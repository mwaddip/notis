// MESH_INTERFACE → The client's node list → "The client's chain" — the
// client holds its chain's last `k` headers (tip highest) and block 1's
// header beside them. The window grows by a gossiped block that extends the
// tip and by a gap fill linked bottom-up to a held header; it shrinks past
// `k` by dropping the lowest. The schedule's anchor is the proof that
// settled the chain (`t_a` = block 1's `createdAt`), the parameters are
// `verifierProfile(profile, 0).retarget`
// (NIPOPOW_INTERFACE → verifyProof — the band and the schedule).

import type { BlockHeader, NetworkProfile } from '@dagsocial/types';
import type { RetargetParams } from '@dagsocial/validation';
import {
  asertTargetBits,
  blockHash,
  verifyOrderingBlockPoW,
} from '@dagsocial/validation';
import { verifierProfile } from '@dagsocial/nipopow-client';

/**
 * Where a hash+height sits on the client's chain
 * (MESH_INTERFACE → "A check" step 3). `tip`, `one-below` and `below` name
 * a hash the window holds; `above` and `under` tell the caller a read is
 * needed; `unplaced` is a held height whose hash does not match, or a
 * null hash.
 */
export type Placement =
  | 'tip'
  | 'one-below'
  | 'below'
  | 'above'
  | 'under'
  | 'unplaced';

export class HeldChain {
  private readonly k: number;
  private readonly retarget: RetargetParams;
  // Ascending by height; tip is `window[window.length - 1]`.
  private readonly window: BlockHeader[] = [];
  private block1: BlockHeader | null = null;
  // Hash → window header; block 1's hash is kept here too so `standing`
  // reports `held` for it.
  private readonly byHash: Map<string, BlockHeader> = new Map();

  constructor(profile: NetworkProfile, k: number) {
    this.k = k;
    this.retarget = verifierProfile(profile, 0).retarget;
  }

  settled(): boolean {
    return this.block1 !== null;
  }

  /**
   * Seat the window from a verified proof: `suffix` is `k` ascending
   * headers (`[suffixHead.header, ...suffixTail]`), `block1` is the proof's
   * first header. A second call replaces both.
   */
  settle(suffix: BlockHeader[], block1: BlockHeader): void {
    this.window.length = 0;
    for (const h of suffix) this.window.push(h);
    this.block1 = block1;
    this.rebuildCaches();
  }

  tip(): BlockHeader | null {
    return this.window.length === 0
      ? null
      : (this.window[this.window.length - 1] ?? null);
  }

  place(hash: string | null, height: number): Placement {
    if (hash === null) return 'unplaced';
    if (!this.block1 || this.window.length === 0) return 'unplaced';
    const tip = this.window[this.window.length - 1]!;
    if (height > tip.height) return 'above';
    const lowestHeight = this.window[0]!.height;
    if (height < lowestHeight) return 'under';
    // Within the window range. Match by hash at the exact height.
    const idx = height - lowestHeight;
    const atHeight = this.window[idx];
    if (!atHeight) return 'unplaced';
    const atHash = blockHash(atHeight);
    if (atHash !== hash) return 'unplaced';
    if (height === tip.height) return 'tip';
    if (height === tip.height - 1) return 'one-below';
    return 'below';
  }

  headerAt(height: number): BlockHeader | null {
    if (!this.block1 || this.window.length === 0) return null;
    const lowestHeight = this.window[0]!.height;
    const highestHeight = this.window[this.window.length - 1]!.height;
    if (height >= lowestHeight && height <= highestHeight) {
      return this.window[height - lowestHeight] ?? null;
    }
    if (height === 1) return this.block1;
    return null;
  }

  /**
   * The block check has accepted the header — its work and, where the
   * parent is held, its schedule (NET_INTERFACE → Stage 1). `extend`
   * compares the parent hash to the window's: the tip is `extended` (the
   * window drops its lowest past `k`); a header below the tip is a `fork`
   * and the window stands; anything else is a `gap`
   * (MESH_INTERFACE → The client's node list → "The client's chain").
   */
  extend(header: BlockHeader): 'extended' | 'fork' | 'gap' {
    if (!this.block1 || this.window.length === 0) return 'gap';
    const tip = this.window[this.window.length - 1]!;
    const tipHash = blockHash(tip);
    if (tipHash !== null && header.prevBlockHash === tipHash) {
      this.window.push(header);
      while (this.window.length > this.k) {
        this.window.shift();
      }
      this.rebuildCaches();
      return 'extended';
    }
    // Scan the window below the tip; block 1 is held separately but a
    // parent reaching that far is a `gap` either way — a fork from block 1
    // diverges from the whole chain and resolves by a check, as a gap
    // fill would.
    for (let i = 0; i < this.window.length - 1; i++) {
      const h = this.window[i]!;
      const hh = blockHash(h);
      if (hh !== null && header.prevBlockHash === hh) return 'fork';
    }
    return 'gap';
  }

