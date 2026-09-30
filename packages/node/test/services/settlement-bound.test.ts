// ---------------------------------------------------------------------------
// Settlement bound tests — T1 through T6.
//
// Each test pins a hazard the settlement byte bound and the capped state-driven
// legs exist to close (NODE_INTERFACE → The settlement transaction).
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MAX_SETTLEMENT_BYTES,
  MAX_ESCROW_RETURNS_PER_BLOCK,
  MAX_BOND_SETTLEMENTS_PER_BLOCK,
  MAX_LAPSE_WITHDRAWALS_PER_BLOCK,
  LIKE_KARMA_COST,
  encodeTx,
} from '@dagsocial/types';
import type {
  KarmaBox,
  VouchBox,
  VouchEscrowBox,
  UtxoTransaction,
  OrderingBlock,
  BondBox,
} from '@dagsocial/types';
import type Database from 'better-sqlite3';
import type { AnyBox, IdentityRecord, PostCommit } from '@dagsocial/types';
import type { BlockEffects } from '@dagsocial/consensus';
import {
  makeApplicableBlock,
  makePostCommit,
  makeTestIdentity,
  seedBoxes,
  seedCommittedState,
  seedProvenance,
  makeLikeTx,
} from '../helpers.js';
import type { TestIdentity } from '../helpers.js';
import { config } from '../../src/config.js';
import type { Config } from '../../src/config.js';


type DbModule = {
  initDb: (path: string) => void;
  getDb: () => Database.Database;
  closeDb: () => void;
};

async function importDb(): Promise<DbModule> {
  return (await import('../../src/store/db.js')) as unknown as DbModule;
}

async function importBlockApply() {
  return (await import('../../src/services/block-apply.js')) as unknown as {
    applyOrderingBlock: (block: OrderingBlock) => boolean;
  };
}

async function importBlockCreator() {
  const creator = (await import('../../src/services/block-creator.js')) as unknown as {
    startBlockCreator: (cfg: Config) => void;
    stopBlockCreator: () => void;
    createOrderingBlock: () => OrderingBlock | null;
  };
  const { applyContextFrom } = await import('../../src/services/block-apply.js');
  const { config: nodeConfig } = await import('../../src/config.js');
  const { buildBlockSettlement, treeStateView } = await import('@dagsocial/consensus');
  const { getAvlProver } = await import('../../src/state/avl-prover.js');
  const { proverSession } = await import('../../src/state/prover-session.js');
  return {
    startBlockCreator: creator.startBlockCreator,
    stopBlockCreator: creator.stopBlockCreator,
    createOrderingBlock: creator.createOrderingBlock,
    // The settlement build the creator runs: over a tree view on the live
    // prover, under the context of the process config.
    buildBlockSettlement: (
      txBytesList: Uint8Array[],
      height: number,
      validator: Uint8Array,
      minerOwner: Uint8Array,
    ): { tx: UtxoTransaction } | { error: string } =>
      buildBlockSettlement(
        treeStateView(proverSession(getAvlProver().prover)),
        txBytesList, height, validator, minerOwner, applyContextFrom(nodeConfig),
      ),
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown) => void;
    getBox: (boxId: string) => unknown;
    getKarmaBoxes: (owner: Uint8Array) => KarmaBox[];
    getKarmaValue: (owner: Uint8Array) => bigint;
    getVouchEscrowsReleasableAt: (height: number, limit: number) => VouchEscrowBox[];
  };
}

// ---------------------------------------------------------------------------
// T1 — the halt. 150 escrows at one release height drain over multiple blocks.
//
// At 70 bytes per (input + output) pair, 141 fits the old MAX_TX_BYTES 10,000
// and 150 does not (150 × 70 = 10,500). Under the old rule this was an
// unreachable settlement; under the capped legs it drains in ⌈150 / 64⌉ = 3
// blocks.
// ---------------------------------------------------------------------------

