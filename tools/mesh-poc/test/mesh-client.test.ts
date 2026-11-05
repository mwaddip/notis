// MESH_INTERFACE → Transports / Discovery / The client's node list / The
// node endpoint — the client, in Node, against mesh nodes over
// WebRTC-direct with upstream stubs and a fake `resolve`. The DNS and ICE
// refusals live here too, held under their own cases. The
// browser-safety scan — the bundle `packages/web/src/mesh/index.ts`
// reaches — lives beside the barrel as `packages/web/test/mesh/no-node-reach.test.ts`.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, bytesToHex } from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import { profileFor } from '@dagsocial/types';
import type { NetworkProfile, NetworkType, OrderingBlock } from '@dagsocial/types';
import type { NodeTipResult } from '@dagsocial/nipopow-client';
import type { Connection } from '@libp2p/interface';
import { nodeKeyFromKeyPair, peerIdFromNotisId, meshBaseUrl } from '@dagsocial/net/browser';
import { MeshConfigError } from '@dagsocial/web/mesh';
import { assertClientConfig, cappedTimerMs, MAX_TIMER_MS, pickConnectionForRead } from '@dagsocial/web/mesh';
import { MeshFetchError, MeshUrlError } from '@dagsocial/net/browser';
import { NetNode } from '@dagsocial/net';
import { startNetPublicMesh, type NetMeshNode } from './helpers/net-public-node.js';
import { startMeshClient, type MeshClient } from '@dagsocial/web/mesh';
import { multiaddr } from '@multiformats/multiaddr';
import { chainResolve, chainUpstream, type ChainUpstream } from './helpers/chain-harness.js';
import { makeLinkedChain } from './helpers/devnet-block.js';

// MESH_INTERFACE → The node endpoint — a tiny upstream the mesh node
// forwards to; the hand-built servers the gated cases below hold are
// of this shape.
interface Stub { srv: Server; base: string; }

async function startNode(upstream: { base: string }, dir: string): Promise<NetMeshNode> {
  return await startNetPublicMesh({ upstream: upstream.base, stateDir: dir });
}

const PROFILE: NetworkProfile = profileFor('devnet' as NetworkType);

// Shared ordering chains for the cases below; `chainResolve`'s captured
// `k` sets the suffix length and the minimum chain length the fake
// accepts, so `K` is the floor. The chains are immutable OrderingBlock
// arrays and safe to read across cases.
const K = 5;
const SHARED_CHAIN = makeLinkedChain(K, PROFILE);
const CHAIN_K_PLUS_1 = makeLinkedChain(K + 1, PROFILE);
const CHAIN_K_PLUS_1_TRAIL = CHAIN_K_PLUS_1.slice(0, K);
const CHAIN_K_PLUS_2 = makeLinkedChain(K + 2, PROFILE);
const CHAIN_K_PLUS_2_TRAIL = CHAIN_K_PLUS_2.slice(0, K);


