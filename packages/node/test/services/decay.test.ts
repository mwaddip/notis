import { describe, it, expect } from 'vitest';
import { fixtureProvenance } from '../helpers.js';
import {
  isIdentityStale,
  owedPeriods,
  effectiveKarma,
  commitDecayClocks,
  deriveKarmaDecay,
} from '../../src/services/decay.js';
import {
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
} from '@dagsocial/types';
import type { KarmaBox } from '@dagsocial/types';
import type { IdentityRecord } from '../../src/store/identity-records.js';

/**
 * Spec G phase D — the decay clock reads the committed identity record.
 *
 * The predicates took `KarmaBox[]` and read `createdAtBlock`; they now take an
 * `IdentityRecord`. The scenarios below are the same ones, restated on the
 * clock: a box at height H that counted as activity is `lastActivityBlock: H`,
 * and a decay-burn box at height H is `lastDecayBlock: H`. End-to-end
 * equivalence is checked against frozen pre-swap captures in
 * `decay-golden.test.ts`; these are the unit-level statements of the two rules.
 */

const OWNER = new Uint8Array(32).fill(0xaa);

const TEST_CFG = {
  staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
  decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
  decayAmount: KARMA_DECAY_AMOUNT,
  karmaMinimum: KARMA_MINIMUM,
};

function clock(lastActivityBlock: number, lastDecayBlock = 0): IdentityRecord {
  return { lastActivityBlock, lastDecayBlock, invitedAtBlock: 0, lifetimeLikesReceived: 0n };
}

/**
 * The `id` is a readable label, not a derived box id — this suite tests the
 * decay predicate and its arithmetic, never identity, and a random label keeps
 * boxes distinguishable in failure output. Provenance is real because
 * `txId`/`index` are required box fields.
 *
 * The `...overrides` spread is what made the annotation unsatisfiable: spreading
 * a `Partial<KarmaBox>` re-optionalises every key it names, including the two
 * required provenance fields.
 */
