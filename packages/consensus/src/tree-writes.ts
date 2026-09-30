import {
  INDEX_MARKER,
  LIKE_MARKER,
  boxKey,
  boxRecordBytes,
  bytesToHex,
  castCountBytes,
  castCountKey,
  hexToBytes,
  holderKey,
  holderRecordBytes,
  identityKey,
  identityRecordBytes,
  lapsedKey,
  likeKey,
  nameKey,
  nameRecordBytes,
  networkKey,
  networkRecordBytes,
  postKey,
  postRecordBytes,
} from '@dagsocial/types';
import type { AnyBox, BondBox, HolderRecord, IdentityRecord, NetworkRecord } from '@dagsocial/types';
import type { BlockEffects } from './apply-block.js';
import { indexEntriesOfBox, isLapsedMember } from './tree-index.js';
import { TreeInconsistencyError } from './tree-view.js';
import type { TreeStateView } from './tree-view.js';
import type { UsernameRow } from './utxo-engine.js';

/** One operation on the tree (CONSENSUS_INTERFACE → The tree writes). */
export type TreeWrite =
  | { tag: 'Remove'; key: Uint8Array }
  | { tag: 'Insert'; key: Uint8Array; value: Uint8Array }
  | { tag: 'Update'; key: Uint8Array; value: Uint8Array }
  | { tag: 'InsertOrUpdate'; key: Uint8Array; value: Uint8Array };

/**
 * A block's writes to the tree (CONSENSUS_INTERFACE → The tree writes), from its
 * effects, its height and `view` — the block's own tree view, where a write reads
 * what it needs from before the block: a spent box, a spent bond's invitee's
 * `invitedAtBlock`, a record's pre-block value, an earlier post's record, a
 * voucher's cast count.
 *
 * - **boxes** — a box the block both inserted and spent nets out, its index
 *   entries with it; every other box is a `Remove` or an `Insert` beside the same
 *   op on each of its entries, a bond the block created keyed at `height`, the
 *   grant's;
 * - **cast counts** — for each voucher whose vouch boxes the block inserted or
 *   spent, the count before the block plus the net change: nothing where the net
 *   change is 0, an `Insert` where none stood, a `Remove` where it falls to 0, an
 *   `Update` otherwise;
 * - **identity records** — the last write to each, an `InsertOrUpdate`; a
 *   `lapsed` entry moves only where its condition flips between the block's start
 *   and its end, for an identity whose record or cast count the block changed;
 * - **the network record** — an `Update`;
 * - **name and holder records** — as their `heldBefore` nets them: an
 *   `InsertOrUpdate`, a `Remove`, or nothing;
 * - **posts** — an `Insert` per post the block confirmed, an `Update` to
 *   `withdrawn` per post it withdrew;
 * - **likes** — an `Insert` per like record.
 *
 * The cast counts are read in ascending identity order — each voucher's whose
 * vouch boxes the block moved, and a written record's only where the record is a
 * lapsed member before the block or after it (CONSENSUS_INTERFACE → The tree
 * writes → "The cast count is the writes' own read").
 *
 * @throws {TreeInconsistencyError} for a spent bond whose invitee holds no record
 *   and for a cast count the block's spends would take below 0
 * @throws {Error} for effects the view does not back — a spent box it holds no
 *   box for, a withdrawn post it holds no record for — and for a key written
 *   twice; each a defect, never a verdict
 */
