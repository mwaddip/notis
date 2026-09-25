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
  ProtocolEra,
  TreasuryBox,
  VouchBox,
  VouchEscrowBox,
} from '@dagsocial/types';
import type { NetworkRecord, UsernameRow } from './utxo-engine.js';

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
  /** `{ txId, index }` for any box the state holds or held, live or spent. */
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
  /** Every live vouch box for the (voucher, target) pair, `id`. */
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
  /** At most `limit` live vouch boxes whose voucher's record fails `member()`, `id`. */
  getLapsedVouches(limit: number): VouchBox[];
  /** The `block_topology` author, or none. */
  getTopologyAuthor(postId: string): Uint8Array | null;
  /** The `block_topology` height, or none. */
  getTopologyHeight(postId: string): number | null;
  getPostStanding(postId: string): PostStanding;
  /** Whether the `(target, liker)` like record exists. */
  hasLikeRecord(targetPostId: string, likerId: Uint8Array): boolean;
}

/**
 * The network profile's numbers the rules read, and nothing else
 * (CONSENSUS_INTERFACE → ApplyContext). A protocol constant the network does
 * not set is imported from `@dagsocial/types`, never carried here.
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
}
