import type { DecayCfg, Scenario } from './decay-timeline.js';

/**
 * The timelines the golden decay fixtures are captured from.
 *
 * Split into two groups on purpose:
 *
 *  - **`EQUIVALENT_SCENARIOS`** — the equivalence gate. Every one of these must
 *    reproduce its frozen capture byte-for-byte. They cover the ledger shape
 *    production is actually in: forced karma consolidation leaves at most one
 *    karma box per owner, so "oldest non-decay box" and "last activity" are the
 *    same number and no clock design can tell them apart.
 *
 *  - **`DIVERGENT_SCENARIOS`** — a multi-box shape where those two readings
 *    part company, captured so the difference is on the record rather than
 *    missing. See `decay-divergence.test.ts`.
 *
 * All heights and amounts are chosen so every arithmetic step is checkable by
 * hand; nothing here samples a clock or a random source.
 */

/**
 * Compressed config — the one `decay-full-pipeline.test.ts` runs the real nodes
 * under. Small enough that every burn is verifiable by inspection.
 */
export const FAST: DecayCfg = {
  staleThresholdBlocks: 10,
  decayIntervalBlocks: 3,
  decayAmount: 5n,
  karmaMinimum: 10n,
};

/**
 * Production-scale constants, frozen as literals on purpose.
 *
 * ⚠ **A frozen output demands frozen inputs.** These fixtures pin what the
 * decay path produces, so reading the live constants here would pin the
 * outputs while letting the inputs float: a units correction elsewhere then
 * breaks the capture with no behaviour having changed, and the break reads as
 * a decay regression.
 *
 * All four fields are frozen, not only the ones that have moved. Every one of
 * them is an input of the frozen outputs, and a field that happens to equal the
 * live constant today is equal by luck rather than by construction.
 */
export const PROD: DecayCfg = {
  staleThresholdBlocks: 20160,
  decayIntervalBlocks: 720,
  decayAmount: 5n,
  karmaMinimum: 10n,
};

