import {
  fixtureProvenance,
  makeTestConfig,
  mineNextBlock,
  seedProvenance,
  signTransaction,
  solveHeaderPow,
  uid, fixturePostId, makePostTx, seedPostTx, fillerTx } from '../helpers.js';
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
  PROTOCOL_VERSION,
  LIKE_KARMA_COST, computeTxId } from '@dagsocial/types';
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
  maxSubBlocksPerBlock: 1000,
  // Mining
  orderingBlockPowTargetBits: 3072,
  creditTreasuryPct: 10,
  treasuryPubKey: '',
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
    timestamp: Date.now(),
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
    owner,
    guard: 'owner_signature',
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
): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [karmaBox.id!],
    outputs: [
      {
        boxType: 'karma',
        value: karmaBox.value - LIKE_KARMA_COST,
        owner: liker.userId,
        guard: 'owner_signature',
      } as KarmaBox,
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
    expect(block!.utxoTxTree.utxoTxIds).toEqual([]);
    expect(block!.utxoTxTree.coinbaseOutputs.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // 2. Pending sub-block triggers block creation
  // -----------------------------------------------------------------------

  it('pending sub-block triggers block creation', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    // Set up identity
    const author = makeTestIdentity();

    const { post, tx: postTx, postId } = await seedPostTx(author, 'hello world');

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
    expect(carried[0]!.post.parentRefs).toEqual(post.parentRefs);
    expect(Buffer.from(carried[0]!.post.author).toString('hex'))
      .toBe(Buffer.from(post.author).toString('hex'));
  });

  // -----------------------------------------------------------------------
  // 3. Block includes sub-block refs
  // -----------------------------------------------------------------------

  it('block carries the post transactions it created posts from', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();

    const { post, tx: postTx, postId } = await seedPostTx(author, 'post one');
    const { encodePost } = await import('@dagsocial/types');

    const posts = await importPosts();
    posts.insertPost(postId, post, encodePost(post));

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
  // 4. Sub-block confirmed after block creation
  // -----------------------------------------------------------------------

  it('sub-block and post confirmed after block creation', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();

    const { post: post, tx: postTx, postId: postId } = await seedPostTx(author, 'confirm me');
    const { encodePost } = await import('@dagsocial/types');

    const posts = await importPosts();
    posts.insertPost(postId, post, encodePost(post));

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
    const { post: post, tx: postTx, postId: postId } = await seedPostTx(author, 'template shape');
    const { encodePost } = await import('@dagsocial/types');
    posts.insertPost(postId, post, encodePost(post));
    mempool.insertUtxoTx(postTx, 1000);

    const karmaBox = makeKarmaBox(100n, author.userId, 0);
    utxo.insertBox(karmaBox);
    mempool.insertUtxoTx(makeLikeTx(author, karmaBox, postId), 1000);

    bc.startBlockCreator(testConfig);
    const block = await mineNextBlock(bc);

    expect(block).not.toBeNull();
    // The type carries exactly the live keys, so the produced tree does too.
    // Exact-set, so a stray key sneaking back in — or a new one added
    // untested — fails here (block body CBOR is consensus-visible bytes).
    expect(Object.keys(block!.utxoTxTree).sort()).toEqual(
      ['coinbaseOutputs', 'pruneEntries', 'utxoTxIds', 'utxoTxs'],
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

    // Drive the real creator+apply across the retired 60-block epoch
    // boundary. Under the retired trigger the tally rode the block after a
    // currentHeight % 60 === 0 chain tip (height 61), so cover both readings
    // of "the boundary": 60 and 61.
    for (let i = 0; i < 61; i++) {
      expect(await mineNextBlock(bc)).not.toBeNull();
    }
    expect(ordering.getCurrentHeight()).toBe(61); // every block applied

    for (const height of [59, 60, 61]) {
      const stored = ordering.getOrderingBlock(height);
      expect(stored).not.toBeNull();
      expect(Object.keys(stored!.utxoTxTree).sort()).toEqual(
        ['coinbaseOutputs', 'pruneEntries', 'utxoTxIds', 'utxoTxs'],
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

    const { encodePost } = await import('@dagsocial/types');

    const { post: post, tx: postTx, postId: postId } = await seedPostTx(author, 'height test');
    const posts = await importPosts();
    posts.insertPost(postId, post, encodePost(post));

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
    const { post: post2, tx: post2Tx, postId: postId2 } = await seedPostTx(author, 'height test 2');
    posts.insertPost(postId2, post2, encodePost(post2));
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
    const { post: post, tx: postTx, postId: postId } = await seedPostTx(author, 'utxoTxIds test');
    const { encodePost, computeTxId } = await import('@dagsocial/types');
    posts.insertPost(postId, post, encodePost(post));

    // Insert sub-block ID into mempool
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
    const { computeUtxoTxRoot } = await importBlockCreator();
    const author = makeTestIdentity();
    const other = makeTestIdentity();

    // `makePostTx`, not `seedPostTx`: this measures the root over transaction
    // ids and opens no database.
    const a = makePostTx(author, 'same words');
    const b = makePostTx(other, 'same words');
    expect(a.tx.post!.content).toBe(b.tx.post!.content);   // only the author differs

    const treeOf = (txId: string) => ({
      utxoTxIds: [txId], utxoTxs: [new Uint8Array(1)],
      pruneEntries: [], coinbaseOutputs: [],
    });
    expect(computeTxId(a.tx)).not.toBe(computeTxId(b.tx));
    expect(computeUtxoTxRoot(treeOf(computeTxId(a.tx))))
      .not.toBe(computeUtxoTxRoot(treeOf(computeTxId(b.tx))));
  });

  // -----------------------------------------------------------------------
  // Template lifecycle: one per height, rebuilt when the tip moves
  // -----------------------------------------------------------------------

  it('a miner node holds a template for the next height the moment a block is applied', async () => {
    // Production is difficulty-regulated: there is no interval to wait out, so
    // a miner polling GET /mining/template is never told to come back later.
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
});
