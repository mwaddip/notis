import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { computeBoxId } from '@dagsocial/types';
import type {
  AnyBox,
  CandidateOf,
  CreditBox,
  KarmaBox,
  UserId,
} from '@dagsocial/types';
import type { BlockJournal } from '../../src/store/journal.js';
import type { IdentityRecord } from '../../src/store/identity-records.js';
import {
  fixtureProvenance,
  seedProvenance,
  type Stored,
} from '../helpers.js';

/**
 * `insertBox` populates the identity record's activity clock.
 *
 * The staleness clock lives in the committed record, and `insertBox` is the
 * choke point that keeps it there: it bumps `lastActivityBlock` for exactly the
 * boxes staleness counts — karma boxes with `nonActivity !== true` — so no
 * producer has to remember to do it.
 *
 * The height comes from the **open journal**, never from the box. `insertBox`
 * takes no height, and a box carries none: `createdAtBlock` is not a box field,
 * and the `created_at_block` COLUMN is store-only, which consensus code must
 * never read (NODE_INTERFACE → "`created_at_block` is a store column, never a
 * consensus input"). Every test below therefore drives a journal height that
 * differs from the seed its fixture was built with, so an implementation that
 * reached back into the box for a height could not pass.
 */

async function importDbFresh() {
  return (await import('../../src/store/db.js')) as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
  };
}

// The module's own type, not a hand-written shape listing the one or two
// exports in use: under a hand-written shape, reaching for another export is a
// compile error, and the test that needed it goes unwritten instead.
async function importUtxoFresh() {
  return import('../../src/store/utxo.js');
}

async function importJournalFresh() {
  return (await import('../../src/store/journal.js')) as {
    beginBlockJournal: (height: number) => void;
    finishBlockJournal: () => BlockJournal;
    openBlockJournalHeight: () => number | null;
  };
}

async function importRecordsFresh() {
  return (await import('../../src/store/identity-records.js')) as {
    getIdentityRecord: (id: UserId) => IdentityRecord | null;
    putIdentityRecord: (id: UserId, r: IdentityRecord) => void;
    identityRecordKey: (id: UserId) => string;
  };
}

function owner(label: string): UserId {
  return new Uint8Array(createHash('blake2b512').update(label).digest().subarray(0, 32));
}

function karmaBox(
  o: UserId,
  seed: number,
  value: bigint,
  nonActivity?: boolean,
): Stored<KarmaBox> {
  const candidate: CandidateOf<KarmaBox> = {
    boxType: 'karma',
    value,
    createdAtBlock: 0,
    owner: o,
    // `seed` is a fixture discriminator, NOT a box field: `seedProvenance`
    // hashes it into the synthetic provenance, so distinct boxes keep distinct
    // ids. The journal height is what the clock assertions turn on.
  };
  if (nonActivity !== undefined) candidate.nonActivity = nonActivity;
  return seedProvenance<KarmaBox>(candidate, seed);
}

function creditBox(o: UserId, value: bigint, seed: number): Stored<CreditBox> {
  return seedProvenance<CreditBox>({
    boxType: 'credit' as const,
    value,
    owner: o,
  }, 1);
}

