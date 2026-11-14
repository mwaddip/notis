// MESH_INTERFACE → The client's node list → "A check" — a check reads
// tips, places them on the held chain, and reads proofs only for tips
// the chain cannot place; the agreement counts come off the per-tip
// verdicts; `state.tip` is the chain's.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeOrderingBlock,
  generateKeyPair,
  MAGIC_DEVNET,
  PROTOCOL_VERSION,
  profileFor,
} from '@dagsocial/types';
import type { BlockHeader, NetworkProfile, NetworkType, OrderingBlock } from '@dagsocial/types';
import { asertTargetBits, blockHash } from '@dagsocial/validation';
import { verifierProfile } from '@dagsocial/nipopow-client';
import { gossipTopics, nodeKeyFromKeyPair, peerIdFromNotisId } from '@dagsocial/net/browser';
import { NetNode } from '@dagsocial/net';
import { startNetPublicMesh, type NetMeshNode } from './helpers/net-public-node.js';
import { waitReaderHeldAsDirect } from './helpers/direct-peer.js';
import { startMeshClient, type MeshClient } from '@dagsocial/web/mesh';
import { chainResolve, chainUpstream, type ChainUpstream } from './helpers/chain-harness.js';
import { makeBlockAt, makeLinkedChain } from './helpers/devnet-block.js';

const PROFILE: NetworkProfile = profileFor('devnet' as NetworkType);
const K = 5;