describe('mesh-client — refusals, dialling by key, state and triggers', () => {
  const nodes: NetNode[] = [];
  const stubs: Stub[] = [];
  const ups: ChainUpstream[] = [];
  const dirs: string[] = [];
  const clients: MeshClient[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) { try { await c.stop(); } catch { /* already stopped */ } }
    for (const n of nodes.splice(0)) { try { await n.stop(); } catch { /* already stopped */ } }
    for (const s of stubs.splice(0)) { s.srv.close(); }
    for (const u of ups.splice(0)) { try { await u.close(); } catch { /* already closed */ } }
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
          resolve: chainResolve(() => SHARED_CHAIN, K),
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(MeshConfigError);
    }, 30_000);
  }

  // MESH_INTERFACE → NAT — "A client's STUN list comes from the public
  // nodes it holds". The STUN list is derived from the held nodes;
  // `iceConfiguration` runs `assertIceServers` over the derived list,
  // which cannot carry a hostname by construction (every derived entry is
  // `stun:<ip>:3478` through `stunServersFor`). The pure
  // `stunServersFor` cases in `test/stun-list.test.ts` cover the IP
  // shape.

  // MESH_INTERFACE → Discovery → "Seeds" — a seed address meets the anchor's
  // refusals; `assertClientConfig` is called with both lists and throws on a
  // seed's `/dns4/` as it does on an anchor's.
  it('assertClientConfig refuses a /dns4/ seed without creating a node', () => {
    const seedKey = nodeKeyFromKeyPair(generateKeyPair());
    expect(() => assertClientConfig({
      anchors: [],
      seeds: [{ notisId: seedKey.notisId, addrs: ['/dns4/example.com/tcp/1'] }],
    })).toThrow(MeshConfigError);
  });

  // MESH_INTERFACE → Discovery → "Seeds" — a seed is a candidate like
  // any node the DHT finds: a seed is in the client's node list as a
  // non-anchor entry in `new` status, which `NodeList.candidates()`
  // lists.
  it('a seed is a candidate', async () => {
    const anchorKey = nodeKeyFromKeyPair(generateKeyPair());
    const seedKey = nodeKeyFromKeyPair(generateKeyPair());
    const client = await startMeshClient({
      anchors: [{ notisId: anchorKey.notisId, addrs: [] }],
      seeds: [{ notisId: seedKey.notisId, addrs: [] }],
      network: 'devnet',
      profile: PROFILE,
      // No check runs here: the state is read before the scheduled first
      // check fires, so the seed is still in its initial `new` status —
      // `new` is one of the four candidate rows (MESH_INTERFACE → The
      // client's node list → "Candidates").
      resolve: chainResolve(() => 'unreachable', K),
    });
    clients.push(client);
    const seedEntry = client.state().nodes.find((n) => n.notisId === seedKey.notisId);
    expect(seedEntry, 'the seed is in the node list').toBeDefined();
    expect(seedEntry!.anchor).toBe(false);
    expect(seedEntry!.status).toBe('new');
  }, 30_000);

  // MESH_INTERFACE → Transports → "A client dials a private address only
  // when its own configuration names it" + Discovery → "Seeds" — a seed's
  // addresses are not configured, so the client's gater refuses a seed on
  // a private address, and the seed never answers. Both anchor and seed
  // are on loopback (private); the anchor is configured, so the anchor's
  // dial reaches libp2p and fails against its stopped node — status
  // retry — and `anchorReached` stays false because the anchor itself
  // never answers.
  it('a seed on a private address is refused by the gater; anchorReached stays false', async () => {
    const upSeed = await chainUpstream(SHARED_CHAIN); ups.push(upSeed);
    const dirSeed = mkdtempSync(join(tmpdir(), 'mesh-client-seed-')); dirs.push(dirSeed);
    const seed = await startNode(upSeed, dirSeed); nodes.push(seed.node);

    const upAnchor = await chainUpstream(SHARED_CHAIN); ups.push(upAnchor);
    const dirAnchor = mkdtempSync(join(tmpdir(), 'mesh-client-anchor-')); dirs.push(dirAnchor);
    const anchor = await startNode(upAnchor, dirAnchor); // not pushed: stopped at once
    await anchor.node.stop();

    const client = await startMeshClient({
      anchors: [{ notisId: anchor.id, addrs: [anchor.webrtcAddr] }],
      seeds: [{ notisId: seed.id, addrs: [seed.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      // The chainResolve would make the seed verified if phase 2
      // reached it — but the gater refuses the seed's loopback-private
      // address before libp2p dials, so phase 1 ends the seed in retry
      // and phase 2 reads no URL for it.
      resolve: chainResolve(() => SHARED_CHAIN, K),
    });
    clients.push(client);
    await client.check();
    const s = client.state();
    expect(s.anchorReached).toBe(false);
    const seedEntry = s.nodes.find((n) => n.notisId === seed.id);
    expect(seedEntry!.anchor).toBe(false);
    expect(seedEntry!.status).toBe('retry');
    const anchorEntry = s.nodes.find((n) => n.notisId === anchor.id);
    expect(anchorEntry!.anchor).toBe(true);
    expect(anchorEntry!.status).toBe('retry');
  }, 90_000);

  it('a routed read reaches the one anchor and nodeId names it', async () => {
    // MESH_INTERFACE → The client's node list → "A routed read goes to
    // a node its need allows" — a `tip` read picks an `ok` node, opens
    // the stream on the connection the client holds, and `state.nodeId`
    // names the serving node after it.
    const up = await chainUpstream(SHARED_CHAIN); ups.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-client-')); dirs.push(dir);
    const started = await startNode(up, dir); nodes.push(started.node);
    const client = await startMeshClient({
      anchors: [{ notisId: started.id, addrs: [started.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      resolve: chainResolve(() => SHARED_CHAIN, K),
    });
    clients.push(client);
    await client.check();

    const { response, nodeId } = await client.read('/blocks/current', 'tip');
    expect(nodeId).toBe(started.id);
    expect(response.status).toBe(200);
    const text = await response.text();
    const direct = await (await globalThis.fetch(`${up.base}/blocks/current`)).text();
    expect(text).toBe(direct);

    const s = client.state();
    expect(s.nodeId).toBe(started.id);
    expect(s.transport).toBe('webrtc-direct');
    expect(s.path).toBe('direct');
    expect(s.anchorReached).toBe(true);
  }, 60_000);

  it('a node that leaves ok/trailing is named by lastLeft, with its reason', async () => {
    // MESH_INTERFACE → The client's node list → "A routed read goes to
    // a node its need allows" — after a check, a node that was `ok` or
    // `trailing` before it and is neither after it goes into
    // `state.lastLeft` with its latest event. Two anchors ok after
    // check 1; A stops; after check 2 A moves to retry and `lastLeft`
    // names A with its failure reason.
    const upA = await chainUpstream(CHAIN_K_PLUS_1); ups.push(upA);
    const upB = await chainUpstream(CHAIN_K_PLUS_1_TRAIL); ups.push(upB);
    const dirA = mkdtempSync(join(tmpdir(), 'mesh-client-a-')); dirs.push(dirA);
    const dirB = mkdtempSync(join(tmpdir(), 'mesh-client-b-')); dirs.push(dirB);
    const a = await startNode(upA, dirA); nodes.push(a.node);
    const b = await startNode(upB, dirB); nodes.push(b.node);

    const client = await startMeshClient({
      anchors: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet',
      profile: PROFILE,
      // Both checks keep A as winner, B as trailing; after A stops it
      // falls out of candidates and B stands alone.
      resolve: chainResolve((url) => (url.includes(a.id) ? CHAIN_K_PLUS_1 : CHAIN_K_PLUS_1_TRAIL), K),
    });
    clients.push(client);

    await client.check();
    // No node left ok/trailing — both just arrived there.
    expect(client.state().lastLeft).toBeNull();

    // Stop node A — the next check cannot reach it.
    await a.node.stop();
    nodes.splice(nodes.indexOf(a.node), 1);

    await client.check();
    const s = client.state();
    expect(s.lastLeft).not.toBeNull();
    expect(s.lastLeft!.nodeId).toBe(a.id);
    expect(s.lastLeft!.reason).toMatch(/^failure:/);
    const entryA = s.nodes.find((n) => n.notisId === a.id);
    expect(entryA?.status).toBe('retry');
  }, 90_000);

  // A resolve that answers only the real node and omits every other
  // url the client offered — so phase 3's `tipEvent` fires nothing
  // for the fake entries under test and the check's phases 4-5 run
  // against the real connection alone. The ids under scrutiny stay
  // in whatever state phase 1's dial left them in, and every case
  // the resolver skips is a case about phase 1's dial alone — the
  // whole-check behavior under the real read path is in a separate
  // case ("a listed address answering with another key").
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

  it('a TCP address and a WebRTC-direct address that answers with another key drops the webrtc address with no address failure recorded', async () => {
    // MESH_INTERFACE → The client's node list → "A node's addresses are
    // dialled as one operation" — "an address no browser transport
    // carries is passed over by libp2p and takes none". The mesh client
    // runs no TCP transport, so a TCP address libp2p is handed is
    // filtered before any dial; a wrong-key answer on the WebRTC-direct
    // address drops that address alone. The check's own `/blocks/current`
    // read then fails as transport (no connection), moving the node by
    // the ordinary failure row — distinct from the wrong-key row's
    // address-only side effect.
    const upK1 = await chainUpstream(SHARED_CHAIN); ups.push(upK1);
    const dirK1 = mkdtempSync(join(tmpdir(), 'mesh-client-k1-')); dirs.push(dirK1);
    const k1 = await startNode(upK1, dirK1); nodes.push(k1.node);

    // A real anchor so the check has a reachable candidate alongside K2.
    const upGood = await chainUpstream(SHARED_CHAIN); ups.push(upGood);
    const dirGood = mkdtempSync(join(tmpdir(), 'mesh-client-good-')); dirs.push(dirGood);
    const good = await startNode(upGood, dirGood); nodes.push(good.node);

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
      resolve: chainResolve((u) => (u.includes(good.id) ? SHARED_CHAIN : 'unreachable'), K),
    });
    clients.push(client);

    await client.check();
    const entry = client.state().nodes.find((n) => n.notisId === k2.notisId);
    expect(entry, 'K2 is in the node list').toBeDefined();
    expect(entry!.droppedAddrs, 'K1\'s WebRTC-direct address dropped for K2')
      .toContain(k1.webrtcAddr);
    expect(entry!.lastFailures[tcpAddr], 'the TCP address has no failure recorded')
      .toBeUndefined();
    expect(entry!.lastFailures[k1.webrtcAddr], 'the wrong-key address has no per-address failure recorded')
      .toBeUndefined();
  }, 90_000);

  it('a wrong-key answer on one address and a timeout on a second dialled address records the node failure', async () => {
    // MESH_INTERFACE → The client's node list — the wrong-key row is
    // "the entry otherwise unchanged" only when every dialled address
    // answered with the wrong key. A dial whose attribution carries
    // any other failure keeps the row for the plain failure kinds:
    // the node moves to `retry` and `failures` grows by one. Here the
    // first dialled address is a real node whose node was stopped,
    // which libp2p times out on; the second is a real node that
    // answers with the wrong key under K2's expected id. The
    // `onlyRealGoodResolve` resolver keeps K2 out of the read, so this
    // case holds phase 1's dial alone.
    const upK1 = await chainUpstream(SHARED_CHAIN); ups.push(upK1);
    const dirK1 = mkdtempSync(join(tmpdir(), 'mesh-client-k1b-')); dirs.push(dirK1);
    const k1 = await startNode(upK1, dirK1); nodes.push(k1.node);

    // A second real node — grab its webrtc-direct address, then stop
    // it; the address stays parseable, but libp2p's dial will time out.
    const upGone = await chainUpstream(SHARED_CHAIN); ups.push(upGone);
    const dirGone = mkdtempSync(join(tmpdir(), 'mesh-client-gone-')); dirs.push(dirGone);
    const gone = await startNode(upGone, dirGone);
    const goneWebrtcAddr = gone.webrtcAddr;
    await gone.node.stop();

    const upGood = await chainUpstream(SHARED_CHAIN); ups.push(upGood);
    const dirGood = mkdtempSync(join(tmpdir(), 'mesh-client-good2-')); dirs.push(dirGood);
    const good = await startNode(upGood, dirGood); nodes.push(good.node);

    const k2 = nodeKeyFromKeyPair(generateKeyPair());
    const client = await startMeshClient({
      anchors: [
        { notisId: good.id, addrs: [good.webrtcAddr] },
        { notisId: k2.notisId, addrs: [goneWebrtcAddr, k1.webrtcAddr] },
      ],
      network: 'devnet',
      profile: PROFILE,
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

  it('every dialled address answers with the wrong key: phase 1\'s dial drops both, the entry is otherwise unchanged', async () => {
    // MESH_INTERFACE → The client's node list — the wrong-key row,
    // the branch where every dialled address answered with another
    // key: the dropped addresses carry the diagnostic alone and the
    // entry's dropped addresses carry the diagnostic alone; the
    // addresses list ends empty. The subsequent `/blocks/current` read
    // then fails as transport (no connection); that failure writes
    // `lastFailure`, not a per-address `lastFailures[addr]` row — the
    // wrong-key row's address-only side effect stands.
    const upK1 = await chainUpstream(SHARED_CHAIN); ups.push(upK1);
    const dirK1 = mkdtempSync(join(tmpdir(), 'mesh-client-k1c-')); dirs.push(dirK1);
    const k1 = await startNode(upK1, dirK1); nodes.push(k1.node);

    const upK3 = await chainUpstream(SHARED_CHAIN); ups.push(upK3);
    const dirK3 = mkdtempSync(join(tmpdir(), 'mesh-client-k3-')); dirs.push(dirK3);
    const k3 = await startNode(upK3, dirK3); nodes.push(k3.node);

    const upGood = await chainUpstream(SHARED_CHAIN); ups.push(upGood);
    const dirGood = mkdtempSync(join(tmpdir(), 'mesh-client-good3-')); dirs.push(dirGood);
    const good = await startNode(upGood, dirGood); nodes.push(good.node);

    const k2 = nodeKeyFromKeyPair(generateKeyPair());
    const client = await startMeshClient({
      anchors: [
        { notisId: good.id, addrs: [good.webrtcAddr] },
        { notisId: k2.notisId, addrs: [k1.webrtcAddr, k3.webrtcAddr] },
      ],
      network: 'devnet',
      profile: PROFILE,
      resolve: chainResolve((u) => (u.includes(good.id) ? SHARED_CHAIN : 'unreachable'), K),
    });
    clients.push(client);

    await client.check();
    const entry = client.state().nodes.find((n) => n.notisId === k2.notisId);
    expect(entry!.droppedAddrs, 'both WebRTC-direct addresses dropped')
      .toEqual(expect.arrayContaining([k1.webrtcAddr, k3.webrtcAddr]));
    expect(entry!.addrs, 'no addresses left').toEqual([]);
    expect(entry!.lastFailures[k1.webrtcAddr], 'no per-address failure recorded for K1\'s addr')
      .toBeUndefined();
    expect(entry!.lastFailures[k3.webrtcAddr], 'no per-address failure recorded for K3\'s addr')
      .toBeUndefined();
  }, 90_000);

  it('an address that answers with another key does not blacklist the key', async () => {
    const upA = await chainUpstream(SHARED_CHAIN); ups.push(upA);
    const upB = await chainUpstream(SHARED_CHAIN); ups.push(upB);
    const dirA = mkdtempSync(join(tmpdir(), 'mesh-client-a-')); dirs.push(dirA);
    const dirB = mkdtempSync(join(tmpdir(), 'mesh-client-b-')); dirs.push(dirB);
    const a = await startNode(upA, dirA); nodes.push(a.node);
    const b = await startNode(upB, dirB); nodes.push(b.node);

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
      resolve: chainResolve(() => SHARED_CHAIN, K),
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
    const up = await chainUpstream(SHARED_CHAIN); ups.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-client-')); dirs.push(dir);
    const started = await startNode(up, dir); nodes.push(started.node);

    // The fake resolve answers 'invalid' with a proof — the proof-invalid
    // row of the mapping (`tipEvent`).
    const client = await startMeshClient({
      anchors: [{ notisId: started.id, addrs: [started.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      // 'invalid' answers like `invalidWithProof`: refuseCode 'invalid'
      // with a non-null proof stand-in, which `tipEvent` reads as a
      // `lie` evidence of kind `proof-invalid`.
      resolve: chainResolve(() => 'invalid', K),
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
    const up = await chainUpstream(SHARED_CHAIN); ups.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-client-')); dirs.push(dir);
    const started = await startNode(up, dir); // not pushed: we stop it right away
    await started.node.stop();

    const client = await startMeshClient({
      anchors: [{ notisId: started.id, addrs: [started.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      // No candidate reachable — resolve may still be called with an
      // empty list; `unreachable` is harmless when it is.
      resolve: chainResolve(() => 'unreachable', K),
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

  it('a failed read triggers a check, and the next read reaches another ok node', async () => {
    // MESH_INTERFACE → The client's node list → "A routed read goes to
    // a node its need allows" + "A read opens no connection" — "a
    // failed routed read runs a check at once, which dials from the
    // list". Two anchors on chain A at the start; after a successful
    // routed read, A stops and B advances to a different chain (one
    // the client's held chain cannot place). The triggered check's
    // phase 4 reads B's proof, the winner's tip replaces the chain's,
    // and B rises to `ok`. The next tip read reaches B.
    const chainA = CHAIN_K_PLUS_1;         // A: K+1 blocks
    const chainBTrail = CHAIN_K_PLUS_1_TRAIL; // B initially: K blocks of A's chain → trailing
    const chainBNew = makeLinkedChain(K + 1, PROFILE); // B after advance: a fork at K+1
    const upA = await chainUpstream(chainA); ups.push(upA);
    const upB = await chainUpstream(chainBTrail); ups.push(upB);
    const dirA = mkdtempSync(join(tmpdir(), 'mesh-client-ic-a-')); dirs.push(dirA);
    const dirB = mkdtempSync(join(tmpdir(), 'mesh-client-ic-b-')); dirs.push(dirB);
    const a = await startNode(upA, dirA); nodes.push(a.node);
    const b = await startNode(upB, dirB); nodes.push(b.node);

    let aStopped = false;
    let bAdvanced = false;
    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(a.id)) return aStopped ? 'unreachable' : chainA;
      if (url.includes(b.id)) return bAdvanced ? chainBNew : chainBTrail;
      return 'unreachable';
    };
    const client = await startMeshClient({
      anchors: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet',
      profile: PROFILE,
      // Pin the fast-set pick to the first candidate so the first read
      // reliably reaches A.
      random: () => 0,
      resolve: chainResolve(chainOf, K),
    });
    clients.push(client);

    await client.check();
    const first = await client.read('/blocks/current', 'tip');
    expect(first.nodeId).toBe(a.id);
    const checksBefore = client.state().checks;

    await a.node.stop();
    nodes.splice(nodes.indexOf(a.node), 1);
    aStopped = true;
    upB.setChain(chainBNew);
    bAdvanced = true;
    let readError: unknown;
    try {
      await client.read('/blocks/current', 'tip');
    } catch (e) {
      readError = e;
    }
    expect(readError).toBeDefined();

    const deadlineMs = Date.now() + 10_000;
    while (
      client.state().checks === checksBefore
      && Date.now() < deadlineMs
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(client.state().checks).toBeGreaterThan(checksBefore);

    const next = await client.read('/blocks/current', 'tip');
    expect(next.nodeId).toBe(b.id);
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
      resolve: chainResolve(() => 'unreachable', K),
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
    // MESH_INTERFACE → The client's node list → "A check" — the client
    // runs one check at a time; a trigger that fires while a check is
    // in flight is that check. Three concurrent `check()` calls during
    // an in-flight check must not start three runs — they all join the
    // same promise. A hostile upstream holds its `/blocks/current`
    // response on an external gate; while the tip-read phase waits,
    // three checks are issued and all join the first — the upstream's
    // server-side counter sees one request.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let currentReads = 0;
    const srv = createServer(async (req, res) => {
      if (req.url === '/blocks/current') {
        currentReads += 1;
        if (currentReads === 1) await gate;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ height: 1, hash: 'ab'.repeat(32) }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    const stub: Stub = { srv, base: `http://127.0.0.1:${port}` };
    stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'oca-')); dirs.push(dir);
    const n = await startNode(stub, dir); nodes.push(n.node);

    const client = await startMeshClient({
      anchors: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      resolve: chainResolve(() => 'unreachable', K),
    });
    clients.push(client);

    // The scheduled start check is the first one in flight; the three
    // `check()` calls below join that same promise.
    const [p1, p2, p3] = [client.check(), client.check(), client.check()];
    // Give the first /blocks/current reach the server and suspend on
    // `gate`.
    for (let i = 0; i < 50 && currentReads === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(currentReads).toBe(1);
    release();
    await Promise.all([p1, p2, p3]);
    // Even after every awaiter resumes, only one /blocks/current
    // request landed — the four `check()` calls all joined the first.
    expect(currentReads).toBe(1);
  }, 60_000);

  // Every timer the client sets runs through `cappedTimerMs`, which
  // folds its argument into the 32-bit `setTimeout` range: a value
  // past the ceiling folds down, a negative or `NaN` folds to zero, a
  // legitimate value passes through. The whole-client timer path
  // reaches `setTimeout` only after `cappedTimerMs` runs.
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

  // MESH_INTERFACE → The client's node list — the tip read runs
  // through `read('/blocks/current', 'tip')` under `HEIGHT_READ_BYTES`,
  // and the classification applies to the node the read went to. A
  // transport or HTTP non-ok result moves that node by `failure`; a
  // body-level failure (overflow, unparseable) or an answer that is
  // not a tip moves it by `lie` of kind `malformed` — a malformed
  // answer over the key-authenticated link is the contract's lie row.
  async function startWithHostileTip(bodyFactory: (req: unknown) => { status: number; body: string }): Promise<{ client: MeshClient; stub: Stub; nodeStarted: NetMeshNode }> {
    // The tip test needs control over `/blocks/current`, so the upstream
    // is a hand-built server here — not `chainUpstream`. The resolve
    // path still runs over the shared chain through `chainResolve`.
    const srv = createServer((req, res) => {
      if (req.url === '/blocks/current') {
        const r = bodyFactory(req);
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(r.body);
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
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
      resolve: chainResolve(() => SHARED_CHAIN, K),
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
    const up = await chainUpstream(SHARED_CHAIN); ups.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-client-no-conn-')); dirs.push(dir);
    const anchor = await startNode(up, dir); nodes.push(anchor.node);

    const client = await startMeshClient({
      anchors: [{ notisId: anchor.id, addrs: [anchor.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      resolve: chainResolve(() => SHARED_CHAIN, K),
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
    // merge it by hand so a read that dialled by key would reach K1
    // again. Under the rule, phase 1 drops K1's address for
    // K2 and phase 2's read calls `httpFetch` without a connection to
    // K2 — the read fails as transport, and K2's `lastFailure`
    // message is the no-connection failure, not noise's wrong-key
    // text. `dial` is called once (phase 1 only) and `dialProtocol`
    // not at all.
    const upK1 = await chainUpstream(SHARED_CHAIN); ups.push(upK1);
    const dirK1 = mkdtempSync(join(tmpdir(), 'mesh-client-peerstore-k1-')); dirs.push(dirK1);
    const k1 = await startNode(upK1, dirK1); nodes.push(k1.node);

    const k2 = nodeKeyFromKeyPair(generateKeyPair());

    const client = await startMeshClient({
      anchors: [{ notisId: k2.notisId, addrs: [k1.webrtcAddr] }],
      network: 'devnet',
      profile: PROFILE,
      resolve: callingHttpFetchResolve(),
    });
    clients.push(client);

    // The DHT-finds-it simulation: libp2p's own peer store carries
    // K1's address under K2's peer id, as a DHT walk would have put
    // it there. A `dialProtocol(peerId)` call would read these
    // addresses and dial K1 again; the rule the case holds
    // (MESH_INTERFACE → The client's node list → "A read opens no
    // connection") refuses that dial.
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

  it('a key whose only open connection is limited is not read on', () => {
    // MESH_INTERFACE → The client's node list → "A read opens no
    // connection" — "an open one, a direct one first, a relayed one
    // when that is all there is, never a limited one". The strict
    // read pick refuses the limited fallback: a connections list of
    // only limited open ones reads
    // null, even when `direct` and the right peer. The display pick
    // (`pickConnectionForLabel`) answers the limited connection in
    // the same shape (its full matrix is in
    // `test/relayed-webrtc-fixes.test.ts`); the read pick refuses
    // it.
    const TARGET = '12D3KooWFvHBAbhX5X9P4ViwiTcJiy2diw7rk7rp1BhtvZtvEyr4';
    const limitedDirect: Connection = {
      status: 'open',
      direct: true,
      limits: { bytes: 1024n, seconds: 60 },
      remoteAddr: {
        toString: () =>
          '/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/uEiAVZaUYSQpGvbSz9JTC4e4hT4qg9eDWVvHe4lhPUT_wxg/p2p/' + TARGET,
      },
      remotePeer: { toString: () => TARGET },
    } as unknown as Connection;
    expect(
      pickConnectionForRead([limitedDirect], TARGET),
      'reading on a limited-only connection returns null',
    ).toBeNull();
  });

  it('a key whose only connection is closed is not read on', () => {
    // MESH_INTERFACE → The client's node list → "A read opens no
    // connection" — "an open one, a direct one first". The read pick
    // narrows the label pick's result, so the open filter the label
    // enforces reaches the read: a closed connection, even direct and
    // unlimited, reads null here. The property is pinned through the
    // read path on purpose: a mutation that lets the label pick a
    // closed connection would otherwise show up only in a label-only
    // case.
    const TARGET = '12D3KooWFvHBAbhX5X9P4ViwiTcJiy2diw7rk7rp1BhtvZtvEyr4';
    const closedDirect: Connection = {
      status: 'closed',
      direct: true,
      limits: undefined,
      remoteAddr: {
        toString: () =>
          '/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/uEiAVZaUYSQpGvbSz9JTC4e4hT4qg9eDWVvHe4lhPUT_wxg/p2p/' + TARGET,
      },
      remotePeer: { toString: () => TARGET },
    } as unknown as Connection;
    expect(
      pickConnectionForRead([closedDirect], TARGET),
      'reading on a closed-only connection returns null',
    ).toBeNull();
  });

  it('a node tied with the winner reads ok after a check', async () => {
    // MESH_INTERFACE → The client's node list — the node-list table's
    // first row: a tip the client's chain already holds at the tip
    // reads `ok`, the winner and every verified tie with it. Both
    // anchors verified `behind === 0`, both read ok.
    const upA = await chainUpstream(SHARED_CHAIN); ups.push(upA);
    const upB = await chainUpstream(SHARED_CHAIN); ups.push(upB);
    const dirA = mkdtempSync(join(tmpdir(), 'tie-a-')); dirs.push(dirA);
    const dirB = mkdtempSync(join(tmpdir(), 'tie-b-')); dirs.push(dirB);
    const a = await startNode(upA, dirA); nodes.push(a.node);
    const b = await startNode(upB, dirB); nodes.push(b.node);

    const client = await startMeshClient({
      anchors: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      resolve: chainResolve(() => SHARED_CHAIN, K),
    });
    clients.push(client);
    await client.check();
    const s = client.state();
    expect(s.nodes.find((n) => n.notisId === a.id)!.status).toBe('ok');
    expect(s.nodes.find((n) => n.notisId === b.id)!.status).toBe('ok');
  }, 90_000);

  it('a tip read never goes to a trailing node', async () => {
    // MESH_INTERFACE → The client's node list → "A routed read goes to
    // a node its need allows" — "One that needs the tip goes to an
    // `ok` node". A is ok (behind 0), B is trailing (behind 1); every
    // tip read goes to A, regardless of the random source.
    const upA = await chainUpstream(CHAIN_K_PLUS_1); ups.push(upA);
    const upB = await chainUpstream(CHAIN_K_PLUS_1_TRAIL); ups.push(upB);
    const dirA = mkdtempSync(join(tmpdir(), 'tr-a-')); dirs.push(dirA);
    const dirB = mkdtempSync(join(tmpdir(), 'tr-b-')); dirs.push(dirB);
    const a = await startNode(upA, dirA); nodes.push(a.node);
    const b = await startNode(upB, dirB); nodes.push(b.node);

    let randIdx = 0;
    const randValues = Array.from({ length: 10 }, (_, i) => i / 10);
    const client = await startMeshClient({
      anchors: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      random: () => randValues[randIdx++ % randValues.length]!,
      resolve: chainResolve((url) => (url.includes(a.id) ? CHAIN_K_PLUS_1 : CHAIN_K_PLUS_1_TRAIL), K),
    });
    clients.push(client);
    await client.check();
    for (let i = 0; i < 10; i += 1) {
      const { nodeId } = await client.read('/blocks/current', 'tip');
      expect(nodeId).toBe(a.id);
    }
  }, 120_000);

  it('a tip read with no usable ok node rejects as transport and triggers a check', async () => {
    // MESH_INTERFACE → The client's node list → "A routed read goes to
    // a node its need allows" — "With none, the read fails as a
    // transport failure." + "a failed routed read runs a check at
    // once". A settled chain at A's tip; A is gone, B one block short
    // reads `trailing`. A `tip` read refuses the trailing-only set and
    // triggers a check.
    const upA = await chainUpstream(CHAIN_K_PLUS_1); ups.push(upA);
    const upB = await chainUpstream(CHAIN_K_PLUS_1_TRAIL); ups.push(upB);
    const dirA = mkdtempSync(join(tmpdir(), 'notip-a-')); dirs.push(dirA);
    const dirB = mkdtempSync(join(tmpdir(), 'notip-b-')); dirs.push(dirB);
    const a = await startNode(upA, dirA); nodes.push(a.node);
    const b = await startNode(upB, dirB); nodes.push(b.node);

    let aStopped = false;
    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(a.id)) return aStopped ? 'unreachable' : CHAIN_K_PLUS_1;
      return CHAIN_K_PLUS_1_TRAIL;
    };
    const client = await startMeshClient({
      anchors: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      resolve: chainResolve(chainOf, K),
    });
    clients.push(client);
    await client.check();
    // After the first check: A `ok` at the tip, B `trailing` one below.
    expect(client.state().nodes.find((n) => n.notisId === a.id)!.status).toBe('ok');
    expect(client.state().nodes.find((n) => n.notisId === b.id)!.status).toBe('trailing');

    // A goes down; A's connection drops. Routed `tip` read sees no
    // ok node (A unreachable, B trailing) and rejects.
    await a.node.stop();
    nodes.splice(nodes.indexOf(a.node), 1);
    aStopped = true;
    const checksBefore = client.state().checks;

    let caught: unknown;
    try {
      await client.read('/blocks/current', 'tip');
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(MeshFetchError);
    expect((caught as MeshFetchError).kind).toBe('transport');
    expect((caught as MeshFetchError).message).toMatch(/no node allowed/i);

    const deadlineMs = Date.now() + 10_000;
    while (client.state().checks === checksBefore && Date.now() < deadlineMs) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(client.state().checks).toBeGreaterThan(checksBefore);
    // The triggered check places B's tip as `one-below`; B stays
    // `trailing`.
    expect(client.state().nodes.find((n) => n.notisId === b.id)!.status).toBe('trailing');
  }, 60_000);

  it('older reads spread over ok and trailing nodes in the fast set', async () => {
    // MESH_INTERFACE → The client's node list — "a read of content
    // older than the newest block goes to an `ok` or a `trailing`
    // node". A is ok, B is trailing; a sweep of random values over
    // [0, 1) picks both ids across 50 reads.
    const upA = await chainUpstream(CHAIN_K_PLUS_1); ups.push(upA);
    const upB = await chainUpstream(CHAIN_K_PLUS_1_TRAIL); ups.push(upB);
    const dirA = mkdtempSync(join(tmpdir(), 'ol-a-')); dirs.push(dirA);
    const dirB = mkdtempSync(join(tmpdir(), 'ol-b-')); dirs.push(dirB);
    const a = await startNode(upA, dirA); nodes.push(a.node);
    const b = await startNode(upB, dirB); nodes.push(b.node);

    let randIdx = 0;
    const seen = new Set<string>();
    const client = await startMeshClient({
      anchors: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      random: () => {
        const v = randIdx / 50;
        randIdx = (randIdx + 1) % 50;
        return v;
      },
      resolve: chainResolve((url) => (url.includes(a.id) ? CHAIN_K_PLUS_1 : CHAIN_K_PLUS_1_TRAIL), K),
    });
    clients.push(client);
    await client.check();
    for (let i = 0; i < 50; i += 1) {
      const { nodeId } = await client.read('/blocks/current', 'older');
      seen.add(nodeId);
    }
    expect(seen.size, 'the spread touches both ids').toBe(2);
  }, 120_000);

  it('nodeId names the node the latest read went to', async () => {
    // MESH_INTERFACE → The client's node list — "The client's state
    // names the node and path the latest routed read went to". After
    // a successful `read`, `state.nodeId` equals the serving node.
    const upA = await chainUpstream(SHARED_CHAIN); ups.push(upA);
    const upB = await chainUpstream(SHARED_CHAIN); ups.push(upB);
    const dirA = mkdtempSync(join(tmpdir(), 'nid-a-')); dirs.push(dirA);
    const dirB = mkdtempSync(join(tmpdir(), 'nid-b-')); dirs.push(dirB);
    const a = await startNode(upA, dirA); nodes.push(a.node);
    const b = await startNode(upB, dirB); nodes.push(b.node);

    let randIdx = 0;
    const client = await startMeshClient({
      anchors: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      // 0 picks the first fast-set entry, 0.99 picks the last — so we
      // can force both nodes in turn.
      random: () => [0, 0.99][randIdx++ % 2]!,
      resolve: chainResolve(() => SHARED_CHAIN, K),
    });
    clients.push(client);
    await client.check();
    const r1 = await client.read('/blocks/current', 'tip');
    expect(client.state().nodeId).toBe(r1.nodeId);
    const r2 = await client.read('/blocks/current', 'tip');
    expect(client.state().nodeId).toBe(r2.nodeId);
    // Across two reads with (0, 0.99) sweep, the two anchors are both
    // picked at least once each.
    expect(new Set([r1.nodeId, r2.nodeId]).size).toBe(2);
  }, 120_000);

  it('lastLeft names any node that left ok/trailing', async () => {
    // MESH_INTERFACE → The client's node list → "A routed read goes to
    // a node its need allows" — the state carries, after a check, a
    // node that was `ok` or `trailing` before it and is neither after
    // it. Three anchors ok after check 1; the second stops; after
    // check 2 the second is in retry while the first stays `ok`, and
    // `lastLeft`
    // names the one that left.
    const upA = await chainUpstream(SHARED_CHAIN); ups.push(upA);
    const upB = await chainUpstream(SHARED_CHAIN); ups.push(upB);
    const upC = await chainUpstream(SHARED_CHAIN); ups.push(upC);
    const dirA = mkdtempSync(join(tmpdir(), 'll3-a-')); dirs.push(dirA);
    const dirB = mkdtempSync(join(tmpdir(), 'll3-b-')); dirs.push(dirB);
    const dirC = mkdtempSync(join(tmpdir(), 'll3-c-')); dirs.push(dirC);
    const a = await startNode(upA, dirA); nodes.push(a.node);
    const b = await startNode(upB, dirB); nodes.push(b.node);
    const c = await startNode(upC, dirC); nodes.push(c.node);

    let bStopped = false;
    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (bStopped && url.includes(b.id)) return 'unreachable';
      return SHARED_CHAIN;
    };
    const client = await startMeshClient({
      anchors: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
        { notisId: c.id, addrs: [c.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      resolve: chainResolve(chainOf, K),
    });
    clients.push(client);
    await client.check();
    expect(client.state().lastLeft).toBeNull();

    // Stop B — A stays ok. The check records B's departure, so
    // `lastLeft` names B.
    await b.node.stop();
    nodes.splice(nodes.indexOf(b.node), 1);
    bStopped = true;
    await client.check();

    const s = client.state();
    expect(s.nodes.find((n) => n.notisId === a.id)!.status).toBe('ok');
    expect(s.nodes.find((n) => n.notisId === b.id)!.status).toBe('retry');
    expect(s.lastLeft).not.toBeNull();
    expect(s.lastLeft!.nodeId).toBe(b.id);
    expect(s.lastLeft!.reason).toMatch(/^failure:/);
  }, 120_000);

  it('readMs is the tip read time of the latest check', async () => {
    // MESH_INTERFACE → The client's node list → "A check" — a check
    // reads every candidate's tip, `GET /blocks/current`, timed from
    // the request to the end of the body, and that time is the node's
    // speed until the next check. The wrap times from fetch call to
    // end of body — a time to headers alone would miss the transfer,
    // which the delayed stub pins by holding the body back for 150 ms
    // after it
    // sends the headers.
    const BODY_DELAY_MS = 150;
    const srv = createServer((req, res) => {
      if (req.url === '/blocks/current') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.flushHeaders();
        setTimeout(() => {
          res.end(JSON.stringify({ height: 1, hash: 'ab'.repeat(32) }));
        }, BODY_DELAY_MS);
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = (srv.address() as AddressInfo).port;
    const stub: Stub = { srv, base: `http://127.0.0.1:${port}` };
    stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'rms-')); dirs.push(dir);
    const started = await startNode(stub, dir); nodes.push(started.node);

    const client = await startMeshClient({
      anchors: [{ notisId: started.id, addrs: [started.webrtcAddr] }],
      network: 'devnet', profile: PROFILE,
      resolve: chainResolve(() => 'unreachable', K),
    });
    clients.push(client);
    await client.check();
    const entry = client.state().nodes.find((n) => n.notisId === started.id)!;
    expect(entry.readMs).not.toBeNull();
    // A timer stopped at headers reads under the body delay; the
    // body-end timer reads over it.
    expect(entry.readMs!).toBeGreaterThanOrEqual(BODY_DELAY_MS / 2);
  }, 60_000);

  it('behindBy is the latest check\'s behind count per node', async () => {
    // MESH_INTERFACE → The client's node list — `TipResult.nodes[i].behind`
    // per node is written to the entry's `behindBy` from each check.
    const upA = await chainUpstream(CHAIN_K_PLUS_2); ups.push(upA);
    const upB = await chainUpstream(CHAIN_K_PLUS_2_TRAIL); ups.push(upB);
    const dirA = mkdtempSync(join(tmpdir(), 'bb-a-')); dirs.push(dirA);
    const dirB = mkdtempSync(join(tmpdir(), 'bb-b-')); dirs.push(dirB);
    const a = await startNode(upA, dirA); nodes.push(a.node);
    const b = await startNode(upB, dirB); nodes.push(b.node);

    const client = await startMeshClient({
      anchors: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      resolve: chainResolve((url) => (url.includes(a.id) ? CHAIN_K_PLUS_2 : CHAIN_K_PLUS_2_TRAIL), K),
    });
    clients.push(client);
    await client.check();
    const s = client.state();
    expect(s.nodes.find((n) => n.notisId === a.id)!.behindBy).toBe(0);
    expect(s.nodes.find((n) => n.notisId === b.id)!.behindBy).toBe(2);
  }, 90_000);

  it('agreement counts come from the latest check', async () => {
    // MESH_INTERFACE → No anchor reached → "The agreement counts" —
    // after each check `state.agreement` holds `{ agreeing,
    // agreeingAnchors, notAgreeing }` from the latest `TipResult`.
    const upA = await chainUpstream(CHAIN_K_PLUS_1); ups.push(upA);
    const upB = await chainUpstream(CHAIN_K_PLUS_1_TRAIL); ups.push(upB);
    const dirA = mkdtempSync(join(tmpdir(), 'ag-a-')); dirs.push(dirA);
    const dirB = mkdtempSync(join(tmpdir(), 'ag-b-')); dirs.push(dirB);
    const a = await startNode(upA, dirA); nodes.push(a.node);
    const b = await startNode(upB, dirB); nodes.push(b.node);

    const client = await startMeshClient({
      anchors: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      resolve: chainResolve((url) => (url.includes(a.id) ? CHAIN_K_PLUS_1 : CHAIN_K_PLUS_1_TRAIL), K),
    });
    clients.push(client);
    // Before the first check, agreement is null.
    expect(client.state().agreement).toBeNull();
    await client.check();
    const s = client.state();
    expect(s.agreement).not.toBeNull();
    expect(s.agreement!.onChain).toBe(2);
    expect(s.agreement!.onChainAnchors).toBe(2);
    expect(s.agreement!.offChain).toBe(0);
  }, 90_000);

  it('checks counts completed checks: 0 at start, +1 at the end of each runCheck', async () => {
    // MESH_INTERFACE → The client's node list → "A routed read goes
    // to a node its need allows" — "how many checks it has completed,
    // so a reader can tell one check's state from the next". A
    // waiter that reads `checks > baseline` sees exactly one
    // completed check — the counts the agreement reports stay
    // identical between checks (the same nodes answer with the same
    // behind), so a baseline on `agreement` never changes and the
    // counter is the one hook a stage step has.
    const upA = await chainUpstream(CHAIN_K_PLUS_1); ups.push(upA);
    const upB = await chainUpstream(CHAIN_K_PLUS_1_TRAIL); ups.push(upB);
    const dirA = mkdtempSync(join(tmpdir(), 'chk-a-')); dirs.push(dirA);
    const dirB = mkdtempSync(join(tmpdir(), 'chk-b-')); dirs.push(dirB);
    const a = await startNode(upA, dirA); nodes.push(a.node);
    const b = await startNode(upB, dirB); nodes.push(b.node);

    const client = await startMeshClient({
      anchors: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      resolve: chainResolve((url) => (url.includes(a.id) ? CHAIN_K_PLUS_1 : CHAIN_K_PLUS_1_TRAIL), K),
    });
    clients.push(client);
    // Before any check, the counter reads 0.
    expect(client.state().checks).toBe(0);
    await client.check();
    expect(client.state().checks).toBe(1);
    await client.check();
    expect(client.state().checks).toBe(2);
    await client.check();
    expect(client.state().checks).toBe(3);
  }, 90_000);

  it('a failed read on a live connection triggers an immediate check', async () => {
    // MESH_INTERFACE → The client's node list → "A read opens no
    // connection" + "A routed read goes to a node its need allows" —
    // "a failed routed read runs a check at once, which dials from
    // the list." The existing "a failed read triggers a check" case
    // reaches the no-node branch (A stopped, no open connection, no
    // allowed node) which has its own trigger; the mutation removing
    // the fetch-failure catch's trigger alone leaves that case green.
    // This case holds the connection open and makes `newStream`
    // reject once, so pickServer returns A and the fetch itself
    // throws from inside meshFetchOverConnection. The 30 s periodic
    // check cannot stand in — the wait is a second.
    const upA = await chainUpstream(CHAIN_K_PLUS_1); ups.push(upA);
    const upB = await chainUpstream(CHAIN_K_PLUS_1_TRAIL); ups.push(upB);
    const dirA = mkdtempSync(join(tmpdir(), 'f4-a-')); dirs.push(dirA);
    const dirB = mkdtempSync(join(tmpdir(), 'f4-b-')); dirs.push(dirB);
    const a = await startNode(upA, dirA); nodes.push(a.node);
    const b = await startNode(upB, dirB); nodes.push(b.node);

    const client = await startMeshClient({
      anchors: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      random: () => 0,
      resolve: chainResolve((url) => (url.includes(a.id) ? CHAIN_K_PLUS_1 : CHAIN_K_PLUS_1_TRAIL), K),
    });
    clients.push(client);
    await client.check();
    const checksBefore = client.state().checks;

    // Patch A's own libp2p connection: next `newStream` rejects. The
    // connection stays "open" so pickConnectionForRead returns it,
    // and the fetch's meshFetchOverConnection catches the rejection
    // and throws `MeshFetchError('transport', ...)` — the
    // fetch-failure catch's path.
    const aPeer = peerIdFromNotisId(a.id).toString();
    const conn = client.libp2p.getConnections().find((c) => c.remotePeer.toString() === aPeer);
    expect(conn, 'the client holds a live connection to A').toBeDefined();
    let patched = true;
    const originalNewStream = conn!.newStream.bind(conn!);
    conn!.newStream = async (...args: Parameters<typeof originalNewStream>) => {
      if (patched) {
        patched = false;
        throw new Error('simulated newStream failure on a live connection');
      }
      return originalNewStream(...args);
    };

    let readError: unknown;
    try {
      await client.read('/blocks/current', 'tip');
    } catch (e) { readError = e; }
    expect(readError, 'the read rejected').toBeInstanceOf(MeshFetchError);
    expect((readError as MeshFetchError).kind).toBe('transport');

    // Within one second the triggered check must complete; the periodic
    // check (30 s) cannot contribute inside the window. `state.checks`
    // increments at the end of each runCheck.
    const deadlineMs = Date.now() + 2_000;
    while (client.state().checks === checksBefore && Date.now() < deadlineMs) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(client.state().checks, 'the fetch-failure catch triggered a check').toBeGreaterThan(checksBefore);
  }, 60_000);

  it('the tip read catch rethrows a non-MeshFetchError from classifyTipRead', async () => {
    // MESH_INTERFACE → The node endpoint — phase 5 catches a failed or
    // unroutable tip read (MeshFetchError kind `transport`) and sets
    // `tip = null`. A throw from classifyTipRead itself is a bug, not
    // a transport failure, and must surface instead of being
    // swallowed. The test forces classifyTipRead to throw by routing
    // the tip read to a notisId the list does not hold: the response
    // classifies as a non-ok HTTP answer, and `nodeList.failure` on
    // that unknown id throws from `unknown('failure', id)`.
    const upA = await chainUpstream(SHARED_CHAIN); ups.push(upA);
    const dirA = mkdtempSync(join(tmpdir(), 'f3-')); dirs.push(dirA);
    const a = await startNode(upA, dirA); nodes.push(a.node);

    const client = await startMeshClient({
      anchors: [{ notisId: a.id, addrs: [a.webrtcAddr] }],
      network: 'devnet', profile: PROFILE,
      resolve: chainResolve(() => SHARED_CHAIN, K),
    });
    clients.push(client);
    await client.check();

    const stranger = 'ff'.repeat(32);
    const typed = client as unknown as { read: typeof client.read };
    const originalRead = typed.read.bind(client);
    typed.read = async (path, need) => {
      if (need === 'tip') {
        return {
          response: new Response(JSON.stringify({ error: 'bad' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          }),
          nodeId: stranger,
        };
      }
      return originalRead(path, need);
    };

    let caught: unknown;
    try { await client.check(); } catch (e) { caught = e; }
    expect(caught, 'a non-MeshFetchError from classifyTipRead reaches the caller').toBeDefined();
    expect(caught, 'the catch rethrows non-transport errors').not.toBeInstanceOf(MeshFetchError);
  }, 60_000);

  it('the resolve seam receives a wall-clock now (reads > 1e12 ms)', async () => {
    // MESH_INTERFACE → "Two clocks" — "The verifier reads the wall
    // clock" — a header's stamp is wall-clock time. `startMeshClient`
    // hands its `wallClock` to the resolve seam; the retry clock stays
    // monotonic. The proof read runs only when a tip is unplaced, so
    // the test seats a reachable mesh node and uses a stub resolve
    // that captures the `now` the client passes.
    const up = await chainUpstream(SHARED_CHAIN); ups.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'wc-')); dirs.push(dir);
    const started = await startNode(up, dir); nodes.push(started.node);
    let capturedNow: (() => number) | null = null;
    const resolveStub: Parameters<typeof startMeshClient>[0]['resolve'] =
      async (_urls, _m, _k, _profile, now) => {
        capturedNow = now;
        return { winner: null, winnerIndex: -1, nodes: [], tip: null, suffixHead: null, splits: [] };
      };
    const client = await startMeshClient({
      anchors: [{ notisId: started.id, addrs: [started.webrtcAddr] }],
      network: 'devnet', profile: PROFILE,
      resolve: resolveStub,
      // Explicitly set wallClock to a fake that is clearly wall-clock
      // (ms since epoch >> 1e12).
      wallClock: () => 1_900_000_000_000,
    });
    clients.push(client);
    await client.check();
    expect(capturedNow, 'resolve was called').not.toBeNull();
    expect(capturedNow!(), 'wallClock reads > 1e12 ms').toBeGreaterThan(1e12);
  }, 60_000);

  it('a non-mesh URL in the resolve httpFetch surfaces as MeshUrlError', async () => {
    // MESH_INTERFACE → The node endpoint — every URL `resolveTip` reads
    // through `timedFetch` is `meshBaseUrl(id)`, so `idOfMeshUrl`
    // throwing on it would be a bug upstream. The current catch
    // swallows the throw and lets `this.fetch` throw a `MeshFetchError`
    // further down, hiding the original bug; with the catch dropped,
    // the `MeshUrlError` from `idOfMeshUrl` surfaces to the caller
    // intact.
    //
    // Phase 4 only calls `resolve` when the check holds an unplaced
    // tip, so the test seats a reachable node (chain unsettled → every
    // tip is unplaced at the first check); the probing resolve then
    // runs with the non-mesh URL.
    const up = await chainUpstream(SHARED_CHAIN); ups.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'nmu-')); dirs.push(dir);
    const started = await startNode(up, dir); nodes.push(started.node);
    let caught: unknown;
    const probingResolve: typeof import('@dagsocial/nipopow-client').resolveTip =
      async (_urls, _m, _k, _profile, _wall, httpFetch) => {
        try {
          await httpFetch('http://not-a-mesh-url/', undefined);
        } catch (e) { caught = e; }
        return { winner: null, winnerIndex: -1, nodes: [], tip: null, suffixHead: null, splits: [] };
      };
    const client = await startMeshClient({
      anchors: [{ notisId: started.id, addrs: [started.webrtcAddr] }],
      network: 'devnet', profile: PROFILE,
      resolve: probingResolve,
    });
    clients.push(client);
    await client.check();
    expect(caught, 'the non-mesh URL caused a throw').toBeDefined();
    expect(caught, 'the throw is a MeshUrlError, not a swallow-then-MeshFetchError').toBeInstanceOf(MeshUrlError);
  }, 60_000);

  it('a routed read during a check still picks by the previous check\'s speeds', async () => {
    // MESH_INTERFACE → The client's node list → "A check" — a check
    // reads every candidate's tip, `GET /blocks/current`, timed from
    // the request to the end of the body, and that time is the node's
    // speed until the next check. A speed holds until the next check
    // writes a fresh one. The test holds the second check's
    // `/blocks/current` reads on a server-side gate; during the hold,
    // a routed `older` read with random=0.99 (which picks the last of
    // the fast set) must reach A — the fast node from the first check
    // — not B, the slow one. A map cleared before the new readings
    // land spreads the pick to both A and B and random=0.99 lands on
    // B instead. A is the fast tip reader, B the slow one; both serve
    // the same chain so each is `ok` after the first check. The
    // second check holds A's `/blocks/current` on an external gate;
    // during the hold the routed `older` read reads from the previous
    // check's readMs values — the fast set is [A] and random=0.99
    // picks A.
    // Without the fix the live map is cleared, the fast set is [A, B],
    // and random=0.99 picks B.
    const BODY_DELAY_MS = 300;
    const chain = CHAIN_K_PLUS_1;
    const tipHeader = chain[chain.length - 1]!.header;
    const tipHash = blockHash(tipHeader);
    const makeSrv = (delayMs: number, isGated: () => boolean, gate: Promise<void>): Server =>
      createServer(async (req, res) => {
        if (req.url === '/blocks/current') {
          if (isGated()) await gate;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.flushHeaders();
          setTimeout(() => res.end(JSON.stringify({ height: K + 1, hash: tipHash })), delayMs);
          return;
        }
        res.writeHead(404); res.end();
      });
    let gateRelease: () => void = () => {};
    const gatePromise = new Promise<void>((r) => { gateRelease = r; });
    let secondCheckStarted = false;
    const srvA = makeSrv(0, () => secondCheckStarted, gatePromise);
    const srvB = makeSrv(BODY_DELAY_MS, () => false, gatePromise);
    await new Promise<void>((resolve) => srvA.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => srvB.listen(0, '127.0.0.1', resolve));
    const stubA: Stub = { srv: srvA, base: `http://127.0.0.1:${(srvA.address() as AddressInfo).port}` };
    const stubB: Stub = { srv: srvB, base: `http://127.0.0.1:${(srvB.address() as AddressInfo).port}` };
    stubs.push(stubA); stubs.push(stubB);
    const dirA = mkdtempSync(join(tmpdir(), 'f1-a-')); dirs.push(dirA);
    const dirB = mkdtempSync(join(tmpdir(), 'f1-b-')); dirs.push(dirB);
    const a = await startNode(stubA, dirA); nodes.push(a.node);
    const b = await startNode(stubB, dirB); nodes.push(b.node);

    const client = await startMeshClient({
      anchors: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      // random=0.99 picks the last entry of the fast set — a one-entry
      // fast set (A only) returns A; a two-entry fast set (A, B)
      // returns B.
      random: () => 0.99,
      resolve: chainResolve(() => chain, K),
    });
    clients.push(client);
    await client.check();

    // After the first check, A's readMs sits well under B's; both are
    // `ok` at the settled chain's tip.
    const s1 = client.state();
    const aMs = s1.nodes.find((n) => n.notisId === a.id)!.readMs;
    const bMs = s1.nodes.find((n) => n.notisId === b.id)!.readMs;
    expect(aMs, 'A has a readMs after the first check').not.toBeNull();
    expect(bMs, 'B has a readMs after the first check').not.toBeNull();
    expect(aMs! < bMs!, `A (${String(aMs)} ms) is faster than B (${String(bMs)} ms)`).toBe(true);
    expect(bMs! > 2 * aMs! + 50, 'B is beyond A\'s fast-set bound').toBe(true);
    expect(s1.nodes.find((n) => n.notisId === a.id)!.status).toBe('ok');
    expect(s1.nodes.find((n) => n.notisId === b.id)!.status).toBe('ok');

    // Start the second check; A's /blocks/current now holds on the
    // gate — phase 2's new readings have not completed.
    secondCheckStarted = true;
    const checkPromise = client.check();
    // Give phase 2's A read a chance to reach the server and suspend.
    await new Promise((r) => setTimeout(r, 100));

    try {
      // Both A and B are still `ok` from the first check; the live
      // readMsMap still holds A fast, B slow, so the fast set is [A].
      // The routed read opens /blocks/foo (a 404 on both servers, not
      // gated); nodeId names the picked server.
      const { nodeId: pickedId } = await client.read('/blocks/foo', 'older');
      expect(pickedId, 'the routed read reaches A — the previous check\'s fast node').toBe(a.id);
    } finally {
      // Release the gate no matter the assertion — a held check would
      // otherwise stall `client.stop()` and time the afterEach hook out.
      gateRelease();
      await checkPromise.catch(() => undefined);
    }
  }, 120_000);
});
