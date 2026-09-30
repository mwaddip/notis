import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MAX_BLOCK_BODY_BYTES, PROTOCOL_VERSION, bytesToHex, computeTxId, decodeTx } from '@dagsocial/types';
import type { CreditBox, FeeBox, OrderingBlock, UtxoTransaction } from '@dagsocial/types';
import type { Config } from '../../src/config.js';
import {
  blockBudgetSeam,
  liveProver,
  makeCreditBox,
  makeTestConfig,
  makeTestIdentity,
  mineNextBlock,
  signTransaction,
} from '../helpers.js';
import type { TestIdentity } from '../helpers.js';

/**
 * Packing to the budget (MINING_INTERFACE → Template and submit → "Packing to
 * the budget"): a body's cost is known only by executing it, so the creator
 * fills in fee order by the admission's cost estimates to the budget less
 * `PACKING_COST_MARGIN` — an entry with no estimate costed alone first and its
 * row updated — and speculates that selection once. Over the budget, it drops
 * from the tail the entries whose estimates cover the overshoot and speculates
 * again, twice at most; still over, it halves the selection and bisects to the
 * longest prefix it finds within the budget. No template is ever over the
 * budget, and an entry trimmed stays pooled. The budget is lowered through
 * `blockBudgetSeam`.
 */

const testConfig: Config = makeTestConfig({
  dbPath: ':memory:',
  nodeRole: 'miner',
  blockBodyBudgetBytes: MAX_BLOCK_BODY_BYTES,
  bootstrapPeers: [],
});

/** The percent of the budget the fill leaves unused against estimates that miss — a literal in the creator (CONSTANTS → Producer policy). */
const PACKING_COST_MARGIN = 5;

async function freshStore() {
  const db = await import('../../src/store/db.js');
  db.initDb(':memory:');
  db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
  return db;
}

/** A deterministic generator, so a failing pool is reproducible from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A signed credit transfer spending `inputs` into `outputs` credit boxes back to
 * the spender, `fee` in a `FeeBox` — conserving, so the rules apply it.
 */
