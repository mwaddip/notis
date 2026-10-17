import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  PROTOCOL_VERSION,
  bytesToHex,
  computeTxId,
  encodeTx,
  hash32,
} from '@dagsocial/types';
import { blockHash, cumulativeWork } from '@dagsocial/validation';
import { label as avlLabel } from '@dagsocial/avltree';
import type { AvlNode } from '@dagsocial/avltree';
import type {
  KarmaBox,
  OrderingBlock,
  UtxoTransaction,
  BlockHeader,
} from '@dagsocial/types';
import type { BlockJournal } from '../../src/store/journal.js';
import {
  hex,
  makeApplicableBlock,
  makeKarmaBox,
  makeLikeTx,
  makeTestIdentity,
  mineNextBlock,
  signHeader,
  signTransaction,
  solveHeaderPow, seedPostTx, activateProverOverStore, insertPoisonedBlock,
  changeBoxOf, revertChainTo, ringHeights, seedBoxes,
  TEST_GENESIS_PROOF_PAYLOAD} from '../helpers.js';
import {
  testConfig,
  importDb,
  importBlockCreator,
  importOrdering,
  importForkResolution,
  stagePrefix,
} from './fork-resolution-fixtures.js';

// ---------------------------------------------------------------------------
// Dynamic import helpers
// ---------------------------------------------------------------------------


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

