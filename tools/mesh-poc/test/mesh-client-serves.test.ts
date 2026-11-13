// MESH_INTERFACE → Block gossip → "A client that serves answers the nodes
// it reads" — the client takes an optional way to serve posts' text and a
// setting. While on, its handshake declares `SERVING_READER_CAPABILITIES`
// and `SYNC_PROTOCOL` streams from the connected nodes land on
// `postTextsHandler`. A change of the setting closes every connection the
// client holds and dials again, so each new handshake declares the new
// set; two quick calls that disagree settle to the last.
//
// A real `NetNode` in a public-mesh role and a real client in one
// process; the node's `getServingReaders()` and `requestPostBodies`
// drive the properties. Where a peer must declare no chain service
// to the client, the file's `overrideHandshake` pattern shapes that
// side alone.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  profileFor,
  PROTOCOL_VERSION,
  computeContentHash,
} from '@dagsocial/types';
import type { NetworkProfile, NetworkType } from '@dagsocial/types';
import {
  HANDSHAKE_PROTOCOL,
  READER_CAPABILITIES,
  SYNC_PROTOCOL,
  MAX_HANDSHAKE_FRAME_BYTES,
  MAX_MODIFIER_REQUEST_FRAME_BYTES,
  buildHandshakeFrame,
  decodeFrame,
  MODIFIER_POST_BODY,
} from '@dagsocial/net/browser';
import { encodeModifierRequest, NetNode } from '@dagsocial/net';
import {
  startMeshClient,
  type MeshClient,
} from '@dagsocial/web/mesh';
import type { PostTextProvider } from '@dagsocial/net/browser';
import { startNetPublicMesh, type NetMeshNode } from './helpers/net-public-node.js';
import { chainResolve, chainUpstream, type ChainUpstream } from './helpers/chain-harness.js';
import { makeLinkedChain } from './helpers/devnet-block.js';

const PROFILE: NetworkProfile = profileFor('devnet' as NetworkType);
const K = 5;
const CHAIN = makeLinkedChain(K, PROFILE);

/**
 * A reader that answers from one in-memory map. Ids the map lacks are
 * left out of the answer — the same rule a post cache follows.
 */
function providerFor(texts: Map<string, string>): PostTextProvider {
  return async (ids) => {
    const out = new Map<string, string>();
    for (const id of ids) {
      const t = texts.get(id);
      if (t !== undefined) out.set(id, t);
    }
    return out;
  };
}

/**
 * NET_INTERFACE → Handshake → "A peer becomes Active once" — the real
 * handshake handler is replaced by one that answers with
 * `opts.capabilities`, so a mesh node can tell the client it serves no
 * chain while the rest of the node stays itself. Same shape as the
 * file beside this one.
 */
async function overrideHandshake(
  node: NetMeshNode,
  opts: { capabilities: readonly number[]; agentName?: string },
): Promise<void> {
  const magic = PROFILE.magic;
  const agentName = opts.agentName ?? 'test-responder';
  await node.libp2p.handle(HANDSHAKE_PROTOCOL, (stream) => {
    void (async () => {
      try {
        const chunks: Uint8Array[] = [];
        let total = 0;
        const iterable = stream as unknown as AsyncIterable<
          Uint8Array | { subarray(): Uint8Array }
        >;
        for await (const value of iterable) {
          const bytes = value instanceof Uint8Array ? value : value.subarray();
          chunks.push(bytes);
          total += bytes.length;
          if (total > MAX_HANDSHAKE_FRAME_BYTES) break;
        }
        if (total === 0 || total > MAX_HANDSHAKE_FRAME_BYTES) {
          await stream.close().catch(() => undefined);
          return;
        }
        const data = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { data.set(c, off); off += c.length; }
        try { decodeFrame(magic, data); } catch {
          await stream.close().catch(() => undefined);
          return;
        }
        const frame = buildHandshakeFrame(magic, {
          agentName,
          protocolVersion: PROTOCOL_VERSION,
          nodeName: agentName,
          chainHeight: 0,
          capabilities: [...opts.capabilities],
        });
        const api = stream as unknown as {
          send: (b: Uint8Array) => boolean;
          onDrain: (ops?: { signal?: AbortSignal }) => Promise<void>;
          close: (ops?: { signal?: AbortSignal }) => Promise<void>;
        };
        if (!api.send(frame)) await api.onDrain();
        await api.close();
      } catch {
        try { await stream.close(); } catch { /* already gone */ }
      }
    })();
  }, { force: true });
}

