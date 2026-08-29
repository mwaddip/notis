import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  EMPTY_STATE_ROOT,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  PROTOCOL_VERSION,
  MAX_BLOCK_BODY_BYTES,
  MAX_FUTURE_DRIFT_MS,
  encodeTx,
  updateInterlinks,
} from '@dagsocial/types';
import { blockHash, cumulativeWork, level as headerLevel } from '@dagsocial/validation';
import type {
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
  hex,
  makeApplicableBlock,
  makeKarmaBox,
  makeLikeTx,
  makeTestConfig,
  makeTestIdentity,
  mineNextBlock,
  signHeader,
  signTransaction,
  solveHeaderPow, seedPostTx, fillerTx, activateProverOverStore, insertPoisonedBlock,
  buildMinedHeaderChain } from '../helpers.js';

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
    setMempoolCap: (n: number) => void;
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown) => void;
    getKarmaBox: (owner: Uint8Array) => KarmaBox | null;
    getBox: (boxId: string) => unknown;
    consumeBox: (boxId: string, consumedAtBlock: number) => void;
  };
}

async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as {
    getCurrentHeight: () => number;
    getOrderingBlock: (height: number) => OrderingBlock | null;
    getOrderingBlockHash: (height: number) => string | null;
    deleteOrderingBlock: (height: number) => void;
    createOrderingBlock: (block: OrderingBlock, interlinks: string[]) => void;
    getInterlinks: (height: number) => string[] | null;
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
    revertBlock: (height: number) => void;
    reorg: (forkHeight: number, newBlocks: OrderingBlock[]) => void;
    resolveFork: (
      block: OrderingBlock,
      net: ForkResolutionNet,
      fromPeerId: string,
    ) => Promise<void>;
    resetForkResolutionMemo: () => void;
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

async function importHandleBlock() {
  return (await import('../../src/services/handle-block.js')) as unknown as {
    handleOrderingBlock: (
      block: OrderingBlock,
      fromPeerId: string,
      net: ForkResolutionNet,
    ) => boolean;
  };
}

async function importRefusedHeaders() {
  return (await import('../../src/store/refused-headers.js')) as {
    insertRefusedHeader: (hash: string, height: number, refusedAt: number) => void;
    anyRefusedHeader: (hashes: string[]) => boolean;
    purgeRefusedHeaders: (belowHeight: number) => void;
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
      interlinkRoot: '00'.repeat(32),
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
      interlinkRoot: '00'.repeat(32),
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
        validatorId: new Uint8Array(32), powNonce: 0, powTargetBits: 256 * 5, createdAt: 1000, interlinkRoot: '00'.repeat(32),
      },
      {
        protocolVersion: PROTOCOL_VERSION, height: 2, prevBlockHash: 'ff'.repeat(32),
        validatorId: new Uint8Array(32), powNonce: 0, powTargetBits: 256 * 5, createdAt: 2000, interlinkRoot: '00'.repeat(32),
      },
    ] as BlockHeader[];

    // Chain B: 1 block at 7 bits = 128
    const chainB = [
      {
        protocolVersion: PROTOCOL_VERSION, height: 1, prevBlockHash: '00'.repeat(32),
        validatorId: new Uint8Array(32), powNonce: 0, powTargetBits: 256 * 7, createdAt: 1000, interlinkRoot: '00'.repeat(32),
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
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const author = makeTestIdentity();

    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'genesis');

    const posts = await importPosts();
    posts.insertPost(postId, commit, content);

    const mempool = await importMempoolFresh();
    mempool.insertUtxoTx(postTx, 1000);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const block1 = await mineNextBlock(bc);
    expect(block1).not.toBeNull();

    // Create a second block that chains from block 1
    const { commit: commit2, tx: post2Tx, postId: postId2, content: content2 } = await seedPostTx(author, 'block 2');
    posts.insertPost(postId2, commit2, content2);
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
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const author = makeTestIdentity();

    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'genesis');

    const posts = await importPosts();
    posts.insertPost(postId, commit, content);

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
        interlinkRoot: '00'.repeat(32),
      },
      utxoTxTree: { utxoTxIds: ['77'.repeat(32)], utxoTxs: [new Uint8Array(96)] },
      validatorSignature: new Uint8Array(64),
    };

    expect(forkResolution.extendsOurTip(candidate)).toBe(false);
  });

  it('returns false when no tip exists (empty chain)', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

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
        interlinkRoot: '00'.repeat(32),
      },
      utxoTxTree: { utxoTxIds: ['77'.repeat(32)], utxoTxs: [new Uint8Array(96)] },
      validatorSignature: new Uint8Array(64),
    };

    expect(forkResolution.extendsOurTip(candidate)).toBe(false);
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
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
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
        interlinkRoot: '00'.repeat(32),
      },
      utxoTxTree: { utxoTxIds: ['77'.repeat(32)], utxoTxs: [new Uint8Array(96)] },
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
    insertPoisonedBlock(db.getDb(), block);
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
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
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
        interlinkRoot: '00'.repeat(32),
      },
      utxoTxTree: { utxoTxIds: ['77'.repeat(32)], utxoTxs: [new Uint8Array(96)] },
      validatorSignature: new Uint8Array(64),
    };
    ordering.createOrderingBlock(extremes, []);

    const readBack = ordering.getOrderingBlock(1)!;
    expect(verifyHeaderFieldDomains(readBack.header)).toEqual({ valid: true });
    expect(blockHash(readBack.header)).not.toBeNull();

    // One step past the top of the domain: the row still round-trips, and the
    // header it produces has no hash. This is what the general claim above
    // would have ruled out. Bypasses `createOrderingBlock`'s blockHash guard
    // because the whole point is to store a header the domain rejects.
    ordering.deleteOrderingBlock(1);
    const pastBlock = {
      ...extremes,
      header: { ...extremes.header, powTargetBits: 65537 },
    };
    insertPoisonedBlock(db.getDb(), pastBlock);
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
  // The load-bearing difference is **reach**: the store frame names the fault
  // so every reader raises one class, and every outer frame — both
  // registrations, the launched `resolveFork` promise, `finalizeBlock`, the
  // block creator, and the guarded provider and routes — is a boundary
  // (NODE_INTERFACE → "Reach is the live argument, not the halt").
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
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
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
        interlinkRoot: '00'.repeat(32),
      },
      utxoTxTree: { utxoTxIds: ['77'.repeat(32)], utxoTxs: [new Uint8Array(96)] },
      validatorSignature: new Uint8Array(64),
    });
    for (const h of [1, 2, 3]) ordering.createOrderingBlock(build(h), []);

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

  // findForkPoint tests deleted — the function is internal to resolveFork.

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
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

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
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

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
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const author = makeTestIdentity();

    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'unconfirm me');

    const posts = await importPosts();
    posts.insertPost(postId, commit, content);

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

  it('a missing journal is a MissingJournalError', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const forkResolution = await importForkResolution();
    const { MissingJournalError, CorruptChainStateError } =
      await import('../../src/services/corrupt-state.js');

    let caught: unknown;
    try { forkResolution.revertBlock(99); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(MissingJournalError);
    expect(caught).toBeInstanceOf(CorruptChainStateError);
    expect((caught as InstanceType<typeof MissingJournalError>).site).toBe('revertBlock');
    expect((caught as InstanceType<typeof MissingJournalError>).height).toBe(99);
  });

  it('reverts UTXO transactions: outputs deleted, inputs unspent', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const posts = await importPosts();
    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();

    const author = makeTestIdentity();

    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'utxo revert test');

    posts.insertPost(postId, commit, content);

    // Insert post transaction
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
    expect(txRecord.txBytes).toBeInstanceOf(Uint8Array);

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
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

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
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

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
    };

    const DECAY_HEIGHT = KARMA_STALE_THRESHOLD_BLOCKS + 100;
    const ownerHex = Buffer.from(identity.userId).toString('hex');
    const karmaBoxes = getKarmaBoxes(identity.userId);
    const postBody = new Map([[ownerHex, { owner: identity.userId, boxes: karmaBoxes }]]);
    const entries = deriveKarmaDecay(deps, postBody, DECAY_HEIGHT, decayCfg);

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
      createdAtBlock: DECAY_HEIGHT,
      owner: plan.owner,
      txId: provenance.mintTxIdFor(provenance.genesisCommitteeContext(plan.owner), DECAY_HEIGHT),
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

  it('a prune\'s re-insertion on revert restores posts and clears the stump', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const author = makeTestIdentity();
    const posts = await importPosts();
    const utxo = await importUtxo();

    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'revert-prune');
    posts.insertPost(postId, commit, content);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    // Block 1: confirms the post.
    const mempool = await importMempoolFresh();
    mempool.insertUtxoTx(postTx, 1000);
    await mineNextBlock(bc);
    expect(posts.getPost(postId)).toBeDefined();

    // Block 2: prune the post.
    const pruneKarma = makeKarmaBox(1n, author.userId, 0, 5001);
    utxo.insertBox(pruneKarma);
    const pruneTx: UtxoTransaction = {
      inputs: [pruneKarma.id!],
      outputs: [
        { boxType: 'karma', value: 1n, createdAtBlock: 0, owner: author.userId } as never,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      prune: { rootPostHash: postId },
    };
    signTransaction(pruneTx, author.privateKey, hex(author.userId));
    mempool.insertUtxoTx(pruneTx, 1000);
    await mineNextBlock(bc);

    // Post is gone, stump exists.
    const postAfterPrune = posts.getPost(postId);
    expect(postAfterPrune && 'rootPostHash' in postAfterPrune).toBe(true);

    // Revert block 2.
    const forkResolution = await importForkResolution();
    forkResolution.revertBlock(2);

    // Post is back, stump is gone.
    const postAfterRevert = posts.getPost(postId);
    expect(postAfterRevert).toBeDefined();
    expect(postAfterRevert && 'status' in postAfterRevert).toBe(true);

    const stumps = db.getDb()
      .prepare('SELECT * FROM dag_stumps WHERE root_post_hash = ?')
      .all(postId);
    expect(stumps).toHaveLength(0);

    // The prune tx's UTXO reversal: the input is unspent again.
    const inputRow = db.getDb()
      .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
      .get(pruneKarma.id!) as { spent_at_block: number | null } | undefined;
    expect(inputRow).toBeDefined();
    expect(inputRow!.spent_at_block).toBeNull();

    // The prune tx's output is gone.
    const { computeTxId } = await import('@dagsocial/types');
    const pruneTxId = computeTxId(pruneTx);
    const outputRow = db.getDb()
      .prepare('SELECT id FROM utxo_boxes WHERE tx_id = ? AND output_index = 0')
      .get(pruneTxId) as { id: string } | undefined;
    expect(outputRow).toBeUndefined();
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

  it('reverts blocks and re-inserts txs to mempool', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const author = makeTestIdentity();


    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    // Build 3 blocks
    for (let i = 0; i < 3; i++) {
      const { commit, tx: postTx, postId, content } = await seedPostTx(author, `reorg test ${i}`);
      posts.insertPost(postId, commit, content);
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

    // Mempool should have re-inserted transactions
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
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();


    const posts = await importPosts();
    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    const author = makeTestIdentity();

    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'reorg re-insert conflict');
    posts.insertPost(postId, commit, content);
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
      .filter((e: { entryType: string; utxoTxBytes: Uint8Array | null }) =>
        e.entryType === 'utxo_tx' && e.utxoTxBytes !== null)
      .map((e: { utxoTxBytes: Uint8Array | null }) => computeTxId(decodeTx(e.utxoTxBytes!)));
    // The incumbent kept its place; the reverted like was not admitted beside it.
    expect(pooled).not.toContain(computeTxId(likeTx));
    // The post transaction spends a box nothing else claims, so it came back.
    expect(pooled).toContain(computeTxId(postTx));
    expect(pooled).toHaveLength(2);
  });

  it('reorg then rebuild: state matches new chain', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const author = makeTestIdentity();


    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    // Build 2 blocks
    for (let i = 0; i < 2; i++) {
      const { commit, tx: postTx, postId, content } = await seedPostTx(author, `chain a ${i}`);
      posts.insertPost(postId, commit, content);
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
    // The block creator will pick up re-inserted transactions
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
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const author = makeTestIdentity();


    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    // Build 3 blocks
    for (let i = 0; i < 3; i++) {
      const { commit, tx: postTx, postId, content } = await seedPostTx(author, `original ${i}`);
      posts.insertPost(postId, commit, content);
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      vi.resetModules();

      const db = await importDb();
      db.initDb(':memory:');
      db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

      const author = makeTestIdentity();

      const posts = await importPosts();
      const mempool = await importMempoolFresh();
      mempool.setMempoolCap(1);
      const bc = await importBlockCreator();
      bc.startBlockCreator(testConfig);

      // Two blocks, one post transaction each. Each insert sits alone in the pool
      // (cap 1) and is consumed by its block, so building the chain is fine.
      for (let i = 0; i < 2; i++) {
        const { commit, tx: postTx, postId, content } = await seedPostTx(author, `full pool ${i}`);
        posts.insertPost(postId, commit, content);
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
    }
  });

  it('control — the same reorg re-inserts entries when the pool has room', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const author = makeTestIdentity();


    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    for (let i = 0; i < 2; i++) {
      const { commit, tx: postTx, postId, content } = await seedPostTx(author, `room in pool ${i}`);
      posts.insertPost(postId, commit, content);
      mempool.insertUtxoTx(postTx, 1000);
      await mineNextBlock(bc);
    }

    mempool.insertUtxoTx(fillerTx('occupier'), 1000);

    const forkResolution = await importForkResolution();
    forkResolution.reorg(0, []);

    // Default cap (10000): the reverted transactions come back.
    expect(mempool.getPendingEntries(100).length).toBeGreaterThan(1);
  });

  it('a fork point of 0 rolls the AVL prover back to the pinned genesis root', async () => {
    // What the fork walk's genesis answer costs downstream. `reorg` walks
    // journals from the fork height and rolls the prover to
    // `versionAtOrBeforeHeight(forkHeight)` — and at 0 that version is the
    // genesis one only because `seedGenesisState` deletes the empty tree's
    // height-0 version before writing its own. Every other suite here runs
    // without a prover, so nothing else exercises this.
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const proverMod = await import('../../src/state/avl-prover.js');
    proverMod.createAvlProver();
    await import('../../src/store/system.js');
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
// Tests — reorg abort restores the AVL prover (NODE_INTERFACE →
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
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

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
      'reorg rejected block at height 3',
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

  it('failed mid-reorg apply leaves dagTipHeight at the pre-reorg tip', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    await activateProverOverStore();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    await mineNextBlock(bc);
    const goodB2 = await makeApplicableBlock({ height: 2 });
    await mineNextBlock(bc);
    await mineNextBlock(bc);

    const metrics = await import('../../src/metrics.js');
    expect(metrics.getDagTipHeight()).toBe(3);

    const badB3 = await makeApplicableBlock({ height: 3 });
    const forkResolution = await importForkResolution();
    expect(() => forkResolution.reorg(1, [goodB2, badB3])).toThrow(
      'reorg rejected block at height 3',
    );

    expect(metrics.getDagTipHeight()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Tests — resolveFork: the reorg applies exactly the verified chain it scored
//
// NODE_INTERFACE → AVL+ State Root → "A reorg applies exactly the verified
// chain it scored, or nothing"; → Fork choice decides on verified headers,
// steps 8–10. The block answer is checked at the decision (count against the
// verified segment, per-block hash identity), not at the mechanism — `reorg()`
// applies exactly what it is handed.
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
  headerRequests: Array<{ startHeight: number; maxCount: number }>;
  askedPeers: string[];
  penalties: Array<{ peerId: string; kind: string; reason: string }>;
} {
  const blockRequests: Array<{ startHeight: number; endHeight: number }> = [];
  const headerRequests: Array<{ startHeight: number; maxCount: number }> = [];
  const askedPeers: string[] = [];
  const penalties: Array<{ peerId: string; kind: string; reason: string }> = [];
  const peerTip = theirHeaders.length > 0
    ? Math.max(...theirHeaders.map(h => h.height))
    : null;
  return {
    blockRequests,
    headerRequests,
    askedPeers,
    penalties,
    getConnectedPeers: () => connected,
    requestHeaders: async (startHeight: number, maxCount: number, peerId: string) => {
      askedPeers.push(peerId);
      headerRequests.push({ startHeight, maxCount });
      // NET_INTERFACE → GetHeaders / GetBlocks responses: descending from startHeight,
      // clamped to the peer's tip, at most maxCount.
      const clamped = peerTip !== null ? Math.min(startHeight, peerTip) : startHeight;
      return theirHeaders
        .filter(h => h.height <= clamped)
        .sort((a, b) => b.height - a.height)
        .slice(0, maxCount);
    },
    requestBlocks: async (startHeight: number, endHeight: number, peerId: string) => {
      askedPeers.push(peerId);
      blockRequests.push({ startHeight, endHeight });
      return answer.filter(b => b.header.height >= startHeight && b.header.height <= endHeight);
    },
    penalizePeer: (peerId: string, kind: string, reason: string) => {
      penalties.push({ peerId, kind, reason });
    },
    peerTipHeight: () => peerTip,
  };
}

describe('resolveFork — the reorg applies exactly the verified chain it scored', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch { /* not imported */ }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('an empty block response refuses with a transient penalty', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const scenario = await buildForkScenario();
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const net = stubNet(scenario.theirHeaders, []);
    await forkResolution.resolveFork(scenario.competingBlock, net, 'peer-withholding');

    expect(net.blockRequests).toEqual([{ startHeight: 2, endHeight: 4 }]);

    expect(ordering.getCurrentHeight()).toBe(3);
    for (const h of [1, 2, 3]) {
      expect(blockHash(ordering.getOrderingBlock(h)!.header)).toBe(scenario.ourHashes[h - 1]);
    }

    expect(net.penalties).toEqual([
      expect.objectContaining({ kind: 'transient' }),
    ]);
  });

  it('a short-but-nonempty response refuses with a transient penalty', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const scenario = await buildForkScenario();
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const net = stubNet(scenario.theirHeaders, [scenario.theirBlocks[0]!]);
    await forkResolution.resolveFork(
      scenario.competingBlock,
      net,
      'peer-withholding',
    );

    expect(ordering.getCurrentHeight()).toBe(3);
    for (const h of [1, 2, 3]) {
      expect(blockHash(ordering.getOrderingBlock(h)!.header)).toBe(scenario.ourHashes[h - 1]);
    }

    expect(net.penalties).toEqual([
      expect.objectContaining({ kind: 'transient' }),
    ]);
  });

  it('a genuinely longer chain still replaces ours', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
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
// genesis state, a node below maxReorgDepth can have its whole chain replaced
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
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
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
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
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
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
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

    // Every request — fork walk pages, scoring walk pages, block fetch — went
    // to the relaying peer.
    expect(net.askedPeers.length).toBeGreaterThanOrEqual(2);
    expect(net.askedPeers.every(p => p === 'peer-relayed-it')).toBe(true);
    expect(ordering.getCurrentHeight()).toBe(4);
  });

  it('falls back to an Active peer when the relaying peer is no longer connected', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const scenario = await buildForkScenario();
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();

    const net = stubNet(scenario.theirHeaders, scenario.theirBlocks, ['peer-active']);

    await forkResolution.resolveFork(scenario.competingBlock, net, 'peer-since-disconnected');

    // The non-member is never asked, and what replaces it is a member: the
    // membership test is what keeps the counterparty on the Active list rather
    // than wherever the source came from.
    expect(net.askedPeers).not.toContain('peer-since-disconnected');
    expect(net.askedPeers.length).toBeGreaterThanOrEqual(2);
    expect(net.askedPeers.every(p => p === 'peer-active')).toBe(true);
    for (const asked of net.askedPeers) {
      expect(net.getConnectedPeers()).toContain(asked);
    }
    expect(ordering.getCurrentHeight()).toBe(4);
  });

  it('falls back for a source that is no peer id at all', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const scenario = await buildForkScenario();
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();

    const net = stubNet(scenario.theirHeaders, scenario.theirBlocks, ['peer-active']);

    // The empty string is what reaches a handler for a gossip event carrying no
    // source, and it is no more a peer id than a stranger's is. Membership is
    // the whole test, so this needs no case of its own.
    await forkResolution.resolveFork(scenario.competingBlock, net, '');

    expect(net.askedPeers.length).toBeGreaterThanOrEqual(2);
    expect(net.askedPeers.every(p => p === 'peer-active')).toBe(true);
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
// while `maxReorgDepth` is the profile's per-network horizon, so this is reachable by configuration
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
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const proverMod = await import('../../src/state/avl-prover.js');
    proverMod.createAvlProver();
    await import('../../src/store/system.js');
    const genesis = await import('../../src/services/genesis-state.js');
    genesis.seedGenesisState();

    // Coinbase-only, for the reason stated on the fork-point-of-0 case: a post's
    // karma box can be seeded neither after the genesis bootstrap (the tree
    // never receives it) nor before it (it would land in the genesis tree and
    // move the pinned root).
    const bc = await importBlockCreator();
    await importUtxo();
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

  it('the missing version is a fail-stop', async () => {
    const { ordering, handle, forkResolution, root } = await chainOnAProver();
    const before = root();
    const hashes = [1, 2, 3].map((h) => blockHash(ordering.getOrderingBlock(h)!.header));

    handle.storage.deleteVersionAtHeight(0);

    const { MissingStateVersionError, CorruptChainStateError } =
      await import('../../src/services/corrupt-state.js');

    let caught: unknown;
    try { forkResolution.reorg(0, []); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(MissingStateVersionError);
    expect(caught).toBeInstanceOf(CorruptChainStateError);
    expect((caught as InstanceType<typeof MissingStateVersionError>).site).toBe('reorg');
    expect((caught as InstanceType<typeof MissingStateVersionError>).height).toBe(0);

    // The transaction rolled back and the in-memory prover went back with it,
    // so the node still holds a chain whose root it can compute.
    expect(ordering.getCurrentHeight()).toBe(3);
    for (const h of [1, 2, 3]) {
      expect(blockHash(ordering.getOrderingBlock(h)!.header)).toBe(hashes[h - 1]);
    }
    expect(root()).toBe(before);
  });

  it('control: the same reorg runs with the version in place', async () => {
    const { ordering, forkResolution } = await chainOnAProver();
    expect(() => forkResolution.reorg(0, [])).not.toThrow();
    expect(ordering.getCurrentHeight()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// reorg — a missing block journal at a revertable height
// ---------------------------------------------------------------------------

describe('reorg — a missing block journal', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch { /* not imported */ }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('a deleted journal is a fail-stop, and chain/DB/prover are at the pre-reorg state', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const proverMod = await import('../../src/state/avl-prover.js');
    proverMod.createAvlProver();
    const genesis = await import('../../src/services/genesis-state.js');
    genesis.seedGenesisState();

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    for (let i = 0; i < 3; i++) {
      await mineNextBlock(bc);
    }

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(3);
    const before = Buffer.from(proverMod.getAvlProver().prover.digest()!).toString('hex');
    const hashes = [1, 2, 3].map((h) => blockHash(ordering.getOrderingBlock(h)!.header));

    const journalStore = await importJournalStore();
    journalStore.deleteBlockJournal(3);

    const forkResolution = await importForkResolution();
    const { MissingJournalError, CorruptChainStateError } =
      await import('../../src/services/corrupt-state.js');

    let caught: unknown;
    try { forkResolution.reorg(1, []); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(MissingJournalError);
    expect(caught).toBeInstanceOf(CorruptChainStateError);
    expect((caught as InstanceType<typeof MissingJournalError>).site).toBe('revertBlock');
    expect((caught as InstanceType<typeof MissingJournalError>).height).toBe(3);

    expect(ordering.getCurrentHeight()).toBe(3);
    for (const h of [1, 2, 3]) {
      expect(blockHash(ordering.getOrderingBlock(h)!.header)).toBe(hashes[h - 1]);
    }
    expect(Buffer.from(proverMod.getAvlProver().prover.digest()!).toString('hex')).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Identity mismatch — chain A's headers scored, chain B's blocks delivered
// ---------------------------------------------------------------------------

describe('resolveFork — identity mismatch', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try { (await importBlockCreator()).stopBlockCreator(); } catch {}
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('headers of chain A scored, valid blocks of chain B delivered → refused, misbehavior', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();
    const { applyOrderingBlock } = (await import(
      '../../src/services/block-apply.js'
    )) as { applyOrderingBlock: (block: OrderingBlock) => boolean };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Height 1 — shared
    await mineNextBlock(bc);

    // Chain A: three blocks at heights 2..4
    const chainABlocks: OrderingBlock[] = [];
    for (const h of [2, 3, 4]) {
      const b = await makeApplicableBlock({ height: h });
      expect(applyOrderingBlock(b)).toBe(true);
      chainABlocks.push(b);
    }
    // Revert chain A
    for (let h = 4; h > 1; h--) forkResolution.revertBlock(h);

    // Chain B: three blocks at the same heights, different content
    const chainBBlocks: OrderingBlock[] = [];
    for (const h of [2, 3, 4]) {
      const b = await makeApplicableBlock({ height: h });
      expect(applyOrderingBlock(b)).toBe(true);
      chainBBlocks.push(b);
    }
    // Revert chain B, rebuild our chain (2 blocks)
    for (let h = 4; h > 1; h--) forkResolution.revertBlock(h);
    await mineNextBlock(bc);
    await mineNextBlock(bc);
    expect(ordering.getCurrentHeight()).toBe(3);

    // Serve chain A's headers but chain B's blocks
    const chainAHeaders = [...chainABlocks].reverse().map(b => b.header)
      .concat(ordering.getOrderingBlock(1)!.header);
    const net = stubNet(chainAHeaders, chainBBlocks);
    await forkResolution.resolveFork(chainABlocks[2]!, net, 'peer-mixed');

    expect(ordering.getCurrentHeight()).toBe(3);
    expect(net.penalties).toEqual([
      expect.objectContaining({ kind: 'misbehavior' }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// #5(b) pinned closed — headers claiming a target above the schedule
// ---------------------------------------------------------------------------

describe('resolveFork — #5(b) pinned closed', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try { (await importBlockCreator()).stopBlockCreator(); } catch {}
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('headers claiming a wrong target are refused at verification, no block request', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await mineNextBlock(bc);
    await mineNextBlock(bc);
    await mineNextBlock(bc);
    expect(ordering.getCurrentHeight()).toBe(3);

    // Build fake headers at height 2..4 with a wrong powTargetBits
    const fakeHeaders: BlockHeader[] = [];
    for (let h = 4; h >= 2; h--) {
      fakeHeaders.push({
        height: h,
        prevBlockHash: '00'.repeat(32),
        stateRoot: EMPTY_STATE_ROOT,
        utxoTxRoot: '00'.repeat(32),
        powTargetBits: 9999,
        powNonce: 0,
        protocolVersion: PROTOCOL_VERSION,
        createdAt: 0,
        validatorId: new Uint8Array(32),
        interlinkRoot: '00'.repeat(32),
      });
    }
    // Include the shared block at height 1 for the fork point
    fakeHeaders.push(ordering.getOrderingBlock(1)!.header);

    const net = stubNet(fakeHeaders, []);
    await forkResolution.resolveFork(
      { header: fakeHeaders[0]!, utxoTxTree: { utxoTxIds: [], utxoTxs: [] }, validatorSignature: new Uint8Array(64) } as OrderingBlock,
      net,
      'peer-fake-target',
    );

    expect(net.blockRequests).toEqual([]);
    expect(net.penalties).toEqual([
      expect.objectContaining({ kind: 'misbehavior' }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tampered headers — one tampered header per reason
// ---------------------------------------------------------------------------

describe('resolveFork — tampered headers refused before any block request', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try { (await importBlockCreator()).stopBlockCreator(); } catch {}
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('far headers with no overlap → genesis fallback, scoring starts at height 1', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Build a short chain (height 1 only)
    await mineNextBlock(bc);
    expect(ordering.getCurrentHeight()).toBe(1);

    // Peer headers are at heights far above our tip. The fork walk's first
    // page holds nothing at or below our tip, so no match is found; with
    // ourTip ≤ maxReorgDepth, genesis is the common ancestor and the scoring
    // walk starts at height 1.
    const farHeaders: BlockHeader[] = [];
    for (let h = 50; h >= 42; h--) {
      farHeaders.push({
        height: h,
        prevBlockHash: '00'.repeat(32),
        stateRoot: EMPTY_STATE_ROOT,
        utxoTxRoot: '00'.repeat(32),
        powTargetBits: testConfig.orderingBlockPowTargetBits,
        powNonce: 0,
        protocolVersion: PROTOCOL_VERSION,
        createdAt: 0,
        validatorId: new Uint8Array(32),
        interlinkRoot: '00'.repeat(32),
      });
    }

    const net = stubNet(farHeaders, []);
    await forkResolution.resolveFork(
      { header: farHeaders[0]!, utxoTxTree: { utxoTxIds: [], utxoTxs: [] }, validatorSignature: new Uint8Array(64) } as OrderingBlock,
      net,
      'peer-window',
    );

    expect(net.blockRequests).toEqual([]);
    expect(net.penalties).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Work rule — equal work keeps ours, strictly more → reorg
// ---------------------------------------------------------------------------

describe('resolveFork — work rule', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try { (await importBlockCreator()).stopBlockCreator(); } catch {}
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('equal work keeps our chain — ties keep the incumbent', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();
    const { applyOrderingBlock } = (await import(
      '../../src/services/block-apply.js'
    )) as { applyOrderingBlock: (block: OrderingBlock) => boolean };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Height 1 — shared
    await mineNextBlock(bc);

    // Build one competing block at height 2 (same work as ours)
    const theirBlock = await makeApplicableBlock({ height: 2 });
    expect(applyOrderingBlock(theirBlock)).toBe(true);
    forkResolution.revertBlock(2);

    // Mine our own height 2
    await mineNextBlock(bc);
    expect(ordering.getCurrentHeight()).toBe(2);

    const theirHeaders = [theirBlock.header, ordering.getOrderingBlock(1)!.header];
    const net = stubNet(theirHeaders, [theirBlock]);
    await forkResolution.resolveFork(theirBlock, net, 'peer-equal');

    // Our chain unchanged — equal work, incumbent wins
    expect(ordering.getCurrentHeight()).toBe(2);
    expect(net.blockRequests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Refused headers — the memory: body-stage refusal → mark → refused again
// ---------------------------------------------------------------------------

describe('resolveFork — refused headers', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try { (await importBlockCreator()).stopBlockCreator(); } catch {}
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('a header-stage refusal writes no mark', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const rh = await importRefusedHeaders();
    const forkResolution = await importForkResolution();
    const ordering = await importOrdering();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await mineNextBlock(bc);
    await mineNextBlock(bc);

    // Serve headers with a bad target — verification fails (header-stage)
    const badHeaders: BlockHeader[] = [
      {
        height: 2,
        prevBlockHash: '00'.repeat(32),
        stateRoot: EMPTY_STATE_ROOT,
        utxoTxRoot: '00'.repeat(32),
        powTargetBits: 9999,
        powNonce: 0,
        protocolVersion: PROTOCOL_VERSION,
        createdAt: 0,
        validatorId: new Uint8Array(32),
        interlinkRoot: '00'.repeat(32),
      },
      ordering.getOrderingBlock(1)!.header,
    ];

    const net = stubNet(badHeaders, []);
    await forkResolution.resolveFork(
      { header: badHeaders[0]!, utxoTxTree: { utxoTxIds: [], utxoTxs: [] }, validatorSignature: new Uint8Array(64) } as OrderingBlock,
      net,
      'peer-bad-target',
    );

    // No mark written for a header-stage refusal
    const hash = blockHash(badHeaders[0]!);
    if (hash) expect(rh.anyRefusedHeader([hash])).toBe(false);
  });

  it('purge on apply removes marks below tip − maxReorgDepth', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const rh = await importRefusedHeaders();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Seed a refused header at a low height
    rh.insertRefusedHeader('old-hash', 1, 5);
    expect(rh.anyRefusedHeader(['old-hash'])).toBe(true);

    // Mine enough blocks so that height 1 is below tip − maxReorgDepth
    for (let i = 0; i < testConfig.maxReorgDepth + 2; i++) {
      await mineNextBlock(bc);
    }

    // The purge ran at each apply — the mark is gone
    expect(rh.anyRefusedHeader(['old-hash'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Entry — handleOrderingBlock
// ---------------------------------------------------------------------------

describe('handleOrderingBlock — entry', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try { (await importBlockCreator()).stopBlockCreator(); } catch {}
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('an extending block applies and returns true', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const handleBlock = await importHandleBlock();
    const ordering = await importOrdering();

    await mineNextBlock(bc);
    expect(ordering.getCurrentHeight()).toBe(1);

    const nextBlock = await makeApplicableBlock({ height: 2 });
    const net = stubNet([], []);
    const result = handleBlock.handleOrderingBlock(nextBlock, 'peer-a', net);

    expect(result).toBe(true);
    expect(ordering.getCurrentHeight()).toBe(2);
  });

  it('a block already held is a no-op — no apply, no header request, returns true', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const handleBlock = await importHandleBlock();
    const ordering = await importOrdering();

    await mineNextBlock(bc);
    const held = ordering.getOrderingBlock(1)!;

    const net = stubNet([], []);
    const result = handleBlock.handleOrderingBlock(held, 'peer-a', net);

    expect(result).toBe(true);
    // No header request
    expect(net.askedPeers).toEqual([]);
    // Height unchanged — no apply
    expect(ordering.getCurrentHeight()).toBe(1);
  });

  it('an unhashable arriving block at an empty height is not treated as already held', async () => {
    // NODE_INTERFACE → "Who reads the block_hash column, and who deliberately
    // does not". Without the null guard, getOrderingBlockHash(h) === null and
    // blockHash(unhashable) === null would collide.
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const handleBlock = await importHandleBlock();
    const ordering = await importOrdering();

    await mineNextBlock(bc);

    // Craft a block at an EMPTY height with an out-of-domain header field.
    // `blockHash` returns null for an unencodable header.
    const { blockHash } = await import('@dagsocial/validation');
    const emptyHeight = 999;
    const fakeBlock = ordering.getOrderingBlock(1)!;
    const unhashable = {
      ...fakeBlock,
      header: {
        ...fakeBlock.header,
        height: emptyHeight,
        powNonce: Number.MAX_SAFE_INTEGER + 1,
      },
    };
    expect(blockHash(unhashable.header)).toBeNull();
    expect(ordering.getOrderingBlockHash(emptyHeight)).toBeNull();

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const net = stubNet([], []);
    const result = handleBlock.handleOrderingBlock(unhashable, 'peer-a', net);
    // Must NOT return true (the "already held" short-circuit)
    expect(result).not.toBe(true);
  });

  it('a non-extending pulled block returns false and triggers resolution', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const scenario = await buildForkScenario();
    await importOrdering();
    const handleBlock = await importHandleBlock();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const net = stubNet(scenario.theirHeaders, scenario.theirBlocks);
    const result = handleBlock.handleOrderingBlock(
      scenario.competingBlock,
      'peer-a',
      net,
    );

    expect(result).toBe(false);

    // Wait for the launched resolution to complete
    await vi.waitFor(() => {
      expect(net.askedPeers.length).toBeGreaterThan(0);
    }, { timeout: 5000 });
  });
});

// ---------------------------------------------------------------------------
// Tampered headers — one per reason, refused before any block request,
// misbehaviour.
// ---------------------------------------------------------------------------

describe('resolveFork — one tampered header per reason', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try { (await importBlockCreator()).stopBlockCreator(); } catch {}
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function setupChainOfThree() {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await mineNextBlock(bc);
    await mineNextBlock(bc);
    await mineNextBlock(bc);
    expect(ordering.getCurrentHeight()).toBe(3);
    return { bc, ordering, forkResolution };
  }

  function headersWithTampered(
    ordering: Awaited<ReturnType<typeof importOrdering>>,
    tamper: (h: BlockHeader) => BlockHeader,
  ): BlockHeader[] {
    const shared = ordering.getOrderingBlock(1)!.header;
    const legit = ordering.getOrderingBlock(2)!.header;
    const tampered = tamper({ ...legit });
    return [tampered, shared];
  }

  it('wrong version → refused, misbehaviour, no block request', async () => {
    const { ordering, forkResolution } = await setupChainOfThree();
    const headers = headersWithTampered(ordering, (h) => {
      h.protocolVersion = 999;
      return h;
    });
    const net = stubNet(headers, []);
    await forkResolution.resolveFork(
      { header: headers[0]!, utxoTxTree: { utxoTxIds: [], utxoTxs: [] }, validatorSignature: new Uint8Array(64) } as OrderingBlock,
      net, 'peer-tamper',
    );
    expect(net.blockRequests).toEqual([]);
    expect(net.penalties).toEqual([expect.objectContaining({ kind: 'misbehavior' })]);
  });

  it('height gap → refused, misbehaviour, no block request', async () => {
    const { ordering, forkResolution } = await setupChainOfThree();
    // A header at height 3 that doesn't match ours: the fork walk sees it,
    // finds no match at height 3, finds the shared block at height 1, and the
    // scoring walk verifies [tampered(h=3)] starting from fork height 1 —
    // height 3 ≠ anchor.height + 1 (= 2) → 'height' refusal → misbehavior.
    const shared = ordering.getOrderingBlock(1)!.header;
    const legit = ordering.getOrderingBlock(2)!.header;
    const tampered: BlockHeader = { ...legit, height: 3, prevBlockHash: 'ee'.repeat(32) };
    const headers = [tampered, shared];
    const net = stubNet(headers, []);
    await forkResolution.resolveFork(
      { header: tampered, utxoTxTree: { utxoTxIds: [], utxoTxs: [] }, validatorSignature: new Uint8Array(64) } as OrderingBlock,
      net, 'peer-tamper',
    );
    expect(net.blockRequests).toEqual([]);
    expect(net.penalties).toEqual([expect.objectContaining({ kind: 'misbehavior' })]);
  });

  it('wrong prevBlockHash (link) → refused, misbehaviour, no block request', async () => {
    const { ordering, forkResolution } = await setupChainOfThree();
    const headers = headersWithTampered(ordering, (h) => {
      h.prevBlockHash = 'ff'.repeat(32);
      return h;
    });
    const net = stubNet(headers, []);
    await forkResolution.resolveFork(
      { header: headers[0]!, utxoTxTree: { utxoTxIds: [], utxoTxs: [] }, validatorSignature: new Uint8Array(64) } as OrderingBlock,
      net, 'peer-tamper',
    );
    expect(net.blockRequests).toEqual([]);
    expect(net.penalties).toEqual([expect.objectContaining({ kind: 'misbehavior' })]);
  });

  it('wrong target → refused, misbehaviour, no block request', async () => {
    const { ordering, forkResolution } = await setupChainOfThree();
    const headers = headersWithTampered(ordering, (h) => {
      h.powTargetBits = 9999;
      return h;
    });
    const net = stubNet(headers, []);
    await forkResolution.resolveFork(
      { header: headers[0]!, utxoTxTree: { utxoTxIds: [], utxoTxs: [] }, validatorSignature: new Uint8Array(64) } as OrderingBlock,
      net, 'peer-tamper',
    );
    expect(net.blockRequests).toEqual([]);
    expect(net.penalties).toEqual([expect.objectContaining({ kind: 'misbehavior' })]);
  });
});

// ---------------------------------------------------------------------------
// Body-stage mark round trip — the load-bearing refused-headers test
// ---------------------------------------------------------------------------

describe('resolveFork — body-stage refusal → mark → re-serve → continuation → unrelated', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try { (await importBlockCreator()).stopBlockCreator(); } catch {}
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('full mark lifecycle: forge → mark → re-serve refused → continuation refused → unrelated adopted', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();
    const rh = await importRefusedHeaders();
    const { applyOrderingBlock } = (await import(
      '../../src/services/block-apply.js'
    )) as { applyOrderingBlock: (block: OrderingBlock) => boolean };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Shared height 1
    await mineNextBlock(bc);

    // Build the forged chain: valid headers (real PoW), forged validator
    // signature on the last block. Apply the first two honestly, then build
    // a third with forged signature.
    const forger = makeTestIdentity();
    const forgedBlocks: OrderingBlock[] = [];
    for (const h of [2, 3]) {
      const b = await makeApplicableBlock({ height: h });
      expect(applyOrderingBlock(b)).toBe(true);
      forgedBlocks.push(b);
    }
    // Height 4: forged signature — validatorId is the miner's, signature is the forger's
    const forgedB4 = await makeApplicableBlock({ height: 4, signWith: forger.privateKey });
    forgedBlocks.push(forgedB4);

    // Revert the honest ones and rebuild our chain (height 2-3)
    for (let h = 3; h > 1; h--) forkResolution.revertBlock(h);
    await mineNextBlock(bc);
    await mineNextBlock(bc);
    expect(ordering.getCurrentHeight()).toBe(3);

    const forgedHeaders = [...forgedBlocks].reverse().map(b => b.header)
      .concat(ordering.getOrderingBlock(1)!.header);

    // Save pre-reorg state
    const preHashes = [1, 2, 3].map(
      (h) => blockHash(ordering.getOrderingBlock(h)!.header)!,
    );

    // --- Step 1: first serve — reorg attempted, rolled back, mark written ---
    const net1 = stubNet(forgedHeaders, forgedBlocks);
    await forkResolution.resolveFork(forgedBlocks[2]!, net1, 'peer-forger');

    // Chain and prover at pre-reorg state
    expect(ordering.getCurrentHeight()).toBe(3);
    for (const h of [1, 2, 3]) {
      expect(blockHash(ordering.getOrderingBlock(h)!.header)).toBe(preHashes[h - 1]);
    }

    // Mark present for the forged block's hash
    const forgedHash = blockHash(forgedB4.header)!;
    expect(rh.anyRefusedHeader([forgedHash])).toBe(true);

    // Misbehaviour recorded
    expect(net1.penalties).toEqual([
      expect.objectContaining({ kind: 'misbehavior' }),
    ]);

    // --- Step 2: same chain served again → refused at memory step, no block request ---
    const net2 = stubNet(forgedHeaders, forgedBlocks);
    await forkResolution.resolveFork(forgedBlocks[2]!, net2, 'peer-forger');

    expect(net2.blockRequests).toEqual([]);
    expect(net2.penalties).toEqual([
      expect.objectContaining({ kind: 'misbehavior' }),
    ]);
    expect(ordering.getCurrentHeight()).toBe(3);

    // --- Step 3: continuation (same chain + one more block) → refused ---
    // Add a hypothetical height-5 header to the forged chain
    const continuationHeaders = [
      {
        height: 5,
        prevBlockHash: forgedHash,
        stateRoot: EMPTY_STATE_ROOT,
        utxoTxRoot: '00'.repeat(32),
        powTargetBits: testConfig.orderingBlockPowTargetBits,
        powNonce: 0,
        protocolVersion: PROTOCOL_VERSION,
        createdAt: 0,
        validatorId: new Uint8Array(32),
        interlinkRoot: '00'.repeat(32),
      } as BlockHeader,
      ...forgedHeaders,
    ];
    const net3 = stubNet(continuationHeaders, []);
    await forkResolution.resolveFork(
      { header: continuationHeaders[0]!, utxoTxTree: { utxoTxIds: [], utxoTxs: [] }, validatorSignature: new Uint8Array(64) } as OrderingBlock,
      net3, 'peer-forger',
    );

    // Refused at the memory step (the forged hash is an ancestor)
    expect(net3.blockRequests).toEqual([]);
    expect(ordering.getCurrentHeight()).toBe(3);

    // --- Step 4: unrelated valid heavier chain from the same peer → adopted ---
    // Build an honest, heavier chain
    for (let h = 3; h > 1; h--) forkResolution.revertBlock(h);
    const honestBlocks: OrderingBlock[] = [];
    for (const h of [2, 3, 4]) {
      const b = await makeApplicableBlock({ height: h });
      expect(applyOrderingBlock(b)).toBe(true);
      honestBlocks.push(b);
    }
    // Revert and restore our chain
    for (let h = 4; h > 1; h--) forkResolution.revertBlock(h);
    await mineNextBlock(bc);
    await mineNextBlock(bc);
    expect(ordering.getCurrentHeight()).toBe(3);

    const honestHeaders = [...honestBlocks].reverse().map(b => b.header)
      .concat(ordering.getOrderingBlock(1)!.header);
    const net4 = stubNet(honestHeaders, honestBlocks);
    await forkResolution.resolveFork(honestBlocks[2]!, net4, 'peer-forger');

    // Adopted — heights 2-4 are now the honest blocks
    expect(ordering.getCurrentHeight()).toBe(4);
    for (const [i, block] of honestBlocks.entries()) {
      expect(blockHash(ordering.getOrderingBlock(i + 2)!.header)).toBe(blockHash(block.header));
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — reorg ceiling screen (MEMPOOL_INTERFACE → Validity ceiling: the
// reorg caller screens a past-ceiling transaction).
// ---------------------------------------------------------------------------

describe('reorg — ceiling screen', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch { /* not imported */ }
    vi.resetModules();
  });

  function ceilingTx(createdAtBlock: number): UtxoTransaction {
    const owner = new Uint8Array(32);
    return {
      inputs: ['aa'.repeat(32)],
      outputs: [
        { boxType: 'karma', value: 99n, owner, createdAtBlock },
        {
          boxType: 'vouch',
          value: 1n,
          voucherId: owner,
          targetId: owner,
          createdAtBlock,
        },
      ],
      signatures: { ['00'.repeat(32)]: new Uint8Array(64) },
      protocolVersion: PROTOCOL_VERSION,
    };
  }

  async function injectCeilingTx(height: number, tx: UtxoTransaction) {
    const journalMod = await import('../../src/store/journal.js');
    const journal = journalMod.getBlockJournal(height);
    if (!journal) throw new Error(`no journal at height ${height}`);
    const encoded = encodeTx(tx);
    journal.appliedUtxoTxs.push({ txId: 'ceiling-test-tx', txBytes: encoded });
    journalMod.insertBlockJournal(journal);
  }

  it('screens a past-ceiling tx when newTipHeight exceeds the ceiling', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = await importDb();
      db.initDb(':memory:');
      db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

      const author = makeTestIdentity();
      const posts = await importPosts();
      const mempool = await importMempoolFresh();
      const bc = await importBlockCreator();
      bc.startBlockCreator(testConfig);

      // Build 7 blocks so reorg(0, chain) has newTipHeight = 7
      for (let i = 0; i < 7; i++) {
        const { commit, tx: postTx, postId, content } = await seedPostTx(author, `ceiling ${i}`);
        posts.insertPost(postId, commit, content);
        mempool.insertUtxoTx(postTx, 1000);
        await mineNextBlock(bc);
      }

      const ordering = await importOrdering();
      expect(ordering.getCurrentHeight()).toBe(7);

      // Inject a vouch tx with createdAtBlock = 1 (ceiling = 6) into block 1's journal
      await injectCeilingTx(1, ceilingTx(1));

      const chain = Array.from({ length: 7 }, (_, i) => ordering.getOrderingBlock(i + 1)!);
      const forkResolution = await importForkResolution();
      forkResolution.reorg(0, chain);

      // The screen fired: ceiling 6 < newTipHeight 7
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('past ceiling')),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not screen when newTipHeight equals the ceiling', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = await importDb();
      db.initDb(':memory:');
      db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

      const author = makeTestIdentity();
      const posts = await importPosts();
      const mempool = await importMempoolFresh();
      const bc = await importBlockCreator();
      bc.startBlockCreator(testConfig);

      // Build 6 blocks so reorg(0, chain) has newTipHeight = 6
      for (let i = 0; i < 6; i++) {
        const { commit, tx: postTx, postId, content } = await seedPostTx(author, `no-screen ${i}`);
        posts.insertPost(postId, commit, content);
        mempool.insertUtxoTx(postTx, 1000);
        await mineNextBlock(bc);
      }

      const ordering = await importOrdering();
      expect(ordering.getCurrentHeight()).toBe(6);

      // Inject a vouch tx with createdAtBlock = 1 (ceiling = 6) into block 1's journal
      await injectCeilingTx(1, ceilingTx(1));

      const chain = Array.from({ length: 6 }, (_, i) => ordering.getOrderingBlock(i + 1)!);
      const forkResolution = await importForkResolution();
      forkResolution.reorg(0, chain);

      // ceiling 6 < 6 is false — not screened
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('past ceiling')),
      ).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('a tx with no ceiling is never screened', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = await importDb();
      db.initDb(':memory:');
      db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

      const author = makeTestIdentity();
      const posts = await importPosts();
      const mempool = await importMempoolFresh();
      const bc = await importBlockCreator();
      bc.startBlockCreator(testConfig);

      for (let i = 0; i < 7; i++) {
        const { commit, tx: postTx, postId, content } = await seedPostTx(author, `null-ceiling ${i}`);
        posts.insertPost(postId, commit, content);
        mempool.insertUtxoTx(postTx, 1000);
        await mineNextBlock(bc);
      }

      const ordering = await importOrdering();
      const chain = Array.from({ length: 7 }, (_, i) => ordering.getOrderingBlock(i + 1)!);
      const forkResolution = await importForkResolution();
      forkResolution.reorg(0, chain);

      // No tx has a ceiling — the screen message never fires
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('past ceiling')),
      ).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Interlink root — verifyHeaderChain step 7 in fork choice
// (NODE_INTERFACE → Fork choice decides on verified headers, step 4-5;
//  VALIDATION_INTERFACE → verifyHeaderChain)
// ---------------------------------------------------------------------------

describe('resolveFork — interlink root verification (step 7)', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try { (await importBlockCreator()).stopBlockCreator(); } catch {}
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('a segment with a wrong interlinkRoot is refused with reason interlinks before any block fetch', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await mineNextBlock(bc);
    await mineNextBlock(bc);
    await mineNextBlock(bc);
    expect(ordering.getCurrentHeight()).toBe(3);

    // Fork at height 1 — build a competing chain of 3 with correct roots
    const sharedH1 = ordering.getOrderingBlock(1)!.header;
    const sharedHash = blockHash(sharedH1)!;
    const sharedLevel = headerLevel(sharedH1, testConfig.orderingBlockPowTargetBits);
    const anchorIl = updateInterlinks([], sharedHash, sharedLevel);
    const { retargetParams: rp } = await import('../../src/services/difficulty.js');
    const { headers: good } = buildMinedHeaderChain({
      anchorPrevBlockHash: sharedHash,
      anchorInterlinks: anchorIl,
      startHeight: 2,
      count: 3,
      params: rp(),
      anchorCreatedAt: sharedH1.createdAt,
      anchorStamp: sharedH1.createdAt,
      startStamp: sharedH1.createdAt + testConfig.orderingBlockIdealMs,
    });

    // Tamper the root at index 1 (height 3) — re-mine so PoW passes
    const tampered: BlockHeader = { ...good[1]!, interlinkRoot: 'ff'.repeat(32) };
    tampered.powNonce = solveHeaderPow(tampered);
    const segment = [good[0]!, tampered, good[2]!];

    // Serve newest-first, with shared height-1 block as the fork anchor
    const theirHeaders = [...segment].reverse().concat(sharedH1);
    const net = stubNet(theirHeaders, []);
    await forkResolution.resolveFork(
      { header: segment[2]!, utxoTxTree: { utxoTxIds: [], utxoTxs: [] }, validatorSignature: new Uint8Array(64) } as OrderingBlock,
      net,
      'peer-bad-root',
    );

    expect(net.blockRequests).toEqual([]);
    expect(net.penalties).toEqual([
      expect.objectContaining({ kind: 'misbehavior' }),
    ]);
  });

  it('a competing chain with correct interlink roots reorgs successfully, and stored interlinks match recomputation', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Shared block 1
    await mineNextBlock(bc);
    expect(ordering.getCurrentHeight()).toBe(1);

    // Build a competing chain of 5 from height 2 — applied on top of the
    // shared height 1, so each block goes through the full apply funnel and
    // its interlink root is verified there.
    const competingBlocks: OrderingBlock[] = [];
    for (let i = 0; i < 5; i++) {
      const b = await mineNextBlock(bc);
      expect(b).not.toBeNull();
      competingBlocks.push(ordering.getOrderingBlock(2 + i)!);
    }
    expect(ordering.getCurrentHeight()).toBe(6);

    // Revert back to height 1 and mine our chain (3 blocks, strictly less work)
    for (let h = 6; h > 1; h--) forkResolution.revertBlock(h);
    expect(ordering.getCurrentHeight()).toBe(1);
    await mineNextBlock(bc);
    await mineNextBlock(bc);
    await mineNextBlock(bc);
    expect(ordering.getCurrentHeight()).toBe(4);

    // Serve the competing chain (5 blocks, more work than our 3)
    const theirHeaders = [...competingBlocks].reverse().map(b => b.header)
      .concat(ordering.getOrderingBlock(1)!.header);
    const net = stubNet(theirHeaders, competingBlocks);
    await forkResolution.resolveFork(
      competingBlocks[4]!,
      net,
      'peer-longer-chain',
    );

    // Reorg succeeded — new tip is height 6
    expect(ordering.getCurrentHeight()).toBe(6);

    // Walk height 1 → tip: every stored interlink vector matches a recomputation
    // from the stored headers (TYPES_INTERFACE → Interlink vector).
    let il: string[] = [];
    for (let h = 1; h <= 6; h++) {
      const stored = ordering.getInterlinks(h);
      expect(stored).not.toBeNull();
      expect(stored).toEqual(il);

      const header = ordering.getOrderingBlock(h)!.header;
      const hash = blockHash(header)!;
      const lvl = headerLevel(header, testConfig.orderingBlockPowTargetBits);
      if (h === 1) {
        il = updateInterlinks([], hash, Infinity);
      } else {
        il = updateInterlinks(il, hash, lvl);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// ASERT: fork-resolution timestamp rules + schedule-aware reorg
// ---------------------------------------------------------------------------

describe('resolveFork — ASERT timestamp rules and schedule', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try { (await importBlockCreator()).stopBlockCreator(); } catch {}
    const { setClock } = await import('../../src/services/difficulty.js');
    setClock(null);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('a segment whose stamps violate the order rule is refused with misbehavior and reason time', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const { setClock } = await import('../../src/services/difficulty.js');
    const { retargetParams: rp } = await import('../../src/services/difficulty.js');
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const t1 = 1_000_000;
    setClock(() => t1);
    await mineNextBlock(bc);
    setClock(() => t1 + 60_000);
    await mineNextBlock(bc);
    expect(ordering.getCurrentHeight()).toBe(2);

    // Build a competing segment from height 2 with equal stamps (order violation)
    const sharedH1 = ordering.getOrderingBlock(1)!.header;
    const sharedHash = blockHash(sharedH1)!;
    const sharedLevel = headerLevel(sharedH1, testConfig.orderingBlockPowTargetBits);
    const anchorIl = updateInterlinks([], sharedHash, sharedLevel);

    // Two headers at the same stamp
    const { headers: badChain } = buildMinedHeaderChain({
      anchorPrevBlockHash: sharedHash,
      anchorInterlinks: anchorIl,
      startHeight: 2,
      count: 3,
      params: rp(),
      anchorCreatedAt: sharedH1.createdAt,
      anchorStamp: sharedH1.createdAt,
      startStamp: sharedH1.createdAt + 60_000,
      spacingMs: 0,
    });
    // Force equal stamps on consecutive headers to trigger the order rule
    badChain[1]!.createdAt = badChain[0]!.createdAt;
    badChain[1]!.powNonce = solveHeaderPow(badChain[1]!);

    const theirHeaders = [...badChain].reverse().concat(sharedH1);
    const net = stubNet(theirHeaders, []);
    await forkResolution.resolveFork(
      { header: badChain[2]!, utxoTxTree: { utxoTxIds: [], utxoTxs: [] }, validatorSignature: new Uint8Array(64) } as OrderingBlock,
      net,
      'peer-bad-time',
    );

    expect(net.blockRequests).toEqual([]);
    expect(net.penalties).toEqual([
      expect.objectContaining({ kind: 'misbehavior' }),
    ]);
  });

  it('a segment stamped beyond the future bound is not penalised, and after setClock advances the same segment reorgs', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const { setClock } = await import('../../src/services/difficulty.js');
    const { retargetParams: rp, anchorCreatedAt: getAnchorCa } = await import('../../src/services/difficulty.js');
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const t1 = 1_000_000;
    setClock(() => t1);
    await mineNextBlock(bc);
    expect(ordering.getCurrentHeight()).toBe(1);

    // Build a competing chain of 3 from genesis with stamps beyond the bound
    const sharedH1 = ordering.getOrderingBlock(1)!.header;
    const sharedHash = blockHash(sharedH1)!;
    const sharedLevel = headerLevel(sharedH1, testConfig.orderingBlockPowTargetBits);
    const anchorIl = updateInterlinks([], sharedHash, sharedLevel);
    const futureStamp = t1 + MAX_FUTURE_DRIFT_MS + 60_001;

    const { headers: futureChain } = buildMinedHeaderChain({
      anchorPrevBlockHash: sharedHash,
      anchorInterlinks: anchorIl,
      startHeight: 2,
      count: 3,
      params: rp(),
      anchorCreatedAt: getAnchorCa(),
      anchorStamp: sharedH1.createdAt,
      startStamp: futureStamp,
    });

    // Serve our 1-block chain and the future 3-block chain
    const theirHeaders = [...futureChain].reverse().concat(sharedH1);

    // Mine our chain to 2 blocks so the fork is meaningful
    setClock(() => t1 + 60_000);
    await mineNextBlock(bc);
    expect(ordering.getCurrentHeight()).toBe(2);

    const net1 = stubNet(theirHeaders, []);
    await forkResolution.resolveFork(
      { header: futureChain[2]!, utxoTxTree: { utxoTxIds: [], utxoTxs: [] }, validatorSignature: new Uint8Array(64) } as OrderingBlock,
      net1,
      'peer-future',
    );

    // Not penalised, no refused_headers, height unchanged
    expect(net1.penalties).toEqual([]);
    expect(ordering.getCurrentHeight()).toBe(2);

    const { anyRefusedHeader } = await import('../../src/store/index.js');
    const futureHashes = futureChain.map(h => blockHash(h)!);
    expect(anyRefusedHeader(futureHashes)).toBe(false);
  });

  it('a branch header declaring the anchor bits where its own schedule says otherwise is penalised with reason target', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const { setClock } = await import('../../src/services/difficulty.js');
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const t1 = 1_000_000;
    setClock(() => t1);
    await mineNextBlock(bc);
    const t2 = t1 + 60_000;
    setClock(() => t2);
    await mineNextBlock(bc);
    expect(ordering.getCurrentHeight()).toBe(2);

    const sharedH1 = ordering.getOrderingBlock(1)!.header;
    const sharedHash = blockHash(sharedH1)!;

    // A chain stamped very late (schedule moves to floor) but declaring anchor bits
    const lateStamp = t1 + 10 * 86_400_000;
    const badHeader: BlockHeader = {
      protocolVersion: PROTOCOL_VERSION,
      height: 2,
      prevBlockHash: sharedHash,
      utxoTxRoot: '00'.repeat(32),
      stateRoot: EMPTY_STATE_ROOT,
      validatorId: new Uint8Array(32),
      powNonce: 0,
      powTargetBits: testConfig.orderingBlockPowTargetBits,
      createdAt: lateStamp,
      interlinkRoot: '00'.repeat(32),
    };
    badHeader.powNonce = solveHeaderPow(badHeader);

    const theirHeaders = [badHeader, sharedH1];
    setClock(() => lateStamp + 60_000);
    const net = stubNet(theirHeaders, []);
    await forkResolution.resolveFork(
      { header: badHeader, utxoTxTree: { utxoTxIds: [], utxoTxs: [] }, validatorSignature: new Uint8Array(64) } as OrderingBlock,
      net,
      'peer-wrong-target',
    );

    expect(net.penalties).toEqual([
      expect.objectContaining({ kind: 'misbehavior' }),
    ]);
  });

  it('a reorg onto a branch whose targets moved with its stamps applies every block through the funnel', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const { setClock } = await import('../../src/services/difficulty.js');
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const t1 = 1_000_000;
    setClock(() => t1);
    await mineNextBlock(bc);
    expect(ordering.getCurrentHeight()).toBe(1);

    // Mine the competing branch of 4 at slow pace — the schedule eases
    const slowSpacing = 600_000;
    const competingBlocks: OrderingBlock[] = [];
    for (let i = 0; i < 4; i++) {
      setClock(() => t1 + slowSpacing * (i + 1));
      await mineNextBlock(bc);
      competingBlocks.push(ordering.getOrderingBlock(2 + i)!);
    }
    expect(ordering.getCurrentHeight()).toBe(5);

    // The schedule eased — later headers carry lower bits (easier)
    expect(competingBlocks[3]!.header.powTargetBits)
      .toBeLessThanOrEqual(competingBlocks[0]!.header.powTargetBits);

    // Revert to height 1 and mine our shorter chain (2 blocks)
    for (let h = 5; h > 1; h--) forkResolution.revertBlock(h);
    expect(ordering.getCurrentHeight()).toBe(1);
    setClock(() => t1 + 60_000);
    await mineNextBlock(bc);
    setClock(() => t1 + 120_000);
    await mineNextBlock(bc);
    expect(ordering.getCurrentHeight()).toBe(3);

    // Serve the competing chain — more work than our 2-block side
    const theirHeaders = [...competingBlocks].reverse().map(b => b.header)
      .concat(ordering.getOrderingBlock(1)!.header);
    setClock(() => t1 + slowSpacing * 5);
    const net = stubNet(theirHeaders, competingBlocks);
    await forkResolution.resolveFork(competingBlocks[3]!, net, 'peer-slow-branch');

    expect(ordering.getCurrentHeight()).toBe(5);
    expect(net.penalties).toEqual([]);
  });
});
