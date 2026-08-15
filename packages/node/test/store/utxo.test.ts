import {
  fixtureProvenance, uid } from '../helpers.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

import type {
  AnyBox,
  KarmaBox,
  CreditBox,
  InviteBox,
  BondBox,
} from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Dynamic import helpers (reset module-level state between tests)
// ---------------------------------------------------------------------------

async function importDbFresh() {
  const mod = await import('../../src/store/db.js');
  return mod as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

async function importUtxoFresh() {
  const mod = await import('../../src/store/utxo.js');
  return mod as {
    getBox: (boxId: string) => AnyBox | null;
    getKarmaBox: (owner: Uint8Array) => KarmaBox | null;
    getKarmaBoxes: (owner: Uint8Array) => KarmaBox[];
    getCreditBox: (owner: Uint8Array) => CreditBox | null;
    getCreditBoxes: (owner: Uint8Array) => CreditBox[];
    getUnlockedCreditBoxes: (owner: Uint8Array, blockHeight: number) => CreditBox[];
    getOpenInvites: (inviterId: Uint8Array) => InviteBox[];
    getInviteFor: (inviteePublicKey: Uint8Array) => InviteBox | null;
    getBondFor: (inviteePublicKey: Uint8Array) => BondBox | null;
    getBondBoxes: (inviterId: Uint8Array) => BondBox[];
    insertBox: (box: AnyBox, postLockTarget?: string) => void;
    consumeBox: (boxId: string, consumedAtBlock: number) => void;
  };
}

async function importTypes() {
  const mod = await import('@dagsocial/types');
  return mod as {
    computeBoxId: (box: AnyBox) => string;
  };
}

// ---------------------------------------------------------------------------
// Box factory helpers
// ---------------------------------------------------------------------------

function bytes(n: number): Uint8Array {
  return new Uint8Array(randomBytes(n));
}

const OWNER_A = bytes(32);
const OWNER_B = bytes(32);

function makeKarmaBox(overrides: Partial<KarmaBox> = {}): KarmaBox {
  const candidate = {
    boxType: 'karma' as const,
    value: 100n,
    owner: OWNER_A,
    guard: 'owner_signature' as const,
    ...overrides,
  };
  return { id: '', ...candidate, ...fixtureProvenance(candidate, 1) };
}

function makeCreditBox(overrides: Partial<CreditBox> = {}): CreditBox {
  const candidate = {
    boxType: 'credit' as const,
    value: 1000n,
    owner: OWNER_A,
    guard: 'owner_signature' as const,
    ...overrides,
  };
  return { id: '', ...candidate, ...fixtureProvenance(candidate, 1) };
}

function makeInviteBox(overrides: Partial<InviteBox> = {}): InviteBox {
  const candidate = {
    boxType: 'invite' as const,
    value: 0n,
    inviterId: uid('alice-inviter'),
    inviteePublicKey: bytes(32),
    guard: 'invite_dual' as const,
    ...overrides,
  };
  return { id: '', ...candidate, ...fixtureProvenance(candidate, 1) };
}

function makeBondBox(overrides: Partial<BondBox> = {}): BondBox {
  const candidate = {
    boxType: 'bond' as const,
    value: 10n,
    inviterId: uid('alice-inviter'),
    inviteePublicKey: bytes(32),
    guard: 'block_apply' as const,
    ...overrides,
  };
  return { id: '', ...candidate, ...fixtureProvenance(candidate, 1) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('utxo store', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  // --- insertBox + getBox round-trip for all 5 box types -------------------

  it('insertBox + getBox round-trip for KarmaBox', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const box = makeKarmaBox({ value: 200n });
    Object.assign(box, fixtureProvenance(box, 1));
    box.id = computeBoxId(box);
    insertBox(box);

    const result = getBox(box.id!) as KarmaBox;
    expect(result).not.toBeNull();
    expect(result.boxType).toBe('karma');
    expect(result.value).toBe(200n);
    expect(result.owner).toEqual(OWNER_A);
    expect(result.guard).toBe('owner_signature');
    // Provenance is what the row has to carry back: the box id derives from
    // `txId`/`index`, so a row that lost either reconstructs a box that no
    // longer hashes to its own key.
    expect(result.txId).toBe(box.txId);
    expect(result.index).toBe(box.index);
    expect(computeBoxId(result)).toBe(result.id);
  });

  it('insertBox + getBox round-trip preserves decayBurn on KarmaBox', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const box = makeKarmaBox({ value: 100n, decayBurn: true });
    Object.assign(box, fixtureProvenance(box, 1));
    box.id = computeBoxId(box);
    insertBox(box);

    const result = getBox(box.id!) as KarmaBox;
    expect(result).not.toBeNull();
    expect(result.decayBurn).toBe(true);
  });

  it('insertBox + getBox round-trip for CreditBox', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const box = makeCreditBox({ value: 5000n });
    Object.assign(box, fixtureProvenance(box, 1));
    box.id = computeBoxId(box);
    insertBox(box);

    const result = getBox(box.id!) as CreditBox;
    expect(result).not.toBeNull();
    expect(result.boxType).toBe('credit');
    expect(result.value).toBe(5000n);
    expect(result.owner).toEqual(OWNER_A);
    expect(result.guard).toBe('owner_signature');
  });

  it("insertBox throws on the retired 'like' box type — the store has no like arm (T2b)", async () => {
    const { initDb } = await importDbFresh();
    const { insertBox } = await importUtxoFresh();

    initDb(':memory:');

    // Adversarial shape: the type is deleted, but JS callers are untyped.
    // The switch's default must fail loudly, never write a row it cannot
    // read back.
    const relic = {
      boxType: 'like', value: 2n, likerId: uid('liker123'),
      txId: 'aa'.repeat(32), index: 0, id: 'bb'.repeat(32),
    };
    expect(() => insertBox(relic as never)).toThrow(/Unknown box type/);
  });

  it('insertBox + getBox round-trip for InviteBox', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const invitee = bytes(32);
    const box = makeInviteBox({ inviteePublicKey: invitee, inviterId: uid('inviter-alice') });
    Object.assign(box, fixtureProvenance(box, 1));
    box.id = computeBoxId(box);
    insertBox(box);

    const result = getBox(box.id!) as InviteBox;
    expect(result).not.toBeNull();
    expect(result.boxType).toBe('invite');
    expect(result.value).toBe(0n);
    expect(result.inviterId).toEqual(uid('inviter-alice'));
    expect(result.inviteePublicKey).toEqual(invitee);
    expect(result.guard).toBe('invite_dual');
  });

  it('insertBox + getBox round-trip for BondBox', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const inviteePk = bytes(32);
    const box = makeBondBox({
      value: 10n,
      inviterId: uid('inviter-bob'),
      inviteePublicKey: inviteePk,
    });
    Object.assign(box, fixtureProvenance(box, 1));
    box.id = computeBoxId(box);
    insertBox(box);

    const result = getBox(box.id!) as BondBox;
    expect(result).not.toBeNull();
    expect(result.boxType).toBe('bond');
    expect(result.value).toBe(10n);
    expect(result.inviterId).toEqual(uid('inviter-bob'));
    expect(result.inviteePublicKey).toEqual(inviteePk);
    expect(result.guard).toBe('block_apply');
  });

  // --- getBox returns null for unknown id -----------------------------------

  it('getBox returns null for unknown id', async () => {
    const { initDb } = await importDbFresh();
    const { getBox } = await importUtxoFresh();

    initDb(':memory:');

    const result = getBox('nonexistent-box-id');
    expect(result).toBeNull();
  });


  // --- getKarmaBox returns single unspent karma box -------------------------

  it('getKarmaBox returns the single unspent karma box for an owner', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getKarmaBox, consumeBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const box = makeKarmaBox({ value: 75n, owner: OWNER_A });
    Object.assign(box, fixtureProvenance(box, 1));
    box.id = computeBoxId(box);
    insertBox(box);

    // Should find it before consumption
    const found = getKarmaBox(OWNER_A);
    expect(found).not.toBeNull();
    expect(found!.value).toBe(75n);

    // Consume it
    consumeBox(box.id!, 10);

    // Should be gone now
    const gone = getKarmaBox(OWNER_A);
    expect(gone).toBeNull();
  });

  // --- getCreditBox returns single unspent credit box -----------------------

  it('getCreditBox returns the single unspent credit box for an owner', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getCreditBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const box = makeCreditBox({ value: 999n, owner: OWNER_A });
    Object.assign(box, fixtureProvenance(box, 1));
    box.id = computeBoxId(box);
    insertBox(box);

    const found = getCreditBox(OWNER_A);
    expect(found).not.toBeNull();
    expect(found!.value).toBe(999n);

    // Owner without a credit box returns null
    const none = getCreditBox(OWNER_B);
    expect(none).toBeNull();
  });

  // --- getOpenInvites returns the inviter's live invites ---------------------

  it('getOpenInvites returns unspent invite boxes for an inviter', async () => {
    // An invite has no expiry, so unspent IS open — there is no third state to
    // filter on (NODE_INTERFACE → Store).
    const { initDb } = await importDbFresh();
    const { insertBox, getOpenInvites, consumeBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const inv1 = makeInviteBox({ inviterId: uid('alice'), inviteePublicKey: uid('inv-1') });
    Object.assign(inv1, fixtureProvenance(inv1, 1));
    inv1.id = computeBoxId(inv1);
    insertBox(inv1);

    const inv2 = makeInviteBox({ inviterId: uid('alice'), inviteePublicKey: uid('inv-2') });
    Object.assign(inv2, fixtureProvenance(inv2, 1));
    inv2.id = computeBoxId(inv2);
    insertBox(inv2);

    const inv3 = makeInviteBox({ inviterId: uid('bob'), inviteePublicKey: uid('inv-3') });
    Object.assign(inv3, fixtureProvenance(inv3, 1));
    inv3.id = computeBoxId(inv3);
    insertBox(inv3);

    // inv1 claimed or cancelled — either way the box is spent and the invite
    // is no longer open.
    consumeBox(inv1.id!, 7);

    const aliceInvites = getOpenInvites(uid('alice'));
    expect(aliceInvites).toHaveLength(1);
    expect(aliceInvites[0]!.inviteePublicKey).toEqual(uid('inv-2'));

    const bobInvites = getOpenInvites(uid('bob'));
    expect(bobInvites).toHaveLength(1);
    expect(bobInvites[0]!.inviteePublicKey).toEqual(uid('inv-3'));
  });

  // --- getInviteFor / getBondFor resolve a pair by the invitee key -----------

  it('getInviteFor and getBondFor resolve the pair naming a key', async () => {
    // The invitee key IS the pairing: an address is invited once ever, so it
    // names exactly one live pair, and no box id or output index is needed.
    const { initDb } = await importDbFresh();
    const { insertBox, getInviteFor, getBondFor, consumeBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const invitee = uid('the-invitee');
    const other = uid('someone-else');

    const invite = makeInviteBox({ inviterId: uid('alice'), inviteePublicKey: invitee });
    Object.assign(invite, fixtureProvenance(invite, 1));
    invite.id = computeBoxId(invite);
    insertBox(invite);

    const bond = makeBondBox({ inviterId: uid('alice'), inviteePublicKey: invitee });
    Object.assign(bond, fixtureProvenance(bond, 1));
    bond.id = computeBoxId(bond);
    insertBox(bond);

    expect(getInviteFor(invitee)!.id).toBe(invite.id);
    expect(getBondFor(invitee)!.id).toBe(bond.id);

    // A key with no pair resolves to nothing rather than to someone else's.
    expect(getInviteFor(other)).toBeNull();
    expect(getBondFor(other)).toBeNull();

    // Both reads are unspent-only: the claim consumes the invite and leaves the
    // bond live until its deadline, which is exactly the state the settlement
    // sweep runs against.
    consumeBox(invite.id!, 7);
    expect(getInviteFor(invitee)).toBeNull();
    expect(getBondFor(invitee)!.id).toBe(bond.id);
  });

  // --- getBondBoxes returns active bonds ------------------------------------

  it('getBondBoxes returns bond boxes for an inviter', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBondBoxes } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const bond1 = makeBondBox({ inviterId: uid('charlie'), value: 10n });
    Object.assign(bond1, fixtureProvenance(bond1, 1));
    bond1.id = computeBoxId(bond1);
    insertBox(bond1);

    const bond2 = makeBondBox({ inviterId: uid('charlie'), value: 15n });
    Object.assign(bond2, fixtureProvenance(bond2, 1));
    bond2.id = computeBoxId(bond2);
    insertBox(bond2);

    const bond3 = makeBondBox({ inviterId: uid('dave'), value: 20n });
    Object.assign(bond3, fixtureProvenance(bond3, 1));
    bond3.id = computeBoxId(bond3);
    insertBox(bond3);

    const charlieBonds = getBondBoxes(uid('charlie'));
    expect(charlieBonds).toHaveLength(2);
    expect(charlieBonds[0]!.value).toBe(10n);
    expect(charlieBonds[1]!.value).toBe(15n);

    const daveBonds = getBondBoxes(uid('dave'));
    expect(daveBonds).toHaveLength(1);
    expect(daveBonds[0]!.value).toBe(20n);

    // No bonds for unknown inviter
    const none = getBondBoxes(uid('nobody'));
    expect(none).toHaveLength(0);
  });

  // --- consumeBox marks as spent --------------------------------------------

  it('consumeBox marks a box as spent', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertBox, consumeBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const box = makeKarmaBox({ value: 50n });
    Object.assign(box, fixtureProvenance(box, 1));
    box.id = computeBoxId(box);
    insertBox(box);

    consumeBox(box.id!, 99);

    const row = getDb()
      .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
      .get(box.id!) as { spent_at_block: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.spent_at_block).toBe(99);
  });

  // --- getKarmaBoxes returns all unspent karma boxes sorted by value desc -----

  it('getKarmaBoxes returns all unspent karma boxes sorted value desc', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getKarmaBoxes, consumeBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const owner = bytes(32);
    const box1 = makeKarmaBox({ value: 100n, owner });
    Object.assign(box1, fixtureProvenance(box1, 1));
    box1.id = computeBoxId(box1);
    insertBox(box1);

    const box2 = makeKarmaBox({ value: 200n, owner });
    Object.assign(box2, fixtureProvenance(box2, 1));
    box2.id = computeBoxId(box2);
    insertBox(box2);

    const box3 = makeKarmaBox({ value: 50n, owner });
    Object.assign(box3, fixtureProvenance(box3, 1));
    box3.id = computeBoxId(box3);
    insertBox(box3);

    // Consume box2 — it should be excluded
    consumeBox(box2.id!, 5);

    const results = getKarmaBoxes(owner);
    expect(results).toHaveLength(2);
    // Sorted value desc: 100, 50
    expect(results[0]!.value).toBe(100n);
    expect(results[1]!.value).toBe(50n);
  });

  it('getKarmaBoxes returns empty array for unknown owner', async () => {
    const { initDb } = await importDbFresh();
    const { getKarmaBoxes } = await importUtxoFresh();

    initDb(':memory:');

    const results = getKarmaBoxes(bytes(32));
    expect(results).toEqual([]);
  });

  it('getKarmaBoxes excludes boxes owned by other users', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getKarmaBoxes } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const alice = bytes(32).fill(0xaa);
    const bob = bytes(32).fill(0xbb);

    const aliceBox = makeKarmaBox({ value: 100n, owner: alice });
    Object.assign(aliceBox, fixtureProvenance(aliceBox, 1));
    aliceBox.id = computeBoxId(aliceBox);
    insertBox(aliceBox);

    const bobBox = makeKarmaBox({ value: 200n, owner: bob });
    Object.assign(bobBox, fixtureProvenance(bobBox, 1));
    bobBox.id = computeBoxId(bobBox);
    insertBox(bobBox);

    const results = getKarmaBoxes(alice);
    expect(results).toHaveLength(1);
    expect(results[0]!.value).toBe(100n);
  });

  // --- getCreditBoxes return all unspent credit boxes sorted by value desc ----

  it('getCreditBoxes returns all unspent credit boxes sorted value desc', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getCreditBoxes, consumeBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const owner = bytes(32);
    const box1 = makeCreditBox({ value: 300n, owner });
    Object.assign(box1, fixtureProvenance(box1, 1));
    box1.id = computeBoxId(box1);
    insertBox(box1);

    const box2 = makeCreditBox({ value: 500n, owner });
    Object.assign(box2, fixtureProvenance(box2, 1));
    box2.id = computeBoxId(box2);
    insertBox(box2);

    // Consume box1 — it should be excluded
    consumeBox(box1.id!, 5);

    const results = getCreditBoxes(owner);
    expect(results).toHaveLength(1);
    expect(results[0]!.value).toBe(500n);
  });

  it('getCreditBoxes returns empty array for unknown owner', async () => {
    const { initDb } = await importDbFresh();
    const { getCreditBoxes } = await importUtxoFresh();

    initDb(':memory:');

    const results = getCreditBoxes(bytes(32));
    expect(results).toEqual([]);
  });

  // --- getUnlockedCreditBoxes filters out locked boxes ------------------------

  it('getUnlockedCreditBoxes excludes locked boxes', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getUnlockedCreditBoxes } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const owner = bytes(32);
    const currentHeight = 100;

    const box1 = makeCreditBox({ value: 300n, owner });
    Object.assign(box1, fixtureProvenance(box1, 1));
    box1.id = computeBoxId(box1);
    insertBox(box1);

    const box2 = makeCreditBox({ value: 500n, owner });
    box2.lockedUntilBlock = 150;
    Object.assign(box2, fixtureProvenance(box2, 1));
    box2.id = computeBoxId(box2);
    insertBox(box2);

    const box3 = makeCreditBox({ value: 200n, owner });
    box3.lockedUntilBlock = 50;
    Object.assign(box3, fixtureProvenance(box3, 1));
    box3.id = computeBoxId(box3);
    insertBox(box3);

    const box4 = makeCreditBox({ value: 100n, owner });
    Object.assign(box4, fixtureProvenance(box4, 1));
    box4.id = computeBoxId(box4);
    insertBox(box4);

    const results = getUnlockedCreditBoxes(owner, currentHeight);
    expect(results).toHaveLength(3);
    expect(results[0]!.value).toBe(300n);
    expect(results[1]!.value).toBe(200n);
    expect(results[2]!.value).toBe(100n);
  });

  it('getUnlockedCreditBoxes returns empty array when all boxes are locked', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getUnlockedCreditBoxes } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const owner = bytes(32);
    const box = makeCreditBox({ value: 500n, owner });
    box.lockedUntilBlock = 200;
    Object.assign(box, fixtureProvenance(box, 1));
    box.id = computeBoxId(box);
    insertBox(box);

    const results = getUnlockedCreditBoxes(owner, 100);
    expect(results).toEqual([]);
  });

  it('getUnlockedCreditBoxes returns empty array for unknown owner', async () => {
    const { initDb } = await importDbFresh();
    const { getUnlockedCreditBoxes } = await importUtxoFresh();

    initDb(':memory:');

    const results = getUnlockedCreditBoxes(bytes(32), 100);
    expect(results).toEqual([]);
  });
});
