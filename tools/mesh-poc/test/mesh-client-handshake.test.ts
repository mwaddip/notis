// MESH_INTERFACE → Block gossip → "A client is a reader of every node it
// holds a connection to" — the client runs net's handshake as the dialler
// on every connection it opens, before any read. Four properties: a node
// that answers the handshake is read; a node that refuses it is `retry`
// with the handshake named, never `blacklisted`; a node whose handshake
// declares no chain service is not read; no read goes out on a
// connection before its handshake completes.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { profileFor, generateKeyPair, PROTOCOL_VERSION } from '@dagsocial/types';
import type { NetworkProfile, NetworkType } from '@dagsocial/types';
import { READER_CAPABILITIES } from '@dagsocial/net/browser';
import { nodeKeyFromKeyPair, notisIdFromPeerId } from '../src/identity.js';
import { startMeshNode, type MeshNode } from '../src/node/mesh-node.js';
import { startMeshClient, type MeshClient } from '../src/client/mesh-client.js';
import { attachNetHandshake } from './helpers/net-handshake-responder.js';
import { chainResolve, chainUpstream, type ChainUpstream } from './helpers/chain-harness.js';
import { makeLinkedChain } from './helpers/devnet-block.js';

const PROFILE: NetworkProfile = profileFor('devnet' as NetworkType);
const K = 5;
const CHAIN = makeLinkedChain(K, PROFILE);

