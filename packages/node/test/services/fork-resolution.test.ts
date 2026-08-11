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
  PROTOCOL_VERSION,
  cumulativeWork,
  ReaderError,
} from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import type {
  Post,
  KarmaBox,
  OrderingBlock,
  UtxoTransaction,
  BlockHeader,
} from '@dagsocial/types';
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
  signHeader,
  solveHeaderPow,
} from '../helpers.js';

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
  postPowTargetBits: 20,
  challengeWindowBlocks: 10,
  orderingBlockIntervalMs: 60000,
  orderingBlockMinSubBlocks: 1,
  maxSubBlocksPerBlock: 1000,
  miningMode: 'internal' as const,
  orderingBlockPowTargetBits: 12,
  creditTreasuryPct: 10,
  treasuryPubKey: '',
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
  onSubBlockReceived: () => void;
  createOrderingBlock: () => OrderingBlock | null;
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

async function importIdentities() {
}

async function importPosts() {
  return (await import('../../src/store/posts.js')) as {
    insertPost: (post: Post, rawCbor: Uint8Array) => void;
    confirmPost: (postId: string, blockHeight: number) => void;
    getPost: (id: string) => Post | null;
  };
}

async function importMempoolFresh() {
  const mod = await import('../../src/store/mempool.js');
  return mod as {
    insertSubBlock: (
      postId: string,
      expiresAtHeight: number,
      batchId?: string | null,
    ) => number;
    insertUtxoTx: (
      tx: UtxoTransaction,
      batchId: string | null,
      expiresAtHeight: number,
    ) => number;
    getPendingEntries: (limit: number) => Array<{
      rowid: number;
      entryType: string;
      subblockId: string | null;
      utxoTxCbor: Uint8Array | null;
      batchId: string | null;
      expiresAtHeight: number;
      createdAt: string;
    }>;
    removeEntry: (rowid: number) => void;
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown) => void;
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
      dagService?: unknown,
    ) => Promise<void>;
    MAX_REORG_DEPTH: number;
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

