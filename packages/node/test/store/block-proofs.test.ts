import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb } from '../../src/store/db.js';
import {
  deleteBlockProof,
  getBlockProof,
  pruneBlockProofs,
  putBlockProof,
} from '../../src/store/block-proofs.js';

/**
 * The block proofs (NODE_INTERFACE → The block proof): `block_proofs (height
 * INTEGER PRIMARY KEY, proof BLOB NOT NULL)`, one proof per applied block — put
 * by apply, deleted by a revert, pruned below a cutoff.
 */

const proofAt = (height: number): Uint8Array => Uint8Array.from({ length: 40 + height }, (_, i) => (i * 7 + height) & 0xff);

describe('block proofs', () => {
  beforeEach(() => { initDb(':memory:'); });
  afterEach(() => { closeDb(); });

  it('answers the bytes put at a height as a plain Uint8Array, and null for a height it holds none for', () => {
    putBlockProof(3, proofAt(3));
    const stored = getBlockProof(3);
    expect(stored).toEqual(proofAt(3));
    expect(Object.getPrototypeOf(stored)).toBe(Uint8Array.prototype);
    expect(getBlockProof(4)).toBeNull();
  });

  it('holds one proof per height: a put at a height it holds replaces the proof, as the journal does', () => {
    putBlockProof(3, proofAt(3));
    putBlockProof(3, proofAt(4));
    expect(getBlockProof(3)).toEqual(proofAt(4));
  });

  it('deletes the proof at one height and no other', () => {
    for (const height of [1, 2, 3]) putBlockProof(height, proofAt(height));
    deleteBlockProof(2);
    expect(getBlockProof(1)).toEqual(proofAt(1));
    expect(getBlockProof(2)).toBeNull();
    expect(getBlockProof(3)).toEqual(proofAt(3));
  });

  it('prunes every proof below the cutoff and none at or above it', () => {
    for (let height = 1; height <= 6; height++) putBlockProof(height, proofAt(height));
    pruneBlockProofs(4);
    expect([1, 2, 3, 4, 5, 6].map((height) => getBlockProof(height) !== null)).toEqual([false, false, false, true, true, true]);
    // A cutoff at or below the lowest height prunes nothing.
    pruneBlockProofs(-10);
    expect(getBlockProof(4)).toEqual(proofAt(4));
  });
});
