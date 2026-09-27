export {
  validateTx,
  applyTx,
  checkTxEnvelope,
  checkOutputShape,
  checkSettlementOutputShape,
  materializeOutput,
  ceilingOf,
  isMember,
  isRoot,
} from './utxo-engine.js';
export type { UtxoEngineDeps, UtxoResult, UsernameRow } from './utxo-engine.js';

export {
  buildBlockSettlement,
  buildSettlement,
  bondOutputOf,
  settlementMarginalBytes,
} from './settlement.js';
export type { SettlementDeps, SettlementBody } from './settlement.js';

export { deriveKarmaDecay, commitDecayClocks } from './decay.js';
export type { DecayDeps, DecayPlan } from './decay.js';

export { computeBlockReward, splitCoinbase, isCreditSideTx } from './coinbase-split.js';
export type { EmbeddedTx } from './coinbase-split.js';

export { postsOf, postIdsOf } from './block-posts.js';

export { applyBlock } from './apply-block.js';
export type { ApplyResult, BlockEffects } from './apply-block.js';
export type { StateView, ApplyContext } from './state-view.js';
// The record shapes are types', beside their codecs (TYPES_INTERFACE → Layout —
// tree records).
export type { NetworkRecord, HolderRecord } from '@dagsocial/types';

export { indexEntriesOfBox, isLapsedMember } from './tree-index.js';
export { seedTreeWrites } from './tree-writes.js';
export type { TreeWrite } from './tree-writes.js';
