// MESH_INTERFACE → The client's node list → "The client reports what it
// does" — the moments that only land over a real libp2p transport: a
// dial's end, a connection opened and closed, a handshake's verdict and
// a serving stream. One case per event, each entering through the real
// entry.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileFor } from '@dagsocial/types';
import type { NetworkProfile, NetworkType } from '@dagsocial/types';
import { HANDSHAKE_PROTOCOL, MAX_HANDSHAKE_FRAME_BYTES, buildHandshakeFrame, decodeFrame, READER_CAPABILITIES } from '@dagsocial/net/browser';
import { NetNode } from '@dagsocial/net';
import { PROTOCOL_VERSION, computeContentHash } from '@dagsocial/types';
import { startMeshClient, type MeshClient, type MeshEvent } from '@dagsocial/web/mesh';
import { vi } from 'vitest';
import type { PostTextProvider } from '@dagsocial/net/browser';
import { startNetPublicMesh, type NetMeshNode } from './helpers/net-public-node.js';
import { chainResolve, chainUpstream, type ChainUpstream } from './helpers/chain-harness.js';
import { makeLinkedChain } from './helpers/devnet-block.js';

const PROFILE: NetworkProfile = profileFor('devnet' as NetworkType);
const K = 5;
const CHAIN = makeLinkedChain(K, PROFILE);

