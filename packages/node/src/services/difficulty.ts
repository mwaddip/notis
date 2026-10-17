import { RETARGET_HALFLIFE_BLOCKS } from '@dagsocial/types';
import { asertTargetBits } from '@dagsocial/validation';
import type { RetargetParams } from '@dagsocial/validation';
import type { BlockHeader } from '@dagsocial/types';
import { config } from '../config.js';
import { getBlockCreatedAt, getCurrentHeight } from '../store/index.js';
import { getHeaderRow } from '../store/header-tree.js';
import type { HeaderRow } from '../store/header-tree.js';
import { MissingStoredBlockError } from './corrupt-state.js';

/** NODE_INTERFACE → Configuration */
export function retargetParams(): RetargetParams {
  return {
    anchorBits: config.orderingBlockPowTargetBits,
    idealMs: config.orderingBlockIdealMs,
    halflifeMs: RETARGET_HALFLIFE_BLOCKS * config.orderingBlockIdealMs,
    floorBits: config.orderingBlockPowTargetFloorBits,
    ceilingBits: config.orderingBlockPowTargetCeilingBits,
  };
}

/**
 * Block 1's stored `createdAt` — the ASERT anchor timestamp.
 * NODE_INTERFACE → Difficulty schedule: `t_a` is `ordering_blocks.created_at`
 * at height 1. A chain with a tip and no block 1 is a store that lost a row.
 */
export function anchorCreatedAt(): number {
  const stamp = getBlockCreatedAt(1);
  if (stamp === null) {
    const tip = getCurrentHeight();
    if (tip > 0) {
      throw new MissingStoredBlockError('anchorCreatedAt', 1);
    }
    throw new Error('anchorCreatedAt called on an empty chain');
  }
  return stamp;
}

/**
 * The target the block above `parent` must carry — the schedule evaluated
 * over the applied-chain anchor stamp. MINING_INTERFACE → Difficulty Schedule.
 */
export function scheduledTargetBits(parent: BlockHeader): number {
  return asertTargetBits(retargetParams(), anchorCreatedAt(), parent);
}

/**
 * The schedule evaluated over a tree row's path — the row's `pathTa`
 * (`t_a` for the branch the row sits on) and its header. MINING_INTERFACE →
 * Difficulty Schedule; NODE_INTERFACE → "An admitted header is stored when it
 * extends the best chain" — a header on a side branch of the tree carries its
 * own `pathTa`, which is block 1's `createdAt` on that branch.
 */
export function scheduledTargetBitsAt(parentRow: HeaderRow): number {
  return asertTargetBits(retargetParams(), parentRow.pathTa, parentRow.header);
}

/**
 * NODE_INTERFACE → Sync handlers (pull-path) → "setScheduledTargetProvider(scheduledPowTargetBits)":
 * height 1 answers the anchor's bits; otherwise the tree row for
 * `header.prevBlockHash` is read, and when it stands at `header.height - 1`
 * the schedule is evaluated over that header and its `pathTa`; every other
 * case answers `null`.
 */
export function scheduledPowTargetBits(header: BlockHeader): number | null {
  const parentHeight = header.height - 1;
  if (!Number.isSafeInteger(parentHeight) || parentHeight < 0) return null;
  if (parentHeight === 0) return config.orderingBlockPowTargetBits;
  const row = getHeaderRow(header.prevBlockHash);
  if (row === null) return null;
  if (row.height !== parentHeight) return null;
  return scheduledTargetBitsAt(row);
}

// NODE_INTERFACE → Difficulty schedule: the clock seam. `nowMs()` returns
// `Date.now()` unless a test has set `setClock(fn)`.
let clockFn: (() => number) | null = null;

export function nowMs(): number {
  return clockFn !== null ? clockFn() : Date.now();
}

export function setClock(fn: (() => number) | null): void {
  clockFn = fn;
}
