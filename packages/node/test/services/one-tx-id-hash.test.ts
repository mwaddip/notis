import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { UtxoTransaction } from '@dagsocial/types';

/**
 * One hash a transaction, where its bytes are proven (CONSENSUS_INTERFACE →
 * Applying a block → "A transaction's id is hashed once, where its bytes are
 * proven"; NODE_INTERFACE → validateTx; MEMPOOL_INTERFACE → insertUtxoTx;
 * MEMPOOL_INTERFACE → The cost gate → "The candidate carries the id admission
 * computed").
 *
 * Each case enters through a real entry: a write route served with the real
 * service, store and prover (the cost gate on); the relay handler as net hands
 * it a transaction; `createOrderingBlock` over a pool.
 */

/**
 * The counter wraps `@dagsocial/types`' `computeTxId` and records each call's
 * answer. The counter's `answers` field holds every id the wrapper has
 * produced since the last reset. A read of `matchesOf(answers, id)` yields
 * how many of those answers equal `id` — the other answers are the
 * settlement's id and other transactions' ids.
 */
interface TxIdCounter {
  answers: string[];
}

function countTxIds(): TxIdCounter {
  const counter: TxIdCounter = { answers: [] };
  vi.doMock('@dagsocial/types', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@dagsocial/types')>();
    return {
      ...actual,
      computeTxId: (tx: UtxoTransaction) => {
        const id = actual.computeTxId(tx);
        counter.answers.push(id);
        return id;
      },
    };
  });
  return counter;
}

/** Every answer equal to `id`, counted. */
function matchesOf(answers: readonly string[], id: string): number {
  return answers.filter((answer) => answer === id).length;
}

/**
 * The write route admitting one transaction with the cost gate on hashes the
 * admitted transaction exactly twice: the route's entry, and `applyBlock`'s
 * declared-id check in the gate's candidate (MEMPOOL_INTERFACE → The cost
 * gate; CONSENSUS_INTERFACE → Applying a block).
 *
 * The relay handler admitting one transaction hashes it exactly twice the
 * same way (NODE_INTERFACE → Relay handlers; MEMPOOL_INTERFACE → The cost
 * gate).
 *
 * `createOrderingBlock` over a pool of one pooled transaction, building one
 * template with no trim, hashes the pooled transaction exactly 3 times: the
 * fill's own `computeTxId(tx)` for the pooled entry, the gate estimate's
 * `applyBlock` declared-id check, and the speculation's `applyBlock`
 * declared-id check (NODE_INTERFACE → validateTx; MEMPOOL_INTERFACE →
 * The cost gate; CONSENSUS_INTERFACE → Applying a block → "A transaction's
 * id is hashed once, where its bytes are proven").
 */
