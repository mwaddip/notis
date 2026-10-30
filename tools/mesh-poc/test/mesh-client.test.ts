// MESH_INTERFACE → Transports / Discovery / The client's node list / The
// node endpoint — the client, in Node, against mesh nodes over
// WebRTC-direct with upstream stubs and a fake `resolve`. The DNS and ICE
// refusals and the dist/lib.js scan live here too: refusals held under
// their own cases, the browser-safety scan reads the built bundle a
// `src/lib.ts` reaches.

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from '@dagsocial/types';
import { profileFor } from '@dagsocial/types';
import type { NetworkProfile, NetworkType } from '@dagsocial/types';
import type { TipResult, NodeTipResult } from '@dagsocial/nipopow-client';
import { nodeKeyFromKeyPair, notisIdFromPeerId } from '../src/identity.js';
import { meshBaseUrl } from '../src/mesh-url.js';
import { MeshConfigError } from '../src/config.js';
import { startMeshNode, type MeshNode } from '../src/node/mesh-node.js';
import { startMeshClient, type MeshClient } from '../src/client/mesh-client.js';

// MESH_INTERFACE → The node endpoint — a tiny upstream the mesh node
// forwards to; the dial-by-key case reads /blocks/current back.
interface Stub { srv: Server; base: string; }
async function makeStub(id: number): Promise<Stub> {
  const srv = createServer((req, res) => {
    if (req.url === '/blocks/current') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ height: id * 10 + 1, id: (id === 0 ? 'ab' : 'cd').repeat(32) }));
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as AddressInfo).port;
  return { srv, base: `http://127.0.0.1:${port}` };
}

async function startNode(stub: Stub, dir: string): Promise<{ node: MeshNode; id: string; webrtcAddr: string }> {
  const key = nodeKeyFromKeyPair(generateKeyPair());
  const n = await startMeshNode({
    key, network: 'devnet', role: 'public',
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    bootstrap: [], stateDir: dir, upstream: stub.base,
  });
  const addrs = n.multiaddrs();
  const webrtcAddr = addrs.find((a) => a.includes('/webrtc-direct/'));
  if (!webrtcAddr) {
    await n.stop();
    throw new Error(`no WebRTC-direct listen address: ${JSON.stringify(addrs)}`);
  }
  const id = notisIdFromPeerId(n.libp2p.peerId);
  return { node: n, id, webrtcAddr };
}

const PROFILE: NetworkProfile = profileFor('devnet' as NetworkType);

function fakeResolveWith(
  answers: readonly ((urls: string[]) => TipResult)[],
): typeof import('@dagsocial/nipopow-client').resolveTip {
  let call = 0;
  return async (urls) => {
    const a = answers[Math.min(call, answers.length - 1)]!;
    call += 1;
    return a(urls);
  };
}

function winnerFirst(urls: string[]): TipResult {
  const nodes: NodeTipResult[] = urls.map((url, i) => ({
    url,
    verified: true,
    proof: { prefix: [], suffixHead: {}, suffixTail: [] } as unknown as NodeTipResult['proof'],
    verifyResult: null,
    refuseReason: null,
    refuseCode: null,
    behind: i === 0 ? 0 : 1,
    genesisHash: 'f'.repeat(64),
  }));
  return {
    winner: nodes[0] ?? null,
    winnerIndex: nodes.length > 0 ? 0 : -1,
    nodes,
    tip: null,
    suffixHead: null,
    splits: [],
  };
}

function invalidWithProof(url: string): NodeTipResult {
  return {
    url,
    verified: false,
    proof: { prefix: [], suffixHead: {}, suffixTail: [] } as unknown as NodeTipResult['proof'],
    verifyResult: null,
    refuseReason: 'verify failed: bad header',
    refuseCode: 'invalid',
    behind: null,
    genesisHash: null,
  };
}

