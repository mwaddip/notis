import { BOX_VALUE_BOUND, PROTOCOL_VERSION } from '@dagsocial/types';
import type { AnyBox, Post, UtxoTransaction } from '@dagsocial/types';
import { ClientError } from '../services/client-error.js';

/**
 * Fields in box types whose runtime value is Uint8Array but arrive as hex
 * strings over the JSON HTTP API.  We convert them back during deserialisation.
 */
const BINARY_BOX_FIELDS = new Set([
  'owner',            // KarmaBox, CreditBox, PostLockBox
  'inviterId',        // InviteBox, BondBox
  'inviteePublicKey', // InviteBox, BondBox
  // VouchBox. A field missing from this list makes its box INEXPRESSIBLE over
  // HTTP JSON — the value arrives as a hex string and dies at `validateTx`'s
  // step-4 schema, which wants `bytes32`. Service-level tests cannot see it:
  // they pass raw `Uint8Array` objects and never cross this edge. This list and
  // the demo UI's `canonicalBoxBytes` mirror must name the same fields.
  'voucherId',        // VouchBox
  'targetId',         // VouchBox
]);

/**
 * Convert a JSON tx object (as received over the HTTP API) into a
 * {@link UtxoTransaction}.  Hex-encoded Uint8Array fields in signatures,
 * preimages, and box outputs are decoded to raw `Uint8Array`.
 */
export function jsonToTx(raw: Record<string, unknown>): UtxoTransaction {
  // ---- signatures ----
  const rawSigs = (raw.signatures ?? {}) as Record<string, string>;
  const signatures: Record<string, Uint8Array> = {};
  for (const [key, val] of Object.entries(rawSigs)) {
    if (typeof val !== 'string') {
      throw new ClientError(`signature for ${key} must be a hex string`);
    }
    signatures[key] = hexToBytes(val);
  }

  // ---- preimages ----
  const rawPreimages = (raw.preimages ?? {}) as Record<string, string>;
  const preimages: Record<string, Uint8Array> = {};
  for (const [key, val] of Object.entries(rawPreimages)) {
    if (typeof val !== 'string') {
      throw new ClientError(`preimage for ${key} must be a hex string`);
    }
    preimages[key] = hexToBytes(val);
  }

  // ---- outputs ----
  const rawOutputs = (raw.outputs ?? []) as Record<string, unknown>[];
  const outputs = rawOutputs.map(convertBox) as unknown as AnyBox[];

  // ---- protocolVersion ----
  // `PROTOCOL_VERSION`, never a hard-coded 1: after a version bump the literal
  // would have this edge mint stale-version txs that `checkTxEnvelope`'s
  // strict-equality clause then rejects. The value still passes through when
  // the client supplies one — the gate owns the equality check, this owns only
  // the default.
  const protocolVersion = (raw.protocolVersion as number) ?? PROTOCOL_VERSION;

  // ---- likeTarget ----
  // Carried through only when present — presence is `!== undefined`, matching
  // the `computeTxId` tail rule. The JSON edge must neither drop nor invent
  // the field: it sits inside the signed bytes, so dropping it breaks every
  // like signature, and `castLike` owns the 64-hex shape check.
  const likeTarget = raw.likeTarget;
  if (likeTarget !== undefined && typeof likeTarget !== 'string') {
    throw new ClientError('likeTarget must be a string post id');
  }

  // ---- post ----
  // Same rule as `likeTarget`: carried through only when present, because it sits
  // inside the signed bytes. `author` is the one binary field — hex on the wire,
  // raw bytes in the preimage — and `verifyTxStructure` owns its 32-byte shape
  // check, as `castLike` owns `likeTarget`'s.
  const post = raw.post === undefined ? undefined : jsonToPost(raw.post);

  return {
    inputs: (raw.inputs ?? []) as string[],
    outputs,
    signatures,
    // A conditional SPREAD, not `: undefined` — the same idiom `likeTarget`
    // uses one line below, and for the same reason. `preimages: undefined`
    // leaves a present key holding `undefined`, which `computeTxId` hashes as
    // absent (falsy) but `checkTxEnvelope` rejects as the CBOR-reachable
    // ambiguity it is. "Normalizes {} to absent" has to hold in structure, not
    // merely in effect: a present key holding `undefined` is not an absent key.
    ...(Object.keys(preimages).length > 0 ? { preimages } : {}),
    protocolVersion,
    ...(likeTarget !== undefined ? { likeTarget } : {}),
    ...(post !== undefined ? { post } : {}),
  };
}

