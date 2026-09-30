/**
 * The admission seam and this node's fee floor
 * (MEMPOOL_INTERFACE → Fee floor).
 *
 * The floor is relay policy: a zero-fee transaction is valid consensus and a
 * miner may mine one. What this suite pins is who the floor applies to — and,
 * in the last test, who it must NOT apply to, which is the reason the seam sits
 * above the store instead of inside it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash, generateKeyPairSync } from 'crypto';
import {
  boxRecordBytes,
  computeBoxId,
  PROTOCOL_VERSION,
  STORAGE_RENT_PER_BYTE,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
} from '@dagsocial/types';
import type { CreditBox, FeeBox, OrderingBlock, UtxoTransaction } from '@dagsocial/types';
import {
  blockBudgetSeam,
  liveProver,
  makeApplicableBlock,
  makeCreditBox,
  makeCreditTx,
  makeTestIdentity,
} from '../helpers.js';

const originalFloor = process.env['MIN_FEE_RATE_PER_BYTE'];

function creditBox(label: string, value: bigint): CreditBox {
  const owner = createHash('blake2b512').update(`${label}_o`).digest().subarray(0, 32);
  const box = {
    boxType: 'credit' as const,
    value,
    createdAtBlock: 0,
    owner: new Uint8Array(owner),
    txId: createHash('blake2b512').update(`${label}_t`).digest().subarray(0, 32).toString('hex'),
    index: 0,
  };
  return { ...box, id: computeBoxId(box as never) } as CreditBox;
}

/**
 * A credit spend that names its fee in a `FeeBox` output — which is the whole
 * of what the floor measures, since `bidOf` resolves no inputs
 * (MEMPOOL_INTERFACE → Fee floor).
 *
 * Signed (non-empty `signatures`): the rent refusal fires on an empty map, and
 * the fee-floor tests are about the fee, not about authorization.
 */
function spend(box: CreditBox, fee: bigint): UtxoTransaction {
  const ownerHex = Buffer.from(box.owner).toString('hex');
  return {
    inputs: [box.id!],
    outputs: [
      {
        boxType: 'credit', value: box.value - fee, createdAtBlock: 0, owner: box.owner,
      } as CreditBox,
      { boxType: 'fee', value: fee, createdAtBlock: 0 } as FeeBox,
    ],
    signatures: { [ownerHex]: new Uint8Array(64) },
    protocolVersion: PROTOCOL_VERSION,
  } as UtxoTransaction;
}

/** A karma-side entry: no outputs, so nothing it could bid. */
function karmaSide(label: string): UtxoTransaction {
  const id = createHash('blake2b512').update(label).digest().subarray(0, 32).toString('hex');
  const dummyKey = createHash('blake2b512').update(`${label}_k`).digest().subarray(0, 32).toString('hex');
  return { inputs: [id], outputs: [], signatures: { [dummyKey]: new Uint8Array(64) }, protocolVersion: PROTOCOL_VERSION } as UtxoTransaction;
}

/** A fresh node with `MIN_FEE_RATE_PER_BYTE` set, and the boxes seeded. */
async function nodeWithFloor(floor: string, boxes: CreditBox[]) {
  process.env['MIN_FEE_RATE_PER_BYTE'] = floor;
  vi.resetModules();
  const dbMod = await import('../../src/store/db.js');
  dbMod.initDb(':memory:');
  const utxo = await import('../../src/store/utxo.js');
  for (const box of boxes) utxo.insertBox(box as never);
  const admit = await import('../../src/services/admit-tx.js');
  const mem = await import('../../src/store/mempool.js');
  return { admit, mem };
}

