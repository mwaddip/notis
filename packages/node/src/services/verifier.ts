import {
  PROTOCOL_VERSION,
  MAX_CONTENT_BYTES,
  MAX_PARENT_REFS,
  POST_LOCK_THREAD_COST,
  POST_LOCK_REPLY_COST,
} from '@dagsocial/types';
import type { Post, Stump } from '@dagsocial/types';
import {
  verifyContentCharacters,
  verifyPostFieldDomains,
} from '@dagsocial/validation';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

// Reserved, never to be reused: `ChallengeRecord`. The PoW challenge handshake is
// gone with post PoW.

// ---------------------------------------------------------------------------
// Dependency interface
// ---------------------------------------------------------------------------

export interface VerifierDeps {
  getKarmaBoxes: (owner: Uint8Array) => { value: bigint; id?: string }[];
  /**
   * The store's real signature. Both arms are meaningful here rather than
   * incidental: a parent ref may name a live post OR a stump, and both are
   * valid parents (NODE_INTERFACE → Posts). The call site below uses it as an
   * existence check, so the union needs no narrowing — but an `unknown` here
   * would hide that the stump case is deliberate.
   */
  getPost: (id: string) => Post | Stump | null;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface VerificationResult {
  valid: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// verifyPost
// ---------------------------------------------------------------------------

/**
 * Verify a post payload against protocol rules.
 *
 * ⛔ **There is no signature check and no PoW check here, and adding either back
 * is a defect.** A post is the payload of the transaction that creates it
 * (NODE_INTERFACE → Post transactions): that transaction is signed over its
 * `TxId`, the signing key is the author, and the payload is inside the `TxId`
 * preimage — so authorship is settled by the transaction signature check and a
 * second signature over the same object would be two places for one fact to
 * disagree. Admission is the **stateful** karma lock, which is strictly stronger
 * than proving someone burned a millisecond.
 *
 * ⚠ **A parent ref's id CANNOT be recomputed from the parent post**, and the
 * check that used to do so is gone rather than relaxed. A post id is
 * provenance-derived — `computePostId(txId, index)` takes no `Post` — so the
 * store's recorded id, written when the creating transaction applied, is the only
 * statement of it. Existence is what remains checkable here.
 *
 * Checks are performed in fail-fast order. The caller supplies store functions
 * via `deps` so the verifier can be tested without a real database.
 */
export function verifyPost(
  deps: VerifierDeps,
  post: Post,
): VerificationResult {
  // 0. Field domains — the precondition, not a courtesy of the caller. Under the
  //    positional wire format `author` and every `parentRefs` entry are
  //    fixed-width, and a fixed-width writer has no unreachable sentinel, so it
  //    throws (TYPES_INTERFACE → Totality). The payload reaches `computeTxId`
  //    through `postFieldBytes`, so the domain has to be established before then.
  const domains = verifyPostFieldDomains(post);
  if (!domains.valid) return domains;

  // 1. Content: 1–300 bytes UTF-8. Reject empty.
  const contentBytes = Buffer.byteLength(post.content, 'utf8');
  if (contentBytes === 0) {
    return { valid: false, error: 'Content is empty' };
  }
  if (contentBytes > MAX_CONTENT_BYTES) {
    return { valid: false, error: 'Content exceeds max length' };
  }

  // 1b. Character restrictions: no control, zero-width, or bidi chars.
  const charCheck = verifyContentCharacters(post.content);
  if (!charCheck.valid) return charCheck;

  // 2. Parent refs: 0–8.
  if (post.parentRefs.length > MAX_PARENT_REFS) {
    return { valid: false, error: `Too many parent refs (max ${MAX_PARENT_REFS})` };
  }

  // 3. Protocol version.
  if (post.protocolVersion !== PROTOCOL_VERSION) {
    return { valid: false, error: 'Unsupported protocol version' };
  }

  // 4. Karma: author must have sufficient karma across all boxes.
  //
  //    ⚠ This is an early, friendlier rejection and NOT the enforcement point.
  //    The lock is enforced structurally by the UTXO engine's post biconditional
  //    — `post` present ⟺ exactly one PostLockBox of the right cost, value
  //    conserved — which is what a block re-validates. A sufficiency check here
  //    that disagreed with the engine would reject nothing the engine accepts.
  const karmaBoxes = deps.getKarmaBoxes(post.author);
  if (karmaBoxes.length === 0) {
    return { valid: false, error: 'No karma box found' };
  }
  const totalKarma = karmaBoxes.reduce((sum, b) => sum + b.value, 0n);
  const requiredKarma =
    post.parentRefs.length === 0 ? POST_LOCK_THREAD_COST : POST_LOCK_REPLY_COST;
  if (totalKarma < requiredKarma) {
    return {
      valid: false,
      error: `Insufficient karma: need ${requiredKarma} (have ${totalKarma})`,
    };
  }

  // 5. Parent refs: every referenced post must exist.
  for (const parentId of post.parentRefs) {
    if (!deps.getPost(parentId)) {
      return { valid: false, error: `Parent post not found: ${parentId}` };
    }
  }

  return { valid: true };
}

// Reserved, never to be reused: `verifyPostForRelay`. It was Stage 2 for a post
// gossiped as a sub-block, and its distinguishing feature — skipping the
// node-local challenge — describes a handshake that no longer exists. A post now
// arrives as a transaction and is validated by the transaction path.
