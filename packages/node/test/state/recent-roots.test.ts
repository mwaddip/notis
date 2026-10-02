import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AvlNode } from '@ergots/avltree';
import { newLeaf } from '@ergots/avltree';
import { bytesToHex } from '@dagsocial/types';
import { RecentRoots } from '../../src/state/recent-roots.js';

// ---------------------------------------------------------------------------
// Unit — the class (NODE_INTERFACE → "A proof at an older height restores a
// kept root")
// ---------------------------------------------------------------------------

function dummyLeaf(seed: number): AvlNode {
  const key = new Uint8Array(65);
  key[0] = seed;
  const value = new Uint8Array([seed]);
  const nextKey = new Uint8Array(65).fill(0xff);
  return newLeaf(key, value, nextKey);
}

describe('RecentRoots — the class', () => {
  it('refuses a non-safe-integer capacity', () => {
    expect(() => new RecentRoots(-1)).toThrow(RangeError);
    expect(() => new RecentRoots(1.5)).toThrow(RangeError);
    expect(() => new RecentRoots(NaN)).toThrow(RangeError);
  });

  it('capacity 0 holds nothing', () => {
    const ring = new RecentRoots(0);
    ring.record(1, dummyLeaf(1), 1);
    expect(ring.size()).toBe(0);
    expect(ring.get(1)).toBeNull();
  });

  it('holds `capacity` roots, newest; records 1..5 at cap 3 leave {3, 4, 5}', () => {
    const ring = new RecentRoots(3);
    for (let h = 1; h <= 5; h++) ring.record(h, dummyLeaf(h), h);
    expect(ring.heights()).toEqual([3, 4, 5]);
    expect(ring.has(2)).toBe(false);
    expect(ring.has(6)).toBe(false);
    expect(ring.get(3)).not.toBeNull();
    expect(ring.get(6)).toBeNull();
  });

  it('records by reference — the root the ring answers is the one passed in', () => {
    const ring = new RecentRoots(3);
    const leaf = dummyLeaf(7);
    ring.record(7, leaf, 11);
    const kept = ring.get(7);
    expect(kept).not.toBeNull();
    expect(kept!.root).toBe(leaf);
    expect(kept!.treeHeight).toBe(11);
  });

  it('re-records replace the previous entry at a height', () => {
    const ring = new RecentRoots(3);
    const first = dummyLeaf(1);
    const second = dummyLeaf(2);
    ring.record(1, first, 1);
    ring.record(1, second, 2);
    expect(ring.get(1)!.root).toBe(second);
    expect(ring.get(1)!.treeHeight).toBe(2);
    expect(ring.size()).toBe(1);
  });

  it('dropAbove drops strictly above', () => {
    const ring = new RecentRoots(5);
    for (let h = 1; h <= 5; h++) ring.record(h, dummyLeaf(h), h);
    ring.dropAbove(3);
    expect(ring.heights()).toEqual([1, 2, 3]);
    ring.dropAbove(0);
    expect(ring.heights()).toEqual([]);
  });

  it('drop removes one entry by height', () => {
    const ring = new RecentRoots(3);
    ring.record(1, dummyLeaf(1), 1);
    ring.record(2, dummyLeaf(2), 2);
    ring.drop(1);
    expect(ring.heights()).toEqual([2]);
    ring.drop(99);
    expect(ring.heights()).toEqual([2]);
  });

  it('snapshot and restore reinstall the same root objects — a reorg that aborts', () => {
    const ring = new RecentRoots(3);
    const first = dummyLeaf(1);
    const second = dummyLeaf(2);
    ring.record(1, first, 1);
    ring.record(2, second, 2);
    const snap = ring.snapshot();

    ring.drop(1);
    const third = dummyLeaf(3);
    ring.record(3, third, 3);
    expect(ring.heights()).toEqual([2, 3]);

    ring.restore(snap);
    expect(ring.heights()).toEqual([1, 2]);
    expect(ring.get(1)!.root).toBe(first);
    expect(ring.get(2)!.root).toBe(second);
  });

  it('clear empties', () => {
    const ring = new RecentRoots(3);
    ring.record(1, dummyLeaf(1), 1);
    ring.clear();
    expect(ring.size()).toBe(0);
    expect(ring.heights()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration — apply, refuse, revert, reopen
// ---------------------------------------------------------------------------

async function freshStore() {
  const db = await import('../../src/store/db.js');
  db.initDb(':memory:');
  db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
  return db;
}

describe('the ring tracks the chain the node holds', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

  it('records each applied block, each kept root\'s digest the block\'s stateRoot', async () => {
    await freshStore();
    const { activateProverOverStore, makeApplicableBlock } = await import('../helpers.js');
    const handle = await activateProverOverStore();
    const { applyOrderingBlock } = await import('../../src/services/block-apply.js');

    for (let height = 1; height <= 3; height++) {
      const block = await makeApplicableBlock({ height });
      expect(applyOrderingBlock(block)).toBe(true);
      const kept = handle.recentRoots.get(height);
      expect(kept, `height ${height}`).not.toBeNull();
      // The 33-byte digest = rootLabel || treeHeight; the header's stateRoot
      // is its hex. The library's digest() is one source of truth.
      // Compare through the inner prover's current digest, which is this
      // height's digest.
      const digestHex = bytesToHex(handle.prover.digest()!);
      expect(digestHex).toBe(block.header.stateRoot);
    }

    // `activateProverOverStore` seeds genesis and records (0, root), and the
    // apply funnel records (1, root) through (3, root) on top.
    expect(handle.recentRoots.heights()).toEqual([0, 1, 2, 3]);
  });

  it('a rule-rejected block leaves the ring as it was', async () => {
    await freshStore();
    const { activateProverOverStore, makeApplicableBlock } = await import('../helpers.js');
    const handle = await activateProverOverStore();
    const { applyOrderingBlock } = await import('../../src/services/block-apply.js');
    for (let h = 1; h <= 2; h++) {
      expect(applyOrderingBlock(await makeApplicableBlock({ height: h }))).toBe(true);
    }
    const before = handle.recentRoots.heights();

    // A block whose stateRoot does not match what the body produces.
    const refused = await makeApplicableBlock({ height: 3, stateRoot: '00'.repeat(33) });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(applyOrderingBlock(refused)).toBe(false);
    expect(handle.recentRoots.heights()).toEqual(before);
    expect(handle.recentRoots.get(3)).toBeNull();
  });

  it('an adProofsRoot mismatch leaves the ring as it was', async () => {
    await freshStore();
    const { activateProverOverStore, makeApplicableBlock } = await import('../helpers.js');
    const handle = await activateProverOverStore();
    const { applyOrderingBlock } = await import('../../src/services/block-apply.js');
    for (let h = 1; h <= 2; h++) {
      expect(applyOrderingBlock(await makeApplicableBlock({ height: h }))).toBe(true);
    }
    const before = handle.recentRoots.heights();
    const refused = await makeApplicableBlock({ height: 3, adProofsRoot: '00'.repeat(32) });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(applyOrderingBlock(refused)).toBe(false);
    expect(handle.recentRoots.heights()).toEqual(before);
    expect(handle.recentRoots.get(3)).toBeNull();
  });

  it('a revert drops the reverted height from the ring', async () => {
    await freshStore();
    const { activateProverOverStore, makeApplicableBlock, revertChainTo } = await import('../helpers.js');
    const handle = await activateProverOverStore();
    const { applyOrderingBlock } = await import('../../src/services/block-apply.js');
    for (let h = 1; h <= 5; h++) {
      expect(applyOrderingBlock(await makeApplicableBlock({ height: h }))).toBe(true);
    }
    expect(handle.recentRoots.heights()).toEqual([0, 1, 2, 3, 4, 5]);

    await revertChainTo(3);
    expect(handle.recentRoots.heights()).toEqual([0, 1, 2, 3]);
    expect(handle.recentRoots.get(4)).toBeNull();
    expect(handle.recentRoots.get(5)).toBeNull();
  });

  it('a reopened node holds its tip\'s height alone, and gains a height with the next block', async () => {
    const db = await freshStore();
    const { activateProverOverStore, makeApplicableBlock } = await import('../helpers.js');
    const firstHandle = await activateProverOverStore();
    const { applyOrderingBlock } = await import('../../src/services/block-apply.js');
    for (let h = 1; h <= 3; h++) {
      expect(applyOrderingBlock(await makeApplicableBlock({ height: h }))).toBe(true);
    }
    expect(firstHandle.recentRoots.heights()).toEqual([0, 1, 2, 3]);

    // Reopen on the same storage — a fresh handle, through the test seam that
    // bypasses the module-level singleton.
    const { createAvlProver } = await import('../../src/state/avl-prover.js');
    const second = createAvlProver(db.getDb());
    expect(second.recentRoots.heights()).toEqual([3]);
    // The kept root's digest is the tip's stateRoot.
    expect(bytesToHex(second.prover.digest()!)).toBe(
      bytesToHex(firstHandle.prover.digest()!),
    );
  });
});
