import { describe, it, expect } from 'vitest';
import { verifyUtxoTxRoot } from '../src/verify.js';
import type { OrderingBlock, BlockHeader } from '@dagsocial/types';
import { EMPTY_STATE_ROOT, ORDERING_BLOCK_POW_TARGET_FLOOR } from '@dagsocial/types';

// VALIDATION_INTERFACE → verifyUtxoTxRoot.
//
// The three bodies and their roots are literals derived from the layout
// apart from this package and from `computeUtxoTxRoot`. A case sets
// `header.utxoTxRoot` to the literal — never to what a function answers.
const ROOT_ONE = '0a8508253323b6e3671fd08431a8e7d97fd7f36d72a0063c1e6df28962d2d5b0';
const ROOT_TWO = 'a4276d68b05e901b685e55ba7ea314954856aab010bb5be42a4331ab89cfd22e';
const ROOT_THREE = 'ea889831c362a66daa0ee57bb178c6ebf9c2e6cdda1eae496bf4794e4af1d516';

const ID_AB = 'ab'.repeat(32);
const ID_CD = 'cd'.repeat(32);
const ID_EF = 'ef'.repeat(32);

const makeHeader = (utxoTxRoot: string, over: Partial<BlockHeader> = {}): BlockHeader => ({
  protocolVersion: 1,
  height: 1,
  prevBlockHash: '00'.repeat(32),
  utxoTxRoot,
  stateRoot: EMPTY_STATE_ROOT,
  validatorId: new Uint8Array(32),
  powNonce: 0,
  powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
  createdAt: 0,
  interlinkRoot: '00'.repeat(32),
  adProofsRoot: '00'.repeat(32),
  ...over,
});

const makeBlock = (
  root: string,
  utxoTxIds: string[],
  utxoTxs: Uint8Array[],
): OrderingBlock => ({
  header: makeHeader(root),
  utxoTxTree: { utxoTxIds, utxoTxs },
  validatorSignature: new Uint8Array(64),
});