describe('insertBox populates the activity clock (Spec G phase D2)', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  // -------------------------------------------------------------------------
  // Id integrity across the store round-trip.
  //
  // TYPES_INTERFACE → BoxId states that `stored.id === computeBoxId(stored)`
  // holds "by construction for every box in the UTXO set". A box that breaks it
  // is one no light client can validate, and the store is where it breaks:
  // `value` is written as a bigint and read back through `.safeIntegers()`, so
  // a fixture built with a NUMBER value hashes one way in memory and another
  // way on the way out.
  //
  // The assertion therefore runs against a REAL store round-trip. The in-memory
  // object is exactly the side that cannot disagree with itself.
  // -------------------------------------------------------------------------
  it('a seeded box read back from the store still derives its own id', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    initDb(':memory:');

    const alice = owner('alice');
    const seeded = karmaBox(alice, 42, 100n);
    beginBlockJournal(42);
    insertBox(seeded);
    finishBlockJournal();

    const stored = getBox(seeded.id);
    expect(stored).not.toBeNull();
    expect(stored!.value).toBe(100n);
    expect(typeof stored!.value).toBe('bigint');
    expect(computeBoxId(stored!)).toBe(stored!.id);
  });

  it('a non-decay karma box creates the record at the journal height', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { insertBox } = await importUtxoFresh();
    const { getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const alice = owner('alice');
    beginBlockJournal(42);
    insertBox(karmaBox(alice, 42, 100n));
    finishBlockJournal();

    expect(getIdentityRecord(alice)).toEqual({ lastActivityBlock: 42, lastDecayBlock: 0, invitedAtBlock: 0, lifetimeLikesReceived: 0n });
  });

  it('the height is the journal height, not the box createdAtBlock', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { insertBox } = await importUtxoFresh();
    const { getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    // The seed and the journal height are deliberately far apart. A box carries
    // no height of its own, so an implementation that found one to read would
    // be reading the store's display column — the one consensus must not touch.
    const alice = owner('alice');
    beginBlockJournal(90);
    insertBox(karmaBox(alice, 7, 100n));
    finishBlockJournal();

    expect(getIdentityRecord(alice)).toEqual({ lastActivityBlock: 90, lastDecayBlock: 0, invitedAtBlock: 0, lifetimeLikesReceived: 0n });
  });

  it('a decay-burn karma box does NOT bump the activity clock', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { insertBox } = await importUtxoFresh();
    const { getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    // The whole point of `nonActivity` is that decay's own replacement box is not
    // activity — if it were, one decay would make the identity look fresh and
    // no second cycle could ever fire.
    const alice = owner('alice');
    beginBlockJournal(50);
    insertBox(karmaBox(alice, 50, 100n, true));
    finishBlockJournal();

    expect(getIdentityRecord(alice)).toBeNull();
  });

  it('an explicit `nonActivity: false` box IS activity', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { insertBox } = await importUtxoFresh();
    const { getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    // The predicate is `nonActivity !== true`, not `=== undefined`: an explicit
    // `false` is activity, and only decay's own replacement box is not.
    const alice = owner('alice');
    beginBlockJournal(50);
    insertBox(karmaBox(alice, 50, 100n, false));
    finishBlockJournal();

    expect(getIdentityRecord(alice)).toEqual({ lastActivityBlock: 50, lastDecayBlock: 0, invitedAtBlock: 0, lifetimeLikesReceived: 0n });
  });

  it('a decay-burn insert leaves an existing record untouched', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { insertBox } = await importUtxoFresh();
    const { getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const alice = owner('alice');
    beginBlockJournal(10);
    insertBox(karmaBox(alice, 10, 100n));
    finishBlockJournal();

    beginBlockJournal(80);
    insertBox(karmaBox(alice, 80, 70n, true));
    finishBlockJournal();

    expect(getIdentityRecord(alice)).toEqual({ lastActivityBlock: 10, lastDecayBlock: 0, invitedAtBlock: 0, lifetimeLikesReceived: 0n });
  });

  it('a non-karma box creates no record', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { insertBox } = await importUtxoFresh();
    const { getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const alice = owner('alice');
    beginBlockJournal(12);
    insertBox(creditBox(alice, 5000n, 12));
    finishBlockJournal();

    expect(getIdentityRecord(alice)).toBeNull();
  });

  it('with no journal open nothing is recorded', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox } = await importUtxoFresh();
    const { getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    // Genesis and bootstrap insert boxes outside any block, and there is no
    // settled height to record — so `insertBox` writes the box and no clock.
    const alice = owner('alice');
    insertBox(karmaBox(alice, 1, 100n));

    expect(getIdentityRecord(alice)).toBeNull();
  });

  it('a later activity bump preserves lastDecayBlock', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { insertBox } = await importUtxoFresh();
    const { getIdentityRecord, putIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    // The two halves of the record have different writers. An activity bump
    // that reset the decay clock would hand the owner a free interval.
    const alice = owner('alice');
    putIdentityRecord(alice, { lastActivityBlock: 5, lastDecayBlock: 33, invitedAtBlock: 0, lifetimeLikesReceived: 0n });

    beginBlockJournal(77);
    insertBox(karmaBox(alice, 77, 100n));
    finishBlockJournal();

    expect(getIdentityRecord(alice)).toEqual({ lastActivityBlock: 77, lastDecayBlock: 33, invitedAtBlock: 0, lifetimeLikesReceived: 0n });
  });

  it('each identity gets its own clock', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { insertBox } = await importUtxoFresh();
    const { getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const alice = owner('alice');
    const bob = owner('bob');
    beginBlockJournal(3);
    insertBox(karmaBox(alice, 3, 100n));
    finishBlockJournal();
    beginBlockJournal(9);
    insertBox(karmaBox(bob, 9, 100n));
    finishBlockJournal();

    expect(getIdentityRecord(alice)).toEqual({ lastActivityBlock: 3, lastDecayBlock: 0, invitedAtBlock: 0, lifetimeLikesReceived: 0n });
    expect(getIdentityRecord(bob)).toEqual({ lastActivityBlock: 9, lastDecayBlock: 0, invitedAtBlock: 0, lifetimeLikesReceived: 0n });
  });

  it('the bump is journaled, after the box insert it followed', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { insertBox } = await importUtxoFresh();
    const { identityRecordKey } = await importRecordsFresh();
    initDb(':memory:');

    // Order matters: `revertBlock` replays in reverse, so the record inverse
    // must run before the box that caused it is deleted.
    const alice = owner('alice');
    const box = karmaBox(alice, 4, 100n);
    beginBlockJournal(4);
    insertBox(box);
    const journal = finishBlockJournal();

    expect(journal.mutations).toEqual([
      { kind: 'box', op: 'insert', boxId: box.id, box },
      {
        kind: 'record',
        key: identityRecordKey(alice),
        identityId: alice,
        record: { lastActivityBlock: 4, lastDecayBlock: 0, invitedAtBlock: 0, lifetimeLikesReceived: 0n },
      },
    ]);
  });

  it('a second bump in the same block journals the value it replaced', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { insertBox } = await importUtxoFresh();
    const { putIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const alice = owner('alice');
    putIdentityRecord(alice, { lastActivityBlock: 2, lastDecayBlock: 1, invitedAtBlock: 0, lifetimeLikesReceived: 0n });

    beginBlockJournal(6);
    insertBox(karmaBox(alice, 6, 10n));
    const journal = finishBlockJournal();

    const records = journal.mutations.filter((m) => m.kind === 'record');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      record: { lastActivityBlock: 6, lastDecayBlock: 1, invitedAtBlock: 0, lifetimeLikesReceived: 0n },
      replaced: { lastActivityBlock: 2, lastDecayBlock: 1, invitedAtBlock: 0, lifetimeLikesReceived: 0n },
    });
  });

  it('openBlockJournalHeight tracks the open journal and nothing else', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal, openBlockJournalHeight } =
      await importJournalFresh();
    initDb(':memory:');

    expect(openBlockJournalHeight()).toBeNull();
    beginBlockJournal(17);
    expect(openBlockJournalHeight()).toBe(17);
    finishBlockJournal();
    expect(openBlockJournalHeight()).toBeNull();
  });

  it('height 0 is a height, not "no journal"', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal, openBlockJournalHeight } =
      await importJournalFresh();
    const { insertBox } = await importUtxoFresh();
    const { getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    // A `if (!height)` guard would silently drop the bump at height 0 and leave
    // the identity looking as though it had never been active.
    const alice = owner('alice');
    beginBlockJournal(0);
    expect(openBlockJournalHeight()).toBe(0);
    insertBox(karmaBox(alice, 0, 100n));
    finishBlockJournal();

    expect(getIdentityRecord(alice)).toEqual({ lastActivityBlock: 0, lastDecayBlock: 0, invitedAtBlock: 0, lifetimeLikesReceived: 0n });
  });
});
