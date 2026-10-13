/**
 * `computeUtxoTxRoot` against hand-derived literals.
 *
 * The expected roots and every intermediate value below are hand-derived from
 * TYPES_INTERFACE → Merkle primitives and → Ordering block using Node's
 * `createHash('blake2b512')` alone, laid out in this file as literals so a
 * reader can read the layout byte by byte. ⛔ A literal is NEVER regenerated
 * from `computeUtxoTxRoot`, `leafHash` or `buildMerkleRoot`.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { computeUtxoTxRoot } from '../src/merkle.js';
import type { UtxoTxTree } from '../src/block.js';

/** The first 32 bytes of a BLAKE2b-512 digest over the concatenated parts. */
function blake2b256(...parts: Uint8Array[]): Uint8Array {
  const h = createHash('blake2b512');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest().subarray(0, 32));
}

/** Lowercase hex of raw bytes. */
function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Decode an even-length lowercase hex string to raw bytes. */
function decodeHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Vector A — ids ab*32, cd*32; elements 01, 0203
// ---------------------------------------------------------------------------

const ID_A = 'ab'.repeat(32);
const ID_B = 'cd'.repeat(32);
const BYTES_A = Uint8Array.of(0x01);
const BYTES_B = Uint8Array.of(0x02, 0x03);

const ROOT_A = 'a4276d68b05e901b685e55ba7ea314954856aab010bb5be42a4331ab89cfd22e';

// Intermediate values of vector A, hand-derived:
const ID_LEAF_A    = '147cee3e7584e28345f6538f6c7684b90e0d01638a09c739119e1583255ae746';
const ID_LEAF_B    = '7fba647aa5d50cac4a4ffb07266ced01d96ac97def0b7523b5c7bf410042d748';
const BYTES_LEAF_A = '1177f6868333c8a813d4151dafe486f2ec3a8448b35d0671d3f35a92ad4e0b09';
const BYTES_LEAF_B = '8b5f29925296b91ad09999dcc6745f67fe5f89a524e3252952339894d604a4c2';
const ID_PAIR      = '4521121b95f77663d434581757362946617bca2a2ac466884ea22db67d2b4c13';
const BYTES_PAIR   = '1f1d37ad7ca782e4568f83cdd91adb9dcd1e42180c20fd1b27c69cbe3fe845f3';
const ORDER_FLIP   = 'd4137b0e533204e3d1d7b22bf47c6c78fc8cd188409f0101d4b8e718c30364b9';

const TREE_A: UtxoTxTree = {
  utxoTxIds: [ID_A, ID_B],
  utxoTxs: [BYTES_A, BYTES_B],
};

// ---------------------------------------------------------------------------
// Vector B — single-id tree ab*32; element 01
// ---------------------------------------------------------------------------

const TREE_B: UtxoTxTree = {
  utxoTxIds: [ID_A],
  utxoTxs: [BYTES_A],
};
const ROOT_B = '0a8508253323b6e3671fd08431a8e7d97fd7f36d72a0063c1e6df28962d2d5b0';

// ---------------------------------------------------------------------------
// Vector C — ids ab, cd, ef; elements 01, 0203, 040506
// ---------------------------------------------------------------------------

const ID_C = 'ef'.repeat(32);
const BYTES_C = Uint8Array.of(0x04, 0x05, 0x06);
const TREE_C: UtxoTxTree = {
  utxoTxIds: [ID_A, ID_B, ID_C],
  utxoTxs: [BYTES_A, BYTES_B, BYTES_C],
};
const ROOT_C = 'ea889831c362a66daa0ee57bb178c6ebf9c2e6cdda1eae496bf4794e4af1d516';

// ---------------------------------------------------------------------------
// The three vectors
// ---------------------------------------------------------------------------

describe('computeUtxoTxRoot — hand-derived vectors', () => {
  it('two ids, two elements', () => {
    expect(computeUtxoTxRoot(TREE_A)).toBe(ROOT_A);
  });

  it('one id, one element', () => {
    expect(computeUtxoTxRoot(TREE_B)).toBe(ROOT_B);
  });

  it('three ids, three elements', () => {
    expect(computeUtxoTxRoot(TREE_C)).toBe(ROOT_C);
  });
});

