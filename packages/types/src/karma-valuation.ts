/**
 * The karma valuation — one implementation of the effective-balance
 * function shared by the node and the light client (TYPES_INTERFACE →
 * Identity record and karma valuation; VALIDATION_INTERFACE → "One
 * implementation per rule"). The engine and the verifier call this; an
 * inline copy anywhere is the mirror defect class.
 *
 * Face values move only when a block's settlement touches the identity
 * (NODE_INTERFACE → Karma decay holds the rule and its derivation;
 * ARCHITECTURE → Karma decay the model).
 */

import { KARMA_DECAY_AMOUNT, KARMA_MINIMUM } from './constants.js';
import type { NetworkProfile } from './network.js';
import type { IdentityRecord } from './identity-record.js';

/**
 * The clock of an identity that has no record at all.
 *
 * Every path that puts karma in a key's hands writes one — the invite grant,
 * and genesis explicitly (NODE_INTERFACE → Bond transition rules) — so an
 * owner holding karma with no record should be unreachable. It is still a
 * total function's job to say what happens if one appears, and "never
 * observed active" is the honest reading: maximally stale, decaying from
 * height 0.
 *
 * The alternative — skipping record-less owners — is the more dangerous
 * failure: it exempts an identity from decay permanently, and does so silently.
 * Over-charging by a fraction of an interval is recoverable; a karma balance
 * that can never decay is an economic hole.
 */
const NEVER_ACTIVE: IdentityRecord = {
  lastActivityBlock: 0,
  lastDecayBlock: 0,
  invitedAtBlock: 0,
  lifetimeLikesReceived: 0n,
  memberSinceBlock: 0,
  memberBar: 0,
  memberVouches: 0,
  memberLikes: 0n,
  invitesUsed: 0,
};

/**
 * The four numbers the valuation reads — the two per-network timescales from
 * the profile and the two universal economics constants.
 */
export interface DecayCfg {
  staleThresholdBlocks: number;
  decayIntervalBlocks: number;
  decayAmount: bigint;
  karmaMinimum: bigint;
}

/**
 * The one derivation of `DecayCfg` from a network profile.
 *
 * `KARMA_DECAY_AMOUNT` and `KARMA_MINIMUM` are universal economics, so they
 * come from the constants; the two block-denominated timescales are
 * per-network and come from the profile. A caller that hand-builds a cfg is
 * a second derivation and drift risk — the node and the client both take
 * their cfg through this function.
 */
export function decayCfgFor(profile: NetworkProfile): DecayCfg {
  return {
    staleThresholdBlocks: profile.karmaStaleThresholdBlocks,
    decayIntervalBlocks: profile.karmaDecayIntervalBlocks,
    decayAmount: KARMA_DECAY_AMOUNT,
    karmaMinimum: KARMA_MINIMUM,
  };
}

/**
 * Is this identity stale — no post within the threshold window?
 *
 *     stale = (height − lastActivityBlock) >= staleThresholdBlocks
 *
 * **`>=`, not `>`.** An identity last active at `A` has gone `height − A`
 * blocks without activity, so it is stale iff `A <= height − threshold`, i.e.
 * `height − A >= threshold`. A `>` here delays every identity's first decay by
 * exactly one block.
 *
 * The `currentHeight <= thresholdBlocks` guard is **not** subsumed by that
 * formula. With `A >= 1` the subtraction cannot reach the threshold below it,
 * but `lastActivityBlock` is 0 for a never-active identity and `0 − 0 >=
 * threshold` holds at exactly `height === threshold` — early by one interval
 * for an identity that has never done anything. The guard is what excludes it.
 */
export function isIdentityStale(
  record: IdentityRecord | null,
  currentHeight: number,
  thresholdBlocks: number,
): boolean {
  if (currentHeight <= thresholdBlocks) return false;
  const clock = record ?? NEVER_ACTIVE;
  return currentHeight - clock.lastActivityBlock >= thresholdBlocks;
}

/**
 * How many decay periods have elapsed since this identity's clock last moved?
 *
 *     owedPeriods = floor( (height − max(lastActivityBlock, lastDecayBlock)) / interval )
 *
 * The `max` is not decoration. After a decay fires, the owner's only karma box
 * is the decay-burn box, and its height is exactly `lastDecayBlock`; charging
 * from `lastActivityBlock` alone would re-bill every interval since the
 * original activity on every subsequent cycle.
 *
 * No clamp at zero: the caller skips anything `<= 0`, and swallowing a
 * negative here would hide a clock that had somehow run ahead of the chain.
 */
export function owedPeriods(
  record: IdentityRecord | null,
  currentHeight: number,
  intervalBlocks: number,
): number {
  const clock = record ?? NEVER_ACTIVE;
  const clockStart = Math.max(clock.lastActivityBlock, clock.lastDecayBlock);
  return Math.floor((currentHeight - clockStart) / intervalBlocks);
}

/**
 * Effective karma: the face total reduced by virtual decay.
 *
 *     effective = clamp(faceTotal − owedPeriods · decayAmount)
 *
 * Clamped so effective never drops below `min(faceTotal, karmaMinimum)`:
 * an identity holding less than the minimum never decays below what it
 * has, and one holding more never decays below the minimum.
 */
export function effectiveKarma(
  faceTotal: bigint,
  record: IdentityRecord | null,
  height: number,
  cfg: DecayCfg,
): bigint {
  if (!isIdentityStale(record, height, cfg.staleThresholdBlocks)) {
    return faceTotal;
  }
  const periods = owedPeriods(record, height, cfg.decayIntervalBlocks);
  if (periods <= 0) return faceTotal;

  const owed = BigInt(periods) * cfg.decayAmount;
  const floor = faceTotal < cfg.karmaMinimum ? faceTotal : cfg.karmaMinimum;
  const decayed = faceTotal - owed;
  return decayed > floor ? decayed : floor;
}