  /**
   * A gap fill, highest-first and no longer than `k`: each header's
   * `prevBlockHash` is the next one's `blockHash`, the last's the tip's.
   * Checked bottom-up — PoW, the scheduled target over the parent below,
   * the link — before anything moves (all or nothing). On `linked` the
   * window gains the fill, lowest dropped past `k`. A lowest header whose
   * parent is a held header below the tip is a fork, and one whose parent
   * is block 1 (or any other held hash) is a divergence from the whole
   * chain; neither extends the tip and so neither is accepted here
   * (MESH_INTERFACE → The client's node list → "The client's chain").
   */
  link(headers: BlockHeader[]): 'linked' | 'failed' {
    if (!this.block1 || this.window.length === 0) return 'failed';
    if (headers.length === 0 || headers.length > this.k) return 'failed';
    const tip = this.window[this.window.length - 1]!;
    let parent: BlockHeader = tip;
    // The chain grows only from its tip: at i = headers.length − 1 the
    // lowest header's parent is the held tip, so the loop's own link check
    // (`cur.prevBlockHash !== parentHash`) answers "failed" when the
    // lowest links to anything else — a held header below the tip (a
    // fork), block 1 (a divergence from the whole chain), or nothing held.
    // The fork case `HeldChain — link: "the fill links to a held header
    // below the tip (a fork), the window unchanged"` holds it.
    // Bottom-up: lowest → highest, each with its parent.
    for (let i = headers.length - 1; i >= 0; i--) {
      const cur = headers[i]!;
      if (!verifyOrderingBlockPoW(cur)) return 'failed';
      const scheduled = asertTargetBits(this.retarget, this.block1.createdAt, {
        height: parent.height,
        createdAt: parent.createdAt,
      });
      if (cur.powTargetBits !== scheduled) return 'failed';
      const parentHash = blockHash(parent);
      if (parentHash === null || cur.prevBlockHash !== parentHash) return 'failed';
      parent = cur;
    }
    // Append in ascending order (reverse of input).
    for (let i = headers.length - 1; i >= 0; i--) {
      this.window.push(headers[i]!);
    }
    while (this.window.length > this.k) {
      this.window.shift();
    }
    this.rebuildCaches();
    return 'linked';
  }

  /**
   * The scheduled target bits for a header the block check is weighing:
   * `anchorBits` at height 1, `asertTargetBits(retarget, t_a, parent)`
   * when the parent is held, `null` otherwise — the block check skips the
   * schedule when `null`
   * (NET_INTERFACE → Stage 1 →
   * "A scheduled-target mismatch is refused, never forwarded, and never penalised").
   */
  scheduledTargetBits(header: BlockHeader): number | null {
    if (!this.block1) return null;
    if (header.height === 1) return this.retarget.anchorBits;
    const parent = this.findHeldByHash(header.prevBlockHash);
    if (parent === null) return null;
    return asertTargetBits(this.retarget, this.block1.createdAt, {
      height: parent.height,
      createdAt: parent.createdAt,
    });
  }

  /**
   * `'held'` for any held header's hash — the window's and block 1's; a
   * header the block check already knows is Ignored
   * (NET_INTERFACE → Stage 1 → "A header this node knows is Ignored").
   */
  standing(hash: string, _height: number): 'held' | null {
    return this.byHash.has(hash) ? 'held' : null;
  }

  private findHeldByHash(hash: string): BlockHeader | null {
    return this.byHash.get(hash) ?? null;
  }

  private rebuildCaches(): void {
    this.byHash.clear();
    for (const h of this.window) {
      const hh = blockHash(h);
      if (hh !== null) this.byHash.set(hh, h);
    }
    if (this.block1) {
      const b1 = blockHash(this.block1);
      if (b1 !== null) this.byHash.set(b1, this.block1);
    }
  }
}
