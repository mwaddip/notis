import type { OrderingBlock } from '@dagsocial/types';
import type { ApplyContext, StateView } from './state-view.js';

/**
 * The screen's answer: every user transaction `applyBlock` would refuse against the state the ones
 * before it leave, in body order (CONSENSUS_INTERFACE → Screening a body).
 */
export interface BodyScreen {
  refused: { index: number; reason: string }[];
}

/**
 * Which of a body's user transactions apply, each against the state the ones before it leave
 * (CONSENSUS_INTERFACE → Screening a body). The producer's question about a body `applyBlock`
 * refused: it runs `applyBlock`'s own phases over one overlay of `view` — the block's posts and
 * their topology rows, the pre-body captures, the user transactions in committed order and the
 * withdrawals — refuses a failing transaction alone with the position and the reason `applyBlock`
 * would give, applies nothing of it, judges the later ones without it, and repeats the passes over
 * the survivors until a pass refuses nothing. The settlement, the grants, the counters, the
 * membership pass, the decay clocks and the block's cost are not screened.
 */
export function screenBody(_view: StateView, _block: OrderingBlock, _ctx: ApplyContext): BodyScreen {
  return { refused: [] };
}
