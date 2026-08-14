import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  EMPTY_STATE_ROOT,
  PROTOCOL_VERSION,
  VOUCH_KARMA_AMOUNT,
} from '@dagsocial/types';
import type {
  KarmaBox,
  OrderingBlock,
  UtxoTransaction,
  VouchBox,
} from '@dagsocial/types';
import type Database from 'better-sqlite3';
import type { Config } from '../../src/config.js';
import type { TestIdentity } from '../helpers.js';
import {
  makeKarmaBox,
  makeTestConfig,
  makeTestIdentity,
  mineNextBlock,
  seedProvenance,
  signTransaction,
  type Stored,
} from '../helpers.js';

// ---------------------------------------------------------------------------
// P2-B phase 1c — the creator must not mine a body its own mutation phase
// rejected.
//
// The reachable scenario is a stale mempool entry: a vouch cast that was valid
// at pool entry (voucher at or above VOUCH_MIN_BALANCE) turns invalid while
// pooled, because a spend of the voucher's OTHER karma box commits first. Its
// own input stays live, so at block creation the embedded-tx re-validation —
// not the liveness skip — is what fails, and the speculative state-root run
// (H-6) rejects the whole body.
//
// The vehicle has to be a rule whose verdict can move without touching the
// transaction's inputs, and the minimum-balance gate is one: it reads the
// voucher's summed karma, which any other spend changes.
//
// The pre-fix twin of the first test passed on unmodified HEAD (2026-08-07):
// createOrderingBlock() solved real PoW over a header carrying
// EMPTY_STATE_ROOT while this node held a live prover — the `?? EMPTY_STATE_
// ROOT` fallback conflated "no prover" with "body rejected" — and the node's
// own apply then rejected that block at embedded-tx re-validation. Work
// wasted, height skipped; finalizeBlock's cleanup evicted the entry, so the
// next interval self-healed.
// ---------------------------------------------------------------------------

// Every field below is kept verbatim; `makeTestConfig` fills only the thirteen
// `Config` requires this literal never stated. Hazard removal, not error removal:
// as a bare literal its type is what `startBlockCreator`'s parameter was declared
// against, so a newly-required `Config` field would have gone unnoticed here.
const testConfig = makeTestConfig({
  port: 3000,
  dbPath: ':memory:',
  networkType: 'testnet' as const,
  nodeRole: 'miner' as const,
  postPowTargetBits: 20,
  challengeWindowBlocks: 10,
  maxSubBlocksPerBlock: 1000,
  orderingBlockPowTargetBits: 3072,
  creditTreasuryPct: 10,
  treasuryPubKey: '',
  bootstrapPeers: [] as string[],
  listenAddrs: '/ip4/127.0.0.1/tcp/0',
  maxPeers: 50,
});

type DbModule = {
  initDb: (path: string) => void;
  getDb: () => Database.Database;
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

async function importMempool() {
  return (await import('../../src/store/mempool.js')) as {
    insertUtxoTx: (
      tx: UtxoTransaction,
      batchId: string | null,
      expiresAtHeight: number,
    ) => number;
    getPendingEntries: (limit: number) => Array<{ rowid: number }>;
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown) => void;
    consumeBox: (boxId: string, consumedAtBlock: number) => void;
    getBox: (boxId: string) => unknown;
    getKarmaBox: (owner: Uint8Array) => KarmaBox | null;
    getKarmaBoxes: (owner: Uint8Array) => KarmaBox[];
    getUnspentBoxes: () => import('@dagsocial/types').AnyBox[];
  };
}

async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as {
    getCurrentHeight: () => number;
    getOrderingBlock: (height: number) => OrderingBlock | null;
  };
}

async function importAvl() {
  return (await import('../../src/state/avl-prover.js')) as
    typeof import('../../src/state/avl-prover.js');
}

/** Prover singleton on the test DB, seeded boxes bootstrapped — src/index.ts wiring. */
async function activateProver() {
  const avlMod = await importAvl();
  const utxo = await importUtxo();
  const handle = avlMod.createAvlProver();
  const unspent = utxo.getUnspentBoxes();
  if (unspent.length > 0) avlMod.bootstrapAvlProver(handle, unspent, 0, []);
  expect(avlMod.tryGetAvlProver()).not.toBeNull();
  return handle;
}

/** The engine deps every production validation path builds over the store. */
async function storeBackedDeps() {
  const utxoStore = await import('../../src/store/utxo.js');
  const vouchCooldowns = await import('../../src/store/vouch-cooldowns.js');
  const identityStore = await import('../../src/store/identity-records.js');
  const { getDb } = await import('../../src/store/db.js');
  return {
    getBox: utxoStore.getBox,
    getIdentityRecord: identityStore.getIdentityRecord,
    insertBox: utxoStore.insertBox,
    consumeBox: utxoStore.consumeBox,
    getKarmaBox: utxoStore.getKarmaBox,
    getKarmaValue: utxoStore.getKarmaValue,
    hasActiveVouchCooldown: vouchCooldowns.hasActiveVouchCooldown,
    runInTransaction: (fn: () => void) => {
      getDb().transaction(fn)();
    },
    isSystemBox: () => false,
  };
}

