// MEMPOOL_INTERFACE → The fill budget is bytes; getPendingEntries is a count →
// "An entry whose owner owes decay adds the squaring": the fill counts and the
// settlement trim's covering sum must each add decayLegMaxBytes for a stale
// owner's entry. This file measures the actual settlement bytes a pool of
// stale-owner likes produces and compares it to what settlementMarginalBytes
// alone names; the GAP is `N × decayLegMaxBytes` to a close approximation,
// and the covering sum that reads only settlementMarginalBytes under-covers
// an overshoot made of those bytes.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, type KeyObject } from 'crypto';
import type Database from 'better-sqlite3';
import {
  LIKE_KARMA_COST,
  KARMA_DECAY_AMOUNT,
  MAX_SETTLEMENT_BYTES,
  PROTOCOL_VERSION,
  encodeTx,
} from '@dagsocial/types';
import type {
  AnyBox,
  IdentityRecord,
  KarmaBox,
  UtxoTransaction,
  PostCommit,
} from '@dagsocial/types';
import { buildBlockSettlement, decayLegMaxBytes, settlementMarginalBytes, treeStateView } from '@dagsocial/consensus';
import {
  makePostCommit,
  rawPublicKey,
  seedCommittedState,
  seedEmissionBox,
  seedKarmaPoolBox,
  seedProvenance,
  signTransaction,
} from '../helpers.js';

