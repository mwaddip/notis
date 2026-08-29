import {
  POST_PRICE_THREAD,
  POST_PRICE_REPLY,
} from '@dagsocial/types';
import type { PostCommit, Stump } from '@dagsocial/types';
import type { StoredPost, PrunedTombstone } from '../store/posts.js';
import {
  verifyParentRefsCount,
  verifyProtocolVersion,
  verifyPostCommitDomains,
} from '@dagsocial/validation';
import { effectiveKarma } from './decay.js';
import type { DecayCfg } from './decay.js';
import type { IdentityRecord } from '../store/identity-records.js';

// ---------------------------------------------------------------------------
// Dependency interface
// ---------------------------------------------------------------------------

export interface VerifierDeps {
  getKarmaBoxes: (owner: Uint8Array) => { value: bigint; id?: string }[];
  getIdentityRecord: (owner: Uint8Array) => IdentityRecord | null;
  currentHeight: number;
  decayCfg: DecayCfg;
  getPost: (id: string) => StoredPost | Stump | PrunedTombstone | null;
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
 * Verify a post commit against protocol rules.
 *
 * Content checks (`verifyPostBody`) are NOT here — they belong at every body
 * entry point (packet, pull, POST /posts), not in the commit path
 * (NODE_INTERFACE → Invariants).
 */
export function verifyPost(
  deps: VerifierDeps,
  commit: PostCommit,
): VerificationResult {
  // 0. Commit field domains — the precondition for `postFieldBytes`.
  const domains = verifyPostCommitDomains(commit);
  if (!domains.valid) return domains;

  // 1. Parent refs: 0–1.
  const refs = verifyParentRefsCount(commit.parentRefs);
  if (!refs.valid) return refs;

  // 2. Protocol version.
  if (!verifyProtocolVersion(commit.protocolVersion)) {
    return { valid: false, error: 'Unsupported protocol version' };
  }

  // 3. Karma: author must have sufficient EFFECTIVE karma.
  const karmaBoxes = deps.getKarmaBoxes(commit.author);
  if (karmaBoxes.length === 0) {
    return { valid: false, error: 'No karma box found' };
  }
  const faceTotal = karmaBoxes.reduce((sum, b) => sum + b.value, 0n);
  const record = deps.getIdentityRecord(commit.author);
  const available = effectiveKarma(faceTotal, record, deps.currentHeight, deps.decayCfg);
  const requiredKarma =
    commit.parentRefs.length === 0 ? POST_PRICE_THREAD : POST_PRICE_REPLY;
  if (available < requiredKarma) {
    return {
      valid: false,
      error: `Insufficient karma: need ${requiredKarma} (have ${available})`,
    };
  }

  // 4. Parent refs: a live post or a stump resolves; a tombstone or null does not.
  for (const parentId of commit.parentRefs) {
    const parent = deps.getPost(parentId);
    if (parent === null || (parent !== null && 'kind' in parent && parent.kind === 'pruned')) {
      return { valid: false, error: `Parent post not found: ${parentId}` };
    }
  }

  return { valid: true };
}
