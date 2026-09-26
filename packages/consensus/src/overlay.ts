import { isMember } from './utxo-engine.js';
import type { NetworkRecord, UsernameRow } from './utxo-engine.js';
import type { PostStanding, StateView } from './state-view.js';
import { bytesToHex, hexToBytes } from '@dagsocial/types';
import type {
  AnyBox,
  BackerPoolBox,
  BondBox,
  EmissionBox,
  IdentityRecord,
  KarmaBox,
  KarmaPoolBox,
  LikeAccrualBox,
  TreasuryBox,
  VouchBox,
  VouchEscrowBox,
} from '@dagsocial/types';

/**
 * The holder record (NODE_INTERFACE → Username records). An absent record means
 * `{ claimAvailable: true, boxId: null }`, and a record equal to that meaning is
 * never written: a burn removes it.
 */
export interface HolderRecord {
  claimAvailable: boolean;
  boxId: string | null;
}

/**
 * One write to committed state (CONSENSUS_INTERFACE → BlockEffects).
 *
 * `heldBefore` on a name or holder mutation says whether the state held its key
 * just before this write, so the AVL feed nets out a key the block both creates
 * and removes (NODE_INTERFACE → "A removable record the block creates and
 * removes nets out, as a box does").
 */
export type BlockMutation =
  | { kind: 'box'; op: 'insert'; boxId: string; box: AnyBox }
  | { kind: 'box'; op: 'remove'; boxId: string }
  | { kind: 'record'; identityId: Uint8Array; record: IdentityRecord }
  | { kind: 'network'; record: NetworkRecord }
  | { kind: 'username'; nameLower: string; row: UsernameRow | null; heldBefore: boolean }
  | { kind: 'holder'; owner: Uint8Array; record: HolderRecord | null; heldBefore: boolean };

/**
 * A limited query read after the block wrote into its set. The view's answer
 * stops at the limit, so it cannot be recomputed over the block's writes, and
 * the overlay throws instead of answering: a tripwire, never a verdict
 * (CONSENSUS_INTERFACE → The overlay).
 */
export class LimitedQueryAfterWriteError extends Error {
  constructor(readonly query: string) {
    super(`${query}: read after the block wrote into its set, which the view's limited answer cannot recompute`);
    this.name = 'LimitedQueryAfterWriteError';
  }
}

/** An insert of a box id the state holds or held, live or spent (CONSENSUS_INTERFACE → The overlay). */
export class BoxIdTakenError extends Error {
  constructor(readonly boxId: string) {
    super(`insertBox: ${boxId} is a box id the state holds or held`);
    this.name = 'BoxIdTakenError';
  }
}

/** A spend of a box that is not live (CONSENSUS_INTERFACE → The overlay). */
export class SpendOfNonLiveBoxError extends Error {
  constructor(readonly boxId: string) {
    super(`consumeBox: ${boxId} names no live box — absent, or already spent`);
    this.name = 'SpendOfNonLiveBoxError';
  }
}

const hex = (bytes: Uint8Array): string => bytesToHex(bytes);

const byId = (a: AnyBox, b: AnyBox): number => (a.id! < b.id! ? -1 : a.id! > b.id! ? 1 : 0);

const byValueDescThenId = (a: AnyBox, b: AnyBox): number =>
  a.value > b.value ? -1 : a.value < b.value ? 1 : byId(a, b);

const likeKey = (targetPostId: string, likerId: Uint8Array): string =>
  `${targetPostId}:${hex(likerId)}`;

