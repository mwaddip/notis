import { describe, it, expect } from 'vitest';
import type { UtxoTxTree } from '@dagsocial/types';
import {
  buildMerkleRoot,
  leafHash,
  hexToBuf,
} from '@dagsocial/types';
import {
  computeUtxoTxRoot,
} from '../../src/services/block-creator.js';

const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

const rootOfLeaves = (...preimages: [string, string][]): string =>
  toHex(buildMerkleRoot(preimages.map(([tag, bytes]) => leafHash(tag, hexToBuf(bytes)))));

// ---------------------------------------------------------------------------
// The root over a whole body
// ---------------------------------------------------------------------------

const utxoFixture: UtxoTxTree = {
  utxoTxIds: ['ab'.repeat(32), 'cd'.repeat(32)],
  utxoTxs: [],
};

describe('Merkle leaf order and composition', () => {
  it('utxoTxRoot leaves are the bare ids, in `utxoTxIds` order', () => {
    expect(computeUtxoTxRoot(utxoFixture)).toBe(
      rootOfLeaves(
        ['utxotx', 'ab'.repeat(32)],
        ['utxotx', 'cd'.repeat(32)],
      ),
    );
  });

  it('leaf ORDER is normative — swapping two ids moves the root', () => {
    const swapped: UtxoTxTree = {
      ...utxoFixture,
      utxoTxIds: ['cd'.repeat(32), 'ab'.repeat(32)],
    };
    expect(computeUtxoTxRoot(swapped)).not.toBe(computeUtxoTxRoot(utxoFixture));
  });

  it('the settlement contributes ONE leaf and no second class', () => {
    const settlementId = 'ef'.repeat(32);
    const withSettlement: UtxoTxTree = {
      ...utxoFixture,
      utxoTxIds: [...utxoFixture.utxoTxIds, settlementId],
    };
    expect(computeUtxoTxRoot(withSettlement)).toBe(
      rootOfLeaves(
        ['utxotx', 'ab'.repeat(32)],
        ['utxotx', 'cd'.repeat(32)],
        ['utxotx', settlementId],
      ),
    );
  });
});
