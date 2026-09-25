import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { computeBoxId, identityRecordKey } from '@dagsocial/types';
import type {
  CreditBox,
  IdentityRecord,
  KarmaBox,
  UserId,
} from '@dagsocial/types';
import type { RecordMutation } from '../../src/store/journal.js';
import {
  makeApplicableBlock,
  makeTestIdentity,
  seedPostTx,
  seedProvenance,
  type Stored,
} from '../helpers.js';

/**
 * The identity record's activity clock (NODE_INTERFACE → Populating the record).
 *
 * The clock is block application's: a post transaction advances its author's
 * `lastActivityBlock` to the height of the block applying it, carrying every
 * other field, and the effects writer journals the write with the row it
 * replaces. The store's box writers move no clock — settlement consumption and
 * settlement outputs are not activity.
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

async function importRecordsFresh() {
  return (await import('../../src/store/identity-records.js')) as {
    getIdentityRecord: (id: UserId) => IdentityRecord | null;
    putIdentityRecord: (id: UserId, r: IdentityRecord) => void;
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

describe('the activity clock', () => {
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
    const { insertBox, getBox } = await importUtxoFresh();
    initDb(':memory:');

    const alice = owner('alice');
    const seeded = karmaBox(alice, 42, 100n);
    insertBox(seeded);

    const stored = getBox(seeded.id);
    expect(stored).not.toBeNull();
    expect(stored!.value).toBe(100n);
    expect(typeof stored!.value).toBe('bigint');
    expect(computeBoxId(stored!)).toBe(stored!.id);
  });

  it('insertBox alone does NOT advance the activity clock', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox } = await importUtxoFresh();
    const { getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const alice = owner('alice');
    insertBox(karmaBox(alice, 42, 100n));

    expect(getIdentityRecord(alice)).toBeNull();
  });

  it('a non-karma box creates no record', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox } = await importUtxoFresh();
    const { getIdentityRecord } = await importRecordsFresh();
    initDb(':memory:');

    const alice = owner('alice');
    insertBox(creditBox(alice, 5000n));

    expect(getIdentityRecord(alice)).toBeNull();
  });

  it('a post advances its author\'s clock to the block\'s height, carrying every other field, journalled with the row it replaced', async () => {
    const db = await importDbFresh();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const { getIdentityRecord, putIdentityRecord } = await importRecordsFresh();
    const { applyOrderingBlock } = await import('../../src/services/block-apply.js');
    const { getBlockJournal } = await import('../../src/store/journal.js');

    // `newcomer` holds no record; `resident` holds one with every field set.
    const newcomer = makeTestIdentity();
    const resident = makeTestIdentity();
    const prior: IdentityRecord = {
      lastActivityBlock: 1, lastDecayBlock: 1, invitedAtBlock: 1, lifetimeLikesReceived: 7n,
      memberSinceBlock: 1, memberBar: 2, memberVouches: 2, memberLikes: 3n, invitesUsed: 2,
    };
    putIdentityRecord(resident.userId, prior);

    expect(applyOrderingBlock(await makeApplicableBlock({ height: 1 }))).toBe(true);
    const newcomerPost = await seedPostTx(newcomer, 'a first post, from no record');
    const residentPost = await seedPostTx(resident, 'a post over a record');
    expect(applyOrderingBlock(await makeApplicableBlock({
      height: 2, utxoTxs: [newcomerPost.tx, residentPost.tx],
    }))).toBe(true);

    const created: IdentityRecord = {
      lastActivityBlock: 2, lastDecayBlock: 0, invitedAtBlock: 0, lifetimeLikesReceived: 0n,
      memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
    };
    const carried: IdentityRecord = { ...prior, lastActivityBlock: 2 };
    expect(getIdentityRecord(newcomer.userId)).toEqual(created);
    expect(getIdentityRecord(resident.userId)).toEqual(carried);

    const writesTo = (who: UserId) => getBlockJournal(2)!.mutations.filter(
      (m): m is RecordMutation => m.kind === 'record' && m.key === identityRecordKey(who),
    );
    const newcomerWrites = writesTo(newcomer.userId);
    expect(newcomerWrites.map((m) => m.record)).toEqual([created]);
    expect('replaced' in newcomerWrites[0]!).toBe(false);
    expect(writesTo(resident.userId).map(({ record, replaced }) => ({ record, replaced }))).toEqual([
      { record: carried, replaced: prior },
    ]);
  });
});
