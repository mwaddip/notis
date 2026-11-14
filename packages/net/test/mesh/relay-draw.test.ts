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
  it.fails('a random source at 0 answers half the schedule', () => {
    // -- LAST ASSERTION --
    expect(retryIntervalMs(1, 100, 1_000, () => 0)).toBe(50);
  });

  it.fails('a random source just under 1 answers just under the whole schedule', () => {
    const v = retryIntervalMs(1, 100, 1_000, () => 1 - 1e-12);
    expect(v, 'at least half').toBeGreaterThanOrEqual(50);
    // -- LAST ASSERTION --
    expect(v, 'strictly less than the whole').toBeLessThan(100);
  });

  it.fails('the cap holds under the draw — at the cap, the draw lies between half the cap and the cap', () => {
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

  // The wait is drawn through the required `random` option. With a source
  // pinned to 0, the wait reads half the schedule; two attempts measured
  // on a never-answering relay confirm it.
  it.fails('the wait a failing listen schedules is drawn through the required random source', async () => {
    // A bare libp2p host that speaks TCP + Noise but has no circuit relay —
    // every listen attempt completes `transportManager.listen` without a
    // reservation (`hasReservation` reads false), so it counts as a
    // failure and the next retry is scheduled.
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
    const relayLibp2p = relay;
    const relayAddr = await (async () => {
      for (let i = 0; i < 50; i++) {
        const a = relayLibp2p.getMultiaddrs().map((m) => m.toString()).find((s) => /\/tcp\/\d+\/p2p\//.test(s));
        if (a) return a;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('no relay tcp addr');
    })();

    const dir = mkdtempSync(join(tmpdir(), 'net-relay-draw-'));
    dirs.push(dir);
    const priv = new NetNode(
      makeConfig({
        nodeKey: generateKeyPair(),
        listenAddrs: '/ip4/127.0.0.1/tcp/0',
        bootstrapPeers: [relayAddr],
        mesh: privateMeshOn(dir),
      }),
      validators,
    );
    await priv.start();
    nodes.push(priv);

    // Open a fresh RelayRetry on an unreachable address with a counting
    // random source: the draw must call `random` on every retry, so a
    // run that fails a few attempts invokes it. (`/ip4/127.0.0.1/tcp/1`
    // reads ECONNREFUSED at once.)
    let randomCalls = 0;
    const retry = startRelayRetry(
      priv.libp2pNode!,
      '/ip4/127.0.0.1/tcp/1/p2p/12D3KooWRAoWaa9kgbsEiFzBkoxtZJktTAwzUZmRWDxv3vmzR5Q5/p2p-circuit',
      { baseMs: 50, capMs: 500, random: () => { randomCalls += 1; return 0; } },
    );
    await new Promise((r) => setTimeout(r, 400));
    retry.stop();
    // -- LAST ASSERTION --
    expect(randomCalls, 'random invoked by the draw').toBeGreaterThan(0);
  }, 30_000);
});
