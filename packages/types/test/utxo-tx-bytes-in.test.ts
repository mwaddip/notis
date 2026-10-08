/**
 * `utxoTxBytesIn` against `decodeUtxoTxTree` — one transaction out of an
 * encoded body (TYPES_INTERFACE → One transaction of a body).
 *
 * The equivalence is the contract: for every id in the tree the walker's
 * bytes equal the decoder's `utxoTxs[utxoTxIds.indexOf(id)]`, byte for byte.
 * The one difference the contract states — no re-encode compare, so trailing
 * bytes after the wanted element do not change the answer — is pinned in its
 * own case below so a reader meets it where the function behaves differently
 * from `decodeUtxoTxTree`.
 */

import { describe, it, expect } from 'vitest';
import { ReaderError, encodeVlqU } from '@dagsocial/wire';
import {
  decodeUtxoTxTree,
  encodeUtxoTxTree,
  utxoTxBytesIn,
} from '../src/serialization.js';
import type { UtxoTxTree } from '../src/block.js';

/** A deterministic 32-byte id in lowercase hex. */
function hexId(i: number): string {
  return i.toString(16).padStart(64, '0');
}

/** Distinct opaque transaction bytes — the walker never decodes them. */
function tx(seed: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (seed + i) & 0xff;
  return out;
}

/** Pin `utxoTxBytesIn` to the decoder for every id in the tree. */
function expectWalkMatchesDecoder(tree: UtxoTxTree): void {
  const bytes = encodeUtxoTxTree(tree);
  const decoded = decodeUtxoTxTree(bytes);
  for (let i = 0; i < tree.utxoTxIds.length; i++) {
    const id = tree.utxoTxIds[i]!;
    const got = utxoTxBytesIn(bytes, id);
    expect(got).not.toBeNull();
    expect(got).toEqual(decoded.utxoTxs[decoded.utxoTxIds.indexOf(id)]);
  }
}

// ---------------------------------------------------------------------------
// The pinned equivalence
// ---------------------------------------------------------------------------

describe('utxoTxBytesIn — the pinned equivalence', () => {
  it('agrees with the decoder on an empty tree (no ids to try)', () => {
    const bytes = encodeUtxoTxTree({ utxoTxIds: [], utxoTxs: [] });
    expect(utxoTxBytesIn(bytes, hexId(0))).toBeNull();
  });

  it('agrees on a one-transaction tree', () => {
    expectWalkMatchesDecoder({
      utxoTxIds: [hexId(1)],
      utxoTxs: [tx(1, 7)],
    });
  });

  it('agrees on a many-transaction tree, first and last and middle', () => {
    const utxoTxIds = Array.from({ length: 8 }, (_, i) => hexId(i + 1));
    const utxoTxs = utxoTxIds.map((_, i) => tx(i * 13, 5 + i));
    expectWalkMatchesDecoder({ utxoTxIds, utxoTxs });
  });

  it('agrees on a zero-length element', () => {
    expectWalkMatchesDecoder({
      utxoTxIds: [hexId(1), hexId(2), hexId(3)],
      utxoTxs: [tx(1, 4), new Uint8Array(0), tx(2, 11)],
    });
  });

  it('agrees on an element of 1 byte', () => {
    expectWalkMatchesDecoder({
      utxoTxIds: [hexId(1), hexId(2)],
      utxoTxs: [new Uint8Array([0x9c]), tx(2, 3)],
    });
  });

  it('agrees on an element of 100 000 bytes', () => {
    expectWalkMatchesDecoder({
      utxoTxIds: [hexId(1), hexId(2)],
      utxoTxs: [tx(1, 3), tx(7, 100_000)],
    });
  });

  it('returns a fresh Uint8Array (a copy, as the decoder does)', () => {
    const tree: UtxoTxTree = {
      utxoTxIds: [hexId(1)],
      utxoTxs: [tx(1, 7)],
    };
    const bytes = encodeUtxoTxTree(tree);
    const got = utxoTxBytesIn(bytes, hexId(1))!;
    expect(got.constructor).toBe(Uint8Array);
    expect(got.buffer).not.toBe(bytes.buffer);
  });
});

// ---------------------------------------------------------------------------
// Null returns — id absent, txId out of domain
// ---------------------------------------------------------------------------

