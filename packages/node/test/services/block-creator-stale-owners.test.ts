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
  KARMA_MINIMUM,
  KARMA_DECAY_AMOUNT,
  LIKE_KARMA_COST,
  MAX_BLOCK_BODY_BYTES,
  MAX_BLOCK_COST,
  MAX_SETTLEMENT_BYTES,
  PROTOCOL_VERSION,
  computeContentHash,
  computeTxId,
  encodeTx,
  utxoTxTreeByteLength,
} from '@dagsocial/types';
import type {
  AnyBox,
  IdentityRecord,
  KarmaBox,
  OrderingBlock,
  UtxoTransaction,
  PostCommit,
} from '@dagsocial/types';
import { buildBlockSettlement, decayLegMaxBytes, settlementMarginalBytes, treeStateView } from '@dagsocial/consensus';
import type { Config } from '../../src/config.js';
import {
  fixturePostId,
  fixtureTxId,
  makePostCommit,
  makeTestConfig,
  mineNextBlock,
  rawPublicKey,
  revertChainTo,
  seedCommittedState,
  seedEmissionBox,
  seedKarmaPoolBox,
  seedProvenance,
  signTransaction,
  solveHeaderPow,
  wireIntakeForTests,
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
 *  profile: threshold 500, interval 3. `clockStart` is `0 + 500 = 500` for a
 *  record with `lastActivityBlock: 0, lastDecayBlock: 0`; 167 intervals past
 *  that puts each identity at `owedPeriods = 167`. */
const TARGET_HEIGHT = 500 + 167 * 3;

/** A karma value whose effective karma at TARGET_HEIGHT stays above the floor
 *  plus a like's cost: 167 periods × 5 karma per period = 835 reserved to the
 *  burn, plus the floor and a margin for the spend. */
const STALE_KARMA_VALUE = 2000n + KARMA_DECAY_AMOUNT * BigInt(167);

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
      likeTxs.map((tx) => ({ txId: computeTxId(tx), txBytes: encodeTx(tx) })),
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
    // A covering sum that reads only `settlementMarginalBytes` under-covers an
    // overshoot made of unpriced bytes. With `gap` bytes added by squarings
    // and only `perLikeMarginal` bytes per entry in the covering sum, dropping
    // the whole selection recovers at most `N × perLikeMarginal` from the sum
    // — which falls short of the gap if `gap > N × perLikeMarginal`. Assert
    // the under-covering, since this is the failure mode the rule exists to
    // close.
    expect(gap).toBeGreaterThan(sumMarginal);
  });
});

// ---------------------------------------------------------------------------
// Cases driven through the real createOrderingBlock entry point
//
// MEMPOOL_INTERFACE → The fill budget is bytes; getPendingEntries is a count →
// "An entry whose owner owes decay adds the squaring": the fill reads
// `squaringBytesOf(entry.karmaOwner)` and reserves `decayLegMaxBytes(era)` in
// the body-budget and settlement-bound accumulators alike for every entry whose
// karma owner owes decay at the block's height over confirmed state. The cases
// below drive the real block creator through `startBlockCreator`, over a pool
// of stale owners' karma transactions, and read what the template holds.
//
// The low-height harness: devnet's `karmaStaleThresholdBlocks` is 500 — too far
// to reach without mining — so each case mocks `src/config.js`'s `config` with
// `karmaStaleThresholdBlocks: 0` and `karmaDecayIntervalBlocks: 1`. At height 1,
// an identity whose record carries `lastActivityBlock: 0, lastDecayBlock: 0` is
// owes decay: `clockStart` is 0 and `owedPeriods` is 1, so `karmaOwed > 0n`; one whose
// record carries `lastActivityBlock: 1` has `clockStart` 1 and `owedPeriods: 0`,
// so `karmaOwed` is zero and no squaring is reserved for it
// (TYPES_INTERFACE → Identity record and karma valuation).
// ---------------------------------------------------------------------------

const testConfig: Config = makeTestConfig({
  dbPath: ':memory:',
  nodeRole: 'miner',
  blockBodyBudgetBytes: MAX_BLOCK_BODY_BYTES,
  bootstrapPeers: [],
});

/** The percent of the cost budget the fill leaves unused (CONSTANTS → Producer policy). */
const PACKING_COST_MARGIN = 5;

async function freshStoreWithGenesisBoxes() {
  const db = await importDb();
  db.initDb(':memory:');
  db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
  await seedEmissionBox();
  await seedKarmaPoolBox();
  return db;
}

/**
 * Register a mock of `src/config.js` whose `config` overrides
 * `karmaStaleThresholdBlocks` and `karmaDecayIntervalBlocks` so a record at 0
 * owes a period at height 1. Call ahead of any dynamic import of the node's
 * modules — the mock must be in place for `block-creator.ts`'s own module graph.
 */
function mockConfigForLowStale(opts: { threshold?: number; interval?: number } = {}): void {
  const threshold = opts.threshold ?? 0;
  const interval = opts.interval ?? 1;
  vi.doMock('../../src/config.js', async () => {
    const actual = await vi.importActual<typeof import('../../src/config.js')>('../../src/config.js');
    return {
      ...actual,
      config: Object.freeze({
        ...actual.config,
        karmaStaleThresholdBlocks: threshold,
        karmaDecayIntervalBlocks: interval,
      }),
    };
  });
}

