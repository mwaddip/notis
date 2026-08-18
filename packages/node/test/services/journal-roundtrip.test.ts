import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  computeBoxId,
  computePostId,
  computeTxId,
  encodePost,
  POST_LOCK_REPLY_COST,
  PROTOCOL_VERSION,
  MAX_BLOCK_BODY_BYTES,
} from '@dagsocial/types';
import type {
  CandidateOf,
  CreditBox,
  VouchEscrowBox,
  KarmaBox,
  OrderingBlock,
  Post,
  PostLockBox,
  Stump,
  UtxoTransaction,
} from '@dagsocial/types';
import type { StoredPost } from '../../src/store/posts.js';
import type Database from 'better-sqlite3';
import type { Config } from '../../src/config.js';
import {
  changeBoxOf,
  fixturePostId,
  fixtureProvenance,
  hex,
  lockBoxOf,
  makeApplicableBlock,
  makeKarmaBox,
  makePost,
  seedPostTx,
  makePruneEntry,
  makeTestConfig,
  makeTestIdentity,
  mineNextBlock,
  seedProvenance,
  signTransaction,
  type TestIdentity,
  activateProverOverStore,
} from '../helpers.js';

// ---------------------------------------------------------------------------
// Spec B P1 acceptance: per-mutation-class apply → revert → re-apply
// round-trips (NODE_INTERFACE "Rollback (revertBlock)").
//
// Every test drives a REAL block through applyOrderingBlock — the funnel — so
// the journal under test is the one the store choke point recorded, never a
// hand-built fixture. Reverts go through the real reorg path. Three
// assertions per class:
//
//   1. DB identity — utxo_boxes plus the side tables (like_records,
//      identity_records)
//      equal their pre-block rows exactly.
//   2. Digest identity — with the ACTIVE prover singleton (the instance
//      tryGetAvlProver() hands to block-apply §13), the digest after revert
//      equals the pre-block digest.
//   3. Re-apply identity — applying the same block again succeeds and lands
//      on the same post-block digest as the first application.
//
// Fixture discipline: every seeded box is inserted BEFORE the prover is
// bootstrapped, so the AVL tree and the DB agree from height 0 on. After
// bootstrap, boxes only ever change through applied blocks. All reverts
// target fork heights ≥ 1 (height 0 holds two versions: the constructor's
// empty tree and the bootstrap tree).
// ---------------------------------------------------------------------------

// Every field below is kept verbatim; `makeTestConfig` fills only the thirteen
// `Config` requires this literal never stated. Hazard removal, not error removal:
// as a bare literal its type is what `startBlockCreator`'s parameter was declared
// against, so a newly-required `Config` field would have gone unnoticed here.
const plainConfig = makeTestConfig({
  port: 3000,
  dbPath: ':memory:',
  networkType: 'testnet' as const,
  nodeRole: 'miner' as const,
  blockBodyBudgetBytes: MAX_BLOCK_BODY_BYTES,
  orderingBlockPowTargetBits: 3072,
  bootstrapPeers: [] as string[],
  listenAddrs: '/ip4/127.0.0.1/tcp/0',
  maxPeers: 50,
});

// ---------------------------------------------------------------------------
// Dynamic import helpers
// ---------------------------------------------------------------------------

type DbModule = {
  initDb: (path: string) => void;
  getDb: () => Database.Database;
  closeDb: () => void;
};

async function importDb(): Promise<DbModule> {
  return (await import('../../src/store/db.js')) as unknown as DbModule;
}

async function importBlockCreator() {
  return (await import('../../src/services/block-creator.js')) as unknown as {
    startBlockCreator: (cfg: Config) => void;
    stopBlockCreator: () => void;
    createOrderingBlock: () => OrderingBlock | null;
    getCurrentTemplate: () => OrderingBlock | null;
    submitMinedBlock: (powNonce: number, submittedHeight: number) => string | null;
  };
}

async function importBlockApply() {
  return (await import('../../src/services/block-apply.js')) as unknown as {
    applyOrderingBlock: (block: OrderingBlock) => boolean;
    computePostBlockStateRoot: (
      block: OrderingBlock,
      height: number,
    ) => import('../../src/services/block-apply.js').StateRootSpeculation;
  };
}

