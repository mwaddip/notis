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
  MAX_REORG_DEPTH,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  PROTOCOL_VERSION,
  ReaderError,
  MAX_BLOCK_BODY_BYTES,
} from '@dagsocial/types';
import { blockHash, cumulativeWork } from '@dagsocial/validation';
import type {
  Post,
  KarmaBox,
  OrderingBlock,
  Stump,
  UtxoTransaction,
  BlockHeader,
} from '@dagsocial/types';
import type { StoredPost } from '../../src/store/posts.js';
import type { BlockJournal } from '../../src/store/journal.js';
import type { ForkResolutionNet } from '../../src/services/fork-resolution.js';
import type Database from 'better-sqlite3';
import type { Config } from '../../src/config.js';
import {
  makeApplicableBlock,
  makeKarmaBox,
  makeLikeTx,
  makePost,
  makeTestConfig,
  makeTestIdentity,
  mineNextBlock,
  signHeader,
  solveHeaderPow, fixturePostId, seedPostTx, fillerTx, activateProverOverStore } from '../helpers.js';

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

/**
 * The block's Merkle helpers, from the graph the current test is driving. Same
 * module as `importBlockCreator`, separate only because that helper's type is
 * the timer-owning surface and widening it would offer `startBlockCreator` to
 * every caller that just wants to re-derive a root.
 */
async function importBlockCreatorRoots() {
  return (await import('../../src/services/block-creator.js')) as unknown as {
    computeUtxoTxRoot: (tree: OrderingBlock['utxoTxTree']) => string;
  };
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
    getBox: (boxId: string) => unknown;
    consumeBox: (boxId: string, consumedAtBlock: number) => void;
    getCreditBox: (owner: Uint8Array) => unknown;
  };
}

async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as {
    getCurrentHeight: () => number;
    getOrderingBlock: (height: number) => OrderingBlock | null;
    deleteOrderingBlock: (height: number) => void;
    createOrderingBlock: (block: OrderingBlock) => void;
  };
}

async function importJournalStore() {
  return (await import('../../src/store/journal.js')) as {
    getBlockJournal: (height: number) => BlockJournal | null;
    deleteBlockJournal: (height: number) => void;
    beginBlockJournal: (height: number) => void;
    abortBlockJournal: () => void;
  };
}

async function importForkResolution() {
  return (await import(
    '../../src/services/fork-resolution.js'
  )) as unknown as {
    extendsOurTip: (block: OrderingBlock) => boolean;
    findForkPoint: (
      ourTip: BlockHeader,
      theirHeaders: BlockHeader[],
    ) => number | null;
    revertBlock: (height: number) => void;
    reorg: (forkHeight: number, newBlocks: OrderingBlock[]) => void;
    resolveFork: (
      block: OrderingBlock,
      net: ForkResolutionNet,
      fromPeerId: string,
      dagService?: unknown,
    ) => Promise<void>;
  };
}

async function importCorruptState() {
  return (await import('../../src/services/corrupt-state.js')) as unknown as {
    UnhashableStoredHeaderError: new (site: string, height: number) => Error;
    MissingStoredBlockError: new (site: string, height: number) => Error;
    UnreadableStoredBlockError: new (
      site: string,
      height: number,
      cause: unknown,
    ) => Error;
  };
}

// ---------------------------------------------------------------------------
// Tests — cumulativeWork
// ---------------------------------------------------------------------------

