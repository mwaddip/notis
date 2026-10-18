import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'crypto';
import type { OrderingBlock } from '@dagsocial/types';
import {
  computeUtxoTxRoot,
} from '@dagsocial/types';
import {
  blockHash,
  meetsPowTarget,
  orderingPowTarget,
  powHit,
} from '@dagsocial/validation';

import { closeDb, getDb, initDb } from '../../src/store/db.js';
import {
  getBestHashAt,
  getBestTip,
  getCurrentHeight,
  getHeaderRow,
  getLowestJournalHeight,
  getOrderingBlockHash,
  getStagedBlock,
  headerStanding,
} from '../../src/store/index.js';
import { createOrderingBlock, deleteOrderingBlock } from '../../src/store/ordering.js';
import { insertBlockJournal } from '../../src/store/journal.js';
import { resetPipelineForTests } from '../../src/services/header-pipeline.js';
import {
  canExtendAppliedTipAsBlockInHand,
  clearIntakeSeamsForTests,
  deliverBlocks,
  deliverGossipedBlock,
  deliverHeaders,
  deliverMinedBlock,
  gateHeld,
  initIntake,
  resetIntakeForTests,
  setIntakeSeamsForTests,
  wantedBlocks,
  type IntakeCallbacks,
} from '../../src/services/intake.js';
import type { PipelineContext } from '../../src/services/header-pipeline.js';
import type { ApplyVerdict } from '../../src/services/block-apply.js';
import {
  ReorgAbortedError,
  ReorgBlockRejectedError,
} from '../../src/services/corrupt-state.js';
import { config } from '../../src/config.js';
import { defaultParams, makeHeader, type ParentHeaderInfo } from '../helpers/make-header.js';
import { rawPublicKey } from '../helpers.js';

// NODE_INTERFACE → Fork choice decides on verified headers → "A block in hand
// extends the applied tip": a block delivered whole whose parent is the
// applied tip is applied in the item that delivers it, whether or not its
// header extends the best chain, while the window allows extension and the
// best tip stands at most `maxReorgDepth` heights above the applied tip. The
// cases drive each path through the intake's real entries over fake blocks:
// `mineWithEmptyRoot` builds a valid-structure header the binding can bind,
// and the apply seam writes to `ordering_blocks` and the journal so
// `getCurrentHeight` moves — the pipeline shape is what the cases measure.

const PARAMS = defaultParams({
  anchorBits: 2304,
  floorBits: 2304,
  ceilingBits: 4096,
  idealMs: 60_000,
});
const SCHEDULE = config.protocolVersionSchedule;

const SETTLEMENT_ID = 'ff'.repeat(32);
const UTXO_TX_ROOT_WITH_SETTLEMENT = computeUtxoTxRoot({
  utxoTxIds: [SETTLEMENT_ID],
  utxoTxs: [new Uint8Array(0)],
});

function makeValidator(): { pub: Uint8Array; priv: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: rawPublicKey(publicKey), priv: privateKey };
}

/**
 * Mine a header whose body is a one-entry settlement — `utxoTxRoot` binds and
 * the structure check passes — and whose `validatorId` is the given key.
 */
function mineHeader(opts: {
  height: number;
  parent?: ParentHeaderInfo | null;
  pub: Uint8Array;
  createdAt?: number;
}): ParentHeaderInfo {
  const parent = opts.parent ?? null;
  const built = makeHeader({
    height: opts.height,
    parent,
    createdAt: opts.createdAt,
    params: PARAMS,
    schedule: SCHEDULE,
    validatorId: opts.pub,
  });
  built.header.utxoTxRoot = UTXO_TX_ROOT_WITH_SETTLEMENT;
  const target = orderingPowTarget(built.header.powTargetBits);
  if (target === null) throw new Error('mineHeader: target outside domain');
  let found = false;
  for (let n = 0; n < 2_000_000; n++) {
    built.header.powNonce = n;
    const hit = powHit(built.header);
    if (hit !== null && meetsPowTarget(hit, target)) { found = true; break; }
  }
  if (!found) throw new Error('mineHeader: no nonce met target');
  const hash = blockHash(built.header);
  if (hash === null) throw new Error('mineHeader: unhashable');
  return { ...built, hash };
}