async function importDb() {
  return (await import('../../src/store/db.js')) as unknown as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

interface Identity {
  pub: Uint8Array;
  priv: KeyObject;
  pubHex: string;
}

function newIdentity(): Identity {
  const kp = generateKeyPairSync('ed25519');
  const pub = rawPublicKey(kp.publicKey);
  return { pub, priv: kp.privateKey, pubHex: Buffer.from(pub).toString('hex') };
}

const AUTHOR = new Uint8Array(32).fill(0x7a);

function targetPostCommit(): PostCommit {
  return makePostCommit(AUTHOR, 'stale owners target');
}

/** The stale owner's identity record: last activity and last decay at 0 fire
 *  decay the moment the target height clears the devnet threshold. */
function staleRecord(): IdentityRecord {
  return {
    lastActivityBlock: 0,
    lastDecayBlock: 0,
    invitedAtBlock: 0,
    lifetimeLikesReceived: 0n,
    memberSinceBlock: 0,
    memberBar: 0,
    memberVouches: 0,
    memberLikes: 0n,
    invitesUsed: 0,
  };
}

/** The height at which decay fires for every seeded identity under the devnet
 *  profile: threshold 500, interval 3. 501 catches each at owedPeriods > 0. */
const TARGET_HEIGHT = 501;

/** A karma value whose effective karma at TARGET_HEIGHT stays above the floor
 *  plus a like's cost: 167 periods × 5 karma per period = 835 reserved to the
 *  burn, plus the floor and a margin for the spend. */
const STALE_KARMA_VALUE = 2000n + KARMA_DECAY_AMOUNT * BigInt(Math.floor(TARGET_HEIGHT / 3));

function buildLikeNamingBoth(
  owner: Identity,
  own: KarmaBox,
  income: KarmaBox,
  postId: string,
): UtxoTransaction {
  const sum = own.value + income.value;
  const change = sum - LIKE_KARMA_COST;
  const outputs: AnyBox[] = [];
  if (change > 0n) {
    outputs.push({
      boxType: 'karma',
      value: change,
      createdAtBlock: 0,
      owner: owner.pub,
    } as unknown as AnyBox);
  }
  outputs.push({
    boxType: 'like_accrual',
    value: LIKE_KARMA_COST,
    createdAtBlock: 0,
    author: AUTHOR,
  } as unknown as AnyBox);
  const tx: UtxoTransaction = {
    inputs: [own.id!, income.id!],
    outputs,
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    likeTarget: postId,
  };
  signTransaction(tx, owner.priv, owner.pubHex);
  return tx;
}

describe('the fill counts a squaring for an entry whose owner owes decay', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(async () => {
    vi.resetModules();
    const db = await importDb();
    try { db.closeDb(); } catch { /* already closed */ }
  });

  it('decayLegMaxBytes names a non-zero width at the current era', () => {
    const bytes = decayLegMaxBytes(PROTOCOL_VERSION);
    // The leg is two inputs and one karma output at most. Its figure is on the
    // order of a hundred bytes and well below MAX_SETTLEMENT_BYTES, so a
    // reserve against it is finite — one more test of the shape before the
    // fill reads it.
    expect(bytes).toBeGreaterThan(100);
    expect(bytes).toBeLessThan(200);
  });

  // The actual settlement a pool of N stale-owner likes produces: the body
  // consumes every seeded owner's own and income boxes, so each owner's
  // post-body karma is one change box, and the settlement's decay leg per
  // owner is one input and one output (NODE_INTERFACE → Karma decay). The
  // test measures the real bytes against what settlementMarginalBytes alone
  // names: the GAP the covering sum does not price is the squarings' total,
  // and sums above the marginal-only answer by a wide margin — which is the
  // under-covering the rule exists to close.
  it('the settlement\'s actual bytes exceed what settlementMarginalBytes names by the squarings', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare(
      'INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)',
    ).run();
    // The settlement reads emission and the karma supply pool, so a store
    // without them yields no settlement at all.
    await seedEmissionBox();
    await seedKarmaPoolBox();

    const commit = targetPostCommit();
    const targetTxId = '9'.repeat(64);
    const targetPostId = '0000000000000000000000000000000000000000000000000000000000000001';
    await seedCommittedState({
      posts: [{ postId: targetPostId, txId: targetTxId, post: commit }],
    });

    // Enough identities that `N × (settlementMarginalBytes + the squaring's
    // actual bytes)` sits above MAX_SETTLEMENT_BYTES. One target post, one
    // author, so a settlement adds one marker input per like and one carry
    // output across the body.
    const N = 1000;
    const identities: Array<{ id: Identity; own: KarmaBox; income: KarmaBox }> = [];
    const boxMutations: Array<{ kind: 'box'; op: 'insert'; boxId: string; box: AnyBox }> = [];
    const recordMutations: Array<{ kind: 'record'; identityId: Uint8Array; record: IdentityRecord }> = [];
    for (let i = 0; i < N; i++) {
      const id = newIdentity();
      const own = seedProvenance<KarmaBox>({
        boxType: 'karma',
        value: STALE_KARMA_VALUE,
        createdAtBlock: 0,
        owner: id.pub,
      }, 0, 10_000 + i);
      const income = seedProvenance<KarmaBox>({
        boxType: 'karma',
        value: 5n,
        createdAtBlock: 0,
        owner: id.pub,
        income: true,
      }, 0, 20_000 + i);
      identities.push({ id, own, income });
      boxMutations.push(
        { kind: 'box', op: 'insert', boxId: own.id!, box: own },
        { kind: 'box', op: 'insert', boxId: income.id!, box: income },
      );
      recordMutations.push({ kind: 'record', identityId: id.pub, record: staleRecord() });
    }
    await seedCommittedState({ mutations: [...boxMutations, ...recordMutations] as never });

    const likeTxs: UtxoTransaction[] = identities.map(({ id, own, income }) =>
      buildLikeNamingBoth(id, own, income, targetPostId),
    );

    const { applyContextFrom } = await import('../../src/services/block-apply.js');
    const { config: nodeConfig } = await import('../../src/config.js');
    const { getAvlProver } = await import('../../src/state/avl-prover.js');
    const { proverSession } = await import('../../src/state/prover-session.js');
    const miner = newIdentity();
    const built = buildBlockSettlement(
      treeStateView(proverSession(getAvlProver().prover)),
      likeTxs.map((tx) => encodeTx(tx)),
      TARGET_HEIGHT,
      miner.pub,
      miner.pub,
      applyContextFrom(nodeConfig),
    );
    if ('error' in built) {
      throw new Error(`buildBlockSettlement failed: ${built.error}`);
    }
    const actualSettlementBytes = encodeTx(built.tx).length;

    // The empty-body settlement's bytes under this state — the baseline every
    // marginal is taken against.
    const baseline = buildBlockSettlement(
      treeStateView(proverSession(getAvlProver().prover)),
      [],
      TARGET_HEIGHT,
      miner.pub,
      miner.pub,
      applyContextFrom(nodeConfig),
    );
    const baselineBytes = 'tx' in baseline ? encodeTx(baseline.tx).length : 0;

    const perLikeMarginal = settlementMarginalBytes(likeTxs[0]!);
    const sumMarginal = N * perLikeMarginal;
    // The gap the covering sum does not price: actual growth beyond the
    // marginal-only sum, which is the squarings' total.
    const gap = (actualSettlementBytes - baselineBytes) - sumMarginal;
    const perEntrySquaring = gap / N;
    console.log(JSON.stringify({
      N,
      targetHeight: TARGET_HEIGHT,
      maxSettlementBytes: MAX_SETTLEMENT_BYTES,
      decayLegMaxBytes: decayLegMaxBytes(PROTOCOL_VERSION),
      perLikeMarginalBytes: perLikeMarginal,
      baselineBytes,
      actualSettlementBytes,
      sumMarginalOnly: sumMarginal,
      gapFromSquarings: gap,
      perEntrySquaring,
    }));

    // The actual settlement is over the bound by the squarings' bytes. The
    // covering sum the current trim reads sums settlementMarginalBytes only,
    // which under-covers the overshoot made of squaring bytes.
    expect(actualSettlementBytes).toBeGreaterThan(MAX_SETTLEMENT_BYTES);
    // Each stale owner's actual squaring is close to decayLegMaxBytes — within
    // a karma output's VLQ widening and the inputs' widths. The rule the next
    // commit writes reserves `decayLegMaxBytes` per such entry, which is the
    // ceiling and matches to within a few bytes.
    expect(perEntrySquaring).toBeGreaterThan(60);
    expect(perEntrySquaring).toBeLessThan(decayLegMaxBytes(PROTOCOL_VERSION) + 1);
    // The brief's claim is that the covering sum under-covers an overshoot
    // made of unpriced bytes. With `gap` bytes added by squarings and only
    // `perLikeMarginal` bytes per entry in the covering sum, dropping the
    // whole selection recovers at most `N × perLikeMarginal` from the sum —
    // which falls short of the gap if `gap > N × perLikeMarginal`. Assert the
    // under-covering, since this is the failure mode the rule exists to close.
    expect(gap).toBeGreaterThan(sumMarginal);
  });
});