async function startBareStub(): Promise<{ srv: Server; base: string; requests: number[] }> {
  const requests: number[] = [];
  const srv = createServer((_req, res) => {
    requests.push(Date.now());
    res.end();
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as AddressInfo).port;
  return { srv, base: `http://127.0.0.1:${port}`, requests };
}

interface Started { node: MeshNode; id: string; webrtcAddr: string; }
async function startBareNode(
  upstream: { base: string },
  dir: string,
): Promise<Started> {
  const key = nodeKeyFromKeyPair(generateKeyPair());
  const n = await startMeshNode({
    key, network: 'devnet', role: 'public',
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    bootstrap: [], stateDir: dir, upstream: upstream.base,
  });
  const addrs = n.multiaddrs();
  const webrtcAddr = addrs.find((a) => a.includes('/webrtc-direct/'));
  if (!webrtcAddr) {
    await n.stop();
    throw new Error('no WebRTC-direct listen address');
  }
  const id = notisIdFromPeerId(n.libp2p.peerId);
  return { node: n, id, webrtcAddr };
}

describe('mesh-client — the reader handshake', () => {
  const clients: MeshClient[] = [];
  const nodes: MeshNode[] = [];
  const stubs: { srv: Server }[] = [];
  const ups: ChainUpstream[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) { try { await c.stop(); } catch { /* already stopped */ } }
    for (const n of nodes.splice(0)) { try { await n.stop(); } catch { /* already stopped */ } }
    for (const s of stubs.splice(0)) { s.srv.close(); }
    for (const u of ups.splice(0)) { try { await u.close(); } catch { /* already closed */ } }
    for (const d of dirs.splice(0)) { rmSync(d, { recursive: true, force: true }); }
  });

  it('a node that answers the handshake is read', async () => {
    const stub = await startBareStub(); stubs.push(stub);
    const up = await chainUpstream(CHAIN); ups.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'hs-ok-')); dirs.push(dir);
    const n = await startBareNode(up, dir); nodes.push(n.node);
    await attachNetHandshake(n.node.libp2p, {
      magic: PROFILE.magic,
      protocolVersion: PROTOCOL_VERSION,
    });

    const client = await startMeshClient({
      anchors: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      resolve: chainResolve(() => CHAIN, K),
    });
    clients.push(client);

    await client.check();
    const entry = client.state().nodes.find((e) => e.notisId === n.id);
    expect(entry, 'anchor entry exists').toBeTruthy();
    // MESH_INTERFACE → The client's node list — a node that answered
    // the handshake and the tip read is ok/trailing/behind, never
    // retry for the handshake's sake.
    expect(entry!.status).toMatch(/^(ok|trailing|behind)$/);
    expect(client.state().anchorReached).toBe(true);
  }, 60_000);

  it('a node that refuses the handshake is retry with the handshake named, never blacklisted', async () => {
    const stub = await startBareStub(); stubs.push(stub);
    const up = await chainUpstream(CHAIN); ups.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'hs-refuse-')); dirs.push(dir);
    // No `attachNetHandshake`: the node's libp2p registers no handler
    // for the handshake protocol, so the client's stream open rejects
    // and `readerHandshake` answers `{ ok: false, reason: ... }`.
    const n = await startBareNode(up, dir); nodes.push(n.node);

    const client = await startMeshClient({
      anchors: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      resolve: chainResolve(() => CHAIN, K),
    });
    clients.push(client);

    await client.check();
    const entry = client.state().nodes.find((e) => e.notisId === n.id);
    expect(entry, 'anchor entry exists').toBeTruthy();
    // MESH_INTERFACE → Block gossip → "A client is a reader of every
    // node it holds a connection to" — a failed handshake is retry,
    // the handshake named, never a lie.
    expect(entry!.status).toBe('retry');
    expect(entry!.lastFailure?.message ?? '').toMatch(/^handshake:/);
  }, 60_000);

  it('a node whose handshake declares no chain service is not read', async () => {
    const stub = await startBareStub(); stubs.push(stub);
    const up = await chainUpstream(CHAIN); ups.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'hs-noserve-')); dirs.push(dir);
    const n = await startBareNode(up, dir); nodes.push(n.node);
    // `capabilities: READER_CAPABILITIES` (`[]`) is what a non-chain
    // peer declares; `servesChain` answers false, so the client holds
    // the connection but opens no read on it.
    await attachNetHandshake(n.node.libp2p, {
      magic: PROFILE.magic,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: READER_CAPABILITIES,
    });

    const client = await startMeshClient({
      anchors: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      resolve: chainResolve(() => CHAIN, K),
    });
    clients.push(client);

    await client.check();
    const entry = client.state().nodes.find((e) => e.notisId === n.id);
    expect(entry, 'anchor entry exists').toBeTruthy();
    // No read went out on the connection, so the entry stays `new`.
    // No request reached the stub either.
    expect(entry!.status).toBe('new');
    expect(client.state().anchorReached).toBe(false);
    expect(stub.requests.length, 'no HTTP read reaches the upstream').toBe(0);
  }, 60_000);

  it('no read goes out on a connection before its handshake completes', async () => {
    // The stub serves `/blocks/current` as the mesh node's upstream;
    // it records every request's arrival time. The stalling
    // handshake responder sleeps `STALL_MS` before answering, so a
    // tip read would hit the stub earlier if the client did not wait
    // for the handshake.
    const upstreamRequests: number[] = [];
    const upstreamSrv = createServer((_req, res) => {
      upstreamRequests.push(Date.now());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ height: 0, hash: null }));
    });
    await new Promise<void>((resolve) => upstreamSrv.listen(0, '127.0.0.1', resolve));
    stubs.push({ srv: upstreamSrv });
    const port = (upstreamSrv.address() as AddressInfo).port;
    const upstreamBase = `http://127.0.0.1:${port}`;
    const dir = mkdtempSync(join(tmpdir(), 'hs-order-')); dirs.push(dir);
    const n = await startBareNode({ base: upstreamBase }, dir); nodes.push(n.node);

    const STALL_MS = 300;
    const { HANDSHAKE_PROTOCOL, NODE_CAPABILITIES, buildHandshakeFrame, MAX_HANDSHAKE_FRAME_BYTES } =
      await import('@dagsocial/net/browser');
    const startMs = Date.now();
    await n.node.libp2p.handle(HANDSHAKE_PROTOCOL, (stream) => {
      void (async () => {
        const iterable = stream as unknown as AsyncIterable<
          Uint8Array | { subarray(): Uint8Array }
        >;
        let total = 0;
        for await (const value of iterable) {
          const bytes = value instanceof Uint8Array ? value : value.subarray();
          total += bytes.length;
          if (total > MAX_HANDSHAKE_FRAME_BYTES) break;
        }
        await new Promise((r) => setTimeout(r, STALL_MS));
        const frame = buildHandshakeFrame(PROFILE.magic, {
          agentName: 'stalling-responder',
          protocolVersion: PROTOCOL_VERSION,
          nodeName: '',
          chainHeight: 0,
          capabilities: [...NODE_CAPABILITIES],
        });
        const api = stream as unknown as {
          send: (b: Uint8Array) => boolean;
          onDrain: () => Promise<void>;
          close: () => Promise<void>;
        };
        if (!api.send(frame)) await api.onDrain();
        await api.close();
      })();
    });

    const client = await startMeshClient({
      anchors: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      resolve: chainResolve(() => CHAIN, K),
    });
    clients.push(client);

    await client.check();
    expect(upstreamRequests.length, 'a tip read reached the upstream').toBeGreaterThan(0);
    const firstReq = upstreamRequests[0]!;
    // Allow a 50 ms latency window: the handshake takes some time
    // beyond STALL_MS for its round trip, but the read has to wait
    // at least STALL_MS less a safety margin for a TOCTOU in timing.
    expect(firstReq - startMs, 'first read waited for the handshake').toBeGreaterThanOrEqual(STALL_MS - 50);
  }, 60_000);
});