interface HandBuilt { srv: Server; base: string; }
async function handBuilt(handler: (req: { url: string }, res: {
  writeHead: (s: number, h?: Record<string, string>) => void;
  end: (b?: string) => void;
}) => void | Promise<void>): Promise<HandBuilt> {
  const srv = createServer(async (req, res) => {
    await handler({ url: req.url ?? '' }, res);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  return { srv, base: `http://127.0.0.1:${port}` };
}

async function startNode(
  upstream: { base: string },
  dir: string,
): Promise<NetMeshNode> {
  return await startNetPublicMesh({ upstream: upstream.base, stateDir: dir });
}

/**
 * A block built on top of `parent`, carrying the schedule asertTargetBits
 * imposes at parent's height, mined, and signed by a fresh key. Lets a
 * case extend a chain by gossip without the harness's whole-chain
 * mutation path.
 */
function makeChildBlock(parent: BlockHeader, t_a: number, profile: NetworkProfile): OrderingBlock {
  const retarget = verifierProfile(profile, 0).retarget;
  const scheduled = asertTargetBits(retarget, t_a, { height: parent.height, createdAt: parent.createdAt });
  const prev = blockHash(parent);
  if (prev === null) throw new Error('parent header outside the encodable domain');
  return makeBlockAt(parent.height + 1, PROTOCOL_VERSION, {
    prevBlockHash: prev,
    createdAt: parent.createdAt + profile.orderingBlockIdealMs,
    powTargetBits: scheduled,
  });
}

interface Router {
  publish(topic: string, data?: Uint8Array): Promise<unknown>;
}

function pubsubOf(libp2p: unknown): Router {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (libp2p as any).services.pubsub as Router;
}

describe('mesh-client — a check reads tips, places them, and proves the rest', () => {
  const nodes: NetNode[] = [];
  const ups: ChainUpstream[] = [];
  const builts: HandBuilt[] = [];
  const dirs: string[] = [];
  const clients: MeshClient[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) { try { await c.stop(); } catch { /* already stopped */ } }
    for (const n of nodes.splice(0)) { try { await n.stop(); } catch { /* already stopped */ } }
    for (const u of ups.splice(0)) { try { await u.close(); } catch { /* already closed */ } }
    for (const b of builts.splice(0)) {
      try { await new Promise<void>((r) => b.srv.close(() => r())); } catch { /* already closed */ }
    }
    for (const d of dirs.splice(0)) { rmSync(d, { recursive: true, force: true }); }
  });

  it('the first check reads one proof per distinct tip', async () => {
    // MESH_INTERFACE → The client's node list → "A check" — "one proof
    // per distinct tip, from the node the list ranks first among those
    // naming it". Three nodes on chain A, one on fork B: resolve is
    // handed two URLs; nodes on A's tip read `ok`.
    const chainA = makeLinkedChain(K + 1, PROFILE);
    const chainB = makeLinkedChain(K + 1, PROFILE); // different keys → different hashes
    const upA1 = await chainUpstream(chainA); ups.push(upA1);
    const upA2 = await chainUpstream(chainA); ups.push(upA2);
    const upA3 = await chainUpstream(chainA); ups.push(upA3);
    const upB = await chainUpstream(chainB); ups.push(upB);
    const d1 = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(d1);
    const d2 = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(d2);
    const d3 = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(d3);
    const d4 = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(d4);
    const a1 = await startNode(upA1, d1); nodes.push(a1.node);
    const a2 = await startNode(upA2, d2); nodes.push(a2.node);
    const a3 = await startNode(upA3, d3); nodes.push(a3.node);
    const b = await startNode(upB, d4); nodes.push(b.node);

    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(a1.id) || url.includes(a2.id) || url.includes(a3.id)) return chainA;
      if (url.includes(b.id)) return chainB;
      return 'unreachable';
    };
    const underlying = chainResolve(chainOf, K);
    const resolveUrls: string[][] = [];
    const client = await startMeshClient({
      firstContact: [
        { notisId: a1.id, addrs: [a1.webrtcAddr] },
        { notisId: a2.id, addrs: [a2.webrtcAddr] },
        { notisId: a3.id, addrs: [a3.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: async (urls, ...rest) => { resolveUrls.push([...urls]); return underlying(urls, ...rest); },
    });
    clients.push(client);
    await client.check();

    // Resolve was called exactly once in phase 4, with two URLs — one per
    // distinct hash (chainA's tip, chainB's tip).
    expect(resolveUrls.length).toBe(1);
    expect(resolveUrls[0]!.length).toBe(2);
    const idsCalled = resolveUrls[0]!.map((u) => u.replace('notis-mesh://', ''));
    const aSet = new Set([a1.id, a2.id, a3.id]);
    const aCount = idsCalled.filter((id) => aSet.has(id)).length;
    expect(aCount).toBe(1); // exactly one of the three A-nodes carried A's hash
    expect(idsCalled.includes(b.id)).toBe(true);
    // All three A nodes read ok (same hash as the chain's winner), B is behind
    // on the losing fork.
    const s = client.state();
    expect(s.nodes.find((n) => n.notisId === a1.id)!.status).toBe('ok');
    expect(s.nodes.find((n) => n.notisId === a2.id)!.status).toBe('ok');
    expect(s.nodes.find((n) => n.notisId === a3.id)!.status).toBe('ok');
    expect(s.nodes.find((n) => n.notisId === b.id)!.status).toBe('behind');
  }, 120_000);

  it('a check with every tip placed reads no proof', async () => {
    // MESH_INTERFACE → The client's node list → "A check" — "A check
    // that places every tip reads no proof". After settlement, five
    // checks with nodes at the tip, one below, two below: `proofReads`
    // unchanged, statuses `ok`, `trailing`, `behind`.
    const chain = makeLinkedChain(K + 2, PROFILE);
    const upA = await chainUpstream(chain); ups.push(upA);
    const upB = await chainUpstream(chain.slice(0, K + 1)); ups.push(upB); // one below
    const upC = await chainUpstream(chain.slice(0, K)); ups.push(upC);     // two below
    const dA = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dA);
    const dB = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dB);
    const dC = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dC);
    const a = await startNode(upA, dA); nodes.push(a.node);
    const b = await startNode(upB, dB); nodes.push(b.node);
    const c = await startNode(upC, dC); nodes.push(c.node);

    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(a.id)) return chain;
      if (url.includes(b.id)) return chain.slice(0, K + 1);
      if (url.includes(c.id)) return chain.slice(0, K);
      return 'unreachable';
    };
    const underlying = chainResolve(chainOf, K);
    const resolveUrls: string[][] = [];
    const client = await startMeshClient({
      firstContact: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
        { notisId: c.id, addrs: [c.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: async (urls, ...rest) => { resolveUrls.push([...urls]); return underlying(urls, ...rest); },
    });
    clients.push(client);
    await client.check();
    const callsAfterSettle = resolveUrls.length;
    const proofReadsAfterSettle = client.state().traffic.proofReads;

    for (let i = 0; i < 5; i += 1) await client.check();

    expect(resolveUrls.length).toBe(callsAfterSettle);
    expect(client.state().traffic.proofReads).toBe(proofReadsAfterSettle);
    const s = client.state();
    expect(s.nodes.find((n) => n.notisId === a.id)!.status).toBe('ok');
    expect(s.nodes.find((n) => n.notisId === b.id)!.status).toBe('trailing');
    expect(s.nodes.find((n) => n.notisId === c.id)!.status).toBe('behind');
  }, 180_000);

  it('a tip above the client\'s is read down and linked', async () => {
    // MESH_INTERFACE → The client's node list → "The client's chain" —
    // a fill reads the serving node's headers by height from its tip
    // down to the client's, the client's tip moving when the fill
    // links. The highest named height's fill runs first, from the
    // client's tip as it then stands; a lower `above` tip placed by
    // that fill is read from the extended chain. A at K+2, B at K+4:
    // B's fill moves the chain to K+4; A reads `behind` as a place two
    // below the new tip; no proof read.
    const base = makeLinkedChain(K + 4, PROFILE);
    const start = base.slice(0, K + 1);     // tip at K+1
    const oneAbove = base.slice(0, K + 2);  // A: one block above start
    const threeAbove = base.slice(0, K + 4); // B: three blocks above start

    const upA = await chainUpstream(start); ups.push(upA);
    const upB = await chainUpstream(start); ups.push(upB);
    const dA = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dA);
    const dB = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dB);
    const a = await startNode(upA, dA); nodes.push(a.node);
    const b = await startNode(upB, dB); nodes.push(b.node);

    // First check: both at the same chain; settle.
    const chainsNow: { a: OrderingBlock[]; b: OrderingBlock[] } = { a: start, b: start };
    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(a.id)) return chainsNow.a;
      if (url.includes(b.id)) return chainsNow.b;
      return 'unreachable';
    };
    const underlying = chainResolve(chainOf, K);
    const resolveUrls: string[][] = [];
    const client = await startMeshClient({
      firstContact: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: async (urls, ...rest) => { resolveUrls.push([...urls]); return underlying(urls, ...rest); },
    });
    clients.push(client);
    await client.check();
    const callsAfterSettle = resolveUrls.length;
    const headersBefore = client.state().traffic.headerBytes;

    // Advance: A one block above, B three above.
    upA.setChain(oneAbove);
    chainsNow.a = oneAbove;
    upB.setChain(threeAbove);
    chainsNow.b = threeAbove;
    await client.check();

    // No new proof read; headers were read.
    expect(resolveUrls.length).toBe(callsAfterSettle);
    expect(client.state().traffic.headerBytes).toBeGreaterThan(headersBefore);
    const s = client.state();
    // After B's fill moves the chain tip to K+4, A at K+2 is two below;
    // place says `below` → event `behind`.
    expect(s.nodes.find((n) => n.notisId === a.id)!.status).toBe('behind');
    expect(s.nodes.find((n) => n.notisId === b.id)!.status).toBe('ok');
  }, 180_000);

  it('a tip more than k above starts a proof read', async () => {
    // MESH_INTERFACE → The client's node list → "A check" — "no more
    // than `k`" headers in the fill; a gap larger than that leaves the
    // tip unplaced and runs a proof read in phase 4.
    const chainSmall = makeLinkedChain(K + 1, PROFILE);
    const chainTall = makeLinkedChain(K + 1 + 21, PROFILE); // 21 above = DEFAULT_K + 1
    const upA = await chainUpstream(chainSmall); ups.push(upA);
    const upB = await chainUpstream(chainSmall); ups.push(upB);
    const dA = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dA);
    const dB = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dB);
    const a = await startNode(upA, dA); nodes.push(a.node);
    const b = await startNode(upB, dB); nodes.push(b.node);

    const chainsNow: { a: OrderingBlock[]; b: OrderingBlock[] } = {
      a: chainSmall,
      b: chainSmall,
    };
    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(a.id)) return chainsNow.a;
      if (url.includes(b.id)) return chainsNow.b;
      return 'unreachable';
    };
    const underlying = chainResolve(chainOf, K);
    const resolveUrls: string[][] = [];
    const client = await startMeshClient({
      firstContact: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: async (urls, ...rest) => { resolveUrls.push([...urls]); return underlying(urls, ...rest); },
    });
    clients.push(client);
    await client.check();
    const callsAfterSettle = resolveUrls.length;

    // B jumps 21 blocks above the client's tip — a gap > DEFAULT_K.
    upB.setChain(chainTall);
    chainsNow.b = chainTall;
    await client.check();

    expect(resolveUrls.length).toBe(callsAfterSettle + 1);
    const lastUrls = resolveUrls[resolveUrls.length - 1]!;
    const idsCalled = lastUrls.map((u) => u.replace('notis-mesh://', ''));
    expect(idsCalled.includes(b.id)).toBe(true);
  }, 240_000);

  it('an unplaced tip reads its proof and the client\'s own, own first', async () => {
    // MESH_INTERFACE → The client's node list → "A check" — while the
    // client holds a chain, its own tip's proof from a node at its tip
    // is handed to `resolveTip` first so a tie keeps the chain.
    const chainA = makeLinkedChain(K + 1, PROFILE);
    const chainB = makeLinkedChain(K + 1, PROFILE); // fork
    const upA = await chainUpstream(chainA); ups.push(upA);
    const upB = await chainUpstream(chainA); ups.push(upB); // starts on A so settle happens
    const dA = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dA);
    const dB = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dB);
    const a = await startNode(upA, dA); nodes.push(a.node);
    const b = await startNode(upB, dB); nodes.push(b.node);

    const chainsNow: { a: OrderingBlock[]; b: OrderingBlock[] } = {
      a: chainA,
      b: chainA,
    };
    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(a.id)) return chainsNow.a;
      if (url.includes(b.id)) return chainsNow.b;
      return 'unreachable';
    };
    const underlying = chainResolve(chainOf, K);
    const resolveUrls: string[][] = [];
    const client = await startMeshClient({
      firstContact: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: async (urls, ...rest) => { resolveUrls.push([...urls]); return underlying(urls, ...rest); },
    });
    clients.push(client);
    await client.check(); // settle at A's chain, both on A's chain

    // Move B to a fork (unplaceable hash at same height).
    upB.setChain(chainB);
    chainsNow.b = chainB;
    await client.check();

    expect(resolveUrls.length).toBeGreaterThanOrEqual(2);
    const lastUrls = resolveUrls[resolveUrls.length - 1]!;
    // The first URL is the client's own tip's node (A).
    expect(lastUrls[0]).toBe('notis-mesh://' + a.id);
    // B is in the list too (its unplaceable hash needs a proof).
    expect(lastUrls.some((u) => u.includes(b.id))).toBe(true);
  }, 180_000);

  it('a null hash places nowhere and reads no proof', async () => {
    // MESH_INTERFACE → The client's node list → "A check" — "a tip
    // answered with no hash" is behind; no proof read.
    const built = await handBuilt((req, res) => {
      if (req.url === '/blocks/current') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ height: 5, hash: null }));
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
    builts.push(built);
    const d = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(d);
    const n = await startNode(built, d); nodes.push(n.node);

    const resolveUrls: string[][] = [];
    const client = await startMeshClient({
      firstContact: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: async (urls) => {
        resolveUrls.push([...urls]);
        return { winner: null, winnerIndex: -1, nodes: [], tip: null, suffixHead: null, splits: [] };
      },
    });
    clients.push(client);
    await client.check();

    // The node is `behind` and no proof read happened.
    expect(client.state().nodes.find((e) => e.notisId === n.id)!.status).toBe('behind');
    expect(resolveUrls.length).toBe(0);
    expect(client.state().traffic.proofReads).toBe(0);
  }, 60_000);

  it('a header that does not read is the serving node\'s lie', async () => {
    // MESH_INTERFACE → The client's node list → "The client's chain" —
    // a fill reads headers each held to its work, its schedule and its
    // link; a header that does not read lands as the serving node's
    // `malformed` lie through the node-list table's lie row.
    const base = makeLinkedChain(K + 2, PROFILE);
    const start = base.slice(0, K + 1); // settle here
    // A hostile upstream: /blocks/current claims tip above the client's,
    // /blocks/:h answers a malformed body for the named height.
    const settleTipHeader = start[start.length - 1]!.header;
    const settleTipHash = blockHash(settleTipHeader);
    const bogusHash = 'f'.repeat(64);

    let claimAbove = false;
    const built = await handBuilt((req, res) => {
      if (req.url === '/blocks/current') {
        res.writeHead(200, { 'content-type': 'application/json' });
        if (!claimAbove) {
          res.end(JSON.stringify({ height: K + 1, hash: settleTipHash }));
        } else {
          res.end(JSON.stringify({ height: K + 2, hash: bogusHash }));
        }
      } else if (req.url === '/blocks/' + (K + 2)) {
        // Malformed — not a header object.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ not: 'a header' }));
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
    builts.push(built);
    const upOther = await chainUpstream(start); ups.push(upOther);
    const dH = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dH);
    const dO = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dO);
    const hostileNode = await startNode(built, dH); nodes.push(hostileNode.node);
    const otherNode = await startNode(upOther, dO); nodes.push(otherNode.node);

    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(otherNode.id)) return start;
      if (url.includes(hostileNode.id)) return start;
      return 'unreachable';
    };
    const client = await startMeshClient({
      firstContact: [
        { notisId: hostileNode.id, addrs: [hostileNode.webrtcAddr] },
        { notisId: otherNode.id, addrs: [otherNode.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(chainOf, K),
    });
    clients.push(client);
    await client.check(); // settle

    // Now the hostile node claims a tip above but serves a malformed header.
    claimAbove = true;
    await client.check();

    const hostileEntry = client.state().nodes.find((e) => e.notisId === hostileNode.id)!;
    expect(hostileEntry.status).toBe('blacklisted');
    expect(hostileEntry.evidence?.kind).toBe('malformed');
  }, 180_000);

  it('speed is the tip read\'s time', async () => {
    // MESH_INTERFACE → The client's node list → "A check" — a check
    // reads every candidate's tip, `GET /blocks/current`, timed from
    // the request to the end of the body, and that time is the node's
    // speed until the next check. `readMs` is set from the timed
    // fetch, not from the proof read.
    const chain = makeLinkedChain(K + 1, PROFILE);
    const BODY_DELAY_MS = 150;
    const tipHeader = chain[chain.length - 1]!.header;
    const tipHash = blockHash(tipHeader);
    const built = await handBuilt(async (req, res) => {
      if (req.url === '/blocks/current') {
        res.writeHead(200, { 'content-type': 'application/json' });
        await new Promise<void>((r) => setTimeout(r, BODY_DELAY_MS));
        res.end(JSON.stringify({ height: K + 1, hash: tipHash }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    builts.push(built);
    const d = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(d);
    const n = await startNode(built, d); nodes.push(n.node);

    const client = await startMeshClient({
      firstContact: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(() => chain, K),
    });
    clients.push(client);
    await client.check();

    const entry = client.state().nodes.find((e) => e.notisId === n.id)!;
    expect(entry.readMs).not.toBeNull();
    // Tip read's body end comes after the delay; headers-only timing
    // would land under half the delay.
    expect(entry.readMs!).toBeGreaterThanOrEqual(BODY_DELAY_MS / 2);
  }, 60_000);

  it('the shown tip is the held chain\'s', async () => {
    // MESH_INTERFACE → The client's node list → "The client's chain" —
    // "The tip moves only by a header carrying its work on the client's
    // chain, never by a node's word". A routed tip read answering
    // another height leaves `state.tip` at the chain's tip; the routed
    // read still classifies a failure or a lie.
    const chain = makeLinkedChain(K + 1, PROFILE);
    const tipHeader = chain[chain.length - 1]!.header;
    const chainTipHash = blockHash(tipHeader);
    let call = 0;
    const built = await handBuilt((req, res) => {
      if (req.url === '/blocks/current') {
        call += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        if (call === 1) {
          res.end(JSON.stringify({ height: K + 1, hash: chainTipHash }));
        } else {
          // Phase 6's routed tip read sees a different valid-shape tip
          // (a height above with a bogus hash). The read still classifies
          // but is not a lie — just a different tip.
          res.end(JSON.stringify({ height: K + 2, hash: 'f'.repeat(64) }));
        }
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    builts.push(built);
    const d = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(d);
    const n = await startNode(built, d); nodes.push(n.node);

    const client = await startMeshClient({
      firstContact: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(() => chain, K),
    });
    clients.push(client);
    await client.check();

    const s = client.state();
    expect(s.tip).not.toBeNull();
    expect(s.tip!.height).toBe(K + 1);
    expect(s.tip!.hash).toBe(chainTipHash);
    // Node's status is `ok` — valid-shape tip not a lie.
    expect(s.nodes.find((e) => e.notisId === n.id)!.status).toBe('ok');

    // Now a hostile routed tip read: the next /blocks/current answers a
    // malformed body. Trigger a new check; phase 2 sees malformed, which
    // is `malformed` lie, and phase 6's routed read also classifies.
    // After this check `state.tip` is still the chain's tip (last
    // settled), not null.
    // Flip the server to always return malformed.
    (built.srv as unknown as { removeAllListeners(e?: string): Server })
      .removeAllListeners('request');
    built.srv.on('request', (req, res) => {
      if (req.url === '/blocks/current') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('not json at all');
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
    await client.check();
    const s2 = client.state();
    // The classify ran: the node is blacklisted.
    expect(s2.nodes.find((e) => e.notisId === n.id)!.status).toBe('blacklisted');
    // state.tip stays at the last chain tip (chain never rolled back).
    expect(s2.tip).not.toBeNull();
    expect(s2.tip!.height).toBe(K + 1);
    expect(s2.tip!.hash).toBe(chainTipHash);
  }, 120_000);

  it('a fill that moves the tip leaves the node at the old tip trailing', async () => {
    // MESH_INTERFACE → The client's node list → "A check" — phase 3
    // places every tip against the chain as it then stands, after the
    // `above` fills have moved the tip. A at the old tip and B one
    // above: after the fill links, A reads `trailing`, B reads `ok`,
    // and a tip-need routed read goes to B.
    const base = makeLinkedChain(K + 2, PROFILE);
    const start = base.slice(0, K + 1);
    const ext = base.slice(0, K + 2);
    const upA = await chainUpstream(start); ups.push(upA);
    const upB = await chainUpstream(start); ups.push(upB);
    const dA = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dA);
    const dB = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dB);
    const a = await startNode(upA, dA); nodes.push(a.node);
    const b = await startNode(upB, dB); nodes.push(b.node);

    const chainsNow: { a: OrderingBlock[]; b: OrderingBlock[] } = { a: start, b: start };
    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(a.id)) return chainsNow.a;
      if (url.includes(b.id)) return chainsNow.b;
      return 'unreachable';
    };
    const client = await startMeshClient({
      firstContact: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(chainOf, K),
    });
    clients.push(client);
    await client.check(); // settle at K+1 — both `ok`

    // Advance B one block above; A stays at K+1.
    upB.setChain(ext);
    chainsNow.b = ext;
    await client.check();

    const s = client.state();
    expect(s.nodes.find((n) => n.notisId === a.id)!.status).toBe('trailing');
    expect(s.nodes.find((n) => n.notisId === b.id)!.status).toBe('ok');
    // A tip-need routed read goes to an `ok` node — B, not A.
    const picked = await client.read('/blocks/current', 'tip');
    expect(picked.nodeId).toBe(b.id);
  }, 180_000);

  it('two nodes above at different heights are filled once, from the highest', async () => {
    // MESH_INTERFACE → The client's node list → "A check" — phase 3
    // runs the `above` fills first, highest named height first; a node
    // whose tip is placed by an earlier fill is not read again. B at
    // h+2, C at h+3: C's fill reads three headers; B is placed from the
    // extended chain with no read of its own.
    const base = makeLinkedChain(K + 4, PROFILE);
    const start = base.slice(0, K + 1);
    const bChain = base.slice(0, K + 3);     // B at K+3 (two above start)
    const cChain = base.slice(0, K + 4);     // C at K+4 (three above start)

    const upA = await chainUpstream(start); ups.push(upA);
    const upB = await chainUpstream(start); ups.push(upB);
    const upC = await chainUpstream(start); ups.push(upC);
    const dA = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dA);
    const dB = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dB);
    const dC = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dC);
    const a = await startNode(upA, dA); nodes.push(a.node);
    const b = await startNode(upB, dB); nodes.push(b.node);
    const c = await startNode(upC, dC); nodes.push(c.node);

    const chainsNow: { a: OrderingBlock[]; b: OrderingBlock[]; c: OrderingBlock[] } = {
      a: start, b: start, c: start,
    };
    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(a.id)) return chainsNow.a;
      if (url.includes(b.id)) return chainsNow.b;
      if (url.includes(c.id)) return chainsNow.c;
      return 'unreachable';
    };
    const client = await startMeshClient({
      firstContact: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
        { notisId: c.id, addrs: [c.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(chainOf, K),
    });
    clients.push(client);
    await client.check(); // settle at K+1
    const bHeightReadsBefore = upB.heightReads();
    const cHeightReadsBefore = upC.heightReads();

    // Advance B to K+2 and C to K+3.
    upB.setChain(bChain);
    chainsNow.b = bChain;
    upC.setChain(cChain);
    chainsNow.c = cChain;
    await client.check();

    // C's fill reads 3 headers; B's tip is placed from the extended
    // chain with no header read of its own.
    expect(upC.heightReads() - cHeightReadsBefore).toBe(3);
    expect(upB.heightReads() - bHeightReadsBefore).toBe(0);
    const s = client.state();
    // After the fill the chain tip is K+3; A is at K+1 (two below), B
    // at K+2 (one below), C at K+3 (tip).
    expect(s.nodes.find((n) => n.notisId === a.id)!.status).toBe('behind');
    expect(s.nodes.find((n) => n.notisId === b.id)!.status).toBe('trailing');
    expect(s.nodes.find((n) => n.notisId === c.id)!.status).toBe('ok');
  }, 240_000);

  it('the own-tip URL is a node placed at the tip this check', async () => {
    // MESH_INTERFACE → The client's node list → "A check" — the own-tip
    // URL prepended to the proof call is a node whose tip read this
    // check placed `tip` against the final chain, not a node that was
    // `ok` at the last check. A is `ok` from last check and moves to a
    // fork at the same height (unplaced in phase 3b, no event — A keeps
    // its `ok` status); B advances one block and is placed `tip` this
    // check; the own-tip URL must be B.
    const base = makeLinkedChain(K + 2, PROFILE);
    const start = base.slice(0, K + 1);
    const ext = base.slice(0, K + 2);
    const forkChain = makeLinkedChain(K + 1, PROFILE); // different hash at K+1
    const upA = await chainUpstream(start); ups.push(upA);
    const upB = await chainUpstream(start); ups.push(upB);
    const dA = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dA);
    const dB = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dB);
    const a = await startNode(upA, dA); nodes.push(a.node);
    const b = await startNode(upB, dB); nodes.push(b.node);

    const chainsNow: { a: OrderingBlock[]; b: OrderingBlock[] } = { a: start, b: start };
    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(a.id)) return chainsNow.a;
      if (url.includes(b.id)) return chainsNow.b;
      return 'unreachable';
    };
    const resolveUrls: string[][] = [];
    const underlying = chainResolve(chainOf, K);
    const client = await startMeshClient({
      firstContact: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: async (urls, ...rest) => {
        resolveUrls.push([...urls]);
        return underlying(urls, ...rest);
      },
    });
    clients.push(client);
    await client.check(); // settle at K+1 — both `ok` on `start`
    const callsAfterSettle = resolveUrls.length;

    // A moves to a fork at the same height (K+1, different hash); B
    // advances one block above (K+2). A's placement in phase 3b is
    // `unplaced` (window height matches, hash does not): no event
    // fires — A keeps `ok` from last check. B's `above` fill links
    // and places B at the tip.
    upA.setChain(forkChain);
    chainsNow.a = forkChain;
    upB.setChain(ext);
    chainsNow.b = ext;
    await client.check();

    expect(resolveUrls.length).toBeGreaterThan(callsAfterSettle);
    const lastUrls = resolveUrls[resolveUrls.length - 1]!;
    // The own-tip URL is a node placed `tip` THIS check — B, not A
    // (which is still `ok` from last check but was never placed `tip`
    // this check).
    expect(lastUrls[0]).toBe('notis-mesh://' + b.id);
  }, 180_000);

  it('behindBy is written for placed nodes', async () => {
    // MESH_INTERFACE → The client's node list → "A check" — every
    // placed node carries its `behindBy`: 0 at the tip, 1 one below,
    // the count below for a tip within the window.
    const chain = makeLinkedChain(K + 2, PROFILE);
    const upA = await chainUpstream(chain); ups.push(upA);
    const upB = await chainUpstream(chain.slice(0, K + 1)); ups.push(upB);  // one below
    const upC = await chainUpstream(chain.slice(0, K)); ups.push(upC);      // two below
    const dA = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dA);
    const dB = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dB);
    const dC = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dC);
    const a = await startNode(upA, dA); nodes.push(a.node);
    const b = await startNode(upB, dB); nodes.push(b.node);
    const c = await startNode(upC, dC); nodes.push(c.node);

    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(a.id)) return chain;
      if (url.includes(b.id)) return chain.slice(0, K + 1);
      if (url.includes(c.id)) return chain.slice(0, K);
      return 'unreachable';
    };
    const client = await startMeshClient({
      firstContact: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
        { notisId: c.id, addrs: [c.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(chainOf, K),
    });
    clients.push(client);
    await client.check(); // settle to A's chain
    // Second check — now the chain is settled and placements apply.
    await client.check();

    const s = client.state();
    expect(s.nodes.find((n) => n.notisId === a.id)!.behindBy).toBe(0);
    expect(s.nodes.find((n) => n.notisId === b.id)!.behindBy).toBe(1);
    expect(s.nodes.find((n) => n.notisId === c.id)!.behindBy).toBe(2);
  }, 180_000);

  it('a refused proof is asked of the next node naming the hash', async () => {
    // MESH_INTERFACE → The client's node list → "A check" — "the next
    // asked in the same check when that proof is refused". B1 and B2
    // name the same fork hash; B1's proof is invalid, so it is
    // `blacklisted` with its own evidence; B2's proof is read in the
    // same check through a further `resolveTip` and B2 is blacklisted
    // too — asserting both evidences shows the retry picked up B2.
    const chainA = makeLinkedChain(K + 2, PROFILE);
    const chainBfork = makeLinkedChain(K + 2, PROFILE); // different hashes
    const upA = await chainUpstream(chainA); ups.push(upA);
    const upB1 = await chainUpstream(chainBfork); ups.push(upB1);
    const upB2 = await chainUpstream(chainBfork); ups.push(upB2);
    const dA = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dA);
    const d1 = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(d1);
    const d2 = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(d2);
    const a = await startNode(upA, dA); nodes.push(a.node);
    const b1 = await startNode(upB1, d1); nodes.push(b1.node);
    const b2 = await startNode(upB2, d2); nodes.push(b2.node);

    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(a.id)) return chainA;
      if (url.includes(b1.id)) return 'invalid';   // B1's proof refused
      if (url.includes(b2.id)) return 'invalid';   // B2's proof refused
      return 'unreachable';
    };
    const resolveUrls: string[][] = [];
    const underlying = chainResolve(chainOf, K);
    const client = await startMeshClient({
      firstContact: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b1.id, addrs: [b1.webrtcAddr] },
        { notisId: b2.id, addrs: [b2.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: async (urls, ...rest) => {
        resolveUrls.push([...urls]);
        return underlying(urls, ...rest);
      },
    });
    clients.push(client);
    await client.check();

    const s = client.state();
    const b1Entry = s.nodes.find((n) => n.notisId === b1.id)!;
    const b2Entry = s.nodes.find((n) => n.notisId === b2.id)!;
    expect(b1Entry.status).toBe('blacklisted');
    expect(b1Entry.evidence?.kind).toBe('proof-invalid');
    // Without the retry, B2's proof is never read and B2 stays at
    // whatever the re-placement left it (event `behind`, not
    // blacklisted). With the retry, B2's proof is read in a further
    // resolveTip pass, is also refused, and B2 is blacklisted with
    // its own evidence.
    expect(b2Entry.status).toBe('blacklisted');
    expect(b2Entry.evidence?.kind).toBe('proof-invalid');
    // The retry pass asked B2 explicitly.
    const b2Asked = resolveUrls.some((pass) =>
      pass.some((u) => u.includes(b2.id)),
    );
    expect(b2Asked).toBe(true);
  }, 180_000);

  it('after a switch every tip is placed against the new chain', async () => {
    // MESH_INTERFACE → The client's node list → "A check" — a switch
    // to a heavier chain leaves the previous `tip` placement stale;
    // the re-placement moves nodes named on the old chain to `behind`.
    // Two nodes A1 and A2 on chainLight: the own-tip URL is one of
    // them, the other is placed `tip` in phase 3 but is NOT in phase
    // 4. After B's heavier chain wins and the chain switches, A2 must
    // read `behind` as well.
    const chainLight = makeLinkedChain(K + 1, PROFILE);
    const chainHeavy = makeLinkedChain(K + 5, PROFILE); // different hashes, heavier
    const upA1 = await chainUpstream(chainLight); ups.push(upA1);
    const upA2 = await chainUpstream(chainLight); ups.push(upA2);
    const upB = await chainUpstream(chainLight); ups.push(upB);
    const d1 = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(d1);
    const d2 = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(d2);
    const dB = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dB);
    const a1 = await startNode(upA1, d1); nodes.push(a1.node);
    const a2 = await startNode(upA2, d2); nodes.push(a2.node);
    const b = await startNode(upB, dB); nodes.push(b.node);

    const chainsNow: {
      a1: OrderingBlock[]; a2: OrderingBlock[]; b: OrderingBlock[];
    } = { a1: chainLight, a2: chainLight, b: chainLight };
    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(a1.id)) return chainsNow.a1;
      if (url.includes(a2.id)) return chainsNow.a2;
      if (url.includes(b.id)) return chainsNow.b;
      return 'unreachable';
    };
    const client = await startMeshClient({
      firstContact: [
        { notisId: a1.id, addrs: [a1.webrtcAddr] },
        { notisId: a2.id, addrs: [a2.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(chainOf, K),
    });
    clients.push(client);
    await client.check(); // settle at chainLight (all ok)

    // B switches to chainHeavy. A1 and A2 stay on chainLight; both are
    // placed `tip` against the pre-switch chain. Phase 4's own-tip
    // prepend is one of them; the OTHER is not in phase 4 at all.
    upB.setChain(chainHeavy);
    chainsNow.b = chainHeavy;
    await client.check();

    const s = client.state();
    // After the switch, A1 and A2 are both on another chain; both read
    // `behind`. B reads `ok` on the new chain.
    expect(s.nodes.find((n) => n.notisId === a1.id)!.status).toBe('behind');
    expect(s.nodes.find((n) => n.notisId === a2.id)!.status).toBe('behind');
    expect(s.nodes.find((n) => n.notisId === b.id)!.status).toBe('ok');
  }, 240_000);

  it('a tip below the held window matched by the chain\'s own header reads behind with no proof', async () => {
    // MESH_INTERFACE → The client's node list → "A check" — "below the
    // held headers, held to the client's own header at that height,
    // read from a node at its tip". The `under` branch: the chain's
    // header at that height matches, event `behind`, no proof read.
    const chainBig = makeLinkedChain(K + 5, PROFILE);
    const chainShort = chainBig.slice(0, 2); // length 2 — under the window
    const upA = await chainUpstream(chainBig); ups.push(upA);
    const upB = await chainUpstream(chainShort); ups.push(upB);
    const dA = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dA);
    const dB = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dB);
    const a = await startNode(upA, dA); nodes.push(a.node);
    const b = await startNode(upB, dB); nodes.push(b.node);

    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(a.id)) return chainBig;
      if (url.includes(b.id)) return chainShort;
      return 'unreachable';
    };
    const resolveUrls: string[][] = [];
    const underlying = chainResolve(chainOf, K);
    const client = await startMeshClient({
      firstContact: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: async (urls, ...rest) => {
        resolveUrls.push([...urls]);
        return underlying(urls, ...rest);
      },
    });
    clients.push(client);
    await client.check(); // settle at chainBig; window = heights (K+5-K+1)..(K+5), lowestHeight > 2
    const proofReadsAfterSettle = client.state().traffic.proofReads;
    const callsAfterSettle = resolveUrls.length;
    await client.check();

    const s = client.state();
    expect(s.nodes.find((n) => n.notisId === b.id)!.status).toBe('behind');
    // No new proof read on the second check — the under matched.
    expect(client.state().traffic.proofReads).toBe(proofReadsAfterSettle);
    expect(resolveUrls.length).toBe(callsAfterSettle);
  }, 180_000);

  it('a tip below the held window not matched by the chain\'s own header reads its proof', async () => {
    // MESH_INTERFACE → The client's node list → "A check" — the `under`
    // branch mismatched: the chain's own header hash differs from the
    // tip read's hash; the tip falls through to the proof call.
    const chainBig = makeLinkedChain(K + 5, PROFILE);
    const chainFork = makeLinkedChain(2, PROFILE); // different hashes at heights 1 and 2
    const upA = await chainUpstream(chainBig); ups.push(upA);
    const upB = await chainUpstream(chainFork); ups.push(upB);
    const dA = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dA);
    const dB = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dB);
    const a = await startNode(upA, dA); nodes.push(a.node);
    const b = await startNode(upB, dB); nodes.push(b.node);

    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(a.id)) return chainBig;
      if (url.includes(b.id)) return chainFork;
      return 'unreachable';
    };
    const resolveUrls: string[][] = [];
    const underlying = chainResolve(chainOf, K);
    const client = await startMeshClient({
      firstContact: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: async (urls, ...rest) => {
        resolveUrls.push([...urls]);
        return underlying(urls, ...rest);
      },
    });
    clients.push(client);
    await client.check(); // settle at chainBig
    const callsAfterSettle = resolveUrls.length;
    await client.check();

    const s = client.state();
    // B's proof is read (chainFork is too-short → event `behind`).
    expect(s.nodes.find((n) => n.notisId === b.id)!.status).toBe('behind');
    expect(resolveUrls.length).toBeGreaterThan(callsAfterSettle);
  }, 180_000);

  it('speed is the tip read\'s even when a header read follows', async () => {
    // MESH_INTERFACE → The client's node list → "A check" — a check
    // reads every candidate's tip, `GET /blocks/current`, timed from
    // the request to the end of the body, and that time is the node's
    // speed until the next check. A header read for an `above` fill
    // through the same timed fetch must not overwrite the node's
    // speed.
    const base = makeLinkedChain(K + 2, PROFILE);
    const start = base.slice(0, K + 1);
    const ext = base.slice(0, K + 2);
    const HEIGHT_DELAY_MS = 300;
    const upA = await chainUpstream(start, { heightReadDelayMs: HEIGHT_DELAY_MS });
    ups.push(upA);
    const dA = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dA);
    const a = await startNode(upA, dA); nodes.push(a.node);

    const chainsNow: { a: OrderingBlock[] } = { a: start };
    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(a.id)) return chainsNow.a;
      return 'unreachable';
    };
    const client = await startMeshClient({
      firstContact: [{ notisId: a.id, addrs: [a.webrtcAddr] }],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(chainOf, K),
    });
    clients.push(client);
    await client.check(); // settle at start

    // Advance A one block above so phase 3a reads a slow `/blocks/K+2`.
    upA.setChain(ext);
    chainsNow.a = ext;
    await client.check();

    const entry = client.state().nodes.find((e) => e.notisId === a.id)!;
    expect(entry.readMs).not.toBeNull();
    // The tip read's time is well under the header-read delay. The
    // header read is slower; if it overwrote `readMs`, the figure
    // would be at least the delay.
    expect(entry.readMs!).toBeLessThan(HEIGHT_DELAY_MS / 2);
  }, 180_000);

  it('a lost tip\'s proof is read once', async () => {
    // MESH_INTERFACE → The client's node list → "A check" — "A tip
    // whose proof verified and lost keeps its verdict while the
    // client's chain stands". A node on a lighter chain names a tip
    // the held chain cannot place; the first check after settlement
    // reads its proof and the client's own, and reads `behind`.
    // Three more checks with that fork unchanged read no proofs —
    // the kept verdict stands in.
    const chainMain = makeLinkedChain(K + 5, PROFILE); // heavier
    const chainFork = makeLinkedChain(K + 2, PROFILE); // lighter, different hashes
    const upA = await chainUpstream(chainMain); ups.push(upA);
    const upB = await chainUpstream(chainFork); ups.push(upB);
    const dA = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dA);
    const dB = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dB);
    const a = await startNode(upA, dA); nodes.push(a.node);
    const b = await startNode(upB, dB); nodes.push(b.node);

    const chainsNow: { a: OrderingBlock[]; b: OrderingBlock[] } = {
      a: chainMain,
      b: chainFork,
    };
    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(a.id)) return chainsNow.a;
      if (url.includes(b.id)) return chainsNow.b;
      return 'unreachable';
    };
    const underlying = chainResolve(chainOf, K);
    const resolveUrls: string[][] = [];
    const urlCount = (): number => resolveUrls.reduce((s, p) => s + p.length, 0);
    const client = await startMeshClient({
      firstContact: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: async (urls, ...rest) => { resolveUrls.push([...urls]); return underlying(urls, ...rest); },
    });
    clients.push(client);
    await client.check(); // settle at chainMain
    const urlsAfterSettle = urlCount();

    await client.check(); // first after settle — reads fork + own
    const urlsAfterFirst = urlCount();
    expect(urlsAfterFirst - urlsAfterSettle).toBe(2);

    for (let i = 0; i < 3; i++) await client.check();
    expect(urlCount()).toBe(urlsAfterFirst);

    const s = client.state();
    expect(s.nodes.find((n) => n.notisId === b.id)!.status).toBe('behind');
    expect(s.agreement!.offChain).toBe(1);
  }, 240_000);

  it('a lost tip that moves is read again', async () => {
    // MESH_INTERFACE → The client's node list → "A check" — the kept
    // verdict is keyed by tip hash: a node answering a different hash
    // the next check falls out of the shortcut and reads the proof
    // again, from the node naming the new hash and the client's own.
    const chainMain = makeLinkedChain(K + 5, PROFILE);
    const chainFork = makeLinkedChain(K + 2, PROFILE);
    const chainFork2 = makeLinkedChain(K + 3, PROFILE); // different hashes
    const upA = await chainUpstream(chainMain); ups.push(upA);
    const upB = await chainUpstream(chainFork); ups.push(upB);
    const dA = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dA);
    const dB = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dB);
    const a = await startNode(upA, dA); nodes.push(a.node);
    const b = await startNode(upB, dB); nodes.push(b.node);

    const chainsNow: { a: OrderingBlock[]; b: OrderingBlock[] } = {
      a: chainMain,
      b: chainFork,
    };
    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(a.id)) return chainsNow.a;
      if (url.includes(b.id)) return chainsNow.b;
      return 'unreachable';
    };
    const underlying = chainResolve(chainOf, K);
    const resolveUrls: string[][] = [];
    const urlCount = (): number => resolveUrls.reduce((s, p) => s + p.length, 0);
    const client = await startMeshClient({
      firstContact: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: async (urls, ...rest) => { resolveUrls.push([...urls]); return underlying(urls, ...rest); },
    });
    clients.push(client);
    await client.check(); // settle at chainMain
    await client.check(); // first after settle — kept verdict stored
    const urlsBeforeMove = urlCount();

    // B moves to a different fork chain (new tip hash).
    upB.setChain(chainFork2);
    chainsNow.b = chainFork2;
    await client.check();
    expect(urlCount() - urlsBeforeMove).toBe(2);
  }, 240_000);

  it('a kept verdict is forgotten once no node names its tip', async () => {
    // MESH_INTERFACE → The client's node list → "A check" — the client
    // keeps a tip's verdict while the chain stands, and a kept hash
    // leaves when no node names it at a check. A node on a lighter
    // fork names H1 (read, kept), then names H2 for a check (so H1
    // leaves at the end-of-check sweep), then names H1 again — H1's
    // proof is read anew, from the node naming it and the client's
    // own. Without the sweep, the stale kept[H1] would short-circuit
    // B on the return and no proof would be read.
    const chainMain = makeLinkedChain(K + 5, PROFILE);
    const chainFork1 = makeLinkedChain(K + 2, PROFILE);
    const chainFork2 = makeLinkedChain(K + 3, PROFILE); // different hashes from Fork1
    const upA = await chainUpstream(chainMain); ups.push(upA);
    const upB = await chainUpstream(chainFork1); ups.push(upB);
    const dA = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dA);
    const dB = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dB);
    const a = await startNode(upA, dA); nodes.push(a.node);
    const b = await startNode(upB, dB); nodes.push(b.node);

    const chainsNow: { a: OrderingBlock[]; b: OrderingBlock[] } = {
      a: chainMain,
      b: chainFork1,
    };
    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(a.id)) return chainsNow.a;
      if (url.includes(b.id)) return chainsNow.b;
      return 'unreachable';
    };
    const underlying = chainResolve(chainOf, K);
    const resolveUrls: string[][] = [];
    const urlCount = (): number => resolveUrls.reduce((s, p) => s + p.length, 0);
    const client = await startMeshClient({
      firstContact: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: async (urls, ...rest) => { resolveUrls.push([...urls]); return underlying(urls, ...rest); },
    });
    clients.push(client);
    await client.check(); // settle at chainMain
    await client.check(); // first after settle — H1 kept

    // B moves to a different fork — H2 — so H1 is no longer named this check.
    upB.setChain(chainFork2);
    chainsNow.b = chainFork2;
    await client.check(); // H2's proof read and kept; the end-of-check sweep drops H1
    const urlsBeforeReturn = urlCount();

    // B returns to H1. The sweep removed kept[H1], so the proof is read anew
    // from B and the client's own tip. Without the sweep, kept[H1] would
    // still be there and B would be short-circuited (resolve never called).
    upB.setChain(chainFork1);
    chainsNow.b = chainFork1;
    await client.check();
    expect(urlCount() - urlsBeforeReturn).toBe(2);
  }, 240_000);

  it('a refused proof is never kept', async () => {
    // MESH_INTERFACE → The client's node list → "A check" — "A tip
    // whose proof verified and lost keeps its verdict" is conditional
    // on `n.verified`; a refused proof is never kept. After settle,
    // L moves to chainFork and lies (resolve answers 'invalid') —
    // blacklisted. The honest node C then moves to chainFork so C
    // names the same hash H; chainUpstream's /blocks/current reports
    // the chain's tip, so pointing C at chainFork makes C name L's
    // old H. The chainResolve harness answers 'invalid' per URL
    // regardless of the tip the upstream serves, so L and C's roles
    // ride two independent flags (`chainsNow.l` and `chainsNow.c`).
    // With the `n.verified` guard intact, kept has no entry for H,
    // so C's proof is read and C reads `behind`; a refused-proof
    // keep would short-circuit C to `blacklisted` on the kept lie
    // and skip the resolve pass for C's URL.
    const chainMain = makeLinkedChain(K + 5, PROFILE);
    const chainFork = makeLinkedChain(K + 2, PROFILE);
    const upA = await chainUpstream(chainMain); ups.push(upA);
    const upL = await chainUpstream(chainMain); ups.push(upL); // L starts on main
    const upC = await chainUpstream(chainMain); ups.push(upC);
    const dA = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dA);
    const dL = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dL);
    const dC = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dC);
    const a = await startNode(upA, dA); nodes.push(a.node);
    const l = await startNode(upL, dL); nodes.push(l.node);
    const c = await startNode(upC, dC); nodes.push(c.node);

    const chainsNow: { a: OrderingBlock[]; l: OrderingBlock[] | 'invalid'; c: OrderingBlock[] } = {
      a: chainMain,
      l: chainMain,
      c: chainMain,
    };
    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(a.id)) return chainsNow.a;
      if (url.includes(l.id)) return chainsNow.l;
      if (url.includes(c.id)) return chainsNow.c;
      return 'unreachable';
    };
    const underlying = chainResolve(chainOf, K);
    const resolveUrls: string[][] = [];
    const client = await startMeshClient({
      firstContact: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: l.id, addrs: [l.webrtcAddr] },
        { notisId: c.id, addrs: [c.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: async (urls, ...rest) => { resolveUrls.push([...urls]); return underlying(urls, ...rest); },
    });
    clients.push(client);
    await client.check(); // settle at chainMain; every node reads ok

    // L switches to chainFork so L names H, and chainsNow.l flips to
    // 'invalid' so the resolver refuses L's proof — L is blacklisted.
    // No chain switch runs here (A still wins the chain's own hash),
    // so the end-of-check sweep is the only path that could remove
    // keptVerdicts[H] — and the correct code never put one there.
    upL.setChain(chainFork);
    chainsNow.l = 'invalid';
    await client.check();
    expect(client.state().nodes.find((n) => n.notisId === l.id)!.status).toBe('blacklisted');

    // C's upstream moves to chainFork so C now names H.
    upC.setChain(chainFork);
    chainsNow.c = chainFork;
    await client.check();
    expect(client.state().nodes.find((n) => n.notisId === c.id)!.status).toBe('behind');
    // C's URL was in the resolve pass — a kept lie would have shortcut it.
    expect(resolveUrls[resolveUrls.length - 1]!.some((u) => u.includes(c.id))).toBe(true);
  }, 240_000);

  it('a switch drops the kept verdicts', async () => {
    // MESH_INTERFACE → The client's node list → "A check" — a tip whose
    // proof verified and lost keeps its verdict while the client's
    // chain stands; when the chain switches the kept verdicts fall
    // away. After a heavier chain wins and the chain switches, a node
    // naming a tip lost against the old chain is read again on the
    // next check.
    const chainMain = makeLinkedChain(K + 2, PROFILE);     // initial
    const chainFork = makeLinkedChain(K + 1, PROFILE);     // lighter, lost
    const chainHeavier = makeLinkedChain(K + 5, PROFILE);  // triggers the switch
    const upA = await chainUpstream(chainMain); ups.push(upA);
    const upB = await chainUpstream(chainFork); ups.push(upB);
    const upD = await chainUpstream(chainMain); ups.push(upD);
    const dA = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dA);
    const dB = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dB);
    const dD = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dD);
    const a = await startNode(upA, dA); nodes.push(a.node);
    const b = await startNode(upB, dB); nodes.push(b.node);
    const d = await startNode(upD, dD); nodes.push(d.node);

    const chainsNow: { a: OrderingBlock[]; b: OrderingBlock[]; d: OrderingBlock[] } = {
      a: chainMain,
      b: chainFork,
      d: chainMain,
    };
    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(a.id)) return chainsNow.a;
      if (url.includes(b.id)) return chainsNow.b;
      if (url.includes(d.id)) return chainsNow.d;
      return 'unreachable';
    };
    const underlying = chainResolve(chainOf, K);
    const resolveUrls: string[][] = [];
    const client = await startMeshClient({
      firstContact: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
        { notisId: d.id, addrs: [d.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: async (urls, ...rest) => { resolveUrls.push([...urls]); return underlying(urls, ...rest); },
    });
    clients.push(client);
    await client.check(); // settle at chainMain
    await client.check(); // first after settle — forkHash kept

    // D moves to the heavier chain; this check switches the chain.
    upD.setChain(chainHeavier);
    chainsNow.d = chainHeavier;
    await client.check(); // chain switches, kept verdicts cleared

    // On the next check, B's forkHash must be re-read: the kept
    // verdict was dropped by the switch. If it had stood, Phase 4
    // would replay for B and the resolve pass would omit B.url.
    await client.check();
    const lastCall = resolveUrls[resolveUrls.length - 1]!;
    expect(lastCall.some((u) => u.includes(b.id))).toBe(true);
  }, 300_000);

  it('a fill whose header read fails at the transport leaves the node in retry, never blacklisted', async () => {
    // MESH_INTERFACE → The client's node list — a transport failure on
    // a fill's header read is the retry row of the table, never a lie.
    // The hostile's /blocks/current claims a tip above the client's;
    // /blocks/<K+2> destroys the socket, so the mesh node's upstream
    // fetch throws and the client's read fails at the transport.
    const base = makeLinkedChain(K + 2, PROFILE);
    const start = base.slice(0, K + 1);
    const settleTipHash = blockHash(start[start.length - 1]!.header);
    const bogusHash = 'f'.repeat(64);
    let claimAbove = false;
    const built = await handBuilt((req, res) => {
      if (req.url === '/blocks/current') {
        res.writeHead(200, { 'content-type': 'application/json' });
        if (!claimAbove) {
          res.end(JSON.stringify({ height: K + 1, hash: settleTipHash }));
        } else {
          res.end(JSON.stringify({ height: K + 2, hash: bogusHash }));
        }
      } else if (req.url === '/blocks/' + (K + 2)) {
        (res as unknown as { destroy(): void }).destroy();
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
    builts.push(built);
    const upOther = await chainUpstream(start); ups.push(upOther);
    const dH = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dH);
    const dO = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dO);
    const hostile = await startNode(built, dH); nodes.push(hostile.node);
    const other = await startNode(upOther, dO); nodes.push(other.node);
    const chainsNow: { h: OrderingBlock[] | 'unreachable'; o: OrderingBlock[] } = {
      h: start,
      o: start,
    };
    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(hostile.id)) return chainsNow.h;
      if (url.includes(other.id)) return chainsNow.o;
      return 'unreachable';
    };
    const client = await startMeshClient({
      firstContact: [
        { notisId: hostile.id, addrs: [hostile.webrtcAddr] },
        { notisId: other.id, addrs: [other.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(chainOf, K),
    });
    clients.push(client);
    await client.check(); // settle at K+1
    claimAbove = true;
    chainsNow.h = 'unreachable'; // phase 4's own-reach fails at the transport too
    await client.check();
    const hostileEntry = client.state().nodes.find((e) => e.notisId === hostile.id)!;
    expect(hostileEntry.status).toBe('retry');
  }, 180_000);

  it('a fill answered 404 leaves the node in retry', async () => {
    // MESH_INTERFACE → The client's node list — a non-2xx answer is a
    // transport-tier failure (the `retry` row), never a lie. The
    // hostile claims a tip above and answers /blocks/<K+2> with 404.
    const base = makeLinkedChain(K + 2, PROFILE);
    const start = base.slice(0, K + 1);
    const settleTipHash = blockHash(start[start.length - 1]!.header);
    const bogusHash = 'f'.repeat(64);
    let claimAbove = false;
    const built = await handBuilt((req, res) => {
      if (req.url === '/blocks/current') {
        res.writeHead(200, { 'content-type': 'application/json' });
        if (!claimAbove) {
          res.end(JSON.stringify({ height: K + 1, hash: settleTipHash }));
        } else {
          res.end(JSON.stringify({ height: K + 2, hash: bogusHash }));
        }
      } else if (req.url === '/blocks/' + (K + 2)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
    builts.push(built);
    const upOther = await chainUpstream(start); ups.push(upOther);
    const dH = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dH);
    const dO = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dO);
    const hostile = await startNode(built, dH); nodes.push(hostile.node);
    const other = await startNode(upOther, dO); nodes.push(other.node);
    const chainsNow: { h: OrderingBlock[] | 'unreachable'; o: OrderingBlock[] } = {
      h: start,
      o: start,
    };
    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(hostile.id)) return chainsNow.h;
      if (url.includes(other.id)) return chainsNow.o;
      return 'unreachable';
    };
    const client = await startMeshClient({
      firstContact: [
        { notisId: hostile.id, addrs: [hostile.webrtcAddr] },
        { notisId: other.id, addrs: [other.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(chainOf, K),
    });
    clients.push(client);
    await client.check(); // settle at K+1
    claimAbove = true;
    chainsNow.h = 'unreachable';
    await client.check();
    const hostileEntry = client.state().nodes.find((e) => e.notisId === hostile.id)!;
    expect(hostileEntry.status).toBe('retry');
  }, 180_000);

  it('a fill reads a block whose JSON is over 1 KiB', async () => {
    // MESH_INTERFACE → The client's node list — the fill's cap is
    // `BLOCK_READ_BYTES`, 8 MiB, not /blocks/current's own 1 KiB. A
    // block with 30 `utxoTxIds` in its JSON is over 1 KiB and the fill
    // reads its header all the same.
    const base = makeLinkedChain(K + 2, PROFILE);
    const start = base.slice(0, K + 1);
    const oneAbove = base.slice(0, K + 2);
    const upA = await chainUpstream(start, { extraUtxoTxIdsInJson: 30 }); ups.push(upA);
    const upB = await chainUpstream(start, { extraUtxoTxIdsInJson: 30 }); ups.push(upB);
    const dA = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dA);
    const dB = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dB);
    const a = await startNode(upA, dA); nodes.push(a.node);
    const b = await startNode(upB, dB); nodes.push(b.node);
    const chainsNow: { a: OrderingBlock[]; b: OrderingBlock[] } = { a: start, b: start };
    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(a.id)) return chainsNow.a;
      if (url.includes(b.id)) return chainsNow.b;
      return 'unreachable';
    };
    const client = await startMeshClient({
      firstContact: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(chainOf, K),
    });
    clients.push(client);
    await client.check(); // settle
    upA.setChain(oneAbove);
    chainsNow.a = oneAbove;
    await client.check();
    const s = client.state();
    // A's fill reads one header at K+2 whose JSON is over 1 KiB; under
    // the correct cap the fill links, so A ends `ok`. Under the old
    // cap readHeaderAt returns null and A is blacklisted as `malformed`.
    expect(s.nodes.find((n) => n.notisId === a.id)!.status).toBe('ok');
  }, 180_000);

  it('a check with no candidate schedules no other at once', async () => {
    // MESH_INTERFACE → The client's node list — the client runs one
    // check at a time; a trigger that fires while a check is in flight
    // is that check. A check that reaches the routed tip read with no
    // candidate throws `MeshFetchError` and triggers an immediate
    // check; the trigger must see the running check and not schedule
    // a 0 ms recurrence.
    const built = await handBuilt((req, res) => {
      if (req.url === '/blocks/current') {
        (res as unknown as { destroy(): void }).destroy();
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    builts.push(built);
    const d = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(d);
    const n = await startNode(built, d); nodes.push(n.node);

    const client = await startMeshClient({
      firstContact: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(() => 'unreachable', K),
    });
    clients.push(client);
    await client.check(); // /blocks/current fails at the transport → retry
    expect(client.state().nodes.find((e) => e.notisId === n.id)!.status).toBe('retry');
    await client.check(); // no candidate; phase 6's trigger must not reschedule
    const checksBefore = client.state().checks;
    await new Promise<void>((r) => setTimeout(r, 1200));
    const checksAfter = client.state().checks;
    // Without the fix: the 0 ms recurrence runs thousands of checks
    // per second. With it: no check runs until `CHECK_INTERVAL_MS`.
    expect(checksAfter - checksBefore).toBeLessThanOrEqual(1);
  }, 60_000);

  it('a settle is skipped when the winner\'s tip is held by the chain', async () => {
    // MESH_INTERFACE → The client's node list → "The client's chain" —
    // "The tip moves only by a header carrying its work on the client's
    // chain, never by a node's word". The race: a Phase-4 proof read
    // from a node at the client's tip ends with that tip's hash while
    // a gossiped block has already extended the chain by one; the
    // winner's tip is one below the new tip and is held by the window,
    // so the chain stands — no settle onto the shorter suffix.
    //
    // The gossip is injected inside the second check's `resolve`
    // wrapper (the closest the harness allows): `underlying` answers
    // the proof read, then the wrapper publishes the extending block
    // from A's mesh node and waits for the client's `chain.extend` to
    // land before returning, so Phase 4 weighs the winner's tip
    // against the extended chain.
    const chainBase = makeLinkedChain(K + 1, PROFILE);
    const forkChain = makeLinkedChain(K + 1, PROFILE); // same length, different hashes
    const extraBlock = makeChildBlock(
      chainBase[chainBase.length - 1]!.header,
      chainBase[0]!.header.createdAt,
      PROFILE,
    );
    const upA = await chainUpstream(chainBase); ups.push(upA);
    const upX = await chainUpstream(forkChain); ups.push(upX);
    const dA = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dA);
    const dX = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dX);
    const a = await startNode(upA, dA); nodes.push(a.node);
    const x = await startNode(upX, dX); nodes.push(x.node);

    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(a.id)) return chainBase;
      if (url.includes(x.id)) return forkChain;
      return 'unreachable';
    };
    const underlying = chainResolve(chainOf, K);

    let injectOnNextResolve: null | (() => Promise<void>) = null;
    const resolve: typeof underlying = async (urls, ...rest) => {
      const r = await underlying(urls, ...rest);
      if (injectOnNextResolve !== null) {
        const fn = injectOnNextResolve;
        injectOnNextResolve = null;
        await fn();
      }
      return r;
    };

    const client = await startMeshClient({
      firstContact: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: x.id, addrs: [x.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve,
    });
    clients.push(client);
    await client.check(); // settle at chainBase (K+1); A `ok`, X `behind`.
    expect(client.state().tip?.height).toBe(K + 1);

    // A's router holds the client as a direct peer and lists it among the topic's subscribers so the inside-resolve publish propagates to it.
    const TOPIC = gossipTopics(MAGIC_DEVNET).orderingBlock;
    await waitReaderHeldAsDirect(a.libp2p, client.libp2p, TOPIC);

    // Second check: inject the gossiped extension inside the Phase-4
    // resolve so the chain gains K+2 before the winner's tip (K+1) is
    // weighed.
    injectOnNextResolve = async () => {
      await pubsubOf(a.libp2p).publish(TOPIC, encodeOrderingBlock(extraBlock));
      await vi.waitFor(() => {
        expect(client.state().tip?.height).toBe(K + 2);
      }, { timeout: 15_000, interval: 50 });
    };
    await client.check();

    // The winner's tip (K+1) is held by the window after the gossip
    // extension, so the chain stands at K+2 — no settle onto the old
    // suffix.
    expect(client.state().tip?.height).toBe(K + 2);
  }, 180_000);

  it('seated, anchor and chain move with the chain', async () => {
    // WEB_INTERFACE → The extension → "The verified figures" → "The anchor";
    // WEB_INTERFACE → The extension → "The chain's name" — after the first
    // check `state.seated` is true, `state.anchor` names the proof's tip and
    // its suffix head, and `state.chain` is the proof's genesisHash (block
    // 1's blockHash). After a gossiped block links, both ends of the anchor
    // move by one. The HeldChain's `k` is `DEFAULT_K`, so the proof must carry
    // that many suffix headers for the window to settle full and the suffix
    // head to be non-null.
    const K_DEFAULT = 20;
    const chain = makeLinkedChain(K_DEFAULT + 1, PROFILE);
    const upA = await chainUpstream(chain); ups.push(upA);
    const upB = await chainUpstream(chain); ups.push(upB);
    const dA = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dA);
    const dB = mkdtempSync(join(tmpdir(), 'cbt-')); dirs.push(dB);
    const a = await startNode(upA, dA); nodes.push(a.node);
    const b = await startNode(upB, dB); nodes.push(b.node);

    const chainsNow: { a: OrderingBlock[]; b: OrderingBlock[] } = { a: chain, b: chain };
    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(a.id)) return chainsNow.a;
      if (url.includes(b.id)) return chainsNow.b;
      return 'unreachable';
    };
    const client = await startMeshClient({
      firstContact: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(chainOf, K_DEFAULT),
    });
    clients.push(client);

    // Before any check: no anchor, no chain, not seated.
    const before = client.state();
    expect(before.seated).toBe(false);
    expect(before.anchor).toBeNull();
    expect(before.chain).toBeNull();

    await client.check(); // settle at K_DEFAULT + 1
    const s1 = client.state();
    expect(s1.seated).toBe(true);
    // The anchor's tip is the proof's tip header; `chainResolve`'s proof is
    // the chain's last `K_DEFAULT` headers, so the tip header is
    // `chain[K_DEFAULT]` (height K_DEFAULT + 1) and the suffix head is
    // `chain[chain.length - K_DEFAULT]` (height 2).
    expect(s1.anchor).not.toBeNull();
    expect(s1.anchor!.tip.height).toBe(K_DEFAULT + 1);
    expect(s1.anchor!.suffixHead.height).toBe(2);
    expect(blockHash(s1.anchor!.tip)).toBe(blockHash(chain[K_DEFAULT]!.header));
    expect(blockHash(s1.anchor!.suffixHead)).toBe(blockHash(chain[1]!.header));
    // The chain name is the proof's genesisHash — blockHash of block 1.
    expect(s1.chain).toBe(blockHash(chain[0]!.header));

    // Gossip one block linked onto the tip. Build it off `chain[K_DEFAULT]`
    // and publish from A's mesh node so the client's gossip handler links it.
    const extraBlock = makeChildBlock(
      chain[K_DEFAULT]!.header,
      chain[0]!.header.createdAt,
      PROFILE,
    );
    const TOPIC = gossipTopics(MAGIC_DEVNET).orderingBlock;
    await waitReaderHeldAsDirect(a.libp2p, client.libp2p, TOPIC);
    await pubsubOf(a.libp2p).publish(TOPIC, encodeOrderingBlock(extraBlock));
    await vi.waitFor(() => {
      expect(client.state().tip?.height).toBe(K_DEFAULT + 2);
    }, { timeout: 15_000, interval: 50 });

    const s2 = client.state();
    // After the link, each end of the anchor is one higher.
    expect(s2.anchor).not.toBeNull();
    expect(s2.anchor!.tip.height).toBe(s1.anchor!.tip.height + 1);
    expect(s2.anchor!.suffixHead.height).toBe(s1.anchor!.suffixHead.height + 1);
    // The chain's name does not change — the block 1 is the same.
    expect(s2.chain).toBe(s1.chain);
  }, 180_000);

  // MESH_INTERFACE → The client's node list → "An entry may carry an API
  // base" — a node the list gives one for is read there over HTTPS wherever
  // the client holds no connection to its key. These cases pin four
  // rules: mesh-first with an API-base fallback, the
  // before-first-check first-contact node, an API-base lie as `retry`, and one
  // entry per key whichever way it answered.
  it('every mesh dial failing: the first read routes to api, the check seats, proofs land at the bases', async () => {
    // MESH_INTERFACE → The client's node list → "A routed read goes to a
    // node its need allows" / → "An entry may carry an API base" — each
    // first-contact entry's `addrs` names a closed port (nothing listens
    // there), so every mesh dial fails; each entry's `api` is the chain harness's
    // own HTTP URL. The first `read('/blocks/current','tip')` answers
    // with `route: 'api'` before the first check ends; the check reads
    // tips and proofs at those bases and seats the chain.
    const K_DEFAULT = 20;
    const chain = makeLinkedChain(K_DEFAULT + 1, PROFILE);
    const upA = await chainUpstream(chain); ups.push(upA);
    const upB = await chainUpstream(chain); ups.push(upB);
    const kA = nodeKeyFromKeyPair(generateKeyPair());
    const kB = nodeKeyFromKeyPair(generateKeyPair());
    const closedAddrA = fakeWebrtcAddr('127.0.0.1', 1, kA.notisId);
    const closedAddrB = fakeWebrtcAddr('127.0.0.1', 1, kB.notisId);
    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.startsWith(upA.base) || url.startsWith(upB.base)) return chain;
      return 'unreachable';
    };
    const client = await startMeshClient({
      firstContact: [
        { notisId: kA.notisId, addrs: [closedAddrA], api: upA.base },
        { notisId: kB.notisId, addrs: [closedAddrB], api: upB.base },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(chainOf, K_DEFAULT),
    });
    clients.push(client);
    // The before-first-check first-contact fallback answers routed reads over
    // the API base — no node has a connection yet, so the first read
    // must land at an API before the first check ends.
    const startedAtMs = Date.now();
    const first = await client.read('/blocks/current', 'tip');
    expect(Date.now() - startedAtMs).toBeLessThan(10_000);
    expect(first.route).toBe('api');
    expect([kA.notisId, kB.notisId]).toContain(first.nodeId);
    expect(first.response.ok).toBe(true);

    await client.check();
    const s1 = client.state();
    expect(s1.seated).toBe(true);
    // Proofs counted for the API-base reads too — "`ClientState.proofs`
    // counts the proofs read at a base as it counts those read over
    // the mesh".
    expect(s1.proofs).not.toBeNull();
    expect(s1.proofs!.verified).toBeGreaterThanOrEqual(1);
    // The agreement-on-chain count names at least one entry, and the
    // chain name is this chain's genesis.
    expect(s1.agreement!.onChain).toBeGreaterThanOrEqual(1);
    expect(s1.chain).toBe(blockHash(chain[0]!.header));
  }, 60_000);

  it('a read before the first check ends is served by a first-contact node at its API base', async () => {
    // MESH_INTERFACE → The client's node list → "Before the first check
    // ends a node the client started from serves any need" — with no check
    // yet completed the read reaches the node's api, not a transport failure.
    const chain = makeLinkedChain(5, PROFILE);
    const up = await chainUpstream(chain); ups.push(up);
    const k = nodeKeyFromKeyPair(generateKeyPair());
    const closedAddr = fakeWebrtcAddr('127.0.0.1', 1, k.notisId);
    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.startsWith(up.base)) return chain;
      return 'unreachable';
    };
    const client = await startMeshClient({
      firstContact: [{ notisId: k.notisId, addrs: [closedAddr], api: up.base }],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(chainOf, 5),
    });
    clients.push(client);
    // The state has not seen a check complete yet.
    expect(client.state().checks).toBe(0);
    const r = await client.read('/blocks/current', 'tip');
    expect(r.route).toBe('api');
    expect(r.nodeId).toBe(k.notisId);
    const body = await r.response.json();
    expect(body).toMatchObject({ height: chain.length });
  }, 60_000);

  it("one first-contact node's certhash wrong: its reads go to api, the other's over the mesh", async () => {
    // MESH_INTERFACE → The client's node list → "An entry may carry an
    // API base" — a dial whose certhash does not match the peer's
    // fails as transport, and the entry falls back to its api. The
    // reachable first-contact node's reads stay on the mesh. The route the client
    // picks is
    // visible on each entry's `transport`/`path` pair.
    const K_DEFAULT = 20;
    const chain = makeLinkedChain(K_DEFAULT + 1, PROFILE);
    const upA = await chainUpstream(chain); ups.push(upA);
    const upB = await chainUpstream(chain); ups.push(upB);
    const dA = mkdtempSync(join(tmpdir(), 'cbt-api-')); dirs.push(dA);
    const dB = mkdtempSync(join(tmpdir(), 'cbt-api-')); dirs.push(dB);
    const a = await startNode(upA, dA); nodes.push(a.node);
    const b = await startNode(upB, dB); nodes.push(b.node);
    // B's addr with a scrambled certhash: dial fails at WebRTC-direct's
    // certhash check, which `applyEvent` records as transport.
    const bBogusAddr = fakeWebrtcAddr('127.0.0.1', 1, b.id);
    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(a.id) || url.startsWith(upA.base)) return chain;
      if (url.includes(b.id) || url.startsWith(upB.base)) return chain;
      return 'unreachable';
    };
    const client = await startMeshClient({
      firstContact: [
        { notisId: a.id, addrs: [a.webrtcAddr], api: upA.base },
        { notisId: b.id, addrs: [bBogusAddr], api: upB.base },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(chainOf, K_DEFAULT),
    });
    clients.push(client);
    await client.check();
    const s = client.state();
    const aEntry = s.nodes.find((n) => n.notisId === a.id)!;
    const bEntry = s.nodes.find((n) => n.notisId === b.id)!;
    // A reached over the mesh: has a transport/path pair.
    expect(aEntry.transport).not.toBeNull();
    expect(aEntry.status).toBe('ok');
    // B's dial failed, so its reads went to its api. The status row
    // moves by the tip there — B is at the chain's tip too, so `ok`.
    // The entry carries no transport/path (no open connection on the
    // mesh), and its api is the one the list named.
    expect(bEntry.transport).toBeNull();
    expect(bEntry.path).toBeNull();
    expect(bEntry.status).toBe('ok');
    expect(bEntry.api).toBe(upB.base);
    expect(s.seated).toBe(true);
    expect(s.agreement!.onChain).toBe(2);
  }, 90_000);

  it('one entry per key: a first-contact node reached both ways counts once in onChain', async () => {
    // MESH_INTERFACE → The client's node list → "An entry may carry an
    // API base" — "It is one entry whichever way it answers — one
    // witness in every count". With the mesh connection open, the
    // routed read goes over the mesh and the check reads at the mesh
    // base; the api is a fallback the check does not need. The entry
    // is one row in `onChain`.
    const K_DEFAULT = 20;
    const chain = makeLinkedChain(K_DEFAULT + 1, PROFILE);
    const up = await chainUpstream(chain); ups.push(up);
    const d = mkdtempSync(join(tmpdir(), 'cbt-single-')); dirs.push(d);
    const n = await startNode(up, d); nodes.push(n.node);
    const chainOf = (url: string): OrderingBlock[] | 'invalid' | 'unreachable' => {
      if (url.includes(n.id) || url.startsWith(up.base)) return chain;
      return 'unreachable';
    };
    const client = await startMeshClient({
      firstContact: [{ notisId: n.id, addrs: [n.webrtcAddr], api: up.base }],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(chainOf, K_DEFAULT),
    });
    clients.push(client);
    await client.check();
    const s = client.state();
    expect(s.agreement!.onChain).toBe(1);
    // The one entry carries both addresses and the api.
    expect(s.nodes).toHaveLength(1);
    expect(s.nodes[0]!.api).toBe(up.base);
  }, 90_000);

  it('an api-base malformed tip is `retry`, never `blacklisted` (the API-base row)', async () => {
    // MESH_INTERFACE → The client's node list — "a malformed answer, a
    // proof that fails verification … the same at an entry's API base
    // — the host, not the key — HTTPS authenticates a name, never a
    // node key — `retry`, as a transport failure; never `blacklisted`".
    // The first-contact node carries an api alone (no addrs), so phase 1 dials
    // nothing and phase 2's api read is the only move on the entry.
    const liar = await handBuilt(async (req, res) => {
      if (req.url === '/blocks/current') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('not json'); // malformed body
        return;
      }
      res.writeHead(404); res.end();
    });
    builts.push(liar);
    const k = nodeKeyFromKeyPair(generateKeyPair());
    const client = await startMeshClient({
      firstContact: [{ notisId: k.notisId, addrs: [], api: liar.base }],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(() => 'unreachable', 5),
    });
    clients.push(client);
    await client.check();
    const entry = client.state().nodes.find((e) => e.notisId === k.notisId)!;
    expect(entry.status).toBe('retry');
    expect(entry.evidence).toBeNull();
    expect(entry.lastFailure).not.toBeNull();
    expect(entry.lastFailure!.kind).toBe('transport');
    // The diagnostic names the api-lie detail so a reader sees why.
    expect(entry.lastFailure!.message).toMatch(/api /);
  }, 60_000);
});

/**
 * MESH_INTERFACE → The client's node list — a webrtc-direct addr
 * shaped for the given peer id and a closed port, so the dial reaches
 * the port, nothing answers, and the dial fails as transport (not a
 * wrong-key answer). The certhash is a well-formed multibase but not
 * tied to any real listener — the port is closed, so nothing answers
 * to check the hash either way.
 */
function fakeWebrtcAddr(ip: string, port: number, notisId: string): string {
  const peerId = peerIdFromNotisId(notisId).toString();
  // 32-byte sha2-256 placeholder: `uEiA` = base64url of multihash
  // prefix 0x12 0x20, then 32 zero bytes. The decoder accepts it.
  const certhash = 'uEiAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  return `/ip4/${ip}/udp/${String(port)}/webrtc-direct/certhash/${certhash}/p2p/${peerId}`;
}
