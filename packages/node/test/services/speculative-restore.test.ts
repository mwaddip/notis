import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyBlock, treeStateView, treeWritesOf } from '@dagsocial/consensus';
import { bytesToHex } from '@dagsocial/types';
import { activateProverOverStore, makeApplicableBlock } from '../helpers.js';

// The speculative run puts the prover's in-memory root and height back by
// reference when it ends, and neither reads nor writes storage (NODE_INTERFACE →
// Post-block stateRoot): the library never mutates a node, so the saved root is
// the whole tree the run started from.

async function freshStore() {
  const db = await import('../../src/store/db.js');
  db.initDb(':memory:');
  db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
  return db;
}

describe('the speculative run restores the prover by reference', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('leaves the digest, the root and the height as it found them, and never touches the storage', async () => {
    const db = await freshStore();
    const handle = await activateProverOverStore();
    const rollback = vi.spyOn(handle.storage, 'rollback');
    const update = vi.spyOn(handle.storage, 'update');
    const rows = (): unknown[] => [
      db.getDb().prepare('SELECT COUNT(*) AS n FROM avl_tree_nodes').get(),
      db.getDb().prepare('SELECT COUNT(*) AS n FROM avl_tree_versions').get(),
    ];
    const rowsBefore = rows();
    const root = handle.prover.prover.root;
    const height = handle.prover.prover.height;
    const digest = bytesToHex(handle.prover.digest());

    // The helper speculates on the live prover for the header's root.
    const block = await makeApplicableBlock();

    // The run moved the tree: the root it answered is not the one it started on.
    expect(block.header.stateRoot).not.toBe(digest);
    expect(rollback).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(rows()).toEqual(rowsBefore);
    expect(handle.prover.prover.root).toBe(root);
    expect(handle.prover.prover.height).toBe(height);
    expect(bytesToHex(handle.prover.digest())).toBe(digest);
  });

  it('leaves the proof cycle as it found it: its own proof is taken before the restore, and nothing of the run is left to prove', async () => {
    await freshStore();
    const handle = await activateProverOverStore();
    const inner = handle.prover.prover;
    // A proof made at the boundary the bootstrap left covers no operation.
    const empty = inner.generateProof();

    const block = await makeApplicableBlock();
    const { computePostBlockStateRoot } = await import('../../src/services/block-apply.js');
    const speculation = computePostBlockStateRoot(block, handle);

    expect(speculation.kind).toBe('computed');
    if (speculation.kind !== 'computed') return;
    // The block's reads and writes are in its proof, and in no later one.
    expect(speculation.proof).toBeInstanceOf(Uint8Array);
    expect(speculation.proof.length).toBeGreaterThan(empty.length);
    expect(inner.oldTopNode).toBe(inner.root);
    expect(inner.generateProof()).toEqual(empty);
  });

  it('the next applied block\'s root is the one a prover no run has touched computes', async () => {
    const db = await freshStore();
    const handle = await activateProverOverStore();

    // A candidate speculated on and never applied, then the block that is: each
    // call mines to a fresh identity, so the two bodies differ.
    const discarded = await makeApplicableBlock();
    const next = await makeApplicableBlock();
    expect(next.header.stateRoot).not.toBe(discarded.header.stateRoot);

    // A second prover over the same storage, loaded from the stored version.
    const { createAvlProver, performTreeWrites } = await import('../../src/state/avl-prover.js');
    const { proverSession } = await import('../../src/state/prover-session.js');
    const { applyContextFrom, applyOrderingBlock } = await import('../../src/services/block-apply.js');
    const { config } = await import('../../src/config.js');
    const untouched = createAvlProver(db.getDb());
    const view = treeStateView(proverSession(untouched.prover));
    const result = applyBlock(view, next, applyContextFrom(config));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expected = bytesToHex(
      performTreeWrites(untouched.prover, 1, treeWritesOf(result.effects, 1, view), 'untouched'),
    );

    expect(next.header.stateRoot).toBe(expected);
    expect(applyOrderingBlock(next)).toBe(true);
    expect(bytesToHex(handle.prover.digest())).toBe(expected);
  });
});
