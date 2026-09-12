// NODE_INTERFACE → Backer transition rules.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initDb, closeDb, getDb,
  insertBox, consumeBox,
  getKarmaBox, getKarmaValue,
  getIdentityRecord,
  hasActiveVouchEscrow,
  getBoxProvenance, getVouchBox, getNetworkRecord,
  getUsername, getUsernameByOwner,
  beginBlockJournal, finishBlockJournal,
} from '../../src/store/index.js';
import { getBoxWithPending } from '../../src/store/mempool.js';
import {
  validateTx,
} from '../../src/services/utxo-engine.js';
import type { UtxoEngineDeps } from '../../src/services/utxo-engine.js';
import {
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type {
  BackerStakeBox, BackerUnstakeBox, UtxoTransaction, AnyBoxCandidate,
} from '@dagsocial/types';
import {
  makeTestIdentity, signTransaction, seedProvenance,
} from '../helpers.js';
import { config } from '../../src/config.js';
import { putIdentityRecord } from '../../src/store/identity-records.js';

const HEIGHT = 10;

function hex(id: Uint8Array): string { return Buffer.from(id).toString('hex'); }

function makeDeps(): UtxoEngineDeps {
  return {
    getBox: getBoxWithPending,
    insertBox,
    consumeBox,
    getKarmaBox,
    getKarmaValue,
    getIdentityRecord,
    hasActiveVouchEscrow,
    vouchCooldownBlocks: 2,
    inviteBondMin: config.inviteBondMin,
    inviteBondMax: config.inviteBondMax,
    decayCfg: {
      staleThresholdBlocks: config.karmaStaleThresholdBlocks,
      decayIntervalBlocks: config.karmaDecayIntervalBlocks,
      decayAmount: config.karmaDecayAmount,
      karmaMinimum: config.karmaMinimum,
    },
    storageRentPeriodBlocks: config.storageRentPeriodBlocks,
    getBoxProvenance,
    getTopologyAuthor: () => null,
    getPendingPostAuthor: () => null,
    runInTransaction: (fn) => getDb().transaction(fn)(),
    getVouchBox,
    getNetworkRecord,
    membershipBarMultiplier: config.membershipBarMultiplier,
    putIdentityRecord,
    protocolVersionSchedule: config.protocolVersionSchedule,
    getUsername,
    getUsernameByOwner,
  };
}

let nonce = 0;
function seedStake(owner: Uint8Array, weight: bigint): BackerStakeBox {
  return seedProvenance<BackerStakeBox>(
    { boxType: 'backer_stake', value: 0n as 0n, createdAtBlock: 1, owner, weight }, 1, nonce++,
  );
}

function unstakeTx(
  holder: ReturnType<typeof makeTestIdentity>,
  stakeBox: BackerStakeBox,
  unstakeWeight: bigint,
): UtxoTransaction {
  const outputs: AnyBoxCandidate[] = [];
  const remainder = stakeBox.weight - unstakeWeight;
  if (remainder > 0n) {
    outputs.push({
      boxType: 'backer_stake', value: 0n, createdAtBlock: HEIGHT,
      owner: holder.userId, weight: remainder,
    } as AnyBoxCandidate);
  }
  outputs.push({
    boxType: 'backer_unstake', value: 0n, createdAtBlock: HEIGHT,
    owner: holder.userId, weight: unstakeWeight,
  } as AnyBoxCandidate);
  const tx: UtxoTransaction = {
    inputs: [stakeBox.id!],
    outputs,
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, holder.privateKey, hex(holder.userId));
  return tx;
}

describe('backer transition rules', () => {
  let deps: UtxoEngineDeps;
  let holder: ReturnType<typeof makeTestIdentity>;
  let stranger: ReturnType<typeof makeTestIdentity>;

  beforeEach(() => {
    initDb(':memory:');
    beginBlockJournal(HEIGHT);
    deps = makeDeps();
    holder = makeTestIdentity();
    stranger = makeTestIdentity();
    nonce = 0;
  });
  afterEach(() => {
    try { finishBlockJournal(); } catch { /* already finished */ }
    closeDb();
  });

  it('full unstake — entire weight into the marker', () => {
    const stake = seedStake(holder.userId, 100n);
    insertBox(stake);
    const tx = unstakeTx(holder, stake, 100n);
    const r = validateTx(deps, tx, HEIGHT);
    expect(r.valid).toBe(true);
  });

  it('partial unstake — weight conserved across successor and marker', () => {
    const stake = seedStake(holder.userId, 100n);
    insertBox(stake);
    const tx = unstakeTx(holder, stake, 40n);
    const r = validateTx(deps, tx, HEIGHT);
    expect(r.valid).toBe(true);
  });

  it('refuses unstake below minimum', () => {
    const weight = 200n;
    const stake = seedStake(holder.userId, weight);
    insertBox(stake);
    // BACKER_UNSTAKE_MIN_PCT=1, so minimum is ceil(200/100)=2. Unstake 1.
    const tx = unstakeTx(holder, stake, 1n);
    const r = validateTx(deps, tx, HEIGHT);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('unstake below minimum');
  });

  it('refuses weight not conserved', () => {
    const stake = seedStake(holder.userId, 100n);
    insertBox(stake);
    const tx: UtxoTransaction = {
      inputs: [stake.id!],
      outputs: [
        { boxType: 'backer_stake', value: 0n, createdAtBlock: HEIGHT, owner: holder.userId, weight: 60n } as AnyBoxCandidate,
        { boxType: 'backer_unstake', value: 0n, createdAtBlock: HEIGHT, owner: holder.userId, weight: 30n } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, holder.privateKey, hex(holder.userId));
    const r = validateTx(deps, tx, HEIGHT);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('unstake weight not conserved');
  });

  it('refuses a foreign owner on the marker', () => {
    const stake = seedStake(holder.userId, 100n);
    insertBox(stake);
    const tx: UtxoTransaction = {
      inputs: [stake.id!],
      outputs: [
        { boxType: 'backer_unstake', value: 0n, createdAtBlock: HEIGHT, owner: stranger.userId, weight: 100n } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, holder.privateKey, hex(holder.userId));
    const r = validateTx(deps, tx, HEIGHT);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('unstake marker names another owner');
  });

  it('refuses a foreign owner on the successor', () => {
    const stake = seedStake(holder.userId, 100n);
    insertBox(stake);
    const tx: UtxoTransaction = {
      inputs: [stake.id!],
      outputs: [
        { boxType: 'backer_stake', value: 0n, createdAtBlock: HEIGHT, owner: stranger.userId, weight: 60n } as AnyBoxCandidate,
        { boxType: 'backer_unstake', value: 0n, createdAtBlock: HEIGHT, owner: holder.userId, weight: 40n } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, holder.privateKey, hex(holder.userId));
    const r = validateTx(deps, tx, HEIGHT);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('stake successor names another owner');
  });

  it('refuses value not 0n on marker or successor — conservation catches first', () => {
    const stake = seedStake(holder.userId, 100n);
    insertBox(stake);
    const tx: UtxoTransaction = {
      inputs: [stake.id!],
      outputs: [
        { boxType: 'backer_unstake', value: 5n, createdAtBlock: HEIGHT, owner: holder.userId, weight: 100n } as unknown as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, holder.privateKey, hex(holder.userId));
    const r = validateTx(deps, tx, HEIGHT);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('non-conservation');
  });

  it('refuses two stake inputs', () => {
    const stake1 = seedStake(holder.userId, 50n);
    const stake2 = seedStake(holder.userId, 50n);
    insertBox(stake1);
    insertBox(stake2);
    const tx: UtxoTransaction = {
      inputs: [stake1.id!, stake2.id!],
      outputs: [
        { boxType: 'backer_unstake', value: 0n, createdAtBlock: HEIGHT, owner: holder.userId, weight: 100n } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, holder.privateKey, hex(holder.userId));
    const r = validateTx(deps, tx, HEIGHT);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('exactly one BackerStakeBox');
  });

  it('refuses a backer_stake output from a karma input', () => {
    const karma = seedProvenance<import('@dagsocial/types').KarmaBox>(
      { boxType: 'karma', value: 10n, createdAtBlock: 1, owner: holder.userId }, 1, nonce++,
    );
    insertBox(karma);
    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        { boxType: 'backer_stake', value: 0n, createdAtBlock: HEIGHT, owner: holder.userId, weight: 10n } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, holder.privateKey, hex(holder.userId));
    const r = validateTx(deps, tx, HEIGHT);
    expect(r.valid).toBe(false);
  });

  it('refuses a backer_pool output from a user transaction', () => {
    const karma = seedProvenance<import('@dagsocial/types').KarmaBox>(
      { boxType: 'karma', value: 10n, createdAtBlock: 1, owner: holder.userId }, 1, nonce++,
    );
    insertBox(karma);
    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        { boxType: 'karma', value: 10n, createdAtBlock: HEIGHT, owner: holder.userId } as AnyBoxCandidate,
        { boxType: 'backer_pool', value: 0n, createdAtBlock: HEIGHT, staked: 0n, accrual: 0n } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, holder.privateKey, hex(holder.userId));
    const r = validateTx(deps, tx, HEIGHT);
    expect(r.valid).toBe(false);
  });

  it('refuses a backer_unstake or backer_pool as an input', () => {
    const marker = seedProvenance<BackerUnstakeBox>(
      { boxType: 'backer_unstake', value: 0n as 0n, createdAtBlock: 1, owner: holder.userId, weight: 10n }, 1, nonce++,
    );
    insertBox(marker);
    const tx: UtxoTransaction = {
      inputs: [marker.id!],
      outputs: [],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, holder.privateKey, hex(holder.userId));
    const r = validateTx(deps, tx, HEIGHT);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('block application');
  });

  it('refusal reasons are distinct from other reasons in the suite', () => {
    const reasons = [
      'unstake weight not conserved',
      'unstake below minimum',
      'unstake marker names another owner',
      'stake successor names another owner',
    ];
    for (let i = 0; i < reasons.length; i++) {
      for (let j = i + 1; j < reasons.length; j++) {
        expect(reasons[i]!.includes(reasons[j]!)).toBe(false);
        expect(reasons[j]!.includes(reasons[i]!)).toBe(false);
      }
    }
  });
});
