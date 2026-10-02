import {
  accrualOfRange,
  bytesToHex,
  creditOfRange,
  escrowOfRange,
  inRange,
  karmaOfRange,
  vouchPairBoxId,
  vouchPairRange,
} from '@dagsocial/types';
import type { AnyBox, TreeRange } from '@dagsocial/types';
import { TreeInconsistencyError } from './tree-view.js';
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

// Where an index key carries the box id it names (TYPES_INTERFACE → The tree
// keys): tag ‖ b32(owner) ‖ b32(boxId) for every kind but `vouch`, whose value
// carries the box id instead (`vouchPairBoxId`).
const OWNED_BOX_ID_AT = 33;

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
 * from its start, or from `from`, for at most `limit` entries; after each
 * entry its box is read, and the tree contradicts itself if that box is not
 * live and of the kind's type (`TreeInconsistencyError`).
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
 * view (CONSENSUS_INTERFACE → The holdings page).
 *
 * The arguments are the caller's: a `from` outside the kind's range for
 * `owner`, an `owner` that is not 32 bytes and a `limit` that is not a
 * positive integer are each a `RangeError` — never a verdict on the tree.
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
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`holdingsPage: limit must be a positive integer, got ${limit}`);
  }
  const range = RANGE_OF[kind](owner);
  if (from !== null && !inRange(from, range)) {
    throw new RangeError(`holdingsPage: from ${bytesToHex(from)} is outside the ${kind} range for the owner`);
  }
  const expectedType = BOX_TYPE_OF[kind];
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
