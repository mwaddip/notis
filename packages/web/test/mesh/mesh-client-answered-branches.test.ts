// MESH_INTERFACE → Discovery → "An answered branch growing asks
// nothing more" — once the reader has answered, a competing proof
// whose highest shared header with an answered proof is that
// answered proof's tip is the same branch: no question is raised,
// and the answered proof is replaced by the competing one. A
// gossiped block runs no check while a question stands.
//
// The harness starts a client with API-only entries, a fake
// `httpFetch` that answers `/blocks/current` per base, and a fake
// `resolve` that answers whole `TipResult`s with real proofs. Phase
// 3's fill is refused (any `/blocks/:h` answers 404), so an `above`
// tip falls to phase 4.

import { afterEach, describe, expect, it } from 'vitest';
import { encodeOrderingBlock, generateKeyPair, profileFor } from '@dagsocial/types';
import type { BlockHeader, NetworkProfile, NetworkType, OrderingBlock, UtxoTxTree } from '@dagsocial/types';
import {
  encodeNipopowProof,
  verifyProof,
  proveWithReader,
} from '@dagsocial/nipopow';
import type { NipopowProof, VerifyResult } from '@dagsocial/nipopow';
import { DEFAULT_M, DEFAULT_K, verifierProfile } from '@dagsocial/nipopow-client';
import type { NodeTipResult, TipResult, resolveTip } from '@dagsocial/nipopow-client';
import { blockHash } from '@dagsocial/validation';
import { gossipTopics, nodeKeyFromKeyPair } from '@dagsocial/net/browser';
import type { HttpFetch } from '@dagsocial/node-reads';

import {
  buildMinedChain,
  makeReader,
} from '../../../nipopow/test/helpers.js';
import { buildMinedBranch } from './helpers/mined-branch.js';
import { startMeshClient } from '../../src/mesh/mesh-client.js';
import type { MeshClient } from '../../src/mesh/mesh-client.js';
import { forkKey } from '../../src/mesh/memory.js';

const PROFILE: NetworkProfile = profileFor('devnet' as NetworkType);
const M = DEFAULT_M;
const K = DEFAULT_K;
const MK = M + K;
const NOW = 100_000_000;

type ResolveFn = typeof resolveTip;

function proofOf(count: number, stampIntervalMs?: number): NipopowProof {
  const opts: { count: number; stampIntervalMs?: number } = { count };
  if (stampIntervalMs !== undefined) opts.stampIntervalMs = stampIntervalMs;
  return proveWithReader(makeReader(buildMinedChain(opts)), { m: M, k: K });
}

function tipOf(count: number, stampIntervalMs?: number): { height: number; hash: string } {
  const opts: { count: number; stampIntervalMs?: number } = { count };
  if (stampIntervalMs !== undefined) opts.stampIntervalMs = stampIntervalMs;
  const chain = buildMinedChain(opts);
  const tip = chain.headers[chain.headers.length - 1]!;
  const hash = blockHash(tip);
  if (hash === null) throw new Error('unhashable tip');
  return { height: tip.height, hash };
}

