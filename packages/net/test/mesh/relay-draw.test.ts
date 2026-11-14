// MESH_INTERFACE → NAT → "A relay that does not answer never stops a
// private node" and MESH_INTERFACE → The client's node list → "Retry":
// after the n-th failure in a row the wait is drawn uniformly between
// half and the whole of `min(RETRY_CAP_MS, RETRY_BASE_MS · 2^(n − 1))`.
// The random source is a required argument on both `retryIntervalMs`
// and `startRelayRetry`'s options.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { generateKeyPair as libp2pGenerate } from '@libp2p/crypto/keys';
import { generateKeyPair } from '@dagsocial/types';
import {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyTxStructure,
  verifyTxSignatures,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyHeaderFieldDomains,
  verifyValidatorSignature,
  verifyPostBody,
} from '@dagsocial/validation';

import { NetNode } from '../../src/index.js';
import type { NetValidators, MeshConfig } from '../../src/index.js';
import { retryIntervalMs, startRelayRetry } from '../../src/mesh/relay-retry.js';
import { RETRY_CAP_MS } from '../../src/browser.js';
import { makeConfig } from '../helpers.js';

const validators: NetValidators = {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyTxStructure,
  verifyTxSignatures,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyHeaderFieldDomains,
  verifyValidatorSignature,
  verifyPostBody,
};

function privateMeshOn(stateDir: string): MeshConfig {
  return {
    role: 'private',
    network: 'devnet',
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    stateDir,
    httpBase: 'http://127.0.0.1:0',
    stun: null,
    relayRetryBaseMs: 100,
    relayRetryCapMs: 1_000,
  } as MeshConfig;
}

describe('retryIntervalMs draws the wait between half and the whole of the schedule', () => {
  // base = 100, cap = 1_000; schedule at n = 1 is 100, so half is 50, whole
  // is 100 (strictly less than).
  it('a random source at 0 answers half the schedule', () => {
    // -- LAST ASSERTION --
    expect(retryIntervalMs(1, 100, 1_000, () => 0)).toBe(50);
  });

  it('a random source just under 1 answers just under the whole schedule', () => {
    const v = retryIntervalMs(1, 100, 1_000, () => 1 - 1e-12);
    expect(v, 'at least half').toBeGreaterThanOrEqual(50);
    // -- LAST ASSERTION --
    expect(v, 'strictly less than the whole').toBeLessThan(100);
  });

  it('the cap holds under the draw — at the cap, the draw lies between half the cap and the cap', () => {
    // RETRY_CAP_MS = 600_000; schedule at a large n saturates to the cap.
    // Half is 300_000, whole is 600_000 (strictly less than).
    const lo = retryIntervalMs(30, 5_000, RETRY_CAP_MS, () => 0);
    const hi = retryIntervalMs(30, 5_000, RETRY_CAP_MS, () => 1 - 1e-12);
    expect(lo, 'half the cap at low source').toBe(RETRY_CAP_MS / 2);
    expect(hi, 'strictly less than the cap at high source').toBeLessThan(RETRY_CAP_MS);
    // -- LAST ASSERTION --
    expect(hi, 'at least half the cap').toBeGreaterThanOrEqual(RETRY_CAP_MS / 2);
  });

  it('zero or negative failures answer 0 whatever the source', () => {
    expect(retryIntervalMs(0, 100, 1_000, () => 0.5), 'zero failures').toBe(0);
    expect(retryIntervalMs(-1, 100, 1_000, () => 0.5), 'negative failures').toBe(0);
    // -- LAST ASSERTION --
    expect(retryIntervalMs(-5, 100, 1_000, () => 0.9), 'deeply negative').toBe(0);
  });
});

