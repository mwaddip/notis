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
import { TopicValidatorResult } from '@libp2p/gossipsub';
import type { PeerId } from '@libp2p/interface';
import {
  encodeOrderingBlock,
  generateKeyPair,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  profileFor,
} from '@dagsocial/types';
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
import { gossipTopics, nodeKeyFromKeyPair, peerIdFromNotisId } from '@dagsocial/net/browser';
import type { HttpFetch } from '@dagsocial/node-reads';

import {
  buildMinedChain,
  makeReader,
} from '../../../nipopow/test/helpers.js';
import { buildMinedBranch } from './helpers/mined-branch.js';
import { makeBlockAt } from '../../../net/test/helpers/devnet-block.js';
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

    // Answer the o2 question — two answered branches now stand.
    client.answer('continue');
    expect(client.toRemember().answered.length).toBe(2);

    // Switch back to o1 (its first proof): the first answered entry
    // suppresses on its own, no question is raised.
    h.proofs.set(oBase, o1Proof);
    h.tips.set(oBase, { height: o1Tip.height, hash: blockHash(o1Tip)! });
    await client.check();
    expect(client.state().disagreement).toBeNull();
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

    // A gossiped block whose parent the client does not hold: the
    // client's validator accepts it, the router delivers it, and the
    // handler sees a standing question and runs no check.
    // MESH_INTERFACE → Block gossip → "A block is checked before it
    // is forwarded, and never applied".
    const gapBlock = makeBlockAt(150, 1, {
      prevBlockHash: '00'.repeat(32),
      powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
    });
    interface PubsubStub {
      topicValidators: Map<
        string,
        (peer: PeerId, msg: { topic: string; data: Uint8Array }) => Promise<number> | number
      >;
      reportMessageValidationResult: (a: string, b: string, c: number) => void;
      dispatchEvent: (ev: Event) => void;
    }
    const pubsub = (client.libp2p as unknown as { services: { pubsub: PubsubStub } }).services.pubsub;
    pubsub.reportMessageValidationResult = () => { /* stub */ };
    const topic = gossipTopics(PROFILE.magic).orderingBlock;
    const msg = { topic, data: encodeOrderingBlock(gapBlock) };
    const validator = pubsub.topicValidators.get(topic)!;
    const relayPeer = peerIdFromNotisId(keyPair().notisId);
    const verdict = await validator(relayPeer, msg);
    expect(verdict).toBe(TopicValidatorResult.Accept);
    pubsub.dispatchEvent(new CustomEvent('gossipsub:message', {
      detail: {
        msg,
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

  it('after continue on memory, a heavier question about the same branch is not raised', async () => {
    // The s7 shape: kept = the honest chain, your node on a lighter
    // fork. First check: memory raise (y loses to kept). The reader
    // answers *continue*: the client takes y's chain and the old kept
    // joins the answered branches. The honest chain then grows; a
    // later check sees it heavier than y but on the branch the reader
    // already answered — no question is raised, and the answered
    // proof follows the growing honest chain.
    const keptProof = proofOf(100);              // honest chain at 100
    const yoursProof = proofOf(MK, 60_001);      // lighter fork at MK
    const grownProof = proofOf(105);             // honest chain extended by 5
    const yId = keyPair().notisId;
    const oId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    const oBase = 'http://127.0.0.1:2';
    h.tips.set(yBase, tipOf(MK, 60_001));
    h.proofs.set(yBase, yoursProof);

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
    expect(client.state().disagreement!.which).toBe('memory');

    client.answer('continue');
    expect(client.state().disagreement).toBeNull();
    // The old kept joined the answered list.
    expect(client.toRemember().answered.length).toBe(1);

    // The honest chain grows by 5 blocks. Another node serves it.
    h.tips.set(oBase, tipOf(105));
    h.proofs.set(oBase, grownProof);

    await client.check();
    // No question is raised — grownProof extends the answered proof
    // (A at 100) by 5 < k=20 blocks, so compareProofs finds A100's
    // tip as the shared highest header and the match replaces the
    // answered entry with grownProof.
    expect(client.state().disagreement).toBeNull();

    const snap = client.toRemember();
    expect(snap.answered.length).toBe(1);
    expect(Array.from(snap.answered[0]!)).toEqual(Array.from(encodeNipopowProof(grownProof)));
  }, 180_000);

  it('two proofs of the same two chains that share different highest headers are one answered branch', async () => {
    // Two proofs of chain A at different lengths keep different
    // sparse structures, so their lcas with the same chain-B proof
    // differ — forkKey(keptA, y) and forkKey(y, grownA) name
    // different shared headers for the same pair of chains (A and
    // B). The new same-branch test does not use forkKey equality; it
    // asks whether the competing proof's lca with an answered proof
    // is the answered proof's tip — which does hold here, so the
    // branch is recognised and no question is raised.
    const keptBaseChain = buildMinedChain({ count: 80 });
    const grownBaseChain = buildMinedChain({ count: 95 });
    const forkChain = buildMinedBranch({ base: grownBaseChain, fromHeight: 15, count: MK });

    const keptProof = proveWithReader(makeReader(keptBaseChain), { m: M, k: K });
    const yProof = proveWithReader(makeReader(forkChain), { m: M, k: K });
    const grownProof = proveWithReader(makeReader(grownBaseChain), { m: M, k: K });

    // Pin the pairing: forkKey(kept, y) is the memory raise's fork,
    // forkKey(y, grown) is the heavier raise's. The assertion below
    // runs against the pair (kept, y) and (y, grown); if the values
    // happen to coincide the test still holds the behavioural
    // assertion (no raise), which is the one the mutations break.
    const forkMemory = forkKey(keptProof, yProof, PROFILE, NOW);
    const forkHeavier = forkKey(yProof, grownProof, PROFILE, NOW);
    // This is the bug the stage hit: forkKeys of the memory raise
    // and the heavier raise named different shared headers of the
    // same two chains. The new check does not rely on forkKey.
    expect(forkMemory).not.toBeNull();
    expect(forkHeavier).not.toBeNull();

    const yId = keyPair().notisId;
    const oId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    const oBase = 'http://127.0.0.1:2';
    const yTipHdr = forkChain.headers[forkChain.headers.length - 1]!;
    const grownTipHdr = grownBaseChain.headers[grownBaseChain.headers.length - 1]!;
    h.tips.set(yBase, { height: yTipHdr.height, hash: blockHash(yTipHdr)! });
    h.proofs.set(yBase, yProof);

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
    expect(client.state().disagreement!.which).toBe('memory');
    client.answer('continue');

    // Serve the grown base chain (same chain A, extended by 15 blocks).
    h.tips.set(oBase, { height: grownTipHdr.height, hash: blockHash(grownTipHdr)! });
    h.proofs.set(oBase, grownProof);

    await client.check();
    // No question: grown extends the answered proof by 15 < k=20,
    // so compareProofs finds the answered proof's tip as the lca
    // and the suppression fires.
    expect(client.state().disagreement).toBeNull();
    const snap = client.toRemember();
    expect(snap.answered.length).toBe(1);
    expect(Array.from(snap.answered[0]!)).toEqual(Array.from(encodeNipopowProof(grownProof)));
  }, 180_000);

  it('a page that loads with an answered branch stored asks nothing about it', async () => {
    // Simulates the extension's reload: the stored record carries
    // one answered branch as its competing proof under the side key
    // `notis.mesh.memory.<network>.answered.0`. `startMeshClient`
    // decodes each `memory.answered` entry into `answeredProofs` at
    // construct (`MESH_INTERFACE → What the client remembers`).
    // On the first check the same competing node is reached — the
    // stored answered proof matches it and no question is raised.
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
      // The stored kept proof and the one answered branch — as the
      // extension's seam reads them from `localStorage` at load.
      memory: {
        proof: encodeNipopowProof(keptProof),
        answered: [encodeNipopowProof(oProof)],
      },
      wallClock: () => NOW,
      httpFetch: h.httpFetch,
      resolve: h.resolve,
    });
    clients.push(client);
    client.addByHand(yId, [], true);

    await client.check();
    // The reader already answered the branch in a prior session;
    // no question is raised on the first check of the new session.
    expect(client.state().disagreement).toBeNull();
    const snap = client.toRemember();
    expect(snap.answered.length).toBe(1);
    expect(Array.from(snap.answered[0]!)).toEqual(Array.from(encodeNipopowProof(oProof)));
  }, 180_000);
});
