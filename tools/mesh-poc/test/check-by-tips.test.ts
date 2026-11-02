// MESH_INTERFACE → The client's node list → "A check" — a check reads
// tips, places them on the held chain, and reads proofs only for tips
// the chain cannot place; the agreement counts come off the per-tip
// verdicts; `state.tip` is the chain's.

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from '@dagsocial/types';
import { profileFor } from '@dagsocial/types';
import type { NetworkProfile, NetworkType, OrderingBlock } from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import { nodeKeyFromKeyPair, notisIdFromPeerId } from '../src/identity.js';
import { startMeshNode, type MeshNode } from '../src/node/mesh-node.js';
import { startMeshClient, type MeshClient } from '../src/client/mesh-client.js';
import { chainResolve, chainUpstream, type ChainUpstream } from './helpers/chain-harness.js';
import { makeLinkedChain } from './helpers/devnet-block.js';

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
): Promise<{ node: MeshNode; id: string; webrtcAddr: string }> {
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
    throw new Error(`no WebRTC-direct listen address: ${JSON.stringify(addrs)}`);
  }
  const id = notisIdFromPeerId(n.libp2p.peerId);
  return { node: n, id, webrtcAddr };
}

describe('mesh-client — a check reads tips, places them, and proves the rest', () => {
  const nodes: MeshNode[] = [];
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
      anchors: [
        { notisId: a1.id, addrs: [a1.webrtcAddr] },
        { notisId: a2.id, addrs: [a2.webrtcAddr] },
        { notisId: a3.id, addrs: [a3.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
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
      anchors: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
        { notisId: c.id, addrs: [c.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
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
    // MESH_INTERFACE → The client's node list → "A check" — "above —
    // read down to a held header as a fill is, the client's tip moving
    // when they link". One node advances one block, another three;
    // headers read, the client's tip moves, both `ok`, no proof.
    const base = makeLinkedChain(K + 4, PROFILE);
    const start = base.slice(0, K + 1);     // tip at K+1
    const oneAbove = base.slice(0, K + 2);  // one block above
    const threeAbove = base.slice(0, K + 4); // three blocks above

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
      anchors: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
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
    expect(s.nodes.find((n) => n.notisId === a.id)!.status).toBe('ok');
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
      anchors: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
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
    // MESH_INTERFACE → The client's node list → "A check" — "while the
    // chain is settled, the URL of the first node at the client's tip
    // first" so a tie keeps the chain.
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
      anchors: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
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
      anchors: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet', profile: PROFILE,
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
    // MESH_INTERFACE → The client's node list → "A check" — "A header
    // that does not read is the serving node's `malformed` lie".
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
      anchors: [
        { notisId: hostileNode.id, addrs: [hostileNode.webrtcAddr] },
        { notisId: otherNode.id, addrs: [otherNode.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
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
    // MESH_INTERFACE → The client's node list → "A check" — "it times
    // each node's tip read; that time is the node's speed until the
    // next check". `readMs` is set from `/blocks/current` through the
    // timed fetch, not from the proof read.
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
      anchors: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet', profile: PROFILE,
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
      anchors: [{ notisId: n.id, addrs: [n.webrtcAddr] }],
      network: 'devnet', profile: PROFILE,
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
});
