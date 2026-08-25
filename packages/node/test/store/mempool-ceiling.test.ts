import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PROTOCOL_VERSION } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import { initDb, closeDb } from '../../src/store/db.js';
import {
  insertUtxoTx,
  purgeExpired,
  getPendingEntries,
} from '../../src/store/mempool.js';

const dummyOwner = new Uint8Array(32);
const dummySig = new Uint8Array(64);
const dummyKey = Buffer.from(dummyOwner).toString('hex');
const BOX_1 = '61'.repeat(32);
const BOX_2 = '62'.repeat(32);
const VOUCHER = 'ee'.repeat(32);
const TARGET = '11'.repeat(32);

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

describe('mempool ceiling — reclaim while pooled', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  it('purgeExpired reclaims an entry past its ceiling', () => {
    const tx = vouchCastTx(10);
    // ceiling = 15
    insertUtxoTx(tx, 1000);
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
    insertUtxoTx(vouchCastTx(10), 1000);

    // A karma tx expiring at height 20
    insertUtxoTx(karmaTx(), 20);

    expect(getPendingEntries(10)).toHaveLength(2);

    // height 16: vouch past ceiling, karma still alive
    expect(purgeExpired(16)).toBe(1);
    expect(getPendingEntries(10)).toHaveLength(1);

    // height 21: karma past expiry
    expect(purgeExpired(21)).toBe(1);
    expect(getPendingEntries(10)).toHaveLength(0);
  });
});
