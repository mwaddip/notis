/**
 * `utxoTxBytesIn` builds no hex string for any id of the body.
 *
 * The pre-change walk read the id array with `readArr(r, (rr) => readHexN(rr, 32))`,
 * calling `readHexN` — and through it `bytesToHex` — once per id to produce the
 * hex strings the then-`indexOf` compared `txId` against. The new walk compares
 * raw bytes and reads no id as hex, so this test replaces `readHexN` with a
 * mock that throws and shows `utxoTxBytesIn` still answers over a body of many
 * ids. The mock-rejection route is the assertion — a byte-comparing walk needs
 * no hex read of the id array, and if the walk ever regresses to one, every
 * case in this file turns red.
 *
 * Encoding is unaffected: `encodeUtxoTxTree` writes ids through
 * `writeHexNOrThrow`, which does not go through `readHexN`.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/codec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/codec.js')>();
  return {
    ...actual,
    readHexN: () => {
      throw new Error('readHexN called — utxoTxBytesIn walked an id as hex');
    },
  };
});

import { encodeUtxoTxTree, utxoTxBytesIn } from '../src/serialization.js';
import type { UtxoTxTree } from '../src/block.js';

function hexId(i: number): string {
  return i.toString(16).padStart(64, '0');
}

describe('utxoTxBytesIn — allocates no id string on the walk', () => {
  const N = 1_000;
  const utxoTxIds = Array.from({ length: N }, (_, i) => hexId(i + 1));
  const utxoTxs = utxoTxIds.map((_, i) => new Uint8Array([i & 0xff, (i >> 8) & 0xff]));
  const tree: UtxoTxTree = { utxoTxIds, utxoTxs };
  const bytes = encodeUtxoTxTree(tree);

  it.each([
    ['first', 0],
    ['middle', N >> 1],
    ['last', N - 1],
  ])('answers at the %s position without calling readHexN', (_name, i) => {
    const id = utxoTxIds[i]!;
    expect(utxoTxBytesIn(bytes, id)).toEqual(utxoTxs[i]);
  });

  it('answers null for an absent id without calling readHexN', () => {
    expect(utxoTxBytesIn(bytes, hexId(N + 1))).toBeNull();
  });
});
