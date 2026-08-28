import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  computeTxId,
  PROTOCOL_VERSION,
  LIKE_KARMA_COST,
  KARMA_STALE_THRESHOLD_BLOCKS,
  EMPTY_STATE_ROOT,
  VOUCH_KARMA_AMOUNT,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  MAX_BLOCK_BODY_BYTES,
} from '@dagsocial/types';
import { verifyOrderingBlockPoW } from '@dagsocial/validation';
import type {
  KarmaBox,
  CreditBox,
  VouchBox,
  VouchEscrowBox,
  PostLockBox,
  BlockHeader,
  OrderingBlock,
  UtxoTransaction,
} from '@dagsocial/types';
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
  hex,
  makeApplicableBlock,
  makeCreditBox,
  makeCreditTx,
  makeKarmaBox,
  makeLikeTx,
  makePostCommit,
  makeTestConfig,
  makeTestIdentity,
  mineNextBlock,
  seedProvenance,
  signHeader,
  signTransaction,
  seedPostTx, fillerTx,
  coinbaseOf, withCoinbase,
  seedEmissionBox, seedKarmaPoolBox } from '../helpers.js';

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
  return await import('../../src/store/posts.js');
}

async function importMempoolFresh() {
  const mod = await import('../../src/store/mempool.js');
  return mod as {
    insertUtxoTx: (tx: UtxoTransaction, expiresAtHeight: number) => number;
    getPendingEntries: (limit: number) => Array<{
      rowid: number;
      entryType: string;
      utxoTxBytes: Uint8Array | null;
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
  // 2. Post confirm records confirmedPostIds in journal
  // -----------------------------------------------------------------------

  it('post confirm records confirmedPostIds in journal', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();

    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'journal test post');

    const posts = await importPosts();
    posts.insertPost(postId, commit, content);

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
    expect(saved!.confirmedPostIds).toContain(postId);
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

    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'utxo journal test');
    const { computeTxId } = await import('@dagsocial/types');
    posts.insertPost(postId, commit, content);

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
    expect(applied.txBytes).toBeInstanceOf(Uint8Array);
    expect(computeTxId(decodeTx(applied.txBytes))).toBe(applied.txId);

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
        interlinkRoot: '00'.repeat(32),
      },
      utxoTxTree: {
        // A body's last entry is its settlement; PoW is refused before anything
        // reads it, so an opaque one is enough here.
        utxoTxIds: ['99'.repeat(32)],
        utxoTxs: [new Uint8Array(96).fill(0x99)],
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
        interlinkRoot: '00'.repeat(32),
      },
      utxoTxTree: {
        // A body's last entry is its settlement; PoW is refused before anything
        // reads it, so an opaque one is enough here.
        utxoTxIds: ['99'.repeat(32)],
        utxoTxs: [new Uint8Array(96).fill(0x99)],
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
        interlinkRoot: '00'.repeat(32),
      },
      utxoTxTree: {
        // A body's last entry is its settlement; PoW is refused before anything
        // reads it, so an opaque one is enough here.
        utxoTxIds: ['99'.repeat(32)],
        utxoTxs: [new Uint8Array(96).fill(0x99)],
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
  // 9. Coinbase mismatch — the settlement's step-4 total check refuses a
  // block whose coinbase pays less than the miner slice
  // (NODE_INTERFACE → The settlement transaction).
  // -----------------------------------------------------------------------

  it('block refused for coinbase value mismatch leaves no journal', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const blockApply = await importBlockApply();

    // One credit less than the miner slice, lock unchanged — step 4's total
    // check is the first thing that refuses it.
    const block = await makeApplicableBlock({
      settlement: (tx) => ({
        ...tx,
        outputs: tx.outputs.map((o) =>
          o.boxType === 'credit' ? { ...o, value: o.value - 1n } : o,
        ),
      }),
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = blockApply.applyOrderingBlock(block);
    const warnings = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();

    expect(result).toBe(false);
    expect(
      warnings.some((w) => w.includes('coinbase value') && w.includes('miner slice')),
      `expected coinbase-mismatch reason, got ${JSON.stringify(warnings)}`,
    ).toBe(true);

    const journal = await importJournalStore();
    expect(journal.getBlockJournal(1)).toBeNull();
    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(0);
  });

  it('control — the same block applies when the coinbase is correct', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const blockApply = await importBlockApply();

    expect(blockApply.applyOrderingBlock(await makeApplicableBlock())).toBe(true);

    const journal = await importJournalStore();
    expect(journal.getBlockJournal(1)).not.toBeNull();
    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(1);
  });

  // A zero-value coinbase satisfies conservation (step 5), which is why
  // step 4 names it before the total (NODE_INTERFACE → The settlement
  // transaction).
  it('block refused for zero-value coinbase output', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const blockApply = await importBlockApply();
    const miner = makeTestIdentity();

    const block = await makeApplicableBlock({
      miner,
      settlement: withCoinbase([{ owner: miner.userId, value: 0n }]),
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = blockApply.applyOrderingBlock(block);
    const warnings = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();

    expect(result).toBe(false);
    expect(
      warnings.some((w) => w.includes('zero-value coinbase output')),
      `expected zero-value reason, got ${JSON.stringify(warnings)}`,
    ).toBe(true);
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
      return splitCoinbase(computeBlockReward(1), fees, 0n, actors).miner;
    }

    it('accepts a coinbase claiming the fees of the block it carries', async () => {
      const db = await importDb();
      db.initDb(':memory:');
      const utxo = await importUtxo();
      const blockApply = await importBlockApply();

      const sender = makeTestIdentity();
      const miner = makeTestIdentity();
      const boxA = makeCreditBox(100_000n, sender.userId, 0, 1);
      const boxB = makeCreditBox(50_000n, sender.userId, 0, 2);
      utxo.insertBox(boxA);
      utxo.insertBox(boxB);

      // No `coinbaseSplit`: the helper builds the coinbase this body requires,
      // which is the thing under test.
      const block = await makeApplicableBlock({
        miner,
        utxoTxs: [makeCreditTx(sender, [boxA], 10_000n), makeCreditTx(sender, [boxB], 5_000n)],
      });

      expect(blockApply.applyOrderingBlock(block)).toBe(true);
      const paid = utxo.getCreditBoxes(miner.userId)[0]!.value;
      expect(paid).toBe(await minerSliceAt1(15_000n, 0));
      // And the fees moved the number — otherwise this passes on a coinbase
      // that ignored them entirely.
      expect(paid).toBeGreaterThan(await minerSliceAt1(0n, 0));
    });

    it('rejects a coinbase claiming more than emission plus fees', async () => {
      const db = await importDb();
      db.initDb(':memory:');
      const utxo = await importUtxo();
      const blockApply = await importBlockApply();
      await import('../../src/services/block-creator.js');

      const sender = makeTestIdentity();
      const miner = makeTestIdentity();
      const box = makeCreditBox(100_000n, sender.userId, 0, 1);
      utxo.insertBox(box);

      // One base unit above the slice this body earns.
      const block = await makeApplicableBlock({
        miner,
        utxoTxs: [makeCreditTx(sender, [box], 10_000n)],
        settlement: withCoinbase([
          { owner: miner.userId, value: (await minerSliceAt1(10_000n, 0)) + 1n },
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
      await import('../../src/services/block-creator.js');

      const sender = makeTestIdentity();
      const miner = makeTestIdentity();
      const box = makeCreditBox(100_000n, sender.userId, 0, 1);
      utxo.insertBox(box);

      // The slice this body would earn if its transaction paid nothing —
      // under-claiming is a rejection, not a donation, or one block has more
      // than one valid encoding.
      const block = await makeApplicableBlock({
        miner,
        utxoTxs: [makeCreditTx(sender, [box], 10_000n)],
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
      await import('../../src/services/block-creator.js');
      const { materializeOutput } = await import('../../src/services/utxo-engine.js');

      const sender = makeTestIdentity();
      const miner = makeTestIdentity();
      const boxA = makeCreditBox(100_000n, sender.userId, 0, 1);
      utxo.insertBox(boxA);

      // A: 100k → 90k, fee 10k. B spends A's output: 90k → 85k, fee 5k.
      const txA = makeCreditTx(sender, [boxA], 10_000n);
      const aOutput = materializeOutput(
        txA.outputs[0] as never,
        computeTxId(txA),
        0,
      ) as CreditBox;
      const txB = makeCreditTx(sender, [aOutput], 5_000n);

      const block = await makeApplicableBlock({ miner, utxoTxs: [txA, txB] });

      expect(blockApply.applyOrderingBlock(block)).toBe(true);
      expect(utxo.getCreditBoxes(miner.userId)[0]!.value).toBe(await minerSliceAt1(15_000n, 0));
      // B's output survives, so the chain really applied rather than the block
      // passing on A alone.
      expect(utxo.getCreditBoxes(sender.userId)[0]!.value).toBe(85_000n);
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
      await import('../../src/services/block-creator.js');

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
      await import('../../src/services/block-creator.js');

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
      const split = splitCoinbase(computeBlockReward(1), 0n, 0n, 0);
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
    };

    const staleHeight = KARMA_STALE_THRESHOLD_BLOCKS + 100;
    const ownerHex = Buffer.from(identity.userId).toString('hex');
    const karmaBoxes = deps.getKarmaBoxes(identity.userId);
    const postBody = new Map([[ownerHex, { owner: identity.userId, boxes: karmaBoxes }]]);
    const entries: DecayPlan[] = deriveKarmaDecay(deps, postBody, staleHeight, decayCfg);

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

  it('the settlement returns a matured escrow as karma', async () => {
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

    // The settlement consumed the escrow and returned its value as karma.
    expect(utxo.getUnspentBoxes().some((b) => b.boxType === 'vouch_escrow')).toBe(false);
    expect(utxo.getKarmaValue(voucher.userId)).toBe(50n + 7n);
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
    const { commit: commitA, tx: postATx, postId: postAId, content: contentA } = await seedPostTx(author, 'valid-txs target a');
    const { commit: commitB, tx: postBTx, postId: postBId, content: contentB } = await seedPostTx(author, 'valid-txs target b');
    posts.insertPost(postAId, commitA, contentA);
    posts.insertPost(postBId, commitB, contentB);
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
    const { commit: commitA, tx: postATx, postId: postAId, content: contentA } = await seedPostTx(author, 'defer-retry target a');
    const { commit: commitB, tx: postBTx, postId: postBId, content: contentB } = await seedPostTx(author, 'defer-retry target b');
    posts.insertPost(postAId, commitA, contentA);
    posts.insertPost(postBId, commitB, contentB);
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
  // read one (NODE_INTERFACE → Store Interface): `getKarmaBox` is `LIMIT 1` with no
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
    const slice = splitCoinbase(computeBlockReward(1), 0n, 0n, 0).miner;
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

  it('a stale untouched identity keeps its face karma — no decay settlement leg', async () => {
    // Under virtual decay a stale identity nothing touches keeps its face
    // values; its effective dissolves but no settlement leg fires. The escrow
    // survives as before.
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
      const journalStore = await importJournalStore();
      const idle = makeTestIdentity();
      utxo.insertBox(makeKarmaBox(50n, idle.userId, 0));
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
      const block = await mineNextBlock(bc);
      expect(block).not.toBeNull();

      const journal = journalStore.getBlockJournal(4)!;
      const ownerHex = hex(idle.userId);
      const karmaMints = journal.mutations
        .filter((m): m is BoxMutation => m.kind === 'box' && m.op === 'insert')
        .map((m) => m.box as AnyBox)
        .filter((b) => b.boxType === 'karma' && hex((b as KarmaBox).owner) === ownerHex);

      // The only karma mint is the escrow return. No decay leg fired — face stays.
      expect(karmaMints.length).toBe(1);
      expect((karmaMints[0] as KarmaBox).value).toBe(VOUCH_KARMA_AMOUNT);

      // The karma box is live at face + the returned escrow.
      expect(utxo.getKarmaValue(idle.userId)).toBe(50n + VOUCH_KARMA_AMOUNT);

      // The escrow was consumed by the settlement.
      expect(utxo.getUnspentBoxes().some((b) => b.boxType === 'vouch_escrow')).toBe(false);

      // ⛔ The hazard: the returned karma must NOT have moved lastActivityBlock.
      const records = await import('../../src/store/identity-records.js');
      const record = records.getIdentityRecord(idle.userId);
      expect(record?.lastActivityBlock ?? 0).toBe(0);
    } finally {
      vi.doUnmock('../../src/config.js');
    }
  });

  it('a stale untouched identity keeps its record — no clock advances without a touch', async () => {
    // Under virtual decay the record does not move for an untouched identity:
    // no decay settlement leg fires, so lastDecayBlock stays where it was.
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


      const idle = makeTestIdentity();
      utxo.insertBox(makeKarmaBox(50n, idle.userId, 0));
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
      for (let i = 0; i < 4; i++) await mineNextBlock(bc);
      expect(await mineNextBlock(bc)).not.toBeNull();

      // No touch: the record is unchanged from genesis seeding.
      const record = records.getIdentityRecord(idle.userId);
      expect(record?.lastDecayBlock ?? 0).toBe(0);
      // ⛔ The hazard: lastActivityBlock must not have moved from the escrow return.
      expect(record?.lastActivityBlock ?? 0).toBe(0);

      // Face + the returned escrow — decay is virtual, no squaring fired.

      expect(utxo.getKarmaValue(idle.userId)).toBe(50n + VOUCH_KARMA_AMOUNT);
      expect(utxo.getUnspentBoxes().some((b) => b.boxType === 'vouch_escrow')).toBe(false);
    } finally {
      vi.doUnmock('../../src/config.js');
    }
  });

  it('a stale TOUCHED identity is squared: post tx applies, owner ends at effective', async () => {
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
      const mempool = await import('../../src/store/mempool.js');
      const { POST_LOCK_THREAD_COST, KARMA_DECAY_AMOUNT, KARMA_MINIMUM } =
        await import('@dagsocial/types');

      const stale = makeTestIdentity();
      const karmaBox = makeKarmaBox(50n, stale.userId, 0);
      utxo.insertBox(karmaBox);

      const bc = await importBlockCreator();
      bc.startBlockCreator(testConfig);
      await mineNextBlock(bc);
      await mineNextBlock(bc);
      await mineNextBlock(bc);

      const { getKarmaPoolBox } = await import('../../src/store/utxo.js');
      const poolBefore = getKarmaPoolBox()!.value;

      const staleCommit = makePostCommit(stale.userId, 'stale post');
      const postTx: UtxoTransaction = {
        inputs: [karmaBox.id!],
        outputs: [
          { boxType: 'karma', value: 50n - POST_LOCK_THREAD_COST, createdAtBlock: 0, owner: stale.userId } as never,
          { boxType: 'post_lock', value: POST_LOCK_THREAD_COST, createdAtBlock: 0, originalValue: POST_LOCK_THREAD_COST, owner: stale.userId } as never,
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
        post: staleCommit,
      };
      signTransaction(postTx, stale.privateKey, hex(stale.userId));
      mempool.insertUtxoTx(postTx, 1000);

      const block = await mineNextBlock(bc);
      expect(block).not.toBeNull();

      const postBodyChange = 50n - POST_LOCK_THREAD_COST;
      const periods = 4;
      const owed = BigInt(periods) * KARMA_DECAY_AMOUNT;
      const floor = postBodyChange < KARMA_MINIMUM ? postBodyChange : KARMA_MINIMUM;
      const effective = (postBodyChange - owed) > floor
        ? postBodyChange - owed : floor;
      const burn = postBodyChange - effective;

      expect(utxo.getKarmaValue(stale.userId)).toBe(effective);
      expect(records.getIdentityRecord(stale.userId)!.lastDecayBlock).toBe(4);

      const poolAfter = getKarmaPoolBox()!.value;
      expect(poolAfter - poolBefore).toBe(burn);
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
// H-3: consensus-carried post authorship + prune authorship binding
// ---------------------------------------------------------------------------

describe('block-apply H-3 post authorship and prune binding', () => {
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
    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'child post', { parentRefs: [parentA] },
    );

    const posts = await importPosts();
    posts.insertPost(postId, commit, content);

    const blockApply = await importBlockApply();
    const block = await makeApplicableBlock({ utxoTxs: [postTx] });
    expect(blockApply.applyOrderingBlock(block)).toBe(true);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The apply funnel is a total function of its input
//
// An unexpected throw out of `applyOrderingBlock` becomes an unhandled
// rejection in the gossip callback, which exits the process. A rejected block
// is never stored, so the node re-fetches it on restart and dies again. The
// apply funnel catches every throw and converts it into `false`.
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

  it('successful apply pushes dagTipHeight', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const metrics = await import('../../src/metrics.js');
    expect(metrics.getDagTipHeight()).toBe(0);
    await mineNextBlock(bc);
    expect(metrics.getDagTipHeight()).toBe(1);
    await mineNextBlock(bc);
    expect(metrics.getDagTipHeight()).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Maturity bind: a prune in the same block the post is confirmed is rejected
  // -----------------------------------------------------------------------

  it('rejects a block carrying a post and a prune of that post (maturity bind)', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'same-block prune');
    posts.insertPost(postId, commit, content);

    const pruneKarma = makeKarmaBox(100n, author.userId, 0, 99);
    utxo.insertBox(pruneKarma);
    const pruneTx: UtxoTransaction = {
      inputs: [pruneKarma.id!],
      outputs: [{ boxType: 'karma' as const, value: 100n, createdAtBlock: 0, owner: author.userId }],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      prune: { rootPostHash: postId },
    };
    signTransaction(pruneTx, author.privateKey, hex(author.userId));

    const block = await makeApplicableBlock({ utxoTxs: [postTx, pruneTx] });
    const applied = blockApply.applyOrderingBlock(block);
    expect(applied).toBe(false);
  });

  it('accepts a prune in a block AFTER the post was confirmed (maturity bind satisfied)', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'earlier-block prune');
    posts.insertPost(postId, commit, content);

    const block1 = await makeApplicableBlock({ utxoTxs: [postTx] });
    expect(blockApply.applyOrderingBlock(block1)).toBe(true);

    const pruneKarma = makeKarmaBox(100n, author.userId, 0, 98);
    utxo.insertBox(pruneKarma);
    const pruneTx: UtxoTransaction = {
      inputs: [pruneKarma.id!],
      outputs: [{ boxType: 'karma' as const, value: 100n, createdAtBlock: 0, owner: author.userId }],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      prune: { rootPostHash: postId },
    };
    signTransaction(pruneTx, author.privateKey, hex(author.userId));

    const block2 = await makeApplicableBlock({ height: 2, utxoTxs: [pruneTx] });
    expect(blockApply.applyOrderingBlock(block2)).toBe(true);
  });

  it('rejects a block whose prune input owner is not the root topology author', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const stranger = makeTestIdentity();
    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'foreign-prune');
    posts.insertPost(postId, commit, content);

    expect(blockApply.applyOrderingBlock(await makeApplicableBlock({ utxoTxs: [postTx] }))).toBe(true);

    // The stranger builds a prune for the author's post.
    const strangerKarma = makeKarmaBox(100n, stranger.userId, 0, 97);
    utxo.insertBox(strangerKarma);
    const pruneTx: UtxoTransaction = {
      inputs: [strangerKarma.id!],
      outputs: [{ boxType: 'karma' as const, value: 100n, createdAtBlock: 0, owner: stranger.userId }],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      prune: { rootPostHash: postId },
    };
    signTransaction(pruneTx, stranger.privateKey, hex(stranger.userId));

    const block2 = await makeApplicableBlock({ height: 2, utxoTxs: [pruneTx] });
    expect(blockApply.applyOrderingBlock(block2)).toBe(false);
  });

  it('rejects a block whose prune root has no topology author (unconfirmed root)', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const unconfirmedRoot = 'dd'.repeat(32);

    const karma = makeKarmaBox(100n, author.userId, 0, 96);
    utxo.insertBox(karma);
    const pruneTx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [{ boxType: 'karma' as const, value: 100n, createdAtBlock: 0, owner: author.userId }],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      prune: { rootPostHash: unconfirmedRoot },
    };
    signTransaction(pruneTx, author.privateKey, hex(author.userId));

    const block = await makeApplicableBlock({ utxoTxs: [pruneTx] });
    expect(blockApply.applyOrderingBlock(block)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Interlink root (NODE_INTERFACE → Ordering block apply-time authorization)
  // -----------------------------------------------------------------------

  it('height 1 commits to interlinkRoot([])', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const ba = await importBlockApply();
    const { interlinkRoot } = await import('@dagsocial/types');
    const block = await makeApplicableBlock();
    expect(block.header.interlinkRoot).toBe(interlinkRoot([]));
    expect(ba.applyOrderingBlock(block)).toBe(true);
  });

  it('a block with a tampered interlinkRoot is rejected before any mutation', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const ba = await importBlockApply();
    const { solveHeaderPow } = await import('../helpers.js');
    const miner = makeTestIdentity();
    const { computeUtxoTxRoot, buildBlockSettlement } = await import(
      '../../src/services/block-creator.js'
    );
    const { expectedTarget } = await import('../../src/services/difficulty.js');
    const { encodeTx, interlinkRoot } = await import('@dagsocial/types');
    await seedEmissionBox();
    await seedKarmaPoolBox();
    const built = buildBlockSettlement([], 1, miner.userId, miner.userId);
    if ('error' in built) throw new Error(built.error);
    const tree = {
      utxoTxIds: [computeTxId(built.tx)],
      utxoTxs: [encodeTx(built.tx)],
    };
    const header: BlockHeader = {
      protocolVersion: PROTOCOL_VERSION,
      height: 1,
      prevBlockHash: ZERO_HASH,
      utxoTxRoot: computeUtxoTxRoot(tree),
      stateRoot: EMPTY_STATE_ROOT,
      validatorId: miner.userId,
      powNonce: 0,
      powTargetBits: expectedTarget(1),
      createdAt: Date.now(),
      interlinkRoot: 'ff'.repeat(32),
    };
    solveHeaderPow(header);
    const block: OrderingBlock = {
      header,
      utxoTxTree: tree,
      validatorSignature: signHeader(header, miner.privateKey),
    };
    expect(block.header.interlinkRoot).not.toBe(interlinkRoot([]));
    expect(ba.applyOrderingBlock(block)).toBe(false);

    const journal = await importJournalStore();
    expect(journal.getBlockJournal(1)).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Genesis pin (NODE_INTERFACE → Ordering block apply-time authorization)
  // -----------------------------------------------------------------------

  it('genesis pin: empty genesisId accepts any block 1', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const ba = await importBlockApply();
    expect(config.profile.genesisId).toBe('');
    const block = await makeApplicableBlock();
    expect(ba.applyOrderingBlock(block)).toBe(true);
  });

  it('genesis pin: pinned-match accepted', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const ba = await importBlockApply();
    const { blockHash } = await import('@dagsocial/validation');
    const block = await makeApplicableBlock();
    const bh = blockHash(block.header)!;
    // The profile is frozen; mock the config module so the funnel sees the pin.
    vi.doMock('../../src/config.js', () => ({
      config: { ...testConfig, profile: { ...config.profile, genesisId: bh } },
    }));
    const ba2 = (await import('../../src/services/block-apply.js')) as typeof ba;
    expect(ba2.applyOrderingBlock(block)).toBe(true);
  });

  it('genesis pin: pinned-mismatch rejected', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    // Mock config BEFORE block-apply imports it, so the funnel sees the pin.
    vi.doMock('../../src/config.js', () => ({
      config: { ...testConfig, profile: { ...config.profile, genesisId: 'ab'.repeat(32) } },
    }));
    const ba = (await import('../../src/services/block-apply.js')) as Awaited<ReturnType<typeof importBlockApply>>;
    const block = await makeApplicableBlock();
    expect(ba.applyOrderingBlock(block)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T4: the activity clock advances from the user-transaction loop
// ---------------------------------------------------------------------------

describe('T4: activity clock in the user-transaction loop', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch {
      // Module might not have been imported
    }
    vi.resetModules();
  });

  it('a karma-spending post with a change output advances lastActivityBlock', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'T4 clock post');
    const posts = await importPosts();
    posts.insertPost(postId, commit, content);

    const mempool = await importMempoolFresh();
    mempool.insertUtxoTx(postTx, 1000);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const block = await mineNextBlock(bc);
    expect(block).not.toBeNull();

    const records = await import('../../src/store/identity-records.js');
    const record = records.getIdentityRecord(author.userId);
    expect(record).not.toBeNull();
    expect(record!.lastActivityBlock).toBe(1);
  });

  it('a like exact-spend (no karma output) advances lastActivityBlock', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const liker = makeTestIdentity();
    const author = makeTestIdentity();

    // Seed a post for the liker to like.
    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'T4 like target');
    const posts = await importPosts();
    posts.insertPost(postId, commit, content);
    const mempool = await importMempoolFresh();
    mempool.insertUtxoTx(postTx, 1000);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    await mineNextBlock(bc);

    // Give the liker exactly LIKE_KARMA_COST — an exact spend.
    const utxo = await importUtxo();
    const likerKarma = makeKarmaBox(LIKE_KARMA_COST, liker.userId, 0, 42);
    utxo.insertBox(likerKarma);

    const likeTx = makeLikeTx(liker, likerKarma, postId, author.userId);
    mempool.insertUtxoTx(likeTx, 1000);

    const block2 = await mineNextBlock(bc);
    expect(block2).not.toBeNull();

    const records = await import('../../src/store/identity-records.js');
    const record = records.getIdentityRecord(liker.userId);
    expect(record).not.toBeNull();
    expect(record!.lastActivityBlock).toBe(2);
  });

  it('a settlement output to an owner does not advance their clock', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const liker = makeTestIdentity();

    // Seed a post for the liker to like — the author receives a settlement payout.
    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'T4 settlement target');
    const posts = await importPosts();
    posts.insertPost(postId, commit, content);
    const mempool = await importMempoolFresh();
    mempool.insertUtxoTx(postTx, 1000);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    await mineNextBlock(bc);

    const utxo = await importUtxo();
    const likerKarma = makeKarmaBox(100n, liker.userId, 0, 77);
    utxo.insertBox(likerKarma);

    const likeTx = makeLikeTx(liker, likerKarma, postId, author.userId);
    mempool.insertUtxoTx(likeTx, 1000);

    const records = await import('../../src/store/identity-records.js');
    const authorRecordBefore = records.getIdentityRecord(author.userId);
    const authorActivityBefore = authorRecordBefore!.lastActivityBlock;

    await mineNextBlock(bc);

    const authorRecordAfter = records.getIdentityRecord(author.userId);
    expect(authorRecordAfter!.lastActivityBlock).toBe(authorActivityBefore);
  });
});

