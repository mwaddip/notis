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
import { profileFor, PROTOCOL_VERSION } from '@dagsocial/types';
import type { NetworkProfile, NetworkType } from '@dagsocial/types';
import {
  HANDSHAKE_PROTOCOL,
  NODE_CAPABILITIES,
  READER_CAPABILITIES,
  buildHandshakeFrame,
  decodeFrame,
  MAX_HANDSHAKE_FRAME_BYTES,
} from '@dagsocial/net/browser';
import { NetNode } from '@dagsocial/net';
import { startMeshClient, type MeshClient } from '@dagsocial/web/mesh';
import { startNetPublicMesh, type NetMeshNode } from './helpers/net-public-node.js';
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

/**
 * NET_INTERFACE → Handshake → `"A peer becomes Active once"` — a handshake
 * handler registered on a running `NetNode`'s libp2p with `force: true`
 * replaces net's own, so the test case gets to shape the response (or
 * stall before it). The helpers below read the dialler's frame to its
 * cap, decode it to drop a malformed one, then write a frame carrying
 * `capabilities` back after `stallMs`. Stays inside this file — the
 * stall, the no-chain-serving and the no-handler cases are the only
 * three that bend net's handshake, and the helper has no other reader.
 */
async function overrideHandshake(
  node: NetMeshNode,
  opts: { capabilities: readonly number[]; stallMs?: number; agentName?: string },
): Promise<void> {
  const magic = PROFILE.magic;
  const stallMs = opts.stallMs ?? 0;
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
        if (stallMs > 0) await new Promise((r) => setTimeout(r, stallMs));
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

describe('mesh-client — the reader handshake', () => {
  const clients: MeshClient[] = [];
  const nodes: NetNode[] = [];
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
    const n = await startNetPublicMesh({ upstream: up.base, stateDir: dir }); nodes.push(n.node);

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
    const n = await startNetPublicMesh({ upstream: up.base, stateDir: dir }); nodes.push(n.node);
    // `libp2p.unhandle(HANDSHAKE_PROTOCOL)` drops net's own handler on
    // this node, so the client's stream open rejects with "protocol
    // not supported" and `readerHandshake` answers
    // `{ ok: false, reason: ... }`.
    await n.libp2p.unhandle(HANDSHAKE_PROTOCOL);

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
    const n = await startNetPublicMesh({ upstream: up.base, stateDir: dir }); nodes.push(n.node);
    // `capabilities: READER_CAPABILITIES` (`[]`) is what a non-chain
    // peer declares; `servesChain` answers false, so the client holds
    // the connection but opens no read on it. `overrideHandshake`
    // replaces net's own handler so the handshake answers with that
    // set in place of `NODE_CAPABILITIES`.
    await overrideHandshake(n, { capabilities: READER_CAPABILITIES });

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
    const n = await startNetPublicMesh({ upstream: upstreamBase, stateDir: dir }); nodes.push(n.node);

    const STALL_MS = 300;
    const startMs = Date.now();
    await overrideHandshake(n, {
      capabilities: NODE_CAPABILITIES,
      stallMs: STALL_MS,
      agentName: 'stalling-responder',
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

  // MESH_INTERFACE → The client's node list → "A check" — "timed from
  // the request to the end of the body", so a `readMs` holds the time
  // of the request alone. The connection's handshake is the
  // connection's, not the read's: a stalling handshake (300 ms) on top
  // of an instant tip response records a `readMs` well under the
  // stall.
  it('readMs holds the request alone, not the handshake wait', async () => {
    const upstreamSrv = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ height: 0, hash: null }));
    });
    await new Promise<void>((resolve) => upstreamSrv.listen(0, '127.0.0.1', resolve));
    stubs.push({ srv: upstreamSrv });
    const port = (upstreamSrv.address() as AddressInfo).port;
    const upstreamBase = `http://127.0.0.1:${port}`;
    const dir = mkdtempSync(join(tmpdir(), 'hs-readms-')); dirs.push(dir);
    const n = await startNetPublicMesh({ upstream: upstreamBase, stateDir: dir }); nodes.push(n.node);

    const STALL_MS = 300;
    await overrideHandshake(n, {
      capabilities: NODE_CAPABILITIES,
      stallMs: STALL_MS,
      agentName: 'stalling-responder-for-readms',
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
    expect(entry!.readMs, 'readMs is set').not.toBeNull();
    // The upstream answers at once; the handshake stalls 300 ms. The
    // recorded speed must be the request's own, not the connection's
    // wait, so it is well under the stall.
    expect(
      entry!.readMs!,
      `readMs ${entry!.readMs} ms must be well under the ${STALL_MS} ms handshake stall`,
    ).toBeLessThan(STALL_MS - 100);
  }, 60_000);
});
