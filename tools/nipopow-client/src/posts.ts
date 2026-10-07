// WEB_INTERFACE → The extension → "The post check" — checkPosts binds every
// row the three post reads bring to the transaction that created it, before
// the extension shows one. The order is the rule, as the contract states.
//
// VALIDATION_INTERFACE → Acceptance criterion — every signature check is
// verifyEd25519 / verifyEd25519Batch; the message is the transaction id's 32
// bytes (CONSENSUS_INTERFACE → the overlay: `verifyGuardSignature` passes
// `hexToBytes(computeTxId(tx))` to `verifyEd25519`).
//
// NODE_INTERFACE → Posts → "The creating transaction rides a post row" — the
// row's PostJson / WithdrawnJson shape, plus `tx: hex | null` the three reads
// add with `?tx=1`.

import {
  bytesToHex,
  computeContentHash,
  computePostId,
  computeTxId,
  decodeTx,
  hexToBytes,
} from '@dagsocial/types';
import type { PostCommit, PostType, UtxoTransaction } from '@dagsocial/types';
import { verifyEd25519, verifyEd25519Batch } from '@dagsocial/validation';
import type { Ed25519BatchEntry } from '@dagsocial/validation';
import { isRecord, shown } from './http.js';

/**
 * The closed set of reasons an `unbound` row carries, in the order checkPosts
 * applies them (WEB_INTERFACE → The extension → "The post check").
 */
export type PostUnboundReason =
  | 'no-tx'
  | 'undecodable'
  | 'no-post'
  | 'tx-id'
  | 'post-id'
  | 'commit'
  | 'content'
  | 'unsigned'
  | 'signature'
  | 'malformed';

/**
 * One row's verdict. `bound` carries the id, the transaction's bytes, the
 * author's lowercase hex and the one parent (or `null`), the fields the
 * extension's cache stores (WEB_INTERFACE → The extension → "The post cache").
 */
export type PostCheck =
  | { status: 'bound'; id: string; txBytes: Uint8Array; author: string; parent: string | null }
  | { status: 'unbound'; reason: PostUnboundReason; verdict: string }
  | { status: 'nothing-to-bind' }
  | { status: 'unserved' };

/** The verifiers checkPosts calls. Injected so a test can refute the counts. */
export interface CheckDeps {
  verifyBatch: (entries: ReadonlyArray<Ed25519BatchEntry>) => boolean;
  verifyOne: (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) => boolean;
}

const HEX_64 = /^[0-9a-f]{64}$/i;
const POST_TYPES: readonly PostType[] = ['regular', 'profile'];

/**
 * Pure, synchronous, total — a row of any shape ends in a status, never a
 * throw. The verifiers default to validation's two forms; a test may override
 * them to count the calls.
 *
 * WEB_INTERFACE → The extension → "The post check" — the ordered checks per
 * row; then the page's signatures as one `verifyEd25519Batch`, and only when
 * that batch fails, each still-candidate row once through `verifyEd25519`.
 */
export function checkPosts(
  rows: unknown[],
  deps: CheckDeps = { verifyBatch: verifyEd25519Batch, verifyOne: verifyEd25519 },
): PostCheck[] {
  // Per-row ordered checks. A row that passes every check up to the signature
  // is collected as a candidate; the batch then decides the whole page at
  // once, with a per-row recheck only when the batch fails.
  interface Candidate {
    index: number;
    id: string;
    txBytes: Uint8Array;
    author: string;
    parent: string | null;
    message: Uint8Array;
    signature: Uint8Array;
    publicKey: Uint8Array;
  }

  const results: PostCheck[] = new Array<PostCheck>(rows.length);
  const candidates: Candidate[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const outcome = checkRow(row);
    if (outcome.kind === 'candidate') {
      candidates.push({ index: i, ...outcome.data });
    } else {
      results[i] = outcome.result;
    }
  }

  if (candidates.length === 0) return results;

  const batchOk = deps.verifyBatch(
    candidates.map((c) => ({ signature: c.signature, message: c.message, publicKey: c.publicKey })),
  );

  if (batchOk) {
    for (const c of candidates) {
      results[c.index] = { status: 'bound', id: c.id, txBytes: c.txBytes, author: c.author, parent: c.parent };
    }
    return results;
  }

  for (const c of candidates) {
    const ok = deps.verifyOne(c.signature, c.message, c.publicKey);
    results[c.index] = ok
      ? { status: 'bound', id: c.id, txBytes: c.txBytes, author: c.author, parent: c.parent }
      : {
        status: 'unbound',
        reason: 'signature',
        verdict: `unbound: the author's signature does not verify over the transaction id`,
      };
  }
  return results;
}

