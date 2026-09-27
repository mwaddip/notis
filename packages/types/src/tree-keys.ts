/**
 * The AVL+ tree's 65-byte keys — every derivation of `TYPES_INTERFACE → The
 * tree keys`. One tag byte, then the row's fields in order, then zero bytes
 * out to `TREE_KEY_LENGTH`; a height field is a `u64` written big-endian, so
 * key order is numeric order. The tag is what keeps the entity kinds apart —
 * two keys with different tags are different keys whatever their fields.
 *
 * **Every derivation lives here and nowhere else**, so the node and a leaf
 * derive identical keys.
 *
 * No Node built-in, no Node global: the browser runs this module exactly as
 * written (ARCHITECTURE → Package boundaries).
 */

import { TREE_KEY_LENGTH } from './constants.js';
import { equalBytes } from './codec.js';
import { isValidUsernameBytes, canonicalUsernameBytes } from './username.js';
import { BOX_TYPE_TAGS } from './utxo.js';

/**
 * The tag table — TYPES_INTERFACE → The tree keys. Tags `0x00` and `0xff` are
 * never used: the AVL+ library bounds the keyspace with an all-`0x00` and an
 * all-`0xff` sentinel.
 */
export const TREE_TAG = Object.freeze({
  box: 0x01,
  identity: 0x02,
  network: 0x03,
  name: 0x04,
  holder: 0x05,
  post: 0x06,
  like: 0x07,
  karmaOf: 0x10,
  creditOf: 0x11,
  escrowOf: 0x12,
  escrowDue: 0x13,
  bondDue: 0x14,
  vouchPair: 0x15,
  lapsed: 0x16,
  accrualOf: 0x17,
  type: 0x18,
} as const);

/** A 32-byte id field. Throws rather than padding or truncating a wrong width. */
function b32(bytes: Uint8Array, what: string): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    throw new RangeError(
      `${what}: expected 32 bytes, got ${bytes instanceof Uint8Array ? bytes.length : typeof bytes}`,
    );
  }
  return bytes;
}

/** A height field — `u64`, big-endian, so key order is height order. */
function u64be(n: number, what: string): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`${what}: not a height: ${n}`);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), false);
  return out;
}

