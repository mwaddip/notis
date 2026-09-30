import { MAX_BLOCK_COST, W_OP, W_SIG } from '@dagsocial/types';

/**
 * What a block's cost counts (CONSENSUS_INTERFACE → The block's cost): the
 * batch's entries, the distinct keys the block's tree view looked up, and the
 * length of `treeWritesOf`'s answer.
 */
export interface BlockCost {
  signatures: number;
  lookups: number;
  writes: number;
}

/** `signatures × W_SIG + (lookups + writes) × W_OP` (TYPES_INTERFACE → The block's cost). */
export function blockCost(cost: BlockCost): number {
  return cost.signatures * W_SIG + (cost.lookups + cost.writes) * W_OP;
}

/**
 * The refusal's reason for a cost over `MAX_BLOCK_COST` — `cost C over the
 * budget B` — or `null` for one within it (CONSENSUS_INTERFACE → The block's
 * cost). A cost exactly at the budget is within it.
 */
export function checkBlockCost(cost: BlockCost): string | null {
  const total = blockCost(cost);
  return total > MAX_BLOCK_COST ? `cost ${total} over the budget ${MAX_BLOCK_COST}` : null;
}
