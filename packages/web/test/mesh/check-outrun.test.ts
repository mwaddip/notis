// MESH_INTERFACE → The client's node list → "A tip the check has outrun is
// read again" — a node answers a proof read, and a fill's header reads,
// from its chain as it stands at that read, which may run past the tip it
// named earlier in the same check. Where a check moves the client's tip —
// a proof settling the chain, or a fill linking — each node whose tip read
// then places below the client's tip is read again, `GET /blocks/current`,
// once in that check, after its proofs and fills. The first read's time
// stays the node's speed. A re-read that fails is a failure as any read's
// is. A re-read that names a tip no placement holds leaves the node as its
// first read placed it. A check that does not move the tip reads no tip
// twice.
//
// The harness starts a client with API-only entries, a per-base
// `TipSchedule` whose first entry is the first `/blocks/current` answer
// and whose later entries are the following answers, a per-base chain the
// fill header reads draw from, and a fake `resolve` that answers whole
// `TipResult`s with real proofs.

import { afterEach, describe, expect, it } from 'vitest';
import { bytesToHex, generateKeyPair, profileFor } from '@dagsocial/types';
import type { BlockHeader, NetworkProfile, NetworkType } from '@dagsocial/types';
import {
  encodeNipopowProof,
  verifyProof,
  proveWithReader,
} from '@dagsocial/nipopow';
import type { NipopowProof, VerifyResult } from '@dagsocial/nipopow';
import { DEFAULT_M, DEFAULT_K, verifierProfile } from '@dagsocial/nipopow-client';
import type { NodeTipResult, TipResult, resolveTip } from '@dagsocial/nipopow-client';
import { blockHash } from '@dagsocial/validation';
import { nodeKeyFromKeyPair } from '@dagsocial/net/browser';
import type { HttpFetch } from '@dagsocial/node-reads';

import {
  buildMinedChain,
  makeReader,
} from '../../../nipopow/test/helpers.js';
import type { MinedChain } from '../../../nipopow/test/helpers.js';
import { startMeshClient } from '../../src/mesh/mesh-client.js';
import type { MeshClient } from '../../src/mesh/mesh-client.js';

const PROFILE: NetworkProfile = profileFor('devnet' as NetworkType);
const M = DEFAULT_M;
const K = DEFAULT_K;
const MK = M + K;
const NOW = 100_000_000;

type ResolveFn = typeof resolveTip;

function chainOf(count: number): MinedChain {
  return buildMinedChain({ count });
}

function tipOfHeader(h: BlockHeader): { height: number; hash: string } {
  const hash = blockHash(h);
  if (hash === null) throw new Error('unhashable header');
  return { height: h.height, hash };
}

function tipAt(chain: MinedChain, height: number): { height: number; hash: string } {
  const h = chain.headers[height - 1];
  if (h === undefined) throw new Error(`no header at height ${height}`);
  return tipOfHeader(h);
}

/** Header JSON shape `/blocks/:height` answers with. */
function headerToJson(h: BlockHeader): Record<string, unknown> {
  return {
    protocolVersion: h.protocolVersion,
    height: h.height,
    prevBlockHash: h.prevBlockHash,
    utxoTxRoot: h.utxoTxRoot,
    stateRoot: h.stateRoot,
    validatorId: bytesToHex(h.validatorId),
    powNonce: h.powNonce,
    powTargetBits: h.powTargetBits,
    createdAt: h.createdAt,
    interlinkRoot: h.interlinkRoot,
    adProofsRoot: h.adProofsRoot,
  };
}

/** A per-base schedule: the first entry is the first `/blocks/current`
 * answer, the second entry the second, and so on. A base with one entry
 * answers that entry for every call. A base in `transportFailAt` throws
 * on the call at that index (1-based). */
interface Schedule {
  tips: ({ height: number; hash: string } | null)[];
  /** The chain whose headers answer `/blocks/:height`; unset = answer 404. */
  chain: MinedChain | null;
  /** 1-based call indices on which `/blocks/current` throws a transport
   * failure. */
  transportFailAt: Set<number>;
  /** An artificial delay in ms before answering `/blocks/current` on the
   * call at that index. */
  delayAt: Map<number, number>;
}

