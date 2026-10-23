// MEMPOOL_INTERFACE → What takes an entry out of the pool → "An entry that
// leaves unconfirmed takes its dependents."
// MEMPOOL_INTERFACE → Eviction, inside the credit class only → "A displaced
// resident takes its dependents"
// MINING_INTERFACE → Template and submit → "A build whose body the mutation
// phase rejects is repeated, not abandoned, and it evicts what the body's own
// transactions refuse."
// NODE_INTERFACE → Block finalization
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  computeTxId,
  PROTOCOL_VERSION,
  MAX_BLOCK_BODY_BYTES,
} from '@dagsocial/types';
import type {
  AnyBox,
  CreditBox,
  FeeBox,
  UtxoTransaction,
} from '@dagsocial/types';
import type { UtxoEngineDeps } from '@dagsocial/consensus';
import { materializeOutput } from '@dagsocial/consensus';

import {
  activateProverOverStore,
  hex,
  makeCreditBox,
  makeTestConfig,
  makeTestIdentity,
  signTransaction,
  solveHeaderPow,
  wireIntakeForTests,
} from '../helpers.js';
import type { TestIdentity } from '../helpers.js';

async function importDb() {
  return (await import('../../src/store/db.js')) as typeof import('../../src/store/db.js');
}

async function importMempool() {
  return (await import('../../src/store/mempool.js')) as typeof import('../../src/store/mempool.js');
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as typeof import('../../src/store/utxo.js');
}

async function importAdmit() {
  return (await import('../../src/services/admit-tx.js')) as typeof import('../../src/services/admit-tx.js');
}

async function importBlockCreator() {
  return (await import('../../src/services/block-creator.js')) as typeof import('../../src/services/block-creator.js');
}

/** Engine deps every production admission path builds over the real store —
 *  pool-follows-applied-block.test.ts's shape, resolved dynamically against
 *  the module graph the test's own setup just reset. */
async function buildEngineDeps(): Promise<UtxoEngineDeps> {
  const types = await import('@dagsocial/types');
  const store = await import('../../src/store/index.js');
  const karmaAdm = await import('../../src/services/karma-admission.js');
  const dbMod = await import('../../src/store/db.js');
  const { config } = await import('../../src/config.js');
  const decayCfg = {
    staleThresholdBlocks: types.KARMA_STALE_THRESHOLD_BLOCKS,
    decayIntervalBlocks: types.KARMA_DECAY_INTERVAL_BLOCKS,
    decayAmount: types.KARMA_DECAY_AMOUNT,
    karmaMinimum: types.KARMA_MINIMUM,
  };
  return {
    getBox: store.getBoxWithPending,
    insertBox: store.insertBox,
    consumeBox: store.consumeBox,
    getKarmaValue: karmaAdm.admissionHeld,
    getOwnKarmaBoxIds: karmaAdm.admissionGetOwnKarmaBoxIds,
    getKarmaOwed: karmaAdm.admissionOwed(decayCfg),
    getIdentityRecord: store.getIdentityRecord,
    hasActiveVouchEscrow: store.hasActiveVouchEscrow,
    vouchCooldownBlocks: 2,
    inviteBondMin: config.inviteBondMin,
    inviteBondMax: config.inviteBondMax,
    decayCfg,
    storageRentPeriodBlocks: 40,
    getBoxProvenance: () => null,
    getTopologyAuthor: (postId: string) => store.getTopologyAuthorBytes(postId),
    getPendingPostAuthor: store.getPendingPostAuthor,
    runInTransaction: (fn: () => void) => (dbMod.getDb().transaction(fn) as () => void)(),
    getVouchBox: store.getVouchBox,
    getNetworkRecord: store.getNetworkRecord,
    membershipBarMultiplier: 1,
    putIdentityRecord: store.putIdentityRecord,
    protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
    getUsername: () => null,
    getUsernameByOwner: () => null,
  };
}

/** A signed credit transfer that spends `input` and emits `change + fee`. */
function creditTransfer(spender: TestIdentity, input: CreditBox, fee: bigint): UtxoTransaction {
  const outputs: AnyBox[] = [
    { boxType: 'credit', value: input.value - fee, createdAtBlock: 0, owner: spender.userId } as CreditBox,
  ];
  if (fee > 0n) outputs.push({ boxType: 'fee', value: fee, createdAtBlock: 0 } as FeeBox);
  const tx: UtxoTransaction = {
    inputs: [input.id!],
    outputs,
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, spender.privateKey, hex(spender.userId));
  return tx;
}

