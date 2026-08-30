import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import {
  boxRecordBytes,
  PROTOCOL_VERSION,
  STORAGE_RENT_PER_BYTE,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
} from '@dagsocial/types';
import type { CreditBox, UtxoTransaction } from '@dagsocial/types';
import { initDb, closeDb } from '../../src/store/db.js';
import {
  getBox,
  getBoxProvenance,
  insertBox,
  consumeBox,
  getKarmaBox,
  getKarmaValue,
} from '../../src/store/utxo.js';
import { getIdentityRecord, putIdentityRecord, getNetworkRecord } from '../../src/store/identity-records.js';
import { getVouchBox } from '../../src/store/vouch-queries.js';
import { validateTx } from '../../src/services/utxo-engine.js';
import type { UtxoEngineDeps } from '../../src/services/utxo-engine.js';
import { splitCoinbase } from '../../src/services/coinbase-split.js';
import {
  rawPublicKey,
  seedProvenance,
  signTransaction,
  type Stored,
} from '../helpers.js';
import { config } from '../../src/config.js';

const RENT_PERIOD = 40;

const deps: UtxoEngineDeps = {
  getBox,
  insertBox,
  consumeBox,
  getKarmaBox,
  getKarmaValue,
  getIdentityRecord,
  hasActiveVouchEscrow: () => false,
  vouchCooldownBlocks: 2,
  inviteBondMin: config.inviteBondMin,
  inviteBondMax: config.inviteBondMax,
  decayCfg: {
    staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
    decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
    decayAmount: KARMA_DECAY_AMOUNT,
    karmaMinimum: KARMA_MINIMUM,
  },
  storageRentPeriodBlocks: RENT_PERIOD,
  getBoxProvenance,
  getTopologyAuthor: () => null,
  getPendingPostAuthor: () => null,
  runInTransaction: (fn) => fn(),
  getVouchBox,
  getNetworkRecord,
  membershipBarMultiplier: 1,
  putIdentityRecord,
  protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
};

describe('storage rent', () => {
  let alice: ReturnType<typeof generateKeyPairSync>;
  let alicePub: Uint8Array;

  beforeEach(() => {
    initDb(':memory:');
    alice = generateKeyPairSync('ed25519');
    alicePub = rawPublicKey(alice.publicKey);
  });

  afterEach(() => {
    closeDb();
  });

  function seedCredit(value: bigint, createdAt: number): Stored<CreditBox> {
    const box = seedProvenance<CreditBox>(
      { boxType: 'credit', value, owner: alicePub, createdAtBlock: createdAt },
      createdAt,
    );
    insertBox(box);
    return box;
  }

  function rentCharge(box: Stored<CreditBox>): bigint {
    const prov = getBoxProvenance(box.id!)!;
    return STORAGE_RENT_PER_BYTE * BigInt(boxRecordBytes(box, prov.txId, prov.index).length);
  }

  // ---- 1. Authorization ----

  it('an unsigned credit spend passes when the box is rent-eligible', () => {
    const height = 100;
    const box = seedCredit(100_000_000n, height - RENT_PERIOD - 1);
    const charge = rentCharge(box);

    const tx: UtxoTransaction = {
      inputs: [box.id!],
      outputs: [
        { boxType: 'credit', value: box.value - charge, owner: alicePub, createdAtBlock: height },
        { boxType: 'fee', value: charge, createdAtBlock: height },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    const result = validateTx(deps, tx, height);
    expect(result.valid).toBe(true);
  });

  it('an unsigned credit spend fails when the box is NOT rent-eligible', () => {
    const height = 100;
    const box = seedCredit(100_000_000n, height - RENT_PERIOD + 5);

    const tx: UtxoTransaction = {
      inputs: [box.id!],
      outputs: [
        { boxType: 'credit', value: box.value - 1000n, owner: alicePub, createdAtBlock: height },
        { boxType: 'fee', value: 1000n, createdAtBlock: height },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    const result = validateTx(deps, tx, height);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('signature');
  });

  // ---- 2. Transition ----

  it('rejects a rent tx with wrong charge', () => {
    const height = 100;
    const box = seedCredit(100_000_000n, height - RENT_PERIOD - 1);
    const charge = rentCharge(box);
    const wrongCharge = charge + 1n;

    const tx: UtxoTransaction = {
      inputs: [box.id!],
      outputs: [
        { boxType: 'credit', value: box.value - wrongCharge, owner: alicePub, createdAtBlock: height },
        { boxType: 'fee', value: wrongCharge, createdAtBlock: height },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    const result = validateTx(deps, tx, height);
    expect(result.valid).toBe(false);
  });

  it('consumes the whole box when value < charge', () => {
    const height = 100;
    const box = seedCredit(1000n, height - RENT_PERIOD - 1);
    const charge = rentCharge(box);
    expect(box.value).toBeLessThan(charge);

    const tx: UtxoTransaction = {
      inputs: [box.id!],
      outputs: [
        { boxType: 'fee', value: box.value, createdAtBlock: height },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    const result = validateTx(deps, tx, height);
    expect(result.valid).toBe(true);
  });

  it('rejects whole-box consumption when value >= charge', () => {
    const height = 100;
    const box = seedCredit(100_000_000n, height - RENT_PERIOD - 1);
    const charge = rentCharge(box);
    expect(box.value).toBeGreaterThanOrEqual(charge);

    const tx: UtxoTransaction = {
      inputs: [box.id!],
      outputs: [
        { boxType: 'fee', value: box.value, createdAtBlock: height },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    const result = validateTx(deps, tx, height);
    expect(result.valid).toBe(false);
  });

  it('rejects a successor with a different owner', () => {
    const height = 100;
    const box = seedCredit(100_000_000n, height - RENT_PERIOD - 1);
    const charge = rentCharge(box);
    const bob = rawPublicKey(generateKeyPairSync('ed25519').publicKey);

    const tx: UtxoTransaction = {
      inputs: [box.id!],
      outputs: [
        { boxType: 'credit', value: box.value - charge, owner: bob, createdAtBlock: height },
        { boxType: 'fee', value: charge, createdAtBlock: height },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    const result = validateTx(deps, tx, height);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('same owner');
  });

  // ---- 3. Biconditional (backward) ----

  it('a signed credit spend on a rent-eligible box is a normal transfer, not rent', () => {
    const height = 100;
    const box = seedCredit(100_000_000n, height - RENT_PERIOD - 1);
    const bob = rawPublicKey(generateKeyPairSync('ed25519').publicKey);

    const tx: UtxoTransaction = {
      inputs: [box.id!],
      outputs: [
        { boxType: 'credit', value: box.value - 1000n, owner: bob, createdAtBlock: height },
        { boxType: 'fee', value: 1000n, createdAtBlock: height },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    const aliceHex = Buffer.from(alicePub).toString('hex');
    signTransaction(tx, alice.privateKey, aliceHex);
    const result = validateTx(deps, tx, height);
    expect(result.valid).toBe(true);
  });

  // ---- 4. Income term ----

  it('rent does not reach the treasury', () => {
    const rent = 10_000n;
    const emission = 100_000n;
    const fees = 5_000n;
    const withRent = splitCoinbase(emission, fees, rent, 0);
    const withoutRent = splitCoinbase(emission, fees, 0n, 0);
    expect(withRent.treasury).toBe(withoutRent.treasury);
    expect(withRent.miner).toBe(withoutRent.miner + rent);
  });

  it('treasury + miner + unearned == emission + fees + rent', () => {
    const split = splitCoinbase(1000n, 500n, 200n, 5);
    expect(split.treasury + split.miner + split.unearned).toBe(1700n);
  });
});