describe('mesh-client — refusals, dialling by key, state and triggers', () => {
  const nodes: MeshNode[] = [];
  const stubs: Stub[] = [];
  const dirs: string[] = [];
  const clients: MeshClient[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) { try { await c.stop(); } catch { /* already stopped */ } }
    for (const n of nodes.splice(0)) { try { await n.stop(); } catch { /* already stopped */ } }
    for (const s of stubs.splice(0)) { s.srv.close(); }
    for (const d of dirs.splice(0)) { rmSync(d, { recursive: true, force: true }); }
  });

  // Each prefix below is a shape — "a <setting> is refused" — one case per
  // the three DNS prefixes a multiaddr may carry.
  for (const prefix of ['/dns4/example.com/tcp/1', '/dns6/example.com/tcp/1', '/dnsaddr/example.com/tcp/1']) {
    it(`a DNS anchor is refused — ${prefix}`, async () => {
      const anchorKey = nodeKeyFromKeyPair(generateKeyPair());
      let thrown: unknown;
      try {
        await startMeshClient({
          anchors: [{ notisId: anchorKey.notisId, addrs: [prefix] }],
          network: 'devnet',
          profile: PROFILE,
          stunServers: [],
          resolve: fakeResolveWith([(u) => winnerFirst(u)]),
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(MeshConfigError);
    }, 30_000);
  }

  it('a hostname ICE server is refused and an IP ICE server is accepted', async () => {
    const anchorKey = nodeKeyFromKeyPair(generateKeyPair());
    let thrown: unknown;
    try {
      await startMeshClient({
        anchors: [{ notisId: anchorKey.notisId, addrs: [] }],
        network: 'devnet',
        profile: PROFILE,
        stunServers: ['stun:stun.example.org:3478'],
        resolve: fakeResolveWith([]),
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MeshConfigError);

    // Each IP form accepted — a `startMeshClient` that returned starts a
    // libp2p node, so `stop()` is called before the test exits.
    for (const ice of ['stun:10.0.0.1:3478', 'stun:[fd00::1]:3478']) {
      const client = await startMeshClient({
        anchors: [{ notisId: anchorKey.notisId, addrs: [] }],
        network: 'devnet',
        profile: PROFILE,
        stunServers: [ice],
        resolve: fakeResolveWith([(u) => winnerFirst(u)]),
      });
      clients.push(client);
      expect(client.state().anchorReached).toBe(false);
    }
  }, 60_000);

  it('the client reads a node by key', async () => {
    const stub = await makeStub(0); stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-client-')); dirs.push(dir);
    const started = await startNode(stub, dir); nodes.push(started.node);
    const client = await startMeshClient({
      anchors: [{ notisId: started.id, addrs: [started.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      stunServers: [],
      resolve: fakeResolveWith([(u) => winnerFirst(u)]),
    });
    clients.push(client);
    await client.check();

    const res = await client.fetch(meshBaseUrl(started.id) + '/blocks/current');
    expect(res.status).toBe(200);
    const text = await res.text();
    const direct = await (await globalThis.fetch(`${stub.base}/blocks/current`)).text();
    expect(text).toBe(direct);

    const s = client.state();
    expect(s.nodeId).toBe(started.id);
    expect(s.transport).toBe('webrtc-direct');
    expect(s.path).toBe('direct');
    expect(s.anchorReached).toBe(true);
  }, 60_000);

  it('the node in use going away moves the client', async () => {
    const stubA = await makeStub(0); stubs.push(stubA);
    const stubB = await makeStub(1); stubs.push(stubB);
    const dirA = mkdtempSync(join(tmpdir(), 'mesh-client-a-')); dirs.push(dirA);
    const dirB = mkdtempSync(join(tmpdir(), 'mesh-client-b-')); dirs.push(dirB);
    const a = await startNode(stubA, dirA); nodes.push(a.node);
    const b = await startNode(stubB, dirB); nodes.push(b.node);

    const client = await startMeshClient({
      anchors: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet',
      profile: PROFILE,
      stunServers: [],
      // First check keeps A as winner; a second one, once A is gone, keeps B.
      resolve: fakeResolveWith([(u) => winnerFirst(u), (u) => winnerFirst(u)]),
    });
    clients.push(client);

    await client.check();
    expect(client.state().nodeId).toBe(a.id);

    // Stop node A — the next check cannot reach it.
    await a.node.stop();
    nodes.splice(nodes.indexOf(a.node), 1);

    await client.check();
    const s = client.state();
    expect(s.nodeId).toBe(b.id);
    expect(s.lastLeft).not.toBeNull();
    expect(s.lastLeft!.nodeId).toBe(a.id);
    expect(s.lastLeft!.reason).toMatch(/^failure:/);
    const entryA = s.nodes.find((n) => n.notisId === a.id);
    expect(entryA?.status).toBe('retry');
  }, 90_000);

  it('an address that answers with another key is dropped, not the key', async () => {
    const stubA = await makeStub(0); stubs.push(stubA);
    const stubB = await makeStub(1); stubs.push(stubB);
    const dirA = mkdtempSync(join(tmpdir(), 'mesh-client-a-')); dirs.push(dirA);
    const dirB = mkdtempSync(join(tmpdir(), 'mesh-client-b-')); dirs.push(dirB);
    const a = await startNode(stubA, dirA); nodes.push(a.node);
    const b = await startNode(stubB, dirB); nodes.push(b.node);

    // The anchor lists A's id with B's address first, A's own second.
    // The client dials B's address, discovers B's key, drops that address,
    // moves on to A's own and connects.
    const client = await startMeshClient({
      anchors: [{ notisId: a.id, addrs: [b.webrtcAddr, a.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      stunServers: [],
      resolve: fakeResolveWith([(u) => winnerFirst(u)]),
    });
    clients.push(client);

    await client.check();
    const s = client.state();
    const entry = s.nodes.find((n) => n.notisId === a.id);
    expect(entry).toBeDefined();
    expect(entry!.status).not.toBe('blacklisted');
    expect(entry!.droppedAddrs).toContain(b.webrtcAddr);
    expect(entry!.addrs).not.toContain(b.webrtcAddr);
    expect(entry!.addrs).toContain(a.webrtcAddr);
    // The anchor reached through its second address.
    expect(s.nodeId).toBe(a.id);
  }, 90_000);

  it('a lying node is blacklisted with its evidence', async () => {
    const stub = await makeStub(0); stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-client-')); dirs.push(dir);
    const started = await startNode(stub, dir); nodes.push(started.node);

    // The fake resolve answers 'invalid' with a proof — the proof-invalid
    // row of the mapping (`tipEvents`).
    const client = await startMeshClient({
      anchors: [{ notisId: started.id, addrs: [started.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      stunServers: [],
      resolve: fakeResolveWith([
        (urls) => ({
          winner: null,
          winnerIndex: -1,
          nodes: urls.map(invalidWithProof),
          tip: null,
          suffixHead: null,
          splits: [],
        }),
        // A later check must not be able to revive the node — but the
        // candidate list drops it before the resolve is called.
        () => ({ winner: null, winnerIndex: -1, nodes: [], tip: null, suffixHead: null, splits: [] }),
      ]),
    });
    clients.push(client);

    await client.check();
    let entry = client.state().nodes.find((n) => n.notisId === started.id)!;
    expect(entry.status).toBe('blacklisted');
    expect(entry.evidence).not.toBeNull();
    expect(entry.evidence!.kind).toBe('proof-invalid');

    // A second check: the blacklisted node is never a candidate again.
    await client.check();
    entry = client.state().nodes.find((n) => n.notisId === started.id)!;
    expect(entry.status).toBe('blacklisted');
    expect(client.state().nodeId).toBeNull();
  }, 90_000);

  it('no anchor reached', async () => {
    const stub = await makeStub(0); stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-client-')); dirs.push(dir);
    const started = await startNode(stub, dir); // not pushed: we stop it right away
    await started.node.stop();

    const client = await startMeshClient({
      anchors: [{ notisId: started.id, addrs: [started.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      stunServers: [],
      // No candidate reachable — resolve may still be called with an empty
      // list; its empty answer leaves the state untouched.
      resolve: fakeResolveWith([() => ({ winner: null, winnerIndex: -1, nodes: [], tip: null, suffixHead: null, splits: [] })]),
    });
    clients.push(client);

    await client.check();
    const s = client.state();
    expect(s.anchorReached).toBe(false);
    // The anchor entry survives the failed dial — the client reached it
    // and recorded the failure, so a reader can tell "no anchor reached"
    // from "the client ran no check at all".
    expect(s.nodes.length).toBe(1);
    expect(s.nodes[0]!.notisId).toBe(started.id);
    expect(s.nodes[0]!.status).toBe('retry');
  }, 60_000);

  it('a failed fetch to the node in use checks at once', async () => {
    const stub = await makeStub(0); stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-client-')); dirs.push(dir);
    const started = await startNode(stub, dir); nodes.push(started.node);

    let resolveCalls = 0;
    const client = await startMeshClient({
      anchors: [{ notisId: started.id, addrs: [started.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      stunServers: [],
      resolve: fakeResolveWith([
        (u) => { resolveCalls += 1; return winnerFirst(u); },
        () => { resolveCalls += 1; return { winner: null, winnerIndex: -1, nodes: [], tip: null, suffixHead: null, splits: [] }; },
      ]),
    });
    clients.push(client);

    await client.check();
    expect(client.state().nodeId).toBe(started.id);
    const callsBefore = resolveCalls;

    // Stop the node, then a client.fetch to it fails: the second check
    // runs without waiting for CHECK_INTERVAL_MS. We await a resolve-call
    // count change rather than a timeout: the test rules out "nothing
    // happened because the timer did not fire".
    await started.node.stop();
    nodes.splice(nodes.indexOf(started.node), 1);
    let fetchError: unknown;
    try {
      await client.fetch(meshBaseUrl(started.id) + '/blocks/current');
    } catch (e) {
      fetchError = e;
    }
    expect(fetchError).toBeDefined();

    const deadlineMs = Date.now() + 10_000;
    while (resolveCalls === callsBefore && Date.now() < deadlineMs) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(resolveCalls).toBeGreaterThan(callsBefore);
  }, 60_000);

  it('the client imports nothing from node:', async () => {
    const distLib = fileURLToPath(new URL('../dist/lib.js', import.meta.url));
    expect(existsSync(distLib), `dist/lib.js must exist — run pnpm build first (${distLib})`).toBe(true);
    const code = readFileSync(distLib, 'utf8');
    // tsup externalises every dependency, so an import from a Node builtin
    // appears verbatim as `from "node:…"` in dist/lib.js. The scan refuses
    // the prefix in any import form a tsup bundle emits.
    const nodeImport = /(?:from\s*['"]|require\s*\(\s*['"]|import\s*\(\s*['"])node:/;
    expect(code).not.toMatch(nodeImport);
  }, 30_000);
});