describe('startRelayRetry schedules the drawn wait', () => {
  const nodes: NetNode[] = [];
  const toStop: Libp2p[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const n of nodes) { try { await n.stop(); } catch { /* */ } }
    nodes.length = 0;
    for (const r of toStop) { try { await r.stop(); } catch { /* */ } }
    toStop.length = 0;
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
    dirs.length = 0;
  });

  async function startBareLibp2p(): Promise<Libp2p> {
    const relayKey = await libp2pGenerate('Ed25519');
    const relay = await createLibp2p({
      privateKey: relayKey,
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
    });
    toStop.push(relay);
    return relay;
  }

  async function newPrivateNodeOn(bootstrapAddr: string, baseMs: number): Promise<NetNode> {
    const dir = mkdtempSync(join(tmpdir(), 'net-relay-draw-'));
    dirs.push(dir);
    const priv = new NetNode(
      makeConfig({
        nodeKey: generateKeyPair(),
        listenAddrs: '/ip4/127.0.0.1/tcp/0',
        bootstrapPeers: [bootstrapAddr],
        mesh: { ...privateMeshOn(dir), relayRetryBaseMs: baseMs, relayRetryCapMs: 100_000 } as MeshConfig,
      }),
      validators,
    );
    nodes.push(priv);
    return priv;
  }

  function addrOfTcpPeer(lp: Libp2p): string {
    const a = lp.getMultiaddrs().map((m) => m.toString()).find((s) => /\/tcp\/\d+\/p2p\//.test(s));
    if (a === undefined) throw new Error('no tcp/p2p addr');
    return a;
  }

  async function waitForTcpPeer(lp: Libp2p): Promise<string> {
    for (let i = 0; i < 50; i++) {
      try { return addrOfTcpPeer(lp); } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('no relay tcp addr');
  }

  // (a) A `startRelayRetry` call with `baseMs: 1_000`, `capMs: 100_000`
  // and a source answering 0.25 schedules its first retry at 625 ms —
  // `(0.5 + 0.25 · 0.5) · 1 000`. A spy on `setTimeout`'s second
  // argument matched to the distinctive 625 holds the draw.
  it('startRelayRetry schedules a 625 ms wait from a 0.25 source and 1 000 ms base', async () => {
    // The scenario a case of its own: a bare libp2p relay (no circuit
    // relay server), so each listen attempt fails and schedules a
    // retry.
    const relay = await startBareLibp2p();
    const relayAddr = await waitForTcpPeer(relay);
    const priv = await newPrivateNodeOn(relayAddr, 50_000);
    await priv.start();

    const scheduled: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    const spy = ((fn: (...args: unknown[]) => void, ms: number) => {
      scheduled.push(ms);
      return origSetTimeout(fn, ms);
    }) as unknown as typeof globalThis.setTimeout;
    globalThis.setTimeout = spy;
    try {
      const retry = startRelayRetry(
        priv.libp2pNode!,
        '/ip4/127.0.0.1/tcp/1/p2p/12D3KooWRAoWaa9kgbsEiFzBkoxtZJktTAwzUZmRWDxv3vmzR5Q5/p2p-circuit',
        { baseMs: 1_000, capMs: 100_000, random: () => 0.25 },
      );
      await new Promise((r) => origSetTimeout(r, 300));
      retry.stop();
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
    // -- LAST ASSERTION -- the distinctive drawn wait landed on the
    // timer, not the undrawn 1 000.
    expect(scheduled.filter((ms) => ms === 625), `scheduled waits: ${scheduled.join(',')}`).not.toEqual([]);
  }, 30_000);

  // (b) The shipped `node.ts` call site is held: a private-role NetNode
  // whose bootstrap never reserves draws its own retry through
  // `Math.random`. With `Math.random` spied to answer 0.25 and
  // `relayRetryBaseMs: 1_000`, the retry schedules 625 ms.
  it('a private NetNode draws its relay retry through Math.random — spied 0.25 schedules 625 ms', async () => {
    const relay = await startBareLibp2p();
    const relayAddr = await waitForTcpPeer(relay);
    const scheduled: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    const spy = ((fn: (...args: unknown[]) => void, ms: number) => {
      scheduled.push(ms);
      return origSetTimeout(fn, ms);
    }) as unknown as typeof globalThis.setTimeout;
    const origRandom = Math.random;
    Math.random = () => 0.25;
    globalThis.setTimeout = spy;
    try {
      const priv = await newPrivateNodeOn(relayAddr, 1_000);
      await priv.start();
      await new Promise((r) => origSetTimeout(r, 1_200));
    } finally {
      Math.random = origRandom;
      globalThis.setTimeout = origSetTimeout;
    }
    // -- LAST ASSERTION --
    expect(scheduled.filter((ms) => ms === 625), `scheduled waits: ${scheduled.join(',')}`).not.toEqual([]);
  }, 30_000);
});
