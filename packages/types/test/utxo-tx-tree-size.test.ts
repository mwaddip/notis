/**
 * `utxoTxTreeByteLength` against `encodeUtxoTxTree` — two ways of computing one
 * number, held together (TYPES_INTERFACE → Sizing without encoding).
 *
 * The equivalence is the contract rather than an implementation detail, and the
 * asymmetry in what a divergence costs is what shapes this file:
 *
 *  - **Under-reporting** makes a body measure legal against
 *    `MAX_BLOCK_BODY_BYTES`, encode larger, and be rejected by every peer that
 *    receives it. That is a block this node relays and nobody accepts.
 *  - **Over-reporting** costs the miner a block it was entitled to produce.
 *
 * Three places an off-by-one hides, and each has its own section below:
 *
 *  1. **Every count and length prefix is `vlqU`, so its width varies.** A
 *     128-element array's prefix is two bytes where a 127-element one's is one,
 *     and `utxoTxs` element prefixes vary per transaction. One byte per element
 *     is ~2 KB of error on a full block.
 *  2. **The encoder's totality is mixed.** `writeArr`, `writeLp`, `writeVlqU`,
 *     `writeBool` and `enum8` are total *by sentinel* — handed an out-of-domain
 *     value they write a fixed width and the encode SUCCEEDS. Those inputs are
 *     inside the encoder's success domain, so the equivalence has to hold there
 *     too, and it is exactly where a sizer that assumed well-formed fields
 *     reports fewer bytes than the encoder writes.
 *  3. **The fixed-width writers throw.** There the tree has no encoding at all,
 *     so there is no length to agree on — what is pinned instead is that the
 *     sizer stays total, because it runs over peer-supplied bodies.
 */

import { describe, it, expect } from 'vitest';
import { encodeVlqU, encodeVlqBigInt } from '@dagsocial/wire';
import {
  VLQ_SENTINEL,
  arrByteLength,
  lpByteLength,
  vlqU64ByteLength,
  vlqUByteLength,
} from '../src/codec.js';
import { encodeUtxoTxTree, utxoTxTreeByteLength } from '../src/serialization.js';
import type { UtxoTxTree } from '../src/block.js';

/** The all-ones u64, ten bytes — what every sentinelled field costs. */
const SENTINEL_WIDTH = encodeVlqBigInt(VLQ_SENTINEL).length;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Distinct, well-formed 32-byte ids. `b32` gives an arbitrary string no encoding. */
function hexId(i: number): string {
  return i.toString(16).padStart(64, '0');
}

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, i) => hexId(i));
}

function txs(count: number, eachLength: number): Uint8Array[] {
  return Array.from({ length: count }, () => new Uint8Array(eachLength).fill(0x7a));
}

const EMPTY_TREE: UtxoTxTree = {
  utxoTxIds: [],
  utxoTxs: [],
};

function makeTree(over: Partial<UtxoTxTree> = {}): UtxoTxTree {
  return { ...EMPTY_TREE, ...over };
}

/**
 * The equivalence, asserted in the one direction that covers both. Returns the
 * encoded length so a caller can pin the number itself where the number is the
 * point.
 */
function expectSizeMatchesEncoder(tree: UtxoTxTree): number {
  const encoded = encodeUtxoTxTree(tree).length;
  expect(utxoTxTreeByteLength(tree)).toBe(encoded);
  return encoded;
}

// ---------------------------------------------------------------------------
// 1 — the width mirrors, against the encoders that actually run
// ---------------------------------------------------------------------------

/**
 * `vlqUByteLength` and `vlqU64ByteLength` restate wire's two encoding loops as
 * digit counts. Pinning them against `encodeVlqU` / `encodeVlqBigInt` directly
 * is what catches a drift at the primitive rather than as an unattributed
 * few-byte gap on a whole body.
 */
describe('VLQ width mirrors', () => {
  const NUMBER_BOUNDARIES = [
    0, 1, 127, 128, 129, 16_383, 16_384, 2_097_151, 2_097_152,
    268_435_455, 268_435_456, 34_359_738_367, 34_359_738_368,
    Number.MAX_SAFE_INTEGER,
  ];

  for (const value of NUMBER_BOUNDARIES) {
    it(`counts vlqU(${value}) as ${encodeVlqU(value).length} byte(s)`, () => {
      expect(vlqUByteLength(value)).toBe(encodeVlqU(value).length);
    });
  }

  const BIGINT_BOUNDARIES = [
    0n, 1n, 127n, 128n, 16_383n, 16_384n,
    2n ** 28n - 1n, 2n ** 28n, 2n ** 49n - 1n, 2n ** 49n, 2n ** 56n, 2n ** 63n,
    VLQ_SENTINEL,
  ];

  for (const value of BIGINT_BOUNDARIES) {
    it(`counts vlqU64(${value}) as ${encodeVlqBigInt(value).length} byte(s)`, () => {
      expect(vlqU64ByteLength(value)).toBe(encodeVlqBigInt(value).length);
    });
  }

  // `writeVlqU` sentinels rather than throws, so this width is the ENCODER'S,
  // not a fallback: it is what the bytes cost.
  it('costs a vlqU field the sentinel when its value has no encoding', () => {
    for (const bad of [-1, 1.5, NaN, Infinity, 2 ** 53, undefined, 'seven']) {
      expect(vlqUByteLength(bad as unknown as number)).toBe(SENTINEL_WIDTH);
    }
  });

  // `writeVlqU64OrThrow` throws instead, so this is the never-under-report
  // maximum standing in for a width that does not exist.
  it('costs a vlqU64 field the widest u64 when its value has no encoding', () => {
    for (const bad of [-1n, 2n ** 64n, 7, undefined, null]) {
      expect(vlqU64ByteLength(bad as unknown as bigint)).toBe(SENTINEL_WIDTH);
    }
  });

  it('sentinels a non-array count and a non-byte-view payload', () => {
    expect(arrByteLength(undefined as unknown as number[], () => 1)).toBe(SENTINEL_WIDTH);
    expect(lpByteLength('abc' as unknown as Uint8Array)).toBe(SENTINEL_WIDTH);
  });
});

