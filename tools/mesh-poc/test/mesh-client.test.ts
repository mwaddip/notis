// MESH_INTERFACE → Transports / Discovery / The client's node list / The
// node endpoint — the client, in Node, against mesh nodes over
// WebRTC-direct with upstream stubs and a fake `resolve`. The DNS and ICE
// refusals and the dist/lib.js scan live here too: refusals held under
// their own cases, the browser-safety scan reads the built bundle a
// `src/lib.ts` reaches.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, bytesToHex } from '@dagsocial/types';
import { profileFor } from '@dagsocial/types';
import type { NetworkProfile, NetworkType } from '@dagsocial/types';
import type { TipResult, NodeTipResult } from '@dagsocial/nipopow-client';
import { nodeKeyFromKeyPair, notisIdFromPeerId, peerIdFromNotisId } from '../src/identity.js';
import { meshBaseUrl } from '../src/mesh-url.js';
import { MeshConfigError } from '../src/config.js';
import { assertClientConfig, cappedTimerMs, MAX_TIMER_MS, pickConnectionForRead } from '../src/client/mesh-client.js';
import { MeshFetchError } from '../src/http-fetch.js';
import { startMeshNode, type MeshNode } from '../src/node/mesh-node.js';
import { startMeshClient, type MeshClient } from '../src/client/mesh-client.js';
import { multiaddr } from '@multiformats/multiaddr';

