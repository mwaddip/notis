import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
import {
  PROTOCOL_VERSION,
  MAX_CONTENT_BYTES,
  MAX_PARENT_REFS,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  ED25519_SPKI_PREFIX,
} from '@dagsocial/types';
import { signingHash, powNonceBytes } from '@dagsocial/types';
import { encodeHeader } from '@dagsocial/types';
import type { Post, SubBlock, BlockHeader, OrderingBlock, UtxoTransaction } from '@dagsocial/types';
import { isDisallowedContentCodepoint } from './content-charset.js';

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Standard blake2b-512/32 hash. Returns the first 32 bytes of blake2b512(data).
 * Used for content-addressed storage: every post, stump, box ID, and Merkle
 * node derives from this function or a structured-field variant.
 *
 * Node.js v22 lacks blake2b256; blake2b-512 with truncation is the project
 * standard for all 32-byte outputs.
 */
export function blake2b32(data: Uint8Array): Uint8Array {
  return createHash('blake2b512').update(data).digest().subarray(0, 32);
}

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
// `writeBigUInt64LE`, CBOR encoding, and plain `.length` reads — so a malformed
// object yields a clean `false` / `{ valid: false }`, never an exception.
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
 * Guard for every value that reaches `BigInt(...)` + `writeBigUInt64LE`, for
 * bit-count arguments (audit M-6), and for the post PoW nonce — whose `vlqU`
 * writer cannot throw but takes every out-of-domain value to one sentinel tail
 * (VALIDATION_INTERFACE → verifyPoW).
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
 * One past the largest value the u64 wire domain carries — the exclusive
 * ceiling of `writeVlqU64OrThrow`'s accepted set, which is `[0, 2^64 - 1]`.
 * That writer is `@dagsocial/types`' (`codec.ts`), not `@dagsocial/wire`'s; it
 * delegates through `ByteWriter.writeVlqBigInt` to `encodeVlqBigInt`, which is
 * where the range is enforced (WIRE_INTERFACE → BigInt VLQ).
 *
 * `isU64Safe` is the `number` counterpart and cannot serve here: a `bigint`
 * field spans the whole u64, far past `MAX_SAFE_INTEGER`, so the two predicates
 * pin different domains for different writers rather than one domain twice.
 *
 * Written `1n << 64n` to match node's `U64_BOUND` (`utxo-engine.ts`) and
 * `json-to-tx.ts`'s edge twin, so the three sites are greppable as one bound.
 */
const U64_BOUND = 1n << 64n;

/**
 * The domain of every field `postFieldBytes` encodes — the precondition of
 * `signingHash`, `postPowPreimage` and `computePostId` in `@dagsocial/types`.
 *
 * **Type checks** (audit M-5/M-6): a malformed post must not throw inside
 * `@dagsocial/types`. A non-array `parentRefs` throws in `.map`, an absent
 * `author`/`challenge` throws on `.length`, an `author` that is not a byte view
 * overruns the preimage buffer, and a symbol in `content` / `parentRefs` /
 * `protocolVersion` / `timestamp` throws in `TextEncoder.encode` / `String()`.
 *
 * The numerics use `isU64Safe`, not a loose `typeof === 'number'`. A loose
 * check admits `NaN` / `Infinity` / negative / fractional values, which the
 * canonical encoder in `@dagsocial/types` has to absorb by writing an all-ones
 * sentinel to stay panic-free — and two such malformed posts then share an
 * encoding. Rejecting them here keeps that sentinel path out of reach for
 * anything that passes this guard.
 *
 * **Width checks** (TYPES_INTERFACE → Layout — Post): `author` and `challenge`
 * are `b32` and `parentRefs` is `arr(refs, b32)`. A fixed-width writer has no
 * unreachable sentinel — its wire domain *is* its encodable domain — so padding
 * or truncating a 31-byte `author` would map it onto a well-formed post's
 * encoding, a consensus-level collision strictly worse than the panic it
 * avoids. `post.ts` therefore throws (`writeBytesNOrThrow`,
 * `writeHexNOrThrow`), and this guard is what establishes the domain before
 * that writer is reached, keeping the throw unreachable rather than latent.
 *
 * No well-formed post is affected: `author` is a 32-byte Ed25519 public key (a
 * 31-byte one cannot verify a signature), `challenge` is `randomBytes(32)` from
 * the issuing node, every `parentRef` is a `computePostId` output, a timestamp
 * is a non-negative safe integer, and `protocolVersion` must equal
 * `PROTOCOL_VERSION` to pass Stage 1 at all.
 */