describe('cumulativeWork', () => {
  it('returns 0 for empty headers array', () => {
    expect(cumulativeWork([])).toBe(0n);
  });

  it('returns equal work for two headers with same target bits', () => {
    const h1: BlockHeader = {
      protocolVersion: PROTOCOL_VERSION,
      height: 1,
      prevBlockHash: '00'.repeat(32),
      subBlockRoot: '00'.repeat(32),
      utxoTxRoot: '00'.repeat(32),
      stateRoot: '00'.repeat(33),
      validatorId: new Uint8Array(32),
      powNonce: 0,
      powTargetBits: 10,
      createdAt: 1000,
    };
    const h2: BlockHeader = {
      ...h1,
      height: 2,
      prevBlockHash: 'ff'.repeat(32),
      powTargetBits: 10,
    };
    expect(cumulativeWork([h1, h2])).toBe(2n * (1n << 10n));
  });

  it('doubles work per additional target bit', () => {
    const h1: BlockHeader = {
      protocolVersion: PROTOCOL_VERSION,
      height: 1,
      prevBlockHash: '00'.repeat(32),
      subBlockRoot: '00'.repeat(32),
      utxoTxRoot: '00'.repeat(32),
      stateRoot: '00'.repeat(33),
      validatorId: new Uint8Array(32),
      powNonce: 0,
      powTargetBits: 5,
      createdAt: 1000,
    };
    const h2: BlockHeader = {
      ...h1,
      height: 2,
      prevBlockHash: 'ff'.repeat(32),
      powTargetBits: 6, // 2^6 = 2 * 2^5
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
        subBlockRoot: '00'.repeat(32), utxoTxRoot: '00'.repeat(32), stateRoot: '00'.repeat(33),
        validatorId: new Uint8Array(32), powNonce: 0, powTargetBits: 5, createdAt: 1000,
      },
      {
        protocolVersion: PROTOCOL_VERSION, height: 2, prevBlockHash: 'ff'.repeat(32),
        subBlockRoot: '00'.repeat(32), utxoTxRoot: '00'.repeat(32), stateRoot: '00'.repeat(33),
        validatorId: new Uint8Array(32), powNonce: 0, powTargetBits: 5, createdAt: 2000,
      },
    ] as BlockHeader[];

    // Chain B: 1 block at 7 bits = 128
    const chainB = [
      {
        protocolVersion: PROTOCOL_VERSION, height: 1, prevBlockHash: '00'.repeat(32),
        subBlockRoot: '00'.repeat(32), utxoTxRoot: '00'.repeat(32), stateRoot: '00'.repeat(33),
        validatorId: new Uint8Array(32), powNonce: 0, powTargetBits: 7, createdAt: 1000,
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
    const ids = await importIdentities();

    const post = makePost(author.userId, 'genesis');
    const postId = computePostId(post);
    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    const mempool = await importMempoolFresh();
    mempool.insertSubBlock(postId, 1000);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const block1 = bc.createOrderingBlock();
    expect(block1).not.toBeNull();

    // Create a second block that chains from block 1
    const post2 = makePost(author.userId, 'block 2');
    const postId2 = computePostId(post2);
    posts.insertPost(post2, encodePost(post2));
    mempool.insertSubBlock(postId2, 1000);

    const block2 = bc.createOrderingBlock();
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
    const ids = await importIdentities();

    const post = makePost(author.userId, 'genesis');
    const postId = computePostId(post);
    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    const mempool = await importMempoolFresh();
    mempool.insertSubBlock(postId, 1000);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    bc.createOrderingBlock();

    // A candidate block with a random prevBlockHash
    const forkResolution = await importForkResolution();
    const candidate: OrderingBlock = {
      header: {
        protocolVersion: PROTOCOL_VERSION,
        height: 2,
        prevBlockHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        subBlockRoot: '00'.repeat(32),
        utxoTxRoot: '00'.repeat(32),
        stateRoot: '00'.repeat(33),
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: 4,
        createdAt: Date.now(),
      },
      subBlockTree: { subBlockEntries: [], pruneEntries: [] },
      utxoTxTree: { utxoTxIds: [], utxoTxs: [], coinbaseOutputs: [] },
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
        subBlockRoot: '00'.repeat(32),
        utxoTxRoot: '00'.repeat(32),
        stateRoot: '00'.repeat(33),
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: 4,
        createdAt: Date.now(),
      },
      subBlockTree: { subBlockEntries: [], pruneEntries: [] },
      utxoTxTree: { utxoTxIds: [], utxoTxs: [], coinbaseOutputs: [] },
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
    const ids = await importIdentities();

    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    // Build chain: block 1, block 2, block 3
    for (let i = 0; i < 3; i++) {
      const post = makePost(author.userId, `block ${i + 1}`);
      const postId = computePostId(post);
      posts.insertPost(post, encodePost(post));
      mempool.insertSubBlock(postId, 1000);
      bc.createOrderingBlock();
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
      subBlockRoot: 'ff'.repeat(32), // different content
      utxoTxRoot: 'ff'.repeat(32),
      stateRoot: 'ff'.repeat(33),
      validatorId: new Uint8Array(32),
      powNonce: 999,
      powTargetBits: 4,
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

  it('returns null when no common ancestor found', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();

    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    // Build chain: block 1 only
    const post = makePost(author.userId, 'genesis');
    const postId = computePostId(post);
    posts.insertPost(post, encodePost(post));
    mempool.insertSubBlock(postId, 1000);
    bc.createOrderingBlock();

    const ordering = await importOrdering();
    const ourTip = ordering.getOrderingBlock(1);
    expect(ourTip).not.toBeNull();

    // Their headers: completely different chain with no overlap
    const theirHeaders: BlockHeader[] = [
      {
        protocolVersion: PROTOCOL_VERSION,
        height: 5,
        prevBlockHash: 'ab'.repeat(32),
        subBlockRoot: '00'.repeat(32),
        utxoTxRoot: '00'.repeat(32),
        stateRoot: '00'.repeat(33),
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: 4,
        createdAt: Date.now(),
      },
    ];

    const forkResolution = await importForkResolution();
    const forkPoint = forkResolution.findForkPoint(ourTip!.header, theirHeaders);
    expect(forkPoint).toBeNull();
  });

  it('returns null when depth exceeds MAX_REORG_DEPTH', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const forkResolution = await importForkResolution();

    // Build a deep chain (more than MAX_REORG_DEPTH) via block-creator
    const author = makeTestIdentity();
    const ids = await importIdentities();

    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    const MAX_DEPTH = forkResolution.MAX_REORG_DEPTH;
    const chainLength = MAX_DEPTH + 5;

    for (let i = 0; i < chainLength; i++) {
      const post = makePost(author.userId, `deep ${i}`);
      const postId = computePostId(post);
      posts.insertPost(post, encodePost(post));
      mempool.insertSubBlock(postId, 1000);
      bc.createOrderingBlock();
    }

    const ordering = await importOrdering();
    const ourTip = ordering.getOrderingBlock(chainLength);
    expect(ourTip).not.toBeNull();

    // Their headers reference a block at height chainLength - MAX_DEPTH - 1
    // which is beyond MAX_REORG_DEPTH from our tip
    const deepBlock = ordering.getOrderingBlock(chainLength - MAX_DEPTH - 1);
    expect(deepBlock).not.toBeNull();

    const theirHeaders: BlockHeader[] = [
      {
        protocolVersion: PROTOCOL_VERSION,
        height: chainLength - MAX_DEPTH - 1 + 3,
        prevBlockHash: blockHash(deepBlock!.header)!,
        subBlockRoot: '00'.repeat(32),
        utxoTxRoot: '00'.repeat(32),
        stateRoot: '00'.repeat(33),
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: 4,
        createdAt: Date.now(),
      },
      deepBlock!.header,
    ];

    const forkPoint = forkResolution.findForkPoint(ourTip!.header, theirHeaders);
    // The common ancestor (deepBlock) is beyond MAX_REORG_DEPTH from our tip
    expect(forkPoint).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Phase 1f-2 — a peer header batch is accepted or refused whole.
  //
  // `theirHeaders` reaches this function as `decode(response) as BlockHeader[]`
  // (net's `requestHeaders`): a raw cbor decode with a TypeScript cast and no
  // runtime check, so every field in it is the peer's to choose. These two pin
  // the answer to the question `blockHash` now forces — what an
  // unhashable entry means — because the plausible alternative, skipping it and
  // carrying on, hands the peer the fork depth.
  // -------------------------------------------------------------------------

  /** A three-block chain and the pieces every batch below is built from. */
  async function threeBlockChain() {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    await importIdentities();
    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    for (let i = 0; i < 3; i++) {
      const post = makePost(author.userId, `batch block ${i + 1}`);
      const postId = computePostId(post);
      posts.insertPost(post, encodePost(post));
      mempool.insertSubBlock(postId, 1000);
      bc.createOrderingBlock();
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
      subBlockRoot: 'ff'.repeat(32),
      utxoTxRoot: 'ff'.repeat(32),
      stateRoot: 'ff'.repeat(33),
      validatorId: new Uint8Array(32),
      powNonce: 999,
      powTargetBits: 4,
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
    // checks, so `createdAt` is the only thing wrong with it.
    const buildBlock = (height: number, createdAt: number): OrderingBlock => ({
      header: {
        protocolVersion: PROTOCOL_VERSION,
        height,
        prevBlockHash: '00'.repeat(32),
        subBlockRoot: '00'.repeat(32),
        utxoTxRoot: '00'.repeat(32),
        stateRoot: '00'.repeat(33),
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: 4,
        createdAt,
      },
      subBlockTree: { subBlockEntries: [], pruneEntries: [] },
      utxoTxTree: { utxoTxIds: [], utxoTxs: [], coinbaseOutputs: [] },
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
    // always hashable**, and `blockHash` can no longer answer `null` on this
    // path at all. The decode boundary subsumes the domain check, which is the
    // "serializer is the validator" property arriving for the header.
    //
    // Reported to main: that makes `UnhashableStoredHeaderError` unreachable
    // from the store, i.e. dead in `src`. Removing it is node's call and needs
    // its own enumeration, so it stays and these tests pin what happens now.
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

  it('every stored header that decodes is inside the domain — so blockHash cannot be null', async () => {
    // The claim the four typed-error tests used to rest on, inverted. It is not
    // an assertion about these values: it is that the reader's *range* is a
    // subset of the domain, so no round-trip can produce a header the domain
    // rejects. Checked over the widest values each writer admits.
    const db = await importDb();
    db.initDb(':memory:');
    const ordering = await importOrdering();
    const { verifyHeaderFieldDomains } = await import('@dagsocial/validation');

    const extremes: OrderingBlock = {
      header: {
        protocolVersion: PROTOCOL_VERSION,
        height: 1,
        prevBlockHash: 'ff'.repeat(32),
        subBlockRoot: '00'.repeat(32),
        utxoTxRoot: 'a0'.repeat(32),
        stateRoot: 'ff'.repeat(33),
        validatorId: new Uint8Array(32).fill(0xff),
        powNonce: Number.MAX_SAFE_INTEGER,
        powTargetBits: 0,
        createdAt: Number.MAX_SAFE_INTEGER,
      },
      subBlockTree: { subBlockEntries: [], pruneEntries: [] },
      utxoTxTree: { utxoTxIds: [], utxoTxs: [], coinbaseOutputs: [] },
      validatorSignature: new Uint8Array(64),
    };
    ordering.createOrderingBlock(extremes);

    const readBack = ordering.getOrderingBlock(1)!;
    expect(verifyHeaderFieldDomains(readBack.header)).toEqual({ valid: true });
    expect(blockHash(readBack.header)).not.toBeNull();
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
  // read throws before `blockHash` is ever reached. For one commit that arrived
  // as a bare `ReaderError`, which is **not** in the funnel's re-throw
  // allowlist: the totality catch absorbed it into `return false`, `reorg`
  // reported its generic "block at height N rejected", and `index.ts` logged
  // that as `Fork resolution error` and carried on. The two cases below pinned
  // that, deliberately asserting the wrong behaviour so it stayed visible; they
  // are inverted now that the door is watched again.
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

  /** Three contiguous, well-formed stored blocks. */
  async function storeThreeBlocks() {
    const db = await importDb();
    db.initDb(':memory:');
    const ordering = await importOrdering();

    const build = (height: number): OrderingBlock => ({
      header: {
        protocolVersion: PROTOCOL_VERSION,
        height,
        prevBlockHash: '00'.repeat(32),
        subBlockRoot: '00'.repeat(32),
        utxoTxRoot: '00'.repeat(32),
        stateRoot: '00'.repeat(33),
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: 4,
        createdAt: 1,
      },
      subBlockTree: { subBlockEntries: [], pruneEntries: [] },
      utxoTxTree: { utxoTxIds: [], utxoTxs: [], coinbaseOutputs: [] },
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
    // off the bottom at height 0 and returns an ordinary answer. Terminating on
    // a missing block is normal *there* and only there.
    expect(forkResolution.findForkPoint(tip, [])).toBeNull();
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
    bc.createOrderingBlock(); // genesis with coinbase

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
    const ids = await importIdentities();

    const post = makePost(author.userId, 'unconfirm me');
    const postId = computePostId(post);
    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    const mempool = await importMempoolFresh();
    mempool.insertSubBlock(postId, 1000);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const block = bc.createOrderingBlock();
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

    const ids = await importIdentities();
    const posts = await importPosts();
    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();

    const author = makeTestIdentity();

    const post = makePost(author.userId, 'utxo revert test');
    const postId = computePostId(post);
    const { encodePost } = await import('@dagsocial/types');
    posts.insertPost(post, encodePost(post));

    // Insert sub-block
    mempool.insertSubBlock(postId, 1000);

    // Insert a standalone UTXO tx. The like targets the post this block
    // confirms — N2b rejects likes on unconfirmed targets, and topology
    // (§8b) precedes the tx loop (§11). Self-like is legal by contract.
    const karmaBox = makeKarmaBox(100n, author.userId, 0);
    utxo.insertBox(karmaBox);
    const likeTx = makeLikeTx(author, karmaBox, postId);
    mempool.insertUtxoTx(likeTx, null, 1000);

    bc.startBlockCreator(testConfig);
    bc.createOrderingBlock();

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

    // Every box the block created is gone; every box it consumed is live again
    for (const boxId of insertedIds) {
      expect(utxo.getBox(boxId)).toBeNull();
    }
    for (const boxId of removedIds) {
      expect(utxo.getBox(boxId)).not.toBeNull();
    }

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
    bc.createOrderingBlock();

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
    const ids = await importIdentities();

    // Create identity with a karma box at block 0 (ancient)
    const identity = makeTestIdentity();
    const oldBox = makeKarmaBox(100n, identity.userId, 0);
    utxo.insertBox(oldBox);
    const oldBoxId = oldBox.id!;

    // Apply decay manually (simulates what block application does)
    const { applyKarmaDecay } = await import(
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

    const entries = applyKarmaDecay(
      deps,
      KARMA_STALE_THRESHOLD_BLOCKS + 100,
      decayCfg,
    );

    expect(entries.length).toBe(1);
    const newBoxId = entries[0]!.newBoxId;

    // Verify old box consumed (not returned by getKarmaBox which filters spent)
    const afterDecayBox = utxo.getKarmaBox(identity.userId);
    expect(afterDecayBox).not.toBeNull();
    expect(afterDecayBox!.id).toBe(newBoxId); // only unspent box is the new one

    // Reverse: delete new box, unconsume old boxes
    // (same logic as revertBlock step 2b in fork-resolution.ts)
    const { deleteBox, unconsumeBox } = await import(
      '../../src/store/utxo.js'
    );
    for (const entry of entries) {
      deleteBox(entry.newBoxId);
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
    const ids = await importIdentities();

    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    // Build 3 blocks
    for (let i = 0; i < 3; i++) {
      const post = makePost(author.userId, `reorg test ${i}`);
      const postId = computePostId(post);
      posts.insertPost(post, encodePost(post));
      mempool.insertSubBlock(postId, 1000);
      bc.createOrderingBlock();
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

  it('reorg then rebuild: state matches new chain', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const ids = await importIdentities();

    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    // Build 2 blocks
    for (let i = 0; i < 2; i++) {
      const post = makePost(author.userId, `chain a ${i}`);
      const postId = computePostId(post);
      posts.insertPost(post, encodePost(post));
      mempool.insertSubBlock(postId, 1000);
      bc.createOrderingBlock();
    }

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(2);

    // Roll back to height 0
    const forkResolution = await importForkResolution();
    forkResolution.reorg(0, []);

    expect(ordering.getCurrentHeight()).toBe(0);

    // Rebuild: new chain from mempool entries (re-inserted by reorg)
    // The block creator will pick up re-inserted sub-blocks
    bc.createOrderingBlock(); // height 1
    bc.createOrderingBlock(); // height 2

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
    const ids = await importIdentities();

    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    // Build 3 blocks
    for (let i = 0; i < 3; i++) {
      const post = makePost(author.userId, `original ${i}`);
      const postId = computePostId(post);
      posts.insertPost(post, encodePost(post));
      mempool.insertSubBlock(postId, 1000);
      bc.createOrderingBlock();
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
      await importIdentities();

      const { encodePost } = await import('@dagsocial/types');
      const posts = await importPosts();
      const mempool = await importMempoolFresh();
      const bc = await importBlockCreator();
      bc.startBlockCreator(testConfig);

      // Two blocks, one sub-block each. Each insert sits alone in the pool
      // (cap 1) and is consumed by its block, so building the chain is fine.
      for (let i = 0; i < 2; i++) {
        const post = makePost(author.userId, `full pool ${i}`);
        const postId = computePostId(post);
        posts.insertPost(post, encodePost(post));
        mempool.insertSubBlock(postId, 1000);
        bc.createOrderingBlock();
      }

      const ordering = await importOrdering();
      expect(ordering.getCurrentHeight()).toBe(2);
      expect(mempool.getPendingEntries(100)).toHaveLength(0);

      // Fill the pool to its cap, so every re-insertion below is rejected.
      mempool.insertSubBlock('occupier', 1000);
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
    await importIdentities();

    const { encodePost } = await import('@dagsocial/types');
    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    for (let i = 0; i < 2; i++) {
      const post = makePost(author.userId, `room in pool ${i}`);
      const postId = computePostId(post);
      posts.insertPost(post, encodePost(post));
      mempool.insertSubBlock(postId, 1000);
      bc.createOrderingBlock();
    }

    mempool.insertSubBlock('occupier', 1000);

    const forkResolution = await importForkResolution();
    forkResolution.reorg(0, []);

    // Default cap (10000): the reverted sub-blocks come back.
    expect(mempool.getPendingEntries(100).length).toBeGreaterThan(1);
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
    // instance tryGetAvlProver() hands to block-apply and reorg().
    const { createAvlProver, tryGetAvlProver } = (await import(
      '../../src/state/avl-prover.js'
    )) as typeof import('../../src/state/avl-prover.js');
    createAvlProver();

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
    bc.createOrderingBlock();
    const goodB2 = await makeApplicableBlock({ height: 2 });
    bc.createOrderingBlock();
    bc.createOrderingBlock();

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
  bc.createOrderingBlock();

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
  bc.createOrderingBlock();
  bc.createOrderingBlock();
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

/** A peer that answers the header request honestly and the block request with `answer`. */
function stubNet(theirHeaders: BlockHeader[], answer: OrderingBlock[]): ForkResolutionNet & {
  blockRequests: Array<{ startHeight: number; endHeight: number }>;
} {
  const blockRequests: Array<{ startHeight: number; endHeight: number }> = [];
  return {
    blockRequests,
    peers: () => [{ id: 'peer-withholding' }],
    requestHeaders: async () => theirHeaders,
    requestBlocks: async (startHeight: number, endHeight: number) => {
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
    await forkResolution.resolveFork(scenario.competingBlock, net);

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
    );

    expect(ordering.getCurrentHeight()).toBe(4);
    // Height 1 is the shared fork point; 2..4 are now the peer's blocks.
    expect(blockHash(ordering.getOrderingBlock(1)!.header)).toBe(scenario.ourHashes[0]);
    for (const [i, block] of scenario.theirBlocks.entries()) {
      expect(blockHash(ordering.getOrderingBlock(i + 2)!.header)).toBe(blockHash(block.header));
    }
  });
});
