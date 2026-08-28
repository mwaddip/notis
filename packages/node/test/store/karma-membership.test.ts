import { fixtureProvenance } from '../helpers.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

import type {
  AnyBox,
  KarmaBox,
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
    insertBox: (box: AnyBox) => void;
    consumeBox: (boxId: string, consumedAtBlock: number) => void;
    unconsumeBox: (boxId: string) => void;
    deleteBox: (boxId: string) => void;
    getKarmaOwners: () => string[];
    registerKarmaMembershipHook: (hook: {
      onGain: (ownerHex: string) => void;
      onLoss: (ownerHex: string) => void;
    }) => void;
  };
}

async function importTypes() {
  const mod = await import('@dagsocial/types');
  return mod as { computeBoxId: (box: AnyBox) => string };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytes(n: number): Uint8Array {
  return new Uint8Array(randomBytes(n));
}

const OWNER_A = bytes(32);
const OWNER_B = bytes(32);

function ownerHex(owner: Uint8Array): string {
  return Buffer.from(owner).toString('hex');
}

function makeKarmaBox(overrides: Partial<KarmaBox> = {}): KarmaBox {
  const candidate = {
    boxType: 'karma' as const,
    value: 100n,
    createdAtBlock: 1,
    owner: OWNER_A,
    ...overrides,
  };
  return { id: '', ...candidate, ...fixtureProvenance(candidate, 1) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('karma membership hook', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('getKarmaOwners returns distinct owners of unspent karma boxes', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getKarmaOwners, consumeBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const boxA1 = makeKarmaBox({ owner: OWNER_A });
    boxA1.id = computeBoxId(boxA1);
    insertBox(boxA1);

    const boxA2 = makeKarmaBox({ owner: OWNER_A, value: 200n });
    Object.assign(boxA2, fixtureProvenance(boxA2, 2));
    boxA2.id = computeBoxId(boxA2);
    insertBox(boxA2);

    const boxB = makeKarmaBox({ owner: OWNER_B, value: 50n });
    Object.assign(boxB, fixtureProvenance(boxB, 1));
    boxB.id = computeBoxId(boxB);
    insertBox(boxB);

    const owners = getKarmaOwners();
    expect(owners).toContain(ownerHex(OWNER_A));
    expect(owners).toContain(ownerHex(OWNER_B));
    expect(owners).toHaveLength(2);

    consumeBox(boxB.id!, 5);
    const afterConsume = getKarmaOwners();
    expect(afterConsume).not.toContain(ownerHex(OWNER_B));
    expect(afterConsume).toHaveLength(1);
  });

  it('first karma insert fires onGain', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, registerKarmaMembershipHook } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const gains: string[] = [];
    const losses: string[] = [];
    registerKarmaMembershipHook({
      onGain: (h) => gains.push(h),
      onLoss: (h) => losses.push(h),
    });

    const box = makeKarmaBox({ owner: OWNER_A });
    box.id = computeBoxId(box);
    insertBox(box);

    expect(gains).toEqual([ownerHex(OWNER_A)]);
    expect(losses).toEqual([]);
  });

  it('second karma insert does not fire onGain', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, registerKarmaMembershipHook } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const gains: string[] = [];
    registerKarmaMembershipHook({
      onGain: (h) => gains.push(h),
      onLoss: () => {},
    });

    const box1 = makeKarmaBox({ owner: OWNER_A });
    box1.id = computeBoxId(box1);
    insertBox(box1);

    gains.length = 0;

    const box2 = makeKarmaBox({ owner: OWNER_A, value: 200n });
    Object.assign(box2, fixtureProvenance(box2, 2));
    box2.id = computeBoxId(box2);
    insertBox(box2);

    expect(gains).toEqual([]);
  });

  it('consuming last karma box fires onLoss', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, consumeBox, registerKarmaMembershipHook } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const box = makeKarmaBox({ owner: OWNER_A });
    box.id = computeBoxId(box);
    insertBox(box);

    const losses: string[] = [];
    registerKarmaMembershipHook({
      onGain: () => {},
      onLoss: (h) => losses.push(h),
    });

    consumeBox(box.id!, 5);
    expect(losses).toEqual([ownerHex(OWNER_A)]);
  });

  it('consuming one of two karma boxes does not fire onLoss', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, consumeBox, registerKarmaMembershipHook } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const box1 = makeKarmaBox({ owner: OWNER_A });
    box1.id = computeBoxId(box1);
    insertBox(box1);

    const box2 = makeKarmaBox({ owner: OWNER_A, value: 200n });
    Object.assign(box2, fixtureProvenance(box2, 2));
    box2.id = computeBoxId(box2);
    insertBox(box2);

    const losses: string[] = [];
    registerKarmaMembershipHook({
      onGain: () => {},
      onLoss: (h) => losses.push(h),
    });

    consumeBox(box1.id!, 5);
    expect(losses).toEqual([]);
  });

  it('deleteBox (revert of first insert) fires onLoss', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, deleteBox, registerKarmaMembershipHook } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const box = makeKarmaBox({ owner: OWNER_A });
    box.id = computeBoxId(box);
    insertBox(box);

    const losses: string[] = [];
    registerKarmaMembershipHook({
      onGain: () => {},
      onLoss: (h) => losses.push(h),
    });

    deleteBox(box.id!);
    expect(losses).toEqual([ownerHex(OWNER_A)]);
  });

  it('unconsumeBox (revert of last consume) fires onGain', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, consumeBox, unconsumeBox, registerKarmaMembershipHook } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const box = makeKarmaBox({ owner: OWNER_A });
    box.id = computeBoxId(box);
    insertBox(box);
    consumeBox(box.id!, 5);

    const gains: string[] = [];
    registerKarmaMembershipHook({
      onGain: (h) => gains.push(h),
      onLoss: () => {},
    });

    unconsumeBox(box.id!);
    expect(gains).toEqual([ownerHex(OWNER_A)]);
  });

  // T5: an exact spend of an owner's last karma box fires onLoss; a spend
  // leaving a box does not (TYPES_INTERFACE → Box value domain).
  it('T5: exact spend of last box fires onLoss; a spend leaving a box does not', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, consumeBox, registerKarmaMembershipHook } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const box1 = makeKarmaBox({ owner: OWNER_A, value: 5n });
    box1.id = computeBoxId(box1);
    insertBox(box1);

    const box2 = makeKarmaBox({ owner: OWNER_A, value: 10n });
    Object.assign(box2, fixtureProvenance(box2, 2));
    box2.id = computeBoxId(box2);
    insertBox(box2);

    const losses: string[] = [];
    registerKarmaMembershipHook({
      onGain: () => {},
      onLoss: (h) => losses.push(h),
    });

    // Consume one — a spend leaving a box: no onLoss.
    consumeBox(box1.id!, 5);
    expect(losses).toEqual([]);

    // Consume the last — an exact spend: onLoss fires.
    consumeBox(box2.id!, 5);
    expect(losses).toEqual([ownerHex(OWNER_A)]);
  });
});
