// ---------------------------------------------------------------------------
// The settlement's escrow leg: at height h, every unspent VouchEscrowBox with
// releaseAtBlock <= h is consumed (ascending box id, pre-body) and its value
// returned to its owner as karma
// (NODE_INTERFACE → The settlement transaction).
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  VOUCH_KARMA_AMOUNT,
  MAX_BLOCK_BODY_BYTES,
} from '@dagsocial/types';
import type {
  KarmaBox,
  VouchBox,
  VouchEscrowBox,
  UtxoTransaction,
  OrderingBlock,
} from '@dagsocial/types';
import {
  hex,
  makeKarmaBox,
  makeTestConfig,
  makeTestIdentity,
  mineNextBlock,
  seedProvenance,
  signTransaction,
  type Stored,
} from '../helpers.js';
import type { TestIdentity } from '../helpers.js';
import { config } from '../../src/config.js';
import type { Config } from '../../src/config.js';

const testConfig = makeTestConfig({
  port: 3000,
  dbPath: ':memory:',
  networkType: 'testnet' as const,
  nodeRole: 'miner' as const,
  blockBodyBudgetBytes: MAX_BLOCK_BODY_BYTES,
  orderingBlockPowTargetBits: 3072,
  bootstrapPeers: [] as string[],
  listenAddrs: '/ip4/127.0.0.1/tcp/0',
  maxPeers: 50,
});

type DbModule = {
  initDb: (path: string) => void;
  getDb: () => import('better-sqlite3').Database;
  closeDb: () => void;
};

async function importDb(): Promise<DbModule> {
  return (await import('../../src/store/db.js')) as unknown as DbModule;
}

async function importBlockCreator() {
  return (await import('../../src/services/block-creator.js')) as unknown as {
    startBlockCreator: (cfg: Config) => void;
    stopBlockCreator: () => void;
    createOrderingBlock: () => OrderingBlock | null;
    getCurrentTemplate: () => OrderingBlock | null;
    submitMinedBlock: (powNonce: number, submittedHeight: number) => string | null;
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown) => void;
    getBox: (boxId: string) => unknown;
    getKarmaBoxes: (owner: Uint8Array) => KarmaBox[];
    getKarmaValue: (owner: Uint8Array) => bigint;
    getUnspentBoxes: () => import('@dagsocial/types').AnyBox[];
    getVouchEscrowsFor: (voucherId: Uint8Array) => VouchEscrowBox[];
    hasActiveVouchEscrow: (voucherId: Uint8Array) => boolean;
    getVouchEscrowsReleasableAt: (height: number, limit: number) => VouchEscrowBox[];
  };
}

async function importMempool() {
  return (await import('../../src/store/mempool.js')) as {
    insertUtxoTx: (tx: UtxoTransaction, expiresAtHeight: number) => number;
  };
}

async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as {
    getCurrentHeight: () => number;
    getOrderingBlock: (height: number) => OrderingBlock | null;
  };
}

function makeVouchBox(
  value: bigint,
  voucherId: Uint8Array,
  targetId: Uint8Array,
  createdAtBlock = 0,
): Stored<VouchBox> {
  return seedProvenance<VouchBox>({
    boxType: 'vouch' as const,
    value,
    createdAtBlock,
    voucherId,
    targetId,
  }, 1);
}

function makeEscrowBox(
  value: bigint,
  owner: Uint8Array,
  releaseAtBlock: number,
  nonce = 0,
): Stored<VouchEscrowBox> {
  return seedProvenance<VouchEscrowBox>({
    boxType: 'vouch_escrow' as const,
    value,
    createdAtBlock: 0,
    owner,
    releaseAtBlock,
  }, 1, nonce);
}

function makeUnvouchTx(
  vouchBoxId: string,
  signer: TestIdentity,
  value: bigint,
  releaseAtBlock: number,
): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [vouchBoxId],
    outputs: [{
      boxType: 'vouch_escrow' as const,
      value,
      createdAtBlock: 0,
      owner: signer.userId,
      releaseAtBlock,
    } as never],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, signer.privateKey, hex(signer.userId));
  return tx;
}