async function importJournalStore() {
  return (await import('../../src/store/journal.js')) as {
    getBlockJournal: (height: number) => BlockJournal | null;
    deleteBlockJournal: (height: number) => void;
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

/**
 * A pool entry any template can carry: a karma box spent back to its owner,
 * signed. The box is committed now, so a test calls this before its first block
 * — the fork point a reorg returns to then holds the box, and the template the
 * reorg rebuilds keeps the entry rather than evicting it.
 */
/** The 33-byte digest of a kept root — the root's label and the tree height, hex. */
function keptDigest(kept: { root: AvlNode; treeHeight: number }): string {
  const out = new Uint8Array(33);
  out.set(avlLabel(kept.root), 0);
  out[32] = kept.treeHeight;
  return bytesToHex(out);
}

async function seededSelfSpend(): Promise<UtxoTransaction> {
  const owner = makeTestIdentity();
  const box = makeKarmaBox(10n, owner.userId, 0);
  await seedBoxes([box]);
  const tx: UtxoTransaction = {
    inputs: [box.id!],
    outputs: [{ boxType: 'karma', value: box.value, createdAtBlock: 0, owner: owner.userId }],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, owner.privateKey, hex(owner.userId));
  return tx;
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
      adProofsRoot: '00'.repeat(32),
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
      adProofsRoot: '00'.repeat(32),
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
        validatorId: new Uint8Array(32), powNonce: 0, powTargetBits: 256 * 5, createdAt: 1000, interlinkRoot: '00'.repeat(32), adProofsRoot: '00'.repeat(32),
      },
      {
        protocolVersion: PROTOCOL_VERSION, height: 2, prevBlockHash: 'ff'.repeat(32),
        validatorId: new Uint8Array(32), powNonce: 0, powTargetBits: 256 * 5, createdAt: 2000, interlinkRoot: '00'.repeat(32), adProofsRoot: '00'.repeat(32),
      },
    ] as BlockHeader[];

    // Chain B: 1 block at 7 bits = 128
    const chainB = [
      {
        protocolVersion: PROTOCOL_VERSION, height: 1, prevBlockHash: '00'.repeat(32),
        validatorId: new Uint8Array(32), powNonce: 0, powTargetBits: 256 * 7, createdAt: 1000, interlinkRoot: '00'.repeat(32), adProofsRoot: '00'.repeat(32),
      },
    ] as BlockHeader[];

    expect(cumulativeWork(chainB) > cumulativeWork(chainA)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — the ordering store disagreeing with the apply gate
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
        adProofsRoot: '00'.repeat(32),
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
    // A prover over the store, so apply reaches the chain-link read: a node
    // with none refuses every block before it (NODE_INTERFACE → Post-block
    // stateRoot → "A node applies and produces over its prover, and has no
    // other way to").
    await activateProverOverStore();
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
    const { corruptState } = await storeCorruptTip();
    const ordering = await importOrdering();

    // The row was written — `writeVlqU` is total and sentinels `-1` — and it
    // cannot be read back. Both halves matter: the write is why the corruption
    // still gets into the store at all, and the read is why it can never come
    // out pretending to be a header.
    const caught = thrownBy(() => ordering.getOrderingBlock(1));

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
        adProofsRoot: '00'.repeat(32),
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
  // registrations, the intake's items, the block creator, and the guarded
  // provider and routes — is a boundary (NODE_INTERFACE → "Reach is the live
  // argument, not the halt").
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
        adProofsRoot: '00'.repeat(32),
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
    const block2 = buildBlock(2, 1);
    const hashes2 = await stagePrefix([block2]);
    const caught = thrownBy(() => forkResolution.reorg(1, hashes2));
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
    // that *does* discriminate is the stored-row direct-read case at the top
    // of this describe — that path never enters the funnel, so only a fix at
    // the store read reaches it.
    //
    // Kept anyway, because the arm it pins is otherwise covered only for its
    // verdict: `tx-envelope-funnel.test.ts` measures what the decode arm
    // answers, and this measures that answering is what it does.
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const miner = makeTestIdentity();
    const block = await makeApplicableBlock({ miner });

    const { computeUtxoTxRoot } = await import('@dagsocial/types');
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
    posts.insertPost(postId, computeTxId(postTx), commit, content);

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

    posts.insertPost(postId, computeTxId(postTx), commit, content);

    // Insert post transaction
    mempool.insertUtxoTx(postTx, 1000);

    // Insert a standalone UTXO tx. The like targets the post this block
    // confirms — N2b rejects likes on unconfirmed targets, and topology
    // (§8b) precedes the tx loop (§11).
    const liker = makeTestIdentity();
    const karmaBox = makeKarmaBox(100n, liker.userId, 0);
    utxo.insertBox(karmaBox);
    const likeTx = makeLikeTx(liker, karmaBox, postId, author.userId);
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
      '@dagsocial/consensus'
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

    // The decay clock is committed state: the deps read and write the identity
    // record.
    const records = await import('../../src/store/identity-records.js');

    const deps = {
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
      txId: provenance.mintTxIdFor(TEST_GENESIS_PROOF_PAYLOAD, provenance.genesisCommitteeContext(plan.owner), DECAY_HEIGHT),
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

  it('reverts blocks and re-inserts txs to mempool', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    // Build 3 blocks, one post per author — NODE_INTERFACE → Karma transition
    // rules → "An identity holds at most two karma boxes". Each post's karma
    // box is committed before the first block, so the fork point the reorg
    // returns to holds it — a box `seedCommittedState` adds mid-chain has no
    // journal, and a revert past it leaves it in the store alone.
    const seededPosts = [];
    for (let i = 0; i < 3; i++) {
      seededPosts.push(await seedPostTx(makeTestIdentity(), `reorg test ${i}`));
    }
    for (const { commit, tx: postTx, postId, content } of seededPosts) {
      posts.insertPost(postId, computeTxId(postTx), commit, content);
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

  // NODE_INTERFACE → Posts → "The creating transaction rides a post row": the
  // reorg path reverts the confirming block (Phase 1's `unconfirmPost` nulls
  // the row's `block_height`) and re-admits the reverted transactions
  // (Phase 2's `insertUtxoTx`). The two cases below read the post afterwards
  // through FeedService with `tx: true`, so a `tx` field answered from the
  // pool and a `tx: null` from a dropped re-insert sit side by side.
  it('a reverted post whose re-insert returns to the pool answers tx as the pool entry\'s bytes', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const author = makeTestIdentity();
    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'reorg feed-service re-insert');
    const txId = computeTxId(postTx);
    const txBytes = encodeTx(postTx);

    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();

    posts.insertPost(postId, txId, commit, content);
    mempool.insertUtxoTx(postTx, 1000);
    bc.startBlockCreator(testConfig);
    await mineNextBlock(bc);
    expect(mempool.getPendingEntries(100)).toHaveLength(0);

    const forkResolution = await importForkResolution();
    forkResolution.reorg(0, []);

    const storeIdx = await import('../../src/store/index.js');
    const feedModule = await import('../../src/services/feed-service.js');
    const feed = new feedModule.FeedService({
      getPost: storeIdx.getPost,
      queryPostsPage: storeIdx.queryPostsPage,
      getLikeRecordCount: storeIdx.getLikeRecordCount,
      getDescendantCount: storeIdx.getDescendantCount,
      hasLikeRecord: storeIdx.hasLikeRecord,
      getAncestorsNearest: storeIdx.getAncestorsNearest,
      getSubtreePage: storeIdx.getSubtreePage,
      getBlockCreatedAt: storeIdx.getBlockCreatedAt,
      getUsernameByOwner: storeIdx.getUsernameByOwner,
      getPendingUtxoTxBytesByTxId: storeIdx.getPendingUtxoTxBytesByTxId,
      getUtxoTxTreeBytes: storeIdx.getUtxoTxTreeBytes,
    });

    const { decodeTx: decodeTx2, computePostId } = await import('@dagsocial/types');
    const r = feed.getPost(postId, null, true) as import('../../src/services/feed-service.js').PostJson;
    expect(r.status).toBe('pending');
    expect(r.txId).toBe(txId);
    expect(typeof r.tx).toBe('string');
    expect(r.tx).toBe(Buffer.from(txBytes).toString('hex'));
    const decoded = decodeTx2(new Uint8Array(Buffer.from(r.tx as string, 'hex')));
    expect(computeTxId(decoded)).toBe(txId);
    expect(computePostId(computeTxId(decoded), 0)).toBe(postId);
  });

  it('a reverted post whose re-insert is dropped stays pending with no pool entry, and answers tx: null', async () => {
    // The pool-full path: `reinsert` catches `MempoolFullError` and completes.
    // The dag_posts row stays — Phase 1's `unconfirmPost` only nulls
    // `block_height` — and the pool has no entry under its `tx_id`, so
    // `getPendingUtxoTxBytesByTxId` answers null and FeedService answers
    // `tx: null`.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = await importDb();
      db.initDb(':memory:');
      db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

      const author = makeTestIdentity();
      const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'reorg feed-service dropped');
      const txId = computeTxId(postTx);

      const posts = await importPosts();
      const mempool = await importMempoolFresh();
      mempool.setMempoolCap(1);
      const bc = await importBlockCreator();

      const occupier = await seededSelfSpend();

      posts.insertPost(postId, txId, commit, content);
      mempool.insertUtxoTx(postTx, 1000);
      bc.startBlockCreator(testConfig);
      await mineNextBlock(bc);
      expect(mempool.getPendingEntries(100)).toHaveLength(0);

      // Fill the pool so the reorg's re-insertion is dropped.
      mempool.insertUtxoTx(occupier, 1000);
      expect(mempool.getPendingEntries(100)).toHaveLength(1);

      const forkResolution = await importForkResolution();
      forkResolution.reorg(0, []);

      // The dag_posts row survives, pool has only the occupier (no entry under
      // the post's txId).
      const ordering = await importOrdering();
      expect(ordering.getCurrentHeight()).toBe(0);
      const storeIdx = await import('../../src/store/index.js');
      expect(storeIdx.getPendingUtxoTxBytesByTxId(txId)).toBeNull();

      const feedModule = await import('../../src/services/feed-service.js');
      const feed = new feedModule.FeedService({
        getPost: storeIdx.getPost,
        queryPostsPage: storeIdx.queryPostsPage,
        getLikeRecordCount: storeIdx.getLikeRecordCount,
        getDescendantCount: storeIdx.getDescendantCount,
        hasLikeRecord: storeIdx.hasLikeRecord,
        getAncestorsNearest: storeIdx.getAncestorsNearest,
        getSubtreePage: storeIdx.getSubtreePage,
        getBlockCreatedAt: storeIdx.getBlockCreatedAt,
        getUsernameByOwner: storeIdx.getUsernameByOwner,
        getPendingUtxoTxBytesByTxId: storeIdx.getPendingUtxoTxBytesByTxId,
        getUtxoTxTreeBytes: storeIdx.getUtxoTxTreeBytes,
      });

      const r = feed.getPost(postId, null, true) as import('../../src/services/feed-service.js').PostJson;
      expect(r.status).toBe('pending');
      expect(r.txId).toBe(txId);
      expect(r.tx).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('reorg re-inserts lowest height first — getPendingEntries holds the parent before the child', async () => {
    // NODE_INTERFACE → Block Journal. A parent tx at h=1 and its child at h=2,
    // reorg both away, getPendingEntries returns the parent first (lower rowid).
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const posts = await importPosts();
    const utxo = await importUtxo();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    const { decodeTx } = await import("@dagsocial/types");

    const liker = makeTestIdentity();
    // Two authors — NODE_INTERFACE → Karma transition rules → "An identity
    // holds at most two karma boxes".
    const authorA = makeTestIdentity();
    const authorB = makeTestIdentity();
    const startBox = makeKarmaBox(100n, liker.userId, 0);
    utxo.insertBox(startBox);

    // Two posts, seeded so the block confirms them at §8b.
    const { commit: cA, tx: postATx, postId: postAId, content: contentA } = await seedPostTx(authorA, 'reorg order a');
    const { commit: cB, tx: postBTx, postId: postBId, content: contentB } = await seedPostTx(authorB, 'reorg order b');
    posts.insertPost(postAId, computeTxId(postATx), cA, contentA);
    posts.insertPost(postBId, computeTxId(postBTx), cB, contentB);

    // Block 1: txA (like from startBox).
    const txA = makeLikeTx(liker, startBox, postAId, authorA.userId);
    const txAId = computeTxId(txA);
    mempool.insertUtxoTx(postATx, 1000);
    mempool.insertUtxoTx(txA, 1000);
    bc.startBlockCreator(testConfig);
    await mineNextBlock(bc);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(1);

    // Block 2: txB (like from txA's change box — depends on txA).
    mempool.insertUtxoTx(postBTx, 1000);
    const txB = makeLikeTx(liker, changeBoxOf(txA), postBId, authorB.userId);
    const txBId = computeTxId(txB);
    mempool.insertUtxoTx(txB, 1000);
    await mineNextBlock(bc);
    expect(ordering.getCurrentHeight()).toBe(2);

    // Reorg both away.
    bc.stopBlockCreator();
    const forkResolution = await importForkResolution();
    forkResolution.reorg(0, []);
    expect(ordering.getCurrentHeight()).toBe(0);

    // The pool holds both in ascending height order: txA (from h=1) before
    // txB (from h=2), because the reorg re-inserts lowest height first.
    const pending = mempool.getPendingEntries(100);
    const pooledIds = pending
      .filter(e => e.utxoTxBytes !== null)
      .map(e => computeTxId(decodeTx(e.utxoTxBytes!)));
    const aIdx = pooledIds.indexOf(txAId);
    const bIdx = pooledIds.indexOf(txBId);
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThanOrEqual(0);
    expect(aIdx).toBeLessThan(bIdx);
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
    posts.insertPost(postId, computeTxId(postTx), commit, content);
    mempool.insertUtxoTx(postTx, 1000);

    const liker = makeTestIdentity();
    const karmaBox = makeKarmaBox(100n, liker.userId, 0);
    utxo.insertBox(karmaBox);
    const likeTx = makeLikeTx(liker, karmaBox, postId, author.userId);
    mempool.insertUtxoTx(likeTx, 1000);

    bc.startBlockCreator(testConfig);
    await mineNextBlock(bc);
    expect(mempool.getPendingEntries(100)).toHaveLength(0);

    // An entry admitted since, spending the box the block's tx spent — a
    // well-formed spend, so the template the reorg rebuilds keeps it.
    const incumbent: UtxoTransaction = {
      inputs: [karmaBox.id!],
      outputs: [{ boxType: 'karma', value: karmaBox.value, createdAtBlock: 0, owner: liker.userId }],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(incumbent, liker.privateKey, hex(liker.userId));
    mempool.insertUtxoTx(incumbent, 1000);

    const forkResolution = await importForkResolution();
    expect(() => forkResolution.reorg(0, [])).not.toThrow();

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(0);

    // Identified by transaction id, because the block carried TWO transactions
    // and only one of them conflicts: the post's re-insert is the control that
    // makes the like's absence a drop rather than an empty re-insert path.
    const { decodeTx } = await import("@dagsocial/types");
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

    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    // Build 2 blocks, one post per author — NODE_INTERFACE → Karma
    // transition rules → "An identity holds at most two karma boxes".
    const seededPosts = [];
    for (let i = 0; i < 2; i++) seededPosts.push(await seedPostTx(makeTestIdentity(), `chain a ${i}`));
    for (const { commit, tx: postTx, postId, content } of seededPosts) {
      posts.insertPost(postId, computeTxId(postTx), commit, content);
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

    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    // Build 3 blocks, one post per author — NODE_INTERFACE → Karma
    // transition rules → "An identity holds at most two karma boxes".
    const seededPosts = [];
    for (let i = 0; i < 3; i++) seededPosts.push(await seedPostTx(makeTestIdentity(), `original ${i}`));
    for (const { commit, tx: postTx, postId, content } of seededPosts) {
      posts.insertPost(postId, computeTxId(postTx), commit, content);
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
    await revertChainTo(1);

    expect(ordering.getCurrentHeight()).toBe(1);

    // Now apply competing chain: blocks 2A, 3A (using same blocks for test simplicity)
    // In a real reorg, these would be different blocks from a peer
    // For the test, we apply the same blocks to verify the mechanism works
    const prefixHashes = await stagePrefix([block2!, block3!]);
    forkResolution.reorg(1, prefixHashes);

    expect(ordering.getCurrentHeight()).toBe(3);
    expect(ordering.getOrderingBlock(2)).not.toBeNull();
    expect(ordering.getOrderingBlock(3)).not.toBeNull();

    // Journals should exist for all 3 heights
    const journalStore = await importJournalStore();
    expect(journalStore.getBlockJournal(1)).not.toBeNull();
    expect(journalStore.getBlockJournal(2)).not.toBeNull();
    expect(journalStore.getBlockJournal(3)).not.toBeNull();

    // NODE_INTERFACE → Fork choice decides on verified headers → "A bound
    // block is staged, and applied from staging.": `reorg`'s in-transaction
    // `unstageBlock` on apply removes every staged row of the prefix.
    const headerTree = await import('../../src/store/header-tree.js');
    for (const hash of prefixHashes) {
      expect(headerTree.getStagedBlock(hash)).toBeNull();
    }
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

      const posts = await importPosts();
      const mempool = await importMempoolFresh();
      mempool.setMempoolCap(1);
      const bc = await importBlockCreator();
      bc.startBlockCreator(testConfig);

      // Two blocks, one post per author — NODE_INTERFACE → Karma transition
      // rules → "An identity holds at most two karma boxes". Each insert
      // sits alone in the pool (cap 1) and is consumed by its block.
      const occupier = await seededSelfSpend();
      const seededPosts = [];
      for (let i = 0; i < 2; i++) seededPosts.push(await seedPostTx(makeTestIdentity(), `full pool ${i}`));
      for (const { commit, tx: postTx, postId, content } of seededPosts) {
        posts.insertPost(postId, computeTxId(postTx), commit, content);
        mempool.insertUtxoTx(postTx, 1000);
        await mineNextBlock(bc);
      }

      const ordering = await importOrdering();
      expect(ordering.getCurrentHeight()).toBe(2);
      expect(mempool.getPendingEntries(100)).toHaveLength(0);

      // Fill the pool to its cap, so every re-insertion below is rejected.
      mempool.insertUtxoTx(occupier, 1000);
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

    const posts = await importPosts();
    const mempool = await importMempoolFresh();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    // Two blocks, one post per author — NODE_INTERFACE → Karma transition
    // rules → "An identity holds at most two karma boxes".
    const occupier = await seededSelfSpend();
    const seededPosts = [];
    for (let i = 0; i < 2; i++) seededPosts.push(await seedPostTx(makeTestIdentity(), `room in pool ${i}`));
    for (const { commit, tx: postTx, postId, content } of seededPosts) {
      posts.insertPost(postId, computeTxId(postTx), commit, content);
      mempool.insertUtxoTx(postTx, 1000);
      await mineNextBlock(bc);
    }

    mempool.insertUtxoTx(occupier, 1000);

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
    forkResolution.reorg(0, await stagePrefix(chain));
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
    const prefixHashes = await stagePrefix([goodB2, badB3]);
    expect(() => forkResolution.reorg(1, prefixHashes)).toThrow(
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

    // NODE_INTERFACE → Fork choice decides on verified headers → "A bound
    // block is staged, and applied from staging.": `reorg`'s in-transaction
    // `unstageBlock(hash)` runs inside the SQLite transaction, so a thrown
    // `ReorgBlockRejectedError` rolls both the unstage and the apply back —
    // every staged row of the prefix is still there, so the block ids
    // remain `wanted`.
    const headerTree = await import('../../src/store/header-tree.js');
    for (const hash of prefixHashes) {
      expect(headerTree.getStagedBlock(hash)).not.toBeNull();
    }
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
    const prefixHashes = await stagePrefix([goodB2, badB3]);
    expect(() => forkResolution.reorg(1, prefixHashes)).toThrow(
      'reorg rejected block at height 3',
    );

    expect(metrics.getDagTipHeight()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Tests — the ring under reorg (NODE_INTERFACE → "A proof at an older height
// restores a kept root"): the fork point's kept root is restored by reference
// where its digest is the store's version; a store resolve clears the ring;
// a reorg that aborts puts back the pair the apply funnel's `saved` names.
// ---------------------------------------------------------------------------

describe('reorg — the ring and the by-reference restore', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch { /* not imported */ }
    vi.resetModules();
  });

  async function setupFork() {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    await activateProverOverStore();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    // Height 1 — the fork point shared by both chains.
    await mineNextBlock(bc);
    // Height 2, 3 — their chain, built first so each commits to the state
    // standing when it was built, which post-revert is the fork state.
    const theirB2 = await makeApplicableBlock({ height: 2 });
    const { applyOrderingBlock } = await import('../../src/services/block-apply.js');
    expect(applyOrderingBlock(theirB2)).toBe(true);
    const theirB3 = await makeApplicableBlock({ height: 3 });
    expect(applyOrderingBlock(theirB3)).toBe(true);
    await revertChainTo(1);
    // Height 2, 3 — our chain, hand-built after revert so they chain-link to
    // the shared tip at 1.
    await mineNextBlock(bc);
    await mineNextBlock(bc);
    return { db, theirBlocks: [theirB2, theirB3] };
  }

  it('a fork point in the ring: restoreRoot by reference, zero rollbacks, kept roots below+at fork are the same objects, each new height\'s digest is its block\'s stateRoot', async () => {
    const { theirBlocks } = await setupFork();
    const { tryGetAvlProver } = await import('../../src/state/avl-prover.js');
    const avl = tryGetAvlProver()!;

    // The ring now holds genesis, our 1, our 2, our 3.
    const beforeHeights = ringHeights(avl.recentRoots);
    expect(beforeHeights).toContain(1);
    const forkKept = avl.recentRoots.get(1);
    expect(forkKept).not.toBeNull();
    const genesisKept = avl.recentRoots.get(0);
    expect(genesisKept).not.toBeNull();

    const storageSpy = vi.spyOn(avl.storage, 'rollback');
    const proverSpy = vi.spyOn(avl.prover, 'rollback');

    const forkResolution = await importForkResolution();
    forkResolution.reorg(1, await stagePrefix(theirBlocks));

    expect(storageSpy).not.toHaveBeenCalled();
    expect(proverSpy).not.toHaveBeenCalled();

    // Below and at the fork: same root objects as before, by reference.
    expect(avl.recentRoots.get(0)!.root).toBe(genesisKept!.root);
    expect(avl.recentRoots.get(1)!.root).toBe(forkKept!.root);
    // Above the fork: the new branch's heights are kept, each kept root's
    // digest is its block's stateRoot.
    for (const b of theirBlocks) {
      const kept = avl.recentRoots.get(b.header.height);
      expect(kept, `height ${b.header.height}`).not.toBeNull();
      expect(keptDigest(kept!), `height ${b.header.height}`).toBe(b.header.stateRoot);
    }
    // The tip's digest is the new tip's stateRoot.
    expect(bytesToHex(avl.prover.digest()!)).toBe(theirBlocks[theirBlocks.length - 1]!.header.stateRoot);
  });

  it('a fork point not in the ring: store resolve, ring emptied, then new blocks\' heights kept and each digest is its block\'s stateRoot', async () => {
    const { theirBlocks } = await setupFork();
    const { tryGetAvlProver } = await import('../../src/state/avl-prover.js');
    const avl = tryGetAvlProver()!;
    // Clear every entry below the tip so the fork point at height 1 is NOT
    // held — a node restarted since would see this ring shape.
    avl.recentRoots.drop(0);
    avl.recentRoots.drop(1);
    avl.recentRoots.drop(2);
    expect(ringHeights(avl.recentRoots)).toEqual([3]); // just the current tip

    const storageSpy = vi.spyOn(avl.storage, 'rollback');
    const forkResolution = await importForkResolution();
    forkResolution.reorg(1, await stagePrefix(theirBlocks));

    // One store resolve: `PersistentBatchAVLProver.rollback` calls
    // `storage.rollback` and then `inner.restoreRoot`.
    expect(storageSpy).toHaveBeenCalledTimes(1);

    // The ring was emptied at the resolve; the new blocks' heights are kept,
    // each kept root's digest its block's stateRoot.
    const heights = ringHeights(avl.recentRoots);
    for (const b of theirBlocks) {
      expect(heights).toContain(b.header.height);
      const kept = avl.recentRoots.get(b.header.height);
      expect(keptDigest(kept!), `height ${b.header.height}`).toBe(b.header.stateRoot);
    }
    expect(heights.filter((h) => h <= 1)).toEqual([]);
  });

  it('one node, both the by-reference and the store-resolve path run to completion over the same chain', async () => {
    // The funnel refuses a block whose stateRoot or adProofsRoot do not
    // match the header's, so returning from reorg on either path means
    // every carried block was applied and its proof stored under its
    // header's commitment. The pin here is that both paths LAND; the
    // tip-and-proofs comparison the funnel already holds.
    const { theirBlocks, db } = await setupFork();
    const { tryGetAvlProver } = await import('../../src/state/avl-prover.js');
    const avl = tryGetAvlProver()!;

    const forkResolution = await importForkResolution();
    // The first run: fork point in the ring (the by-reference path).
    forkResolution.reorg(1, await stagePrefix(theirBlocks));
    const tipA = bytesToHex(avl.prover.digest()!);
    for (const b of theirBlocks) {
      const row = db.getDb().prepare('SELECT proof FROM block_proofs WHERE height = ?').get(b.header.height) as { proof: Buffer } | undefined;
      expect(row, `by-reference path: block ${b.header.height} has a stored proof`).toBeDefined();
    }

    // The twin: revert, mine our chain again, drop every kept root but the
    // tip so the fork point is NOT held (the store-resolve path).
    await revertChainTo(1);
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    await mineNextBlock(bc);
    await mineNextBlock(bc);

    const heights = ringHeights(avl.recentRoots);
    for (const h of heights) if (h !== Math.max(...heights)) avl.recentRoots.drop(h);

    forkResolution.reorg(1, await stagePrefix(theirBlocks));
    const tipB = bytesToHex(avl.prover.digest()!);
    for (const b of theirBlocks) {
      const row = db.getDb().prepare('SELECT proof FROM block_proofs WHERE height = ?').get(b.header.height) as { proof: Buffer } | undefined;
      expect(row, `store-resolve path: block ${b.header.height} has a stored proof`).toBeDefined();
    }

    // The funnel's commitment already pins the tip and the proofs to the
    // headers' values. Both tips are theirBlocks' tip's stateRoot by that
    // commitment; the comparison here notes they agree.
    expect(tipA).toBe(theirBlocks[theirBlocks.length - 1]!.header.stateRoot);
    expect(tipB).toBe(theirBlocks[theirBlocks.length - 1]!.header.stateRoot);
  });

  it('an abort on the by-reference path: zero rollbacks, root objects preserved, the live root is the pre-reorg root object, next honest block applies and its stored proof equals a twin\'s', async () => {
    const { theirBlocks } = await setupFork();
    const { tryGetAvlProver } = await import('../../src/state/avl-prover.js');
    const avl = tryGetAvlProver()!;

    // The twin (no reorg): save our chain's tip stateRoot and compute what
    // the next honest block over it would produce.
    const twinTipStateRoot = bytesToHex(avl.prover.digest()!);
    const nextHonestBlock = await makeApplicableBlock({ height: 4 });

    // A doomed reorg: pass a block whose prevBlockHash is wrong, so the
    // chain-link check at the inner apply refuses it.
    const broken: typeof theirBlocks[0] = {
      ...theirBlocks[1]!,
      header: { ...theirBlocks[1]!.header, prevBlockHash: '00'.repeat(32) },
    };

    const beforeHeights = ringHeights(avl.recentRoots);
    const preReorgRoot = avl.prover.prover.root;
    const beforeByH: Record<number, unknown> = {};
    for (const h of beforeHeights) beforeByH[h] = avl.recentRoots.get(h)!.root;
    const nodesBeyondBefore = avl.recentRoots.nodesHeldBeyondTree();

    const storageSpy = vi.spyOn(avl.storage, 'rollback');
    const proverSpy = vi.spyOn(avl.prover, 'rollback');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const forkResolution = await importForkResolution();
    const prefixHashesForBroken = await stagePrefix([theirBlocks[0]!, broken]);
    expect(() => forkResolution.reorg(1, prefixHashesForBroken)).toThrow(
      /reorg rejected block/,
    );

    expect(storageSpy).not.toHaveBeenCalled();
    expect(proverSpy).not.toHaveBeenCalled();

    // The live root IS the pre-reorg root object (restored by reference).
    expect(avl.prover.prover.root).toBe(preReorgRoot);
    expect(bytesToHex(avl.prover.digest()!)).toBe(twinTipStateRoot);
    expect(ringHeights(avl.recentRoots)).toEqual(beforeHeights);
    for (const h of beforeHeights) {
      expect(avl.recentRoots.get(h)!.root, `height ${h}`).toBe(beforeByH[h]);
    }
    // The snapshot carries the counts, so the sum beyond the tree stands too
    // (NODE_INTERFACE → "The count is the store's").
    expect(avl.recentRoots.nodesHeldBeyondTree()).toBe(nodesBeyondBefore);

    // The next honest block applies, and its stored proof equals the twin's
    // — the one a node that never saw the reorg would have written.
    const { applyOrderingBlock } = await import('../../src/services/block-apply.js');
    expect(applyOrderingBlock(nextHonestBlock)).toBe(true);
    const { getBlockProof } = await import('../../src/store/block-proofs.js');
    const stored = getBlockProof(4);
    expect(stored).not.toBeNull();
    expect(bytesToHex(hash32(stored!))).toBe(nextHonestBlock.header.adProofsRoot);
  });

  it('a kept root that is not the store\'s version: reorg resolves from store, ring emptied, the result equals the twin\'s', async () => {
    const { theirBlocks } = await setupFork();
    const { tryGetAvlProver } = await import('../../src/state/avl-prover.js');
    const { newLeaf } = await import('@dagsocial/avltree');
    const avl = tryGetAvlProver()!;

    // Replace the ring's root at height 1 with a bogus leaf — a root whose
    // digest cannot be the store's version at that height.
    const bogus = newLeaf(
      new Uint8Array(65).fill(0x7f),
      Uint8Array.of(0xaa),
      new Uint8Array(65).fill(0xff),
    );
    avl.recentRoots.record(1, bogus, 1, 0);

    const storageSpy = vi.spyOn(avl.storage, 'rollback');
    const forkResolution = await importForkResolution();
    forkResolution.reorg(1, await stagePrefix(theirBlocks));

    // One store resolve happened — the bogus kept root did not match the
    // store's version, so the resolve went to the store and the ring was
    // emptied.
    expect(storageSpy).toHaveBeenCalledTimes(1);
    expect(avl.recentRoots.get(0)).toBeNull();
    expect(avl.recentRoots.get(1)).toBeNull();
    // The new blocks' heights are kept, each digest the block's stateRoot —
    // the tip's `stateRoot` is the new branch's.
    for (const b of theirBlocks) {
      const kept = avl.recentRoots.get(b.header.height);
      expect(kept, `height ${b.header.height}`).not.toBeNull();
      expect(keptDigest(kept!), `height ${b.header.height}`).toBe(b.header.stateRoot);
    }
    expect(bytesToHex(avl.prover.digest()!)).toBe(theirBlocks[theirBlocks.length - 1]!.header.stateRoot);
  });
});
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

      const posts = await importPosts();
      const mempool = await importMempoolFresh();
      const bc = await importBlockCreator();
      bc.startBlockCreator(testConfig);

      // Build 7 blocks, one post per author (NODE_INTERFACE → Karma
      // transition rules → "An identity holds at most two karma boxes").
      const seededPosts = [];
      for (let i = 0; i < 7; i++) seededPosts.push(await seedPostTx(makeTestIdentity(), `ceiling ${i}`));
      for (const { commit, tx: postTx, postId, content } of seededPosts) {
        posts.insertPost(postId, computeTxId(postTx), commit, content);
        mempool.insertUtxoTx(postTx, 1000);
        await mineNextBlock(bc);
      }

      const ordering = await importOrdering();
      expect(ordering.getCurrentHeight()).toBe(7);

      // Inject a vouch tx with createdAtBlock = 1 (ceiling = 6) into block 1's journal
      await injectCeilingTx(1, ceilingTx(1));

      const chain = Array.from({ length: 7 }, (_, i) => ordering.getOrderingBlock(i + 1)!);
      const forkResolution = await importForkResolution();
      forkResolution.reorg(0, await stagePrefix(chain));

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

      const posts = await importPosts();
      const mempool = await importMempoolFresh();
      const bc = await importBlockCreator();
      bc.startBlockCreator(testConfig);

      // Build 6 blocks, one post per author (NODE_INTERFACE → Karma
      // transition rules → "An identity holds at most two karma boxes").
      const seededPosts = [];
      for (let i = 0; i < 6; i++) seededPosts.push(await seedPostTx(makeTestIdentity(), `no-screen ${i}`));
      for (const { commit, tx: postTx, postId, content } of seededPosts) {
        posts.insertPost(postId, computeTxId(postTx), commit, content);
        mempool.insertUtxoTx(postTx, 1000);
        await mineNextBlock(bc);
      }

      const ordering = await importOrdering();
      expect(ordering.getCurrentHeight()).toBe(6);

      // Inject a vouch tx with createdAtBlock = 1 (ceiling = 6) into block 1's journal
      await injectCeilingTx(1, ceilingTx(1));

      const chain = Array.from({ length: 6 }, (_, i) => ordering.getOrderingBlock(i + 1)!);
      const forkResolution = await importForkResolution();
      forkResolution.reorg(0, await stagePrefix(chain));

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

      const posts = await importPosts();
      const mempool = await importMempoolFresh();
      const bc = await importBlockCreator();
      bc.startBlockCreator(testConfig);

      // Build 7 blocks, one post per author (NODE_INTERFACE → Karma
      // transition rules → "An identity holds at most two karma boxes").
      const seededPosts = [];
      for (let i = 0; i < 7; i++) seededPosts.push(await seedPostTx(makeTestIdentity(), `null-ceiling ${i}`));
      for (const { commit, tx: postTx, postId, content } of seededPosts) {
        posts.insertPost(postId, computeTxId(postTx), commit, content);
        mempool.insertUtxoTx(postTx, 1000);
        await mineNextBlock(bc);
      }

      const ordering = await importOrdering();
      const chain = Array.from({ length: 7 }, (_, i) => ordering.getOrderingBlock(i + 1)!);
      const forkResolution = await importForkResolution();
      forkResolution.reorg(0, await stagePrefix(chain));

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
// Re-insertion floor pin — row 167-1 (NODE_INTERFACE → Validity ceiling:
// "Re-insertion screens the ceiling and not the floor"). A reorg onto a
// shorter, heavier branch re-inserts a credit tx whose input's
// `lockedUntilBlock` is above the new tip; the tx sits in the pool, the
// next build evicts it (the rejected-body loop), and the node holds a
// template afterwards (no fork, no stall).
// ---------------------------------------------------------------------------

describe('reorg — re-insertion floor pin (row 167-1)', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch { /* not imported */ }
    vi.resetModules();
  });

  it('a locked credit tx re-inserted by a reorg to a shorter chain sits in the pool and is evicted by the next build', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const db = await importDb();
      db.initDb(':memory:');
      db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

      const author = makeTestIdentity();
      const posts = await importPosts();
      const mempool = await importMempoolFresh();
      const utxo = await importUtxo();
      const forkResolution = await importForkResolution();
      const bc = await importBlockCreator();

      // Seed karma boxes before the prover: a box entering the store
      // after the bootstrap is absent from the tree
      // (NODE_INTERFACE → AVL+ State Root). One post per author so each
      // identity holds one own karma box (NODE_INTERFACE → Karma transition
      // rules → "An identity holds at most two karma boxes").
      const postFixtures = [];
      for (let i = 0; i < 6; i++) {
        postFixtures.push(await seedPostTx(makeTestIdentity(), `floor ${i}`));
      }

      await activateProverOverStore();
      bc.startBlockCreator(testConfig);
      const ordering = await importOrdering();

      // Build 6 blocks.
      for (let i = 0; i < 6; i++) {
        const { commit, tx: postTx, postId, content } = postFixtures[i]!;
        posts.insertPost(postId, computeTxId(postTx), commit, content);
        mempool.insertUtxoTx(postTx, 1000);
        await mineNextBlock(bc);
      }
      expect(ordering.getCurrentHeight()).toBe(6);

      // A CreditBox locked until 6 (NODE_INTERFACE → Spend timing).
      const creditOwner = author.publicKey;
      const { computeCandidateBoxId } = await import('@dagsocial/types');
      const lockedCandidate = {
        boxType: 'credit' as const,
        value: 100n,
        owner: creditOwner,
        createdAtBlock: 3,
        lockedUntilBlock: 6,
      };
      const provTxId = 'cc'.repeat(32);
      const boxId = computeCandidateBoxId(lockedCandidate, provTxId, 0);
      utxo.insertBox({ ...lockedCandidate, id: boxId, txId: provTxId, index: 0 });

      // A credit → credit spend of the locked box.
      const floorTx: UtxoTransaction = {
        inputs: [boxId],
        outputs: [
          { boxType: 'credit', value: 100n, owner: creditOwner, createdAtBlock: 6, lockedUntilBlock: 0 },
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };
      signTransaction(floorTx, author.privateKey, hex(creditOwner));

      // Inject into block 5's journal for re-insertion on reorg.
      const journalMod = await import('../../src/store/journal.js');
      const journal5 = journalMod.getBlockJournal(5);
      if (!journal5) throw new Error('no journal at height 5');
      journal5.appliedUtxoTxs.push({ txId: 'floor-test-tx', txBytes: encodeTx(floorTx) });
      journalMod.insertBlockJournal(journal5);

      const { decodeTx: decode } = await import('@dagsocial/types');
      const findLocked = (entries: Array<{ utxoTxBytes: Uint8Array | null }>) =>
        entries.find(e => {
          if (!e.utxoTxBytes) return false;
          const tx = decode(e.utxoTxBytes);
          return tx.inputs.includes(boxId);
        });

      // Revert blocks 5 and 6: new tip = 4. The locked tx from height
      // 5's journal is re-inserted into the pool
      // (NODE_INTERFACE → Validity ceiling).
      warn.mockClear();
      forkResolution.reorg(4, []);
      expect(ordering.getCurrentHeight()).toBe(4);

      // Re-insertion screens the ceiling and not the floor
      // (NODE_INTERFACE → Validity ceiling): the locked tx enters the pool,
      // the build at height 5 speculates, `validateTx` step 3 refuses
      // (5 < lockedUntilBlock 6), the body is rejected, and the
      // rejected-body loop evicts the entry
      // (MINING_INTERFACE → Template and submit).
      const warns = warn.mock.calls.map(c => String(c[0]));
      expect(
        warns.some(w => w.includes('speculation returned body-rejected')),
        'the eviction warn fires',
      ).toBe(true);
      expect(findLocked(mempool.getPendingEntries(1000)), 'the locked tx is evicted from the pool').toBeUndefined();
      const template = bc.getCurrentTemplate();
      expect(template, 'the node holds a template after the build (no stall)').not.toBeNull();
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