function makeHttpFetch(tips: Map<string, { height: number; hash: string }>): HttpFetch {
  return async (url: string, _init?: RequestInit) => {
    for (const [base, tip] of tips) {
      if (url === `${base}/blocks/current`) {
        return new Response(JSON.stringify(tip), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.startsWith(`${base}/blocks/`)) {
        return new Response(JSON.stringify({ error: 'not found' }), {
          status: 404,
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
  readonly tips: Map<string, { height: number; hash: string }>;
  readonly proofs: Map<string, NipopowProof>;
}

function harness(): Harness {
  const tips = new Map<string, { height: number; hash: string }>();
  const proofs = new Map<string, NipopowProof>();
  return {
    tips,
    proofs,
    httpFetch: makeHttpFetch(tips),
    resolve: makeResolve(proofs),
  };
}

describe('mesh-client — an answered branch growing asks nothing more', () => {
  const clients: MeshClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) { try { await c.stop(); } catch { /* already stopped */ } }
  });

  it('after continue on heavier, the branch growing asks nothing and the answered proof follows it', async () => {
    // Kept = y's chain; another node o serves a heavier chain on a
    // sibling branch at MK + 30, then grows to MK + 40 on the same
    // branch. The reader answers *continue* on the first raise; the
    // second check's o-grown proof is the same branch as the answered
    // proof (`compareProofs(oGrown, oFirst).lca = oFirst.tip`), so no
    // question is raised and the answered proof advances.
    const keptProof = proofOf(MK);
    const baseChain = buildMinedChain({ count: MK, stampIntervalMs: 60_001 });
    const oFirstChain = buildMinedChain({ count: MK + 30, stampIntervalMs: 60_001 });
    const oGrownChain = buildMinedChain({ count: MK + 40, stampIntervalMs: 60_001 });
    const oFirst = proveWithReader(makeReader(oFirstChain), { m: M, k: K });
    const oGrown = proveWithReader(makeReader(oGrownChain), { m: M, k: K });
    const yId = keyPair().notisId;
    const oId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    const oBase = 'http://127.0.0.1:2';
    h.tips.set(yBase, tipOf(MK));
    h.tips.set(oBase, tipOf(MK + 30, 60_001));
    h.proofs.set(yBase, keptProof);
    h.proofs.set(oBase, oFirst);

    const client = await startMeshClient({
      firstContact: [
        { notisId: yId, addrs: [], api: yBase },
        { notisId: oId, addrs: [], api: oBase },
      ],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      memory: { proof: encodeNipopowProof(keptProof), answered: [] },
      wallClock: () => NOW,
      httpFetch: h.httpFetch,
      resolve: h.resolve,
    });
    clients.push(client);
    client.addByHand(yId, [], true);

    await client.check();
    expect(client.state().disagreement).not.toBeNull();

    client.answer('continue');
    expect(client.state().disagreement).toBeNull();

    // The snapshot now holds one answered branch — oFirst's bytes.
    const snapAfterAnswer = client.toRemember();
    expect(snapAfterAnswer.answered.length).toBe(1);
    expect(Array.from(snapAfterAnswer.answered[0]!)).toEqual(Array.from(encodeNipopowProof(oFirst)));

    // Advance o's chain to the grown proof. Next check finds o still
    // heavier than y, but its proof extends the answered one.
    h.proofs.set(oBase, oGrown);
    h.tips.set(oBase, tipOf(MK + 40, 60_001));

    // Avoid fake chain reference silencing the `baseChain` import.
    expect(baseChain.headers.length).toBe(MK);

    await client.check();
    expect(client.state().disagreement).toBeNull();
    // The answered proof follows the branch: the stored bytes match oGrown.
    const snapAfterAdvance = client.toRemember();
    expect(snapAfterAdvance.answered.length).toBe(1);
    expect(Array.from(snapAfterAdvance.answered[0]!)).toEqual(Array.from(encodeNipopowProof(oGrown)));
  }, 180_000);

  it('a competing chain that does not reach the answered tip asks again', async () => {
    // Kept = y = base chain. First check: o1, a branch forked at
    // height 4, heavier than y — raise heavier, reader continues.
    // Answered now holds o1's proof. Second check: o2, a different
    // branch forked at height 9 (shares blocks 1..9 with y and
    // diverges at 10) — o2 is not a prefix nor an extension of o1,
    // so `compareProofs(o2, o1)` finds an lca below o1.tip. The
    // suppression does not apply and a new heavier disagreement is
    // raised.
    const baseChain = buildMinedChain({ count: MK });
    const o1Chain = buildMinedBranch({ base: baseChain, fromHeight: 4, count: MK + 30 });
    const o2Chain = buildMinedBranch({ base: baseChain, fromHeight: 9, count: MK + 30 });
    const keptProof = proveWithReader(makeReader(baseChain), { m: M, k: K });
    const o1Proof = proveWithReader(makeReader(o1Chain), { m: M, k: K });
    const o2Proof = proveWithReader(makeReader(o2Chain), { m: M, k: K });
    const o1Tip = o1Chain.headers[o1Chain.headers.length - 1]!;
    const o2Tip = o2Chain.headers[o2Chain.headers.length - 1]!;
    const yTip = baseChain.headers[baseChain.headers.length - 1]!;

    const yId = keyPair().notisId;
    const oId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    const oBase = 'http://127.0.0.1:2';
    h.tips.set(yBase, { height: yTip.height, hash: blockHash(yTip)! });
    h.tips.set(oBase, { height: o1Tip.height, hash: blockHash(o1Tip)! });
    h.proofs.set(yBase, keptProof);
    h.proofs.set(oBase, o1Proof);

    const client = await startMeshClient({
      firstContact: [
        { notisId: yId, addrs: [], api: yBase },
        { notisId: oId, addrs: [], api: oBase },
      ],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      memory: { proof: encodeNipopowProof(keptProof), answered: [] },
      wallClock: () => NOW,
      httpFetch: h.httpFetch,
      resolve: h.resolve,
    });
    clients.push(client);
    client.addByHand(yId, [], true);

    await client.check();
    expect(client.state().disagreement).not.toBeNull();
    client.answer('continue');

    // Switch o to o2 — a different branch rooted at a different
    // height. Its tip is not held by o1's chain, so o1 is not a
    // prefix of o2; and o2 forks away from y earlier than o1 does,
    // so o2 is not an extension of o1 either.
    h.proofs.set(oBase, o2Proof);
    h.tips.set(oBase, { height: o2Tip.height, hash: blockHash(o2Tip)! });

    await client.check();
    const s = client.state();
    expect(s.disagreement).not.toBeNull();
    expect(s.disagreement!.which).toBe('heavier');
  }, 180_000);

  it('while a question stands a gossiped block runs no check', async () => {
    // Set up a heavier disagreement, gossip a block whose parent is
    // the kept tip (would otherwise extend and no check), then gossip
    // a block with an unknown parent (would otherwise trigger an
    // immediate check). The check counter stays the same.
    const keptProof = proofOf(MK);
    const oProof = proofOf(MK + 30, 60_001);
    const yId = keyPair().notisId;
    const oId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    const oBase = 'http://127.0.0.1:2';
    h.tips.set(yBase, tipOf(MK));
    h.tips.set(oBase, tipOf(MK + 30, 60_001));
    h.proofs.set(yBase, keptProof);
    h.proofs.set(oBase, oProof);

    const client = await startMeshClient({
      firstContact: [
        { notisId: yId, addrs: [], api: yBase },
        { notisId: oId, addrs: [], api: oBase },
      ],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      memory: { proof: encodeNipopowProof(keptProof), answered: [] },
      wallClock: () => NOW,
      httpFetch: h.httpFetch,
      resolve: h.resolve,
    });
    clients.push(client);
    client.addByHand(yId, [], true);

    await client.check();
    // `addByHand` and `start()` each queued a 0-ms trigger that may
    // fire after the first check completes — drain them so the
    // baseline counter is stable before the gossip event.
    for (let i = 0; i < 4; i++) await new Promise<void>((r) => setTimeout(r, 25));
    expect(client.state().disagreement).not.toBeNull();
    const checksBefore = client.state().checks;

    // Mine a block with an unknown parent and gossip it — under the
    // old rule this ran a check at once. Under the new rule nothing
    // is checked while the question stands.
    const extendedChain = buildMinedChain({ count: 150 });
    const unknownParentHeader = extendedChain.headers[149]!;
    const emptyTree: UtxoTxTree = { utxoTxIds: [], utxoTxs: [] };
    const gapBlock: OrderingBlock = {
      header: unknownParentHeader,
      utxoTxTree: emptyTree,
      validatorSignature: new Uint8Array(64),
    };
    interface PubsubStub {
      reportMessageValidationResult: (a: string, b: string, c: number) => void;
      dispatchEvent: (ev: Event) => void;
    }
    const pubsub = (client.libp2p as unknown as { services: { pubsub: PubsubStub } }).services.pubsub;
    pubsub.reportMessageValidationResult = () => { /* stub */ };
    pubsub.dispatchEvent(new CustomEvent('gossipsub:message', {
      detail: {
        msg: {
          topic: gossipTopics(PROFILE.magic).orderingBlock,
          data: encodeOrderingBlock(gapBlock),
        },
        msgId: 'gap-msg-id',
        propagationSource: { toString: () => 'fake-peer' },
      },
    }));

    // Poll for a `checks` increment — under a gossip-triggered check
    // the counter would grow within one microtask cycle plus the
    // scheduler's 0-ms timer. 500 ms is a wide bound for the check
    // to land where it would. No increment means no check ran.
    const until = Date.now() + 500;
    while (Date.now() < until) {
      if (client.state().checks !== checksBefore) break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    expect(client.state().checks).toBe(checksBefore);
  }, 180_000);

  it('a competing proof equal to the answered proof (same tip) is the same branch', async () => {
    // Record o as an answered branch, then on the next check o still
    // serves the same bytes. `compareProofs(o, o)` ties with `lca =
    // o.tip`, which matches the answered proof's tip — no question
    // is raised. The forkKey helper is exercised to compare the two
    // keys under the proofs for the weakest claim's record.
    const keptProof = proofOf(MK);
    const oProof = proofOf(MK + 30, 60_001);
    const yId = keyPair().notisId;
    const oId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    const oBase = 'http://127.0.0.1:2';
    h.tips.set(yBase, tipOf(MK));
    h.tips.set(oBase, tipOf(MK + 30, 60_001));
    h.proofs.set(yBase, keptProof);
    h.proofs.set(oBase, oProof);

    const client = await startMeshClient({
      firstContact: [
        { notisId: yId, addrs: [], api: yBase },
        { notisId: oId, addrs: [], api: oBase },
      ],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      memory: { proof: encodeNipopowProof(keptProof), answered: [] },
      wallClock: () => NOW,
      httpFetch: h.httpFetch,
      resolve: h.resolve,
    });
    clients.push(client);
    client.addByHand(yId, [], true);

    await client.check();
    client.answer('continue');

    // `forkKey(y, o)` was the raise's fork; `forkKey(o, o)` is o's
    // tip itself — the two differ, which the old suppression path
    // keyed off and so would have asked again.
    const forkFromRaise = forkKey(keptProof, oProof, PROFILE, NOW);
    const forkOfSelf = forkKey(oProof, oProof, PROFILE, NOW);
    expect(forkFromRaise).not.toBe(forkOfSelf);

    await client.check();
    expect(client.state().disagreement).toBeNull();
  }, 180_000);
});