async function importForkResolution() {
  return (await import('../../src/services/fork-resolution.js')) as unknown as {
    reorg: (forkHeight: number, newBlocks: OrderingBlock[]) => void;
  };
}

async function importAvl() {
  return (await import('../../src/state/avl-prover.js')) as
    typeof import('../../src/state/avl-prover.js');
}

async function importPosts() {
  return (await import('../../src/store/posts.js')) as {
    insertPost: (postId: string, post: Post, rawCbor: Uint8Array) => void;
    getPost: (id: string) => StoredPost | Stump | null;
  };
}

async function importMempool() {
  return (await import('../../src/store/mempool.js')) as {
    insertUtxoTx: (tx: UtxoTransaction, expiresAtHeight: number) => number;
    getPendingEntries: (limit: number) => Array<{ entryType: string }>;
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown, postLockTarget?: string) => void;
    getBox: (boxId: string) => { id?: string; value: bigint } | null;
    getKarmaBox: (owner: Uint8Array) => KarmaBox | null;
    getKarmaValue: (owner: Uint8Array) => bigint;
    getCreditBoxes: (owner: Uint8Array) => CreditBox[];
    getEmissionBox: () => { id?: string; value: bigint } | null;
    getUnspentBoxes: () => import('@dagsocial/types').AnyBox[];
  };
}

/** The escrow store, which is now the box store (ARCHITECTURE → Vouch boxes). */
async function importVouch() {
  return (await import('../../src/store/utxo.js')) as unknown as {
    getVouchEscrowsFor: (
      voucherId: Uint8Array,
    ) => Array<{ value: bigint; owner: Uint8Array; releaseAtBlock: number }>;
  };
}