/** The key of the composed query that lists this box, or null for a box none lists. */
function composedKeyOf(box: AnyBox): string | null {
  switch (box.boxType) {
    case 'karma':
      return `karma:${hex(box.owner)}`;
    case 'vouch_escrow':
      return `escrow:${hex(box.owner)}`;
    case 'vouch':
      return `vouch:${hex(box.voucherId)}:${hex(box.targetId)}`;
    case 'like_accrual':
      return `accrual:${hex(box.author)}`;
    default:
      return null;
  }
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * A box the block inserted, as a read answers it: a copy, every byte field a
 * plain `Uint8Array` and no key that holds `undefined`.
 */
function readBackBox<B extends AnyBox>(box: B): B {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(box)) {
    if (value === undefined) continue;
    copy[key] = value instanceof Uint8Array ? new Uint8Array(value) : value;
  }
  return copy as B;
}

/** An identity record the block wrote, as a read answers it: a copy, its fields in the record's declared order. */
function readBackRecord(record: IdentityRecord): IdentityRecord {
  return {
    lastActivityBlock: record.lastActivityBlock,
    lastDecayBlock: record.lastDecayBlock,
    invitedAtBlock: record.invitedAtBlock,
    lifetimeLikesReceived: record.lifetimeLikesReceived,
    memberSinceBlock: record.memberSinceBlock,
    memberBar: record.memberBar,
    memberVouches: record.memberVouches,
    memberLikes: record.memberLikes,
    invitesUsed: record.invitesUsed,
  };
}

/** A name row the block wrote, as a read answers it: a copy, or none for a removal. */
function readBackRow(row: UsernameRow | null): UsernameRow | null {
  return row === null
    ? null
    : { nameLower: row.nameLower, name: row.name, owner: row.owner, boxId: row.boxId, claimedAtBlock: row.claimedAtBlock };
}

/**
 * The block-local layer `applyBlock` reads and writes through
 * (CONSENSUS_INTERFACE → The overlay). Every write is visible to every later
 * read of the block and to no read outside it; the view underneath is never
 * written.
 *
 * - **A keyed read** answers from the block's own entry first, the view's
 *   otherwise — but `block_topology` keeps a post's first confirmation, so
 *   there the view's row answers first.
 * - **An unlimited query** composes the view's answer with the block's writes
 *   under the query's own order: the block's spent boxes out, its live inserts
 *   in.
 * - **A limited query** answers the view's answer while the block has written
 *   nothing into its set, and throws `LimitedQueryAfterWriteError` after.
 * - **The store's backstops**: an insert of a box id the state holds or held
 *   throws `BoxIdTakenError`; a spend of a box that is not live throws
 *   `SpendOfNonLiveBoxError`.
 * - **A read of what the block wrote answers a copy** — of a box, a record, a
 *   name row or a post's author — with every byte field a plain `Uint8Array`
 *   and a record's fields in its declared order, whatever carried the bytes the
 *   block was decoded from; no reader holds an object the effects hold.
 *
 * `mutations`, `likeRecords` and `withdrawals` are the block's writes in the
 * order it made them — the effects' own lists (CONSENSUS_INTERFACE →
 * BlockEffects); an inserted box is listed as the object the block passed.
 */
export class BlockOverlay implements StateView {
  readonly mutations: BlockMutation[] = [];
  readonly likeRecords: Array<{ targetPostId: string; likerId: Uint8Array }> = [];
  readonly withdrawals: string[] = [];

  private readonly view: StateView;
  private readonly inserted = new Map<string, AnyBox>();
  private readonly spent = new Map<string, AnyBox>();
  private readonly insertedByType = new Map<AnyBox['boxType'], AnyBox[]>();
  private readonly spentByType = new Map<AnyBox['boxType'], AnyBox[]>();
  private readonly composedInserts = new Map<string, AnyBox[]>();
  private readonly records = new Map<string, { identityId: Uint8Array; record: IdentityRecord }>();
  private network: NetworkRecord | null = null;
  /** Name records the block wrote, by canonical name; `null` is a removal. */
  private readonly names = new Map<string, UsernameRow | null>();
  /** Holder records the block wrote, as the owner's name row, by owner hex; `null` is a removal. */
  private readonly holders = new Map<string, UsernameRow | null>();
  private readonly topology = new Map<string, { author: Uint8Array; height: number }>();
  private readonly confirmed = new Set<string>();
  private readonly withdrawn = new Set<string>();
  private readonly likes = new Set<string>();

