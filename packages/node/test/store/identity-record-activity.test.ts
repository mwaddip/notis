import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { computeBoxId } from '@dagsocial/types';
import type {
  CreditBox,
  KarmaBox,
  UserId,
} from '@dagsocial/types';
import type { BlockJournal } from '../../src/store/journal.js';
import type { IdentityRecord } from '../../src/store/identity-records.js';
import {
  seedProvenance,
  type Stored,
} from '../helpers.js';

/**
 * `recordKarmaActivity` advances the identity record's activity clock.
 *
 * The staleness clock lives in the committed record, and `recordKarmaActivity`
 * is the single writer of `lastActivityBlock` during block application: it
 * fires from the user-transaction loop in `applyOrderingBlock` for every
 * transaction whose inputs are karma boxes (ARCHITECTURE → Karma decay).
 * Settlement consumption (decay) and settlement outputs (grants, payouts,
 * vests, returns) do not advance the clock — only user spends do.
 *
 * The height comes from the **open journal**. `recordKarmaActivity` asserts a
 * journal is open and throws outside block application.
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
): Stored<KarmaBox> {
  return seedProvenance<KarmaBox>({
    boxType: 'karma',
    value,
    createdAtBlock: 0,
    owner: o,
  }, seed);
}

function creditBox(o: UserId, value: bigint): Stored<CreditBox> {
  return seedProvenance<CreditBox>({
    boxType: 'credit' as const,
    value,
    owner: o,
  }, 1);
}

describe('recordKarmaActivity advances the activity clock', () => {
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

  it('recordKarmaActivity creates the record at the journal height', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { recordKarmaActivity } = await importUtxoFresh();
    const { getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const alice = owner('alice');
    beginBlockJournal(42);
    recordKarmaActivity(alice);
    finishBlockJournal();

    expect(getIdentityRecord(alice)).toEqual({ lastActivityBlock: 42, lastDecayBlock: 0, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 });
  });

  it('insertBox alone does NOT advance the activity clock', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { insertBox } = await importUtxoFresh();
    const { getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const alice = owner('alice');
    beginBlockJournal(42);
    insertBox(karmaBox(alice, 42, 100n));
    finishBlockJournal();

    expect(getIdentityRecord(alice)).toBeNull();
  });

  it('a non-karma box creates no record', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { insertBox } = await importUtxoFresh();
    const { getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const alice = owner('alice');
    beginBlockJournal(12);
    insertBox(creditBox(alice, 5000n));
    finishBlockJournal();

    expect(getIdentityRecord(alice)).toBeNull();
  });

  it('recordKarmaActivity throws with no journal open', async () => {
    const { initDb } = await importDbFresh();
    const { recordKarmaActivity } = await importUtxoFresh();
    initDb(':memory:');

    const alice = owner('alice');
    expect(() => recordKarmaActivity(alice)).toThrow('outside block application');
  });

  it('height 0 is a height, not "no journal"', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { recordKarmaActivity } = await importUtxoFresh();
    const { getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const alice = owner('alice');
    beginBlockJournal(0);
    recordKarmaActivity(alice);
    finishBlockJournal();

    expect(getIdentityRecord(alice)).toEqual({ lastActivityBlock: 0, lastDecayBlock: 0, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 });
  });

  it('a later activity bump preserves lastDecayBlock', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { recordKarmaActivity } = await importUtxoFresh();
    const { getIdentityRecord, putIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const alice = owner('alice');
    putIdentityRecord(alice, { lastActivityBlock: 5, lastDecayBlock: 33, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 });

    beginBlockJournal(77);
    recordKarmaActivity(alice);
    finishBlockJournal();

    expect(getIdentityRecord(alice)).toEqual({ lastActivityBlock: 77, lastDecayBlock: 33, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 });
  });

  it('each identity gets its own clock', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { recordKarmaActivity } = await importUtxoFresh();
    const { getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const alice = owner('alice');
    const bob = owner('bob');
    beginBlockJournal(3);
    recordKarmaActivity(alice);
    finishBlockJournal();
    beginBlockJournal(9);
    recordKarmaActivity(bob);
    finishBlockJournal();

    expect(getIdentityRecord(alice)).toEqual({ lastActivityBlock: 3, lastDecayBlock: 0, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 });
    expect(getIdentityRecord(bob)).toEqual({ lastActivityBlock: 9, lastDecayBlock: 0, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 });
  });

  it('the bump is journaled', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { recordKarmaActivity } = await importUtxoFresh();
    const { identityRecordKey } = await importRecordsFresh();
    initDb(':memory:');

    const alice = owner('alice');
    beginBlockJournal(4);
    recordKarmaActivity(alice);
    const journal = finishBlockJournal();

    expect(journal.mutations).toEqual([
      {
        kind: 'record',
        key: identityRecordKey(alice),
        identityId: alice,
        record: { lastActivityBlock: 4, lastDecayBlock: 0, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 },
      },
    ]);
  });

  it('a second bump in the same block journals the value it replaced', async () => {
    const { initDb } = await importDbFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { recordKarmaActivity } = await importUtxoFresh();
    const { putIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const alice = owner('alice');
    putIdentityRecord(alice, { lastActivityBlock: 2, lastDecayBlock: 1, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 });

    beginBlockJournal(6);
    recordKarmaActivity(alice);
    const journal = finishBlockJournal();

    const records = journal.mutations.filter((m) => m.kind === 'record');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      record: { lastActivityBlock: 6, lastDecayBlock: 1, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 },
      replaced: { lastActivityBlock: 2, lastDecayBlock: 1, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 },
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
});
