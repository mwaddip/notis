// NET_INTERFACE → The mesh — two guards on the private role's relay
// retry that end-to-end cases do not hold by themselves. Both ride
// `MESH_INTERFACE → NAT → "A relay that does not answer never stops a private node"`:
//   1. A relay that accepts the connection and never answers the HOP
//      reservation: the private node's attempt ends at the per-
//      attempt timeout and the next attempt is scheduled on the
//      retry cadence; without the timeout, the attempt never ends.
//   2. A private node with `bootstrapPeers: []` schedules no retry
//      and never dials its own transport manager for a circuit
//      address; a retry started regardless of bootstrap would show
//      up as a `transportManager.listen` call.

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
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
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

function privateMeshOn(stateDir: string, opts?: { listenTimeoutMs?: number }): MeshConfig {
  return {
    role: 'private',
    network: 'devnet',
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    stateDir,
    httpBase: 'http://127.0.0.1:0',
    stun: null,
    relayRetryBaseMs: 50,
    relayRetryCapMs: 500,
    relayListenTimeoutMs: opts?.listenTimeoutMs,
  } as MeshConfig;
}

async function waitFor<T>(fn: () => T | null | undefined, ms: number, label: string): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== null && v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitFor timed out after ${ms} ms: ${label}`);
}

describe('mesh — private role retry guards', () => {
  let nodes: NetNode[] = [];
  let toStop: Libp2p[] = [];
  let dirs: string[] = [];
  afterEach(async () => {
    for (const n of nodes) { try { await n.stop(); } catch { /* already stopped */ } }
    for (const l of toStop) { try { await l.stop(); } catch { /* already stopped */ } }
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ } }
    nodes = []; toStop = []; dirs = [];
  });

  // `MESH_INTERFACE → NAT → "A relay that does not answer never stops a private node"`
  // — a relay that accepts the TCP connection and registers the HOP
  // protocol but never writes a response holds the private node's
  // reservation stream open forever. The per-attempt deadline must
  // fire, count the attempt as a failure, and schedule the next
  // attempt on the retry cadence. Observable: more than one
  // `transportManager.listen([<relay>/p2p-circuit])` call lands in a
  // window of `relayListenTimeoutMs + a few retry periods`. Without
  // the deadline, the first attempt never returns and only one
  // `listen` call is seen.
  it('a relay that stalls HOP: the attempt ends at listenTimeoutMs and a retry is scheduled', async () => {
    const LISTEN_TIMEOUT_MS = 400;

    // A plain libp2p host that registers the HOP protocol with a
    // handler that holds the stream open and writes nothing. The
    // reservation attempt opens a stream to `/libp2p/circuit/relay/0.2.0/hop`
    // and waits for the HOP response forever.
    const stallKey = await libp2pGenerate('Ed25519');
    const stallPeer = peerIdFromPrivateKey(stallKey);
    const stall = await createLibp2p({
      privateKey: stallKey,
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
    });
    toStop.push(stall);
    // Register a HOP handler that never writes, never closes.
    await stall.handle('/libp2p/circuit/relay/0.2.0/hop', async () => {
      // Hold the stream open — the remote awaits the HOP response.
      // The handler returns, but the stream stays until stop().
    });
    const stallTcp = await waitFor(
      () => stall.getMultiaddrs().map((a) => a.toString()).find((s) => /\/tcp\/\d+\/p2p\//.test(s)),
      5_000,
      "stall relay's TCP multiaddr",
    );

    const dir = mkdtempSync(join(tmpdir(), 'net-mesh-priv-stall-hop-'));
    dirs.push(dir);
    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      bootstrapPeers: [stallTcp],
      mesh: privateMeshOn(dir, { listenTimeoutMs: LISTEN_TIMEOUT_MS }),
    }), validators);
    await node.start();
    nodes.push(node);

    const libp2p = (node as unknown as { libp2p: Libp2p }).libp2p;
    // Spy `transportManager.listen` right after `start()` returns.
    // `startRelayRetry`'s first attempt is `scheduleRetry(0)`, which
    // runs on a setTimeout, so by the time we read it, no `listen`
    // has been called yet — the spy catches every attempt from here.
    const tm = (libp2p as unknown as {
      components: { transportManager: { listen(addrs: unknown[]): Promise<void> } };
    }).components.transportManager;
    const listenCalls: string[] = [];
    const origListen = tm.listen.bind(tm);
    tm.listen = async (addrs: unknown[]): Promise<void> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const a of addrs) listenCalls.push((a as any).toString());
      return origListen(addrs);
    };

    // Wait long enough for: first attempt (stalls for LISTEN_TIMEOUT_MS)
    // + retry delay (`relayRetryBaseMs = 50`) + second attempt start.
    // 2× listenTimeoutMs + a few hundred ms slack catches at least two
    // attempts.
    const windowMs = 2 * LISTEN_TIMEOUT_MS + 300;
    await new Promise((r) => setTimeout(r, windowMs));

    const circuitCalls = listenCalls.filter((s) =>
      s.includes(stallPeer.toString()) && s.includes('/p2p-circuit'),
    );
    expect(circuitCalls.length,
      `listen calls to the stalling relay (${windowMs} ms window) = ${circuitCalls.length}: ${circuitCalls.join(', ')}`,
    ).toBeGreaterThanOrEqual(2);

    // The node is still running and still serves its own listeners
    // (TCP, WebRTC-direct); the private `announceFilter` drops every
    // non-circuit address from `getMultiaddrs()`, so the listener
    // seam is read directly. No circuit reservation stands.
    const tmReach = (libp2p as unknown as {
      components: { transportManager: {
        getListeners(): Array<{ getAddrs(): Array<{ toString(): string }> }>;
      } };
    }).components.transportManager;
    const listenerAddrs: string[] = [];
    for (const l of tmReach.getListeners()) {
      for (const a of l.getAddrs()) listenerAddrs.push(a.toString());
    }
    expect(listenerAddrs.length,
      `own listener addresses still present: ${listenerAddrs.join(', ')}`,
    ).toBeGreaterThan(0);
    const announced = libp2p.getMultiaddrs().map((a) => a.toString());
    expect(announced.some((m) => m.includes('/p2p-circuit')),
      `no reservation while HOP stalls: ${announced.join(', ')}`).toBe(false);
  }, 20_000);

  // `MESH_INTERFACE → NAT → "A relay that does not answer never stops a private node"`
  // — with `bootstrapPeers: []`, the private role starts no retry at
  // all. The observable: no `transportManager.listen` call for a
  // circuit address, and `meshIdentity()` carries no `/p2p-circuit`.
  it('with bootstrapPeers: [] starts no retry (no transportManager.listen for a circuit)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'net-mesh-priv-no-boot-spy-'));
    dirs.push(dir);
    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      bootstrapPeers: [],
      mesh: privateMeshOn(dir),
    }), validators);
    await node.start();
    nodes.push(node);

    const libp2p = (node as unknown as { libp2p: Libp2p }).libp2p;
    const tm = (libp2p as unknown as {
      components: { transportManager: { listen(addrs: unknown[]): Promise<void> } };
    }).components.transportManager;
    const listenCalls: string[] = [];
    const origListen = tm.listen.bind(tm);
    tm.listen = async (addrs: unknown[]): Promise<void> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const a of addrs) listenCalls.push((a as any).toString());
      return origListen(addrs);
    };

    // Wait past the first retry wait (`relayRetryBaseMs = 50`) so a
    // scheduled retry would have fired by now. Any retry started by
    // the code would call `transportManager.listen` with a
    // /p2p-circuit address.
    await new Promise((r) => setTimeout(r, 500));

    const circuitCalls = listenCalls.filter((s) => s.includes('/p2p-circuit'));
    expect(circuitCalls, `no circuit listen calls, saw: ${listenCalls.join(', ')}`).toEqual([]);

    const id = node.meshIdentity();
    expect(id).not.toBeNull();
    expect(id!.multiaddrs.some((m) => m.includes('/p2p-circuit')),
      `meshIdentity announces no /p2p-circuit: ${id!.multiaddrs.join(', ')}`).toBe(false);
  }, 15_000);
});