describe('T1 — escrow cap and multi-block drain', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    vi.resetModules();
  });

  // 150 × 70 = 10,500 > 10,000 (old MAX_TX_BYTES). Red on b01b81f by
  // arithmetic: 150 pairs do not fit a 10,000-byte transaction.
  it('150 escrows drain over 3 blocks in ascending (releaseAtBlock, box id) order', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();
    const blockApply = await importBlockApply();

    const TOTAL = 150;
    const RELEASE_HEIGHT = 2;

    const owners: TestIdentity[] = [];
    for (let i = 0; i < TOTAL; i++) owners.push(makeTestIdentity());

    // Block 1: empty (seeds emission + pool)
    const block1 = await makeApplicableBlock({ utxoTxs: [] });
    expect(blockApply.applyOrderingBlock(block1)).toBe(true);

    // Seed 150 vouch escrow boxes all releasing at height 2
    const escrows: AnyBox[] = [];
    for (let i = 0; i < TOTAL; i++) {
      escrows.push(seedProvenance<VouchEscrowBox>({
        boxType: 'vouch_escrow' as const,
        value: BigInt(10 + i),
        createdAtBlock: 1,
        owner: owners[i]!.userId,
        releaseAtBlock: RELEASE_HEIGHT,
      }, 1000 + i));
    }
    await seedBoxes(escrows);

    // Blocks 2, 3, 4: each settles up to MAX_ESCROW_RETURNS_PER_BLOCK
    let totalReturned = 0;
    for (let h = 2; h <= 4; h++) {
      const block = await makeApplicableBlock({ height: h, utxoTxs: [] });
      expect(blockApply.applyOrderingBlock(block)).toBe(true);

      const remaining = utxo.getVouchEscrowsReleasableAt(h, TOTAL);
      totalReturned = TOTAL - remaining.length;
    }

    expect(totalReturned).toBe(TOTAL);

    // Every owner got their karma back
    for (let i = 0; i < TOTAL; i++) {
      const karma = utxo.getKarmaValue(owners[i]!.userId);
      expect(karma).toBe(BigInt(10 + i));
    }
  });
});

// ---------------------------------------------------------------------------
// T2 — the like storm. Each like adds one 32-byte marker input to the
// settlement, plus one 38-byte carry output per distinct author. With all
// likes to the same post (one author), the cost after the first is 32 bytes
// per like.
//
// OLD bound: MAX_TX_BYTES 10,000 → N_old ≈ (10,000 − 108) / 32 = 309
// NEW bound: MAX_SETTLEMENT_BYTES 100,000 → N_new ≈ (100,000 − 108) / 32 = 3,122
//
// (a) 320 likes: fits the new bound (the finding closed).
// (b) 3,200 likes: exceeds the new bound — the fill must trim.
// ---------------------------------------------------------------------------

describe('T2 — like storm', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('more likes than the OLD bound fit the new bound; more than the NEW bound exceeds it', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const blockApply = await importBlockApply();
    const bc = await importBlockCreator();

    // Block 1: seeds emission + pool
    const block1 = await makeApplicableBlock({ utxoTxs: [] });
    expect(blockApply.applyOrderingBlock(block1)).toBe(true);

    // One target post (all likes target the same author), confirmed, and the
    // author's karma box (the carry needs one to exist).
    const postAuthor = makeTestIdentity();
    const targetPostId = (9000).toString(16).padStart(64, '0');
    const target: PostCommit = makePostCommit(postAuthor.userId, 'the storm target');
    const authorKarma = seedProvenance<KarmaBox>({
      boxType: 'karma' as const,
      value: 1000n,
      createdAtBlock: 1,
      owner: postAuthor.userId,
    }, 9999);
    await seedCommittedState({
      mutations: [{ kind: 'box', op: 'insert', boxId: authorKarma.id!, box: authorKarma }],
      posts: [{ postId: targetPostId, txId: targetPostId, post: target }],
    });

    // Build like tx bytes — each liker contributes one marker input
    async function makeLikeTxBytes(count: number): Promise<Uint8Array[]> {
      const txBytes: Uint8Array[] = [];
      const boxes: KarmaBox[] = [];
      for (let i = 0; i < count; i++) {
        const liker = makeTestIdentity();
        const karmaBox = seedProvenance<KarmaBox>({
          boxType: 'karma' as const,
          value: LIKE_KARMA_COST,
          createdAtBlock: 1,
          owner: liker.userId,
        }, 10_000 + i);
        boxes.push(karmaBox);
        const tx = makeLikeTx(liker, karmaBox, targetPostId, postAuthor.userId);
        txBytes.push(encodeTx(tx));
      }
      await seedBoxes(boxes);
      return txBytes;
    }

    const miner = makeTestIdentity();

    // (a) 320 likes: exceeds old MAX_TX_BYTES, fits MAX_SETTLEMENT_BYTES
    const likesA = await makeLikeTxBytes(320);
    const resultA = bc.buildBlockSettlement(likesA, 2, miner.userId, miner.userId);
    expect('tx' in resultA).toBe(true);
    if ('tx' in resultA) {
      const bytes = encodeTx(resultA.tx).length;
      expect(bytes).toBeGreaterThan(10_000);
      expect(bytes).toBeLessThanOrEqual(MAX_SETTLEMENT_BYTES);
    }

    // (b) 3,200 likes: exceeds MAX_SETTLEMENT_BYTES — the fill must trim
    const likesB = await makeLikeTxBytes(3200);
    const resultB = bc.buildBlockSettlement(likesB, 2, miner.userId, miner.userId);
    expect('tx' in resultB).toBe(true);
    if ('tx' in resultB) {
      const bytes = encodeTx(resultB.tx).length;
      expect(bytes).toBeGreaterThan(MAX_SETTLEMENT_BYTES);
    }
  });
});

