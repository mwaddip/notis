import {
  computePostId,
  MEMPOOL_EXPIRY_BLOCKS,
} from '@dagsocial/types';
import type { Post, Stump, KarmaBox, UtxoTransaction, AnyBox } from '@dagsocial/types';
import type { StoredPost } from '../store/posts.js';
import type { VerifierDeps, VerificationResult } from './verifier.js';
import { ClientError } from './client-error.js';

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class PostServiceError extends ClientError {
  constructor(message: string, statusCode: number = 400) {
    super(message, statusCode);
    this.name = 'PostServiceError';
  }
}

/** Validation-specific error — the post failed independent recomputation. */
export class PostValidationError extends PostServiceError {
  constructor(message: string) {
    super(message);
    this.name = 'PostValidationError';
  }
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface PostServiceDeps {
  // Validation
  verifyPost: (deps: VerifierDeps, post: Post) => VerificationResult;
  getKarmaBoxes: (owner: Uint8Array) => { value: bigint; id?: string }[];
  /**
   * The store's real signature — passed straight through to `VerifierDeps`,
   * which needs only the `Post` half. Named as the store returns it because
   * `PostsDeps` extends this interface and `FeedServiceDeps` together, and two
   * descriptions of one injected function have to agree.
   */
  getPost: (id: string) => StoredPost | Stump | null;

  // Serialization & storage
  encodePost: (post: Post) => Uint8Array;
  insertPost: (postId: string, post: Post, rawCbor: Uint8Array) => void;

  // State
  getCurrentHeight: () => number;

  // Mutations
  /** Admission — the relay policy above the pool, never the store directly. */
  admitTx: (tx: UtxoTransaction, expiresAtHeight: number) => number;

  // UTXO validation
  validateTx: (
    tx: UtxoTransaction,
    currentBlockHeight: number,
  ) => { valid: boolean; error?: string; computedOutputs?: AnyBox[]; txId?: string };
  getBox: (id: string) => AnyBox | null;
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

/**
 * Post creation service — **one transaction, one mempool entry**.
 *
 * A post is the payload of the transaction that locks its karma
 * (NODE_INTERFACE → Post transactions). That collapses what used to be two
 * objects joined by a mempool `batchId`, and with them the window in which a post
 * could exist without its lock.
 *
 * ⛔ **The post id is derived from the transaction, so the ORDER here is
 * load-bearing**: the transaction is validated first, its `TxId` names the post,
 * and only then can the post be stored. Nothing can name the post earlier —
 * `computePostId` takes no `Post`.
 *
 * Broadcasting is handled by the route layer (follows the same pattern as
 * invites and likes services).
 */
export function createPost(
  deps: PostServiceDeps,
  tx: UtxoTransaction,
): PostCreateResult {
  const currentHeight = deps.getCurrentHeight();

  const post = tx.post;
  if (!post) {
    throw new PostServiceError('transaction carries no post payload');
  }

  // ---- Verify the post payload (domains, content, parents, karma) ----
  const verifierDeps: VerifierDeps = {
    getKarmaBoxes: deps.getKarmaBoxes,
    getPost: deps.getPost,
  };
  const result = deps.verifyPost(verifierDeps, post);
  if (!result.valid) {
    throw new PostServiceError(result.error ?? 'validation failed');
  }

  // ---- Validate the transaction ----
  //
  // This is where the post lock is actually enforced: the engine's post
  // biconditional — `post` present ⟺ exactly one PostLockBox of
  // POST_LOCK_{THREAD,REPLY}_COST, value conserved — plus signature and
  // conservation checks over the whole transaction.
  const txResult = deps.validateTx(tx, currentHeight);
  if (!txResult.valid) {
    throw new PostServiceError(txResult.error ?? 'invalid post transaction');
  }
  const txId = txResult.txId;
  if (!txId) {
    throw new PostServiceError('transaction validation returned no txId');
  }

  // ---- Bind the payload's author to the karma being spent ----
  //
  // The engine binds every karma input to one owner, but it does not know that
  // `post.author` is meant to be that owner — the payload is opaque to it. Without
  // this, one identity could publish a post attributed to another while paying
  // from its own karma, and authorship is what prune and the feed key on.
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
  if (!Buffer.from(post.author).equals(Buffer.from(karmaOwner))) {
    throw new PostServiceError('post transaction does not belong to post author');
  }

  // ---- Name the post from its creating transaction ----
  //
  // `index` is 0 because exactly one post rides one transaction. It is passed
  // rather than assumed so the rule stays stated (TYPES_INTERFACE → Hashing
  // functions).
  const postId = computePostId(txId, 0);

  // ---- Store the post, then the single mempool entry ----
  const rawCbor = deps.encodePost(post);
  deps.insertPost(postId, post, rawCbor);

  const expiresAtHeight = currentHeight + MEMPOOL_EXPIRY_BLOCKS;
  deps.admitTx(tx, expiresAtHeight);

  return {
    postId,
    status: 'pending',
    expiresAtHeight,
    txId,
    tx,
  };
}