describe('the admission seam', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    if (originalFloor === undefined) delete process.env['MIN_FEE_RATE_PER_BYTE'];
    else process.env['MIN_FEE_RATE_PER_BYTE'] = originalFloor;
  });

  it('refuses a credit transaction paying under the floor', async () => {
    const box = creditBox('poor', 100_000n);
    const { admit, mem } = await nodeWithFloor('10', [box]);

    // A transaction is ~950 in-block bytes, so a floor of 10 per byte asks for
    // roughly 9,500 and this pays 1.
    expect(() => admit.admitTx(spend(box, 1n), 1000)).toThrow(admit.FeeBelowFloorError);
    expect(mem.getPendingEntries(10)).toHaveLength(0);
  });

  it('admits the same transaction once it pays enough', async () => {
    const box = creditBox('rich', 100_000n);
    const { admit, mem } = await nodeWithFloor('10', [box]);

    // The control that makes the refusal above attributable to the AMOUNT
    // rather than to anything else about the fixture.
    expect(() => admit.admitTx(spend(box, 90_000n), 1000)).not.toThrow();
    expect(mem.getPendingEntries(10)).toHaveLength(1);
  });

  it('never measures a karma-side transaction against the floor', async () => {
    const { admit, mem } = await nodeWithFloor('1000000', []);

    // A floor high enough to refuse any credit transaction must still leave
    // posts, likes and vouches admissible — they bid nothing by nature, and
    // charging them would close the network the moment an operator raised one.
    expect(() => admit.admitTx(karmaSide('a_post'), 1000)).not.toThrow();
    expect(mem.getPendingEntries(10)).toHaveLength(1);
  });

  it('applies no floor at the shipped default', async () => {
    const box = creditBox('free', 100_000n);
    process.env['MIN_FEE_RATE_PER_BYTE'] = '';
    delete process.env['MIN_FEE_RATE_PER_BYTE'];
    const { admit, mem } = await nodeWithFloor('0', [box]);

    expect(() => admit.admitTx(spend(box, 0n), 1000)).not.toThrow();
    expect(mem.getPendingEntries(10)).toHaveLength(1);
  });

  // ⛔ The test that makes the seam's PLACEMENT tested rather than plausible.
  // A floor inside `insertUtxoTx` passes every case above and silently drops
  // confirmed history on the next reorg — and the floor is exactly the value an
  // operator raises under load.
  it('lets reorg re-insertion past a floor the transaction cannot clear', async () => {
    const box = creditBox('mined_when_free', 100_000n);
    const { admit, mem } = await nodeWithFloor('10', [box]);

    // Mined when this node's floor was zero, so it pays 1 over ~950 bytes.
    const tx = spend(box, 1n);
    expect(() => admit.admitTx(tx, 1000)).toThrow(admit.FeeBelowFloorError);

    // `fork-resolution` re-inserts through the store, not through admission.
    // The chain already accepted this transaction; a relay policy raised after
    // the fact must not be able to erase it.
    expect(() => mem.insertUtxoTx(tx, 1000)).not.toThrow();
    expect(mem.getPendingEntries(10)).toHaveLength(1);
  });

  // ⚠ The throw lands on the IMPORT, not on a later call: `config.ts` builds
  // its singleton at module scope (`export const config = loadConfig()`), so a
  // floor the node cannot read stops it before anything else runs. That is the
  // intent — a relay policy nobody chose must not be indistinguishable from a
  // deliberate zero — and it is why these two assert a rejected import.
  it('refuses to start on a floor it cannot read', async () => {
    process.env['MIN_FEE_RATE_PER_BYTE'] = 'lots';
    vi.resetModules();
    await expect(import('../../src/config.js')).rejects.toThrow(/MIN_FEE_RATE_PER_BYTE/);
  });

  it('refuses to start on a floor beneath zero', async () => {
    // Its own reason, not the parse's: a negative floor admits a transaction
    // paying nothing while reporting that it cleared a bar.
    process.env['MIN_FEE_RATE_PER_BYTE'] = '-1';
    vi.resetModules();
    await expect(import('../../src/config.js')).rejects.toThrow(/beneath zero/);
  });
});

// ---------------------------------------------------------------------------
// Rent admission (MEMPOOL_INTERFACE → Storage rent is refused at admission)
// ---------------------------------------------------------------------------

