import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { UserId } from '@dagsocial/types';
import type { IdentityRecord } from '../../src/store/identity-records.js';
import {
  GENESIS_KARMA_POOL,
  genesisCommitteeContext,
  genesisContext,
  mintTxIdFor,
} from '../../src/mint-provenance.js';

/**
 * Genesis committee seeding, and the karma supply pool it draws from.
 *
 * ⛔ **Every test here seeds at least TWO members, and that is the point.**
 * `genesis` keys on `u32BE(k)` — one number per genesis box — so N members
 * seeded under one selector derive one synthetic txId, one `computeBoxId`
 * preimage, and the second insert violates `UNIQUE(tx_id, output_index)`
 * (NODE_INTERFACE → Reason and subject table). All three network profiles ship
 * `genesisCommitteeKeys: []`, so a one-member test — and every test that runs
 * under a real profile — passes just as well against the colliding
 * implementation. Two members is the smallest fixture that can tell them apart.
 */

async function importFresh() {
  const db = (await import('../../src/store/db.js')) as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
  };
  const system = await import('../../src/store/system.js');
  const records = (await import('../../src/store/identity-records.js')) as {
    getIdentityRecord: (id: UserId) => IdentityRecord | null;
  };
  const utxo = await import('../../src/store/utxo.js');
  return { ...db, system, records, utxo };
}

/** Two distinct 32-byte keys, hex — the profile's own form. */
const MEMBER_A = 'a1'.repeat(32);
const MEMBER_B = 'b2'.repeat(32);
const MEMBER_C = 'c3'.repeat(32);

const bytesOf = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));

const GRANT = 1_000n;

describe('genesis committee seeding', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('two members get two karma boxes, and the ids do not collide', async () => {
    const s = await importFresh();
    s.initDb(':memory:');

    const granted = s.system.seedGenesisCommittee([MEMBER_A, MEMBER_B], GRANT, 0);

    expect(granted).toBe(2n * GRANT);

    const a = s.utxo.getKarmaBox(bytesOf(MEMBER_A));
    const b = s.utxo.getKarmaBox(bytesOf(MEMBER_B));
    expect(a, 'member A holds no karma box').not.toBeNull();
    expect(b, 'member B holds no karma box').not.toBeNull();
    expect(a!.value).toBe(GRANT);
    expect(b!.value).toBe(GRANT);

    // The two halves of the collision the `genesis` selector would produce: one
    // synthetic txId, therefore one box id. Both are asserted, because the
    // UNIQUE constraint is on the txId pair while the PRIMARY KEY is on the id
    // — a fixture that checked only one would leave the other unexplained.
    expect(a!.txId).not.toBe(b!.txId);
    expect(a!.id).not.toBe(b!.id);
    expect(a!.index).toBe(b!.index);
  });

  it('the subject is the member, so the txId is the one keyed on them', async () => {
    const s = await importFresh();
    s.initDb(':memory:');

    s.system.seedGenesisCommittee([MEMBER_A, MEMBER_B], GRANT, 0);

    // Height 0 is clamped to 1 — a synthetic mint txId commits to a height, and
    // no block ever settles at 0.
    expect(s.utxo.getKarmaBox(bytesOf(MEMBER_A))!.txId)
      .toBe(mintTxIdFor(genesisCommitteeContext(bytesOf(MEMBER_A)), 1));
    expect(s.utxo.getKarmaBox(bytesOf(MEMBER_B))!.txId)
      .toBe(mintTxIdFor(genesisCommitteeContext(bytesOf(MEMBER_B)), 1));
  });

  it('the colliding implementation is a real shape — one selector, one txId', () => {
    // ⛔ **The witness for the rule above, and the reason it is a rule.** This
    // asserts what a `genesisContext`-keyed seeder would have derived: the same
    // txId for every member, at any height. Nothing in the profiles reaches it,
    // so without this the collision is only ever described in prose.
    const viaSelector = [MEMBER_A, MEMBER_B, MEMBER_C].map(
      () => mintTxIdFor(genesisContext(GENESIS_KARMA_POOL), 1),
    );
    expect(new Set(viaSelector).size).toBe(1);

    const viaMember = [MEMBER_A, MEMBER_B, MEMBER_C].map((k) =>
      mintTxIdFor(genesisCommitteeContext(bytesOf(k)), 1),
    );
    expect(new Set(viaMember).size).toBe(3);
  });

  it('three members still do not collide — the pairwise property, not a two-case one', async () => {
    const s = await importFresh();
    s.initDb(':memory:');

    const granted = s.system.seedGenesisCommittee([MEMBER_A, MEMBER_B, MEMBER_C], GRANT, 0);
    expect(granted).toBe(3n * GRANT);

    const ids = [MEMBER_A, MEMBER_B, MEMBER_C].map(
      (k) => s.utxo.getKarmaBox(bytesOf(k))!.id,
    );
    expect(new Set(ids).size).toBe(3);
  });

  it('every member gets an identity record, so decay does not read "never active"', async () => {
    const s = await importFresh();
    s.initDb(':memory:');

    s.system.seedGenesisCommittee([MEMBER_A, MEMBER_B], GRANT, 500);

    for (const member of [MEMBER_A, MEMBER_B]) {
      expect(s.records.getIdentityRecord(bytesOf(member)), member).toEqual({
        lastActivityBlock: 500,
        lastDecayBlock: 0,
        invitedAtBlock: 0,
        lifetimeLikesReceived: 0n,
        memberSinceBlock: 500,
        memberBar: 0,
        memberVouches: 0,
        memberLikes: 0n,
        invitesUsed: 0,
      });
    }
  });

  it('an empty committee grants nothing and writes nothing — the profiles as they ship', async () => {
    const s = await importFresh();
    s.initDb(':memory:');

    expect(s.system.seedGenesisCommittee([], GRANT, 0)).toBe(0n);
    expect(s.utxo.getUnspentBoxes()).toHaveLength(0);
  });

  it('refuses a key that is not 32 bytes, naming it', async () => {
    const s = await importFresh();
    s.initDb(':memory:');

    expect(() => s.system.seedGenesisCommittee([MEMBER_A, 'aabb'], GRANT, 0))
      .toThrow(/is 2 bytes, not 32/);
  });

  it('is idempotent — a second call grants nothing further', async () => {
    const s = await importFresh();
    s.initDb(':memory:');

    expect(s.system.seedGenesisCommittee([MEMBER_A, MEMBER_B], GRANT, 0)).toBe(2n * GRANT);
    expect(s.system.seedGenesisCommittee([MEMBER_A, MEMBER_B], GRANT, 0)).toBe(0n);
    expect(s.utxo.getUnspentBoxes()).toHaveLength(2);
  });
});

