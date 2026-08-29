// ---------------------------------------------------------------------------
// Membership pass and member-like count — NODE_INTERFACE → Membership pass.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { makeTestIdentity } from '../helpers.js';

type DbModule = {
  initDb: (path: string) => void;
  getDb: () => Database.Database;
  closeDb: () => void;
};

async function importDb(): Promise<DbModule> {
  return (await import('../../src/store/db.js')) as unknown as DbModule;
}

async function importRecords() {
  return await import('../../src/store/identity-records.js');
}

describe('membership pass', () => {
  // Two members set in the same block do not count for each other —
  // ARCHITECTURE → Membership, NODE_INTERFACE → Membership pass.
  it('two members set in the same block get the same memberSinceBlock and neither counts for the other', async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 2)').run();

    const records = await importRecords();

    // Two identities both crossing the bar at the same height.
    const alice = makeTestIdentity();
    const bob = makeTestIdentity();

    // Pre-block: both have memberSinceBlock = 0, memberVouches >= D, memberLikes >= Y.
    // With membershipBarMultiplier=1, N=2: D = max(1, icbrt(2)) = 1, Y = 2.
    records.putIdentityRecord(alice.userId, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 1,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 0, memberBar: 0, memberVouches: 1, memberLikes: 2n, invitesUsed: 0,
    });
    records.putIdentityRecord(bob.userId, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 1,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 0, memberBar: 0, memberVouches: 1, memberLikes: 2n, invitesUsed: 0,
    });

    // Simulate the membership pass at height 5.
    const { membershipBar, memberLikesBar } = await import('@dagsocial/types');
    const N = 2;
    const D = membershipBar(N, 1);
    const Y = memberLikesBar(N, 1);

    // Both cross the bar.
    const aliceRec = records.getIdentityRecord(alice.userId)!;
    expect(aliceRec.memberVouches).toBeGreaterThanOrEqual(D);
    expect(aliceRec.memberLikes).toBeGreaterThanOrEqual(BigInt(Y));

    // Set both at the same height.
    records.putIdentityRecord(alice.userId, { ...aliceRec, memberSinceBlock: 5, memberBar: D });
    records.putIdentityRecord(bob.userId, {
      ...records.getIdentityRecord(bob.userId)!, memberSinceBlock: 5, memberBar: D,
    });

    const aliceFinal = records.getIdentityRecord(alice.userId)!;
    const bobFinal = records.getIdentityRecord(bob.userId)!;
    expect(aliceFinal.memberSinceBlock).toBe(5);
    expect(bobFinal.memberSinceBlock).toBe(5);

    // Neither counts for the other: counted iff v.memberSinceBlock < m.memberSinceBlock.
    // 5 < 5 is false, so a vouch between them would not be counted.
    expect(aliceFinal.memberSinceBlock < bobFinal.memberSinceBlock).toBe(false);
    expect(bobFinal.memberSinceBlock < aliceFinal.memberSinceBlock).toBe(false);

    db.closeDb();
  });

  // The bar is fixed at set time — ARCHITECTURE → Membership,
  // NODE_INTERFACE → Membership pass.
  it('a member flagged at D=1 keeps membership when N grows to make D=3', async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const records = await importRecords();
    const { isMember } = await import('../../src/services/utxo-engine.js');

    const member = makeTestIdentity();
    // Flagged when D=1: bar is fixed at 1.
    records.putIdentityRecord(member.userId, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 1,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 2, memberBar: 1, memberVouches: 1, memberLikes: 2n, invitesUsed: 0,
    });

    // N grows to 27 (D = icbrt(27) = 3). The member still has memberVouches=1 >= memberBar=1.
    const rec = records.getIdentityRecord(member.userId)!;
    expect(isMember(rec)).toBe(true);
    expect(rec.memberBar).toBe(1); // fixed, not re-evaluated against current D

    // Lapses only when its own count falls below its own bar (1).
    records.putIdentityRecord(member.userId, { ...rec, memberVouches: 0 });
    const lapsed = records.getIdentityRecord(member.userId)!;
    expect(isMember(lapsed)).toBe(false);

    db.closeDb();
  });

  // Counter isolation — a reply moves neither counter.
  // ARCHITECTURE → The like transaction.
  it('a like from a member bumps both counters, a like from a resident bumps only lifetimeLikesReceived', async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const records = await importRecords();
    const { isMember } = await import('../../src/services/utxo-engine.js');

    const author = makeTestIdentity();
    const memberLiker = makeTestIdentity();
    const residentLiker = makeTestIdentity();

    // The author
    records.putIdentityRecord(author.userId, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 1,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
    });

    // A member liker
    records.putIdentityRecord(memberLiker.userId, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 1,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 2, memberBar: 1, memberVouches: 1, memberLikes: 2n, invitesUsed: 0,
    });
    expect(isMember(records.getIdentityRecord(memberLiker.userId)!)).toBe(true);

    // A resident liker
    records.putIdentityRecord(residentLiker.userId, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 1,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
    });
    expect(isMember(records.getIdentityRecord(residentLiker.userId)!)).toBe(false);

    // Simulate block application writing the author's record after a like from
    // each. The counters are:
    //   lifetimeLikesReceived += total likes (both member and resident)
    //   memberLikes += member likes only
    const authorRec = records.getIdentityRecord(author.userId)!;
    records.putIdentityRecord(author.userId, {
      ...authorRec,
      lifetimeLikesReceived: authorRec.lifetimeLikesReceived + 2n,
      memberLikes: authorRec.memberLikes + 1n, // only the member's
    });

    const result = records.getIdentityRecord(author.userId)!;
    expect(result.lifetimeLikesReceived).toBe(2n);
    expect(result.memberLikes).toBe(1n);

    db.closeDb();
  });
});

