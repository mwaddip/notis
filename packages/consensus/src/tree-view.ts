import {
  accrualOfRange,
  bondDueRange,
  boxFromRecordBytes,
  boxKey,
  bytesToHex,
  canonicalUsernameBytes,
  castCountFromBytes,
  castCountKey,
  escrowDueRange,
  escrowOfRange,
  hexToBytes,
  holderKey,
  holderRecordFromBytes,
  identityKey,
  identityRecordFromBytes,
  inRange,
  karmaOfRange,
  keyHeight,
  lapsedRange,
  likeKey,
  nameKey,
  nameRecordFromBytes,
  networkKey,
  networkRecordFromBytes,
  postKey,
  postRecordFromBytes,
  rangeStart,
  typeRange,
  vouchPairBoxId,
  vouchPairKey,
  vouchPairRange,
} from '@dagsocial/types';
import type {
  AnyBox,
  BackerPoolBox,
  BondBox,
  EmissionBox,
  IdentityRecord,
  KarmaBox,
  KarmaPoolBox,
  LikeAccrualBox,
  NetworkRecord,
  PostRecord,
  TreasuryBox,
  TreeRange,
  TypeKeyBoxType,
  UsernameBox,
  VouchBox,
  VouchEscrowBox,
} from '@dagsocial/types';
import type { PostStanding, StateView } from './state-view.js';
import { isSentinel } from './tree-session.js';
import type { TreeLookup, TreeSession } from './tree-session.js';
import type { UsernameRow } from './utxo-engine.js';

/** The `StateView` the rules see, and the one read the tree writes add to it (CONSENSUS_INTERFACE → The tree view). */
export interface TreeStateView extends StateView {
  /** The voucher's cast count — 0 where no entry stands. The writes' own read; no rule makes it. */
  castCountOf(voucherId: Uint8Array): number;
}

/**
 * A tree that contradicts itself — a next key it names with no leaf, a next
 * key no farther along than the one just looked up, an entry naming a box or
 * a record it does not hold, a `lapsed` entry with no vouch under it: a
 * throw, never a verdict (CONSENSUS_INTERFACE → The tree view).
 */
export class TreeInconsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TreeInconsistencyError';
  }
}

/** The tree view over `session` (CONSENSUS_INTERFACE → The tree view): one view per block. */
export function treeStateView(session: TreeSession): TreeStateView {
  return new TreeView(session);
}

// Where an index key carries the box id it names, and a `lapsed` key its
// identity — the tag, then the fields in order (TYPES_INTERFACE → The tree keys).
const OWNED_BOX_ID_AT = 33; // tag ‖ b32(owner) ‖ b32(boxId)
const DUE_BOX_ID_AT = 9; // tag ‖ u64(height) ‖ b32(boxId)
const TYPE_BOX_ID_AT = 2; // tag ‖ enum8(boxType) ‖ b32(boxId)
const LAPSED_IDENTITY_AT = 1; // tag ‖ b32(identityId)

const idAt = (key: Uint8Array, at: number): string => bytesToHex(key.subarray(at, at + 32));

/** Bytewise order of two keys. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length - b.length;
}

const byValueDescThenId = (a: KarmaBox, b: KarmaBox): number =>
  a.value > b.value ? -1 : a.value < b.value ? 1 : a.id! < b.id! ? -1 : a.id! > b.id! ? 1 : 0;

/** A box as its tree value decodes, with no key holding `undefined`. */
function boxOf(id: string, value: Uint8Array): AnyBox {
  const box: Record<string, unknown> = {};
  for (const [field, fieldValue] of Object.entries(boxFromRecordBytes(id, value))) {
    if (fieldValue !== undefined) box[field] = fieldValue;
  }
  return box as unknown as AnyBox;
}

/**
 * Every read looks each key up at most once — the first read memoises the
 * lookup, so a block's reads of the tree are the distinct keys it asked, in the
 * order it first asked them. A value is decoded afresh on every read, so no
 * answer aliases another.
 */
class TreeView implements TreeStateView {
  private readonly memo = new Map<string, TreeLookup>();

  constructor(private readonly session: TreeSession) {}

  // ---------------------------------------------------------------------------
  // Lookups and walks
  // ---------------------------------------------------------------------------

  private look(key: Uint8Array): TreeLookup {
    const hex = bytesToHex(key);
    const known = this.memo.get(hex);
    if (known !== undefined) return known;
    const answer = this.session.lookup(key);
    this.memo.set(hex, answer);
    return answer;
  }

