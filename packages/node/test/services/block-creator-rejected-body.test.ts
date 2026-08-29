import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  EMPTY_STATE_ROOT,
  PROTOCOL_VERSION,
  VOUCH_KARMA_AMOUNT,
  MAX_BLOCK_BODY_BYTES,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
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
  makeApplicableBlock,
  makeKarmaBox,
  makeTestConfig,
  makeTestIdentity,
  mineNextBlock,
  signTransaction,
  solveHeaderPow,
  activateProverOverStore,
} from '../helpers.js';
import { config } from '../../src/config.js';

// ---------------------------------------------------------------------------
// A body-rejected build repeats until it holds a template; a rejected body
// that carried no pool row is terminal (MINING_INTERFACE → Template and
// submit).
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
  blockBodyBudgetBytes: MAX_BLOCK_BODY_BYTES,
  orderingBlockPowTargetBits: 3072,
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
    insertUtxoTx: (tx: UtxoTransaction, expiresAtHeight: number) => number;
    getPendingEntries: (limit: number) => Array<{ rowid: number; entryType: string }>;
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
  // Ordering lives in the shared helper: committed state into the store, then
  // the tree built from it (helpers.ts → `activateProverOverStore`).
  const handle = await activateProverOverStore();
  expect((await importAvl()).tryGetAvlProver()).not.toBeNull();
  return handle;
}