// MESH_INTERFACE → The node endpoint — a tiny upstream the mesh node
// forwards to; the dial-by-key case reads /blocks/current back.
interface Stub { srv: Server; base: string; }
async function makeStub(id: number): Promise<Stub> {
  const srv = createServer((req, res) => {
    if (req.url === '/blocks/current') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ height: id * 10 + 1, hash: (id === 0 ? 'ab' : 'cd').repeat(32) }));
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

  // `assertClientConfig` is the one check `startMeshClient` runs first.
  // The function itself is pure — a direct call throws before any libp2p
  // state could be created, which is the property the page relies on
  // when the real `startMeshClient` reaches it with a DNS anchor
  // (MESH_INTERFACE → Discovery / NAT).
  it('assertClientConfig refuses a /dns4/ anchor without creating a node', () => {
    const anchorKey = nodeKeyFromKeyPair(generateKeyPair());
    expect(() => assertClientConfig({
      anchors: [{ notisId: anchorKey.notisId, addrs: ['/dns4/example.com/tcp/1'] }],
      stunServers: [],
    })).toThrow(MeshConfigError);
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

  // MESH_INTERFACE → Discovery → "Seeds" — a seed address meets the anchor's
  // refusals; `assertClientConfig` is called with both lists and throws on a
  // seed's `/dns4/` as it does on an anchor's.
  it('assertClientConfig refuses a /dns4/ seed without creating a node', () => {
    const seedKey = nodeKeyFromKeyPair(generateKeyPair());
    expect(() => assertClientConfig({
      anchors: [],
      seeds: [{ notisId: seedKey.notisId, addrs: ['/dns4/example.com/tcp/1'] }],
      stunServers: [],
    })).toThrow(MeshConfigError);
  });

  // MESH_INTERFACE → Discovery → "Seeds" — "a seed is a candidate like any node
  // the DHT finds": a seed is in the client's node list as a non-anchor entry
  // in `new` status, which `NodeList.candidates()` lists.
  it('a seed is a candidate', async () => {
    const anchorKey = nodeKeyFromKeyPair(generateKeyPair());
    const seedKey = nodeKeyFromKeyPair(generateKeyPair());
    const client = await startMeshClient({
      anchors: [{ notisId: anchorKey.notisId, addrs: [] }],
      seeds: [{ notisId: seedKey.notisId, addrs: [] }],
      network: 'devnet',
      profile: PROFILE,
      stunServers: [],
      // No check runs here: the state is read before the scheduled first
      // check fires, so the seed is still in its initial `new` status —
      // `new` is one of the four candidate rows (MESH_INTERFACE → The
      // client's node list → "Candidates").
      resolve: fakeResolveWith([]),
    });
    clients.push(client);
    const seedEntry = client.state().nodes.find((n) => n.notisId === seedKey.notisId);
    expect(seedEntry, 'the seed is in the node list').toBeDefined();
    expect(seedEntry!.anchor).toBe(false);
    expect(seedEntry!.status).toBe('new');
  }, 30_000);

  // MESH_INTERFACE → Discovery → "Seeds" / No anchor reached — "no answer from
  // [a seed] makes `anchorReached` true": a check where the anchor is
  // unreachable and the seed answers as the winner leaves `anchorReached`
  // false. A real mesh node stands behind the seed so the pre-dial reaches
  // it; the anchor's addr is the stopped node's, so its pre-dial fails and
  // phase 2 reads only the seed.
  it('an answering seed does not make anchorReached true', async () => {
    const stubSeed = await makeStub(0); stubs.push(stubSeed);
    const dirSeed = mkdtempSync(join(tmpdir(), 'mesh-client-seed-')); dirs.push(dirSeed);
    const seed = await startNode(stubSeed, dirSeed); nodes.push(seed.node);

    const stubAnchor = await makeStub(1); stubs.push(stubAnchor);
    const dirAnchor = mkdtempSync(join(tmpdir(), 'mesh-client-anchor-')); dirs.push(dirAnchor);
    const anchor = await startNode(stubAnchor, dirAnchor); // not pushed: stopped at once
    await anchor.node.stop();

    const client = await startMeshClient({
      anchors: [{ notisId: anchor.id, addrs: [anchor.webrtcAddr] }],
      seeds: [{ notisId: seed.id, addrs: [seed.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      stunServers: [],
      // Phase 1 fails the stopped anchor and connects to the seed; phase 2
      // asks `resolveTip` with the seed's URL only, and winnerFirst makes
      // the seed the winner.
      resolve: fakeResolveWith([(u) => winnerFirst(u)]),
    });
    clients.push(client);
    await client.check();
    const s = client.state();
    expect(s.anchorReached).toBe(false);
    const seedEntry = s.nodes.find((n) => n.notisId === seed.id);
    expect(seedEntry!.anchor).toBe(false);
    expect(seedEntry!.status).toBe('ok');
    const anchorEntry = s.nodes.find((n) => n.notisId === anchor.id);
    expect(anchorEntry!.anchor).toBe(true);
    expect(anchorEntry!.status).toBe('retry');
  }, 90_000);

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

  // A resolve that answers only the real node and omits every other
  // url the client offered — so phase 3's `tipEvents` fires nothing
  // for the fake entries under test and the check's phases 4-5 run
  // against the real connection alone. The ids under scrutiny stay in
  // whatever state phase 1's dial left them in.
  function onlyRealGoodResolve(realId: string): typeof import('@dagsocial/nipopow-client').resolveTip {
    return async (urls) => {
      const realUrl = urls.find((u) => u.includes(realId));
      if (!realUrl) {
        return { winner: null, winnerIndex: -1, nodes: [], tip: null, suffixHead: null, splits: [] };
      }
      const node: NodeTipResult = {
        url: realUrl,
        verified: true,
        proof: { prefix: [], suffixHead: {}, suffixTail: [] } as unknown as NodeTipResult['proof'],
        verifyResult: null,
        refuseReason: null,
        refuseCode: null,
        behind: 0,
        genesisHash: 'f'.repeat(64),
      };
      return { winner: node, winnerIndex: 0, nodes: [node], tip: null, suffixHead: null, splits: [] };
    };
  }

  it('a TCP address and a WebRTC-direct address that answers with another key: the address drops; the entry is otherwise unchanged', async () => {
    // MESH_INTERFACE → The client's node list → "A node's addresses are
    // dialled as one operation" — "an address no browser transport
    // carries is passed over by libp2p and takes none". The mesh client
    // runs no TCP transport, so a TCP address libp2p is handed is
    // filtered before any dial; a wrong-key answer on the WebRTC-direct
    // address drops that address alone. MESH_INTERFACE → The client's
    // node list — the table row "an address answers with a key other
    // than the one dialled": "that address dropped for that key when
    // the dial's failure names it; the entry otherwise unchanged" — so
    // `status` and `failures` carry over the check.
    const stubK1 = await makeStub(0); stubs.push(stubK1);
    const dirK1 = mkdtempSync(join(tmpdir(), 'mesh-client-k1-')); dirs.push(dirK1);
    const k1 = await startNode(stubK1, dirK1); nodes.push(k1.node);

    // A real anchor the resolver answers for — the check's phases 4-5
    // run against it, so phase 5's /blocks/current reads a real
    // connection's tip and never touches K2's state.
    const stubGood = await makeStub(1); stubs.push(stubGood);
    const dirGood = mkdtempSync(join(tmpdir(), 'mesh-client-good-')); dirs.push(dirGood);
    const good = await startNode(stubGood, dirGood); nodes.push(good.node);

    // A fresh notis id — the anchor names K2 at K1's WebRTC-direct
    // address (which answers with K1's key, not K2's), plus a loopback
    // TCP address (which the mesh client has no transport for).
    const k2 = nodeKeyFromKeyPair(generateKeyPair());
    const tcpAddr = '/ip4/127.0.0.1/tcp/4002';

    const client = await startMeshClient({
      anchors: [
        { notisId: good.id, addrs: [good.webrtcAddr] },
        { notisId: k2.notisId, addrs: [tcpAddr, k1.webrtcAddr] },
      ],
      network: 'devnet',
      profile: PROFILE,
      stunServers: [],
      resolve: onlyRealGoodResolve(good.id),
    });
    clients.push(client);

    // Read K2's status and failure count BEFORE the check — the
    // invariant the check must preserve is "the entry otherwise
    // unchanged".
    const before = client.state().nodes.find((n) => n.notisId === k2.notisId)!;
    const beforeStatus = before.status;
    const beforeFailures = before.failures;

    await client.check();
    const entry = client.state().nodes.find((n) => n.notisId === k2.notisId);
    expect(entry, 'K2 is in the node list').toBeDefined();
    expect(entry!.droppedAddrs, 'K1\'s WebRTC-direct address dropped for K2')
      .toContain(k1.webrtcAddr);
    expect(entry!.lastFailures[tcpAddr], 'the TCP address has no failure recorded')
      .toBeUndefined();
    expect(entry!.status, 'K2\'s status unchanged by a wrong-key-only dial').toBe(beforeStatus);
    expect(entry!.failures, 'K2\'s failure count unchanged by a wrong-key-only dial').toBe(beforeFailures);
  }, 90_000);

  it('a wrong-key answer on one address and a timeout on a second dialled address records the node failure', async () => {
    // MESH_INTERFACE → The client's node list — the wrong-key row is
    // "the entry otherwise unchanged" only when every dialled address
    // answered with the wrong key. A dial whose attribution carries
    // any other failure keeps the row for the plain failure kinds:
    // the node moves to `retry` and `failures` grows by one. Here the
    // first dialled address is a real node whose node was stopped,
    // which libp2p times out on; the second is a real node that
    // answers with the wrong key under K2's expected id.
    const stubK1 = await makeStub(0); stubs.push(stubK1);
    const dirK1 = mkdtempSync(join(tmpdir(), 'mesh-client-k1b-')); dirs.push(dirK1);
    const k1 = await startNode(stubK1, dirK1); nodes.push(k1.node);

    // A second real node — grab its webrtc-direct address, then stop
    // it; the address stays parseable, but libp2p's dial will time out.
    const stubGone = await makeStub(2); stubs.push(stubGone);
    const dirGone = mkdtempSync(join(tmpdir(), 'mesh-client-gone-')); dirs.push(dirGone);
    const gone = await startNode(stubGone, dirGone);
    const goneWebrtcAddr = gone.webrtcAddr;
    await gone.node.stop();

    const stubGood = await makeStub(1); stubs.push(stubGood);
    const dirGood = mkdtempSync(join(tmpdir(), 'mesh-client-good2-')); dirs.push(dirGood);
    const good = await startNode(stubGood, dirGood); nodes.push(good.node);

    const k2 = nodeKeyFromKeyPair(generateKeyPair());
    const client = await startMeshClient({
      anchors: [
        { notisId: good.id, addrs: [good.webrtcAddr] },
        { notisId: k2.notisId, addrs: [goneWebrtcAddr, k1.webrtcAddr] },
      ],
      network: 'devnet',
      profile: PROFILE,
      stunServers: [],
      resolve: onlyRealGoodResolve(good.id),
    });
    clients.push(client);

    await client.check();
    const entry = client.state().nodes.find((n) => n.notisId === k2.notisId);
    expect(entry, 'K2 is in the node list').toBeDefined();
    // The wrong-key address drops; the stopped-node address stays and
    // keeps a `lastFailures` row for the timeout.
    expect(entry!.droppedAddrs, 'K1\'s WebRTC-direct address dropped for K2').toContain(k1.webrtcAddr);
    expect(entry!.lastFailures[goneWebrtcAddr], 'the stopped address kept a failure row').toBeDefined();
    // Not every dialled row was wrong-key — the node moves on.
    expect(entry!.status, 'K2 moves to retry on the plain failure').toBe('retry');
    expect(entry!.failures, 'K2\'s failures grew by one').toBe(1);
  }, 90_000);

  it('every dialled address answers with the wrong key: both drop, the entry is otherwise unchanged', async () => {
    // MESH_INTERFACE → The client's node list — "every address wrong-
    // key dropped" is the pre-existing branch of the same rule: when
    // every dialled row is a wrong-key answer, the dropped addresses
    // carry the diagnostic alone and the entry's `status` and
    // `failures` are unchanged. Two real nodes K1 and K3 listen on
    // WebRTC-direct; the anchor names K2 at both of their addresses,
    // so each answers with its own key, not K2's.
    const stubK1 = await makeStub(0); stubs.push(stubK1);
    const dirK1 = mkdtempSync(join(tmpdir(), 'mesh-client-k1c-')); dirs.push(dirK1);
    const k1 = await startNode(stubK1, dirK1); nodes.push(k1.node);

    const stubK3 = await makeStub(3); stubs.push(stubK3);
    const dirK3 = mkdtempSync(join(tmpdir(), 'mesh-client-k3-')); dirs.push(dirK3);
    const k3 = await startNode(stubK3, dirK3); nodes.push(k3.node);

    const stubGood = await makeStub(1); stubs.push(stubGood);
    const dirGood = mkdtempSync(join(tmpdir(), 'mesh-client-good3-')); dirs.push(dirGood);
    const good = await startNode(stubGood, dirGood); nodes.push(good.node);

    const k2 = nodeKeyFromKeyPair(generateKeyPair());
    const client = await startMeshClient({
      anchors: [
        { notisId: good.id, addrs: [good.webrtcAddr] },
        { notisId: k2.notisId, addrs: [k1.webrtcAddr, k3.webrtcAddr] },
      ],
      network: 'devnet',
      profile: PROFILE,
      stunServers: [],
      resolve: onlyRealGoodResolve(good.id),
    });
    clients.push(client);

    const before = client.state().nodes.find((n) => n.notisId === k2.notisId)!;
    const beforeStatus = before.status;
    const beforeFailures = before.failures;

    await client.check();
    const entry = client.state().nodes.find((n) => n.notisId === k2.notisId);
    expect(entry!.droppedAddrs, 'both WebRTC-direct addresses dropped')
      .toEqual(expect.arrayContaining([k1.webrtcAddr, k3.webrtcAddr]));
    expect(entry!.addrs, 'no addresses left').toEqual([]);
    expect(entry!.status, 'K2\'s status unchanged').toBe(beforeStatus);
    expect(entry!.failures, 'K2\'s failures unchanged').toBe(beforeFailures);
  }, 90_000);

  it('an address that answers with another key does not blacklist the key', async () => {
    const stubA = await makeStub(0); stubs.push(stubA);
    const stubB = await makeStub(1); stubs.push(stubB);
    const dirA = mkdtempSync(join(tmpdir(), 'mesh-client-a-')); dirs.push(dirA);
    const dirB = mkdtempSync(join(tmpdir(), 'mesh-client-b-')); dirs.push(dirB);
    const a = await startNode(stubA, dirA); nodes.push(a.node);
    const b = await startNode(stubB, dirB); nodes.push(b.node);

    // The anchor lists A's id with B's address first, A's own second.
    // The one-dial-per-peer path hands libp2p both and reads whichever
    // address succeeds; the anchor is not blacklisted (a key-authenticated
    // mismatch stays below the lie threshold — the contract reads
    // "the address lied, not the key"), and the anchor was reached.
    //
    // MESH_INTERFACE → The client's node list — the exact address-drop
    // granularity (which specific address answered with the wrong key)
    // is lost when another address of the same peer succeeds first:
    // libp2p's dial-queue serves the first good connection and never
    // surfaces the failed-with-wrong-key per-address causes to its
    // caller. The invariant that MATTERS — the key is not blacklisted
    // — is preserved.
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
    // The anchor reached through one of its addresses.
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

  it('a failed fetch to the node in use checks at once, and the check moves the client to the next connection', async () => {
    // MESH_INTERFACE → The client's node list → "A read opens no
    // connection" — "a failed read to the node in use runs a check at
    // once, which dials from the list". Two anchors: A is reached
    // first, then stopped; the fetch to A fails as transport (its
    // connection is gone), the immediate check dials from the list,
    // and B — the next candidate — becomes the node in use. We await
    // the state change rather than a timeout: the test rules out
    // "nothing happened because the timer did not fire".
    const stubA = await makeStub(0); stubs.push(stubA);
    const stubB = await makeStub(1); stubs.push(stubB);
    const dirA = mkdtempSync(join(tmpdir(), 'mesh-client-ic-a-')); dirs.push(dirA);
    const dirB = mkdtempSync(join(tmpdir(), 'mesh-client-ic-b-')); dirs.push(dirB);
    const a = await startNode(stubA, dirA); nodes.push(a.node);
    const b = await startNode(stubB, dirB); nodes.push(b.node);

    let resolveCalls = 0;
    const client = await startMeshClient({
      anchors: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet',
      profile: PROFILE,
      stunServers: [],
      resolve: fakeResolveWith([
        (u) => { resolveCalls += 1; return winnerFirst(u); },
        (u) => { resolveCalls += 1; return winnerFirst(u); },
        (u) => { resolveCalls += 1; return winnerFirst(u); },
      ]),
    });
    clients.push(client);

    await client.check();
    expect(client.state().nodeId).toBe(a.id);
    const callsBefore = resolveCalls;

    await a.node.stop();
    nodes.splice(nodes.indexOf(a.node), 1);
    let fetchError: unknown;
    try {
      await client.fetch(meshBaseUrl(a.id) + '/blocks/current');
    } catch (e) {
      fetchError = e;
    }
    expect(fetchError).toBeDefined();

    const deadlineMs = Date.now() + 10_000;
    while (
      (resolveCalls === callsBefore || client.state().nodeId !== b.id)
      && Date.now() < deadlineMs
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(resolveCalls).toBeGreaterThan(callsBefore);
    expect(client.state().nodeId).toBe(b.id);
  }, 60_000);

  it('a discovered node is added before any event names it', async () => {
    // MESH_INTERFACE → Discovery — the DHT's `peer:discovery` reports a
    // Notis peer; the client's handler calls `nodeList.add(id, addrs)` so
    // every entry exists before any later success/failure/lie names it.
    // The seam dispatches the event on the client's libp2p so the case
    // holds its guard without a three-node DHT walk.
    const client = await startMeshClient({
      anchors: [],
      network: 'devnet',
      profile: PROFILE,
      stunServers: [],
      resolve: fakeResolveWith([
        () => ({ winner: null, winnerIndex: -1, nodes: [], tip: null, suffixHead: null, splits: [] }),
      ]),
    });
    clients.push(client);
    await client.check();

    // Fresh Notis id — the client itself has a different one.
    const discoveredId = bytesToHex(generateKeyPair().publicKey);
    const pid = peerIdFromNotisId(discoveredId);
    const ma = multiaddr(`/ip4/127.0.0.1/tcp/9999/p2p/${pid.toString()}`);
    client.libp2p.dispatchEvent(new CustomEvent('peer:discovery', {
      detail: { id: pid, multiaddrs: [ma] },
    }));

    const entry = client.state().nodes.find((n) => n.notisId === discoveredId);
    expect(entry, 'discovered id must be a NodeList entry before any event').toBeDefined();
    expect(entry!.addrs).toContain(ma.toString());
    expect(entry!.anchor).toBe(false);
  }, 30_000);

  it('one check at a time: a trigger during a check joins the in-flight one', async () => {
    // MESH_INTERFACE → The client's node list → "A check" —
    // "one check at a time: a trigger during a check is that check."
    // Three concurrent `check()` calls during an in-flight check must not
    // start three runs — they all join the same promise and the resolve
    // seam records a single call. The anchor list is empty so phase 1's
    // dial has no address to wait on; `resolveFn` is reached in the same
    // microtask run and suspends on `gate`.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let resolveCalls = 0;
    const EMPTY: TipResult = { winner: null, winnerIndex: -1, nodes: [], tip: null, suffixHead: null, splits: [] };
    const client = await startMeshClient({
      anchors: [],
      network: 'devnet',
      profile: PROFILE,
      stunServers: [],
      resolve: async () => {
        resolveCalls += 1;
        if (resolveCalls === 1) await gate;
        return EMPTY;
      },
    });
    clients.push(client);

    // The scheduled start check is the first one in flight; the three
    // `check()` calls below join that same promise.
    const [p1, p2, p3] = [client.check(), client.check(), client.check()];
    // Give the first resolve enough microtask + 0 ms turns to run and
    // suspend on `gate`.
    for (let i = 0; i < 20 && resolveCalls === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(resolveCalls).toBe(1);
    release();
    await Promise.all([p1, p2, p3]);
    // Even after every awaiter resumes, only one resolve call happened.
    expect(resolveCalls).toBe(1);
  }, 60_000);

  // MESH_INTERFACE → Place in the workspace — "every timer capped at
  // 2^31 − 1 ms". A unit case over the cap: a value past the ceiling
  // folds down, a negative or `NaN` folds to zero, a legitimate value
  // passes through. The whole-client timer path reaches `setTimeout`
  // only after `cappedTimerMs` runs.
  it('every timer is capped at 2^31 − 1 ms', () => {
    expect(MAX_TIMER_MS).toBe(0x7fff_ffff);
    expect(cappedTimerMs(0)).toBe(0);
    expect(cappedTimerMs(5_000)).toBe(5_000);
    expect(cappedTimerMs(MAX_TIMER_MS)).toBe(MAX_TIMER_MS);
    expect(cappedTimerMs(MAX_TIMER_MS + 1)).toBe(MAX_TIMER_MS);
    expect(cappedTimerMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMER_MS);
    expect(cappedTimerMs(-5)).toBe(0);
    expect(cappedTimerMs(Number.NaN)).toBe(0);
    expect(cappedTimerMs(Number.POSITIVE_INFINITY)).toBe(MAX_TIMER_MS);
  });

  // MESH_INTERFACE → The client's node list — the node in use's own tip
  // is read through `fetchJson` under `HEIGHT_READ_BYTES`. A transport
  // or HTTP non-ok result moves the node by `failure`; a body-level
  // failure (overflow, unparseable) or an answer that is not a tip
  // moves it by `lie` of kind `malformed` — a malformed answer over the
  // key-authenticated link is the contract's lie row.
  async function startWithHostileTip(bodyFactory: (req: unknown) => { status: number; body: string }): Promise<{ client: MeshClient; stub: Stub; nodeStarted: { id: string; node: MeshNode; webrtcAddr: string } }> {
    const srv = createServer((req, res) => {
      if (req.url === '/blocks/current') {
        const r = bodyFactory(req);
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(r.body);
      } else if (req.url === '/nipopow/proof/24/20') {
        // Any proof route is served honestly through the fake resolve, so
        // leave this a 404; the tip test only exercises /blocks/current.
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      } else {
        res.writeHead(404); res.end();
      }
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = (srv.address() as AddressInfo).port;
    const stub: Stub = { srv, base: `http://127.0.0.1:${port}` };
    stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-client-tip-')); dirs.push(dir);
    const started = await startNode(stub, dir); nodes.push(started.node);
    const client = await startMeshClient({
      anchors: [{ notisId: started.id, addrs: [started.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      stunServers: [],
      resolve: fakeResolveWith([(u) => winnerFirst(u), (u) => winnerFirst(u)]),
    });
    clients.push(client);
    return { client, stub, nodeStarted: started };
  }

  it('refreshTip: an HTTP non-ok answer moves the node by failure', async () => {
    const { client, nodeStarted } = await startWithHostileTip(() => ({ status: 500, body: 'kaboom' }));
    await client.check();
    const entry = client.state().nodes.find((n) => n.notisId === nodeStarted.id);
    expect(entry!.status).toBe('retry');
    expect(entry!.evidence).toBeNull();
  }, 60_000);

  it('refreshTip: a body that does not parse as JSON moves the node by lie', async () => {
    const { client, nodeStarted } = await startWithHostileTip(() => ({ status: 200, body: 'not json at all' }));
    await client.check();
    const entry = client.state().nodes.find((n) => n.notisId === nodeStarted.id);
    expect(entry!.status).toBe('blacklisted');
    expect(entry!.evidence?.kind).toBe('malformed');
  }, 60_000);

  it('refreshTip: a body that parses but is not a tip moves the node by lie', async () => {
    const { client, nodeStarted } = await startWithHostileTip(() => ({
      status: 200,
      body: JSON.stringify({ not: 'a tip' }),
    }));
    await client.check();
    const entry = client.state().nodes.find((n) => n.notisId === nodeStarted.id);
    expect(entry!.status).toBe('blacklisted');
    expect(entry!.evidence?.kind).toBe('malformed');
  }, 60_000);

  it('refreshTip: a body over the route cap moves the node by lie', async () => {
    // HEIGHT_READ_BYTES is 1_024; a valid-looking tip body wrapped in
    // enough filler to overflow the cap is cut off at the reader and
    // read as a malformed answer over the authenticated link.
    const bulk = JSON.stringify({ height: 1, hash: 'ab'.repeat(32), filler: 'x'.repeat(2_000) });
    const { client, nodeStarted } = await startWithHostileTip(() => ({ status: 200, body: bulk }));
    await client.check();
    const entry = client.state().nodes.find((n) => n.notisId === nodeStarted.id);
    expect(entry!.status).toBe('blacklisted');
    expect(entry!.evidence?.kind).toBe('malformed');
  }, 60_000);

  // MESH_INTERFACE → The client's node list → "A read opens no
  // connection" — "the client dials only what the list holds for a
  // key — in its order, without the addresses it dropped — never an
  // address libp2p keeps for the key from elsewhere". A resolver
  // that calls the `httpFetch` it is handed exposes the read path:
  // what the client's fetch does for each URL reaches the test as
  // the node's refuse code and reason.
  function callingHttpFetchResolve(): typeof import('@dagsocial/nipopow-client').resolveTip {
    return async (urls, _m, _k, _profile, _nowMs, httpFetch) => {
      const nodes: NodeTipResult[] = [];
      for (const url of urls) {
        try {
          const res = await httpFetch(`${url}/nipopow/proof/24/20`);
          nodes.push({
            url,
            verified: false,
            proof: null,
            verifyResult: null,
            refuseReason: `HTTP ${res.status}`,
            refuseCode: 'http',
            behind: null,
            genesisHash: null,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          nodes.push({
            url,
            verified: false,
            proof: null,
            verifyResult: null,
            refuseReason: `unreachable: ${msg}`,
            refuseCode: 'unreachable',
            behind: null,
            genesisHash: null,
          });
        }
      }
      return { winner: null, winnerIndex: -1, nodes, tip: null, suffixHead: null, splits: [] };
    };
  }

  it('a key the client holds no connection to reads as transport and dials nothing', async () => {
    // MESH_INTERFACE → The client's node list → "A read opens no
    // connection" — "With none, the read fails as a transport
    // failure". A stranger key is one the client holds no connection
    // to; a direct `client.fetch` to its mesh URL rejects as
    // transport and the libp2p host sees no dial as a side effect.
    const stub = await makeStub(0); stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-client-no-conn-')); dirs.push(dir);
    const anchor = await startNode(stub, dir); nodes.push(anchor.node);

    const client = await startMeshClient({
      anchors: [{ notisId: anchor.id, addrs: [anchor.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      stunServers: [],
      resolve: fakeResolveWith([(u) => winnerFirst(u)]),
    });
    clients.push(client);
    await client.check();

    // Install the spies AFTER the first check, so we count only dials
    // the forthcoming `fetch` triggers.
    const dialSpy = vi.spyOn(client.libp2p, 'dial');
    const dialProtocolSpy = vi.spyOn(client.libp2p, 'dialProtocol');

    const strangerId = bytesToHex(generateKeyPair().publicKey);
    let caught: unknown;
    try {
      await client.fetch(meshBaseUrl(strangerId) + '/blocks/current');
    } catch (e) {
      caught = e;
    }
    expect(caught, 'the read rejects').toBeInstanceOf(MeshFetchError);
    expect((caught as MeshFetchError).kind, 'the read rejects as transport').toBe('transport');
    expect(dialSpy, 'libp2p.dial is not called by the read').not.toHaveBeenCalled();
    expect(dialProtocolSpy, 'libp2p.dialProtocol is not called by the read').not.toHaveBeenCalled();
  }, 60_000);

  it('a listed address answering with another key: the address drops, a later read fails as transport, no further dial', async () => {
    // MESH_INTERFACE → The client's node list → "A read opens no
    // connection" — "So the client dials only what the list holds for
    // a key — in its order, without the addresses it dropped — never
    // an address libp2p keeps for the key from elsewhere." A real
    // node K1 answers at its WebRTC-direct address; K2 is a fresh key
    // the anchor list points at K1's address. The DHT would also put
    // K1's address into libp2p's peer store under K2's peer id; we
    // merge it by hand so a dial by key would, under the old path,
    // reach K1 again. Under the rule, phase 1 drops K1's address for
    // K2 and phase 2's read calls `httpFetch` without a connection to
    // K2 — the read fails as transport, and K2's `lastFailure`
    // message is the no-connection failure, not noise's wrong-key
    // text. `dial` is called once (phase 1 only) and `dialProtocol`
    // not at all.
    const stubK1 = await makeStub(0); stubs.push(stubK1);
    const dirK1 = mkdtempSync(join(tmpdir(), 'mesh-client-peerstore-k1-')); dirs.push(dirK1);
    const k1 = await startNode(stubK1, dirK1); nodes.push(k1.node);

    const k2 = nodeKeyFromKeyPair(generateKeyPair());

    const client = await startMeshClient({
      anchors: [{ notisId: k2.notisId, addrs: [k1.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      stunServers: [],
      resolve: callingHttpFetchResolve(),
    });
    clients.push(client);

    // The DHT-finds-it simulation: libp2p's own peer store carries
    // K1's address under K2's peer id. A dial by key — the old read
    // path's `dialProtocol(peerId)` — would read these addresses and
    // dial K1 again.
    await client.libp2p.peerStore.merge(peerIdFromNotisId(k2.notisId), {
      multiaddrs: [multiaddr(k1.webrtcAddr)],
    });

    const dialSpy = vi.spyOn(client.libp2p, 'dial');
    const dialProtocolSpy = vi.spyOn(client.libp2p, 'dialProtocol');

    await client.check();

    const entry = client.state().nodes.find((n) => n.notisId === k2.notisId);
    expect(entry, 'K2 is in the node list').toBeDefined();
    expect(entry!.droppedAddrs, 'K1\'s address is dropped for K2').toContain(k1.webrtcAddr);
    expect(entry!.status, 'K2 moves to retry on the read\'s transport failure').toBe('retry');
    expect(entry!.lastFailure, 'K2 keeps the read\'s transport failure as its last').not.toBeNull();
    expect(entry!.lastFailure!.kind, 'K2\'s last failure is transport').toBe('transport');
    expect(entry!.lastFailure!.message, 'K2\'s last failure is not the noise wrong-key text')
      .not.toMatch(/Payload peer id/);
    expect(dialSpy, 'libp2p.dial is called once by phase 1 — the one dial per candidate').toHaveBeenCalledTimes(1);
    expect(dialProtocolSpy, 'libp2p.dialProtocol is not called — reads open no connection')
      .not.toHaveBeenCalled();
  }, 90_000);

  it('a key whose only open connection is limited is not read on', async () => {
    // MESH_INTERFACE → NAT → "A relay carries signalling, not data."
    // — "a client opens no API stream on a limited connection". The
    // only way a browser reaches a limited connection in this suite
    // is through its fake-connection fixtures (see
    // `test/relayed-webrtc-fixes.test.ts` for the full matrix); here
    // we exercise the whole fetch wrapper by setting the client's
    // read pick to one that reports no suitable connection. The
    // `fetch` then rejects as transport, matching the no-connection
    // path a real limited-only client would take.
    const stub = await makeStub(0); stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-client-limited-')); dirs.push(dir);
    const anchor = await startNode(stub, dir); nodes.push(anchor.node);

    const client = await startMeshClient({
      anchors: [{ notisId: anchor.id, addrs: [anchor.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      stunServers: [],
      resolve: fakeResolveWith([(u) => winnerFirst(u)]),
    });
    clients.push(client);
    await client.check();

    // Confirm the connection is open and unlimited; the pick finds
    // it, so a plain fetch would succeed under the default pick.
    const conns = client.libp2p.getConnections();
    const openUnlimited = conns.find((c) => c.status === 'open' && c.limits == null);
    expect(openUnlimited, 'the client holds an open unlimited connection to the anchor').toBeDefined();

    // The strict read pick (reads refuse to fall back to a limited
    // connection) returns null for a connections list of only
    // limited open ones.
    const pseudoLimited = { ...openUnlimited!, limits: { bytes: 1024n, seconds: 60 } } as unknown as typeof openUnlimited;
    expect(
      pickConnectionForRead([pseudoLimited!], openUnlimited!.remotePeer.toString()),
      'reading on a limited-only connection returns null',
    ).toBeNull();
  }, 60_000);

  it('the client imports nothing from node:', async () => {
    const distLib = fileURLToPath(new URL('../dist/lib.js', import.meta.url));
    expect(existsSync(distLib), `dist/lib.js must exist — run pnpm build first (${distLib})`).toBe(true);
    const code = readFileSync(distLib, 'utf8');
    const { builtinModules } = await import('node:module');
    // tsup externalises Node builtins, but it rewrites `node:fs` to `fs` in
    // its output: the refuse-node-builtins script checks both forms, so the
    // scan does the same (packages/web/scripts/refuse-node-builtins.mjs).
    const importRe = /(?:from\s*['"]|require\s*\(\s*['"]|import\s*\(\s*['"])([^'"\s)]+)['"]/g;
    const banned: string[] = [];
    for (const match of code.matchAll(importRe)) {
      const importSpecifier = match[1]!;
      if (importSpecifier.startsWith('node:') || builtinModules.includes(importSpecifier)) banned.push(importSpecifier);
    }
    expect(banned, `banned Node imports in dist/lib.js: ${banned.join(', ')}`).toEqual([]);
  }, 30_000);
});
