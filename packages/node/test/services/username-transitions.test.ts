// NODE_INTERFACE → Username transition rules, Legal box transitions (Claim and Burn rows).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initDb, closeDb, getDb,
  insertBox, consumeBox,
  getKarmaBox, getKarmaValue,
  getIdentityRecord, putIdentityRecord,
  hasActiveVouchEscrow,
  getBoxProvenance, getVouchBox, getNetworkRecord,
  getUsername, getUsernameByOwner, putUsername, deleteUsername,
  beginBlockJournal, finishBlockJournal,
} from '../../src/store/index.js';
import { getBoxWithPending } from '../../src/store/mempool.js';
import {
  validateTx, applyTx,
} from '../../src/services/utxo-engine.js';
import type { UtxoEngineDeps } from '../../src/services/utxo-engine.js';
import {
  PROTOCOL_VERSION,
  USERNAME_BURN_PRICE,
} from '@dagsocial/types';
import type {
  KarmaBox, UsernameBox, UtxoTransaction, AnyBoxCandidate, AnyBox,
} from '@dagsocial/types';
import {
  makeTestIdentity, signTransaction, seedProvenance,
} from '../helpers.js';
import { config } from '../../src/config.js';

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
function seedKarma(owner: Uint8Array, value: bigint): KarmaBox {
  return seedProvenance<KarmaBox>(
    { boxType: 'karma', value, createdAtBlock: 1, owner }, 1, nonce++,
  );
}

function seedUsernameBox(owner: Uint8Array, name: string): UsernameBox {
  return seedProvenance<UsernameBox>(
    { boxType: 'username', value: 0n as 0n, createdAtBlock: 1, owner, name: Buffer.from(name, 'utf8') }, 1, nonce++,
  );
}

function claimTx(
  holder: ReturnType<typeof makeTestIdentity>,
  karmaBox: KarmaBox,
  name: string,
): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [karmaBox.id!],
    outputs: [
      { boxType: 'karma', value: karmaBox.value, createdAtBlock: HEIGHT, owner: holder.userId } as AnyBoxCandidate,
      { boxType: 'username', value: 0n, createdAtBlock: HEIGHT, owner: holder.userId, name: Buffer.from(name, 'utf8') } as AnyBoxCandidate,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, holder.privateKey, hex(holder.userId));
  return tx;
}

function burnTx(
  holder: ReturnType<typeof makeTestIdentity>,
  karmaBox: KarmaBox,
  usernameBox: UsernameBox,
): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [karmaBox.id!, usernameBox.id!],
    outputs: [
      { boxType: 'karma', value: karmaBox.value - USERNAME_BURN_PRICE, createdAtBlock: HEIGHT, owner: holder.userId } as AnyBoxCandidate,
      { boxType: 'karma_price', value: USERNAME_BURN_PRICE, createdAtBlock: HEIGHT } as AnyBoxCandidate,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, holder.privateKey, hex(holder.userId));
  return tx;
}