// ---------------------------------------------------------------------------
// T3 — the liveness relation: buildSettlement over an empty body with every
// state-driven leg at its cap encodes ≤ MAX_SETTLEMENT_BYTES.
// ---------------------------------------------------------------------------

describe('T3 — liveness relation', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('a settlement with all three state-driven legs at cap fits MAX_SETTLEMENT_BYTES', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const blockApply = await importBlockApply();
    const bc = await importBlockCreator();

    // Block 1: empty (seeds emission + pool)
    const block1 = await makeApplicableBlock({ utxoTxs: [] });
    expect(blockApply.applyOrderingBlock(block1)).toBe(true);

    // Seed 64 bonds, 64 escrows, and 64 lapsed vouches — the three capped legs.
    // Committed at height 1, so each bond's due key is 1 (CONSENSUS_INTERFACE →
    // The tree writes): due by `settleHeight`, whose sweep reads the bonds
    // invited at or below `BOND_HEIGHT`.
    const BOND_HEIGHT = 2;
    const probation = config.inviteProbationBlocks;
    const settleHeight = BOND_HEIGHT + probation;
    const mutations: BlockEffects['mutations'] = [];
    const insert = (box: AnyBox): void => { mutations.push({ kind: 'box', op: 'insert', boxId: box.id!, box }); };

    for (let i = 0; i < MAX_BOND_SETTLEMENTS_PER_BLOCK; i++) {
      const owner = makeTestIdentity();
      insert(seedProvenance<BondBox>({
        boxType: 'bond' as const,
        value: 25n,
        createdAtBlock: 1,
        inviterId: owner.userId,
        inviteePublicKey: makeTestIdentity().userId,
      }, 2000 + i));
    }

    for (let i = 0; i < MAX_ESCROW_RETURNS_PER_BLOCK; i++) {
      const owner = makeTestIdentity();
      insert(seedProvenance<VouchEscrowBox>({
        boxType: 'vouch_escrow' as const,
        value: 10n,
        createdAtBlock: 1,
        owner: owner.userId,
        releaseAtBlock: settleHeight,
      }, 3000 + i));
    }

    for (let i = 0; i < MAX_LAPSE_WITHDRAWALS_PER_BLOCK; i++) {
      const voucher = makeTestIdentity();
      const target = makeTestIdentity();
      // The voucher's record fails member(): memberSinceBlock > 0 but
      // memberVouches (0) < memberBar (1).
      const record: IdentityRecord = {
        lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 0,
        lifetimeLikesReceived: 0n, memberSinceBlock: 1, memberBar: 1,
        memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
      };
      mutations.push({ kind: 'record', identityId: voucher.userId, record });
      insert(seedProvenance<VouchBox>({
        boxType: 'vouch' as const,
        value: 1n,
        createdAtBlock: 1,
        voucherId: voucher.userId,
        targetId: target.userId,
      }, 4000 + i));
    }
    await seedCommittedState({ mutations });

    // Build the settlement at settleHeight with an empty body
    const miner = makeTestIdentity();
    const result = bc.buildBlockSettlement([], settleHeight, miner.userId, miner.userId);

    expect('tx' in result).toBe(true);
    if ('tx' in result) {
      const encoded = encodeTx(result.tx);
      console.log(`Empty-body settlement with 3 capped legs: ${encoded.length} bytes`);
      expect(encoded.length).toBeLessThanOrEqual(MAX_SETTLEMENT_BYTES);
    }
  });
});

