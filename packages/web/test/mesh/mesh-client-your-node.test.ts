// MESH_INTERFACE → Discovery → "A node added by hand" / "Your node takes
// precedence" / "A disagreement is the reader's question, never the
// client's choice" — the mesh client answers the reader's trust
// assertion: a routed read goes to your node first, a disagreement
// holds the chain and waits on `answer('continue' | 'disable')`, and
// a *continue* records the fork so the same competing branch growing
// does not ask again.
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
  bytesToHex,
  encodeOrderingBlock,
  generateKeyPair,
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
import { signedExtendingBlock } from './helpers/signed-extending-block.js';
import { startMeshClient } from '../../src/mesh/mesh-client.js';
import type { MeshClient } from '../../src/mesh/mesh-client.js';

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

/** Options the your-node tests share. */
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

// Each test's "yours" entry carries an api base through `firstContact`
// and no webrtc-direct address. `client.addByHand(yId, [], true)`
// marks the existing entry `yours = true, byHand = true` without
// adding a webrtc-direct address — so phase 1's pre-dial sees the
// entry's `addrs.length === 0` and does nothing, and node-datachannel
// is never asked for a peer connection. The entry is still reached at
// its api base for the check's tip and proof reads.
describe('mesh-client — your node: disagreement, precedence and the reader\'s answer', () => {
  const clients: MeshClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) { try { await c.stop(); } catch { /* already stopped */ } }
  });

  it("your node's proof loses to the kept one: disagreement memory, the chain does not move", async () => {
    // The kept chain is longer; your node serves a fork from below the
    // kept tip, with different stamps. `judgeByMemory` marks it `lost`,
    // and the disagreement reads `memory`. The client's chain does not
    // move.
    const keptProof = proofOf(100);
    const yoursProof = proofOf(MK, 60_001);
    const yId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    h.tips.set(yBase, tipOf(MK, 60_001));
    h.proofs.set(yBase, yoursProof);

    const client = await startMeshClient({
      firstContact: [{ notisId: yId, addrs: [], api: yBase }],
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
    const s = client.state();
    expect(s.disagreement).not.toBeNull();
    expect(s.disagreement!.which).toBe('memory');
    expect(s.disagreement!.other).toBeNull();
    expect(s.disagreement!.yours.height).toBe(MK);
    // The chain did not move: still at 100 (the kept chain's tip).
    expect(s.tip?.height).toBe(100);
  }, 90_000);

  it("another node's proof off your node's chain beats it and continues memory: disagreement heavier", async () => {
    // Kept = your node = chain of MK (same proof bytes); another node
    // o serves a heavier chain (MK+30, different stamps) off y's.
    // y continues kept (tie), o continues kept too (beats both), and
    // o beats y.
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
    const s = client.state();
    expect(s.disagreement).not.toBeNull();
    expect(s.disagreement!.which).toBe('heavier');
    expect(s.disagreement!.other).not.toBeNull();
    expect(s.disagreement!.other!.height).toBe(MK + 30);
    expect(s.disagreement!.yours.height).toBe(MK);
    // The chain did not switch: still your node's (the kept).
    expect(s.tip?.height).toBe(MK);
  }, 90_000);

  it('your node one block behind on the same chain: no disagreement', async () => {
    // Kept = chain of MK+1. Your node serves the same chain at MK
    // (one block below). Your node's tip lands as `one-below` in
    // phase 3b → `trailing`; phase 4 reads no proof for it, so no
    // disagreement fires.
    const keptProof = proofOf(MK + 1);
    const yId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    const mkChain = buildMinedChain({ count: MK });
    const mkTipHdr = mkChain.headers[mkChain.headers.length - 1]!;
    h.tips.set(yBase, { height: MK, hash: blockHash(mkTipHdr)! });

    const client = await startMeshClient({
      firstContact: [{ notisId: yId, addrs: [], api: yBase }],
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
    const s = client.state();
    expect(s.disagreement).toBeNull();
    expect(s.tip?.height).toBe(MK + 1);
  }, 90_000);

  it('your node unreachable: no disagreement, the ordinary rules choose', async () => {
    // Your node's httpFetch never answers (no tips entry). Another
    // node serves the chain honestly. Your node is unreachable, no
    // disagreement is raised, and the chain seats as usual.
    const otherProof = proofOf(MK + 5);
    const yId = keyPair().notisId;
    const oId = keyPair().notisId;
    const h = harness();
    const oBase = 'http://127.0.0.1:2';
    h.tips.set(oBase, tipOf(MK + 5));
    h.proofs.set(oBase, otherProof);
    // No tips entry for your node's base — unreachable.
    const yBase = 'http://127.0.0.1:99';

    const client = await startMeshClient({
      firstContact: [
        { notisId: yId, addrs: [], api: yBase },
        { notisId: oId, addrs: [], api: oBase },
      ],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      wallClock: () => NOW,
      httpFetch: h.httpFetch,
      resolve: h.resolve,
    });
    clients.push(client);
    client.addByHand(yId, [], true);

    await client.check();
    const s = client.state();
    expect(s.disagreement).toBeNull();
    expect(s.tip?.height).toBe(MK + 5);
  }, 90_000);

  it('your node many blocks behind on the same chain, its proof read: no disagreement', async () => {
    // Kept at MK + 60. Your node serves the same chain at MK — a
    // prefix of the kept, more than K blocks below the window. Phase
    // 3b places y's tip as `under` and phase 3c bails (no node is at
    // the tip this check), so phase 4 reads y's proof. judgeByMemory
    // marks y lost (kept beats). `forkKey(kept, y)` is y's tip (y is
    // a prefix of kept): no disagreement, because `memory` needs the
    // fork strictly below y's tip.
    const keptProof = proofOf(MK + 60);
    const yProof = proofOf(MK);
    const yId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    h.tips.set(yBase, tipOf(MK));
    h.proofs.set(yBase, yProof);

    const client = await startMeshClient({
      firstContact: [{ notisId: yId, addrs: [], api: yBase }],
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
    const s = client.state();
    expect(s.disagreement).toBeNull();
    // The chain stays at the kept's tip.
    expect(s.tip?.height).toBe(MK + 60);
  }, 90_000);

  it("another node extending your node's chain raises nothing", async () => {
    // Kept = y's chain of MK. Another node o serves the same chain
    // extended to MK + 30. Both continue the kept; o beats y under
    // `compareProofs`, but `forkKey(y, o)` is y's tip — o extends y,
    // o's tip is not off y's chain, and heavier needs the fork
    // strictly below y's tip. No disagreement; the settle advances
    // the chain to o's.
    const keptProof = proofOf(MK);
    const oProof = proofOf(MK + 30);
    const yId = keyPair().notisId;
    const oId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    const oBase = 'http://127.0.0.1:2';
    h.tips.set(yBase, tipOf(MK));
    h.tips.set(oBase, tipOf(MK + 30));
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
    const s = client.state();
    expect(s.disagreement).toBeNull();
    // The chain advances to o's tip (o continues the kept and y).
    expect(s.tip?.height).toBe(MK + 30);
  }, 90_000);

  it('while a disagreement stands a gossiped block extending the tip does not extend the chain', async () => {
    // The memory setup raises a disagreement. Then a gossiped block
    // whose parent is the kept tip is dropped before `chain.extend`:
    // `state.tip` stays where it was.
    const keptProof = proofOf(100);
    const yoursProof = proofOf(MK, 60_001);
    const yId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    h.tips.set(yBase, tipOf(MK, 60_001));
    h.proofs.set(yBase, yoursProof);

    const client = await startMeshClient({
      firstContact: [{ notisId: yId, addrs: [], api: yBase }],
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
    const sBefore = client.state();
    expect(sBefore.disagreement).not.toBeNull();
    const tipBefore = sBefore.tip!.height;

    // Mine one more block on top of the kept chain and gossip it; the
    // handler's guard holds the chain (MESH_INTERFACE → Discovery →
    // "A disagreement is the reader's question, never the client's
    // choice").
    const { block: extraBlock } = signedExtendingBlock({
      base: tipBefore,
      m: M,
      k: K,
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
    const msg = { topic, data: encodeOrderingBlock(extraBlock) };
    const validator = pubsub.topicValidators.get(topic)!;
    const relayPeer = peerIdFromNotisId(keyPair().notisId);
    const verdict = await validator(relayPeer, msg);
    expect(verdict).toBe(TopicValidatorResult.Accept);
    pubsub.dispatchEvent(new CustomEvent('gossipsub:message', {
      detail: {
        msg,
        msgId: 'fake-msg-id',
        propagationSource: { toString: () => 'fake-peer' },
      },
    }));
    // The tip stayed where it was.
    expect(client.state().tip?.height).toBe(tipBefore);
  }, 90_000);

  it('continue: the chain is your node\'s, the competing branch growing does not ask again', async () => {
    // Heavier disagreement, then continue. The competing proof is
    // recorded in `answeredProofs`; a later check where the same
    // competing branch still beats y does not raise a new disagreement.
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
    expect(client.state().disagreement).not.toBeNull();

    client.answer('continue');
    expect(client.state().disagreement).toBeNull();
    // The snapshot carries replace: true now.
    const snap = client.toRemember();
    expect(snap.replace).toBe(true);
    expect(snap.answered.length).toBe(1);

    // A later check with the same o still beating y: no new disagreement.
    await client.check();
    expect(client.state().disagreement).toBeNull();
  }, 120_000);

  it('continue, then your node forks again: a new disagreement', async () => {
    // Kept = y's chain of MK (y continues). First check: o1 is a
    // branch rooted at base height 4 — it shares blocks 1..4 with y
    // and diverges at block 5. Heavier disagreement, fork1 = block 4.
    // Continue — answered forks records block 4's hash. Swap o to o2,
    // a branch rooted at base height 9 — shares blocks 1..9 with y
    // and diverges at block 10. fork2 = block 9's hash, different
    // from fork1, so the answered-forks set does not match and a new
    // disagreement is raised.
    const baseChain = buildMinedChain({ count: MK });
    const o1Chain = buildMinedBranch({ base: baseChain, fromHeight: 4, count: MK + 30 });
    const o2Chain = buildMinedBranch({ base: baseChain, fromHeight: 9, count: MK + 30 });
    const keptProof = proveWithReader(makeReader(baseChain), { m: M, k: K });
    const oProof1 = proveWithReader(makeReader(o1Chain), { m: M, k: K });
    const oProof2 = proveWithReader(makeReader(o2Chain), { m: M, k: K });
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
    h.proofs.set(oBase, oProof1);

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
    const firstFork = client.state().disagreement!.fork;
    client.answer('continue');

    // Swap o to o2 — a branch diverging from y at a higher height.
    h.proofs.set(oBase, oProof2);
    h.tips.set(oBase, { height: o2Tip.height, hash: blockHash(o2Tip)! });

    await client.check();
    const s = client.state();
    expect(s.disagreement).not.toBeNull();
    expect(s.disagreement!.fork).not.toBe(firstFork);
  }, 120_000);

  it('disable: your node leaves precedence and the better chain seats at the next check', async () => {
    // Heavier disagreement, then disable. Your node is removed, and
    // the next check seats to the competing chain.
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
    expect(client.state().disagreement).not.toBeNull();
    client.answer('disable');
    const after = client.state();
    expect(after.disagreement).toBeNull();
    // yours is cleared.
    const entry = after.nodes.find((n) => n.notisId === yId);
    expect(entry?.yours).toBe(false);

    await client.check();
    const final = client.state();
    expect(final.tip?.height).toBe(MK + 30);
  }, 120_000);

  it('a check that no longer finds the disagreement clears it', async () => {
    // Raise a memory disagreement. Then your node becomes
    // unreachable; a later check runs and no disagreement is
    // detected — it clears.
    const keptProof = proofOf(100);
    const yoursProof = proofOf(MK, 60_001);
    const yId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    h.tips.set(yBase, tipOf(MK, 60_001));
    h.proofs.set(yBase, yoursProof);

    const client = await startMeshClient({
      firstContact: [{ notisId: yId, addrs: [], api: yBase }],
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

    // Your node goes unreachable.
    h.tips.delete(yBase);
    h.proofs.delete(yBase);
    await client.check();
    expect(client.state().disagreement).toBeNull();
  }, 120_000);

  it('routed reads go to your node first among the nodes the need allows', async () => {
    const keptProof = proofOf(MK);
    const yId = keyPair().notisId;
    const oId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    const oBase = 'http://127.0.0.1:2';
    h.tips.set(yBase, tipOf(MK));
    h.tips.set(oBase, tipOf(MK));
    h.proofs.set(yBase, keptProof);
    h.proofs.set(oBase, keptProof);

    const client = await startMeshClient({
      firstContact: [
        { notisId: yId, addrs: [], api: yBase },
        { notisId: oId, addrs: [], api: oBase },
      ],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      wallClock: () => NOW,
      httpFetch: h.httpFetch,
      resolve: h.resolve,
    });
    clients.push(client);
    client.addByHand(yId, [], true);

    await client.check();
    expect(client.state().disagreement).toBeNull();

    // `base` of a `tip` need picks your node.
    expect(client.base('tip')).toBe(yBase);
    // `order` lists your node first.
    const order = client.order('tip');
    expect(order[0]).toBe(yBase);
  }, 90_000);

  it('while a disagreement stands routed reads take no preference for your node', async () => {
    // With a standing disagreement, routed reads go on with no yours
    // preference. The `base` pick is no longer biased to your node.
    const keptProof = proofOf(100);
    const yoursProof = proofOf(MK, 60_001);
    const otherProof = proofOf(100);
    const yId = keyPair().notisId;
    const oId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    const oBase = 'http://127.0.0.1:2';
    h.tips.set(yBase, tipOf(MK, 60_001));
    h.tips.set(oBase, tipOf(100));
    h.proofs.set(yBase, yoursProof);
    h.proofs.set(oBase, otherProof);

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

    // Under a standing disagreement, your node is off the chain
    // (behind status), so no routed read for `tip` would go to it at
    // all. Over 50 presses the pick does not include yBase.
    for (let i = 0; i < 50; i++) {
      const b = client.base('tip');
      expect(b).not.toBe(yBase);
    }
  }, 120_000);

  it('after continue, your node at the client\'s tip reads ok at the next check', async () => {
    // MESH_INTERFACE → Discovery → "Your node takes precedence" — "its
    // chain is the client's chain, and a routed read goes to it first".
    // Memory setup: kept is a heavier chain, your node's fork is
    // lighter and loses — the memory question. A second node continues
    // kept. The reader answers *continue* and the chain settles to
    // your node's. At the next check your node is placed at tip in
    // phase 3b against the client's (your node's) chain; the heavier
    // other node is above and its proof is read in phase 4, so the
    // own-tip URL — your node — rides the same resolve. The resolve's
    // `behind` field is winner-relative (`→ The client's node list
    // → "A check"`), and the winner there is the heavier other node:
    // your node's winner-relative `behind` is null. Phase 3b's
    // placement against the client's chain stands — your node reads
    // `ok` with `behindBy` 0.
    const keptProof = proofOf(100);
    const yoursProof = proofOf(MK, 60_001);
    const yId = keyPair().notisId;
    const oId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    const oBase = 'http://127.0.0.1:2';
    h.tips.set(yBase, tipOf(MK, 60_001));
    h.tips.set(oBase, tipOf(100));
    h.proofs.set(yBase, yoursProof);
    h.proofs.set(oBase, keptProof);

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

    await client.check();
    const s = client.state();
    const yEntry = s.nodes.find((n) => n.notisId === yId);
    expect(yEntry).toBeDefined();
    expect(yEntry!.status).toBe('ok');
    expect(yEntry!.behindBy).toBe(0);
    expect(yEntry!.yours).toBe(true);
  }, 120_000);

  it('after continue, a tip read goes to your node', async () => {
    // MESH_INTERFACE → Discovery → "Your node takes precedence" —
    // "a routed read goes to it first among the nodes the read's
    // need allows". After *continue* your node reads `ok` at the
    // next check and `base('tip')` picks it, over the heavier
    // other node that reads `behind` off your node's chain.
    const keptProof = proofOf(100);
    const yoursProof = proofOf(MK, 60_001);
    const yId = keyPair().notisId;
    const oId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    const oBase = 'http://127.0.0.1:2';
    h.tips.set(yBase, tipOf(MK, 60_001));
    h.tips.set(oBase, tipOf(100));
    h.proofs.set(yBase, yoursProof);
    h.proofs.set(oBase, keptProof);

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
    await client.check();

    expect(client.base('tip')).toBe(yBase);
    expect(client.order('tip')[0]).toBe(yBase);
  }, 120_000);

  it('after continue on the heavier question, your node reads ok at the next check', async () => {
    // MESH_INTERFACE → Discovery → "Your node takes precedence" — the
    // heavier question variant. Kept = your node's chain of MK; a
    // second node's chain is MK+30 off your node's and beats it. The
    // reader answers *continue*, the fork is answered, and at the next
    // check the heavier other node's tip is placed off the chain in
    // the answered-fork branch while your node names the client's tip
    // — `ok` with `behindBy` 0. The resolve's winner-relative `behind`
    // is null for your node (the winner is the heavier other node),
    // but Phase 3b's placement against the client's chain stands.
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
    expect(client.state().disagreement).not.toBeNull();
    expect(client.state().disagreement!.which).toBe('heavier');

    client.answer('continue');
    expect(client.state().disagreement).toBeNull();

    await client.check();
    const s = client.state();
    const yEntry = s.nodes.find((n) => n.notisId === yId);
    expect(yEntry).toBeDefined();
    expect(yEntry!.status).toBe('ok');
    expect(yEntry!.behindBy).toBe(0);
    expect(yEntry!.yours).toBe(true);
  }, 120_000);

  it('after continue, the heavier node off your chain reads behind and serves no read', async () => {
    // MESH_INTERFACE → Discovery → "Your node takes precedence" —
    // "a routed read goes to a node its need allows ... a `behind`
    // node serves no read". After *continue* the answered-fork
    // branch places the heavier node's tip off your node's chain
    // and reads `behind`; `pickServer` refuses it for every read.
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
    expect(client.state().disagreement).not.toBeNull();
    client.answer('continue');
    await client.check();

    const s = client.state();
    const oEntry = s.nodes.find((n) => n.notisId === oId);
    expect(oEntry).toBeDefined();
    expect(oEntry!.status).toBe('behind');
    // `base('tip')` picks your node first; `base('older')` the same
    // ('behind' serves neither 'tip' nor 'older').
    expect(client.base('tip')).toBe(yBase);
    expect(client.base('older')).toBe(yBase);
    // The order never carries the behind node's base.
    expect(client.order('tip')).not.toContain(oBase);
    expect(client.order('older')).not.toContain(oBase);
  }, 120_000);
});

// MESH_INTERFACE → The client's node list → "A node is judged against
// the chain the check leaves" — a node's event, distance and
// agreement verdict are read against the client's chain as the check
// ends, never against the winner of a contest the client did not
// take: a fork the reader answered, a question standing, the kept
// proof's settle. A tip whose verified proof lost is kept as lost
// only when it lies off that chain. A lie and a failure land as they
// were read.
describe("mesh-client — a node is judged against the chain the check leaves", () => {
  const clients: MeshClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) { try { await c.stop(); } catch { /* already stopped */ } }
  });

  it("after a switch to a heavier chain, the node at the old tip reads behind and serves no tip read", async () => {
    // Kept = Y's chain of MK blocks. Z extends Y by 30 blocks (past
    // k = 20 of Y's window). The first check seats the chain, reads
    // Z's proof — which continues kept — and judge-by-memory picks
    // Z's proof as best. The chain switches to Z. Y's tip, at height
    // MK, falls under Z's window (lowest MK + 11) and places off the
    // chain. The lead says Y reads behind with `behindBy` null and
    // serves no tip read.
    const keptProof = proofOf(MK);
    const zProof = proofOf(MK + 30);
    const yId = keyPair().notisId;
    const zId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    const zBase = 'http://127.0.0.1:2';
    h.tips.set(yBase, tipOf(MK));
    h.tips.set(zBase, tipOf(MK + 30));
    h.proofs.set(yBase, keptProof);
    h.proofs.set(zBase, zProof);

    const client = await startMeshClient({
      firstContact: [
        { notisId: yId, addrs: [], api: yBase },
        { notisId: zId, addrs: [], api: zBase },
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

    await client.check();
    const s = client.state();
    expect(s.tip?.height).toBe(MK + 30);
    const yEntry = s.nodes.find((n) => n.notisId === yId);
    expect(yEntry).toBeDefined();
    expect(yEntry!.status).toBe('behind');
    expect(yEntry!.behindBy).toBeNull();
    expect(client.order('tip')).not.toContain(yBase);
    expect(client.order('older')).not.toContain(yBase);
  }, 120_000);

  it("while a question stands, nodes are judged against the held chain", async () => {
    // Kept = Y's chain of MK. A heavier O on a different chain (stamp
    // 60_001 shifts its retarget so it does not continue kept). The
    // first check raises a heavier disagreement; the chain stays at
    // kept. The lead says a node naming the held tip reads ok and
    // the heavier other reads behind off the chain.
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
    const s = client.state();
    expect(s.disagreement).not.toBeNull();
    expect(s.disagreement!.which).toBe('heavier');
    expect(s.tip?.height).toBe(MK);
    const yEntry = s.nodes.find((n) => n.notisId === yId);
    const oEntry = s.nodes.find((n) => n.notisId === oId);
    expect(yEntry!.status).toBe('ok');
    expect(yEntry!.behindBy).toBe(0);
    expect(oEntry!.status).toBe('behind');
    expect(oEntry!.behindBy).toBeNull();
    expect(s.agreement).not.toBeNull();
    expect(s.agreement!.onChain).toBe(1);
    expect(s.agreement!.offChain).toBe(1);
  }, 120_000);

  it("where the kept proof wins the settle over the resolve's winner, nodes are judged against the kept chain", async () => {
    // Kept = Y's chain of MK. Z is higher (MK + 30) on an
    // incomparable chain: a forced level-7 nonce at height 1 gives
    // a different genesis, so Z and Y share no block and
    // `compareProofs` answers `incomparable`. The resolve picks Z
    // (highest tip); `judgeByMemory` picks Y, since no comparable
    // proof beats the kept. The lead says Z, whose tip lies off the
    // kept chain, reads behind with `behindBy` null.
    const keptProof = proofOf(MK);
    const zForce = new Map([[1, 7]]);
    const zChain = buildMinedChain({ count: MK + 30, forceLevels: zForce });
    const zProof = proveWithReader(makeReader(zChain), { m: M, k: K });
    const zTipHdr = zChain.headers[zChain.headers.length - 1]!;
    const zTipHash = blockHash(zTipHdr);
    if (zTipHash === null) throw new Error('unhashable zTip');
    const yId = keyPair().notisId;
    const zId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    const zBase = 'http://127.0.0.1:2';
    h.tips.set(yBase, tipOf(MK));
    h.tips.set(zBase, { height: MK + 30, hash: zTipHash });
    h.proofs.set(yBase, keptProof);
    h.proofs.set(zBase, zProof);

    const client = await startMeshClient({
      firstContact: [
        { notisId: yId, addrs: [], api: yBase },
        { notisId: zId, addrs: [], api: zBase },
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

    await client.check();
    const s = client.state();
    expect(s.tip?.height).toBe(MK);  // chain stays on kept
    const zEntry = s.nodes.find((n) => n.notisId === zId);
    expect(zEntry).toBeDefined();
    expect(zEntry!.status).toBe('behind');
    expect(zEntry!.behindBy).toBeNull();
    expect(s.agreement).not.toBeNull();
    expect(s.agreement!.onChain).toBe(1);
    expect(s.agreement!.offChain).toBe(1);
  }, 120_000);

  it("after continue, your node counts on the chain in the agreement", async () => {
    // The heavier memory question: kept = Y's chain of MK, O heavier
    // on a different chain. After *continue*, the next check reads
    // the heavier other as behind off the chain and Y as ok. Y
    // counts on and O counts off.
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
    expect(client.state().disagreement).not.toBeNull();
    client.answer('continue');
    await client.check();

    const s = client.state();
    const yEntry = s.nodes.find((n) => n.notisId === yId);
    expect(yEntry!.status).toBe('ok');
    expect(s.agreement).not.toBeNull();
    expect(s.agreement!.onChain).toBe(1);
    expect(s.agreement!.offChain).toBe(1);
  }, 120_000);

  it("after continue, every node naming your node's tip reads ok", async () => {
    // A third node w names Y's tip after continue. w's placement
    // against the client's chain (= Y's) is `tip`; w reads ok.
    const keptProof = proofOf(MK);
    const oProof = proofOf(MK + 30, 60_001);
    const yId = keyPair().notisId;
    const oId = keyPair().notisId;
    const wId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    const oBase = 'http://127.0.0.1:2';
    const wBase = 'http://127.0.0.1:3';
    h.tips.set(yBase, tipOf(MK));
    h.tips.set(oBase, tipOf(MK + 30, 60_001));
    h.tips.set(wBase, tipOf(MK));  // w names kept's tip (= Y's tip)
    h.proofs.set(yBase, keptProof);
    h.proofs.set(oBase, oProof);
    h.proofs.set(wBase, keptProof);

    const client = await startMeshClient({
      firstContact: [
        { notisId: yId, addrs: [], api: yBase },
        { notisId: oId, addrs: [], api: oBase },
        { notisId: wId, addrs: [], api: wBase },
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
    await client.check();

    const s = client.state();
    const wEntry = s.nodes.find((n) => n.notisId === wId);
    expect(wEntry).toBeDefined();
    expect(wEntry!.status).toBe('ok');
    expect(wEntry!.behindBy).toBe(0);
  }, 120_000);

  it("after continue, the client's own tip is not kept as a lost tip", async () => {
    // After *continue*, the client's chain is Y's. On the next
    // check, a third node w naming Y's tip reads ok, never
    // treated as a lost tip via a stale keptVerdicts entry. A
    // third check follows to catch any carry-over.
    const keptProof = proofOf(MK);
    const oProof = proofOf(MK + 30, 60_001);
    const yId = keyPair().notisId;
    const oId = keyPair().notisId;
    const wId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    const oBase = 'http://127.0.0.1:2';
    const wBase = 'http://127.0.0.1:3';
    h.tips.set(yBase, tipOf(MK));
    h.tips.set(oBase, tipOf(MK + 30, 60_001));
    h.tips.set(wBase, tipOf(MK));
    h.proofs.set(yBase, keptProof);
    h.proofs.set(oBase, oProof);
    h.proofs.set(wBase, keptProof);

    const client = await startMeshClient({
      firstContact: [
        { notisId: yId, addrs: [], api: yBase },
        { notisId: oId, addrs: [], api: oBase },
        { notisId: wId, addrs: [], api: wBase },
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
    await client.check();
    await client.check();

    const s = client.state();
    const yEntry = s.nodes.find((n) => n.notisId === yId);
    const wEntry = s.nodes.find((n) => n.notisId === wId);
    expect(yEntry!.status).toBe('ok');
    expect(wEntry!.status).toBe('ok');
    expect(s.tip?.height).toBe(MK);
  }, 120_000);

  it("a node whose proof is a lie is blacklisted whatever its tip read placed", async () => {
    // A node M names a tip above the chain; phase 3b places it
    // above. In phase 4 M serves a tampered proof — the suffix
    // head's `powNonce` set to 0, which fails verification. Over a
    // mesh-authenticated link the lie lands as `blacklisted` (the
    // node-list table's lie row); at an API base it is demoted to
    // `retry` (the API-base row — HTTPS authenticates a name, never
    // a key). Either way the single pass does NOT promote M back to
    // 'ok' from its tip read's placement. The harness reads M at
    // its API base, so M reads `retry`.
    const keptProof = proofOf(MK);
    const tamperedProof: NipopowProof = {
      ...keptProof,
      suffixHead: {
        ...keptProof.suffixHead,
        header: { ...keptProof.suffixHead.header, powNonce: 0 },
      },
    };
    const mTipChain = buildMinedChain({ count: MK + 5 });
    const mTipHdr = mTipChain.headers[mTipChain.headers.length - 1]!;
    const mTipHash = blockHash(mTipHdr);
    if (mTipHash === null) throw new Error('unhashable mTip');
    const yId = keyPair().notisId;
    const mId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    const mBase = 'http://127.0.0.1:2';
    h.tips.set(yBase, tipOf(MK));
    h.tips.set(mBase, { height: MK + 5, hash: mTipHash });
    h.proofs.set(yBase, keptProof);
    h.proofs.set(mBase, tamperedProof);

    const client = await startMeshClient({
      firstContact: [
        { notisId: yId, addrs: [], api: yBase },
        { notisId: mId, addrs: [], api: mBase },
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

    await client.check();
    const s = client.state();
    const mEntry = s.nodes.find((n) => n.notisId === mId);
    expect(mEntry).toBeDefined();
    expect(mEntry!.status).toBe('retry');
    // The single pass judges M's tip hash above the chain; if it
    // had wrongly written an event for a lying node, status would
    // read 'behind' or 'ok'. The assertion stands for the lie path.
    expect(mEntry!.status).not.toBe('ok');
    expect(mEntry!.status).not.toBe('trailing');
    expect(mEntry!.status).not.toBe('behind');
  }, 120_000);

  it("a node further down the chain than the held headers, matched by the chain's own header, counts on the chain", async () => {
    // Kept = Y's chain of MK. W reports tip at height 5 with Y's
    // chain's hash at that height. Phase 3b places W 'under' (5 is
    // below the window's lowest held height, M + 1). Phase 3c reads
    // Y's `/blocks/5`, whose hash matches W's — W lies on the chain,
    // further down than the held headers. The lead says W counts on
    // the chain with `behindBy` its distance (MK - 5).
    const keptProof = proofOf(MK);
    const yChain = buildMinedChain({ count: MK });
    const wHeight = 5;
    const wHash = blockHash(yChain.headers[wHeight - 1]!);
    if (wHash === null) throw new Error('unhashable yBlock5');
    const yId = keyPair().notisId;
    const wId = keyPair().notisId;
    const yBase = 'http://127.0.0.1:1';
    const wBase = 'http://127.0.0.1:2';
    const tips = new Map<string, { height: number; hash: string }>();
    tips.set(yBase, tipOf(MK));
    tips.set(wBase, { height: wHeight, hash: wHash });
    const proofs = new Map<string, NipopowProof>();
    proofs.set(yBase, keptProof);

    // Custom httpFetch: /blocks/current per base; Y's /blocks/<h>
    // serves Y's chain header (phase 3c reads from first-at-tip).
    const httpFetch: HttpFetch = async (url: string) => {
      for (const [base, tip] of tips) {
        if (url === `${base}/blocks/current`) {
          return new Response(JSON.stringify(tip), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      if (url.startsWith(`${yBase}/blocks/`)) {
        const heightStr = url.slice(`${yBase}/blocks/`.length);
        const height = Number.parseInt(heightStr, 10);
        if (Number.isInteger(height) && height >= 1 && height <= yChain.headers.length) {
          return new Response(
            JSON.stringify({ header: headerToJson(yChain.headers[height - 1]!) }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
      }
      return new Response('nowhere', { status: 404 });
    };

    const client = await startMeshClient({
      firstContact: [
        { notisId: yId, addrs: [], api: yBase },
        { notisId: wId, addrs: [], api: wBase },
      ],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      memory: { proof: encodeNipopowProof(keptProof), answered: [] },
      wallClock: () => NOW,
      httpFetch,
      resolve: makeResolve(proofs),
    });
    clients.push(client);

    await client.check();
    const s = client.state();
    const wEntry = s.nodes.find((n) => n.notisId === wId);
    expect(wEntry).toBeDefined();
    expect(wEntry!.status).toBe('behind');
    expect(wEntry!.behindBy).toBe(MK - wHeight);
    expect(s.tip?.height).toBe(MK);
    expect(s.agreement).not.toBeNull();
    expect(s.agreement!.onChain).toBe(2);
    expect(s.agreement!.offChain).toBe(0);
  }, 120_000);

  it("an under tip the chain's own header does not match lies off the chain", async () => {
    // Kept = Y's chain of MK. V has an incomparable chain with a
    // forced level-7 nonce at block 1 — so V and Y share no block,
    // `compareProofs` answers `incomparable`, and V's block at
    // height 5 differs from Y's. V reports tip at height 5 with its
    // own chain's block-5 hash; phase 3b places V 'under'. Phase 3c
    // reads Y's `/blocks/5`, whose hash does not match. Y is
    // comparable in the batch (its own proof ties kept), so
    // `foreign` is false and the chain stays on Y. V lies off the
    // chain, `behind` with `behindBy` null and `off` in the
    // agreement — the pair to the matched case above.
    const keptProof = proofOf(MK);
    const yChain = buildMinedChain({ count: MK });
    const vForce = new Map([[1, 7]]);
    const vChain = buildMinedChain({ count: MK, forceLevels: vForce });
    const vProof = proveWithReader(makeReader(vChain), { m: M, k: K });
    const vHeight = 5;
    const vHash = blockHash(vChain.headers[vHeight - 1]!);
    if (vHash === null) throw new Error('unhashable vBlock5');
    const yId = keyPair().notisId;
    const vId = keyPair().notisId;
    const yBase = 'http://127.0.0.1:1';
    const vBase = 'http://127.0.0.1:2';
    const tips = new Map<string, { height: number; hash: string }>();
    tips.set(yBase, tipOf(MK));
    tips.set(vBase, { height: vHeight, hash: vHash });
    const proofs = new Map<string, NipopowProof>();
    proofs.set(yBase, keptProof);
    proofs.set(vBase, vProof);

    const httpFetch: HttpFetch = async (url: string) => {
      for (const [base, tip] of tips) {
        if (url === `${base}/blocks/current`) {
          return new Response(JSON.stringify(tip), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      if (url.startsWith(`${yBase}/blocks/`)) {
        const heightStr = url.slice(`${yBase}/blocks/`.length);
        const height = Number.parseInt(heightStr, 10);
        if (Number.isInteger(height) && height >= 1 && height <= yChain.headers.length) {
          return new Response(
            JSON.stringify({ header: headerToJson(yChain.headers[height - 1]!) }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
      }
      return new Response('nowhere', { status: 404 });
    };

    const client = await startMeshClient({
      firstContact: [
        { notisId: yId, addrs: [], api: yBase },
        { notisId: vId, addrs: [], api: vBase },
      ],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      memory: { proof: encodeNipopowProof(keptProof), answered: [] },
      wallClock: () => NOW,
      httpFetch,
      resolve: makeResolve(proofs),
    });
    clients.push(client);

    await client.check();
    const s = client.state();
    const vEntry = s.nodes.find((n) => n.notisId === vId);
    expect(vEntry).toBeDefined();
    expect(vEntry!.status).toBe('behind');
    expect(vEntry!.behindBy).toBeNull();
    expect(s.tip?.height).toBe(MK);
    expect(s.agreement).not.toBeNull();
    expect(s.agreement!.onChain).toBe(1);
    expect(s.agreement!.offChain).toBe(1);
  }, 120_000);

  it("after a switch, the node chosen for the outrun re-read is chosen against the settled chain", async () => {
    // Kept = Y's chain of MK. Z extends Y by 30 blocks. Y reports
    // tip MK, Z reports tip MK + 30; the first check settles the
    // chain to Z. Y's tip at MK falls under Z's window — placed
    // against the settled chain, Y is 'under', so the outrun re-read
    // asks Y again (a tip the check has outrun is read again). The
    // observable: Y's `/blocks/current` is called twice in one
    // check. A regression that chooses the re-read set against the
    // pre-switch placements reads Y once, since Y was 'tip' on the
    // pre-switch chain.
    const keptProof = proofOf(MK);
    const zProof = proofOf(MK + 30);
    const yId = keyPair().notisId;
    const zId = keyPair().notisId;
    const yBase = 'http://127.0.0.1:1';
    const zBase = 'http://127.0.0.1:2';
    const tips = new Map<string, { height: number; hash: string }>();
    tips.set(yBase, tipOf(MK));
    tips.set(zBase, tipOf(MK + 30));
    const proofs = new Map<string, NipopowProof>();
    proofs.set(yBase, keptProof);
    proofs.set(zBase, zProof);

    let yCurrentCalls = 0;
    const httpFetch: HttpFetch = async (url: string) => {
      for (const [base, tip] of tips) {
        if (url === `${base}/blocks/current`) {
          if (base === yBase) yCurrentCalls += 1;
          return new Response(JSON.stringify(tip), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      return new Response('nowhere', { status: 404 });
    };

    const client = await startMeshClient({
      firstContact: [
        { notisId: yId, addrs: [], api: yBase },
        { notisId: zId, addrs: [], api: zBase },
      ],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      memory: { proof: encodeNipopowProof(keptProof), answered: [] },
      wallClock: () => NOW,
      httpFetch,
      resolve: makeResolve(proofs),
    });
    clients.push(client);

    await client.check();
    const s = client.state();
    expect(s.tip?.height).toBe(MK + 30);
    // Y was 'tip' on Y's chain, 'under' on Z's chain — the re-read
    // picks against Z, so Y is re-read in this check.
    expect(yCurrentCalls).toBe(2);
  }, 120_000);

  // MESH_INTERFACE → The client's node list → "A node is judged
  // against the chain the check leaves" — "A lie and a failure land
  // as they were read: the entry's status is theirs — `blacklisted`
  // or `retry` — while its count in the agreement and its distance
  // follow its tip read's placement as any node's do, since the
  // counts say what the nodes name" (→ What the client remembers →
  // "The agreement counts").

  it("a node whose proof fails at its API base keeps retry and counts on the chain by the tip it names", async () => {
    // R and Y at their API bases, both naming the same tip at MK.
    // R's proof is tampered (`powNonce` set to 0 on its suffix head),
    // Y's proof verifies. Phase 4 asks R first by candidate rank
    // (first-contact order); the API-base lie moves R to `retry`.
    // The next pass reads Y and seats the chain. Both tip reads
    // place `tip` against the seated chain; R's `retry` stays, and
    // R counts on the chain beside Y.
    const rProof = proofOf(MK);
    const tamperedProof: NipopowProof = {
      ...rProof,
      suffixHead: {
        ...rProof.suffixHead,
        header: { ...rProof.suffixHead.header, powNonce: 0 },
      },
    };
    const yProof = proofOf(MK);
    const rId = keyPair().notisId;
    const yId = keyPair().notisId;
    const h = harness();
    const rBase = 'http://127.0.0.1:1';
    const yBase = 'http://127.0.0.1:2';
    h.tips.set(rBase, tipOf(MK));
    h.tips.set(yBase, tipOf(MK));
    h.proofs.set(rBase, tamperedProof);
    h.proofs.set(yBase, yProof);

    const client = await startMeshClient({
      firstContact: [
        { notisId: rId, addrs: [], api: rBase },
        { notisId: yId, addrs: [], api: yBase },
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
    const rEntry = s.nodes.find((n) => n.notisId === rId);
    expect(rEntry).toBeDefined();
    expect(rEntry!.status).toBe('retry');
    expect(rEntry!.behindBy).toBe(0);
    expect(s.tip?.height).toBe(MK);
    expect(s.agreement).not.toBeNull();
    expect(s.agreement!.onChain).toBe(2);
    expect(s.agreement!.offChain).toBe(0);
    // The retry node serves no tip read.
    expect(client.base('tip')).toBe(yBase);
    expect(client.order('tip')).not.toContain(rBase);
  }, 120_000);

  it("a node blacklisted by a gossip-block lie counts by the tip it named, and serves no read", async () => {
    // Y and N at their API bases, both naming the same tip at MK,
    // both proofs verifying. No memory, so phase 4 resolves the
    // winner and seats the chain. During that resolveFn call the
    // topic validator for the ordering-block topic is called with a
    // malformed block (bytes that fail to decode) and N's peer id as
    // propagation source: the validator reads a reject with
    // `lie: true` and the entry for N moves to `blacklisted` with
    // evidence `gossip-block` (→ The client's node list, the lie
    // row; → Block gossip → "A refused block is evidence as `net`
    // weighs it"). The judgement pass reads N's status, leaves it
    // with no event, and writes its agreement verdict and distance
    // from its tip read's placement — on the chain at the tip.
    interface TopicValidator {
      (peer: unknown, msg: { topic: string; data: Uint8Array }): unknown;
    }
    interface Pubsub {
      topicValidators: { get(topic: string): TopicValidator | undefined };
    }
    const topicValidatorHolder: { current: TopicValidator | null } = { current: null };

    const yProof = proofOf(MK);
    const yId = keyPair().notisId;
    const nId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    const nBase = 'http://127.0.0.1:2';
    h.tips.set(yBase, tipOf(MK));
    h.tips.set(nBase, tipOf(MK));
    h.proofs.set(yBase, yProof);
    h.proofs.set(nBase, yProof);

    const nPeerId = peerIdFromNotisId(nId);
    let dispatched = false;
    const underlying = h.resolve;
    const wrappedResolve: ResolveFn = async (urls, m, k, profile, now, fetch) => {
      if (!dispatched && topicValidatorHolder.current !== null) {
        dispatched = true;
        const topic = gossipTopics(PROFILE.magic).orderingBlock;
        await topicValidatorHolder.current(nPeerId, {
          topic,
          data: new Uint8Array(0),
        });
      }
      return underlying(urls, m, k, profile, now, fetch);
    };

    const client = await startMeshClient({
      firstContact: [
        { notisId: yId, addrs: [], api: yBase },
        { notisId: nId, addrs: [], api: nBase },
      ],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      wallClock: () => NOW,
      httpFetch: h.httpFetch,
      resolve: wrappedResolve,
    });
    clients.push(client);
    const pubsub = (client.libp2p as unknown as { services: { pubsub: Pubsub } }).services.pubsub;
    const topic = gossipTopics(PROFILE.magic).orderingBlock;
    const validator = pubsub.topicValidators.get(topic);
    if (validator === undefined) throw new Error('no topic validator for ordering block');
    topicValidatorHolder.current = validator;

    await client.check();
    const s = client.state();
    const nEntry = s.nodes.find((n) => n.notisId === nId);
    expect(nEntry).toBeDefined();
    expect(nEntry!.status).toBe('blacklisted');
    expect(nEntry!.behindBy).toBe(0);
    expect(s.tip?.height).toBe(MK);
    expect(s.agreement).not.toBeNull();
    expect(s.agreement!.onChain).toBe(2);
    expect(s.agreement!.offChain).toBe(0);
    // A blacklisted entry serves no read.
    expect(client.base('tip')).toBe(yBase);
    expect(client.order('tip')).not.toContain(nBase);
  }, 120_000);

  it("a node whose proof read fails as a transport failure keeps retry and counts by the tip it named", async () => {
    // T and Y at their API bases, both naming the same tip at MK.
    // T has no proof in the resolve map, so the resolve answers it
    // `refuseCode: 'unreachable'`, which `tipEvent` reads as a
    // transport failure (→ The client's node list, the `retry` row).
    // T moves to `retry`; the next pass reads Y and seats the chain.
    // Both tip reads place `tip` against the seated chain; T's
    // `retry` stays, and T counts on the chain beside Y.
    const yProof = proofOf(MK);
    const tId = keyPair().notisId;
    const yId = keyPair().notisId;
    const h = harness();
    const tBase = 'http://127.0.0.1:1';
    const yBase = 'http://127.0.0.1:2';
    h.tips.set(tBase, tipOf(MK));
    h.tips.set(yBase, tipOf(MK));
    // No proof entry for tBase: the resolve answers `unreachable`.
    h.proofs.set(yBase, yProof);

    const client = await startMeshClient({
      firstContact: [
        { notisId: tId, addrs: [], api: tBase },
        { notisId: yId, addrs: [], api: yBase },
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
    const tEntry = s.nodes.find((n) => n.notisId === tId);
    expect(tEntry).toBeDefined();
    expect(tEntry!.status).toBe('retry');
    expect(tEntry!.behindBy).toBe(0);
    expect(s.tip?.height).toBe(MK);
    expect(s.agreement).not.toBeNull();
    expect(s.agreement!.onChain).toBe(2);
    expect(s.agreement!.offChain).toBe(0);
    expect(client.base('tip')).toBe(yBase);
    expect(client.order('tip')).not.toContain(tBase);
  }, 120_000);

  it("a node off the chain whose proof was refused counts off the chain", async () => {
    // Kept = Y's chain at MK. O names an incomparable tip at MK + 5
    // (forced level-7 genesis). Phase 3a's fill against O's base
    // fails (the harness answers 404 for `/blocks/:height`); phase 4
    // asks for O's proof at its API base, finds a tampered one that
    // fails verification, and moves O to `retry` (the API-base row).
    // The final pass places O's hash `above`, off the chain; the
    // `retry` stays, and O counts off the chain.
    const keptProof = proofOf(MK);
    const oForce = new Map([[1, 7]]);
    const oChain = buildMinedChain({ count: MK + 5, forceLevels: oForce });
    const oProof = proveWithReader(makeReader(oChain), { m: M, k: K });
    const oTamperedProof: NipopowProof = {
      ...oProof,
      suffixHead: {
        ...oProof.suffixHead,
        header: { ...oProof.suffixHead.header, powNonce: 0 },
      },
    };
    const oTipHdr = oChain.headers[oChain.headers.length - 1]!;
    const oTipHash = blockHash(oTipHdr);
    if (oTipHash === null) throw new Error('unhashable oTip');
    const yId = keyPair().notisId;
    const oId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    const oBase = 'http://127.0.0.1:2';
    h.tips.set(yBase, tipOf(MK));
    h.tips.set(oBase, { height: MK + 5, hash: oTipHash });
    h.proofs.set(yBase, keptProof);
    h.proofs.set(oBase, oTamperedProof);

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

    await client.check();
    const s = client.state();
    const oEntry = s.nodes.find((n) => n.notisId === oId);
    expect(oEntry).toBeDefined();
    expect(oEntry!.status).toBe('retry');
    expect(oEntry!.behindBy).toBeNull();
    expect(s.tip?.height).toBe(MK);
    expect(s.agreement).not.toBeNull();
    expect(s.agreement!.onChain).toBe(1);
    expect(s.agreement!.offChain).toBe(1);
  }, 120_000);

  // MESH_INTERFACE → The client's node list → "A node is judged
  // against the chain the check leaves" — "its tip placed on that
  // chain by hash, at the height the chain holds that hash whatever
  // height the read names". A read whose hash the window holds is
  // placed at that hash's chain-held height (tip / one-below /
  // further down); a read whose hash the window does not hold is
  // placed by the height it names.

  it("a tip read naming the chain's tip hash at a height above it is placed at the tip", async () => {
    // Kept = Y's chain at MK. N serves the chain's tip hash with a
    // height of MK + 1 on `/blocks/current`, and its proof is Y's
    // (naming the same tip). The chain already holds that hash at
    // MK, so the pass places N at the tip — N counts on the chain,
    // and phase 3a attempts no fill of `/blocks/MK+1` (the node has
    // no such block).
    const keptProof = proofOf(MK);
    const yTip = tipOf(MK);
    const yId = keyPair().notisId;
    const nId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    const nBase = 'http://127.0.0.1:2';
    h.tips.set(yBase, yTip);
    // N rewrites only the height; the hash is the chain's tip hash.
    h.tips.set(nBase, { height: MK + 1, hash: yTip.hash });
    h.proofs.set(yBase, keptProof);
    h.proofs.set(nBase, keptProof);

    const client = await startMeshClient({
      firstContact: [
        { notisId: yId, addrs: [], api: yBase },
        { notisId: nId, addrs: [], api: nBase },
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

    await client.check();
    const s = client.state();
    const nEntry = s.nodes.find((n) => n.notisId === nId);
    expect(nEntry).toBeDefined();
    expect(nEntry!.status).toBe('ok');
    expect(nEntry!.behindBy).toBe(0);
    expect(s.tip?.height).toBe(MK);
    expect(s.agreement).not.toBeNull();
    expect(s.agreement!.onChain).toBe(2);
    expect(s.agreement!.offChain).toBe(0);
    expect(client.order('tip')).toContain(nBase);
  }, 120_000);

  it("a tip read naming the chain's tip hash at a height below it is placed at the tip", async () => {
    // Kept = Y's chain at MK. N serves the chain's tip hash with a
    // height of MK − 1 on `/blocks/current`; its proof is Y's. The
    // window holds the hash at MK, so the pass places N at the tip.
    const keptProof = proofOf(MK);
    const yTip = tipOf(MK);
    const yId = keyPair().notisId;
    const nId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    const nBase = 'http://127.0.0.1:2';
    h.tips.set(yBase, yTip);
    h.tips.set(nBase, { height: MK - 1, hash: yTip.hash });
    h.proofs.set(yBase, keptProof);
    h.proofs.set(nBase, keptProof);

    const client = await startMeshClient({
      firstContact: [
        { notisId: yId, addrs: [], api: yBase },
        { notisId: nId, addrs: [], api: nBase },
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

    await client.check();
    const s = client.state();
    const nEntry = s.nodes.find((n) => n.notisId === nId);
    expect(nEntry).toBeDefined();
    expect(nEntry!.status).toBe('ok');
    expect(nEntry!.behindBy).toBe(0);
    expect(s.tip?.height).toBe(MK);
    expect(s.agreement).not.toBeNull();
    expect(s.agreement!.onChain).toBe(2);
    expect(s.agreement!.offChain).toBe(0);
    expect(client.order('tip')).toContain(nBase);
  }, 120_000);

  it("a tip read naming a hash the chain does not hold at a height it holds is off the chain", async () => {
    // Kept = Y's chain at MK. N serves a hash the chain does not
    // hold at a height the window holds (MK − 5); N's proof is
    // tampered, so phase 4 reads a proof-invalid lie at N's API
    // base. The pass places N off the chain and keeps its `retry`.
    const keptProof = proofOf(MK);
    const tamperedProof: NipopowProof = {
      ...keptProof,
      suffixHead: {
        ...keptProof.suffixHead,
        header: { ...keptProof.suffixHead.header, powNonce: 0 },
      },
    };
    const yId = keyPair().notisId;
    const nId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    const nBase = 'http://127.0.0.1:2';
    h.tips.set(yBase, tipOf(MK));
    // A hash the chain does not hold, at a height the window holds.
    const fakeHash = '00'.repeat(32);
    h.tips.set(nBase, { height: MK - 5, hash: fakeHash });
    h.proofs.set(yBase, keptProof);
    h.proofs.set(nBase, tamperedProof);

    const client = await startMeshClient({
      firstContact: [
        { notisId: yId, addrs: [], api: yBase },
        { notisId: nId, addrs: [], api: nBase },
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

    await client.check();
    const s = client.state();
    const nEntry = s.nodes.find((n) => n.notisId === nId);
    expect(nEntry).toBeDefined();
    expect(nEntry!.status).toBe('retry');
    expect(nEntry!.behindBy).toBeNull();
    expect(s.tip?.height).toBe(MK);
    expect(s.agreement).not.toBeNull();
    expect(s.agreement!.onChain).toBe(1);
    expect(s.agreement!.offChain).toBe(1);
    expect(client.order('tip')).not.toContain(nBase);
  }, 120_000);
});

/** Header JSON shape `/blocks/:height` answers with — shared by the
 * three cases that need a node to serve its chain's headers. */
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
