import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  computePostId,
  computeTxId,
  encodePost,
  encodeOrderingBlock,
  decodeOrderingBlock,
  PROTOCOL_VERSION,
  LIKE_KARMA_COST,
  KARMA_STALE_THRESHOLD_BLOCKS,
  EMPTY_STATE_ROOT,
  VOUCH_KARMA_AMOUNT,
  VOUCH_MIN_BALANCE,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  MAX_BLOCK_BODY_BYTES,
} from '@dagsocial/types';
import { verifyOrderingBlockPoW } from '@dagsocial/validation';
import type {
  Post,
  KarmaBox,
  CreditBox,
  VouchBox,
  VouchEscrowBox,
  PostLockBox,
  BlockHeader,
  OrderingBlock,
  Stump,
  PruneEntry,
  UtxoTransaction,
} from '@dagsocial/types';
import type { StoredPost } from '../../src/store/posts.js';
import type { BlockJournal, BoxMutation } from '../../src/store/journal.js';
import type { AnyBox } from '@dagsocial/types';
import type { DecayPlan } from '../../src/services/decay.js';
import type Database from 'better-sqlite3';
import { config } from '../../src/config.js';
import type { Config } from '../../src/config.js';
import type { TestIdentity } from '../helpers.js';
import {
  ZERO_HASH,
  changeBoxOf,
  feeBoxOf,
  hex,
  makeApplicableBlock,
  makeCreditBox,
  makeCreditTx,
  makeKarmaBox,
  makeLikeTx,
  makePost,
  makePruneEntry,
  makeTestConfig,
  makeTestIdentity,
  mineNextBlock,
  seedProvenance,
  signHeader,
  signTransaction,
  solveHeaderPow, fixturePostId, seedPostTx, fillerTx,
  coinbaseOf, withCoinbase } from '../helpers.js';

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

// Every field below is kept verbatim; `makeTestConfig` fills only the thirteen
// `Config` requires this literal never stated. Hazard removal, not error removal:
// as a bare literal its type is what `startBlockCreator`'s parameter was declared
// against, so a newly-required `Config` field would have gone unnoticed here.
const testConfig = makeTestConfig({
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

type BlockCreatorModule = {
  startBlockCreator: (cfg: Config) => void;
  stopBlockCreator: () => void;
  createOrderingBlock: () => OrderingBlock | null;
  getCurrentTemplate: () => OrderingBlock | null;
  submitMinedBlock: (powNonce: number, submittedHeight: number) => string | null;
};

async function importDb(): Promise<DbModule> {
  return (await import('../../src/store/db.js')) as unknown as DbModule;
}

async function importBlockCreator(): Promise<BlockCreatorModule> {
  return (await import(
    '../../src/services/block-creator.js'
  )) as unknown as BlockCreatorModule;
}

async function importPosts() {
  return (await import('../../src/store/posts.js')) as {
    insertPost: (postId: string, post: Post, rawCbor: Uint8Array) => void;
    confirmPost: (postId: string, blockHeight: number) => void;
    getPost: (id: string) => StoredPost | Stump | null;
  };
}

async function importMempoolFresh() {
  const mod = await import('../../src/store/mempool.js');
  return mod as {
    insertUtxoTx: (tx: UtxoTransaction, expiresAtHeight: number) => number;
    getPendingEntries: (limit: number) => Array<{
      rowid: number;
      entryType: string;
      utxoTxCbor: Uint8Array | null;
      expiresAtHeight: number;
      createdAt: string;
    }>;
    removeEntry: (rowid: number) => void;
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown, postLockTarget?: string) => void;
    getKarmaBox: (owner: Uint8Array) => KarmaBox | null;
    getKarmaValue: (owner: Uint8Array) => bigint;
    getCreditBoxes: (owner: Uint8Array) => AnyBox[];
    getBox: (boxId: string) => unknown;
    getUnspentBoxes: () => AnyBox[];
    consumeBox: (boxId: string, consumedAtBlock: number) => void;
  };
}

async function importBlockApply() {
  return (await import(
    '../../src/services/block-apply.js'
  )) as unknown as {
    applyOrderingBlock: (block: OrderingBlock) => boolean;
  };
}

async function importJournalStore() {
  return (await import('../../src/store/journal.js')) as {
    getBlockJournal: (height: number) => BlockJournal | null;
    insertBlockJournal: (journal: BlockJournal) => void;
    deleteBlockJournal: (height: number) => void;
    isBlockJournalOpen: () => boolean;
  };
}

/** boxIds of box 'remove' mutations, in application order. */
function removedIds(journal: BlockJournal): string[] {
  return journal.mutations
    .filter((m) => m.kind === 'box' && m.op === 'remove')
    .map((m) => (m as BoxMutation).boxId);
}

/** boxIds of box 'insert' mutations, in application order. */
function insertedIds(journal: BlockJournal): string[] {
  return journal.mutations
    .filter((m) => m.kind === 'box' && m.op === 'insert')
    .map((m) => (m as BoxMutation).boxId);
}

/** Box inserts matching a predicate over the recorded box payload. */
function boxInserts(
  journal: BlockJournal,
  match: (box: AnyBox) => boolean,
): BoxMutation[] {
  return journal.mutations.filter(
    (m) => m.kind === 'box' && m.op === 'insert' && match(m.box!),
  ) as BoxMutation[];
}

async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as {
    getCurrentHeight: () => number;
    getOrderingBlock: (height: number) => OrderingBlock | null;
    deleteOrderingBlock: (height: number) => void;
  };
}