function creditSpend(spender: TestIdentity, inputs: CreditBox[], fee: bigint, outputs: number): UtxoTransaction {
  const total = inputs.reduce((sum, box) => sum + box.value, 0n) - fee;
  const share = total / BigInt(outputs);
  const tx: UtxoTransaction = {
    inputs: inputs.map((box) => box.id!),
    outputs: [
      ...Array.from({ length: outputs }, (_, i) => ({
        boxType: 'credit' as const,
        value: i === 0 ? total - share * BigInt(outputs - 1) : share,
        createdAtBlock: 0,
        owner: spender.userId,
      }) as CreditBox),
      { boxType: 'fee', value: fee, createdAtBlock: 0 } as FeeBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, spender.privateKey, bytesToHex(spender.userId));
  return tx;
}

/**
 * `shapes.length` credit transfers, each spending its own fresh boxes, the boxes
 * put in the store ahead of the tree — `inputs` boxes into `outputs` boxes, a
 * distinct fee each.
 */
async function fundedTransfers(shapes: Array<{ inputs: number; outputs: number }>): Promise<UtxoTransaction[]> {
  const utxo = await import('../../src/store/utxo.js');
  let nonce = 1;
  return shapes.map(({ inputs, outputs }, i) => {
    const spender = makeTestIdentity();
    const boxes = Array.from({ length: inputs }, () => makeCreditBox(100_000n, spender.userId, 0, nonce++));
    for (const box of boxes) utxo.insertBox(box);
    return creditSpend(spender, boxes, 1_000n + 37n * BigInt(i), outputs);
  });
}

/** The pool's fill order for its credit transfers, as ids. */
async function fillOrder(): Promise<string[]> {
  const mempool = await import('../../src/store/mempool.js');
  return [...mempool.iteratePendingEntries({ klass: 'credit' })].map((entry) => computeTxId(decodeTx(entry.utxoTxBytes!)));
}

/**
 * Pool `fundedTransfers(shapes)` in the store directly, as a reorg re-inserts —
 * rows carrying no estimate — and answer the pool's fill order for them.
 */
async function poolOf(shapes: Array<{ inputs: number; outputs: number }>): Promise<string[]> {
  const mempool = await import('../../src/store/mempool.js');
  for (const tx of await fundedTransfers(shapes)) mempool.insertUtxoTx(tx, 5000);
  return fillOrder();
}

/**
 * Admit `fundedTransfers(shapes)` through the cost gate once the tree holds their
 * boxes, so every row carries the gate's estimate (MEMPOOL_INTERFACE → The cost
 * gate), and answer the pool's fill order for them.
 */
async function admittedPoolOf(shapes: Array<{ inputs: number; outputs: number }>): Promise<string[]> {
  const txs = await fundedTransfers(shapes);
  await liveProver();
  const { admitTx } = await import('../../src/services/admit-tx.js');
  for (const tx of txs) admitTx(tx, 5000);
  return fillOrder();
}

/** Every pooled row's estimate rewritten as `rewrite` of the one it carries. */
async function estimateEvery(rewrite: (estimate: number | null) => number): Promise<void> {
  const mempool = await import('../../src/store/mempool.js');
  for (const entry of mempool.getPendingEntries(10_000)) mempool.setCostEstimate(entry.rowid, rewrite(entry.costEstimate));
}

/** The estimates the pool's rows carry, in `order`. */
async function estimatesOf(order: string[]): Promise<Array<number | null>> {
  const mempool = await import('../../src/store/mempool.js');
  const byId = new Map(mempool.getPendingEntries(10_000).map((entry) => [computeTxId(decodeTx(entry.utxoTxBytes!)), entry.costEstimate]));
  return order.map((id) => byId.get(id)!);
}

/** The pooled transactions by id, as the pool holds them. */
async function pooledBytes(): Promise<Map<string, Uint8Array>> {
  const mempool = await import('../../src/store/mempool.js');
  const byId = new Map<string, Uint8Array>();
  for (const entry of mempool.iteratePendingEntries()) {
    byId.set(computeTxId(decodeTx(entry.utxoTxBytes!)), entry.utxoTxBytes!);
  }
  return byId;
}

/**
 * The cost of the block carrying `bodies` at height 1, its settlement built as
 * the creator builds one, counted over the live tree read unrecorded
 * (CONSENSUS_INTERFACE → The block's cost).
 */
async function bodiesCost(bodies: Uint8Array[]): Promise<number> {
  const { applyBlock, blockCost, buildBlockSettlement, treeStateView, treeWritesOf } = await import('@dagsocial/consensus');
  const { proverSession } = await import('../../src/state/prover-session.js');
  const { applyContextFrom } = await import('../../src/services/block-apply.js');
  const { config } = await import('../../src/config.js');
  const { encodeTx } = await import('@dagsocial/types');
  const handle = await liveProver();
  const miner = makeTestIdentity();
  const ctx = applyContextFrom(config);
  const built = buildBlockSettlement(treeStateView(proverSession(handle.prover)), bodies, 1, miner.userId, miner.userId, ctx);
  if ('error' in built) throw new Error(built.error);
  const block = {
    header: { height: 1, validatorId: miner.userId },
    utxoTxTree: {
      utxoTxIds: [...bodies.map((body) => computeTxId(decodeTx(body))), computeTxId(built.tx)],
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

/** The cost of the block carrying the pooled transactions `ids`, in that order (`bodiesCost`). */
async function txsCost(ids: string[]): Promise<number> {
  const byId = await pooledBytes();
  return bodiesCost(ids.map((id) => byId.get(id)!));
}

/** The cost of the block carrying the first `length` transactions of `order` (`txsCost`). */
async function prefixCost(order: string[], length: number): Promise<number> {
  return txsCost(order.slice(0, length));
}

/** The cost of `block` as the rules count it over the live tree, read unrecorded. */
async function costOfBlock(block: OrderingBlock): Promise<number> {
  const { applyBlock, blockCost, treeStateView, treeWritesOf } = await import('@dagsocial/consensus');
  const { proverSession } = await import('../../src/state/prover-session.js');
  const { applyContextFrom } = await import('../../src/services/block-apply.js');
  const { config } = await import('../../src/config.js');
  const handle = await liveProver();
  const view = treeStateView(proverSession(handle.prover));
  const result = applyBlock(view, block, applyContextFrom(config));
  if (!result.ok) throw new Error(result.reason);
  const writes = treeWritesOf(result.effects, block.header.height, view);
  return blockCost({ signatures: result.effects.signatures, lookups: view.lookupCount(), writes: writes.length });
}

/** The user transactions of a body — every entry but the settlement, last. */
function userTxIds(block: OrderingBlock): string[] {
  return block.utxoTxTree.utxoTxIds.slice(0, -1);
}

/**
 * Every speculation the creator runs, counted: `computePostBlockStateRoot`
 * wrapped in the modules imported after this is registered.
 */
function countSpeculations(): { count: number } {
  const counter = { count: 0 };
  vi.doMock('../../src/services/block-apply.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/services/block-apply.js')>();
    return {
      ...actual,
      computePostBlockStateRoot: (...args: Parameters<typeof actual.computePostBlockStateRoot>) => {
        counter.count++;
        return actual.computePostBlockStateRoot(...args);
      },
    };
  });
  return counter;
}

describe('packing to the budget', () => {
  let budget: { set(budget: number): void };

  beforeEach(() => {
    vi.resetModules();
    budget = blockBudgetSeam();
  });
  afterEach(async () => {
    (await import('../../src/services/block-creator.js')).stopBlockCreator();
    vi.doUnmock('@dagsocial/consensus');
    vi.doUnmock('../../src/services/cost-estimate.js');
    vi.doUnmock('../../src/services/block-apply.js');
    vi.doUnmock('../../src/config.js');
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('with estimates that cover nothing, trims a selection over the budget to the longest prefix within it, evicts nothing, and the template it holds applies', async () => {
    const speculations = countSpeculations();
    await freshStore();
    const order = await poolOf(Array.from({ length: 11 }, () => ({ inputs: 1, outputs: 1 })));
    await liveProver();
    const costs: number[] = [];
    for (let length = 0; length <= order.length; length++) costs.push(await prefixCost(order, length));
    const within = 6;
    expect(costs[within]!).toBeLessThan(costs[within + 1]!);
    budget.set(costs[within]!);
    expect(costs[order.length]!).toBeGreaterThan(costs[within]!);
    // A single unit each: the fill takes the whole selection, no tail of
    // estimates covers the overshoot, and the halving decides.
    await estimateEvery(() => 1);

    const bc = await import('../../src/services/block-creator.js');
    const mempool = await import('../../src/store/mempool.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bc.startBlockCreator(testConfig);
    warn.mockRestore();
    const template = bc.getCurrentTemplate();

    expect(template).not.toBeNull();
    expect(userTxIds(template!)).toEqual(order.slice(0, within));
    expect(await costOfBlock(template!)).toBe(costs[within]!);
    // The selection first, then at most 2·log₂(n) + 1 more.
    expect(speculations.count).toBeLessThanOrEqual(1 + 2 * Math.log2(order.length) + 1);
    // Nothing was evicted for the budget: every entry is still pooled.
    expect(mempool.getPendingEntries(100)).toHaveLength(order.length);

    const mined = await mineNextBlock(bc);
    expect(mined).not.toBeNull();
    expect(userTxIds(mined!)).toEqual(order.slice(0, within));
    expect(mempool.getPendingEntries(100)).toHaveLength(order.length - within);
  });

  it('holds no template, and evicts nothing, when even the body with no user transaction is over the budget', async () => {
    await freshStore();
    const order = await poolOf([{ inputs: 1, outputs: 1 }, { inputs: 2, outputs: 1 }]);
    await liveProver();
    budget.set((await prefixCost(order, 0)) - 1);

    const bc = await import('../../src/services/block-creator.js');
    const mempool = await import('../../src/store/mempool.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bc.startBlockCreator(testConfig);

    expect(bc.getCurrentTemplate()).toBeNull();
    expect(warn.mock.calls.some((call) => String(call[0]).startsWith('Not producing block at height 1:'))).toBe(true);
    expect(mempool.getPendingEntries(100)).toHaveLength(order.length);
  });

  it('a pool where a longer prefix costs less still yields no template over the budget', async () => {
    // A transfer into eight boxes, then one consolidating all eight — its inputs
    // net out against the first one's outputs, so the pair costs less than the
    // first alone — then an unrelated transfer.
    await freshStore();
    const utxo = await import('../../src/store/utxo.js');
    const mempool = await import('../../src/store/mempool.js');
    const { materializeOutput } = await import('@dagsocial/consensus');
    const spender = makeTestIdentity();
    const [source, other] = [makeCreditBox(100_000n, spender.userId, 0, 1), makeCreditBox(100_000n, spender.userId, 0, 2)];
    utxo.insertBox(source);
    utxo.insertBox(other);
    const split = creditSpend(spender, [source], 4_000n, 8);
    const splitId = computeTxId(split);
    const parts = split.outputs.slice(0, 8).map((out, i) => materializeOutput(out, splitId, i) as CreditBox);
    const joined = creditSpend(spender, parts, 1_000n, 1);
    const unrelated = creditSpend(spender, [other], 10n, 1);
    for (const tx of [split, joined, unrelated]) mempool.insertUtxoTx(tx, 5000);
    const order = [...mempool.iteratePendingEntries({ klass: 'credit' })].map((entry) => computeTxId(decodeTx(entry.utxoTxBytes!)));
    expect(order).toEqual([splitId, computeTxId(joined), computeTxId(unrelated)]);
    await liveProver();
    const costs: number[] = [];
    for (let length = 0; length <= order.length; length++) costs.push(await prefixCost(order, length));
    expect(costs[2]!).toBeLessThan(costs[1]!);
    budget.set(costs[2]!);
    expect(costs[3]!).toBeGreaterThan(costs[2]!);
    // A single unit each, so the fill takes all three and the search decides.
    await estimateEvery(() => 1);

    const bc = await import('../../src/services/block-creator.js');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    bc.startBlockCreator(testConfig);
    const template = bc.getCurrentTemplate();

    // The search halves past the pair that fits, and holds a shorter prefix —
    // within the budget all the same.
    expect(template).not.toBeNull();
    expect(await costOfBlock(template!)).toBeLessThanOrEqual(costs[2]!);
    expect(userTxIds(template!)).toEqual(order.slice(0, userTxIds(template!).length));
    expect(mempool.getPendingEntries(100)).toHaveLength(order.length);
  });

  // A property over random pools: transfers of one to three inputs into one to
  // three outputs, pooled with no estimate, and a budget anywhere from below the
  // empty body's cost to above the whole selection's. One speculation; no
  // template is ever over the budget; a template is always a prefix of the fill
  // order, and the entry after it does not fit the budget less the margin.
  it.each(Array.from({ length: 12 }, (_, i) => 0x5eed + i))('random pool %i: no template is ever over the budget', async (seed) => {
    const speculations = countSpeculations();
    const random = mulberry32(seed);
    const pick = (n: number): number => 1 + Math.floor(random() * n);
    await freshStore();
    const order = await poolOf(Array.from({ length: pick(8) }, () => ({ inputs: pick(3), outputs: pick(3) })));
    await liveProver();
    const costs: number[] = [];
    for (let length = 0; length <= order.length; length++) costs.push(await prefixCost(order, length));
    const low = costs[0]! - 40;
    const high = costs[order.length]! + 40;
    const limit = low + Math.floor(random() * (high - low));
    budget.set(limit);

    const bc = await import('../../src/services/block-creator.js');
    const mempool = await import('../../src/store/mempool.js');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    bc.startBlockCreator(testConfig);
    const template = bc.getCurrentTemplate();
    expect(mempool.getPendingEntries(100)).toHaveLength(order.length);
    expect(speculations.count).toBe(1);

    if (costs[0]! > limit) {
      expect(template).toBeNull();
      return;
    }
    expect(template).not.toBeNull();
    const held = userTxIds(template!);
    expect(held).toEqual(order.slice(0, held.length));
    expect(await costOfBlock(template!)).toBeLessThanOrEqual(limit);
    if (held.length < order.length) {
      expect(costs[held.length + 1]!).toBeGreaterThan(Math.floor((limit * (100 - PACKING_COST_MARGIN)) / 100));
    }
  });

  it('packs a full pool by its admission estimates and speculates once: the longest prefix they fit to the margin, within the budget', async () => {
    const speculations = countSpeculations();
    const random = mulberry32(0xf011);
    const pick = (n: number): number => 1 + Math.floor(random() * n);
    await freshStore();
    const order = await admittedPoolOf(Array.from({ length: 120 }, () => ({ inputs: pick(3), outputs: pick(3) })));
    const estimates = await estimatesOf(order);
    expect(estimates.every((estimate) => estimate !== null && estimate > 0)).toBe(true);
    const empty = await prefixCost(order, 0);
    // The fee-ordered selection is twice what the budget holds.
    const limit = await prefixCost(order, 60);
    budget.set(limit);
    const packTo = Math.floor((limit * (100 - PACKING_COST_MARGIN)) / 100);
    let fits = 0;
    let estimated = empty;
    while (fits < order.length && estimated + estimates[fits]! <= packTo) estimated += estimates[fits++]!;

    const bc = await import('../../src/services/block-creator.js');
    const mempool = await import('../../src/store/mempool.js');
    bc.startBlockCreator(testConfig);
    const template = bc.getCurrentTemplate();

    expect(speculations.count).toBe(1);
    expect(template).not.toBeNull();
    expect(userTxIds(template!)).toEqual(order.slice(0, fits));
    const cost = await costOfBlock(template!);
    // Independent transfers: the block costs the empty body plus its entries' estimates, exactly.
    expect(cost).toBe(estimated);
    expect(cost).toBeLessThanOrEqual(limit);
    // Full to the margin, short of it by less than the entry that did not fit.
    expect(cost + estimates[fits]!).toBeGreaterThan(packTo);
    expect(cost / limit).toBeGreaterThan((100 - PACKING_COST_MARGIN) / 100 - Math.max(...(estimates as number[])) / limit);
    expect(mempool.getPendingEntries(1000)).toHaveLength(order.length);
  });

  it('estimates low by a stated factor: the build drops the tail they cover and corrects within the two retries, within the budget', async () => {
    const speculations = countSpeculations();
    await freshStore();
    const order = await admittedPoolOf(Array.from({ length: 120 }, () => ({ inputs: 1, outputs: 1 })));
    // Four fifths of what the gate measured: a miss four times the margin.
    await estimateEvery((measured) => Math.floor((measured! * 4) / 5));
    const [low] = await estimatesOf(order);
    expect(new Set(await estimatesOf(order))).toEqual(new Set([low]));
    const empty = await prefixCost(order, 0);
    const limit = await prefixCost(order, 60);
    budget.set(limit);
    // The fill by the low estimates, the overshoot its speculation finds, and the
    // tail whose estimates cover it.
    const packTo = Math.floor((limit * (100 - PACKING_COST_MARGIN)) / 100);
    const filled = Math.floor((packTo - empty) / low!);
    const overshoot = (await prefixCost(order, filled)) - limit;
    expect(overshoot).toBeGreaterThan(0);
    const kept = filled - Math.ceil(overshoot / low!);

    const bc = await import('../../src/services/block-creator.js');
    const mempool = await import('../../src/store/mempool.js');
    bc.startBlockCreator(testConfig);
    const template = bc.getCurrentTemplate();

    expect(speculations.count).toBe(2);
    expect(template).not.toBeNull();
    expect(userTxIds(template!)).toEqual(order.slice(0, kept));
    expect(await costOfBlock(template!)).toBeLessThanOrEqual(limit);
    expect(mempool.getPendingEntries(1000)).toHaveLength(order.length);
  });

  // Estimates wildly low — a unit each — over random pools and budgets: the fill
  // takes the whole selection, and a budget below its last entry leaves an
  // overshoot of more than a whole transfer, which no tail of unit estimates
  // covers; the halving and bisection hold the longest prefix within the budget.
  it.each(Array.from({ length: 6 }, (_, i) => 0xbad + i))('random pool %i with estimates wildly low: the search still never exceeds the budget', async (seed) => {
    const speculations = countSpeculations();
    const random = mulberry32(seed);
    const pick = (n: number): number => 1 + Math.floor(random() * n);
    await freshStore();
    const order = await admittedPoolOf(Array.from({ length: 8 + pick(16) }, () => ({ inputs: pick(3), outputs: pick(3) })));
    await estimateEvery(() => 1);
    const costs: number[] = [];
    for (let length = 0; length <= order.length; length++) costs.push(await prefixCost(order, length));
    const limit = costs[0]! + Math.floor(random() * (costs[order.length - 1]! - costs[0]!));
    expect(costs[order.length]! - limit).toBeGreaterThan(order.length);
    budget.set(limit);

    const bc = await import('../../src/services/block-creator.js');
    const mempool = await import('../../src/store/mempool.js');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    bc.startBlockCreator(testConfig);
    const template = bc.getCurrentTemplate();

    expect(speculations.count).toBeGreaterThan(3);
    expect(template).not.toBeNull();
    const held = userTxIds(template!);
    expect(held).toEqual(order.slice(0, held.length));
    expect(await costOfBlock(template!)).toBeLessThanOrEqual(limit);
    expect(costs[held.length + 1]!).toBeGreaterThan(limit);
    expect(mempool.getPendingEntries(1000)).toHaveLength(order.length);
  });

  it('costs a row with no estimate alone before the fill counts it, and writes the estimate to its row', async () => {
    const speculations = countSpeculations();
    await freshStore();
    const order = await poolOf([{ inputs: 1, outputs: 1 }, { inputs: 2, outputs: 1 }, { inputs: 1, outputs: 3 }]);
    await liveProver();
    expect(await estimatesOf(order)).toEqual([null, null, null]);
    const empty = await prefixCost(order, 0);
    const marginals: number[] = [];
    for (const id of order) marginals.push((await txsCost([id])) - empty);

    const bc = await import('../../src/services/block-creator.js');
    bc.startBlockCreator(testConfig);
    const template = bc.getCurrentTemplate();

    expect(speculations.count).toBe(1);
    expect(userTxIds(template!)).toEqual(order);
    expect(await estimatesOf(order)).toEqual(marginals);
  });

  it('an entry with no block alone to cost keeps no estimate, and rides the selection behind the entry it spends from', async () => {
    const speculations = countSpeculations();
    await freshStore();
    const utxo = await import('../../src/store/utxo.js');
    const mempool = await import('../../src/store/mempool.js');
    const { materializeOutput } = await import('@dagsocial/consensus');
    const spender = makeTestIdentity();
    const box = makeCreditBox(100_000n, spender.userId, 0, 1);
    utxo.insertBox(box);
    const parent = creditSpend(spender, [box], 5_000n, 2);
    const change = materializeOutput(parent.outputs[0]!, computeTxId(parent), 0) as CreditBox;
    const child = creditSpend(spender, [change], 10n, 1);
    mempool.insertUtxoTx(parent, 5000);
    mempool.insertUtxoTx(child, 5000);
    const order = await fillOrder();
    expect(order).toEqual([computeTxId(parent), computeTxId(child)]);
    await liveProver();
    const empty = await prefixCost(order, 0);
    const parentAlone = await txsCost([computeTxId(parent)]);

    const bc = await import('../../src/services/block-creator.js');
    bc.startBlockCreator(testConfig);
    const template = bc.getCurrentTemplate();

    expect(speculations.count).toBe(1);
    expect(userTxIds(template!)).toEqual(order);
    expect(await estimatesOf(order)).toEqual([parentAlone - empty, null]);
  });

  it('costs each rent transaction alone and packs it by that estimate', async () => {
    // Every credit box created at height 0 owes rent at height 1 (NODE_INTERFACE →
    // "Storage rent is a transition requiring no signature").
    vi.doMock('../../src/config.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/config.js')>('../../src/config.js');
      return { ...actual, config: Object.freeze({ ...actual.config, storageRentPeriodBlocks: 0 }) };
    });
    const speculations = countSpeculations();
    await freshStore();
    const utxo = await import('../../src/store/utxo.js');
    for (const nonce of [1, 2]) utxo.insertBox(makeCreditBox(100_000_000n, makeTestIdentity().userId, 0, nonce));
    await liveProver();

    const bc = await import('../../src/services/block-creator.js');
    bc.startBlockCreator(testConfig);
    const both = bc.getCurrentTemplate()!.utxoTxTree.utxoTxs.slice(0, -1);
    expect(both).toHaveLength(2);
    expect(both.every((body) => Object.keys(decodeTx(body).signatures).length === 0)).toBe(true);
    const [empty, one, two] = [await bodiesCost([]), await bodiesCost(both.slice(0, 1)), await bodiesCost(both)];
    expect(one).toBeGreaterThan(empty);
    expect(two).toBeGreaterThan(one);

    // The budget holds both rent transactions; the budget less the margin holds
    // the first one's estimate and not the second's.
    const limit = two;
    const packTo = Math.floor((limit * (100 - PACKING_COST_MARGIN)) / 100);
    expect(packTo).toBeGreaterThanOrEqual(one);
    expect(packTo).toBeLessThan(two);
    budget.set(limit);
    speculations.count = 0;
    bc.createOrderingBlock();
    const template = bc.getCurrentTemplate()!;

    expect(speculations.count).toBe(1);
    expect(template.utxoTxTree.utxoTxs.slice(0, -1)).toEqual(both.slice(0, 1));
  });
});
