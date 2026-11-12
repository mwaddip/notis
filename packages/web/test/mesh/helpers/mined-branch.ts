// A branch that mines on top of a prefix of an existing mined chain:
// the first `fromHeight` blocks are the base chain's (shared by hash),
// and the block at `fromHeight + 1` is forced to a level the default
// mining is overwhelmingly unlikely to hit, so its nonce — and so its
// hash — differs from the base's block at that height, and the branch
// diverges there. `buildMinedBranch(base, { fromHeight: F, count: N })`
// and `buildMinedBranch(base, { fromHeight: F', count: N })` with
// `F !== F'` share only the first `min(F, F')` blocks and so have
// different `forkKey`s against any third chain that diverges elsewhere.
//
// Implemented over `@dagsocial/nipopow`'s `buildMinedChain` memo:
// different `forceLevels` keys the memo fresh, deterministic mining
// gives identical blocks 1..F with the base, `solveForLevel(10)` at
// `F + 1` forces a nonce that (with overwhelming probability — devnet
// power targets meet `level >= 10` at roughly 2^-10 of nonces) is not
// the default mining's nonce, and every block after rides the forced
// one's hash.

import { buildMinedChain } from '../../../../nipopow/test/helpers.js';
import type { MinedChain } from '../../../../nipopow/test/helpers.js';

export function buildMinedBranch(opts: {
  /** The chain the branch forks from. Must have been built without
   *  `forceLevels` at `fromHeight + 1` (default mining there), so the
   *  fork actually diverges. */
  base: MinedChain;
  /** The last block shared with the base — blocks 1..fromHeight have
   *  the same hash across both chains; block fromHeight + 1 is the
   *  forked block. */
  fromHeight: number;
  /** The branch's total length. Must exceed `fromHeight`. */
  count: number;
  /** Forwarded to `buildMinedChain`; keep it equal to the base's so
   *  blocks 1..fromHeight match. Default: the retarget's ideal. */
  stampIntervalMs?: number;
}): MinedChain {
  if (opts.fromHeight < 1) {
    throw new Error(`buildMinedBranch: fromHeight must be >= 1, got ${opts.fromHeight}`);
  }
  if (opts.count <= opts.fromHeight) {
    throw new Error(`buildMinedBranch: count ${opts.count} must exceed fromHeight ${opts.fromHeight}`);
  }
  if (opts.fromHeight >= opts.base.headers.length) {
    throw new Error(
      `buildMinedBranch: fromHeight ${opts.fromHeight} must be inside the base chain of length ${opts.base.headers.length}`,
    );
  }
  const forcedHeight = opts.fromHeight + 1;
  const forceLevels = new Map<number, number>([[forcedHeight, 10]]);
  const built = buildMinedChain({
    count: opts.count,
    forceLevels,
    ...(opts.stampIntervalMs !== undefined ? { stampIntervalMs: opts.stampIntervalMs } : {}),
  });
  // Sanity: blocks 1..fromHeight match the base, block fromHeight+1
  // does not. Fails fast with a message if the default mining at
  // `forcedHeight` happened to meet `level >= 10` and the forced
  // block coincides with the base's.
  for (let i = 0; i < opts.fromHeight; i++) {
    if (built.headers[i] !== opts.base.headers[i]) {
      // Headers are frozen, so equality by reference is fine where
      // both come from the same memo state; the slice may diverge if
      // the base's build used a param the branch's does not inherit.
      if (built.headers[i]!.prevBlockHash !== opts.base.headers[i]!.prevBlockHash
        || built.headers[i]!.powNonce !== opts.base.headers[i]!.powNonce) {
        throw new Error(`buildMinedBranch: block ${i + 1} differs from the base (unexpected)`);
      }
    }
  }
  if (built.headers[opts.fromHeight]!.powNonce === opts.base.headers[opts.fromHeight]!.powNonce) {
    throw new Error(
      `buildMinedBranch: the forced block at ${forcedHeight} has the same nonce as the base — the level=10 hint did not force a divergence`,
    );
  }
  return built;
}