describe('verifyUtxoTxRoot', () => {
  const idsOne = [ID_AB];
  const txsOne = (): Uint8Array[] => [new Uint8Array([0x01])];

  const idsTwo = [ID_AB, ID_CD];
  const txsTwo = (): Uint8Array[] => [new Uint8Array([0x01]), new Uint8Array([0x02, 0x03])];

  const idsThree = [ID_AB, ID_CD, ID_EF];
  const txsThree = (): Uint8Array[] => [
    new Uint8Array([0x01]),
    new Uint8Array([0x02, 0x03]),
    new Uint8Array([0x04, 0x05, 0x06]),
  ];

  it('accepts the one-entry body under its root', () => {
    expect(verifyUtxoTxRoot(makeBlock(ROOT_ONE, idsOne, txsOne()))).toBe(true);
  });

  it('accepts the two-entry body under its root', () => {
    expect(verifyUtxoTxRoot(makeBlock(ROOT_TWO, idsTwo, txsTwo()))).toBe(true);
  });

  it('accepts the three-entry body under its root', () => {
    expect(verifyUtxoTxRoot(makeBlock(ROOT_THREE, idsThree, txsThree()))).toBe(true);
  });

  it('rejects after flipping any one bit of any byte of either element', () => {
    const base = txsTwo();
    for (let elemIdx = 0; elemIdx < base.length; elemIdx++) {
      const elem = base[elemIdx]!;
      for (let byteIdx = 0; byteIdx < elem.length; byteIdx++) {
        for (let bit = 0; bit < 8; bit++) {
          const altered = txsTwo();
          const buf = altered[elemIdx]!;
          buf[byteIdx] = (buf[byteIdx]! ^ (1 << bit)) & 0xff;
          expect(verifyUtxoTxRoot(makeBlock(ROOT_TWO, idsTwo, altered))).toBe(false);
        }
      }
    }
  });

  it('rejects after changing any one hex digit of either id', () => {
    const digits = '0123456789abcdef';
    for (let idSlot = 0; idSlot < idsTwo.length; idSlot++) {
      const original = idsTwo[idSlot]!;
      for (let pos = 0; pos < 64; pos++) {
        const current = original[pos]!;
        for (const d of digits) {
          if (d === current) continue;
          const altered = original.slice(0, pos) + d + original.slice(pos + 1);
          const alteredIds = [...idsTwo];
          alteredIds[idSlot] = altered;
          expect(verifyUtxoTxRoot(makeBlock(ROOT_TWO, alteredIds, txsTwo()))).toBe(false);
        }
      }
    }
  });

  it('rejects after changing any one hex digit of the header root', () => {
    const digits = '0123456789abcdef';
    for (let pos = 0; pos < 64; pos++) {
      const current = ROOT_TWO[pos]!;
      for (const d of digits) {
        if (d === current) continue;
        const altered = ROOT_TWO.slice(0, pos) + d + ROOT_TWO.slice(pos + 1);
        expect(verifyUtxoTxRoot(makeBlock(altered, idsTwo, txsTwo()))).toBe(false);
      }
    }
  });

  it('rejects after exchanging the two elements', () => {
    const base = txsTwo();
    const swapped = [base[1]!, base[0]!];
    expect(verifyUtxoTxRoot(makeBlock(ROOT_TWO, idsTwo, swapped))).toBe(false);
  });

  it('rejects after exchanging the two ids', () => {
    const swapped = [idsTwo[1]!, idsTwo[0]!];
    expect(verifyUtxoTxRoot(makeBlock(ROOT_TWO, swapped, txsTwo()))).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Total by itself — every malformed input answers false, never throws
  // (VALIDATION_INTERFACE → verifyUtxoTxRoot).
  // ---------------------------------------------------------------------------

  it('rejects arrays of different length, both ways round', () => {
    expect(verifyUtxoTxRoot(makeBlock(ROOT_TWO, [ID_AB], txsTwo()))).toBe(false);
    expect(verifyUtxoTxRoot(makeBlock(ROOT_TWO, idsTwo, [new Uint8Array([0x01])]))).toBe(false);
  });

  it('rejects an id that is a number, null, uppercase hex, or 63 characters', () => {
    const bads: unknown[] = [42, null, 'AB'.repeat(32), 'ab'.repeat(31) + 'a'];
    for (const bad of bads) {
      expect(
        verifyUtxoTxRoot(makeBlock(ROOT_TWO, [bad as string, ID_CD], txsTwo())),
      ).toBe(false);
    }
  });

  it('rejects an element that is a string, null, or a plain array of numbers', () => {
    const bads: unknown[] = ['not-bytes', null, [1, 2, 3]];
    for (const bad of bads) {
      const txs: Uint8Array[] = [bad as unknown as Uint8Array, new Uint8Array([0x02, 0x03])];
      expect(verifyUtxoTxRoot(makeBlock(ROOT_TWO, idsTwo, txs))).toBe(false);
    }
  });

  it('rejects utxoTxTree absent, null, or a string', () => {
    for (const bad of [undefined, null, 'string'] as unknown[]) {
      const b: OrderingBlock = {
        header: makeHeader(ROOT_TWO),
        utxoTxTree: bad as unknown as OrderingBlock['utxoTxTree'],
        validatorSignature: new Uint8Array(64),
      };
      expect(verifyUtxoTxRoot(b)).toBe(false);
    }
  });

  it('rejects utxoTxIds or utxoTxs not an array', () => {
    for (const bad of [null, 'string', 42] as unknown[]) {
      const b1: OrderingBlock = {
        header: makeHeader(ROOT_TWO),
        utxoTxTree: {
          utxoTxIds: bad as unknown as string[],
          utxoTxs: txsTwo(),
        },
        validatorSignature: new Uint8Array(64),
      };
      expect(verifyUtxoTxRoot(b1)).toBe(false);
      const b2: OrderingBlock = {
        header: makeHeader(ROOT_TWO),
        utxoTxTree: {
          utxoTxIds: idsTwo,
          utxoTxs: bad as unknown as Uint8Array[],
        },
        validatorSignature: new Uint8Array(64),
      };
      expect(verifyUtxoTxRoot(b2)).toBe(false);
    }
  });

  it('rejects block itself null, undefined, or a number', () => {
    for (const bad of [null, undefined, 42] as unknown[]) {
      expect(verifyUtxoTxRoot(bad as unknown as OrderingBlock)).toBe(false);
    }
  });

  it('rejects header absent', () => {
    const b = {
      utxoTxTree: { utxoTxIds: idsTwo, utxoTxs: txsTwo() },
      validatorSignature: new Uint8Array(64),
    } as unknown as OrderingBlock;
    expect(verifyUtxoTxRoot(b)).toBe(false);
  });

  it('rejects header.utxoTxRoot a number, 63 characters, or uppercase hex', () => {
    const bads: unknown[] = [42, 'ab'.repeat(31) + 'a', 'AB'.repeat(32)];
    for (const bad of bads) {
      const b: OrderingBlock = {
        header: { ...makeHeader(ROOT_TWO), utxoTxRoot: bad as string },
        utxoTxTree: { utxoTxIds: idsTwo, utxoTxs: txsTwo() },
        validatorSignature: new Uint8Array(64),
      };
      expect(verifyUtxoTxRoot(b)).toBe(false);
    }
  });

  // ---------------------------------------------------------------------------
  // An element held as a Uint8Array, as a Buffer, and as a subarray view into
  // a longer buffer answers the same.
  // ---------------------------------------------------------------------------

  it('answers the same for Uint8Array, Buffer, and a subarray view', () => {
    const asUint8: Uint8Array[] = [new Uint8Array([0x01]), new Uint8Array([0x02, 0x03])];
    const asBuffer: Uint8Array[] = [Buffer.from([0x01]), Buffer.from([0x02, 0x03])];
    const sourceBuf = Buffer.from([0xff, 0x01, 0xff, 0x02, 0x03, 0xff]);
    const asSubarray: Uint8Array[] = [sourceBuf.subarray(1, 2), sourceBuf.subarray(3, 5)];
    expect(verifyUtxoTxRoot(makeBlock(ROOT_TWO, idsTwo, asUint8))).toBe(true);
    expect(verifyUtxoTxRoot(makeBlock(ROOT_TWO, idsTwo, asBuffer))).toBe(true);
    expect(verifyUtxoTxRoot(makeBlock(ROOT_TWO, idsTwo, asSubarray))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // It judges the root and nothing else — validatorSignature and any other
  // header field outside its domain do not change the verdict
  // (VALIDATION_INTERFACE → verifyUtxoTxRoot).
  // ---------------------------------------------------------------------------

  it('accepts a body under its root with validatorSignature replaced by garbage', () => {
    const b: OrderingBlock = {
      header: makeHeader(ROOT_TWO),
      utxoTxTree: { utxoTxIds: idsTwo, utxoTxs: txsTwo() },
      validatorSignature: new Uint8Array([1, 2, 3]),
    };
    expect(verifyUtxoTxRoot(b)).toBe(true);
  });

  it('accepts a body under its root with another header field out of domain (height: -1)', () => {
    const b: OrderingBlock = {
      header: { ...makeHeader(ROOT_TWO), height: -1 },
      utxoTxTree: { utxoTxIds: idsTwo, utxoTxs: txsTwo() },
      validatorSignature: new Uint8Array(64),
    };
    expect(verifyUtxoTxRoot(b)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // An empty body answers by the comparison — true under a root of 64 zeros,
  // false under any other. Refusing an empty body stays
  // verifyOrderingBlockStructure's.
  // ---------------------------------------------------------------------------

  it('an empty body accepts the 64-zero root and refuses any other', () => {
    expect(verifyUtxoTxRoot(makeBlock('00'.repeat(32), [], []))).toBe(true);
    expect(verifyUtxoTxRoot(makeBlock('11'.repeat(32), [], []))).toBe(false);
    expect(verifyUtxoTxRoot(makeBlock(ROOT_TWO, [], []))).toBe(false);
  });
});
