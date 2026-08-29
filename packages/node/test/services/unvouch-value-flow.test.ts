// ---------------------------------------------------------------------------
// P2-B phase 4 — the multi-VouchBox unvouch's money consequence, measured
// through real block application (K2; the engine leg lives in
// input-shape-pins.test.ts).
//
// Block application detects an unvouch by walking the inputs for a VouchBox,
// writes ONE escrow row, and breaks. Nothing bounded the vouch input count:
// the transition arm asked only for zero outputs, and conservation exempts
// zero-output vouch spends wholesale. This test was first written in its
// ACCEPTANCE form and run against untouched HEAD, where it passed with the
// loss measured in karma: two live vouch boxes (2 karma locked), one
// transaction, both boxes consumed, ONE escrow row (karmaAmount 1), and at
// maturity the voucher held 1 karma — supply down by one stake, the escrow
// round-trip broken.
//
// Reachable: castVouch's one-vouch-at-a-time is service-layer only, so a
// block-embedded pair of casts gives one voucher two live VouchBoxes; two
// colluding owners reach it directly. As in the phase 2 suite, the
// transaction is placed straight into the mempool, around the service layer
// that would refuse it — the block creator embeds whatever it picks up, which
// reproduces the malicious-producer case exactly.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  VOUCH_KARMA_AMOUNT,
  MAX_BLOCK_BODY_BYTES,
} from '@dagsocial/types';
import type {
  KarmaBox,
  VouchBox,
  UtxoTransaction,
  OrderingBlock,
} from '@dagsocial/types';
import {
  hex,
  makeTestConfig,
  makeTestIdentity,
  mineNextBlock,
  seedProvenance,
  signTransaction,
  type Stored,
} from '../helpers.js';
import type { TestIdentity } from '../helpers.js';
import type { Config } from '../../src/config.js';

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

async function importDb() {
  return (await import('../../src/store/db.js')) as {
    initDb: (path: string) => void;
    closeDb: () => void;
  };
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

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown) => void;
    getBox: (boxId: string) => unknown;
    getKarmaBoxes: (owner: Uint8Array) => KarmaBox[];
  };
}

async function importMempool() {
  return (await import('../../src/store/mempool.js')) as {
    insertUtxoTx: (tx: UtxoTransaction, expiresAtHeight: number) => number;
  };
}

/**
 * The escrow store, which is now the box store.
 *
 * ⛔ **`vouch_cooldowns` is deleted, table and all.** An unvouched stake waits in
 * a `VouchEscrowBox` in the UTXO set — and therefore in the `stateRoot` — rather
 * than in node-local SQL a synced node could not interpret (ARCHITECTURE →
 * Vouch boxes). ⚠ **The escrow carries no target**, so what a voucher's escrows
 * report is the value and the release height, never the pair the row held.
 */
async function importVouchEscrows() {
  return (await import('../../src/store/utxo.js')) as unknown as {
    getVouchEscrowsFor: (
      voucherId: Uint8Array,
    ) => Array<{ value: bigint; owner: Uint8Array; releaseAtBlock: number }>;
  };
}

async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as {
    getCurrentHeight: () => number;
    getOrderingBlock: (height: number) => OrderingBlock | null;
  };
}

/** Seed a VouchBox with fixture provenance. */
function makeVouchBox(
  value: bigint,
  voucherId: Uint8Array,
  targetId: Uint8Array,
): Stored<VouchBox> {
  return seedProvenance<VouchBox>({
    boxType: 'vouch' as const,
    value,
    createdAtBlock: 0,
    voucherId,
    targetId,
  }, 1);
}

/** A signed unvouch: the given VouchBoxes spent to zero outputs. */
function makeUnvouchTx(
  vouchBoxIds: string[],
  signer: TestIdentity,
  value: bigint,
  releaseAtBlock = 1000,
): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: vouchBoxIds,
    // ⛔ The escrow output carries the CONSUMED BOX'S value, never
    // `VOUCH_KARMA_AMOUNT` (TYPES_INTERFACE → VouchEscrowBox).
    outputs: [{
      boxType: 'vouch_escrow' as const,
      value,
      createdAtBlock: 0,
      owner: signer.userId,
      releaseAtBlock,
    } as never],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, signer.privateKey, hex(signer.userId));
  return tx;
}

const sumKarma = (boxes: KarmaBox[]): bigint =>
  boxes.reduce((sum, b) => sum + b.value, 0n);

describe('P2-B phase 4 — multi-VouchBox unvouch money flow', () => {
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

  it('K2 consequence: a block embedding a two-VouchBox unvouch is rejected whole', async () => {
    // On HEAD this block applied: both boxes consumed, one escrow row, and at
    // maturity 1 of the 2 locked karma re-minted — the other stake destroyed.
    // Now the embedded tx fails re-validation inside block application
    // ("Unvouch must consume exactly one VouchBox"), which rejects the block.
    const db = await importDb();
    db.initDb(':memory:');

    const utxo = await importUtxo();
    const mempool = await importMempool();
    const escrows = await importVouchEscrows();

    const voucher = makeTestIdentity();
    const target1 = makeTestIdentity();
    const target2 = makeTestIdentity();

    // Two live vouch boxes, one stake each — 2 karma locked in total.
    const v1 = makeVouchBox(VOUCH_KARMA_AMOUNT, voucher.userId, target1.userId);
    const v2 = makeVouchBox(VOUCH_KARMA_AMOUNT, voucher.userId, target2.userId);
    utxo.insertBox(v1);
    utxo.insertBox(v2);
    expect(sumKarma(utxo.getKarmaBoxes(voucher.userId))).toBe(0n);

    // ⛔ **One transaction spending BOTH VouchBoxes, escrowing ONE stake.** That
    // is the shape the single-input bound exists to refuse: without it the
    // second stake is consumed and nothing holds it. It no longer conserves
    // either, so the bound and conservation both fire — the bound is what names
    // WHY (NODE_INTERFACE → Vouch transition rules).
    mempool.insertUtxoTx(
      makeUnvouchTx([v1.id!, v2.id!], voucher, VOUCH_KARMA_AMOUNT),
      100000,
    );

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    await mineNextBlock(bc);

    // Nothing the block would have done survives: no block, both stakes
    // still live in their boxes, and no escrow row — the destruction is
    // unreachable rather than merely unexercised.
    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(0);
    expect(utxo.getBox(v1.id!)).not.toBeNull();
    expect(utxo.getBox(v2.id!)).not.toBeNull();
    expect(escrows.getVouchEscrowsFor(voucher.userId)).toHaveLength(0);
  });
});
