import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PROTOCOL_VERSION, STORAGE_RENT_PER_BYTE, boxRecordBytes } from '@dagsocial/types';
import type { AnyBoxCandidate, UtxoTransaction } from '@dagsocial/types';
import { blockBudgetSeam, liveProver, makeCreditBox, makeCreditTx, makeTestIdentity } from '../helpers.js';

/**
 * The gossip relay's transaction handler (NODE_INTERFACE → Relay handlers). A
 * policy refusal of a relayed transaction — the fee floor's, rent's, the cost
 * gate's — is this node's answer to it: the handler logs it as a refusal and
 * returns with the pool unchanged, and throws nothing for net to log as a
 * handler defect. A throw that is no refusal still reaches net.
 */

/** The config module with `overrides` over the process config — registered before the node's modules load. */
function configWith(overrides: Record<string, unknown>): void {
  vi.doMock('../../src/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/config.js')>();
    return { ...actual, config: Object.freeze({ ...actual.config, ...overrides }) };
  });
}

/**
 * A fresh store holding one credit box of ten credits for a fresh sender — more
 * than a rent charge on it — and a prover over it.
 */
async function storeWithCredit() {
  const db = await import('../../src/store/db.js');
  db.initDb(':memory:');
  db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
  const utxo = await import('../../src/store/utxo.js');
  const sender = makeTestIdentity();
  const box = makeCreditBox(10n * 10n ** 8n, sender.userId, 0, 1);
  utxo.insertBox(box);
  await liveProver();
  return { sender, box };
}

/** `tx` through the relay handler: the lines it warned and errored, what it threw, and the pool after. */
async function relay(tx: UtxoTransaction) {
  const { handleRelayedTx } = await import('../../src/services/handle-tx.js');
  const warned: string[] = [];
  const errored: string[] = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warned.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errored.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  let thrown: unknown = null;
  try {
    handleRelayedTx(tx, undefined, 'peer-relay');
  } catch (err) {
    thrown = err;
  }
  const mempool = await import('../../src/store/mempool.js');
  return { warned, errored, thrown, pooled: mempool.getPendingEntries(10).length };
}

describe('the relay handler takes a policy refusal as an answer', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(async () => {
    (await import('../../src/store/db.js')).closeDb();
    vi.doUnmock('../../src/config.js');
    vi.doUnmock('@dagsocial/consensus');
    vi.doUnmock('../../src/services/admit-tx.js');
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('a transaction under the fee floor is logged as refused, and nothing is thrown or pooled', async () => {
    configWith({ minFeeRatePerByte: 10n ** 6n });
    const { sender, box } = await storeWithCredit();

    const run = await relay(makeCreditTx(sender, [box], 1n));

    expect(run.thrown).toBeNull();
    expect(run.warned.some((line) => line.startsWith('Relayed tx refused: Fee rate below this node\'s floor'))).toBe(true);
    expect(run.errored).toEqual([]);
    expect(run.pooled).toBe(0);
  });

  it('a rent transaction is logged as refused, and nothing is thrown or pooled', async () => {
    // Rent-eligible at the height that would carry it, tip + 1.
    configWith({ storageRentPeriodBlocks: 0 });
    const { box } = await storeWithCredit();
    const { getBoxProvenance } = await import('../../src/store/utxo.js');
    const provenance = getBoxProvenance(box.id!);
    if (provenance === null) throw new Error('the seeded box has no provenance');
    const charge = STORAGE_RENT_PER_BYTE * BigInt(boxRecordBytes(box, provenance.txId, provenance.index).length);
    const rent: UtxoTransaction = {
      inputs: [box.id!],
      outputs: [
        { boxType: 'credit', value: box.value - charge, createdAtBlock: 1, owner: box.owner } as AnyBoxCandidate,
        { boxType: 'fee', value: charge, createdAtBlock: 1 } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };

    const run = await relay(rent);

    expect(run.thrown).toBeNull();
    expect(run.warned, JSON.stringify(run.warned)).toContain('Relayed tx refused: Rent transactions are not accepted for relay');
    expect(run.errored).toEqual([]);
    expect(run.pooled).toBe(0);
  });

  it('a transaction no block can carry is logged as refused, and nothing is thrown or pooled', async () => {
    const budget = blockBudgetSeam();
    const { sender, box } = await storeWithCredit();
    budget.set(1);

    const run = await relay(makeCreditTx(sender, [box], 1_000n));

    expect(run.thrown).toBeNull();
    expect(run.warned.some((line) => line.startsWith('Relayed tx refused: A block carrying this transaction alone is over the budget'))).toBe(true);
    expect(run.errored).toEqual([]);
    expect(run.pooled).toBe(0);
  });

  it('control: a throw from admission that is no refusal still reaches net', async () => {
    vi.doMock('../../src/services/admit-tx.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/services/admit-tx.js')>();
      return {
        ...actual,
        admitTx: () => {
          throw new Error('injected: admission fails');
        },
      };
    });
    const { sender, box } = await storeWithCredit();

    const run = await relay(makeCreditTx(sender, [box], 1_000n));

    expect(String(run.thrown)).toContain('injected: admission fails');
    expect(run.pooled).toBe(0);
  });
});