/** The tag, then the fields in order, zero-padded to `TREE_KEY_LENGTH`. */
function treeKey(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(TREE_KEY_LENGTH);
  out[0] = tag;
  let at = 1;
  for (const p of parts) {
    if (at + p.length > TREE_KEY_LENGTH) {
      throw new RangeError('tree key: fields exceed the key length');
    }
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A range's prefix — the tag, then the fields named so far, unpadded. */
function treePrefix(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const len = 1 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  out[0] = tag;
  let at = 1;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export function boxKey(boxId: Uint8Array): Uint8Array {
  return treeKey(TREE_TAG.box, b32(boxId, 'boxKey: boxId'));
}

export function identityKey(identityId: Uint8Array): Uint8Array {
  return treeKey(TREE_TAG.identity, b32(identityId, 'identityKey: identityId'));
}

export function networkKey(): Uint8Array {
  return treeKey(TREE_TAG.network);
}

/**
 * `nameLower` must already be canonical — valid (`isValidUsernameBytes`) and
 * equal to its own `canonicalUsernameBytes` — this derivation never lowers it.
 * The valid alphabet has no zero byte, so the zero padding stays unambiguous.
 */
export function nameKey(nameLower: Uint8Array): Uint8Array {
  if (!isValidUsernameBytes(nameLower)) {
    throw new RangeError(`nameKey: not a valid username: ${nameLower.length} byte(s)`);
  }
  if (!equalBytes(nameLower, canonicalUsernameBytes(nameLower))) {
    throw new RangeError('nameKey: name is not canonical lowercase');
  }
  return treeKey(TREE_TAG.name, nameLower);
}

export function holderKey(owner: Uint8Array): Uint8Array {
  return treeKey(TREE_TAG.holder, b32(owner, 'holderKey: owner'));
}

export function postKey(postId: Uint8Array): Uint8Array {
  return treeKey(TREE_TAG.post, b32(postId, 'postKey: postId'));
}

export function likeKey(postId: Uint8Array, likerId: Uint8Array): Uint8Array {
  return treeKey(
    TREE_TAG.like,
    b32(postId, 'likeKey: postId'),
    b32(likerId, 'likeKey: likerId'),
  );
}

// ---------------------------------------------------------------------------
// Indexes — each a pure function of one entity's own fields
// ---------------------------------------------------------------------------

export function karmaOfKey(owner: Uint8Array, boxId: Uint8Array): Uint8Array {
  return treeKey(
    TREE_TAG.karmaOf,
    b32(owner, 'karmaOfKey: owner'),
    b32(boxId, 'karmaOfKey: boxId'),
  );
}

export function creditOfKey(owner: Uint8Array, boxId: Uint8Array): Uint8Array {
  return treeKey(
    TREE_TAG.creditOf,
    b32(owner, 'creditOfKey: owner'),
    b32(boxId, 'creditOfKey: boxId'),
  );
}

export function escrowOfKey(owner: Uint8Array, boxId: Uint8Array): Uint8Array {
  return treeKey(
    TREE_TAG.escrowOf,
    b32(owner, 'escrowOfKey: owner'),
    b32(boxId, 'escrowOfKey: boxId'),
  );
}

export function escrowDueKey(releaseAtBlock: number, boxId: Uint8Array): Uint8Array {
  return treeKey(
    TREE_TAG.escrowDue,
    u64be(releaseAtBlock, 'escrowDueKey: releaseAtBlock'),
    b32(boxId, 'escrowDueKey: boxId'),
  );
}

export function bondDueKey(createdAtBlock: number, boxId: Uint8Array): Uint8Array {
  return treeKey(
    TREE_TAG.bondDue,
    u64be(createdAtBlock, 'bondDueKey: createdAtBlock'),
    b32(boxId, 'bondDueKey: boxId'),
  );
}

export function vouchPairKey(voucherId: Uint8Array, targetId: Uint8Array): Uint8Array {
  return treeKey(
    TREE_TAG.vouchPair,
    b32(voucherId, 'vouchPairKey: voucherId'),
    b32(targetId, 'vouchPairKey: targetId'),
  );
}

export function lapsedKey(identityId: Uint8Array): Uint8Array {
  return treeKey(TREE_TAG.lapsed, b32(identityId, 'lapsedKey: identityId'));
}

export function accrualOfKey(author: Uint8Array, boxId: Uint8Array): Uint8Array {
  return treeKey(
    TREE_TAG.accrualOf,
    b32(author, 'accrualOfKey: author'),
    b32(boxId, 'accrualOfKey: boxId'),
  );
}

/** The four box types the `type` tag covers — TYPES_INTERFACE → The tree keys. */
export type TypeKeyBoxType = 'emission' | 'treasury' | 'karma_pool' | 'backer_pool';

/** `TypeKeyBoxType` restricted from `BOX_TYPE_TAGS` — one source for the byte. */
const TYPE_KEY_TAGS: Readonly<Record<TypeKeyBoxType, number>> = {
  emission: BOX_TYPE_TAGS.emission,
  treasury: BOX_TYPE_TAGS.treasury,
  karma_pool: BOX_TYPE_TAGS.karma_pool,
  backer_pool: BOX_TYPE_TAGS.backer_pool,
};

function typeTagByte(boxType: TypeKeyBoxType): number {
  const tag = TYPE_KEY_TAGS[boxType];
  if (tag === undefined) {
    throw new RangeError(`typeKey: not one of the four type-keyed box types: ${String(boxType)}`);
  }
  return tag;
}

export function typeKey(boxType: TypeKeyBoxType, boxId: Uint8Array): Uint8Array {
  return treeKey(
    TREE_TAG.type,
    Uint8Array.of(typeTagByte(boxType)),
    b32(boxId, 'typeKey: boxId'),
  );
}

// ---------------------------------------------------------------------------
// Ranges — a prefix, not a full key
// ---------------------------------------------------------------------------

/** A range over the tree: every key carrying `prefix`. */
export interface TreeRange {
  readonly prefix: Uint8Array;
}

export function karmaOfRange(owner: Uint8Array): TreeRange {
  return { prefix: treePrefix(TREE_TAG.karmaOf, b32(owner, 'karmaOfRange: owner')) };
}

export function creditOfRange(owner: Uint8Array): TreeRange {
  return { prefix: treePrefix(TREE_TAG.creditOf, b32(owner, 'creditOfRange: owner')) };
}

export function escrowOfRange(owner: Uint8Array): TreeRange {
  return { prefix: treePrefix(TREE_TAG.escrowOf, b32(owner, 'escrowOfRange: owner')) };
}

export function accrualOfRange(author: Uint8Array): TreeRange {
  return { prefix: treePrefix(TREE_TAG.accrualOf, b32(author, 'accrualOfRange: author')) };
}

export function vouchPairRange(voucherId: Uint8Array): TreeRange {
  return { prefix: treePrefix(TREE_TAG.vouchPair, b32(voucherId, 'vouchPairRange: voucherId')) };
}

export function escrowDueRange(): TreeRange {
  return { prefix: treePrefix(TREE_TAG.escrowDue) };
}

export function bondDueRange(): TreeRange {
  return { prefix: treePrefix(TREE_TAG.bondDue) };
}

export function lapsedRange(): TreeRange {
  return { prefix: treePrefix(TREE_TAG.lapsed) };
}

export function typeRange(boxType: TypeKeyBoxType): TreeRange {
  return { prefix: treePrefix(TREE_TAG.type, Uint8Array.of(typeTagByte(boxType))) };
}

/** `range`'s prefix, zero-padded to a full key — the range's first possible key. */
export function rangeStart(range: TreeRange): Uint8Array {
  const out = new Uint8Array(TREE_KEY_LENGTH);
  out.set(range.prefix, 0);
  return out;
}

/** Whether `key` carries `range`'s prefix. */
export function inRange(key: Uint8Array, range: TreeRange): boolean {
  const p = range.prefix;
  if (key.length < p.length) return false;
  for (let i = 0; i < p.length; i++) {
    if (key[i] !== p[i]) return false;
  }
  return true;
}

/**
 * The `u64` big-endian height at bytes 1–8 of a due key (`escrowDueKey` /
 * `bondDueKey`) — the inverse of the height half of `treeKey`.
 *
 * @throws {RangeError} if `key` is not `TREE_KEY_LENGTH` bytes, or the encoded
 *   height is above `Number.MAX_SAFE_INTEGER`
 */
export function keyHeight(key: Uint8Array): number {
  if (key.length !== TREE_KEY_LENGTH) {
    throw new RangeError(`keyHeight: expected a ${TREE_KEY_LENGTH}-byte key, got ${key.length}`);
  }
  const view = new DataView(key.buffer, key.byteOffset + 1, 8);
  const raw = view.getBigUint64(0, false);
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`keyHeight: ${raw} is above Number.MAX_SAFE_INTEGER`);
  }
  return Number(raw);
}