/** The engine deps every production validation path builds over the store. */
async function storeBackedDeps() {
  const utxoStore = await import('../../src/store/utxo.js');
  const identityStore = await import('../../src/store/identity-records.js');
  const { getDb } = await import('../../src/store/db.js');
  return {
    getBox: utxoStore.getBox,
    getIdentityRecord: identityStore.getIdentityRecord,
    insertBox: utxoStore.insertBox,
    consumeBox: utxoStore.consumeBox,
    getKarmaBox: utxoStore.getKarmaBox,
    getKarmaValue: utxoStore.getKarmaValue,
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
      storageRentPeriodBlocks: 40,
      getBoxProvenance: () => null,
    getTopologyAuthor: () => null,
    getPendingPostAuthor: () => null,
    runInTransaction: (fn: () => void) => {
      getDb().transaction(fn)();
    },
      getVouchBox: () => null,
      getNetworkRecord: () => ({ memberCount: 1 }),
      membershipBarMultiplier: 1,
      putIdentityRecord: () => {},
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
        createdAtBlock: 0,
        owner: voucher.userId,
      } as KarmaBox,
      {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: 0,
        voucherId: voucher.userId,
        targetId,
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
  const { getDb } = await importDb();
  getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
  const utxo = await importUtxo();
  const mempool = await importMempool();
  const records = await import('../../src/store/identity-records.js');

  const voucher = makeTestIdentity();
  const target = makeTestIdentity();
  records.putIdentityRecord(voucher.userId, {
    lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 0,
    lifetimeLikesReceived: 0n, memberSinceBlock: 1, memberBar: 0,
    memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
  });
  records.putIdentityRecord(target.userId, {
    lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 1,
    lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0,
    memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
  });

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

  mempool.insertUtxoTx(cast, 1000);

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
    vi.doUnmock('../../src/services/block-apply.js');
    vi.resetModules();
  });

  it('startBlockCreator evicts the stale entry, rebuilds, and holds a template', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const { utxo, mempool, voucher, spent } = await seedStaleVouchCast();

    const handle = await activateProver();
    const preDigest = Buffer.from(handle.prover.digest()!).toString('hex');

    const ordering = await importOrdering();
    const bc = await importBlockCreator();

    // startBlockCreator alone — no createOrderingBlock(), no mineNextBlock.
    bc.startBlockCreator(testConfig);

    // The creator holds a template: the stale body was rejected, its rows
    // evicted, and the rebuild produced a clean template.
    const tpl = bc.getCurrentTemplate();
    expect(tpl).not.toBeNull();
    expect(tpl!.header.stateRoot).not.toBe(EMPTY_STATE_ROOT);
    // The template's body carries no user transaction.
    expect(tpl!.utxoTxTree.utxoTxIds).toHaveLength(1);

    // The cast's rows are gone from the pool.
    expect(mempool.getPendingEntries(10)).toHaveLength(0);

    // The rejected body applied nothing and the rebuild's speculation left no
    // trace: prover digest equals the pre-start digest, the voucher's summed
    // karma is still 6n, no live vouch box exists.
    expect(Buffer.from(handle.prover.digest()!).toString('hex')).toBe(preDigest);
    expect(utxo.getBox(spent.id!)).not.toBeNull();
    expect(utxo.getKarmaBoxes(voucher.userId).reduce((sum, b) => sum + b.value, 0n)).toBe(6n);
    expect(
      db.getDb()
        .prepare(`SELECT id FROM utxo_boxes WHERE box_type = 'vouch' AND spent_at_block IS NULL`)
        .all(),
    ).toHaveLength(0);
    expect(ordering.getCurrentHeight()).toBe(0);

    // The held template mines through submitMinedBlock to height 1.
    const nonce = solveHeaderPow(tpl!.header);
    expect(bc.submitMinedBlock(nonce, tpl!.header.height)).not.toBeNull();
    expect(ordering.getCurrentHeight()).toBe(1);
  });

  it('a creator with no prover still produces a block carrying EMPTY_STATE_ROOT', async () => {
    // The contractual test-only fallback (NODE_INTERFACE → Post-block
    // stateRoot): no prover means nothing to speculate against, and the
    // creator mines over EMPTY_STATE_ROOT rather than stalling. Discriminating
    // the fatal arm must not have collapsed this one into it.
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

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
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

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

  // The `!txBytes` arm is unreachable through `applyOrderingBlock` —
  // `verifyOrderingBlockStructure` refuses a body whose `utxoTxs` does not align
  // with `utxoTxIds` before the funnel reads either — but
  // `computePostBlockStateRoot` runs no structure check at all, so the
  // speculation entry point is where a misaligned body is expressible. That is
  // the entry point this test uses to cover an arm kept for totality.
  it('a body whose utxoTxs do not align with utxoTxIds is rejected, not thrown on', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

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
        utxoTxRoot: '00'.repeat(32),
        stateRoot: EMPTY_STATE_ROOT,
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: 256 * 12,
        createdAt: 0,
        interlinkRoot: '00'.repeat(32),
      },
      // One declared id, no body beside it — the misalignment structure would
      // have caught on every other path into the mutation phase.
      utxoTxTree: { utxoTxIds: ['ab'.repeat(32)], utxoTxs: [] },
      validatorSignature: new Uint8Array(64),
    };

    // A stated rejection, not the catch-all: the arm returns false, so the
    // speculation exits through `BlockRejected` and the prover is restored.
    expect(computePostBlockStateRoot(candidate, 1)).toEqual({ kind: 'body-rejected' });
    expect(Buffer.from(handle.prover.digest()!).toString('hex')).toBe(preDigest);
  });

  it('a corrupt state tree found while producing STOPS the node, and is not a body-rejected', async () => {
    // ⛔ The arm that must sit ABOVE the catch-all. Mapped to `body-rejected`
    // instead, a diverged tree would stop this node producing while it stayed
    // up — forever, because the fault is in our state rather than in the body,
    // so the next candidate fails identically. "Rejects everything while
    // staying up" is the outcome `services/corrupt-state.ts` exists to prevent,
    // and it is indistinguishable from a quiet network until somebody reads the
    // logs.
    //
    // `process.exit` is stubbed to throw, because a real one takes the test
    // runner with it. That the stub is reached at all is the assertion — the
    // same shape `corrupt-state.test.ts` uses for the other three subclasses.
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    // Armed after the candidate is built, so the block itself is honest: the
    // first speculation runs the real prover, and only the direct call below
    // meets the refusal. A fixture cannot express the condition any other way —
    // a store and a tree that disagree is not something a body can carry.
    let armed = false;
    const badKey = 'ab'.repeat(32);
    // ⚠ **Resolved here, not by a static import at the top of the file.**
    // `vi.resetModules()` gives each module graph its own copy of
    // `corrupt-state.js`, so a statically-imported class is a *different object*
    // from the one `block-apply.js` closes over — and `instanceof` against it is
    // false, which silently routes this case into the catch-all arm and makes
    // the test assert the opposite of what it says.
    const { DivergedStateTreeError } = await import('../../src/services/corrupt-state.js');
    vi.doMock('../../src/state/avl-prover.js', async (importOriginal) => {
      const actual =
        await importOriginal<typeof import('../../src/state/avl-prover.js')>();
      return {
        ...actual,
        applyBlockMutations: (
          ...args: Parameters<typeof actual.applyBlockMutations>
        ): Uint8Array => {
          if (armed) {
            throw new DivergedStateTreeError('applyBlockMutations', 1, 'Remove', badKey);
          }
          return actual.applyBlockMutations(...args);
        },
      };
    });

    const utxo = await importUtxo();
    utxo.insertBox(makeKarmaBox(24n, makeTestIdentity().userId, 0));
    const handle = await activateProver();
    const preDigest = Buffer.from(handle.prover.digest()!).toString('hex');

    const candidate = await makeApplicableBlock({ height: 1 });

    const exited: number[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exited.push(code ?? 0);
      throw new Error('process.exit');
    }) as never);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
      errors.push(String(msg));
    });

    const { computePostBlockStateRoot } = await import(
      '../../src/services/block-apply.js'
    );

    armed = true;
    // It never returns a verdict: the boundary is reached instead, and the
    // stubbed exit is what comes back out.
    expect(() => computePostBlockStateRoot(candidate, 1)).toThrow('process.exit');
    expect(exited).toEqual([1]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('FATAL');
    expect(errors[0]).toContain(badKey);
    expect(errors[0]).toContain('Nothing a peer sent can have caused this');

    // ⛔ **That the `finally` never runs is NOT assertable here, and pretending
    // otherwise would be the test asserting a fiction.** In production
    // `process.exit(1)` does not unwind, so the journal abort and the prover
    // restore are skipped; under a stub that *throws* instead, the `finally`
    // runs exactly as it would for any other exception. The stub is what keeps
    // the runner alive, and it is precisely what removes the property from
    // view. It is stated on `computePostBlockStateRoot` instead, where a reader
    // meets it.
    //
    // The prover is untouched here for an unrelated reason — the injection
    // throws before the real mutation runs — so it says nothing either way.
    expect(Buffer.from(handle.prover.digest()!).toString('hex')).toBe(preDigest);
  });

  it('the bound: K rejected bodies → K+1 speculation calls and a held template', async () => {
    const K = 1;
    let callCount = 0;
    vi.doMock('../../src/services/block-apply.js', async (importOriginal) => {
      const actual =
        await importOriginal<typeof import('../../src/services/block-apply.js')>();
      return {
        ...actual,
        computePostBlockStateRoot: (
          ...args: Parameters<typeof actual.computePostBlockStateRoot>
        ) => {
          callCount++;
          if (callCount <= K) return { kind: 'body-rejected' as const };
          return actual.computePostBlockStateRoot(...args);
        },
      };
    });

    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    await seedStaleVouchCast();
    await activateProver();

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    expect(callCount).toBe(K + 1);
    expect(bc.getCurrentTemplate()).not.toBeNull();
  });

  it('empty pool + always-reject → one speculation call, null template, one warn', async () => {
    let callCount = 0;
    vi.doMock('../../src/services/block-apply.js', async (importOriginal) => {
      const actual =
        await importOriginal<typeof import('../../src/services/block-apply.js')>();
      return {
        ...actual,
        computePostBlockStateRoot: () => {
          callCount++;
          return { kind: 'body-rejected' as const };
        },
      };
    });

    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();
    utxo.insertBox(makeKarmaBox(24n, makeTestIdentity().userId, 0));
    await activateProver();

    const warns: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((msg: unknown) => {
      warns.push(String(msg));
    });

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    expect(callCount).toBe(1);
    expect(bc.getCurrentTemplate()).toBeNull();
    const relevant = warns.filter((w) => w.includes('body-rejected'));
    expect(relevant).toHaveLength(1);
    expect(relevant[0]).toContain('no pool rows');
  });
});