export function verifyPostFieldDomains(post: Post): { valid: boolean; error?: string } {
  if (!isObject(post)) return { valid: false, error: 'Post is not an object' };
  if (typeof post.content !== 'string') {
    return { valid: false, error: 'Post content must be a string' };
  }
  if (!isBytes(post.author) || post.author.length !== 32) {
    return { valid: false, error: 'Post author must be exactly 32 bytes' };
  }
  if (!Array.isArray(post.parentRefs)) {
    return { valid: false, error: 'Post parentRefs must be an array' };
  }
  for (const ref of post.parentRefs) {
    if (typeof ref !== 'string' || !POST_ID_HEX.test(ref)) {
      return { valid: false, error: 'Post parentRef must be 64 lowercase hex characters' };
    }
  }
  if (!isBytes(post.challenge) || post.challenge.length !== 32) {
    return { valid: false, error: 'Post challenge must be exactly 32 bytes' };
  }
  if (!isU64Safe(post.protocolVersion)) {
    return { valid: false, error: 'Post protocolVersion must be a non-negative safe integer' };
  }
  if (!isU64Safe(post.timestamp)) {
    return { valid: false, error: 'Post timestamp must be a non-negative safe integer' };
  }
  return { valid: true };
}

/**
 * The same predicate as a type guard, for the call sites that want narrowing
 * rather than a message. One implementation, two shapes — a second copy of the
 * domain rule is exactly the mirror `VALIDATION_INTERFACE` warns about.
 */
