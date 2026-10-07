import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BatchAVLVerifier } from '@dagsocial/avltree';
import { MAX_BLOCK_BODY_BYTES, TREE_KEY_LENGTH, boxKey, bytesToHex, hash32, hexToBytes } from '@dagsocial/types';
import type { OrderingBlock } from '@dagsocial/types';
import { applyBlock, treeStateView, treeWritesOf, verifierSession } from '@dagsocial/consensus';
import type { ApplyContext, BlockEffects, TreeLookup, TreeSession, TreeWrite } from '@dagsocial/consensus';
import type { Config } from '../../src/config.js';
import {
  liveProver,
  makeApplicableBlock,
  makeCreditBox,
  makeCreditTx,
  makeTestConfig,
  makeTestIdentity,
  mineNextBlock,
  revertChainTo,
} from '../helpers.js';

/**
 * The block proof (NODE_INTERFACE → The block proof; CONSENSUS_INTERFACE → The
 * block proof): block application and the speculative run read through a
 * recording session, so the proof the prover makes for a block covers the
 * block's reads, then its writes — the same list on the producer and on every
 * node that applies it, and one a verifier replays from the parent's digest.
 * Apply stores it with its block, a revert deletes it, and apply prunes it
 * below `tip − PROOF_RETENTION_BLOCKS`.
 */

const TREE_CONFIG = { keyLength: TREE_KEY_LENGTH, valueLengthOpt: null };

async function freshStore() {
  const db = await import('../../src/store/db.js');
  db.initDb(':memory:');
  db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
  return db;
}

async function blockApply() {
  return import('../../src/services/block-apply.js');
}

async function storedProof(height: number): Promise<Uint8Array | null> {
  return (await import('../../src/store/block-proofs.js')).getBlockProof(height);
}

/** Every table of the store as its rows, each table's in a fixed order — the store as a value. */
async function storeSnapshot(): Promise<Record<string, string[]>> {
  const db = (await import('../../src/store/db.js')).getDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
  const snapshot: Record<string, string[]> = {};
  for (const { name } of tables) {
    const rows = db.prepare(`SELECT * FROM "${name}"`).safeIntegers().all() as Record<string, unknown>[];
    snapshot[name] = rows
      .map((row) => JSON.stringify(row, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)))
      .sort();
  }
  return snapshot;
}

/** The rules' context as block application builds it. */
async function nodeCtx(): Promise<ApplyContext> {
  const { applyContextFrom } = await blockApply();
  const { config } = await import('../../src/config.js');
  return applyContextFrom(config);
}

/** A sender holding two credit boxes in the store, ahead of the tree built over it. */
async function seededSender() {
  const utxo = await import('../../src/store/utxo.js');
  const sender = makeTestIdentity();
  const boxes = [makeCreditBox(100_000n, sender.userId, 0, 1), makeCreditBox(50_000n, sender.userId, 0, 2)];
  for (const box of boxes) utxo.insertBox(box);
  return { sender, boxes };
}

/** `inner`, logging every key it is asked, as hex, in order. */
function logging(inner: TreeSession): TreeSession & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    lookup(key: Uint8Array): TreeLookup {
      keys.push(bytesToHex(key));
      return inner.lookup(key);
    },
  };
}

/**
 * The block run from its parent's digest and a proof alone
 * (CONSENSUS_INTERFACE → The tree session): the rules over `verifierSession`,
 * the writes derived over the same view and performed on the verifier.
 */
function replay(
  parent: Uint8Array,
  proof: Uint8Array,
  block: OrderingBlock,
  ctx: ApplyContext,
): { effects: BlockEffects; digest: string; reads: string[]; writes: TreeWrite[] } {
  const verifier = new BatchAVLVerifier(parent, proof, TREE_CONFIG);
  const session = logging(verifierSession(verifier));
  const view = treeStateView(session);
  const result = applyBlock(view, block, ctx);
  if (!result.ok) throw new Error(`the replay refused the block: ${result.reason}`);
  const writes = treeWritesOf(result.effects, block.header.height, view);
  for (const write of writes) {
    if (!verifier.performOneOperation(write).success) {
      throw new Error(`the proof refuses ${write.tag} of ${bytesToHex(write.key)}: ${verifier.getLastFailReason()}`);
    }
  }
  const digest = verifier.digest();
  if (digest === null) throw new Error(`the verifier is poisoned: ${verifier.getLastFailReason()}`);
  return { effects: result.effects, digest: bytesToHex(digest), reads: session.keys, writes };
}