describe('rent admission refusal', () => {
  const RENT_PERIOD = 40;

  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    if (originalFloor === undefined) delete process.env['MIN_FEE_RATE_PER_BYTE'];
    else process.env['MIN_FEE_RATE_PER_BYTE'] = originalFloor;
  });

  it('refuses a rent transaction at admission', async () => {
    const box = creditBox('rent_target', 100_000_000n);
    const { admit, mem } = await nodeWithFloor('0', [box]);

    // An unsigned transaction: `signatures` is empty — the only way this
    // passes `validateTx` is as a rent collection (H1 biconditional).
    const tx: UtxoTransaction = {
      inputs: [box.id!],
      outputs: [
        { boxType: 'credit', value: box.value - 1000n, owner: box.owner, createdAtBlock: 0 } as CreditBox,
        { boxType: 'fee', value: 1000n, createdAtBlock: 0 } as FeeBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };

    expect(() => admit.admitTx(tx, 1000)).toThrow(admit.RentRefusedError);
    expect(mem.getPendingEntries(10)).toHaveLength(0);
  });

  // ⛔ Pins "policy, not consensus": the SAME unsigned transaction that
  // admission refuses must pass `validateTx` — which is what block application
  // calls for every embedded transaction. If someone makes the refusal
  // consensus-level, this test fails.
  it('validateTx accepts the rent transaction block application would carry', async () => {
    vi.resetModules();
    const dbMod = await import('../../src/store/db.js');
    dbMod.initDb(':memory:');
    const utxo = await import('../../src/store/utxo.js');
    const engine = await import('@dagsocial/consensus');
    const { rawPublicKey, seedProvenance } = await import('../helpers.js');
    const cfgMod = await import('../../src/config.js');

    const alice = generateKeyPairSync('ed25519');
    const alicePub = rawPublicKey(alice.publicKey);
    const height = 100;

    const box = seedProvenance<CreditBox>(
      { boxType: 'credit', value: 100_000_000n, owner: alicePub, createdAtBlock: height - RENT_PERIOD - 1 },
      height - RENT_PERIOD - 1,
    );
    utxo.insertBox(box);

    const prov = utxo.getBoxProvenance(box.id!)!;
    const charge = STORAGE_RENT_PER_BYTE * BigInt(boxRecordBytes(box, prov.txId, prov.index).length);

    const tx: UtxoTransaction = {
      inputs: [box.id!],
      outputs: [
        { boxType: 'credit', value: box.value - charge, owner: alicePub, createdAtBlock: height },
        { boxType: 'fee', value: charge, createdAtBlock: height },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };

    const deps: import('@dagsocial/consensus').UtxoEngineDeps = {
      getBox: utxo.getBox,
      insertBox: utxo.insertBox,
      consumeBox: utxo.consumeBox,
      getKarmaValue: utxo.getKarmaValue,
      getIdentityRecord: (await import('../../src/store/identity-records.js')).getIdentityRecord,
      hasActiveVouchEscrow: () => false,
      vouchCooldownBlocks: 2,
      inviteBondMin: cfgMod.config.inviteBondMin,
      inviteBondMax: cfgMod.config.inviteBondMax,
      decayCfg: {
        staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
        decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
        decayAmount: KARMA_DECAY_AMOUNT,
        karmaMinimum: KARMA_MINIMUM,
      },
      storageRentPeriodBlocks: RENT_PERIOD,
      getBoxProvenance: utxo.getBoxProvenance,
      getTopologyAuthor: () => null,
      getPendingPostAuthor: () => null,
      runInTransaction: (fn) => fn(),
      getVouchBox: () => null,
      getNetworkRecord: () => ({ memberCount: 1 }),
      membershipBarMultiplier: 1,
      putIdentityRecord: () => {},
      protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
      getUsername: () => null,
      getUsernameByOwner: () => null,
    };

    const result = engine.validateTx(deps, tx, height);
    expect(result.valid).toBe(true);

    dbMod.closeDb();
  });
});

