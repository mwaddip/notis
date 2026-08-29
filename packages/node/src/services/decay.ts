import type { KarmaBox } from '@dagsocial/types';
// Type-only: the decay service reaches the record through injected deps, never
// through the store module directly.
import type { IdentityRecord } from '../store/identity-records.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The clock of an identity that has no record at all.
 *
 * Every karma producer now writes one — the journaled paths through
 * `insertBox`'s choke point, and genesis explicitly (`ensureSystemKarmaBox`) —
 * so an owner holding karma with no record should be unreachable. It is still a
 * total function's job to say what happens if one appears, and "never observed
 * active" is the honest reading: maximally stale, decaying from height 0.
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
 * Is this identity stale — no normal activity within the threshold window?
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
 * original activity on every subsequent cycle. This is the same fallback the
 * box-reading version expressed as "use the youngest box when all boxes are
 * decay-burn".
 *
 * No clamp at zero: `deriveKarmaDecay` skips anything
 * `<= 0`, and swallowing a negative here would hide a clock that had somehow
 * run ahead of the chain.
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

// ---------------------------------------------------------------------------
// The valuation function — one implementation (VALIDATION_INTERFACE → "One
// implementation per rule"). The engine, the verifier and the demo UI all
// call this; an inline copy anywhere is the mirror defect class.
// ---------------------------------------------------------------------------

export interface DecayCfg {
  staleThresholdBlocks: number;
  decayIntervalBlocks: number;
  decayAmount: bigint;
  karmaMinimum: bigint;
}

/**
 * Effective karma: the face total reduced by virtual decay.
 *
 *     effective = clamp(faceTotal − owedPeriods · decayAmount)
 *
 * Clamped so effective never drops below `min(faceTotal, KARMA_MINIMUM)`:
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

// ---------------------------------------------------------------------------
// Decay execution
// ---------------------------------------------------------------------------

export interface DecayDeps {
  getKarmaBoxes: (owner: Uint8Array) => KarmaBox[];
  /** The identity's decay clock, or null if it has never held karma. */
  getIdentityRecord: (identityId: Uint8Array) => IdentityRecord | null;
  /** Write the clock back. Journals at the store choke point. */
  putIdentityRecord: (identityId: Uint8Array, record: IdentityRecord) => void;
}

/**
 * One identity's decay, as a plan rather than as a mutation.
 *
 * ⛔ **Decay moves no boxes any more.** Its burn's sink is the karma supply
 * pool, and the pool is spent by the block's settlement transaction and by
 * nothing else (NODE_INTERFACE → The settlement transaction) — so the boxes
 * this describes are consumed and re-emitted there, in one operation that names
 * both ends. Charging an owner here and crediting the pool later would be a burn
 * and a mint separated by steps, which `ARCHITECTURE → The conservation axiom`
 * forbids by name.
 *
 * ⚠ The trigger is touch: the squaring fires per identity when the block
 * body consumes their boxes. There is no per-block walk.
 */
export interface DecayPlan {
  owner: Uint8Array;
  /** Every karma box the owner holds — the settlement's inputs for this leg. */
  consumedBoxIds: string[];
  /** What the owner is left holding. */
  newValue: bigint;
  /** What returns to the pool. */
  burnAmount: bigint;
}

/**
 * Derive the decay owed by each TOUCHED identity at `currentHeight`.
 *
 * ⛔ **Pure with respect to the ledger: it reads and returns, and writes
 * nothing.** The settlement emits its boxes and `commitDecayClocks` advances the
 * clocks, so a block whose settlement is refused has not moved a decay clock
 * either.
 *
 * `postBodyKarma` is the post-body karma projection — for each identity the
 * block's body touched, the karma boxes they hold AFTER the body's user
 * transactions but BEFORE the settlement. The caller provides entries in
 * ascending owner-hex order (ARCHITECTURE → Karma decay). The identity record
 * is read from pre-body state (user transactions do not write it).
 */
export function deriveKarmaDecay(
  deps: DecayDeps,
  postBodyKarma: Map<string, { owner: Uint8Array; boxes: KarmaBox[] }>,
  currentHeight: number,
  cfg: DecayCfg,
): DecayPlan[] {
  const plans: DecayPlan[] = [];

  for (const [, { owner, boxes }] of postBodyKarma) {
    if (boxes.length === 0) continue;

    const record = deps.getIdentityRecord(owner);

    if (!isIdentityStale(record, currentHeight, cfg.staleThresholdBlocks)) {
      continue;
    }

    const periods = owedPeriods(record, currentHeight, cfg.decayIntervalBlocks);
    if (periods <= 0) continue;

    const faceTotal = boxes.reduce((sum, b) => sum + b.value, 0n);
    const effective = effectiveKarma(faceTotal, record, currentHeight, cfg);
    const burnAmount = faceTotal - effective;
    if (burnAmount <= 0n) continue;

    plans.push({
      owner,
      consumedBoxIds: boxes.filter((b) => b.id).map((b) => b.id!),
      newValue: effective,
      burnAmount,
    });
  }

  return plans;
}

/**
 * Advance the decay half of the clock for every identity the settlement charged.
 *
 * Written **after** the settlement's boxes are in, so the journal's reverse
 * replay undoes the record before deleting the box that caused it. Only firings
 * reach here — a stale identity sitting at the karma floor produces no plan and
 * keeps its clock where it was, rather than silently forfeiting the intervals it
 * is owed.
 *
 * `lastActivityBlock` is carried through unchanged: the decay-burn box the
 * settlement emitted is deliberately *not* activity, and resetting the activity
 * half here would make an identity look freshly active every time it was
 * charged. `invitedAtBlock` the same — block application's grant path owns it,
 * and a decay that reset it would both un-bar the address and move the paired
 * bond's settlement deadline. `lifetimeLikesReceived` too: it is monotonic, and
 * a decay that reset it would forfeit a bond the invitee had earned.
 */
export function commitDecayClocks(
  deps: DecayDeps,
  plans: DecayPlan[],
  currentHeight: number,
): void {
  for (const plan of plans) {
    const record = deps.getIdentityRecord(plan.owner);
    deps.putIdentityRecord(plan.owner, {
      lastActivityBlock: record?.lastActivityBlock ?? 0,
      lastDecayBlock: currentHeight,
      invitedAtBlock: record?.invitedAtBlock ?? 0,
      lifetimeLikesReceived: record?.lifetimeLikesReceived ?? 0n,
      memberSinceBlock: record?.memberSinceBlock ?? 0,
      memberBar: record?.memberBar ?? 0,
      memberVouches: record?.memberVouches ?? 0,
      memberLikes: record?.memberLikes ?? 0n,
      invitesUsed: record?.invitesUsed ?? 0,
    });
  }
}
