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
import { createHash } from 'crypto';
import { computeBoxId, PROTOCOL_VERSION } from '@dagsocial/types';
import type { CreditBox, UtxoTransaction } from '@dagsocial/types';

const originalFloor = process.env['MIN_FEE_RATE_PER_BYTE'];

function creditBox(label: string, value: bigint): CreditBox {
  const owner = createHash('blake2b512').update(`${label}_o`).digest().subarray(0, 32);
  const box = {
    boxType: 'credit' as const,
    value,
    owner: new Uint8Array(owner),
    guard: 'owner_signature' as const,
    txId: createHash('blake2b512').update(`${label}_t`).digest().subarray(0, 32).toString('hex'),
    index: 0,
  };
  return { ...box, id: computeBoxId(box as never) } as CreditBox;
}

function spend(box: CreditBox, fee: bigint): UtxoTransaction {
  return {
    inputs: [box.id!],
    outputs: [{
      boxType: 'credit', value: box.value - fee, owner: box.owner, guard: 'owner_signature',
    } as CreditBox],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  } as UtxoTransaction;
}

/** A karma-side entry: no outputs, so nothing it could bid. */
function karmaSide(label: string): UtxoTransaction {
  const id = createHash('blake2b512').update(label).digest().subarray(0, 32).toString('hex');
  return { inputs: [id], outputs: [], signatures: {}, protocolVersion: PROTOCOL_VERSION } as UtxoTransaction;
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
