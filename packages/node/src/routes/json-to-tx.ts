import { BOX_VALUE_BOUND, encodeTx, hexToBytes, MAX_TX_BYTES, protocolVersionAt } from '@dagsocial/types';
import type { AnyBox, PostCommit, PostType, PostWithdrawCommit, ProtocolEra, UtxoTransaction } from '@dagsocial/types';
import { checkOutputShape, checkTxEnvelope } from '@dagsocial/consensus';
import { verifyTxStructure } from '@dagsocial/validation';
import { ClientError } from '../services/client-error.js';
import { TxTooLargeError } from '../store/mempool.js';

/**
 * The HTTP JSON names of the box fields a transaction carries as bytes
 * (TYPES_INTERFACE → Layout — Boxes). Every entry is a hex string this
 * edge decodes with `@dagsocial/types`' `hexToBytes`, the one spelling
 * the strict decoder accepts (NODE_INTERFACE → HTTP API → "Hex is
 * lowercase"). A box field missing from this set is read through
 * as the client's bytes and refused at the per-box schema
 * (NODE_INTERFACE → Output shape).
 */
export const BINARY_BOX_FIELDS = new Set([
  'owner',            // KarmaBox, CreditBox, VouchEscrowBox, UsernameBox
  'inviterId',        // BondBox
  'inviteePublicKey', // BondBox
  'voucherId',        // VouchBox
  'targetId',         // VouchBox
  'author',           // LikeAccrualBox
  'name',             // UsernameBox
]);

/**
 * The HTTP JSON names of the box fields a transaction carries as
 * `bigint` amounts.
 */
const VALUE_BOX_FIELDS = new Set(['value', 'weight', 'staked', 'accrual']);

/**
 * The JSON form of the lead "A write request's transaction is checked
 * whole before anything reads it" (NODE_INTERFACE → HTTP API). Throws
 * `ClientError` (400) naming the field for a `tx` that is not a plain
 * object; an absent `inputs`, `outputs` or `signatures`; an `outputs`
 * that is not an array of plain objects; a `signatures` that is not a
 * plain object of strings; a binary field — each signature, the commit's
 * `contentHash` and `author`, each `BINARY_BOX_FIELDS` box field — that
 * is not a string or a string `@dagsocial/types`' `hexToBytes` refuses;
 * an amount that is neither a safe integer nor a decimal string of 1
 * to 19 digits; a post commit with no `parentRefs` or no `type`.
 *
 * An absent `protocolVersion`, the transaction's or the commit's, is
 * supplied as the era the caller hands in; `inputs` passes as given,
 * which `checkTxEnvelope` types (NODE_INTERFACE → Transaction envelope
 * shape).
 */
export function jsonToTx(raw: unknown, defaultVersion: number): UtxoTransaction {
  if (!isPlainObject(raw)) {
    throw new ClientError('tx must be a plain object');
  }
  const r = raw;
  const inputs = requireKey(r, 'inputs');
  const rawOutputs = requireKey(r, 'outputs');
  const rawSigs = requireKey(r, 'signatures');

  if (!isPlainObject(rawSigs)) {
    throw new ClientError('signatures must be a plain object');
  }
  const signatures: Record<string, Uint8Array> = {};
  for (const [key, val] of Object.entries(rawSigs)) {
    if (typeof val !== 'string') {
      throw new ClientError(`signature value for ${key} must be a hex string`);
    }
    try {
      signatures[key] = hexToBytes(val);
    } catch {
      throw new ClientError(`signature value for ${key} must be lowercase hex of even length`);
    }
  }

  if (!Array.isArray(rawOutputs)) {
    throw new ClientError('outputs must be an array');
  }
  const outputs: AnyBox[] = rawOutputs.map((entry, i) => {
    if (!isPlainObject(entry)) {
      throw new ClientError(`outputs[${i}] must be a plain object`);
    }
    return convertBox(entry, i);
  }) as unknown as AnyBox[];

  // An absent `protocolVersion` is supplied; a present one — `null`
  // included — reaches `checkTxEnvelope`, which refuses it
  // (NODE_INTERFACE → Transaction envelope shape).
  const protocolVersion = Object.hasOwn(r, 'protocolVersion') ? r.protocolVersion : defaultVersion;

  const likeTarget = r.likeTarget;
  if (likeTarget !== undefined && typeof likeTarget !== 'string') {
    throw new ClientError('likeTarget must be a string post id');
  }

  const post = r.post === undefined ? undefined : jsonToPostCommit(r.post, defaultVersion);
  const postWithdraw = r.postWithdraw === undefined ? undefined : jsonToPostWithdrawCommit(r.postWithdraw);

  return {
    inputs: inputs as UtxoTransaction['inputs'],
    outputs,
    signatures,
    protocolVersion: protocolVersion as number,
    ...(likeTarget !== undefined ? { likeTarget } : {}),
    ...(post !== undefined ? { post } : {}),
    ...(postWithdraw !== undefined ? { postWithdraw } : {}),
  };
}

/**
 * NODE_INTERFACE → HTTP API → "A write request's transaction is checked
 * whole before anything reads it". Reads the request's `tx` value whole
 * before any service reads it: the JSON form (jsonToTx), then
 * `checkTxEnvelope` at `height` and `checkOutputShape`
 * (NODE_INTERFACE → Transaction envelope shape; → Output shape), then
 * `verifyTxStructure` last (VALIDATION_INTERFACE → verifyTxStructure).
 * Returns the transaction, or throws: a `ClientError` (400) for every
 * refusal with the check's own error, except the structure refusal where
 * `encodeTx(tx).length > MAX_TX_BYTES` — that one is `TxTooLargeError`
 * (413), the pool's own bound
 * (MEMPOOL_INTERFACE → insertUtxoTx → "It is the pool's own bound, not
 * a restatement of validation's").
 */