describe('one hash a transaction, where its bytes are proven', () => {
  let counter: TxIdCounter;

  beforeEach(() => {
    vi.resetModules();
    counter = countTxIds();
  });

  afterEach(() => {
    vi.doUnmock('@dagsocial/types');
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('control: the counter counts a call that goes through the wrapper', async () => {
    const types = await import('@dagsocial/types');
    const actual = await vi.importActual<typeof import('@dagsocial/types')>('@dagsocial/types');
    const { makeTestIdentity, makeCreditBox, makeCreditTx } = await import('../helpers.js');
    const sender = makeTestIdentity();
    const box = makeCreditBox(100_000n, sender.userId, 0, 1);
    const tx = makeCreditTx(sender, [box], 1_000n);
    const id = actual.computeTxId(tx);

    counter.answers.length = 0;
    const answered = types.computeTxId(tx);

    expect(answered).toBe(id);
    expect(matchesOf(counter.answers, id)).toBe(1);
    counter.answers.length = 0;
  });

  it.fails('a write route admitting one transaction with the cost gate on hashes the admitted transaction twice', async () => {
    const actual = await vi.importActual<typeof import('@dagsocial/types')>('@dagsocial/types');
    const { makeTestIdentity, makeCreditBox, makeCreditTx, liveProver } = await import('../helpers.js');
    const db = await import('../../src/store/db.js');
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await import('../../src/store/utxo.js');
    const sender = makeTestIdentity();
    const box = makeCreditBox(100_000n, sender.userId, 0, 1);
    utxo.insertBox(box);
    await liveProver();
    const tx = makeCreditTx(sender, [box], 1_000n);
    const admittedId = actual.computeTxId(tx);

    const credits = await import('../../src/services/credits.js');
    const { config } = await import('../../src/config.js');
    const { admissionOwed } = await import('../../src/services/karma-admission.js');
    const { getIdentityRecord } = await import('../../src/store/identity-records.js');
    const deps = {
      getBox: utxo.getBox,
      insertBox: utxo.insertBox,
      consumeBox: utxo.consumeBox,
      getKarmaOwed: admissionOwed({
        staleThresholdBlocks: config.karmaStaleThresholdBlocks,
        decayIntervalBlocks: config.karmaDecayIntervalBlocks,
        decayAmount: config.karmaDecayAmount,
        karmaMinimum: config.karmaMinimum,
      }),
      getKarmaValue: utxo.getKarmaValue,
      getOwnKarmaBoxIds: (owner: Uint8Array) =>
        utxo.getKarmaBoxes(owner).filter((b) => b.income !== true).map((b) => b.id!),
      getIdentityRecord,
      hasActiveVouchEscrow: () => false,
      vouchCooldownBlocks: config.vouchCooldownBlocks,
      inviteBondMin: config.inviteBondMin,
      inviteBondMax: config.inviteBondMax,
      decayCfg: {
        staleThresholdBlocks: config.karmaStaleThresholdBlocks,
        decayIntervalBlocks: config.karmaDecayIntervalBlocks,
        decayAmount: config.karmaDecayAmount,
        karmaMinimum: config.karmaMinimum,
      },
      storageRentPeriodBlocks: config.storageRentPeriodBlocks,
      getBoxProvenance: utxo.getBoxProvenance,
      getTopologyAuthor: () => null,
      getPendingPostAuthor: () => null,
      runInTransaction: (fn: () => void) => fn(),
      getVouchBox: () => null,
      getNetworkRecord: () => ({ memberCount: 1 }),
      membershipBarMultiplier: config.membershipBarMultiplier,
      putIdentityRecord: () => {},
      protocolVersionSchedule: config.protocolVersionSchedule,
      getUsername: () => null,
      getUsernameByOwner: () => null,
    };

    counter.answers.length = 0;
    const result = credits.sendCredits(deps, tx, 0);
    expect(result.txId).toBe(admittedId);
    expect(matchesOf(counter.answers, admittedId)).toBe(2);
  });

  it.fails('the relay handler admitting one transaction hashes the admitted transaction twice', async () => {
    const actual = await vi.importActual<typeof import('@dagsocial/types')>('@dagsocial/types');
    const { makeTestIdentity, makeCreditBox, makeCreditTx, liveProver } = await import('../helpers.js');
    const db = await import('../../src/store/db.js');
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await import('../../src/store/utxo.js');
    const sender = makeTestIdentity();
    const box = makeCreditBox(100_000n, sender.userId, 0, 1);
    utxo.insertBox(box);
    await liveProver();
    const tx = makeCreditTx(sender, [box], 1_000n);
    const admittedId = actual.computeTxId(tx);

    const { handleRelayedTx } = await import('../../src/services/handle-tx.js');

    counter.answers.length = 0;
    const admitted = handleRelayedTx(tx, undefined, 'peer-relay');
    expect(admitted).toBe(true);
    expect(matchesOf(counter.answers, admittedId)).toBe(2);
  });

  it.fails('createOrderingBlock over a pool of one pooled transaction hashes the pooled transaction 3 times', async () => {
    const actual = await vi.importActual<typeof import('@dagsocial/types')>('@dagsocial/types');
    const { makeTestIdentity, makeCreditBox, makeCreditTx, liveProver, makeTestConfig } = await import('../helpers.js');
    const db = await import('../../src/store/db.js');
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await import('../../src/store/utxo.js');
    const sender = makeTestIdentity();
    const box = makeCreditBox(100_000n, sender.userId, 0, 1);
    utxo.insertBox(box);
    await liveProver();
    const tx = makeCreditTx(sender, [box], 1_000n);
    const pooledId = actual.computeTxId(tx);

    const mempool = await import('../../src/store/mempool.js');
    mempool.insertUtxoTx(tx, 1000);

    const bc = await import('../../src/services/block-creator.js');
    const cfg = makeTestConfig();

    counter.answers.length = 0;
    bc.startBlockCreator(cfg);
    const template = bc.getCurrentTemplate();
    expect(template).not.toBeNull();
    expect(template!.utxoTxTree.utxoTxIds).toContain(pooledId);
    expect(matchesOf(counter.answers, pooledId)).toBe(3);
  });
});