/**
 * Convert the JSON post payload carried by a post transaction.
 *
 * ⚠ **No id is read and none may be.** A post's id comes from the transaction
 * that creates it (`computePostId(txId, index)`), so a client-supplied id would
 * be a claim with nothing behind it. The service derives it after the
 * transaction validates.
 */
function jsonToPost(raw: unknown): Post {
  if (typeof raw !== 'object' || raw === null) {
    throw new ClientError('post must be an object');
  }
  const p = raw as Record<string, unknown>;
  if (typeof p.author !== 'string') {
    throw new ClientError('post author must be a hex string');
  }
  const author = hexToBytes(p.author);
  if (author.length !== 32) {
    throw new ClientError('post author must be 32 bytes (64 hex chars) — Ed25519 public key');
  }
  return {
    content: p.content as string,
    author,
    parentRefs: (p.parentRefs ?? []) as string[],
    protocolVersion: (p.protocolVersion as number) ?? PROTOCOL_VERSION,
    timestamp: p.timestamp as number,
  };
}

/**
 * Amount fields that are bigint at runtime but arrive as decimal strings (or
 * safe-integer numbers) over the JSON HTTP API: `value` on every box type,
 * `originalValue` on PostLockBox. Coerced before validation — leaving one as
 * a number would change its CBOR encoding and so the computed box id.
 */
const VALUE_BOX_FIELDS = new Set(['value', 'originalValue']);

/**
 * Convert hex-encoded Uint8Array fields inside a single box object, coerce
 * amount fields to bigint, and reject a `value` the ledger cannot account for.
 */
function convertBox(box: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(box)) {
    if (BINARY_BOX_FIELDS.has(key) && typeof val === 'string') {
      out[key] = hexToBytes(val);
    } else if (VALUE_BOX_FIELDS.has(key)) {
      out[key] = coerceBoxValue(val, key);
    } else {
      out[key] = val;
    }
  }
  assertValidBoxValue(out.value);
  return out;
}

/**
 * Coerce an incoming JSON amount (decimal string or safe-integer number) to
 * bigint, rejecting anything not cleanly convertible, then enforce the value
 * bound. This is the HTTP→consensus edge for box values.
 */
function coerceBoxValue(raw: unknown, field: string): bigint {
  let value: bigint;
  if (typeof raw === 'bigint') {
    value = raw;
  } else if (typeof raw === 'number' && Number.isSafeInteger(raw)) {
    value = BigInt(raw);
  } else if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) {
    value = BigInt(raw);
  } else {
    throw new ClientError(
      `box ${field} must be a non-negative integer (decimal string or number), got ${String(raw)}`,
    );
  }
  assertValidBoxValue(value, field);
  return value;
}

/**
 * A box `value` must lie in `[0, BOX_VALUE_BOUND)` — the accepted domain,
 * imported rather than restated (TYPES_INTERFACE → Box value domain). Negative
 * values break conservation arithmetic; a value at or above the bound encodes
 * cleanly and cannot be stored. Rejecting here gives the client a clear 400;
 * `validateTx`'s step-4 output schema (the `u64` field type) enforces the same
 * bound for txs arriving over gossip or inside a block.
 */
function assertValidBoxValue(value: unknown, field = 'value'): void {
  if (typeof value !== 'bigint' || value < 0n || value >= BOX_VALUE_BOUND) {
    throw new ClientError(
      `box ${field} must be a non-negative bigint < 2^63, got ${String(value)}`,
    );
  }
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}
