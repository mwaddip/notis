// NET_INTERFACE → Node Lifecycle →
// "Every connection libp2p opens reaches net's hooks" — libp2p is created
// stopped, and net's connection and peer listeners, both protocols and
// everything they reach are in place before it starts. So a connection libp2p
// opens on the node's behalf as it starts — at this file, its own reconnect
// dial of a stored `keep-alive` peer — opens its handshake, and the peer is
// tracked.
//
// The test shape, in each case:
//   F = a public mesh NetNode, long-lived.
//   P = a public mesh NetNode on a `stateDir` that persists.
//   P dials F, handshakes, stops; the keep-alive tag is set on F in P's own
//   peer store (NET_INTERFACE → Handshake →
//   "Every connection this node dialled carries its handshake, whoever within
//   the node dialled it"). A second P starts on the same `stateDir`, so
//   libp2p's own `ReconnectQueue.afterStart` redials F by stored peer id at
//   libp2p's start.
//
// A `vi.mock` of `libp2p` wraps `createLibp2p` with a fixed delay after the
// real one — a start whose own steps are slow — so the race is deterministic.
// On the current (broken) code the delay sits between libp2p's own `start()`
// (which `createLibp2p` awaits inside) and `NetNode.start`'s listener/handler
// attach, long enough for libp2p's redial to open its connection unheard. On
// fixed code the delay sits before `libp2p.start()` — nothing dials in it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import { generateKeyPair, type KeyPair } from '@dagsocial/types';
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

import { NetNode } from '../src/index.js';
import type { NetValidators, MeshConfig } from '../src/index.js';
import { makeConfig } from './helpers.js';

// A module-level knob the mock reads. Set it before a `new NetNode(...).start()`
// call to slow that start. Zero means no extra delay — the default, used while
// F and the first P are set up.
let createLibp2pExtraDelayMs = 0;

vi.mock('libp2p', async () => {
  const actual = await vi.importActual<typeof import('libp2p')>('libp2p');
  return {
    ...actual,
    createLibp2p: async (opts: Parameters<typeof actual.createLibp2p>[0]) => {
      const node = await actual.createLibp2p(opts);
      if (createLibp2pExtraDelayMs > 0) {
        await new Promise((r) => setTimeout(r, createLibp2pExtraDelayMs));
      }
      return node;
    },
  };
});

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

function publicMeshOn(stateDir: string): MeshConfig {
  // `MESH_INTERFACE → NAT → "Every STUN server is a mesh node named by IP"`
  // — these cases exercise libp2p's own redial of a `keep-alive` peer at
  // start, not STUN, so the server is off; `stun: null` keeps `STUN_PORT`
  // (3478) unbound so this file never races another mesh case under the
  // forks pool.
  return {
    role: 'public',
    network: 'devnet',
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    stateDir,
    httpBase: 'http://127.0.0.1:0',
    stun: null,
  };
}

function libp2pOf(node: NetNode): Libp2p {
  return (node as unknown as { libp2p: Libp2p }).libp2p;
}