// ---------------------------------------------------------------------------
// Vector A's derivation — spelled out byte by byte with node:crypto alone
// ---------------------------------------------------------------------------

describe('vector A — the layout read byte by byte', () => {
  // A leaf preimage is `utf8(domain) ‖ 0x00 ‖ data`
  // (TYPES_INTERFACE → Merkle primitives).
  const te = new TextEncoder();
  const UTXOTX = te.encode('utxotx');
  const UTXOTX_BYTES = te.encode('utxotx-bytes');
  const NUL = Uint8Array.of(0x00);

  it('id leaf A is blake2b512( "utxotx" | 0x00 | ab*32 )[:32]', () => {
    expect(hex(blake2b256(UTXOTX, NUL, decodeHex(ID_A)))).toBe(ID_LEAF_A);
  });

  it('id leaf B is blake2b512( "utxotx" | 0x00 | cd*32 )[:32]', () => {
    expect(hex(blake2b256(UTXOTX, NUL, decodeHex(ID_B)))).toBe(ID_LEAF_B);
  });

  it('bytes leaf A is blake2b512( "utxotx-bytes" | 0x00 | 01 )[:32]', () => {
    expect(hex(blake2b256(UTXOTX_BYTES, NUL, BYTES_A))).toBe(BYTES_LEAF_A);
  });

  it('bytes leaf B is blake2b512( "utxotx-bytes" | 0x00 | 0203 )[:32]', () => {
    expect(hex(blake2b256(UTXOTX_BYTES, NUL, BYTES_B))).toBe(BYTES_LEAF_B);
  });

  it('a node is blake2b512( 0x00 | left | right )[:32] — the id pair', () => {
    expect(hex(blake2b256(NUL, decodeHex(ID_LEAF_A), decodeHex(ID_LEAF_B))))
      .toBe(ID_PAIR);
  });

  it('a node is blake2b512( 0x00 | left | right )[:32] — the bytes pair', () => {
    expect(hex(blake2b256(NUL, decodeHex(BYTES_LEAF_A), decodeHex(BYTES_LEAF_B))))
      .toBe(BYTES_PAIR);
  });

  it('the root is a node over the id pair then the bytes pair', () => {
    expect(hex(blake2b256(NUL, decodeHex(ID_PAIR), decodeHex(BYTES_PAIR))))
      .toBe(ROOT_A);
  });

  it('and the function agrees with the derivation', () => {
    expect(computeUtxoTxRoot(TREE_A)).toBe(ROOT_A);
  });
});

// ---------------------------------------------------------------------------
// The root is not the ids alone, and the two classes do not commute
// ---------------------------------------------------------------------------

describe('vector A — the root reads both leaf classes, in order', () => {
  it('is not the root of the id leaves alone', () => {
    expect(computeUtxoTxRoot(TREE_A)).not.toBe(ID_PAIR);
  });

  it('swapping the two classes — bytes first, then ids — gives a different root', () => {
    // The function reads ids first then elements; a reader that reversed the
    // two classes would compute `ORDER_FLIP`, which is NOT the root.
    expect(ORDER_FLIP).not.toBe(ROOT_A);
    // The literal `ORDER_FLIP` is the ids-second ordering of vector A, as
    // hand-derived from the layout. The point here is only that it is NOT
    // what the function answers.
    expect(computeUtxoTxRoot(TREE_A)).not.toBe(ORDER_FLIP);
  });
});

// ---------------------------------------------------------------------------
// Vector A — every byte of either leaf class reaches the root
// ---------------------------------------------------------------------------

