// MEMPOOL_INTERFACE → The fill budget is bytes; getPendingEntries is a count →
// "An entry whose marker pays an author who owes decay adds that author's
// squaring": the fill counts and the settlement trim's covering sum must each
// add decayLegMaxBytes for every distinct author a marker names who owes decay
// over confirmed state. These three cases drive the real block creator through
// `createOrderingBlock` and assert the fill reserves the author's squaring.

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
  computeTxId,
  utxoTxTreeByteLength,
} from '@dagsocial/types';
import { decayLegMaxBytes, settlementMarginalBytes } from '@dagsocial/consensus';
import type {
  AnyBox,
  IdentityRecord,
  KarmaBox,
  OrderingBlock,
  UtxoTransaction,
  PostCommit,
} from '@dagsocial/types';
import type { Config } from '../../src/config.js';
import {
  fixturePostId,
  fixtureTxId,
  makePostCommit,
  makeTestConfig,
  rawPublicKey,
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

const testConfig: Config = makeTestConfig({
  dbPath: ':memory:',
  nodeRole: 'miner',
  blockBodyBudgetBytes: MAX_BLOCK_BODY_BYTES,
  bootstrapPeers: [],
});

/**
 * Register a mock of `src/config.js` whose `config` overrides
 * `karmaStaleThresholdBlocks` and `karmaDecayIntervalBlocks` so a record at 0
 * owes a period at height 1.
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

/** The stale record: `owedPeriods` is 1 at height 1 under `mockConfigForLowStale()`. */
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

/** A fresh record at `height`: `owedPeriods` is 0 under `mockConfigForLowStale()`. */
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

function userTxIds(block: OrderingBlock): string[] {
  return block.utxoTxTree.utxoTxIds.slice(0, -1);
}

async function freshStoreWithGenesisBoxes() {
  const db = await importDb();
  db.initDb(':memory:');
  db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
  await seedEmissionBox();
  await seedKarmaPoolBox();
  return db;
}

/**
 * Build a pool of `N` likes by fresh distinct likers, each targeting a post
 * authored by `author`, insert them into the pool, and return the resulting
 * template's kept count.
 */
async function fillLikesToOneAuthor(
  author: Identity,
  authorRecord: IdentityRecord,
  N: number,
): Promise<number> {
  const commit: PostCommit = makePostCommit(author.pub, 'author-reservation target');
  const postId = fixturePostId(commit);
  const authorKarma = karmaBoxForOwner(author.pub, STALE_FACE, 999_000);
  const likers: Identity[] = [];
  const boxMutations: Array<{ kind: 'box'; op: 'insert'; boxId: string; box: AnyBox }> = [];
  const recordMutations: Array<{ kind: 'record'; identityId: Uint8Array; record: IdentityRecord }> = [];
  const likeTxs: UtxoTransaction[] = [];
  recordMutations.push({ kind: 'record', identityId: author.pub, record: authorRecord });
  boxMutations.push({ kind: 'box', op: 'insert', boxId: authorKarma.id!, box: authorKarma });
  for (let i = 0; i < N; i++) {
    const id = newIdentity();
    const own = karmaBoxForOwner(id.pub, STALE_FACE, 500_000 + i);
    likers.push(id);
    boxMutations.push({ kind: 'box', op: 'insert', boxId: own.id!, box: own });
    // Fresh at height 1 — the liker owes nothing.
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
  return userTxIds(template!).length;
}

/** Teardown shared with every case here. */
async function teardown(): Promise<void> {
  try {
    const bc = await import('../../src/services/block-creator.js');
    bc.stopBlockCreator();
  } catch { /* module may not have been imported */ }
  vi.doUnmock('../../src/config.js');
  vi.restoreAllMocks();
  vi.resetModules();
  const db = await importDb();
  try { db.closeDb(); } catch { /* already closed */ }
}

describe('createOrderingBlock reserves one squaring per distinct author a marker pays who owes decay', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(teardown);

  // Under the author reservation the fresh-liker pool to a STALE author
  // fills to fewer entries than the twin pool to a FRESH author. Each like
  // adds a `decayLegMaxBytes` reservation under the first arm and nothing
  // under the second. The two pools are otherwise identical.
  it('a fresh-liker pool to a stale author fills to fewer entries than the twin pool to a fresh author', async () => {
    const N = 1500;

    // Arm A — stale author.
    mockConfigForLowStale();
    await freshStoreWithGenesisBoxes();
    const staleAuthor = newIdentity();
    const keptStale = await fillLikesToOneAuthor(staleAuthor, staleActiveRecord(), N);
    await teardown();

    // Arm B — fresh author.
    mockConfigForLowStale();
    await freshStoreWithGenesisBoxes();
    const freshAuthor = newIdentity();
    const keptFresh = await fillLikesToOneAuthor(freshAuthor, freshActiveRecord(1), N);

    expect(keptStale).toBeLessThan(keptFresh);
  });

  // The author predicate is read once per author per build. A pool of
  // `N` likes by distinct fresh likers to one stale author drives one build
  // through `createOrderingBlock`; a spy on the store's `getKarmaValue`
  // keyed by the author's bytes counts one call, not `N`.
  it('the author predicate is read once per author per build however many entries pay them', async () => {
    const N = 5;
    mockConfigForLowStale();
    await freshStoreWithGenesisBoxes();

    const author = newIdentity();
    const commit: PostCommit = makePostCommit(author.pub, 'author-cache target');
    const postId = fixturePostId(commit);
    const authorKarma = karmaBoxForOwner(author.pub, STALE_FACE, 999_100);
    const boxMutations: Array<{ kind: 'box'; op: 'insert'; boxId: string; box: AnyBox }> = [];
    const recordMutations: Array<{ kind: 'record'; identityId: Uint8Array; record: IdentityRecord }> = [];
    const likeTxs: UtxoTransaction[] = [];
    recordMutations.push({ kind: 'record', identityId: author.pub, record: staleActiveRecord() });
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

    // Spy on `getKarmaValue` through the store barrel the fill imports from.
    // One hex key is the author's; the fill reads it to decide the author's
    // squaring under the author-reservation rule.
    const storeIndex = await import('../../src/store/index.js');
    const authorHex = Buffer.from(author.pub).toString('hex');
    const authorKarmaReads = { count: 0 };
    const original = storeIndex.getKarmaValue;
    vi.spyOn(storeIndex, 'getKarmaValue').mockImplementation((owner: Uint8Array) => {
      if (Buffer.from(owner).toString('hex') === authorHex) authorKarmaReads.count++;
      return original(owner);
    });

    const bc = await import('../../src/services/block-creator.js');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    bc.startBlockCreator(testConfig);
    const template = bc.getCurrentTemplate();
    expect(template).not.toBeNull();
    expect(authorKarmaReads.count).toBe(1);
  });

  // A pool of likes to DISTINCT stale authors by fresh likers builds a
  // template whose settlement encodes at or under `MAX_SETTLEMENT_BYTES`,
  // and the block it builds applies (no `body-rejected`), its cost under
  // `MAX_BLOCK_COST`. Without the author reservation the fill selects more
  // entries than the bound admits and the sizer's covering sum under-covers
  // the overshoot, so the template holds no user entries at all.
  it('a pool of likes to distinct stale authors by fresh likers builds a non-empty template within the settlement bound', async () => {
    // Pool N is above the fill's natural ceiling under the author reservation
    // (~675 entries at `MAX_SETTLEMENT_BYTES / (settlementMarginalBytes +
    // decayLegMaxBytes)`), so the fill's settlement-bound check is the
    // binding one and the cost estimate does not stop it short.
    const N = 3000;
    mockConfigForLowStale();
    await freshStoreWithGenesisBoxes();

    const authors: Identity[] = [];
    const posts: Array<{ postId: string; txId: string; post: PostCommit }> = [];
    const boxMutations: Array<{ kind: 'box'; op: 'insert'; boxId: string; box: AnyBox }> = [];
    const recordMutations: Array<{ kind: 'record'; identityId: Uint8Array; record: IdentityRecord }> = [];
    const likeTxs: UtxoTransaction[] = [];
    for (let i = 0; i < N; i++) {
      const author = newIdentity();
      authors.push(author);
      const commit: PostCommit = makePostCommit(author.pub, `distinct-authors target ${i}`);
      const postId = fixturePostId(commit);
      posts.push({ postId, txId: fixtureTxId(commit), post: commit });
      const authorKarma = karmaBoxForOwner(author.pub, STALE_FACE, 700_000 + i);
      boxMutations.push({ kind: 'box', op: 'insert', boxId: authorKarma.id!, box: authorKarma });
      recordMutations.push({ kind: 'record', identityId: author.pub, record: staleActiveRecord() });

      const liker = newIdentity();
      const own = karmaBoxForOwner(liker.pub, STALE_FACE, 800_000 + i);
      boxMutations.push({ kind: 'box', op: 'insert', boxId: own.id!, box: own });
      recordMutations.push({ kind: 'record', identityId: liker.pub, record: freshActiveRecord(1) });
      likeTxs.push(buildLikeOfOwnBox(liker, own, author.pub, postId));
    }
    await seedCommittedState({
      posts,
      mutations: [...boxMutations, ...recordMutations] as never,
    });

    const mempool = await import('../../src/store/mempool.js');
    // A low cost estimate per entry keeps the fill's cost-estimate check from
    // stopping it short of the settlement-bound check — the predicate under
    // test is the settlement-bound one, under the author-squaring reservation.
    for (const tx of likeTxs) mempool.insertUtxoTx(tx, computeTxId(tx), 5000, 1);

    const bc = await import('../../src/services/block-creator.js');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    bc.startBlockCreator(testConfig);
    const template = bc.getCurrentTemplate();
    expect(template).not.toBeNull();

    const kept = userTxIds(template!);
    const settlementBytes = template!.utxoTxTree.utxoTxs[template!.utxoTxTree.utxoTxs.length - 1]!.length;
    expect(kept.length).toBeGreaterThan(0);

    // The template's settlement is within the bound.
    expect(settlementBytes).toBeLessThanOrEqual(MAX_SETTLEMENT_BYTES);

    // The block applies — no `body-rejected`. Submit through the mined path.
    await wireIntakeForTests();
    const nonce = solveHeaderPow(template!.header);
    const hash = bc.submitMinedBlock(nonce, template!.header.height);
    expect(hash).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Measurements the MEMPOOL marker names — `block-creator-stale-owners.test.ts`
// pools re-run with every owner AND every author owing decay, and a like pool
// whose likers owe nothing but whose authors all do (MEMPOOL_INTERFACE → The
// fill budget is bytes; getPendingEntries is a count).
// ---------------------------------------------------------------------------

describe('measurements for the fill under the author-squaring reservation', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(teardown);

  it('every owner and every author owing decay: a 1500-like pool', async () => {
    mockConfigForLowStale();
    await freshStoreWithGenesisBoxes();

    const author = newIdentity();
    const commit: PostCommit = makePostCommit(author.pub, 'measurement authors');
    const postId = fixturePostId(commit);
    const authorKarma = karmaBoxForOwner(author.pub, STALE_FACE, 900_000);
    const N = 1500;
    const boxMutations: Array<{ kind: 'box'; op: 'insert'; boxId: string; box: AnyBox }> = [];
    const recordMutations: Array<{ kind: 'record'; identityId: Uint8Array; record: IdentityRecord }> = [];
    const likeTxs: UtxoTransaction[] = [];
    recordMutations.push({ kind: 'record', identityId: author.pub, record: staleActiveRecord() });
    boxMutations.push({ kind: 'box', op: 'insert', boxId: authorKarma.id!, box: authorKarma });
    for (let i = 0; i < N; i++) {
      const id = newIdentity();
      const own = karmaBoxForOwner(id.pub, STALE_FACE, 920_000 + i);
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
    const settlementBytes = template!.utxoTxTree.utxoTxs[template!.utxoTxTree.utxoTxs.length - 1]!.length;
    const bodyBytes = utxoTxTreeByteLength(template!.utxoTxTree);
    process.stdout.write('MEASUREMENT: ' + JSON.stringify({
      case: 'stale-owners-stale-author-likes',
      poolSize: N,
      keptCount: kept.length,
      settlementBytes,
      bodyBytes,
      decayLegMaxBytes: decayLegMaxBytes(PROTOCOL_VERSION),
      perEntryMarginal: settlementMarginalBytes(likeTxs[0]!),
      budgets: { body: MAX_BLOCK_BODY_BYTES, settlement: MAX_SETTLEMENT_BYTES, cost: MAX_BLOCK_COST },
    }) + '\n');
  });

  it('every liker owes nothing and every author owes decay: a 3000-like pool to distinct authors', async () => {
    mockConfigForLowStale();
    await freshStoreWithGenesisBoxes();

    const N = 3000;
    const boxMutations: Array<{ kind: 'box'; op: 'insert'; boxId: string; box: AnyBox }> = [];
    const recordMutations: Array<{ kind: 'record'; identityId: Uint8Array; record: IdentityRecord }> = [];
    const posts: Array<{ postId: string; txId: string; post: PostCommit }> = [];
    const likeTxs: UtxoTransaction[] = [];
    for (let i = 0; i < N; i++) {
      const author = newIdentity();
      const commit: PostCommit = makePostCommit(author.pub, `measurement author ${i}`);
      const postId = fixturePostId(commit);
      posts.push({ postId, txId: fixtureTxId(commit), post: commit });
      const authorKarma = karmaBoxForOwner(author.pub, STALE_FACE, 940_000 + i);
      boxMutations.push({ kind: 'box', op: 'insert', boxId: authorKarma.id!, box: authorKarma });
      recordMutations.push({ kind: 'record', identityId: author.pub, record: staleActiveRecord() });

      const liker = newIdentity();
      const own = karmaBoxForOwner(liker.pub, STALE_FACE, 970_000 + i);
      boxMutations.push({ kind: 'box', op: 'insert', boxId: own.id!, box: own });
      recordMutations.push({ kind: 'record', identityId: liker.pub, record: freshActiveRecord(1) });
      likeTxs.push(buildLikeOfOwnBox(liker, own, author.pub, postId));
    }
    await seedCommittedState({
      posts,
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
    const settlementBytes = template!.utxoTxTree.utxoTxs[template!.utxoTxTree.utxoTxs.length - 1]!.length;
    const bodyBytes = utxoTxTreeByteLength(template!.utxoTxTree);
    process.stdout.write('MEASUREMENT: ' + JSON.stringify({
      case: 'fresh-likers-stale-authors-distinct',
      poolSize: N,
      keptCount: kept.length,
      settlementBytes,
      bodyBytes,
      decayLegMaxBytes: decayLegMaxBytes(PROTOCOL_VERSION),
      perEntryMarginal: settlementMarginalBytes(likeTxs[0]!),
      budgets: { body: MAX_BLOCK_BODY_BYTES, settlement: MAX_SETTLEMENT_BYTES, cost: MAX_BLOCK_COST },
    }) + '\n');
  });
});
