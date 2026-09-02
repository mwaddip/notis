import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  createAvlProver,
  applyBlockMutations,
  checkpointProver,
} from '../../src/state/avl-prover.js';
import {
  deserializeBoxWithId,
  deserializeBox,
} from '../../src/state/serialize-box.js';
import type { AnyBox } from '@dagsocial/types';
import { fixtureProvenance, openAvlDb } from '../helpers.js';

/**
 * A box as it exists in the tree. `AnyBox.id` is optional — genuinely absent
 * for the one expression between building a candidate and hashing it — but
 * every box these fixtures hand the prover is already keyed, so the local type
 * says so instead of every use site asserting it.
 */
type StoredBox = AnyBox & { id: string };

/** Generate sequential, non-zero 64-char hex IDs starting from 1 to avoid
 *  the all-zeros key which collides with the AVL neg-inf sentinel. */
function makeIdGenerator() {
  let counter = 1;
  return (): string => (counter++).toString(16).padStart(64, '0');
}

/**
 * The `id` here is the generator's, NOT `computeBoxId(box)`: this suite keys the
 * AVL by a *controlled* 32-byte value (see `makeIdGenerator` above), which is
 * what makes insertion order, rollback and per-height lookups readable. Nothing
 * in the file asserts id integrity, and nothing seeds a store.
 *
 * `txId`/`index` are real all the same: they are required box fields, they ride
 * the AVL value, and the round-trip assertion at the bottom of the suite reads
 * them back. A fixture that left them off would make that assertion compare
 * `undefined` to `undefined` and pass on a codec that dropped the tail.
 */
function makeKarmaBox(id: string, value: bigint, block: number, seed: number): StoredBox {
  const owner = new Uint8Array(32);
  owner[0] = seed & 0xff;
  const candidate = {
    boxType: 'karma' as const,
    value,
    createdAtBlock: block,
    owner,
  };
  return { id, ...candidate, ...fixtureProvenance(candidate, block, seed) };
}

function makeCreditBox(id: string, value: bigint, block: number, seed: number): StoredBox {
  const owner = new Uint8Array(32);
  owner[0] = seed & 0xff;
  const candidate = {
    boxType: 'credit' as const,
    value,
    createdAtBlock: block,
    owner,
  };
  return { id, ...candidate, ...fixtureProvenance(candidate, block, seed) };
}

