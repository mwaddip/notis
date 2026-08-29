// Membership bar — TYPES_INTERFACE → Membership; ARCHITECTURE → Membership.

import { MEMBER_LIKES_MULTIPLIER } from './constants.js';

/**
 * Integer cube root — the largest `r` with `r³ ≤ n`.
 *
 * `n` must be a non-negative safe integer; anything else throws. Integer
 * arithmetic throughout — no `Math.cbrt`, no `**` on floats, no float in
 * the path.
 *
 * TYPES_INTERFACE → Membership.
 */
export function icbrt(n: number): number {
  if (!Number.isInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('icbrt: n must be a non-negative safe integer');
  }
  if (n <= 1) return n;

  // 208063³ < MAX_SAFE_INTEGER < 208064³, so every candidate and every
  // mid³ in the search is exact as a JavaScript number.
  let lo = 1;
  let hi = Math.min(n, 208063);

  while (lo < hi) {
    const mid = lo + ((hi - lo + 1) >> 1);
    if (mid * mid * mid <= n) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  return lo;
}

/**
 * `D(N) = max(1, icbrt(k · N))` — the vouch bar a newcomer must clear.
 *
 * TYPES_INTERFACE → Membership; ARCHITECTURE → Membership.
 */
export function membershipBar(memberCount: number, multiplier: number): number {
  if (!Number.isInteger(memberCount) || memberCount < 0 || memberCount > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('membershipBar: memberCount must be a non-negative safe integer');
  }
  if (!Number.isInteger(multiplier) || multiplier < 0 || multiplier > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('membershipBar: multiplier must be a non-negative safe integer');
  }
  if (multiplier > 0 && memberCount > Math.floor(Number.MAX_SAFE_INTEGER / multiplier)) {
    throw new RangeError('membershipBar: k · N exceeds Number.MAX_SAFE_INTEGER');
  }
  return Math.max(1, icbrt(memberCount * multiplier));
}

/**
 * `Y(N) = MEMBER_LIKES_MULTIPLIER · D(N)` — the likes bar a newcomer
 * must clear beside the vouches.
 *
 * TYPES_INTERFACE → Membership; ARCHITECTURE → Membership.
 */
export function memberLikesBar(memberCount: number, multiplier: number): number {
  if (!Number.isInteger(memberCount) || memberCount < 0 || memberCount > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('memberLikesBar: memberCount must be a non-negative safe integer');
  }
  if (!Number.isInteger(multiplier) || multiplier < 0 || multiplier > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('memberLikesBar: multiplier must be a non-negative safe integer');
  }
  return MEMBER_LIKES_MULTIPLIER * membershipBar(memberCount, multiplier);
}
