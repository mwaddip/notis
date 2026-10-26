import type {
  AnyBox,
  BackerPoolBox,
  BondBox,
  DecayCfg,
  EmissionBox,
  IdentityRecord,
  KarmaBox,
  KarmaPoolBox,
  LikeAccrualBox,
  NetworkRecord,
  ProtocolEra,
  TreasuryBox,
  VouchBox,
  VouchEscrowBox,
} from '@dagsocial/types';
import type { Ed25519BatchEntry } from '@dagsocial/validation';
import type { UsernameRow } from './utxo-engine.js';

/** A post's standing in the DAG: a row that is live, a row that is withdrawn, or no row. */
export type PostStanding = 'live' | 'withdrawn' | 'none';

/**
 * Everything the rules read, and nothing else (CONSENSUS_INTERFACE → StateView).
 *
 * **Read-only.** The node answers each read with its store's own query for it,
 * the order and the limit included; a leaf answers from proofs. `applyBlock`
 * reads it through its overlay and never writes it (CONSENSUS_INTERFACE → The
 * overlay).
 *
 * The orders below are the queries' own: a caller that returns a different
 * order hands the rules a different verdict wherever a list is hashed or cut.
 */
export interface StateView {
  /** The box, if live. */
  getBox(id: string): AnyBox | null;
  /** `{ txId, index }` for a live box. */
  getBoxProvenance(id: string): { txId: string; index: number } | null;
  getIdentityRecord(identityId: Uint8Array): IdentityRecord | null;
  /** The member count. The record exists from genesis seeding on. */
  getNetworkRecord(): NetworkRecord;
  /** The name record — the row for a canonical name, or none. */
  getUsername(nameLower: string): UsernameRow | null;
  /** The holder record — the owner's name row, or none. */
  getUsernameByOwner(owner: Uint8Array): UsernameRow | null;
  /** The live box of the type, or none — `ORDER BY id LIMIT 1`. */
  getEmissionBox(): EmissionBox | null;
  /** The live box of the type, or none — `ORDER BY id LIMIT 1`. */
  getTreasuryBox(): TreasuryBox | null;
  /** The live box of the type, or none — `ORDER BY id LIMIT 1`. */
  getKarmaPoolBox(): KarmaPoolBox | null;
  /** The live box of the type, or none — `ORDER BY id LIMIT 1`. */
  getBackerPoolBox(): BackerPoolBox | null;
  /** Every live karma box of the owner, `value DESC, id`. */
  getKarmaBoxes(owner: Uint8Array): KarmaBox[];
  /** Every live escrow the voucher owns, `id`. */
  getVouchEscrowsFor(voucherId: Uint8Array): VouchEscrowBox[];
  /** The pair's live vouch box — one at most (NODE_INTERFACE → Vouch transition rules). */
  getVouchBoxes(voucherId: Uint8Array, targetId: Uint8Array): VouchBox[];
  /** Every live `like_accrual` box naming the author, `id`. */
  getLikeAccrualBoxes(author: Uint8Array): LikeAccrualBox[];
  /**
   * At most `limit` live bonds whose invitee's record holds
   * `0 < invitedAtBlock ≤ maxInvitedAt`, `(invitedAtBlock, id)`.
   */
  getBondsInvitedAt(maxInvitedAt: number, limit: number): BondBox[];
  /** At most `limit` live escrows with `releaseAtBlock ≤ height`, `(releaseAtBlock, id)`. */
  getVouchEscrowsReleasableAt(height: number, limit: number): VouchEscrowBox[];
  /**
   * At most `limit` live vouch boxes whose voucher is a lapsed member —
   * `memberSinceBlock > 0` and failing `member()` (CONSENSUS_INTERFACE → What it
   * holds → "Membership is one predicate") — voucher by voucher and each
   * voucher's in target order (CONSENSUS_INTERFACE → StateView → "The lapses run
   * voucher by voucher").
   */
  getLapsedVouches(limit: number): VouchBox[];
  /** The post's recorded author — the post record under the state root (NODE_INTERFACE → Block Topology → "Block application reads the record, through the tree view"), or none. */
  getTopologyAuthor(postId: string): Uint8Array | null;
  /** The post's recorded height — the post record under the state root (NODE_INTERFACE → Block Topology → "Block application reads the record, through the tree view"), or none. */
  getTopologyHeight(postId: string): number | null;
  getPostStanding(postId: string): PostStanding;
  /** Whether the `(target, liker)` like record exists. */
  hasLikeRecord(targetPostId: string, likerId: Uint8Array): boolean;
}

/**
 * The signature checks the caller hands the rules, each answering what
 * `validation`'s rule does (CONSENSUS_INTERFACE → ApplyContext).
 * `verify` is `screenBody`'s per-entry check and `verifyBatch` is
 * `applyBlock`'s one call over the body's entries.
 */
export interface SignatureChecks {
  verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean;
  verifyBatch(entries: ReadonlyArray<Ed25519BatchEntry>): boolean;
}

/**
 * The network profile's numbers the rules read, and the signature checks when
 * its caller has its own (CONSENSUS_INTERFACE → ApplyContext). A protocol
 * constant the network does not set is imported from `@dagsocial/types`,
 * never carried here.
 */
export interface ApplyContext {
  protocolVersionSchedule: readonly ProtocolEra[];
  vouchCooldownBlocks: number;
  inviteBondMin: bigint;
  inviteBondMax: bigint;
  inviteProbationBlocks: number;
  decayCfg: DecayCfg;
  storageRentPeriodBlocks: number;
  membershipBarMultiplier: number;
  backerSupply: bigint;
  creditFixedRateBlocks: number;
  creditEpochBlocks: number;
  creditMinerRewardDelay: number;
  /**
   * The caller's signature checks, each answering what `validation`'s does
   * (CONSENSUS_INTERFACE → ApplyContext). `applyBlock` makes its one batch
   * call through `signatureChecks.verifyBatch` and `screenBody`'s per-entry
   * check goes through `signatureChecks.verify`; absent, `validation`'s
   * `verifyEd25519Batch` and `verifyEd25519` answer.
   */
  signatureChecks?: SignatureChecks;
}