export function checkRequestTx(
  rawTx: unknown,
  height: number,
  schedule: readonly ProtocolEra[],
): UtxoTransaction {
  const tx = jsonToTx(rawTx, protocolVersionAt(schedule, height)!);
  const envelope = checkTxEnvelope(tx, height, schedule);
  if (!envelope.valid) throw new ClientError(envelope.error!);
  const shape = checkOutputShape(tx.outputs);
  if (!shape.valid) throw new ClientError(shape.error!);
  const structure = verifyTxStructure(tx);
  if (!structure.valid) {
    const length = encodeTx(tx).length;
    if (length > MAX_TX_BYTES) throw new TxTooLargeError(length);
    throw new ClientError(structure.error!);
  }
  return tx;
}

function requireKey(obj: Record<string, unknown>, name: string): unknown {
  if (!Object.hasOwn(obj, name)) {
    throw new ClientError(`${name} required`);
  }
  return obj[name];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function jsonToPostCommit(raw: unknown, defaultVersion: number): PostCommit {
  if (!isPlainObject(raw)) {
    throw new ClientError('post must be a plain object');
  }
  if (!Object.hasOwn(raw, 'parentRefs')) {
    throw new ClientError('post parentRefs required');
  }
  if (!Array.isArray(raw.parentRefs)) {
    throw new ClientError('post parentRefs must be an array');
  }
  if (!Object.hasOwn(raw, 'type')) {
    throw new ClientError('post type required');
  }
  if (typeof raw.contentHash !== 'string') {
    throw new ClientError('post contentHash must be a hex string');
  }
  const contentHash = decodeHex(raw.contentHash, 'post contentHash');
  if (contentHash.length !== 32) {
    throw new ClientError('post contentHash must be 32 bytes (64 hex chars)');
  }
  if (typeof raw.author !== 'string') {
    throw new ClientError('post author must be a hex string');
  }
  const author = decodeHex(raw.author, 'post author');
  if (author.length !== 32) {
    throw new ClientError('post author must be 32 bytes (64 hex chars) — Ed25519 public key');
  }
  const protocolVersion = Object.hasOwn(raw, 'protocolVersion') ? raw.protocolVersion : defaultVersion;
  return {
    contentHash,
    author,
    parentRefs: raw.parentRefs as string[],
    protocolVersion: protocolVersion as number,
    type: raw.type as PostType,
  };
}

function jsonToPostWithdrawCommit(raw: unknown): PostWithdrawCommit {
  if (!isPlainObject(raw)) {
    throw new ClientError('postWithdraw must be a plain object');
  }
  if (typeof raw.postId !== 'string') {
    throw new ClientError('postWithdraw postId must be a string');
  }
  return { postId: raw.postId };
}

function convertBox(box: Record<string, unknown>, outputIndex: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(box)) {
    if (BINARY_BOX_FIELDS.has(key)) {
      if (typeof val !== 'string') {
        throw new ClientError(`outputs[${outputIndex}].${key} must be a hex string`);
      }
      out[key] = decodeHex(val, `outputs[${outputIndex}].${key}`);
    } else if (VALUE_BOX_FIELDS.has(key)) {
      out[key] = coerceBoxValue(val, `outputs[${outputIndex}].${key}`);
    } else {
      out[key] = val;
    }
  }
  if (Object.hasOwn(out, 'value')) {
    assertValidBoxValue(out.value, `outputs[${outputIndex}].value`);
  }
  return out;
}

function decodeHex(hex: string, field: string): Uint8Array {
  try {
    return hexToBytes(hex);
  } catch {
    throw new ClientError(`${field} must be lowercase hex of even length`);
  }
}

/**
 * Coerce an incoming JSON amount to `bigint`. The accepted domain is a
 * safe-integer number or a decimal string of 1 to 19 digits — enough to
 * spell every value the ledger stores (TYPES_INTERFACE → Box value
 * domain). A leading zero is a client that cannot be read as it is: `5`
 * and `005` are two spellings of one value, which the sender signed over
 * exactly one of.
 */
function coerceBoxValue(raw: unknown, field: string): bigint {
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) {
      throw new ClientError(`${field} must be a safe integer or a decimal string of 1 to 19 digits`);
    }
    const v = BigInt(raw);
    assertValidBoxValue(v, field);
    return v;
  }
  if (typeof raw === 'string') {
    if (!/^(0|[1-9][0-9]{0,18})$/.test(raw)) {
      throw new ClientError(`${field} must be a safe integer or a decimal string of 1 to 19 digits`);
    }
    const v = BigInt(raw);
    assertValidBoxValue(v, field);
    return v;
  }
  throw new ClientError(`${field} must be a safe integer or a decimal string of 1 to 19 digits`);
}

function assertValidBoxValue(value: unknown, field: string): void {
  if (typeof value !== 'bigint' || value < 0n || value >= BOX_VALUE_BOUND) {
    throw new ClientError(`${field} must be a non-negative bigint < 2^63, got ${String(value)}`);
  }
}
