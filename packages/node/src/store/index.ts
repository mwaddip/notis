// NODE_INTERFACE → "Page<K> is { limit: number, after?: K }"
export interface PostKey { blockHeight: number; blockIndex: number }
export interface BoxKey { value: bigint; id: string }
export interface Page<K> { limit: number; after?: K }
export interface PageResult<T, K> { rows: T[]; next: K | null; count: number }

export { initDb, getDb, closeDb } from './db.js';
export {
  insertPost,
  setPostBody,
  getPost,
  getMissingBodies,
  queryPostsPage,
  confirmPost,
  unconfirmPost,
  deletePendingPost,
  withdrawPost,
  clearWithdrawal,
  getParentRefs,
  getAncestorsNearest,
  getSubtreePage,
  getDescendantCount,
  isLivePost,
  getPlaceholdersAt,
  getPendingPostAuthor,
} from './posts.js';
export type { PostStatus, StoredPost } from './posts.js';

export {
  getBox,
  getBoxProvenance,
  getKarmaBox,
  getKarmaBoxes,
  getKarmaBoxesPage,
  getKarmaValue,
  getKarmaTotal,
  getCreditValue,
  getCreditBoxesPage,
  getGenesisProofBox,
  getEmissionBox,
  getTreasuryBox,
  getKarmaPoolBox,
  getBackerPoolBox,
  getBackerStakeBox,
  getCreditBoxes,
  getRentEligibleCreditBoxes,
  getBondFor,
  getBondsInvitedAt,
  getBondBoxesPage,
  getVouchEscrowsFor,
  getVouchEscrowsForPage,
  getVouchEscrowsReleasableAt,
  hasActiveVouchEscrow,
  getLikeCarryBox,
  getUnspentBoxes,
  insertBox,
  consumeBox,
  unconsumeBox,
  deleteBox,
  BoxNotLiveError,
  getKarmaOwners,
  registerKarmaMembershipHook,
  recordKarmaActivity,
} from './utxo.js';
export type { KarmaMembershipHook } from './utxo.js';

export {
  insertLikeRecord,
  hasLikeRecord,
  getLikeRecordCount,
  deleteLikeRecord,
} from './likes.js';

export {
  createOrderingBlock,
  getOrderingBlock,
  getBlockCreatedAt,
  getCurrentHeight,
  nextBlockHeight,
  deleteOrderingBlock,
  getOrderingBlockHash,
  getHeightByBlockHash,
  getInterlinks,
  getPopowHeaderByHash,
  getPopowHeaderAtHeight,
  getLastHeaders,
  getHeadersAfter,
  getHeadersAbove,
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
  insertBlockTopology,
  getTopologyAuthor,
  getTopologyAuthorBytes,
  getTopologyHeight,
  rollbackBlockTopology,
} from './topology.js';

export {
  insertUtxoTx,
  getPendingEntries,
  iteratePendingEntries,
  purgeExpired,
  removeEntry,
  removeUtxoTxEntry,
  hasPendingLike,
  countPendingInvites,
  hasPendingVouch,
  hasPendingClaim,
  hasPendingClaimBy,
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

export {
  getVouchBox,
  getVouchesForTargetPage,
  getVouchesForVoucherPage,
  getVouchCountForTarget,
  getLapsedVouches,
} from './vouch-queries.js';

export {
  getIdentityRecord,
  putIdentityRecord,
  deleteIdentityRecord,
  getNetworkRecord,
  putNetworkRecord,
  networkRecordKey,
} from './identity-records.js';
export type { IdentityRecord, NetworkRecord } from './identity-records.js';

export {
  insertRefusedHeader,
  anyRefusedHeader,
  purgeRefusedHeaders,
} from './refused-headers.js';

export {
  getUsername,
  getUsernameByOwner,
  putUsername,
  deleteUsername,
  countUsernames,
} from './usernames.js';
export type { UsernameRow, HolderRecord } from './usernames.js';