  constructor(view: StateView) {
    this.view = view;
  }

  // ---------------------------------------------------------------------------
  // Keyed reads
  // ---------------------------------------------------------------------------

  getBox(id: string): AnyBox | null {
    if (this.spent.has(id)) return null;
    const inserted = this.inserted.get(id);
    return inserted !== undefined ? readBackBox(inserted) : this.view.getBox(id);
  }

  getBoxProvenance(id: string): { txId: string; index: number } | null {
    const box = this.inserted.get(id);
    return box !== undefined ? { txId: box.txId, index: box.index } : this.view.getBoxProvenance(id);
  }

  getIdentityRecord(identityId: Uint8Array): IdentityRecord | null {
    const written = this.records.get(hex(identityId));
    return written !== undefined ? readBackRecord(written.record) : this.view.getIdentityRecord(identityId);
  }

  getNetworkRecord(): NetworkRecord {
    return this.network !== null ? { memberCount: this.network.memberCount } : this.view.getNetworkRecord();
  }

  getUsername(nameLower: string): UsernameRow | null {
    const written = this.names.get(nameLower);
    return written !== undefined ? readBackRow(written) : this.view.getUsername(nameLower);
  }

  getUsernameByOwner(owner: Uint8Array): UsernameRow | null {
    const written = this.holders.get(hex(owner));
    return written !== undefined ? readBackRow(written) : this.view.getUsernameByOwner(owner);
  }

  /**
   * `block_topology` keeps the first confirmation of a post id, so a row the
   * view holds answers ahead of the block's own (NODE_INTERFACE → Block
   * Topology).
   */
  getTopologyAuthor(postId: string): Uint8Array | null {
    const fromView = this.view.getTopologyAuthor(postId);
    if (fromView !== null) return fromView;
    const written = this.topology.get(postId);
    return written !== undefined ? new Uint8Array(written.author) : null;
  }

  getTopologyHeight(postId: string): number | null {
    return this.view.getTopologyHeight(postId) ?? this.topology.get(postId)?.height ?? null;
  }

  /**
   * A post the block confirmed with no row is a placeholder, and a placeholder is
   * live (NODE_INTERFACE → Post transactions → "A post applied without its
   * packet is a placeholder").
   */
  getPostStanding(postId: string): PostStanding {
    if (this.withdrawn.has(postId)) return 'withdrawn';
    const standing = this.view.getPostStanding(postId);
    return standing === 'none' && this.confirmed.has(postId) ? 'live' : standing;
  }

  hasLikeRecord(targetPostId: string, likerId: Uint8Array): boolean {
    return this.likes.has(likeKey(targetPostId, likerId)) || this.view.hasLikeRecord(targetPostId, likerId);
  }

  // ---------------------------------------------------------------------------
  // Unlimited queries — composed
  // ---------------------------------------------------------------------------

  getKarmaBoxes(owner: Uint8Array): KarmaBox[] {
    return this.compose(this.view.getKarmaBoxes(owner), `karma:${hex(owner)}`, byValueDescThenId);
  }

  getVouchEscrowsFor(voucherId: Uint8Array): VouchEscrowBox[] {
    return this.compose(this.view.getVouchEscrowsFor(voucherId), `escrow:${hex(voucherId)}`, byId);
  }

  getVouchBoxes(voucherId: Uint8Array, targetId: Uint8Array): VouchBox[] {
    return this.compose(
      this.view.getVouchBoxes(voucherId, targetId),
      `vouch:${hex(voucherId)}:${hex(targetId)}`,
      byId,
    );
  }

  getLikeAccrualBoxes(author: Uint8Array): LikeAccrualBox[] {
    return this.compose(this.view.getLikeAccrualBoxes(author), `accrual:${hex(author)}`, byId);
  }

