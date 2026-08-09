import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
import {
  PROTOCOL_VERSION,
  MAX_CONTENT_BYTES,
  MAX_PARENT_REFS,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  ED25519_SPKI_PREFIX,
} from '@dagsocial/types';
import { signingHash } from '@dagsocial/types';
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
 * Guard for every value that reaches `BigInt(...)` + `writeBigUInt64LE`, and
 * for bit-count arguments (audit M-6).
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
 * True iff `hash` opens with at least `targetBits` zero bits.
 *
 * A `targetBits` beyond the hash's own bit length is unsatisfiable, hence
 * `false`. The previous inline loops read past the end of the array instead,
 * where `undefined & mask` coerces to `0` — so an all-zero digest satisfied an
 * arbitrarily large target rather than none. (The practically reachable
 * accept-anything case was a `NaN`/`Infinity` `targetBits`, whose loop never
 * ran at all; `isU64Safe` now rejects that before we get here.)
 */
function hasLeadingZeroBits(hash: Uint8Array, targetBits: number): boolean {
  if (targetBits > hash.length * 8) return false;
  for (let i = 0; i < targetBits; i++) {
    const byteIdx = Math.floor(i / 8);
    const bitIdx = 7 - (i % 8);
    const byte = hash[byteIdx];
    if (byte === undefined) return false; // unreachable given the bound above
    if ((byte & (1 << bitIdx)) !== 0) return false;
  }
  return true;
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
 * The domain of every field `postFieldBytes` encodes — the precondition of
 * `signingHash`, `postPowPreimage` and `computePostId` in `@dagsocial/types`.
 *
 * **Type checks** (audit M-5/M-6): a malformed post must not throw inside
 * `@dagsocial/types`. A non-array `parentRefs` throws in `.map`, an absent
 * `author`/`challenge` throws on `.length`, an `author` that is not a byte view
 * overruns the preimage buffer, and a symbol in `content` / `parentRefs` /
 * `protocolVersion` / `timestamp` throws in `TextEncoder.encode` / `String()`.
 *
 * The numerics use `isU64Safe`, not a loose `typeof === 'number'`. The loose
 * check admitted `NaN` / `Infinity` / negative / fractional values, which the
 * canonical encoder in `@dagsocial/types` has to absorb by writing an all-ones
 * sentinel to stay panic-free — and two such malformed posts then share an
 * encoding. Rejecting them here instead keeps that sentinel path out of reach
 * for anything that passes this guard.
 *
 * **Width checks** (positional wire format, spec §2.5 / §6.1): `author` and
 * `challenge` become `b32` and `parentRefs` becomes `arr(refs, b32)`. A
 * fixed-width writer has no unreachable sentinel — its wire domain *is* its
 * encodable domain — so padding or truncating a 31-byte `author` would map it
 * onto a well-formed post's encoding, a consensus-level collision strictly
 * worse than the panic it avoids. The writer therefore throws, and the domain
 * has to be established before the writer is reached. Establishing it here, one
 * phase ahead of `post.ts` moving, is what keeps that throw unreachable rather
 * than latent.
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
// The block header's encodable domain (Phase 1f)
// ---------------------------------------------------------------------------
//
// One statement of the domain, two callers. It replaced `isEncodableHeader`,
// which stated the same domain as *types only* (`typeof prevBlockHash ===
// 'string'`, with no width and no alphabet; a bare `isBytes(validatorId)`, with
// no length) while `verifyOrderingBlockStructure` stated it again with widths
// and alphabets. Two implementations of one domain drift — the class the
// positional wire format exists to close — so both now consult this table.
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
  { field: 'powTargetBits', ok: isU64Safe, error: 'Block header powTargetBits must be a non-negative safe integer' },
  // vlqU, and the field nothing checked anywhere in the repo before Phase 1f.
  // A domain pin, not a clock policy: no monotonicity rule and no skew window —
  // those are consensus rule additions, and "never add checks the reference
  // lacks" applies. `createdAt` stays a producer-set record that no node
  // validates against anything, as in every chain in the lineage.
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
 * subsumed by the rejection (Phase 1c): `verifyOrderingBlockStructure` re-labels
 * the failure with its own long-standing per-field message rather than emitting
 * a bare "invalid header".
 */
export function verifyHeaderFieldDomains(header: unknown): { valid: boolean; error?: string } {
  if (!isObject(header)) return { valid: false, error: 'Block header is not an object' };
  const failed = firstHeaderDomainFailure(header);
  return failed ? { valid: false, error: failed.error } : { valid: true };
}

// ---------------------------------------------------------------------------
// verifyPoW
// ---------------------------------------------------------------------------

export function verifyPoW(input: Uint8Array, nonce: number, targetBits: number): boolean {
  if (!isBytes(input)) return false;
  if (!isU64Safe(nonce)) return false;
  if (!isU64Safe(targetBits)) return false;
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(nonce));
  const buf = Buffer.concat([Buffer.from(input), nonceBuf]);
  const hash = createHash('blake2b512').update(buf).digest().subarray(0, 32);
  return hasLeadingZeroBits(hash, targetBits);
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
  // `blockHashChecked` establishes the header domain itself, so a malformed
  // header yields `null` rather than throwing inside `encodeHeader`. Its
  // non-null return also proves `validatorId` is exactly 32 bytes, which is what
  // keeps `createPublicKey` ("Failed to read asymmetric key") out of reach.
  const hash = blockHashChecked(header);
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
  // matching the codepoint semantics the previous `u`-flag regex had.
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
  if (!sb.subBlockId) return { valid: false, error: 'Sub-block missing subBlockId' };
  if (typeof sb.protocolVersion !== 'number') return { valid: false, error: 'Sub-block missing protocolVersion' };
  if (!sb.producerId) return { valid: false, error: 'Sub-block missing producerId' };
  // The post's field domains, checked here because this is the Stage-1 gate the
  // relay path runs *before* it builds a PoW preimage from that post
  // (`net/gossip.ts:201` gates `:222`). Under fixed-width writers a post outside
  // the domain has no encoding and the writer throws — inside a topic validator
  // whose catch arm bans the *forwarding* peer for a message it merely relayed.
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
 * Phase 1e's teeth demonstration asserts these strings exactly.
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
  // New in Phase 1f — the field this function never touched.
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
  if (!Array.isArray(block.subBlockTree?.subBlockRefs)) {
    return { valid: false, error: 'Ordering block missing subBlockTree.subBlockRefs' };
  }
  if (!Array.isArray(block.subBlockTree.subBlockEntries) ||
      block.subBlockTree.subBlockEntries.length !== block.subBlockTree.subBlockRefs.length) {
    return { valid: false, error: 'Ordering block subBlockEntries must align with subBlockRefs' };
  }
  // Validate each entry. All three fields are `b32` at the codec boundary —
  // hex `string` in memory, raw bytes on the wire — so their domain is the hex
  // alphabet, not a character count. A 64-character *non-hex* value has no
  // encoding under a fixed-width writer and no sentinel to fall back on, so the
  // writer throws (TYPES_INTERFACE → Totality).
  //
  // The count check was never the whole rule here, and the reachable path runs
  // through the store rather than the preimage: `block-apply.ts:579` takes
  // `subBlockId = entry.postId` and `:584` writes `insertPostPlaceholder(
  // subBlockId, entry.parentRefs)` for any confirmed sub-block whose content
  // has not arrived. `insertPost` deliberately does not overwrite `parent_refs`
  // when the real post lands later (`store/posts.ts:91-92` says so), so the
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
    // `MAX_PARENT_REFS`, not a literal `8`. Every other enforcement site imports
    // the constant (`verifier.ts:137`, `:239`, `verifyParentRefsCount` above);
    // this one had
    // drifted to a literal, which is a no-op only while the constant is 8. The
    // moment it moves, a literal here would cap the post path at the new value
    // while this path — the one that feeds `insertPostPlaceholder` — kept
    // accepting the old one.
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
  // states and these three fields (here, `validatorId`, `coinbaseOutput.owner`)
  // did not follow. They are `b64`/`b32` *from a `Uint8Array`*, so the codec
  // reaches `writeBytesNOrThrow`, which throws on anything that is not a byte
  // view of that exact width; a 64-character string, `{length: 64}` and a
  // 64-element `Array` all satisfy a length check and none of them encode.
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
  // The only array in this struct that had no per-element check at all, so an
  // element could be a number, an object or `null`. Those reach `hexToBuf(id)`
  // inside `computeUtxoTxRoot`'s Merkle build (`block-creator.ts:79`, called
  // from `block-apply.ts:270`), where a non-string throws *today* — inside the
  // apply transaction, so the funnel's totality catch turns a malformed block
  // into an "unexpected failure" log rather than the stated rejection the
  // spec's boundary check requires (§2.1 step 4). Register row C3 records this
  // as subsumed by the migration, which is true from Phase 3 onward — the ids
  // decode as raw bytes then — and not true in the window this phase covers.
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
    if (typeof out.value !== 'bigint' || out.value < 0n) {
      return { valid: false, error: 'Coinbase output invalid value' };
    }
    if (typeof out.lockedUntilBlock !== 'number' || out.lockedUntilBlock < h.height) {
      return { valid: false, error: 'Coinbase output invalid lockedUntilBlock' };
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
// Block hash
// ---------------------------------------------------------------------------

/**
 * The block hash IS the hash of the serialized header.
 */
export function blockHash(header: BlockHeader): string {
  return createHash('blake2b512')
    .update(Buffer.from(encodeHeader(header)))
    .digest()
    .subarray(0, 32)
    .toString('hex');
}

/**
 * Compute the PoW preimage — the serialized header with powNonce=0.
 * The miner hashes this against candidate nonces.
 */
export function computePowHash(header: BlockHeader): Buffer {
  const template = { ...header, powNonce: 0 };
  return createHash('blake2b512')
    .update(Buffer.from(encodeHeader(template)))
    .digest()
    .subarray(0, 32);
}

// ---------------------------------------------------------------------------
// The guarded encoders (Phase 1f, expand step)
// ---------------------------------------------------------------------------
//
// `blockHash` and `computePowHash` above are the only two functions in this
// package that hand a header to `encodeHeader`, and neither checks anything.
// That precondition is currently the *caller's* to remember, at thirteen `src`
// lines — and the reachable path where nobody does is fork resolution, which
// carries bare peer headers that `net` obtained from a raw `cbor-x` decode with
// a TypeScript cast. `verifyOrderingBlockStructure` cannot cover it: it takes an
// `OrderingBlock` and that path has only headers.
//
// So the guard goes inside the encoder-backed functions rather than at their
// callers. A consumer then absorbs an *absence* — it does not learn the header
// domain, call a predicate, or decide what well-formed means. This extends the
// contract's no-panic rule (M-5) past the `verify*` naming convention that had
// quietly exempted these two: a function with no `false` to return says so with
// `null`.
//
// Temporary names. `blockHash` / `computePowHash` stay in place and unchanged
// until `node` and `net` have migrated (Phases 1f-2 / 1f-3); 1f-4 deletes the
// unguarded pair and the compiler proves nobody is left.

/**
 * `blockHash`, with its precondition enforced: `null` on exactly the headers
 * `verifyHeaderFieldDomains` rejects, the canonical 64-char hex hash otherwise.
 */
export function blockHashChecked(header: BlockHeader): string | null {
  if (firstHeaderDomainFailure(header) !== null) return null;
  return blockHash(header);
}

/**
 * `computePowHash`, with its precondition enforced: `null` on exactly the
 * headers `verifyHeaderFieldDomains` rejects, the 32-byte preimage otherwise.
 */
export function computePowHashChecked(header: BlockHeader): Buffer | null {
  if (firstHeaderDomainFailure(header) !== null) return null;
  return computePowHash(header);
}

// ---------------------------------------------------------------------------
// verifyOrderingBlockPoW
// ---------------------------------------------------------------------------

export function verifyOrderingBlockPoW(header: BlockHeader): boolean {
  // One gate, not two: the guarded preimage establishes the whole header domain,
  // which includes `powNonce` / `powTargetBits` as non-negative safe integers
  // (M-6) — the bound that keeps `BigInt` / `writeBigUInt64LE` from throwing.
  const preimage = computePowHashChecked(header);
  if (preimage === null) return false;
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(header.powNonce));
  const hash = createHash('blake2b512')
    .update(preimage)
    .update(nonceBuf)
    .digest()
    .subarray(0, 32);
  return hasLeadingZeroBits(hash, header.powTargetBits);
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
  const prevHash = blockHashChecked(prevBlock.header);
  if (prevHash === null) return false;
  return (
    block.header.prevBlockHash === prevHash &&
    block.header.height === prevBlock.header.height + 1
  );
}