// `powTargetBits` is in units of 1/256 of a bit — VALIDATION_INTERFACE →
// orderingPowTarget — so a whole bit `n` is written `256 * n` and the work it
// carries is `1n << BigInt(n)`. The expected totals below are stated in whole
// bits because that is what the fixtures are chosen to express.
describe('cumulativeWork', () => {
  it('returns 0 for empty headers array', () => {
    expect(cumulativeWork([])).toBe(0n);
  });

  it('returns equal work for two headers with same target bits', () => {
    const h1: BlockHeader = {
      protocolVersion: PROTOCOL_VERSION,
      height: 1,
      prevBlockHash: '00'.repeat(32),
      utxoTxRoot: '00'.repeat(32),
      stateRoot: '00'.repeat(33),
      validatorId: new Uint8Array(32),
      powNonce: 0,
      powTargetBits: 256 * 10,
      createdAt: 1000,
    };
    const h2: BlockHeader = {
      ...h1,
      height: 2,
      prevBlockHash: 'ff'.repeat(32),
      powNonce: 0,
      powTargetBits: 256 * 10,
    };
    expect(cumulativeWork([h1, h2])).toBe(2n * (1n << 10n));
  });

  it('doubles work per additional target bit', () => {
    const h1: BlockHeader = {
      protocolVersion: PROTOCOL_VERSION,
      height: 1,
      prevBlockHash: '00'.repeat(32),
      utxoTxRoot: '00'.repeat(32),
      stateRoot: '00'.repeat(33),
      validatorId: new Uint8Array(32),
      powNonce: 0,
      powTargetBits: 256 * 5,
      createdAt: 1000,
    };
    const h2: BlockHeader = {
      ...h1,
      height: 2,
      prevBlockHash: 'ff'.repeat(32),
      powNonce: 0,
      powTargetBits: 256 * 6, // 2^6 = 2 * 2^5
    };
    // Work(h1) = 2^5 = 32, Work(h2) = 2^6 = 64
    expect(cumulativeWork([h1])).toBe(32n);
    expect(cumulativeWork([h1, h2])).toBe(96n);
  });

  it('higher cumulative work wins chain comparison', () => {
    // Chain A: 2 blocks at 5 bits each = 2 * 32 = 64
    const chainA = [
      {
        protocolVersion: PROTOCOL_VERSION, height: 1, prevBlockHash: '00'.repeat(32),
        validatorId: new Uint8Array(32), powNonce: 0, powTargetBits: 256 * 5, createdAt: 1000,
      },
      {
        protocolVersion: PROTOCOL_VERSION, height: 2, prevBlockHash: 'ff'.repeat(32),
        validatorId: new Uint8Array(32), powNonce: 0, powTargetBits: 256 * 5, createdAt: 2000,
      },
    ] as BlockHeader[];

    // Chain B: 1 block at 7 bits = 128
    const chainB = [
      {
        protocolVersion: PROTOCOL_VERSION, height: 1, prevBlockHash: '00'.repeat(32),
        validatorId: new Uint8Array(32), powNonce: 0, powTargetBits: 256 * 7, createdAt: 1000,
      },
    ] as BlockHeader[];

    expect(cumulativeWork(chainB) > cumulativeWork(chainA)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — extendsOurTip
// ---------------------------------------------------------------------------

describe('extendsOurTip', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch { /* not imported */ }
    vi.resetModules();
  });

  it('returns true when prevBlockHash matches our tip', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();

    const { post: post, tx: postTx, postId: postId } = await seedPostTx(author, 'genesis');
    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    posts.insertPost(postId, post, encodePost(post));

    const mempool = await importMempoolFresh();
    mempool.insertUtxoTx(postTx, 1000);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const block1 = await mineNextBlock(bc);
    expect(block1).not.toBeNull();

    // Create a second block that chains from block 1
    const { post: post2, tx: post2Tx, postId: postId2 } = await seedPostTx(author, 'block 2');
    posts.insertPost(postId2, post2, encodePost(post2));
    mempool.insertUtxoTx(post2Tx, 1000);

    const block2 = await mineNextBlock(bc);
    expect(block2).not.toBeNull();

    // block2's prevBlockHash should match block1's hash
    const forkResolution = await importForkResolution();
    // extendsOurTip checks if the BLOCK being received extends OUR tip
    // At this point, our tip is block2. But block2 was just created and applied.
    // To test the "true" case: a block with prevBlockHash matching our current tip
    const ordering = await importOrdering();
    const ourTip = ordering.getOrderingBlock(ordering.getCurrentHeight());
    expect(ourTip).not.toBeNull();

    // A hypothetical block that extends our tip
    const candidate: OrderingBlock = {
      ...block2!,
      header: {
        ...block2!.header,
        height: ourTip!.header.height + 1,
        prevBlockHash: blockHash(ourTip!.header)!,
      },
    };
    expect(forkResolution.extendsOurTip(candidate)).toBe(true);
  });

  it('returns false when prevBlockHash does not match our tip', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();

    const { post: post, tx: postTx, postId: postId } = await seedPostTx(author, 'genesis');
    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    posts.insertPost(postId, post, encodePost(post));

    const mempool = await importMempoolFresh();
    mempool.insertUtxoTx(postTx, 1000);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    await mineNextBlock(bc);

    // A candidate block with a random prevBlockHash
    const forkResolution = await importForkResolution();
    const candidate: OrderingBlock = {
      header: {
        protocolVersion: PROTOCOL_VERSION,
        height: 2,
        prevBlockHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        utxoTxRoot: '00'.repeat(32),
        stateRoot: '00'.repeat(33),
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: 256 * 4,
        createdAt: Date.now(),
      },
      utxoTxTree: { utxoTxIds: ['77'.repeat(32)], utxoTxs: [new Uint8Array(96)], pruneEntries: [] },
      validatorSignature: new Uint8Array(64),
    };

    expect(forkResolution.extendsOurTip(candidate)).toBe(false);
  });

  it('returns false when no tip exists (empty chain)', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const forkResolution = await importForkResolution();
    const candidate: OrderingBlock = {
      header: {
        protocolVersion: PROTOCOL_VERSION,
        height: 1,
        prevBlockHash: '00'.repeat(32),
        utxoTxRoot: '00'.repeat(32),
        stateRoot: '00'.repeat(33),
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: 256 * 4,
        createdAt: Date.now(),
      },
      utxoTxTree: { utxoTxIds: ['77'.repeat(32)], utxoTxs: [new Uint8Array(96)], pruneEntries: [] },
      validatorSignature: new Uint8Array(64),
    };

    expect(forkResolution.extendsOurTip(candidate)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests — findForkPoint
// ---------------------------------------------------------------------------

describe('findForkPoint', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch { /* not imported */ }
    vi.resetModules();
  });

  it('finds common ancestor between two chains', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();

    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    // Build chain: block 1, block 2, block 3
    for (let i = 0; i < 3; i++) {
      const { post: post, tx: postTx, postId: postId } = await seedPostTx(author, `block ${i + 1}`);
      posts.insertPost(postId, post, encodePost(post));
      mempool.insertUtxoTx(postTx, 1000);
      await mineNextBlock(bc);
    }

    const ordering = await importOrdering();
    const ourTip = ordering.getOrderingBlock(3);
    expect(ourTip).not.toBeNull();

    // Construct theirHeaders: block 3 (fork) -> block 2 (same as ours) -> block 1 (same)
    // Their chain has same blocks 1 and 2 but a different block 3
    const block1 = ordering.getOrderingBlock(1);
    const block2 = ordering.getOrderingBlock(2);
    const forkBlock3: BlockHeader = {
      protocolVersion: PROTOCOL_VERSION,
      height: 3,
      prevBlockHash: blockHash(block2!.header)!, // chains from our block 2
      utxoTxRoot: 'ff'.repeat(32), // different content

      stateRoot: 'ff'.repeat(33),
      validatorId: new Uint8Array(32),
      powNonce: 0,
      powTargetBits: 256 * 4,
      createdAt: Date.now(),
    };

    const theirHeaders: BlockHeader[] = [
      forkBlock3,           // newest first (their tip)
      block2!.header,       // should match ours at height 2
    ];

    const forkResolution = await importForkResolution();
    const forkPoint = forkResolution.findForkPoint(ourTip!.header, theirHeaders);

    // Common ancestor should be at height 2 (block 2 matches both chains)
    expect(forkPoint).toBe(2);
  });

  it('two chains sharing no block fork at the genesis state', async () => {
    // The rule this pins: reaching height 0 IS a common ancestor. Height 0
    // holds no block and no hash, so nothing here matches — but every node on
    // a network holds a byte-identical height-0 state (`assertGenesisRoot`
    // makes a divergent one fail-stop), so two chains inside the reorg window
    // that share no block still share genesis, and it is the only ancestor
    // they have. Before this rule the pair below answered null and a mesh
    // whose nodes each mined their own height 1 could never converge.
    //
    // The null case did not disappear with it: it moved to the depth bound,
    // which the two tests below pin from either side.
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();

    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    // Build chain: block 1 only
    const { post: post, tx: postTx, postId: postId } = await seedPostTx(author, 'genesis');
    posts.insertPost(postId, post, encodePost(post));
    mempool.insertUtxoTx(postTx, 1000);
    await mineNextBlock(bc);

    const ordering = await importOrdering();
    const ourTip = ordering.getOrderingBlock(1);
    expect(ourTip).not.toBeNull();

    // Their headers: completely different chain with no overlap
    const theirHeaders: BlockHeader[] = [
      {
        protocolVersion: PROTOCOL_VERSION,
        height: 5,
        prevBlockHash: 'ab'.repeat(32),
        utxoTxRoot: '00'.repeat(32),
        stateRoot: '00'.repeat(33),
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: 256 * 4,
        createdAt: Date.now(),
      },
    ];

    const forkResolution = await importForkResolution();
    const forkPoint = forkResolution.findForkPoint(ourTip!.header, theirHeaders);
    expect(forkPoint).toBe(0);
  });

  it('returns null when depth exceeds MAX_REORG_DEPTH', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const forkResolution = await importForkResolution();

    // Build a deep chain (more than MAX_REORG_DEPTH) via block-creator
    const author = makeTestIdentity();

    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    const chainLength = MAX_REORG_DEPTH + 5;

    for (let i = 0; i < chainLength; i++) {
      const { post: post, tx: postTx, postId: postId } = await seedPostTx(author, `deep ${i}`);
      posts.insertPost(postId, post, encodePost(post));
      mempool.insertUtxoTx(postTx, 1000);
      await mineNextBlock(bc);
    }

    const ordering = await importOrdering();
    const ourTip = ordering.getOrderingBlock(chainLength);
    expect(ourTip).not.toBeNull();

    // Their headers reference a block at height chainLength - MAX_REORG_DEPTH - 1
    // which is beyond MAX_REORG_DEPTH from our tip
    const deepBlock = ordering.getOrderingBlock(chainLength - MAX_REORG_DEPTH - 1);
    expect(deepBlock).not.toBeNull();

    const theirHeaders: BlockHeader[] = [
      {
        protocolVersion: PROTOCOL_VERSION,
        height: chainLength - MAX_REORG_DEPTH - 1 + 3,
        prevBlockHash: blockHash(deepBlock!.header)!,
        utxoTxRoot: '00'.repeat(32),
        stateRoot: '00'.repeat(33),
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: 256 * 4,
        createdAt: Date.now(),
      },
      deepBlock!.header,
    ];

    const forkPoint = forkResolution.findForkPoint(ourTip!.header, theirHeaders);
    // The common ancestor (deepBlock) is beyond MAX_REORG_DEPTH from our tip
    expect(forkPoint).toBeNull();
  });

  it('height 0 is reachable up to MAX_REORG_DEPTH and not one block further', async () => {
    // **The bound did not move.** Height 0 became a valid *answer*; how far
    // back a reorg may go is unchanged, and it has to be: journal retention is
    // the real floor under revert depth (`revertBlock` throws without a
    // journal, and `purgeOldJournals` clears everything below
    // `height − MAX_REORG_DEPTH`). Answering 0 from deeper than the window
    // would name an ancestor the node cannot revert to.
    //
    // Both edges, on one chain, because a single-sided assertion cannot tell a
    // correct bound from an absent one.
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    const forkResolution = await importForkResolution();
    const ordering = await importOrdering();

    /** A peer tip that chains from nothing we hold — no block can ever match. */
    const unrelated = (height: number): BlockHeader => ({
      protocolVersion: PROTOCOL_VERSION,
      height,
      prevBlockHash: 'cd'.repeat(32),
      utxoTxRoot: '00'.repeat(32),
      stateRoot: '00'.repeat(33),
      validatorId: new Uint8Array(32),
      powNonce: 0,
      powTargetBits: 256 * 4,
      createdAt: Date.now(),
    });

    for (let i = 0; i < MAX_REORG_DEPTH; i++) {
      const { post: post, tx: postTx, postId: postId } = await seedPostTx(author, `bound ${i}`);
      posts.insertPost(postId, post, encodePost(post));
      mempool.insertUtxoTx(postTx, 1000);
      await mineNextBlock(bc);
    }

    // At exactly MAX_REORG_DEPTH the walk covers heights MAX_REORG_DEPTH..1 and then
    // runs out of blocks — genesis is inside the window.
    const atBound = ordering.getOrderingBlock(MAX_REORG_DEPTH);
    expect(forkResolution.findForkPoint(atBound!.header, [unrelated(MAX_REORG_DEPTH)])).toBe(0);

    // One block further, the walk is truncated by the depth bound before it
    // reaches the bottom, and the answer goes back to "no common ancestor".
    const { post: post, tx: postTx, postId: postId } = await seedPostTx(author, 'one past the bound');
    posts.insertPost(postId, post, encodePost(post));
    mempool.insertUtxoTx(postTx, 1000);
    await mineNextBlock(bc);

    const pastBound = ordering.getOrderingBlock(MAX_REORG_DEPTH + 1);
    expect(pastBound).not.toBeNull();
    expect(
      forkResolution.findForkPoint(pastBound!.header, [unrelated(MAX_REORG_DEPTH + 1)]),
    ).toBeNull();
  });

  it('a poisoned batch is still refused whole rather than falling through to genesis', async () => {
    // The genesis fallback must sit behind the batch check, not in front of it.
    // In front, a peer could turn "this batch is uninterpretable" into "we fork
    // at genesis" by corrupting one entry — buying a full-chain reorg attempt
    // with a single malformed header, on exactly the short chains where the
    // whole walk is inside the window.
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (let i = 0; i < 2; i++) {
      const { post: post, tx: postTx, postId: postId } = await seedPostTx(author, `poison control ${i}`);
      posts.insertPost(postId, post, encodePost(post));
      mempool.insertUtxoTx(postTx, 1000);
      await mineNextBlock(bc);
    }

    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();
    const ourTip = ordering.getOrderingBlock(2)!;
    const sane: BlockHeader = {
      protocolVersion: PROTOCOL_VERSION,
      height: 2,
      prevBlockHash: 'ef'.repeat(32),
      utxoTxRoot: '00'.repeat(32),
      stateRoot: '00'.repeat(33),
      validatorId: new Uint8Array(32),
      powNonce: 0,
      powTargetBits: 256 * 4,
      createdAt: Date.now(),
    };

    // Control: this batch, unpoisoned, falls through to genesis.
    expect(forkResolution.findForkPoint(ourTip.header, [sane])).toBe(0);

    // The same batch with one entry outside the encodable domain is refused,
    // and the refusal names the batch rather than answering a fork point.
    expect(
      forkResolution.findForkPoint(ourTip.header, [sane, { ...sane, createdAt: -1 }]),
    ).toBeNull();
    expect(
      warn.mock.calls.some(([m]) => typeof m === 'string' && m.includes('refusing peer header batch')),
    ).toBe(true);
    warn.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Phase 1f-2 — a peer header batch is accepted or refused whole.
  //
  // `theirHeaders` reaches this function as `decode(response) as BlockHeader[]`
  // (net's `requestHeaders`): a raw cbor decode with a TypeScript cast and no
  // runtime check, so every field in it is the peer's to choose. These two pin
  // the answer to the question `blockHash` forces — what an unhashable entry
  // means — because the plausible alternative, skipping it and carrying on,
  // hands the peer the fork depth.
  // -------------------------------------------------------------------------

  /** A three-block chain and the pieces every batch below is built from. */
  async function threeBlockChain() {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    for (let i = 0; i < 3; i++) {
      const { post: post, tx: postTx, postId: postId } = await seedPostTx(author, `batch block ${i + 1}`);
      posts.insertPost(postId, post, encodePost(post));
      mempool.insertUtxoTx(postTx, 1000);
      await mineNextBlock(bc);
    }

    const ordering = await importOrdering();
    const block1 = ordering.getOrderingBlock(1);
    const block2 = ordering.getOrderingBlock(2);
    const ourTip = ordering.getOrderingBlock(3);
    expect(block1).not.toBeNull();
    expect(block2).not.toBeNull();
    expect(ourTip).not.toBeNull();

    // Their tip: a real-looking header on a chain that forked from ours, so the
    // batch has a leading entry that matches nothing.
    const theirTip: BlockHeader = {
      protocolVersion: PROTOCOL_VERSION,
      height: 3,
      prevBlockHash: blockHash(block2!.header)!,
      utxoTxRoot: 'ff'.repeat(32),
      stateRoot: 'ff'.repeat(33),
      validatorId: new Uint8Array(32),
      powNonce: 0,
      powTargetBits: 256 * 4,
      createdAt: Date.now(),
    };

    return {
      ourTip: ourTip!.header,
      block1: block1!.header,
      block2: block2!.header,
      theirTip,
      forkResolution: await importForkResolution(),
    };
  }

  it('refuses the whole batch when any header is outside the encodable domain', async () => {
    const { ourTip, block1, block2, theirTip, forkResolution } = await threeBlockChain();

    // Control: this exact batch, unpoisoned, forks at 2.
    expect(forkResolution.findForkPoint(ourTip, [theirTip, block2])).toBe(2);

    // `createdAt` outside `vlqU`'s domain — the field nothing checked before
    // Phase 1f. Placed AFTER the matching entry, where a check that stopped at
    // the first match would never look, so answering null proves the whole
    // batch is hashed before any of it is matched.
    const poisoned: BlockHeader = { ...block1, createdAt: -1 };
    expect(forkResolution.findForkPoint(ourTip, [theirTip, block2, poisoned])).toBeNull();
  });

  it('a corrupted header cannot push the fork point deeper', async () => {
    const { ourTip, block1, block2, theirTip, forkResolution } = await threeBlockChain();

    // Control: with the height-2 entry absent the batch legitimately forks at
    // 1, so the deeper answer is reachable and null below is a refusal rather
    // than "nothing matched".
    expect(forkResolution.findForkPoint(ourTip, [theirTip, block1])).toBe(1);

    // Same batch, except the entry that would have matched at height 2 is
    // corrupted instead of absent. Skipping it answers 1 — a reorg two blocks
    // deeper than the chains actually diverged, with the depth chosen by
    // whoever served the headers. Refusing the batch is what this pins.
    const poisonedAtTwo: BlockHeader = { ...block2, createdAt: Number.NaN };
    expect(
      forkResolution.findForkPoint(ourTip, [theirTip, poisonedAtTwo, block1]),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — the ordering store disagreeing with the apply gate
//
// `index.ts`'s ordering-block boundary fails the node stop on
// `UnhashableStoredHeaderError` and warns-and-continues on everything else, so
// what these pin is the half of that decision the boundary cannot make for
// itself: that the fault arrives as a distinct *type* carrying the site and the
// height, rather than as prose the boundary would have to match on.
//
// Reaching the state at all takes a write through the store, which is what
// apply does — but *after* the structure gate whose header checks are the same
// domain predicate. That is the only way past it, and it is exactly how the
// double-width roots in `test/routes/blocks.test.ts` got into a stored header.
// ---------------------------------------------------------------------------

describe('a stored header that cannot be hashed', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => { vi.resetModules(); });

  /** Store a height-1 block whose header is outside the encodable domain. */
  async function storeCorruptTip() {
    const db = await importDb();
    db.initDb(':memory:');
    const ordering = await importOrdering();

    // Structurally valid in every respect `verifyOrderingBlockStructure`
    // checks, so `createdAt` is the only thing wrong with it. That is what
    // makes `powTargetBits` the constant and not a number: the gate reads
    // `ORDERING_BLOCK_POW_TARGET_FLOOR` (VALIDATION_INTERFACE →
    // verifyOrderingBlockStructure), and a fixture spelling its present value
    // stops being structurally valid the moment the floor moves — which turns
    // these tests green on a rejection at the wrong gate.
    const buildBlock = (height: number, createdAt: number): OrderingBlock => ({
      header: {
        protocolVersion: PROTOCOL_VERSION,
        height,
        prevBlockHash: '00'.repeat(32),
        utxoTxRoot: '00'.repeat(32),
        stateRoot: '00'.repeat(33),
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
        createdAt,
      },
      utxoTxTree: { utxoTxIds: ['77'.repeat(32)], utxoTxs: [new Uint8Array(96)], pruneEntries: [] },
      validatorSignature: new Uint8Array(64),
    });

    // `createdAt: -1` is outside `vlqU`'s domain, and the field nothing checked
    // before Phase 1f. The only way in is the store: `createOrderingBlock` is
    // what apply calls *after* the gate that would have refused this header.
    //
    // ⚠ **Phase 3b changed where this surfaces, and the change is structural.**
    // Under cbor the corruption round-tripped, so the header came back out of
    // the store intact and failed later, at `blockHash` — which is what
    // `UnhashableStoredHeaderError` was built to report. Under the positional
    // format `-1` writes `VLQ_SENTINEL`, so the row is still *written* but can
    // never be *read*: `readVlqU` refuses ten bytes past `MAX_SAFE_INTEGER`.
    //
    // The consequence is bigger than this fixture. Every value `readVlqU`,
    // `readHexN` and `readBytesN` can produce is already inside
    // `verifyHeaderFieldDomains` — safe non-negative integers, lowercase hex of
    // the exact width, exactly 32 bytes — so **a stored header that decodes is
    // always hashable**, and `blockHash` cannot answer `null` on this path. The
    // decode boundary subsumes the domain check, which is the "serializer is the
    // validator" property holding for the header.
    //
    // That leaves `UnhashableStoredHeaderError` unreachable from the store. It
    // stays because the argument above is a claim about the rest of the tree
    // rather than a property of this function, and these tests pin the behaviour
    // the claim would have to survive.
    const block = buildBlock(1, -1);
    ordering.createOrderingBlock(block);
    expect(ordering.getCurrentHeight()).toBe(1);

    return {
      block,
      header: block.header,
      buildBlock,
      forkResolution: await importForkResolution(),
      corruptState: await importCorruptState(),
    };
  }

  /** Run `fn` and return what it threw, or `null` if it did not throw. */
  function thrownBy(fn: () => unknown): unknown {
    try {
      fn();
      return null;
    } catch (err) {
      return err;
    }
  }

  it('a header outside the domain is UNREADABLE, not merely unhashable', async () => {
    const { forkResolution, corruptState } = await storeCorruptTip();

    // The row was written — `writeVlqU` is total and sentinels `-1` — and it
    // cannot be read back. Both halves matter: the write is why the corruption
    // still gets into the store at all, and the read is why it can never come
    // out pretending to be a header.
    const caught = thrownBy(() => forkResolution.extendsOurTip(
      { header: { height: 2 } } as unknown as OrderingBlock,
    ));

    // What it surfaces AS is the fix. A bare `ReaderError` here says only
    // "some bytes did not decode" — the same sentence peer bytes produce — and
    // every boundary downstream treats it as one. `getOrderingBlock` knows
    // more than that: the bytes are ours. So it says so, in the vocabulary the
    // boundary already acts on.
    expect(caught).toBeInstanceOf(corruptState.UnreadableStoredBlockError);
    expect((caught as { site: string }).site).toBe('getOrderingBlock');
    expect((caught as { height: number }).height).toBe(1);

    // The reader's own diagnosis is carried, not replaced: `cause` keeps which
    // field of which struct refused, which is the only thing that says *what*
    // is corrupt. By name, not `instanceof` — `vi.resetModules()` gives the
    // dynamically imported graph its own copy of every class, so a cross-graph
    // `instanceof` compares two identical definitions and answers false.
    const cause = (caught as { cause: unknown }).cause;
    expect((cause as Error).name).toBe('ReaderError');
    expect((cause as Error).message).toMatch(/exceeds safe integer range/);
    expect((caught as Error).message).toMatch(/exceeds safe integer range/);
  });

  it('a stored header at the widest value each field admits is still hashable', async () => {
    // Checked over the widest value each writer admits, `powTargetBits` included
    // — 65536 is the top of its domain (VALIDATION_INTERFACE → orderingPowTarget
    // clause 1) and three VLQ bytes, so this is also the widest that field gets.
    //
    // ⚠ **`powTargetBits` is the one header field whose domain is NARROWER than
    // its reader's range**, and that breaks the general form of this claim.
    // Every other field's `readVlqU` / `readHexN` / `readBytesN` range is a
    // subset of `verifyHeaderFieldDomains`, so no round-trip could produce a
    // header the domain rejects; `readVlqU` produces any safe integer, and the
    // domain stops at 65536. A stored row above it decodes and then hashes to
    // `null` — so `UnhashableStoredHeaderError` is reachable from the store
    // again, by the same corrupt-database or downgrade route the fail-stop
    // notes below describe.
    const db = await importDb();
    db.initDb(':memory:');
    const ordering = await importOrdering();
    const { verifyHeaderFieldDomains } = await import('@dagsocial/validation');

    const extremes: OrderingBlock = {
      header: {
        protocolVersion: PROTOCOL_VERSION,
        height: 1,
        prevBlockHash: 'ff'.repeat(32),
        utxoTxRoot: 'a0'.repeat(32),
        stateRoot: 'ff'.repeat(33),
        validatorId: new Uint8Array(32).fill(0xff),
        powNonce: 0,
        powTargetBits: 65536,
        createdAt: Number.MAX_SAFE_INTEGER,
      },
      utxoTxTree: { utxoTxIds: ['77'.repeat(32)], utxoTxs: [new Uint8Array(96)], pruneEntries: [] },
      validatorSignature: new Uint8Array(64),
    };
    ordering.createOrderingBlock(extremes);

    const readBack = ordering.getOrderingBlock(1)!;
    expect(verifyHeaderFieldDomains(readBack.header)).toEqual({ valid: true });
    expect(blockHash(readBack.header)).not.toBeNull();

    // One step past the top of the domain: the row still round-trips, and the
    // header it produces has no hash. This is what the general claim above
    // would have ruled out.
    ordering.deleteOrderingBlock(1);
    ordering.createOrderingBlock({
      ...extremes,
      header: { ...extremes.header, powTargetBits: 65537 },
    });
    const past = ordering.getOrderingBlock(1)!;
    expect(past.header.powTargetBits).toBe(65537);
    expect(verifyHeaderFieldDomains(past.header).valid).toBe(false);
    expect(blockHash(past.header)).toBeNull();
  });

  // **WHERE PHASE 3b MOVED THIS FAIL-STOP, AND WHERE IT NOW LIVES.**
  //
  // Before: a stored header outside the domain came back out of the store
  // intact, `blockHash` answered `null`, and the apply path raised
  // `UnhashableStoredHeaderError` — typed, naming its site and height, and
  // re-thrown through `applyOrderingBlock`'s totality catch so that local
  // corruption could not be filed as a network problem.
  //
  // Under the positional format the header does not decode at all, so the store
  // read throws before `blockHash` is ever reached. What it must NOT throw is a
  // bare `ReaderError`, which is **not** in the funnel's re-throw allowlist: the
  // totality catch would absorb it into `return false`, `reorg` would report its
  // generic "block at height N rejected", and `index.ts` would log that as
  // `Fork resolution error` and carry on. The two cases below assert the wrapped
  // error, which is the difference between a corrupt store announcing itself and
  // a corrupt store reading as an ordinary rejection.
  //
  // **The fix is in the store, not in the catch.** At the catch, `err
  // instanceof ReaderError` is equally true for `decodeTx` over the block's own
  // `utxoTxs` — bytes the *producer* chose. Inside `getOrderingBlock` the
  // provenance is not inferred, it is structural: `ordering_blocks` has exactly
  // one INSERT, in `block-apply` downstream of the structure gate, and what it
  // stores is our own re-encoding of the decoded block rather than any bytes a
  // peer sent. A row that will not decode is therefore our corruption or our
  // bug, never a peer's input — so it leaves as `UnreadableStoredBlockError`,
  // a `CorruptChainStateError`, which the funnel's existing arm already carries
  // and the boundary already fail-stops on. No new escape from the catch.
  //
  // The load-bearing difference is **reach**, and the first test below is where
  // it shows: `extendsOurTip` reads the same row on the gossip path *before*
  // apply and outside `handleOrderingBlock`'s inner try, so an arm in the
  // funnel's catch never sees it — a bare `ReaderError` there fails
  // `failStopIfCorruptChain`'s `instanceof` and ends the process as an
  // unhandled rejection instead, with no FATAL line and no site or height.
  // Five other callers (`findForkPoint`, `revertBlock`, the block creator, two
  // routes) are outside that catch as well.
  //
  // Reachability, stated so the severity is not overread: a header can only
  // reach the store outside the domain if it bypassed `verifyHeaderFieldDomains`
  // (Phase 1f), which apply runs. So the trigger is a corrupt or hand-edited
  // database, or a downgrade — which is precisely the population
  // `failStopIfCorruptChain` exists for.

  it('applyOrderingBlock surfaces the unreadable store row instead of swallowing it', async () => {
    const { buildBlock, corruptState } = await storeCorruptTip();
    const { applyOrderingBlock } = (await import(
      '../../src/services/block-apply.js'
    )) as unknown as { applyOrderingBlock: (b: OrderingBlock) => boolean };

    // `false` would read as "the arriving block was bad" for a fault that is
    // entirely local — and would then repeat for every block after it, since
    // the same unreadable row is the chain link every one of them is checked
    // against.
    const caught = thrownBy(() => applyOrderingBlock(buildBlock(2, 1)));
    expect(caught).toBeInstanceOf(corruptState.UnreadableStoredBlockError);
    expect((caught as { site: string }).site).toBe('getOrderingBlock');
    expect((caught as { height: number }).height).toBe(1);
  });

  /** Three contiguous, well-formed stored blocks — well-formed to the same
   * gate `storeCorruptTip` above builds against, so `powTargetBits` is the
   * floor constant here too. */
  async function storeThreeBlocks() {
    const db = await importDb();
    db.initDb(':memory:');
    const ordering = await importOrdering();

    const build = (height: number): OrderingBlock => ({
      header: {
        protocolVersion: PROTOCOL_VERSION,
        height,
        prevBlockHash: '00'.repeat(32),
        utxoTxRoot: '00'.repeat(32),
        stateRoot: '00'.repeat(33),
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
        createdAt: 1,
      },
      utxoTxTree: { utxoTxIds: ['77'.repeat(32)], utxoTxs: [new Uint8Array(96)], pruneEntries: [] },
      validatorSignature: new Uint8Array(64),
    });
    for (const h of [1, 2, 3]) ordering.createOrderingBlock(build(h));

    return {
      ordering,
      tip: build(3).header,
      forkResolution: await importForkResolution(),
      corruptState: await importCorruptState(),
    };
  }

  it('a hole below the tip leaves getCurrentHeight unchanged', async () => {
    const { ordering } = await storeThreeBlocks();

    // Why the silent skip in the fork-resolution work comparison was invisible:
    // `getCurrentHeight()` is `MAX(height)`, so removing a block *below* the tip
    // changes nothing it reports. Nothing else notices either — which is why
    // walking the range has to assert contiguity rather than tolerate a gap.
    ordering.deleteOrderingBlock(2);
    expect(ordering.getCurrentHeight()).toBe(3);
    expect(ordering.getOrderingBlock(2)).toBeNull();
    expect(ordering.getOrderingBlock(3)).not.toBeNull();
  });

  it('findForkPoint walks the whole chain down without a hole', async () => {
    const { tip, forkResolution } = await storeThreeBlocks();

    // The control the throw below needs: with the chain intact, the walk runs
    // out of blocks at height 0 and returns an ordinary answer — the genesis
    // state, which is the ancestor a three-block chain shares with anything.
    // Running out of blocks is normal *there* and only there; a hole anywhere
    // above it throws.
    expect(forkResolution.findForkPoint(tip, [])).toBe(0);
  });

  it('findForkPoint stops the node on a hole rather than reorging without it', async () => {
    const { ordering, tip, forkResolution, corruptState } = await storeThreeBlocks();
    ordering.deleteOrderingBlock(2);

    // Truncating here loses our height-1 hash, so a peer chain that forks at 1
    // reads as having no common ancestor and the node quietly declines to
    // reorg — forever, on a chain it cannot leave. The genesis boundary is
    // height 0; height 2 is a gap, and the two are told apart by `>= 1`.
    const caught = thrownBy(() => forkResolution.findForkPoint(tip, []));
    expect(caught).toBeInstanceOf(corruptState.MissingStoredBlockError);
    expect((caught as { site: string }).site).toBe('findForkPoint');
    expect((caught as { height: number }).height).toBe(2);
  });

  it('reorg propagates the corruption instead of reporting a rejected block', async () => {
    const { buildBlock, forkResolution, corruptState } = await storeCorruptTip();

    // **The sharper of the two**: `reorg failed: block at height N rejected` is
    // the one sentence that must never be produced for this fault. It is what
    // `reorg` throws when `applyOrderingBlock` answers
    // `false`, and `index.ts`'s fork-resolution catch logs it as
    // `Fork resolution error` and carries on — local corruption filed as a
    // network problem.
    //
    // `reorg`'s own catch restores the prover and re-throws unchanged, so the
    // typed error reaches the boundary with its identity intact and the
    // fork-resolution catch in `index.ts` lets it past rather than warning
    // over it.
    const caught = thrownBy(() => forkResolution.reorg(1, [buildBlock(2, 1)]));
    expect(caught).toBeInstanceOf(corruptState.UnreadableStoredBlockError);
    expect((caught as Error).message).not.toContain('reorg failed');
  });

  it('undecodable bytes a PEER chose stay a rejection, and never a halt', async () => {
    // The other half of the separation. `decodeTx` over
    // `utxoTxTree.utxoTxs[i]` reads bytes the *producer* chose, so a
    // `ReaderError` from there is ordinary malformed input: the block is
    // rejected (NODE_INTERFACE → "Embedded transactions: a mismatch rejects the
    // block") and the node stays up. Which verdict the arm reaches is that
    // rule's business; what this test owns is that it is a verdict at all
    // rather than a process death.
    //
    // ⚠ **What this test does NOT prove — measured, not assumed.** The
    // alternative fix (an `err instanceof ReaderError` arm in the funnel's
    // catch) was built and run against this test, and this test PASSED under
    // it. It cannot discriminate, because the decode above has its own local
    // catch and a producer's `ReaderError` therefore never reaches the funnel's
    // catch to be promoted. The hazard in that design is latent, not live: it
    // makes funnel totality depend on every present and future decode of
    // block-carried bytes being locally caught, with a remote node-kill as the
    // failure mode and nothing that would notice the day one is added. The test
    // that *does* discriminate is `extendsOurTip`'s, at the top of this
    // describe — that path never enters the funnel, so only a fix at the store
    // read reaches it.
    //
    // Kept anyway, because the arm it pins is otherwise covered only for its
    // verdict: `tx-envelope-funnel.test.ts` measures what the decode arm
    // answers, and this measures that answering is what it does.
    const db = await importDb();
    db.initDb(':memory:');

    const miner = makeTestIdentity();
    const block = await makeApplicableBlock({ miner });

    const { computeUtxoTxRoot } = await importBlockCreatorRoots();
    block.utxoTxTree.utxoTxIds = ['00'.repeat(32)];
    block.utxoTxTree.utxoTxs = [new Uint8Array([0xff, 0xff, 0xff])];
    // The Merkle commitment covers the bytes, so it has to be re-derived — a
    // block whose root disagrees with its body is rejected at step 4 and would
    // never reach the tx loop this test is about. Nonce and signature cover the
    // header, so both follow.
    block.header.utxoTxRoot = computeUtxoTxRoot(block.utxoTxTree);
    block.header.powNonce = solveHeaderPow(block.header);
    block.validatorSignature = signHeader(block.header, miner.privateKey);

    const { applyOrderingBlock } = (await import(
      '../../src/services/block-apply.js'
    )) as unknown as { applyOrderingBlock: (b: OrderingBlock) => boolean };

    let applied: boolean | undefined;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const caught = thrownBy(() => { applied = applyOrderingBlock(block); });
    const warnings = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();

    expect(caught).toBeNull();
    expect(applied).toBe(false);
    // Not merely "it did not throw": the decode really was attempted and really
    // did fail, so the absence of a throw is this arm's doing rather than the
    // bytes never having been read.
    expect(
      warnings.some((w) => w.includes('did not decode')),
      `no decode warning; got ${JSON.stringify(warnings)}`,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — revertBlock
// ---------------------------------------------------------------------------

describe('revertBlock', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch { /* not imported */ }
    vi.resetModules();
  });

  it('reverts coinbase credits', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    await mineNextBlock(bc); // genesis with coinbase

    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).not.toBeNull();

    // Revert
    const forkResolution = await importForkResolution();
    forkResolution.revertBlock(1);

    // Block and journal deleted
    expect(ordering.getOrderingBlock(1)).toBeNull();
    const journal = await importJournalStore();
    expect(journal.getBlockJournal(1)).toBeNull();
  });

  it('reverts post confirmations', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();

    const { post: post, tx: postTx, postId: postId } = await seedPostTx(author, 'unconfirm me');
    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    posts.insertPost(postId, post, encodePost(post));

    const mempool = await importMempoolFresh();
    mempool.insertUtxoTx(postTx, 1000);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const block = await mineNextBlock(bc);
    expect(block).not.toBeNull();

    // Verify post was confirmed
    const postAfter = posts.getPost(postId);
    expect(postAfter).not.toBeNull();

    // Revert
    const forkResolution = await importForkResolution();
    forkResolution.revertBlock(1);

    // Block deleted
    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
  });

  it('throws when no journal exists for height', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const forkResolution = await importForkResolution();
    expect(() => forkResolution.revertBlock(99)).toThrow(
      'No journal for height 99',
    );
  });

  it('reverts UTXO transactions: outputs deleted, inputs unspent', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const posts = await importPosts();
    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();

    const author = makeTestIdentity();

    const { post: post, tx: postTx, postId: postId } = await seedPostTx(author, 'utxo revert test');
    const { encodePost } = await import('@dagsocial/types');
    posts.insertPost(postId, post, encodePost(post));

    // Insert sub-block
    mempool.insertUtxoTx(postTx, 1000);

    // Insert a standalone UTXO tx. The like targets the post this block
    // confirms — N2b rejects likes on unconfirmed targets, and topology
    // (§8b) precedes the tx loop (§11). Self-like is legal by contract.
    const karmaBox = makeKarmaBox(100n, author.userId, 0);
    utxo.insertBox(karmaBox);
    const likeTx = makeLikeTx(author, karmaBox, postId, author.userId);
    mempool.insertUtxoTx(likeTx, 1000);

    bc.startBlockCreator(testConfig);
    await mineNextBlock(bc);

    // Verify journal has the applied tx (mempool re-insertion record) and the
    // primitive mutation log the revert will replay
    const journalStore = await importJournalStore();
    const journal = journalStore.getBlockJournal(1);
    expect(journal).not.toBeNull();
    expect(journal!.appliedUtxoTxs.length).toBeGreaterThan(0);
    const txRecord = journal!.appliedUtxoTxs[0]!;
    expect(txRecord.txId).toBeTruthy();
    expect(txRecord.txCbor).toBeInstanceOf(Uint8Array);

    const insertedIds = journal!.mutations
      .filter((m) => m.kind === 'box' && m.op === 'insert')
      .map((m) => (m as { boxId: string }).boxId);
    const removedIds = journal!.mutations
      .filter((m) => m.kind === 'box' && m.op === 'remove')
      .map((m) => (m as { boxId: string }).boxId);
    // The like tx's change box was created, its karma input consumed
    expect(insertedIds.length).toBeGreaterThan(0);
    expect(removedIds).toContain(karmaBox.id);

    // Revert
    const forkResolution = await importForkResolution();
    forkResolution.revertBlock(1);

    // Every box the block created is gone; every box it consumed is live again.
    //
    // ⛔ **EXCEPT ONE THAT IS BOTH, AND THE LIKE MARKER IS THE FIRST OF ITS
    // KIND.** A `LikeAccrualBox` is created by the like transaction and consumed
    // by the same block's settlement, so it appears in BOTH lists — and after a
    // revert it must be **gone**, not live: it never existed before this block.
    // The journal replays its inverses in reverse order, so the unconsume is
    // undone by the delete that follows it.
    const intraBlock = new Set(insertedIds.filter((id) => removedIds.includes(id)));
    for (const boxId of insertedIds) {
      expect(utxo.getBox(boxId)).toBeNull();
    }
    for (const boxId of removedIds) {
      if (intraBlock.has(boxId)) {
        expect(utxo.getBox(boxId)).toBeNull();
        continue;
      }
      expect(utxo.getBox(boxId)).not.toBeNull();
    }
    // Non-vacuity: the marker really is one, so the branch above is exercised
    // rather than being a clause nothing takes.
    expect(intraBlock.size).toBeGreaterThan(0);

    // Block and journal should be gone
    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(journalStore.getBlockJournal(1)).toBeNull();
  });

  it('refuses to run while a block journal is open', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    await mineNextBlock(bc);

    const journalStore = await importJournalStore();
    const forkResolution = await importForkResolution();
    journalStore.beginBlockJournal(2);
    try {
      expect(() => forkResolution.revertBlock(1)).toThrow(
        'a block journal is open',
      );
    } finally {
      journalStore.abortBlockJournal();
    }

    // Nothing was reverted
    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).not.toBeNull();
  });

  it('rolls back decay burns', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();

    // Create identity with a karma box at block 0 (ancient)
    const identity = makeTestIdentity();
    const oldBox = makeKarmaBox(100n, identity.userId, 0);
    utxo.insertBox(oldBox);
    const oldBoxId = oldBox.id!;

    // Apply decay manually (simulates what block application does)
    const { deriveKarmaDecay } = await import(
      '../../src/services/decay.js'
    );
    const {
      KARMA_STALE_THRESHOLD_BLOCKS,
      KARMA_DECAY_INTERVAL_BLOCKS,
      KARMA_DECAY_AMOUNT,
      KARMA_MINIMUM,
    } = await import('@dagsocial/types');

    // Use real store functions for getKarmaBoxes (returns all boxes)
    const { getKarmaBoxes } = await import('../../src/store/utxo.js');

    const decayCfg = {
      staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
      decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
      decayAmount: KARMA_DECAY_AMOUNT,
      karmaMinimum: KARMA_MINIMUM,
    };

    // Spec G phase D: the decay clock is committed state, injected alongside
    // the box accessors.
    const records = await import('../../src/store/identity-records.js');

    const deps = {
      getKarmaBoxes,
      consumeBox: utxo.consumeBox,
      insertBox: utxo.insertBox,
      getIdentityRecord: records.getIdentityRecord,
      putIdentityRecord: records.putIdentityRecord,
      getKarmaOwners: () => [identity.userId],
    };

    const DECAY_HEIGHT = KARMA_STALE_THRESHOLD_BLOCKS + 100;
    const entries = deriveKarmaDecay(deps, DECAY_HEIGHT, decayCfg);

    expect(entries.length).toBe(1);

    // ⛔ **The plan carries no box id, because decay emits no box.** It derives;
    // the block's settlement transaction emits the replacement as one of its
    // outputs (NODE_INTERFACE → The settlement transaction). This block stands
    // in for that emission so the REVERT — which is what this case is about —
    // still has something to undo.
    const { computeBoxId } = await import('@dagsocial/types');
    const provenance = await import('../../src/mint-provenance.js');
    const plan = entries[0]!;
    for (const id of plan.consumedBoxIds) utxo.consumeBox(id, DECAY_HEIGHT);
    const emitted = {
      boxType: 'karma' as const,
      value: plan.newValue,
      owner: plan.owner,
      decayBurn: true,
      txId: provenance.mintTxIdFor(provenance.decayContext(plan.owner), DECAY_HEIGHT),
      index: provenance.MINT_OUTPUT_INDEX,
    };
    const newBoxId = computeBoxId(emitted);
    utxo.insertBox({ ...emitted, id: newBoxId });

    // Old box consumed (not returned by getKarmaBox, which filters spent)
    const afterDecayBox = utxo.getKarmaBox(identity.userId);
    expect(afterDecayBox).not.toBeNull();
    expect(afterDecayBox!.value).toBe(plan.newValue);

    // Reverse: delete new box, unconsume old boxes
    // (same logic as revertBlock step 2b in fork-resolution.ts)
    const { deleteBox, unconsumeBox } = await import(
      '../../src/store/utxo.js'
    );
    for (const entry of entries) {
      deleteBox(newBoxId);
      for (const boxId of entry.consumedBoxIds) {
        unconsumeBox(boxId);
      }
    }

    // Old box restored (unspent), new box gone
    const restoredBox = utxo.getKarmaBox(identity.userId);
    expect(restoredBox).not.toBeNull();
    expect(restoredBox!.boxType).toBe('karma');
    expect(restoredBox!.value).toBe(100n);
    expect(restoredBox!.id).toBe(oldBoxId);

    expect(utxo.getBox(newBoxId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — reorg
// ---------------------------------------------------------------------------

describe('reorg', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch { /* not imported */ }
    vi.resetModules();
  });

  it('reverts blocks and re-inserts txs/sub-blocks to mempool', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();

    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    // Build 3 blocks
    for (let i = 0; i < 3; i++) {
      const { post: post, tx: postTx, postId: postId } = await seedPostTx(author, `reorg test ${i}`);
      posts.insertPost(postId, post, encodePost(post));
      mempool.insertUtxoTx(postTx, 1000);
      await mineNextBlock(bc);
    }

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(3);

    // Mempool should be empty (all consumed)
    expect(mempool.getPendingEntries(100)).toHaveLength(0);

    // Reorg back to height 0 (full rollback, no new blocks)
    const forkResolution = await importForkResolution();
    forkResolution.reorg(0, []);

    // All blocks should be gone
    expect(ordering.getCurrentHeight()).toBe(0);
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(ordering.getOrderingBlock(2)).toBeNull();
    expect(ordering.getOrderingBlock(3)).toBeNull();

    // Journals should be gone
    const journalStore = await importJournalStore();
    expect(journalStore.getBlockJournal(1)).toBeNull();
    expect(journalStore.getBlockJournal(2)).toBeNull();
    expect(journalStore.getBlockJournal(3)).toBeNull();

    // Mempool should have re-inserted sub-blocks
    const pendingAfter = mempool.getPendingEntries(100);
    expect(pendingAfter.length).toBeGreaterThan(0);
  });

  it('a re-insert whose input a pending entry spends is dropped, not thrown', async () => {
    // The reverted tx and the incumbent are both valid once the block is gone,
    // and only one can be. Admitting both would leave the pool holding two
    // spends of one box; throwing would roll the whole chain switch back. The
    // reorg drops it and completes.
    const db = await importDb();
    db.initDb(':memory:');

    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    const author = makeTestIdentity();

    const { post: post, tx: postTx, postId: postId } = await seedPostTx(author, 'reorg re-insert conflict');
    posts.insertPost(postId, post, encodePost(post));
    mempool.insertUtxoTx(postTx, 1000);

    const karmaBox = makeKarmaBox(100n, author.userId, 0);
    utxo.insertBox(karmaBox);
    const likeTx = makeLikeTx(author, karmaBox, postId, author.userId);
    mempool.insertUtxoTx(likeTx, 1000);

    bc.startBlockCreator(testConfig);
    await mineNextBlock(bc);
    expect(mempool.getPendingEntries(100)).toHaveLength(0);

    // An entry admitted since, spending the box the block's tx spent.
    mempool.insertUtxoTx(
      { inputs: [karmaBox.id!], outputs: [], signatures: {}, protocolVersion: 1 } as never,
      1000,
    );

    const forkResolution = await importForkResolution();
    expect(() => forkResolution.reorg(0, [])).not.toThrow();

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(0);

    // Identified by transaction id, because the block carried TWO transactions
    // and only one of them conflicts: the post's re-insert is the control that
    // makes the like's absence a drop rather than an empty re-insert path.
    const { computeTxId, decodeTx } = await import('@dagsocial/types');
    const pooled = mempool.getPendingEntries(100)
      .filter((e: { entryType: string; utxoTxCbor: Uint8Array | null }) =>
        e.entryType === 'utxo_tx' && e.utxoTxCbor !== null)
      .map((e: { utxoTxCbor: Uint8Array | null }) => computeTxId(decodeTx(e.utxoTxCbor!)));
    // The incumbent kept its place; the reverted like was not admitted beside it.
    expect(pooled).not.toContain(computeTxId(likeTx));
    // The post transaction spends a box nothing else claims, so it came back.
    expect(pooled).toContain(computeTxId(postTx));
    expect(pooled).toHaveLength(2);
  });

  it('reorg then rebuild: state matches new chain', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();

    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    // Build 2 blocks
    for (let i = 0; i < 2; i++) {
      const { post: post, tx: postTx, postId: postId } = await seedPostTx(author, `chain a ${i}`);
      posts.insertPost(postId, post, encodePost(post));
      mempool.insertUtxoTx(postTx, 1000);
      await mineNextBlock(bc);
    }

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(2);

    // Roll back to height 0
    const forkResolution = await importForkResolution();
    forkResolution.reorg(0, []);

    expect(ordering.getCurrentHeight()).toBe(0);

    // Rebuild: new chain from mempool entries (re-inserted by reorg)
    // The block creator will pick up re-inserted sub-blocks
    await mineNextBlock(bc); // height 1
    await mineNextBlock(bc); // height 2

    expect(ordering.getCurrentHeight()).toBe(2);

    // Verify new chain blocks exist
    expect(ordering.getOrderingBlock(1)).not.toBeNull();
    expect(ordering.getOrderingBlock(2)).not.toBeNull();

    // Journals should exist for the new chain
    const journalStore = await importJournalStore();
    expect(journalStore.getBlockJournal(1)).not.toBeNull();
    expect(journalStore.getBlockJournal(2)).not.toBeNull();
  });

  it('reorg with new blocks applies competing chain', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();

    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    // Build 3 blocks
    for (let i = 0; i < 3; i++) {
      const { post: post, tx: postTx, postId: postId } = await seedPostTx(author, `original ${i}`);
      posts.insertPost(postId, post, encodePost(post));
      mempool.insertUtxoTx(postTx, 1000);
      await mineNextBlock(bc);
    }

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(3);

    // Save block 1 (the fork point)
    const block1 = ordering.getOrderingBlock(1);
    expect(block1).not.toBeNull();

    // Save block 2 and 3 from store before reverting
    const block2 = ordering.getOrderingBlock(2);
    const block3 = ordering.getOrderingBlock(3);
    expect(block2).not.toBeNull();
    expect(block3).not.toBeNull();

    // Delete block 3 and 2, but keep block 1 (simulate fork at height 1)
    const forkResolution = await importForkResolution();
    forkResolution.revertBlock(3);
    forkResolution.revertBlock(2);

    expect(ordering.getCurrentHeight()).toBe(1);

    // Now apply competing chain: blocks 2A, 3A (using same blocks for test simplicity)
    // In a real reorg, these would be different blocks from a peer
    // For the test, we apply the same blocks to verify the mechanism works
    forkResolution.reorg(1, [block2!, block3!]);

    expect(ordering.getCurrentHeight()).toBe(3);
    expect(ordering.getOrderingBlock(2)).not.toBeNull();
    expect(ordering.getOrderingBlock(3)).not.toBeNull();

    // Journals should exist for all 3 heights
    const journalStore = await importJournalStore();
    expect(journalStore.getBlockJournal(1)).not.toBeNull();
    expect(journalStore.getBlockJournal(2)).not.toBeNull();
    expect(journalStore.getBlockJournal(3)).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // A full mempool must not abort a reorg (audit M-8). Re-insertion is
  // bookkeeping; letting MempoolFullError escape would roll back the whole
  // chain switch — mempool pressure turning into a consensus-liveness failure.
  // -------------------------------------------------------------------------
  it('drops re-inserted entries and still completes the reorg when the pool is full', async () => {
    const originalCap = process.env['MAX_MEMPOOL_ENTRIES'];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.env['MAX_MEMPOOL_ENTRIES'] = '1';
      vi.resetModules();

      const db = await importDb();
      db.initDb(':memory:');

      const author = makeTestIdentity();

      const { encodePost } = await import('@dagsocial/types');
      const posts = await importPosts();
      const mempool = await importMempoolFresh();
      const bc = await importBlockCreator();
      bc.startBlockCreator(testConfig);

      // Two blocks, one sub-block each. Each insert sits alone in the pool
      // (cap 1) and is consumed by its block, so building the chain is fine.
      for (let i = 0; i < 2; i++) {
        const { post: post, tx: postTx, postId: postId } = await seedPostTx(author, `full pool ${i}`);
        posts.insertPost(postId, post, encodePost(post));
        mempool.insertUtxoTx(postTx, 1000);
        await mineNextBlock(bc);
      }

      const ordering = await importOrdering();
      expect(ordering.getCurrentHeight()).toBe(2);
      expect(mempool.getPendingEntries(100)).toHaveLength(0);

      // Fill the pool to its cap, so every re-insertion below is rejected.
      mempool.insertUtxoTx(fillerTx('occupier'), 1000);
      expect(mempool.getPendingEntries(100)).toHaveLength(1);

      const forkResolution = await importForkResolution();
      expect(() => forkResolution.reorg(0, [])).not.toThrow();

      // The chain switch completed despite every re-insertion being dropped.
      expect(ordering.getCurrentHeight()).toBe(0);
      expect(ordering.getOrderingBlock(1)).toBeNull();
      expect(ordering.getOrderingBlock(2)).toBeNull();
      expect(mempool.getPendingEntries(100)).toHaveLength(1);
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('Reorg re-insertion dropped')),
      ).toBe(true);
    } finally {
      warn.mockRestore();
      if (originalCap === undefined) delete process.env['MAX_MEMPOOL_ENTRIES'];
      else process.env['MAX_MEMPOOL_ENTRIES'] = originalCap;
    }
  });

  it('control — the same reorg re-inserts entries when the pool has room', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();

    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    for (let i = 0; i < 2; i++) {
      const { post: post, tx: postTx, postId: postId } = await seedPostTx(author, `room in pool ${i}`);
      posts.insertPost(postId, post, encodePost(post));
      mempool.insertUtxoTx(postTx, 1000);
      await mineNextBlock(bc);
    }

    mempool.insertUtxoTx(fillerTx('occupier'), 1000);

    const forkResolution = await importForkResolution();
    forkResolution.reorg(0, []);

    // Default cap (10000): the reverted sub-blocks come back.
    expect(mempool.getPendingEntries(100).length).toBeGreaterThan(1);
  });

  it('a fork point of 0 rolls the AVL prover back to the pinned genesis root', async () => {
    // What `findForkPoint`'s new answer costs downstream. `reorg` walks
    // journals from the fork height and rolls the prover to
    // `versionAtOrBeforeHeight(forkHeight)` — and at 0 that version is the
    // genesis one only because `seedGenesisState` deletes the empty tree's
    // height-0 version before writing its own. Every other suite here runs
    // without a prover, so nothing else exercises this.
    const db = await importDb();
    db.initDb(':memory:');
    const proverMod = await import('../../src/state/avl-prover.js');
    proverMod.createAvlProver();
    const system = await import('../../src/store/system.js');
    const genesis = await import('../../src/services/genesis-state.js');
    genesis.seedGenesisState();

    const root = (): string =>
      Buffer.from(proverMod.getAvlProver().prover.digest()!).toString('hex');
    // Imported from the same module graph the seeder just ran in — after
    // `vi.resetModules()` a statically imported `config` is a different
    // instance from the one `genesis-state` read.
    const { config } = await import('../../src/config.js');
    const genesisRoot = root();
    expect(genesisRoot).toBe(config.profile.genesisStateRoot);

    // Coinbase-only blocks, and deliberately so: the state has to move off
    // genesis, and every block moves it by releasing the emission box and
    // creating its coinbase. A post transaction would need a karma box seeded
    // into the store *after* `seedGenesisState` built the tree from
    // `getUnspentBoxes()` — a box the tree never received, which the block
    // spending it cannot remove. Seeding it earlier is not open either: the
    // genesis feed is that same read, so the box would land in the genesis tree
    // and `assertGenesisRoot` would refuse the pinned root.
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    for (let i = 0; i < 3; i++) {
      await mineNextBlock(bc);
    }

    const ordering = await importOrdering();
    const chain = [1, 2, 3].map((h) => ordering.getOrderingBlock(h)!);
    expect(root()).not.toBe(genesisRoot);

    const forkResolution = await importForkResolution();
    forkResolution.reorg(0, []);

    // The whole chain is gone and the state is exactly what genesis seeded —
    // not merely "some earlier root", which a rollback to the empty tree would
    // also satisfy.
    expect(ordering.getCurrentHeight()).toBe(0);
    expect(root()).toBe(genesisRoot);

    // And the fork point is re-appliable: apply from 0 takes the genesis branch
    // of the chain-link check (`prevBlockHash` all zeros, height 1).
    forkResolution.reorg(0, chain);
    expect(ordering.getCurrentHeight()).toBe(3);
    for (const h of [1, 2, 3]) expect(ordering.getOrderingBlock(h)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — reorg abort restores the AVL prover (NODE_INTERFACE
// "Reorg-abort-safe"). SQLite rollback restores the DB and the AVL storage
// rows, but not the prover's in-memory tree: without the reorg-level restore
// it would end at fork-point + applied-prefix state.
// ---------------------------------------------------------------------------

describe('reorg abort', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch { /* not imported */ }
    vi.resetModules();
  });

  it('failed mid-reorg apply leaves chain, DB, and prover digest at the pre-reorg state', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    // Activate the AVL prover singleton against the test DB — the same
    // instance tryGetAvlProver() hands to block-apply and reorg(). Over the
    // store, so the emission box every block below releases is in the tree.
    const { tryGetAvlProver } = (await import(
      '../../src/state/avl-prover.js'
    )) as typeof import('../../src/state/avl-prover.js');
    await activateProverOverStore();

    // Chain of 3 empty blocks (coinbase only); every box in the prover's tree
    // arrived through the apply funnel, so tree and DB agree.
    //
    // The competing height-2 block is built after height 1 and before the
    // originals at 2 and 3, because a hand-built block's `stateRoot` commits to
    // the state its body produces *from the state standing when it is built*
    // (H-6). Post-revert that is exactly the fork state, so building it here is
    // what makes it applicable there.
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    await mineNextBlock(bc);
    const goodB2 = await makeApplicableBlock({ height: 2 });
    await mineNextBlock(bc);
    await mineNextBlock(bc);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(3);
    const originalHashes = [1, 2, 3].map(
      (h) => blockHash(ordering.getOrderingBlock(h)!.header)!,
    );

    const preBoxes = db.getDb().prepare('SELECT * FROM utxo_boxes ORDER BY id').all();
    const avl = tryGetAvlProver();
    expect(avl).not.toBeNull();
    const preDigest = new Uint8Array(avl!.prover.digest()!);

    // Competing chain: the valid height-2 block built above, then a block whose
    // prevBlockHash still names the original height-2 block — rejected by the
    // chain-link check after the valid prefix has already been applied. (That
    // check runs long before the state root, so badB3's root is irrelevant.)
    const badB3 = await makeApplicableBlock({ height: 3 });

    const forkResolution = await importForkResolution();
    expect(() => forkResolution.reorg(1, [goodB2, badB3])).toThrow(
      'reorg failed: block at height 3 rejected',
    );

    // Chain and DB: byte-for-byte the pre-reorg state (SQLite rollback).
    expect(ordering.getCurrentHeight()).toBe(3);
    for (const h of [1, 2, 3]) {
      expect(blockHash(ordering.getOrderingBlock(h)!.header)).toBe(originalHashes[h - 1]);
    }
    expect(db.getDb().prepare('SELECT * FROM utxo_boxes ORDER BY id').all()).toEqual(preBoxes);

    // Prover: the in-memory digest is back at the pre-reorg tip. Without the
    // reorg-level restore it would sit at fork-point + goodB2.
    const postDigest = avl!.prover.digest();
    expect(postDigest).not.toBeNull();
    expect(Buffer.from(postDigest!).equals(Buffer.from(preDigest))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — resolveFork: never reorg to a shorter chain
//
// NODE_INTERFACE → AVL+ State Root → "Never reorg to a shorter chain".
// `reorg()` applies exactly what it is handed, so the resulting tip is checked
// at the decision, not at the mechanism — a peer's answer is the one input the
// work comparison never saw.
// ---------------------------------------------------------------------------

type ForkScenario = {
  /** Hashes of our chain at heights 1, 2, 3. */
  ourHashes: string[];
  /** Newest-first, the shape `requestHeaders` returns. */
  theirHeaders: BlockHeader[];
  /** Their blocks for heights 2, 3, 4. */
  theirBlocks: OrderingBlock[];
  /** The gossiped block that opened the fork. */
  competingBlock: OrderingBlock;
};

/**
 * Our chain at height 3 against a peer chain of three blocks over a shared
 * height-1 fork point — heavier by one block at the network's constant target.
 *
 * The peer's blocks are built, applied in sequence, then reverted. That order is
 * what keeps them applicable: each commits to the state standing when it was
 * built (H-6), which post-revert is the state the reorg replays them against.
 */
async function buildForkScenario(): Promise<ForkScenario> {
  const bc = await importBlockCreator();
  bc.startBlockCreator(testConfig);
  const ordering = await importOrdering();
  const { applyOrderingBlock } = (await import(
    '../../src/services/block-apply.js'
  )) as { applyOrderingBlock: (block: OrderingBlock) => boolean };

  // Height 1 — the fork point, shared by both chains.
  await mineNextBlock(bc);

  const theirBlocks: OrderingBlock[] = [];
  for (const height of [2, 3, 4]) {
    const b = await makeApplicableBlock({ height });
    expect(applyOrderingBlock(b)).toBe(true);
    theirBlocks.push(b);
  }
  expect(ordering.getCurrentHeight()).toBe(4);

  const forkResolution = await importForkResolution();
  for (const height of [4, 3, 2]) forkResolution.revertBlock(height);
  expect(ordering.getCurrentHeight()).toBe(1);

  // Our chain: two blocks the creator mines to its own validator id, so they
  // cannot collide with the hand-built ones above.
  await mineNextBlock(bc);
  await mineNextBlock(bc);
  expect(ordering.getCurrentHeight()).toBe(3);

  const ourHashes = [1, 2, 3].map(
    (h) => blockHash(ordering.getOrderingBlock(h)!.header)!,
  );
  const theirHashes = theirBlocks.map((b) => blockHash(b.header)!);
  expect(ourHashes.some((h) => theirHashes.includes(h))).toBe(false);

  return {
    ourHashes,
    theirHeaders: [...theirBlocks].reverse().map((b) => b.header).concat(
      ordering.getOrderingBlock(1)!.header,
    ),
    theirBlocks,
    competingBlock: theirBlocks[2]!,
  };
}

/**
 * A peer that answers the header request honestly and the block request with
 * `answer`.
 *
 * `connected` is what `getConnectedPeers()` reports — the Active list a
 * counterparty is selected from — and `askedPeers` records the peer id each of
 * the two requests went to, in call order.
 */
function stubNet(
  theirHeaders: BlockHeader[],
  answer: OrderingBlock[],
  connected: string[] = ['peer-withholding'],
): ForkResolutionNet & {
  blockRequests: Array<{ startHeight: number; endHeight: number }>;
  askedPeers: string[];
} {
  const blockRequests: Array<{ startHeight: number; endHeight: number }> = [];
  const askedPeers: string[] = [];
  return {
    blockRequests,
    askedPeers,
    getConnectedPeers: () => connected,
    requestHeaders: async (_startHeight: number, _maxCount: number, peerId: string) => {
      askedPeers.push(peerId);
      return theirHeaders;
    },
    requestBlocks: async (startHeight: number, endHeight: number, peerId: string) => {
      askedPeers.push(peerId);
      blockRequests.push({ startHeight, endHeight });
      return answer;
    },
  };
}

describe('resolveFork — never reorg to a shorter chain', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch { /* not imported */ }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('an empty block response does not truncate our chain to the fork point', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const scenario = await buildForkScenario();
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const net = stubNet(scenario.theirHeaders, []);
    await forkResolution.resolveFork(scenario.competingBlock, net, 'peer-withholding');

    // The peer was asked for the whole range above the fork — the reorg was
    // refused on its answer, not skipped earlier in fork choice.
    expect(net.blockRequests).toEqual([{ startHeight: 2, endHeight: 4 }]);

    expect(ordering.getCurrentHeight()).toBe(3);
    for (const h of [1, 2, 3]) {
      expect(blockHash(ordering.getOrderingBlock(h)!.header)).toBe(scenario.ourHashes[h - 1]);
    }

    // A stated refusal, naming the peer.
    expect(
      warn.mock.calls.some(
        ([msg]) => typeof msg === 'string'
          && msg.includes('peer-withholding')
          && msg.includes('aborting reorg'),
      ),
    ).toBe(true);
  });

  it('a short-but-nonempty response does not lower our tip', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const scenario = await buildForkScenario();
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // One block for a three-block range: nothing is empty, and the tip would
    // still land at 2 against the 3 it started at.
    await forkResolution.resolveFork(
      scenario.competingBlock,
      stubNet(scenario.theirHeaders, [scenario.theirBlocks[0]!]),
      'peer-withholding',
    );

    expect(ordering.getCurrentHeight()).toBe(3);
    for (const h of [1, 2, 3]) {
      expect(blockHash(ordering.getOrderingBlock(h)!.header)).toBe(scenario.ourHashes[h - 1]);
    }
  });

  it('a genuinely longer chain still replaces ours', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const scenario = await buildForkScenario();
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();

    await forkResolution.resolveFork(
      scenario.competingBlock,
      stubNet(scenario.theirHeaders, scenario.theirBlocks),
      'peer-withholding',
    );

    expect(ordering.getCurrentHeight()).toBe(4);
    // Height 1 is the shared fork point; 2..4 are now the peer's blocks.
    expect(blockHash(ordering.getOrderingBlock(1)!.header)).toBe(scenario.ourHashes[0]);
    for (const [i, block] of scenario.theirBlocks.entries()) {
      expect(blockHash(ordering.getOrderingBlock(i + 2)!.header)).toBe(blockHash(block.header));
    }
  });
});

// ---------------------------------------------------------------------------
// The reorg counterparty comes off the Active list.
//
// `peers()` returns every *known* peer, wrong-network ones included: `addPeer`
// runs on `peer:connect` and starts them at Connecting, so a peer that failed
// the DAGsocial handshake is on that list. Choosing a counterparty from it lets
// a stranger's chain be adopted — and because the fork walk bottoms out at the
// genesis state, a node below MAX_REORG_DEPTH can have its whole chain replaced
// rather than a suffix of it.
//
// Within that list the peer asked is the one that relayed the competing block
// (NET_INTERFACE → Pull Requests): it holds the fork chain, where an arbitrary
// connected peer may hold nothing about it and answers the same empty list a
// peer with no reorg to offer would. The source is filtered *through* the
// Active list, so the two rules compose in one direction only — a relaying
// peer that is not Active is not askable.
// ---------------------------------------------------------------------------

describe('resolveFork — the counterparty is an Active peer', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch { /* not imported */ }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('refuses to reorg to a peer that never completed the handshake', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const scenario = await buildForkScenario();
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Known but not Active — the shape of a peer on another network. Its chain
    // is the genuinely-heavier one that the control below does adopt, so the
    // only thing refusing this reorg is which list the counterparty came from.
    //
    // It is also the peer that gossiped the block, which buys it nothing: the
    // selection reads the Active list and the gossip source is filtered through
    // it, so a stranger is no more askable for having relayed the block.
    let headersRequested = 0;
    const strangerOnly = {
      peers: () => [{ id: 'wrong-network-peer' }],
      getConnectedPeers: () => [],
      requestHeaders: async () => { headersRequested++; return scenario.theirHeaders; },
      requestBlocks: async () => scenario.theirBlocks,
    } as unknown as ForkResolutionNet;

    await forkResolution.resolveFork(
      scenario.competingBlock,
      strangerOnly,
      'wrong-network-peer',
    );

    expect(ordering.getCurrentHeight()).toBe(3);
    for (const h of [1, 2, 3]) {
      expect(blockHash(ordering.getOrderingBlock(h)!.header)).toBe(scenario.ourHashes[h - 1]);
    }
    // Refused before any request went out, not after weighing the answer.
    expect(headersRequested).toBe(0);
    expect(
      warn.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('no connected peers')),
    ).toBe(true);
  });

  it('control: the same chain from an Active peer is adopted', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const scenario = await buildForkScenario();
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();

    await forkResolution.resolveFork(
      scenario.competingBlock,
      stubNet(scenario.theirHeaders, scenario.theirBlocks),
      'peer-withholding',
    );

    expect(ordering.getCurrentHeight()).toBe(4);
  });

  it('asks the peer that relayed the block, not the head of the list', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const scenario = await buildForkScenario();
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();

    // The source sits second among the Active peers, so "asked the relaying
    // peer" is distinguishable from "asked whichever came first".
    const net = stubNet(scenario.theirHeaders, scenario.theirBlocks, [
      'peer-idle',
      'peer-relayed-it',
    ]);

    await forkResolution.resolveFork(scenario.competingBlock, net, 'peer-relayed-it');

    // Both queries — the header walk and the block fetch — went to it.
    expect(net.askedPeers).toEqual(['peer-relayed-it', 'peer-relayed-it']);
    expect(ordering.getCurrentHeight()).toBe(4);
  });

  it('falls back to an Active peer when the relaying peer is no longer connected', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const scenario = await buildForkScenario();
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();

    const net = stubNet(scenario.theirHeaders, scenario.theirBlocks, ['peer-active']);

    await forkResolution.resolveFork(scenario.competingBlock, net, 'peer-since-disconnected');

    // The non-member is never asked, and what replaces it is a member: the
    // membership test is what keeps the counterparty on the Active list rather
    // than wherever the source came from.
    expect(net.askedPeers).not.toContain('peer-since-disconnected');
    expect(net.askedPeers).toEqual(['peer-active', 'peer-active']);
    for (const asked of net.askedPeers) {
      expect(net.getConnectedPeers()).toContain(asked);
    }
    expect(ordering.getCurrentHeight()).toBe(4);
  });

  it('falls back for a source that is no peer id at all', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const scenario = await buildForkScenario();
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();

    const net = stubNet(scenario.theirHeaders, scenario.theirBlocks, ['peer-active']);

    // The empty string is what reaches a handler for a gossip event carrying no
    // source, and it is no more a peer id than a stranger's is. Membership is
    // the whole test, so this needs no case of its own.
    await forkResolution.resolveFork(scenario.competingBlock, net, '');

    expect(net.askedPeers).toEqual(['peer-active', 'peer-active']);
    expect(ordering.getCurrentHeight()).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// A reorg that cannot roll the prover back refuses, rather than skipping.
//
// Phase 1b resolves the fork point's AVL version so phase 3 applies the peer's
// chain onto the tree that height actually had. With the version gone there is
// nothing to roll back to, and applying anyway leaves a state root that no
// longer covers the UTXO set — which surfaces later, on some other node, as a
// mismatch blamed on whoever sent the next block.
//
// `MAX_PROOF_HISTORY` is env-tunable and prunes below `height - maxProofHistory`
// while `MAX_REORG_DEPTH` is fixed at 20, so this is reachable by configuration
// and not only by corruption.
// ---------------------------------------------------------------------------

describe('reorg — a missing AVL version at the fork height', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch { /* not imported */ }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  /** A seeded genesis and three mined blocks, with a live prover. */
  async function chainOnAProver() {
    const db = await importDb();
    db.initDb(':memory:');
    const proverMod = await import('../../src/state/avl-prover.js');
    proverMod.createAvlProver();
    const system = await import('../../src/store/system.js');
    const genesis = await import('../../src/services/genesis-state.js');
    genesis.seedGenesisState();

    // Coinbase-only, for the reason stated on the fork-point-of-0 case: a post's
    // karma box can be seeded neither after the genesis bootstrap (the tree
    // never receives it) nor before it (it would land in the genesis tree and
    // move the pinned root).
    const bc = await importBlockCreator();
    const utxo = await importUtxo();
    bc.startBlockCreator(testConfig);
    for (let i = 0; i < 3; i++) {
      await mineNextBlock(bc);
    }

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(3);
    return {
      ordering,
      handle: proverMod.getAvlProver(),
      forkResolution: await importForkResolution(),
      root: (): string =>
        Buffer.from(proverMod.getAvlProver().prover.digest()!).toString('hex'),
    };
  }

  it('refuses the reorg and leaves our chain and our prover where they were', async () => {
    const { ordering, handle, forkResolution, root } = await chainOnAProver();
    const before = root();
    const hashes = [1, 2, 3].map((h) => blockHash(ordering.getOrderingBlock(h)!.header));

    // What `checkpointProver`'s pruning leaves behind when MAX_PROOF_HISTORY is
    // below MAX_REORG_DEPTH: the fork point is still an answer the walk can
    // give, and its version is gone.
    handle.storage.deleteVersionAtHeight(0);

    expect(() => forkResolution.reorg(0, []))
      .toThrow(/no AVL version at or before it/i);

    // The transaction rolled back and the in-memory prover went back with it,
    // so the node still holds a chain whose root it can compute.
    expect(ordering.getCurrentHeight()).toBe(3);
    for (const h of [1, 2, 3]) {
      expect(blockHash(ordering.getOrderingBlock(h)!.header)).toBe(hashes[h - 1]);
    }
    expect(root()).toBe(before);
  });

  it('names both numbers, because their relationship is the fault', async () => {
    const { handle, forkResolution } = await chainOnAProver();
    handle.storage.deleteVersionAtHeight(0);

    let message = '';
    try { forkResolution.reorg(0, []); } catch (err) { message = String(err); }
    expect(message).toMatch(/MAX_PROOF_HISTORY/);
    expect(message).toMatch(/MAX_REORG_DEPTH/);
  });

  it('control: the same reorg runs with the version in place', async () => {
    const { ordering, forkResolution } = await chainOnAProver();
    expect(() => forkResolution.reorg(0, [])).not.toThrow();
    expect(ordering.getCurrentHeight()).toBe(0);
  });
});