async function overrideHandshakeNoChain(node: NetMeshNode): Promise<void> {
  const magic = PROFILE.magic;
  await node.libp2p.handle(HANDSHAKE_PROTOCOL, (stream) => {
    void (async () => {
      try {
        const chunks: Uint8Array[] = [];
        let total = 0;
        const iterable = stream as unknown as AsyncIterable<Uint8Array | { subarray(): Uint8Array }>;
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
          agentName: 'no-chain-responder',
          protocolVersion: PROTOCOL_VERSION,
          nodeName: 'no-chain-responder',
          chainHeight: 0,
          capabilities: [...READER_CAPABILITIES],
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

function providerFor(map: Map<string, string>): PostTextProvider {
  return async (ids) => {
    const out = new Map<string, string>();
    for (const id of ids) {
      const t = map.get(id);
      if (t !== undefined) out.set(id, t);
    }
    return out;
  };
}

describe('mesh client — the events sink over real libp2p', () => {
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

  it('a dial that resolves writes one `dial` event with `result: "connected"` and a time', async () => {
    const up = await chainUpstream(CHAIN); ups.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'ev-dial-')); dirs.push(dir);
    const n = await startNetPublicMesh({ upstream: up.base, stateDir: dir }); nodes.push(n.node);

    const captured: MeshEvent[] = [];
    const client = await startMeshClient({
      firstContact: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-events',
      resolve: chainResolve(() => CHAIN, K),
      events: (e) => captured.push(e),
    });
    clients.push(client);
    await client.check();

    const dials = captured.filter((e): e is Extract<MeshEvent, { kind: 'dial' }> => e.kind === 'dial' && e.nodeId === n.id);
    expect(dials.length, 'at least one dial event').toBeGreaterThanOrEqual(1);
    expect(dials.some((d) => d.outcome.result === 'connected'), 'one dial resolved').toBe(true);
    const connected = dials.find((d) => d.outcome.result === 'connected')!;
    expect(connected.ms, 'the time is a non-negative number').toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('a connection open writes a `connection` event with the peer, the transport, the path, the direction and the connection id', async () => {
    const up = await chainUpstream(CHAIN); ups.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'ev-conn-')); dirs.push(dir);
    const n = await startNetPublicMesh({ upstream: up.base, stateDir: dir }); nodes.push(n.node);
    const captured: MeshEvent[] = [];
    const client = await startMeshClient({
      firstContact: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-events',
      resolve: chainResolve(() => CHAIN, K),
      events: (e) => captured.push(e),
    });
    clients.push(client);
    await client.check();

    const opens = captured.filter((e): e is Extract<MeshEvent, { kind: 'connection' }> =>
      e.kind === 'connection' && e.event === 'open' && e.peer === n.id,
    );
    expect(opens.length, 'at least one open event for the node').toBeGreaterThanOrEqual(1);
    const open = opens[0]!;
    expect(open.peerKind, 'a Notis key is recognised').toBe('notis');
    expect(open.direction, 'the client dialled out').toBe('outbound');
    expect(open.transport, 'webrtc-direct is the dialled transport').toBe('webrtc-direct');
    expect(open.path, 'direct path').toBe('direct');
    expect(open.connId.length, 'a non-empty connection id').toBeGreaterThan(0);
  }, 60_000);

  it('a handshake that passes writes a `handshake` event with `verdict: "passed"`', async () => {
    const up = await chainUpstream(CHAIN); ups.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'ev-hs-ok-')); dirs.push(dir);
    const n = await startNetPublicMesh({ upstream: up.base, stateDir: dir }); nodes.push(n.node);
    const captured: MeshEvent[] = [];
    const client = await startMeshClient({
      firstContact: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-events',
      resolve: chainResolve(() => CHAIN, K),
      events: (e) => captured.push(e),
    });
    clients.push(client);
    await client.check();

    const handshakes = captured.filter((e): e is Extract<MeshEvent, { kind: 'handshake' }> =>
      e.kind === 'handshake' && e.peer === n.id,
    );
    expect(handshakes.length, 'one handshake event').toBeGreaterThanOrEqual(1);
    const passed = handshakes.find((h) => h.verdict === 'passed');
    expect(passed, 'the handshake passed').toBeTruthy();
    expect(passed!.reason, 'passed carries no reason').toBeNull();
  }, 60_000);

  it('a handshake that declares no chain service writes a `handshake` event with `verdict: "no-chain"` and the recorded reason', async () => {
    const up = await chainUpstream(CHAIN); ups.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'ev-hs-noserve-')); dirs.push(dir);
    const n = await startNetPublicMesh({ upstream: up.base, stateDir: dir }); nodes.push(n.node);
    await overrideHandshakeNoChain(n);
    const captured: MeshEvent[] = [];
    const client = await startMeshClient({
      firstContact: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-events',
      resolve: chainResolve(() => CHAIN, K),
      events: (e) => captured.push(e),
    });
    clients.push(client);
    await client.check();

    const handshakes = captured.filter((e): e is Extract<MeshEvent, { kind: 'handshake' }> =>
      e.kind === 'handshake' && e.peer === n.id,
    );
    expect(handshakes.length, 'one handshake event').toBeGreaterThanOrEqual(1);
    const noChain = handshakes.find((h) => h.verdict === 'no-chain');
    expect(noChain, 'the no-chain verdict').toBeTruthy();
    expect(noChain!.reason, 'the recorded reason').toBe('no chain service');
  }, 60_000);

  it('a serving stream writes `serving-stream` and `serving-call` events', async () => {
    const up = await chainUpstream(CHAIN); ups.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'ev-serve-')); dirs.push(dir);
    const n = await startNetPublicMesh({ upstream: up.base, stateDir: dir }); nodes.push(n.node);

    const postText = 'hello from serving';
    const postIdHex = '11' + '00'.repeat(31);
    const postHash = computeContentHash(postText);
    const captured: MeshEvent[] = [];
    const client = await startMeshClient({
      firstContact: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-events',
      resolve: chainResolve(() => CHAIN, K),
      events: (e) => captured.push(e),
      serving: { on: true, texts: providerFor(new Map([[postIdHex, postText]])) },
    });
    clients.push(client);
    await client.check();
    const clientPeerId = client.libp2p.peerId.toString();

    await vi.waitFor(() => {
      expect(n.node.getServingReaders()).toContain(clientPeerId);
    }, { timeout: 15_000, interval: 200 });

    const answers = await n.node.requestPostBodies(
      [{ id: postIdHex, contentHash: postHash }],
      clientPeerId,
    );
    expect(answers, 'the node reads the text back from the serving client').toEqual([{ id: postIdHex, content: postText }]);

    // The sink runs synchronously inside the handler; let microtasks drain.
    await new Promise((r) => setTimeout(r, 200));

    const streams = captured.filter((e): e is Extract<MeshEvent, { kind: 'serving-stream' }> => e.kind === 'serving-stream');
    const calls = captured.filter((e): e is Extract<MeshEvent, { kind: 'serving-call' }> => e.kind === 'serving-call');
    expect(streams.length, 'one serving-stream event per serving stream').toBeGreaterThanOrEqual(1);
    expect(streams[0]!.nodeId, 'the serving stream carries the node id').toBe(n.id);
    expect(streams[0]!.connId.length, 'a non-empty connection id').toBeGreaterThan(0);
    expect(calls.length, 'one serving-call event per provider call').toBeGreaterThanOrEqual(1);
    expect(calls[0]!.asked, 'the ids asked').toBe(1);
    expect(calls[0]!.answered, 'the ids the provider found').toBe(1);
  }, 90_000);

  it('diagnostics() over a real connection answers each open connection with the peer, address, direction, transport, path, limited flag, age and handshake', async () => {
    const up = await chainUpstream(CHAIN); ups.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'ev-diag-')); dirs.push(dir);
    const n = await startNetPublicMesh({ upstream: up.base, stateDir: dir }); nodes.push(n.node);
    const client = await startMeshClient({
      firstContact: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-events',
      resolve: chainResolve(() => CHAIN, K),
    });
    clients.push(client);
    await client.check();

    const d = client.diagnostics();
    const forNode = d.connections.find((c) => c.peer === n.id);
    expect(forNode, 'the node is one of the open connections').toBeTruthy();
    expect(forNode!.peerKind).toBe('notis');
    expect(forNode!.direction).toBe('outbound');
    expect(forNode!.transport).toBe('webrtc-direct');
    expect(forNode!.path).toBe('direct');
    expect(forNode!.limited, 'webrtc-direct is unlimited').toBe(false);
    expect(forNode!.ageMs, 'the age is a non-negative number').toBeGreaterThanOrEqual(0);
    expect(forNode!.remoteAddr.length, 'the remote address is non-empty').toBeGreaterThan(0);
    expect(forNode!.connId.length).toBeGreaterThan(0);
    // The handshake verdict is one of the three; passed on a real node.
    expect(forNode!.handshake.verdict).toBe('passed');
    // gossip and iceServers read as structured values; no assertion
    // on specific counts since they depend on live gossipsub state.
    expect(d.gossip.meshPeers).toBeGreaterThanOrEqual(0);
    expect(d.gossip.directPeers).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(d.iceServers)).toBe(true);
  }, 60_000);
});