  /**
   * The range's leaves in key order (CONSENSUS_INTERFACE → The tree view → "A
   * range read walks"): the range's start looked up, then each next key while it
   * is in the range, no sentinel, `within` the read, and the limit not reached.
   * A next key is looked up only when it is yielded, so a walk never looks up a
   * sentinel or a key past where it stops. A next key not strictly above the
   * one just looked up is refused before that lookup, never looked up itself.
   */
  private *walk(
    range: TreeRange,
    limit = Infinity,
    within: (key: Uint8Array) => boolean = () => true,
  ): Generator<{ key: Uint8Array; value: Uint8Array }> {
    if (limit <= 0) return;
    const start = rangeStart(range);
    const first = this.look(start);
    let count = 0;
    if (first.found && within(start)) {
      yield { key: start, value: first.value };
      count++;
    }
    let lastKey = start;
    let next = first.nextKey;
    while (count < limit && !isSentinel(next) && inRange(next, range) && within(next)) {
      if (compareBytes(next, lastKey) <= 0) {
        throw new TreeInconsistencyError(
          `the tree names ${bytesToHex(next)} as a next key of ${bytesToHex(lastKey)}, no farther along`,
        );
      }
      const step = this.look(next);
      if (!step.found) {
        throw new TreeInconsistencyError(`the tree names ${bytesToHex(next)} as a next key and holds no leaf for it`);
      }
      yield { key: next, value: step.value };
      count++;
      lastKey = next;
      next = step.nextKey;
    }
  }

  /** The live box `id` names, of `boxType` — an entry naming no such box is a tree that contradicts itself. */
  private namedBox<T extends AnyBox['boxType']>(id: string, boxType: T, entry: Uint8Array): Extract<AnyBox, { boxType: T }> {
    const box = this.getBox(id);
    if (box === null || box.boxType !== boxType) {
      throw new TreeInconsistencyError(
        `the tree's entry ${bytesToHex(entry)} names ${id}, which is no live ${boxType} box`,
      );
    }
    return box as Extract<AnyBox, { boxType: T }>;
  }

  private indexedBoxes<T extends AnyBox['boxType']>(
    range: TreeRange,
    boxIdAt: number,
    boxType: T,
    limit?: number,
    within?: (key: Uint8Array) => boolean,
  ): Array<Extract<AnyBox, { boxType: T }>> {
    const boxes: Array<Extract<AnyBox, { boxType: T }>> = [];
    for (const { key } of this.walk(range, limit, within)) boxes.push(this.namedBox(idAt(key, boxIdAt), boxType, key));
    return boxes;
  }

  private firstOfType<T extends TypeKeyBoxType>(boxType: T): Extract<AnyBox, { boxType: T }> | null {
    return this.indexedBoxes(typeRange(boxType), TYPE_BOX_ID_AT, boxType, 1)[0] ?? null;
  }

  // ---------------------------------------------------------------------------
  // Keyed reads
  // ---------------------------------------------------------------------------

  getBox(id: string): AnyBox | null {
    const answer = this.look(boxKey(hexToBytes(id)));
    return answer.found ? boxOf(id, answer.value) : null;
  }

  getBoxProvenance(id: string): { txId: string; index: number } | null {
    const box = this.getBox(id);
    return box === null ? null : { txId: box.txId, index: box.index };
  }

  getIdentityRecord(identityId: Uint8Array): IdentityRecord | null {
    const answer = this.look(identityKey(identityId));
    return answer.found ? identityRecordFromBytes(answer.value) : null;
  }

  getNetworkRecord(): NetworkRecord {
    const answer = this.look(networkKey());
    if (!answer.found) throw new TreeInconsistencyError('the tree holds no network record, which exists from genesis');
    return networkRecordFromBytes(answer.value);
  }

  /** The name's row, rebuilt from the tree (CONSENSUS_INTERFACE → The tree view → "The name and holder reads rebuild the row from the tree"). */
  getUsername(nameLower: string): UsernameRow | null {
    const key = nameKey(new TextEncoder().encode(nameLower));
    const answer = this.look(key);
    if (!answer.found) return null;
    const { boxId, claimedAtBlock } = nameRecordFromBytes(answer.value);
    const row = rowOf(this.namedBox(boxId, 'username', key), claimedAtBlock);
    if (row.nameLower !== nameLower) {
      throw new TreeInconsistencyError(`the name entry ${bytesToHex(key)} names ${boxId}, whose name is ${row.nameLower}`);
    }
    return row;
  }

  /** The owner's name row: the holder record's box, then that name's record for `claimedAtBlock`. */
  getUsernameByOwner(owner: Uint8Array): UsernameRow | null {
    const key = holderKey(owner);
    const answer = this.look(key);
    if (!answer.found) return null;
    const { boxId } = holderRecordFromBytes(answer.value);
    if (boxId === null) return null;
    const box = this.namedBox(boxId, 'username', key);
    const nameEntry = nameKey(canonicalUsernameBytes(box.name));
    const named = this.look(nameEntry);
    const record = named.found ? nameRecordFromBytes(named.value) : null;
    if (record === null || record.boxId !== boxId) {
      throw new TreeInconsistencyError(
        `the holder entry ${bytesToHex(key)} names ${boxId}, whose name record ${bytesToHex(nameEntry)} does not`,
      );
    }
    return rowOf(box, record.claimedAtBlock);
  }

