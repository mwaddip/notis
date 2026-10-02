import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AvlNode } from '@ergots/avltree';
import { label, newLeaf } from '@ergots/avltree';
import { bytesToHex } from '@dagsocial/types';
import { RecentRoots } from '../../src/state/recent-roots.js';
import type { KeptRoot } from '../../src/state/recent-roots.js';

/** The 33-byte digest of a kept root — the root's label and the tree height, hex. */
function keptDigest(kept: KeptRoot): string {
  const out = new Uint8Array(33);
  out.set(label(kept.root), 0);
  out[32] = kept.treeHeight;
  return bytesToHex(out);
}

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

const UNBOUNDED = Number.MAX_SAFE_INTEGER;

describe('RecentRoots — the class', () => {
  it('refuses a non-safe-integer capacity', () => {
    expect(() => new RecentRoots(-1, UNBOUNDED)).toThrow(RangeError);
    expect(() => new RecentRoots(1.5, UNBOUNDED)).toThrow(RangeError);
    expect(() => new RecentRoots(NaN, UNBOUNDED)).toThrow(RangeError);
  });

  it('refuses a non-safe-integer maxNodes', () => {
    expect(() => new RecentRoots(3, -1)).toThrow(RangeError);
    expect(() => new RecentRoots(3, 1.5)).toThrow(RangeError);
    expect(() => new RecentRoots(3, NaN)).toThrow(RangeError);
    expect(() => new RecentRoots(3, Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });

  it('capacity 0 holds nothing', () => {
    const ring = new RecentRoots(0, UNBOUNDED);
    ring.record(1, dummyLeaf(1), 1, 0);
    expect(ring.size()).toBe(0);
    expect(ring.get(1)).toBeNull();
  });

  it('holds `capacity` roots, newest; records 1..5 at cap 3 leave {3, 4, 5}', () => {
    const ring = new RecentRoots(3, UNBOUNDED);
    for (let h = 1; h <= 5; h++) ring.record(h, dummyLeaf(h), h, 0);
    expect(ring.heights()).toEqual([3, 4, 5]);
    expect(ring.has(2)).toBe(false);
    expect(ring.has(6)).toBe(false);
    expect(ring.get(3)).not.toBeNull();
    expect(ring.get(6)).toBeNull();
  });

  it('records by reference — the root the ring answers is the one passed in', () => {
    const ring = new RecentRoots(3, UNBOUNDED);
    const leaf = dummyLeaf(7);
    ring.record(7, leaf, 11, 0);
    const kept = ring.get(7);
    expect(kept).not.toBeNull();
    expect(kept!.root).toBe(leaf);
    expect(kept!.treeHeight).toBe(11);
  });

  it('re-records replace the previous entry at a height', () => {
    const ring = new RecentRoots(3, UNBOUNDED);
    const first = dummyLeaf(1);
    const second = dummyLeaf(2);
    ring.record(1, first, 1, 0);
    ring.record(1, second, 2, 0);
    expect(ring.get(1)!.root).toBe(second);
    expect(ring.get(1)!.treeHeight).toBe(2);
    expect(ring.size()).toBe(1);
  });

  it('drop removes one entry by height', () => {
    const ring = new RecentRoots(3, UNBOUNDED);
    ring.record(1, dummyLeaf(1), 1, 0);
    ring.record(2, dummyLeaf(2), 2, 0);
    ring.drop(1);
    expect(ring.heights()).toEqual([2]);
    ring.drop(99);
    expect(ring.heights()).toEqual([2]);
  });

  it('snapshot and restore reinstall the same root objects — a reorg that aborts', () => {
    const ring = new RecentRoots(3, UNBOUNDED);
    const first = dummyLeaf(1);
    const second = dummyLeaf(2);
    ring.record(1, first, 1, 0);
    ring.record(2, second, 2, 0);
    const snap = ring.snapshot();

    ring.drop(1);
    const third = dummyLeaf(3);
    ring.record(3, third, 3, 0);
    expect(ring.heights()).toEqual([2, 3]);

    ring.restore(snap);
    expect(ring.heights()).toEqual([1, 2]);
    expect(ring.get(1)!.root).toBe(first);
    expect(ring.get(2)!.root).toBe(second);
  });

  it('clear empties', () => {
    const ring = new RecentRoots(3, UNBOUNDED);
    ring.record(1, dummyLeaf(1), 1, 0);
    ring.clear();
    expect(ring.size()).toBe(0);
    expect(ring.heights()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Unit — the node bound (NODE_INTERFACE → "The count is the store's")
// ---------------------------------------------------------------------------

describe('RecentRoots — the node bound', () => {
  it('an empty ring and a one-root ring both answer 0 beyond the tree', () => {
    const ring = new RecentRoots(5, UNBOUNDED);
    expect(ring.nodesHeldBeyondTree()).toBe(0);
    ring.record(1, dummyLeaf(1), 1, 42);
    expect(ring.nodesHeldBeyondTree()).toBe(0);
    ring.drop(1);
    ring.record(9, dummyLeaf(9), 1, 999);
    expect(ring.nodesHeldBeyondTree()).toBe(0);
  });

  it('heights 5, 6, 7 recorded with 10, 20, 30 sum to 50', () => {
    const ring = new RecentRoots(5, UNBOUNDED);
    ring.record(5, dummyLeaf(5), 1, 10);
    ring.record(6, dummyLeaf(6), 1, 20);
    ring.record(7, dummyLeaf(7), 1, 30);
    expect(ring.nodesHeldBeyondTree()).toBe(50);
  });

  it('maxNodes = 50 lets 5/10, 6/20, 7/30 stand; 8/1 drops 5 and leaves 6, 7, 8 at 31', () => {
    const ring = new RecentRoots(5, 50);
    ring.record(5, dummyLeaf(5), 1, 10);
    ring.record(6, dummyLeaf(6), 1, 20);
    ring.record(7, dummyLeaf(7), 1, 30);
    expect(ring.heights()).toEqual([5, 6, 7]);
    expect(ring.nodesHeldBeyondTree()).toBe(50);

    ring.record(8, dummyLeaf(8), 1, 1);
    expect(ring.heights()).toEqual([6, 7, 8]);
    expect(ring.nodesHeldBeyondTree()).toBe(31);
  });

  it('one block above the bound stands alone, the next stands beside it', () => {
    const ring = new RecentRoots(5, 50);
    ring.record(5, dummyLeaf(5), 1, 10);
    ring.record(6, dummyLeaf(6), 1, 500);
    expect(ring.heights()).toEqual([6]);
    expect(ring.nodesHeldBeyondTree()).toBe(0);

    ring.record(7, dummyLeaf(7), 1, 3);
    expect(ring.heights()).toEqual([6, 7]);
    expect(ring.nodesHeldBeyondTree()).toBe(3);
  });

  it('maxNodes = 0 keeps the highest alone after every non-zero record', () => {
    const ring = new RecentRoots(5, 0);
    ring.record(5, dummyLeaf(5), 1, 1);
    expect(ring.heights()).toEqual([5]);
    ring.record(6, dummyLeaf(6), 1, 2);
    expect(ring.heights()).toEqual([6]);
    ring.record(7, dummyLeaf(7), 1, 3);
    expect(ring.heights()).toEqual([7]);
    expect(ring.nodesHeldBeyondTree()).toBe(0);
  });

  it('capacity 2 and maxNodes 1000: the third record drops the lowest by count though the sum is far under', () => {
    const ring = new RecentRoots(2, 1000);
    ring.record(5, dummyLeaf(5), 1, 10);
    ring.record(6, dummyLeaf(6), 1, 20);
    ring.record(7, dummyLeaf(7), 1, 30);
    expect(ring.heights()).toEqual([6, 7]);
    expect(ring.nodesHeldBeyondTree()).toBe(30);
  });

  it('drop of the highest reduces the sum by its count', () => {
    const ring = new RecentRoots(5, UNBOUNDED);
    ring.record(5, dummyLeaf(5), 1, 10);
    ring.record(6, dummyLeaf(6), 1, 20);
    ring.record(7, dummyLeaf(7), 1, 30);
    expect(ring.nodesHeldBeyondTree()).toBe(50);
    ring.drop(7);
    // 5, 6 remain; the sum excludes the lowest (5), so it is 20.
    expect(ring.heights()).toEqual([5, 6]);
    expect(ring.nodesHeldBeyondTree()).toBe(20);
  });

  it('snapshot then further records, then restore, answers the snapshot heights and its sum', () => {
    const ring = new RecentRoots(5, UNBOUNDED);
    ring.record(5, dummyLeaf(5), 1, 10);
    ring.record(6, dummyLeaf(6), 1, 20);
    ring.record(7, dummyLeaf(7), 1, 30);
    const snap = ring.snapshot();
    const sumBefore = ring.nodesHeldBeyondTree();

    ring.record(8, dummyLeaf(8), 1, 40);
    ring.record(9, dummyLeaf(9), 1, 50);
    expect(ring.nodesHeldBeyondTree()).toBe(20 + 30 + 40 + 50);

    ring.restore(snap);
    expect(ring.heights()).toEqual([5, 6, 7]);
    expect(ring.nodesHeldBeyondTree()).toBe(sumBefore);
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

  it('each kept root\'s digest is its block\'s stateRoot after every block has applied', async () => {
    await freshStore();
    const { activateProverOverStore, makeApplicableBlock } = await import('../helpers.js');
    const handle = await activateProverOverStore();
    const { applyOrderingBlock } = await import('../../src/services/block-apply.js');

    const stateRootOf = new Map<number, string>();
    for (let height = 1; height <= 3; height++) {
      const block = await makeApplicableBlock({ height });
      expect(applyOrderingBlock(block)).toBe(true);
      stateRootOf.set(height, block.header.stateRoot);
    }

    // After every block has applied, each kept root the ring answers has the
    // digest of the block committed at its height — a later block has not
    // moved an earlier one.
    expect(handle.recentRoots.heights()).toEqual([0, 1, 2, 3]);
    for (const [height, root] of stateRootOf) {
      const kept = handle.recentRoots.get(height);
      expect(kept, `height ${height}`).not.toBeNull();
      expect(keptDigest(kept!), `height ${height}`).toBe(root);
    }
  });

  describe('a refusal leaves the ring exactly as it was, whatever height the block claims', () => {
    async function appliedChain(upTo: number) {
      await freshStore();
      const { activateProverOverStore, makeApplicableBlock } = await import('../helpers.js');
      const handle = await activateProverOverStore();
      const { applyOrderingBlock } = await import('../../src/services/block-apply.js');
      const applied: Array<{ height: number; stateRoot: string }> = [];
      for (let h = 1; h <= upTo; h++) {
        const block = await makeApplicableBlock({ height: h });
        expect(applyOrderingBlock(block)).toBe(true);
        applied.push({ height: h, stateRoot: block.header.stateRoot });
      }
      return { handle, applied, makeApplicableBlock, applyOrderingBlock };
    }

    function snapshotRing(handle: Awaited<ReturnType<typeof appliedChain>>['handle']) {
      const heights = handle.recentRoots.heights();
      const byH: Record<number, { root: unknown; digest: string }> = {};
      for (const h of heights) {
        const kept = handle.recentRoots.get(h)!;
        byH[h] = { root: kept.root, digest: keptDigest(kept) };
      }
      return { heights, byH };
    }

    function expectRingUnchanged(handle: Awaited<ReturnType<typeof appliedChain>>['handle'], snap: ReturnType<typeof snapshotRing>) {
      expect(handle.recentRoots.heights()).toEqual(snap.heights);
      for (const h of snap.heights) {
        const kept = handle.recentRoots.get(h)!;
        // Same root object by reference, and same 33-byte digest.
        expect(kept.root, `height ${h}`).toBe(snap.byH[h]!.root);
        expect(keptDigest(kept), `height ${h}`).toBe(snap.byH[h]!.digest);
      }
    }

    it('a block claiming height 1 while the ring holds three heights or more', async () => {
      const { handle, applyOrderingBlock } = await appliedChain(3);
      const snap = snapshotRing(handle);
      // A height-1 block the chain-link check refuses, which runs inside
      // the funnel's transaction (NODE_INTERFACE → Ordering block
      // apply-time authorization).
      const { makeApplicableBlock } = await import('../helpers.js');
      const refused = await makeApplicableBlock({ height: 1 });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(applyOrderingBlock(refused)).toBe(false);
      expectRingUnchanged(handle, snap);
    });

    it('the tip block sent a second time', async () => {
      const { handle, applied, applyOrderingBlock } = await appliedChain(3);
      const snap = snapshotRing(handle);
      // Re-apply the tip's block. The block names its parent's hash — the
      // block at `tip - 1` — but its height is the tip's, not the tip's
      // plus one; `verifyBlockChainLink` requires
      // `block.height === prevBlock.height + 1`, which refuses it.
      const { getOrderingBlock } = await import('../../src/store/ordering.js');
      const tip = getOrderingBlock(applied[applied.length - 1]!.height);
      expect(tip).not.toBeNull();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(applyOrderingBlock(tip!)).toBe(false);
      expectRingUnchanged(handle, snap);
    });

    it('a block at tip + 1 refused for a rule', async () => {
      const { handle, applied, applyOrderingBlock } = await appliedChain(3);
      const snap = snapshotRing(handle);
      // A block at the next height with a protocol version in no era — a
      // rule's refusal (VALIDATION_INTERFACE → Protocol Version).
      const { makeApplicableBlock } = await import('../helpers.js');
      const refused = await makeApplicableBlock({ height: applied[applied.length - 1]!.height + 1, protocolVersion: 999 });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(applyOrderingBlock(refused)).toBe(false);
      expectRingUnchanged(handle, snap);
    });

    it('a block at tip + 1 refused for a stateRoot mismatch', async () => {
      const { handle, applied, applyOrderingBlock } = await appliedChain(3);
      const snap = snapshotRing(handle);
      const { makeApplicableBlock } = await import('../helpers.js');
      const refused = await makeApplicableBlock({
        height: applied[applied.length - 1]!.height + 1,
        stateRoot: '00'.repeat(33),
      });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(applyOrderingBlock(refused)).toBe(false);
      expectRingUnchanged(handle, snap);
    });

    it('a block at tip + 1 refused for an adProofsRoot mismatch', async () => {
      const { handle, applied, applyOrderingBlock } = await appliedChain(3);
      const snap = snapshotRing(handle);
      const { makeApplicableBlock } = await import('../helpers.js');
      const refused = await makeApplicableBlock({
        height: applied[applied.length - 1]!.height + 1,
        adProofsRoot: '00'.repeat(32),
      });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(applyOrderingBlock(refused)).toBe(false);
      expectRingUnchanged(handle, snap);
    });
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
    // A disk-backed store so the restart is a real one: the first graph
    // writes it, the second graph (`vi.resetModules()` + `initDb(path)`)
    // reads it back and the module singleton is the reopened one.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dagsocial-recent-roots-'));
    const dbPath = path.join(dir, 'restart.db');
    try {
      vi.resetModules();
      {
        const dbMod = await import('../../src/store/db.js');
        dbMod.initDb(dbPath);
        dbMod.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
        const { activateProverOverStore, makeApplicableBlock } = await import('../helpers.js');
        const firstHandle = await activateProverOverStore();
        const { applyOrderingBlock } = await import('../../src/services/block-apply.js');
        for (let h = 1; h <= 3; h++) {
          expect(applyOrderingBlock(await makeApplicableBlock({ height: h }))).toBe(true);
        }
        expect(firstHandle.recentRoots.heights()).toEqual([0, 1, 2, 3]);
        dbMod.closeDb();
      }

      vi.resetModules();
      const dbMod = await import('../../src/store/db.js');
      dbMod.initDb(dbPath);
      const { createAvlProver } = await import('../../src/state/avl-prover.js');
      const second = createAvlProver();
      // After a restart the node holds its tip's height alone.
      expect(second.recentRoots.heights()).toEqual([3]);
      const { getOrderingBlock } = await import('../../src/store/ordering.js');
      const tipStateRoot = getOrderingBlock(3)!.header.stateRoot;
      expect(keptDigest(second.recentRoots.get(3)!)).toBe(tipStateRoot);

      // The next block applies — the ring gains a height.
      const { makeApplicableBlock: makeAgain } = await import('../helpers.js');
      const { applyOrderingBlock: applyAgain } = await import('../../src/services/block-apply.js');
      const next = await makeAgain({ height: 4 });
      expect(applyAgain(next)).toBe(true);
      expect(second.recentRoots.heights()).toEqual([3, 4]);
      expect(keptDigest(second.recentRoots.get(4)!)).toBe(next.header.stateRoot);
      dbMod.closeDb();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * `PROOF_WINDOW_BLOCKS` reaches `new RecentRoots(…)` through the
   * environment → `parseProofWindow` → `config.proofWindowBlocks` →
   * `createAvlProver`, read once at module load. The two window cases
   * reset the module graph with the variable set, as the suite's other
   * configuration tests do (NODE_INTERFACE → Configuration).
   */
  async function withProofWindow<T>(value: string, body: () => Promise<T>): Promise<T> {
    const prev = process.env['PROOF_WINDOW_BLOCKS'];
    process.env['PROOF_WINDOW_BLOCKS'] = value;
    try {
      vi.resetModules();
      return await body();
    } finally {
      if (prev === undefined) delete process.env['PROOF_WINDOW_BLOCKS'];
      else process.env['PROOF_WINDOW_BLOCKS'] = prev;
    }
  }

  it('`PROOF_WINDOW_BLOCKS = 3` — blocks 1..5 leave {3, 4, 5} in the ring, routes answer them, 2 and 6 are 404', async () => {
    await withProofWindow('3', async () => {
      const dbMod = await import('../../src/store/db.js');
      dbMod.initDb(':memory:');
      dbMod.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
      const { activateProverOverStore, makeApplicableBlock, makeTestConfig } = await import('../helpers.js');
      const handle = await activateProverOverStore();
      const { applyOrderingBlock } = await import('../../src/services/block-apply.js');
      const roots: Record<number, string> = {};
      for (let h = 1; h <= 5; h++) {
        const block = await makeApplicableBlock({ height: h });
        expect(applyOrderingBlock(block)).toBe(true);
        roots[h] = block.header.stateRoot;
      }
      expect(handle.recentRoots.heights()).toEqual([3, 4, 5]);

      const { createApp } = await import('../../src/server.js');
      const supertest = await import('supertest');
      const app = createApp(makeTestConfig({ nodeRole: 'server' }));
      const { bytesToHex: bh, networkKey } = await import('@dagsocial/types');
      const key = bh(networkKey());
      for (const h of [3, 4, 5]) {
        const r = await supertest.default(app).get(`/api/v1/proof/${key}?atHeight=${h}`).expect(200);
        expect(r.body.stateRoot, `height ${h}`).toBe(roots[h]);
      }
      for (const h of [2, 6]) {
        await supertest.default(app).get(`/api/v1/proof/${key}?atHeight=${h}`).expect(404);
      }
    });
  });

  it('`PROOF_WINDOW_BLOCKS = 0` — the tip answers, every older height is 404', async () => {
    await withProofWindow('0', async () => {
      const dbMod = await import('../../src/store/db.js');
      dbMod.initDb(':memory:');
      dbMod.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
      const { activateProverOverStore, makeApplicableBlock, makeTestConfig } = await import('../helpers.js');
      const handle = await activateProverOverStore();
      const { applyOrderingBlock } = await import('../../src/services/block-apply.js');
      for (let h = 1; h <= 3; h++) {
        expect(applyOrderingBlock(await makeApplicableBlock({ height: h }))).toBe(true);
      }
      // Zero keeps no root; the tip is the live tree's, which the route
      // answers without one.
      expect(handle.recentRoots.heights()).toEqual([]);

      const { createApp } = await import('../../src/server.js');
      const supertest = await import('supertest');
      const app = createApp(makeTestConfig({ nodeRole: 'server' }));
      const { bytesToHex: bh, networkKey } = await import('@dagsocial/types');
      const key = bh(networkKey());
      await supertest.default(app).get(`/api/v1/proof/${key}`).expect(200);
      await supertest.default(app).get(`/api/v1/proof/${key}?atHeight=3`).expect(200);
      for (const h of [0, 1, 2]) {
        await supertest.default(app).get(`/api/v1/proof/${key}?atHeight=${h}`).expect(404);
      }
    });
  });

  /**
   * `PROOF_WINDOW_NODES` reaches `new RecentRoots(…)` the same way
   * `PROOF_WINDOW_BLOCKS` does — the environment → `parseProofWindowNodes` →
   * `config.proofWindowNodes` → `createAvlProver` — so the window helper's
   * pattern applies (NODE_INTERFACE → Configuration).
   */
  async function withProofWindowNodes<T>(value: string, body: () => Promise<T>): Promise<T> {
    const prev = process.env['PROOF_WINDOW_NODES'];
    process.env['PROOF_WINDOW_NODES'] = value;
    try {
      vi.resetModules();
      return await body();
    } finally {
      if (prev === undefined) delete process.env['PROOF_WINDOW_NODES'];
      else process.env['PROOF_WINDOW_NODES'] = prev;
    }
  }

  /**
   * NODE_INTERFACE → "The count is the store's" — the count recorded with a
   * block's root is exactly the number of nodes the first root carries whose
   * label no node of the second does, counted by object identity over a walk.
   * Any further object the first reaches that the second does not is one
   * whose label a different object of the second carries — a node the block
   * rebuilt to the same label (main measured 15–31 of these in a block
   * replacing ~60 000).
   */
  it('for each applied block the recorded count is exactly its label-absent orphans; the ring sum equals the recorded counts above the lowest', async () => {
    await freshStore();
    const { activateProverOverStore, makeApplicableBlock } = await import('../helpers.js');
    const handle = await activateProverOverStore();
    const { applyOrderingBlock } = await import('../../src/services/block-apply.js');

    function walk(node: AvlNode, out: Set<AvlNode>): void {
      if (out.has(node)) return;
      out.add(node);
      if (node.kind === 'internal') {
        walk(node.left, out);
        walk(node.right, out);
      }
    }

    function labelsOf(nodes: Set<AvlNode>): Set<string> {
      const out = new Set<string>();
      for (const n of nodes) out.add(bytesToHex(label(n)));
      return out;
    }

    for (let h = 1; h <= 4; h++) {
      const before = handle.recentRoots.get(h - 1);
      expect(before, `no kept root for height ${h - 1} before block ${h}`).not.toBeNull();
      const beforeNodes = new Set<AvlNode>();
      walk(before!.root, beforeNodes);

      const block = await makeApplicableBlock({ height: h });
      expect(applyOrderingBlock(block)).toBe(true);

      const after = handle.recentRoots.get(h);
      expect(after, `no kept root recorded for applied block ${h}`).not.toBeNull();
      const afterNodes = new Set<AvlNode>();
      walk(after!.root, afterNodes);
      const afterLabels = labelsOf(afterNodes);

      let labelAbsent = 0;
      let labelRebuiltSame = 0;
      for (const n of beforeNodes) {
        if (afterNodes.has(n)) continue; // shared object identity
        const lab = bytesToHex(label(n));
        if (afterLabels.has(lab)) labelRebuiltSame++;
        else labelAbsent++;
      }
      // Every object in `before \ after` is one of the two kinds — no third.
      expect(labelAbsent + labelRebuiltSame).toBe(beforeNodes.size - [...beforeNodes].filter((n) => afterNodes.has(n)).length);
      // The recorded count is exactly the label-absent count.
      expect(labelAbsent, `height ${h}: label-absent orphans`).toBe(after!.replaced);
    }

    const heights = handle.recentRoots.heights();
    const low = heights[0]!;
    let expectedSum = 0;
    for (const h of heights) if (h !== low) expectedSum += handle.recentRoots.get(h)!.replaced;
    expect(handle.recentRoots.nodesHeldBeyondTree()).toBe(expectedSum);
  });

  /**
   * NODE_INTERFACE → "The count is the store's" — a bound below what two
   * consecutive blocks replace leaves only the tip's root, routes serve the
   * tip and 404 for older heights, and a one-block reorg takes the store
   * resolve path (`fork-resolution.ts` where the ring holds no root at the
   * fork height) — the node lands on the new branch's `stateRoot`.
   */
  it('`PROOF_WINDOW_NODES` below two blocks\' replaced leaves tip-only; routes 404 for older; a one-block reorg resolves from the store and lands on the new branch', async () => {
    await withProofWindow('5', async () => {
      await withProofWindowNodes('1', async () => {
        const dbMod = await import('../../src/store/db.js');
        dbMod.initDb(':memory:');
        dbMod.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
        const { activateProverOverStore, makeApplicableBlock, makeTestConfig } = await import('../helpers.js');
        const handle = await activateProverOverStore();
        const { applyOrderingBlock } = await import('../../src/services/block-apply.js');

        // Apply block 1 (shared fork point).
        expect(applyOrderingBlock(await makeApplicableBlock({ height: 1 }))).toBe(true);
        // Build the competing block at height 2 BEFORE applying our 2, so
        // theirB2 chain-links to the shared tip at 1.
        const theirB2 = await makeApplicableBlock({ height: 2 });
        // Apply our 2 — the tip the reorg will revert.
        expect(applyOrderingBlock(await makeApplicableBlock({ height: 2 }))).toBe(true);

        // Each applied block's replaced count is above the bound (= 1), so
        // the ring holds only the tip.
        expect(handle.recentRoots.heights()).toEqual([2]);
        expect(handle.recentRoots.nodesHeldBeyondTree()).toBe(0);

        // The route answers the tip and 404s on every older height.
        const { createApp } = await import('../../src/server.js');
        const supertest = await import('supertest');
        const app = createApp(makeTestConfig({ nodeRole: 'server' }));
        const { bytesToHex: bh, networkKey } = await import('@dagsocial/types');
        const key = bh(networkKey());
        await supertest.default(app).get(`/api/v1/proof/${key}`).expect(200);
        await supertest.default(app).get(`/api/v1/proof/${key}?atHeight=2`).expect(200);
        const r1 = await supertest.default(app).get(`/api/v1/proof/${key}?atHeight=1`).expect(404);
        expect(r1.body).toEqual({ error: 'height not available' });
        const r0 = await supertest.default(app).get(`/api/v1/proof/${key}?atHeight=0`).expect(404);
        expect(r0.body).toEqual({ error: 'height not available' });

        // Reorg: forkHeight = 1. The ring holds no root at 1, so
        // fork-resolution calls `storage.rollback` and `recentRoots.clear`.
        const storageSpy = vi.spyOn(handle.storage, 'rollback');
        const { reorg } = await import('../../src/services/fork-resolution.js');
        reorg(1, [theirB2]);
        expect(storageSpy).toHaveBeenCalledTimes(1);

        // After reorg: the ring records theirB2's height, and the live
        // digest matches theirB2's stateRoot.
        expect(handle.recentRoots.heights()).toEqual([2]);
        expect(bytesToHex(handle.prover.digest()!)).toBe(theirB2.header.stateRoot);
      });
    });
  });

  /**
   * NODE_INTERFACE → "The count is the store's" — a bound the blocks stay
   * under lets `PROOF_WINDOW_BLOCKS` roots stand, as the count bound did
   * alone. Set `PROOF_WINDOW_NODES` far above the replaced counts a few
   * default blocks produce; the ring behaves exactly as it does without a
   * node bound.
   */
  it('`PROOF_WINDOW_NODES` far above the blocks\' replaced keeps `PROOF_WINDOW_BLOCKS` roots', async () => {
    await withProofWindow('3', async () => {
      await withProofWindowNodes('1000000', async () => {
        const dbMod = await import('../../src/store/db.js');
        dbMod.initDb(':memory:');
        dbMod.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
        const { activateProverOverStore, makeApplicableBlock } = await import('../helpers.js');
        const handle = await activateProverOverStore();
        const { applyOrderingBlock } = await import('../../src/services/block-apply.js');
        for (let h = 1; h <= 5; h++) {
          expect(applyOrderingBlock(await makeApplicableBlock({ height: h }))).toBe(true);
        }
        // The capacity decided — the three newest, as the window-only case.
        expect(handle.recentRoots.heights()).toEqual([3, 4, 5]);
      });
    });
  });
});