  /** The view's answer less the block's spends, plus the block's live inserts, in the query's order. */
  private compose<B extends AnyBox>(
    fromView: B[],
    key: string,
    order: (a: AnyBox, b: AnyBox) => number,
  ): B[] {
    const kept = fromView.filter((box) => !this.spent.has(box.id!));
    const added = (this.composedInserts.get(key) ?? [])
      .filter((box) => !this.spent.has(box.id!))
      .map((box) => readBackBox(box) as B);
    return added.length === 0 ? kept : [...kept, ...added].sort(order);
  }

  // ---------------------------------------------------------------------------
  // Limited queries — the view's answer, or the tripwire
  // ---------------------------------------------------------------------------

  getEmissionBox(): EmissionBox | null {
    this.throwIfWritten('getEmissionBox', this.touchedType('emission'));
    return this.view.getEmissionBox();
  }

  getTreasuryBox(): TreasuryBox | null {
    this.throwIfWritten('getTreasuryBox', this.touchedType('treasury'));
    return this.view.getTreasuryBox();
  }

  getKarmaPoolBox(): KarmaPoolBox | null {
    this.throwIfWritten('getKarmaPoolBox', this.touchedType('karma_pool'));
    return this.view.getKarmaPoolBox();
  }

  getBackerPoolBox(): BackerPoolBox | null {
    this.throwIfWritten('getBackerPoolBox', this.touchedType('backer_pool'));
    return this.view.getBackerPoolBox();
  }

  /**
   * The set is the live bonds whose invitee's record holds
   * `0 < invitedAtBlock ≤ maxInvitedAt`, so a bond spent, a bond inserted for an
   * invitee inside the range, or a record written into or out of the range
   * writes into it.
   */
  getBondsInvitedAt(maxInvitedAt: number, limit: number): BondBox[] {
    const inSet = (record: IdentityRecord | null): boolean =>
      record !== null && record.invitedAtBlock > 0 && record.invitedAtBlock <= maxInvitedAt;
    this.throwIfWritten(
      'getBondsInvitedAt',
      this.ofType(this.spentByType, 'bond').length > 0 ||
        this.ofType(this.insertedByType, 'bond').some((box) =>
          inSet(this.getIdentityRecord((box as BondBox).inviteePublicKey))) ||
        this.recordWritesMove(inSet),
    );
    return this.view.getBondsInvitedAt(maxInvitedAt, limit);
  }

  getVouchEscrowsReleasableAt(height: number, limit: number): VouchEscrowBox[] {
    this.throwIfWritten(
      'getVouchEscrowsReleasableAt',
      this.ofType(this.spentByType, 'vouch_escrow').length > 0 ||
        this.ofType(this.insertedByType, 'vouch_escrow').some((box) =>
          (box as VouchEscrowBox).releaseAtBlock <= height),
    );
    return this.view.getVouchEscrowsReleasableAt(height, limit);
  }

  /**
   * The set is the live vouch boxes whose voucher's record fails `member()`, so a
   * vouch spent, a vouch inserted by such a voucher, or a record written across
   * `member()` writes into it.
   */
  getLapsedVouches(limit: number): VouchBox[] {
    const lapsed = (record: IdentityRecord | null): boolean => record !== null && !isMember(record);
    this.throwIfWritten(
      'getLapsedVouches',
      this.ofType(this.spentByType, 'vouch').length > 0 ||
        this.ofType(this.insertedByType, 'vouch').some((box) =>
          lapsed(this.getIdentityRecord((box as VouchBox).voucherId))) ||
        this.recordWritesMove(lapsed),
    );
    return this.view.getLapsedVouches(limit);
  }

  private touchedType(boxType: AnyBox['boxType']): boolean {
    return this.insertedByType.has(boxType) || this.spentByType.has(boxType);
  }

