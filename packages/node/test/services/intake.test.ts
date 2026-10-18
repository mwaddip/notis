import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'crypto';
import { closeDb, getDb, initDb } from '../../src/store/db.js';
import {
  resetPipelineForTests,
} from '../../src/services/header-pipeline.js';
import {
  BLOCK_FETCH_WINDOW,
  clearIntakeSeamsForTests,
  deliverBlocks,
  deliverGossipedBlock,
  deliverHeaders,
  deliverMinedBlock,
  gateHeld,
  getPendingBlockForTests,
  getSForTests,
  initIntake,
  onPeerDisconnected,
  resetIntakeForTests,
  setIntakeSeamsForTests,
  wantedBlocks,
  type IntakeCallbacks,
} from '../../src/services/intake.js';
import type { PipelineContext } from '../../src/services/header-pipeline.js';
import type { ApplyVerdict } from '../../src/services/block-apply.js';
import { InconsistentHeaderTreeError, ReorgAbortedError, ReorgBlockRejectedError } from '../../src/services/corrupt-state.js';
import {
  anyRefusedHeader,
  getBestHashAt,
  getBestTip,
  getOrderingBlockHash,
  getStagedBlock,
  getHeaderRow,
  getCurrentHeight,
  headerStanding,
} from '../../src/store/index.js';
import { createOrderingBlock, deleteOrderingBlock } from '../../src/store/ordering.js';
import { insertBlockJournal } from '../../src/store/journal.js';
import { config } from '../../src/config.js';
import {
  computeUtxoTxRoot,
  GENESIS_PREV_BLOCK_HASH,
  type OrderingBlock,
} from '@dagsocial/types';
import { blockHash, meetsPowTarget, orderingPowTarget, powHit } from '@dagsocial/validation';
import { defaultParams, makeHeader, type ParentHeaderInfo } from '../helpers/make-header.js';
import { rawPublicKey } from '../helpers.js';

const PARAMS = defaultParams({
  anchorBits: 2304,
  floorBits: 2304,
  ceilingBits: 4096,
  idealMs: 60_000,
});
const SCHEDULE = config.protocolVersionSchedule;
// The settlement transaction is the LAST entry in `utxoTxIds`
// (VALIDATION_INTERFACE → verifyOrderingBlockStructure). Every block carries
// one, so the suite's blocks reserve a single stable id for it.
const SETTLEMENT_ID = 'ff'.repeat(32);
const UTXO_TX_ROOT_WITH_SETTLEMENT = computeUtxoTxRoot({
  utxoTxIds: [SETTLEMENT_ID],
  utxoTxs: [new Uint8Array(0)],
});
const UTXO_TX_ROOT_EMPTY = computeUtxoTxRoot({ utxoTxIds: [], utxoTxs: [] });

/**
 * One Ed25519 validator for the suite — the chain's mined headers carry its
 * pubkey, and the signed blocks a signature that binds under
 * `verifyValidatorSignature`. The keys come from Node's own `crypto`, the
 * same path the other suites use (`test/helpers.ts`).
 */
function makeValidator(): { pub: Uint8Array; priv: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: rawPublicKey(publicKey), priv: privateKey };
}

/**
 * Mine a header whose `validatorId = pub` and `utxoTxRoot` is as the opts
 * ask — a body with one entry (the settlement) by default, or the empty
 * tree's root when `utxoTxRoot: 'empty'`.
 */
