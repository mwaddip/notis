import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
import {
  MAX_CONTENT_BYTES,
  MAX_PARENT_REFS,
  MAX_TX_BYTES,
  MAX_SETTLEMENT_BYTES,
  MAX_BLOCK_BODY_BYTES,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  ED25519_SPKI_PREFIX,
  LEVEL_CAP,
  MAX_INTERLINKS,
  MAX_FUTURE_DRIFT_MS,
  interlinkRoot,
  updateInterlinks,
  protocolVersionAt,
} from '@dagsocial/types';
import { encodeHeader, encodeTx, utxoTxTreeByteLength, computeContentHash } from '@dagsocial/types';
import type { BlockHeader, OrderingBlock, ProtocolEra, UtxoTransaction } from '@dagsocial/types';
import { isDisallowedContentCodepoint } from './content-charset.js';

// ---------------------------------------------------------------------------
// Ed25519 SPKI helpers
// ---------------------------------------------------------------------------

const ED25519_SPKI_BUF = Buffer.from(ED25519_SPKI_PREFIX, 'hex');

function wrapSpki(raw: Uint8Array): Buffer {
  return Buffer.concat([ED25519_SPKI_BUF, Buffer.from(raw)]);
}

/** Wrap a raw 32-byte Ed25519 public key as an SPKI DER KeyObject. */
export function ed25519PublicKeyToKeyObject(rawKey: Uint8Array): ReturnType<typeof createPublicKey> {
  return createPublicKey({
    key: wrapSpki(rawKey),
    format: 'der',
    type: 'spki',
  });
}

// ---------------------------------------------------------------------------
// Input guards (audit M-5, M-6)
// ---------------------------------------------------------------------------
//
// Every exported verify* function receives objects straight off the wire, so
// its arguments may be wrongly typed or out of range. The guards below stand in
// front of the operations that throw on such input — `Buffer.byteLength`,
// `Buffer.from`, `createPublicKey`, `crypto.verify`, `BigInt` /
// `writeBigUInt64LE`, the codec's throwing writers, and plain `.length` reads —
// so a malformed object yields a clean `false` / `{ valid: false }`, never an
// exception.
//
// Each guard checks exactly the declared type of the field it protects, so a
// well-formed object from any conforming encoder passes unchanged and the happy
// path is untouched.

/** Narrow to a non-null object. */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Narrow to `Uint8Array` (which `Buffer` extends).
 *
 * Deliberately not `ArrayBuffer.isView`: `Buffer.from(new Uint32Array(8))`
 * copies *elements*, not bytes, so a 32-byte-but-not-Uint8Array view would
 * silently yield an 8-byte key and throw downstream in `createPublicKey`.
 */
function isBytes(v: unknown): v is Uint8Array {
  return v instanceof Uint8Array;
}

/**
 * Guard for every value that reaches `BigInt(...)` + `writeBigUInt64LE`, and for
 * bit-count arguments (audit M-6).
 *
 * ⛔ **`HEADER_DOMAIN`'s `powNonce` row is the load-bearing one, and it is a
 * search variable an attacker varies against a target.** Its header writer is
 * `vlqU`, total by sentinel, so without this guard every out-of-domain nonce
 * would share one encoding — the shape that makes a totality argument bite. What
 * closes it is this pin plus `verifyOrderingBlockPoW` hashing the nonce as a
 * fixed 8-byte LE, which has no sentinel at all; `computePowHash` runs the whole
 * header domain first, so the two cannot be reached out of order.
 *
 * `Number.isSafeInteger`, not a loose `typeof === 'number'` — the loose check
 * admits `NaN`, `Infinity`, and floats, each of which throws in `BigInt()`, and
 * negatives / values ≥ 2^64, which throw in `writeBigUInt64LE`. Safe integers
 * are a strict subset of u64, so the u64 range is satisfied by construction.
 */
