import type { UtxoTransaction } from '@dagsocial/types';
import {
  getTopologyHeight,
  getPost,
  isLivePost,
} from '../store/index.js';
import { ClientError } from './client-error.js';
import { validateTx } from '@dagsocial/consensus';
import type { UtxoEngineDeps } from '@dagsocial/consensus';
import { admitWriteTx } from './admit-tx.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate the withdrawal-specific rules, run `validateTx` + `admitTx`, and
 * insert the transaction into the mempool.
 *
 * The maturity check matches the consensus rule: `getTopologyHeight(postId)`
 * must be strictly less than the current height — the post was confirmed in an
 * earlier block.
 */
export function executePostWithdraw(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): { txId: string; expiresAtHeight: number; tx: UtxoTransaction } {
  // NODE_INTERFACE → Service Layer Architecture → "A write request runs in
  // one order, cheapest first", → "One function admits". The pool's word on
  // the id leads; the caller's checks ride inside `admitWriteTx` so a held
  // transaction never reaches them (MEMPOOL_INTERFACE → getHeldEntry).
  const r = admitWriteTx(
    () => {
      const pw = tx.postWithdraw;
      if (!pw) {
        throw new ClientError('Transaction carries no postWithdraw payload');
      }

      // NODE_INTERFACE → Withdrawal, the `POST /posts/:id/withdraw` row's
      // "404 if the post is unknown": an id the node has never heard of
      // answers 404 before any topology read.
      const post = getPost(pw.postId);
      if (!post) {
        throw new ClientError('Post not found', 404);
      }

      // The maturity bind judges at the withdrawal's block — the same
      // judged-for height validateTx uses, one rule (NODE_INTERFACE →
      // validateTx). The route passes tip + 1.
      const postHeight = getTopologyHeight(pw.postId);
      if (postHeight === null || postHeight >= currentBlockHeight) {
        throw new ClientError('Post is not confirmed in an earlier block');
      }

      if (!isLivePost(post)) {
        throw new ClientError('Post is already withdrawn');
      }
    },
    (t, h) => validateTx(deps, t, h),
    tx,
    currentBlockHeight,
    'Invalid postWithdraw transaction: ',
  );
  return { txId: r.txId, expiresAtHeight: r.expiresAtHeight, tx: r.tx };
}