export function treeWritesOf(effects: BlockEffects, height: number, view: TreeStateView): TreeWrite[] {
  const writes: TreeWrite[] = [];
  const casts = new Map<string, { voucherId: Uint8Array; delta: number }>();
  const moveCast = (voucherId: Uint8Array, delta: number): void => {
    const voucher = bytesToHex(voucherId);
    const moved = casts.get(voucher);
    if (moved !== undefined) moved.delta += delta;
    else casts.set(voucher, { voucherId, delta });
  };

  const { created, spent } = netBoxes(effects.mutations);
  for (const id of spent) {
    const box = view.getBox(id);
    if (box === null) throw new Error(`treeWritesOf: the block spends ${id}, which the view holds no box for`);
    writes.push({ tag: 'Remove', key: boxKey(hexToBytes(id)) });
    const grantHeight = box.boxType === 'bond' ? grantHeightOf(box, view) : undefined;
    for (const { key } of indexEntriesOfBox(box, grantHeight)) writes.push({ tag: 'Remove', key });
    if (box.boxType === 'vouch') moveCast(box.voucherId, -1);
  }
  for (const box of created) {
    writes.push({ tag: 'Insert', key: boxKey(hexToBytes(box.id!)), value: boxRecordBytes(box, box.txId, box.index) });
    for (const { key, value } of indexEntriesOfBox(box, height)) writes.push({ tag: 'Insert', key, value });
    if (box.boxType === 'vouch') moveCast(box.voucherId, +1);
  }

  const records = new Map<string, { identityId: Uint8Array; record: IdentityRecord }>();
  let network: NetworkRecord | null = null;
  const names = new Map<string, { heldBefore: boolean; last: UsernameRow | null }>();
  const holders = new Map<string, { owner: Uint8Array; heldBefore: boolean; last: HolderRecord | null }>();
  for (const m of effects.mutations) {
    switch (m.kind) {
      case 'box':
        break;
      case 'record':
        records.set(bytesToHex(m.identityId), { identityId: m.identityId, record: m.record });
        break;
      case 'network':
        network = m.record;
        break;
      case 'username': {
        const seen = names.get(m.nameLower);
        if (seen !== undefined) seen.last = m.row;
        else names.set(m.nameLower, { heldBefore: m.heldBefore, last: m.row });
        break;
      }
      case 'holder': {
        const seen = holders.get(bytesToHex(m.owner));
        if (seen !== undefined) seen.last = m.record;
        else holders.set(bytesToHex(m.owner), { owner: m.owner, heldBefore: m.heldBefore, last: m.record });
        break;
      }
      default: {
        const unhandled: never = m;
        throw new Error(`treeWritesOf: a mutation of kind ${String((unhandled as { kind: unknown }).kind)} has no write`);
      }
    }
  }

  for (const { identityId, record } of records.values()) {
    writes.push({ tag: 'InsertOrUpdate', key: identityKey(identityId), value: identityRecordBytes(record) });
  }
  for (const identity of [...new Set([...casts.keys(), ...records.keys()])].sort()) {
    const moved = casts.get(identity);
    const identityId = moved?.voucherId ?? records.get(identity)!.identityId;
    let counted: number | undefined;
    const countBefore = (): number => (counted ??= view.castCountOf(identityId));
    const countAfter = (): number => countBefore() + (moved?.delta ?? 0);
    if (moved !== undefined) {
      const key = castCountKey(identityId);
      if (countAfter() < 0) {
        throw new TreeInconsistencyError(
          `the block spends ${-moved.delta} vouch box(es) of ${identity}, whose cast count is ${countBefore()}`,
        );
      }
      if (moved.delta !== 0) {
        if (countAfter() === 0) writes.push({ tag: 'Remove', key });
        else writes.push({ tag: countBefore() === 0 ? 'Insert' : 'Update', key, value: castCountBytes(countAfter()) });
      }
    }
    const before = view.getIdentityRecord(identityId);
    const after = records.get(identity)?.record ?? before;
    const heldBefore = isLapsedMember(before) && countBefore() > 0;
    const heldAfter = isLapsedMember(after) && countAfter() > 0;
    if (heldAfter && !heldBefore) {
      writes.push({ tag: 'InsertOrUpdate', key: lapsedKey(identityId), value: Uint8Array.from(INDEX_MARKER) });
    } else if (heldBefore && !heldAfter) {
      writes.push({ tag: 'Remove', key: lapsedKey(identityId) });
    }
  }

  if (network !== null) writes.push({ tag: 'Update', key: networkKey(), value: networkRecordBytes(network) });

  for (const [nameLower, { heldBefore, last }] of names) {
    const key = nameKey(new TextEncoder().encode(nameLower));
    if (last !== null) {
      writes.push({ tag: 'InsertOrUpdate', key, value: nameRecordBytes({ boxId: last.boxId, claimedAtBlock: last.claimedAtBlock }) });
    } else if (heldBefore) {
      writes.push({ tag: 'Remove', key });
    }
  }
  for (const { owner, heldBefore, last } of holders.values()) {
    const key = holderKey(owner);
    if (last !== null) writes.push({ tag: 'InsertOrUpdate', key, value: holderRecordBytes(last) });
    else if (heldBefore) writes.push({ tag: 'Remove', key });
  }

  for (const { postId, post } of effects.posts) {
    writes.push({
      tag: 'Insert',
      key: postKey(hexToBytes(postId)),
      value: postRecordBytes({ author: post.author, height, standing: 'live' }),
    });
  }
  for (const postId of effects.withdrawals) {
    const author = view.getTopologyAuthor(postId);
    const confirmedAt = view.getTopologyHeight(postId);
    if (author === null || confirmedAt === null) {
      throw new Error(`treeWritesOf: the block withdraws ${postId}, which the view holds no post record for`);
    }
    writes.push({
      tag: 'Update',
      key: postKey(hexToBytes(postId)),
      value: postRecordBytes({ author, height: confirmedAt, standing: 'withdrawn' }),
    });
  }

  for (const { targetPostId, likerId } of effects.likeRecords) {
    writes.push({ tag: 'Insert', key: likeKey(hexToBytes(targetPostId), likerId), value: Uint8Array.from(LIKE_MARKER) });
  }

  return ordered(writes, 'treeWritesOf');
}

/**
 * The block's box mutations netted: a box it inserted and later spent is in
 * neither list; `created` holds the other inserts, `spent` the other spends.
 */
function netBoxes(mutations: BlockEffects['mutations']): { created: AnyBox[]; spent: string[] } {
  const inserted = new Map<string, AnyBox>();
  const spent: string[] = [];
  for (const m of mutations) {
    if (m.kind !== 'box') continue;
    if (m.op === 'insert') inserted.set(m.boxId, m.box);
    else if (!inserted.delete(m.boxId)) spent.push(m.boxId);
  }
  return { created: [...inserted.values()], spent };
}

/**
 * A spent bond's due height: its invitee's `invitedAtBlock` before the block
 * (CONSENSUS_INTERFACE → The index entries → "A bond's due height is its
 * invitee's `invitedAtBlock`").
 */
function grantHeightOf(bond: BondBox, view: TreeStateView): number {
  const invitee = view.getIdentityRecord(bond.inviteePublicKey);
  if (invitee === null) {
    throw new TreeInconsistencyError(`the tree holds bond ${bond.id}, whose invitee holds no record`);
  }
  return invitee.invitedAtBlock;
}

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