describe('escrow settlement leg', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch {
      // Module might not have been imported
    }
    vi.resetModules();
  });

  // §4.7 (a): at releaseAtBlock == h, the escrow is an input and its value a
  // karma output to owner in the stated position (after
  // bond outputs, before decay).
  it('(a) escrow at releaseAtBlock == h is consumed and returned as karma', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const voucher = makeTestIdentity();
    const stakeValue = 5n;

    const escrow = makeEscrowBox(stakeValue, voucher.userId, 1);
    utxo.insertBox(escrow);

    expect(utxo.hasActiveVouchEscrow(voucher.userId)).toBe(true);
    expect(utxo.getVouchEscrowsReleasableAt(1, 64)).toHaveLength(1);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const block = await mineNextBlock(bc);
    expect(block).not.toBeNull();

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(1);

    // The escrow is spent
    expect(utxo.hasActiveVouchEscrow(voucher.userId)).toBe(false);
    expect(utxo.getVouchEscrowsFor(voucher.userId)).toHaveLength(0);

    // The voucher received the stake back as karma
    const karmaBoxes = utxo.getKarmaBoxes(voucher.userId);
    expect(karmaBoxes.length).toBeGreaterThanOrEqual(1);
    const returnBox = karmaBoxes.find((b) => b.value === stakeValue);
    expect(returnBox).toBeDefined();
    expect(returnBox!.createdAtBlock).toBe(1);

    // The settlement's inputs include the escrow
    const storedBlock = ordering.getOrderingBlock(1)!;
    const lastTxCbor = storedBlock.utxoTxTree.utxoTxs[storedBlock.utxoTxTree.utxoTxs.length - 1]!;
    const { decodeTx } = await import('@dagsocial/types');
    const settlement = decodeTx(lastTxCbor);
    expect(settlement.inputs).toContain(escrow.id);
  });

  // §4.7 (b): releaseAtBlock > h is NOT consumed.
  it('(b) escrow above the current height is not consumed', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const voucher = makeTestIdentity();

    const escrow = makeEscrowBox(3n, voucher.userId, 100);
    utxo.insertBox(escrow);

    expect(utxo.getVouchEscrowsReleasableAt(1, 64)).toHaveLength(0);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const block = await mineNextBlock(bc);
    expect(block).not.toBeNull();

    // The escrow is still live
    expect(utxo.hasActiveVouchEscrow(voucher.userId)).toBe(true);
    expect(utxo.getVouchEscrowsFor(voucher.userId)).toHaveLength(1);

    // No karma returned
    expect(utxo.getKarmaValue(voucher.userId)).toBe(0n);
  });

  // §4.7 (c): the born-overdue case. An escrow created by the body of block h
  // with releaseAtBlock <= h is not in the pre-body snapshot, so the settlement
  // at h does not consume it — it returns at h+1.
  //
  // Devnet cooldown is 3, so a vouch cast at block 0 unvouched at h yields
  // releaseAtBlock = 0 + 3 = 3. The unvouch must ride in the body of block h
  // where h >= releaseAtBlock for the escrow to be born overdue. Mine
  // coinbase-only blocks to h-1, queue the unvouch, mine block h. The escrow
  // survives block h (pre-body capture) and returns at h+1.
  it('(c) born-overdue escrow returns at h+1, not h', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const utxo = await importUtxo();
    const mempool = await importMempool();
    const records = await import('../../src/store/identity-records.js');
    const voucher = makeTestIdentity();
    const target = makeTestIdentity();
    const rootRec = {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 0,
      lifetimeLikesReceived: 0n, memberSinceBlock: 1, memberBar: 0,
      memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
    };
    records.putIdentityRecord(voucher.userId, rootRec);
    records.putIdentityRecord(target.userId, {
      ...rootRec, memberSinceBlock: 0, invitedAtBlock: 1,
    });

    const karma = makeKarmaBox(VOUCH_KARMA_AMOUNT, voucher.userId, 0);
    utxo.insertBox(karma);
    const vouch = makeVouchBox(VOUCH_KARMA_AMOUNT, voucher.userId, target.userId, 0);
    utxo.insertBox(vouch);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    const releaseAtBlock = 0 + config.vouchCooldownBlocks;

    // Mine coinbase-only blocks up to releaseAtBlock - 1.
    for (let h = 1; h < releaseAtBlock; h++) {
      const b = await mineNextBlock(bc);
      expect(b).not.toBeNull();
    }

    // Queue the unvouch for block at releaseAtBlock.
    const unvouchTx = makeUnvouchTx(vouch.id!, voucher, VOUCH_KARMA_AMOUNT, releaseAtBlock);
    mempool.insertUtxoTx(unvouchTx, 100000);

    // Block at releaseAtBlock: the body creates the escrow with
    // releaseAtBlock <= h. Pre-body capture does NOT see it.
    const blockAtRelease = await mineNextBlock(bc);
    expect(blockAtRelease).not.toBeNull();

    // The escrow exists but was NOT consumed (born overdue — pre-body).
    expect(utxo.hasActiveVouchEscrow(voucher.userId)).toBe(true);

    // Next block: the settlement sees the escrow and returns it.
    const nextBlock = await mineNextBlock(bc);
    expect(nextBlock).not.toBeNull();
    expect(utxo.hasActiveVouchEscrow(voucher.userId)).toBe(false);

    const karmaBoxes = utxo.getKarmaBoxes(voucher.userId);
    const returnedBox = karmaBoxes.find((b) => b.value === VOUCH_KARMA_AMOUNT);
    expect(returnedBox).toBeDefined();
  });

  // §4.7 (d): two escrows ascending box id.
  it('(d) two escrows are consumed in ascending box id order', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const voucher1 = makeTestIdentity();
    const voucher2 = makeTestIdentity();

    const escrow1 = makeEscrowBox(3n, voucher1.userId, 1, 0);
    const escrow2 = makeEscrowBox(7n, voucher2.userId, 1, 1);
    utxo.insertBox(escrow1);
    utxo.insertBox(escrow2);

    // Both are releasable at height 1
    const releasable = utxo.getVouchEscrowsReleasableAt(1, 64);
    expect(releasable).toHaveLength(2);
    // Ascending box id
    expect(releasable[0]!.id! < releasable[1]!.id!).toBe(true);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const block = await mineNextBlock(bc);
    expect(block).not.toBeNull();

    // Both escrows spent
    expect(utxo.hasActiveVouchEscrow(voucher1.userId)).toBe(false);
    expect(utxo.hasActiveVouchEscrow(voucher2.userId)).toBe(false);

    // Both received karma back
    expect(utxo.getKarmaValue(voucher1.userId)).toBe(3n);
    expect(utxo.getKarmaValue(voucher2.userId)).toBe(7n);

    // Settlement inputs include both, in ascending id order
    const ordering = await importOrdering();
    const storedBlock = ordering.getOrderingBlock(1)!;
    const lastTxCbor = storedBlock.utxoTxTree.utxoTxs[storedBlock.utxoTxTree.utxoTxs.length - 1]!;
    const { decodeTx } = await import('@dagsocial/types');
    const settlement = decodeTx(lastTxCbor);
    const escrowIdx1 = settlement.inputs.indexOf(escrow1.id!);
    const escrowIdx2 = settlement.inputs.indexOf(escrow2.id!);
    expect(escrowIdx1).toBeGreaterThanOrEqual(0);
    expect(escrowIdx2).toBeGreaterThanOrEqual(0);
    // The one with the lower id comes first
    if (escrow1.id! < escrow2.id!) {
      expect(escrowIdx1).toBeLessThan(escrowIdx2);
    } else {
      expect(escrowIdx2).toBeLessThan(escrowIdx1);
    }
  });

  // §4.7 (e): conservation. The escrow leg moves value box to box with no pool
  // contribution. Verified by building the settlement through the shared
  // derivation and checking it — the same path block application runs.
  it('(e) the settlement conserves value with escrow returns', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const voucher = makeTestIdentity();
    const stakeValue = 11n;

    const escrow = makeEscrowBox(stakeValue, voucher.userId, 1);
    utxo.insertBox(escrow);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const block = await mineNextBlock(bc);
    expect(block).not.toBeNull();

    // The block applied — checkSettlement passed, which includes the
    // conservation check (settlement.ts §5). Verify the escrow was consumed
    // and its exact value returned.
    expect(utxo.hasActiveVouchEscrow(voucher.userId)).toBe(false);
    const karmaBoxes = utxo.getKarmaBoxes(voucher.userId);
    const returnBox = karmaBoxes.find((b) => b.value === stakeValue);
    expect(returnBox).toBeDefined();
    // Direct conservation: Σ input values == Σ output values. Inputs are
    // spent, so read them including consumed boxes via raw SQL.
    const ordering = await importOrdering();
    const storedBlock = ordering.getOrderingBlock(1)!;
    const lastTxCbor = storedBlock.utxoTxTree.utxoTxs[storedBlock.utxoTxTree.utxoTxs.length - 1]!;
    const { decodeTx } = await import('@dagsocial/types');
    const settlement = decodeTx(lastTxCbor);
    const rawDb = db.getDb();
    let totalIn = 0n;
    for (const inputId of settlement.inputs) {
      const row = rawDb.prepare('SELECT value FROM utxo_boxes WHERE id = ?').safeIntegers().get(inputId) as { value: bigint } | undefined;
      expect(row).toBeDefined();
      totalIn += row!.value;
    }
    const totalOut = settlement.outputs.reduce((sum, o) => sum + o.value, 0n);
    expect(totalIn).toBe(totalOut);
  });

  // §4.7 (f): after the return, hasActiveVouchEscrow is false and a recast
  // by the voucher is accepted. The cast needs VOUCH_MIN_BALANCE (11n), so
  // the fixture seeds enough karma that the returned escrow brings the total
  // above the threshold.
  it('(f) after the escrow returns, hasActiveVouchEscrow clears and a recast is accepted', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const utxo = await importUtxo();
    const mempool = await importMempool();
    const records = await import('../../src/store/identity-records.js');
    const { VOUCH_MIN_BALANCE } = await import('@dagsocial/types');
    const voucher = makeTestIdentity();
    const target = makeTestIdentity();
    const target2 = makeTestIdentity();
    const rootRec = {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 0,
      lifetimeLikesReceived: 0n, memberSinceBlock: 1, memberBar: 0,
      memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
    };
    records.putIdentityRecord(voucher.userId, rootRec);
    records.putIdentityRecord(target.userId, { ...rootRec, memberSinceBlock: 0, invitedAtBlock: 1 });
    records.putIdentityRecord(target2.userId, { ...rootRec, memberSinceBlock: 0, invitedAtBlock: 1 });

    // Seed karma above VOUCH_MIN_BALANCE so the voucher can cast twice.
    const seedKarma = VOUCH_MIN_BALANCE + VOUCH_KARMA_AMOUNT;
    const karma = makeKarmaBox(seedKarma, voucher.userId, 0);
    utxo.insertBox(karma);

    // First vouch and unvouch.
    const vouch = makeVouchBox(VOUCH_KARMA_AMOUNT, voucher.userId, target.userId, 0);
    utxo.insertBox(vouch);
    const unvouchTx = makeUnvouchTx(vouch.id!, voucher, VOUCH_KARMA_AMOUNT, 0 + config.vouchCooldownBlocks);
    mempool.insertUtxoTx(unvouchTx, 100000);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    // Mine block 1: the unvouch applies, escrow created.
    await mineNextBlock(bc);
    expect(utxo.hasActiveVouchEscrow(voucher.userId)).toBe(true);

    // Mine to releaseAtBlock so the settlement consumes the escrow.
    for (let h = 2; h <= config.vouchCooldownBlocks; h++) {
      await mineNextBlock(bc);
    }
    expect(utxo.hasActiveVouchEscrow(voucher.userId)).toBe(false);

    // Build the recast: karma → karma-change + VouchBox targeting target2.
    const karmaBoxes = utxo.getKarmaBoxes(voucher.userId);
    const karmaForCast = karmaBoxes.find((b) => b.value >= VOUCH_MIN_BALANCE);
    expect(karmaForCast).toBeDefined();
    const castHeight = config.vouchCooldownBlocks + 1;
    const castTx: UtxoTransaction = {
      inputs: [karmaForCast!.id!],
      outputs: [
        {
          boxType: 'karma' as const,
          value: karmaForCast!.value - VOUCH_KARMA_AMOUNT,
          createdAtBlock: castHeight,
          owner: voucher.userId,
        },
        {
          boxType: 'vouch' as const,
          value: VOUCH_KARMA_AMOUNT,
          createdAtBlock: castHeight,
          voucherId: voucher.userId,
          targetId: target2.userId,
        } as never,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(castTx, voucher.privateKey, hex(voucher.userId));
    mempool.insertUtxoTx(castTx, 100000);

    // Mine the recast — if it applies, the cast was accepted.
    const recastBlock = await mineNextBlock(bc);
    expect(recastBlock).not.toBeNull();

    // The new VouchBox exists.
    const boxes = utxo.getUnspentBoxes();
    const newVouch = boxes.find(
      (b) => b.boxType === 'vouch' && Buffer.from((b as VouchBox).targetId).equals(Buffer.from(target2.userId)),
    );
    expect(newVouch).toBeDefined();
  });

  // §4.7 (g): a user transaction spending an escrow is refused.
  it('(g) a user transaction spending an escrow is refused', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const voucher = makeTestIdentity();

    const escrow = makeEscrowBox(5n, voucher.userId, 1);
    utxo.insertBox(escrow);

    const { validateTx } = await import('../../src/services/utxo-engine.js');
    const { getBox, getIdentityRecord, getKarmaBox, getKarmaBoxes, hasActiveVouchEscrow, insertBox, consumeBox } = await import('../../src/store/index.js');
    const tx: UtxoTransaction = {
      inputs: [escrow.id!],
      outputs: [{ boxType: 'karma' as const, value: 5n, createdAtBlock: 0, owner: voucher.userId }],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, voucher.privateKey, hex(voucher.userId));
    const result = validateTx(
      {
        getBox,
        getIdentityRecord,
        insertBox: (box) => insertBox(box),
        consumeBox: (id, atBlock) => consumeBox(id, atBlock),
        getKarmaBox: (owner) => getKarmaBox(owner),
        getKarmaValue: (owner) => getKarmaBoxes(owner).reduce((s, b) => s + b.value, 0n),
        hasActiveVouchEscrow,
        vouchCooldownBlocks: config.vouchCooldownBlocks,
        inviteBondMin: config.inviteBondMin,
        inviteBondMax: config.inviteBondMax,
        decayCfg: {
          staleThresholdBlocks: 1000,
          decayIntervalBlocks: 1000,
          decayAmount: 0n,
          karmaMinimum: 0n,
        },
        storageRentPeriodBlocks: 40,
        getBoxProvenance: () => null,
        getTopologyAuthor: () => null,
        getPendingPostAuthor: () => null,
        runInTransaction: (fn) => fn(),
      getVouchBox: () => null,
      getNetworkRecord: () => ({ memberCount: 1 }),
      membershipBarMultiplier: 1,
      putIdentityRecord: () => {},
      },
      tx,
      10,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('consumed only by block application');
  });
});
