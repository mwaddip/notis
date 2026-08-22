import {
  fixtureProvenance,
  makeTestConfig,
  mineNextBlock,
  seedProvenance,
  signTransaction,
  solveHeaderPow,
  uid, fixturePostId, makePostTx, seedPostTx, fillerTx, coinbaseOf,
  seedEmissionBox } from '../helpers.js';
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  generateKeyPairSync,
  createHash,
  type KeyObject,
} from 'crypto';
import {
  computeBoxId,
  computePostId,
  MAX_BLOCK_BODY_BYTES,
  PROTOCOL_VERSION,
  LIKE_KARMA_COST, computeTxId, utxoTxTreeByteLength } from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import type {
  Post,
  KarmaBox,
  OrderingBlock,
  Stump,
  UtxoTransaction,
} from '@dagsocial/types';
import type { StoredPost } from '../../src/store/posts.js';
import type Database from 'better-sqlite3';
import type { Config } from '../../src/config.js';

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
  // Mining
  orderingBlockPowTargetBits: 3072,
  // Net settings
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
  computeUtxoTxRoot: (tree: OrderingBlock['utxoTxTree']) => string;
};

async function importDb(): Promise<DbModule> {
  return (await import('../../src/store/db.js')) as unknown as DbModule;
}

/**
 * The creator, over a store that holds this network's emission box.
 *
 * ⛔ **A miner below the terminus cannot produce a block without one.** The
 * block's settlement SPENDS the emission for its coinbase (MINING_INTERFACE →
 * Coinbase Application), so a store with nothing to spend from yields no
 * template at all — the creator declines rather than mining a body its own
 * applier refuses. Genesis seeds one on every network; these suites build stores
 * directly with `initDb(':memory:')`, which is what leaves the gap.
 *
 * Idempotent, and always called after `initDb`.
 */
async function importBlockCreator(): Promise<BlockCreatorModule> {
  await seedEmissionBox();
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
      utxoTxCbor: Uint8Array | null;
      expiresAtHeight: number;
      createdAt: string;
    }>;
    purgeExpired: (currentHeight: number) => number;
    removeEntry: (rowid: number) => void;
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown, postLockTarget?: string) => void;
    getKarmaBox: (owner: Uint8Array) => KarmaBox | null;
    consumeBox: (boxId: string, consumedAtBlock: number) => void;
  };
}

async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as {
    getCurrentHeight: () => number;
    getOrderingBlock: (height: number) => OrderingBlock | null;
  };
}

// ---------------------------------------------------------------------------
// Ed25519 helpers
// ---------------------------------------------------------------------------

/** Extract raw 32-byte Ed25519 public key from SPKI DER KeyObject. */
function rawPublicKey(keyObj: KeyObject): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

/** Create a public key KeyObject from raw 32-byte public key. */
function rawToKeyObject(pubKey: Uint8Array): KeyObject {
  const { createPublicKey } = require('crypto');
  const ED25519_SPKI_PREFIX = Buffer.from(
    '302a300506032b6570032100',
    'hex',
  );
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pubKey)]),
    format: 'der',
    type: 'spki',
  });
}

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

interface TestIdentity {
  userId: Uint8Array;
  publicKey: Uint8Array;
  privateKey: KeyObject;
}

function makeTestIdentity(): TestIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubKey = rawPublicKey(publicKey);
  const userId = pubKey;
  return { userId, publicKey: pubKey, privateKey };
}

function makePost(authorId: Uint8Array, content = 'test post'): Post {
  return {
    content,
    author: authorId,
    parentRefs: [],
    protocolVersion: PROTOCOL_VERSION,
    type: 'regular',
  };
}

function makeKarmaBox(
  value: bigint,
  owner: Uint8Array,
  seed: number,
): KarmaBox {
  const box = seedProvenance<KarmaBox>({
    boxType: 'karma',
    value,
    createdAtBlock: 0,
    owner,
  }, seed);
  const id = box.id;
  box.id = id;
  return box;
}