// ---------------------------------------------------------------------------
// The cost gate (MEMPOOL_INTERFACE → The cost gate): a transaction whose block
// — it alone, at tip + 1, its settlement built as the creator builds one — costs
// more than a block may is refused at admission, and never at the store, which
// a reorg's re-insertion reaches. The budget is lowered through
// `blockBudgetSeam`.
// ---------------------------------------------------------------------------

describe('the cost gate', () => {
  let budget: { set(budget: number): void };

  beforeEach(() => {
    vi.resetModules();
    budget = blockBudgetSeam();
  });
  afterEach(() => {
    vi.doUnmock('@dagsocial/consensus');
    vi.doUnmock('../../src/services/cost-estimate.js');
    vi.restoreAllMocks();
    vi.resetModules();
  });

  /** A store holding a sender's credit box ahead of the tree built over it, and a signed transfer spending it. */
  async function gatedNode() {
    const db = await import('../../src/store/db.js');
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await import('../../src/store/utxo.js');
    const sender = makeTestIdentity();
    const box = makeCreditBox(100_000n, sender.userId, 0, 1);
    utxo.insertBox(box);
    const handle = await liveProver();
    return {
      handle,
      tx: makeCreditTx(sender, [box], 1_000n),
      admit: await import('../../src/services/admit-tx.js'),
      mem: await import('../../src/store/mempool.js'),
    };
  }

  /** The cost of the block carrying `tx` alone at height 1, its settlement built as the creator builds one. */
  async function aloneCost(tx: UtxoTransaction): Promise<number> {
    const { applyBlock, blockCost, buildBlockSettlement, treeStateView, treeWritesOf } = await import('@dagsocial/consensus');
    const { computeTxId, encodeTx } = await import('@dagsocial/types');
    const { proverSession } = await import('../../src/state/prover-session.js');
    const { applyContextFrom } = await import('../../src/services/block-apply.js');
    const { config } = await import('../../src/config.js');
    const handle = await liveProver();
    const ctx = applyContextFrom(config);
    const miner = makeTestIdentity();
    const txBytes = encodeTx(tx);
    const built = buildBlockSettlement(treeStateView(proverSession(handle.prover)), [txBytes], 1, miner.userId, miner.userId, ctx);
    if ('error' in built) throw new Error(built.error);
    const block = {
      header: { height: 1, validatorId: miner.userId },
      utxoTxTree: { utxoTxIds: [computeTxId(tx), computeTxId(built.tx)], utxoTxs: [txBytes, encodeTx(built.tx)] },
      validatorSignature: new Uint8Array(64),
    } as unknown as OrderingBlock;
    const view = treeStateView(proverSession(handle.prover));
    const result = applyBlock(view, block, ctx);
    if (!result.ok) throw new Error(result.reason);
    const writes = treeWritesOf(result.effects, 1, view);
    return blockCost({ signatures: result.effects.signatures, lookups: view.lookupCount(), writes: writes.length });
  }

  it('refuses a transaction whose block alone is over the budget, naming its cost; admits one within it', async () => {
    const { tx, admit, mem } = await gatedNode();
    const cost = await aloneCost(tx);

    budget.set(cost - 1);
    let refusal: unknown;
    try {
      admit.admitTx(tx, 1000);
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(admit.TxOverBlockBudgetError);
    expect((refusal as Error).message).toContain(`cost ${cost} over the budget ${cost - 1}`);
    expect((refusal as { statusCode: number }).statusCode).toBe(413);
    expect(mem.getPendingEntries(10)).toHaveLength(0);

    budget.set(cost);
    expect(() => admit.admitTx(tx, 1000)).not.toThrow();
    expect(mem.getPendingEntries(10)).toHaveLength(1);
  });

  it('reads the tree unrecorded: admitting a transaction leaves nothing in the prover\'s proof cycle', async () => {
    const { handle, tx, admit } = await gatedNode();
    // A proof made at the boundary the bootstrap left covers no operation.
    const empty = handle.prover.prover.generateProof();

    expect(() => admit.admitTx(tx, 1000)).not.toThrow();
    expect(handle.prover.prover.generateProof()).toEqual(empty);
  });

  it('never refuses a reorg\'s re-insertion of a transaction its chain had carried', async () => {
    const { tx, admit, mem } = await gatedNode();
    const cost = await aloneCost(tx);
    const { applyOrderingBlock } = await import('../../src/services/block-apply.js');
    expect(applyOrderingBlock(await makeApplicableBlock({ utxoTxs: [tx] }))).toBe(true);

    // Under a budget the gate refuses it by, the revert re-inserts it — the gate
    // is above the store, where re-insertion never reaches.
    budget.set(cost - 1);
    const { reorg } = await import('../../src/services/fork-resolution.js');
    expect(() => reorg(0, [])).not.toThrow();
    expect(mem.getPendingEntries(10)).toHaveLength(1);
    expect(() => admit.admitTx(tx, 1000)).toThrow(`cost ${cost} over the budget ${cost - 1}`);
  });
});

// ---------------------------------------------------------------------------
// The gate keeps what it measured (MEMPOOL_INTERFACE → The cost gate): a costed
// admission writes the transaction's marginal cost — its block alone less the
// empty block at the same tip, the empty block's cost computed once a tip — and
// a row the gate did not cost carries NULL.
// ---------------------------------------------------------------------------

describe('the gate keeps what it measured', () => {
  /** The empty body's settlement builds the node's modules made: the empty block's cost, once a tip. */
  let emptyBuilds: number;

  beforeEach(() => {
    vi.resetModules();
    emptyBuilds = 0;
    vi.doMock('@dagsocial/consensus', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@dagsocial/consensus')>();
      return {
        ...actual,
        buildBlockSettlement: (...args: Parameters<typeof actual.buildBlockSettlement>) => {
          if (args[1].length === 0) emptyBuilds++;
          return actual.buildBlockSettlement(...args);
        },
      };
    });
  });
  afterEach(() => {
    vi.doUnmock('@dagsocial/consensus');
    vi.restoreAllMocks();
    vi.resetModules();
  });

  /** A store holding `senders` credit boxes, each its own sender's, ahead of the tree built over it. */
  async function nodeWithSenders(senders: number) {
    const db = await import('../../src/store/db.js');
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await import('../../src/store/utxo.js');
    const funded = Array.from({ length: senders }, (_, i) => {
      const sender = makeTestIdentity();
      const box = makeCreditBox(100_000n, sender.userId, 0, i + 1);
      utxo.insertBox(box);
      return { sender, box };
    });
    await liveProver();
    return {
      funded,
      admit: await import('../../src/services/admit-tx.js'),
      mem: await import('../../src/store/mempool.js'),
    };
  }

  /**
   * The cost of the block at height 1 carrying `txs`, then the settlement built
   * as the creator builds one, counted over the live tree read unrecorded — the
   * consensus the test file imported, so no build of it is counted above.
   */
  async function blockCostOf(txs: UtxoTransaction[]): Promise<number> {
    const { applyBlock, blockCost, buildBlockSettlement, treeStateView, treeWritesOf } =
      await vi.importActual<typeof import('@dagsocial/consensus')>('@dagsocial/consensus');
    const { computeTxId, encodeTx } = await import('@dagsocial/types');
    const { proverSession } = await import('../../src/state/prover-session.js');
    const { applyContextFrom } = await import('../../src/services/block-apply.js');
    const { config } = await import('../../src/config.js');
    const handle = await liveProver();
    const ctx = applyContextFrom(config);
    const miner = makeTestIdentity();
    const bodies = txs.map((tx) => encodeTx(tx));
    const built = buildBlockSettlement(treeStateView(proverSession(handle.prover)), bodies, 1, miner.userId, miner.userId, ctx);
    if ('error' in built) throw new Error(built.error);
    const block = {
      header: { height: 1, validatorId: miner.userId },
      utxoTxTree: {
        utxoTxIds: [...txs.map((tx) => computeTxId(tx)), computeTxId(built.tx)],
        utxoTxs: [...bodies, encodeTx(built.tx)],
      },
      validatorSignature: new Uint8Array(64),
    } as unknown as OrderingBlock;
    const view = treeStateView(proverSession(handle.prover));
    const result = applyBlock(view, block, ctx);
    if (!result.ok) throw new Error(result.reason);
    const writes = treeWritesOf(result.effects, 1, view);
    return blockCost({ signatures: result.effects.signatures, lookups: view.lookupCount(), writes: writes.length });
  }

  it('a costed admission writes its marginal cost: its block alone less the empty block at the same tip', async () => {
    const { funded, admit, mem } = await nodeWithSenders(1);
    const { sender, box } = funded[0]!;
    const tx = makeCreditTx(sender, [box], 1_000n);
    const alone = await blockCostOf([tx]);
    const empty = await blockCostOf([]);
    expect(alone).toBeGreaterThan(empty);

    admit.admitTx(tx, 1000);

    expect(mem.getPendingEntries(10).map((entry) => entry.costEstimate)).toEqual([alone - empty]);
  });

  it('computes the empty block\'s cost once a tip: twice admitted at one tip, once built; the tip moved, built again', async () => {
    const { funded, admit, mem } = await nodeWithSenders(3);
    const [first, second, third] = funded.map(({ sender, box }) => makeCreditTx(sender, [box], 1_000n));

    admit.admitTx(first!, 1000);
    admit.admitTx(second!, 1000);
    expect(emptyBuilds).toBe(1);

    const { applyOrderingBlock } = await import('../../src/services/block-apply.js');
    expect(applyOrderingBlock(await makeApplicableBlock({ utxoTxs: [first!, second!] }))).toBe(true);
    expect(mem.getPendingEntries(10)).toHaveLength(0);

    admit.admitTx(third!, 1000);
    expect(emptyBuilds).toBe(2);
    expect(mem.getPendingEntries(10).map((entry) => entry.costEstimate)).toEqual([expect.any(Number)]);
  });

  it('a transaction admitted uncostable carries NULL: one spending the output of a transaction still pooled', async () => {
    const { funded, admit, mem } = await nodeWithSenders(1);
    const { sender, box } = funded[0]!;
    const parent = makeCreditTx(sender, [box], 1_000n);
    const { materializeOutput } = await import('@dagsocial/consensus');
    const { computeTxId } = await import('@dagsocial/types');
    const change = materializeOutput(parent.outputs[0]!, computeTxId(parent), 0) as CreditBox;
    const child = makeCreditTx(sender, [change], 500n);

    admit.admitTx(parent, 1000);
    admit.admitTx(child, 1000);

    const [parentRow, childRow] = mem.getPendingEntries(10);
    expect(parentRow!.costEstimate).toEqual(expect.any(Number));
    expect(childRow!.costEstimate).toBeNull();
  });

  it('a reorg\'s re-insertion carries NULL', async () => {
    const { funded, admit, mem } = await nodeWithSenders(1);
    const { sender, box } = funded[0]!;
    const tx = makeCreditTx(sender, [box], 1_000n);
    admit.admitTx(tx, 1000);
    expect(mem.getPendingEntries(10)[0]!.costEstimate).toEqual(expect.any(Number));

    const { applyOrderingBlock } = await import('../../src/services/block-apply.js');
    expect(applyOrderingBlock(await makeApplicableBlock({ utxoTxs: [tx] }))).toBe(true);
    expect(mem.getPendingEntries(10)).toHaveLength(0);
    const { reorg } = await import('../../src/services/fork-resolution.js');
    expect(() => reorg(0, [])).not.toThrow();

    expect(mem.getPendingEntries(10).map((entry) => entry.costEstimate)).toEqual([null]);
  });
});