export const EQUIVALENT_SCENARIOS: Scenario[] = [
  {
    // Nothing fires below the threshold. Pins the guard against
    // `currentHeight − threshold` going negative, which would make every box
    // look recent.
    name: 'no-decay-below-threshold',
    cfg: FAST,
    owners: ['alice'],
    steps: [
      { at: 1, op: 'mint', owner: 'alice', amount: 100n },
      { at: 1, op: 'decay' },
      { at: 5, op: 'decay' },
      { at: 10, op: 'decay' },
    ],
  },
  {
    // The staleness boundary, at exactly `height − lastActivity === threshold`.
    // The single height where a `>` and a `>=` comparison disagree, so this is
    // what pins which one the ledger uses.
    name: 'staleness-boundary-exactly-at-threshold',
    cfg: FAST,
    owners: ['alice'],
    steps: [
      { at: 1, op: 'mint', owner: 'alice', amount: 100n },
      { at: 11, op: 'decay' },
      { at: 12, op: 'decay' },
    ],
  },
  {
    // An activity height of 0 at exactly the threshold height. Unreachable for
    // a box today (every producer clamps to ≥ 1), but it is the value a
    // never-active identity's clock reads, so the guard has to hold there.
    name: 'zero-activity-height-at-threshold',
    cfg: FAST,
    owners: ['alice'],
    steps: [
      { at: 0, op: 'seed', owner: 'alice', amount: 100n, tag: 'origin' },
      { at: 10, op: 'decay' },
      { at: 11, op: 'decay' },
    ],
  },
  {
    // Decay twice, then a third time. The **only** path that exercises the
    // `max(lastActivityBlock, lastDecayBlock)` fallback: after the first firing
    // the owner's one karma box is the decay-burn box, whose height is exactly
    // `lastDecayBlock`, and reading `lastActivityBlock` alone would charge from
    // the original activity and over-burn.
    name: 'decay-twice-then-thrice',
    cfg: FAST,
    owners: ['alice'],
    steps: [
      { at: 1, op: 'mint', owner: 'alice', amount: 100n },
      { at: 20, op: 'decay' },
      { at: 26, op: 'decay' },
      { at: 32, op: 'decay' },
    ],
  },
  {
    // Activity after a decay resets the clock, and the next decay charges from
    // the activity rather than from the older decay.
    name: 'activity-resets-clock-after-decay',
    cfg: FAST,
    owners: ['alice'],
    steps: [
      { at: 1, op: 'mint', owner: 'alice', amount: 100n },
      { at: 20, op: 'decay' },
      { at: 22, op: 'mint', owner: 'alice', amount: 10n },
      { at: 30, op: 'decay' },
      { at: 40, op: 'decay' },
    ],
  },
  {
    // The harness fabricates a karma mint at the same height decay fires;
    // production reaches the same adjacency via like settlement landing at a
    // decay height. The two record writes (`lastActivityBlock` from the mint's
    // `bumpActivityClock`, `lastDecayBlock` from `commitDecayClocks`) target
    // one key and must collapse correctly.
    name: 'decay-then-mint-same-block',
    cfg: FAST,
    owners: ['alice'],
    steps: [
      { at: 1, op: 'mint', owner: 'alice', amount: 100n },
      { at: 20, op: 'decay' },
      { at: 20, op: 'mint', owner: 'alice', amount: 10n },
      { at: 25, op: 'decay' },
      { at: 35, op: 'decay' },
    ],
  },
  {
    // The burn is capped so the balance never crosses the minimum, and a
    // subsequent firing at the floor produces no event at all.
    name: 'burn-capped-at-minimum-floor',
    cfg: FAST,
    owners: ['alice'],
    steps: [
      { at: 1, op: 'mint', owner: 'alice', amount: 12n },
      { at: 20, op: 'decay' },
      { at: 40, op: 'decay' },
    ],
  },
  {
    // Already below the floor: stale, owed periods, and still no burn.
    name: 'below-minimum-never-burns',
    cfg: FAST,
    owners: ['alice'],
    steps: [
      { at: 1, op: 'mint', owner: 'alice', amount: 8n },
      { at: 20, op: 'decay' },
      { at: 40, op: 'decay' },
    ],
  },
  {
    // Two owners on independent clocks, interleaved in one timeline: one goes
    // stale while the other is still active, then both decay from different
    // origins in the same block.
    name: 'two-owners-independent-clocks',
    cfg: FAST,
    owners: ['alice', 'bob'],
    steps: [
      { at: 1, op: 'mint', owner: 'alice', amount: 100n },
      { at: 1, op: 'mint', owner: 'bob', amount: 100n },
      { at: 15, op: 'mint', owner: 'bob', amount: 5n },
      { at: 20, op: 'decay' },
      { at: 30, op: 'decay' },
    ],
  },
  {
    // One timeline at capture-time production constants (see PROD), so the
    // fixtures are not entirely a compressed-config artifact.
    name: 'production-constants',
    cfg: PROD,
    owners: ['alice'],
    steps: [
      { at: 1, op: 'mint', owner: 'alice', amount: 1000n },
      { at: 20161, op: 'decay' },
      { at: 20881, op: 'decay' },
      { at: 22321, op: 'decay' },
    ],
  },
];

export const DIVERGENT_SCENARIOS: Scenario[] = [
  {
    // Two non-decay karma boxes at different heights for one owner.
    //
    // Reachable: settlement karma outputs do not consolidate — an invite grant
    // and a later like payout to the same owner both land beside existing
    // holdings (NODE_INTERFACE → The settlement transaction, no-consolidation
    // rule). Neither spends what the recipient already holds, so both survive.
    //
    // This is the shape where "oldest non-decay box" and "newest activity" are
    // different numbers, so a clock kept on the boxes and a clock kept on the
    // record answer differently. The committed record reads the newest. That is
    // a behavioural choice, so it is captured rather than assumed away.
    name: 'two-non-decay-boxes-at-different-heights',
    cfg: FAST,
    owners: ['alice'],
    steps: [
      { at: 1, op: 'seed', owner: 'alice', amount: 50n, tag: 'first-grant' },
      { at: 10, op: 'seed', owner: 'alice', amount: 50n, tag: 'second-grant' },
      { at: 30, op: 'decay' },
    ],
  },
];
