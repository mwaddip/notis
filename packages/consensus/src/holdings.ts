import {
  accrualOfRange,
  bytesToHex,
  creditOfRange,
  escrowOfRange,
  karmaOfRange,
  vouchPairBoxId,
  vouchPairRange,
} from '@dagsocial/types';
import type { AnyBox, TreeRange } from '@dagsocial/types';
import { OWNED_BOX_ID_AT, TreeInconsistencyError } from './tree-view.js';
import type { TreeStateView } from './tree-view.js';

/**
 * The five ranges a key's boxes are indexed under
 * (CONSENSUS_INTERFACE → The holdings page).
 */
export type HoldingKind = 'karma' | 'credit' | 'escrow' | 'vouch' | 'accrual';

/** A page of what one key holds of one kind (CONSENSUS_INTERFACE → The holdings page). */
export interface HoldingsPage {
  boxes: AnyBox[];
  /** The first key the walk did not take that is still in the range, or `null` where the range ends. */
  next: Uint8Array | null;
}

const RANGE_OF: Readonly<Record<HoldingKind, (owner: Uint8Array) => TreeRange>> = {
  karma: karmaOfRange,
  credit: creditOfRange,
  escrow: escrowOfRange,
  vouch: vouchPairRange,
  accrual: accrualOfRange,
};

const BOX_TYPE_OF: Readonly<Record<HoldingKind, AnyBox['boxType']>> = {
  karma: 'karma',
  credit: 'credit',
  escrow: 'vouch_escrow',
  vouch: 'vouch',
  accrual: 'like_accrual',
};

/**
 * A page of what one key holds of one kind, read through a tree view
 * (CONSENSUS_INTERFACE → The holdings page). The `kind`'s range is walked
 * from its start, or from `from`, for at most `limit` entries, and then the
 * box each entry names is looked up in the entries' order: that box is live
 * and of the kind's type, or the tree contradicts itself
 * (`TreeInconsistencyError`). **The order of the lookups is the rule itself**
 * — the walk's keys, then the boxes'.
 *
 * - `karma`, `credit`, `escrow`, `accrual` — the box id is the key's at
 *   `OWNED_BOX_ID_AT`.
 * - `vouch` — the key is a `(voucher, target)` pair; its value carries the
 *   box id (`vouchPairBoxId`).
 *
 * `boxes` is in key order. `next` is the last entry's `nextKey` while that
 * key is still in the range, or `null` where the range ends; the walk's
 * `nextKey` is authenticated by its leaf, so a reader of a proof knows from
 * the proof alone whether a page ended its range (CONSENSUS_INTERFACE → The
 * holdings page). A page looks up at most `1 + 2 · limit` keys through the
 * view.
 *
 * `holdingsPage` names `owner`'s refusal (its 32 bytes); `limit` and `from`
 * are the view's `pageRange` to refuse (CONSENSUS_INTERFACE → The tree view
 * → "`pageRange(range, from, limit)` is the walk as a page"): the one place
 * each check lives.
 */
export function holdingsPage(
  view: TreeStateView,
  kind: HoldingKind,
  owner: Uint8Array,
  from: Uint8Array | null,
  limit: number,
): HoldingsPage {
  if (owner.length !== 32) {
    throw new RangeError(`holdingsPage: owner must be 32 bytes, got ${owner.length}`);
  }
  const range = RANGE_OF[kind](owner);
  const expectedType = BOX_TYPE_OF[kind];
  // `pageRange` throws for a `limit` that is not a positive integer and for a
  // `from` outside the range — the walk's keys come first, then each box's.
  const page = view.pageRange(range, from, limit);
  const boxes: AnyBox[] = [];
  for (const entry of page.entries) {
    const idBytes = kind === 'vouch'
      ? vouchPairBoxId(entry.value)
      : entry.key.subarray(OWNED_BOX_ID_AT, OWNED_BOX_ID_AT + 32);
    const id = bytesToHex(idBytes);
    const box = view.getBox(id);
    if (box === null || box.boxType !== expectedType) {
      throw new TreeInconsistencyError(
        `the tree's entry ${bytesToHex(entry.key)} names ${id}, which is no live ${expectedType} box`,
      );
    }
    boxes.push(box);
  }
  return { boxes, next: page.next };
}