describe('the karma supply pool draws the grants out of the total', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('two members: the pool holds the total less both grants', async () => {
    const s = await importFresh();
    s.initDb(':memory:');

    const granted = s.system.seedGenesisCommittee([MEMBER_A, MEMBER_B], GRANT, 0);
    const pool = s.system.ensureKarmaPoolBox(granted, 0);

    // ⛔ **The arithmetic the real profiles cannot exercise.** All three ship an
    // empty committee, so `granted` is 0 and `TOTAL - 0` equals `TOTAL` — the
    // subtraction is untested by every test that runs under a profile.
    expect(pool.value).toBe(s.system.KARMA_SUPPLY_TOTAL - 2n * GRANT);
  });

  it('the invariant holds: pool plus circulating karma is the whole supply', async () => {
    const s = await importFresh();
    s.initDb(':memory:');

    const granted = s.system.seedGenesisCommittee([MEMBER_A, MEMBER_B, MEMBER_C], GRANT, 0);
    const pool = s.system.ensureKarmaPoolBox(granted, 0);

    // Summed from the store rather than from `granted`, so this is not the
    // seeder's own arithmetic restated: what must hold is that the boxes the
    // ledger actually holds add up (TYPES_INTERFACE → KarmaPoolBox).
    const circulating = [MEMBER_A, MEMBER_B, MEMBER_C]
      .map((k) => s.utxo.getKarmaBox(bytesOf(k))!.value)
      .reduce((sum, v) => sum + v, 0n);

    expect(pool.value + circulating).toBe(s.system.KARMA_SUPPLY_TOTAL);
  });

  it('a zero-value pool IS created — the one place the emission rule inverts', async () => {
    const s = await importFresh();
    s.initDb(':memory:');

    // Granting the whole supply leaves the pool empty, and the box still
    // exists: burns must always have somewhere to return, so the pool never
    // terminates. `ensureEmissionBox`'s rule is the opposite and does not apply
    // here (TYPES_INTERFACE → KarmaPoolBox).
    const pool = s.system.ensureKarmaPoolBox(s.system.KARMA_SUPPLY_TOTAL, 0);

    expect(pool.value).toBe(0n);
    expect(s.utxo.getKarmaPoolBox()).not.toBeNull();
    expect(s.utxo.getKarmaPoolBox()!.value).toBe(0n);
  });

  it('refuses a grant total above the supply, naming the pool rather than the encoder', async () => {
    const s = await importFresh();
    s.initDb(':memory:');

    expect(() => s.system.ensureKarmaPoolBox(s.system.KARMA_SUPPLY_TOTAL + 1n, 0))
      .toThrow(/more than the .* a network can hold/);
  });

  it('the pool is not a karma box — it answers no owner lookup', async () => {
    const s = await importFresh();
    s.initDb(':memory:');

    s.system.ensureKarmaPoolBox(0n, 0);

    // ⛔ Giving the pool the `karma` type would put the maximum supply inside
    // every balance query (TYPES_INTERFACE → KarmaPoolBox). It has no owner, so
    // there is no key it could answer for — asserted against the ledger rather
    // than against the type.
    const karmaRows = s
      .getDb()
      .prepare("SELECT COUNT(*) AS c FROM utxo_boxes WHERE box_type = 'karma'")
      .get() as { c: number };
    expect(karmaRows.c).toBe(0);
    expect(s.utxo.getUnspentBoxes()).toHaveLength(1);
  });
});