describe('utxoTxBytesIn — nulls', () => {
  const tree: UtxoTxTree = {
    utxoTxIds: [hexId(1), hexId(2)],
    utxoTxs: [tx(1, 4), tx(2, 5)],
  };
  const bytes = encodeUtxoTxTree(tree);

  it('answers null for an id the tree lacks', () => {
    expect(utxoTxBytesIn(bytes, hexId(99))).toBeNull();
  });

  it('answers null for a txId of the wrong length', () => {
    expect(utxoTxBytesIn(bytes, '00')).toBeNull();
    expect(utxoTxBytesIn(bytes, 'a'.repeat(63))).toBeNull();
    expect(utxoTxBytesIn(bytes, 'a'.repeat(65))).toBeNull();
  });

  it('answers null for upper-case hex', () => {
    const upper = 'ABCDEF' + '0'.repeat(58);
    // The hex-letter half must be upper-cased for the check to bite.
    expect(upper).not.toBe(upper.toLowerCase());
    expect(utxoTxBytesIn(bytes, upper)).toBeNull();
  });

  it('answers null for a non-hex txId', () => {
    expect(utxoTxBytesIn(bytes, 'g'.repeat(64))).toBeNull();
  });

  it('answers null for a non-string txId', () => {
    // The function's domain is `TxId = string`; a non-string is still rejected
    // rather than throwing, matching the stated contract.
    expect(utxoTxBytesIn(bytes, undefined as unknown as string)).toBeNull();
    expect(utxoTxBytesIn(bytes, 42 as unknown as string)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// First-position rule
// ---------------------------------------------------------------------------

describe('utxoTxBytesIn — a duplicated id answers the first position', () => {
  it('returns the element at the first position holding the id', () => {
    const id = hexId(1);
    const tree: UtxoTxTree = {
      utxoTxIds: [id, hexId(2), id],
      utxoTxs: [tx(1, 4), tx(2, 7), tx(3, 11)],
    };
    const bytes = encodeUtxoTxTree(tree);
    expect(utxoTxBytesIn(bytes, id)).toEqual(tx(1, 4));
  });
});

// ---------------------------------------------------------------------------
// Truncation at every byte offset
// ---------------------------------------------------------------------------

describe('utxoTxBytesIn — truncation at every byte offset', () => {
  it('either answers the original tree (stopping short of the cut) or throws ReaderError', () => {
    const tree: UtxoTxTree = {
      utxoTxIds: [hexId(1), hexId(2), hexId(3)],
      utxoTxs: [tx(1, 3), tx(2, 5), tx(3, 7)],
    };
    const bytes = encodeUtxoTxTree(tree);
    const ids = tree.utxoTxIds;

    for (let cut = 0; cut < bytes.length; cut++) {
      const prefix = bytes.subarray(0, cut);
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]!;
        try {
          const got = utxoTxBytesIn(prefix, id);
          // Non-throwing path: a non-null answer must equal the ORIGINAL
          // tree's element at `id` — the walker only reaches that element when
          // every byte it needs is present (the stated difference from the
          // decoder is that it does not read past that element). A `null`
          // answer means the id was absent from the id array as the walker
          // read it, which the prefix either confirms by containing the full
          // id array with no match, or by cutting it short — the latter also
          // allowed, since this test's domain is throw-or-right-answer.
          if (got !== null) {
            expect(got).toEqual(tree.utxoTxs[i]);
          }
        } catch (e) {
          // Only ReaderError is acceptable for a bad read — never TypeError,
          // never RangeError, never another class.
          expect(e).toBeInstanceOf(ReaderError);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// An id array longer than the element array
// ---------------------------------------------------------------------------

describe('utxoTxBytesIn — id array longer than element array', () => {
  it('throws ReaderError for an id at a position with no element', () => {
    // Encode a tree with 2 ids and 1 element by hand: the codec's `encodeArr`
    // would refuse the mismatch, so this builds the bytes directly. The id
    // array has `vlqU(2) ‖ id1 ‖ id2`; the element array has `vlqU(1) ‖ lp(e1)`.
    const id1 = hexId(1);
    const id2 = hexId(2);
    const e1 = tx(1, 3);
    const parts: number[] = [];
    // id count
    for (const b of encodeVlqU(2)) parts.push(b);
    // id1 and id2 as raw 32 bytes each
    for (let i = 0; i < 64; i += 2) parts.push(parseInt(id1.slice(i, i + 2), 16));
    for (let i = 0; i < 64; i += 2) parts.push(parseInt(id2.slice(i, i + 2), 16));
    // element count
    for (const b of encodeVlqU(1)) parts.push(b);
    // element 1 as lp
    for (const b of encodeVlqU(e1.length)) parts.push(b);
    for (const b of e1) parts.push(b);
    const bytes = new Uint8Array(parts);

    // id1 is at position 0 — a real element — and resolves.
    expect(utxoTxBytesIn(bytes, id1)).toEqual(e1);
    // id2 is at position 1 — the element array stops short — and throws.
    expect(() => utxoTxBytesIn(bytes, id2)).toThrow(ReaderError);
  });
});

// ---------------------------------------------------------------------------
// Does not read past the wanted element — the stated difference from the decoder
// ---------------------------------------------------------------------------

describe('utxoTxBytesIn — does not read past the wanted element', () => {
  it('garbage appended after the wanted element does not change an early id', () => {
    const tree: UtxoTxTree = {
      utxoTxIds: [hexId(1), hexId(2), hexId(3)],
      utxoTxs: [tx(1, 3), tx(2, 5), tx(3, 7)],
    };
    const bytes = encodeUtxoTxTree(tree);
    const junked = new Uint8Array(bytes.length + 16);
    junked.set(bytes, 0);
    junked.set(new Uint8Array(16).fill(0xaa), bytes.length);

    // The decoder rejects `junked` (trailing bytes); the walker does not,
    // because it stops at the wanted element.
    expect(() => decodeUtxoTxTree(junked)).toThrow();
    expect(utxoTxBytesIn(junked, hexId(1))).toEqual(tx(1, 3));
    expect(utxoTxBytesIn(junked, hexId(2))).toEqual(tx(2, 5));
  });
});

// ---------------------------------------------------------------------------
// A body of 10 000 distinct ids and 10 000 small elements — first, middle,
// last each answer the decoder's element.
// ---------------------------------------------------------------------------

describe('utxoTxBytesIn — ten thousand distinct ids', () => {
  const N = 10_000;
  const utxoTxIds = Array.from({ length: N }, (_, i) => hexId(i + 1));
  const utxoTxs = utxoTxIds.map((_, i) => tx(i & 0xff, 3));
  const tree: UtxoTxTree = { utxoTxIds, utxoTxs };
  const bytes = encodeUtxoTxTree(tree);
  const decoded = decodeUtxoTxTree(bytes);

  it.each([
    ['first', 0],
    ['middle', N >> 1],
    ['last', N - 1],
  ])('answers the decoder at the %s position', (_name, i) => {
    const id = utxoTxIds[i]!;
    expect(utxoTxBytesIn(bytes, id)).toEqual(decoded.utxoTxs[decoded.utxoTxIds.indexOf(id)]);
  });
});