function tcpMultiaddr(node: NetNode): string {
  const libp2p = libp2pOf(node);
  const addrs = libp2p.getMultiaddrs().map((a) => a.toString());
  const match = addrs.find((a) => /\/tcp\/\d+\/p2p\//.test(a));
  if (!match) throw new Error(`no TCP multiaddr on node: ${addrs.join(', ')}`);
  return match;
}

function tcpMultiaddrNoPeer(node: NetNode): string {
  const libp2p = libp2pOf(node);
  const addrs = libp2p.getMultiaddrs().map((a) => a.toString());
  const match = addrs.find((a) => /\/tcp\/\d+(?:\/|$)/.test(a) && !a.includes('/webrtc'));
  if (!match) throw new Error(`no TCP multiaddr on node: ${addrs.join(', ')}`);
  // Strip any trailing `/p2p/...` component so the dial resolves to an
  // address, not to a peer id — the stage's own seed shape.
  return match.replace(/\/p2p\/.*$/, '');
}

async function waitFor<T>(
  fn: () => T | null | undefined,
  ms: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== null && v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timed out after ${ms} ms: ${label}`);
}

async function peerTagKeys(node: NetNode, peerId: string): Promise<string[]> {
  const libp2p = libp2pOf(node);
  try {
    const peer = await (libp2p as unknown as {
      peerStore: { get(id: unknown): Promise<{ tags: Map<string, unknown> }> };
    }).peerStore.get(peerIdFromString(peerId));
    return [...peer.tags.keys()];
  } catch {
    return [];
  }
}

describe('NET_INTERFACE → Node Lifecycle — every connection libp2p opens reaches net\'s hooks', () => {
  let f: NetNode | null = null;
  let pFirst: NetNode | null = null;
  let pRestart: NetNode | null = null;
  const dirs: string[] = [];
  let pKey: KeyPair | null = null;
  let pStateDir = '';

  beforeEach(async () => {
    createLibp2pExtraDelayMs = 0;
    pKey = generateKeyPair();
    pStateDir = mkdtempSync(join(tmpdir(), 'net-start-dials-p-'));
    dirs.push(pStateDir);
    const fStateDir = mkdtempSync(join(tmpdir(), 'net-start-dials-f-'));
    dirs.push(fStateDir);

    // F — accepts; `syncRequestTimeoutMs` short so its deadline is seconds.
    f = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      syncRequestTimeoutMs: 2_000,
      mesh: publicMeshOn(fStateDir),
    }), validators);
    await f.start();

    const fAddr = tcpMultiaddr(f);

    // First P — dials F through its TCP bootstrap peer, handshakes.
    pFirst = new NetNode(makeConfig({
      nodeKey: pKey,
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      syncRequestTimeoutMs: 2_000,
      bootstrapPeers: [fAddr],
      mesh: publicMeshOn(pStateDir),
    }), validators);
    await pFirst.start();

    const fId = f.peerId();
    await waitFor(
      () => (pFirst!.getConnectedPeers().includes(fId) ? true : null),
      10_000,
      'P1 handshakes with F',
    );

    // Set a `keep-alive-notis-test` tag on F in P's peer store. libp2p's
    // `ReconnectQueue.afterStart` dials every stored peer whose tags include
    // any key starting with `keep-alive` (libp2p@3.5.1
    // `connection-manager/reconnect-queue.js`, `hasKeepAliveTag`), so this
    // name is enough.
    const pFirstLibp2p = libp2pOf(pFirst);
    await (pFirstLibp2p as unknown as {
      peerStore: {
        merge(id: unknown, patch: { tags: Record<string, { value: number }> }): Promise<unknown>;
      };
    }).peerStore.merge(peerIdFromString(fId), {
      tags: { 'keep-alive-notis-test': { value: 1 } },
    });

    await pFirst.stop();
    pFirst = null;
  });

  afterEach(async () => {
    createLibp2pExtraDelayMs = 0;
    try { await pRestart?.stop(); } catch { /* already stopped */ }
    try { await pFirst?.stop(); } catch { /* already stopped */ }
    try { await f?.stop(); } catch { /* already stopped */ }
    pRestart = null; pFirst = null; f = null;
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ } }
    dirs.length = 0;
  });

  // `syncRequestTimeoutMs` is 2 000 ms and `HANDSHAKE_DEADLINE_FACTOR` is 3,
  // so F closes an un-handshaken connection at 6 000 ms. The delay in the mock
  // is 1 500 ms — longer than one event-loop tick (so libp2p's deferred
  // redial opens the connection on broken code) and well under the deadline.
  const MOCK_DELAY_MS = 1_500;

  it('a peer libp2p redials at its own start is Active on the restarted node', async () => {
    const fId = f!.peerId();
    createLibp2pExtraDelayMs = MOCK_DELAY_MS;
    pRestart = new NetNode(makeConfig({
      nodeKey: pKey!,
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      syncRequestTimeoutMs: 2_000,
      // No seed — the only way to F is libp2p's own redial.
      bootstrapPeers: [],
      mesh: publicMeshOn(pStateDir),
    }), validators);
    await pRestart.start();
    // Diagnostic — the tags F carries in P's store at this point. The
    // explicit `keep-alive-notis-test` is always there; kad-dht's own
    // `keep-alive-kad-dht` tag arrives on a timer in
    // `@libp2p/kad-dht@16.4.9` (`routing-table/closest-peers.ts`
    // `REFRESH_INTERVAL = 5 000`), so shortly after the pair peer.
    const tagsNow = await peerTagKeys(pRestart, fId);
    console.log(`[test] tags on F in P's store at P2 start: ${tagsNow.join(', ')}`);
    // The window — F's handshake deadline is `HANDSHAKE_DEADLINE_FACTOR × 2 000`
    // = 6 000 ms. libp2p's own `ReconnectQueue` retries a dropped
    // connection after it, so an assertion past 6 s is spoiled by the
    // retry carrying a connection its listener now hears. 2 500 ms
    // bounds the "redial libp2p opens at its own start reaches net's
    // hooks" claim: a second connection libp2p opens later is a
    // different claim.
    await waitFor(
      () => (pRestart!.getConnectedPeers().includes(fId) ? true : null),
      2_500,
      'restarted P hears libp2p\'s own redial and handshakes F within 2.5 s',
    );
    expect(pRestart.getConnectedPeers()).toContain(fId);
  }, 30_000);

  it('a peer libp2p redials at its own start is Active when the restarted node also dials it as a seed', async () => {
    const fId = f!.peerId();
    const fSeed = tcpMultiaddrNoPeer(f!);
    createLibp2pExtraDelayMs = MOCK_DELAY_MS;
    pRestart = new NetNode(makeConfig({
      nodeKey: pKey!,
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      syncRequestTimeoutMs: 2_000,
      // The stage's shape: F's bare TCP address as P's seed, so libp2p's
      // redial and the dial funnel race for the same peer.
      bootstrapPeers: [fSeed],
      mesh: publicMeshOn(pStateDir),
    }), validators);
    await pRestart.start();
    await waitFor(
      () => (pRestart!.getConnectedPeers().includes(fId) ? true : null),
      12_000,
      'restarted P with seed hears libp2p\'s own redial and the seed, and handshakes F',
    );
    expect(pRestart.getConnectedPeers()).toContain(fId);
  }, 30_000);

  it('the connection libp2p opens at its own start carries a handshake and outlives the deadline', async () => {
    const fId = f!.peerId();
    createLibp2pExtraDelayMs = MOCK_DELAY_MS;
    pRestart = new NetNode(makeConfig({
      nodeKey: pKey!,
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      syncRequestTimeoutMs: 2_000,
      bootstrapPeers: [],
      mesh: publicMeshOn(pStateDir),
    }), validators);
    await pRestart.start();
    // Capture the very first connection id — the one libp2p opened at its
    // own start. The claim is that *this* connection still stands past the
    // deadline, not that *some* connection to F does (libp2p's
    // `ReconnectQueue` retries after F closes an un-handshaken one at
    // its deadline, and such a retry is a different connection with a
    // different id).
    const pLibp2p = libp2pOf(pRestart);
    const initialId = await waitFor(
      () => {
        const conns = pLibp2p.getConnections().filter((c) => c.remotePeer.toString() === fId);
        return conns.length > 0 ? conns[0]!.id : null;
      },
      2_500,
      'the redial libp2p opens at its own start stands for the restarted P',
    );
    await waitFor(
      () => (pRestart!.getConnectedPeers().includes(fId) ? true : null),
      2_500,
      'restarted P handshakes F on libp2p\'s own redial within 2.5 s',
    );

    // Past `HANDSHAKE_DEADLINE_FACTOR × syncRequestTimeoutMs` plus a
    // margin — 6 000 ms + 1 500 ms = 7 500 ms — the same connection id
    // still stands and both ends count each other.
    await new Promise((r) => setTimeout(r, 7_500));
    const keptConn = pLibp2p.getConnections().find((c) => c.id === initialId);
    expect(keptConn, `initial connection id ${initialId} no longer stands`).toBeTruthy();
    expect(keptConn!.remotePeer.toString()).toBe(fId);
    expect(pRestart.getConnectedPeers()).toContain(fId);
    expect(f!.getConnectedPeers()).toContain(pRestart.peerId());
  }, 30_000);

  it('a connection that never handshakes is still closed at its deadline', async () => {
    // NET_INTERFACE → Handshake →
    // "A connection handshakes within its deadline, or is closed":
    // `HANDSHAKE_DEADLINE_FACTOR` (3) × `syncRequestTimeoutMs` (2 000 ms) =
    // 6 000 ms after a connection opens on F, F closes it when no handshake
    // has completed.
    //
    // A bare libp2p host — TCP, Noise, yamux, identify — dials F and
    // completes the libp2p upgrade, so F's `connection:open` hook arms the
    // deadline on a real connection. The host never opens
    // `/dagsocial/handshake/1`, so the deadline runs out and F closes the
    // connection.
    //
    // The close is read from the dialler's `connection:close` event, waited
    // on with an 8 000 ms bound: above F's 6 000 ms deadline and below
    // libp2p 3.5.1's `INBOUND_UPGRADE_TIMEOUT`
    // (`connection-manager/constants.defaults.ts`, 10 000 ms), so nothing
    // but net's deadline can satisfy it.
    const fPeerId = f!.peerId();
    const fAddr = tcpMultiaddr(f!);

    const dialler: Libp2p = await createLibp2p({
      addresses: { listen: [] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
    });

    try {
      const dialStart = Date.now();
      await dialler.dial(multiaddr(fAddr));

      // Control: F lists the dialler's connection — the libp2p upgrade
      // completed on F's side and F armed the deadline.
      const fLibp2p = libp2pOf(f!);
      await waitFor(
        () => {
          const conns = fLibp2p.getConnections().filter(
            (c) => c.remotePeer.toString() === dialler.peerId.toString(),
          );
          return conns.length > 0 ? true : null;
        },
        2_000,
        "F's libp2p lists the dialler's connection",
      );

      const closeMs = await new Promise<number>((resolve) => {
        const onClose = (evt: { detail: { remotePeer: { toString(): string } } }): void => {
          if (evt.detail.remotePeer.toString() === fPeerId) {
            dialler.removeEventListener('connection:close', onClose);
            resolve(Date.now() - dialStart);
          }
        };
        dialler.addEventListener('connection:close', onClose);
        setTimeout(() => {
          dialler.removeEventListener('connection:close', onClose);
          resolve(-1);
        }, 8_000);
      });

      expect(closeMs, `F did not close the connection within 8 000 ms (measured ${closeMs} ms)`).toBeGreaterThan(0);
      expect(closeMs).toBeLessThan(8_000);
      expect(dialler.getConnections().filter(
        (c) => c.remotePeer.toString() === fPeerId,
      )).toHaveLength(0);
    } finally {
      try { await dialler.stop(); } catch { /* already stopped */ }
    }
  }, 30_000);
});