/**
 * A signed, value-conserving UTXO transaction used purely as inclusion
 * plumbing by the assembly tests below — the live burn shape (P2-D): one
 * karma change output at −LIKE_KARMA_COST, `likeTarget` naming the post.
 * Assembly does not validate transactions, so any conserving payload
 * exercises the same paths.
 */
function makeLikeTx(
  liker: TestIdentity,
  karmaBox: KarmaBox,
  targetPostId: string,
  author: Uint8Array = liker.userId,
): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [karmaBox.id!],
    outputs: [
      {
        boxType: 'karma',
        value: karmaBox.value - LIKE_KARMA_COST,
        createdAtBlock: 0,
        owner: liker.userId,
      } as KarmaBox,
      // ⛔ **The marker carries the cost.** The like conserves now: its karma
      // moves into a `LikeAccrualBox` earmarked for the author rather than
      // leaving the ledger (ARCHITECTURE → The conservation axiom).
      {
        boxType: 'like_accrual',
        value: LIKE_KARMA_COST,
        createdAtBlock: 0,
        author,
      } as unknown as KarmaBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    likeTarget: targetPostId,
  };
  signTransaction(tx, liker.privateKey, Buffer.from(liker.userId).toString('hex'));
  return tx;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('block-creator', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(async () => {
    // Stop the interval if running
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch {
      // Module might not have been imported
    }
    vi.resetModules();
  });

  // -----------------------------------------------------------------------
  // 1. Null return when nothing pending
  // -----------------------------------------------------------------------

  it('createOrderingBlock produces genesis block even with nothing pending', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    const block = await mineNextBlock(bc);
    // Empty blocks are always mined — miners need coinbase rewards.
    // At genesis (height 0→1), this produces a block with coinbase outputs.
    expect(block).not.toBeNull();
    expect(block!.header.height).toBe(1);
    // ⛔ **One entry: the settlement.** An "empty" body is not empty — every
    // block carries the transaction that pays its own coinbase, and it is the
    // LAST entry (NODE_INTERFACE → It is the LAST entry in `utxoTxIds`).
    expect(block!.utxoTxTree.utxoTxIds).toHaveLength(1);
    expect(coinbaseOf(block!).length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // 2. Pending post transaction triggers block creation
  // -----------------------------------------------------------------------

  it('pending sub-block triggers block creation', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    // Set up identity
    const author = makeTestIdentity();

    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'hello world');

    // The transaction IS the post's carrier: the pool holds one entry and the
    // block that takes it carries the payload (NODE_INTERFACE → Post
    // transactions).
    const mempool = await importMempoolFresh();
    mempool.insertUtxoTx(postTx, 1000);

    // Start block creator and create block
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    const block = await mineNextBlock(bc);
    expect(block).not.toBeNull();
    expect(block!.header.height).toBe(1);
    // ⛔ ONE committed list. The post rides `utxoTxIds` with everything else,
    // and its payload — parents and author included — is inside the transaction
    // body rather than in a parallel claim the producer wrote (audit H-3).
    const { postsOf } = await import('../../src/services/block-posts.js');
    const carried = postsOf(block!);
    expect(carried).toHaveLength(1);
    expect(carried[0]!.postId).toBe(postId);
    expect(carried[0]!.post.parentRefs).toEqual(commit.parentRefs);
    expect(Buffer.from(carried[0]!.post.author).toString('hex'))
      .toBe(Buffer.from(commit.author).toString('hex'));
  });

  // -----------------------------------------------------------------------
  // 3. Block carries post transactions
  // -----------------------------------------------------------------------

  it('block carries the post transactions it created posts from', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();

    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'post one');


    const posts = await importPosts();
    posts.insertPost(postId, commit, content);

    const mempool = await importMempoolFresh();
    mempool.insertUtxoTx(postTx, 1000);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    const block = await mineNextBlock(bc);
    expect(block).not.toBeNull();
    const { postsOf } = await import('../../src/services/block-posts.js');
    expect(postsOf(block!).map((p) => p.postId)).toEqual([postId]);
    expect(block!.header.validatorId).toBeTruthy();
    expect(block!.validatorSignature.length).toBe(64);
    const h = blockHash(block!.header);
    expect(h).toBeTruthy();
    expect(h!.length).toBe(64); // 32 bytes hex = 64 chars
  });

  // -----------------------------------------------------------------------
  // 4. Post confirmed after block creation
  // -----------------------------------------------------------------------

  it('sub-block and post confirmed after block creation', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();

    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'confirm me');


    const posts = await importPosts();
    posts.insertPost(postId, commit, content);

    const mempool = await importMempoolFresh();
    mempool.insertUtxoTx(postTx, 1000);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    const block = await mineNextBlock(bc);
    expect(block).not.toBeNull();

    // Verify mempool is now empty (confirmed entries removed)
    const pendingAfter = mempool.getPendingEntries(10);
    expect(pendingAfter).toHaveLength(0);

    // Verify post is confirmed
    const confirmedPost = posts.getPost(postId);
    expect(confirmedPost).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // 5. Template assembly carries exactly the live utxoTxTree keys
  // -----------------------------------------------------------------------

  it('template assembly carries exactly the live utxoTxTree keys', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const posts = await importPosts();
    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();

    const author = makeTestIdentity();
    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'template shape');

    posts.insertPost(postId, commit, content);
    mempool.insertUtxoTx(postTx, 1000);

    const karmaBox = makeKarmaBox(100n, author.userId, 0);
    utxo.insertBox(karmaBox);
    mempool.insertUtxoTx(makeLikeTx(author, karmaBox, postId), 1000);

    bc.startBlockCreator(testConfig);
    const block = await mineNextBlock(bc);

    expect(block).not.toBeNull();
    // The type carries exactly the live keys, so the produced tree does too.
    // Exact-set, so a stray key sneaking back in — `coinbaseOutputs` above all,
    // whose section is retired — or a new one added untested, fails here (the
    // block body is consensus-visible bytes).
    expect(Object.keys(block!.utxoTxTree).sort()).toEqual(
      ['pruneEntries', 'utxoTxIds', 'utxoTxs'],
    );
  });

  // -----------------------------------------------------------------------
  // 6. Former epoch boundaries are ordinary heights
  // -----------------------------------------------------------------------

  it('a block at a former epoch boundary (height % 60 === 0) carries no tally and applies like any other height', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const bc = await importBlockCreator();
    const ordering = await importOrdering();

    bc.startBlockCreator(testConfig);

    // Heights 59, 60, 61: 60 is the round multiple, 61 the block after.
    // The body carries the same three keys (`pruneEntries`, `utxoTxIds`,
    // `utxoTxs`) at each — no height-dependent structural variation.
    for (let i = 0; i < 61; i++) {
      expect(await mineNextBlock(bc)).not.toBeNull();
    }
    expect(ordering.getCurrentHeight()).toBe(61); // every block applied

    for (const height of [59, 60, 61]) {
      const stored = ordering.getOrderingBlock(height);
      expect(stored).not.toBeNull();
      expect(Object.keys(stored!.utxoTxTree).sort()).toEqual(
        ['pruneEntries', 'utxoTxIds', 'utxoTxs'],
      );
    }
  });

  // -----------------------------------------------------------------------
  // 10. getCurrentHeight increments after block creation
  // -----------------------------------------------------------------------

  it('getCurrentHeight increments after block creation', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();



    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'height test');
    const posts = await importPosts();
    posts.insertPost(postId, commit, content);

    const mempool = await importMempoolFresh();
    mempool.insertUtxoTx(postTx, 1000);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    // Height starts at 0
    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(0);

    await mineNextBlock(bc);
    expect(ordering.getCurrentHeight()).toBe(1);

    // Second block
    const { commit: commit2, tx: post2Tx, postId: postId2, content: content2 } = await seedPostTx(author, 'height test 2');
    posts.insertPost(postId2, commit2, content2);
    mempool.insertUtxoTx(post2Tx, 1000);

    await mineNextBlock(bc);
    expect(ordering.getCurrentHeight()).toBe(2);
  });

  // -----------------------------------------------------------------------
  // 11. utxoTxIds populated from mempool standalone UTXO entries
  // -----------------------------------------------------------------------

  it('populates utxoTxIds from mempool standalone UTXO entries', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const posts = await importPosts();
    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();

    // Set up identity
    const author = makeTestIdentity();

    // Create and insert a post
    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'utxoTxIds test');
    const { computeTxId } = await import('@dagsocial/types');
    posts.insertPost(postId, commit, content);

    // Insert post transaction into mempool
    mempool.insertUtxoTx(postTx, 1000);

    // Set up: standalone UTXO transaction in mempool
    const karmaBox = makeKarmaBox(100n, author.userId, 0);
    utxo.insertBox(karmaBox);
    // A real post id that is deliberately not `postId` — `likeTarget` is
    // `opt(b32)` in the txId preimage now, so the old `'some_post_id_not_matching'`
    // placeholder has no encoding. What the test needs is "not this post", and a
    // well-formed id that differs says that just as well.
    const likeTx = makeLikeTx(author, karmaBox, 'ee'.repeat(32));
    mempool.insertUtxoTx(likeTx, 1000);

    // The subject is the body the creator assembles, so the template is what
    // this reads. The like names a post no block confirms, which apply rejects
    // — a chain the block never joins still had a body, and that body is the
    // claim here.
    bc.startBlockCreator(testConfig);
    bc.createOrderingBlock();
    const template = bc.getCurrentTemplate();

    expect(template).not.toBeNull();
    expect(template!.utxoTxTree.utxoTxIds.length).toBeGreaterThan(0);
    // The standalone like should be in utxoTxIds
    expect(template!.utxoTxTree.utxoTxIds).toContain(computeTxId(likeTx));

    // Verify inline CBOR UTXO tx fields
    const { decodeTx } = await import('@dagsocial/types');
    expect(template!.utxoTxTree.utxoTxs).toBeDefined();
    expect(template!.utxoTxTree.utxoTxs.length).toBe(
      template!.utxoTxTree.utxoTxIds.length,
    );
    for (let i = 0; i < template!.utxoTxTree.utxoTxs.length; i++) {
      const tx = decodeTx(template!.utxoTxTree.utxoTxs[i]!);
      expect(computeTxId(tx)).toBe(template!.utxoTxTree.utxoTxIds[i]);
    }

    // Entries the body claimed leave the pool at finalize, accepted or not.
    const nonce = solveHeaderPow(template!.header);
    expect(bc.submitMinedBlock(nonce, template!.header.height)).not.toBeNull();
    const remaining = mempool.getPendingEntries(100);
    expect(remaining).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 13. Batch-linked UTXO transactions appear in utxoTxIds
  // -----------------------------------------------------------------------

  it('batch-linked UTXO transactions appear in utxoTxIds', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const posts = await importPosts();
    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();

    // Set up identity
    const author = makeTestIdentity();

    const { tx: postTx, postId } = await seedPostTx(author, 'batch UTXO test');
    const { computeTxId } = await import('@dagsocial/types');
    mempool.insertUtxoTx(postTx, 1000);

    const karmaBox = makeKarmaBox(100n, author.userId, 0);
    utxo.insertBox(karmaBox);
    // Well-formed and deliberately unrelated — see the note above.
    const likeTx = makeLikeTx(author, karmaBox, 'ee'.repeat(32));
    mempool.insertUtxoTx(likeTx, 1000);

    // Assembly again, so again the template: the like names a post no block
    // confirms and apply rejects the body it rides in.
    bc.startBlockCreator(testConfig);
    bc.createOrderingBlock();
    const template = bc.getCurrentTemplate();

    expect(template).not.toBeNull();
    // The batch-linked UTXO tx ID should be in utxoTxIds
    expect(template!.utxoTxTree.utxoTxIds).toContain(computeTxId(likeTx));
    // …and the post rides the same list.
    const { postsOf } = await import('../../src/services/block-posts.js');
    expect(postsOf(template!).map((p) => p.postId)).toContain(postId);
    // Both entries leave the pool at finalize.
    const nonce = solveHeaderPow(template!.header);
    expect(bc.submitMinedBlock(nonce, template!.header.height)).not.toBeNull();
    const remaining = mempool.getPendingEntries(100);
    expect(remaining).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // H-3: the committed root binds the post's author, through its transaction
  // -----------------------------------------------------------------------

  it('computeUtxoTxRoot commits to the post author, via the transaction id', async () => {
    // ⛔ The successor to the `computeSubBlockRoot` author test, and the binding
    // is now TWO steps rather than one — which is why it is stronger. The root
    // commits `utxoTxIds`; a `TxId` covers `postFieldBytes`, which contains the
    // author. So flipping the author moves the transaction id and therefore the
    // root, and a producer cannot rewrite authorship after mining without
    // producing a different block entirely.
    // Imported directly rather than through `importBlockCreator`, which seeds
    // an emission box and therefore needs a store — this case opens none.
    const { computeUtxoTxRoot } = await import('../../src/services/block-creator.js');
    const author = makeTestIdentity();
    const other = makeTestIdentity();

    // `makePostTx`, not `seedPostTx`: this measures the root over transaction
    // ids and opens no database.
    const a = makePostTx(author, 'same words');
    const b = makePostTx(other, 'same words');
    expect(a.tx.post!.content).toBe(b.tx.post!.content);   // only the author differs

    const treeOf = (txId: string) => ({
      utxoTxIds: [txId], utxoTxs: [new Uint8Array(1)],
      pruneEntries: [],
    });
    expect(computeTxId(a.tx)).not.toBe(computeTxId(b.tx));
    expect(computeUtxoTxRoot(treeOf(computeTxId(a.tx))))
      .not.toBe(computeUtxoTxRoot(treeOf(computeTxId(b.tx))));
  });

  // -----------------------------------------------------------------------
  // Template lifecycle: one per height, rebuilt when the tip moves
  // -----------------------------------------------------------------------

  it('a miner node holds a template for the next height the moment a block is applied', async () => {
    // Production is difficulty-regulated: there is no interval to wait out,
    // so the node holds a template from the moment it starts. Serving is
    // separate (the peer-readiness gate can withhold it).
    // MINING_INTERFACE → Template and submit.
    const db = await importDb();
    db.initDb(':memory:');
    const bc = await importBlockCreator();

    bc.startBlockCreator(testConfig);
    expect(bc.getCurrentTemplate()?.header.height).toBe(1);

    const block = await mineNextBlock(bc);
    expect(block).not.toBeNull();

    const next = bc.getCurrentTemplate();
    expect(next).not.toBeNull();
    expect(next!.header.height).toBe(2);
    expect(next!.header.prevBlockHash).toBe(blockHash(block!.header));
  });

  // -----------------------------------------------------------------------
  // The fill budget is bytes
  // -----------------------------------------------------------------------

  describe('block body budget', () => {
    /**
     * Fill a pool with distinct, identically-sized transactions and return
     * their rowids in insertion order.
     *
     * `fillerTx` bodies are the same length whatever the label — one 64-hex
     * input, no outputs — so a per-entry byte cost measured on one is exact for
     * all of them, which is what lets a budget be aimed at a chosen entry
     * count instead of guessed at.
     */
    async function fillPool(count: number, tag: string): Promise<number[]> {
      const mempool = await importMempoolFresh();
      const rowids: number[] = [];
      for (let i = 0; i < count; i++) {
        rowids.push(mempool.insertUtxoTx(fillerTx(`${tag}_${i}`), 5000));
      }
      return rowids;
    }

    it('stops at the budget and leaves the rest of the pool pending', async () => {
      const db = await importDb();
      db.initDb(':memory:');
      const mempool = await importMempoolFresh();
      const bc = await importBlockCreator();

      const POOL = 40;
      const rowids = await fillPool(POOL, 'budget');

      // Pass one, at the production budget, to learn what this body costs.
      //
      // ⚠ **The reserve is the SETTLEMENT the empty body produces**, not a
      // worst-case coinbase. The settlement's value depends on the fill, so it
      // cannot be built until the body is chosen; what the fill budgets against
      // is its baseline, and `entryByteCost` carries each entry's marginal
      // growth on top (MEMPOOL_INTERFACE → the settlement replaces
      // `coinbaseOutputs` here). These fillers add nothing to it — no fee box,
      // no bond — so the baseline is exact here.
      bc.startBlockCreator(testConfig);
      const full = bc.getCurrentTemplate();
      expect(full).not.toBeNull();
      // POOL user entries plus the settlement.
      expect(full!.utxoTxTree.utxoTxIds).toHaveLength(POOL + 1);

      // What the finished body carries besides the user transactions — the
      // prune section, the count prefixes, and the settlement itself.
      const reserved = utxoTxTreeByteLength({
        ...full!.utxoTxTree,
        utxoTxIds: full!.utxoTxTree.utxoTxIds.slice(POOL),
        utxoTxs: full!.utxoTxTree.utxoTxs.slice(POOL),
      });
      const perTx = (utxoTxTreeByteLength(full!.utxoTxTree) - reserved) / POOL;
      expect(Number.isInteger(perTx)).toBe(true);
      // Non-vacuity: the settlement really is in the reserve, so this is not the
      // empty-tree constant wearing another name.
      expect(reserved).toBeGreaterThan(
        utxoTxTreeByteLength({ utxoTxIds: [], utxoTxs: [], pruneEntries: [] }),
      );

      // Pass two, at a budget that binds mid-pool. Every count prefix in the
      // body is one byte wide below 128 entries, so the arithmetic is exact
      // and KEEP is the number that must land.
      const KEEP = 12;
      const budget = reserved + KEEP * perTx;
      bc.startBlockCreator({ ...testConfig, blockBodyBudgetBytes: budget });
      const bound = bc.getCurrentTemplate();
      expect(bound).not.toBeNull();

      // ⛔ Both halves, or this asserts only that a block was produced: the
      // measured body against the budget, and *which* entries stayed behind.
      expect(utxoTxTreeByteLength(bound!.utxoTxTree)).toBeLessThanOrEqual(budget);
      expect(bound!.utxoTxTree.utxoTxIds).toHaveLength(KEEP + 1);
      expect(bound!.utxoTxTree.utxoTxs).toHaveLength(KEEP + 1);
      // One more would have overrun it — the budget is what bound the fill, not
      // the pool running out.
      expect(reserved + (KEEP + 1) * perTx).toBeGreaterThan(budget);

      // The pool is untouched until a block is finalized, and the entries the
      // body did not claim are the tail of it in FIFO order.
      const pending = mempool.getPendingEntries(POOL + 10);
      expect(pending.map((e) => e.rowid)).toEqual(rowids);
      const nonce = solveHeaderPow(bound!.header);
      expect(bc.submitMinedBlock(nonce, bound!.header.height)).not.toBeNull();
      expect(
        mempool.getPendingEntries(POOL + 10).map((e) => e.rowid),
      ).toEqual(rowids.slice(KEEP));
    });

    it('fills past any fixed count when the budget still has room', async () => {
      const db = await importDb();
      db.initDb(':memory:');
      const bc = await importBlockCreator();

      // ⛔ Deeper than the count this creator used to draw (1000) and than any
      // single page it reads. An under-fetch is the silent failure here: it
      // produces short blocks while every test passes and every block
      // validates, so the pool has to be deep enough to expose one.
      const POOL = 1_100;
      await fillPool(POOL, 'page');

      bc.startBlockCreator(testConfig);
      const template = bc.getCurrentTemplate();
      expect(template).not.toBeNull();
      // Every entry but the settlement's.
      expect(template!.utxoTxTree.utxoTxIds).toHaveLength(POOL + 1);
      expect(utxoTxTreeByteLength(template!.utxoTxTree))
        .toBeLessThanOrEqual(MAX_BLOCK_BODY_BYTES);
    });

    it('clamps a budget above MAX_BLOCK_BODY_BYTES rather than honouring it', async () => {
      const db = await importDb();
      db.initDb(':memory:');
      const bc = await importBlockCreator();
      const { encodeTx } = await import('@dagsocial/types');

      // Pool rows written directly. The subject is what the creator fills to,
      // and admission runs one conflicting-spend query per input per insert —
      // over the ~150-input transactions a 2 MB body needs, building this
      // through `insertUtxoTx` costs minutes and measures the admission path.
      const bigTx = (label: string): UtxoTransaction => ({
        inputs: Array.from({ length: 148 }, (_, i) =>
          createHash('blake2b512').update(`${label}/${i}`).digest()
            .subarray(0, 32).toString('hex'),
        ),
        outputs: [],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      });
      const ins = db.getDb().prepare(
        `INSERT INTO mempool (entry_type, utxo_tx_cbor, expires_at_height)
         VALUES ('utxo_tx', ?, 5000)`,
      );
      // Deep enough that the CONSENSUS cap binds before the pool runs out: a
      // `bigTx` encodes to about 4.8 KB, so the cap needs upwards of 400 of
      // them and the loop leaves margin over that.
      let pooled = 0;
      db.getDb().transaction(() => {
        for (let i = 0; i < 600; i++) {
          const cbor = encodeTx(bigTx(`big_${i}`));
          expect(cbor.length).toBeLessThanOrEqual(10_000);   // a minable size
          ins.run(Buffer.from(cbor));
          pooled++;
        }
      })();

      bc.startBlockCreator({
        ...testConfig,
        blockBodyBudgetBytes: MAX_BLOCK_BODY_BYTES * 2,
      });
      const template = bc.getCurrentTemplate();
      expect(template).not.toBeNull();

      // The consensus bound held, not the config's ask — and it bound: the pool
      // had more to give. The lower bound is what stops this passing on a body
      // that stopped early for some other reason; the fill only ends one
      // transaction short of the cap.
      const measured = utxoTxTreeByteLength(template!.utxoTxTree);
      expect(measured).toBeLessThanOrEqual(MAX_BLOCK_BODY_BYTES);
      expect(measured).toBeGreaterThan(MAX_BLOCK_BODY_BYTES - 10_000);
      // Every entry but the settlement's, so a body that took the whole pool
      // would still measure `pooled + 1` here.
      expect(template!.utxoTxTree.utxoTxIds.length - 1).toBeLessThan(pooled);
    });
  });

  // -------------------------------------------------------------------------
  // Fill order — karma-side first, then credits by fee rate
  // (MEMPOOL_INTERFACE → Ordering). A node's assembly preference, not a rule:
  // what makes it rational is the coinbase's inclusion bonus, which a miner
  // filling credits first forfeits.
  // -------------------------------------------------------------------------

  describe('fill order', () => {
    /**
     * A credit box in the store and a transfer spending it, naming `fee` in a
     * `FeeBox` output. `padding` widens the transaction without changing the
     * fee, which is how a rate is told apart from a total.
     */
    async function seedCreditSpend(
      label: string,
      value: bigint,
      fee: bigint,
      padding = 1,
    ): Promise<UtxoTransaction> {
      const utxo = await importUtxo();
      const owner = createHash('blake2b512').update(`${label}_o`).digest().subarray(0, 32);
      const candidate = {
        boxType: 'credit' as const,
        value,
        createdAtBlock: 0,
        owner: new Uint8Array(owner),
      };
      const box = seedProvenance(candidate, 1, labelNonceOf(label));
      utxo.insertBox(box);

      const out = value - fee;
      const share = out / BigInt(padding);
      const outputs: unknown[] = Array.from({ length: padding }, (_, i) => ({
        ...candidate,
        value: i === 0 ? out - share * BigInt(padding - 1) : share,
      }));
      // Zero fee means no box (NODE_INTERFACE → the credit transition row).
      if (fee > 0n) {
        outputs.push({ boxType: 'fee' as const, value: fee,  createdAtBlock: 0,});
      }
      return {
        inputs: [box.id!],
        outputs,
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      } as UtxoTransaction;
    }

    function labelNonceOf(label: string): number {
      return createHash('blake2b512').update(label).digest().readUInt16BE(0);
    }

    /** The ids the template carries, in body order. */
    /**
     * The USER transactions of a body — every entry but the last.
     *
     * ⛔ **The last is the settlement**, which every block carries and no fill
     * selects (NODE_INTERFACE → It is the LAST entry in `utxoTxIds`), so a fill
     * assertion that counted it would be measuring the creator's own tail.
     */
    function idsIn(block: OrderingBlock): string[] {
      return block.utxoTxTree.utxoTxIds.slice(0, -1);
    }

    it('offers the budget to karma-side entries before credit transactions', async () => {
      const db = await importDb();
      db.initDb(':memory:');
      const mempool = await importMempoolFresh();
      const bc = await importBlockCreator();

      // The payer arrives FIRST, so arrival order cannot explain the outcome.
      const payer = await seedCreditSpend('payer', 10_000n, 9_000n);
      mempool.insertUtxoTx(payer, 5000);
      mempool.insertUtxoTx(fillerTx('karma_side') as UtxoTransaction, 5000);

      // A budget that admits exactly one of the two. Both costs are measured
      // rather than assumed, and the larger one sets the budget so that
      // whichever class is served first is what lands.
      const { encodeTx } = await import('@dagsocial/types');
      const { entryByteCost } = mempool as unknown as {
        entryByteCost: (cbor: Uint8Array) => number;
      };
      const payerCost = entryByteCost(encodeTx(payer));
      const karmaCost = entryByteCost(encodeTx(fillerTx('karma_side') as UtxoTransaction));
      // The fill's own reserve: the settlement an empty body produces. Measured
      // by asking for a budget no user entry can fit into, so what comes back is
      // the settlement alone — the same seed the fill starts from.
      bc.startBlockCreator({ ...testConfig, blockBodyBudgetBytes: 1 });
      const empty = bc.getCurrentTemplate();
      expect(empty).not.toBeNull();
      expect(empty!.utxoTxTree.utxoTxIds).toHaveLength(1);
      const reserved = utxoTxTreeByteLength(empty!.utxoTxTree);
      bc.stopBlockCreator();

      bc.startBlockCreator({
        ...testConfig,
        blockBodyBudgetBytes: reserved + Math.max(payerCost, karmaCost),
      });
      const block = bc.getCurrentTemplate();
      expect(block).not.toBeNull();

      expect(idsIn(block!)).toHaveLength(1);
      expect(idsIn(block!)[0]).toBe(computeTxId(fillerTx('karma_side') as UtxoTransaction));
      // And the payer really would have fitted — otherwise this passes because
      // it was too big, not because karma went first.
      expect(reserved + payerCost).toBeLessThanOrEqual(
        reserved + Math.max(payerCost, karmaCost),
      );
    });

    it('orders credit transactions by fee rate, not by arrival', async () => {
      const db = await importDb();
      db.initDb(':memory:');
      const mempool = await importMempoolFresh();
      const bc = await importBlockCreator();

      // Inserted cheapest-first, so FIFO would reverse the expected answer.
      const cheap = await seedCreditSpend('cheap', 10_000n, 1n);
      const mid = await seedCreditSpend('mid', 10_000n, 50n);
      const rich = await seedCreditSpend('rich', 10_000n, 500n);
      mempool.insertUtxoTx(cheap, 5000);
      mempool.insertUtxoTx(mid, 5000);
      mempool.insertUtxoTx(rich, 5000);

      bc.startBlockCreator(testConfig);
      const block = bc.getCurrentTemplate();
      expect(idsIn(block!)).toEqual([
        computeTxId(rich),
        computeTxId(mid),
        computeTxId(cheap),
      ]);
    });

    it('ranks a fat transaction by rate, so an equal fee over more bytes loses', async () => {
      const db = await importDb();
      db.initDb(':memory:');
      const mempool = await importMempoolFresh();
      const bc = await importBlockCreator();

      // Identical fees; only the byte cost differs.
      const fat = await seedCreditSpend('fat', 10_000n, 600n, 14);
      const lean = await seedCreditSpend('lean', 10_000n, 600n, 1);
      mempool.insertUtxoTx(fat, 5000);
      mempool.insertUtxoTx(lean, 5000);

      bc.startBlockCreator(testConfig);
      const block = bc.getCurrentTemplate();
      // Both fit at the default budget, so this asserts the ORDER rather than
      // which one survived a trim — the leaner rate is offered first.
      expect(idsIn(block!)).toEqual([computeTxId(lean), computeTxId(fat)]);
    });
  });
});