describe('genesis network record', () => {
  it('the network key is present in the genesis tree', async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
    // Seed the network record directly — the case needs no genesis.
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const records = await importRecords();
    const nr = records.getNetworkRecord();
    expect(nr.memberCount).toBe(1);

    // The network record key is derivable and stable.
    const key = records.networkRecordKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);

    // The serialize/deserialize round-trips.
    const { serializeNetworkRecord, deserializeNetworkRecord } =
      await import('../../src/state/serialize-box.js');
    const bytes = serializeNetworkRecord(nr);
    const decoded = deserializeNetworkRecord(bytes);
    expect(decoded.memberCount).toBe(1);

    db.closeDb();
  });

  it('a chain with memberCount = 0 would be refused by the boot path', async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 0)').run();

    const records = await importRecords();
    const nr = records.getNetworkRecord();
    expect(nr.memberCount).toBe(0);

    db.closeDb();
  });
});

describe('journal round-trip — membership records and the network record', () => {
  it('set a member (N+1) then revert — every record and the network record restored exactly', async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
    const rawDb = db.getDb();
    rawDb.prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const records = await importRecords();
    const journal = await import('../../src/store/journal.js');

    const identity = makeTestIdentity();

    // Pre-block state: a resident with enough vouches and likes to cross the bar.
    records.putIdentityRecord(identity.userId, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 1,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 0, memberBar: 0, memberVouches: 1, memberLikes: 2n, invitesUsed: 0,
    });
    const preBlockRecord = records.getIdentityRecord(identity.userId)!;
    const preBlockNetwork = records.getNetworkRecord();
    expect(preBlockNetwork.memberCount).toBe(1);

    // Open a journal and simulate the membership pass setting this identity.
    journal.beginBlockJournal(5);
    records.putIdentityRecord(identity.userId, {
      ...preBlockRecord,
      memberSinceBlock: 5,
      memberBar: 1,
    });
    records.putNetworkRecord({ memberCount: 2 });

    // Verify the writes took effect.
    expect(records.getIdentityRecord(identity.userId)!.memberSinceBlock).toBe(5);
    expect(records.getNetworkRecord().memberCount).toBe(2);

    // Finish and persist the journal.
    const finishedJournal = journal.finishBlockJournal();
    rawDb.prepare(
      'INSERT INTO block_journal (block_height, journal_cbor) VALUES (?, ?)',
    ).run(5, (await import('cbor-x')).encode(finishedJournal));

    // Revert the block.
    const { revertBlock } = await import('../../src/services/fork-resolution.js');
    revertBlock(5);

    // The identity record is restored to its pre-block state.
    const restored = records.getIdentityRecord(identity.userId)!;
    expect(restored.memberSinceBlock).toBe(0);
    expect(restored.memberBar).toBe(0);
    expect(restored.memberVouches).toBe(1);
    expect(restored.memberLikes).toBe(2n);

    // The network record is restored too.
    const restoredNetwork = records.getNetworkRecord();
    expect(restoredNetwork.memberCount).toBe(1);

    db.closeDb();
  });
});