/**
 * Read a bounded raw answer from a libp2p stream; `null` past the bound.
 */
async function readAnswerBounded(stream: unknown, cap: number): Promise<Uint8Array | null> {
  const iterable = stream as AsyncIterable<Uint8Array | { subarray(): Uint8Array }>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const value of iterable) {
    const bytes = value instanceof Uint8Array ? value : value.subarray();
    chunks.push(bytes);
    total += bytes.length;
    if (total > cap) return null;
  }
  const data = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { data.set(c, off); off += c.length; }
  return data;
}

describe('mesh-client — serving posts\' text to the nodes it reads', () => {
  const clients: MeshClient[] = [];
  const nodes: NetNode[] = [];
  const ups: ChainUpstream[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) { try { await c.stop(); } catch { /* already stopped */ } }
    for (const n of nodes.splice(0)) { try { await n.stop(); } catch { /* already stopped */ } }
    for (const u of ups.splice(0)) { try { await u.close(); } catch { /* already closed */ } }
    for (const d of dirs.splice(0)) { rmSync(d, { recursive: true, force: true }); }
  });

  // The post id a case holds and the text under it. The id is arbitrary
  // 64-hex — the node's `requestPostBodies` carries the asker's own
  // commitment, so the handler and the verifier read the same bytes.
  const POST_ID = '11' + '00'.repeat(31);
  const POST_TEXT = 'hello from the serving reader';
  const POST_HASH = computeContentHash(POST_TEXT);

  it('a serving client is listed and answers the node\'s request', async () => {
    const up = await chainUpstream(CHAIN); ups.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'serve-ok-')); dirs.push(dir);
    const n = await startNetPublicMesh({ upstream: up.base, stateDir: dir }); nodes.push(n.node);

    const client = await startMeshClient({
      firstContact: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(() => CHAIN, K),
      serving: { on: true, texts: providerFor(new Map([[POST_ID, POST_TEXT]])) },
    });
    clients.push(client);

    await client.check();
    const clientPeerId = client.libp2p.peerId.toString();

    await vi.waitFor(() => {
      expect(n.node.getServingReaders()).toContain(clientPeerId);
    }, { timeout: 15_000, interval: 200 });

    const answers = await n.node.requestPostBodies(
      [{ id: POST_ID, contentHash: POST_HASH }],
      clientPeerId,
    );
    expect(answers).toEqual([{ id: POST_ID, content: POST_TEXT }]);
  }, 90_000);

  it('a client not serving is asked nothing', async () => {
    const up = await chainUpstream(CHAIN); ups.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'serve-off-')); dirs.push(dir);
    const n = await startNetPublicMesh({ upstream: up.base, stateDir: dir }); nodes.push(n.node);

    const client = await startMeshClient({
      firstContact: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(() => CHAIN, K),
      serving: { on: false, texts: providerFor(new Map([[POST_ID, POST_TEXT]])) },
    });
    clients.push(client);

    await client.check();
    const clientPeerId = client.libp2p.peerId.toString();

    // Control: the client is a reader the node sees, so
    // `getConnectedReaders()` holds its peer id once the handshake
    // lands.
    await vi.waitFor(() => {
      expect(n.node.getConnectedReaders()).toContain(clientPeerId);
    }, { timeout: 15_000, interval: 200 });

    expect(n.node.getServingReaders()).not.toContain(clientPeerId);

    const answers = await n.node.requestPostBodies(
      [{ id: POST_ID, contentHash: POST_HASH }],
      clientPeerId,
    );
    expect(answers).toEqual([]);
  }, 90_000);

  it('setServing(true) on a running client is heard after the redial', async () => {
    const up = await chainUpstream(CHAIN); ups.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'serve-toggle-on-')); dirs.push(dir);
    const n = await startNetPublicMesh({ upstream: up.base, stateDir: dir }); nodes.push(n.node);

    const client = await startMeshClient({
      firstContact: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(() => CHAIN, K),
      serving: { on: false, texts: providerFor(new Map([[POST_ID, POST_TEXT]])) },
    });
    clients.push(client);

    await client.check();
    const clientPeerId = client.libp2p.peerId.toString();
    await vi.waitFor(() => {
      expect(n.node.getConnectedReaders()).toContain(clientPeerId);
    }, { timeout: 15_000, interval: 200 });
    expect(n.node.getServingReaders()).not.toContain(clientPeerId);
    const connBefore = client.libp2p.getConnections()[0];
    expect(connBefore, 'one connection to the node').toBeTruthy();
    const connIdBefore = connBefore!.id;

    await client.setServing(true);

    // The one connection held before is closed, a new one is opened,
    // the new handshake declares `SERVING_READER_CAPABILITIES`.
    await vi.waitFor(() => {
      const conns = client.libp2p.getConnections();
      expect(conns.some((c) => c.id !== connIdBefore)).toBe(true);
      expect(n.node.getServingReaders()).toContain(clientPeerId);
    }, { timeout: 20_000, interval: 200 });

    const answers = await n.node.requestPostBodies(
      [{ id: POST_ID, contentHash: POST_HASH }],
      clientPeerId,
    );
    expect(answers).toEqual([{ id: POST_ID, content: POST_TEXT }]);
  }, 120_000);

  it('setServing(false) stops the serving after the redial', async () => {
    const up = await chainUpstream(CHAIN); ups.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'serve-toggle-off-')); dirs.push(dir);
    const n = await startNetPublicMesh({ upstream: up.base, stateDir: dir }); nodes.push(n.node);

    const client = await startMeshClient({
      firstContact: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(() => CHAIN, K),
      serving: { on: true, texts: providerFor(new Map([[POST_ID, POST_TEXT]])) },
    });
    clients.push(client);

    await client.check();
    const clientPeerId = client.libp2p.peerId.toString();
    await vi.waitFor(() => {
      expect(n.node.getServingReaders()).toContain(clientPeerId);
    }, { timeout: 15_000, interval: 200 });
    const connBefore = client.libp2p.getConnections()[0];
    const connIdBefore = connBefore!.id;

    await client.setServing(false);

    await vi.waitFor(() => {
      const conns = client.libp2p.getConnections();
      expect(conns.some((c) => c.id !== connIdBefore)).toBe(true);
      expect(n.node.getConnectedReaders()).toContain(clientPeerId);
      expect(n.node.getServingReaders()).not.toContain(clientPeerId);
    }, { timeout: 20_000, interval: 200 });

    const answers = await n.node.requestPostBodies(
      [{ id: POST_ID, contentHash: POST_HASH }],
      clientPeerId,
    );
    expect(answers).toEqual([]);
  }, 120_000);

  it('the last of two quick calls decides', async () => {
    const up = await chainUpstream(CHAIN); ups.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'serve-last-')); dirs.push(dir);
    const n = await startNetPublicMesh({ upstream: up.base, stateDir: dir }); nodes.push(n.node);

    const client = await startMeshClient({
      firstContact: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(() => CHAIN, K),
      serving: { on: false, texts: providerFor(new Map([[POST_ID, POST_TEXT]])) },
    });
    clients.push(client);

    await client.check();
    const clientPeerId = client.libp2p.peerId.toString();
    await vi.waitFor(() => {
      expect(n.node.getConnectedReaders()).toContain(clientPeerId);
    }, { timeout: 15_000, interval: 200 });

    const a = client.setServing(true);
    const b = client.setServing(false);
    await Promise.all([a, b]);

    // Once the handshakes have landed again, the node sees the reader
    // but not as serving; libp2p's registrar does not list
    // `SYNC_PROTOCOL` on the client.
    await vi.waitFor(() => {
      expect(n.node.getConnectedReaders()).toContain(clientPeerId);
      expect(n.node.getServingReaders()).not.toContain(clientPeerId);
    }, { timeout: 20_000, interval: 200 });

    expect(client.libp2p.getProtocols()).not.toContain(SYNC_PROTOCOL);
  }, 120_000);

  it('a connection whose handshake declared no chain service is not answered', async () => {
    const up = await chainUpstream(CHAIN); ups.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'serve-no-chain-')); dirs.push(dir);
    const n = await startNetPublicMesh({ upstream: up.base, stateDir: dir }); nodes.push(n.node);
    // The peer's handshake answers `READER_CAPABILITIES`, so the
    // client's `runHandshake` records `no-chain` for this connection.
    await overrideHandshake(n, { capabilities: READER_CAPABILITIES });

    const client = await startMeshClient({
      firstContact: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(() => CHAIN, K),
      serving: { on: true, texts: providerFor(new Map([[POST_ID, POST_TEXT]])) },
    });
    clients.push(client);

    await client.check();
    const clientPeerId = client.libp2p.peerId.toString();
    // The handshake declared no chain service, so the connection
    // stays `new` in the list — but libp2p holds it, and the peer
    // can open a stream on it. Wait for the one connection to land.
    await vi.waitFor(() => {
      const conns = client.libp2p.getConnections();
      expect(conns.length).toBeGreaterThan(0);
    }, { timeout: 15_000, interval: 200 });

    // The peer opens a `SYNC_PROTOCOL` stream to the client with one
    // held id's modifier request. The client's handler refuses the
    // stream because the handshake did not pass.
    const magic = PROFILE.magic;
    const req = encodeModifierRequest(magic, {
      typeId: MODIFIER_POST_BODY,
      ids: [POST_ID],
    });
    const libp2p = n.libp2p;
    const peerId = libp2p.getPeers().find((p) => p.toString() === clientPeerId);
    expect(peerId, 'peer id resolves').toBeTruthy();

    const refusedStream = await libp2p.dialProtocol(peerId!, SYNC_PROTOCOL, {
      signal: AbortSignal.timeout(10_000),
    });
    const writeApi = refusedStream as unknown as {
      send: (b: Uint8Array) => boolean;
      onDrain: (ops?: { signal?: AbortSignal }) => Promise<void>;
      close: (ops?: { signal?: AbortSignal }) => Promise<void>;
    };
    if (!writeApi.send(req)) await writeApi.onDrain();
    await writeApi.close();
    const answer = await readAnswerBounded(refusedStream, MAX_MODIFIER_REQUEST_FRAME_BYTES);
    expect(answer, 'no bytes come back on a no-chain connection').toEqual(new Uint8Array(0));

    // Control: a second node whose handshake is honest. The client
    // dials it, the new handshake passes, and the client's handler
    // answers a request on that connection.
    const up2 = await chainUpstream(CHAIN); ups.push(up2);
    const dir2 = mkdtempSync(join(tmpdir(), 'serve-no-chain-ctrl-')); dirs.push(dir2);
    const n2 = await startNetPublicMesh({ upstream: up2.base, stateDir: dir2 }); nodes.push(n2.node);
    client.addByHand(n2.id, [n2.webrtcAddr], false);
    await client.check();

    await vi.waitFor(() => {
      expect(n2.node.getServingReaders()).toContain(clientPeerId);
    }, { timeout: 15_000, interval: 200 });

    const okAnswers = await n2.node.requestPostBodies(
      [{ id: POST_ID, contentHash: POST_HASH }],
      clientPeerId,
    );
    expect(okAnswers).toEqual([{ id: POST_ID, content: POST_TEXT }]);
  }, 120_000);

  it('an unchanged value does nothing', async () => {
    const up = await chainUpstream(CHAIN); ups.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'serve-same-')); dirs.push(dir);
    const n = await startNetPublicMesh({ upstream: up.base, stateDir: dir }); nodes.push(n.node);

    const client = await startMeshClient({
      firstContact: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(() => CHAIN, K),
      serving: { on: true, texts: providerFor(new Map([[POST_ID, POST_TEXT]])) },
    });
    clients.push(client);

    await client.check();
    const clientPeerId = client.libp2p.peerId.toString();
    await vi.waitFor(() => {
      expect(n.node.getServingReaders()).toContain(clientPeerId);
    }, { timeout: 15_000, interval: 200 });
    const connBefore = client.libp2p.getConnections()[0];
    const connIdBefore = connBefore!.id;

    await client.setServing(true);

    // The one connection the client holds stays, with the same id,
    // and the node still lists the reader as serving.
    const connsAfter = client.libp2p.getConnections();
    expect(connsAfter.length).toBe(1);
    expect(connsAfter[0]!.id).toBe(connIdBefore);
    expect(n.node.getServingReaders()).toContain(clientPeerId);
  }, 90_000);

  it('a change made while a check runs still redials at once', async () => {
    const up = await chainUpstream(CHAIN); ups.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'serve-mid-check-')); dirs.push(dir);
    const n = await startNetPublicMesh({ upstream: up.base, stateDir: dir }); nodes.push(n.node);

    const client = await startMeshClient({
      firstContact: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(() => CHAIN, K),
      serving: { on: false, texts: providerFor(new Map([[POST_ID, POST_TEXT]])) },
    });
    clients.push(client);

    // One check first so the client holds a connection to the node.
    await client.check();
    const clientPeerId = client.libp2p.peerId.toString();
    await vi.waitFor(() => {
      expect(n.node.getConnectedReaders()).toContain(clientPeerId);
    }, { timeout: 15_000, interval: 200 });

    // A second check starts without being awaited; while it runs, the
    // reader is set to serve. The rule says a change redials every
    // node at once; a 15 s wait is well under the 30 s check cadence,
    // so this wait times out if the redial waits on the next
    // scheduled check instead.
    const pending = client.check();
    await client.setServing(true);
    await pending;

    await vi.waitFor(() => {
      expect(n.node.getServingReaders()).toContain(clientPeerId);
    }, { timeout: 15_000, interval: 200 });

    const answers = await n.node.requestPostBodies(
      [{ id: POST_ID, contentHash: POST_HASH }],
      clientPeerId,
    );
    expect(answers).toEqual([{ id: POST_ID, content: POST_TEXT }]);
  }, 120_000);

  it('a call made while another runs resolves after it', async () => {
    const up = await chainUpstream(CHAIN); ups.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'serve-queue-')); dirs.push(dir);
    const n = await startNetPublicMesh({ upstream: up.base, stateDir: dir }); nodes.push(n.node);

    const client = await startMeshClient({
      firstContact: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(() => CHAIN, K),
      serving: { on: false, texts: providerFor(new Map([[POST_ID, POST_TEXT]])) },
    });
    clients.push(client);

    await client.check();
    const clientPeerId = client.libp2p.peerId.toString();
    await vi.waitFor(() => {
      expect(n.node.getConnectedReaders()).toContain(clientPeerId);
    }, { timeout: 15_000, interval: 200 });
    const conns = client.libp2p.getConnections();
    expect(conns.length).toBeGreaterThan(0);
    const connBefore = conns[0]!;
    expect(connBefore.status).toBe('open');

    // Two calls in rapid succession. The second's work waits on the
    // first through `servingLock`; by the time `second` resolves, the
    // first has already closed the one connection the client held.
    const first = client.setServing(true);
    const second = client.setServing(true);
    await second;

    expect(connBefore.status).not.toBe('open');

    await first;
  }, 90_000);
});