  getTopologyAuthor(postId: string): Uint8Array | null {
    return this.postRecord(postId)?.author ?? null;
  }

  getTopologyHeight(postId: string): number | null {
    return this.postRecord(postId)?.height ?? null;
  }

  getPostStanding(postId: string): PostStanding {
    return this.postRecord(postId)?.standing ?? 'none';
  }

  hasLikeRecord(targetPostId: string, likerId: Uint8Array): boolean {
    return this.look(likeKey(hexToBytes(targetPostId), likerId)).found;
  }

  castCountOf(voucherId: Uint8Array): number {
    const answer = this.look(castCountKey(voucherId));
    return answer.found ? castCountFromBytes(answer.value) : 0;
  }

  private postRecord(postId: string): PostRecord | null {
    const answer = this.look(postKey(hexToBytes(postId)));
    return answer.found ? postRecordFromBytes(answer.value) : null;
  }

  // ---------------------------------------------------------------------------
  // Range reads
  // ---------------------------------------------------------------------------

  getEmissionBox(): EmissionBox | null {
    return this.firstOfType('emission');
  }

  getTreasuryBox(): TreasuryBox | null {
    return this.firstOfType('treasury');
  }

  getKarmaPoolBox(): KarmaPoolBox | null {
    return this.firstOfType('karma_pool');
  }

  getBackerPoolBox(): BackerPoolBox | null {
    return this.firstOfType('backer_pool');
  }

  /** The owner's whole range, sorted `value DESC, id` — the read has no limit. */
  getKarmaBoxes(owner: Uint8Array): KarmaBox[] {
    return this.indexedBoxes(karmaOfRange(owner), OWNED_BOX_ID_AT, 'karma').sort(byValueDescThenId);
  }

  getVouchEscrowsFor(voucherId: Uint8Array): VouchEscrowBox[] {
    return this.indexedBoxes(escrowOfRange(voucherId), OWNED_BOX_ID_AT, 'vouch_escrow');
  }

  getLikeAccrualBoxes(author: Uint8Array): LikeAccrualBox[] {
    return this.indexedBoxes(accrualOfRange(author), OWNED_BOX_ID_AT, 'like_accrual');
  }

  getVouchBoxes(voucherId: Uint8Array, targetId: Uint8Array): VouchBox[] {
    const key = vouchPairKey(voucherId, targetId);
    const answer = this.look(key);
    return answer.found ? [this.namedBox(bytesToHex(vouchPairBoxId(answer.value)), 'vouch', key)] : [];
  }

  /** The `bondDue` walk while the key's height is `≤ maxInvitedAt` (CONSENSUS_INTERFACE → The tree view → "The due queues stop at a height"). */
  getBondsInvitedAt(maxInvitedAt: number, limit: number): BondBox[] {
    return this.indexedBoxes(bondDueRange(), DUE_BOX_ID_AT, 'bond', limit, (key) => keyHeight(key) <= maxInvitedAt);
  }

  getVouchEscrowsReleasableAt(height: number, limit: number): VouchEscrowBox[] {
    return this.indexedBoxes(escrowDueRange(), DUE_BOX_ID_AT, 'vouch_escrow', limit, (key) => keyHeight(key) <= height);
  }

  /**
   * The `lapsed` walk and, for each voucher, their `vouchPair` walk, one limit
   * shared across them (CONSENSUS_INTERFACE → The tree view → "The lapses share
   * one limit"). A `lapsed` entry stands only while its voucher holds a vouch
   * (CONSENSUS_INTERFACE → The index entries), so an empty pair range under one
   * is a tree that contradicts itself.
   */
  getLapsedVouches(limit: number): VouchBox[] {
    const vouches: VouchBox[] = [];
    if (limit <= 0) return vouches;
    for (const { key } of this.walk(lapsedRange())) {
      const voucherId = key.subarray(LAPSED_IDENTITY_AT, LAPSED_IDENTITY_AT + 32);
      const before = vouches.length;
      for (const pair of this.walk(vouchPairRange(voucherId), limit - vouches.length)) {
        vouches.push(this.namedBox(bytesToHex(vouchPairBoxId(pair.value)), 'vouch', pair.key));
      }
      if (vouches.length === before) {
        throw new TreeInconsistencyError(`the tree's lapsed entry ${bytesToHex(key)} stands over no vouch`);
      }
      if (vouches.length >= limit) break;
    }
    return vouches;
  }
}

/** A name's row from its box and its record (CONSENSUS_INTERFACE → The tree view). */
function rowOf(box: UsernameBox, claimedAtBlock: number): UsernameRow {
  const decoder = new TextDecoder('utf-8');
  return {
    nameLower: decoder.decode(canonicalUsernameBytes(box.name)),
    name: decoder.decode(box.name),
    owner: bytesToHex(box.owner),
    boxId: box.id!,
    claimedAtBlock,
  };
}