describe('the block proof', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(async () => {
    (await import('../../src/services/block-creator.js')).stopBlockCreator();
    vi.doUnmock('../../src/services/block-apply.js');
    vi.doUnmock('../../src/store/journal.js');
    vi.doUnmock('../../src/config.js');
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('the speculation answers the block\'s proof beside its stateRoot — adProofsRoot its hash32 — and a verifier replays it from the parent\'s digest to that root', async () => {
    await freshStore();
    const { sender, boxes } = await seededSender();
    const handle = await liveProver();
    const parent = handle.prover.digest();
    const block = await makeApplicableBlock({ utxoTxs: [makeCreditTx(sender, [boxes[0]!], 10_000n)] });
    const { computePostBlockStateRoot } = await blockApply();

    const speculation = computePostBlockStateRoot(block, handle);

    expect(speculation.kind).toBe('computed');
    if (speculation.kind !== 'computed') return;
    expect(speculation.stateRoot).toBe(block.header.stateRoot);
    expect(speculation.proof).toBeInstanceOf(Uint8Array);
    expect(speculation.adProofsRoot).toBe(bytesToHex(hash32(speculation.proof)));
    const ctx = await nodeCtx();
    const replayed = replay(parent, speculation.proof, block, ctx);
    expect(replayed.digest).toBe(block.header.stateRoot);
    // The same effects the rules answer over the prover itself.
    const { proverSession } = await import('../../src/state/prover-session.js');
    const overProver = applyBlock(treeStateView(proverSession(handle.prover)), block, ctx);
    expect(overProver.ok).toBe(true);
    if (overProver.ok) expect(replayed.effects).toEqual(overProver.effects);
  });

  it('the proof apply stores for a block is the one its checkpoint made and the speculation made, byte for byte', async () => {
    await freshStore();
    const { sender, boxes } = await seededSender();
    const handle = await liveProver();
    const block = await makeApplicableBlock({
      utxoTxs: [makeCreditTx(sender, [boxes[0]!], 10_000n), makeCreditTx(sender, [boxes[1]!], 5_000n)],
    });
    const { computePostBlockStateRoot, applyOrderingBlock } = await blockApply();
    const speculation = computePostBlockStateRoot(block, handle);
    if (speculation.kind !== 'computed') throw new Error(`the speculation answered ${speculation.kind}`);

    const checkpoint = vi.spyOn(handle.prover, 'generateProofAndUpdateStorage');
    expect(applyOrderingBlock(block)).toBe(true);

    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(checkpoint.mock.results[0]!.value).toEqual(speculation.proof);
    expect(await storedProof(1)).toEqual(speculation.proof);
  });

  it('a verifier replays the stored proof from the parent\'s digest: the rules answer the block\'s effects and reach its stateRoot', async () => {
    await freshStore();
    const { sender, boxes } = await seededSender();
    const handle = await liveProver();
    const parent = handle.prover.digest();
    const block = await makeApplicableBlock({ utxoTxs: [makeCreditTx(sender, [boxes[0]!], 10_000n)] });
    const ctx = await nodeCtx();
    const { proverSession } = await import('../../src/state/prover-session.js');
    const overProver = applyBlock(treeStateView(proverSession(handle.prover)), block, ctx);
    if (!overProver.ok) throw new Error(overProver.reason);
    const { applyOrderingBlock } = await blockApply();
    expect(applyOrderingBlock(block)).toBe(true);

    const replayed = replay(parent, (await storedProof(1))!, block, ctx);
    expect(replayed.effects).toEqual(overProver.effects);
    expect(replayed.digest).toBe(block.header.stateRoot);
  });

  it('a coinbase-only block\'s proof is not an empty cycle\'s, and replays to its stateRoot', async () => {
    await freshStore();
    const handle = await liveProver();
    const parent = handle.prover.digest();
    // A proof made at the boundary the bootstrap left covers no operation.
    const empty = handle.prover.prover.generateProof();
    const block = await makeApplicableBlock();
    const { applyOrderingBlock } = await blockApply();
    expect(applyOrderingBlock(block)).toBe(true);

    const proof = (await storedProof(1))!;
    expect(proof.length).toBeGreaterThan(empty.length);
    expect(replay(parent, proof, block, await nodeCtx()).digest).toBe(block.header.stateRoot);
  });

  it('a block that reads a key and then writes it proves both, the read first', async () => {
    await freshStore();
    const { sender, boxes } = await seededSender();
    const handle = await liveProver();
    const parent = handle.prover.digest();
    const spent = bytesToHex(boxKey(hexToBytes(boxes[0]!.id!)));
    const block = await makeApplicableBlock({ utxoTxs: [makeCreditTx(sender, [boxes[0]!], 10_000n)] });
    const { applyOrderingBlock } = await blockApply();
    expect(applyOrderingBlock(block)).toBe(true);
    const proof = (await storedProof(1))!;

    // The spent box is among the block's reads and among its writes, and the
    // proof answers them in that order.
    const replayed = replay(parent, proof, block, await nodeCtx());
    expect(replayed.reads).toContain(spent);
    expect(replayed.writes.some((write) => write.tag === 'Remove' && bytesToHex(write.key) === spent)).toBe(true);
    // The writes alone, without the reads before them, are not what it proves.
    const writesAlone = new BatchAVLVerifier(parent, proof, TREE_CONFIG);
    const refused = replayed.writes.some((write) => !writesAlone.performOneOperation(write).success);
    const reached = writesAlone.digest();
    expect(refused || reached === null || bytesToHex(reached) !== block.header.stateRoot).toBe(true);
  });

  it('a block the funnel refuses leaves none of its recorded reads in the prover\'s proof cycle, and stores no proof', async () => {
    await freshStore();
    const { sender, boxes } = await seededSender();
    const handle = await liveProver();
    const good = await makeApplicableBlock({ utxoTxs: [makeCreditTx(sender, [boxes[0]!], 10_000n)] });
    const { computePostBlockStateRoot, applyOrderingBlockVerdict } = await blockApply();
    const before = computePostBlockStateRoot(good, handle);
    if (before.kind !== 'computed') throw new Error(`the speculation answered ${before.kind}`);
    expect(before.proof).toBeInstanceOf(Uint8Array);

    // A body the rules refuse after reading the tree: it spends a box the tree
    // does not hold, which the rules read before they refuse it.
    const stranger = makeTestIdentity();
    const unseeded = makeCreditBox(7_000n, stranger.userId, 0, 99);
    const refused = await makeApplicableBlock({ utxoTxs: [makeCreditTx(stranger, [unseeded], 1_000n)] });
    expect(applyOrderingBlockVerdict(refused)).toEqual({ applied: false, class: 'consensus' });
    expect(await storedProof(1)).toBeNull();

    const after = computePostBlockStateRoot(good, handle);
    if (after.kind !== 'computed') throw new Error(`the speculation answered ${after.kind}`);
    expect(after.proof).toEqual(before.proof);
  });

  it('a block whose adProofsRoot is not its proof\'s is refused: it stores no proof, and the store and the prover are as they were', async () => {
    await freshStore();
    const { sender, boxes } = await seededSender();
    const handle = await liveProver();
    const miner = makeTestIdentity();
    const tx = makeCreditTx(sender, [boxes[0]!], 10_000n);
    const honest = await makeApplicableBlock({ miner, utxoTxs: [tx] });
    // The same body committing to another proof, its header re-mined and re-signed.
    const altered = await makeApplicableBlock({
      miner,
      utxoTxs: [tx],
      adProofsRoot: bytesToHex(hash32(hexToBytes(honest.header.adProofsRoot))),
    });
    expect(altered.header.stateRoot).toBe(honest.header.stateRoot);
    expect(altered.header.adProofsRoot).not.toBe(honest.header.adProofsRoot);

    const { applyOrderingBlockVerdict } = await blockApply();
    const store = await storeSnapshot();
    const { root, height } = handle.prover.prover;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(applyOrderingBlockVerdict(altered)).toEqual({ applied: false, class: 'consensus' });
    expect(warn.mock.calls.some(([line]) => String(line).startsWith('adProofsRoot mismatch at height 1'))).toBe(true);
    expect(await storedProof(1)).toBeNull();
    expect(await storeSnapshot()).toEqual(store);
    expect(handle.prover.prover.root).toBe(root);
    expect(handle.prover.prover.height).toBe(height);

    // The prover's proof cycle is where the refused block found it: the honest
    // block applies, and the proof it stores is the one its header names.
    expect(applyOrderingBlockVerdict(honest)).toEqual({ applied: true });
    expect(bytesToHex(hash32((await storedProof(1))!))).toBe(honest.header.adProofsRoot);
  });

  it('is stored in the apply transaction: a block that fails after its checkpoint leaves no proof', async () => {
    await freshStore();
    vi.doMock('../../src/store/journal.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/store/journal.js')>();
      return {
        ...actual,
        insertBlockJournal: () => {
          throw new Error('injected: the journal write fails after the proof is put');
        },
      };
    });
    const block = await makeApplicableBlock();
    const { applyOrderingBlockVerdict } = await blockApply();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(applyOrderingBlockVerdict(block)).toMatchObject({ applied: false, class: 'local' });
    expect(await storedProof(1)).toBeNull();
  });

  it('a revert deletes the proof with its block', async () => {
    await freshStore();
    const block = await makeApplicableBlock();
    const { applyOrderingBlock } = await blockApply();
    expect(applyOrderingBlock(block)).toBe(true);
    expect(await storedProof(1)).not.toBeNull();

    await revertChainTo(0);
    expect(await storedProof(1)).toBeNull();
  });

  it('keeps the proofs at and above tip − PROOF_RETENTION_BLOCKS, and none below', async () => {
    vi.doMock('../../src/config.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/config.js')>();
      return { ...actual, config: Object.freeze({ ...actual.config, proofRetentionBlocks: 2 }) };
    });
    await freshStore();
    const { applyOrderingBlock } = await blockApply();
    const held: number[][] = [];
    for (let height = 1; height <= 5; height++) {
      expect(applyOrderingBlock(await makeApplicableBlock({ height }))).toBe(true);
      const heights: number[] = [];
      for (let h = 1; h <= height; h++) if ((await storedProof(h)) !== null) heights.push(h);
      held.push(heights);
    }
    expect(held).toEqual([[1], [1, 2], [1, 2, 3], [2, 3, 4], [3, 4, 5]]);
  });

  // NODE_INTERFACE → The block proof: PROOF_RETENTION_BYTES, the byte cap
  // apply prunes against after the height-based prune — the tighter of the
  // two settings wins, and the tip's proof is kept whatever either says.
  describe('the byte cap', () => {
    /**
     * What the byte-cap prune keeps: the newest-by-height proofs whose
     * cumulative length is at most `capBytes`, plus the tip regardless of its
     * own length — recomputed independently of `pruneBlockProofsByBytes`,
     * from sizes measured after each real apply, as the check on its
     * arithmetic. Sound against the implementation's incremental deletion:
     * a row's inclusion depends only on the sizes of rows newer than it, so
     * recomputing from every size seen so far — even one a prior round
     * already deleted — answers the same as the incremental process did.
     */
    function heldUnderCap(sizes: Map<number, number>, capBytes: number): number[] {
      const newest = [...sizes.keys()].sort((a, b) => b - a);
      const held: number[] = [];
      let total = 0;
      for (let i = 0; i < newest.length; i++) {
        const height = newest[i]!;
        const len = sizes.get(height)!;
        if (i > 0 && total + len > capBytes) break;
        total += len;
        held.push(height);
      }
      return held.sort((a, b) => a - b);
    }

    it('keeps the newest proofs whose total length fits PROOF_RETENTION_BYTES, and none older — the cap tighter than PROOF_RETENTION_BLOCKS', async () => {
      let mockConfig!: Config;
      vi.doMock('../../src/config.js', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../src/config.js')>();
        mockConfig = { ...actual.config, proofRetentionBytes: 0 };
        return { ...actual, config: mockConfig };
      });
      await freshStore();
      const { applyOrderingBlock } = await blockApply();

      const sizes = new Map<number, number>();
      const held: number[][] = [];
      const expected: number[][] = [];
      for (let height = 1; height <= 5; height++) {
        expect(applyOrderingBlock(await makeApplicableBlock({ height }))).toBe(true);
        sizes.set(height, (await storedProof(height))!.length);
        if (height === 1) {
          // Sized off the first block's real proof: comfortably two of them,
          // not three, whatever the exact AVL encoding gives.
          mockConfig.proofRetentionBytes = sizes.get(1)! * 2 + 1;
        }
        expected.push(heldUnderCap(sizes, mockConfig.proofRetentionBytes));
        const heights: number[] = [];
        for (let h = 1; h <= height; h++) if ((await storedProof(h)) !== null) heights.push(h);
        held.push(heights);
      }
      expect(held).toEqual(expected);
      // The cap bound something — otherwise this test would prove nothing.
      expect(held[4]!.length).toBeLessThan(5);
    });

    it('the tighter setting the other way: a tight PROOF_RETENTION_BLOCKS prunes by height when the byte cap would not', async () => {
      vi.doMock('../../src/config.js', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../src/config.js')>();
        return {
          ...actual,
          config: Object.freeze({ ...actual.config, proofRetentionBlocks: 2, proofRetentionBytes: 1_000_000_000 }),
        };
      });
      await freshStore();
      const { applyOrderingBlock } = await blockApply();
      const held: number[][] = [];
      for (let height = 1; height <= 5; height++) {
        expect(applyOrderingBlock(await makeApplicableBlock({ height }))).toBe(true);
        const heights: number[] = [];
        for (let h = 1; h <= height; h++) if ((await storedProof(h)) !== null) heights.push(h);
        held.push(heights);
      }
      expect(held).toEqual([[1], [1, 2], [1, 2, 3], [2, 3, 4], [3, 4, 5]]);
    });

    it('a revert after a prune by bytes: what the cap already removed stays gone, and the revert deletes what it had kept', async () => {
      let mockConfig!: Config;
      vi.doMock('../../src/config.js', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../src/config.js')>();
        mockConfig = { ...actual.config, proofRetentionBytes: 0 };
        return { ...actual, config: mockConfig };
      });
      await freshStore();
      const { applyOrderingBlock } = await blockApply();

      for (let height = 1; height <= 5; height++) {
        expect(applyOrderingBlock(await makeApplicableBlock({ height }))).toBe(true);
        if (height === 1) mockConfig.proofRetentionBytes = (await storedProof(1))!.length * 2 + 1;
      }
      const heights = [1, 2, 3, 4, 5];
      const before = await Promise.all(heights.map((h) => storedProof(h)));
      expect(before.some((proof) => proof === null)).toBe(true);
      expect(before[4]).not.toBeNull(); // the tip survives the cap

      await revertChainTo(0);

      for (const h of heights) expect(await storedProof(h)).toBeNull();
    });
  });

  it('the proof of a block the creator produced is the one its template\'s speculation made', async () => {
    // Every speculation the creator runs, kept.
    const made: Array<{ stateRoot: string; proof: Uint8Array }> = [];
    vi.doMock('../../src/services/block-apply.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/services/block-apply.js')>();
      return {
        ...actual,
        computePostBlockStateRoot: (...args: Parameters<typeof actual.computePostBlockStateRoot>) => {
          const speculation = actual.computePostBlockStateRoot(...args);
          if (speculation.kind === 'computed') made.push(speculation);
          return speculation;
        },
      };
    });
    await freshStore();
    const { sender, boxes } = await seededSender();
    const mempool = await import('../../src/store/mempool.js');
    mempool.insertUtxoTx(makeCreditTx(sender, [boxes[0]!], 10_000n), 1000);
    mempool.insertUtxoTx(makeCreditTx(sender, [boxes[1]!], 5_000n), 1000);
    await liveProver();
    const bc = await import('../../src/services/block-creator.js');
    const testConfig: Config = makeTestConfig({ nodeRole: 'miner', blockBodyBudgetBytes: MAX_BLOCK_BODY_BYTES });
    bc.startBlockCreator(testConfig);

    const mined = await mineNextBlock(bc);
    expect(mined).not.toBeNull();
    expect(mined!.utxoTxTree.utxoTxIds).toHaveLength(3);
    // The height-1 builds' speculations — the applied block rebuilt the
    // template for height 2 after it, which is not this block's.
    const forMined = made.filter((speculation) => speculation.stateRoot === mined!.header.stateRoot);
    expect(forMined.length).toBeGreaterThan(0);
    const stored = await storedProof(1);
    for (const speculation of forMined) expect(stored).toEqual(speculation.proof);
  });

  it('a block the creator produces commits to its proof: its adProofsRoot is hash32 of the proof its apply stores', async () => {
    await freshStore();
    const { sender, boxes } = await seededSender();
    const mempool = await import('../../src/store/mempool.js');
    mempool.insertUtxoTx(makeCreditTx(sender, [boxes[0]!], 10_000n), 1000);
    await liveProver();
    const bc = await import('../../src/services/block-creator.js');
    bc.startBlockCreator(makeTestConfig({ nodeRole: 'miner', blockBodyBudgetBytes: MAX_BLOCK_BODY_BYTES }));

    const mined = await mineNextBlock(bc);
    expect(mined).not.toBeNull();
    expect(mined!.utxoTxTree.utxoTxIds).toHaveLength(2);
    const stored = await storedProof(1);
    expect(stored).not.toBeNull();
    expect(mined!.header.adProofsRoot).toBe(bytesToHex(hash32(stored!)));
  });
});