/** `karmaIn` → karma change + a VouchBox staking VOUCH_KARMA_AMOUNT. */
function makeVouchCastTx(
  karmaIn: KarmaBox,
  voucher: TestIdentity,
  targetId: Uint8Array,
): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [karmaIn.id!],
    outputs: [
      {
        boxType: 'karma',
        value: karmaIn.value - VOUCH_KARMA_AMOUNT,
        owner: voucher.userId,
        guard: 'owner_signature',
      } as KarmaBox,
      {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        voucherId: voucher.userId,
        targetId,
        guard: 'owner_signature',
      } as VouchBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, voucher.privateKey, Buffer.from(voucher.userId).toString('hex'));
  return tx;
}

/**
 * Seed the stale-entry scenario and return its pieces: a vouch cast that was
 * valid at pool entry and turns invalid while pooled, with its own input still
 * live.
 *
 * The vehicle is the vouch minimum-balance gate, which is a predicate on the
 * voucher's *summed* karma rather than on this transaction's inputs. That is
 * what makes the staleness reachable at all: a spend of a box the cast never
 * named moves the verdict, so at block creation the embedded-tx re-validation —
 * not the liveness skip — is what fails.
 */
async function seedStaleVouchCast() {
  const utxo = await importUtxo();
  const mempool = await importMempool();

  const voucher = makeTestIdentity();
  const target = makeTestIdentity();

  // 6 + 6 = 12, above VOUCH_MIN_BALANCE (11) at pool time. Split across two
  // boxes on purpose: the cast names only the first, so consuming the second is
  // a change to the voucher's balance that leaves the cast's input live.
  const spent = makeKarmaBox(6n, voucher.userId, 0, 0);
  const other = makeKarmaBox(6n, voucher.userId, 0, 1);
  utxo.insertBox(spent);
  utxo.insertBox(other);

  const cast = makeVouchCastTx(spent, voucher, target.userId);

  // Entry-time proof: this is the tx pool entry / relay validation accepts.
  const { validateTx } = await import('../../src/services/utxo-engine.js');
  const deps = await storeBackedDeps();
  expect(validateTx(deps, cast, 1).valid).toBe(true);

  mempool.insertUtxoTx(cast, null, 1000);

  // The voucher's other box is consumed AFTER the cast pooled, dropping the
  // summed balance below the minimum. The cast's own input stays live.
  utxo.consumeBox(other.id!, 0);
  expect(validateTx(deps, cast, 1).valid).toBe(false);

  return { utxo, mempool, voucher, target, spent, cast };
}