  private ofType(map: Map<AnyBox['boxType'], AnyBox[]>, boxType: AnyBox['boxType']): AnyBox[] {
    return map.get(boxType) ?? [];
  }

  /** Whether a record the block wrote answers `inSet` differently from the view's record. */
  private recordWritesMove(inSet: (record: IdentityRecord | null) => boolean): boolean {
    for (const { identityId, record } of this.records.values()) {
      if (inSet(record) !== inSet(this.view.getIdentityRecord(identityId))) return true;
    }
    return false;
  }

  private throwIfWritten(query: string, written: boolean): void {
    if (written) throw new LimitedQueryAfterWriteError(query);
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  insertBox(box: AnyBox): void {
    const id = box.id;
    if (id === undefined) throw new Error('insertBox: the box carries no id');
    if (this.inserted.has(id) || this.view.getBoxProvenance(id) !== null) {
      throw new BoxIdTakenError(id);
    }
    this.inserted.set(id, box);
    append(this.insertedByType, box.boxType, box);
    const key = composedKeyOf(box);
    if (key !== null) append(this.composedInserts, key, box);
    this.mutations.push({ kind: 'box', op: 'insert', boxId: id, box });
  }

  consumeBox(id: string): void {
    const box = this.spent.has(id) ? null : (this.inserted.get(id) ?? this.view.getBox(id));
    if (box === null) throw new SpendOfNonLiveBoxError(id);
    this.spent.set(id, box);
    append(this.spentByType, box.boxType, box);
    this.mutations.push({ kind: 'box', op: 'remove', boxId: id });
  }

  putIdentityRecord(identityId: Uint8Array, record: IdentityRecord): void {
    this.records.set(hex(identityId), { identityId, record });
    this.mutations.push({ kind: 'record', identityId, record });
  }

  putNetworkRecord(record: NetworkRecord): void {
    this.network = record;
    this.mutations.push({ kind: 'network', record });
  }

  /**
   * A claim: the name record, and the holder record `{ claimAvailable: false,
   * boxId }` for its owner (NODE_INTERFACE → Username records).
   */
  putUsername(row: UsernameRow): void {
    const owner = hexToBytes(row.owner);
    const nameHeld = this.getUsername(row.nameLower) !== null;
    const holderHeld = this.getUsernameByOwner(owner) !== null;
    this.names.set(row.nameLower, row);
    this.holders.set(hex(owner), row);
    this.mutations.push({ kind: 'username', nameLower: row.nameLower, row, heldBefore: nameHeld });
    this.mutations.push({
      kind: 'holder',
      owner,
      record: { claimAvailable: false, boxId: row.boxId },
      heldBefore: holderHeld,
    });
  }

  /**
   * A burn: both records removed (NODE_INTERFACE → Username records). A name no
   * record holds writes nothing.
   */
  deleteUsername(nameLower: string): void {
    const existing = this.getUsername(nameLower);
    if (existing === null) return;
    const owner = hexToBytes(existing.owner);
    const holderHeld = this.getUsernameByOwner(owner) !== null;
    this.names.set(nameLower, null);
    this.holders.set(hex(owner), null);
    this.mutations.push({ kind: 'username', nameLower, row: null, heldBefore: true });
    this.mutations.push({ kind: 'holder', owner, record: null, heldBefore: holderHeld });
  }

  /** The post's row, or its placeholder when the view holds none, is confirmed by the block. */
  confirmPost(postId: string): void {
    this.confirmed.add(postId);
  }

  insertBlockTopology(postId: string, author: Uint8Array, height: number): void {
    if (!this.topology.has(postId)) this.topology.set(postId, { author, height });
  }

  withdrawPost(postId: string): void {
    this.withdrawn.add(postId);
    this.withdrawals.push(postId);
  }

  insertLikeRecord(targetPostId: string, likerId: Uint8Array): void {
    this.likes.add(likeKey(targetPostId, likerId));
    this.likeRecords.push({ targetPostId, likerId });
  }
}