function isU64Safe(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/**
 * A `PostId` as it appears in `parentRefs`: exactly 64 lowercase hex
 * characters, the output shape of `computePostId`'s `.toString('hex')`.
 *
 * Lowercase, not case-insensitive: uppercase hex decodes to the same 32 bytes,
 * so accepting both would make `hexToBytes` non-injective at the codec boundary
 * — two distinct in-memory posts encoding to one preimage, which is the
 * malleability the M-1 encoding exists to close.
 */
const POST_ID_HEX = /^[0-9a-f]{64}$/;

/**
 * The `b32` string domain: exactly 64 lowercase hex characters.
 *
 * One predicate over `POST_ID_HEX` rather than a second regex, because it is
 * the same domain reached from a different field. Every 32-byte value that
 * stays a hex `string` in memory and crosses the wire as raw bytes lands here
 * — post ids, the roots, `prevBlockHash`, tx ids, the consensus-carried
 * `author`. `codec.ts`'s `hexToBytesExact` is the function on the other side
 * and its accepted set is exactly this one, deliberately: a domain narrower
 * than the writer's leaves a reachable throw, and a domain wider than the
 * writer's is a check that rejects nothing.
 */
function isHex32(v: unknown): v is string {
  return typeof v === 'string' && POST_ID_HEX.test(v);
}

/**
 * `stateRoot`'s domain — **66** characters, not 64.
 *
 * The AVL+ digest is 33 bytes (`EMPTY_STATE_ROOT = '00'.repeat(33)`), so it is
 * `b33` on the wire and `POST_ID_HEX` is the wrong width for it. The extra byte
 * is the root node's height, carried inside the digest; it is not a 32-byte
 * hash with a spare byte, so there is no "close enough" reading under which the
 * 64-char form is acceptable.
 */
const STATE_ROOT_HEX = /^[0-9a-f]{66}$/;

/** `stateRoot`'s domain as a predicate — the `b33` counterpart to `isHex32`. */
function isHex33(v: unknown): v is string {
  return typeof v === 'string' && STATE_ROOT_HEX.test(v);
}

/** A `Uint8Array` of exactly `n` bytes — type first, width second (see `isBytes`). */
function isBytesOfLength(v: unknown, n: number): v is Uint8Array {
  return isBytes(v) && v.length === n;
}

/**
 * The field-domain pin over the transaction's `PostCommit` payload
 * (VALIDATION_INTERFACE → verifyPostCommitDomains).
 *
 * `postFieldBytes` sits inside the `computeTxId` preimage, so this guard
 * keeps its throwing writers unreachable on the transaction-id path.
 * `verifyTxStructure` calls it before anything takes the transaction's id.
 *
 * **Width checks** (TYPES_INTERFACE → Layout — PostCommit): `contentHash`
 * and `author` are `b32` (exactly 32 bytes each); `parentRefs` is
 * `arr(refs, b32)` with at most `MAX_PARENT_REFS` entries. Fixed-width
 * writers throw on a wrong width (`writeBytesNOrThrow`,
 * `writeHexNOrThrow`), and this guard establishes the domain before they
 * are reached. `protocolVersion` uses `isU64Safe` to keep the `vlqU`
 * sentinel path closed. `type` must be a member of `POST_TYPE`.
 *
 * It reads no content — the commit carries none; the body's rules are
 * `verifyPostBody`'s.
 *
 * Total on adversarial input, like every function here.
 */
export function verifyPostCommitDomains(commit: unknown): { valid: boolean; error?: string } {
  if (!isObject(commit)) return { valid: false, error: 'Post is not an object' };
  if (!isBytesOfLength(commit.contentHash, 32)) {
    return { valid: false, error: 'Post contentHash must be exactly 32 bytes' };
  }
  if (!isBytesOfLength(commit.author, 32)) {
    return { valid: false, error: 'Post author must be exactly 32 bytes' };
  }
  if (!Array.isArray(commit.parentRefs)) {
    return { valid: false, error: 'Post parentRefs must be an array' };
  }
  for (const ref of commit.parentRefs) {
    if (typeof ref !== 'string' || !POST_ID_HEX.test(ref)) {
      return { valid: false, error: 'Post parentRef must be 64 lowercase hex characters' };
    }
  }
  if (commit.parentRefs.length > MAX_PARENT_REFS) {
    return { valid: false, error: `Too many parent refs (max ${MAX_PARENT_REFS})` };
  }
  if (!isU64Safe(commit.protocolVersion)) {
    return { valid: false, error: 'Post protocolVersion must be a non-negative safe integer' };
  }
  if (commit.type !== 'regular' && commit.type !== 'profile') {
    return { valid: false, error: 'Post type must be a member of POST_TYPE' };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Prune-commit payload domain
// ---------------------------------------------------------------------------

/**
 * The prune payload's structural domain — one field
 * (VALIDATION_INTERFACE → `verifyPruneCommitDomains`; TYPES_INTERFACE →
 * Layout — PruneCommit). The subtree is derived at apply, so the payload
 * carries no set to check for repeats and no root to check for type.
 *
 * Total on adversarial input, like every function here.
 */
export function verifyPruneCommitDomains(commit: unknown): { valid: boolean; error?: string } {
  if (!isObject(commit)) return { valid: false, error: 'PruneCommit is not an object' };
  if (!isHex32(commit.rootPostHash)) {
    return { valid: false, error: 'PruneCommit rootPostHash must be 64 lowercase hex characters' };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Post-withdraw-commit payload domain
// ---------------------------------------------------------------------------

export function verifyPostWithdrawCommitDomains(commit: unknown): { valid: boolean; error?: string } {
  if (!isObject(commit)) return { valid: false, error: 'PostWithdrawCommit is not an object' };
  if (!isHex32(commit.postId)) {
    return { valid: false, error: 'PostWithdrawCommit postId must be 64 lowercase hex characters' };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// The block header's encodable domain
// ---------------------------------------------------------------------------
//
// One statement of the domain, every caller. `verifyHeaderFieldDomains`,
// `verifyOrderingBlockStructure`, `blockHash` and `computePowHash` all consult
// this table rather than restating widths and alphabets of their own: two
// implementations of one domain drift, which is the class the positional wire
// format exists to close.
//
// Each rule names the writer its field feeds under that format, because that is
// what fixes the domain: `b32`/`b33` are fixed-width and have no unreachable
// sentinel, so they throw outside their domain (TYPES_INTERFACE → Totality);
// `vlqU` is total *by sentinel*, so it does not throw — it collides, mapping
// every out-of-domain value onto one encoding. A pin is needed either way, and
// the second case is the one a search for panics cannot see.

type HeaderField =
  | 'protocolVersion'
  | 'height'
  | 'prevBlockHash'
  | 'utxoTxRoot'
  | 'stateRoot'
  | 'validatorId'
  | 'powNonce'
  | 'powTargetBits'
  | 'createdAt'
  | 'interlinkRoot';

interface HeaderDomainRule {
  readonly field: HeaderField;
  readonly ok: (v: unknown) => boolean;
  /** The reason `verifyHeaderFieldDomains` reports for this field. */
  readonly error: string;
}

const HEADER_DOMAIN: readonly HeaderDomainRule[] = [
  // vlqU
  { field: 'protocolVersion', ok: isU64Safe, error: 'Block header protocolVersion must be a non-negative safe integer' },
  { field: 'height', ok: isU64Safe, error: 'Block header height must be a non-negative safe integer' },
  // b32 — 32 bytes carried as hex in memory
  { field: 'prevBlockHash', ok: isHex32, error: 'Block header prevBlockHash must be 64 lowercase hex characters' },
  { field: 'utxoTxRoot', ok: isHex32, error: 'Block header utxoTxRoot must be 64 lowercase hex characters' },
  // b33 — the AVL+ digest carries a height byte, so 66 characters, not 64
  { field: 'stateRoot', ok: isHex33, error: 'Block header stateRoot must be 66 lowercase hex characters' },
  // b32 — already bytes, so type before width (a 32-char string is not 32 bytes)
  { field: 'validatorId', ok: (v) => isBytesOfLength(v, 32), error: 'Block header validatorId must be exactly 32 bytes' },
  // vlqU
  { field: 'powNonce', ok: isU64Safe, error: 'Block header powNonce must be a non-negative safe integer' },
  // vlqU, in units of 1/256 of a bit — VALIDATION_INTERFACE → orderingPowTarget.
  // The upper bound is the domain, not a new rule: a header above it already
  // fails `verifyOrderingBlockPoW`, which refuses a target it cannot expand.
  {
    field: 'powTargetBits',
    ok: (v) => isU64Safe(v) && (v as number) <= 65536,
    error: 'Block header powTargetBits must be an integer in [0, 65536]',
  },
  // vlqU — a consensus input: the order and future-bound rules
  // (→ verifyCreatedAtOrder, → verifyCreatedAtBound) and the difficulty
  // schedule (→ asertTargetBits) read it.
  { field: 'createdAt', ok: isU64Safe, error: 'Block header createdAt must be a non-negative safe integer' },
  // b32 — the interlink vector's commitment (TYPES_INTERFACE → Interlink vector)
  { field: 'interlinkRoot', ok: isHex32, error: 'Block header interlinkRoot must be 64 lowercase hex characters' },
];

/**
 * The first rule the header violates, or `null` if it is inside the domain.
 *
 * A non-object reads as a header with every field absent, so it fails the first
 * rule rather than slipping through as "no failure" — the shape that would let
 * a `null`/`42`/`'header'` reach `encodeHeader`.
 */
function firstHeaderDomainFailure(h: unknown): HeaderDomainRule | null {
  const fields: Record<string, unknown> = isObject(h) ? h : {};
  for (const rule of HEADER_DOMAIN) {
    if (!rule.ok(fields[rule.field])) return rule;
  }
  return null;
}

/**
 * The domain of every field `encodeHeader` writes — the precondition of
 * `blockHash` and `computePowHash`, and the single source of the header's
 * encodable domain.
 *
 * Only declared fields are checked, and that is the whole domain: `encodeHeader`
 * writes the ten declared fields positionally and reads nothing else, so an
 * *extra* property on a header — a symbol, a function, a reference cycle —
 * reaches no writer and has no bytes.
 *
 * Returns a **reason**, not a boolean, because a rejection's diagnosis is not
 * subsumed by the rejection: `verifyOrderingBlockStructure` re-labels the
 * failure with its own per-field message rather than emitting a bare
 * "invalid header".
 */
export function verifyHeaderFieldDomains(header: unknown): { valid: boolean; error?: string } {
  if (!isObject(header)) return { valid: false, error: 'Block header is not an object' };
  const failed = firstHeaderDomainFailure(header);
  return failed ? { valid: false, error: failed.error } : { valid: true };
}

// ---------------------------------------------------------------------------
// The PoW admission rule
// ---------------------------------------------------------------------------

/**
 * `2^(-f/256)` factored by the bits of `f`, as `floor(2^320 · 2^(-(2^j)/256))`.
 * `[7]` is `floor(2^320/√2)` and each lower index halves the exponent.
 *
 * ⚠ Re-deriving these as a chain of square roots needs guard bits. Taken at this
 * precision alone, three of the eight land one ulp low — a set that renders the
 * same target on every admitted input, but not these digits.
 *
 * VALIDATION_INTERFACE → orderingPowTarget: these are an implementation choice,
 * not a consensus constant. The rule is the predicate; any factors reproducing
 * it agree, and `ordering-pow-target.test.ts` checks every admitted input
 * against that predicate rather than against these values.
 */
const ORDERING_TARGET_FACTORS: readonly bigint[] = [
  0xff4ecb59511ec8a5301ba217ef18dd7c2f409857956d475fdb171474700cd72f09abbd9586cb942fn,
  0xfe9e115c7b8f884badd25995e79d2f096934ec56be0d25443a7522ed803a527baa2398a03fbdc508n,
  0xfd3e0c0cf486c174853f3a5931e0ee03061b7bb285a607919d2285b6754edd613ab745a256540c03n,
  0xfa83b2db722a033a7c25bb14315d7fcc8006fe21a95d14dc4844b29bf4af18e84b0207166ee1375en,
  0xf5257d152486cc2c7b9d0c7aed980fc36f510308677709f5bdd80329364aa29fd22dd036f1906094n,
  0xeac0c6e7dd24392ed02d75b3706e54fac4faace043b7f91c17d8d1e8ca31880ab338fcd2ac2ffbc8n,
  0xd744fccad69d6af439a68bb9902d3fde1d733af522058b16b5c13ada0e778299efb01fda334bca9an,
  0xb504f333f9de6484597d89b3754abe9f1d6f60ba893ba84ced17ac85833399154afc83043ab8a2c3n,
];

/** The scale the factors above are written at. */
const ORDERING_TARGET_PRECISION = 320n;

/**
 * The inclusive maximum acceptable ordering-block digest for `scaledBits`,
 * big-endian, 32 bytes. `null` outside `[0, 65536]`, which a caller reads as
 * "no digest can satisfy this" and answers `false`.
 *
 * VALIDATION_INTERFACE → orderingPowTarget. `scaledBits` is in units of 1/256
 * of a bit, so the target is `R - 1` for the unique `R` with
 * `R^256 ≤ 2^(65536 - scaledBits) < (R+1)^256`.
 */
export function orderingPowTarget(scaledBits: number): Uint8Array | null {
  if (!Number.isSafeInteger(scaledBits) || scaledBits < 0 || scaledBits > 65536) return null;
  const whole = scaledBits >> 8;
  const fraction = scaledBits & 255;
  let mantissa = 1n << ORDERING_TARGET_PRECISION;
  for (let j = 0; j < 8; j++) {
    if ((fraction >> j) & 1) {
      mantissa = (mantissa * ORDERING_TARGET_FACTORS[j]!) >> ORDERING_TARGET_PRECISION;
    }
  }
  let value = ((mantissa << BigInt(256 - whole)) >> ORDERING_TARGET_PRECISION) - 1n;
  const target = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    target[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return target;
}

/**
 * The comparator half of the PoW admission rule: `hash <= target`, both read
 * big-endian, byte by byte over `target.length`. A short `hash` is compared
 * normally while it has bytes and refused the moment it runs out still equal —
 * so it meets the target only if every digest extending it would. Never
 * zero-extended.
 *
 * VALIDATION_INTERFACE → meetsPowTarget. Byte-wise rather than BigInt because
 * a solver runs it once per nonce.
 */
export function meetsPowTarget(hash: Uint8Array, target: Uint8Array): boolean {
  for (let i = 0; i < target.length; i++) {
    const h = hash[i];
    const c = target[i];
    if (h === undefined || c === undefined) return false;
    if (h < c) return true;
    if (h > c) return false;
  }
  return true;
}

/**
 * The work a header claiming `scaledBits` represents — the expected number of
 * digests tried to meet it. `scaledBits` is in units of 1/256 of a bit.
 *
 * `2^256 / (target + 1)`, where `target` is `orderingPowTarget`'s **inclusive**
 * maximum. That inclusivity is load-bearing: `target + 1` is precisely `R`,
 * which at `scaledBits = 256n` is `2^(256 − n)`, so the quotient is `2^n` with
 * no remainder. An exclusive target would floor to one less at every whole bit.
 *
 * ⚠ Work resolves on the band `[2305, 63357]` and at neither end — 1816 steps
 * below buy nothing, and above 63358 work stops because the target does. So
 * `ORDERING_BLOCK_POW_TARGET_FLOOR` puts every *reachable* difficulty inside the
 * band, not every admitted one. VALIDATION_INTERFACE → blockWork /
 * cumulativeWork.
 *
 * `null` for exactly the inputs `orderingPowTarget` refuses, so the domain is
 * stated once rather than re-derived here.
 */
export function blockWork(scaledBits: number): bigint | null {
  const target = orderingPowTarget(scaledBits);
  if (target === null) return null;
  let t = 0n;
  for (const byte of target) t = (t << 8n) | BigInt(byte);
  return (1n << 256n) / (t + 1n);
}

/**
 * The total work of a header sequence.
 *
 * A header outside `blockWork`'s domain contributes nothing rather than
 * throwing: the array reaches here from the wire, where `powTargetBits` is any
 * `number`, and refusing the whole comparison over one bad member would hand a
 * peer a way to void a fork-choice decision.
 */
export function cumulativeWork(headers: BlockHeader[]): bigint {
  let sum = 0n;
  for (const h of headers) {
    const work = blockWork(h.powTargetBits);
    if (work !== null) sum += work;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// RetargetParams / asertTargetBits — VALIDATION_INTERFACE → asertTargetBits
// ---------------------------------------------------------------------------

/**
 * The schedule's injected parameters. The caller owns every value; this
 * package owns the function. VALIDATION_INTERFACE → asertTargetBits.
 */
export interface RetargetParams {
  anchorBits: number;
  idealMs: number;
  halflifeMs: number;
  floorBits: number;
  ceilingBits: number;
}

/**
 * The target the block above `parent` must carry — the ASERT difficulty
 * schedule in log space over the 1/256-bit representation.
 * VALIDATION_INTERFACE → asertTargetBits;
 * MINING_INTERFACE → Difficulty Schedule.
 */
export function asertTargetBits(
  params: RetargetParams,
  anchorCreatedAt: number,
  parent: { height: number; createdAt: number },
): number {
  if (!isObject(params) || !isObject(parent)) return 0;
  const pHeight = (parent as Record<string, unknown>).height;
  const pCreatedAt = (parent as Record<string, unknown>).createdAt;
  if (!isU64Safe(pHeight as number) || !isU64Safe(pCreatedAt as number) || !isU64Safe(anchorCreatedAt)) return 0;

  const delta = (BigInt(pCreatedAt as number) - BigInt(anchorCreatedAt))
    - BigInt(params.idealMs) * (BigInt(pHeight as number) - 1n);
  const numerator = delta * 256n;
  const divisor = BigInt(params.halflifeMs);
  let q = numerator / divisor;
  if (numerator % divisor !== 0n && numerator < 0n) q -= 1n;

  let bits = BigInt(params.anchorBits) - q;
  const floor = BigInt(params.floorBits);
  const ceiling = BigInt(params.ceilingBits);
  if (bits < floor) bits = floor;
  if (bits > ceiling) bits = ceiling;
  return Number(bits);
}

// ---------------------------------------------------------------------------
// verifyCreatedAtOrder — VALIDATION_INTERFACE → verifyCreatedAtOrder
// ---------------------------------------------------------------------------

/**
 * `header.createdAt > parent.createdAt` — the timestamp order rule.
 * MINING_INTERFACE → Header timestamp rules, the order rule.
 */
export function verifyCreatedAtOrder(
  header: BlockHeader,
  parent: BlockHeader,
): boolean {
  if (!isObject(header) || !isObject(parent)) return false;
  const hCa = (header as Record<string, unknown>).createdAt;
  const pCa = (parent as Record<string, unknown>).createdAt;
  if (!isU64Safe(hCa as number) || !isU64Safe(pCa as number)) return false;
  return (hCa as number) > (pCa as number);
}

// ---------------------------------------------------------------------------
// verifyCreatedAtBound — VALIDATION_INTERFACE → verifyCreatedAtBound
// ---------------------------------------------------------------------------

/**
 * `header.createdAt ≤ nowMs + maxDriftMs` — the future bound.
 * MINING_INTERFACE → Header timestamp rules, the future bound.
 */
export function verifyCreatedAtBound(
  header: BlockHeader,
  nowMs: number,
  maxDriftMs: number,
): boolean {
  if (!isObject(header)) return false;
  const ca = (header as Record<string, unknown>).createdAt;
  if (!isU64Safe(ca as number)) return false;
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || !Number.isInteger(nowMs)) return false;
  if (typeof maxDriftMs !== 'number' || !Number.isFinite(maxDriftMs) || !Number.isInteger(maxDriftMs)) return false;
  return (ca as number) <= nowMs + maxDriftMs;
}

// ---------------------------------------------------------------------------
// verifyValidatorSignature
// ---------------------------------------------------------------------------

/**
 * Verify that `signature` is a valid raw Ed25519 signature over the block hash,
 * made by the key declared in `header.validatorId`.
 *
 * The signed message is `Buffer.from(blockHash(header), 'hex')` — the 32 raw
 * bytes of `blake2b512(encodeHeader(header))[:32]`, exactly what the block
 * creator signs. `validatorSignature` lives on the block, not in the header, so
 * `blockHash(header)` is stable before and after signing.
 *
 * PoW proves work was spent; it does not prove who spent it. This is the check
 * that binds a block to the holder of `validatorId`'s private key.
 */
export function verifyValidatorSignature(header: BlockHeader, signature: Uint8Array): boolean {
  // A non-byte signature throws in `Buffer.from`; a wrong-*length* signature is
  // left to `crypto.verify`, which rejects it cleanly.
  if (!isBytes(signature)) return false;
  // `blockHash` establishes the header domain itself, so a malformed
  // header yields `null` rather than throwing inside `encodeHeader`. Its
  // non-null return also proves `validatorId` is exactly 32 bytes, which is what
  // keeps `createPublicKey` ("Failed to read asymmetric key") out of reach.
  const hash = blockHash(header);
  if (hash === null) return false;
  const pubKeyObj = ed25519PublicKeyToKeyObject(header.validatorId);
  const message = Buffer.from(hash, 'hex');
  return cryptoVerify(null, message, pubKeyObj, Buffer.from(signature));
}

// ---------------------------------------------------------------------------
// verifyProtocolVersion
// ---------------------------------------------------------------------------

/**
 * The declared protocol version equals the era scheduled for `height`
 * (VALIDATION_INTERFACE → Protocol Version). The height is the object's own — a
 * block header's `height`, a transaction's the carrying block's, `tip + 1` at
 * admission (ARCHITECTURE → Protocol Versioning). `false` when no era covers the
 * height (`protocolVersionAt` answers `null`) and when `declared` is anything but
 * that integer.
 *
 * Total (M-5): `protocolVersionAt` iterates the schedule (TYPES_INTERFACE →
 * Version), so a non-array or an ill-formed schedule throws there — the call is
 * guarded and any throw is read as "no era", never escapes. No check in this
 * package reads `PROTOCOL_VERSION`.
 */
export function verifyProtocolVersion(
  declared: number,
  height: number,
  schedule: readonly ProtocolEra[],
): boolean {
  let era: number | null;
  try {
    era = protocolVersionAt(schedule, height);
  } catch {
    return false;
  }
  return era !== null && declared === era;
}

// ---------------------------------------------------------------------------
// verifyTxProtocolVersion
// ---------------------------------------------------------------------------

/**
 * Every declared version a transaction carries equals the era at `height`:
 * `tx.protocolVersion` and, when `tx.post` is present, `tx.post.protocolVersion`
 * (VALIDATION_INTERFACE → verifyTxProtocolVersion). The commit's version is in
 * the post-id preimage, so a commit declaring a version other than its
 * transaction's would mint a second identity for one post.
 *
 * Total (M-5): reached straight off gossip, so a non-object `tx` or a `post`
 * that is not an object is `false`, never a throw.
 */
export function verifyTxProtocolVersion(
  tx: UtxoTransaction,
  height: number,
  schedule: readonly ProtocolEra[],
): boolean {
  if (!isObject(tx)) return false;
  if (!verifyProtocolVersion(tx.protocolVersion as number, height, schedule)) return false;
  const post = tx.post;
  if (post !== undefined) {
    if (!isObject(post)) return false;
    if (!verifyProtocolVersion(post.protocolVersion as number, height, schedule)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// verifyContentLimits
// ---------------------------------------------------------------------------

export function verifyContentLimits(content: string): { valid: boolean; error?: string } {
  // `Buffer.byteLength` throws on anything that is not a string or byte view.
  if (typeof content !== 'string') return { valid: false, error: 'Content must be a string' };
  const byteLen = Buffer.byteLength(content, 'utf8');
  if (byteLen === 0) return { valid: false, error: 'Content is empty' };
  if (byteLen > MAX_CONTENT_BYTES) return { valid: false, error: 'Content exceeds max length' };
  return { valid: true };
}

// ---------------------------------------------------------------------------
// verifyContentCharacters
// ---------------------------------------------------------------------------

const CONTENT_CHAR_ERROR =
  'Content contains disallowed characters (control, zero-width, or bidi override)';

/**
 * Consensus Stage-1 character policy. Rejects the Unicode control, format,
 * surrogate, and private-use codepoints (`Cc`/`Cf`/`Cs`/`Co`) enumerated at the
 * pinned Unicode version in `content-charset.ts`, with `\n` as the sole
 * exception. Unassigned (`Cn`) codepoints are allowed.
 *
 * Consults only the static table — never a runtime `\p{...}` escape — so the
 * verdict is identical on every node regardless of the Unicode data version its
 * Node/V8 build ships (audit M-4).
 */
export function verifyContentCharacters(content: string): { valid: boolean; error?: string } {
  if (typeof content !== 'string') return { valid: false, error: CONTENT_CHAR_ERROR };
  // Iterating a string yields whole codepoints (and lone surrogates singly),
  // which is the granularity the table's ranges are stated at.
  for (const ch of content) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && isDisallowedContentCodepoint(cp)) {
      return { valid: false, error: CONTENT_CHAR_ERROR };
    }
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// verifyParentRefsCount
// ---------------------------------------------------------------------------

export function verifyParentRefsCount(refs: string[]): { valid: boolean; error?: string } {
  if (!Array.isArray(refs)) return { valid: false, error: 'Parent refs must be an array' };
  if (refs.length > MAX_PARENT_REFS) {
    return { valid: false, error: `Too many parent refs (max ${MAX_PARENT_REFS})` };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// verifyPostBody — VALIDATION_INTERFACE → verifyPostBody
// ---------------------------------------------------------------------------

export function verifyPostBody(
  content: unknown,
  contentHash: Uint8Array,
): { valid: boolean; error?: string } {
  if (typeof content !== 'string') {
    return { valid: false, error: 'Post content must be a string' };
  }
  const limits = verifyContentLimits(content);
  if (!limits.valid) return limits;
  const chars = verifyContentCharacters(content);
  if (!chars.valid) return chars;
  if (!isBytesOfLength(contentHash, 32)) {
    return { valid: false, error: 'contentHash must be exactly 32 bytes' };
  }
  const expected = computeContentHash(content);
  if (expected.length !== contentHash.length) {
    return { valid: false, error: 'Content hash mismatch' };
  }
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== contentHash[i]) {
      return { valid: false, error: 'Content hash mismatch' };
    }
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// verifyTxStructure
// ---------------------------------------------------------------------------

export function verifyTxStructure(tx: UtxoTransaction): { valid: boolean; error?: string } {
  if (!isObject(tx)) return { valid: false, error: 'Transaction is not an object' };
  if (!Array.isArray(tx.inputs) || tx.inputs.length === 0) {
    return { valid: false, error: 'Transaction must have at least one input' };
  }
  if (!Array.isArray(tx.outputs) || tx.outputs.length === 0) {
    return { valid: false, error: 'Transaction must have at least one output' };
  }
  // A `genesis_proof` box is written by genesis seeding alone, so a transaction
  // that creates one is refused here — the package's only box-type-aware rule
  // (VALIDATION_INTERFACE → verifyTxStructure). The rule's other half, that such
  // a box may never be *spent*, cannot live here: `tx.inputs` are box id strings
  // and typing one requires the UTXO set, so node owns it.
  //
  // The tag alone decides. No payload bound stands beside this line, because a
  // bound behind an outright refusal rejects nothing.
  //
  // `isObject` first: this function is reached straight off gossip with a
  // peer-supplied object, and no exported function here panics on one.
  for (const out of tx.outputs) {
    if (isObject(out) && out.boxType === 'genesis_proof') {
      return { valid: false, error: 'Transaction may not output a genesis_proof box' };
    }
  }
  // Check for duplicate inputs
  const seen = new Set<string>();
  for (const input of tx.inputs) {
    if (seen.has(input)) return { valid: false, error: 'Duplicate input in transaction' };
    seen.add(input);
  }
  if (typeof tx.protocolVersion !== 'number') {
    return { valid: false, error: 'Transaction missing protocolVersion' };
  }
  // The commit's domains — the structural gate before `computeTxId` reaches
  // `postFieldBytes` (VALIDATION_INTERFACE → verifyPostCommitDomains). The
  // transaction carries the commit, never the body; content checks belong to
  // `verifyPostBody`, which runs wherever a body enters a node.
  if (tx.post !== undefined) {
    const domains = verifyPostCommitDomains(tx.post);
    if (!domains.valid) return domains;
  }
  // The weight bound, last and after every shape check above
  // (VALIDATION_INTERFACE → The size bound measures `encodeTx`, and runs last).
  // The measure is the re-encoding rather than the bytes the transaction arrived
  // as: node's `insertUtxoTx` re-encodes on the way into the mempool, so this is
  // the form that will occupy a block, and it is one number on every node where
  // a received-bytes measure would not be. `verifyOrderingBlockStructure` weighs
  // an *embedded* transaction as it arrived, and that asymmetry is deliberate —
  // each measures the bytes its own object costs.
  //
  // ⛔ `encodeTx` is the positional codec over a peer-supplied object, and its
  // throwing writers reach values every check above admits: an `inputs` element
  // or a `likeTarget` outside 64 lowercase hex (`writeHexNOrThrow`), an output
  // box whose `owner` is not exactly 32 bytes or whose `value` leaves
  // `[0, 2^64)` (`canonicalBoxBytes`), and a `signatures` key or 64-byte value
  // of the same shape (TYPES_INTERFACE → Totality). None of them has an
  // unreachable sentinel to collapse onto, which is why the writer throws
  // instead. The no-panic rule (Postconditions — No-panic M-5) decides the
  // shape: a transaction that cannot be encoded cannot be stored, mined or
  // relayed, so the throw is a rejection and not an escape.
  let encoded: Uint8Array;
  try {
    encoded = encodeTx(tx);
  } catch {
    return { valid: false, error: 'Transaction is not encodable' };
  }
  if (encoded.length > MAX_TX_BYTES) {
    return { valid: false, error: `Transaction too large (max ${MAX_TX_BYTES} bytes)` };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// verifyOrderingBlockStructure
// ---------------------------------------------------------------------------

/**
 * This function's own message for each header field, so the header domain can
 * be stated once (`HEADER_DOMAIN`) without moving any rejection's diagnosis.
 */
const BLOCK_HEADER_FIELD_ERROR: Record<HeaderField, string> = {
  protocolVersion: 'Ordering block header missing protocolVersion',
  height: 'Ordering block invalid height',
  prevBlockHash: 'Ordering block header missing or invalid prevBlockHash',
  utxoTxRoot: 'Ordering block header missing utxoTxRoot',
  stateRoot: 'Ordering block header missing or invalid stateRoot',
  validatorId: 'Ordering block header missing or invalid validatorId',
  powNonce: 'Ordering block missing or invalid powNonce',
  powTargetBits: 'Ordering block missing or invalid powTargetBits',
  createdAt: 'Ordering block header missing or invalid createdAt',
  interlinkRoot: 'Ordering block header missing or invalid interlinkRoot',
};

export function verifyOrderingBlockStructure(
  block: OrderingBlock,
): { valid: boolean; error?: string } {
  if (!isObject(block)) return { valid: false, error: 'Ordering block is not an object' };
  const h = block.header;
  if (!h) return { valid: false, error: 'Ordering block missing header' };
  // Every header field's domain, delegated to the one place it is stated
  // (`verifyHeaderFieldDomains`) and re-labelled with this function's own
  // messages. What stays below are the *semantic* floors a domain check cannot
  // know: `height >= 1` (genesis) and `powTargetBits >= the policy floor`.
  const headerFailure = firstHeaderDomainFailure(h);
  if (headerFailure) {
    return { valid: false, error: BLOCK_HEADER_FIELD_ERROR[headerFailure.field] };
  }
  // `isBytes`, not a bare `.length`: a stored row put back through a bare
  // `value as T` carries any type in any field, and a 64-character string,
  // `{length: 64}` and a 64-element `Array` all satisfy a length check while
  // none of them encode through `writeBytesNOrThrow`. They are
  // `b64`/`b32` *from a `Uint8Array`*, so the codec reaches
  // `writeBytesNOrThrow`, which throws on anything that is not a byte view of
  // that exact width; a 64-character string, `{length: 64}` and a 64-element
  // `Array` all satisfy a length check and none of them encode.
  if (!isBytes(block.validatorSignature) || block.validatorSignature.length !== 64) {
    return { valid: false, error: 'Ordering block missing or invalid validatorSignature' };
  }
  // Genesis floor — semantic, not a domain: `vlqU` encodes 0 perfectly well and
  // the header predicate accepts it, but no block may claim height 0.
  if (h.height < 1) {
    return { valid: false, error: 'Ordering block invalid height' };
  }
  // A policy floor, likewise: the header domain admits any u64 target, and this
  // is the gossip pre-filter that refuses a trivially cheap one.
  if (h.powTargetBits < ORDERING_BLOCK_POW_TARGET_FLOOR) {
    return { valid: false, error: 'Ordering block missing or invalid powTargetBits' };
  }
  if (!Array.isArray(block.utxoTxTree?.utxoTxIds)) {
    return { valid: false, error: 'Ordering block missing utxoTxTree.utxoTxIds' };
  }
  // ⛔ The settlement transaction is the LAST entry, and that is the whole of
  // how it is identified (NODE_INTERFACE → It is the LAST entry in `utxoTxIds`).
  // Every block carries one, so an empty body is a block that cannot have paid
  // its own coinbase and is refused here, before a single box is read.
  //
  // ⚠ **Non-emptiness is the whole of what this package can state about the
  // rule**, and the reason is the identification itself: with position deciding
  // identity, "exactly one" is a consequence of there being one last entry
  // rather than a count this function could take. Recognising a settlement in
  // any *other* position means recognising what it spends — the karma pool,
  // whose id needs the UTXO set, and that read is the one positional identity
  // exists to avoid. The other half is node's: the verifier re-derives
  // the settlement's deterministic legs from the body and checks the
  // producer's against them — derived fields by value, producer-chosen
  // fields by constraint (NODE_INTERFACE → Determinism is this
  // mechanism's whole risk; MINING_INTERFACE → On block receipt).
  if (block.utxoTxTree.utxoTxIds.length === 0) {
    return { valid: false, error: 'Ordering block body carries no settlement transaction' };
  }
  // Without this check an element could be a number, an object or `null`, and
  // those reach `hexToBuf(id)` inside `computeUtxoTxRoot`'s Merkle build, which
  // `block-apply` calls at its Merkle-root verification step. A non-string
  // throws there — inside the apply transaction, so the funnel's totality catch
  // would turn a malformed block into an "unexpected failure" log rather than
  // the stated rejection the apply path requires (NODE_INTERFACE → Ordering
  // block apply-time authorization).
  for (const id of block.utxoTxTree.utxoTxIds) {
    if (!isHex32(id)) {
      return {
        valid: false,
        error: 'Ordering block utxoTxId must be 64 lowercase hex characters',
      };
    }
  }
  if (!Array.isArray(block.utxoTxTree.utxoTxs) ||
      block.utxoTxTree.utxoTxs.length !== block.utxoTxTree.utxoTxIds.length) {
    return { valid: false, error: 'Ordering block utxoTxs must align with utxoTxIds' };
  }
  // Element **type**, which array-ness and length alignment do not establish.
  // These are `arr(utxoTxs, lp)` — opaque length-prefixed bytes — and `writeLp`
  // is total *by sentinel*: handed a non-byte-view it writes a sentinel
  // **length prefix**, which `readLp` refuses. The encode side is node's store
  // write, so an unpinned element is a byte our own decoder rejects, written
  // into `ordering_blocks` and read back as `UnreadableStoredBlockError` →
  // `failStopIfCorruptChain` → `process.exit(1)`, triggered automatically by
  // the next gossip block's `extendsOurTip` (measured on `672f5a5`).
  //
  // No commitment makes that unreachable: `utxoTxRoot` commits `utxoTxIds` and
  // **never `utxoTxs`**, and the validator signature covers the header only —
  // so a *relaying* node can swap the payload on an honest block with no
  // re-mine and no re-sign. All three peer paths decode
  // through the positional codec (`decodeOrderingBlock` on gossip,
  // `decodeBlocks` under `requestBlocks`, `decodeOrderingBlock` again under
  // `appendBlocks`), so a swap is refused there; this pin is what keeps the
  // store write safe independently of that.
  //
  // Every element but the last is weighed against `MAX_TX_BYTES`; the last
  // against `MAX_SETTLEMENT_BYTES` — the settlement's size is derived from the
  // body and from chain state rather than chosen by a user
  // (TYPES_INTERFACE → Size caps). The non-emptiness check above guarantees a
  // last element exists. The measure is the as-arrived byte length, matching how
  // the body bound below weighs the same array and deliberately unlike
  // `verifyTxStructure`'s re-encoding.
  const lastIdx = block.utxoTxTree.utxoTxs.length - 1;
  for (let i = 0; i <= lastIdx; i++) {
    const tx = block.utxoTxTree.utxoTxs[i]!;
    if (!isBytes(tx)) {
      return { valid: false, error: 'Ordering block utxoTx must be a byte view' };
    }
    if (i < lastIdx) {
      if (tx.length > MAX_TX_BYTES) {
        return { valid: false, error: `Ordering block utxoTx too large (max ${MAX_TX_BYTES} bytes)` };
      }
    } else {
      if (tx.length > MAX_SETTLEMENT_BYTES) {
        return { valid: false, error: `Ordering block settlement too large (max ${MAX_SETTLEMENT_BYTES} bytes)` };
      }
    }
  }
  // The body weight bound, refused here rather than at apply because this is
  // what net runs before relay (VALIDATION_INTERFACE → The body size bound).
  //
  // The bound holds a relation and not a number — `MAX_BLOCK_BODY_BYTES` <
  // `MAX_SERVE_BODY_BYTES` < `MAX_STREAM_BYTES` (`TYPES_INTERFACE` → Size caps).
  if (utxoTxTreeByteLength(block.utxoTxTree) > MAX_BLOCK_BODY_BYTES) {
    return {
      valid: false,
      error: `Ordering block body too large (max ${MAX_BLOCK_BODY_BYTES} bytes)`,
    };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// isValidVouchTarget
// ---------------------------------------------------------------------------

/**
 * Validate that a target UserId for a vouch is a well-formed 32-byte
 * Ed25519 public key.  Does NOT check whether the identity exists on-chain
 * — vouching for unknown public keys is allowed.
 */
export function isValidVouchTarget(userId: Uint8Array): boolean {
  if (!(userId instanceof Uint8Array)) return false;
  if (userId.length !== 32) return false;
  let allZero = true;
  for (let i = 0; i < 32; i++) {
    if (userId[i] !== 0) { allZero = false; break; }
  }
  return !allZero;
}

// ---------------------------------------------------------------------------
// Block hash and PoW preimage — the guarded encoders
// ---------------------------------------------------------------------------
//
// These are the only two functions in this package that hand a header to
// `encodeHeader`, and each establishes the header domain itself rather than
// requiring it of its callers (VALIDATION_INTERFACE → blockHash). The caller
// class that makes that necessary is node's fork resolution, which holds bare
// peer `BlockHeader`s: `verifyOrderingBlockStructure` cannot cover it, because
// it takes an `OrderingBlock` and that path has only headers.
//
// A consumer therefore absorbs an *absence* — it does not learn the header
// domain, call a predicate, or decide what well-formed means. This extends the
// contract's no-panic rule (M-5) to two functions the `verify*` naming
// convention does not reach: one with no `false` to return says so with `null`.

/**
 * The block hash IS the hash of the serialized header, with its precondition
 * enforced: `null` on exactly the headers `verifyHeaderFieldDomains` rejects,
 * the canonical 64-char hex hash otherwise.
 */
export function blockHash(header: BlockHeader): string | null {
  if (firstHeaderDomainFailure(header) !== null) return null;
  return createHash('blake2b512')
    .update(Buffer.from(encodeHeader(header)))
    .digest()
    .subarray(0, 32)
    .toString('hex');
}

/**
 * The PoW preimage — the serialized header with powNonce=0, which the miner
 * hashes against candidate nonces. Precondition enforced as in `blockHash`:
 * `null` on exactly the headers `verifyHeaderFieldDomains` rejects, the 32-byte
 * preimage otherwise.
 */
export function computePowHash(header: BlockHeader): Buffer | null {
  if (firstHeaderDomainFailure(header) !== null) return null;
  const template = { ...header, powNonce: 0 };
  return createHash('blake2b512')
    .update(Buffer.from(encodeHeader(template)))
    .digest()
    .subarray(0, 32);
}

// ---------------------------------------------------------------------------
// powHit — VALIDATION_INTERFACE → powHit
// ---------------------------------------------------------------------------

/**
 * The 32-byte digest a header's nonce produced — the bytes `meetsPowTarget`
 * compares against the target. `null` on exactly the inputs `computePowHash`
 * refuses (M-5/M-6); never throws.
 */
export function powHit(header: BlockHeader): Uint8Array | null {
  const preimage = computePowHash(header);
  if (preimage === null) return null;
  if (!isU64Safe(header.powNonce)) return null;
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(header.powNonce));
  return createHash('blake2b512')
    .update(preimage)
    .update(nonceBuf)
    .digest()
    .subarray(0, 32);
}

// ---------------------------------------------------------------------------
// verifyOrderingBlockPoW
// ---------------------------------------------------------------------------

export function verifyOrderingBlockPoW(header: BlockHeader): boolean {
  const hit = powHit(header);
  if (hit === null) return false;
  const target = orderingPowTarget(header.powTargetBits);
  if (target === null) return false;
  return meetsPowTarget(hit, target);
}

// ---------------------------------------------------------------------------
// levelOfHit / level — VALIDATION_INTERFACE → level
// ---------------------------------------------------------------------------

/**
 * The arithmetic half of the NiPoPoW level: the largest `μ ≥ 0` with
 * `hit · 2^μ ≤ target`, both read as unsigned big-endian integers.
 * `LEVEL_CAP` when `hit` is zero; `null` when `hit > target` or either
 * operand is not exactly 32 bytes. Never throws.
 */
export function levelOfHit(hit: Uint8Array, target: Uint8Array): number | null {
  if (!isBytes(hit) || hit.length !== 32) return null;
  if (!isBytes(target) || target.length !== 32) return null;
  let h = 0n;
  for (const byte of hit) h = (h << 8n) | BigInt(byte);
  if (h === 0n) return LEVEL_CAP;
  let t = 0n;
  for (const byte of target) t = (t << 8n) | BigInt(byte);
  if (h > t) return null;
  let mu = 0;
  while ((h << BigInt(mu + 1)) <= t) mu++;
  return mu;
}

/**
 * The superblock level of a header against the network's anchor target —
 * the yardstick (VALIDATION_INTERFACE → level; TYPES_INTERFACE → Interlink
 * vector). `Infinity` at height 1; otherwise
 * `levelOfHit(powHit(header), orderingPowTarget(anchorBits))`.
 * `null` when the hit exceeds the yardstick, when either half is `null`,
 * or when `anchorBits` is outside `orderingPowTarget`'s domain.
 */
export function level(header: BlockHeader, anchorBits: number): number | null {
  if (isObject(header) && (header as Record<string, unknown>).height === 1) return Infinity;
  const hit = powHit(header);
  if (hit === null) return null;
  const yardstick = orderingPowTarget(anchorBits);
  if (yardstick === null) return null;
  return levelOfHit(hit, yardstick);
}

// ---------------------------------------------------------------------------
// verifyBlockChainLink
// ---------------------------------------------------------------------------

export function verifyBlockChainLink(
  block: OrderingBlock,
  prevBlock: OrderingBlock,
): boolean {
  if (!isObject(block) || !isObject(prevBlock)) return false;
  if (!isObject(block.header)) return false;
  // `prevBlock.header` reaches `encodeHeader` through the hash; `block.header`
  // is only read from, so it needs no encodability guard.
  const prevHash = blockHash(prevBlock.header);
  if (prevHash === null) return false;
  return (
    block.header.prevBlockHash === prevHash &&
    block.header.height === prevBlock.header.height + 1
  );
}

// ---------------------------------------------------------------------------
// verifyHeaderChain — VALIDATION_INTERFACE → verifyHeaderChain
// ---------------------------------------------------------------------------

/**
 * The header-level rules a chain segment must pass before any of its work
 * counts. Discriminated on `ok`; the success arm carries the continuation
 * anchor for the following page. VALIDATION_INTERFACE → verifyHeaderChain.
 */
export type HeaderChainVerdict =
  | { ok: true; work: bigint; hashes: string[]; next: { prevBlockHash: string; height: number; interlinks: string[]; createdAt: number | null; t_a: number | null } }
  | { ok: false; index: number; reason: 'domain' | 'version' | 'height' | 'link' | 'time' | 'clock' | 'target' | 'pow' | 'interlinks' };

/**
 * Verify a contiguous header segment against an anchor, the retarget
 * parameters, the caller's clock and the protocol-version schedule. Each header
 * declares the era scheduled at its own `height` (the `version` reason).
 * VALIDATION_INTERFACE → verifyHeaderChain.
 */
export function verifyHeaderChain(
  headers: BlockHeader[],
  anchor: { prevBlockHash: string; height: number; interlinks: string[]; createdAt: number | null },
  params: RetargetParams,
  anchorCreatedAt: number | null,
  nowMs: number,
  schedule: readonly ProtocolEra[],
): HeaderChainVerdict {
  if (!Array.isArray(headers) || headers.length === 0) {
    return { ok: true, work: 0n, hashes: [], next: { prevBlockHash: anchor.prevBlockHash, height: anchor.height, interlinks: anchor.interlinks, createdAt: anchor.createdAt ?? null, t_a: anchorCreatedAt ?? null } };
  }

  // A null anchor.createdAt with a non-null anchorCreatedAt, or the reverse,
  // is malformed input.
  const anchorCaNull = anchor.createdAt === null || anchor.createdAt === undefined;
  const tANull = anchorCreatedAt === null || anchorCreatedAt === undefined;
  if (anchorCaNull !== tANull) {
    return { ok: false, index: 0, reason: 'time' };
  }

  // Validate anchor interlinks before entering the loop.
  if (!Array.isArray(anchor.interlinks) ||
      anchor.interlinks.length > MAX_INTERLINKS ||
      anchor.interlinks.some(e => !isHex32(e)) ||
      (anchor.interlinks.length === 0 && anchor.height !== 0)) {
    return { ok: false, index: 0, reason: 'interlinks' };
  }

  const yardstick = orderingPowTarget(params.anchorBits);
  if (yardstick === null) {
    return { ok: false, index: 0, reason: 'target' };
  }
  let t_a: number | null = anchorCreatedAt ?? null;

  const hashes: string[] = [];
  let expectedInterlinks = anchor.interlinks;

  for (let i = 0; i < headers.length; i++) {
    const header = headers[i]!;

    // 1. Domain
    const hash = blockHash(header);
    if (hash === null) {
      return { ok: false, index: i, reason: 'domain' };
    }

    // 2. Protocol version — the era scheduled at this header's own height
    //    (VALIDATION_INTERFACE → verifyHeaderChain).
    if (!verifyProtocolVersion(header.protocolVersion, header.height, schedule)) {
      return { ok: false, index: i, reason: 'version' };
    }

    // 3. Height — contiguous from anchor
    const expectedHeight = anchor.height + 1 + i;
    if (header.height !== expectedHeight) {
      return { ok: false, index: i, reason: 'height' };
    }

    // 4. Link
    const expectedPrev = i === 0 ? anchor.prevBlockHash : hashes[i - 1]!;
    if (header.prevBlockHash !== expectedPrev) {
      return { ok: false, index: i, reason: 'link' };
    }

    // 5. Time — createdAt strictly above the previous header's (or the
    //    anchor's for i = 0 when it is not null). Height 1 has no order check.
    if (header.height !== 1) {
      if (i === 0) {
        if (anchor.createdAt !== null && anchor.createdAt !== undefined) {
          if (!isU64Safe(header.createdAt) || !isU64Safe(anchor.createdAt) || header.createdAt <= anchor.createdAt) {
            return { ok: false, index: i, reason: 'time' };
          }
        }
      } else {
        const prev = headers[i - 1]!;
        if (!isU64Safe(header.createdAt) || !isU64Safe(prev.createdAt) || header.createdAt <= prev.createdAt) {
          return { ok: false, index: i, reason: 'time' };
        }
      }
    }

    // 6. Clock — the future bound against the caller's clock
    if (!verifyCreatedAtBound(header, nowMs, MAX_FUTURE_DRIFT_MS)) {
      return { ok: false, index: i, reason: 'clock' };
    }

    // 7. Target — the ASERT schedule
    if (header.height === 1) {
      if (header.powTargetBits !== params.anchorBits) {
        return { ok: false, index: i, reason: 'target' };
      }
      // At a genesis fork, headers[0] at height 1 establishes t_a for i ≥ 1
      if (t_a === null) {
        t_a = header.createdAt;
      }
    } else {
      if (t_a === null) {
        return { ok: false, index: i, reason: 'target' };
      }
      let previous: { height: number; createdAt: number };
      if (i === 0 && anchor.createdAt !== null && anchor.createdAt !== undefined) {
        previous = { height: anchor.height, createdAt: anchor.createdAt };
      } else if (i > 0) {
        previous = headers[i - 1]!;
      } else {
        return { ok: false, index: i, reason: 'target' };
      }
      if (header.powTargetBits !== asertTargetBits(params, t_a, previous)) {
        return { ok: false, index: i, reason: 'target' };
      }
    }

    // 8. PoW
    const hit = powHit(header);
    if (hit === null) return { ok: false, index: i, reason: 'pow' };
    const target = orderingPowTarget(header.powTargetBits);
    if (target === null || !meetsPowTarget(hit, target)) {
      return { ok: false, index: i, reason: 'pow' };
    }

    // 9. Interlink root — the yardstick level
    const expectedRoot = interlinkRoot(expectedInterlinks);
    if (header.interlinkRoot !== expectedRoot) {
      return { ok: false, index: i, reason: 'interlinks' };
    }

    const headerLevel = header.height === 1 ? Infinity : levelOfHit(hit, yardstick);
    expectedInterlinks = updateInterlinks(expectedInterlinks, hash, headerLevel);

    hashes.push(hash);
  }

  const last = headers.length - 1;
  return {
    ok: true,
    work: cumulativeWork(headers),
    hashes,
    next: {
      prevBlockHash: hashes[last]!,
      height: headers[last]!.height,
      interlinks: expectedInterlinks,
      createdAt: headers[last]!.createdAt,
      t_a,
    },
  };
}
