import type { BlockHeader, ProtocolEra } from '@dagsocial/types';
import { blockWork } from '@dagsocial/validation';
import type { RetargetParams } from '@dagsocial/validation';

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "The intake owns
 * what it runs": every penalty and the "best chain moved" event leave the
 * pipeline through callbacks the intake injects.
 */
export interface PipelineCallbacks {
  penalize(peerId: string, kind: 'misbehavior' | 'transient', reason: string): void;
  chainMoved(): void;
}

/**
 * The verdict `admitHeader` answers its caller with. `callbacks.penalize` and
 * `callbacks.chainMoved` have already fired by the time the caller sees it;
 * the verdict carries the outcome a case asserts and the intake switches on.
 */
export type AdmitVerdict =
  | { kind: 'held' }
  | { kind: 'refused'; reason: string }
  | { kind: 'stored'; wasBest: boolean }
  | { kind: 'stored-switched'; forkHeight: number }
  | { kind: 'scored' }
  | { kind: 'parent-unknown' };

/** The source of a header admission (NODE_INTERFACE → Fork choice decides on verified headers). */
export type AdmitSource = 'headers-page' | 'gossip';

/** Verdict for `admitPage`. */
export interface PageVerdict {
  accepted: boolean;
  outcome:
    | 'extended'
    | 'scored-partial'
    | 'won'
    | 'lighter'
    | 'stored-from-pass-2'
    | 'held'
    | 'refused';
  refusedAt?: { index: number; kind: 'misbehavior' | 'transient' | 'none'; reason: string };
}

/**
 * Parameters the admission reads: the schedule, the clock, the retarget
 * parameters, the floor's horizon and the genesis pin — one slot the intake
 * resolves from `config.profile` once at wiring.
 */
export interface PipelineContext {
  params: RetargetParams;
  schedule: readonly ProtocolEra[];
  nowMs(): number;
  maxReorgDepth: number;
  genesisId: string;
  lowestJournalHeight(): number | null;
  appliedTipHeight(): number;
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers.
 *
 * Admit one header. Returns a verdict after it has resolved to one of
 * `held` / `refused` / `stored` / `stored-switched` / `scored` / `parent-unknown`,
 * firing `callbacks.penalize` on a refusal that carries one and
 * `callbacks.chainMoved` when the best chain moves.
 */
export function admitHeader(
  _header: BlockHeader,
  _source: AdmitSource,
  _peerId: string,
  _ctx: PipelineContext,
  _callbacks: PipelineCallbacks,
): AdmitVerdict {
  return { kind: 'refused', reason: 'not-implemented' };
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers →
 * "A side branch is stored only once it is heavier": pass 1 scores and pass 2
 * stores a won branch — this is one entry for both.
 *
 * `claimHash` is `''` for a run net opened with no claim
 * (NET_INTERFACE → Sync Handler Registration): its branch ends at the peer's
 * tip, the first page shorter than `MAX_CHAIN_RESPONSE_ITEMS`.
 */
export function admitPage(
  _peerId: string,
  _claimHash: string,
  _headers: BlockHeader[],
  _ctx: PipelineContext,
  _callbacks: PipelineCallbacks,
): PageVerdict {
  return { accepted: false, outcome: 'refused', refusedAt: { index: 0, kind: 'none', reason: 'not-implemented' } };
}

/**
 * NODE_INTERFACE → Sync Handler Registration → `setChainView` row: the tree
 * holds `hash`, or the pipeline scored that peer's branch lighter at it.
 */
export function knowsTip(_peerId: string, _hash: string): boolean {
  return false;
}

/**
 * NODE_INTERFACE → Sync Handler Registration → `setChainView` row: the locator
 * a header request to `peerId` carries (NET_INTERFACE →
 * `GetHeaders` / `GetBlocks` responses).
 */
export function locatorFor(_peerId: string): string[] {
  return [];
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "Pruning": called
 * beside `purgeOldJournals`.
 */
export function pruneHeaderTree(_belowHeight: number): void {
  // intentionally empty — the next commit wires the store cascade
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "One intake, one
 * at a time": a peer's disconnect takes its pending block, its presync and its
 * memo entry.
 */
export function onPeerDisconnected(_peerId: string): void {
  // intentionally empty
}

/**
 * Tests only: clear the module-local presync and memo state between cases.
 */
export function resetPipelineForTests(): void {
  // intentionally empty
}

/**
 * Internal helper the admission reads for the parent's work step. Exported so
 * cases can argue the chain_work bound without duplicating the arithmetic.
 */
export function headerWork(header: BlockHeader): bigint {
  return blockWork(header.powTargetBits) ?? 0n;
}