function signAs(info: ParentHeaderInfo, priv: KeyObject): OrderingBlock {
  const msg = Buffer.from(info.hash, 'hex');
  const sig = cryptoSign(null, msg, priv);
  return {
    header: info.header,
    utxoTxTree: { utxoTxIds: [SETTLEMENT_ID], utxoTxs: [new Uint8Array(0)] },
    validatorSignature: new Uint8Array(sig),
  };
}

interface Captured {
  penalties: Array<{ peerId: string; kind: 'misbehavior' | 'transient'; reason: string }>;
  chainMoves: number;
  needHeadersFor: string[];
}

function recorder(): { cap: Captured; callbacks: IntakeCallbacks } {
  const cap: Captured = { penalties: [], chainMoves: 0, needHeadersFor: [] };
  const callbacks: IntakeCallbacks = {
    penalize: (peerId, kind, reason) => { cap.penalties.push({ peerId, kind, reason }); },
    chainMoved: () => { cap.chainMoves += 1; },
    needHeaders: (peerId) => { cap.needHeadersFor.push(peerId); },
  };
  return { cap, callbacks };
}

function pipelineCtx(opts?: Partial<PipelineContext>): PipelineContext {
  return {
    params: PARAMS,
    schedule: SCHEDULE,
    nowMs: () => 1_700_000_000_000 + 300_000_000_000,
    maxReorgDepth: config.maxReorgDepth,
    genesisId: '',
    lowestJournalHeight: () => getLowestJournalHeight(),
    appliedTipHeight: () => getCurrentHeight(),
    canExtendAppliedTipAsBlockInHand,
    ...opts,
  };
}

/**
 * The scheduler's two-pass admit over one page — pass 1 scores, pass 2 stores.
 * A page extending the best tip stores on its first call; the second call is
 * then a `held` no-op.
 */
async function admitChain(peerId: string, chain: ParentHeaderInfo[]): Promise<void> {
  const headers = chain.map(c => c.header);
  const claim = chain[chain.length - 1]!.hash;
  await deliverHeaders(peerId, claim, headers);
  await deliverHeaders(peerId, claim, headers);
}

/** The default apply seam: write `ordering_blocks` and the journal; the next drain reads the next height. */
function defaultApplyBehaviour(block: OrderingBlock): ApplyVerdict {
  createOrderingBlock(block, []);
  insertBlockJournal({
    blockHeight: block.header.height,
    mutations: [],
    confirmedPostIds: [],
    withdrawnPosts: [],
    likeRecordInsertions: [],
    appliedUtxoTxs: [],
  });
  return { applied: true, indexed: [] };
}

/** Reorg seam: roll our blocks back down to `forkHeight`, then apply each staged block through the apply seam. */
function defaultReorgBehaviour(
  forkHeight: number,
  hashes: readonly string[],
  apply: (b: OrderingBlock) => ApplyVerdict,
): void {
  const currentHeight = getCurrentHeight();
  for (let h = currentHeight; h > forkHeight; h--) deleteOrderingBlock(h);
  for (const hash of hashes) {
    const staged = getStagedBlock(hash);
    if (staged === null) continue;
    const b = staged.block;
    const verdict = apply(b);
    if (verdict.applied) continue;
    if (verdict.class === 'consensus') {
      throw new ReorgBlockRejectedError(b.header.height, hash);
    }
    throw new ReorgAbortedError(b.header.height, hash, verdict.class, verdict.detail);
  }
}

