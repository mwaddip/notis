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
 * speculates the fee-ordered selection and, over the budget, trims it from the
 * tail to the longest prefix it finds within the budget. No template is ever over
 * the budget, and an entry trimmed stays pooled. The budget is lowered through
 * `blockBudgetSeam`.
 */

const testConfig: Config = makeTestConfig({
  dbPath: ':memory:',
  nodeRole: 'miner',
  blockBodyBudgetBytes: MAX_BLOCK_BODY_BYTES,
  bootstrapPeers: [],
});

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
 * Pool `shapes.length` credit transfers, each spending its own fresh boxes, in
 * the store ahead of the tree — `inputs` boxes into `outputs` boxes, a distinct
 * fee each — and answer the pool's fill order for them.
 */
async function poolOf(shapes: Array<{ inputs: number; outputs: number }>): Promise<string[]> {
  const utxo = await import('../../src/store/utxo.js');
  const mempool = await import('../../src/store/mempool.js');
  let nonce = 1;
  const pooled: UtxoTransaction[] = [];
  shapes.forEach(({ inputs, outputs }, i) => {
    const spender = makeTestIdentity();
    const boxes = Array.from({ length: inputs }, () => makeCreditBox(100_000n, spender.userId, 0, nonce++));
    for (const box of boxes) utxo.insertBox(box);
    pooled.push(creditSpend(spender, boxes, 1_000n + 37n * BigInt(i), outputs));
  });
  for (const tx of pooled) mempool.insertUtxoTx(tx, 5000);
  return [...mempool.iteratePendingEntries({ klass: 'credit' })].map((entry) => computeTxId(decodeTx(entry.utxoTxBytes!)));
}

/** The pooled transactions by id, as the pool holds them. */
async function pooledBytes(): Promise<Map<string, Uint8Array>> {
  const mempool = await import('../../src/store/mempool.js');
  const byId = new Map<string, Uint8Array>();
  for (const entry of mempool.iteratePendingEntries({ klass: 'credit' })) {
    byId.set(computeTxId(decodeTx(entry.utxoTxBytes!)), entry.utxoTxBytes!);
  }
  return byId;
}

/**
 * The cost of the block carrying the first `length` transactions of `order` at
 * height 1, its settlement built as the creator builds one, counted over the live
 * tree read unrecorded (CONSENSUS_INTERFACE → The block's cost).
 */
async function prefixCost(order: string[], length: number): Promise<number> {
  const { applyBlock, blockCost, buildBlockSettlement, treeStateView, treeWritesOf } = await import('@dagsocial/consensus');
  const { proverSession } = await import('../../src/state/prover-session.js');
  const { applyContextFrom } = await import('../../src/services/block-apply.js');
  const { config } = await import('../../src/config.js');
  const handle = await liveProver();
  const byId = await pooledBytes();
  const txBytes = order.slice(0, length).map((id) => byId.get(id)!);
  const miner = makeTestIdentity();
  const ctx = applyContextFrom(config);
  const built = buildBlockSettlement(treeStateView(proverSession(handle.prover)), txBytes, 1, miner.userId, miner.userId, ctx);
  if ('error' in built) throw new Error(built.error);
  const { encodeTx } = await import('@dagsocial/types');
  const block = {
    header: { height: 1, validatorId: miner.userId },
    utxoTxTree: {
      utxoTxIds: [...order.slice(0, length), computeTxId(built.tx)],
      utxoTxs: [...txBytes, encodeTx(built.tx)],
    },
    validatorSignature: new Uint8Array(64),
  } as unknown as OrderingBlock;
  const view = treeStateView(proverSession(handle.prover));
  const result = applyBlock(view, block, ctx);
  if (!result.ok) throw new Error(result.reason);
  const writes = treeWritesOf(result.effects, 1, view);
  return blockCost({ signatures: result.effects.signatures, lookups: view.lookupCount(), writes: writes.length });
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

describe('packing to the budget', () => {
  let budget: { set(budget: number): void };

  beforeEach(() => {
    vi.resetModules();
    budget = blockBudgetSeam();
  });
  afterEach(async () => {
    (await import('../../src/services/block-creator.js')).stopBlockCreator();
    vi.doUnmock('@dagsocial/consensus');
    vi.doUnmock('../../src/services/block-apply.js');
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('trims a selection over the budget to the longest prefix within it, evicts nothing, and the template it holds applies', async () => {
    // Every speculation the creator runs, counted.
    let speculations = 0;
    vi.doMock('../../src/services/block-apply.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/services/block-apply.js')>();
      return {
        ...actual,
        computePostBlockStateRoot: (...args: Parameters<typeof actual.computePostBlockStateRoot>) => {
          speculations++;
          return actual.computePostBlockStateRoot(...args);
        },
      };
    });
    await freshStore();
    const order = await poolOf(Array.from({ length: 11 }, () => ({ inputs: 1, outputs: 1 })));
    await liveProver();
    const costs: number[] = [];
    for (let length = 0; length <= order.length; length++) costs.push(await prefixCost(order, length));
    const within = 6;
    expect(costs[within]!).toBeLessThan(costs[within + 1]!);
    budget.set(costs[within]!);
    expect(costs[order.length]!).toBeGreaterThan(costs[within]!);

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
    expect(speculations).toBeLessThanOrEqual(1 + 2 * Math.log2(order.length) + 1);
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
  // three outputs, and a budget anywhere from below the empty body's cost to above
  // the whole selection's. No template is ever over the budget; a template is
  // always a prefix of the fill order, and the entry after it does not fit.
  it.each(Array.from({ length: 12 }, (_, i) => 0x5eed + i))('random pool %i: no template is ever over the budget', async (seed) => {
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

    if (costs[0]! > limit) {
      expect(template).toBeNull();
      return;
    }
    expect(template).not.toBeNull();
    const held = userTxIds(template!);
    expect(held).toEqual(order.slice(0, held.length));
    expect(await costOfBlock(template!)).toBeLessThanOrEqual(limit);
    if (held.length < order.length) expect(costs[held.length + 1]!).toBeGreaterThan(limit);
  });
});