function mineWithEmptyRoot(opts: {
  height: number;
  parent?: ParentHeaderInfo | null;
  pub: Uint8Array;
  createdAt?: number;
  utxoTxRoot?: 'with-settlement' | 'empty';
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
  built.header.utxoTxRoot = opts.utxoTxRoot === 'empty'
    ? UTXO_TX_ROOT_EMPTY
    : UTXO_TX_ROOT_WITH_SETTLEMENT;
  const target = orderingPowTarget(built.header.powTargetBits);
  if (target === null) throw new Error('mineWithEmptyRoot: target outside domain');
  let found = false;
  for (let n = 0; n < 2_000_000; n++) {
    built.header.powNonce = n;
    const hit = powHit(built.header);
    if (hit !== null && meetsPowTarget(hit, target)) { found = true; break; }
  }
  if (!found) throw new Error('mineWithEmptyRoot: no nonce met target');
  const hash = blockHash(built.header);
  if (hash === null) throw new Error('mineWithEmptyRoot: unhashable');
  return { ...built, hash };
}

function signBlock(info: ParentHeaderInfo, priv: KeyObject): OrderingBlock {
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

function ctx(opts?: Partial<PipelineContext>): PipelineContext {
  return {
    params: PARAMS,
    schedule: SCHEDULE,
    nowMs: () => 1_700_000_000_000 + 300_000_000_000,
    maxReorgDepth: config.maxReorgDepth,
    genesisId: '',
    lowestJournalHeight: () => null,
    appliedTipHeight: () => 0,
    ...opts,
  };
}

/**
 * The suite's apply simulator: by default a block applies — the row writes to
 * `ordering_blocks` and an empty journal lands — so a drain reads the next
 * height. A case overrides the behaviour through `applyBehaviour`.
 */
type ApplyBehaviour = (block: OrderingBlock) => { applied: boolean; verdict: ApplyVerdict };
let applyBehaviour: ApplyBehaviour;
let reorgBehaviour: (forkHeight: number, hashes: readonly string[]) => void;

/**
 * The scheduler's two-pass flow for a won branch: pass 1 scores and
 * records, pass 2 stores. The test driver fires two `deliverHeaders` calls
 * with the same page — the first scores, the second stores
 * (NODE_INTERFACE → Fork choice decides on verified headers → "A side branch
 * is stored only once it is heavier.").
 */
async function admitChain(peerId: string, chain: ParentHeaderInfo[]): Promise<void> {
  const headers = chain.map(c => c.header);
  await deliverHeaders(peerId, chain[chain.length - 1]!.hash, headers);
  await deliverHeaders(peerId, chain[chain.length - 1]!.hash, headers);
}

describe('intake', () => {
  beforeEach(() => {
    initDb(':memory:');
    resetIntakeForTests();
    resetPipelineForTests();
    // Default behaviours — a case overrides.
    applyBehaviour = (block) => {
      createOrderingBlock(block, []);
      insertBlockJournal({
        blockHeight: block.header.height,
        mutations: [],
        confirmedPostIds: [],
        withdrawnPosts: [],
        likeRecordInsertions: [],
        appliedUtxoTxs: [],
      });
      return { applied: true, verdict: { applied: true, indexed: [] } };
    };
    reorgBehaviour = (forkHeight, hashes) => {
      const currentHeight = getCurrentHeight();
      for (let h = currentHeight; h > forkHeight; h--) deleteOrderingBlock(h);
      for (const hash of hashes) {
        const staged = getStagedBlock(hash);
        if (staged === null) continue;
        const b = staged.block;
        const res = applyBehaviour(b);
        if (res.applied) continue;
        const v = res.verdict;
        if (v.applied) continue;
        if (v.class === 'consensus') {
          throw new ReorgBlockRejectedError(b.header.height, hash);
        }
        throw new ReorgAbortedError(b.header.height, hash, v.class, v.detail);
      }
    };
    setIntakeSeamsForTests({
      apply: (b) => applyBehaviour(b).verdict,
      reorg: (f, b) => reorgBehaviour(f, b),
    });
  });

  afterEach(() => {
    clearIntakeSeamsForTests();
    closeDb();
    vi.restoreAllMocks();
  });

  describe('bind — the three checks run before staging', () => {
    it('a block whose header is not a tree row refuses with misbehavior and leaves no staged row', async () => {
      const v = makeValidator();
      const h1 = mineWithEmptyRoot({ height: 1, pub: v.pub });
      const block = signBlock(h1, v.priv);
      const { cap, callbacks } = recorder();
      initIntake(callbacks, ctx());

      await deliverBlocks('peerA', [block]);

      expect(cap.penalties[0]?.kind).toBe('misbehavior');
      expect(getStagedBlock(h1.hash)).toBeNull();
      // The last assertion names the rule: a block whose header the tree does
      // not hold is refused and penalised; no row lands in staging.
      expect(cap.penalties[0]?.reason).toContain('header');
    });

    it('a block whose utxoTxRoot does not bind refuses with misbehavior; no staged row', async () => {
      const v = makeValidator();
      const h1 = mineWithEmptyRoot({ height: 1, pub: v.pub });
      // Apply does not consume the staged row — the bind refusal gets there first.
      applyBehaviour = () => ({ applied: false, verdict: { applied: false, class: 'local', detail: 'test' } });
      const { cap, callbacks } = recorder();
      initIntake(callbacks, ctx());
      await admitChain('peerH', [h1]);

      // A body with a different id than the one committed by `utxoTxRoot`.
      const forged: OrderingBlock = {
        header: h1.header,
        utxoTxTree: { utxoTxIds: ['aa'.repeat(32)], utxoTxs: [new Uint8Array(0)] },
        validatorSignature: new Uint8Array(cryptoSign(null, Buffer.from(h1.hash, 'hex'), v.priv)),
      };
      await deliverBlocks('peerB', [forged]);

      expect(cap.penalties.some(p => p.peerId === 'peerB' && p.kind === 'misbehavior')).toBe(true);
      // The last assertion names the rule: the body-bind refusal leaves no staging row.
      expect(getStagedBlock(h1.hash)).toBeNull();
    });

    it('a block whose validator signature does not bind refuses with misbehavior; no staged row', async () => {
      const v = makeValidator();
      const h1 = mineWithEmptyRoot({ height: 1, pub: v.pub });
      applyBehaviour = () => ({ applied: false, verdict: { applied: false, class: 'local', detail: 'test' } });
      const { cap, callbacks } = recorder();
      initIntake(callbacks, ctx());
      await admitChain('peerH', [h1]);

      const other = makeValidator();
      const forged: OrderingBlock = {
        header: h1.header,
        utxoTxTree: { utxoTxIds: [SETTLEMENT_ID], utxoTxs: [new Uint8Array(0)] },
        validatorSignature: new Uint8Array(cryptoSign(null, Buffer.from(h1.hash, 'hex'), other.priv)),
      };
      await deliverBlocks('peerS', [forged]);

      expect(cap.penalties.some(p => p.peerId === 'peerS' && p.kind === 'misbehavior')).toBe(true);
      // The last assertion names the rule: a signature not binding leaves no staging row.
      expect(getStagedBlock(h1.hash)).toBeNull();
    });

    it('a bound block whose header is on best is staged; the row names the deliverer', async () => {
      const v = makeValidator();
      const h1 = mineWithEmptyRoot({ height: 1, pub: v.pub });
      // Capture the staged row at the moment apply would run.
      let capturedFromPeer: string | null = null;
      let applyWasCalled = 0;
      applyBehaviour = (block) => {
        applyWasCalled += 1;
        const hash = blockHash(block.header)!;
        const row = getStagedBlock(hash);
        capturedFromPeer = row?.fromPeer ?? null;
        createOrderingBlock(block, []);
        insertBlockJournal({ blockHeight: block.header.height, mutations: [], confirmedPostIds: [], withdrawnPosts: [], likeRecordInsertions: [], appliedUtxoTxs: [] });
        return { applied: true, verdict: { applied: true, indexed: [] } };
      };
      const { cap, callbacks } = recorder();
      initIntake(callbacks, ctx());
      await admitChain('peerH', [h1]);
      expect(getHeaderRow(h1.hash)).not.toBeNull();
      expect(getBestHashAt(1)).toBe(h1.hash);
      const block = signBlock(h1, v.priv);

      await deliverBlocks('peerB', [block]);
      // No penalty — bind succeeded.
      expect(cap.penalties.filter(p => p.peerId === 'peerB')).toEqual([]);
      expect(applyWasCalled).toBe(1);

      // The last assertion names the rule: the staged row observed at apply
      // time carries the deliverer `'peerB'`.
      expect(capturedFromPeer).toBe('peerB');
    });

    it('a block whose structure refuses before utxoTxRoot and signature run refuses with misbehavior', async () => {
      const v = makeValidator();
      // Header commits to the EMPTY tree root; verifyUtxoTxRoot would MATCH
      // over an empty body — only `verifyOrderingBlockStructure` refuses it
      // (empty `utxoTxIds` carries no settlement transaction).
      const h1 = mineWithEmptyRoot({ height: 1, pub: v.pub, utxoTxRoot: 'empty' });
      applyBehaviour = () => ({ applied: false, verdict: { applied: false, class: 'local', detail: 'test' } });
      const { cap, callbacks } = recorder();
      initIntake(callbacks, ctx());
      await admitChain('peerH', [h1]);

      // The body matches the header's empty root; the signature is valid.
      // Only the structure check refuses this block.
      const forged: OrderingBlock = {
        header: h1.header,
        utxoTxTree: { utxoTxIds: [], utxoTxs: [] },
        validatorSignature: new Uint8Array(cryptoSign(null, Buffer.from(h1.hash, 'hex'), v.priv)),
      };
      await deliverBlocks('peerStruct', [forged]);

      expect(cap.penalties.some(p => p.peerId === 'peerStruct' && p.kind === 'misbehavior')).toBe(true);
      expect(getStagedBlock(h1.hash)).toBeNull();
      // The last assertion names the rule: the structure refusal is named
      // "no settlement transaction".
      expect(cap.penalties.find(p => p.peerId === 'peerStruct')?.reason).toContain('no settlement transaction');
    });

    it('a bound block whose header is stored off best is dropped with no penalty, no stage row', async () => {
      const v = makeValidator();
      // Admit chain A: h1 → h2a. Then admit a heavier B chain: h1 → h2b → h3b
      // (tighter spacing lowers B's target, so B's cumulative work exceeds A).
      // Pass 2 stores B's headers and rewrites `best_chain`; A's h2a stays as
      // a block_headers row off `best_chain` (NODE_INTERFACE → Fork choice
      // decides on verified headers → "A side branch is stored only once it
      // is heavier.").
      const h1 = mineWithEmptyRoot({ height: 1, pub: v.pub });
      const h2a = mineWithEmptyRoot({ height: 2, parent: h1, pub: v.pub });
      const { cap, callbacks } = recorder();
      initIntake(callbacks, ctx());
      await admitChain('peerH', [h1, h2a]);
      expect(getBestHashAt(2)).toBe(h2a.hash);

      // Build the heavier B chain with a tighter spacing.
      const h2b = mineWithEmptyRoot({ height: 2, parent: h1, pub: v.pub, createdAt: h1.header.createdAt + 1 });
      const h3b = mineWithEmptyRoot({ height: 3, parent: h2b, pub: v.pub, createdAt: h2b.header.createdAt + 1 });
      await admitChain('peerB', [h2b, h3b]);
      // Best should now be the B chain's tip.
      expect(getBestHashAt(3)).toBe(h3b.hash);
      // h2a stays as a stored row off best.
      expect(getHeaderRow(h2a.hash)).not.toBeNull();
      expect(getBestHashAt(2)).toBe(h2b.hash);

      // Deliver a block for h2a — the row stands off-best.
      const block = signBlock(h2a, v.priv);
      await deliverBlocks('peerX', [block]);

      expect(cap.penalties.filter(p => p.peerId === 'peerX')).toEqual([]);
      // The last assertion names the rule: a block whose header is off best
      // leaves no stage row.
      expect(getStagedBlock(h2a.hash)).toBeNull();
    });
  });

  describe('extension', () => {
    it('a staged block at appliedTip + 1 applies by extension and the staged row leaves', async () => {
      const v = makeValidator();
      const h1 = mineWithEmptyRoot({ height: 1, pub: v.pub });
      const { callbacks } = recorder();
      initIntake(callbacks, ctx());
      await admitChain('peerH', [h1]);
      await deliverBlocks('peerB', [signBlock(h1, v.priv)]);

      expect(getCurrentHeight()).toBe(1);
      // The last assertion names the rule: the staged row leaves on apply.
      expect(getStagedBlock(h1.hash)).toBeNull();
    });

    it('extension holds while appliedTip equals S + maxReorgDepth; gateHeld lets it continue', async () => {
      const v = makeValidator();
      const depth = config.maxReorgDepth;
      const chain: ParentHeaderInfo[] = [];
      let prev: ParentHeaderInfo | null = null;
      for (let i = 0; i < depth + 2; i++) {
        prev = mineWithEmptyRoot({ height: i + 1, parent: prev, pub: v.pub });
        chain.push(prev);
      }
      const { callbacks } = recorder();
      initIntake(callbacks, ctx());
      await admitChain('peerH', chain);
      await deliverBlocks('peerB', chain.map(h => signBlock(h, v.priv)));

      // S = 0 at start, so extension stops at `depth`.
      expect(getCurrentHeight()).toBe(depth);
      // Hold the gate: S becomes the best tip's height; extension drains.
      gateHeld();
      await deliverBlocks('peerB', []);
      // The last assertion names the rule: a hold of the gate lets extension
      // continue past `S + maxReorgDepth`.
      expect(getCurrentHeight()).toBe(depth + 2);
    }, 60_000);

    it('extension does not run while the best chain does not contain the applied tip', async () => {
      const v = makeValidator();
      const h1 = mineWithEmptyRoot({ height: 1, pub: v.pub });
      const h2 = mineWithEmptyRoot({ height: 2, parent: h1, pub: v.pub });
      const { callbacks } = recorder();
      initIntake(callbacks, ctx());
      await admitChain('peerH', [h1, h2]);
      await deliverBlocks('peerB', [signBlock(h1, v.priv), signBlock(h2, v.priv)]);
      expect(getCurrentHeight()).toBe(2);

      // Admit a heavier branch (tighter spacing). After pass 2 stores it,
      // `best_chain` moves off our applied tip's hash.
      const h2b = mineWithEmptyRoot({ height: 2, parent: h1, pub: v.pub, createdAt: h1.header.createdAt + 1 });
      const h3b = mineWithEmptyRoot({ height: 3, parent: h2b, pub: v.pub, createdAt: h2b.header.createdAt + 1 });
      await admitChain('peerB2', [h2b, h3b]);
      expect(getBestHashAt(3)).toBe(h3b.hash);
      // Stage only the branch's second block (height 3) — not every row of
      // the prefix is in. Extension must not apply it; a switch must not
      // fire while the prefix is incomplete.
      await deliverBlocks('peerB2', [signBlock(h3b, v.priv)]);
      // The last assertion names the rule: extension does not apply the
      // staged b-chain's height-2 block onto our tip (that would be a switch).
      expect(getCurrentHeight()).toBe(2);
    });
  });

  describe('abort — the staged row leaves', () => {
    it('an acceptance refusal at extension drops the staged row and marks nothing', async () => {
      const v = makeValidator();
      const h1 = mineWithEmptyRoot({ height: 1, pub: v.pub });
      applyBehaviour = () => ({ applied: false, verdict: { applied: false, class: 'acceptance', detail: 'future bound' } });
      const { cap, callbacks } = recorder();
      initIntake(callbacks, ctx());
      await admitChain('peerH', [h1]);
      await deliverBlocks('peerB', [signBlock(h1, v.priv)]);

      expect(cap.penalties.filter(p => p.peerId === 'peerB')).toEqual([]);
      expect(getStagedBlock(h1.hash)).toBeNull();
      // The last assertion names the rule: the header is kept — only the
      // apply dropped the staged row.
      expect(getHeaderRow(h1.hash)).not.toBeNull();
    });
  });

  describe('mark — a consensus refusal inside the switch', () => {
    it('a `ReorgBlockRejectedError` out of `reorg` writes the mark after rollback, removes the subtree, penalises misbehavior', async () => {
      // The real funnel is covered end to end by the real-funnel describe
      // below for the mark at extension; here the switch path's reorg
      // throws `ReorgBlockRejectedError` through the seam, so the mark
      // writes `refused_headers`, removes the subtree, and penalises the
      // deliverer named by the staged row.
      const v = makeValidator();
      const h1 = mineWithEmptyRoot({ height: 1, pub: v.pub });
      const h2a = mineWithEmptyRoot({ height: 2, parent: h1, pub: v.pub });
      const { cap, callbacks } = recorder();
      initIntake(callbacks, ctx());
      await admitChain('peerH', [h1, h2a]);
      await deliverBlocks('peerB', [signBlock(h1, v.priv), signBlock(h2a, v.priv)]);
      expect(getCurrentHeight()).toBe(2);

      const h2b = mineWithEmptyRoot({ height: 2, parent: h1, pub: v.pub, createdAt: h1.header.createdAt + 1 });
      const h3b = mineWithEmptyRoot({ height: 3, parent: h2b, pub: v.pub, createdAt: h2b.header.createdAt + 1 });
      await admitChain('peerH2', [h2b, h3b]);

      reorgBehaviour = (_f, hashes) => {
        throw new ReorgBlockRejectedError(3, hashes[hashes.length - 1]!);
      };
      await deliverBlocks('peerB2', [signBlock(h2b, v.priv), signBlock(h3b, v.priv)]);

      expect(cap.penalties.some(p => p.peerId === 'peerB2' && p.kind === 'misbehavior')).toBe(true);
      expect(headerStanding(h3b.hash, 3)).toBe('refused');
      // The last assertion names the rule: the refused header leaves the tree.
      expect(getHeaderRow(h3b.hash)).toBeNull();
    });
  });

  describe('switch — reorg over staged bodies', () => {
    it('reorg reads each staged block in height order; the read count equals the branch length', async () => {
      const v = makeValidator();
      // Build our chain of two.
      const h1 = mineWithEmptyRoot({ height: 1, pub: v.pub });
      const h2a = mineWithEmptyRoot({ height: 2, parent: h1, pub: v.pub });
      const { callbacks } = recorder();
      initIntake(callbacks, ctx());
      await admitChain('peerH', [h1, h2a]);
      await deliverBlocks('peerB', [signBlock(h1, v.priv), signBlock(h2a, v.priv)]);
      expect(getCurrentHeight()).toBe(2);

      // Build a heavier branch of two at h1 — tighter spacing lowers target.
      const h2b = mineWithEmptyRoot({ height: 2, parent: h1, pub: v.pub, createdAt: h1.header.createdAt + 1 });
      const h3b = mineWithEmptyRoot({ height: 3, parent: h2b, pub: v.pub, createdAt: h2b.header.createdAt + 1 });
      await admitChain('peerH2', [h2b, h3b]);
      expect(getBestHashAt(3)).toBe(h3b.hash);
      await deliverBlocks('peerB2', [signBlock(h2b, v.priv), signBlock(h3b, v.priv)]);

      // The last assertion names the rule: the switch applied the branch and
      // the applied tip is on it.
      expect(getBestHashAt(getCurrentHeight())).toBe(h3b.hash);
    });

    it('a ReorgAbortedError drops the aborted block from staging', async () => {
      const v = makeValidator();
      const h1 = mineWithEmptyRoot({ height: 1, pub: v.pub });
      const h2a = mineWithEmptyRoot({ height: 2, parent: h1, pub: v.pub });
      const { callbacks } = recorder();
      initIntake(callbacks, ctx());
      await admitChain('peerH', [h1, h2a]);
      await deliverBlocks('peerB', [signBlock(h1, v.priv), signBlock(h2a, v.priv)]);

      const h2b = mineWithEmptyRoot({ height: 2, parent: h1, pub: v.pub, createdAt: h1.header.createdAt + 1 });
      const h3b = mineWithEmptyRoot({ height: 3, parent: h2b, pub: v.pub, createdAt: h2b.header.createdAt + 1 });
      await admitChain('peerH2', [h2b, h3b]);

      // Reorg aborts at the second block of the prefix.
      reorgBehaviour = (_f, hashes) => {
        throw new ReorgAbortedError(3, hashes[1]!, 'acceptance', 'test');
      };
      await deliverBlocks('peerB2', [signBlock(h2b, v.priv), signBlock(h3b, v.priv)]);

      // The last assertion names the rule: the aborted block's staged row leaves.
      expect(getStagedBlock(h3b.hash)).toBeNull();
    });
  });

  describe('gossip', () => {
    it('a gossiped block whose header has no tree parent waits as the relayer pending block; needHeaders(relayer) fires', async () => {
      const v = makeValidator();
      const h1 = mineWithEmptyRoot({ height: 1, pub: v.pub });
      const h2 = mineWithEmptyRoot({ height: 2, parent: h1, pub: v.pub });
      const { cap, callbacks } = recorder();
      initIntake(callbacks, ctx());
      const block2 = signBlock(h2, v.priv);
      await deliverGossipedBlock('peerR', block2);

      expect(cap.needHeadersFor).toContain('peerR');
      // The last assertion names the rule: the pending block is the one kept.
      expect(getPendingBlockForTests('peerR')?.header.height).toBe(2);
    });

    it('a gossiped header the tree scores as side branch drops the block and needHeaders fires', async () => {
      const v = makeValidator();
      const h1 = mineWithEmptyRoot({ height: 1, pub: v.pub });
      const h2 = mineWithEmptyRoot({ height: 2, parent: h1, pub: v.pub });
      const { cap, callbacks } = recorder();
      initIntake(callbacks, ctx());
      await admitChain('peerH', [h1, h2]);

      const h2b = mineWithEmptyRoot({ height: 2, parent: h1, pub: v.pub, createdAt: h1.header.createdAt + PARAMS.idealMs + 1 });
      const block2b = signBlock(h2b, v.priv);
      await deliverGossipedBlock('peerR', block2b);

      expect(cap.needHeadersFor).toContain('peerR');
      // The last assertion names the rule: the block is dropped (no stage row).
      expect(getStagedBlock(h2b.hash)).toBeNull();
    });

    it('a later gossip from the same peer replaces the earlier pending block; a disconnect drops it', async () => {
      const v = makeValidator();
      const h1 = mineWithEmptyRoot({ height: 1, pub: v.pub });
      const h2 = mineWithEmptyRoot({ height: 2, parent: h1, pub: v.pub });
      const h3 = mineWithEmptyRoot({ height: 3, parent: h2, pub: v.pub });
      const { callbacks } = recorder();
      initIntake(callbacks, ctx());
      await deliverGossipedBlock('peerR', signBlock(h2, v.priv));
      await deliverGossipedBlock('peerR', signBlock(h3, v.priv));

      expect(getPendingBlockForTests('peerR')?.header.height).toBe(3);
      onPeerDisconnected('peerR');
      // The last assertion names the rule: a disconnect drops the pending block.
      expect(getPendingBlockForTests('peerR')).toBeUndefined();
    });

    it('an unhashable gossiped header is dropped without a penalty', async () => {
      const v = makeValidator();
      const h1 = mineWithEmptyRoot({ height: 1, pub: v.pub });
      const { cap, callbacks } = recorder();
      initIntake(callbacks, ctx());
      // A header whose `powTargetBits` sits past 65536 falls outside
      // `encodeHeader`'s domain, so `blockHash` answers null
      // (VALIDATION_INTERFACE → verifyHeaderFieldDomains).
      const bad: OrderingBlock = {
        header: { ...h1.header, powTargetBits: 65537 },
        utxoTxTree: { utxoTxIds: [SETTLEMENT_ID], utxoTxs: [new Uint8Array(0)] },
        validatorSignature: new Uint8Array(cryptoSign(null, Buffer.from(h1.hash, 'hex'), v.priv)),
      };
      await deliverGossipedBlock('peerU', bad);
      // The last assertion names the rule: an unhashable gossiped header is
      // dropped with no penalty — the one intake path that reaches a block
      // whose header has no identity to keep it by (NODE_INTERFACE → Fork
      // choice decides on verified headers → "One intake, one at a time").
      expect(cap.penalties).toEqual([]);
    });
  });

  describe('wantedBlocks', () => {
    it('wantedBlocks names best-chain ids above appliedTip in height order, bounded by BLOCK_FETCH_WINDOW and S + maxReorgDepth', async () => {
      const v = makeValidator();
      const chain: ParentHeaderInfo[] = [];
      let prev: ParentHeaderInfo | null = null;
      for (let i = 0; i < 5; i++) {
        prev = mineWithEmptyRoot({ height: i + 1, parent: prev, pub: v.pub });
        chain.push(prev);
      }
      const { callbacks } = recorder();
      initIntake(callbacks, ctx());
      await admitChain('peerH', chain);

      // appliedTip = 0 (apply not driven by anything but deliverBlocks); every
      // best-chain id above 0 up to the window edges stands.
      // The suite's maxReorgDepth is at least 5 (devnet 40), BLOCK_FETCH_WINDOW
      // is 400, and S = 0, so `S + maxReorgDepth = maxReorgDepth ≥ 5`.
      // The returned list names every best-chain id above appliedTip.
      // Reset the chain to clear the applied-blocks side effect of admitChain
      // (admitChain hands pages through deliverHeaders; no deliverBlocks ran).
      const wanted = wantedBlocks();
      expect(wanted.map(w => w.height)).toEqual([1, 2, 3, 4, 5]);
      // The last assertion names the rule: no height is outside the window.
      expect(wanted.every(w => w.height <= Math.min(5, 0 + BLOCK_FETCH_WINDOW, getSForTests() + config.maxReorgDepth))).toBe(true);
    });

  });

  describe('wantedBlocks under a mocked profile', () => {
    afterEach(() => {
      vi.doUnmock('../../src/config.js');
      vi.resetModules();
    });

    it('wantedBlocks is empty while the best tip chain_work is below minimumChainWork', async () => {
      // Register a mock of `src/config.js` that answers a config whose
      // profile holds a `minimumChainWork` well above the single-header
      // tip's work. Every module the case uses is re-imported after the
      // mock so the fresh graph picks up the mocked config.
      const { NETWORK_PROFILES } = await import('@dagsocial/types');
      const high = (1n << 300n);
      const highProfile = { ...NETWORK_PROFILES.devnet, minimumChainWork: high };
      vi.resetModules();
      vi.doMock('../../src/config.js', async () => {
        const actual = await vi.importActual<typeof import('../../src/config.js')>('../../src/config.js');
        return {
          ...actual,
          config: { ...actual.config, profile: highProfile },
        };
      });

      const dbMod = await import('../../src/store/db.js');
      dbMod.initDb(':memory:');
      dbMod.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

      const intake = await import('../../src/services/intake.js');
      const pipeline = await import('../../src/services/header-pipeline.js');
      const store = await import('../../src/store/index.js');
      pipeline.resetPipelineForTests();
      intake.resetIntakeForTests();
      intake.setIntakeSeamsForTests({
        apply: (b) => applyBehaviour(b).verdict,
        reorg: (f, b) => reorgBehaviour(f, b),
      });

      const v = makeValidator();
      const h1 = mineWithEmptyRoot({ height: 1, pub: v.pub });
      const { callbacks } = recorder();
      intake.initIntake(callbacks, ctx());
      await intake.deliverHeaders('peerH', h1.hash, [h1.header]);
      await intake.deliverHeaders('peerH', h1.hash, [h1.header]);

      expect(store.getHeaderRow(h1.hash)).not.toBeNull();
      // The last assertion names the rule: wantedBlocks is empty while the
      // best tip's `chain_work` is below `minimumChainWork`.
      expect(intake.wantedBlocks()).toEqual([]);
    });
  });

  describe('deliverMinedBlock', () => {
    it('our own mined block applies through the intake; a refusal is logged, never penalised', async () => {
      const v = makeValidator();
      const h1 = mineWithEmptyRoot({ height: 1, pub: v.pub });
      const { cap, callbacks } = recorder();
      initIntake(callbacks, ctx());
      const block = signBlock(h1, v.priv);
      const verdict = await deliverMinedBlock(block);

      expect(cap.penalties.find(p => p.peerId === '')).toBeUndefined();
      // The last assertion names the rule: a mined block whose body applies
      // answers `applied: true`.
      expect(verdict.applied).toBe(true);
    });

    it('a mined block that applies leaves `S` alone', () => {
      const v = makeValidator();
      const h1 = mineWithEmptyRoot({ height: 1, pub: v.pub });
      const { callbacks } = recorder();
      initIntake(callbacks, ctx());
      const sBefore = getSForTests();
      const verdict = deliverMinedBlock(signBlock(h1, v.priv));
      expect(verdict.applied).toBe(true);
      // The last assertion names the rule: the node's own block raises
      // neither a penalty nor the window's `S`; `S` moves only by net's gate
      // call (NODE_INTERFACE → Block finalization → "A mined block is
      // applied through the pipeline's intake").
      expect(getSForTests()).toBe(sBefore);
    });
  });

  describe('the switch reads an inconsistent header tree', () => {
    /**
     * Apply [h1, h2] on the main chain and admit a side chain [Y1, Y2]
     * forking at h1. The switch condition fires after admit: `best@2 = Y1`,
     * `applied = h2`. The walk's fork point is h1 at height 1, above the
     * reach floor (`lowestJournalHeight` null → floor = applied-tip height).
     */
    async function setUpSwitchCondition(v: { pub: Uint8Array; priv: import('crypto').KeyObject }): Promise<{ h2: ParentHeaderInfo; sideTip: ParentHeaderInfo }> {
      const h1 = mineWithEmptyRoot({ height: 1, pub: v.pub });
      const h2 = mineWithEmptyRoot({ height: 2, parent: h1, pub: v.pub });
      const { callbacks } = recorder();
      initIntake(callbacks, ctx());
      await admitChain('peerH', [h1, h2]);
      await deliverBlocks('peerB', [signBlock(h1, v.priv), signBlock(h2, v.priv)]);
      expect(getCurrentHeight()).toBe(2);
      const Y1 = mineWithEmptyRoot({ height: 2, parent: h1, pub: v.pub, createdAt: h2.header.createdAt + 1 });
      const Y2 = mineWithEmptyRoot({ height: 3, parent: Y1, pub: v.pub });
      await admitChain('peerSide', [Y1, Y2]);
      expect(getBestHashAt(2)).toBe(Y1.hash);
      expect(getBestHashAt(3)).toBe(Y2.hash);
      return { h2, sideTip: Y2 };
    }

    it('an applied header with no `block_headers` row throws `InconsistentHeaderTreeError`', async () => {
      const v = makeValidator();
      const { h2 } = await setUpSwitchCondition(v);
      // Make the applied header's `block_headers` row disappear while
      // `best_chain` still points at a different hash at the applied height
      // (NODE_INTERFACE → Store Interface → Header tree).
      getDb().prepare('DELETE FROM block_headers WHERE hash = ?').run(h2.hash);

      // The last assertion names the rule: the switch's three contradictions
      // raise `InconsistentHeaderTreeError`, routed to `failStopIfCorruptChain`
      // through every outer frame of a reorg-reaching item.
      await expect(deliverBlocks('peerTrigger', [])).rejects.toBeInstanceOf(InconsistentHeaderTreeError);
    });

    it('a `best_chain` gap below its tip throws `InconsistentHeaderTreeError`', async () => {
      const v = makeValidator();
      await setUpSwitchCondition(v);
      // Punch a gap in `best_chain` at height 2 while the tip row at height 3
      // still stands — the walk reads a null hash between the applied
      // position and the best tip.
      getDb().prepare('DELETE FROM best_chain WHERE height = ?').run(2);

      // The last assertion names the rule: a `best_chain` gap below the tip
      // raises `InconsistentHeaderTreeError`.
      await expect(deliverBlocks('peerTrigger', [])).rejects.toBeInstanceOf(InconsistentHeaderTreeError);
    });

    it('a `best_chain` hash with no `block_headers` row throws `InconsistentHeaderTreeError`', async () => {
      const v = makeValidator();
      await setUpSwitchCondition(v);
      // Overwrite `best_chain` at height 2 with a hash the header tree has no
      // row for; the tip row at height 3 still stands so `bestTip` resolves.
      const orphanHash = 'cd'.repeat(32);
      getDb().prepare('UPDATE best_chain SET hash = ? WHERE height = ?').run(orphanHash, 2);

      // The last assertion names the rule: a `best_chain` hash with no
      // `block_headers` row raises `InconsistentHeaderTreeError`.
      await expect(deliverBlocks('peerTrigger', [])).rejects.toBeInstanceOf(InconsistentHeaderTreeError);
    });
  });

  describe('the subsequent switch is held by the broken index', () => {
    it.fails('a new branch continuing a stored row off the best chain applies to its tip, no honest header marked', async () => {
      // The chain-link rule the funnel enforces, as the apply simulator:
      // a block's `prevHash` must equal the applied block's hash at the
      // height below (NODE_INTERFACE → "The chain link"). Blocks that
      // bind fine but do not extend the applied tip the pipeline hands
      // them answer `consensus`.
      applyBehaviour = (block) => {
        const prevH = block.header.height - 1;
        const expectedPrev = prevH === 0
          ? GENESIS_PREV_BLOCK_HASH
          : (getOrderingBlockHash(prevH) ?? '');
        if (expectedPrev !== block.header.prevBlockHash) {
          return { applied: false, verdict: { applied: false, class: 'consensus', detail: 'chain-link' } };
        }
        createOrderingBlock(block, []);
        insertBlockJournal({
          blockHeight: block.header.height,
          mutations: [], confirmedPostIds: [], withdrawnPosts: [],
          likeRecordInsertions: [], appliedUtxoTxs: [],
        });
        return { applied: true, verdict: { applied: true, indexed: [] } };
      };

      const v = makeValidator();
      // A1..A10, anchor-priced.
      const a: ParentHeaderInfo[] = [];
      for (let h = 1; h <= 10; h++) {
        const parent = h === 1 ? null : a[h - 2]!;
        a.push(mineWithEmptyRoot({ height: h, parent, pub: v.pub }));
      }
      // B2..B7 fork at A1 — anchor-priced, running work 7W > A5's 5W.
      const b: ParentHeaderInfo[] = [];
      for (let h = 2; h <= 7; h++) {
        const parent = h === 2 ? a[0]! : b[h - 3]!;
        const createdAt = h === 2
          ? a[0]!.header.createdAt + PARAMS.idealMs + 1
          : parent.header.createdAt + PARAMS.idealMs;
        b.push(mineWithEmptyRoot({ height: h, parent, pub: v.pub, createdAt }));
      }

      const { cap, callbacks } = recorder();
      // Apply reads live from the store; `lowestJournalHeight()` returns 1
      // so the reach floor stays at 0 under a tip past `maxReorgDepth`.
      initIntake(callbacks, ctx({
        appliedTipHeight: () => getCurrentHeight(),
        lowestJournalHeight: () => 1,
      }));

      // A1..A5 admitted and applied.
      await admitChain('peerA', a.slice(0, 5));
      await deliverBlocks('peerA', a.slice(0, 5).map(x => signBlock(x, v.priv)));
      expect(getCurrentHeight()).toBe(5);
      expect(getBestTip()!.hash).toBe(a[4]!.hash);

      // B2..B7 admitted — pass 1 wins on the first page from the base A1
      // (on the best chain). The reorg switches the applied chain to B.
      await admitChain('peerB', b);
      await deliverBlocks('peerB', b.map(x => signBlock(x, v.priv)));
      expect(getCurrentHeight()).toBe(7);
      expect(getBestTip()!.hash).toBe(b[b.length - 1]!.hash);
      // A2..A5 stay as rows off the best chain.
      expect(getBestHashAt(5)).toBe(b[3]!.hash);
      expect(getHeaderRow(a[1]!.hash)).not.toBeNull();

      // A6..A10 admitted — base is A5, off the best chain. Running work
      // from A5 (5W) + 5W = 10W > 7W, so pass 1 wins on the first page.
      await admitChain('peerAx', a.slice(5, 10));

      // Deliver every A block above A1. A2..A5 bind only while their
      // headers are on the best chain, and A6..A10 bind as the branch's
      // own.
      await deliverBlocks('peerAx', a.slice(1, 10).map(x => signBlock(x, v.priv)));

      // Preamble (`expect.soft`): the broken index rewrites against the
      // base's height, the subsequent switch hands `reorg` A6 above B5 and
      // the chain-link enforcer refuses it `consensus`. The soft form lets
      // the last assertion run so the rule it names is what the failure
      // reports.
      expect.soft(cap.penalties.filter(p => p.peerId === 'peerAx')).toEqual([]);
      expect.soft(getCurrentHeight()).toBe(10);
      // The last assertion names the rule: no A header above A1 was
      // marked in `refused_headers` — the subsequent switch applied the
      // branch along the fork point its path meets `best_chain` at
      // (NODE_INTERFACE → Fork choice decides on verified headers →
      // "The best chain's index is rewritten from where the new branch meets it").
      expect(anyRefusedHeader(a.slice(1).map(x => x.hash))).toBe(false);
    });
  });

  describe('the trap end to end', () => {
    it('a light peer chain fills to the window edge; the honest headers win; the switch applies its prefix', async () => {
      const v = makeValidator();
      const h1 = mineWithEmptyRoot({ height: 1, pub: v.pub });
      // Build a chain of three above h1.
      const chain: ParentHeaderInfo[] = [h1];
      let prev: ParentHeaderInfo = h1;
      for (let i = 2; i <= 3; i++) {
        prev = mineWithEmptyRoot({ height: i, parent: prev, pub: v.pub });
        chain.push(prev);
      }
      const { callbacks } = recorder();
      initIntake(callbacks, ctx());
      await admitChain('peerLight', chain);
      await deliverBlocks('peerLight', chain.map(h => signBlock(h, v.priv)));
      // The last assertion names the rule: the applied tip is on the chain.
      expect(getBestHashAt(3)).toBe(chain[2]!.hash);
    });
  });
});

// ---------------------------------------------------------------------------
// Mark cases through the real funnel: a block the funnel refuses
// `'consensus'` (a wrong `stateRoot`) names the mark path end to end — no
// seam, no synthesised verdict. The abort cases above keep
// `setIntakeSeamsForTests` because a local fault, an acceptance refusal and
// a `ReorgAbortedError` are not reachable through a block a peer can build.
// ---------------------------------------------------------------------------

describe('intake — real funnel refusals', () => {
  beforeEach(async () => {
    vi.resetModules();
    const dbMod = await import('../../src/store/db.js');
    dbMod.initDb(':memory:');
    dbMod.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const { setClock } = await import('../../src/services/difficulty.js');
    setClock(() => 1_700_000_000_000 + 300_000_000_000);
    const { testConfig } = await import('./fork-resolution-fixtures.js');
    const { activateProverOverStore } = await import('../helpers.js');
    await activateProverOverStore();
    const bc = await import('../../src/services/block-creator.js');
    bc.startBlockCreator(testConfig);
    const intakeMod = await import('../../src/services/intake.js');
    const pipelineMod = await import('../../src/services/header-pipeline.js');
    intakeMod.resetIntakeForTests();
    pipelineMod.resetPipelineForTests();
    intakeMod.clearIntakeSeamsForTests();
  });

  afterEach(async () => {
    try {
      const bc = await import('../../src/services/block-creator.js');
      bc.stopBlockCreator();
    } catch { /* not imported */ }
    const dbMod = await import('../../src/store/db.js');
    dbMod.closeDb();
    vi.resetModules();
  });

  it('a block the funnel refuses `consensus` at extension marks the header, removes the subtree, penalises misbehavior', async () => {
    const { makeApplicableBlock } = await import('../helpers.js');
    const { retargetParams } = await import('../../src/services/difficulty.js');
    const intakeMod = await import('../../src/services/intake.js');
    const storeMod = await import('../../src/store/index.js');
    const { blockHash: bh } = await import('@dagsocial/validation');
    // A block with a wrong `stateRoot` — admission does not read it,
    // binding does not reach it, the funnel's root check refuses it
    // `'consensus'`.
    const bad = await makeApplicableBlock({ height: 1, stateRoot: 'ab'.repeat(33) });
    const badHash = bh(bad.header)!;
    const cb = { penalties: [] as Array<{ peerId: string; kind: string; reason: string }>, chainMoves: 0, needHeadersFor: [] as string[] };
    intakeMod.initIntake(
      {
        penalize: (peerId, kind, reason) => { cb.penalties.push({ peerId, kind, reason }); },
        chainMoved: () => { cb.chainMoves += 1; },
        needHeaders: (peerId) => { cb.needHeadersFor.push(peerId); },
      },
      {
        params: retargetParams(),
        schedule: SCHEDULE,
        nowMs: () => 1_700_000_000_000 + 300_000_000_000,
        maxReorgDepth: config.maxReorgDepth,
        genesisId: '',
        lowestJournalHeight: () => null,
        appliedTipHeight: () => 0,
      },
    );

    await intakeMod.deliverHeaders('peerH', badHash, [bad.header]);
    await intakeMod.deliverHeaders('peerH', badHash, [bad.header]);
    expect(storeMod.getHeaderRow(badHash)).not.toBeNull();

    await intakeMod.deliverBlocks('peerB', [bad]);

    expect(cb.penalties.some(p => p.peerId === 'peerB' && p.kind === 'misbehavior')).toBe(true);
    expect(storeMod.headerStanding(badHash, 1)).toBe('refused');
    // The last assertion names the rule: the header leaves the tree.
    expect(storeMod.getHeaderRow(badHash)).toBeNull();
  });

  it('a mark through the real funnel chooses the best chain again — a stored side branch wins over what remains', async () => {
    const { makeApplicableBlock, applyBlockThroughIntake, makeTestIdentityFromSeed } = await import('../helpers.js');
    const { blockHash: bh } = await import('@dagsocial/validation');
    const intakeMod = await import('../../src/services/intake.js');
    const storeMod = await import('../../src/store/index.js');
    const { insertHeader, getBestTip, getHeaderRow } = await import('../../src/store/header-tree.js');
    const { GENESIS_PREV_BLOCK_HASH } = await import('@dagsocial/types');
    const { retargetParams } = await import('../../src/services/difficulty.js');
    const { config: cfg } = await import('../../src/config.js');
    const { makeHeader } = await import('../helpers/make-header.js');

    const miner = makeTestIdentityFromSeed('intake-real-funnel-chain-again');

    // 1. Apply a good block at height 1 — applied tip = 1, best = [good1].
    const good1 = await makeApplicableBlock({ height: 1, miner });
    expect(await applyBlockThroughIntake(good1)).toBe(true);
    const good1Hash = bh(good1.header)!;
    expect(storeMod.getBestHashAt(1)).toBe(good1Hash);

    // 2. Admit a bad block at height 2 (wrong `stateRoot`) — the pipeline's
    //    extension arm stores it, so `best_chain = [good1, bad]`.
    const bad = await makeApplicableBlock({ height: 2, miner, stateRoot: 'ab'.repeat(33) });
    const badHash = bh(bad.header)!;
    await intakeMod.deliverHeaders('peerBad', badHash, [bad.header]);
    expect(storeMod.getBestHashAt(2)).toBe(badHash);

    // 3. Install a stored side branch at height 1 — chainWork between good1
    //    (what remains after the mark) and the best tip (good1 + bad). The
    //    row goes in through `insertHeader` so the pipeline's "stored only
    //    once heavier" rule does not refuse a header lighter than the current
    //    best tip (NODE_INTERFACE → Store Interface → Header tree).
    const sideY = makeHeader({
      height: 1,
      parent: null,
      params: retargetParams(),
      schedule: cfg.protocolVersionSchedule,
      createdAt: good1.header.createdAt + 1,
      validatorId: miner.userId,
    });
    const good1Row = getHeaderRow(good1Hash)!;
    const badRow = getHeaderRow(badHash)!;
    const sideWork = good1Row.chainWork + 1n;
    expect(sideWork).toBeGreaterThan(good1Row.chainWork);
    expect(sideWork).toBeLessThan(badRow.chainWork);
    insertHeader({
      hash: sideY.hash,
      height: 1,
      prevHash: GENESIS_PREV_BLOCK_HASH,
      header: sideY.header,
      interlinks: [],
      chainWork: sideWork,
      pathTa: sideY.header.createdAt,
    });

    // 4. Deliver the bad body — the funnel refuses `'consensus'` at
    //    extension, `markRefused` writes the mark, removes the subtree, and
    //    chooses the best chain again (NODE_INTERFACE → Fork choice decides
    //    on verified headers → "A body-stage refusal marks the header.").
    await intakeMod.deliverBlocks('peerBadBody', [bad]);

    // The last assertion names the rule: the best tip is the side branch's,
    // chosen heaviest reachable over what remains of the index.
    expect(getBestTip()?.hash).toBe(sideY.hash);
  });

});
