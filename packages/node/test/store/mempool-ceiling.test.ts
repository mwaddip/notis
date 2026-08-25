import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PROTOCOL_VERSION } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import { initDb, closeDb } from '../../src/store/db.js';
import {
  insertUtxoTx,
  purgeExpired,
  getPendingEntries,
  CeilingExceededError,
} from '../../src/store/mempool.js';

const dummyOwner = new Uint8Array(32);
const dummySig = new Uint8Array(64);
const dummyKey = Buffer.from(dummyOwner).toString('hex');
const BOX_1 = '61'.repeat(32);
const BOX_2 = '62'.repeat(32);
const VOUCHER = 'ee'.repeat(32);
const TARGET = '11'.repeat(32);

function rentTxWithSuccessor(createdAtBlock: number): UtxoTransaction {
  return {
    inputs: [BOX_1],
    outputs: [
      { boxType: 'credit', value: 500n, owner: dummyOwner, createdAtBlock },
      { boxType: 'fee', value: 50n, createdAtBlock: 0 },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
}

function rentTxNoSuccessor(): UtxoTransaction {
  return {
    inputs: [BOX_1],
    outputs: [
      { boxType: 'fee', value: 10n, createdAtBlock: 0 },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
}

function vouchCastTx(createdAtBlock: number): UtxoTransaction {
  return {
    inputs: [BOX_2],
    outputs: [
      { boxType: 'karma', value: 99n, owner: dummyOwner, createdAtBlock },
      {
        boxType: 'vouch',
        value: 1n,
        voucherId: new Uint8Array(Buffer.from(VOUCHER, 'hex')),
        targetId: new Uint8Array(Buffer.from(TARGET, 'hex')),
        createdAtBlock,
      },
    ],
    signatures: { [dummyKey]: dummySig },
    protocolVersion: PROTOCOL_VERSION,
  };
}

function karmaTx(): UtxoTransaction {
  return {
    inputs: [BOX_1],
    outputs: [
      { boxType: 'karma', value: 100n, owner: dummyOwner, createdAtBlock: 1 },
    ],
    signatures: { [dummyKey]: dummySig },
    protocolVersion: PROTOCOL_VERSION,
  };
}

describe('mempool ceiling', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  // -----------------------------------------------------------------------
  // Moment 1: refusal at insert
  // -----------------------------------------------------------------------
  describe('refusal at insert', () => {
    it('refuses a rent tx whose ceiling is below currentHeight', () => {
      const tx = rentTxWithSuccessor(50);
      expect(() => insertUtxoTx(tx, 1000, 51)).toThrow(CeilingExceededError);
    });

    it('accepts a rent tx whose ceiling equals currentHeight', () => {
      const tx = rentTxWithSuccessor(50);
      expect(() => insertUtxoTx(tx, 1000, 50)).not.toThrow();
    });

    it('refuses a vouch cast past its window', () => {
      const tx = vouchCastTx(10);
      // ceiling = 10 + 5 = 15
      expect(() => insertUtxoTx(tx, 1000, 16)).toThrow(CeilingExceededError);
    });

    it('accepts a vouch cast within its window', () => {
      const tx = vouchCastTx(10);
      // ceiling = 10 + 5 = 15
      expect(() => insertUtxoTx(tx, 1000, 15)).not.toThrow();
    });

    it('accepts a rent tx with no successor (null ceiling)', () => {
      const tx = rentTxNoSuccessor();
      expect(() => insertUtxoTx(tx, 1000, 999)).not.toThrow();
    });

    it('accepts a karma tx (null ceiling) at any height', () => {
      const tx = karmaTx();
      expect(() => insertUtxoTx(tx, 1000, 999)).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Moment 2: reclaim while pooled
  // -----------------------------------------------------------------------
  describe('reclaim while pooled', () => {
    it('purgeExpired reclaims an entry past its ceiling', () => {
      const tx = vouchCastTx(10);
      // ceiling = 15, insert at height 10
      insertUtxoTx(tx, 1000, 10);
      expect(getPendingEntries(10)).toHaveLength(1);

      // height 15: still valid
      expect(purgeExpired(15)).toBe(0);
      expect(getPendingEntries(10)).toHaveLength(1);

      // height 16: past ceiling, reclaimed
      expect(purgeExpired(16)).toBe(1);
      expect(getPendingEntries(10)).toHaveLength(0);
    });

    it('does not reclaim an entry with no ceiling', () => {
      insertUtxoTx(karmaTx(), 1000);
      expect(purgeExpired(999)).toBe(0);
      expect(getPendingEntries(10)).toHaveLength(1);
    });

    it('reclaims ceiling-dead entries alongside expiry-dead entries', () => {
      // A vouch with ceiling 15
      const vouch = vouchCastTx(10);
      insertUtxoTx(vouch, 1000, 10);

      // A karma tx expiring at height 20
      const karma = karmaTx();
      insertUtxoTx(karma, 20);

      expect(getPendingEntries(10)).toHaveLength(2);

      // height 16: vouch past ceiling, karma still alive
      expect(purgeExpired(16)).toBe(1);
      expect(getPendingEntries(10)).toHaveLength(1);

      // height 21: karma past expiry
      expect(purgeExpired(21)).toBe(1);
      expect(getPendingEntries(10)).toHaveLength(0);
    });
  });
});
