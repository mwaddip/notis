import type { AvlNode } from '@ergots/avltree';

/**
 * One kept root (NODE_INTERFACE → "A proof at an older height restores a kept
 * root"): the AVL+ root node and the tree height the prover held together.
 * Held by reference — the library never mutates a node, so a kept root shares
 * every unchanged node with the live tree and costs the nodes its block
 * replaced.
 */
export interface KeptRoot {
  root: AvlNode;
  treeHeight: number;
}

/**
 * The last blocks' roots a node keeps in memory, keyed by block height
 * (NODE_INTERFACE → "A proof at an older height restores a kept root"). Both
 * proof routes answer `atHeight` by restoring the kept root on the shared
 * prover, performing their lookups, generating the proof and restoring the
 * live root. A height no entry answers is 404.
 *
 * **The invariant: for each height the ring answers, the root it answers is
 * the root of the block the node holds at that height — its digest is that
 * block's `stateRoot` — and it answers no height the node does not hold a
 * block at.** NODE_INTERFACE → "Every kept root is a root of the one tree
 * the node holds in memory": a tree resolved from the store (`rollback`)
 * shares no node with the kept roots, so a path that resolves clears the
 * ring, and a reorg restores the fork point's kept root by reference where
 * it holds one whose digest is the store's version.
 *
 * `record` is called once a block's checkpoint stands and the block applies
 * — only on the funnel's success path, so a refused block never writes to
 * the ring whatever height it claims (NODE_INTERFACE → "a refused block
 * leaves the kept roots exactly as they were, whatever height it claims").
 * A revert drops with its block (`drop`), a reorg that aborts puts the ring
 * back (`snapshot`/`restore`, by reference under the apply funnel's pair),
 * a reorg's store resolve clears the ring (`clear`), and genesis seeding's
 * failure clears it. The capacity is `PROOF_WINDOW_BLOCKS` (NODE_INTERFACE
 * → Configuration); the oldest kept root is evicted when a new one is added
 * above the capacity.
 */
export class RecentRoots {
  private readonly capacity: number;
  /** Keyed by block height, insertion-ordered. */
  private roots = new Map<number, KeptRoot>();

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 0) {
      throw new RangeError(
        `RecentRoots: capacity must be a non-negative safe integer, got ${capacity}`,
      );
    }
    this.capacity = capacity;
  }

  /**
   * Record `height`'s root. If the ring is at capacity the lowest kept height
   * is dropped. Capacity zero holds nothing.
   */
  record(height: number, root: AvlNode, treeHeight: number): void {
    if (this.capacity === 0) return;
    // Replace any older entry at this height — the last writer wins, which
    // never happens on the apply path (`height` is strictly ascending) but
    // keeps the ring sound against a repeat record.
    this.roots.delete(height);
    this.roots.set(height, { root, treeHeight });
    this.evictBelowCapacity();
  }

  private evictBelowCapacity(): void {
    while (this.roots.size > this.capacity) {
      const first = this.roots.keys().next().value;
      if (first === undefined) break;
      // The Map's insertion order after a `drop` need not be ascending, so we
      // evict by minimum height — the oldest root the ring holds.
      let minHeight = first;
      for (const h of this.roots.keys()) if (h < minHeight) minHeight = h;
      this.roots.delete(minHeight);
    }
  }

  /** The kept root for `height`, or `null` where no entry answers. */
  get(height: number): KeptRoot | null {
    return this.roots.get(height) ?? null;
  }

  /** Whether the ring holds an entry at `height`. */
  has(height: number): boolean {
    return this.roots.has(height);
  }

  /** The heights the ring answers, ascending. */
  heights(): number[] {
    return [...this.roots.keys()].sort((a, b) => a - b);
  }

  /** The number of kept roots. */
  size(): number {
    return this.roots.size;
  }

  /** Drop the entry at `height`, if any. */
  drop(height: number): void {
    this.roots.delete(height);
  }

  /** Drop every entry. */
  clear(): void {
    this.roots.clear();
  }

  /**
   * The ring's state, for a caller that may need to put it back exactly as it
   * was — a reorg that aborts after records of its own (NODE_INTERFACE → "A
   * proof at an older height restores a kept root"). The snapshot aliases the
   * same `AvlNode` references the ring holds — the library never mutates a
   * node — so a restore is byte-identical.
   */
  snapshot(): Map<number, KeptRoot> {
    return new Map(this.roots);
  }

  /** Install `snapshot` as the ring's state, replacing whatever it held. */
  restore(snapshot: Map<number, KeptRoot>): void {
    this.roots = new Map(snapshot);
  }
}