function newSchedule(): Schedule {
  return { tips: [], chain: null, transportFailAt: new Set(), delayAt: new Map() };
}

interface Counts {
  current: number[];  // 1-based indices observed per base, or the ascending call count
  headers: number[];  // same for /blocks/:h
}

function makeHttpFetch(
  bases: Map<string, Schedule>,
  counts: Map<string, Counts>,
): HttpFetch {
  return async (url: string, _init?: RequestInit) => {
    for (const [base, schedule] of bases) {
      const c = counts.get(base) ?? { current: [], headers: [] };
      counts.set(base, c);
      if (url === `${base}/blocks/current`) {
        c.current.push(c.current.length + 1);
        const idx = c.current.length;
        if (schedule.transportFailAt.has(idx)) {
          throw new Error(`transport failure at /blocks/current call ${idx}`);
        }
        const tip = schedule.tips[Math.min(idx - 1, schedule.tips.length - 1)] ?? null;
        if (tip === null) {
          return new Response(JSON.stringify({ error: 'no tip' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          });
        }
        const body = JSON.stringify(tip);
        const delay = schedule.delayAt.get(idx);
        if (delay !== undefined && delay > 0) {
          await new Promise((r) => setTimeout(r, delay));
        }
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.startsWith(`${base}/blocks/`)) {
        c.headers.push(c.headers.length + 1);
        const heightStr = url.slice(`${base}/blocks/`.length);
        const height = Number.parseInt(heightStr, 10);
        if (!Number.isInteger(height) || height < 1 || schedule.chain === null) {
          return new Response(JSON.stringify({ error: 'not found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        const h = schedule.chain.headers[height - 1];
        if (h === undefined) {
          return new Response(JSON.stringify({ error: 'not found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ header: headerToJson(h) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response('nowhere', { status: 404 });
  };
}

function makeResolve(proofPerUrl: Map<string, NipopowProof>): ResolveFn {
  return async (nodeUrls, m, k, profile, now) => {
    const nodes: NodeTipResult[] = [];
    for (const url of nodeUrls) {
      const proof = proofPerUrl.get(url);
      if (proof === undefined) {
        nodes.push({
          url,
          verified: false,
          proof: null,
          verifyResult: null,
          refuseReason: 'unreachable',
          refuseCode: 'unreachable',
          behind: null,
          genesisHash: null,
        });
        continue;
      }
      const vr = verifyProof(proof, { m, k }, verifierProfile(profile, now()));
      const b1Hash = vr.ok ? blockHash(vr.headers[0]!) : blockHash(proof.suffixHead.header);
      nodes.push({
        url,
        verified: vr.ok,
        proof,
        verifyResult: vr,
        refuseReason: vr.ok ? null : `verify failed: ${vr.reason}`,
        refuseCode: vr.ok ? null : 'invalid',
        behind: null,
        genesisHash: b1Hash,
      });
    }
    let winner: NodeTipResult | null = null;
    let winnerIndex = -1;
    let winnerSuffix: BlockHeader[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      if (!n.verified || n.verifyResult === null || !n.verifyResult.ok) continue;
      const vr = n.verifyResult;
      const suffix = [vr.suffixHead.header, ...n.proof!.suffixTail];
      if (winner === null) {
        winner = n;
        winnerIndex = i;
        winnerSuffix = suffix;
        continue;
      }
      const wTip = winnerSuffix[winnerSuffix.length - 1]!;
      if (vr.tip.height > wTip.height) {
        winner = n;
        winnerIndex = i;
        winnerSuffix = suffix;
      }
    }
    if (winner !== null) {
      for (const n of nodes) {
        if (!n.verified || n.verifyResult === null || !n.verifyResult.ok) continue;
        const nHash = blockHash(n.verifyResult.tip);
        let behind: number | null = null;
        if (nHash !== null) {
          for (let i = 0; i < winnerSuffix.length; i++) {
            const h = winnerSuffix[i]!;
            if (h.height !== n.verifyResult.tip.height) continue;
            if (blockHash(h) === nHash) {
              behind = winnerSuffix.length - 1 - i;
              break;
            }
          }
        }
        n.behind = behind;
      }
    }
    const winnerVr = winner !== null ? (winner.verifyResult as VerifyResult & { ok: true }) : null;
    const out: TipResult = {
      winner,
      winnerIndex,
      nodes,
      tip: winnerVr !== null ? winnerVr.tip : null,
      suffixHead: winnerVr !== null ? winnerVr.suffixHead : null,
      splits: [],
    };
    return out;
  };
}

function keyPair(): { notisId: string } {
  return { notisId: nodeKeyFromKeyPair(generateKeyPair()).notisId };
}

interface Harness {
  readonly httpFetch: HttpFetch;
  readonly resolve: ResolveFn;
  readonly bases: Map<string, Schedule>;
  readonly proofs: Map<string, NipopowProof>;
  readonly counts: Map<string, Counts>;
}

function harness(): Harness {
  const bases = new Map<string, Schedule>();
  const proofs = new Map<string, NipopowProof>();
  const counts = new Map<string, Counts>();
  return {
    bases,
    proofs,
    counts,
    httpFetch: makeHttpFetch(bases, counts),
    resolve: makeResolve(proofs),
  };
}

describe('mesh-client — a tip the check has outrun is read again', () => {
  const clients: MeshClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) { try { await c.stop(); } catch { /* already stopped */ } }
  });

  // Without the re-read, A's placement after settle is `below` gap 2:
  //   AssertionError: expected 'behind' to be 'ok'
  it.fails('a first check whose proof runs two blocks past the tips read places both nodes at the tip', async () => {
    // Two nodes, both naming tip MK at their first `/blocks/current`;
    // the resolve answers a proof of MK + 2 for each (their chains ran
    // on between the tip read and the proof read). The chain settles
    // to MK + 2, phase 3b places both tips at `below` gap 2. The
    // re-read fires for each, and each answers MK + 2 → both place at
    // the tip.
    const h = harness();
    const aId = keyPair().notisId;
    const bId = keyPair().notisId;
    const aBase = 'http://127.0.0.1:1';
    const bBase = 'http://127.0.0.1:2';
    const chain = chainOf(MK + 2);
    const tipAtMK = tipAt(chain, MK);
    const tipAtMKPlus2 = tipAt(chain, MK + 2);
    const proof = proveWithReader(makeReader(chain), { m: M, k: K });

    const sA = newSchedule(); sA.tips = [tipAtMK, tipAtMKPlus2]; sA.chain = chain;
    const sB = newSchedule(); sB.tips = [tipAtMK, tipAtMKPlus2]; sB.chain = chain;
    h.bases.set(aBase, sA);
    h.bases.set(bBase, sB);
    h.proofs.set(aBase, proof);
    h.proofs.set(bBase, proof);

    const client = await startMeshClient({
      firstContact: [
        { notisId: aId, addrs: [], api: aBase },
        { notisId: bId, addrs: [], api: bBase },
      ],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      wallClock: () => NOW,
      httpFetch: h.httpFetch,
      resolve: h.resolve,
    });
    clients.push(client);

    await client.check();
    const s = client.state();
    const eA = s.nodes.find((n) => n.notisId === aId)!;
    const eB = s.nodes.find((n) => n.notisId === bId)!;
    expect(eA.status).toBe('ok');
    expect(eB.status).toBe('ok');
    expect(eA.behindBy).toBe(0);
    expect(eB.behindBy).toBe(0);
    expect(s.tip?.height).toBe(MK + 2);
    const picked = client.base('tip');
    expect(picked === aBase || picked === bBase).toBe(true);
  }, 90_000);

  // Without the re-read, A stays `below` even though its chain has moved
  // past:
  //   AssertionError: expected 'behind' to be 'ok'
  it.fails('a node still two below at its re-read stays behind', async () => {
    // A sees MK + 2 at its re-read; B still names MK. B lands `behind`
    // with `behindBy` 2.
    const h = harness();
    const aId = keyPair().notisId;
    const bId = keyPair().notisId;
    const aBase = 'http://127.0.0.1:1';
    const bBase = 'http://127.0.0.1:2';
    const chain = chainOf(MK + 2);
    const tipAtMK = tipAt(chain, MK);
    const tipAtMKPlus2 = tipAt(chain, MK + 2);
    const proof = proveWithReader(makeReader(chain), { m: M, k: K });

    const sA = newSchedule(); sA.tips = [tipAtMK, tipAtMKPlus2]; sA.chain = chain;
    const sB = newSchedule(); sB.tips = [tipAtMK, tipAtMK]; sB.chain = chain;
    h.bases.set(aBase, sA);
    h.bases.set(bBase, sB);
    h.proofs.set(aBase, proof);
    h.proofs.set(bBase, proof);

    const client = await startMeshClient({
      firstContact: [
        { notisId: aId, addrs: [], api: aBase },
        { notisId: bId, addrs: [], api: bBase },
      ],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      wallClock: () => NOW,
      httpFetch: h.httpFetch,
      resolve: h.resolve,
    });
    clients.push(client);

    await client.check();
    const s = client.state();
    const eA = s.nodes.find((n) => n.notisId === aId)!;
    const eB = s.nodes.find((n) => n.notisId === bId)!;
    expect(eA.status).toBe('ok');
    expect(eA.behindBy).toBe(0);
    expect(eB.status).toBe('behind');
    expect(eB.behindBy).toBe(2);
  }, 90_000);

  // Without the re-read, A stays `trailing` after the fill moves the tip
  // past A's first read:
  //   AssertionError: expected 'trailing' to be 'ok'
  it.fails('a fill that moves the tip re-reads the node read at the old tip', async () => {
    // Memory seats the chain at MK. Node A names MK; node B names
    // MK + 1 and serves the header at MK + 1. Phase 3a fills to
    // MK + 1 — the tip moves by a fill, with no proof read of its
    // own. A is `one-below` after phase 3b; the re-read for A
    // answers MK + 1 and places A at the tip.
    const h = harness();
    const aId = keyPair().notisId;
    const bId = keyPair().notisId;
    const aBase = 'http://127.0.0.1:1';
    const bBase = 'http://127.0.0.1:2';
    const chain = chainOf(MK + 1);
    const keptProof = proveWithReader(makeReader(buildMinedChain({ count: MK })), { m: M, k: K });
    const tipAtMK = tipAt(chain, MK);
    const tipAtMKPlus1 = tipAt(chain, MK + 1);

    const sA = newSchedule(); sA.tips = [tipAtMK, tipAtMKPlus1]; sA.chain = chain;
    const sB = newSchedule(); sB.tips = [tipAtMKPlus1]; sB.chain = chain;
    h.bases.set(aBase, sA);
    h.bases.set(bBase, sB);

    const client = await startMeshClient({
      firstContact: [
        { notisId: aId, addrs: [], api: aBase },
        { notisId: bId, addrs: [], api: bBase },
      ],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      memory: { proof: encodeNipopowProof(keptProof), answeredForks: [] },
      wallClock: () => NOW,
      httpFetch: h.httpFetch,
      resolve: h.resolve,
    });
    clients.push(client);

    await client.check();
    const s = client.state();
    expect(s.tip?.height).toBe(MK + 1);
    const eA = s.nodes.find((n) => n.notisId === aId)!;
    const eB = s.nodes.find((n) => n.notisId === bId)!;
    expect(eA.status).toBe('ok');
    expect(eA.behindBy).toBe(0);
    expect(eB.status).toBe('ok');
    expect(eB.behindBy).toBe(0);
  }, 90_000);

  it('a check that does not move the tip reads each tip once', async () => {
    // Memory seats the chain at MK. Two nodes name MK. Phase 3a has
    // no `above` candidates, phase 3b places both at `tip`, phase 4
    // reads no proof. The chain tip does not move, so no re-read
    // fires: the two phase-2 tip reads plus one routed-read tip at
    // end of `runCheck` is three `/blocks/current` requests across
    // the two bases, and whichever base the routed read did not pick
    // sees exactly one request.
    const h = harness();
    const aId = keyPair().notisId;
    const bId = keyPair().notisId;
    const aBase = 'http://127.0.0.1:1';
    const bBase = 'http://127.0.0.1:2';
    const chain = chainOf(MK);
    const keptProof = proveWithReader(makeReader(chain), { m: M, k: K });
    const tipAtMK = tipAt(chain, MK);

    const sA = newSchedule(); sA.tips = [tipAtMK]; sA.chain = chain;
    const sB = newSchedule(); sB.tips = [tipAtMK]; sB.chain = chain;
    h.bases.set(aBase, sA);
    h.bases.set(bBase, sB);

    const client = await startMeshClient({
      firstContact: [
        { notisId: aId, addrs: [], api: aBase },
        { notisId: bId, addrs: [], api: bBase },
      ],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      memory: { proof: encodeNipopowProof(keptProof), answeredForks: [] },
      wallClock: () => NOW,
      httpFetch: h.httpFetch,
      resolve: h.resolve,
    });
    clients.push(client);

    await client.check();
    const cA = h.counts.get(aBase)!.current.length;
    const cB = h.counts.get(bBase)!.current.length;
    expect(cA + cB).toBe(3);
    expect(Math.min(cA, cB)).toBe(1);
  }, 90_000);

  // Without the re-read A is never read a second time:
  //   AssertionError: expected 1 to be 2
  it.fails('a re-read is made once per node per check', async () => {
    // One node names MK at the first `/blocks/current`; the resolve
    // answers a proof of MK + 2. The chain settles to MK + 2; the
    // node is placed `below` gap 2 and re-reads to MK + 5 (above
    // the new tip) — its fill links, extending the chain to MK + 5.
    // No third `/blocks/current` is sent to that node.
    const h = harness();
    const aId = keyPair().notisId;
    const aBase = 'http://127.0.0.1:1';
    const chain = chainOf(MK + 5);
    const proof = proveWithReader(makeReader(buildMinedChain({ count: MK + 2 })), { m: M, k: K });
    const tipAtMK = tipAt(chain, MK);
    const tipAtMKPlus5 = tipAt(chain, MK + 5);

    const sA = newSchedule(); sA.tips = [tipAtMK, tipAtMKPlus5]; sA.chain = chain;
    h.bases.set(aBase, sA);
    h.proofs.set(aBase, proof);

    const client = await startMeshClient({
      firstContact: [{ notisId: aId, addrs: [], api: aBase }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      wallClock: () => NOW,
      httpFetch: h.httpFetch,
      resolve: h.resolve,
    });
    clients.push(client);

    await client.check();
    expect(h.counts.get(aBase)!.current.length).toBe(2);
    const s = client.state();
    expect(s.tip?.height).toBe(MK + 5);
    const eA = s.nodes.find((n) => n.notisId === aId)!;
    expect(eA.status).toBe('ok');
    expect(eA.behindBy).toBe(0);
  }, 90_000);

  // Without the re-read B stays `behind` rather than moving to `retry`:
  //   AssertionError: expected 'behind' to be 'ok'   (and B stays `behind`)
  it.fails('a failed re-read is a failure', async () => {
    // Two nodes name MK at the first `/blocks/current`; the resolve
    // answers a proof of MK + 2 for each. The chain settles to MK + 2
    // and both tips place `below` gap 2. The re-read of B throws a
    // transport failure; B's event is a failure (`retry`), while A's
    // re-read succeeds and places A at the tip.
    const h = harness();
    const aId = keyPair().notisId;
    const bId = keyPair().notisId;
    const aBase = 'http://127.0.0.1:1';
    const bBase = 'http://127.0.0.1:2';
    const chain = chainOf(MK + 2);
    const tipAtMK = tipAt(chain, MK);
    const tipAtMKPlus2 = tipAt(chain, MK + 2);
    const proof = proveWithReader(makeReader(chain), { m: M, k: K });

    const sA = newSchedule(); sA.tips = [tipAtMK, tipAtMKPlus2]; sA.chain = chain;
    const sB = newSchedule(); sB.tips = [tipAtMK]; sB.chain = chain;
    sB.transportFailAt.add(2);
    h.bases.set(aBase, sA);
    h.bases.set(bBase, sB);
    h.proofs.set(aBase, proof);
    h.proofs.set(bBase, proof);

    const client = await startMeshClient({
      firstContact: [
        { notisId: aId, addrs: [], api: aBase },
        { notisId: bId, addrs: [], api: bBase },
      ],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      wallClock: () => NOW,
      httpFetch: h.httpFetch,
      resolve: h.resolve,
    });
    clients.push(client);

    await client.check();
    const s = client.state();
    const eA = s.nodes.find((n) => n.notisId === aId)!;
    const eB = s.nodes.find((n) => n.notisId === bId)!;
    expect(eA.status).toBe('ok');
    expect(eB.status).toBe('retry');
  }, 90_000);

  // Without the re-read A stays `behind` rather than moving to `ok`:
  //   AssertionError: expected 'behind' to be 'ok'
  it.fails("a re-read naming a tip no placement holds keeps the first read's placement", async () => {
    // Two nodes name MK; the resolve answers proofs of MK + 2. The
    // chain settles to MK + 2 and both tips place `below` gap 2. A's
    // re-read answers MK + 2 — A places at the tip. B's re-read
    // answers (MK + 2, a fabricated hash that is not the chain's) —
    // the placement is `unplaced`, and B keeps its first read's
    // placement (`below`, `behindBy` 2) with no further proof read.
    const h = harness();
    const aId = keyPair().notisId;
    const bId = keyPair().notisId;
    const aBase = 'http://127.0.0.1:1';
    const bBase = 'http://127.0.0.1:2';
    const chain = chainOf(MK + 2);
    const tipAtMK = tipAt(chain, MK);
    const tipAtMKPlus2 = tipAt(chain, MK + 2);
    const proof = proveWithReader(makeReader(chain), { m: M, k: K });

    const fabricatedHash = 'ff'.repeat(32);
    const sA = newSchedule(); sA.tips = [tipAtMK, tipAtMKPlus2]; sA.chain = chain;
    const sB = newSchedule();
    sB.tips = [tipAtMK, { height: MK + 2, hash: fabricatedHash }];
    sB.chain = chain;
    h.bases.set(aBase, sA);
    h.bases.set(bBase, sB);
    h.proofs.set(aBase, proof);
    h.proofs.set(bBase, proof);

    const client = await startMeshClient({
      firstContact: [
        { notisId: aId, addrs: [], api: aBase },
        { notisId: bId, addrs: [], api: bBase },
      ],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      wallClock: () => NOW,
      httpFetch: h.httpFetch,
      resolve: h.resolve,
    });
    clients.push(client);

    const proofsBefore = client.state().proofs?.asked ?? 0;
    await client.check();
    const s = client.state();
    const eA = s.nodes.find((n) => n.notisId === aId)!;
    const eB = s.nodes.find((n) => n.notisId === bId)!;
    expect(eA.status).toBe('ok');
    expect(eA.behindBy).toBe(0);
    expect(eB.status).toBe('behind');
    expect(eB.behindBy).toBe(2);
    // The proofs count after the check reflects the first-pass proof
    // reads only — one per distinct hash (MK), not a second read of
    // the fabricated tip.
    expect(s.proofs!.asked - proofsBefore).toBe(2);
  }, 90_000);

  it("the first read's time stays the node's speed", async () => {
    // A's first `/blocks/current` is fast; its re-read is artificially
    // slow (50 ms). After the check, A's `readMs` reflects the first
    // read, well under the re-read's delay.
    const h = harness();
    const aId = keyPair().notisId;
    const bId = keyPair().notisId;
    const aBase = 'http://127.0.0.1:1';
    const bBase = 'http://127.0.0.1:2';
    const chain = chainOf(MK + 2);
    const tipAtMK = tipAt(chain, MK);
    const tipAtMKPlus2 = tipAt(chain, MK + 2);
    const proof = proveWithReader(makeReader(chain), { m: M, k: K });

    const sA = newSchedule(); sA.tips = [tipAtMK, tipAtMKPlus2]; sA.chain = chain;
    sA.delayAt.set(2, 50);
    const sB = newSchedule(); sB.tips = [tipAtMK, tipAtMKPlus2]; sB.chain = chain;
    h.bases.set(aBase, sA);
    h.bases.set(bBase, sB);
    h.proofs.set(aBase, proof);
    h.proofs.set(bBase, proof);

    const client = await startMeshClient({
      firstContact: [
        { notisId: aId, addrs: [], api: aBase },
        { notisId: bId, addrs: [], api: bBase },
      ],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      wallClock: () => NOW,
      httpFetch: h.httpFetch,
      resolve: h.resolve,
    });
    clients.push(client);

    await client.check();
    const eA = client.state().nodes.find((n) => n.notisId === aId)!;
    expect(eA.readMs).not.toBeNull();
    expect(eA.readMs!).toBeLessThan(40);
  }, 90_000);
});