/** The materialized credit change output at index 0 of a credit transfer. */
function changeOf(tx: UtxoTransaction): CreditBox {
  return materializeOutput(tx.outputs[0] as AnyBox, computeTxId(tx), 0) as CreditBox;
}

const minerConfig = makeTestConfig({
  port: 3100,
  dbPath: ':memory:',
  networkType: 'testnet' as const,
  nodeRole: 'miner' as const,
  blockBodyBudgetBytes: MAX_BLOCK_BODY_BYTES,
  orderingBlockPowTargetBits: 3072,
  bootstrapPeers: [] as string[],
  listenAddrs: '/ip4/127.0.0.1/tcp/0',
  maxPeers: 50,
});

describe('a credit-class displacement takes the cheapest resident\'s dependents', () => {
  beforeEach(async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
    const mem = await importMempool();
    // The credit class caps at MEMPOOL_CREDIT_SHARE_PCT (50) of the bound, so
    // a bound of 4 opens two slots for credit entries (MEMPOOL_INTERFACE →
    // Eviction, inside the credit class only).
    mem.setMempoolCap(4);
  });

  afterEach(async () => {
    const db = await importDb();
    db.closeDb();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('a credit entry chained on the cheapest resident\'s change leaves with that resident when a higher bid displaces it', async () => {
    const spender = makeTestIdentity();
    const boxC = makeCreditBox(10_000_000n, spender.userId, 0, 1);
    const boxA = makeCreditBox(10_000_000n, spender.userId, 0, 2);
    const utxo = await importUtxo();
    utxo.insertBox(boxC);
    utxo.insertBox(boxA);

    const engine = await buildEngineDeps();
    const admit = await importAdmit();
    const consensus = await import('@dagsocial/consensus');
    const validate = (t: UtxoTransaction, h: number) => consensus.validateTx(engine, t, h);

    const C = creditTransfer(spender, boxC, 10n);
    const Cid = computeTxId(C);
    admit.admitWriteTx(() => {}, validate, C, 1, '');

    const Cprime = creditTransfer(spender, changeOf(C), 20n);
    const CprimeId = computeTxId(Cprime);
    admit.admitWriteTx(() => {}, validate, Cprime, 1, '');

    const mem = await importMempool();
    expect(mem.getPendingEntries(10)).toHaveLength(2);

    // The arriving entry bids above the cheapest resident, which is `C`.
    const A = creditTransfer(spender, boxA, 500n);
    const Aid = computeTxId(A);
    admit.admitWriteTx(() => {}, validate, A, 1, '');

    const held = mem.getPendingEntries(10);
    expect(held).toHaveLength(1);
    const db = (await importDb()).getDb();
    const txIds = held.map(
      (e) => (db.prepare('SELECT tx_id FROM mempool WHERE rowid = ?').get(e.rowid) as { tx_id: string }).tx_id,
    );
    expect(txIds).toContain(Aid);
    expect(txIds).not.toContain(Cid);
    expect(txIds).not.toContain(CprimeId);
  });
});

describe('an arrival that depends on the cheapest resident\'s closure is refused', () => {
  beforeEach(async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
    const mem = await importMempool();
    mem.setMempoolCap(4);
  });

  afterEach(async () => {
    const db = await importDb();
    db.closeDb();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('a credit transfer whose input is an output of the cheapest resident\'s chained dependent throws MempoolFullError and leaves both pooled', async () => {
    const spender = makeTestIdentity();
    const boxC = makeCreditBox(10_000_000n, spender.userId, 0, 1);
    const utxo = await importUtxo();
    utxo.insertBox(boxC);

    const engine = await buildEngineDeps();
    const admit = await importAdmit();
    const consensus = await import('@dagsocial/consensus');
    const validate = (t: UtxoTransaction, h: number) => consensus.validateTx(engine, t, h);

    const C = creditTransfer(spender, boxC, 10n);
    const Cid = computeTxId(C);
    admit.admitWriteTx(() => {}, validate, C, 1, '');

    const Cprime = creditTransfer(spender, changeOf(C), 20n);
    const CprimeId = computeTxId(Cprime);
    admit.admitWriteTx(() => {}, validate, Cprime, 1, '');

    const mem = await importMempool();
    expect(mem.getPendingEntries(10)).toHaveLength(2);

    // Arrival chained on `C'`'s change — a box only `C'` holds, in the pending
    // view. It exists nowhere in the confirmed set, so the arrival depends on
    // what would leave with `C` and must not displace it.
    const A2 = creditTransfer(spender, changeOf(Cprime), 500n);

    expect(() => admit.admitWriteTx(() => {}, validate, A2, 1, '')).toThrow(mem.MempoolFullError);

    const held = mem.getPendingEntries(10);
    expect(held).toHaveLength(2);
    const db = (await importDb()).getDb();
    const txIds = held.map(
      (e) => (db.prepare('SELECT tx_id FROM mempool WHERE rowid = ?').get(e.rowid) as { tx_id: string }).tx_id,
    );
    expect(txIds).toContain(Cid);
    expect(txIds).toContain(CprimeId);
  });

  it('a credit transfer whose input is the cheapest resident\'s own change throws MempoolFullError and leaves the resident pooled', async () => {
    const spender = makeTestIdentity();
    const boxC = makeCreditBox(10_000_000n, spender.userId, 0, 1);
    const utxo = await importUtxo();
    utxo.insertBox(boxC);

    const engine = await buildEngineDeps();
    const admit = await importAdmit();
    const consensus = await import('@dagsocial/consensus');
    const validate = (t: UtxoTransaction, h: number) => consensus.validateTx(engine, t, h);

    // The resident `C` outputs two credit boxes to its owner and a fee: its
    // dependent `C'` spends the first, the arrival spends the second.
    const half = (boxC.value - 10n) / 2n;
    const C: UtxoTransaction = {
      inputs: [boxC.id!],
      outputs: [
        { boxType: 'credit', value: half, createdAtBlock: 0, owner: spender.userId } as CreditBox,
        { boxType: 'credit', value: boxC.value - 10n - half, createdAtBlock: 0, owner: spender.userId } as CreditBox,
        { boxType: 'fee', value: 10n, createdAtBlock: 0 } as FeeBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(C, spender.privateKey, hex(spender.userId));
    const Cid = computeTxId(C);
    admit.admitWriteTx(() => {}, validate, C, 1, '');

    const Cprime = creditTransfer(spender, changeOf(C), 20n);
    const CprimeId = computeTxId(Cprime);
    admit.admitWriteTx(() => {}, validate, Cprime, 1, '');

    const mem = await importMempool();
    expect(mem.getPendingEntries(10)).toHaveLength(2);

    // Arrival chained on `C`'s second credit output, which `C'` does not
    // spend: a box only `C` holds in the pending view, so the arrival depends
    // on what would leave with `C` and must not displace it.
    const secondChange = materializeOutput(C.outputs[1] as AnyBox, Cid, 1) as CreditBox;
    const A2 = creditTransfer(spender, secondChange, 500n);

    expect(() => admit.admitWriteTx(() => {}, validate, A2, 1, '')).toThrow(mem.MempoolFullError);

    const held = mem.getPendingEntries(10);
    expect(held).toHaveLength(2);
    const db = (await importDb()).getDb();
    const txIds = held.map(
      (e) => (db.prepare('SELECT tx_id FROM mempool WHERE rowid = ?').get(e.rowid) as { tx_id: string }).tx_id,
    );
    expect(txIds).toContain(Cid);
    expect(txIds).toContain(CprimeId);
  });
});

describe('a build whose screen refuses a pooled transaction takes that transaction\'s pooled dependent', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch {
      // nothing to stop
    }
    vi.doUnmock('../../src/config.js');
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('a credit transfer whose input is in the pool\'s store but not in the tree carries its chained dependent out when the build\'s screen refuses it', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    // The prover bootstraps from the unspent set at this moment; a credit box
    // seeded afterwards is in the store and reachable by admission, which reads
    // the pending view through the store, but is absent from the tree the
    // speculation and the screen read (NODE_INTERFACE → Post-block stateRoot).
    await activateProverOverStore();

    const spender = makeTestIdentity();
    const boxX = makeCreditBox(10_000_000n, spender.userId, 0, 1);
    const utxo = await importUtxo();
    utxo.insertBox(boxX);

    const engine = await buildEngineDeps();
    const admit = await importAdmit();
    const consensus = await import('@dagsocial/consensus');
    const validate = (t: UtxoTransaction, h: number) => consensus.validateTx(engine, t, h);

    // P bids less than D so the credit-class fee-rate fill meets D ahead of P.
    // D's input is P's change — the pending view holds it; the confirmed set
    // does not — so the dependency skip keeps D out of the body. P is drawn
    // after D, finds its input in the confirmed set, and rides the body alone
    // (MEMPOOL_INTERFACE → Block Creator Integration).
    const P = creditTransfer(spender, boxX, 10n);
    const Pid = computeTxId(P);
    admit.admitWriteTx(() => {}, validate, P, 1, '');

    const D = creditTransfer(spender, changeOf(P), 500n);
    const Did = computeTxId(D);
    admit.admitWriteTx(() => {}, validate, D, 1, '');

    const mem = await importMempool();
    expect(mem.getPendingEntries(10)).toHaveLength(2);

    const warns: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warns.push(a.map(String).join(' '));
    });
    const bc = await importBlockCreator();
    bc.startBlockCreator(minerConfig);

    // The build's screen refuses P and carries its dependent out with it;
    // the second fill holds an empty body, and the template stands.
    expect(bc.getCurrentTemplate()).not.toBeNull();
    expect(warns.some((w) => w.includes('body-rejected'))).toBe(true);

    const held = mem.getPendingEntries(10);
    expect(held).toHaveLength(0);
    const database = (await importDb()).getDb();
    const txIds = held.map(
      (e) => (database.prepare('SELECT tx_id FROM mempool WHERE rowid = ?').get(e.rowid) as { tx_id: string }).tx_id,
    );
    expect(txIds).not.toContain(Pid);
    expect(txIds).not.toContain(Did);
  });
});

