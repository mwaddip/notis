import {
  fixtureProvenance, uid } from '../helpers.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

import type {
  AnyBox,
  KarmaBox,
  CreditBox,
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
    getCreditBoxes: (owner: Uint8Array) => CreditBox[];
    getBondFor: (inviteePublicKey: Uint8Array) => BondBox | null;
    insertBox: (box: AnyBox, postLockTarget?: string) => void;
    consumeBox: (boxId: string, consumedAtBlock: number) => void;
    BoxNotLiveError: new (boxId: string) => Error & { readonly boxId: string };
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
    createdAtBlock: 0,
    owner: OWNER_A,
    ...overrides,
  };
  return { id: '', ...candidate, ...fixtureProvenance(candidate, 1) };
}

function makeCreditBox(overrides: Partial<CreditBox> = {}): CreditBox {
  const candidate = {
    boxType: 'credit' as const,
    value: 1000n,
    createdAtBlock: 0,
    owner: OWNER_A,
    ...overrides,
  };
  return { id: '', ...candidate, ...fixtureProvenance(candidate, 1) };
}

function makeBondBox(overrides: Partial<BondBox> = {}): BondBox {
  const candidate = {
    boxType: 'bond' as const,
    value: 10n,
    createdAtBlock: 0,
    inviterId: uid('alice-inviter'),
    inviteePublicKey: bytes(32),
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
    // Provenance is what the row has to carry back: the box id derives from
    // `txId`/`index`, so a row that lost either reconstructs a box that no
    // longer hashes to its own key.
    expect(result.txId).toBe(box.txId);
    expect(result.index).toBe(box.index);
    expect(computeBoxId(result)).toBe(result.id);
  });

  it('insertBox + getBox round-trip preserves nonActivity on KarmaBox', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const box = makeKarmaBox({ value: 100n, nonActivity: true });
    Object.assign(box, fixtureProvenance(box, 1));
    box.id = computeBoxId(box);
    insertBox(box);

    const result = getBox(box.id!) as KarmaBox;
    expect(result).not.toBeNull();
    expect(result.nonActivity).toBe(true);
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

  // --- getCreditBoxes returns unspent credit boxes in total order ------------

  it('getCreditBoxes returns boxes for an owner and empty for another', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getCreditBoxes } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const box = makeCreditBox({ value: 999n, owner: OWNER_A });
    Object.assign(box, fixtureProvenance(box, 1));
    box.id = computeBoxId(box);
    insertBox(box);

    const found = getCreditBoxes(OWNER_A);
    expect(found).toHaveLength(1);
    expect(found[0]!.value).toBe(999n);

    // Owner without a credit box returns empty array
    const none = getCreditBoxes(OWNER_B);
    expect(none).toHaveLength(0);
  });

  it('getCreditBoxes breaks equal-value ties by id', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getCreditBoxes } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const boxA = makeCreditBox({ value: 500n, owner: OWNER_A });
    Object.assign(boxA, fixtureProvenance(boxA, 1));
    boxA.id = computeBoxId(boxA);
    insertBox(boxA);

    const boxB = makeCreditBox({ value: 500n, owner: OWNER_A });
    Object.assign(boxB, fixtureProvenance(boxB, 2));
    boxB.id = computeBoxId(boxB);
    insertBox(boxB);

    const boxes = getCreditBoxes(OWNER_A);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.value).toBe(500n);
    expect(boxes[1]!.value).toBe(500n);
    // Equal value → ascending id tiebreak
    expect(boxes[0]!.id! < boxes[1]!.id!).toBe(true);
  });


  // --- getBondFor resolves a bond by the invitee key ------------------------

  it('getBondFor resolves the bond naming a key', async () => {
    // ⛔ **The invitee key IS the pairing, and the bond is the only box in
    // it** — an address is invited once ever, so it names exactly one live bond
    // and no box id or output index is needed (ARCHITECTURE → Invite System).
    const { initDb } = await importDbFresh();
    const { insertBox, getBondFor, consumeBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const invitee = uid('the-invitee');
    const other = uid('someone-else');

    const bond = makeBondBox({ inviterId: uid('alice'), inviteePublicKey: invitee });
    Object.assign(bond, fixtureProvenance(bond, 1));
    bond.id = computeBoxId(bond);
    insertBox(bond);

    expect(getBondFor(invitee)!.id).toBe(bond.id);

    // A key with no bond resolves to nothing rather than to someone else's.
    expect(getBondFor(other)).toBeNull();

    // Unspent-only: the probation-deadline settlement consumes the bond, and
    // from that point the key names none.
    consumeBox(bond.id!, 7);
    expect(getBondFor(invitee)).toBeNull();
  });

  // --- getBondBoxesPage returns unspent bonds ---------------------------------

  it('getBondBoxesPage returns unspent bond boxes for an inviter', async () => {
    const { initDb } = await importDbFresh();
    const utxo = await import('../../src/store/utxo.js');
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const bond1 = makeBondBox({ inviterId: uid('charlie'), value: 10n });
    Object.assign(bond1, fixtureProvenance(bond1, 1));
    bond1.id = computeBoxId(bond1);
    utxo.insertBox(bond1);

    const bond2 = makeBondBox({ inviterId: uid('charlie'), value: 15n });
    Object.assign(bond2, fixtureProvenance(bond2, 1));
    bond2.id = computeBoxId(bond2);
    utxo.insertBox(bond2);

    const bond3 = makeBondBox({ inviterId: uid('dave'), value: 20n });
    Object.assign(bond3, fixtureProvenance(bond3, 1));
    bond3.id = computeBoxId(bond3);
    utxo.insertBox(bond3);

    const charlieResult = utxo.getBondBoxesPage(uid('charlie'), { limit: 50 });
    expect(charlieResult.rows).toHaveLength(2);
    expect(charlieResult.count).toBe(2);

    const daveResult = utxo.getBondBoxesPage(uid('dave'), { limit: 50 });
    expect(daveResult.rows).toHaveLength(1);
    expect(daveResult.count).toBe(1);

    const noneResult = utxo.getBondBoxesPage(uid('nobody'), { limit: 50 });
    expect(noneResult.rows).toHaveLength(0);
    expect(noneResult.count).toBe(0);
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

  // --- consumeBox refuses a box the store does not hold live -----------------
  //
  // Both arms the guard covers — an absent id and an already-spent one
  // (NODE_INTERFACE → Store Interface, the `consumeBox` row). A box this node
  // holds no live row for costs the block, never the node, so the throw must
  // NOT be a `CorruptChainStateError`: the apply funnel's totality catch turns
  // it into a rejection, and a member of that family would exit the process.

  it('consumeBox on an id no row holds throws BoxNotLiveError naming it', async () => {
    const { initDb } = await importDbFresh();
    const { consumeBox, BoxNotLiveError } = await importUtxoFresh();
    const { CorruptChainStateError } = (await import(
      '../../src/services/corrupt-state.js'
    )) as { CorruptChainStateError: abstract new (...args: never[]) => Error };

    initDb(':memory:');

    expect(() => consumeBox('no-such-box', 7)).toThrow(BoxNotLiveError);
    try {
      consumeBox('no-such-box', 7);
      expect.unreachable('consumeBox accepted an absent id');
    } catch (err) {
      expect((err as { boxId: string }).boxId).toBe('no-such-box');
      expect(err).not.toBeInstanceOf(CorruptChainStateError);
    }
  });

  it('a second consume throws and leaves the first spend height in place', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertBox, consumeBox, BoxNotLiveError } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const box = makeKarmaBox({ value: 50n });
    Object.assign(box, fixtureProvenance(box, 1));
    box.id = computeBoxId(box);
    insertBox(box);

    consumeBox(box.id!, 12);
    expect(() => consumeBox(box.id!, 34)).toThrow(BoxNotLiveError);

    // The height the FIRST spend wrote. A row-count check without the
    // `spent_at_block IS NULL` predicate would match this row again and
    // overwrite it with 34 rather than refusing — this is the assertion that
    // tells the two halves apart.
    const row = getDb()
      .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
      .get(box.id!) as { spent_at_block: number } | undefined;
    expect(row!.spent_at_block).toBe(12);
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

  // --- page reads: order and count -------------------------------------------

  it('getKarmaBoxesPage returns one page with count over the whole set', async () => {
    const { initDb } = await importDbFresh();
    const utxo = await import('../../src/store/utxo.js');
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const owner = bytes(32);
    const ids: string[] = [];
    for (const v of [300n, 100n, 200n]) {
      const box = makeKarmaBox({ value: v, owner });
      Object.assign(box, fixtureProvenance(box, 1));
      box.id = computeBoxId(box);
      utxo.insertBox(box);
      ids.push(box.id);
    }

    const result = utxo.getKarmaBoxesPage(owner, { limit: 2 });
    expect(result.count).toBe(3);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.value).toBe(300n);
    expect(result.rows[1]!.value).toBe(200n);
    expect(result.next).not.toBeNull();
  });

  it('getCreditBoxesPage returns one page with count over the whole set', async () => {
    const { initDb } = await importDbFresh();
    const utxo = await import('../../src/store/utxo.js');
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const owner = bytes(32);
    for (const v of [50n, 150n, 250n]) {
      const box = makeCreditBox({ value: v, owner });
      Object.assign(box, fixtureProvenance(box, 1));
      box.id = computeBoxId(box);
      utxo.insertBox(box);
    }

    const result = utxo.getCreditBoxesPage(owner, { limit: 2 });
    expect(result.count).toBe(3);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.value).toBe(250n);
    expect(result.rows[1]!.value).toBe(150n);
    expect(result.next).not.toBeNull();
  });

  it('getBondBoxesPage lists unspent bonds only, ascending id, with count', async () => {
    const { initDb } = await importDbFresh();
    const utxo = await import('../../src/store/utxo.js');
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const inviter = uid('bond-page-inviter');
    const bonds: BondBox[] = [];
    for (let i = 0; i < 3; i++) {
      const box = makeBondBox({ inviterId: inviter, value: BigInt(10 + i) });
      Object.assign(box, fixtureProvenance(box, 1));
      box.id = computeBoxId(box);
      utxo.insertBox(box);
      bonds.push(box);
    }

    // Settle one bond
    utxo.consumeBox(bonds[1]!.id!, 5);

    const result = utxo.getBondBoxesPage(inviter, { limit: 50 });
    expect(result.count).toBe(2);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.find(b => b.id === bonds[1]!.id)).toBeUndefined();

    // Ascending id
    const resultIds = result.rows.map(b => b.id!);
    expect(resultIds).toEqual([...resultIds].sort());
  });

  // --- keyset pins ---

  it('karma page continuation across an insert: no overlap, no gap', async () => {
    const { initDb } = await importDbFresh();
    const utxo = await import('../../src/store/utxo.js');
    const { computeBoxId } = await importTypes();

    initDb(':memory:');
    const owner = bytes(32);
    for (const v of [400n, 300n, 200n, 100n]) {
      const box = makeKarmaBox({ value: v, owner });
      Object.assign(box, fixtureProvenance(box, 1));
      box.id = computeBoxId(box);
      utxo.insertBox(box);
    }

    const page1 = utxo.getKarmaBoxesPage(owner, { limit: 2 });
    expect(page1.rows.map(b => b.value)).toEqual([400n, 300n]);
    expect(page1.next).not.toBeNull();

    const insert = makeKarmaBox({ value: 350n, owner });
    Object.assign(insert, fixtureProvenance(insert, 1));
    insert.id = computeBoxId(insert);
    utxo.insertBox(insert);

    const page2 = utxo.getKarmaBoxesPage(owner, { limit: 2, after: page1.next! });
    const page2Values = page2.rows.map(b => b.value);
    expect(page2Values).not.toContainEqual(400n);
    expect(page2Values).not.toContainEqual(300n);
    expect(page2Values).toContainEqual(200n);
  });

  it('karma page continuation across a spend: no skip', async () => {
    const { initDb } = await importDbFresh();
    const utxo = await import('../../src/store/utxo.js');
    const { computeBoxId } = await importTypes();

    initDb(':memory:');
    const owner = bytes(32);
    const boxes: KarmaBox[] = [];
    for (const v of [400n, 300n, 200n, 100n]) {
      const box = makeKarmaBox({ value: v, owner });
      Object.assign(box, fixtureProvenance(box, 1));
      box.id = computeBoxId(box);
      utxo.insertBox(box);
      boxes.push(box);
    }

    const page1 = utxo.getKarmaBoxesPage(owner, { limit: 2 });
    expect(page1.next).not.toBeNull();

    utxo.consumeBox(boxes[1]!.id!, 5);

    const page2 = utxo.getKarmaBoxesPage(owner, { limit: 2, after: page1.next! });
    expect(page2.rows.map(b => b.value)).toEqual([200n, 100n]);
  });

  it('exact next: exactly limit rows → null; limit + 1 → the limit-th key', async () => {
    const { initDb } = await importDbFresh();
    const utxo = await import('../../src/store/utxo.js');
    const { computeBoxId } = await importTypes();

    initDb(':memory:');
    const owner = bytes(32);
    for (const v of [200n, 100n]) {
      const box = makeKarmaBox({ value: v, owner });
      Object.assign(box, fixtureProvenance(box, 1));
      box.id = computeBoxId(box);
      utxo.insertBox(box);
    }
    const exact = utxo.getKarmaBoxesPage(owner, { limit: 2 });
    expect(exact.next).toBeNull();

    const extra = makeKarmaBox({ value: 50n, owner });
    Object.assign(extra, fixtureProvenance(extra, 1));
    extra.id = computeBoxId(extra);
    utxo.insertBox(extra);
    const withExtra = utxo.getKarmaBoxesPage(owner, { limit: 2 });
    expect(withExtra.next).not.toBeNull();
    expect(withExtra.next!.value).toBe(100n);
  });

  it('exact next on bond page', async () => {
    const { initDb } = await importDbFresh();
    const utxo = await import('../../src/store/utxo.js');
    const { computeBoxId } = await importTypes();

    initDb(':memory:');
    const inviter = uid('exact-bond');
    const bonds: BondBox[] = [];
    for (let i = 0; i < 2; i++) {
      const box = makeBondBox({ inviterId: inviter, value: BigInt(10 + i) });
      Object.assign(box, fixtureProvenance(box, 1));
      box.id = computeBoxId(box);
      utxo.insertBox(box);
      bonds.push(box);
    }
    const exact = utxo.getBondBoxesPage(inviter, { limit: 2 });
    expect(exact.next).toBeNull();

    const extra = makeBondBox({ inviterId: inviter, value: 20n });
    Object.assign(extra, fixtureProvenance(extra, 1));
    extra.id = computeBoxId(extra);
    utxo.insertBox(extra);
    const withExtra = utxo.getBondBoxesPage(inviter, { limit: 2 });
    expect(withExtra.next).not.toBeNull();
  });

  it('getKarmaTotal equals getKarmaValue on an owner with three boxes', async () => {
    const { initDb } = await importDbFresh();
    const utxo = await import('../../src/store/utxo.js');
    const { computeBoxId } = await importTypes();

    initDb(':memory:');
    const owner = bytes(32);
    for (const v of [100n, 200n, 300n]) {
      const box = makeKarmaBox({ value: v, owner });
      Object.assign(box, fixtureProvenance(box, 1));
      box.id = computeBoxId(box);
      utxo.insertBox(box);
    }
    expect(utxo.getKarmaTotal(owner)).toBe(utxo.getKarmaValue(owner));
    expect(utxo.getKarmaTotal(owner)).toBe(600n);
  });

  it('EXPLAIN QUERY PLAN: box pages use two-range form with after, SUMs and COUNTs use the owner index', async () => {
    const { initDb, getDb } = await importDbFresh();
    initDb(':memory:');
    const db = getDb();
    const owner = Buffer.from(bytes(32));
    const id = 'aa'.repeat(32);
    const limit = 11;

    const afterPlan = db.prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM (
         SELECT * FROM utxo_boxes WHERE owner = ? AND box_type = 'karma' AND spent_at_block IS NULL AND value = ? AND id > ? ORDER BY id LIMIT ?
       ) UNION ALL SELECT * FROM (
         SELECT * FROM utxo_boxes WHERE owner = ? AND box_type = 'karma' AND spent_at_block IS NULL AND value < ? ORDER BY value DESC, id LIMIT ?
       ) ORDER BY value DESC, id LIMIT ?`,
    ).all(owner, 100, id, limit, owner, 100, limit, limit) as Array<{ detail: string }>;
    const afterDetail = afterPlan.map(r => r.detail).join(' ');
    expect(afterDetail).toContain('value=? AND id>?');
    expect(afterDetail).toContain('value<?');

    const noAfterPlan = db.prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM utxo_boxes WHERE owner = ? AND box_type = 'credit' AND spent_at_block IS NULL ORDER BY value DESC, id LIMIT ?`,
    ).all(owner, limit) as Array<{ detail: string }>;
    expect(noAfterPlan.some(r => r.detail.includes('idx_utxo_boxes_owner_type_value'))).toBe(true);

    const sumAndCountPlans = [
      db.prepare(`EXPLAIN QUERY PLAN SELECT COALESCE(SUM(value), 0) AS s FROM utxo_boxes WHERE owner = ? AND box_type = 'karma' AND spent_at_block IS NULL`).all(owner),
      db.prepare(`EXPLAIN QUERY PLAN SELECT COALESCE(SUM(value), 0) AS s FROM utxo_boxes WHERE owner = ? AND box_type = 'credit' AND spent_at_block IS NULL`).all(owner),
      db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) AS cnt FROM utxo_boxes WHERE owner = ? AND box_type = 'karma' AND spent_at_block IS NULL`).all(owner),
      db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) AS cnt FROM utxo_boxes WHERE owner = ? AND box_type = 'credit' AND spent_at_block IS NULL`).all(owner),
    ];
    for (const plan of sumAndCountPlans) {
      expect((plan as Array<{ detail: string }>).some(r => r.detail.includes('idx_utxo_boxes_owner_type_value'))).toBe(true);
    }
  });

  it('EXPLAIN QUERY PLAN: bond pages use idx_utxo_boxes_bond_inviter', async () => {
    const { initDb, getDb } = await importDbFresh();
    initDb(':memory:');
    const db = getDb();
    const hex = 'aa'.repeat(32);

    const pagePlan = db.prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM utxo_boxes WHERE box_type = 'bond' AND spent_at_block IS NULL AND json_extract(extra_data, '$.inviterId') = ? AND id > ? ORDER BY id LIMIT ?`,
    ).all(hex, hex, 11) as Array<{ detail: string }>;
    expect(pagePlan.some(r => r.detail.includes('idx_utxo_boxes_bond_inviter'))).toBe(true);

    const countPlan = db.prepare(
      `EXPLAIN QUERY PLAN SELECT COUNT(*) AS cnt FROM utxo_boxes WHERE box_type = 'bond' AND spent_at_block IS NULL AND json_extract(extra_data, '$.inviterId') = ?`,
    ).all(hex) as Array<{ detail: string }>;
    expect(countPlan.some(r => r.detail.includes('idx_utxo_boxes_bond_inviter'))).toBe(true);
  });

  it('EXPLAIN QUERY PLAN: vouch pages use idx_utxo_boxes_vouch_target', async () => {
    const { initDb, getDb } = await importDbFresh();
    initDb(':memory:');
    const db = getDb();
    const hex = 'aa'.repeat(32);

    const pagePlan = db.prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM utxo_boxes WHERE box_type = 'vouch' AND spent_at_block IS NULL AND json_extract(extra_data, '$.targetId') = ? AND id > ? ORDER BY id LIMIT ?`,
    ).all(hex, hex, 11) as Array<{ detail: string }>;
    expect(pagePlan.some(r => r.detail.includes('idx_utxo_boxes_vouch_target'))).toBe(true);

    const countPlan = db.prepare(
      `EXPLAIN QUERY PLAN SELECT COUNT(*) AS cnt FROM utxo_boxes WHERE box_type = 'vouch' AND spent_at_block IS NULL AND json_extract(extra_data, '$.targetId') = ?`,
    ).all(hex) as Array<{ detail: string }>;
    expect(countPlan.some(r => r.detail.includes('idx_utxo_boxes_vouch_target'))).toBe(true);
  });
});