describe('username claim and burn transitions', () => {
  let deps: UtxoEngineDeps;

  beforeEach(() => {
    initDb(':memory:');
    const db = getDb();
    db.prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 0)').run();
    deps = makeDeps();
  });

  afterEach(() => {
    closeDb();
  });

  // --- Claim: valid ---

  it('claim valid', () => {
    const holder = makeTestIdentity();
    const kb = seedKarma(holder.userId, 100n);
    insertBox(kb);
    const tx = claimTx(holder, kb, 'Alice');
    const result = validateTx(deps, tx, HEIGHT);
    expect(result.valid, result.error).toBe(true);
  });

  // --- Claim refusals ---

  it('claim refused for a taken name (same case)', () => {
    const a = makeTestIdentity();
    const kb = seedKarma(a.userId, 100n);
    insertBox(kb);
    beginBlockJournal(HEIGHT);
    putUsername({ nameLower: 'alice', name: 'Alice', owner: hex(a.userId), boxId: 'aa'.repeat(32), claimedAtBlock: 1 });
    finishBlockJournal();

    const b = makeTestIdentity();
    const kb2 = seedKarma(b.userId, 100n);
    insertBox(kb2);
    const tx = claimTx(b, kb2, 'Alice');
    const result = validateTx(deps, tx, HEIGHT);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('name taken');
  });

  it('claim refused for a taken name (different case)', () => {
    const a = makeTestIdentity();
    beginBlockJournal(HEIGHT);
    putUsername({ nameLower: 'alice', name: 'Alice', owner: hex(a.userId), boxId: 'aa'.repeat(32), claimedAtBlock: 1 });
    finishBlockJournal();

    const b = makeTestIdentity();
    const kb = seedKarma(b.userId, 100n);
    insertBox(kb);
    const tx = claimTx(b, kb, 'ALICE');
    const result = validateTx(deps, tx, HEIGHT);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('name taken');
  });

  it('claim refused for an identity that holds a name', () => {
    const holder = makeTestIdentity();
    beginBlockJournal(HEIGHT);
    putUsername({ nameLower: 'bob', name: 'Bob', owner: hex(holder.userId), boxId: 'bb'.repeat(32), claimedAtBlock: 1 });
    finishBlockJournal();

    const kb = seedKarma(holder.userId, 100n);
    insertBox(kb);
    const tx = claimTx(holder, kb, 'Charlie');
    const result = validateTx(deps, tx, HEIGHT);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('identity holds a name');
  });

  it('claim refused for a wrong owner', () => {
    const holder = makeTestIdentity();
    const other = makeTestIdentity();
    const kb = seedKarma(holder.userId, 100n);
    insertBox(kb);
    const tx: UtxoTransaction = {
      inputs: [kb.id!],
      outputs: [
        { boxType: 'karma', value: 100n, createdAtBlock: HEIGHT, owner: holder.userId } as AnyBoxCandidate,
        { boxType: 'username', value: 0n, createdAtBlock: HEIGHT, owner: other.userId, name: Buffer.from('Dave', 'utf8') } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, holder.privateKey, hex(holder.userId));
    const result = validateTx(deps, tx, HEIGHT);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('owner must match');
  });

  it('claim refused for value != 0n', () => {
    const holder = makeTestIdentity();
    const kb = seedKarma(holder.userId, 100n);
    insertBox(kb);
    const tx: UtxoTransaction = {
      inputs: [kb.id!],
      outputs: [
        { boxType: 'karma', value: 99n, createdAtBlock: HEIGHT, owner: holder.userId } as AnyBoxCandidate,
        { boxType: 'username', value: 1n, createdAtBlock: HEIGHT, owner: holder.userId, name: Buffer.from('Eve', 'utf8') } as unknown as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, holder.privateKey, hex(holder.userId));
    const result = validateTx(deps, tx, HEIGHT);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('value must be 0');
  });

  it('claim refused for an invalid name', () => {
    const holder = makeTestIdentity();
    const kb = seedKarma(holder.userId, 100n);
    insertBox(kb);
    const tx: UtxoTransaction = {
      inputs: [kb.id!],
      outputs: [
        { boxType: 'karma', value: 100n, createdAtBlock: HEIGHT, owner: holder.userId } as AnyBoxCandidate,
        { boxType: 'username', value: 0n, createdAtBlock: HEIGHT, owner: holder.userId, name: Buffer.from('a b', 'utf8') } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, holder.privateKey, hex(holder.userId));
    const result = validateTx(deps, tx, HEIGHT);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('name invalid');
  });

  // --- Burn: valid ---

  it('burn valid', () => {
    const holder = makeTestIdentity();
    const kb = seedKarma(holder.userId, 100n);
    insertBox(kb);
    const ub = seedUsernameBox(holder.userId, 'Frank');
    insertBox(ub);

    const tx = burnTx(holder, kb, ub);
    const result = validateTx(deps, tx, HEIGHT);
    expect(result.valid, result.error).toBe(true);
  });

  // --- Burn refusals ---

  it('burn refused for a non-holder signer (step 8 fires before the arm)', () => {
    const holder = makeTestIdentity();
    const other = makeTestIdentity();
    const kb = seedKarma(other.userId, 100n);
    insertBox(kb);
    const ub = seedUsernameBox(holder.userId, 'Grace');
    insertBox(ub);

    const tx: UtxoTransaction = {
      inputs: [kb.id!, ub.id!],
      outputs: [
        { boxType: 'karma', value: 100n - USERNAME_BURN_PRICE, createdAtBlock: HEIGHT, owner: other.userId } as AnyBoxCandidate,
        { boxType: 'karma_price', value: USERNAME_BURN_PRICE, createdAtBlock: HEIGHT } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, other.privateKey, hex(other.userId));
    const result = validateTx(deps, tx, HEIGHT);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('signature');
  });

  it('burn refused for a wrong price', () => {
    const holder = makeTestIdentity();
    const kb = seedKarma(holder.userId, 100n);
    insertBox(kb);
    const ub = seedUsernameBox(holder.userId, 'Heidi');
    insertBox(ub);

    const tx: UtxoTransaction = {
      inputs: [kb.id!, ub.id!],
      outputs: [
        { boxType: 'karma', value: 100n - 1n, createdAtBlock: HEIGHT, owner: holder.userId } as AnyBoxCandidate,
        { boxType: 'karma_price', value: 1n, createdAtBlock: HEIGHT } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, holder.privateKey, hex(holder.userId));
    const result = validateTx(deps, tx, HEIGHT);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('price must be exactly');
  });

  it('burn refused for a missing price box', () => {
    const holder = makeTestIdentity();
    const kb = seedKarma(holder.userId, 100n);
    insertBox(kb);
    const ub = seedUsernameBox(holder.userId, 'Ivan');
    insertBox(ub);

    const tx: UtxoTransaction = {
      inputs: [kb.id!, ub.id!],
      outputs: [
        { boxType: 'karma', value: 100n, createdAtBlock: HEIGHT, owner: holder.userId } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, holder.privateKey, hex(holder.userId));
    const result = validateTx(deps, tx, HEIGHT);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('KarmaPriceBox required');
  });

  it('burn refused for an extra username output', () => {
    const holder = makeTestIdentity();
    const kb = seedKarma(holder.userId, 100n);
    insertBox(kb);
    const ub = seedUsernameBox(holder.userId, 'Judy');
    insertBox(ub);

    const tx: UtxoTransaction = {
      inputs: [kb.id!, ub.id!],
      outputs: [
        { boxType: 'karma', value: 100n - USERNAME_BURN_PRICE, createdAtBlock: HEIGHT, owner: holder.userId } as AnyBoxCandidate,
        { boxType: 'karma_price', value: USERNAME_BURN_PRICE, createdAtBlock: HEIGHT } as AnyBoxCandidate,
        { boxType: 'username', value: 0n, createdAtBlock: HEIGHT, owner: holder.userId, name: Buffer.from('Judy2', 'utf8') } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, holder.privateKey, hex(holder.userId));
    const result = validateTx(deps, tx, HEIGHT);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('no username output');
  });

  // --- Claim → burn → re-claim ---

  it('claim → burn → claim the same name by another identity', () => {
    const a = makeTestIdentity();
    const ka = seedKarma(a.userId, 100n);
    insertBox(ka);

    const claimA = claimTx(a, ka, 'Reclaim');
    const r1 = validateTx(deps, claimA, HEIGHT);
    expect(r1.valid, r1.error).toBe(true);
    beginBlockJournal(HEIGHT);
    applyTx(deps, claimA, r1.computedOutputs!, HEIGHT);
    const uOut = r1.computedOutputs!.find(o => o.boxType === 'username')!;
    putUsername({
      nameLower: 'reclaim', name: 'Reclaim',
      owner: hex(a.userId), boxId: uOut.id!, claimedAtBlock: HEIGHT,
    });
    finishBlockJournal();

    const ka2 = seedKarma(a.userId, 100n);
    insertBox(ka2);
    const burnA = burnTx(a, ka2, uOut as UsernameBox);
    const r2 = validateTx(deps, burnA, HEIGHT + 1);
    expect(r2.valid, r2.error).toBe(true);
    beginBlockJournal(HEIGHT + 1);
    applyTx(deps, burnA, r2.computedOutputs!, HEIGHT + 1);
    deleteUsername('reclaim');
    finishBlockJournal();

    const b = makeTestIdentity();
    const kb = seedKarma(b.userId, 100n);
    insertBox(kb);
    const claimB = claimTx(b, kb, 'Reclaim');
    const r3 = validateTx(deps, claimB, HEIGHT + 2);
    expect(r3.valid, r3.error).toBe(true);
  });

  it('claim → burn → claim the same name by the same identity', () => {
    const a = makeTestIdentity();
    const ka = seedKarma(a.userId, 100n);
    insertBox(ka);

    const c1 = claimTx(a, ka, 'SelfReclaim');
    const r1 = validateTx(deps, c1, HEIGHT);
    expect(r1.valid, r1.error).toBe(true);
    beginBlockJournal(HEIGHT);
    applyTx(deps, c1, r1.computedOutputs!, HEIGHT);
    const uOut = r1.computedOutputs!.find(o => o.boxType === 'username')!;
    putUsername({
      nameLower: 'selfreclaim', name: 'SelfReclaim',
      owner: hex(a.userId), boxId: uOut.id!, claimedAtBlock: HEIGHT,
    });
    finishBlockJournal();

    const ka2 = seedKarma(a.userId, 100n);
    insertBox(ka2);
    const b1 = burnTx(a, ka2, uOut as UsernameBox);
    const r2 = validateTx(deps, b1, HEIGHT + 1);
    expect(r2.valid, r2.error).toBe(true);
    beginBlockJournal(HEIGHT + 1);
    applyTx(deps, b1, r2.computedOutputs!, HEIGHT + 1);
    deleteUsername('selfreclaim');
    finishBlockJournal();

    const ka3 = seedKarma(a.userId, 100n);
    insertBox(ka3);
    const c2 = claimTx(a, ka3, 'SelfReclaim');
    const r3 = validateTx(deps, c2, HEIGHT + 2);
    expect(r3.valid, r3.error).toBe(true);
  });

  // --- Mixed-input refusals ---

  it('username + credit inputs refused', () => {
    const holder = makeTestIdentity();
    const kb = seedKarma(holder.userId, 100n);
    insertBox(kb);
    const ub = seedUsernameBox(holder.userId, 'Mix1');
    insertBox(ub);
    const cb = seedProvenance<AnyBox>(
      { boxType: 'credit', value: 10n, createdAtBlock: 1, owner: holder.userId } as AnyBox, 1, nonce++,
    );
    insertBox(cb);

    const tx: UtxoTransaction = {
      inputs: [cb.id!, ub.id!],
      outputs: [],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, holder.privateKey, hex(holder.userId));
    const result = validateTx(deps, tx, HEIGHT);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Mixed input types');
  });

  it('two username inputs refused', () => {
    const holder = makeTestIdentity();
    const kb = seedKarma(holder.userId, 100n);
    insertBox(kb);
    const ub1 = seedUsernameBox(holder.userId, 'Dup1');
    insertBox(ub1);
    const ub2 = seedUsernameBox(holder.userId, 'Dup2');
    insertBox(ub2);

    const tx: UtxoTransaction = {
      inputs: [kb.id!, ub1.id!, ub2.id!],
      outputs: [
        { boxType: 'karma_price', value: USERNAME_BURN_PRICE, createdAtBlock: HEIGHT } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, holder.privateKey, hex(holder.userId));
    const result = validateTx(deps, tx, HEIGHT);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('At most one username input');
  });

  it('a username input alone refused', () => {
    const holder = makeTestIdentity();
    const ub = seedUsernameBox(holder.userId, 'Solo');
    insertBox(ub);

    const tx: UtxoTransaction = {
      inputs: [ub.id!],
      outputs: [],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, holder.privateKey, hex(holder.userId));
    const result = validateTx(deps, tx, HEIGHT);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('username input alone');
  });

  // --- Username IO with like/post/withdraw refused ---

  it('a username input with likeTarget refused', () => {
    const holder = makeTestIdentity();
    const kb = seedKarma(holder.userId, 100n);
    insertBox(kb);
    const ub = seedUsernameBox(holder.userId, 'LikeBurn');
    insertBox(ub);

    const tx: UtxoTransaction = {
      inputs: [kb.id!, ub.id!],
      outputs: [
        { boxType: 'karma', value: 99n, createdAtBlock: HEIGHT, owner: holder.userId } as AnyBoxCandidate,
        { boxType: 'like_accrual', value: 1n, createdAtBlock: HEIGHT, author: holder.userId } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      likeTarget: 'aa'.repeat(32),
    };
    signTransaction(tx, holder.privateKey, hex(holder.userId));
    const result = validateTx(deps, tx, HEIGHT);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/not legal on a like|all-karma/i);
  });

  it('a username input with post refused', () => {
    const holder = makeTestIdentity();
    const kb = seedKarma(holder.userId, 100n);
    insertBox(kb);
    const ub = seedUsernameBox(holder.userId, 'PostBurn');
    insertBox(ub);

    const tx: UtxoTransaction = {
      inputs: [kb.id!, ub.id!],
      outputs: [
        { boxType: 'karma', value: 95n, createdAtBlock: HEIGHT, owner: holder.userId } as AnyBoxCandidate,
        { boxType: 'karma_price', value: 5n, createdAtBlock: HEIGHT } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      post: {
        contentHash: Buffer.alloc(32, 0xcc),
        author: holder.userId,
        parentRefs: [],
        protocolVersion: PROTOCOL_VERSION,
        type: 'regular',
      },
    };
    signTransaction(tx, holder.privateKey, hex(holder.userId));
    const result = validateTx(deps, tx, HEIGHT);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not legal on a like, post or withdrawal');
  });

  it('a username input with postWithdraw refused', () => {
    const holder = makeTestIdentity();
    const kb = seedKarma(holder.userId, 100n);
    insertBox(kb);
    const ub = seedUsernameBox(holder.userId, 'WdBurn');
    insertBox(ub);

    const tx: UtxoTransaction = {
      inputs: [kb.id!, ub.id!],
      outputs: [
        { boxType: 'karma', value: 100n, createdAtBlock: HEIGHT, owner: holder.userId } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      postWithdraw: { postId: 'dd'.repeat(32) },
    };
    signTransaction(tx, holder.privateKey, hex(holder.userId));
    const result = validateTx(deps, tx, HEIGHT);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not legal on a like, post or withdrawal');
  });

  it('a username output with post refused', () => {
    const holder = makeTestIdentity();
    const kb = seedKarma(holder.userId, 100n);
    insertBox(kb);

    const tx: UtxoTransaction = {
      inputs: [kb.id!],
      outputs: [
        { boxType: 'karma', value: 95n, createdAtBlock: HEIGHT, owner: holder.userId } as AnyBoxCandidate,
        { boxType: 'karma_price', value: 5n, createdAtBlock: HEIGHT } as AnyBoxCandidate,
        { boxType: 'username', value: 0n, createdAtBlock: HEIGHT, owner: holder.userId, name: Buffer.from('PostClaim', 'utf8') } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      post: {
        contentHash: Buffer.alloc(32, 0xcc),
        author: holder.userId,
        parentRefs: [],
        protocolVersion: PROTOCOL_VERSION,
        type: 'regular',
      },
    };
    signTransaction(tx, holder.privateKey, hex(holder.userId));
    const result = validateTx(deps, tx, HEIGHT);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not legal on a like, post or withdrawal');
  });

  // --- Conservation with the 0n box ---

  it('conservation holds with a 0n username box in the sum', () => {
    const holder = makeTestIdentity();
    const kb = seedKarma(holder.userId, 100n);
    insertBox(kb);
    const tx = claimTx(holder, kb, 'Conserve');
    const result = validateTx(deps, tx, HEIGHT);
    expect(result.valid, result.error).toBe(true);
  });

  it('conservation holds for a burn (the 0n input balances with karma change + price)', () => {
    const holder = makeTestIdentity();
    const kb = seedKarma(holder.userId, 100n);
    insertBox(kb);
    const ub = seedUsernameBox(holder.userId, 'BurnCons');
    insertBox(ub);
    const tx = burnTx(holder, kb, ub);
    const result = validateTx(deps, tx, HEIGHT);
    expect(result.valid, result.error).toBe(true);
  });
});