/** The first nonce that does NOT satisfy the header's declared target. */
function unsolvedHeaderPow(header: BlockHeader): number {
  for (let nonce = 0; ; nonce++) {
    if (!verifyOrderingBlockPoW({ ...header, powNonce: nonce })) return nonce;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('block-apply journal recording', () => {
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
  // 1. Coinbase mint records credit box inserts in journal
  // -----------------------------------------------------------------------

  it('coinbase mint records credit box inserts in journal', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    const block = await mineNextBlock(bc);
    expect(block).not.toBeNull();
    expect(block!.header.height).toBe(1);

    // Verify journal was saved
    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(1);
    expect(saved).not.toBeNull();
    expect(saved!.blockHeight).toBe(1);

    // Genesis miner has no prior credits, so each coinbase output is exactly
    // one credit insert, its box bytes carried in the journal payload
    const creditInserts = boxInserts(saved!, (b) => b.boxType === 'credit');
    expect(creditInserts.length).toBe(coinbaseOf(block!).length);

    // ⚠ **A paying block mutates four boxes, not one.** Besides the coinbase
    // mint it spends the emission box to its successor and accrues to the
    // treasury box, and all three journal like every other mutation — which is
    // what makes them roll back with the block.
    //
    // Named individually rather than counted: a total alone is satisfied by any
    // four mutations, so it would stay green if a transition were replaced by
    // an unrelated one. The count below is the residual check that nothing
    // *else* also mutated.
    expect(boxInserts(saved!, (b) => b.boxType === 'emission')).toHaveLength(1);
    expect(boxInserts(saved!, (b) => b.boxType === 'treasury')).toHaveLength(1);
    const removes = saved!.mutations.filter((m) => m.kind === 'box' && m.op === 'remove');
    expect(removes).toHaveLength(1);   // the predecessor emission box
    expect(saved!.mutations.length).toBe(creditInserts.length + 3);
  });

  // -----------------------------------------------------------------------
  // 2. Post confirm records confirmedSubBlockIds in journal
  // -----------------------------------------------------------------------

  it('post confirm records confirmedSubBlockIds in journal', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();

    const { post: post, tx: postTx, postId: postId } = await seedPostTx(author, 'journal test post');
    const { encodePost } = await import('@dagsocial/types');

    const posts = await importPosts();
    posts.insertPost(postId, post, encodePost(post));

    const mempool = await importMempoolFresh();
    mempool.insertUtxoTx(postTx, 1000);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    await mineNextBlock(bc);

    // Verify post was confirmed
    const confirmedPost = posts.getPost(postId);
    expect(confirmedPost).not.toBeNull();

    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(1);
    expect(saved).not.toBeNull();
    expect(saved!.confirmedSubBlockIds).toContain(postId);
  });

  // -----------------------------------------------------------------------
  // 5. UTXO tx apply records appliedUtxoTxs in journal
  // -----------------------------------------------------------------------

  it('UTXO tx apply records appliedUtxoTxs in journal', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const posts = await importPosts();
    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();

    const author = makeTestIdentity();

    const { post: post, tx: postTx, postId: postId } = await seedPostTx(author, 'utxo journal test');
    const { encodePost, computeTxId } = await import('@dagsocial/types');
    posts.insertPost(postId, post, encodePost(post));

    // Insert post transaction
    mempool.insertUtxoTx(postTx, 1000);

    // Insert a standalone UTXO transaction in mempool. The like targets the
    // post this same block confirms — N2b's apply rules reject a like on an
    // unconfirmed target, and topology lands (§8b) before the tx loop (§11),
    // so confirm-and-like-in-one-block is the valid shape. A self-like is
    // legal (and uneconomical) by contract.
    const karmaBox = makeKarmaBox(100n, author.userId, 0);
    utxo.insertBox(karmaBox);
    const likeTx = makeLikeTx(author, karmaBox, postId, author.userId);
    mempool.insertUtxoTx(likeTx, 1000);

    bc.startBlockCreator(testConfig);
    const block = await mineNextBlock(bc);

    // Verify UTXO tx was decoded from block CBOR and applied
    const { decodeTx } = await import('@dagsocial/types');
    expect(block!.utxoTxTree.utxoTxs).toBeDefined();
    expect(block!.utxoTxTree.utxoTxs.length).toBe(
      block!.utxoTxTree.utxoTxIds.length,
    );
    for (let i = 0; i < block!.utxoTxTree.utxoTxs.length; i++) {
      const tx = decodeTx(block!.utxoTxTree.utxoTxs[i]!);
      expect(computeTxId(tx)).toBe(block!.utxoTxTree.utxoTxIds[i]);
    }

    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(1);
    expect(saved).not.toBeNull();
    expect(saved!.appliedUtxoTxs.length).toBeGreaterThan(0);

    // The applied-tx record carries what mempool re-insertion needs: the id
    // and the CBOR, which round-trips to the same transaction. Two transactions
    // rode this block — the post's and the like's, in that order, because the
    // like cannot apply before the block confirms its target.
    expect(saved!.appliedUtxoTxs.map((t) => t.txId)).toEqual([
      computeTxId(postTx),
      computeTxId(likeTx),
    ]);
    const applied = saved!.appliedUtxoTxs[1]!;
    expect(applied.txId).toBe(computeTxId(likeTx));
    expect(applied.txCbor).toBeInstanceOf(Uint8Array);
    expect(computeTxId(decodeTx(applied.txCbor))).toBe(applied.txId);

    // The tx's box mutations live in the primitive log: input consumed,
    // change karma created (the burn shape has no other output)
    expect(removedIds(saved!)).toContain(karmaBox.id);
    expect(insertedIds(saved!)).toContain(changeBoxOf(likeTx).id);
  });

  // -----------------------------------------------------------------------
  // 6. Rejected block leaves NO journal — invalid PoW at genesis
  // -----------------------------------------------------------------------

  it('block rejected for invalid PoW leaves no journal', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const blockApply = await importBlockApply();
    const { expectedTarget } = await import('../../src/services/difficulty.js');

    // A block that passes the genesis and difficulty-schedule checks and then
    // fails on the solution: the target is the scheduled one, the nonce is the
    // first that does not satisfy it. Picking the nonce deterministically is
    // what keeps this off a 1-in-2^targetBits coin flip.
    const miner = makeTestIdentity();
    const block: OrderingBlock = {
      header: {
        protocolVersion: PROTOCOL_VERSION,
        height: 1,
        prevBlockHash: '0000000000000000000000000000000000000000000000000000000000000000',
        utxoTxRoot: '0000000000000000000000000000000000000000000000000000000000000000',
        stateRoot: EMPTY_STATE_ROOT,
        validatorId: miner.userId,
        powNonce: 0,
        powTargetBits: expectedTarget(1),
        createdAt: Date.now(),
      },
      utxoTxTree: {
        // A body's last entry is its settlement; PoW is refused before anything
        // reads it, so an opaque one is enough here.
        utxoTxIds: ['99'.repeat(32)],
        utxoTxs: [new Uint8Array(96).fill(0x99)],
        pruneEntries: [],
      },
      validatorSignature: new Uint8Array(64),
    };
    block.header.powNonce = unsolvedHeaderPow(block.header);
    expect(verifyOrderingBlockPoW(block.header)).toBe(false);
    // Properly signed even though PoW rejects first, so the unsolved nonce is
    // the only thing wrong with this block.
    block.validatorSignature = signHeader(block.header, miner.privateKey);

    const result = blockApply.applyOrderingBlock(block);
    expect(result).toBe(false);

    // No journal should exist for height 1
    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(1);
    expect(saved).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 7. Rejected block leaves NO journal — wrong height at genesis
  // -----------------------------------------------------------------------

  it('block rejected for wrong height at genesis leaves no journal', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const blockApply = await importBlockApply();
    const { expectedTarget } = await import('../../src/services/difficulty.js');

    const miner = makeTestIdentity();
    const block: OrderingBlock = {
      header: {
        protocolVersion: PROTOCOL_VERSION,
        height: 99, // Genesis must have height 1
        prevBlockHash: '0000000000000000000000000000000000000000000000000000000000000000',
        utxoTxRoot: '0000000000000000000000000000000000000000000000000000000000000000',
        stateRoot: EMPTY_STATE_ROOT,
        validatorId: miner.userId,
        // The scheduled target, not a number. Two gates read this field —
        // `verifyOrderingBlockStructure`'s floor, which runs *before* the
        // height check, and M-2's schedule equality after it — and either one
        // rejects with `false` and no journal, exactly what this test asserts.
        // A fixture that trips the floor therefore passes on the wrong gate.
        powNonce: 0,
        powTargetBits: expectedTarget(99),
        createdAt: Date.now(),
      },
      utxoTxTree: {
        // A body's last entry is its settlement; PoW is refused before anything
        // reads it, so an opaque one is enough here.
        utxoTxIds: ['99'.repeat(32)],
        utxoTxs: [new Uint8Array(96).fill(0x99)],
        pruneEntries: [],
      },
      validatorSignature: new Uint8Array(64),
    };
    // Signed, so the height is the only thing wrong with this block.
    block.validatorSignature = signHeader(block.header, miner.privateKey);

    const result = blockApply.applyOrderingBlock(block);
    expect(result).toBe(false);

    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(99);
    expect(saved).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 8. Rejected block — wrong prevBlockHash at genesis
  // -----------------------------------------------------------------------

  it('block rejected for wrong prevBlockHash at genesis leaves no journal', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const blockApply = await importBlockApply();
    const { expectedTarget } = await import('../../src/services/difficulty.js');

    const miner = makeTestIdentity();
    const block: OrderingBlock = {
      header: {
        protocolVersion: PROTOCOL_VERSION,
        height: 1,
        prevBlockHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        utxoTxRoot: '0000000000000000000000000000000000000000000000000000000000000000',
        stateRoot: EMPTY_STATE_ROOT,
        validatorId: miner.userId,
        // Same reason as the height case above.
        powNonce: 0,
        powTargetBits: expectedTarget(1),
        createdAt: Date.now(),
      },
      utxoTxTree: {
        // A body's last entry is its settlement; PoW is refused before anything
        // reads it, so an opaque one is enough here.
        utxoTxIds: ['99'.repeat(32)],
        utxoTxs: [new Uint8Array(96).fill(0x99)],
        pruneEntries: [],
      },
      validatorSignature: new Uint8Array(64),
    };
    // Signed, so the prevBlockHash is the only thing wrong with this block.
    block.validatorSignature = signHeader(block.header, miner.privateKey);

    const result = blockApply.applyOrderingBlock(block);
    expect(result).toBe(false);

    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(1);
    expect(saved).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 9. Rejected block — coinbase value mismatch
  // -----------------------------------------------------------------------

  it('block rejected for coinbase value mismatch leaves no journal', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const blockApply = await importBlockApply();

    // Genesis paying a zero coinbase when the emission schedule says 100.
    //
    // Every earlier check is made to pass so the block reaches the coinbase
    // check on every run: the target is the scheduled one with a mined nonce,
    // and the Merkle roots are computed rather than zeroed. With a header that
    // failed PoW it was a coin flip whether PoW or the Merkle root did the
    // rejecting, and the coinbase check went untested.
    const { computeUtxoTxRoot } = await import(
      '../../src/services/block-creator.js'
    );
    const { expectedTarget } = await import('../../src/services/difficulty.js');
    const miner = makeTestIdentity();
    const utxoTxTree = {
      utxoTxIds: [],
      utxoTxs: [],
      pruneEntries: [],
      coinbaseOutputs: [
        // The scheduled maturity lock, so the value is the only thing wrong:
        // a non-numeric `lockedUntilBlock` is now a structure rejection, which
        // would reject this block before it reached the coinbase check.
        {
          value: 0n,
          owner: new Uint8Array(32),
          lockedUntilBlock: 1 + config.creditMinerRewardDelay,
          isTreasury: false,
        },
      ],
    };
    const header = {
      protocolVersion: PROTOCOL_VERSION,
      height: 1,
      prevBlockHash: '0000000000000000000000000000000000000000000000000000000000000000',
      utxoTxRoot: computeUtxoTxRoot(utxoTxTree),
      // EMPTY_STATE_ROOT, not a hand-written literal: `stateRoot` is hex(33) =
      // 66 characters (VALIDATION_INTERFACE → `verifyHeaderFieldDomains`), so a
      // hand-written 64-char 32-byte root rejects the block at the width gate,
      // one gate EARLIER than the validator signature — reintroducing exactly
      // the vacuity the comment below guards against, and the test would still
      // pass.
      stateRoot: EMPTY_STATE_ROOT,
      validatorId: miner.userId,
      powNonce: 0,
      powTargetBits: expectedTarget(1),
      createdAt: Date.now(),
    } as BlockHeader;
    header.powNonce = solveHeaderPow(header);
    const block = {
      header,
      utxoTxTree,
      // Signed: the coinbase check sits behind the validator-signature gate, so
      // an unsigned block would reject at the gate and test nothing here.
      validatorSignature: signHeader(header, miner.privateKey),
    } as unknown as OrderingBlock;

    const result = blockApply.applyOrderingBlock(block);
    expect(result).toBe(false);

    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(1);
    expect(saved).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 9b. The coinbase carries the block's income (MINING_INTERFACE → Coinbase
  // Application): `computeBlockReward(height) + fees`, where `fees` is the
  // deficit the block's credit transactions left.
  //
  // The sum is taken inside the mutation phase's embedded-transaction loop,
  // which is where an input resolves in dependency order — the chained case
  // below is what makes that placement necessary rather than tidy.
  // -----------------------------------------------------------------------

  describe('the coinbase equals emission plus fees', () => {
    /**
     * The miner's slice of a block at height 1 carrying `fees` and `actors`.
     *
     * ⚠ **Not the income, on any network.** The treasury's share and the
     * forfeited bonus accrue to the `TreasuryBox` rather than to a coinbase
     * output, so the coinbase is smaller than the block's income by exactly
     * that much and the two never coincide.
     */
    async function minerSliceAt1(fees: bigint, actors: number): Promise<bigint> {
      const { computeBlockReward } = await import('../../src/services/block-creator.js');
      const { splitCoinbase } = await import('../../src/services/coinbase-split.js');
      return splitCoinbase(computeBlockReward(1), fees, actors).miner;
    }

    it('accepts a coinbase claiming the fees of the block it carries', async () => {
      const db = await importDb();
      db.initDb(':memory:');
      const utxo = await importUtxo();
      const blockApply = await importBlockApply();

      const sender = makeTestIdentity();
      const miner = makeTestIdentity();
      const boxA = makeCreditBox(1000n, sender.userId, 0, 1);
      const boxB = makeCreditBox(500n, sender.userId, 0, 2);
      utxo.insertBox(boxA);
      utxo.insertBox(boxB);

      // No `coinbaseSplit`: the helper builds the coinbase this body requires,
      // which is the thing under test.
      const block = await makeApplicableBlock({
        miner,
        utxoTxs: [makeCreditTx(sender, [boxA], 100n), makeCreditTx(sender, [boxB], 50n)],
      });

      expect(blockApply.applyOrderingBlock(block)).toBe(true);
      const paid = utxo.getCreditBoxes(miner.userId)[0]!.value;
      expect(paid).toBe(await minerSliceAt1(150n, 0));
      // And the fees moved the number — otherwise this passes on a coinbase
      // that ignored them entirely.
      expect(paid).toBeGreaterThan(await minerSliceAt1(0n, 0));
    });

    it('rejects a coinbase claiming more than emission plus fees', async () => {
      const db = await importDb();
      db.initDb(':memory:');
      const utxo = await importUtxo();
      const blockApply = await importBlockApply();
      const { computeBlockReward } = await import('../../src/services/block-creator.js');

      const sender = makeTestIdentity();
      const miner = makeTestIdentity();
      const box = makeCreditBox(1000n, sender.userId, 0, 1);
      utxo.insertBox(box);

      // One base unit above the slice this body earns.
      const block = await makeApplicableBlock({
        miner,
        utxoTxs: [makeCreditTx(sender, [box], 100n)],
        settlement: withCoinbase([
          { owner: miner.userId, value: (await minerSliceAt1(100n, 0)) + 1n },
        ]),
      });

      expect(blockApply.applyOrderingBlock(block)).toBe(false);
      expect(utxo.getCreditBoxes(miner.userId)).toHaveLength(0);
    });

    it('rejects a coinbase that leaves the fees unclaimed', async () => {
      const db = await importDb();
      db.initDb(':memory:');
      const utxo = await importUtxo();
      const blockApply = await importBlockApply();
      const { computeBlockReward } = await import('../../src/services/block-creator.js');

      const sender = makeTestIdentity();
      const miner = makeTestIdentity();
      const box = makeCreditBox(1000n, sender.userId, 0, 1);
      utxo.insertBox(box);

      // The slice this body would earn if its transaction paid nothing —
      // under-claiming is a rejection, not a donation, or one block has more
      // than one valid encoding.
      const block = await makeApplicableBlock({
        miner,
        utxoTxs: [makeCreditTx(sender, [box], 100n)],
        settlement: withCoinbase([
          { owner: miner.userId, value: await minerSliceAt1(0n, 0) },
        ]),
      });

      expect(blockApply.applyOrderingBlock(block)).toBe(false);
    });

    // The placement test. `B` spends a box `A` creates in the same block, so
    // its input does not exist in the confirmed set when the block arrives —
    // only the embedded loop's dependency ordering resolves it. A fee sum taken
    // before that loop counts A's deficit and misses B's, and this block, which
    // is valid, would be refused for over-claiming.
    it('claims the fees of a transaction spending a box the same block creates', async () => {
      const db = await importDb();
      db.initDb(':memory:');
      const utxo = await importUtxo();
      const blockApply = await importBlockApply();
      const { computeBlockReward } = await import('../../src/services/block-creator.js');
      const { materializeOutput } = await import('../../src/services/utxo-engine.js');

      const sender = makeTestIdentity();
      const miner = makeTestIdentity();
      const boxA = makeCreditBox(1000n, sender.userId, 0, 1);
      utxo.insertBox(boxA);

      // A: 1000 → 900, fee 100. B spends A's only output: 900 → 850, fee 50.
      const txA = makeCreditTx(sender, [boxA], 100n);
      const aOutput = materializeOutput(
        txA.outputs[0] as never,
        computeTxId(txA),
        0,
      ) as CreditBox;
      const txB = makeCreditTx(sender, [aOutput], 50n);

      const block = await makeApplicableBlock({ miner, utxoTxs: [txA, txB] });

      expect(blockApply.applyOrderingBlock(block)).toBe(true);
      expect(utxo.getCreditBoxes(miner.userId)[0]!.value).toBe(await minerSliceAt1(150n, 0));
      // B's output survives, so the chain really applied rather than the block
      // passing on A alone.
      expect(utxo.getCreditBoxes(sender.userId)[0]!.value).toBe(850n);
    });

    // The attribution guard. A karma-side deficit is not a fee, and an unvouch
    // is the shape that catches a classifier keyed on outputs alone: it has NO
    // outputs, so `outputs.every(isCredit)` is vacuously true and the whole
    // staked value would be counted as a fee.
    it('does not count a zero-output karma-side spend as a fee', async () => {
      const db = await importDb();
      db.initDb(':memory:');
      const utxo = await importUtxo();
      const blockApply = await importBlockApply();
      const { computeBlockReward } = await import('../../src/services/block-creator.js');

      const voucher = makeTestIdentity();
      const target = makeTestIdentity();
      const miner = makeTestIdentity();
      const vouchBox = seedProvenance(
        {
          boxType: 'vouch' as const,
          value: VOUCH_KARMA_AMOUNT,
          createdAtBlock: 0,
          voucherId: voucher.userId,
          targetId: target.userId,
        },
        1,
      );
      utxo.insertBox(vouchBox);

      const unvouch: UtxoTransaction = {
        inputs: [vouchBox.id!],
        // ⛔ **An unvouch conserves: its stake lands in a `VouchEscrowBox`**, so
        // a zero-output vouch spend is an ordinary whole-input deficit and is
        // refused. The SUBJECT here is the fee accounting, which needs a live
        // karma-side spend to carry it.
        outputs: [
          {
            boxType: 'vouch_escrow' as const,
            value: VOUCH_KARMA_AMOUNT,
            createdAtBlock: 0,
            owner: voucher.userId,
            releaseAtBlock: 0 + testConfig.vouchCooldownBlocks,
          },
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };
      signTransaction(unvouch, voucher.privateKey, hex(voucher.userId));

      // The staked karma is escrowed, not a fee, and it is not on the credit
      // ledger at all — so the coinbase is exactly what a fee-free block earns.
      // The voucher IS an actor, though, so the slice is the one-actor slice.
      const block = await makeApplicableBlock({ miner, utxoTxs: [unvouch] });

      expect(blockApply.applyOrderingBlock(block)).toBe(true);
      expect(utxo.getCreditBoxes(miner.userId)[0]!.value).toBe(await minerSliceAt1(0n, 1));
    });

    // One block, one encoding. Without this, `[]` and `[{value: 0}]` are both
    // valid wherever the total is right, with different `utxoTxRoot` and
    // different block hashes. The total here IS right, so the zero-value clause
    // is the only gate that can refuse it.
    it('rejects a zero-value coinbase output beside a correct total', async () => {
      const db = await importDb();
      db.initDb(':memory:');
      await importUtxo();
      const blockApply = await importBlockApply();
      const { computeBlockReward } = await import('../../src/services/block-creator.js');

      // The total is exactly right and no value is misrouted, so the zero-value
      // clause is the only gate that can refuse this.
      const miner = makeTestIdentity();
      const block = await makeApplicableBlock({
        miner,
        settlement: withCoinbase([
          { owner: miner.userId, value: await minerSliceAt1(0n, 0) },
          { owner: makeTestIdentity().userId, value: 0n },
        ]),
      });

      expect(blockApply.applyOrderingBlock(block)).toBe(false);
    });

    // The forfeit is the whole mechanism the inclusion bonus prices with, so a
    // block that keeps it sums correctly against the income and gives up
    // nothing. This is the case a total-only check cannot see.
    it('rejects a coinbase that keeps the forfeited bonus', async () => {
      const db = await importDb();
      db.initDb(':memory:');
      await importUtxo();
      const blockApply = await importBlockApply();
      const { computeBlockReward } = await import('../../src/services/block-creator.js');

      const miner = makeTestIdentity();
      const block = await makeApplicableBlock({
        miner,
        // The whole emission — what a producer who forfeits nothing pays
        // themselves, and strictly more than the slice they earned.
        settlement: withCoinbase([
          { owner: miner.userId, value: computeBlockReward(1) },
        ]),
      });

      expect(computeBlockReward(1)).toBeGreaterThan(await minerSliceAt1(0n, 0));
      expect(blockApply.applyOrderingBlock(block)).toBe(false);
    });

    // ⛔ **The `isTreasury` flag is GONE with the struct that carried it**
    // (TYPES_INTERFACE → Coinbase output). A coinbase output is an ordinary
    // `CreditBox` output of the settlement, so there is no field to misdeclare
    // and no rejection to test — the shape is unrepresentable rather than
    // refused. What replaces it as the settlement's own type discipline is
    // covered by `output-shape.test.ts` → checkSettlementOutputShape.
    it('refuses a settlement emitting a box type its body does not derive', async () => {
      const db = await importDb();
      db.initDb(':memory:');
      await importUtxo();
      const blockApply = await importBlockApply();
      const { computeBlockReward } = await import('../../src/services/block-creator.js');
      const { splitCoinbase } = await import('../../src/services/coinbase-split.js');

      // Exactly the miner's slice, to the miner's own key, PLUS a karma output
      // no bond in this body asks for. The amount is right, so nothing else can
      // be what rejects it.
      const miner = makeTestIdentity();
      const split = splitCoinbase(computeBlockReward(1), 0n, 0);
      const stranger = makeTestIdentity();
      const grafted = await makeApplicableBlock({
        miner,
        settlement: (tx) => ({
          ...tx,
          outputs: [
            ...tx.outputs,
            { boxType: 'karma', value: 5n,  createdAtBlock: 0,owner: stranger.userId } as never,
          ],
        }),
      });
      expect(blockApply.applyOrderingBlock(grafted)).toBe(false);

      // ⛔ **The control is what stops this passing for the wrong reason.** The
      // same settlement without the grafted output must APPLY — which isolates
      // the extra box as the whole difference.
      const clean = await makeApplicableBlock({
        miner,
        settlement: withCoinbase([{ owner: miner.userId, value: split.miner }]),
      });
      expect(blockApply.applyOrderingBlock(clean)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 10. Successful block leaves no journal open after persistence
  // -----------------------------------------------------------------------

  it('no block journal is left open after successful block application', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    await mineNextBlock(bc);

    const journal = await importJournalStore();
    expect(journal.isBlockJournalOpen()).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 11. Decay burns recorded in journal
  // -----------------------------------------------------------------------

  it('records decay burns in journal', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();

    // Create an identity with a karma box at block 0 (ancient). The value is
    // large enough that the value-over-minimum cap cannot bind — see the
    // owed-burn derivation below.
    const identity = makeTestIdentity();
    const oldBox = makeKarmaBox(1000n, identity.userId, 0);
    utxo.insertBox(oldBox);

    // Import decay module directly — applyOrderingBlock delegates to it,
    // and we can't build 20,000+ blocks in a test. Inside block application
    // its box mutations are journaled at the store choke point; the return
    // value asserted here is the service's own per-owner summary.
    const { deriveKarmaDecay } = await import(
      '../../src/services/decay.js'
    );
    const { KARMA_DECAY_AMOUNT, KARMA_DECAY_INTERVAL_BLOCKS, KARMA_MINIMUM } = await import('@dagsocial/types');

    const decayCfg = {
      staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
      decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
      decayAmount: KARMA_DECAY_AMOUNT,
      karmaMinimum: KARMA_MINIMUM,
    };

    // Spec G phase D: the decay clock is committed state. `oldBox` was inserted
    // with no journal open, so the identity has no record and reads as never
    // active — the same clock its `createdAtBlock` of 0 gave the old box-age
    // reading, so the burn below is unchanged by the swap.
    const records = await import('../../src/store/identity-records.js');

    const deps = {
      getKarmaBoxes: (owner: Uint8Array) => {
        const box = utxo.getKarmaBox(owner);
        return box ? [box] : [];
      },
      consumeBox: (boxId: string, height: number) =>
        utxo.consumeBox(boxId, height),
      insertBox: (box: KarmaBox) => utxo.insertBox(box),
      getIdentityRecord: records.getIdentityRecord,
      putIdentityRecord: records.putIdentityRecord,
      getKarmaOwners: () => [identity.userId],
    };

    const staleHeight = KARMA_STALE_THRESHOLD_BLOCKS + 100;
    const entries: DecayPlan[] = deriveKarmaDecay(deps, staleHeight, decayCfg);

    // Never-active clock ⇒ periods count from height 0:
    // owed = floor(staleHeight / interval) × amount.
    //
    // The box value (1000n) keeps the value-over-minimum cap from binding, so
    // the assertion measures the period arithmetic itself. A clamped assertion
    // can hide an unbounded error in its input — the pre-P2A version of this
    // test hardcoded a 720 divisor and the cap swallowed the resulting 2×
    // error. The premise is asserted so a future constant change cannot
    // silently turn this back into a cap test.
    const owed =
      BigInt(Math.floor(staleHeight / KARMA_DECAY_INTERVAL_BLOCKS)) * KARMA_DECAY_AMOUNT;
    expect(owed < 1000n - KARMA_MINIMUM).toBe(true);

    expect(entries.length).toBe(1);
    expect(entries[0]!.owner).toEqual(identity.userId);
    expect(entries[0]!.burnAmount).toBe(owed);
    expect(entries[0]!.consumedBoxIds).toEqual([oldBox.id!]);
    // ⛔ **The plan carries a VALUE, not a box id.** The replacement karma is an
    // output of the block's settlement transaction, so its id is that
    // transaction's to give (NODE_INTERFACE → The settlement transaction) and
    // the derivation could not know it.
    expect(entries[0]!.newValue).toBe(1000n - owed);

    // ⛔ **NOTHING MOVED, and that is the assertion.** This case derives the
    // plan directly and applies no block, so the owner's box is untouched — the
    // replacement karma is emitted by the block's settlement transaction, which
    // has not run here. ⚠ **A derivation is pure**, so a store read at this
    // point measures the fixture's seed and nothing else.
    const karmaBox = utxo.getKarmaBox(identity.userId);
    expect(karmaBox).not.toBeNull();
    expect(karmaBox!.id).toBe(oldBox.id);
    expect(karmaBox!.boxType).toBe('karma');
    // The pre-decay value, unchanged. What the plan says the owner is LEFT with
    // is asserted above, on the plan.
    expect(karmaBox!.value).toBe(1000n);
  });

  // -----------------------------------------------------------------------
  // 12. The escrow release journals through the box primitives (H-7 retired)
  // -----------------------------------------------------------------------

  it('the settlement does not sweep a matured escrow — the owner reclaims it', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();

    const voucher = makeTestIdentity();
    const oldKarma = makeKarmaBox(50n, voucher.userId, 0);
    utxo.insertBox(oldKarma);
    utxo.insertBox(
      seedProvenance<VouchEscrowBox>(
        {
          boxType: 'vouch_escrow' as const,
          value: 7n,
          createdAtBlock: 0,
          owner: voucher.userId,
          releaseAtBlock: 1,
        },
        1,
        88,
      ),
    );

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    await mineNextBlock(bc);

    // The escrow SURVIVES the height it used to be swept at — the settlement
    // no longer releases it.
    expect(utxo.getUnspentBoxes().some((b) => b.boxType === 'vouch_escrow')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Embedded UTXO tx re-validation at block application
// ---------------------------------------------------------------------------

describe('block-apply embedded tx re-validation', () => {
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

  /**
   * Mine and apply a block over whatever sits in the mempool.
   *
   * The block creator does not validate what it picks up, so putting a
   * transaction into the mempool directly — around the service layer that
   * would have refused it — reproduces the malicious-producer case exactly:
   * validator selection is permissionless PoW, so a producer can embed a
   * transaction that passed validation on no node at all.
   */
  async function mineBlockOverMempool() {
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    return mineNextBlock(bc);
  }

  it('rejects the whole block when an embedded tx spends a live box unsigned', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();

    const victim = makeTestIdentity();
    const victimBox = makeKarmaBox(100n, victim.userId, 0);
    utxo.insertBox(victimBox);

    // Well-formed — envelope included — conserving, and spending a box that
    // really exists. The only thing it lacks is the victim's authorisation.
    //
    // The target is 64-hex because `checkTxEnvelope` (validateTx step 0) pins
    // `likeTarget` to a post id, and the placeholder string this fixture used
    // to carry made it envelope-invalid: the funnel skipped the transaction
    // and the block applied, so the whole-block rejection asserted below was
    // never reached. It need not name a post that exists — `validateTx` never
    // looks one up; the apply-time like rules do, and step 6 refuses the
    // missing signature long before them.
    const forged = makeLikeTx(victim, victimBox, ZERO_HASH, victim.userId);
    forged.signatures = {};
    mempool.insertUtxoTx(forged, 1000);

    await mineBlockOverMempool();

    // Nothing the block would have done survives — not the block row, not the
    // coinbase mint, not the spend.
    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(0);

    const journal = await importJournalStore();
    expect(journal.getBlockJournal(1)).toBeNull();

    const survivor = utxo.getBox(victimBox.id!) as KarmaBox | null;
    expect(survivor).not.toBeNull();
    expect(survivor!.value).toBe(100n);
  });

  it('rejects the whole block when an embedded tx mints value', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();

    const attacker = makeTestIdentity();
    const attackerBox = makeKarmaBox(100n, attacker.userId, 0);
    utxo.insertBox(attackerBox);

    // Correctly signed by the owner and a legal karma → karma + post_lock
    // shape, but the outputs total 105 against a 100 karma input: the change
    // box keeps the full balance and the PostLockBox is conjured from nothing.
    const inflating: UtxoTransaction = {
      inputs: [attackerBox.id!],
      outputs: [
        {
          boxType: 'karma',
          value: 100n,
          createdAtBlock: 0,
          owner: attacker.userId,
        } as KarmaBox,
        {
          boxType: 'post_lock',
          value: 5n,
          createdAtBlock: 0,
          originalValue: 5n,
          owner: attacker.userId,
          // `b32` in the box-id preimage — `'target_post'` has no encoding, and
          // the tx has to be *hashable* for the value check to be what rejects it.
        } as PostLockBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(
      inflating,
      attacker.privateKey,
      Buffer.from(attacker.userId).toString('hex'),
    );
    mempool.insertUtxoTx(inflating, 1000);

    await mineBlockOverMempool();

    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(0);

    const journal = await importJournalStore();
    expect(journal.getBlockJournal(1)).toBeNull();

    // The attacker's balance is exactly what it was — no 102 anywhere.
    const survivor = utxo.getBox(attackerBox.id!) as KarmaBox | null;
    expect(survivor).not.toBeNull();
    expect(survivor!.value).toBe(100n);
  });

  it('applies a block whose embedded txs are all valid', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const { computeTxId } = await import('@dagsocial/types');

    const alice = makeTestIdentity();
    const bob = makeTestIdentity();
    const aliceBox = makeKarmaBox(100n, alice.userId, 0);
    const bobBox = makeKarmaBox(40n, bob.userId, 0);
    utxo.insertBox(aliceBox);
    utxo.insertBox(bobBox);

    // N2b: likes need confirmed live targets — real posts, confirmed by this
    // same block (topology at §8b precedes the tx loop at §11).
    const author = makeTestIdentity();
    const { post: postA, tx: postATx, postId: postAId } = await seedPostTx(author, 'valid-txs target a');
    const { post: postB, tx: postBTx, postId: postBId } = await seedPostTx(author, 'valid-txs target b');
    posts.insertPost(postAId, postA, encodePost(postA));
    posts.insertPost(postBId, postB, encodePost(postB));
    mempool.insertUtxoTx(postATx, 1000);
    mempool.insertUtxoTx(postBTx, 1000);

    // ⛔ **The marker names the POST'S author, not the liker.** Both posts are
    // `author`'s, so both markers name `author` — a marker naming the liker
    // would earmark their own karma to themselves and is refused by the pin
    // (NODE_INTERFACE → Karma transition rules).
    const aliceTx = makeLikeTx(alice, aliceBox, postAId, author.userId);
    const bobTx = makeLikeTx(bob, bobBox, postBId, author.userId);
    mempool.insertUtxoTx(aliceTx, 1000);
    mempool.insertUtxoTx(bobTx, 1000);

    await mineBlockOverMempool();

    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(1);
    expect(saved).not.toBeNull();
    expect(saved!.appliedUtxoTxs.map((t) => t.txId).sort()).toEqual(
      [
        computeTxId(postATx),
        computeTxId(postBTx),
        computeTxId(aliceTx),
        computeTxId(bobTx),
      ].sort(),
    );

    // Inputs consumed, change boxes live at the conserved values.
    expect(utxo.getBox(aliceBox.id!)).toBeNull();
    expect(utxo.getBox(bobBox.id!)).toBeNull();
    expect((utxo.getBox(changeBoxOf(aliceTx).id!) as KarmaBox).value).toBe(
      100n - LIKE_KARMA_COST,
    );
    expect((utxo.getBox(changeBoxOf(bobTx).id!) as KarmaBox).value).toBe(
      40n - LIKE_KARMA_COST,
    );
  });

  it('still defers and retries a tx that consumes a box created in the same block', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const { computeTxId } = await import('@dagsocial/types');

    const liker = makeTestIdentity();
    const startBox = makeKarmaBox(100n, liker.userId, 0);
    utxo.insertBox(startBox);

    // N2b: likes need confirmed live targets — two real posts, confirmed by
    // the same block that carries the chained likes.
    const author = makeTestIdentity();
    const { post: postA, tx: postATx, postId: postAId } = await seedPostTx(author, 'defer-retry target a');
    const { post: postB, tx: postBTx, postId: postBId } = await seedPostTx(author, 'defer-retry target b');
    posts.insertPost(postAId, postA, encodePost(postA));
    posts.insertPost(postBId, postB, encodePost(postB));
    mempool.insertUtxoTx(postATx, 1000);
    mempool.insertUtxoTx(postBTx, 1000);

    const txA = makeLikeTx(liker, startBox, postAId, author.userId);
    const txB = makeLikeTx(liker, changeBoxOf(txA), postBId, author.userId);

    // B goes in first, so the block lists it first and its input does not
    // exist on the first pass — the "inputs not present yet" case, which must
    // still defer and retry rather than take the block down.
    mempool.insertUtxoTx(txB, 1000);
    mempool.insertUtxoTx(txA, 1000);

    const block = await mineBlockOverMempool();
    // Block order is pool order: the two post transactions, then txB ahead of
    // the txA it depends on — the inversion the multi-pass loop has to survive.
    // The settlement is the body's LAST entry and is not part of the fill.
    expect(block!.utxoTxTree.utxoTxIds.slice(0, -1)).toEqual([
      computeTxId(postATx),
      computeTxId(postBTx),
      computeTxId(txB),
      computeTxId(txA),
    ]);

    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(1);
    expect(saved).not.toBeNull();
    // Applied in dependency order, not block order: the two post transactions
    // and txA go on the first pass, txB on the second — where block order put
    // txB ahead of txA.
    expect(saved!.appliedUtxoTxs.map((t) => t.txId)).toEqual([
      computeTxId(postATx),
      computeTxId(postBTx),
      computeTxId(txA),
      computeTxId(txB),
    ]);

    // 100 → 99 → 98, with both intermediate boxes spent.
    expect(utxo.getBox(startBox.id!)).toBeNull();
    expect(utxo.getBox(changeBoxOf(txA).id!)).toBeNull();
    const finalBox = utxo.getBox(changeBoxOf(txB).id!) as KarmaBox | null;
    expect(finalBox).not.toBeNull();
    expect(finalBox!.value).toBe(100n - 2n * LIKE_KARMA_COST);
  });

  // -------------------------------------------------------------------------
  // A block is invalid if any embedded transaction does not apply
  //
  // The two arms beside it in the same loop already reject the block — a failed
  // re-validation and a like on an unconfirmed post. The liveness arm was the
  // one that warned and carried on, which left the header committing to a
  // `utxoTxIds` its own `stateRoot` did not reflect.
  // -------------------------------------------------------------------------

  /**
   * A karma self-transfer: one box in, one box of the same value out to the
   * same owner. Conserving and like-free, so a chain of them needs no confirmed
   * post per link — what it tests is the dependency ordering, nothing else.
   */
  function makeSelfTransferTx(owner: TestIdentity, karmaBox: KarmaBox): UtxoTransaction {
    const tx: UtxoTransaction = {
      inputs: [karmaBox.id!],
      outputs: [
        {
          boxType: 'karma',
          value: karmaBox.value,
          createdAtBlock: 0,
          owner: owner.userId,
        },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, owner.privateKey, Buffer.from(owner.userId).toString('hex'));
    return tx;
  }

  it('refuses a block whose embedded transactions do not all apply', async () => {
    // Block 94's exact shape: two transactions naming ONE input, each valid on
    // its own. The first spends the box, the second's input is then dead.
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const { computeTxId } = await import('@dagsocial/types');
    const owner = makeTestIdentity();
    const box = makeKarmaBox(100n, owner.userId, 0);
    utxo.insertBox(box);

    const first = makeSelfTransferTx(owner, box);
    const second: UtxoTransaction = {
      ...makeSelfTransferTx(owner, box),
      // A second, distinct transaction on the same input — the change is paid
      // to a different key, so the two are not the same transaction twice.
      outputs: [{
        boxType: 'karma',
        value: box.value,
        createdAtBlock: 0,
        owner: makeTestIdentity().userId,
      }],
    };
    signTransaction(second, owner.privateKey, Buffer.from(owner.userId).toString('hex'));
    expect(computeTxId(first)).not.toBe(computeTxId(second));

    const block = await makeApplicableBlock({ utxoTxs: [first, second] });

    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(block)).toBe(false);

    // Rolled back whole — no partial application survives the refusal.
    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(0);
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(utxo.getBox(box.id!)).not.toBeNull();

    const journal = await importJournalStore();
    expect(journal.getBlockJournal(1)).toBeNull();
  });

  it('applies a dependency chain deeper than twenty in one block', async () => {
    // The regression for removing the pass cap. At twenty the tail was dropped
    // silently and the block applied anyway; a node with a different cap would
    // have accepted a different set from the same bytes.
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const owner = makeTestIdentity();
    const root = makeKarmaBox(100n, owner.userId, 0);
    utxo.insertBox(root);

    const CHAIN = 25;
    const chain: UtxoTransaction[] = [];
    let current: KarmaBox = root;
    for (let i = 0; i < CHAIN; i++) {
      const tx = makeSelfTransferTx(owner, current);
      chain.push(tx);
      current = changeBoxOf(tx);
    }

    // Reversed, so no transaction's input exists until the one after it in the
    // block has applied: the deepest ordering the retry loop can be handed.
    const block = await makeApplicableBlock({ utxoTxs: [...chain].reverse() });

    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(block)).toBe(true);

    const journal = await importJournalStore();
    const saved = journal.getBlockJournal(1);
    expect(saved!.appliedUtxoTxs).toHaveLength(CHAIN);

    // The whole chain settled: the root is spent and only the last change lives.
    expect(utxo.getBox(root.id!)).toBeNull();
    const tip = utxo.getBox(changeBoxOf(chain[CHAIN - 1]!).id!) as KarmaBox | null;
    expect(tip).not.toBeNull();
    expect(tip!.value).toBe(100n);
  });

  // -------------------------------------------------------------------------
  // The vouch minimum-balance gate at the block path.
  //
  // `getKarmaValue` is a consensus input and MUST sum across boxes rather than
  // read one (NODE_INTERFACE → Store): `getKarmaBox` is `LIMIT 1` with no
  // `ORDER BY`, so a single-box read makes the verdict a function of SQLite's
  // physical row order — M-12's class. The unit suite exercises the gate only
  // through a test-local deps stub, so the *production* wiring is unpinned
  // there: mutating the block path's read from summed to single-box left every
  // unit test green until these two were written.
  //
  // They run a vouch cast through the real block pipeline, where deps come from
  // the store, and the fixture makes summed-vs-single observable: the voucher's
  // karma clears `VOUCH_MIN_BALANCE` only across boxes.
  // -------------------------------------------------------------------------

  /** `karmaIn` → karma change + a VouchBox staking VOUCH_KARMA_AMOUNT. */
  function makeVouchCastTx(
    karmaIn: KarmaBox,
    voucher: TestIdentity,
    targetId: Uint8Array,
  ): UtxoTransaction {
    const tx: UtxoTransaction = {
      inputs: [karmaIn.id!],
      outputs: [
        {
          boxType: 'karma',
          value: karmaIn.value - VOUCH_KARMA_AMOUNT,
          createdAtBlock: 0,
          owner: voucher.userId,
        } as KarmaBox,
        {
          boxType: 'vouch',
          value: VOUCH_KARMA_AMOUNT,
          createdAtBlock: 0,
          voucherId: voucher.userId,
          targetId,
        } as VouchBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, voucher.privateKey, Buffer.from(voucher.userId).toString('hex'));
    return tx;
  }

  it('the vouch minimum-balance gate sums the voucher karma across boxes at the block path', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();

    const voucher = makeTestIdentity();
    const target = makeTestIdentity();

    // 6 + 6 = 12 ≥ VOUCH_MIN_BALANCE (11), but neither box alone reaches it —
    // a single-box read sees 6 < 11 whichever row it lands on, and the cast is
    // refused however the karma is partitioned.
    const splitA = makeKarmaBox(6n, voucher.userId, 0, 0);
    const splitB = makeKarmaBox(6n, voucher.userId, 0, 1);
    utxo.insertBox(splitA);
    utxo.insertBox(splitB);

    mempool.insertUtxoTx(makeVouchCastTx(splitA, voucher, target.userId), 1000);
    const block = await mineBlockOverMempool();
    expect(block).not.toBeNull();

    // Settled state, not a rejection message: under a single-box read the
    // creator's speculative mutation pass drops the cast — or the verifier
    // rejects the block — and either way no VouchBox is ever created.
    expect(utxo.getBox(splitA.id!)).toBeNull();
    const vouches = db.getDb()
      .prepare(`SELECT id FROM utxo_boxes WHERE box_type = 'vouch' AND spent_at_block IS NULL`)
      .all() as Array<{ id: string }>;
    expect(vouches).toHaveLength(1);

    // The gate reads the voucher's boxes; the cast must not spend the one it
    // did not name.
    expect(utxo.getBox(splitB.id!)).not.toBeNull();
  });

  it('the same cast settles with the voucher karma in one box (control)', async () => {
    // Non-vacuity for the split fixture above: 12 in a single box clears the
    // minimum under summed AND single-box reads, so this control passing while
    // the split test fails is what isolates a mutation to partitioning rather
    // than to the vouch flow being broken generally.
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();

    const voucher = makeTestIdentity();
    const target = makeTestIdentity();

    const whole = makeKarmaBox(12n, voucher.userId, 0);
    utxo.insertBox(whole);

    mempool.insertUtxoTx(makeVouchCastTx(whole, voucher, target.userId), 1000);
    const block = await mineBlockOverMempool();
    expect(block).not.toBeNull();

    expect(utxo.getBox(whole.id!)).toBeNull();
    const vouches = db.getDb()
      .prepare(`SELECT id FROM utxo_boxes WHERE box_type = 'vouch' AND spent_at_block IS NULL`)
      .all() as Array<{ id: string }>;
    expect(vouches).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Mint provenance at the apply path
//
// These exercise the *wiring* rather than the encoders: which context each
// `transferKarma` call site passes. A unit test on `mint-provenance.ts`
// cannot see a call site that hands the wrong one over, and both mistakes
// below are silent — a collision, not an error.
// ---------------------------------------------------------------------------

describe('block-apply mint provenance', () => {
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

  it('a split coinbase mints one box per output, each with its own txId', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const blockApply = await importBlockApply();
    const { computeBlockReward } = await import('../../src/services/block-creator.js');
    const { computeMintTxId } = await import('@dagsocial/types');
    // ⛔ **The coinbase is ONE transaction's outputs now, not N mint events.**
    // Each output is a `CreditBox` of the settlement, so its provenance is the
    // settlement's own `txId` at the output's own position — no synthetic mint
    // id, no per-output subject, and `UNIQUE(tx_id, output_index)` is satisfied
    // by the positions rather than by distinct ids (MINING_INTERFACE → Coinbase
    // Application: the credits are spent from the `EmissionBox` by the
    // transaction that emits them).
    //
    // Two outputs on the MINER's side, which is the multi-output shape devnet
    // can reach: only the treasury side is pinned to an amount and an owner, so
    // a producer may pay their own slice to more than one key. The pair here
    // sums to that slice exactly.
    const { splitCoinbase } = await import('../../src/services/coinbase-split.js');
    const miner = makeTestIdentity();
    const second = makeTestIdentity();
    const slice = splitCoinbase(computeBlockReward(1), 0n, 0).miner;
    const secondShare = slice / 10n;

    const block = await makeApplicableBlock({
      miner,
      settlement: withCoinbase([
        { owner: miner.userId, value: slice - secondShare },
        { owner: second.userId, value: secondShare },
      ]),
    });
    expect(blockApply.applyOrderingBlock(block)).toBe(true);

    const minerBox = utxo.getCreditBoxes(miner.userId)[0];
    const treasuryBox = utxo.getCreditBoxes(second.userId)[0];
    expect(minerBox).toBeDefined();
    expect(treasuryBox).toBeDefined();

    // ONE txId — the settlement's — and the positions are what separate them.
    const settlementId = block.utxoTxTree.utxoTxIds[block.utxoTxTree.utxoTxIds.length - 1]!;
    expect(minerBox!.txId).toBe(settlementId);
    expect(treasuryBox!.txId).toBe(settlementId);
    expect(minerBox!.index).not.toBe(treasuryBox!.index);
    // …and therefore two distinct box ids, which is the property the shared-txId
    // hazard was about.
    expect(minerBox!.id).not.toBe(treasuryBox!.id);
  });

  it('a decay charge fires while a matured escrow survives in the same block', async () => {
    // Decay fires at a height where a matured escrow exists. The escrow
    // survives — the settlement no longer sweeps it — so only the decay
    // charge lands as a karma mutation for this owner.
    //
    // Thresholds are shrunk through a test-local mock of the config module so
    // a 4-block chain crosses the staleness window. The env overrides this
    // test used before P2-A were the consensus violation the network profile
    // removed; a module mock is a seam only a test can reach — a running node
    // has no equivalent.
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

      const utxo = await importUtxo();
      const journalStore = await importJournalStore();
      const { VOUCH_KARMA_AMOUNT } = await import('@dagsocial/types');
      const idle = makeTestIdentity();
      const target = makeTestIdentity();
      utxo.insertBox(makeKarmaBox(50n, idle.userId, 0));
      // Matures at height 4 — the same block decay first fires in.
      // ⛔ An escrow BOX due at height 4. The obligation is committed state
      // (ARCHITECTURE → Vouch boxes), and the box carries only the owner and the
      // release height — no target.
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
          89,
        ),
      );

      const bc = await importBlockCreator();
      bc.startBlockCreator(testConfig);
      await mineNextBlock(bc);
      await mineNextBlock(bc);
      await mineNextBlock(bc);

      // Height 4 > threshold 3: decay fires, then the cooldown settles.
      const block = await mineNextBlock(bc);
      expect(block).not.toBeNull();

      const journal = journalStore.getBlockJournal(4)!;
      const ownerHex = hex(idle.userId);
      const mints = journal.mutations
        .filter((m): m is BoxMutation => m.kind === 'box' && m.op === 'insert')
        .map((m) => m.box as AnyBox)
        .filter((b) => b.boxType === 'karma' && hex((b as KarmaBox).owner) === ownerHex);

      // Only the decay charge fires — the escrow survives.
      expect(mints.length).toBe(1);
      const decayed = mints[0]!;
      expect((decayed as KarmaBox & { decayBurn?: boolean }).decayBurn).toBe(true);

      // The escrow is still live.
      expect(utxo.getUnspentBoxes().some((b) => b.boxType === 'vouch_escrow')).toBe(true);
    } finally {
      vi.doUnmock('../../src/config.js');
    }
  });

  it('decay fires while a matured escrow survives — no activity-clock bump', async () => {
    // Without the settlement sweeping the escrow, `lastActivityBlock` is NOT
    // updated by the escrow's maturity. Staleness restarts from `lastDecayBlock`
    // alone.
    // Thresholds shrunk through a test-local config mock — see the sibling
    // decay test above for why this replaced the env overrides.
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

      const utxo = await importUtxo();
      const records = await import('../../src/store/identity-records.js');
      const { VOUCH_KARMA_AMOUNT } = await import('@dagsocial/types');

      const idle = makeTestIdentity();
      const target = makeTestIdentity();
      utxo.insertBox(makeKarmaBox(50n, idle.userId, 0));
      // ⛔ An escrow BOX due at height 4. The obligation is committed state
      // (ARCHITECTURE → Vouch boxes), and the box carries only the owner and the
      // release height — no target.
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
          89,
        ),
      );

      const bc = await importBlockCreator();
      bc.startBlockCreator(testConfig);
      for (let i = 0; i < 3; i++) await mineNextBlock(bc);

      // Height 4: decay fires, escrow survives.
      expect(await mineNextBlock(bc)).not.toBeNull();
      expect(records.getIdentityRecord(idle.userId)).toEqual({
        lastActivityBlock: 0,
        lastDecayBlock: 4,
        invitedAtBlock: 0,
        lifetimeLikesReceived: 0n,
      });
      expect(utxo.getUnspentBoxes().some((b) => b.boxType === 'vouch_escrow')).toBe(true);
      const afterFirstDecay = utxo.getKarmaValue(idle.userId);

      // Without the escrow release bumping lastActivityBlock, the identity
      // stays stale: isIdentityStale reads lastActivityBlock alone, not
      // max(lastActivity, lastDecay). Decay fires at every subsequent block.
      expect(await mineNextBlock(bc)).not.toBeNull();
      expect(records.getIdentityRecord(idle.userId)).toEqual({
        lastActivityBlock: 0,
        lastDecayBlock: 5,
        invitedAtBlock: 0,
        lifetimeLikesReceived: 0n,
      });
      expect(utxo.getKarmaValue(idle.userId)).toBeLessThan(afterFirstDecay);
    } finally {
      vi.doUnmock('../../src/config.js');
    }
  });
});

// ---------------------------------------------------------------------------
// Height-deterministic difficulty + coinbase maturity, enforced at apply
// (audit M-2, M-3)
// ---------------------------------------------------------------------------

describe('block-apply consensus schedules', () => {
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
  // M-2: powTargetBits must equal expectedTarget(height)
  // -----------------------------------------------------------------------

  it('rejects a block whose powTargetBits is below the schedule', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const { expectedTarget } = await import('../../src/services/difficulty.js');
    // The constant, not its present value: the floor is a consensus parameter
    // and this test is about the gap between it and the schedule, not about
    // which number it currently holds.
    const floorTarget = ORDERING_BLOCK_POW_TARGET_FLOOR;
    expect(floorTarget).toBeLessThan(expectedTarget(1));

    // The M-2 attack, in full: a self-declared floor target with a PoW solution
    // that genuinely satisfies it. Nothing here is malformed — the block is
    // internally consistent and costs whatever the floor costs to produce.
    const block = await makeApplicableBlock({ powTargetBits: floorTarget });
    expect(verifyOrderingBlockPoW(block.header)).toBe(true);

    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(block)).toBe(false);

    // Rolled back whole: no block, no height, no coinbase mint.
    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(0);

    const journal = await importJournalStore();
    expect(journal.getBlockJournal(1)).toBeNull();
  });

  it('accepts a block whose powTargetBits equals the schedule', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const { expectedTarget } = await import('../../src/services/difficulty.js');
    const block = await makeApplicableBlock();
    expect(block.header.powTargetBits).toBe(expectedTarget(1));

    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(block)).toBe(true);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(1);
  });

  // -----------------------------------------------------------------------
  // M-3: every coinbase lock must equal height + config.creditMinerRewardDelay
  // -----------------------------------------------------------------------

  it('rejects a block whose coinbase output is unlocked', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    // lockedUntilBlock 0 — spendable the moment it is minted, bypassing the
    // scheduled maturity. The value is correct, so the emission check above
    // waves it through.
    const block = await makeApplicableBlock({ lockedUntilBlock: 0 });

    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(block)).toBe(false);

    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(0);

    // The mint is what the attack is after: no credit box, of any maturity.
    const { getCreditBoxes } = (await import('../../src/store/utxo.js')) as {
      getCreditBoxes: (owner: Uint8Array) => unknown[];
    };
    expect(getCreditBoxes(coinbaseOf(block)[0]!.owner)).toHaveLength(0);
  });

  it('rejects a block whose coinbase lock is one block short of maturity', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    // Off by one, not obviously wrong, and still ahead of the block height the
    // gossip validator bounds against — so only an equality check catches it.
    const block = await makeApplicableBlock({
      lockedUntilBlock: 1 + config.creditMinerRewardDelay - 1,
    });

    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(block)).toBe(false);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(0);
  });

  it('accepts a block whose coinbase lock matches the maturity delay', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const block = await makeApplicableBlock({
      lockedUntilBlock: 1 + config.creditMinerRewardDelay,
    });

    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(block)).toBe(true);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(1);

    // Minted, and carrying the lock the block declared.
    const { getCreditBoxes } = (await import('../../src/store/utxo.js')) as {
      getCreditBoxes: (owner: Uint8Array) => Array<{ lockedUntilBlock?: number }>;
    };
    const boxes = getCreditBoxes(coinbaseOf(block)[0]!.owner);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.lockedUntilBlock).toBe(1 + config.creditMinerRewardDelay);
  });

  // -----------------------------------------------------------------------
  // H-1: the block must be signed by the key its validatorId names
  // -----------------------------------------------------------------------

  it('rejects a block whose validator signature is corrupted', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const block = await makeApplicableBlock();
    // Nothing in the header moves, so the PoW solution stays valid and the
    // signature is the only check this block can fail.
    expect(verifyOrderingBlockPoW(block.header)).toBe(true);
    block.validatorSignature[0] = (block.validatorSignature[0]! + 1) % 256;

    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(block)).toBe(false);

    // Rolled back whole: no block, no height, no journal, no coinbase mint.
    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(0);

    const journal = await importJournalStore();
    expect(journal.getBlockJournal(1)).toBeNull();

    const { getCreditBoxes } = (await import('../../src/store/utxo.js')) as {
      getCreditBoxes: (owner: Uint8Array) => unknown[];
    };
    expect(getCreditBoxes(coinbaseOf(block)[0]!.owner)).toHaveLength(0);
  });

  it('rejects a block carrying the all-zero placeholder signature', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    // What every hand-built block used to carry, and what an unsigned forgery
    // costs nothing to produce.
    const block = await makeApplicableBlock();
    block.validatorSignature = new Uint8Array(64);

    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(block)).toBe(false);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(0);
  });

  it('rejects a block signed by a key other than the one its validatorId names', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    // The H-1 attack in full: the forger does the (testnet-cheap) PoW and
    // publishes under another validator's identity. Every other check passes —
    // the block is internally consistent, on-schedule, and correctly mined.
    // Only the signature ties block production to the key that claims it.
    const forger = makeTestIdentity();
    const block = await makeApplicableBlock({ signWith: forger.privateKey });
    expect(verifyOrderingBlockPoW(block.header)).toBe(true);
    expect(block.header.validatorId).not.toEqual(forger.userId);

    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(block)).toBe(false);

    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(0);

    const journal = await importJournalStore();
    expect(journal.getBlockJournal(1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// H-3: consensus-carried sub-block authorship + prune authorship binding
// ---------------------------------------------------------------------------

describe('block-apply H-3 sub-block authorship and prune binding', () => {
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
  // Prune authorship binding — the H-3 attack itself
  // -----------------------------------------------------------------------

  it('rejects a block pruning a subtree under a key that is not the root author', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const attacker = makeTestIdentity();
    // ⛔ The block must CARRY the post transaction, not a claim about the post.
    // `block_topology`'s author comes from `tx.post.author` now, so a fixture
    // that seeded the post and asserted an id would be testing its own
    // arithmetic — the binding under attack here is the one apply derives.
    const { post, tx: postTx, postId } = await seedPostTx(author, 'victim post');

    const blockApply = await importBlockApply();

    // Height 1 confirms the post — that is what records its author in
    // block_topology, and it is the only place the author is recorded.
    const confirmBlock = await makeApplicableBlock({ utxoTxs: [postTx] });
    expect(blockApply.applyOrderingBlock(confirmBlock)).toBe(true);

    // Height 2 is the attack: the prune is signed, correctly, by a key that has
    // nothing to do with the post. Merkle root, postId set and signature all
    // verify — only the binding to the recorded author does not.
    const pruneBlock = await makeApplicableBlock({
      height: 2,
      pruneEntries: [makePruneEntry(postId, [postId], attacker)],
    });
    expect(hex(attacker.userId)).not.toBe(hex(author.userId));
    expect(blockApply.applyOrderingBlock(pruneBlock)).toBe(false);

    // Rolled back whole: no block at 2, no settlement, no DAG deletion.
    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(2)).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(1);

    const journal = await importJournalStore();
    expect(journal.getBlockJournal(2)).toBeNull();

    const posts = await importPosts();
    const stored = posts.getPost(postId);
    expect(stored).not.toBeNull();
    expect((stored as Post).content).toBe('victim post');

    const { getStump } = (await import('../../src/store/stumps.js')) as {
      getStump: (id: string) => unknown;
    };
    expect(getStump(postId)).toBeNull();
  });

  it('accepts the same prune when authorId is the recorded author (control)', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const { post, tx: postTx, postId } = await seedPostTx(author, 'victim post');

    const posts = await importPosts();
    posts.insertPost(postId, post, encodePost(post));

    const blockApply = await importBlockApply();
    const confirmBlock = await makeApplicableBlock({
      utxoTxs: [postTx],
    });
    expect(blockApply.applyOrderingBlock(confirmBlock)).toBe(true);

    // Identical in shape to the rejected block above — the signing key is the
    // only difference, which is what makes that rejection non-vacuous.
    const pruneBlock = await makeApplicableBlock({
      height: 2,
      pruneEntries: [makePruneEntry(postId, [postId], author)],
    });
    expect(blockApply.applyOrderingBlock(pruneBlock)).toBe(true);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(2);

    const { getStump } = (await import('../../src/store/stumps.js')) as {
      getStump: (id: string) => { rootPostHash: string } | null;
    };
    expect(getStump(postId)?.rootPostHash).toBe(postId);
  });

  it('rejects a prune of a root no applied block has confirmed', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    // The author's own key, the author's own post — but nothing has confirmed
    // it, so block_topology has no author for it and it is not prunable. Held
    // locally and unconfirmed is exactly the state a gossip-only post is in.
    const author = makeTestIdentity();
    const { post, tx: postTx, postId } = await seedPostTx(author, 'unconfirmed post');

    const posts = await importPosts();
    posts.insertPost(postId, post, encodePost(post));

    const { getTopologyAuthor } = (await import('../../src/store/topology.js')) as {
      getTopologyAuthor: (postId: string) => string | null;
    };
    expect(getTopologyAuthor(postId)).toBeNull();

    const blockApply = await importBlockApply();
    const pruneBlock = await makeApplicableBlock({
      pruneEntries: [makePruneEntry(postId, [postId], author)],
    });
    expect(blockApply.applyOrderingBlock(pruneBlock)).toBe(false);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(0);
    expect((posts.getPost(postId) as Post).content).toBe('unconfirmed post');
  });

  it('accepts the same prune once a block has confirmed the root (control)', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const { post, tx: postTx, postId } = await seedPostTx(author, 'confirmed post');

    const posts = await importPosts();
    posts.insertPost(postId, post, encodePost(post));

    const blockApply = await importBlockApply();
    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({
          utxoTxs: [postTx],
        }),
      ),
    ).toBe(true);

    // Same entry, same key — the topology row is the only thing that changed.
    const pruneBlock = await makeApplicableBlock({
      height: 2,
      pruneEntries: [makePruneEntry(postId, [postId], author)],
    });
    expect(blockApply.applyOrderingBlock(pruneBlock)).toBe(true);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Entry-vs-post verification — content-holders keep lying entries out
  // -----------------------------------------------------------------------

  // ⚠ Every fixture in this cluster carries ONE parent ref, and that is
  // load-bearing rather than cosmetic. `MAX_PARENT_REFS` is 1, and
  // `verifyOrderingBlockStructure` enforces it in the structure gate at the top
  // of `applyOrderingBlock` — ahead of the entry-vs-post comparison against
  // `realParents` that these tests exist for. A
  // two-ref fixture is therefore rejected for its COUNT, so the three
  // `toBe(false)` cases below would keep passing with the H-3 comparison
  // deleted entirely. Only the control fails loudly; the rest fail silently, so
  // the width is what keeps them honest.

  it('accepts a block whose entry matches the local post (control)', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const parentA = 'a1'.repeat(32);
    const { post, tx: postTx, postId } = await seedPostTx(author, 'child post', { parentRefs: [parentA] },
    );

    const posts = await importPosts();
    posts.insertPost(postId, post, encodePost(post));

    const blockApply = await importBlockApply();
    const block = await makeApplicableBlock({ utxoTxs: [postTx] });
    expect(blockApply.applyOrderingBlock(block)).toBe(true);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(1);
  });

  // ⛔ Reserved, never to be reused: the unseen-post placeholder case.
  //
  // It covered a node that confirmed a post it had no content for — the state
  // a `SubBlockEntry` created by carrying topology without content. **That
  // state is unreachable**: a block carries its posts inside `utxoTxs`, so a
  // node applying a block always has the content, `insertPostPlaceholder` has
  // no producer, and `block_topology` is derived from `tx.post` rather than
  // recorded from a claim it cannot check.
});