async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as {
    getCurrentHeight: () => number;
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** utxo_boxes + every side table a mutation class touches, in stable order. */
function dumpState(db: Database.Database) {
  return {
    boxes: db.prepare('SELECT * FROM utxo_boxes ORDER BY id').all(),
    // ⛔ **The vouch escrow needs no row here.** It is a box, so it is already
    // in `boxes` above, and it round-trips through the journal's own
    // `{kind:'box'}` inverses rather than through a hand-written side-record.
    // ✅ **Every piece of block-application state this dumps is inside the
    // `stateRoot`** (ARCHITECTURE → Vouch boxes).
    // P2-D N3b: prune settlement deletes the subtree's like-records, so "DB
    // identity after revert" has to cover the table (mirrors the
    // like-settlement suite's dumpState).
    likeRecords: db
      .prepare('SELECT * FROM like_records ORDER BY target_post_id, liker_id')
      .all(),
    // Spec G phase D: identity records are the second **committed** entity, so
    // "DB identity after revert" has to cover them. Every class that mints
    // non-decay karma now writes one, which is most of them — leaving this out
    // would let a record survive a revert unnoticed in all of them.
    identityRecords: db
      .prepare('SELECT * FROM identity_records ORDER BY identity_id')
      .all(),
  };
}

/** Persisted journal rows — the speculative state-root run must add none. */
function journalHeights(db: Database.Database): number[] {
  return (
    db.prepare('SELECT block_height FROM block_journal ORDER BY block_height').all() as Array<{
      block_height: number;
    }>
  ).map((r) => r.block_height);
}

/**
 * Activate the AVL prover singleton on the test DB and (when boxes were
 * seeded) bootstrap them into the tree — the production startup wiring from
 * src/index.ts. Returns the handle whose digest §13 of block-apply advances.
 */
async function activateProver() {
  // Ordering lives in the shared helper: committed state into the store, then
  // the tree built from it (helpers.ts → `activateProverOverStore`).
  const handle = await activateProverOverStore();
  expect((await importAvl()).tryGetAvlProver()).not.toBeNull();
  return handle;
}

function digestOf(handle: { prover: { digest(): Uint8Array | null } }): Uint8Array {
  const d = handle.prover.digest();
  expect(d).not.toBeNull();
  return new Uint8Array(d!);
}

interface Snapshot {
  height: number;
  state: ReturnType<typeof dumpState>;
  digest: Uint8Array;
}

function takeSnapshot(
  db: DbModule,
  handle: { prover: { digest(): Uint8Array | null } },
  height: number,
): Snapshot {
  return { height, state: dumpState(db.getDb()), digest: digestOf(handle) };
}

/**
 * The shared tail of every class test: revert the class block through the
 * real reorg path and check all three P1 acceptance properties, plus the
 * P3/H-6 property that rides on the same restored pre-state — the digest the
 * producer computes speculatively equals the one the real apply produces.
 */
async function assertRoundTrip(
  db: DbModule,
  handle: { prover: { digest(): Uint8Array | null } },
  pre: Snapshot,
  classBlock: OrderingBlock,
): Promise<void> {
  const postDigest = digestOf(handle);
  // Non-vacuity: the class block must have moved the prover.
  expect(Buffer.from(postDigest).equals(Buffer.from(pre.digest))).toBe(false);

  // Revert through the real reorg path.
  const forkResolution = await importForkResolution();
  forkResolution.reorg(pre.height, []);

  const ordering = await importOrdering();
  expect(ordering.getCurrentHeight()).toBe(pre.height);

  // 1. DB identity — exact pre-block rows, spent markers included.
  expect(dumpState(db.getDb())).toEqual(pre.state);

  // 2. Digest identity — the active prover is back at the pre-block digest.
  expect(Buffer.from(digestOf(handle)).equals(Buffer.from(pre.digest))).toBe(true);

  // 2b. Speculation identity (P3/H-6) — on this restored pre-state, the digest
  //     the producer computes *without applying anything* is the digest step 3
  //     below actually lands on. That is what makes `header.stateRoot`
  //     checkable: producer and verifier run one implementation of the state
  //     transition, not two.
  const blockApply = await importBlockApply();
  const journalsBefore = journalHeights(db.getDb());
  const speculative = blockApply.computePostBlockStateRoot(
    classBlock,
    classBlock.header.height,
  );
  expect(speculative).toEqual({
    kind: 'computed',
    stateRoot: Buffer.from(postDigest).toString('hex'),
  });
  // …and it is what the producer committed to before mining, so a verifier
  // running VERIFY_STATE_ROOT accepts exactly the blocks a producer builds.
  expect(classBlock.header.stateRoot).toBe(Buffer.from(postDigest).toString('hex'));

  // 2c. …and it left no trace: its transaction rolled back, the prover was
  //     restored by hand (SQLite rollback cannot reach it), and it persisted
  //     no journal row.
  expect(dumpState(db.getDb())).toEqual(pre.state);
  expect(Buffer.from(digestOf(handle)).equals(Buffer.from(pre.digest))).toBe(true);
  expect(journalHeights(db.getDb())).toEqual(journalsBefore);

  // 3. Re-apply identity — the same block applies again onto the restored
  //    state and lands on the same post-block digest.
  expect(blockApply.applyOrderingBlock(classBlock)).toBe(true);
  expect(Buffer.from(digestOf(handle)).equals(Buffer.from(postDigest))).toBe(true);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('journal round-trip per mutation class (P1 acceptance)', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch {
      // Module might not have been imported
    }
    vi.resetModules();
  });

  // -----------------------------------------------------------------------
  // Coinbase — an OUTPUT of the block's settlement transaction, so revert must
  // undo the credit box it created and restore the emission box it spent.
  //
  // ⛔ **There is no merge, and that is the change.** `mintCredits` consumed
  // the owner's pre-existing credit boxes and wrote one merged successor; a
  // settlement output is a new box beside whatever the owner already held
  // (MINING_INTERFACE → Coinbase Application: the credits are spent from the
  // `EmissionBox` by the transaction that emits them). What revert has to
  // restore is therefore an emission predecessor, not a merged-in original.
  // -----------------------------------------------------------------------

  it('coinbase: the settlement\'s credit output and the emission it spent are both reverted', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const minerB = makeTestIdentity();
    const utxo = await importUtxo();
    const seeded = seedProvenance<CreditBox>({
      boxType: 'credit',
      value: 100n,
      createdAtBlock: 0,
      owner: minerB.userId,
    }, 1);
    utxo.insertBox(seeded);

    const handle = await activateProver();
    const blockApply = await importBlockApply();

    // Baseline block 1 pays a fresh miner — minerB's box is untouched.
    expect(blockApply.applyOrderingBlock(await makeApplicableBlock())).toBe(true);
    const pre = takeSnapshot(db, handle, 1);
    const emissionBefore = utxo.getEmissionBox()!;

    // Class block: the settlement pays minerB.
    const classBlock = await makeApplicableBlock({ height: 2, miner: minerB });
    expect(blockApply.applyOrderingBlock(classBlock)).toBe(true);

    // The seeded box is untouched — a settlement output merges nothing.
    expect(utxo.getBox(seeded.id!)).not.toBeNull();
    const boxes = utxo.getCreditBoxes(minerB.userId);
    expect(boxes).toHaveLength(2);
    expect(boxes.reduce((sum, b) => sum + b.value, 0n)).toBeGreaterThan(100n);

    // And the emission box moved to a successor, which the revert must undo.
    expect(utxo.getEmissionBox()!.id).not.toBe(emissionBefore.id);

    await assertRoundTrip(db, handle, pre, classBlock);
  });

  // -----------------------------------------------------------------------
  // User tx — a signed credit transfer embedded in the block.
  // -----------------------------------------------------------------------

  it('user-tx: credit transfer inputs unspent and outputs gone after revert', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const sender = makeTestIdentity();
    const recipient = makeTestIdentity();
    const utxo = await importUtxo();

    const senderBox = seedProvenance<CreditBox>({
      boxType: 'credit',
      value: 100n,
      createdAtBlock: 0,
      owner: sender.userId,
    }, 1);
    utxo.insertBox(senderBox);

    const handle = await activateProver();
    const bc = await importBlockCreator();
    bc.startBlockCreator(plainConfig);

    await mineNextBlock(bc); // height 1 baseline
    const pre = takeSnapshot(db, handle, 1);

    // Signed, value-conserving credit transfer: 40 to the recipient, 60 change.
    const tx: UtxoTransaction = {
      inputs: [senderBox.id!],
      outputs: [
        {
          boxType: 'credit',
          value: 40n,
          createdAtBlock: 0,
          owner: recipient.userId,
        } as CreditBox,
        {
          boxType: 'credit',
          value: 60n,
          createdAtBlock: 0,
          owner: sender.userId,
        } as CreditBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, sender.privateKey, hex(sender.userId));

    const mempool = await importMempool();
    mempool.insertUtxoTx(tx, 1000);

    const classBlock = await mineNextBlock(bc); // height 2 carries the tx
    expect(classBlock).not.toBeNull();
    expect(classBlock!.utxoTxTree.utxoTxIds).toContain(computeTxId(tx));

    expect(utxo.getBox(senderBox.id!)).toBeNull(); // spent
    expect(utxo.getCreditBoxes(recipient.userId)).toHaveLength(1);

    await assertRoundTrip(db, handle, pre, classBlock!);
  });

  // -----------------------------------------------------------------------
  // Prune settlement — consumes every PostLockBox in the subtree, merge-mints
  // a refund to the owners other than the pruning author, whose own lock burns
  // (ARCHITECTURE → "Prune lifecycle"), and deletes the subtree's like-records
  // (P2-D N3b: no liker leg — a like's karma was burned at cast and nothing is
  // refunded); revert restores the settled rows and the records exactly.
  // A mixed subtree, so the round-trip covers both legs: the reply author's
  // merge-mint and the pruner's mintless burn. (Extends the Phase B
  // block-apply revert test with digest + re-apply identity.)
  // -----------------------------------------------------------------------

  it('prune settlement: settled boxes, merge-consumed karma, and like-records restored', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const replier = makeTestIdentity();
    const liker = makeTestIdentity();
    const utxo = await importUtxo();
    const posts = await importPosts();
    const likes = (await import('../../src/store/likes.js')) as {
      insertLikeRecord: (targetPostId: string, likerId: Uint8Array, blockHeight: number) => void;
      hasLikeRecord: (targetPostId: string, likerId: Uint8Array) => boolean;
    };

    // ⛔ The lock boxes are MINTED by the post transactions, not seeded. A post
    // and its lock are one transaction (NODE_INTERFACE → Post transactions), so
    // a fixture that seeded a `PostLockBox` beside a separately-inserted post
    // would settle a pairing the chain never made.
    const { tx: postTx, postId } = await seedPostTx(author, 'prune round-trip victim');
    const { tx: replyTx, postId: replyId } = await seedPostTx(
      replier, 'somebody else in the same thread', { parentRefs: [postId] },
    );

    const handle = await activateProver();
    const blockApply = await importBlockApply();

    // Block 1 carries both post transactions — that is what stores the posts,
    // records `block_topology` (which prune authorization reads) and mints the
    // two locks. Only the replier's karma is a merge target: the pruning
    // author's own lock burns and mints nothing to merge into.
    const confirmBlock = await makeApplicableBlock({ utxoTxs: [postTx, replyTx] });
    expect(blockApply.applyOrderingBlock(confirmBlock)).toBe(true);
    // Attribution: the block APPLIED both transactions rather than deferring and
    // skipping them, which is the shape that leaves every assertion below
    // measuring an empty chain.
    expect(posts.getPost(postId)).not.toBeNull();
    expect(posts.getPost(replyId)).not.toBeNull();
    const lockBox = lockBoxOf(postTx);
    const replyLockBox = lockBoxOf(replyTx);
    expect(utxo.getBox(lockBox.id!)).not.toBeNull();
    expect(utxo.getBox(replyLockBox.id!)).not.toBeNull();
    // The change boxes the two post transactions left behind — 1 karma each,
    // and the replier's is the merge target the refund lands in.
    const authorChange = changeBoxOf(postTx);
    const replierChange = changeBoxOf(replyTx);
    // A like applied at block 1 — seeded with no journal open, so the
    // seeding records nothing. Part of the pre-state the revert must restore.
    likes.insertLikeRecord(postId, liker.userId, 1);
    const pre = takeSnapshot(db, handle, 1);

    const classBlock = await makeApplicableBlock({
      height: 2,
      pruneEntries: [makePruneEntry(postId, [postId, replyId], author)],
    });
    expect(blockApply.applyOrderingBlock(classBlock)).toBe(true);

    // Settled: both locks consumed by the settlement. The replier is refunded
    // their lock; the pruning author's own lock goes to the POOL, leaving their
    // 1 karma of change untouched. ⚠ **No merge** — the settlement emits a fresh
    // karma output rather than consolidating, so the replier's change box stands
    // and the BALANCE carries the claim.
    expect(utxo.getBox(lockBox.id!)).toBeNull();
    expect(utxo.getBox(replyLockBox.id!)).toBeNull();
    expect(utxo.getBox(replierChange.id!)).not.toBeNull();
    expect(utxo.getKarmaValue(replier.userId)).toBe(1n + POST_LOCK_REPLY_COST);
    expect(utxo.getBox(authorChange.id!)).not.toBeNull();
    expect(utxo.getKarmaValue(author.userId)).toBe(1n);
    expect(utxo.getKarmaBox(liker.userId)).toBeNull();
    expect(likes.hasLikeRecord(postId, liker.userId)).toBe(false);
    // Every consumption and the record deletion are in the journal the revert
    // below replays.
    const journalStore = (await import('../../src/store/journal.js')) as {
      getBlockJournal: (h: number) => import('../../src/store/journal.js').BlockJournal | null;
    };
    const saved = journalStore.getBlockJournal(2)!;
    expect(
      saved.mutations
        .filter((m) => m.kind === 'box' && m.op === 'remove')
        .map((m) => (m as { boxId: string }).boxId),
    // ⚠ **The replier's change box is NOT among them.** Nothing consolidates it
    // any more, so the settlement consumes the two locks and nothing else.
    ).toEqual(expect.arrayContaining([lockBox.id, replyLockBox.id]));
    expect(saved.likeRecordDeletions).toEqual([
      { targetPostId: postId, likerId: liker.userId, appliedAtBlock: 1 },
    ]);

    await assertRoundTrip(db, handle, pre, classBlock);

    // The re-applied block leaves the same settled state again. Balances, not
    // boxes — the settlement emits rather than consolidates.
    expect(utxo.getKarmaValue(replier.userId)).toBe(1n + POST_LOCK_REPLY_COST);
    expect(utxo.getKarmaValue(author.userId)).toBe(1n);
    expect(utxo.getBox(lockBox.id!)).toBeNull();
    expect(utxo.getBox(replyLockBox.id!)).toBeNull();
    expect(likes.hasLikeRecord(postId, liker.userId)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // The escrow release — the matured `VouchEscrowBox` is consumed and its karma
  // emitted by the settlement; revert restores the box. ⛔ H-7's hand-written
  // side-record and inverse are deleted rather than ported: a box journals
  // through `insertBox`/`consumeBox` with exact inverses already.
  // (Extends the Phase B fork-resolution revert test with the reorg path,
  // digest identity, and re-apply identity.)
  // -----------------------------------------------------------------------

  it('the escrow survives its release height — the settlement does not sweep it', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const voucher = makeTestIdentity();
    const target = makeTestIdentity();
    const utxo = await importUtxo();
    const vouch = await importVouch();

    const oldKarma = makeKarmaBox(50n, voucher.userId, 0);
    utxo.insertBox(oldKarma);
    utxo.insertBox(
      seedProvenance<VouchEscrowBox>(
        {
          boxType: 'vouch_escrow' as const,
          value: 7n,
          createdAtBlock: 0,
          owner: voucher.userId,
          releaseAtBlock: 2,
        },
        1,
        86,
      ),
    );

    const handle = await activateProver();
    const blockApply = await importBlockApply();

    expect(blockApply.applyOrderingBlock(await makeApplicableBlock())).toBe(true);
    expect(vouch.getVouchEscrowsFor(voucher.userId)).toHaveLength(1);
    const pre = takeSnapshot(db, handle, 1);

    const classBlock = await makeApplicableBlock({ height: 2 });
    expect(blockApply.applyOrderingBlock(classBlock)).toBe(true);

    // The escrow SURVIVES — the owner reclaims it via a user transaction.
    expect(vouch.getVouchEscrowsFor(voucher.userId)).toHaveLength(1);
    expect(utxo.getKarmaValue(voucher.userId)).toBe(50n);

    await assertRoundTrip(db, handle, pre, classBlock);

    // The re-applied block leaves the same applied state again.
    expect(utxo.getKarmaValue(voucher.userId)).toBe(50n);
    expect(vouch.getVouchEscrowsFor(voucher.userId)).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // Decay — block-level, reached by shrinking the thresholds through a
  // test-local mock of the config module so a 4-block chain crosses the
  // staleness window. The env overrides these tests used before P2-A were
  // the consensus violation the network profile removed; a module mock is a
  // seam only a test can reach — a running node has no equivalent.
  // -----------------------------------------------------------------------

  it('decay: consumed karma boxes and the decay-burn box round-trip', async () => {
    try {
      vi.doMock('../../src/config.js', async () => {
        const actual = await vi.importActual<typeof import('../../src/config.js')>(
          '../../src/config.js',
        );
        return {
          ...actual,
          config: Object.freeze({
            ...actual.config,
            karmaStaleThresholdBlocks: 3,
            karmaDecayIntervalBlocks: 1,
          }),
        };
      });
      vi.resetModules(); // re-import the module graph against the mocked config

      const db = await importDb();
      db.initDb(':memory:');

      const idle = makeTestIdentity();
      const utxo = await importUtxo();
      const oldBox = makeKarmaBox(50n, idle.userId, 0);
      utxo.insertBox(oldBox);

      const handle = await activateProver();
      const bc = await importBlockCreator();
      bc.startBlockCreator(plainConfig);

      // Heights 1–3: currentHeight ≤ threshold → staleness guard skips decay.
      await mineNextBlock(bc);
      await mineNextBlock(bc);
      await mineNextBlock(bc);
      expect(utxo.getBox(oldBox.id!)).not.toBeNull();
      const pre = takeSnapshot(db, handle, 3);

      // Height 4 > threshold 3: stale, owes 4 periods × 5 = 20, capped at
      // value − minimum = 40 → burn 20, one consolidated decay-burn box.
      const classBlock = await mineNextBlock(bc);
      expect(classBlock).not.toBeNull();

      expect(utxo.getBox(oldBox.id!)).toBeNull();
      const burned = utxo.getKarmaBox(idle.userId);
      expect(burned).not.toBeNull();
      expect(burned!.value).toBe(30n);
      expect((burned as KarmaBox & { decayBurn?: boolean }).decayBurn).toBe(true);

      await assertRoundTrip(db, handle, pre, classBlock!);
    } finally {
      vi.doUnmock('../../src/config.js');
    }
  });

  it('identity record: decay writes the clock and the journal reverts exactly', async () => {
    // The record mutation class: a block that writes the same record key
    // **twice**, which is what exercises `proverFeedFromJournal`'s
    // collapse-duplicates-to-last-write rule. Without a second write to one
    // key, deleting that rule outright kills nothing.
    //
    // Two puts in one block need decay and a karma mint for the same owner at
    // one height, which the mutation phase's ordering makes reachable:
    // `applyKarmaDecay` (§12) writes `lastDecayBlock`, then
    // `processVouchCooldowns` (§12b) mints and `insertBox` writes
    // `lastActivityBlock`. Journal order carries which came last; a sort by key
    // cannot, which is why the collapse lives in the feed and not in
    // `applyBlockMutations`.
    // Thresholds shrunk through a test-local config mock — see the section
    // comment above for why this replaced the env overrides.
    try {
      vi.doMock('../../src/config.js', async () => {
        const actual = await vi.importActual<typeof import('../../src/config.js')>(
          '../../src/config.js',
        );
        return {
          ...actual,
          config: Object.freeze({
            ...actual.config,
            karmaStaleThresholdBlocks: 3,
            karmaDecayIntervalBlocks: 1,
          }),
        };
      });
      vi.resetModules();

      const db = await importDb();
      db.initDb(':memory:');

      const idle = makeTestIdentity();
      const utxo = await importUtxo();
      utxo.insertBox(makeKarmaBox(50n, idle.userId, 0));

      const recordStore = await import('../../src/store/identity-records.js');
      const { VOUCH_KARMA_AMOUNT } = await import('@dagsocial/types');
      // ⛔ An escrow BOX maturing at height 4 — the same block decay first fires
      // in. The obligation is committed state now, so the fixture seeds a box
      // rather than a node-local row (ARCHITECTURE → Vouch boxes). `target` no
      // longer reaches it: the box carries only the owner and the release
      // height.
      utxo.insertBox(
        seedProvenance<VouchEscrowBox>(
          {
            boxType: 'vouch_escrow' as const,
            value: VOUCH_KARMA_AMOUNT,
            createdAtBlock: 0,
            owner: idle.userId,
            releaseAtBlock: 4,
          },
          1,
          87,
        ),
      );

      const handle = await activateProver();
      const bc = await importBlockCreator();
      bc.startBlockCreator(plainConfig);

      await mineNextBlock(bc);
      await mineNextBlock(bc);
      await mineNextBlock(bc);
      const pre = takeSnapshot(db, handle, 3);
      // Non-vacuity: no record exists yet, so the class block creates one.
      expect(recordStore.getIdentityRecord(idle.userId)).toBeNull();

      const classBlock = await mineNextBlock(bc);
      expect(classBlock).not.toBeNull();

      // Without the escrow release, only the decay clock write lands.
      const journalStore = await import('../../src/store/journal.js');
      const recordMutations = journalStore
        .getBlockJournal(4)!
        .mutations.filter((m) => m.kind === 'record');
      expect(recordMutations).toHaveLength(1);
      expect(recordMutations[0]).toMatchObject({ record: { lastDecayBlock: 4 } });

      // The tree holds the single write.
      const key = Buffer.from(recordStore.identityRecordKey(idle.userId), 'hex');
      const serialize = await import('../../src/state/serialize-box.js');
      const lookup = handle.prover.performOneOperation({ tag: 'Lookup', key });
      if (!lookup.success) throw new Error('lookup failed');
      expect(lookup.value).toBeTruthy();
      expect(serialize.deserializeIdentityRecord(lookup.value!)).toEqual({
        lastActivityBlock: 0,
        lastDecayBlock: 4,
        invitedAtBlock: 0,
        lifetimeLikesReceived: 0n,
      });
      // The lookup above recorded proof directions; drop them so the digest
      // comparisons below see the same prover state the block left behind.
      handle.prover.prover.generateProof();

      // Round-trip. Assertion 1 (DB identity) now covers `identity_records`,
      // and `pre.state` has none — so a revert that restored the intra-block
      // intermediate instead of "absent" fails there, which is exactly the
      // reverse-replay property. `assertRoundTrip` re-applies at the end.
      await assertRoundTrip(db, handle, pre, classBlock!);

      // Re-apply landed the single write back.
      expect(recordStore.getIdentityRecord(idle.userId)).toEqual({
        lastActivityBlock: 0,
        lastDecayBlock: 4,
        invitedAtBlock: 0,
        lifetimeLikesReceived: 0n,
      });
    } finally {
      vi.doUnmock('../../src/config.js');
    }
  });
});