describe('vector A — every byte of either leaf class reaches the root', () => {
  it('flipping any one bit of any byte of either element moves the root', () => {
    for (const slot of [0, 1] as const) {
      const original = TREE_A.utxoTxs[slot]!;
      for (let i = 0; i < original.length; i++) {
        for (let bit = 0; bit < 8; bit++) {
          const mutated = new Uint8Array(original);
          mutated[i]! ^= 1 << bit;
          const utxoTxs = [TREE_A.utxoTxs[0]!, TREE_A.utxoTxs[1]!];
          utxoTxs[slot] = mutated;
          const moved: UtxoTxTree = { utxoTxIds: TREE_A.utxoTxIds, utxoTxs };
          expect(computeUtxoTxRoot(moved)).not.toBe(ROOT_A);
        }
      }
    }
  });

  it('flipping one hex digit of either id moves the root', () => {
    const digits = '0123456789abcdef';
    for (const slot of [0, 1] as const) {
      const id = TREE_A.utxoTxIds[slot]!;
      for (let i = 0; i < id.length; i++) {
        for (const d of digits) {
          if (d === id[i]) continue;
          const mutatedId = id.slice(0, i) + d + id.slice(i + 1);
          const utxoTxIds = [TREE_A.utxoTxIds[0]!, TREE_A.utxoTxIds[1]!];
          utxoTxIds[slot] = mutatedId;
          const moved: UtxoTxTree = { utxoTxIds, utxoTxs: TREE_A.utxoTxs };
          expect(computeUtxoTxRoot(moved)).not.toBe(ROOT_A);
        }
      }
    }
  });

  it('exchanging the two elements — ids as they were — moves the root', () => {
    const moved: UtxoTxTree = {
      utxoTxIds: TREE_A.utxoTxIds,
      utxoTxs: [TREE_A.utxoTxs[1]!, TREE_A.utxoTxs[0]!],
    };
    expect(computeUtxoTxRoot(moved)).not.toBe(ROOT_A);
  });

  it('exchanging the two ids — elements as they were — moves the root', () => {
    const moved: UtxoTxTree = {
      utxoTxIds: [TREE_A.utxoTxIds[1]!, TREE_A.utxoTxIds[0]!],
      utxoTxs: TREE_A.utxoTxs,
    };
    expect(computeUtxoTxRoot(moved)).not.toBe(ROOT_A);
  });
});

// ---------------------------------------------------------------------------
// A bytes leaf reads the element as it stands — three byte views, one root
// ---------------------------------------------------------------------------

describe('an element is hashed as it stands — the view decides', () => {
  it('Uint8Array, Buffer and a subarray view with other bytes alongside agree', () => {
    const asUint8 = Uint8Array.of(0x01);
    const asBuffer = Buffer.of(0x01);
    const outer = Uint8Array.of(0xaa, 0x01, 0xbb);
    const asView = outer.subarray(1, 2);
    expect(asView.byteLength).toBe(1);
    expect(asView[0]).toBe(0x01);

    const expected = 'a4276d68b05e901b685e55ba7ea314954856aab010bb5be42a4331ab89cfd22e';
    expect(expected).toBe(ROOT_A);
    expect(computeUtxoTxRoot({ utxoTxIds: TREE_A.utxoTxIds, utxoTxs: [asUint8, BYTES_B] })).toBe(expected);
    expect(computeUtxoTxRoot({ utxoTxIds: TREE_A.utxoTxIds, utxoTxs: [asBuffer, BYTES_B] })).toBe(expected);
    expect(computeUtxoTxRoot({ utxoTxIds: TREE_A.utxoTxIds, utxoTxs: [asView, BYTES_B] })).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Totality — an id outside the domain throws, and the shape of the answer
// ---------------------------------------------------------------------------

describe('an id outside the domain throws, and the answer is 64 lowercase hex', () => {
  it('an id with an uppercase hex digit throws TypeError', () => {
    const tree: UtxoTxTree = {
      utxoTxIds: ['AB'.repeat(32)],
      utxoTxs: [BYTES_A],
    };
    expect(() => computeUtxoTxRoot(tree)).toThrow(TypeError);
  });

  it('an id with a non-hex character throws TypeError', () => {
    const tree: UtxoTxTree = {
      utxoTxIds: ['zz'.repeat(32)],
      utxoTxs: [BYTES_A],
    };
    expect(() => computeUtxoTxRoot(tree)).toThrow(TypeError);
  });

  it('an id of odd character length throws TypeError', () => {
    const tree: UtxoTxTree = {
      utxoTxIds: ['a'.repeat(63)],
      utxoTxs: [BYTES_A],
    };
    expect(() => computeUtxoTxRoot(tree)).toThrow(TypeError);
  });

  it('the answer is 64 lowercase hex', () => {
    for (const tree of [TREE_A, TREE_B, TREE_C]) {
      const root = computeUtxoTxRoot(tree);
      expect(root).toHaveLength(64);
      expect(root).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