describe('AVL integration — full pipeline', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openAvlDb();
  });

  afterEach(() => {
    db.close();
  });

  it('simulates 10 blocks of UTXO mutations and verifies historical proofs', () => {
    const handle = createAvlProver(db);
    const allBoxes = new Map<string, StoredBox>();
    const nextId = makeIdGenerator();

    // -- Block 1: create 5 karma boxes -----------------------------------------
    const created1: StoredBox[] = Array.from({ length: 5 }, (_, i) =>
      makeKarmaBox(nextId(), BigInt(100 + i), 1, i),
    );
    for (const b of created1) allBoxes.set(b.id, b);
    const d1 = applyBlockMutations(handle.prover, 1, [], created1);
    checkpointProver(handle, 1);

    expect(d1).toBeInstanceOf(Uint8Array);
    expect(d1.length).toBe(33); // 32-byte label + 1-byte height

    // Verify: all 5 boxes are present via unauthenticatedLookup
    for (const box of created1) {
      const key = Buffer.from(box.id, 'hex');
      const raw = handle.prover.unauthenticatedLookup(key);
      expect(raw, `box ${box.id} should be found after block 1`).not.toBeNull();
      const deserialized = deserializeBoxWithId(box.id, raw!);
      expect(deserialized.id).toBe(box.id);
      expect(deserialized.boxType).toBe('karma');
    }

    // -- Block 2: create 3 credit boxes, consume the first karma box -----------
    const consumed2 = [created1[0]!.id];
    allBoxes.delete(created1[0]!.id);

    const created2: StoredBox[] = Array.from({ length: 3 }, (_, i) =>
      makeCreditBox(nextId(), BigInt(50 + i), 2, i + 5),
    );
    for (const b of created2) allBoxes.set(b.id, b);

    const d2 = applyBlockMutations(handle.prover, 2, consumed2, created2);
    checkpointProver(handle, 2);

    expect(d2).toBeInstanceOf(Uint8Array);
    expect(d2.length).toBe(33);
    expect(Buffer.from(d2).equals(Buffer.from(d1))).toBe(false);

    // Verify: consumed box is gone
    const consumedKey = Buffer.from(created1[0]!.id, 'hex');
    expect(handle.prover.unauthenticatedLookup(consumedKey)).toBeNull();

    // Verify: new credit boxes are present
    for (const box of created2) {
      const key = Buffer.from(box.id, 'hex');
      expect(handle.prover.unauthenticatedLookup(key)).not.toBeNull();
    }

    // -- Blocks 3–10: create 2 boxes each, consume oldest every other block ----
    const blockDigests: Uint8Array[] = [d1, d2];

    for (let block = 3; block <= 10; block++) {
      const created: StoredBox[] = Array.from({ length: 2 }, (_, i) =>
        makeKarmaBox(nextId(), BigInt(10 + i), block, block * 10 + i),
      );

      const consumed: string[] = [];
      if (block % 2 === 0 && allBoxes.size > 0) {
        // Consume the oldest (first-inserted) surviving box
        const oldestId = allBoxes.keys().next().value;
        if (oldestId) {
          consumed.push(oldestId);
          allBoxes.delete(oldestId);
        }
      }

      for (const b of created) allBoxes.set(b.id, b);

      applyBlockMutations(handle.prover, block, consumed, created);
      checkpointProver(handle, block);

      const digest = handle.prover.digest();
      expect(digest, `block ${block} digest should be non-null`).not.toBeNull();
      expect(digest!.length).toBe(33);
      blockDigests.push(digest!);

      // Verify: every consumed box is truly gone
      for (const cid of consumed) {
        expect(
          handle.prover.unauthenticatedLookup(Buffer.from(cid, 'hex')),
          `consumed box ${cid} should not be found after block ${block}`,
        ).toBeNull();
      }
    }

    // -- Final state verification ----------------------------------------------
    // All boxes tracked in allBoxes should be present in the prover
    const finalCount = allBoxes.size;
    let found = 0;

    for (const [boxId, expectedBox] of allBoxes) {
      const key = Buffer.from(boxId, 'hex');
      const value = handle.prover.unauthenticatedLookup(key);
      if (value) {
        found++;
        const box = deserializeBoxWithId(boxId, value);
        expect(box.id).toBe(boxId);
        expect(box.boxType).toBe(expectedBox.boxType);
      }
    }
    expect(found).toBe(finalCount);

    // Sanity: we should have created 5+3+16=24 boxes and consumed 5
    // (1 at block 2 + 4 at blocks 4,6,8,10), leaving 19
    expect(finalCount).toBe(19);

    // -- Rollback: restore height 1 and verify only original 5 boxes exist ----
    const d1Copy = new Uint8Array(d1);
    handle.prover.rollback(d1Copy);

    // All 5 original boxes should be present at height 1
    for (const box of created1) {
      const key = Buffer.from(box.id, 'hex');
      const raw = handle.prover.unauthenticatedLookup(key);
      expect(raw, `box ${box.id} should exist after rollback to height 1`).not.toBeNull();
      const deserialized = deserializeBoxWithId(box.id, raw!);
      expect(deserialized.boxType).toBe('karma');
      expect(deserialized.value).toBe(box.value);
    }

    // Boxes created after block 1 should NOT exist after rollback
    for (const box of created2) {
      const key = Buffer.from(box.id, 'hex');
      expect(
        handle.prover.unauthenticatedLookup(key),
        `box ${box.id} should not exist after rollback to height 1`,
      ).toBeNull();
    }

    // `created1[0]` is consumed at block 2, so it is ALIVE at height 1 and the
    // rollback must resurrect it. This is the direction that distinguishes a
    // real rollback from a tree that only ever removes: the two assertions above
    // both hold for a prover that discards later blocks without restoring
    // earlier ones.
    const recreatedKey = Buffer.from(created1[0]!.id, 'hex');
    const recreatedValue = handle.prover.unauthenticatedLookup(recreatedKey);
    expect(recreatedValue, 'box consumed at height 2 should be alive after rollback to height 1').not.toBeNull();

    // -- Verify deterministic: all block digests are unique ---------------------
    const hexDigests = blockDigests.map((d) => Buffer.from(d).toString('hex'));
    const uniqueDigests = new Set(hexDigests);
    expect(uniqueDigests.size).toBe(blockDigests.length);

    // -- Verify roundtrip for a sample box -------------------------------------
    const sampleBox = created1[1]!;
    const sampleKey = Buffer.from(sampleBox.id, 'hex');
    const sampleRaw = handle.prover.unauthenticatedLookup(sampleKey);
    expect(sampleRaw).not.toBeNull();

    // deserializeBox (without id) + deserializeBoxWithId (with id)
    const withoutId = deserializeBox(sampleRaw!);
    expect(withoutId.boxType).toBe('karma');
    expect(withoutId.value).toBe(sampleBox.value);

    const withId = deserializeBoxWithId(sampleBox.id, sampleRaw!);
    expect(withId.id).toBe(sampleBox.id);
    expect(withId.boxType).toBe('karma');
    // The AVL value carries provenance, and must: NODE_INTERFACE → Invariants
    // requires that a box id be a total function of the stored box, which is
    // only checkable *from a proof* if the proof's value carries everything the
    // derivation consumes.
    expect(withId.txId).toBe(sampleBox.txId);
    expect(withId.index).toBe(sampleBox.index);
  });
});