// ---------------------------------------------------------------------------
// The apply funnel is a total function of its input
//
// `verifyOrderingBlockStructure` ran only in the gossip topic validator, so the
// pull-sync path — CBOR-decode straight into the apply handler — reached
// consensus code with fields of arbitrary type. Nothing between there and the
// prune loop's `Buffer.from(entry.subtreeMerkleRoot)` checks that field, and a
// throw out of `applyOrderingBlock` becomes an unhandled rejection in the
// gossip callback (whose promise the net layer discards), which exits the
// process. A rejected block is never stored, so the node re-fetches it on
// restart and dies again: one cheaply-mined block, a permanent network-wide
// crash loop.
// ---------------------------------------------------------------------------

describe('block-apply funnel totality', () => {
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
    vi.doUnmock('../../src/store/journal.js');
    vi.resetModules();
  });

  /**
   * A confirmed post and its consensus-recorded author — the state an attacker
   * builds a prune entry against. `rootPostHash` and the recorded author are
   * public consensus data (they ride in every block), so nothing here is a
   * secret the attacker has to obtain.
   */
  async function confirmedPost(): Promise<{ postId: string; author: TestIdentity }> {
    const author = makeTestIdentity();
    const { post, tx: postTx, postId } = await seedPostTx(author, 'victim post');

    const posts = await importPosts();
    posts.insertPost(postId, post, encodePost(post));

    const blockApply = await importBlockApply();
    const confirmBlock = await makeApplicableBlock({ utxoTxs: [postTx] });
    expect(blockApply.applyOrderingBlock(confirmBlock)).toBe(true);
    return { postId, author };
  }

  // -----------------------------------------------------------------------
  // The kill shot: a prune entry whose subtreeMerkleRoot is not bytes
  // -----------------------------------------------------------------------

  /**
   * Build the block a malicious producer actually ships: honest roots over an
   * honest entry, then the hostile entry swapped into the body afterwards.
   *
   * The entry can no longer be present while the block is built —
   * `computeUtxoTxRoot` runs `serializePruneEntry`, which has no encoding for
   * a non-byte root — so the swap is the only way to construct the case at all.
   * `expectUnbuildable` below pins that, because it is half the property.
   */
  async function killBlockAtHeight2(
    postId: string,
    author: TestIdentity,
  ): Promise<{ block: OrderingBlock; killEntry: PruneEntry }> {
    const killEntry = {
      ...makePruneEntry(postId, [postId], author),
      subtreeMerkleRoot: 42,
    } as unknown as PruneEntry;
    const block = await makeApplicableBlock({
      height: 2,
      pruneEntries: [makePruneEntry(postId, [postId], author)],
    });
    block.utxoTxTree.pruneEntries[0] = killEntry;
    return { block, killEntry };
  }

  const STRUCTURE_REJECTION =
    'Rejected block: invalid structure: Ordering block pruneEntry has invalid subtreeMerkleRoot';

  it('rejects a non-Uint8Array subtreeMerkleRoot at the structure gate, before any Merkle work', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const { postId, author } = await confirmedPost();
    const blockApply = await importBlockApply();
    const { block, killEntry } = await killBlockAtHeight2(postId, author);

    // Half the property: the honest producer cannot build this block at all now.
    await expect(
      makeApplicableBlock({ height: 2, pruneEntries: [killEntry] }),
    ).rejects.toThrow();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let applied: boolean | undefined;
    expect(() => { applied = blockApply.applyOrderingBlock(block); }).not.toThrow();
    const warnings = warn.mock.calls.map((c) => String(c[0]));
    const errors = error.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    error.mockRestore();

    expect(applied).toBe(false);

    // ---- the verdict, by its exact label -----------------------------------
    // `verifyOrderingBlockStructure` owns this rejection (it lives in
    // `@dagsocial/validation`, not in this package), and
    // naming the string is what stops the test passing on some *other*
    // rejection — a root mismatch, say, which is what a fixture that injected
    // the entry and asserted only `false` would silently have settled for.
    expect(warnings, `got ${JSON.stringify(warnings)}`).toContain(STRUCTURE_REJECTION);

    // ---- THE ORDERING PIN --------------------------------------------------
    // The structure gate runs at the top of `applyOrderingBlock`, Merkle
    // recomputation later in the same funnel (§4). That ordering is
    // load-bearing: `computeUtxoTxRoot` is partial, so if the two ever swap,
    // this block throws into the funnel's totality catch instead of producing a
    // verdict. Nothing else in the suite would notice — `applyOrderingBlock`
    // answers `false` either way — so the absence of that catch's log line is
    // the whole signal.
    expect(errors.filter((e) => e.includes('unexpected failure during apply'))).toEqual([]);

    // …and the reason the ordering matters, stated rather than assumed. Without
    // this line the pin above is vacuous: it would also hold if the Merkle
    // computation were still total.
    const { computeUtxoTxRoot } = await import('../../src/services/block-creator.js');
    expect(() => computeUtxoTxRoot(block.utxoTxTree)).toThrow();

    // Rolled back whole: the chain does not move and no journal is written.
    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(2)).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(1);

    const journal = await importJournalStore();
    expect(journal.getBlockJournal(2)).toBeNull();
    expect(journal.isBlockJournalOpen()).toBe(false);

    // The prune did not settle: the victim's content is untouched.
    const posts = await importPosts();
    expect((posts.getPost(postId) as Post).content).toBe('victim post');
  });

  it('accepts the same block with a real 32-byte subtreeMerkleRoot (control)', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const { postId, author } = await confirmedPost();
    const blockApply = await importBlockApply();

    // Identical in every field but one: the merkle root is the real root over
    // the subtree ids and the signature covers it. That is what makes the
    // rejection above a verdict on the field's *type* and nothing else.
    const block = await makeApplicableBlock({
      height: 2,
      pruneEntries: [makePruneEntry(postId, [postId], author)],
    });
    expect(blockApply.applyOrderingBlock(block)).toBe(true);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(2);

    const { getStump } = (await import('../../src/store/stumps.js')) as {
      getStump: (id: string) => { rootPostHash: string } | null;
    };
    expect(getStump(postId)?.rootPostHash).toBe(postId);
  });

  // -----------------------------------------------------------------------
  // Path independence — the sync path has no gossip validator in front of it
  // -----------------------------------------------------------------------

  it('the malformed block cannot cross the wire, and the funnel rejects it anyway', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const { postId, author } = await confirmedPost();
    const blockApply = await importBlockApply();

    const { block: killBlock } = await killBlockAtHeight2(postId, author);

    // What `NetNode.appendBlocks` does with a peer's Modifier response: decode
    // the bytes and hand the result straight to the apply handler. No topic
    // validator runs on this path, which is why the structure check cannot
    // live in gossip.
    //
    // ⚠ **Phase 3b closed the wire half of this, and the old assertion said so
    // in advance without meaning to.** It read "the wire round-trip preserves
    // the hostile field verbatim — a CBOR integer decodes back to a number, not
    // to bytes", which was the defect: a self-describing encoder let a number
    // occupy a 32-byte field all the way to the apply funnel.
    //
    // `subtreeMerkleRoot` is `b32` from bytes now, so `writeBytesNOrThrow`
    // refuses a number and this block **has no encoding at all** — it cannot be
    // put on the sync path by anyone. Pinned as the first assertion, because
    // "the funnel rejects it" and "it cannot arrive" are different guarantees
    // and this test now carries both.
    expect(() => encodeOrderingBlock(killBlock)).toThrow(/expected 32 bytes, got number/);

    // The funnel's guarantee is path-independent and survives regardless: it is
    // about a struct reaching `applyOrderingBlock`, which is still reachable
    // in-process (the sync handler hands over a decoded object, and a future
    // codec change must not be what keeps this honest). So the rest of the test
    // runs against the struct directly, which is what it was really asserting.
    const decoded = killBlock;
    expect(typeof decoded.utxoTxTree.pruneEntries[0]!.subtreeMerkleRoot).toBe('number');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let applied: boolean | undefined;
    expect(() => { applied = blockApply.applyOrderingBlock(decoded); }).not.toThrow();
    const warnings = warn.mock.calls.map((c) => String(c[0]));
    const errors = error.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    error.mockRestore();

    expect(applied).toBe(false);
    // Same verdict and same ordering pin as the direct path — that identity is
    // the point of the test: the guarantee is path-independent because it lives
    // in the funnel, not in the gossip validator.
    expect(warnings, `got ${JSON.stringify(warnings)}`).toContain(STRUCTURE_REJECTION);
    expect(errors.filter((e) => e.includes('unexpected failure during apply'))).toEqual([]);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(1);
  });

  it('accepts a well-formed block over the same sync path (control)', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const { postId, author } = await confirmedPost();
    const blockApply = await importBlockApply();

    const block = await makeApplicableBlock({
      height: 2,
      pruneEntries: [makePruneEntry(postId, [postId], author)],
    });
    const decoded = decodeOrderingBlock(encodeOrderingBlock(block));
    expect(blockApply.applyOrderingBlock(decoded)).toBe(true);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Totality backstop — an unexpected throw is a rejection, not a crash
  // -----------------------------------------------------------------------

  it('returns false and rolls back when apply throws for a reason no check anticipated', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    // A failure from the last step of apply, past every consensus check and
    // past every state mutation the block makes: the block row is written and
    // the coinbase is minted before this runs. Nothing about the block is
    // malformed — this stands in for the class of defect structure validation
    // cannot enumerate in advance.
    vi.doMock('../../src/store/journal.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/store/journal.js')>(
        '../../src/store/journal.js',
      );
      return {
        ...actual,
        insertBlockJournal: () => {
          throw new Error('disk on fire');
        },
      };
    });

    const blockApply = await importBlockApply();
    const block = await makeApplicableBlock();

    expect(() => blockApply.applyOrderingBlock(block)).not.toThrow();
    expect(blockApply.applyOrderingBlock(block)).toBe(false);

    // Rolled back whole — including the mutations that had already landed
    // inside the transaction before the throw.
    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(0);

    const { getCreditBoxes } = (await import('../../src/store/utxo.js')) as {
      getCreditBoxes: (owner: Uint8Array) => unknown[];
    };
    expect(getCreditBoxes(coinbaseOf(block)[0]!.owner)).toHaveLength(0);

    // The half-built journal is dropped, so the next block does not inherit it.
    const journalStore = await importJournalStore();
    expect(journalStore.isBlockJournalOpen()).toBe(false);
  });

  it('applies the same block with no stub in place (control)', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const blockApply = await importBlockApply();
    const block = await makeApplicableBlock();
    expect(blockApply.applyOrderingBlock(block)).toBe(true);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(1);

    const journal = await importJournalStore();
    expect(journal.getBlockJournal(1)).not.toBeNull();

    const { getCreditBoxes } = (await import('../../src/store/utxo.js')) as {
      getCreditBoxes: (owner: Uint8Array) => unknown[];
    };
    expect(getCreditBoxes(coinbaseOf(block)[0]!.owner)).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // Confirmed-entry cleanup on the received-block path
  // -----------------------------------------------------------------------

  it("a peer's block clears a confirmed transaction sitting deep in the pool", async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const mempool = await importMempoolFresh();
    const blockApply = await importBlockApply();

    // ⛔ The pool has to be deeper than the literal the cleanup scan carried
    // (1000), or the fixture cannot tell a keyed delete from a bounded one:
    // every entry a shallow pool holds is inside any bound.
    const DEPTH = 1_100;
    for (let i = 0; i < DEPTH; i++) mempool.insertUtxoTx(fillerTx(`deep_${i}`), 5000);

    const author = makeTestIdentity();
    const { tx: postTx } = await seedPostTx(author, 'confirmed by a peer');
    const deepRowid = mempool.insertUtxoTx(postTx, 5000);
    expect(deepRowid).toBeGreaterThan(1000);

    // ⛔ The RECEIVED-block path, not `mineNextBlock`. `finalizeBlock` evicts by
    // `minedRowids` regardless of position, so a locally produced block clears
    // this row whatever the cleanup does — a test that mined here would pass
    // without exercising anything.
    const block = await makeApplicableBlock({ utxoTxs: [postTx] });
    expect(blockApply.applyOrderingBlock(block)).toBe(true);

    const after = mempool.getPendingEntries(DEPTH + 10);
    expect(after.some((e) => e.rowid === deepRowid)).toBe(false);
    // …and only that row: the block confirmed one transaction, so the cleanup
    // is keyed rather than a sweep.
    expect(after).toHaveLength(DEPTH);
  });
});

