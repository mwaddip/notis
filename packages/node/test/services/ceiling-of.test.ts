import { describe, it, expect } from 'vitest';
import { PROTOCOL_VERSION } from '@dagsocial/types';
import type { UtxoTransaction, AnyBoxCandidate } from '@dagsocial/types';
import { ceilingOf } from '../../src/services/utxo-engine.js';

const VOUCH_CAST_HEIGHT_WINDOW = 5;

const dummyOwner = new Uint8Array(32);
const dummySig = new Uint8Array(64);
const dummyKey = Buffer.from(dummyOwner).toString('hex');

function creditOut(value: bigint, createdAtBlock: number): AnyBoxCandidate {
  return { boxType: 'credit', value, owner: dummyOwner, createdAtBlock } as AnyBoxCandidate;
}

function feeOut(value: bigint): AnyBoxCandidate {
  return { boxType: 'fee', value, createdAtBlock: 0 } as AnyBoxCandidate;
}

function karmaOut(value: bigint, createdAtBlock: number): AnyBoxCandidate {
  return { boxType: 'karma', value, owner: dummyOwner, createdAtBlock } as AnyBoxCandidate;
}

function vouchOut(createdAtBlock: number): AnyBoxCandidate {
  return {
    boxType: 'vouch',
    value: 1n,
    voucherId: dummyOwner,
    targetId: dummyOwner,
    createdAtBlock,
  } as AnyBoxCandidate;
}

function baseTx(
  outputs: AnyBoxCandidate[],
  signatures: Record<string, Uint8Array> = {},
): UtxoTransaction {
  return {
    inputs: ['deadbeef'.repeat(8)],
    outputs,
    signatures,
    protocolVersion: PROTOCOL_VERSION,
  };
}

describe('ceilingOf', () => {
  // -----------------------------------------------------------------------
  // Rent arm: credit-side AND unsigned
  // -----------------------------------------------------------------------
  describe('rent collection with successor', () => {
    it('returns the credit output createdAtBlock', () => {
      const tx = baseTx([creditOut(500n, 100), feeOut(50n)]);
      expect(ceilingOf(tx)).toBe(100);
    });

    it('equal heights across successors yield that height', () => {
      const tx = baseTx([
        creditOut(300n, 42),
        creditOut(200n, 42),
        feeOut(50n),
      ]);
      expect(ceilingOf(tx)).toBe(42);
    });

    it('differing heights take the minimum — the tx is permanently dead', () => {
      const tx = baseTx([
        creditOut(300n, 50),
        creditOut(200n, 30),
        feeOut(50n),
      ]);
      expect(ceilingOf(tx)).toBe(30);
    });
  });

  describe('rent collection without successor', () => {
    it('returns null when the box value is below its charge', () => {
      const tx = baseTx([feeOut(10n)]);
      expect(ceilingOf(tx)).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Vouch arm: a vouch output on a karma-side transaction
  // -----------------------------------------------------------------------
  describe('vouch cast', () => {
    it('returns createdAtBlock + VOUCH_CAST_HEIGHT_WINDOW', () => {
      const tx = baseTx(
        [karmaOut(99n, 200), vouchOut(200)],
        { [dummyKey]: dummySig },
      );
      expect(ceilingOf(tx)).toBe(200 + VOUCH_CAST_HEIGHT_WINDOW);
    });
  });

  // -----------------------------------------------------------------------
  // Null cases: everything else
  // -----------------------------------------------------------------------
  describe('no ceiling', () => {
    it('returns null for a signed credit transfer', () => {
      const tx = baseTx(
        [creditOut(900n, 50), feeOut(100n)],
        { [dummyKey]: dummySig },
      );
      expect(ceilingOf(tx)).toBeNull();
    });

    it('returns null for a karma consolidation', () => {
      const tx = baseTx(
        [karmaOut(100n, 10)],
        { [dummyKey]: dummySig },
      );
      expect(ceilingOf(tx)).toBeNull();
    });

    it('returns null for an invite (karma → karma + bond)', () => {
      const tx = baseTx(
        [
          karmaOut(90n, 10),
          {
            boxType: 'bond',
            value: 10n,
            inviterId: dummyOwner,
            inviteePublicKey: dummyOwner,
            createdAtBlock: 10,
          } as AnyBoxCandidate,
        ],
        { [dummyKey]: dummySig },
      );
      expect(ceilingOf(tx)).toBeNull();
    });

    it('returns null for a like (karma burn with likeTarget)', () => {
      const tx: UtxoTransaction = {
        ...baseTx(
          [
            karmaOut(99n, 10),
            {
              boxType: 'like_accrual',
              value: 1n,
              author: dummyOwner,
              createdAtBlock: 10,
            } as AnyBoxCandidate,
          ],
          { [dummyKey]: dummySig },
        ),
        likeTarget: 'abcd'.repeat(16),
      };
      expect(ceilingOf(tx)).toBeNull();
    });
  });
});
