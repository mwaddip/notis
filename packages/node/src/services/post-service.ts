import {
  computePostId,
  computeTxId,
  decodeTx,
  MEMPOOL_EXPIRY_BLOCKS,
} from '@dagsocial/types';
import type {
  DecayCfg,
  IdentityRecord,
  PostCommit,
  KarmaBox,
  TxId,
  UtxoTransaction,
  AnyBox,
  ProtocolEra,
} from '@dagsocial/types';
import type { StoredPost } from '../store/posts.js';
import type { VerifierDeps, VerificationResult } from './verifier.js';
import { verifyPostBody } from '@dagsocial/validation';
import { ClientError } from './client-error.js';
import { emitPostReceived, emitPostValidated, emitPostIndexed } from '../journal.js';

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class PostServiceError extends ClientError {
  constructor(message: string, statusCode: number = 400) {
    super(message, statusCode);
    this.name = 'PostServiceError';
  }
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface PostServiceDeps {
  verifyPost: (deps: VerifierDeps, commit: PostCommit) => VerificationResult;
  getKarmaBoxes: (owner: Uint8Array) => { value: bigint; id?: string }[];
  getIdentityRecord: (owner: Uint8Array) => IdentityRecord | null;
  decayCfg: DecayCfg;
  getPost: (id: string) => StoredPost | null;

  insertPost: (postId: string, txId: TxId, commit: PostCommit, content: string | null) => void;

  getCurrentHeight: () => number;
  /** The profile's era schedule — supplied to the verifier's version check. */
  protocolVersionSchedule: readonly ProtocolEra[];

  admitTx: (tx: UtxoTransaction, expiresAtHeight: number) => number;

  /** MEMPOOL_INTERFACE → getHeldEntry — the pool's one point read by id. */
  getHeldEntry: (txId: string) => { expiresAtHeight: number; txBytes: Uint8Array } | null;

  validateTx: (
    tx: UtxoTransaction,
    txId: string,
    currentBlockHeight: number,
  ) => { valid: boolean; error?: string; computedOutputs?: AnyBox[]; txId?: string };
  getBox: (id: string) => AnyBox | null;

  runInTransaction: (fn: () => void) => void;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface PostCreateResult {
  postId: string;
  status: 'pending';
  expiresAtHeight: number;
  txId: string;
  tx: UtxoTransaction;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createPost(
  deps: PostServiceDeps,
  tx: UtxoTransaction,
  content: string,
): PostCreateResult {
  // The judged-for height — tip + 1, the block that would carry this
  // transaction. The verifier and validateTx read the same height, one rule
  // (NODE_INTERFACE → validateTx).
  const currentHeight = deps.getCurrentHeight() + 1;

  const commit = tx.post;
  if (!commit) {
    throw new PostServiceError('transaction carries no post payload');
  }

  // ---- Verify the body against the commitment ----
  const bodyCheck = verifyPostBody(content, commit.contentHash);
  if (!bodyCheck.valid) {
    throw new PostServiceError(bodyCheck.error ?? 'body verification failed');
  }

  // MEMPOOL_INTERFACE → "A transaction the pool holds is answered as held,
  // before anything reads state". The id derives from the canonical bytes
  // (TYPES_INTERFACE → Layout — UtxoTransaction); an id the encoder refuses
  // is a PostServiceError, as any refusal of the service's is. A pooled
  // entry ends the path with the stored bytes decoded and no journal event
  // (JOURNAL_EVENTS.md → "A post whose transaction the pool already holds,
  // arriving again, emits none of the three post events").
  let heldTxId: string;
  try {
    heldTxId = computeTxId(tx);
  } catch (err) {
    throw new PostServiceError((err as Error).message);
  }
  const heldEntry = deps.getHeldEntry(heldTxId);
  if (heldEntry !== null) {
    return {
      postId: computePostId(heldTxId, 0),
      status: 'pending',
      expiresAtHeight: heldEntry.expiresAtHeight,
      txId: heldTxId,
      tx: decodeTx(heldEntry.txBytes),
    };
  }

  // ---- Verify the commit (domains, parents, karma) ----
  const validationStart = performance.now();
  const verifierDeps: VerifierDeps = {
    getKarmaBoxes: deps.getKarmaBoxes,
    getIdentityRecord: deps.getIdentityRecord,
    currentHeight,
    decayCfg: deps.decayCfg,
    getPost: deps.getPost,
    protocolVersionSchedule: deps.protocolVersionSchedule,
  };
  const result = deps.verifyPost(verifierDeps, commit);
  if (!result.valid) {
    throw new PostServiceError(result.error ?? 'validation failed');
  }

  // ---- Validate the transaction ----
  const txResult = deps.validateTx(tx, heldTxId, currentHeight);
  if (!txResult.valid) {
    throw new PostServiceError(txResult.error ?? 'invalid post transaction');
  }
  const txId = txResult.txId;
  if (!txId) {
    throw new PostServiceError('transaction validation returned no txId');
  }
  const validationDurationMs = performance.now() - validationStart;

  // ---- Bind the payload's author to the karma being spent ----
  const firstInput = tx.inputs[0];
  if (!firstInput) {
    throw new PostServiceError('post transaction has no inputs');
  }
  const karmaInput = deps.getBox(firstInput);
  if (!karmaInput || karmaInput.boxType !== 'karma') {
    throw new PostServiceError('post transaction first input must be a karma box');
  }
  const karmaOwner = (karmaInput as KarmaBox).owner;
  if (!karmaOwner || karmaOwner.length !== 32) {
    throw new PostServiceError('Karma box has invalid owner');
  }
  if (!Buffer.from(commit.author).equals(Buffer.from(karmaOwner))) {
    throw new PostServiceError('post transaction does not belong to post author');
  }

  // ---- Name the post from its creating transaction ----
  const postId = computePostId(txId, 0);
  emitPostReceived(postId, 'local', 'packet');
  emitPostValidated(postId, validationDurationMs);

  // ---- admitTx and insertPost in one store transaction ----
  const expiresAtHeight = currentHeight + MEMPOOL_EXPIRY_BLOCKS;
  deps.runInTransaction(() => {
    deps.admitTx(tx, expiresAtHeight);
    deps.insertPost(postId, txId, commit, content);
  });
  emitPostIndexed(postId, commit.parentRefs.length);

  return {
    postId,
    status: 'pending',
    expiresAtHeight,
    txId,
    tx,
  };
}