function isSignablePost(post: unknown): post is Post {
  return verifyPostFieldDomains(post as Post).valid;
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
  | 'subBlockRoot'
  | 'utxoTxRoot'
  | 'stateRoot'
  | 'validatorId'
  | 'powNonce'
  | 'powTargetBits'
  | 'createdAt';

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
  { field: 'subBlockRoot', ok: isHex32, error: 'Block header subBlockRoot must be 64 lowercase hex characters' },
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
  // vlqU. A domain pin, not a clock policy: no monotonicity rule and no skew
  // window — those are consensus rule additions, and "never add checks the
  // reference lacks" applies. `createdAt` stays a producer-set record that no
  // node validates against anything, as in every chain in the lineage.
  { field: 'createdAt', ok: isU64Safe, error: 'Block header createdAt must be a non-negative safe integer' },
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
 * Only declared fields are checked. A header carrying an *extra* property that
 * holds a symbol, function, or reference cycle would still throw inside
 * `cbor-x`, but such a header cannot arrive over the wire (CBOR encodes none of
 * those); it can only be built in-process, which is trusted.
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
 * The inclusive maximum acceptable PoW digest for `targetBits`, big-endian, 32
 * bytes. `null` for a target outside `[0, 256]`, which a caller reads as "no
 * digest can satisfy this" and answers `false`.
 *
 * VALIDATION_INTERFACE → powTarget / meetsPowTarget. Inclusive
 * (`2^(256−targetBits) − 1`) rather than the exclusive threshold, because the
 * exclusive form is `2^256` at `targetBits = 0` and does not fit the digest
 * width; the inclusive form makes both extremes ordinary values.
 */
export function powTarget(targetBits: number): Uint8Array | null {
  if (!Number.isSafeInteger(targetBits) || targetBits < 0 || targetBits > 256) return null;
  const target = new Uint8Array(32).fill(0xff);
  const wholeBytes = targetBits >> 3;
  for (let i = 0; i < wholeBytes; i++) target[i] = 0x00;
  // A non-zero remainder means `targetBits` is not a multiple of 8, so it is at
  // most 255 and `wholeBytes` at most 31: the partial byte is always in range.
  const remainderBits = targetBits & 7;
  if (remainderBits !== 0) target[wholeBytes] = 0xff >> remainderBits;
  return target;
}

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
 * `R^256 ≤ 2^(65536 - scaledBits) < (R+1)^256`. Post PoW is not in these units
 * and uses `powTarget`.
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
 * True iff `hash` is at or below `target`, both read big-endian.
 *
 * VALIDATION_INTERFACE → powTarget / meetsPowTarget: the single PoW admission
 * rule in the repo — the verifier and every solver answer this question and no
 * other. Byte-wise rather than BigInt because a solver runs it once per nonce.
 *
 * A `hash` shorter than `target` is refused rather than zero-extended: a digest
 * that cannot be compared over the target's full width does not meet it.
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
// verifyPoW
// ---------------------------------------------------------------------------

/**
 * Post PoW: `blake2b512(input ‖ powNonceBytes(nonce))[0..32]` meets the target
 * `targetBits` expands to.
 *
 * The tail is `@dagsocial/types`' to write — TYPES_INTERFACE → Serialization →
 * "Layout — Post" is the layout, and `powNonceBytes` its only writer, so this
 * predicate and `computePostId` cannot state it differently.
 *
 * `isU64Safe(nonce)` is **not** redundant with that writer, which is total by
 * sentinel: it is what stops every out-of-domain nonce sharing one tail and so
 * one verdict (VALIDATION_INTERFACE → verifyPoW).
 *
 * The ordering-block nonce is `encodeLE64` and has its own predicate below —
 * two encodings, each specified, sharing no code.
 */
export function verifyPoW(input: Uint8Array, nonce: number, targetBits: number): boolean {
  if (!isBytes(input)) return false;
  if (!isU64Safe(nonce)) return false;
  if (!isU64Safe(targetBits)) return false;
  const target = powTarget(targetBits);
  if (target === null) return false;
  const buf = Buffer.concat([Buffer.from(input), Buffer.from(powNonceBytes(nonce))]);
  const hash = createHash('blake2b512').update(buf).digest().subarray(0, 32);
  return meetsPowTarget(hash, target);
}

// ---------------------------------------------------------------------------
// verifyPostSignature
// ---------------------------------------------------------------------------

export function verifyPostSignature(post: Post, publicKey: Uint8Array): boolean {
  // `createPublicKey` throws ("Failed to read asymmetric key") unless the SPKI
  // envelope carries exactly 32 raw bytes.
  if (!isBytes(publicKey) || publicKey.length !== 32) return false;
  if (!isSignablePost(post)) return false;
  // A wrong-*length* signature is left to `crypto.verify`, which rejects it
  // cleanly; only a non-byte-view throws.
  if (!isBytes(post.signature)) return false;
  const pubDer = wrapSpki(publicKey);
  const pubKeyObj = createPublicKey({ key: pubDer, format: 'der', type: 'spki' });
  const sigBuf = Buffer.from(post.signature);
  return cryptoVerify(null, signingHash(post), pubKeyObj, sigBuf);
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
  // left to `crypto.verify`, which rejects it cleanly (as in verifyPostSignature).
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

export function verifyProtocolVersion(version: number): boolean {
  return version === PROTOCOL_VERSION;
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
// verifySubBlockStructure
// ---------------------------------------------------------------------------

export function verifySubBlockStructure(sb: SubBlock): { valid: boolean; error?: string } {
  if (!isObject(sb)) return { valid: false, error: 'Sub-block is not an object' };
  if (!sb.post) return { valid: false, error: 'Sub-block missing post' };
  // The struct's own three fields, each pinned to the domain of the writer it
  // feeds in the `SUB_BLOCK` codec. `b32` from hex and `b32` from bytes are
  // fixed-width and throw outside their domain; `vlqU` is total by sentinel and
  // collides instead. Both need the domain established upstream of the encoder
  // (TYPES_INTERFACE → Totality).
  if (!isHex32(sb.subBlockId)) {
    return { valid: false, error: 'Sub-block subBlockId must be 64 lowercase hex characters' };
  }
  if (!isU64Safe(sb.protocolVersion)) {
    return { valid: false, error: 'Sub-block protocolVersion must be a non-negative safe integer' };
  }
  // Type before width: `producerId` is `UserId` bytes, not the hex its
  // table-neighbour `subBlockId` carries, so a 32-character string is not 32
  // bytes and `writeBytesNOrThrow` refuses it.
  if (!isBytesOfLength(sb.producerId, 32)) {
    return { valid: false, error: 'Sub-block producerId must be exactly 32 bytes' };
  }
  // The post's field domains, checked here because this is the Stage-1 gate the
  // relay path runs *before* it builds a PoW preimage from that post: `net`'s
  // `runStage1SubBlock` calls this function and only then `postPowPreimage`.
  // Under fixed-width writers a post outside the domain has no encoding and the
  // writer throws — inside a topic validator whose catch arm bans the
  // *forwarding* peer for a message it merely relayed.
  // Rejecting it as invalid content is both the correct verdict and the correct
  // penalty class.
  const postDomains = verifyPostFieldDomains(sb.post);
  if (!postDomains.valid) return postDomains;
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
  subBlockRoot: 'Ordering block header missing subBlockRoot',
  utxoTxRoot: 'Ordering block header missing utxoTxRoot',
  stateRoot: 'Ordering block header missing or invalid stateRoot',
  validatorId: 'Ordering block header missing or invalid validatorId',
  powNonce: 'Ordering block missing or invalid powNonce',
  powTargetBits: 'Ordering block missing or invalid powTargetBits',
  createdAt: 'Ordering block header missing or invalid createdAt',
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
  // `subBlockEntries`' presence check. There is no companion `subBlockRefs`
  // check because the struct carries no such field: the committed topology is
  // `subBlockEntries` and `pruneEntries` alone (TYPES_INTERFACE → Layout —
  // Block). The `?.` is load-bearing — it makes a block with no `subBlockTree`
  // at all a stated rejection here rather than a TypeError in the loop below.
  // The message follows `pruneEntries`' below rather than inventing a phrasing.
  if (!Array.isArray(block.subBlockTree?.subBlockEntries)) {
    return { valid: false, error: 'Ordering block missing subBlockTree.subBlockEntries' };
  }
  // Validate each entry. All three fields are `b32` at the codec boundary —
  // hex `string` in memory, raw bytes on the wire — so their domain is the hex
  // alphabet, not a character count. A 64-character *non-hex* value has no
  // encoding under a fixed-width writer and no sentinel to fall back on, so the
  // writer throws (TYPES_INTERFACE → Totality).
  //
  // The count check is not the whole rule here, and the reachable path runs
  // through the store rather than the preimage: `block-apply`'s entry loop takes
  // `subBlockId = entry.postId` and calls `insertPostPlaceholder(subBlockId,
  // entry.parentRefs)` for any confirmed sub-block whose content has not
  // arrived. `insertPost` deliberately does not overwrite `parent_refs` when the
  // real post lands later — its placeholder-upgrade branch says so — so the
  // block's claim is what `rowToPost` → `computePostId` reads at feed-service
  // and stump-engine, forever. Pinning here is what keeps that column inside
  // the encodable domain.
  for (const entry of block.subBlockTree.subBlockEntries) {
    if (!isObject(entry)) {
      return { valid: false, error: 'Ordering block subBlockEntry is not an object' };
    }
    if (!isHex32(entry.postId)) {
      return { valid: false, error: 'Ordering block subBlockEntry has invalid postId' };
    }
    // `MAX_PARENT_REFS`, not a literal. Every enforcement site imports the
    // constant — node's `verifyPost` and `verifyPostForRelay`, and
    // `verifyParentRefsCount` above. A literal here would pin this path — the
    // one that feeds `insertPostPlaceholder` — to whatever the constant read
    // when it was written, while the post path tracked the constant itself.
    if (!Array.isArray(entry.parentRefs) || entry.parentRefs.length > MAX_PARENT_REFS) {
      return { valid: false, error: 'Ordering block subBlockEntry has invalid parentRefs' };
    }
    for (const ref of entry.parentRefs) {
      if (!isHex32(ref)) {
        return {
          valid: false,
          error: 'Ordering block subBlockEntry parentRef must be 64 lowercase hex characters',
        };
      }
    }
    // Structure only: `author` is checked for shape here, not truth. Binding it
    // to the real post and to prune authorization is stateful (audit H-3) and
    // lives in @dagsocial/node.
    if (!isHex32(entry.author)) {
      return { valid: false, error: 'Ordering block subBlockEntry has invalid author' };
    }
  }
  // Prune entries. Every byte field is checked with `isBytes`, not a `.length`
  // read: a CBOR payload puts any type in any field, and a 32-char string or a
  // `{length: 32}` object satisfies a length check while throwing in the
  // `Buffer.from` / `createHash().update()` these fields reach at block apply.
  // Type is the only property that makes those calls safe.
  if (!Array.isArray(block.subBlockTree.pruneEntries)) {
    return { valid: false, error: 'Ordering block missing subBlockTree.pruneEntries' };
  }
  for (const entry of block.subBlockTree.pruneEntries) {
    if (!isObject(entry)) {
      return { valid: false, error: 'Ordering block pruneEntry is not an object' };
    }
    if (!isHex32(entry.rootPostHash)) {
      return { valid: false, error: 'Ordering block pruneEntry has invalid rootPostHash' };
    }
    if (!Array.isArray(entry.subtreePostIds)) {
      return { valid: false, error: 'Ordering block pruneEntry has invalid subtreePostIds' };
    }
    for (const id of entry.subtreePostIds) {
      if (!isHex32(id)) {
        return {
          valid: false,
          error: 'Ordering block pruneEntry subtreePostId must be 64 lowercase hex characters',
        };
      }
    }
    if (!isBytes(entry.subtreeMerkleRoot) || entry.subtreeMerkleRoot.length !== 32) {
      return { valid: false, error: 'Ordering block pruneEntry has invalid subtreeMerkleRoot' };
    }
    if (!isBytes(entry.authorId) || entry.authorId.length !== 32) {
      return { valid: false, error: 'Ordering block pruneEntry has invalid authorId' };
    }
    if (!isBytes(entry.authorSignature) || entry.authorSignature.length !== 64) {
      return { valid: false, error: 'Ordering block pruneEntry has invalid authorSignature' };
    }
    if (entry.trigger !== 'author' && entry.trigger !== 'storage_prune') {
      return { valid: false, error: 'Ordering block pruneEntry has invalid trigger' };
    }
  }
  // `isBytes`, not a bare `.length` — the same rule the prune-entry block above
  // states, and it governs the three byte fields outside that block too
  // (`validatorSignature` here, `validatorId`, `coinbaseOutput.owner`). They are
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
  // `coinbaseOutputs` and **never `utxoTxs`**, and the validator signature
  // covers the header only — so a *relaying* node can swap the payload on an
  // honest block with no re-mine and no re-sign. All three peer paths decode
  // through the positional codec (`decodeOrderingBlock` on gossip,
  // `decodeBlocks` under `requestBlocks`, `decodeOrderingBlock` again under
  // `appendBlocks`), so a swap is refused there; this pin is what keeps the
  // store write safe independently of that.
  for (const tx of block.utxoTxTree.utxoTxs) {
    if (!isBytes(tx)) {
      return { valid: false, error: 'Ordering block utxoTx must be a byte view' };
    }
  }
  if (!Array.isArray(block.utxoTxTree?.coinbaseOutputs)) {
    return { valid: false, error: 'Ordering block missing utxoTxTree.coinbaseOutputs' };
  }
  for (const out of block.utxoTxTree.coinbaseOutputs) {
    if (!isObject(out)) {
      return { valid: false, error: 'Coinbase output is not an object' };
    }
    if (!isBytes(out.owner) || out.owner.length !== 32) {
      return { valid: false, error: 'Coinbase output missing or invalid owner' };
    }
    // `value` is `bigint`, so its writer is `writeVlqU64OrThrow` — the one
    // **throwing** writer in the codec, because a `bigint` spans the whole u64
    // and has no unreachable sentinel to fall back on (TYPES_INTERFACE →
    // Totality). A sign check alone would leave the ceiling open, and the throw
    // is reached: node's apply funnel computes `computeUtxoTxRoot` at **step
    // 4**, ahead of the coinbase sum at step 5, so a value at or above 2^64
    // dies inside root computation and the funnel's totality catch logs it as
    // an "unexpected failure" instead of a stated rejection (NODE_INTERFACE →
    // Ordering block apply-time authorization). Establishing the domain
    // upstream of the encoder is what makes that throw unreachable.
    if (typeof out.value !== 'bigint' || out.value < 0n || out.value >= U64_BOUND) {
      return { valid: false, error: 'Coinbase output invalid value' };
    }
    // `isU64Safe`, not a bare `typeof === 'number'`: the writer is `vlqU` over a
    // `number`, which is total *by sentinel*, so an out-of-domain height does
    // not throw — it **collides**. `2^60`, `Infinity` and `1e300` all clear the
    // `>= h.height` floor and all three encode to `VLQ_SENTINEL`, giving
    // distinct blocks one `utxoTxRoot`. `HEADER_DOMAIN`'s `createdAt` rule is
    // the same pin one struct over.
    //
    // Nothing here relies on the funnel: `lockedUntilBlock` is saved today only
    // by step 5b's exact-equality check, which is incidental protection — loosen
    // that to a range for a maturity-schedule change and the row reopens with no
    // compiler signal. The `>= 0` half of `isU64Safe` is implied by
    // `>= h.height >= 1`; it is kept because the predicate names the writer's
    // domain, not this call site's.
    if (!isU64Safe(out.lockedUntilBlock) || out.lockedUntilBlock < h.height) {
      return { valid: false, error: 'Coinbase output invalid lockedUntilBlock' };
    }
    // Nothing else in the repo checks this field — not this function's callers,
    // not apply. `block-apply`'s coinbase loop passes `owner`, `value` and
    // `lockedUntilBlock` to `mintCredits` and never reads `isTreasury`, so it
    // enters no box, no journal entry and no AVL value; outside the store round
    // trip the only readers are node's `blocks` and `mining` routes, copying it
    // into a JSON response. `writeBool` emits `0xff` for any non-boolean and
    // `readBool` refuses it, so the same fail-stop chain as `utxoTxs` above — at
    // the cost of one block's PoW, since `utxoTxRoot` *does* commit the
    // coinbase leaf and the malformed block honestly commits to its own byte.
    //
    // Truthiness would not do: the honest producer emits `false` on every
    // single-output block, so the test is the type, not the value.
    if (typeof out.isTreasury !== 'boolean') {
      return { valid: false, error: 'Coinbase output invalid isTreasury' };
    }
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
// verifyOrderingBlockPoW
// ---------------------------------------------------------------------------

export function verifyOrderingBlockPoW(header: BlockHeader): boolean {
  // One gate, not two: the guarded preimage establishes the whole header domain,
  // which includes `powNonce` / `powTargetBits` as non-negative safe integers
  // (M-6) — the bound that keeps `BigInt` / `writeBigUInt64LE` from throwing.
  const preimage = computePowHash(header);
  if (preimage === null) return false;
  const target = orderingPowTarget(header.powTargetBits);
  if (target === null) return false;
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(header.powNonce));
  const hash = createHash('blake2b512')
    .update(preimage)
    .update(nonceBuf)
    .digest()
    .subarray(0, 32);
  return meetsPowTarget(hash, target);
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
  // `prevBlock.header` is CBOR-encoded by the hash; `block.header` is only read
  // from, so it needs no encodability guard.
  const prevHash = blockHash(prevBlock.header);
  if (prevHash === null) return false;
  return (
    block.header.prevBlockHash === prevHash &&
    block.header.height === prevBlock.header.height + 1
  );
}