// ---------------------------------------------------------------------------
// 2 — the equivalence over generated trees
// ---------------------------------------------------------------------------

describe('utxoTxTreeByteLength', () => {
  it('sizes the empty tree at two count prefixes', () => {
    expect(expectSizeMatchesEncoder(EMPTY_TREE)).toBe(2);
  });

  it('sizes a full body — ids and transactions', () => {
    expectSizeMatchesEncoder(makeTree({
      utxoTxIds: ids(300),
      utxoTxs: txs(300, 953),
    }));
  });
});

/**
 * Array counts and payload lengths straddling every `vlqU` width step. Built
 * lazily — the 16,384-element cases are half a megabyte encoded, and there is no
 * reason to hold them all through collection.
 */
describe('VLQ width boundaries', () => {
  const COUNTS = [0, 1, 127, 128, 16_383, 16_384];
  const CASES: Array<{ label: string; tree: () => UtxoTxTree }> = [];

  for (const n of COUNTS) {
    CASES.push({ label: `${n} utxoTxIds`, tree: () => makeTree({ utxoTxIds: ids(n) }) });
    CASES.push({ label: `${n} utxoTxs of 1 byte`, tree: () => makeTree({ utxoTxs: txs(n, 1) }) });
    CASES.push({
      label: `utxoTxs elements of ${n} bytes`,
      tree: () => makeTree({ utxoTxs: txs(3, n) }),
    });
  }

  for (const { label, tree } of CASES) {
    it(`sizes ${label}`, () => {
      expectSizeMatchesEncoder(tree());
    });
  }
});

// ---------------------------------------------------------------------------
// 3 — the sentinel branches, which the encoder ACCEPTS
// ---------------------------------------------------------------------------

/**
 * ⛔ Every case here encodes successfully, so the equivalence is owed on all of
 * them — and every one is a place a sizer reading the field at face value
 * reports too few bytes. Each asserts the equivalence and then the width the
 * branch costs, differenced against the empty tree, so a failure says which
 * writer moved rather than only that a total disagreed.
 */
describe('sentinel branches', () => {
  const EMPTY_SIZE = 2;

  it('costs a non-array section its sentinel count and no elements', () => {
    const tree = makeTree({ utxoTxIds: undefined as unknown as string[] });
    expectSizeMatchesEncoder(tree);
    // The section's own count prefix (1 byte, empty) becomes the sentinel.
    expect(utxoTxTreeByteLength(tree)).toBe(EMPTY_SIZE - 1 + SENTINEL_WIDTH);
  });

  // The under-report trap named in `lpByteLength`: `verifyOrderingBlockStructure`
  // checks `utxoTxs`' length alignment but not its element types, so this input
  // is reachable. A foreign object's `.length` is 3 here; the encoder writes 10.
  it('costs a non-byte-view transaction its sentinel length prefix and no payload', () => {
    const tree = makeTree({ utxoTxs: ['abc' as unknown as Uint8Array] });
    expectSizeMatchesEncoder(tree);
    expect(utxoTxTreeByteLength(tree) - EMPTY_SIZE).toBe(SENTINEL_WIDTH);
    expect(utxoTxTreeByteLength(tree)).toBeGreaterThan(EMPTY_SIZE + 1 + 'abc'.length);
  });

});

// ---------------------------------------------------------------------------
// 4 — trees the encoder rejects
// ---------------------------------------------------------------------------

/**
 * The fixed-width writers throw, so these trees have no encoding and no length
 * to agree on. What is pinned is that the sizer stays **total**: it is called
 * from `verifyOrderingBlockStructure` over peer-supplied bodies, where a throw
 * would put gate ordering between untrusted bytes and a panic.
 */
describe('trees the encoder rejects', () => {
  const UNENCODABLE: Array<{ label: string; tree: UtxoTxTree }> = [
    {
      label: 'a utxoTxId that is not 32 bytes of lowercase hex',
      tree: makeTree({ utxoTxIds: ['zz'.repeat(32)] }),
    },
    {
      label: 'a utxoTxId of the wrong length',
      tree: makeTree({ utxoTxIds: ['ab'] }),
    },
  ];

  for (const { label, tree } of UNENCODABLE) {
    it(`stays total for ${label}`, () => {
      expect(() => encodeUtxoTxTree(tree)).toThrow();
      expect(() => utxoTxTreeByteLength(tree)).not.toThrow();
      expect(utxoTxTreeByteLength(tree)).toBeGreaterThan(0);
    });
  }
});
