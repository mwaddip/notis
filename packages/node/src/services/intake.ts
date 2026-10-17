import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import {
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyValidatorSignature,
  blockHash,
} from '@dagsocial/validation';
import { encodeOrderingBlock } from '@dagsocial/types';
import {
  getBestHashAt,
  getBestTip,
  getCurrentHeight,
  getOrderingBlockHash,
  getStagedBlock,
  insertRefusedHeader,
  pruneHeadersBelow,
  purgeOldJournals,
  removeHeaderSubtree,
  stageBlock,
  unstageBlock,
} from '../store/index.js';
import {
  admitHeader,
  admitPage,
  onPeerDisconnected as pipelineOnPeerDisconnected,
  pruneHeaderTree,
  type AdmitVerdict,
  type PageVerdict,
  type PipelineCallbacks,
  type PipelineContext,
} from './header-pipeline.js';
import { applyOrderingBlockVerdict, type ApplyVerdict } from './block-apply.js';
import { reorg } from './fork-resolution.js';

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "The pipeline
 * names the blocks it wants": the bound on how far an extension's wanted set
 * reaches above the applied tip. Literal (CONSTANTS → node).
 */
export const BLOCK_FETCH_WINDOW = 400;

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "The intake owns
 * what it runs": every penalty, every `best chain moved` event, and every
 * `needHeaders(peer)` ask leaves the intake through callbacks the wiring
 * injects.
 */
export interface IntakeCallbacks {
  penalize(peerId: string, kind: 'misbehavior' | 'transient', reason: string): void;
  chainMoved(): void;
  needHeaders(peerId: string): void;
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "One intake, one
 * at a time": the module state the intake holds. `S` the window's hold
 * (`gateHeld()` writes it), `pendingBlocks` the one-per-peer gossiped block
 * waiting for its header's parent.
 */
let callbacks: IntakeCallbacks | null = null;
let context: PipelineContext | null = null;
let S = 0;
const pendingBlocks = new Map<string, OrderingBlock>();

/**
 * NODE_INTERFACE → Fork choice decides on verified headers. Wires the intake
 * once at startup — the seam the wiring and the suite share.
 */
export function initIntake(cb: IntakeCallbacks, ctx: PipelineContext): void {
  callbacks = cb;
  context = ctx;
}

/** Tests only. */
export function resetIntakeForTests(): void {
  callbacks = null;
  context = null;
  S = 0;
  pendingBlocks.clear();
}

function cb(): IntakeCallbacks {
  if (callbacks === null) throw new Error('intake: initIntake was not called');
  return callbacks;
}

function ctx(): PipelineContext {
  if (context === null) throw new Error('intake: initIntake was not called');
  return context;
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "The pipeline
 * names the blocks it wants". For extension: the best chain's ids above the
 * applied tip that are neither applied nor staged, each with its height, in
 * height order, bounded by `BLOCK_FETCH_WINDOW` and the window's edge
 * (`S + maxReorgDepth`); for a switch (best chain forks below `appliedTip`):
 * the branch's whole shortest heavier prefix; empty while the best tip's
 * `chain_work` is below `minimumChainWork`.
 */
export function wantedBlocks(): { id: string; height: number }[] {
  // Stub — the live code lands in a follow-up.
  return [];
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "The window":
 * `S` is the best chain's height at the last `gateHeld()`; `S = 0` at process
 * start.
 */
export function gateHeld(): void {
  const best = getBestTip();
  S = best?.height ?? 0;
}

/**
 * NET_INTERFACE → Sync Handler Registration: the applied chain's answer to
 * the scheduler's `fullyApplied()` question.
 */
export function fullyApplied(): boolean {
  const best = getBestTip();
  if (!best) return true;
  return getCurrentHeight() >= best.height;
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "One intake, one
 * at a time". A `Headers` page from a peer: admission over the page, then
 * extension drain.
 */
export async function deliverHeaders(
  peerId: string,
  claimHash: string,
  headers: BlockHeader[],
): Promise<boolean> {
  // Stub — the live code lands in a follow-up.
  void peerId;
  void claimHash;
  void headers;
  return false;
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "A served block
 * is bound to its header before it is kept.". A `Blocks` answer: each block
 * is bound to a stored header on the best chain, staged, and extension drains.
 */
export async function deliverBlocks(peerId: string, blocks: OrderingBlock[]): Promise<void> {
  // Stub — the live code lands in a follow-up.
  void peerId;
  void blocks;
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "One intake, one
 * at a time". A gossiped block past Stage 1: admit its header, bind the block
 * to the admitted row, stage it; a gossiped block whose header has no tree
 * parent waits as its relayer's pending block and `needHeaders(relayer)` is
 * called.
 */
export async function deliverGossipedBlock(peerId: string, block: OrderingBlock): Promise<void> {
  // Stub — the live code lands in a follow-up.
  void peerId;
  void block;
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "One intake, one
 * at a time". This node's own mined block: admit, bind, stage and apply by
 * extension in one item; `peerId` is `''` and a refusal of our own block is
 * logged, never penalised — the wiring's injected `penalize` filters `''`.
 */
export async function deliverMinedBlock(block: OrderingBlock): Promise<ApplyVerdict> {
  // Stub — the live code lands in a follow-up.
  void block;
  return { applied: false, class: 'local', detail: 'intake not yet implemented' };
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "One intake, one
 * at a time": a peer's disconnect takes its pending block, its presync and
 * its memo entry.
 */
export function onPeerDisconnected(peerId: string): void {
  pendingBlocks.delete(peerId);
  pipelineOnPeerDisconnected(peerId);
}

/** Tests only. */
export function getPendingBlockForTests(peerId: string): OrderingBlock | undefined {
  return pendingBlocks.get(peerId);
}

/** Tests only. */
export function getSForTests(): number {
  return S;
}

// References kept to keep the imports live while the stubs stand in.
void admitHeader;
void admitPage;
void applyOrderingBlockVerdict;
void blockHash;
void encodeOrderingBlock;
void getBestHashAt;
void getOrderingBlockHash;
void getStagedBlock;
void insertRefusedHeader;
void pruneHeaderTree;
void pruneHeadersBelow;
void purgeOldJournals;
void removeHeaderSubtree;
void reorg;
void stageBlock;
void unstageBlock;
void verifyOrderingBlockStructure;
void verifyUtxoTxRoot;
void verifyValidatorSignature;
void cb;
void ctx;
export type { AdmitVerdict, PageVerdict, PipelineCallbacks, PipelineContext };