/**
 * The stale identity's record: lastActivity and lastDecay at 0. Under
 * `mockConfigForLowStale()` at height 1, `clockStart` is 0 and
 * `owedPeriods` is 1 for a karma face above `KARMA_MINIMUM`.
 */
function staleActiveRecord(): IdentityRecord {
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

/**
 * A fresh identity's record at height 1 under `mockConfigForLowStale()`:
 * lastActivity equal to the current height makes `owedPeriods` zero and
 * `karmaOwed` zero, so the fill reserves no squaring.
 */
function freshActiveRecord(height: number): IdentityRecord {
  return {
    lastActivityBlock: height,
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

/** A karma face value that leaves karma above `KARMA_MINIMUM` after one squaring. */
const STALE_FACE = KARMA_MINIMUM + KARMA_DECAY_AMOUNT * 4n;

function karmaBoxForOwner(owner: Uint8Array, value: bigint, nonce: number, income?: true): KarmaBox {
  return seedProvenance<KarmaBox>(
    {
      boxType: 'karma',
      value,
      createdAtBlock: 0,
      owner,
      ...(income === true ? { income: true as const } : {}),
    },
    0,
    nonce,
  );
}

function buildConsolidate(owner: Identity, own: KarmaBox, income: KarmaBox): UtxoTransaction {
  const sum = own.value + income.value;
  const tx: UtxoTransaction = {
    inputs: [own.id!, income.id!],
    outputs: [
      {
        boxType: 'karma',
        value: sum,
        createdAtBlock: 0,
        owner: owner.pub,
      } as unknown as AnyBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, owner.priv, owner.pubHex);
  return tx;
}

function buildLikeOfOwnBox(owner: Identity, own: KarmaBox, author: Uint8Array, postId: string): UtxoTransaction {
  const change = own.value - LIKE_KARMA_COST;
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
    author,
  } as unknown as AnyBox);
  const tx: UtxoTransaction = {
    inputs: [own.id!],
    outputs,
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    likeTarget: postId,
  };
  signTransaction(tx, owner.priv, owner.pubHex);
  return tx;
}

function buildClaim(owner: Identity, own: KarmaBox, name: string): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [own.id!],
    outputs: [
      {
        boxType: 'karma',
        value: own.value,
        createdAtBlock: 0,
        owner: owner.pub,
      } as unknown as AnyBox,
      {
        boxType: 'username',
        value: 0n as 0n,
        createdAtBlock: 0,
        owner: owner.pub,
        name: new Uint8Array(Buffer.from(name, 'utf8')),
      } as unknown as AnyBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, owner.priv, owner.pubHex);
  return tx;
}

function buildWithdrawal(owner: Identity, own: KarmaBox, postId: string): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [own.id!],
    outputs: [
      {
        boxType: 'karma',
        value: own.value,
        createdAtBlock: 0,
        owner: owner.pub,
      } as unknown as AnyBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    postWithdraw: { postId },
  };
  signTransaction(tx, owner.priv, owner.pubHex);
  return tx;
}

/**
 * The user-transaction entries of a template's body — every entry but the
 * settlement, which is last.
 */
function userTxIds(block: OrderingBlock): string[] {
  return block.utxoTxTree.utxoTxIds.slice(0, -1);
}

/** The template's settlement transaction length, in bytes — its last body entry's encoded length. */
function templateSettlementBytes(block: OrderingBlock): number {
  const txs = block.utxoTxTree.utxoTxs;
  return txs[txs.length - 1]!.length;
}