function makeKarmaBox(overrides: Partial<KarmaBox> = {}): KarmaBox {
  const candidate = {
    boxType: 'karma' as const,
    value: 100n,
    createdAtBlock: 0,
    owner: OWNER,
  };
  return {
    ...candidate,
    ...fixtureProvenance(candidate, 1),
    id: 'box-' + Math.random().toString(36).slice(2, 8),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isIdentityStale
// ---------------------------------------------------------------------------

describe('isIdentityStale', () => {
  it('returns false for an identity with no record below the threshold height', () => {
    expect(isIdentityStale(null, 1000, KARMA_STALE_THRESHOLD_BLOCKS)).toBe(false);
  });

  it('returns false when activity is within the threshold', () => {
    // current = 100000, age = 1000 — well inside the threshold
    expect(isIdentityStale(clock(99000), 100000, KARMA_STALE_THRESHOLD_BLOCKS)).toBe(false);
  });

  it('returns true when activity is older than the threshold', () => {
    // current = 100000, age = 99000 — beyond the threshold
    expect(isIdentityStale(clock(1000), 100000, KARMA_STALE_THRESHOLD_BLOCKS)).toBe(true);
  });

  it('a recent decay does not count as activity', () => {
    // The decay-burn box the old code excluded is `lastDecayBlock` here: recent,
    // and still not activity. Otherwise one decay would make the identity look
    // fresh and no second cycle could ever fire.
    expect(
      isIdentityStale(clock(1000, 99999), 100000, KARMA_STALE_THRESHOLD_BLOCKS),
    ).toBe(true);
  });

  it('recent activity wins over an old decay', () => {
    expect(
      isIdentityStale(clock(99999, 1000), 100000, KARMA_STALE_THRESHOLD_BLOCKS),
    ).toBe(false);
  });

  it('is stale at exactly the threshold, not one block later', () => {
    // `>=`, not `>`. The predecessor's test was `createdAtBlock > height −
    // threshold`, so an activity height exactly `threshold` blocks back is
    // already stale. The contract's prose said `>` and was off by one.
    expect(isIdentityStale(clock(100), 100 + KARMA_STALE_THRESHOLD_BLOCKS,
      KARMA_STALE_THRESHOLD_BLOCKS)).toBe(true);
    expect(isIdentityStale(clock(100), 99 + KARMA_STALE_THRESHOLD_BLOCKS,
      KARMA_STALE_THRESHOLD_BLOCKS)).toBe(false);
  });

  it('never stale at or below the threshold height', () => {
    // The chain has not existed long enough. Load-bearing for a clock of 0,
    // where the subtraction alone would report stale at exactly `threshold`.
    expect(isIdentityStale(clock(0), KARMA_STALE_THRESHOLD_BLOCKS,
      KARMA_STALE_THRESHOLD_BLOCKS)).toBe(false);
    expect(isIdentityStale(clock(0), KARMA_STALE_THRESHOLD_BLOCKS + 1,
      KARMA_STALE_THRESHOLD_BLOCKS)).toBe(true);
  });

  it('a missing record reads as never-active', () => {
    expect(isIdentityStale(null, 100000, KARMA_STALE_THRESHOLD_BLOCKS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// owedPeriods
// ---------------------------------------------------------------------------

describe('owedPeriods', () => {
  it('returns 0 when the clock is at the current height', () => {
    expect(owedPeriods(clock(1000), 1000, KARMA_DECAY_INTERVAL_BLOCKS)).toBe(0);
  });

  it('counts periods since activity', () => {
    // Three whole intervals since the activity height.
    expect(
      owedPeriods(clock(1000), 1000 + 3 * KARMA_DECAY_INTERVAL_BLOCKS, KARMA_DECAY_INTERVAL_BLOCKS),
    ).toBe(3);
  });

  it('uses the decay height when it is later than the activity height', () => {
    // The `max(...)` fallback: after a decay the only karma box is the
    // decay-burn box, whose height is exactly `lastDecayBlock`.
    // One interval past the decay — not three past the activity.
    const activityAt = 1000;
    const decayAt = activityAt + 2 * KARMA_DECAY_INTERVAL_BLOCKS;
    expect(
      owedPeriods(
        clock(activityAt, decayAt),
        decayAt + KARMA_DECAY_INTERVAL_BLOCKS,
        KARMA_DECAY_INTERVAL_BLOCKS,
      ),
    ).toBe(1);
  });

  it('uses the activity height when it is later than the decay height', () => {
    // The decay sits more than one whole interval before the activity, so
    // reading the decay height instead would change the answer.
    const decayAt = 100;
    const activityAt = decayAt + KARMA_DECAY_INTERVAL_BLOCKS;
    const height = activityAt + 3 * KARMA_DECAY_INTERVAL_BLOCKS;
    expect(owedPeriods(clock(activityAt, decayAt), height, KARMA_DECAY_INTERVAL_BLOCKS)).toBe(3);
    expect(owedPeriods(clock(height - 1, decayAt), height, KARMA_DECAY_INTERVAL_BLOCKS)).toBe(0);
  });

  it('activity and decay at the same height count once', () => {
    // The intra-block adjacency: decay fires, then a vouch settlement mints for
    // the same owner in the same block.
    expect(
      owedPeriods(clock(2000, 2000), 2000 + KARMA_DECAY_INTERVAL_BLOCKS, KARMA_DECAY_INTERVAL_BLOCKS),
    ).toBe(1);
  });

  it('a missing record counts from height 0', () => {
    expect(owedPeriods(null, 2 * KARMA_DECAY_INTERVAL_BLOCKS, KARMA_DECAY_INTERVAL_BLOCKS)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// deriveKarmaDecay
// ---------------------------------------------------------------------------

describe('deriveKarmaDecay', () => {
  function makeDeps(
    boxesMap: Map<string, KarmaBox[]>,
    recordMap = new Map<string, IdentityRecord>(),
  ) {
    const consumed: { boxId: string; atHeight: number }[] = [];
    const inserted: KarmaBox[] = [];
    const key = (o: Uint8Array) => Buffer.from(o).toString('hex');
    return {
      deps: {
        getKarmaBoxes: (owner: Uint8Array) => boxesMap.get(key(owner)) ?? [],
        getIdentityRecord: (id: Uint8Array) => recordMap.get(key(id)) ?? null,
        putIdentityRecord: (id: Uint8Array, r: IdentityRecord) => {
          recordMap.set(key(id), r);
        },
      },
      touchedOwners: Array.from(boxesMap.keys())
        .sort()
        .map((k) => new Uint8Array(Buffer.from(k, 'hex'))),
      consumed,
      inserted,
      recordMap,
    };
  }

  const ownerKey = Buffer.from(OWNER).toString('hex');

  function oneOwner(boxes: KarmaBox[], record?: IdentityRecord) {
    const boxesMap = new Map<string, KarmaBox[]>([[ownerKey, boxes]]);
    const recordMap = new Map<string, IdentityRecord>();
    if (record) recordMap.set(ownerKey, record);
    return { ...makeDeps(boxesMap, recordMap), touchedOwners: [OWNER] };
  }

  // The stale-family heights, derived from the constants so the tests survive
  // the next constant change. Activity at ACTIVITY_AT, decay evaluated at
  // STALE_AT: past the staleness threshold, with enough whole intervals owed
  // (CAP_INTERVALS × KARMA_DECAY_AMOUNT > 100n − KARMA_MINIMUM) that the
  // value-over-minimum cap, not the per-period rate, sets every asserted burn.
  const ACTIVITY_AT = 1000;
  const CAP_INTERVALS = Number((100n - KARMA_MINIMUM) / KARMA_DECAY_AMOUNT) + 1;
  const STALE_AT =
    ACTIVITY_AT + KARMA_STALE_THRESHOLD_BLOCKS + CAP_INTERVALS * KARMA_DECAY_INTERVAL_BLOCKS;

  it('does nothing for a non-stale identity', () => {
    const { deps, touchedOwners, consumed, inserted } = oneOwner(
      [makeKarmaBox({ value: 100n })],
      clock(99999),
    );

    const journal = deriveKarmaDecay(deps, touchedOwners, 100000, TEST_CFG);

    expect(journal).toHaveLength(0);
    expect(consumed).toHaveLength(0);
    expect(inserted).toHaveLength(0);
  });

  it('burns karma for a stale identity', () => {
    // Stale by construction of STALE_AT, and owed more than the box holds over
    // the floor — so the burn is the value-over-minimum cap.
    const { deps, touchedOwners } = oneOwner(
      [makeKarmaBox({ id: 'old-box-1', value: 100n })],
      clock(ACTIVITY_AT),
    );

    const journal = deriveKarmaDecay(deps, touchedOwners, STALE_AT, TEST_CFG);

    expect(journal).toHaveLength(1);
    const entry = journal[0]!;
    expect(entry.burnAmount).toBe(100n - KARMA_MINIMUM);
    expect(entry.consumedBoxIds).toEqual(['old-box-1']);
    // ⛔ **No box id, because no box is produced here.** The replacement karma is
    // an output of the block's settlement transaction and takes that
    // transaction's `(txId, index)`, so the plan carries the VALUE the owner is
    // left holding rather than an id it could not know.
    expect(entry.newValue).toBe(100n - entry.burnAmount);
  });

  it('caps burn at the KARMA_MINIMUM floor', () => {
    // Owed far more than the box holds over the floor; only the excess burns.
    const { deps, touchedOwners } = oneOwner(
      [makeKarmaBox({ id: 'old-box-1', value: 12n })],
      clock(ACTIVITY_AT),
    );

    const journal = deriveKarmaDecay(deps, touchedOwners, STALE_AT, TEST_CFG);

    expect(journal).toHaveLength(1);
    expect(journal[0]!.burnAmount).toBe(12n - KARMA_MINIMUM);
  });

  it('does nothing when already at or below the minimum', () => {
    const { deps, touchedOwners, consumed, inserted } = oneOwner(
      [makeKarmaBox({ id: 'old-box-1', value: 8n })],
      clock(ACTIVITY_AT),
    );

    const journal = deriveKarmaDecay(deps, touchedOwners, STALE_AT, TEST_CFG);

    expect(journal).toHaveLength(0);
    expect(consumed).toHaveLength(0);
    expect(inserted).toHaveLength(0);
  });

  it('leaves the clock untouched when nothing burns', () => {
    // A stale identity sitting at the floor keeps the intervals it is owed —
    // writing `lastDecayBlock` on a zero burn would silently forgive them.
    const { deps, touchedOwners, recordMap } = oneOwner(
      [makeKarmaBox({ id: 'old-box-1', value: 8n })],
      clock(ACTIVITY_AT),
    );

    deriveKarmaDecay(deps, touchedOwners, STALE_AT, TEST_CFG);

    expect(recordMap.get(ownerKey)).toEqual(clock(ACTIVITY_AT));
  });

  it('consolidates multiple boxes into one', () => {
    const { deps, touchedOwners, consumed } = oneOwner(
      [
        makeKarmaBox({ id: 'box-a', value: 50n }),
        makeKarmaBox({ id: 'box-b', value: 60n }),
      ],
      clock(ACTIVITY_AT),
    );

    const journal = deriveKarmaDecay(deps, touchedOwners, STALE_AT, TEST_CFG);

    expect(journal).toHaveLength(1);
    // ⛔ **The plan NAMES both boxes; the settlement consumes them.** The
    // derivation is pure, so `consumed` stays empty and the plan is the only
    // place the pair can be read.
    expect(journal[0]!.consumedBoxIds).toHaveLength(2);
    expect([...journal[0]!.consumedBoxIds].sort()).toEqual(['box-a', 'box-b']);
    expect(consumed).toHaveLength(0);
  });

  it('the new box has decayBurn: true', () => {
    const { deps, touchedOwners, inserted } = oneOwner(
      [makeKarmaBox({ id: 'old-box', value: 100n })],
      clock(ACTIVITY_AT),
    );

    const plans = deriveKarmaDecay(deps, touchedOwners, STALE_AT, TEST_CFG);

    // ⚠ **`decayBurn` is the SETTLEMENT's to set now**, on the karma output it
    // emits for this plan — it is what keeps the replacement from resetting the
    // owner's activity clock. The derivation carries the value; that the flag
    // rides it is asserted where the box is made, in `conservation-axiom` and
    // `block-apply`.
    expect(plans).toHaveLength(1);
    expect(inserted).toHaveLength(0);
  });

  it('advances lastDecayBlock and preserves lastActivityBlock', () => {
    const { deps, touchedOwners, recordMap } = oneOwner(
      [makeKarmaBox({ id: 'old-box', value: 100n })],
      clock(ACTIVITY_AT),
    );

    const plans = deriveKarmaDecay(deps, touchedOwners, STALE_AT, TEST_CFG);
    // ⛔ **The clock is advanced by `commitDecayClocks`, after the settlement's
    // boxes are in** — so the journal's reverse replay undoes the record before
    // deleting the box that caused it.
    commitDecayClocks(deps, plans, STALE_AT);

    expect(recordMap.get(ownerKey)).toEqual(clock(ACTIVITY_AT, STALE_AT));
  });

  it('a second cycle charges from the first decay, not from the activity', () => {
    // Without `max(...)` this would re-bill every interval since ACTIVITY_AT
    // and burn down to the floor instead of one period's worth.
    const firstDecayAt = ACTIVITY_AT + KARMA_STALE_THRESHOLD_BLOCKS;
    const { deps, touchedOwners } = oneOwner(
      [makeKarmaBox({ id: 'decay-box', value: 100n, decayBurn: true })],
      clock(ACTIVITY_AT, firstDecayAt),
    );

    const journal = deriveKarmaDecay(deps, touchedOwners, firstDecayAt + KARMA_DECAY_INTERVAL_BLOCKS, TEST_CFG);

    expect(journal).toHaveLength(1);
    // One whole interval past the first decay -> exactly one period's burn.
    expect(journal[0]!.burnAmount).toBe(KARMA_DECAY_AMOUNT);
  });

  it('creates a record for an owner that had none', () => {
    const { deps, touchedOwners, recordMap } = oneOwner([makeKarmaBox({ id: 'old-box', value: 100n })]);

    const journal = deriveKarmaDecay(deps, touchedOwners, STALE_AT, TEST_CFG);
    commitDecayClocks(deps, journal, STALE_AT);

    expect(journal).toHaveLength(1);
    expect(recordMap.get(ownerKey)).toEqual(clock(0, STALE_AT));
  });

  it('skips an owner with no karma boxes without touching its clock', () => {
    const { deps, touchedOwners, recordMap } = oneOwner([], clock(ACTIVITY_AT));

    expect(deriveKarmaDecay(deps, touchedOwners, STALE_AT, TEST_CFG)).toHaveLength(0);
    expect(recordMap.get(ownerKey)).toEqual(clock(ACTIVITY_AT));
  });

  it('a stale identity NOT in the touched set produces no plan', () => {
    const { deps } = oneOwner(
      [makeKarmaBox({ id: 'old-box', value: 100n })],
      clock(ACTIVITY_AT),
    );
    const plans = deriveKarmaDecay(deps, [], STALE_AT, TEST_CFG);
    expect(plans).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// effectiveKarma — the one valuation function
// ---------------------------------------------------------------------------

describe('effectiveKarma', () => {
  it('returns face total for a non-stale identity', () => {
    expect(effectiveKarma(100n, clock(99000), 100000, TEST_CFG)).toBe(100n);
  });

  it('reduces a stale identity by owed periods', () => {
    const rec = clock(1000);
    const height = 1000 + KARMA_STALE_THRESHOLD_BLOCKS;
    // At exactly the threshold: owedPeriods = floor(40320 / 1440) = 28.
    // With 1000n balance the floor (10n) does not bind.
    expect(effectiveKarma(1000n, rec, height, TEST_CFG)).toBe(1000n - 28n * KARMA_DECAY_AMOUNT);
  });

  it('clamps at KARMA_MINIMUM for an identity holding more', () => {
    const rec = clock(1000);
    const height = 1000 + KARMA_STALE_THRESHOLD_BLOCKS + 100 * KARMA_DECAY_INTERVAL_BLOCKS;
    expect(effectiveKarma(100n, rec, height, TEST_CFG)).toBe(KARMA_MINIMUM);
  });

  it('clamps at face total when face < KARMA_MINIMUM', () => {
    const rec = clock(1000);
    const height = 1000 + KARMA_STALE_THRESHOLD_BLOCKS + KARMA_DECAY_INTERVAL_BLOCKS;
    expect(effectiveKarma(5n, rec, height, TEST_CFG)).toBe(5n);
  });

  it('a null record reads as never-active — maximally stale', () => {
    const height = KARMA_STALE_THRESHOLD_BLOCKS + 100 * KARMA_DECAY_INTERVAL_BLOCKS;
    expect(effectiveKarma(100n, null, height, TEST_CFG)).toBe(KARMA_MINIMUM);
  });

  it('uses max(lastActivity, lastDecay) as the clock start', () => {
    const height = 1000 + KARMA_STALE_THRESHOLD_BLOCKS + 2 * KARMA_DECAY_INTERVAL_BLOCKS;
    // From activity (1000): owedPeriods = floor((40320 + 2880) / 1440) = 30
    const fromActivity = effectiveKarma(1000n, clock(1000), height, TEST_CFG);
    // From decay (2440): owedPeriods = floor((40320 + 2880 - 1440) / 1440) = 29
    const fromDecay = effectiveKarma(
      1000n,
      clock(1000, 1000 + KARMA_DECAY_INTERVAL_BLOCKS),
      height,
      TEST_CFG,
    );
    expect(fromActivity).toBe(1000n - 30n * KARMA_DECAY_AMOUNT);
    expect(fromDecay).toBe(1000n - 29n * KARMA_DECAY_AMOUNT);
  });
});