describe('a mined block the intake refuses sweeps the template rows\' pooled dependents', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch {
      // nothing to stop
    }
    try {
      const intake = await import('../../src/services/intake.js');
      intake.clearIntakeSeamsForTests();
    } catch {
      // nothing to clear
    }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('a chained dependent admitted after the template is built leaves with the template row the intake refuses', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const spender = makeTestIdentity();
    const boxX = makeCreditBox(10_000_000n, spender.userId, 0, 1);
    const utxo = await importUtxo();
    utxo.insertBox(boxX);

    const engine = await buildEngineDeps();
    const admit = await importAdmit();
    const consensus = await import('@dagsocial/consensus');
    const validate = (t: UtxoTransaction, h: number) => consensus.validateTx(engine, t, h);

    const P = creditTransfer(spender, boxX, 10n);
    const Pid = computeTxId(P);
    admit.admitWriteTx(() => {}, validate, P, 1, '');

    await activateProverOverStore();

    const bc = await importBlockCreator();
    bc.startBlockCreator(minerConfig);
    const tpl = bc.getCurrentTemplate();
    expect(tpl).not.toBeNull();
    expect(tpl!.utxoTxTree.utxoTxIds).toContain(Pid);

    // A chained dependent admitted after the template is built. The template
    // does not carry it; `submitMinedBlock`'s refused arm sweeps the template
    // rows alone, and the closure walk carries the dependent out with its
    // parent.
    const D = creditTransfer(spender, changeOf(P), 5n);
    const Did = computeTxId(D);
    admit.admitWriteTx(() => {}, validate, D, 1, '');

    const mem = await importMempool();
    expect(mem.getPendingEntries(10)).toHaveLength(2);

    await wireIntakeForTests();
    // The intake's apply is held to a consensus refusal through the seam,
    // which routes `submitMinedBlock` down the refused arm (NODE_INTERFACE →
    // Block finalization).
    const intake = await import('../../src/services/intake.js');
    intake.setIntakeSeamsForTests({
      apply: () => ({ applied: false, class: 'consensus' as const }),
    });
    const nonce = solveHeaderPow(tpl!.header);
    const hash = bc.submitMinedBlock(nonce, tpl!.header.height);
    expect(hash).toBeNull();

    const held = mem.getPendingEntries(10);
    expect(held).toHaveLength(0);
    const database = (await importDb()).getDb();
    const txIds = held.map(
      (e) => (database.prepare('SELECT tx_id FROM mempool WHERE rowid = ?').get(e.rowid) as { tx_id: string }).tx_id,
    );
    expect(txIds).not.toContain(Pid);
    expect(txIds).not.toContain(Did);
  });
});