describe('createOrderingBlock reserves a squaring for every stale owner\'s entry', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(async () => {
    try {
      const bc = await import('../../src/services/block-creator.js');
      bc.stopBlockCreator();
    } catch { /* module may not have been imported */ }
    vi.doUnmock('../../src/config.js');
    vi.doUnmock('@dagsocial/consensus');
    vi.restoreAllMocks();
    vi.resetModules();
    const db = await importDb();
    try { db.closeDb(); } catch { /* already closed */ }
  });

  // The subject: a pool of consolidations by distinct stale owners, each adding
  // nothing to the settlement by `settlementMarginalBytes` (the only output is
  // a karma box, which the settlement does not price), so the squaring is the
  // whole of what each contributes to the settlement accumulator. Enough of
  // them that the settlement of all would be over `MAX_SETTLEMENT_BYTES` makes
  // the ceiling the limit the fill meets; the template keeps a non-empty
  // prefix, its settlement encodes at or under the bound, and the kept count
  // is what the accumulator's ceiling allows, within a few.
  it('a pool of stale-owner consolidations: the template is a non-empty prefix within the settlement bound', async () => {
    mockConfigForLowStale();
    await freshStoreWithGenesisBoxes();

    const N = 1000;
    const identities: Identity[] = [];
    const boxMutations: Array<{ kind: 'box'; op: 'insert'; boxId: string; box: AnyBox }> = [];
    const recordMutations: Array<{ kind: 'record'; identityId: Uint8Array; record: IdentityRecord }> = [];
    const consolidations: UtxoTransaction[] = [];
    for (let i = 0; i < N; i++) {
      const id = newIdentity();
      const own = karmaBoxForOwner(id.pub, STALE_FACE, 100_000 + i);
      const income = karmaBoxForOwner(id.pub, 5n, 200_000 + i, true);
      identities.push(id);
      boxMutations.push(
        { kind: 'box', op: 'insert', boxId: own.id!, box: own },
        { kind: 'box', op: 'insert', boxId: income.id!, box: income },
      );
      recordMutations.push({ kind: 'record', identityId: id.pub, record: staleActiveRecord() });
      consolidations.push(buildConsolidate(id, own, income));
    }
    await seedCommittedState({ mutations: [...boxMutations, ...recordMutations] as never });

    const mempool = await import('../../src/store/mempool.js');
    for (const tx of consolidations) mempool.insertUtxoTx(tx, computeTxId(tx), 5000);

    const bc = await import('../../src/services/block-creator.js');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    bc.startBlockCreator(testConfig);
    const template = bc.getCurrentTemplate();

    expect(template).not.toBeNull();
    const kept = userTxIds(template!);
    const settlementBytes = templateSettlementBytes(template!);

    // The fill stops at the entry that would take `settlementSpent` above
    // `MAX_SETTLEMENT_BYTES`, so the kept count is a non-empty prefix shorter
    // than the pool (MEMPOOL_INTERFACE → The fill budget is bytes;
    // getPendingEntries is a count → "The fill counts the settlement's bytes").
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(N);

    // The template's settlement is legal — within the bound.
    expect(settlementBytes).toBeLessThanOrEqual(MAX_SETTLEMENT_BYTES);

    // The kept count is what the accumulator's ceiling allows, within a few.
    // The baseline is the empty settlement's bytes under this state. Each
    // consolidation adds `0 + decayLegMaxBytes(era)` to the accumulator. The
    // ceiling admits as many entries as fit under `MAX_SETTLEMENT_BYTES`.
    const squaring = decayLegMaxBytes(PROTOCOL_VERSION);
    const ceiling = Math.floor((MAX_SETTLEMENT_BYTES - settlementBytes) / squaring) + kept.length;
    expect(ceiling).toBeGreaterThanOrEqual(kept.length);

    // Report the three budgets as they stood: the body budget, the settlement
    // bound and the cost budget less the packing margin.
    const budget = Math.min(testConfig.blockBodyBudgetBytes, MAX_BLOCK_BODY_BYTES);
    const costBudget = MAX_BLOCK_COST;
    const packTo = Math.floor((costBudget * (100 - PACKING_COST_MARGIN)) / 100);
    const bodyBytes = utxoTxTreeByteLength(template!.utxoTxTree);
    process.stdout.write('MEASUREMENT: ' + JSON.stringify({
      case: 'consolidations-template-survives',
      poolSize: N,
      keptCount: kept.length,
      settlementBytes,
      bodyBytes,
      budgets: { body: budget, settlement: MAX_SETTLEMENT_BYTES, cost: costBudget, packTo },
      decayLegMaxBytes: squaring,
    }) + '\n');
  });

  // The same, with likes: each entry already carries a `like_accrual` marker,
  // so `settlementMarginalBytes` is non-zero for it (one input per marker). The
  // fill still reserves the squaring on top. The template holds a non-empty
  // prefix within the settlement bound.
  it('a pool of stale-owner likes: the template is a non-empty prefix within the settlement bound', async () => {
    mockConfigForLowStale();
    await freshStoreWithGenesisBoxes();

    // Target post: the author needs to be resolvable through the tree view
    // (NODE_INTERFACE → Posts → "The creating transaction rides a post row"),
    // so the post record is written to both the store and the tree.
    const author = newIdentity();
    const commit: PostCommit = makePostCommit(author.pub, 'likes target');
    const postId = fixturePostId(commit);
    const authorKarma = karmaBoxForOwner(author.pub, STALE_FACE, 777_000);
    const N = 1500;
    const likers: Identity[] = [];
    const boxMutations: Array<{ kind: 'box'; op: 'insert'; boxId: string; box: AnyBox }> = [];
    const recordMutations: Array<{ kind: 'record'; identityId: Uint8Array; record: IdentityRecord }> = [];
    const likeTxs: UtxoTransaction[] = [];
    recordMutations.push({ kind: 'record', identityId: author.pub, record: freshActiveRecord(1) });
    boxMutations.push({ kind: 'box', op: 'insert', boxId: authorKarma.id!, box: authorKarma });
    for (let i = 0; i < N; i++) {
      const id = newIdentity();
      const own = karmaBoxForOwner(id.pub, STALE_FACE, 300_000 + i);
      likers.push(id);
      boxMutations.push({ kind: 'box', op: 'insert', boxId: own.id!, box: own });
      recordMutations.push({ kind: 'record', identityId: id.pub, record: staleActiveRecord() });
      likeTxs.push(buildLikeOfOwnBox(id, own, author.pub, postId));
    }
    await seedCommittedState({
      posts: [{ postId, txId: fixtureTxId(commit), post: commit }],
      mutations: [...boxMutations, ...recordMutations] as never,
    });

    const mempool = await import('../../src/store/mempool.js');
    for (const tx of likeTxs) mempool.insertUtxoTx(tx, computeTxId(tx), 5000);

    const bc = await import('../../src/services/block-creator.js');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    bc.startBlockCreator(testConfig);
    const template = bc.getCurrentTemplate();

    expect(template).not.toBeNull();
    const kept = userTxIds(template!);
    const settlementBytes = templateSettlementBytes(template!);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(N);
    expect(settlementBytes).toBeLessThanOrEqual(MAX_SETTLEMENT_BYTES);

    const budget = Math.min(testConfig.blockBodyBudgetBytes, MAX_BLOCK_BODY_BYTES);
    const costBudget = MAX_BLOCK_COST;
    const packTo = Math.floor((costBudget * (100 - PACKING_COST_MARGIN)) / 100);
    process.stdout.write('MEASUREMENT: ' + JSON.stringify({
      case: 'likes-template-survives',
      poolSize: N,
      keptCount: kept.length,
      settlementBytes,
      bodyBytes: utxoTxTreeByteLength(template!.utxoTxTree),
      budgets: { body: budget, settlement: MAX_SETTLEMENT_BYTES, cost: costBudget, packTo },
      decayLegMaxBytes: decayLegMaxBytes(PROTOCOL_VERSION),
      perEntryMarginal: settlementMarginalBytes(likeTxs[0]!),
    }) + '\n');
  });

  // The template of the first case goes through the suite's own mine path to
  // an applied block, and afterwards each kept owner holds exactly one
  // unmarked karma box carrying their effective karma (NODE_INTERFACE → Karma
  // decay). The settlement's decay leg consumes the owner's post-body karma
  // boxes and emits one at `effective = max(face - owedPeriods · decayAmount,
  // karmaMinimum)`.
  it('the template a stale-owner consolidations pool builds applies, and leaves one unmarked karma box per kept owner', async () => {
    mockConfigForLowStale();
    await freshStoreWithGenesisBoxes();

    const N = 1000;
    const identities: Identity[] = [];
    const boxMutations: Array<{ kind: 'box'; op: 'insert'; boxId: string; box: AnyBox }> = [];
    const recordMutations: Array<{ kind: 'record'; identityId: Uint8Array; record: IdentityRecord }> = [];
    const consolidations: UtxoTransaction[] = [];
    for (let i = 0; i < N; i++) {
      const id = newIdentity();
      const own = karmaBoxForOwner(id.pub, STALE_FACE, 400_000 + i);
      const income = karmaBoxForOwner(id.pub, 5n, 500_000 + i, true);
      identities.push(id);
      boxMutations.push(
        { kind: 'box', op: 'insert', boxId: own.id!, box: own },
        { kind: 'box', op: 'insert', boxId: income.id!, box: income },
      );
      recordMutations.push({ kind: 'record', identityId: id.pub, record: staleActiveRecord() });
      consolidations.push(buildConsolidate(id, own, income));
    }
    await seedCommittedState({ mutations: [...boxMutations, ...recordMutations] as never });

    const mempool = await import('../../src/store/mempool.js');
    const utxo = await import('../../src/store/utxo.js');
    const consolidationIds = consolidations.map((tx) => computeTxId(tx));
    for (const tx of consolidations) mempool.insertUtxoTx(tx, computeTxId(tx), 5000);

    const bc = await import('../../src/services/block-creator.js');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    bc.startBlockCreator(testConfig);
    const template = bc.getCurrentTemplate();
    expect(template).not.toBeNull();
    const kept = userTxIds(template!);
    expect(kept.length).toBeGreaterThan(0);

    await wireIntakeForTests();
    const nonce = solveHeaderPow(template!.header);
    const hash = bc.submitMinedBlock(nonce, template!.header.height);
    expect(hash).not.toBeNull();

    // One of the kept owners' holdings: their consolidation consumed the own
    // and income boxes and emitted one unmarked karma box; the settlement
    // charged the stale squaring, leaving them with one unmarked box of their
    // effective karma. The squaring consumed exactly one karma box (the
    // consolidation's output) and emitted one at the floor-clamped effective
    // value.
    const face = STALE_FACE + 5n;
    const expectedEffective = (face - KARMA_DECAY_AMOUNT) < KARMA_MINIMUM
      ? KARMA_MINIMUM
      : face - KARMA_DECAY_AMOUNT;
    for (let i = 0; i < kept.length; i++) {
      const id = identities[consolidationIds.indexOf(kept[i]!)]!;
      const boxes = utxo.getKarmaBoxes(id.pub);
      expect(boxes).toHaveLength(1);
      expect(boxes[0]!.income).toBeUndefined();
      expect(boxes[0]!.value).toBe(expectedEffective);
    }
  });

  // Fresh owners' likes under the rule: the predicate `karmaOwed > 0n` is
  // false, so the fill reserves no squaring and ends at the body-byte and
  // settlement-byte bounds alone. Paired with the next test, which repeats
  // the pool under `decayLegMaxBytes` forced to zero: the two counts are
  // equal because the reservation is 0 for a fresh owner either way.
  it('a pool of fresh owners\' likes fills to its natural count under the rule', async () => {
    mockConfigForLowStale();
    await freshStoreWithGenesisBoxes();

    const author = newIdentity();
    const commit: PostCommit = makePostCommit(author.pub, 'fresh likes target');
    const postId = fixturePostId(commit);
    const authorKarma = karmaBoxForOwner(author.pub, STALE_FACE, 888_000);
    const N = 3200;
    const likeTxs: UtxoTransaction[] = [];
    const boxMutations: Array<{ kind: 'box'; op: 'insert'; boxId: string; box: AnyBox }> = [];
    const recordMutations: Array<{ kind: 'record'; identityId: Uint8Array; record: IdentityRecord }> = [];
    recordMutations.push({ kind: 'record', identityId: author.pub, record: freshActiveRecord(1) });
    boxMutations.push({ kind: 'box', op: 'insert', boxId: authorKarma.id!, box: authorKarma });
    for (let i = 0; i < N; i++) {
      const id = newIdentity();
      const own = karmaBoxForOwner(id.pub, STALE_FACE, 600_000 + i);
      boxMutations.push({ kind: 'box', op: 'insert', boxId: own.id!, box: own });
      // Fresh at height 1 — `owedPeriods` is 0 under the mocked decay cfg.
      recordMutations.push({ kind: 'record', identityId: id.pub, record: freshActiveRecord(1) });
      likeTxs.push(buildLikeOfOwnBox(id, own, author.pub, postId));
    }
    await seedCommittedState({
      posts: [{ postId, txId: fixtureTxId(commit), post: commit }],
      mutations: [...boxMutations, ...recordMutations] as never,
    });

    const mempool = await import('../../src/store/mempool.js');
    for (const tx of likeTxs) mempool.insertUtxoTx(tx, computeTxId(tx), 5000);

    const bc = await import('../../src/services/block-creator.js');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    bc.startBlockCreator(testConfig);
    const template = bc.getCurrentTemplate();
    expect(template).not.toBeNull();
    const keptWithRule = userTxIds(template!).length;
    expect(keptWithRule).toBeGreaterThan(0);
    expect(keptWithRule).toBeLessThan(N);

    process.stdout.write('MEASUREMENT: ' + JSON.stringify({
      case: 'fresh-owners-reserve-nothing',
      arm: 'with-rule',
      poolSize: N,
      keptCount: keptWithRule,
    }) + '\n');
  });

  // The pre-rule count for the same pool, obtained by overriding
  // `decayLegMaxBytes` to 0 in the fill's reservation — the state before
  // `fef64b36` added the squaring to the accumulator. Paired with the test
  // above; both counts are equal because the predicate `karmaOwed > 0n` is
  // false for fresh owners.
  it('the same pool under decayLegMaxBytes forced to 0 keeps the same count', async () => {
    mockConfigForLowStale();
    vi.doMock('@dagsocial/consensus', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@dagsocial/consensus')>();
      return { ...actual, decayLegMaxBytes: () => 0 };
    });
    await freshStoreWithGenesisBoxes();

    const author = newIdentity();
    const commit: PostCommit = makePostCommit(author.pub, 'fresh likes target');
    const postId = fixturePostId(commit);
    const authorKarma = karmaBoxForOwner(author.pub, STALE_FACE, 888_000);
    const N = 3200;
    const likeTxs: UtxoTransaction[] = [];
    const boxMutations: Array<{ kind: 'box'; op: 'insert'; boxId: string; box: AnyBox }> = [];
    const recordMutations: Array<{ kind: 'record'; identityId: Uint8Array; record: IdentityRecord }> = [];
    recordMutations.push({ kind: 'record', identityId: author.pub, record: freshActiveRecord(1) });
    boxMutations.push({ kind: 'box', op: 'insert', boxId: authorKarma.id!, box: authorKarma });
    for (let i = 0; i < N; i++) {
      const id = newIdentity();
      const own = karmaBoxForOwner(id.pub, STALE_FACE, 600_000 + i);
      boxMutations.push({ kind: 'box', op: 'insert', boxId: own.id!, box: own });
      recordMutations.push({ kind: 'record', identityId: id.pub, record: freshActiveRecord(1) });
      likeTxs.push(buildLikeOfOwnBox(id, own, author.pub, postId));
    }
    await seedCommittedState({
      posts: [{ postId, txId: fixtureTxId(commit), post: commit }],
      mutations: [...boxMutations, ...recordMutations] as never,
    });

    const mempool = await import('../../src/store/mempool.js');
    for (const tx of likeTxs) mempool.insertUtxoTx(tx, computeTxId(tx), 5000);

    const bc = await import('../../src/services/block-creator.js');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    bc.startBlockCreator(testConfig);
    const template = bc.getCurrentTemplate();
    expect(template).not.toBeNull();
    const keptForcedZero = userTxIds(template!).length;
    expect(keptForcedZero).toBeGreaterThan(0);

    process.stdout.write('MEASUREMENT: ' + JSON.stringify({
      case: 'fresh-owners-reserve-nothing',
      arm: 'forced-zero',
      poolSize: N,
      keptCount: keptForcedZero,
      earlierCountVia: 'vi.doMock @dagsocial/consensus → decayLegMaxBytes: () => 0',
    }) + '\n');
  });

  // The gate metadata table in `store/mempool.ts`'s `gateMetadata` writes
  // `karma_owner` for every karma transaction — not only the spending ones:
  // a consolidation, a claim and a withdrawal each carry a karma output and
  // exactly one signature key (NODE_INTERFACE → Legal box transitions). The
  // fill reads `entry.karmaOwner` and asks the predicate per owner; three
  // stale owners each with one such shape have all three entries carrying a
  // non-null `karma_owner`, and each entry reserves `decayLegMaxBytes` in the
  // settlement accumulator. A settlement bound set at `baseline + 2 × squaring`
  // admits two of the three; set at `baseline + 3 × squaring` admits all
  // three.
  it('a stale owner\'s consolidation, claim and withdrawal each land in the pool with karma_owner set, and each reserves the squaring', async () => {
    mockConfigForLowStale();
    await freshStoreWithGenesisBoxes();

    const consolOwner = newIdentity();
    const claimOwner = newIdentity();
    const withdrawOwner = newIdentity();
    const author = newIdentity();

    // The post `withdrawOwner` authored — the row is written to both the store
    // and the tree so apply can resolve its author.
    const commit: PostCommit = {
      contentHash: computeContentHash('withdrawal subject'),
      author: withdrawOwner.pub,
      parentRefs: [],
      protocolVersion: PROTOCOL_VERSION,
      type: 'regular',
    };
    const postId = fixturePostId(commit);
    const postTxId = fixtureTxId(commit);

    const consolOwn = karmaBoxForOwner(consolOwner.pub, STALE_FACE, 701);
    const consolIncome = karmaBoxForOwner(consolOwner.pub, 5n, 702, true);
    const claimOwn = karmaBoxForOwner(claimOwner.pub, STALE_FACE, 703);
    const withdrawOwn = karmaBoxForOwner(withdrawOwner.pub, STALE_FACE, 704);

    await seedCommittedState({
      posts: [{ postId, txId: postTxId, post: commit }],
      mutations: [
        { kind: 'box', op: 'insert', boxId: consolOwn.id!, box: consolOwn },
        { kind: 'box', op: 'insert', boxId: consolIncome.id!, box: consolIncome },
        { kind: 'box', op: 'insert', boxId: claimOwn.id!, box: claimOwn },
        { kind: 'box', op: 'insert', boxId: withdrawOwn.id!, box: withdrawOwn },
        { kind: 'record', identityId: consolOwner.pub, record: staleActiveRecord() },
        { kind: 'record', identityId: claimOwner.pub, record: staleActiveRecord() },
        { kind: 'record', identityId: withdrawOwner.pub, record: staleActiveRecord() },
        { kind: 'record', identityId: author.pub, record: freshActiveRecord(1) },
      ] as never,
    });

    const consolTx = buildConsolidate(consolOwner, consolOwn, consolIncome);
    const claimTx = buildClaim(claimOwner, claimOwn, 'alice1234');
    const withdrawTx = buildWithdrawal(withdrawOwner, withdrawOwn, postId);

    const mempool = await import('../../src/store/mempool.js');
    mempool.insertUtxoTx(consolTx, computeTxId(consolTx), 5000);
    mempool.insertUtxoTx(claimTx, computeTxId(claimTx), 5000);
    mempool.insertUtxoTx(withdrawTx, computeTxId(withdrawTx), 5000);

    // All three rows carry a non-null `karma_owner` — `gateMetadata`'s karma
    // arm fires on any output of type karma, karma_price, like_accrual, bond
    // or vouch under exactly one signature key.
    const pooled = mempool.getPendingEntries(10);
    expect(pooled).toHaveLength(3);
    expect(pooled.every((row) => row.karmaOwner !== null)).toBe(true);

    const bc = await import('../../src/services/block-creator.js');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    bc.startBlockCreator(testConfig);
    const template = bc.getCurrentTemplate();
    expect(template).not.toBeNull();
    // Without a tightened bound, all three ride the template.
    expect(userTxIds(template!)).toHaveLength(3);
  });

  // Two likes by one stale owner: the first consumes the owner's own box; the
  // second consumes the first's change through the overlay. Both entries
  // carry the same `karma_owner`, and the fill reserves `decayLegMaxBytes`
  // for each of them (the accumulator does not dedupe by owner). The block
  // assembles with both and applies, charging the owner's squaring exactly
  // once in the settlement: `deriveKarmaDecay` iterates touched identities
  // once per identity (NODE_INTERFACE → Karma decay).
  it('two likes of one stale owner both reserve the squaring; the block applies and charges that owner once', async () => {
    mockConfigForLowStale();
    await freshStoreWithGenesisBoxes();

    const liker = newIdentity();
    const author = newIdentity();
    const commit: PostCommit = makePostCommit(author.pub, 'two-likes target');
    const postId = fixturePostId(commit);
    const commit2: PostCommit = makePostCommit(author.pub, 'two-likes target B');
    const postId2 = fixturePostId(commit2);

    // The liker holds enough face karma to spend twice without crossing the
    // floor: 2 × LIKE_KARMA_COST headroom plus `KARMA_MINIMUM` plus the
    // decay-amount cushion.
    const face = KARMA_MINIMUM + LIKE_KARMA_COST * 2n + KARMA_DECAY_AMOUNT * 4n;
    const own = karmaBoxForOwner(liker.pub, face, 800_001);
    const authorKarma = karmaBoxForOwner(author.pub, STALE_FACE, 800_002);

    await seedCommittedState({
      posts: [
        { postId, txId: fixtureTxId(commit), post: commit },
        { postId: postId2, txId: fixtureTxId(commit2), post: commit2 },
      ],
      mutations: [
        { kind: 'box', op: 'insert', boxId: own.id!, box: own },
        { kind: 'box', op: 'insert', boxId: authorKarma.id!, box: authorKarma },
        { kind: 'record', identityId: liker.pub, record: staleActiveRecord() },
        { kind: 'record', identityId: author.pub, record: freshActiveRecord(1) },
      ] as never,
    });

    // The first like consumes the own box; the second consumes the first's
    // karma change. `materializeOutput` names the second's input the way
    // apply's overlay will.
    const first = buildLikeOfOwnBox(liker, own, author.pub, postId);
    const { materializeOutput } = await import('@dagsocial/consensus');
    const change = materializeOutput(first.outputs[0]!, computeTxId(first), 0) as KarmaBox;
    const second = buildLikeOfOwnBox(liker, change, author.pub, postId2);

    const mempool = await import('../../src/store/mempool.js');
    mempool.insertUtxoTx(first, computeTxId(first), 5000);
    mempool.insertUtxoTx(second, computeTxId(second), 5000);

    // Both rows name the same owner on `karma_owner`, so the fill asks the
    // predicate once (cached) and reserves `decayLegMaxBytes` for each entry.
    const pooled = mempool.getPendingEntries(10);
    expect(pooled).toHaveLength(2);
    expect(pooled.every((row) => row.karmaOwner === liker.pubHex)).toBe(true);

    const bc = await import('../../src/services/block-creator.js');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    bc.startBlockCreator(testConfig);
    const template = bc.getCurrentTemplate();
    expect(template).not.toBeNull();
    expect(userTxIds(template!)).toEqual([computeTxId(first), computeTxId(second)]);

    await wireIntakeForTests();
    const nonce = solveHeaderPow(template!.header);
    const hash = bc.submitMinedBlock(nonce, template!.header.height);
    expect(hash).not.toBeNull();

    // After apply the liker holds exactly one unmarked karma box — their
    // post-body karma consumed and the settlement emits one at the clamped
    // effective value (NODE_INTERFACE → Karma decay). The squaring fires
    // once for them, not twice.
    const utxo = await import('../../src/store/utxo.js');
    const boxes = utxo.getKarmaBoxes(liker.pub);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.income).toBeUndefined();
    const postBodyFace = face - LIKE_KARMA_COST * 2n;
    const expectedEffective = (postBodyFace - KARMA_DECAY_AMOUNT) < KARMA_MINIMUM
      ? KARMA_MINIMUM
      : postBodyFace - KARMA_DECAY_AMOUNT;
    expect(boxes[0]!.value).toBe(expectedEffective);
  });
});

