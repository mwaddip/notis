import { RETARGET_HALFLIFE_BLOCKS } from '@dagsocial/types';
import { asertTargetBits } from '@dagsocial/validation';
import type { RetargetParams } from '@dagsocial/validation';
import type { BlockHeader } from '@dagsocial/types';
import { config } from '../config.js';
import { getBlockCreatedAt } from '../store/index.js';
import { getCurrentHeight } from '../store/index.js';
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
 * over the stored anchor. MINING_INTERFACE → Difficulty Schedule.
 */
export function scheduledTargetBits(parent: BlockHeader): number {
  return asertTargetBits(retargetParams(), anchorCreatedAt(), parent);
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
