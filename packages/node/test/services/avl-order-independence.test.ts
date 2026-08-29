import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MAX_BLOCK_BODY_BYTES } from '@dagsocial/types';
import type { OrderingBlock } from '@dagsocial/types';
import type Database from 'better-sqlite3';
import type { Config } from '../../src/config.js';
import {
  makeKarmaBox,
  makeTestConfig,
  mineNextBlock,
  seedEmissionBox,
  uid,
} from '../helpers.js';

// ---------------------------------------------------------------------------
// Spec B P2 acceptance (M-12) — the audit escalation scenario, made
// permanent: two nodes holding the same box set, but with the bootstrap feed
// presented in different orders, build/apply the same blocks and end at the
// identical AVL digest.
//
// Node A seeds the boxes in creation order and bootstraps with the store's
// feed. Node B — a fresh module universe via vi.resetModules() — seeds the
// identical boxes in reversed row order and activateProver hands the reversed
// list to bootstrapAvlProver. The store read has no tie order the test relies
// on; the bootstrap sort neutralises whichever order it gets.
//
// (The divergently-ordered set is plain karma boxes that nothing spends — the
// property under test does not depend on what the boxes are.)
//
// Fixture discipline, learned by measuring an unsorted prover: the box ids
// must be FIXED, not random. Whether two insertion orders of the same keys
// produce differently-shaped AVL trees depends on the key values; with
// per-run random identities some draws collide and the unsorted prover
// passes by luck. Deterministic ids (uid() owners, fixed values) make the
// pre-fix failure reproducible. The guards below fail loudly if the two
// nodes stop presenting genuinely divergent feed orders.
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

async function importBlockApply() {
  return (await import('../../src/services/block-apply.js')) as unknown as {
    applyOrderingBlock: (block: OrderingBlock) => boolean;
  };
}

async function importAvl() {
  return (await import('../../src/state/avl-prover.js')) as
    typeof import('../../src/state/avl-prover.js');
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown) => void;
    getBox: (boxId: string) => { id?: string } | null;
    getUnspentBoxes: () => import('@dagsocial/types').AnyBox[];
  };
}

/**
 * Activate the AVL prover singleton on the current universe's DB and
 * bootstrap the seeded boxes — the production startup wiring from
 * src/index.ts (same shape as the journal round-trip harness).
 *
 * `permute`, when given, is applied to the store's feed before
 * bootstrapAvlProver sees it — the test hands node B the reversed list so the
 * non-vacuity assertion holds regardless of the store's scan order.
 */
async function activateProver(
  permute?: (rows: import('@dagsocial/types').AnyBox[]) => import('@dagsocial/types').AnyBox[],
) {
  const avlMod = await importAvl();
  const utxo = await importUtxo();
  const handle = avlMod.createAvlProver();
  const raw = utxo.getUnspentBoxes();
  const unspent = permute ? permute(raw) : raw;
  expect(unspent.length).toBeGreaterThan(0);
  avlMod.bootstrapAvlProver(handle, unspent, 0, []);
  expect(avlMod.tryGetAvlProver()).not.toBeNull();
  return {
    handle,
    feedOrder: unspent.map((b) => b.id!),
    bootstrapDigest: new Uint8Array(handle.prover.digest()!),
  };
}

describe('AVL digest order-independence across nodes (P2 acceptance)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch {
      // Module might not have been imported
    }
    vi.resetModules();
  });

  it('different box row orders: same blocks, identical digest', async () => {
    // Shared fixture data — fixed values, valid across both module universes.
    // Deterministic owners pin every box id, hence the AVL shapes compared.
    const karmaBoxes = Array.from({ length: 6 }, (_, i) =>
      makeKarmaBox(5n, uid(`p2-order-owner-${i}`), 0),
    );

    // ---- Node A: boxes in creation order; builds the chain. ----
    const dbA = await importDb();
    dbA.initDb(':memory:');
    const utxoA = await importUtxo();
    // ⚠ **Before `activateProver`, so the box is in the bootstrap feed.** Block
    // 1 spends the emission box, and a remove against a key the tree never held
    // is not a state transition either node can perform. Genesis puts it in the
    // height-0 tree for exactly this reason; a seed after the bootstrap would
    // leave it in SQL and outside the digest.
    await seedEmissionBox();
    for (const kb of karmaBoxes) utxoA.insertBox(kb);

    const {
      handle: handleA,
      feedOrder: feedA,
      bootstrapDigest: bootA,
    } = await activateProver();
    const bcA = await importBlockCreator();
    bcA.startBlockCreator(testConfig);

    const b1 = await mineNextBlock(bcA);
    const b2 = await mineNextBlock(bcA);
    const b3 = await mineNextBlock(bcA);
    expect(b1).not.toBeNull();
    expect(b2).not.toBeNull();
    expect(b3).not.toBeNull();
    // The chain did real work: three coinbase mints moved the digest…
    const digestA = new Uint8Array(handleA.prover.digest()!);
    expect(Buffer.from(digestA).equals(Buffer.from(bootA))).toBe(false);
    // …and the seeded boxes survived it, so they are still in the tree whose
    // digest is compared below.
    for (const kb of karmaBoxes) expect(utxoA.getBox(kb.id!)).not.toBeNull();

    bcA.stopBlockCreator();

    // ---- Node B: identical boxes, reversed row order; applies A's blocks
    // (the gossip path). ----
    vi.resetModules();
    const dbB = await importDb();
    dbB.initDb(':memory:');
    const utxoB = await importUtxo();
    // Same box, same id — `ensureEmissionBox` is a total function of the
    // profile — which is what lets B apply A's blocks at all. Seeded before the
    // reversed inserts on purpose: if its position in the feed mattered, the
    // bootstrap-digest equality below would catch it.
    await seedEmissionBox();
    for (const kb of [...karmaBoxes].reverse()) utxoB.insertBox(kb);

    const {
      handle: handleB,
      feedOrder: feedB,
      bootstrapDigest: bootB,
    } = await activateProver(rows => [...rows].reverse());
    // Non-vacuity: the two nodes really did present the same box set to the
    // prover in different orders — the condition the sort has to neutralize.
    expect([...feedB].sort()).toEqual([...feedA].sort());
    expect(feedB).not.toEqual(feedA);

    // The bootstrap sort, isolated: same set, opposite feed order, one digest.
    expect(Buffer.from(bootA).equals(Buffer.from(bootB))).toBe(true);

    const applyB = await importBlockApply();
    expect(applyB.applyOrderingBlock(b1!)).toBe(true);
    expect(applyB.applyOrderingBlock(b2!)).toBe(true);
    expect(applyB.applyOrderingBlock(b3!)).toBe(true);
    for (const kb of karmaBoxes) expect(utxoB.getBox(kb.id!)).not.toBeNull();

    const digestB = new Uint8Array(handleB.prover.digest()!);

    // End to end: two nodes, same boxes, different row order, one chain —
    // the audit escalation scenario, and the same digest.
    expect(Buffer.from(digestA).equals(Buffer.from(digestB))).toBe(true);
  });
});
