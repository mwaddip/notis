import {
  INDEX_MARKER,
  boxKey,
  boxRecordBytes,
  bytesToHex,
  castCountBytes,
  castCountKey,
  hexToBytes,
  identityKey,
  identityRecordBytes,
  lapsedKey,
  networkKey,
  networkRecordBytes,
} from '@dagsocial/types';
import type { AnyBox, IdentityRecord, NetworkRecord } from '@dagsocial/types';
import { indexEntriesOfBox, isLapsedMember } from './tree-index.js';

/** One operation on the tree (CONSENSUS_INTERFACE → The tree writes). */
export type TreeWrite =
  | { tag: 'Remove'; key: Uint8Array }
  | { tag: 'Insert'; key: Uint8Array; value: Uint8Array }
  | { tag: 'Update'; key: Uint8Array; value: Uint8Array }
  | { tag: 'InsertOrUpdate'; key: Uint8Array; value: Uint8Array };

/**
 * Genesis as tree writes (CONSENSUS_INTERFACE → The tree writes →
 * "`seedTreeWrites(boxes, records, network)` is genesis"): every box with its
 * index entries — a bond's due height its invitee's `invitedAtBlock` among
 * `records` — each voucher's cast count, every record with its `lapsed` entry
 * where both halves hold, and the network record, all `Insert`s in ascending
 * key order.
 *
 * @throws {Error} for a bond whose invitee holds no record among `records`, and
 *   for a seed that writes one key twice
 */
export function seedTreeWrites(
  boxes: readonly AnyBox[],
  records: ReadonlyArray<{ identityId: Uint8Array; record: IdentityRecord }>,
  network: NetworkRecord,
): TreeWrite[] {
  const writes: TreeWrite[] = [];
  const recordOf = new Map(records.map(({ identityId, record }) => [bytesToHex(identityId), record]));
  const castCounts = new Map<string, { voucherId: Uint8Array; count: number }>();

  for (const box of boxes) {
    writes.push({ tag: 'Insert', key: boxKey(hexToBytes(box.id!)), value: boxRecordBytes(box, box.txId, box.index) });
    let invitedAtBlock: number | undefined;
    if (box.boxType === 'bond') {
      const invitee = recordOf.get(bytesToHex(box.inviteePublicKey));
      if (invitee === undefined) {
        throw new Error(`seedTreeWrites: bond ${box.id} names an invitee who holds no record among the seed's`);
      }
      invitedAtBlock = invitee.invitedAtBlock;
    }
    for (const { key, value } of indexEntriesOfBox(box, invitedAtBlock)) writes.push({ tag: 'Insert', key, value });
    if (box.boxType === 'vouch') {
      const voucher = bytesToHex(box.voucherId);
      const counted = castCounts.get(voucher);
      if (counted !== undefined) counted.count++;
      else castCounts.set(voucher, { voucherId: box.voucherId, count: 1 });
    }
  }
  for (const { voucherId, count } of castCounts.values()) {
    writes.push({ tag: 'Insert', key: castCountKey(voucherId), value: castCountBytes(count) });
  }
  for (const { identityId, record } of records) {
    writes.push({ tag: 'Insert', key: identityKey(identityId), value: identityRecordBytes(record) });
    if (isLapsedMember(record) && castCounts.has(bytesToHex(identityId))) {
      writes.push({ tag: 'Insert', key: lapsedKey(identityId), value: Uint8Array.from(INDEX_MARKER) });
    }
  }
  writes.push({ tag: 'Insert', key: networkKey(), value: networkRecordBytes(network) });
  return ordered(writes, 'seedTreeWrites');
}

/** Where each tag's writes fall in a block's order (CONSENSUS_INTERFACE → The tree writes). */
const TAG_RANK: Readonly<Record<TreeWrite['tag'], number>> = { Remove: 0, Insert: 1, Update: 2, InsertOrUpdate: 3 };

/**
 * The writes in their consensus order — every `Remove`, then every `Insert`, then
 * every `Update`, then every `InsertOrUpdate`, each run by key, bytewise
 * (CONSENSUS_INTERFACE → The tree writes → "The order is a consensus rule,
 * because an AVL+ digest depends on the order of its operations").
 *
 * @throws {Error} for a key that takes two writes (CONSENSUS_INTERFACE → The tree
 *   writes → "No key takes two writes in one block") — a defect, never a verdict
 */
function ordered(writes: TreeWrite[], caller: string): TreeWrite[] {
  const seen = new Set<string>();
  for (const { key } of writes) {
    const hex = bytesToHex(key);
    if (seen.has(hex)) throw new Error(`${caller}: key ${hex} takes two writes`);
    seen.add(hex);
  }
  return writes.sort((a, b) => TAG_RANK[a.tag] - TAG_RANK[b.tag] || compareBytes(a.key, b.key));
}

/** Bytewise order of two keys. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length - b.length;
}
