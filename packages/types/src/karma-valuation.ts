/**
 * The karma valuation — one implementation of the effective-balance
 * function the node and the light client both run (TYPES_INTERFACE →
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
import { EMPTY_IDENTITY_RECORD, type IdentityRecord } from './identity-record.js';

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
 * The height decay's clock starts at for a given record:
 *
 *     clockStart = max( lastActivityBlock + staleThresholdBlocks, lastDecayBlock )
 *
 * The `max` holds the two paths together: past the window's end the start is
 * `lastDecayBlock` — the height the last squaring settled through — so
 * counting from the window's end alone would re-bill every period a squaring
 * already settled (TYPES_INTERFACE → Identity record and karma valuation →
 * "The `max` in `clockStart` is not decoration"). A `null` record values as
 * `EMPTY_IDENTITY_RECORD` — its clock starts at `staleThresholdBlocks`
 * (TYPES_INTERFACE → Identity record and karma valuation →
 * "A `null` record values as never active").
 *
 * One statement of the clock, read by `owedPeriods`, `decaySettledThrough`
 * and `effectiveKarma` — a second statement is a drift risk.
 */
function clockStart(record: IdentityRecord | null, cfg: DecayCfg): number {
  const clk = record ?? EMPTY_IDENTITY_RECORD;
  return Math.max(clk.lastActivityBlock + cfg.staleThresholdBlocks, clk.lastDecayBlock);
}

/**
 * How many decay periods have elapsed since the record's `clockStart`:
 *
 *     owedPeriods = floor( (height − clockStart) / decayIntervalBlocks )
 *
 * No clamp at zero — negative or zero through the grace window, and a caller
 * charges nothing at `<= 0`. Swallowing a negative here would hide a clock
 * that had somehow run ahead of the chain
 * (TYPES_INTERFACE → Identity record and karma valuation).
 */
export function owedPeriods(
  record: IdentityRecord | null,
  height: number,
  cfg: DecayCfg,
): number {
  return Math.floor((height - clockStart(record, cfg)) / cfg.decayIntervalBlocks);
}

/**
 * The height a squaring at `height` writes as `lastDecayBlock`:
 *
 *     settledThrough = clockStart + owedPeriods · decayIntervalBlocks
 *
 * The part of a period that has run at `height` stays owed and the next
 * squaring counts it; writing `height` would forgive it
 * (NODE_INTERFACE → Karma decay → "A squaring writes the height it settles
 * through, never its own height"). Read only where `owedPeriods > 0`.
 */
export function decaySettledThrough(
  record: IdentityRecord | null,
  height: number,
  cfg: DecayCfg,
): number {
  const start = clockStart(record, cfg);
  const periods = Math.floor((height - start) / cfg.decayIntervalBlocks);
  return start + periods * cfg.decayIntervalBlocks;
}

/**
 * Effective karma: the face total reduced by virtual decay.
 *
 *     effective = owedPeriods > 0
 *                 ? max( faceTotal − owedPeriods · decayAmount, min(faceTotal, karmaMinimum) )
 *                 : faceTotal
 *
 * `owedPeriods > 0` holds only past the window's end
 * (TYPES_INTERFACE → Identity record and karma valuation →
 * "Decay starts at the grace window's end, from nothing"); the floor
 * `min(faceTotal, karmaMinimum)` holds a face below the minimum where it
 * stands and a face above the minimum down to it.
 */
export function effectiveKarma(
  faceTotal: bigint,
  record: IdentityRecord | null,
  height: number,
  cfg: DecayCfg,
): bigint {
  const periods = owedPeriods(record, height, cfg);
  if (periods <= 0) return faceTotal;

  const owed = BigInt(periods) * cfg.decayAmount;
  const floor = faceTotal < cfg.karmaMinimum ? faceTotal : cfg.karmaMinimum;
  const decayed = faceTotal - owed;
  return decayed > floor ? decayed : floor;
}
