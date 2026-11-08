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

// A valid webrtc-direct address — the client's `addByHand` refuses a
// multiaddr without one. In the test harness no libp2p peer answers at
// this address, so the entry falls back to its api base for reads.
const YOUR_ADDR = '/ip4/10.0.0.1/udp/4001/webrtc-direct/certhash/uEiAHocoutEO27UicmZa5J6i7mvNBHjnfOtnAeSTMAR0Ezg';

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
      memory: { proof: encodeNipopowProof(keptProof), answeredForks: [] },
      wallClock: () => NOW,
      httpFetch: h.httpFetch,
      resolve: h.resolve,
    });
    clients.push(client);
    client.addByHand(yId, [YOUR_ADDR], true);

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
      memory: { proof: encodeNipopowProof(keptProof), answeredForks: [] },
      wallClock: () => NOW,
      httpFetch: h.httpFetch,
      resolve: h.resolve,
    });
    clients.push(client);
    client.addByHand(yId, [YOUR_ADDR], true);

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
      memory: { proof: encodeNipopowProof(keptProof), answeredForks: [] },
      wallClock: () => NOW,
      httpFetch: h.httpFetch,
      resolve: h.resolve,
    });
    clients.push(client);
    client.addByHand(yId, [YOUR_ADDR], true);

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
    client.addByHand(yId, [YOUR_ADDR], true);

    await client.check();
    const s = client.state();
    expect(s.disagreement).toBeNull();
    expect(s.tip?.height).toBe(MK + 5);
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
      memory: { proof: encodeNipopowProof(keptProof), answeredForks: [] },
      wallClock: () => NOW,
      httpFetch: h.httpFetch,
      resolve: h.resolve,
    });
    clients.push(client);
    client.addByHand(yId, [YOUR_ADDR], true);

    await client.check();
    const sBefore = client.state();
    expect(sBefore.disagreement).not.toBeNull();
    const tipBefore = sBefore.tip!.height;

    // Mine one more block on top of the kept chain and gossip it.
    const extended = buildMinedChain({ count: 101 });
    const nextHeader = extended.headers[100]!;
    const emptyTree: UtxoTxTree = { utxoTxIds: [], utxoTxs: [] };
    const extraBlock: OrderingBlock = {
      header: nextHeader,
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
          data: encodeOrderingBlock(extraBlock),
        },
        msgId: 'fake-msg-id',
        propagationSource: { toString: () => 'fake-peer' },
      },
    }));
    // The tip stayed where it was.
    expect(client.state().tip?.height).toBe(tipBefore);
  }, 90_000);

  it('continue: the chain is your node\'s, the competing branch growing does not ask again', async () => {
    // Heavier disagreement, then continue. The fork is recorded in
    // answeredForks; a later check where the same competing branch
    // still beats y does not raise a new disagreement.
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
      memory: { proof: encodeNipopowProof(keptProof), answeredForks: [] },
      wallClock: () => NOW,
      httpFetch: h.httpFetch,
      resolve: h.resolve,
    });
    clients.push(client);
    client.addByHand(yId, [YOUR_ADDR], true);

    await client.check();
    expect(client.state().disagreement).not.toBeNull();

    client.answer('continue');
    expect(client.state().disagreement).toBeNull();
    // The snapshot carries replace: true now.
    const snap = client.toRemember();
    expect(snap.replace).toBe(true);
    expect(snap.answeredForks.length).toBe(1);

    // A later check with the same o still beating y: no new disagreement.
    await client.check();
    expect(client.state().disagreement).toBeNull();
  }, 120_000);

  // `buildMinedChain` makes every chain share block 1 (forceLevels on
  // other heights mines each chain afresh from block 1), so every fork
  // the pair-helpers can construct has the same `lca = block 1` and
  // therefore the same `forkKey`. A test of "forks again" needs chains
  // that diverge at different heights; this one is kept as a
  // placeholder and will be rewritten when a divergent-chain helper
  // lands.
  it.fails('continue, then your node forks again: a new disagreement', async () => {
    // First disagreement answered. Then o changes to a different
    // branch — forkKey differs — a new disagreement is raised.
    const keptProof = proofOf(MK);
    const oProof1 = proofOf(MK + 30, 60_001);
    const yId = keyPair().notisId;
    const oId = keyPair().notisId;
    const h = harness();
    const yBase = 'http://127.0.0.1:1';
    const oBase = 'http://127.0.0.1:2';
    h.tips.set(yBase, tipOf(MK));
    h.tips.set(oBase, tipOf(MK + 30, 60_001));
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
      memory: { proof: encodeNipopowProof(keptProof), answeredForks: [] },
      wallClock: () => NOW,
      httpFetch: h.httpFetch,
      resolve: h.resolve,
    });
    clients.push(client);
    client.addByHand(yId, [YOUR_ADDR], true);

    await client.check();
    expect(client.state().disagreement).not.toBeNull();
    const firstFork = client.state().disagreement!.fork;
    client.answer('continue');

    // Swap o's proof to a different fork (different stampInterval).
    const oProof2 = proofOf(MK + 30, 59_999);
    h.proofs.set(oBase, oProof2);
    h.tips.set(oBase, tipOf(MK + 30, 59_999));

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
      memory: { proof: encodeNipopowProof(keptProof), answeredForks: [] },
      wallClock: () => NOW,
      httpFetch: h.httpFetch,
      resolve: h.resolve,
    });
    clients.push(client);
    client.addByHand(yId, [YOUR_ADDR], true);

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
      memory: { proof: encodeNipopowProof(keptProof), answeredForks: [] },
      wallClock: () => NOW,
      httpFetch: h.httpFetch,
      resolve: h.resolve,
    });
    clients.push(client);
    client.addByHand(yId, [YOUR_ADDR], true);

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
    client.addByHand(yId, [YOUR_ADDR], true);

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
      memory: { proof: encodeNipopowProof(keptProof), answeredForks: [] },
      wallClock: () => NOW,
      httpFetch: h.httpFetch,
      resolve: h.resolve,
    });
    clients.push(client);
    client.addByHand(yId, [YOUR_ADDR], true);

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
});
