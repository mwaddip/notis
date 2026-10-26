import type { UtxoTransaction } from '@dagsocial/types';
import { isHex64 } from '@dagsocial/types';
import {
  getPost,
  isLivePost,
  hasLikeRecord,
} from '../store/index.js';
import { validateTx } from '@dagsocial/consensus';
import { admitWriteTx } from './admit-tx.js';
import type { UtxoEngineDeps } from '@dagsocial/consensus';
import { ClientError } from './client-error.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Cast a like on a target post (NODE_INTERFACE → Likes).
 *
 * Receives a pre-built, signed UtxoTransaction from the client with
 * `likeTarget` set. The engine enforces the biconditional like shape — karma
 * inputs with one owner, at most one karma output with that same owner, and
 * one `LikeAccrualBox` carrying exactly `LIKE_KARMA_COST` to the target's
 * author. The transaction conserves. There is no free tier, no refund
 * schedule, and no unlike: one like per `(liker, post)`, forever.
 *
 * These gateway checks are courtesy; the consensus checks run again at block
 * application. The liker is the karma inputs' owner — no separate liker field
 * exists anywhere.
 *
 * Dedup matches apply since N4a: `hasLikeRecord` reads the same
 * like-record the consensus dedup checks at block application, and
 * `hasPendingLike` covers the mempool. A re-like of an already-recorded
 * `(liker, post)` is rejected here, not just at apply.
 *
 * @returns `{ castLikeResult: 'pending', txId, expiresAtHeight, tx }`
 */
export function castLike(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): { castLikeResult: 'pending'; txId: string; expiresAtHeight: number; tx: UtxoTransaction } {
  // NODE_INTERFACE → Service Layer Architecture → "A write request runs in
  // one order, cheapest first", → "One function admits". The pool's word on
  // the id leads; the caller's checks ride inside `admitWriteTx` so a held
  // transaction never reaches them (MEMPOOL_INTERFACE → getHeldEntry).
  const r = admitWriteTx(
    () => {
      // ---- 1. Extract and validate likeTarget ----
      const likeTarget = tx.likeTarget;
      if (!isHex64(likeTarget)) {
        throw new ClientError(
          'likeTarget missing or malformed: expected a 64-char hex post id',
        );
      }

      // ---- 2. Verify the target post exists and is live ----
      const post = getPost(likeTarget);
      if (!post) {
        throw new ClientError(`Post not found: ${likeTarget}`);
      }
      // NODE_INTERFACE → Karma transition rules: a like targets a live post only.
      if (!isLivePost(post)) {
        throw new ClientError('Cannot like a withdrawn post');
      }

      // ---- 3. Verify not already liked at the confirmed state ----
      // The liker is the karma inputs' owner, which for a well-formed like
      // tx is the single signing key — enforced here so the mempool gate's
      // single-key derivation (`like_liker`) is exact for every entry this
      // path inserts, and so a spare signature cannot pin someone else's
      // `(liker, target)` pair. The pending-like gate rides admission
      // (MEMPOOL_INTERFACE → Correctness gates); the confirmed check stays
      // here.
      const signerHexes = Object.keys(tx.signatures);
      if (signerHexes.length !== 1) {
        throw new ClientError(
          'A like transaction must carry exactly one signature (the liker)',
        );
      }
      const likerHex = signerHexes[0]!;
      if (hasLikeRecord(likeTarget, Buffer.from(likerHex, 'hex'))) {
        throw new ClientError('Already liked this post');
      }
    },
    (t, h) => validateTx(deps, t, h),
    tx,
    currentBlockHeight,
    'Invalid like transaction: ',
  );

  return {
    castLikeResult: 'pending',
    txId: r.txId,
    expiresAtHeight: r.expiresAtHeight,
    tx: r.tx,
  };
}
