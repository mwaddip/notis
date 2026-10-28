import { describe, it, expect } from 'vitest';
import { fixtureProvenance } from './helpers.js';
import {
  commitDecayClocks,
  deriveKarmaDecay,
} from '@dagsocial/consensus';
import {
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
} from '@dagsocial/types';
import type { IdentityRecord, KarmaBox } from '@dagsocial/types';

/**
 * The decay execution — `deriveKarmaDecay` reads the identity record and the
 * pre-body karma projection and returns per-owner plans, `commitDecayClocks`
 * writes the clocks back (NODE_INTERFACE → Karma decay).
 */

const OWNER = new Uint8Array(32).fill(0xaa);

const TEST_CFG = {
  staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
  decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
  decayAmount: KARMA_DECAY_AMOUNT,
  karmaMinimum: KARMA_MINIMUM,
};

function clock(lastActivityBlock: number, lastDecayBlock = 0): IdentityRecord {
  return { lastActivityBlock, lastDecayBlock, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 };
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

// The pure-piece tests — `owedPeriods`, `decaySettledThrough`, `effectiveKarma`
// — live in `@dagsocial/types`. The execution tests below drive the deps and
// the plan.

// ---------------------------------------------------------------------------
// deriveKarmaDecay
// ---------------------------------------------------------------------------

describe('deriveKarmaDecay', () => {
  function makeDeps(
    boxesMap: Map<string, KarmaBox[]>,
    recordMap = new Map<string, IdentityRecord>(),
  ) {
    const key = (o: Uint8Array) => Buffer.from(o).toString('hex');
    const postBodyKarma = new Map<string, { owner: Uint8Array; boxes: KarmaBox[] }>();
    for (const [k, boxes] of Array.from(boxesMap.entries()).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      postBodyKarma.set(k, { owner: new Uint8Array(Buffer.from(k, 'hex')), boxes });
    }
    return {
      deps: {
        getIdentityRecord: (id: Uint8Array) => recordMap.get(key(id)) ?? null,
        putIdentityRecord: (id: Uint8Array, r: IdentityRecord) => {
          recordMap.set(key(id), r);
        },
      },
      postBodyKarma,
      recordMap,
    };
  }

  const ownerKey = Buffer.from(OWNER).toString('hex');

  function oneOwner(boxes: KarmaBox[], record?: IdentityRecord) {
    const boxesMap = new Map<string, KarmaBox[]>([[ownerKey, boxes]]);
    const recordMap = new Map<string, IdentityRecord>();
    if (record) recordMap.set(ownerKey, record);
    return makeDeps(boxesMap, recordMap);
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
    const { deps, postBodyKarma } = oneOwner(
      [makeKarmaBox({ value: 100n })],
      clock(99999),
    );

    const journal = deriveKarmaDecay(deps, postBodyKarma, 100000, TEST_CFG);

    expect(journal).toHaveLength(0);
  });

  it('burns karma for a stale identity', () => {
    // Stale by construction of STALE_AT, and owed more than the box holds over
    // the floor — so the burn is the value-over-minimum cap.
    const { deps, postBodyKarma } = oneOwner(
      [makeKarmaBox({ id: 'old-box-1', value: 100n })],
      clock(ACTIVITY_AT),
    );

    const journal = deriveKarmaDecay(deps, postBodyKarma, STALE_AT, TEST_CFG);

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
    const { deps, postBodyKarma } = oneOwner(
      [makeKarmaBox({ id: 'old-box-1', value: 12n })],
      clock(ACTIVITY_AT),
    );

    const journal = deriveKarmaDecay(deps, postBodyKarma, STALE_AT, TEST_CFG);

    expect(journal).toHaveLength(1);
    expect(journal[0]!.burnAmount).toBe(12n - KARMA_MINIMUM);
  });

  it('a zero-burn plan at or below the minimum carries settledThrough and names no box', () => {
    const { deps, postBodyKarma } = oneOwner(
      [makeKarmaBox({ id: 'old-box-1', value: 8n })],
      clock(ACTIVITY_AT),
    );

    const journal = deriveKarmaDecay(deps, postBodyKarma, STALE_AT, TEST_CFG);

    // The squared set includes an owner at the floor; the plan is a clock
    // write and no leg (NODE_INTERFACE → Karma decay → "The floor forgives
    // what it stops").
    expect(journal).toHaveLength(1);
    expect(journal[0]!.consumedBoxIds).toEqual([]);
    expect(journal[0]!.burnAmount).toBe(0n);
    expect(journal[0]!.settledThrough).toBe(STALE_AT);
  });

  it('the floor\'s clock-write forgives the periods it stopped at', () => {
    // An identity sitting at the floor keeps no periods: the squaring writes
    // the clock, and effective karma over the owner's boxes and record
    // answers the same from the block onward.
    const { deps, postBodyKarma, recordMap } = oneOwner(
      [makeKarmaBox({ id: 'old-box-1', value: 8n })],
      clock(ACTIVITY_AT),
    );

    const plans = deriveKarmaDecay(deps, postBodyKarma, STALE_AT, TEST_CFG);
    commitDecayClocks(deps, plans);

    expect(recordMap.get(ownerKey)).toEqual(clock(ACTIVITY_AT, STALE_AT));
  });

  it('consolidates multiple boxes into one', () => {
    const { deps, postBodyKarma } = oneOwner(
      [
        makeKarmaBox({ id: 'box-a', value: 50n }),
        makeKarmaBox({ id: 'box-b', value: 60n }),
      ],
      clock(ACTIVITY_AT),
    );

    const journal = deriveKarmaDecay(deps, postBodyKarma, STALE_AT, TEST_CFG);

    expect(journal).toHaveLength(1);
    // ⛔ **The plan NAMES both boxes; the settlement consumes them.** The
    // derivation is pure — DecayDeps declares no box writer — so the plan is
    // the only place the pair can be read.
    expect(journal[0]!.consumedBoxIds).toHaveLength(2);
    expect([...journal[0]!.consumedBoxIds].sort()).toEqual(['box-a', 'box-b']);
  });

  it('advances lastDecayBlock and preserves lastActivityBlock', () => {
    const { deps, postBodyKarma, recordMap } = oneOwner(
      [makeKarmaBox({ id: 'old-box', value: 100n })],
      clock(ACTIVITY_AT),
    );

    const plans = deriveKarmaDecay(deps, postBodyKarma, STALE_AT, TEST_CFG);
    // ⛔ **The clock is advanced by `commitDecayClocks`, after the settlement's
    // boxes are in** — so the journal's reverse replay undoes the record before
    // deleting the box that caused it.
    commitDecayClocks(deps, plans);

    // `clockStart = ACTIVITY_AT + T`; `settledThrough = clockStart +
    // CAP_INTERVALS · I`, which lands at STALE_AT by construction.
    expect(recordMap.get(ownerKey)).toEqual(clock(ACTIVITY_AT, STALE_AT));
  });

  it('a second cycle charges from the first decay, not from the activity', () => {
    // Without `max(...)` this would re-bill every interval since ACTIVITY_AT
    // and burn down to the floor instead of one period's worth.
    const firstDecayAt = ACTIVITY_AT + KARMA_STALE_THRESHOLD_BLOCKS;
    const { deps, postBodyKarma } = oneOwner(
      [makeKarmaBox({ id: 'decay-box', value: 100n })],
      clock(ACTIVITY_AT, firstDecayAt),
    );

    const journal = deriveKarmaDecay(deps, postBodyKarma, firstDecayAt + KARMA_DECAY_INTERVAL_BLOCKS, TEST_CFG);

    expect(journal).toHaveLength(1);
    // One whole interval past the first decay -> exactly one period's burn.
    expect(journal[0]!.burnAmount).toBe(KARMA_DECAY_AMOUNT);
  });

  it('creates a record for an owner that had none', () => {
    const { deps, postBodyKarma, recordMap } = oneOwner([makeKarmaBox({ id: 'old-box', value: 100n })]);

    const journal = deriveKarmaDecay(deps, postBodyKarma, STALE_AT, TEST_CFG);
    commitDecayClocks(deps, journal);

    expect(journal).toHaveLength(1);
    // Null record values as `EMPTY_IDENTITY_RECORD`: `clockStart = T`, and
    // `settledThrough = T + CAP_INTERVALS · I` is a period short of STALE_AT
    // because ACTIVITY_AT is not a multiple of I.
    const settledThrough = KARMA_STALE_THRESHOLD_BLOCKS + CAP_INTERVALS * KARMA_DECAY_INTERVAL_BLOCKS;
    expect(recordMap.get(ownerKey)).toEqual(clock(0, settledThrough));
  });

  it('an owner in the squared set holding no karma box carries a zero-burn plan', () => {
    const { deps, postBodyKarma, recordMap } = oneOwner([], clock(ACTIVITY_AT));

    const plans = deriveKarmaDecay(deps, postBodyKarma, STALE_AT, TEST_CFG);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.consumedBoxIds).toEqual([]);
    expect(plans[0]!.burnAmount).toBe(0n);
    expect(plans[0]!.settledThrough).toBe(STALE_AT);
    // The clock advances only through commitDecayClocks, which the test
    // does not call — the record stands as seeded.
    expect(recordMap.get(ownerKey)).toEqual(clock(ACTIVITY_AT));
  });

  it('a stale identity NOT in the squared set produces no plan', () => {
    const { deps } = oneOwner(
      [makeKarmaBox({ id: 'old-box', value: 100n })],
      clock(ACTIVITY_AT),
    );
    const plans = deriveKarmaDecay(deps, new Map(), STALE_AT, TEST_CFG);
    expect(plans).toHaveLength(0);
  });
});