describe('block creator vs a body its own mutation phase rejects', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch {
      // Module might not have been imported
    }
    vi.doUnmock('../../src/state/avl-prover.js');
    vi.resetModules();
  });

  it('produces nothing on a rejected body, evicts it, and self-heals next attempt', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const { utxo, mempool, voucher, spent } = await seedStaleVouchCast();

    // Real prover over the committed unspent set — production wiring. This is
    // what makes EMPTY_STATE_ROOT impossible to reach benignly: with a prover
    // live, only the body-rejected arm could ever have produced it.
    const handle = await activateProver();
    const preDigest = Buffer.from(handle.prover.digest()!).toString('hex');

    const ordering = await importOrdering();
    const bc = await importBlockCreator();

    // Starting the creator builds the first template, and this body is one its
    // own mutation phase rejects.
    bc.startBlockCreator(testConfig);

    // No template, so nothing to mine: not stored, no PoW spent, prover
    // untouched.
    expect(bc.getCurrentTemplate()).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(0);
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(Buffer.from(handle.prover.digest()!).toString('hex')).toBe(preDigest);

    // Nothing applied: the cast's karma input survives and no VouchBox exists.
    expect(utxo.getBox(spent.id!)).not.toBeNull();
    expect(utxo.getKarmaBoxes(voucher.userId).reduce((sum, b) => sum + b.value, 0n)).toBe(6n);
    expect(
      db.getDb()
        .prepare(`SELECT id FROM utxo_boxes WHERE box_type = 'vouch' AND spent_at_block IS NULL`)
        .all(),
    ).toHaveLength(0);

    // The poisoned body's entries are evicted — the same cleanup a rejected
    // finalize runs. Without this every later rebuild reassembles the identical
    // body, and purgeExpired cannot break the loop because the chain height it
    // keys on has stopped advancing.
    expect(mempool.getPendingEntries(10)).toHaveLength(0);

    // Next attempt self-heals: a clean block, carrying a real digest, applied.
    const second = await mineNextBlock(bc);
    expect(second).not.toBeNull();
    expect(second!.header.stateRoot).not.toBe(EMPTY_STATE_ROOT);
    expect(ordering.getCurrentHeight()).toBe(1);
  });

  it('a creator with no prover still produces a block carrying EMPTY_STATE_ROOT', async () => {
    // The contractual test-only fallback (NODE_INTERFACE "Post-block
    // stateRoot"): no prover means nothing to speculate against, and the
    // creator mines over EMPTY_STATE_ROOT rather than stalling. Discriminating
    // the fatal arm must not have collapsed this one into it.
    const db = await importDb();
    db.initDb(':memory:');

    const avlMod = await importAvl();
    expect(avlMod.tryGetAvlProver()).toBeNull();

    const ordering = await importOrdering();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const block = await mineNextBlock(bc);

    expect(block).not.toBeNull();
    expect(block!.header.stateRoot).toBe(EMPTY_STATE_ROOT);
    // Proverless apply skips the stateRoot gate, so the node accepts its own
    // block — the fallback keeps producing, it does not just emit and fail.
    expect(ordering.getCurrentHeight()).toBe(1);
    expect(ordering.getOrderingBlock(1)).not.toBeNull();
  });

  it('an unexpected speculation crash is fatal — produce nothing, not EMPTY_STATE_ROOT', async () => {
    // Pins computePostBlockStateRoot's catch-all arm to `body-rejected`. The
    // mapping rides the apply funnel's totality doctrine: the funnel turns the
    // same throw into a block rejection, so a body that crashes speculation is
    // a body no node — this one included — will apply. Mapping it to
    // `no-prover` instead would solve real PoW over EMPTY_STATE_ROOT on that
    // body: the 1c defect in a second costume. Until this test the arm was
    // unpinned — flipping it to `no-prover` left all 909 tests green
    // (2026-08-07 probe).
    //
    // Reached by injection at the module seam, not by crafted data: the
    // creator builds its candidate from locally validated state, so a plain
    // throw inside the speculation models dependency failure (the prover
    // library crashing on its own state), which no fixture can express.
    const db = await importDb();
    db.initDb(':memory:');

    // applyBlockMutations is the speculation's last in-transaction call and
    // runs only after the mutation phase succeeded — so the injected Error is
    // neither a SpeculativeRollback nor a BlockRejected, and only the
    // catch-all can field it. Everything else passes through untouched.
    vi.doMock('../../src/state/avl-prover.js', async (importOriginal) => {
      const actual =
        await importOriginal<typeof import('../../src/state/avl-prover.js')>();
      return {
        ...actual,
        applyBlockMutations: (): Uint8Array => {
          throw new Error('injected: prover mutation crashed mid-speculation');
        },
      };
    });

    // Live prover with a real digest, so the no-prover early bails cannot be
    // what keeps the block away.
    const utxo = await importUtxo();
    utxo.insertBox(makeKarmaBox(24n, makeTestIdentity().userId, 0));
    const handle = await activateProver();
    const preDigest = Buffer.from(handle.prover.digest()!).toString('hex');

    const ordering = await importOrdering();
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const block = await mineNextBlock(bc);

    // Fatal, exactly like an explicit body rejection: no block, no PoW spent,
    // nothing stored, prover untouched.
    expect(block).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(0);
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(Buffer.from(handle.prover.digest()!).toString('hex')).toBe(preDigest);
  });

  // The `!txCbor` arm is unreachable through `applyOrderingBlock` —
  // `verifyOrderingBlockStructure` refuses a body whose `utxoTxs` does not align
  // with `utxoTxIds` before the funnel reads either — but
  // `computePostBlockStateRoot` runs no structure check at all, so the
  // speculation entry point is where a misaligned body is expressible. That is
  // the entry point this test uses to cover an arm kept for totality.
  it('a body whose utxoTxs do not align with utxoTxIds is rejected, not thrown on', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    utxo.insertBox(makeKarmaBox(24n, makeTestIdentity().userId, 0));
    const handle = await activateProver();
    const preDigest = Buffer.from(handle.prover.digest()!).toString('hex');

    const { computePostBlockStateRoot } = await import(
      '../../src/services/block-apply.js'
    );

    const candidate: OrderingBlock = {
      header: {
        protocolVersion: PROTOCOL_VERSION,
        height: 1,
        prevBlockHash: '00'.repeat(32),
        subBlockRoot: '00'.repeat(32),
        utxoTxRoot: '00'.repeat(32),
        stateRoot: EMPTY_STATE_ROOT,
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: 256 * 12,
        createdAt: 0,
      },
      subBlockTree: { subBlockEntries: [], pruneEntries: [] },
      // One declared id, no body beside it — the misalignment structure would
      // have caught on every other path into the mutation phase.
      utxoTxTree: { utxoTxIds: ['ab'.repeat(32)], utxoTxs: [], coinbaseOutputs: [] },
      validatorSignature: new Uint8Array(64),
    };

    // A stated rejection, not the catch-all: the arm returns false, so the
    // speculation exits through `BlockRejected` and the prover is restored.
    expect(computePostBlockStateRoot(candidate, 1)).toEqual({ kind: 'body-rejected' });
    expect(Buffer.from(handle.prover.digest()!).toString('hex')).toBe(preDigest);
  });
});
