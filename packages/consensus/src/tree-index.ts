import {
  INDEX_MARKER,
  accrualOfKey,
  bondDueKey,
  creditOfKey,
  escrowDueKey,
  escrowOfKey,
  hexToBytes,
  karmaOfKey,
  typeKey,
  vouchPairKey,
  vouchPairValue,
} from '@dagsocial/types';
import type { AnyBox, IdentityRecord } from '@dagsocial/types';

/**
 * The index entries a box places beside its own key (CONSENSUS_INTERFACE → The
 * index entries): each a function of the box's fields, and for a bond of its
 * invitee's `invitedAtBlock`, which the caller hands in — the height of the
 * block that created the bond, so 1 or more (CONSENSUS_INTERFACE → The index
 * entries → "A bond's due height is its invitee's `invitedAtBlock`"). Every
 * value is `INDEX_MARKER` but a vouch pair's, which is the box id. Each value is
 * a fresh array.
 *
 * @throws {Error} for a box that carries no id, or a bond handed no grant height
 */
export function indexEntriesOfBox(
  box: AnyBox,
  invitedAtBlock?: number,
): Array<{ key: Uint8Array; value: Uint8Array }> {
  if (box.id === undefined) throw new Error('indexEntriesOfBox: the box carries no id');
  const id = hexToBytes(box.id);
  const marker = (key: Uint8Array): { key: Uint8Array; value: Uint8Array } =>
    ({ key, value: Uint8Array.from(INDEX_MARKER) });
  switch (box.boxType) {
    case 'karma':
      return [marker(karmaOfKey(box.owner, id))];
    case 'credit':
      return [marker(creditOfKey(box.owner, id))];
    case 'vouch_escrow':
      return [marker(escrowOfKey(box.owner, id)), marker(escrowDueKey(box.releaseAtBlock, id))];
    case 'bond':
      if (invitedAtBlock === undefined || !Number.isSafeInteger(invitedAtBlock) || invitedAtBlock < 1) {
        throw new Error(
          `indexEntriesOfBox: bond ${box.id} needs its invitee's invitedAtBlock, a height of 1 or more — got ${String(invitedAtBlock)}`,
        );
      }
      return [marker(bondDueKey(invitedAtBlock, id))];
    case 'vouch':
      return [{ key: vouchPairKey(box.voucherId, box.targetId), value: vouchPairValue(id) }];
    case 'like_accrual':
      return [marker(accrualOfKey(box.author, id))];
    case 'emission':
    case 'treasury':
    case 'karma_pool':
    case 'backer_pool':
      return [marker(typeKey(box.boxType, id))];
    case 'genesis_proof':
    case 'username':
    case 'karma_price':
    case 'fee':
    case 'backer_stake':
    case 'backer_unstake':
      return [];
    default: {
      const unhandled: never = box;
      throw new Error(`indexEntriesOfBox: box type ${String((unhandled as AnyBox).boxType)} has no entry rule`);
    }
  }
}

/**
 * The record half of the `lapsed` entry's condition (CONSENSUS_INTERFACE → The
 * index entries): a member — `memberSinceBlock > 0` — whose vouches fell below
 * the bar. The other half is a cast count held.
 */
export function isLapsedMember(record: IdentityRecord | null): boolean {
  return record !== null && record.memberSinceBlock > 0 && record.memberVouches < record.memberBar;
}