type RowOutcome =
  | { kind: 'result'; result: PostCheck }
  | {
    kind: 'candidate';
    data: {
      id: string;
      txBytes: Uint8Array;
      author: string;
      parent: string | null;
      message: Uint8Array;
      signature: Uint8Array;
      publicKey: Uint8Array;
    };
  };

function checkRow(row: unknown): RowOutcome {
  if (!isRecord(row)) {
    return unbound('malformed', `malformed: a row is ${shown(row)}`);
  }

  // WithdrawnJson carries `kind: 'withdrawn'` — it holds no text for a
  // transaction to bind.
  if (row['kind'] === 'withdrawn') return result({ status: 'nothing-to-bind' });

  const txField = row['tx'];
  if (txField === null) return result({ status: 'unserved' });
  if (typeof txField !== 'string') {
    return unbound('no-tx', `unbound: the row carries no tx: ${shown(txField)}`);
  }

  let txBytes: Uint8Array;
  let decoded: UtxoTransaction;
  try {
    txBytes = hexToBytes(txField);
    decoded = decodeTx(txBytes);
  } catch (e) {
    return unbound('undecodable', `unbound: tx will not decode: ${describeError(e)}`);
  }

  const commit = decoded.post;
  if (commit === undefined) {
    return unbound('no-post', 'unbound: the transaction carries no post commit');
  }

  // The shape pre-check on the row's own fields — anything but the fields the
  // commit is checked against is a malformed row, since the commit cannot be
  // weighed against a field whose shape is wrong.
  const rowId = row['id'];
  if (typeof rowId !== 'string' || !HEX_64.test(rowId)) {
    return unbound('malformed', `malformed: row id is ${shown(rowId)}`);
  }
  const rowTxId = row['txId'];
  if (typeof rowTxId !== 'string' || !HEX_64.test(rowTxId)) {
    return unbound('malformed', `malformed: row txId is ${shown(rowTxId)}`);
  }
  const rowAuthor = row['author'];
  if (typeof rowAuthor !== 'string' || !HEX_64.test(rowAuthor)) {
    return unbound('malformed', `malformed: row author is ${shown(rowAuthor)}`);
  }
  const rowParentRefs = row['parentRefs'];
  if (!Array.isArray(rowParentRefs)) {
    return unbound('malformed', `malformed: row parentRefs is ${shown(rowParentRefs)}`);
  }
  for (const ref of rowParentRefs) {
    if (typeof ref !== 'string' || !HEX_64.test(ref)) {
      return unbound('malformed', `malformed: a parent ref is ${shown(ref)}`);
    }
  }
  const rowContentHash = row['contentHash'];
  if (typeof rowContentHash !== 'string' || !HEX_64.test(rowContentHash)) {
    return unbound('malformed', `malformed: row contentHash is ${shown(rowContentHash)}`);
  }
  const rowType = row['type'];
  if (typeof rowType !== 'string' || !POST_TYPES.includes(rowType as PostType)) {
    return unbound('malformed', `malformed: row type is ${shown(rowType)}`);
  }
  const rowProtocolVersion = row['protocolVersion'];
  if (typeof rowProtocolVersion !== 'number' || !Number.isInteger(rowProtocolVersion)) {
    return unbound('malformed', `malformed: row protocolVersion is ${shown(rowProtocolVersion)}`);
  }
  const rowContent = row['content'];
  if (rowContent !== null && typeof rowContent !== 'string') {
    return unbound('malformed', `malformed: row content is ${shown(rowContent)}`);
  }

  // computeTxId / computePostId — both throw on an out-of-domain transaction
  // (TYPES_INTERFACE → computeTxId), so each sits inside a try that maps a
  // throw onto the step's own unbound reason.
  let txId: string;
  try {
    txId = computeTxId(decoded);
  } catch (e) {
    return unbound('tx-id', `unbound: the transaction will not hash to an id: ${describeError(e)}`);
  }
  if (txId !== rowTxId.toLowerCase()) {
    return unbound('tx-id', `unbound: computeTxId '${txId}' does not match row txId '${rowTxId.toLowerCase()}'`);
  }

  let postId: string;
  try {
    postId = computePostId(txId, 0);
  } catch (e) {
    return unbound('post-id', `unbound: computePostId refused: ${describeError(e)}`);
  }
  if (postId !== rowId.toLowerCase()) {
    return unbound('post-id', `unbound: computePostId '${postId}' does not match row id '${rowId.toLowerCase()}'`);
  }

  const commitAuthor = bytesToHex(commit.author);
  if (commitAuthor !== rowAuthor.toLowerCase()) {
    return unbound('commit', `unbound: commit author '${commitAuthor}' does not match row author '${rowAuthor.toLowerCase()}'`);
  }
  if (!parentRefsEqual(commit.parentRefs, rowParentRefs)) {
    return unbound('commit', `unbound: commit parentRefs do not match the row's`);
  }
  const commitContentHash = bytesToHex(commit.contentHash);
  if (commitContentHash !== rowContentHash.toLowerCase()) {
    return unbound('commit', `unbound: commit contentHash '${commitContentHash}' does not match row contentHash '${rowContentHash.toLowerCase()}'`);
  }
  if (commit.type !== rowType) {
    return unbound('commit', `unbound: commit type '${commit.type}' does not match row type '${String(rowType)}'`);
  }
  if (commit.protocolVersion !== rowProtocolVersion) {
    return unbound('commit', `unbound: commit protocolVersion ${commit.protocolVersion} does not match row protocolVersion ${rowProtocolVersion}`);
  }

  // A placeholder — `content: null` — is checked as any row, less this step.
  if (typeof rowContent === 'string') {
    let hashHex: string;
    try {
      hashHex = bytesToHex(computeContentHash(rowContent));
    } catch (e) {
      return unbound('content', `unbound: computeContentHash refused: ${describeError(e)}`);
    }
    if (hashHex !== commitContentHash) {
      return unbound('content', `unbound: computeContentHash of the row's content does not match the commit's`);
    }
  }

  const signature = decoded.signatures[commitAuthor];
  if (signature === undefined) {
    return unbound('unsigned', `unbound: the transaction carries no signature under the author's key`);
  }

  // The message every tx signature is over — the 32-byte txId
  // (CONSENSUS_INTERFACE → the overlay).
  let message: Uint8Array;
  try {
    message = hexToBytes(txId);
  } catch (e) {
    // computeTxId answers lowercase 64-hex by construction, so this is
    // unreachable — kept as a totality guard rather than a path.
    return unbound('malformed', `malformed: txId will not decode: ${describeError(e)}`);
  }

  const parent = commit.parentRefs.length === 0 ? null : commit.parentRefs[0]!;

  return {
    kind: 'candidate',
    data: {
      id: postId,
      txBytes,
      author: commitAuthor,
      parent,
      message,
      signature,
      publicKey: commit.author,
    },
  };
}

function parentRefsEqual(commitRefs: readonly string[], rowRefs: readonly unknown[]): boolean {
  if (commitRefs.length !== rowRefs.length) return false;
  for (let i = 0; i < commitRefs.length; i++) {
    const r = rowRefs[i];
    if (typeof r !== 'string' || r.toLowerCase() !== commitRefs[i]!.toLowerCase()) return false;
  }
  return true;
}

function unbound(reason: PostUnboundReason, verdict: string): RowOutcome {
  return { kind: 'result', result: { status: 'unbound', reason, verdict } };
}

function result(r: PostCheck): RowOutcome {
  return { kind: 'result', result: r };
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

// Keep the unused import out of the browser surface — PostCommit is referenced
// only through the decoded transaction's type.
export type { PostCommit };
