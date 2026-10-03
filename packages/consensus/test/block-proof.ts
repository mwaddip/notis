import { BatchAVLProver, StrictBatchAVLVerifier } from '@ergots/avltree';
import type { AvlTreeConfig, NeighborLookup } from '@ergots/avltree';
import { TREE_KEY_LENGTH, bytesToHex } from '@dagsocial/types';
import type { OrderingBlock } from '@dagsocial/types';
import { applyBlock, treeStateView, treeWritesOf, verifierSession } from '@dagsocial/consensus';
import type { ApplyContext, ApplyResult, TreeLookup, TreeSession, TreeWrite } from '@dagsocial/consensus';

// A block proven on a prover and replayed on a verifier (CONSENSUS_INTERFACE →
// The block proof). This module imports nothing Node and reads no Node global,
// so the bundle carries it.

/** The tree's shape (TYPES_INTERFACE → State format): keys of `TREE_KEY_LENGTH` bytes, values of any length. */
export const TREE_CONFIG: AvlTreeConfig = { keyLength: TREE_KEY_LENGTH, valueLengthOpt: null };

/**
 * A recording session over a prover (CONSENSUS_INTERFACE → The tree session):
 * each lookup is the prover's `performLookupWithNeighbors`, so it joins the
 * proof the prover makes next; a `null` neighbour is the sentinel, a fresh
 * array each, and a `{ success: false }` a throw. A key in `unrecorded` (hex)
 * is looked up unrecorded instead, which leaves it out of the proof.
 */
export function recordingSession(prover: BatchAVLProver, unrecorded: ReadonlySet<string> = new Set()): TreeSession {
  return {
    lookup(key: Uint8Array): TreeLookup {
      if (unrecorded.has(bytesToHex(key))) return lookupOf(prover.unauthenticatedLookupWithNeighbors(key));
      const answer = prover.performLookupWithNeighbors(key);
      if (!answer.success) throw new Error(`the prover refuses the lookup of ${bytesToHex(key)}`);
      return lookupOf(answer);
    },
  };
}

function lookupOf(answer: NeighborLookup): TreeLookup {
  const nextKey = answer.nextKey ?? new Uint8Array(TREE_KEY_LENGTH).fill(0xff);
  return answer.found
    ? { found: true, value: answer.value, nextKey }
    : { found: false, prevKey: answer.prevKey ?? new Uint8Array(TREE_KEY_LENGTH), nextKey };
}

/** `inner`, logging every key it is asked (hex) and every answer it gives, in order. */
export function loggingSession(inner: TreeSession): TreeSession & { keys: string[]; answers: TreeLookup[] } {
  const keys: string[] = [];
  const answers: TreeLookup[] = [];
  return {
    keys,
    answers,
    lookup(key: Uint8Array): TreeLookup {
      keys.push(bytesToHex(key));
      const answer = inner.lookup(key);
      answers.push(answer);
      return answer;
    },
  };
}

/** A prover holding `writes` — genesis's, `seedTreeWrites` — performed in order, its proof cycle closed. */
export function proverFrom(writes: readonly TreeWrite[]): BatchAVLProver {
  const prover = new BatchAVLProver(TREE_KEY_LENGTH, null);
  for (const write of writes) {
    if (!prover.performOneOperation(write).success) throw new Error(`the prover refuses ${write.tag} of ${bytesToHex(write.key)}`);
  }
  prover.generateProof();
  return prover;
}

/** What one block's run over a tree answered, and every lookup its session made. */
export interface BlockRun {
  result: ApplyResult;
  /** `treeWritesOf`'s answer for an accepted block; none for a refused one. */
  writes: TreeWrite[];
  /** Every key the session was asked, as hex, in order: the rules', then `treeWritesOf`'s own. */
  keys: string[];
  answers: TreeLookup[];
  /** The view's `lookupCount()` once the rules have run, and once `treeWritesOf` has. */
  rulesLookups: number;
  lookups: number;
}

/** The rules over a tree view on `session`, then, for an accepted block, `treeWritesOf` over the same view. */
function runBlock(session: TreeSession, block: OrderingBlock, ctx: ApplyContext): Omit<BlockRun, 'keys' | 'answers'> {
  const view = treeStateView(session);
  const result = applyBlock(view, block, ctx);
  const rulesLookups = view.lookupCount();
  const writes = result.ok ? treeWritesOf(result.effects, block.header.height, view) : [];
  return { result, writes, rulesLookups, lookups: view.lookupCount() };
}

/**
 * The block proven on `prover`, which stands at a proof-cycle boundary
 * (CONSENSUS_INTERFACE → The block proof): its reads through a recording
 * session, its writes performed, the proof and the digest they reach. A key in
 * `unrecorded` (hex) is left out of the proof.
 */
export function proveBlock(
  prover: BatchAVLProver,
  block: OrderingBlock,
  ctx: ApplyContext,
  unrecorded: ReadonlySet<string> = new Set(),
): BlockRun & { proof: Uint8Array; digest: Uint8Array } {
  const log = loggingSession(recordingSession(prover, unrecorded));
  const run = runBlock(log, block, ctx);
  for (const write of run.writes) {
    if (!prover.performOneOperation(write).success) throw new Error(`the prover refuses ${write.tag} of ${bytesToHex(write.key)}`);
  }
  return { ...run, keys: log.keys, answers: log.answers, proof: prover.generateProof(), digest: prover.digest() };
}

/**
 * The block replayed from its parent's digest and its proof alone
 * (CONSENSUS_INTERFACE → The tree session): the rules over `verifierSession`,
 * the writes derived over the same view and performed on the verifier, and the
 * digest they reach. A write the verifier refuses throws, naming its reason.
 * The verifier is `StrictBatchAVLVerifier`, so `isFullyConsumed()` is asked
 * once, after the last write and the digest, and a replay whose proof is not
 * byte for byte the proof its operations write throws
 * (CONSENSUS_INTERFACE → The tree session → "A block replays from its proof
 * only on all of these").
 */
export function replayBlock(
  parentDigest: Uint8Array,
  proof: Uint8Array,
  block: OrderingBlock,
  ctx: ApplyContext,
): BlockRun & { digest: Uint8Array | null } {
  const verifier = new StrictBatchAVLVerifier(parentDigest, proof, TREE_CONFIG);
  const log = loggingSession(verifierSession(verifier));
  const run = runBlock(log, block, ctx);
  for (const write of run.writes) {
    if (!verifier.performOneOperation(write).success) {
      throw new Error(`the block's proof refuses ${write.tag} of ${bytesToHex(write.key)}: ${verifier.getLastFailReason()}`);
    }
  }
  const digest = verifier.digest();
  if (digest !== null && !verifier.isFullyConsumed()) {
    throw new Error("the block's proof is not byte for byte the proof its operations write");
  }
  return { ...run, keys: log.keys, answers: log.answers, digest };
}
