// MESH_INTERFACE → The client's node list → "A read opens no connection"
// and → Block gossip → "A client is a reader of every node it holds a
// connection to" — a `fetch` of a `notis-mesh://` URL opens its stream on
// the connection the client already holds to the key, after that
// connection's handshake has passed. The client reports the request's
// head with the id, transport and path of the connection its stream
// opened on (→ The client's node list → "The client reports what it
// does").

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileFor, PROTOCOL_VERSION } from '@dagsocial/types';
import type { NetworkProfile, NetworkType } from '@dagsocial/types';
import {
  HANDSHAKE_PROTOCOL,
  NODE_CAPABILITIES,
  buildHandshakeFrame,
  decodeFrame,
  MAX_HANDSHAKE_FRAME_BYTES,
  meshBaseUrl,
} from '@dagsocial/net/browser';
import { NetNode } from '@dagsocial/net';
import { startMeshClient, type MeshClient, type MeshEvent } from '@dagsocial/web/mesh';
import { startNetPublicMesh, type NetMeshNode } from './helpers/net-public-node.js';
import { chainResolve, chainUpstream, type ChainUpstream } from './helpers/chain-harness.js';
import { makeLinkedChain } from './helpers/devnet-block.js';

const PROFILE: NetworkProfile = profileFor('devnet' as NetworkType);
const K = 5;
const CHAIN = makeLinkedChain(K, PROFILE);

/**
 * NET_INTERFACE → Handshake — replace net's own handler on a running
 * `NetNode` with one that reads the dialler's frame to its cap, waits
 * `stallMs`, then answers with a frame carrying `NODE_CAPABILITIES`. The
 * stall holds the handshake open on the dialler's side without reaching
 * into the client's private maps, so a case can issue a read while the
 * handshake is still pending.
 */
async function stallHandshake(node: NetMeshNode, stallMs: number): Promise<void> {
  const magic = PROFILE.magic;
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
        await new Promise((r) => setTimeout(r, stallMs));
        const frame = buildHandshakeFrame(magic, {
          agentName: 'stalling-responder',
          protocolVersion: PROTOCOL_VERSION,
          nodeName: 'stalling-responder',
          chainHeight: 0,
          capabilities: [...NODE_CAPABILITIES],
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

describe('mesh client — a mesh request over a real connection', () => {
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

  it.fails('a mesh read issued while its connection\'s handshake is still running answers the node\'s response and names the connection', async () => {
    const up = await chainUpstream(CHAIN); ups.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'mr-pending-')); dirs.push(dir);
    const n = await startNetPublicMesh({ upstream: up.base, stateDir: dir }); nodes.push(n.node);
    // The responder stalls long enough that a read issued in the
    // `connection:open` handler is under way before the handshake
    // completes. `NODE_CAPABILITIES` keeps the handshake chain-serving,
    // so after the stall the connection is ready for reads.
    await stallHandshake(n, 400);

    const captured: MeshEvent[] = [];
    const client = await startMeshClient({
      firstContact: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(() => CHAIN, K),
      events: (e) => captured.push(e),
    });
    clients.push(client);

    // Fire the mesh read synchronously in the first `connection:open`
    // for the target peer. The client's own listener runs first (it
    // was registered in `start()` before this one), so the handshake
    // promise is already recorded in the client by the time the fetch
    // is issued — but it has not resolved yet.
    const meshUrl = `${meshBaseUrl(n.id)}/blocks/current`;
    let fetchPromise: Promise<Response> | null = null;
    const fetchStarted = new Promise<void>((resolveStarted) => {
      const onOpen = (ev: { detail: { remotePeer: { toString(): string } } }): void => {
        try {
          if (ev.detail.remotePeer.toString() !== n.libp2p.peerId.toString()) return;
        } catch {
          return;
        }
        client.libp2p.removeEventListener('connection:open', onOpen);
        const p = client.fetch(meshUrl, undefined);
        // Absorb the rejection here so it does not land as an
        // unhandled rejection; the test body awaits `p` again and
        // reads the real outcome.
        p.catch(() => undefined);
        fetchPromise = p;
        resolveStarted();
      };
      client.libp2p.addEventListener('connection:open', onOpen);
    });

    await client.check();
    await fetchStarted;
    const response = await fetchPromise!;
    expect(response.status, 'the node answered the mesh read with 200').toBe(200);

    // The `request` event for this URL carries `route: 'mesh'`, head
    // is ok, and names the connection libp2p opened the stream on.
    const requests = captured.filter(
      (e): e is Extract<MeshEvent, { kind: 'request' }> =>
        e.kind === 'request' && e.url === meshUrl,
    );
    expect(requests.length, 'one request event for the mesh URL').toBe(1);
    const ev = requests[0]!;
    expect(ev.route, 'the mesh route').toBe('mesh');
    expect(ev.head.ok, 'the request\'s head is ok').toBe(true);
    expect(ev.connection, 'the event names the connection').toBeDefined();
    const openConns = client.libp2p.getConnections(n.libp2p.peerId);
    expect(openConns.length, 'the client holds a connection to the node').toBeGreaterThanOrEqual(1);
    const ids = openConns.map((c) => c.id);
    expect(ids, 'the event\'s connection id is one libp2p holds').toContain(ev.connection!.id);
  }, 60_000);
});