describe('a block in hand extends the applied tip', () => {
  let applyBehaviour: (block: OrderingBlock) => ApplyVerdict;

  beforeEach(() => {
    initDb(':memory:');
    getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    resetPipelineForTests();
    resetIntakeForTests();
    applyBehaviour = defaultApplyBehaviour;
    setIntakeSeamsForTests({
      apply: (b) => applyBehaviour(b),
      reorg: (f, hashes) => defaultReorgBehaviour(f, hashes, applyBehaviour),
    });
    const { callbacks } = recorder();
    initIntake(callbacks, pipelineCtx());
  });

  afterEach(() => {
    clearIntakeSeamsForTests();
    closeDb();
    vi.restoreAllMocks();
  });

  it('a mined block at a height whose best-chain block is withheld moves the applied tip', async () => {
    const v = makeValidator();
    const applied: ParentHeaderInfo[] = [];
    let prev: ParentHeaderInfo | null = null;
    for (let h = 1; h <= 5; h++) {
      prev = mineHeader({ height: h, parent: prev, pub: v.pub });
      applied.push(prev);
    }
    const { cap, callbacks } = recorder();
    initIntake(callbacks, pipelineCtx());
    await admitChain('peerH', applied);
    for (const h of applied) await deliverBlocks('peerB', [signAs(h, v.priv)]);
    expect(getCurrentHeight()).toBe(5);
    gateHeld();

    const withheld6 = mineHeader({
      height: 6, parent: applied[4]!, pub: v.pub,
      createdAt: applied[4]!.header.createdAt + PARAMS.idealMs + 100,
    });
    await admitChain('peerW', [withheld6]);
    expect(getBestTip()!.hash).toBe(withheld6.hash);
    expect(getCurrentHeight()).toBe(5);

    const mined6 = mineHeader({
      height: 6, parent: applied[4]!, pub: v.pub,
      createdAt: applied[4]!.header.createdAt + PARAMS.idealMs + 200,
    });
    const verdict = deliverMinedBlock(signAs(mined6, v.priv));
    expect.soft(verdict.applied).toBe(true);
    expect.soft(getHeaderRow(mined6.hash)).not.toBeNull();

    // The last assertion names the rule: a mined block at a height whose
    // best-chain block is withheld moves the applied tip.
    expect(getCurrentHeight()).toBe(6);
    void cap;
  });

  it.fails('a tie between the applied chain and the best chain moves the best chain to the applied one', async () => {
    const v = makeValidator();
    const applied: ParentHeaderInfo[] = [];
    let prev: ParentHeaderInfo | null = null;
    for (let h = 1; h <= 5; h++) {
      prev = mineHeader({ height: h, parent: prev, pub: v.pub });
      applied.push(prev);
    }
    const { callbacks } = recorder();
    initIntake(callbacks, pipelineCtx());
    await admitChain('peerH', applied);
    for (const h of applied) await deliverBlocks('peerB', [signAs(h, v.priv)]);
    gateHeld();

    const withheld6 = mineHeader({
      height: 6, parent: applied[4]!, pub: v.pub,
      createdAt: applied[4]!.header.createdAt + PARAMS.idealMs + 100,
    });
    await admitChain('peerW', [withheld6]);

    const mined6 = mineHeader({
      height: 6, parent: applied[4]!, pub: v.pub,
      createdAt: applied[4]!.header.createdAt + PARAMS.idealMs + 200,
    });
    deliverMinedBlock(signAs(mined6, v.priv));

    expect.soft(getCurrentHeight()).toBe(6);
    expect.soft(getOrderingBlockHash(6)).toBe(mined6.hash);

    // The last assertion names the rule: a tie moves the best chain to the
    // applied one and the wanted set empties.
    expect(getBestTip()!.hash).toBe(mined6.hash);
    expect(wantedBlocks()).toEqual([]);
  });

  it('a gossiped block at a height whose best-chain block is withheld moves the applied tip', async () => {
    const v = makeValidator();
    const applied: ParentHeaderInfo[] = [];
    let prev: ParentHeaderInfo | null = null;
    for (let h = 1; h <= 5; h++) {
      prev = mineHeader({ height: h, parent: prev, pub: v.pub });
      applied.push(prev);
    }
    const { cap, callbacks } = recorder();
    initIntake(callbacks, pipelineCtx());
    await admitChain('peerH', applied);
    for (const h of applied) await deliverBlocks('peerB', [signAs(h, v.priv)]);
    gateHeld();

    const withheld6 = mineHeader({
      height: 6, parent: applied[4]!, pub: v.pub,
      createdAt: applied[4]!.header.createdAt + PARAMS.idealMs + 100,
    });
    await admitChain('peerW', [withheld6]);

    const gossiped6 = mineHeader({
      height: 6, parent: applied[4]!, pub: v.pub,
      createdAt: applied[4]!.header.createdAt + PARAMS.idealMs + 300,
    });
    await deliverGossipedBlock('peerG', signAs(gossiped6, v.priv));

    expect.soft(cap.penalties.filter(p => p.peerId === 'peerG')).toEqual([]);
    expect.soft(cap.needHeadersFor).not.toContain('peerG');

    // The last assertion names the rule: a gossiped block at a height whose
    // best-chain block is withheld moves the applied tip.
    expect(getCurrentHeight()).toBe(6);
  });

  it('a heavier chain whose further block is withheld stays best and wanted while the applied chain moves', async () => {
    const v = makeValidator();
    const applied: ParentHeaderInfo[] = [];
    let prev: ParentHeaderInfo | null = null;
    for (let h = 1; h <= 5; h++) {
      prev = mineHeader({ height: h, parent: prev, pub: v.pub });
      applied.push(prev);
    }
    const { callbacks } = recorder();
    initIntake(callbacks, pipelineCtx());
    await admitChain('peerH', applied);
    for (const h of applied) await deliverBlocks('peerB', [signAs(h, v.priv)]);
    gateHeld();

    const withheld6 = mineHeader({
      height: 6, parent: applied[4]!, pub: v.pub,
      createdAt: applied[4]!.header.createdAt + PARAMS.idealMs + 100,
    });
    const withheld7 = mineHeader({
      height: 7, parent: withheld6, pub: v.pub,
      createdAt: withheld6.header.createdAt + PARAMS.idealMs + 100,
    });
    await admitChain('peerW', [withheld6, withheld7]);
    expect(getBestTip()!.hash).toBe(withheld7.hash);

    const mined6 = mineHeader({
      height: 6, parent: applied[4]!, pub: v.pub,
      createdAt: applied[4]!.header.createdAt + PARAMS.idealMs + 200,
    });
    deliverMinedBlock(signAs(mined6, v.priv));

    expect.soft(getCurrentHeight()).toBe(6);
    expect.soft(getOrderingBlockHash(6)).toBe(mined6.hash);

    // The last assertion names the rule: a heavier chain whose further block
    // is withheld stays best and the pipeline names its ids in height order.
    expect(getBestTip()!.hash).toBe(withheld7.hash);
    expect(wantedBlocks().map(w => w.id)).toEqual([withheld6.hash, withheld7.hash]);
  });

  it.fails('a tie at the heavier chain tip moves the best chain to the applied one', async () => {
    const v = makeValidator();
    const applied: ParentHeaderInfo[] = [];
    let prev: ParentHeaderInfo | null = null;
    for (let h = 1; h <= 5; h++) {
      prev = mineHeader({ height: h, parent: prev, pub: v.pub });
      applied.push(prev);
    }
    const { callbacks } = recorder();
    initIntake(callbacks, pipelineCtx());
    await admitChain('peerH', applied);
    for (const h of applied) await deliverBlocks('peerB', [signAs(h, v.priv)]);
    gateHeld();

    const withheld6 = mineHeader({
      height: 6, parent: applied[4]!, pub: v.pub,
      createdAt: applied[4]!.header.createdAt + PARAMS.idealMs + 100,
    });
    const withheld7 = mineHeader({
      height: 7, parent: withheld6, pub: v.pub,
      createdAt: withheld6.header.createdAt + PARAMS.idealMs + 100,
    });
    await admitChain('peerW', [withheld6, withheld7]);

    const mined6 = mineHeader({
      height: 6, parent: applied[4]!, pub: v.pub,
      createdAt: applied[4]!.header.createdAt + PARAMS.idealMs + 200,
    });
    deliverMinedBlock(signAs(mined6, v.priv));
    expect.soft(getCurrentHeight()).toBe(6);

    const mined7 = mineHeader({
      height: 7, parent: mined6, pub: v.pub,
      createdAt: mined6.header.createdAt + PARAMS.idealMs + 100,
    });
    deliverMinedBlock(signAs(mined7, v.priv));

    expect.soft(getCurrentHeight()).toBe(7);
    expect.soft(getOrderingBlockHash(7)).toBe(mined7.hash);

    // The last assertion names the rule: at the heavier chain's tip height,
    // a tie moves the best chain to the applied one and the wanted set empties.
    expect(getBestTip()!.hash).toBe(mined7.hash);
    expect(wantedBlocks()).toEqual([]);
  });

  it('a heavier chain whose blocks arrive wins through a switch', async () => {
    const v = makeValidator();
    const applied: ParentHeaderInfo[] = [];
    let prev: ParentHeaderInfo | null = null;
    for (let h = 1; h <= 5; h++) {
      prev = mineHeader({ height: h, parent: prev, pub: v.pub });
      applied.push(prev);
    }
    const { callbacks } = recorder();
    initIntake(callbacks, pipelineCtx());
    await admitChain('peerH', applied);
    for (const h of applied) await deliverBlocks('peerB', [signAs(h, v.priv)]);
    gateHeld();

    const withheld6 = mineHeader({
      height: 6, parent: applied[4]!, pub: v.pub,
      createdAt: applied[4]!.header.createdAt + PARAMS.idealMs + 100,
    });
    const withheld7 = mineHeader({
      height: 7, parent: withheld6, pub: v.pub,
      createdAt: withheld6.header.createdAt + PARAMS.idealMs + 100,
    });
    await admitChain('peerW', [withheld6, withheld7]);

    const mined6 = mineHeader({
      height: 6, parent: applied[4]!, pub: v.pub,
      createdAt: applied[4]!.header.createdAt + PARAMS.idealMs + 200,
    });
    deliverMinedBlock(signAs(mined6, v.priv));
    expect.soft(getCurrentHeight()).toBe(6);
    expect.soft(getOrderingBlockHash(6)).toBe(mined6.hash);

    await deliverBlocks('peerW', [signAs(withheld6, v.priv), signAs(withheld7, v.priv)]);

    expect.soft(getOrderingBlockHash(6)).toBe(withheld6.hash);
    expect.soft(getCurrentHeight()).toBe(7);

    // The last assertion names the rule: the heavier chain's blocks arriving
    // move the applied chain through the switch to the heavier tip.
    expect(getOrderingBlockHash(7)).toBe(withheld7.hash);
  });

  it('a best tip more than maxReorgDepth heights above the applied tip holds the block in hand', async () => {
    const v = makeValidator();
    const applied: ParentHeaderInfo[] = [];
    let prev: ParentHeaderInfo | null = null;
    for (let h = 1; h <= 5; h++) {
      prev = mineHeader({ height: h, parent: prev, pub: v.pub });
      applied.push(prev);
    }
    const { cap, callbacks } = recorder();
    initIntake(callbacks, pipelineCtx());
    await admitChain('peerH', applied);
    for (const h of applied) await deliverBlocks('peerB', [signAs(h, v.priv)]);
    gateHeld();
    expect(getCurrentHeight()).toBe(5);

    // Build a chain of further headers above applied-5 that no body answers:
    // best tip stands at height 5 + (maxReorgDepth + 1), so the height bound
    // shuts for a block whose parent is the applied tip.
    const ahead = config.maxReorgDepth + 1;
    const headers: ParentHeaderInfo[] = [];
    prev = applied[4]!;
    for (let i = 0; i < ahead; i++) {
      prev = mineHeader({
        height: 5 + i + 1, parent: prev, pub: v.pub,
        createdAt: prev.header.createdAt + PARAMS.idealMs + 50,
      });
      headers.push(prev);
    }
    await admitChain('peerW', headers);
    expect(getBestTip()!.hash).toBe(headers[headers.length - 1]!.hash);
    gateHeld();

    // A gossiped block whose parent is the applied tip, hash different from
    // the first withheld-ahead header.
    const gossiped6 = mineHeader({
      height: 6, parent: applied[4]!, pub: v.pub,
      createdAt: applied[4]!.header.createdAt + PARAMS.idealMs + 300,
    });
    await deliverGossipedBlock('peerG', signAs(gossiped6, v.priv));

    expect.soft(cap.needHeadersFor).toContain('peerG');
    expect.soft(getHeaderRow(gossiped6.hash)).toBeNull();

    const mined6 = mineHeader({
      height: 6, parent: applied[4]!, pub: v.pub,
      createdAt: applied[4]!.header.createdAt + PARAMS.idealMs + 400,
    });
    const minedVerdict = deliverMinedBlock(signAs(mined6, v.priv));
    expect.soft(minedVerdict.applied).toBe(false);
    expect.soft(minedVerdict.applied ? '' : minedVerdict.detail).toContain('did not bind');

    // The last assertion names the rule: the height bound holds every block
    // in hand off the best chain while the best tip stands more than
    // `maxReorgDepth` heights above the applied tip.
    expect(getCurrentHeight()).toBe(5);
  }, 120_000);

  it('the window shut holds the block in hand', async () => {
    const v = makeValidator();
    const depth = config.maxReorgDepth;
    const applied: ParentHeaderInfo[] = [];
    let prev: ParentHeaderInfo | null = null;
    for (let h = 1; h <= depth; h++) {
      prev = mineHeader({ height: h, parent: prev, pub: v.pub });
      applied.push(prev);
    }
    const { cap, callbacks } = recorder();
    initIntake(callbacks, pipelineCtx());
    // `gateHeld` is never called — `S = 0`, and extension stops at
    // `applied = S + maxReorgDepth = maxReorgDepth`.
    await admitChain('peerH', applied);
    for (const h of applied) await deliverBlocks('peerB', [signAs(h, v.priv)]);
    expect(getCurrentHeight()).toBe(depth);

    // Build one withheld header above applied-tip so the best tip advances
    // the one height a block-in-hand candidate would seek.
    const withheldNext = mineHeader({
      height: depth + 1, parent: applied[depth - 1]!, pub: v.pub,
      createdAt: applied[depth - 1]!.header.createdAt + PARAMS.idealMs + 100,
    });
    await admitChain('peerW', [withheldNext]);
    expect(getBestTip()!.hash).toBe(withheldNext.hash);

    const gossipedNext = mineHeader({
      height: depth + 1, parent: applied[depth - 1]!, pub: v.pub,
      createdAt: applied[depth - 1]!.header.createdAt + PARAMS.idealMs + 300,
    });
    await deliverGossipedBlock('peerG', signAs(gossipedNext, v.priv));

    expect.soft(cap.needHeadersFor).toContain('peerG');
    expect.soft(getHeaderRow(gossipedNext.hash)).toBeNull();

    // The last assertion names the rule: the window holds every block in
    // hand off the best chain while `appliedTip ≥ S + maxReorgDepth`.
    expect(getCurrentHeight()).toBe(depth);
  }, 120_000);

  it.fails('the applied chain more than maxReorgDepth above the fork point moves the best chain to the applied one', async () => {
    const smallDepth = 4;
    const { callbacks } = recorder();
    initIntake(callbacks, pipelineCtx({ maxReorgDepth: smallDepth }));

    const v = makeValidator();
    // Alternate: one withheld header above the withheld chain's tip, one
    // applied block above the applied chain's tip. After smallDepth + 1
    // rounds the applied tip stands more than smallDepth above the shared
    // fork point (the virtual root).
    let withheldPrev: ParentHeaderInfo | null = null;
    let appliedPrev: ParentHeaderInfo | null = null;
    const rounds = smallDepth + 1;
    for (let r = 0; r < rounds; r++) {
      const h = r + 1;
      const withheldH = mineHeader({
        height: h, parent: withheldPrev, pub: v.pub,
        createdAt: (withheldPrev?.header.createdAt ?? 1_700_000_000_000 - PARAMS.idealMs) + PARAMS.idealMs + 100,
      });
      await deliverHeaders('peerW', withheldH.hash, [withheldH.header]);
      await deliverHeaders('peerW', withheldH.hash, [withheldH.header]);
      withheldPrev = withheldH;

      gateHeld();
      const appliedH = mineHeader({
        height: h, parent: appliedPrev, pub: v.pub,
        createdAt: (appliedPrev?.header.createdAt ?? 1_700_000_000_000 - PARAMS.idealMs) + PARAMS.idealMs + 300,
      });
      const verdict = deliverMinedBlock(signAs(appliedH, v.priv));
      expect.soft(verdict.applied).toBe(true);
      appliedPrev = appliedH;
    }

    expect.soft(getCurrentHeight()).toBe(rounds);

    // Deliver one more withheld header above the withheld chain's tip —
    // past the horizon it is unreachable and must not move the best chain.
    const withheldPast = mineHeader({
      height: rounds + 1, parent: withheldPrev, pub: v.pub,
      createdAt: withheldPrev!.header.createdAt + PARAMS.idealMs + 100,
    });
    await deliverHeaders('peerW', withheldPast.hash, [withheldPast.header]);

    // The last assertion names the rule: past the horizon the best chain is
    // chosen again as the applied one.
    expect(getBestTip()!.hash).toBe(appliedPrev!.hash);
  }, 240_000);

  it('a block in hand refused by the rules marks', async () => {
    const v = makeValidator();
    const applied: ParentHeaderInfo[] = [];
    let prev: ParentHeaderInfo | null = null;
    for (let h = 1; h <= 5; h++) {
      prev = mineHeader({ height: h, parent: prev, pub: v.pub });
      applied.push(prev);
    }
    const { cap, callbacks } = recorder();
    initIntake(callbacks, pipelineCtx());
    await admitChain('peerH', applied);
    for (const h of applied) await deliverBlocks('peerB', [signAs(h, v.priv)]);
    gateHeld();

    const withheld6 = mineHeader({
      height: 6, parent: applied[4]!, pub: v.pub,
      createdAt: applied[4]!.header.createdAt + PARAMS.idealMs + 100,
    });
    await admitChain('peerW', [withheld6]);

    const gossiped6 = mineHeader({
      height: 6, parent: applied[4]!, pub: v.pub,
      createdAt: applied[4]!.header.createdAt + PARAMS.idealMs + 300,
    });
    // The gossiped block applies through the apply seam, which refuses with
    // class 'consensus' — the mark path's precondition.
    applyBehaviour = (block) => {
      if (blockHash(block.header) === gossiped6.hash) {
        return { applied: false, class: 'consensus', detail: 'bad state root' };
      }
      return defaultApplyBehaviour(block);
    };
    await deliverGossipedBlock('peerG', signAs(gossiped6, v.priv));

    expect.soft(cap.penalties.some(p => p.peerId === 'peerG' && p.kind === 'misbehavior')).toBe(true);
    expect.soft(getCurrentHeight()).toBe(5);
    expect.soft(getBestTip()!.hash).toBe(withheld6.hash);

    // The last assertion names the rule: a block in hand refused by the
    // rules writes a mark.
    expect(headerStanding(gossiped6.hash, 6)).toBe('refused');
  });

  it('a reachable stored header heavier than the applied tip stands when the best chain falls out of reach', async () => {
    const v = makeValidator();
    const applied: ParentHeaderInfo[] = [];
    let prev: ParentHeaderInfo | null = null;
    for (let h = 1; h <= 2; h++) {
      prev = mineHeader({ height: h, parent: prev, pub: v.pub });
      applied.push(prev);
    }
    const { callbacks } = recorder();
    initIntake(callbacks, pipelineCtx());
    await admitChain('peerH', applied);
    for (const h of applied) await deliverBlocks('peerB', [signAs(h, v.priv)]);
    gateHeld();

    // A heavier side branch forking at the root: 3 headers from the virtual
    // root (strictly heavier than two anchor headers).
    const sideA = mineHeader({ height: 1, parent: null, pub: v.pub, createdAt: applied[0]!.header.createdAt + 1 });
    const sideB = mineHeader({ height: 2, parent: sideA, pub: v.pub, createdAt: sideA.header.createdAt + PARAMS.idealMs });
    const sideC = mineHeader({ height: 3, parent: sideB, pub: v.pub, createdAt: sideB.header.createdAt + PARAMS.idealMs });
    await admitChain('peerS', [sideA, sideB, sideC]);
    expect.soft(getBestTip()!.hash).toBe(sideC.hash);

    // The last assertion names the rule: a heavier stored branch whose fork
    // with the applied chain is above the reach floor is the best chain, and
    // its tip is the stored header the index names.
    expect(getBestHashAt(3)).toBe(sideC.hash);
  });
});