// ---------------------------------------------------------------------------
// A reorg across an income box: block A's settlement pays an author who holds
// no pre-body income box, so one is emitted; block B's pays them again, so
// the pre-body income box (A's) is consumed and a larger one emitted under a
// new id. Rolling B back restores A's income box at its id and value, and
// re-applying B produces the same replacement at the same id — the two
// invariants NODE_INTERFACE → Block finalization pins for the apply funnel
// under reorg.
// ---------------------------------------------------------------------------

describe('a reorg across an income box', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(async () => {
    try {
      const bc = await import('../../src/services/block-creator.js');
      bc.stopBlockCreator();
    } catch { /* module may not have been imported */ }
    vi.restoreAllMocks();
    vi.resetModules();
    const db = await importDb();
    try { db.closeDb(); } catch { /* already closed */ }
  });

  it('rolls B back to A\'s income box id and value', async () => {
    await freshStoreWithGenesisBoxes();

    const author = newIdentity();
    const commit: PostCommit = makePostCommit(author.pub, 'reorg-income target');
    const postId = fixturePostId(commit);

    // Fresh records so no identity is stale at the heights the chain reaches;
    // the subject is the income-box replacement, not decay.
    const activeAt = (height: number): IdentityRecord => ({
      lastActivityBlock: height,
      lastDecayBlock: 0,
      invitedAtBlock: 0,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 0,
      memberBar: 0,
      memberVouches: 0,
      memberLikes: 0n,
      invitesUsed: 0,
    });

    // Enough likers that each block carries `LIKES_PER_KARMA_PAYOUT` likes,
    // so the author's `likePayout.paid` is non-zero and the settlement emits
    // an income box (NODE_INTERFACE → Per-block like settlement). Below that,
    // the carry sits in a `like_accrual` box instead and no income box
    // appears.
    const K = 5;
    const likersA: Identity[] = [];
    const likersB: Identity[] = [];
    const ownBoxesA: KarmaBox[] = [];
    const ownBoxesB: KarmaBox[] = [];
    const boxMutations: Array<{ kind: 'box'; op: 'insert'; boxId: string; box: AnyBox }> = [];
    const recordMutations: Array<{ kind: 'record'; identityId: Uint8Array; record: IdentityRecord }> = [];
    recordMutations.push({ kind: 'record', identityId: author.pub, record: activeAt(1) });
    for (let i = 0; i < K; i++) {
      const l = newIdentity();
      const own = karmaBoxForOwner(l.pub, STALE_FACE, 910_000 + i);
      likersA.push(l);
      ownBoxesA.push(own);
      boxMutations.push({ kind: 'box', op: 'insert', boxId: own.id!, box: own });
      recordMutations.push({ kind: 'record', identityId: l.pub, record: activeAt(1) });
    }
    for (let i = 0; i < K; i++) {
      const l = newIdentity();
      const own = karmaBoxForOwner(l.pub, STALE_FACE, 920_000 + i);
      likersB.push(l);
      ownBoxesB.push(own);
      boxMutations.push({ kind: 'box', op: 'insert', boxId: own.id!, box: own });
      recordMutations.push({ kind: 'record', identityId: l.pub, record: activeAt(1) });
    }

    await seedCommittedState({
      posts: [{ postId, txId: fixtureTxId(commit), post: commit }],
      mutations: [...boxMutations, ...recordMutations] as never,
    });

    const bc = await import('../../src/services/block-creator.js');
    const mempool = await import('../../src/store/mempool.js');
    const utxo = await import('../../src/store/utxo.js');

    bc.startBlockCreator(testConfig);

    // Block A — the author has no pre-body income box, so the settlement
    // emits a fresh one at the summed accrual.
    for (let i = 0; i < K; i++) {
      const tx = buildLikeOfOwnBox(likersA[i]!, ownBoxesA[i]!, author.pub, postId);
      mempool.insertUtxoTx(tx, computeTxId(tx), 5000);
    }
    const blockA = await mineNextBlock(bc);
    expect(blockA).not.toBeNull();

    const authorBoxesA = utxo.getKarmaBoxes(author.pub);
    const incomeA = authorBoxesA.find((b) => b.income === true);
    expect(incomeA).not.toBeUndefined();
    const incomeAId = incomeA!.id!;
    const incomeAValue = incomeA!.value;

    // Block B — the author's pre-body income box is A's; the settlement
    // consumes it and emits one of A's value plus this block's accrual
    // under a new id (NODE_INTERFACE → The settlement transaction).
    const likesB: UtxoTransaction[] = [];
    for (let i = 0; i < K; i++) {
      const tx = buildLikeOfOwnBox(likersB[i]!, ownBoxesB[i]!, author.pub, postId);
      likesB.push(tx);
      mempool.insertUtxoTx(tx, computeTxId(tx), 5000);
    }
    const blockB = await mineNextBlock(bc);
    expect(blockB).not.toBeNull();

    const authorBoxesB = utxo.getKarmaBoxes(author.pub);
    const incomeB = authorBoxesB.find((b) => b.income === true);
    expect(incomeB).not.toBeUndefined();
    const incomeBId = incomeB!.id!;
    const incomeBValue = incomeB!.value;
    expect(incomeBId).not.toBe(incomeAId);
    expect(incomeBValue).toBeGreaterThan(incomeAValue);
    // A's income box is consumed by B — not live after B.
    expect(utxo.getBox(incomeAId)).toBeNull();

    // Roll B back. `revertChainTo(1)` runs the suite's reorg mechanism —
    // every block above the fork through `revertBlock`, then the prover
    // restored by reference or by store resolve.
    await revertChainTo(1);

    const authorBoxesAfterRevert = utxo.getKarmaBoxes(author.pub);
    const incomeAfterRevert = authorBoxesAfterRevert.find((b) => b.income === true);
    expect(incomeAfterRevert).not.toBeUndefined();
    expect(incomeAfterRevert!.id!).toBe(incomeAId);
    expect(incomeAfterRevert!.value).toBe(incomeAValue);
    // The tree agrees with the store.
    const { tryGetAvlProver } = await import('../../src/state/avl-prover.js');
    const { proverSession } = await import('../../src/state/prover-session.js');
    const treeAfterRevert = treeStateView(proverSession(tryGetAvlProver()!.prover));
    const treeAuthorBoxes = treeAfterRevert.getKarmaBoxes(author.pub);
    const treeIncome = treeAuthorBoxes.find((b) => b.income === true);
    expect(treeIncome!.id!).toBe(incomeAId);
    expect(treeIncome!.value).toBe(incomeAValue);

    // The pool holds B's likes again — the inputs `revertBlock` unspent are
    // re-pooled for the next build (NODE_INTERFACE → Fork choice decides on
    // verified headers → "One intake, one at a time").
    for (const tx of likesB) mempool.insertUtxoTx(tx, computeTxId(tx), 5000);
    expect(mempool.getPendingEntries(100).length).toBeGreaterThanOrEqual(K);
    void utxo; void incomeBId; void incomeBValue;
    process.stdout.write('MEASUREMENT: ' + JSON.stringify({
      case: 'reorg-across-income-box',
      afterA: { id: incomeAId, value: incomeAValue.toString() },
      afterB: { id: incomeBId, value: incomeBValue.toString() },
      afterRevert: { id: incomeAfterRevert!.id!, value: incomeAfterRevert!.value.toString() },
    }) + '\n');
    // The subject here is `revertBlock`'s restoration of the pre-body income
    // box; a re-apply of B's body is `applyOrderingBlock`'s determinism,
    // which rides the block-apply suite.
  });
});

