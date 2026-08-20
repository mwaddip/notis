export { initDb, getDb, closeDb } from './db.js';
export {
  insertPost,
  getPost,
  getPostRaw,
  queryPosts,
  getPendingPosts,
  confirmPost,
  unconfirmPost,
  getParentRefs,
  getAncestors,
  getSubtree,
  pruneSubtree,
} from './posts.js';
export type { PostStatus, StoredPost } from './posts.js';

export {
  getBox,
  getKarmaBox,
  getKarmaBoxes,
  getKarmaValue,
  getGenesisProofBox,
  getEmissionBox,
  getTreasuryBox,
  getKarmaPoolBox,
  getCreditBox,
  getCreditBoxes,
  getBondFor,
  getBondsInvitedAt,
  getBondBoxes,
  getVouchEscrowsFor,
  hasActiveVouchEscrow,
  getLikeCarryBox,
  getUnspentPostLockBoxes,
  getPostLockBox,
  getLikersForPost,
  getUnspentBoxes,
  insertBox,
  consumeBox,
  unconsumeBox,
  deleteBox,
  BoxNotLiveError,
} from './utxo.js';

export {
  insertLikeRecord,
  hasLikeRecord,
  getLikeRecordCount,
  deleteLikeRecordsForPosts,
  deleteLikeRecord,
  restoreLikeRecord,
} from './likes.js';

export {
  createOrderingBlock,
  getOrderingBlock,
  getBlockCreatedAt,
  getCurrentHeight,
  deleteOrderingBlock,
} from './ordering.js';

export {
  beginBlockJournal,
  finishBlockJournal,
  abortBlockJournal,
  insertBlockJournal,
  getBlockJournal,
  deleteBlockJournal,
  purgeOldJournals,
} from './journal.js';

export {
  insertStump,
  getStump,
} from './stumps.js';

export {
  insertBlockTopology,
  getSubtreeTopology,
  getTopologyAuthor,
  getTopologyAuthorBytes,
  rollbackBlockTopology,
} from './topology.js';

export {
  insertUtxoTx,
  insertMempoolPrune,
  getPendingEntries,
  iteratePendingEntries,
  purgeExpired,
  removeEntry,
  removeUtxoTxEntry,
  drainMempoolPrunes,
  removeMempoolPrunes,
  hasPendingLike,
  countPendingInvites,
  hasPendingVouch,
  hasPendingSpend,
  findPendingOutput,
  getBoxWithPending,
  MempoolFullError,
  PendingSpendConflictError,
  TxTooLargeError,
} from './mempool.js';
export type { PoolEntry } from './mempool.js';

export {
  ensureSystemKarmaBox,
  ensureFaucetCreditBox,
  ensureGenesisProofBox,
} from './system.js';

export { loadAllPeers, putPeer, deletePeer, peerStorage } from './peers.js';

export { metaGet, metaPut, metaDelete, metaHas } from './meta.js';

export {
  getVouchBox,
  getVouchesForTarget,
  getVouchesByVoucher,
  hasAnyActiveVouch,
} from './vouch-queries.js';

export {
  getIdentityRecord,
  putIdentityRecord,
  deleteIdentityRecord,
} from './identity-records.js';
export type { IdentityRecord } from './identity-records.js';

export {
  insertRefusedHeader,
  anyRefusedHeader,
  purgeRefusedHeaders,
} from './refused-headers.js';
