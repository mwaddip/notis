import type { AvlNode } from '@ergots/avltree';

/**
 * One kept root (NODE_INTERFACE → "A proof at an older height restores a kept
 * root"): the AVL+ root node, the tree height the prover held, and the count
 * of the nodes the block that made this root replaced — the ones its
 * checkpoint's `update` orphans
 * (NODE_INTERFACE → "AVL storage shares nodes across versions; a row is a
 * node's lifetime"). Held by reference — the library never mutates a node, so
 * a kept root shares every unchanged node with the live tree at the tip and
 * holds beyond it only what later blocks replaced (NODE_INTERFACE → "The
 * count is the store's"). The `replaced` count a kept root carries is its
 * own block's; the ring's sum (→ `nodesHeldBeyondTree`) leaves the lowest
 * root's count out, since that root's replacement is held by no kept root
 * the ring records.
 */
export interface KeptRoot {
  root: AvlNode;
  treeHeight: number;
  replaced: number;
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
 * failure clears it.
 *
 * **The kept heights are consecutive.** Three sites call `record`, and each
 * holds the shape: the funnel's apply writes the height above the highest
 * (`height = tip + 1`); `bootstrapAvlProver` replaces the height
 * `createAvlProver`'s construction seed recorded (genesis loads the store
 * at the empty tree's height 0 and the bootstrap writes at the same height);
 * the construction seed itself writes the one entry of an empty ring.
 * `drop` takes the highest — `revertBlock` runs on the tip and `reorg`'s
 * revert loop walks downward from it, calling `revertBlock` at each height
 * above the fork point. Eviction takes the lowest. So the sum of `replaced`
 * over every kept height but the lowest is the count of nodes the ring
 * holds beyond the live tree at the tip (NODE_INTERFACE → "The count is the
 * store's"): each kept root above the lowest shares the tip's nodes except
 * the ones its block (or a later block) replaced, and those replacements
 * sum to the ring's count beyond the tip.
 *
 * The capacity is `PROOF_WINDOW_BLOCKS` and the node bound is
 * `PROOF_WINDOW_NODES` (NODE_INTERFACE → Configuration). After a `record`
 * the lowest kept root is evicted while the ring holds more roots than
 * `capacity` or its sum is above `maxNodes`; the sum over one root is `0`,
 * so the loop stops at one root at the latest and never drops the highest.
 */
export class RecentRoots {
  private readonly capacity: number;
  private readonly maxNodes: number;
  /** Keyed by block height, insertion-ordered. */
  private roots = new Map<number, KeptRoot>();

  constructor(capacity: number, maxNodes: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 0) {
      throw new RangeError(
        `RecentRoots: capacity must be a non-negative safe integer, got ${capacity}`,
      );
    }
    if (!Number.isSafeInteger(maxNodes) || maxNodes < 0) {
      throw new RangeError(
        `RecentRoots: maxNodes must be a non-negative safe integer, got ${maxNodes}`,
      );
    }
    this.capacity = capacity;
    this.maxNodes = maxNodes;
  }

  /**
   * Record `height`'s root with the count of nodes the block that made it
   * replaced (NODE_INTERFACE → "The count is the store's"). If the ring is
   * over `capacity` or its sum of counts above the lowest is above
   * `maxNodes` the lowest kept height is dropped. Capacity zero holds
   * nothing.
   */
  record(height: number, root: AvlNode, treeHeight: number, replaced: number): void {
    if (this.capacity === 0) return;
    // Replace any older entry at this height — the last writer wins, which
    // never happens on the apply path (`height` is strictly ascending) but
    // keeps the ring sound against a repeat record.
    this.roots.delete(height);
    this.roots.set(height, { root, treeHeight, replaced });
    this.evict();
  }

  private evict(): void {
    while (this.roots.size > 0 && (this.roots.size > this.capacity || this.nodesHeldBeyondTree() > this.maxNodes)) {
      const first = this.roots.keys().next().value;
      if (first === undefined) break;
      // The Map's insertion order after a `drop` need not be ascending, so we
      // evict by minimum height — the oldest root the ring holds.
      let minHeight = first;
      for (const h of this.roots.keys()) if (h < minHeight) minHeight = h;
      this.roots.delete(minHeight);
    }
  }

  /**
   * The sum of `replaced` over every kept height but the lowest — the count
   * of nodes the ring holds beyond the live tree at the tip
   * (NODE_INTERFACE → "The count is the store's"). Empty and single-root
   * rings answer `0`.
   */
  nodesHeldBeyondTree(): number {
    if (this.roots.size <= 1) return 0;
    let min = Infinity;
    for (const h of this.roots.keys()) if (h < min) min = h;
    let sum = 0;
    for (const [h, kept] of this.roots) if (h !== min) sum += kept.replaced;
    return sum;
  }

  /** The kept root for `height`, or `null` where no entry answers. */
  get(height: number): KeptRoot | null {
    return this.roots.get(height) ?? null;
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
