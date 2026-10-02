import { BatchAVLVerifier, StrictBatchAVLVerifier } from '@ergots/avltree';
import type { AvlTreeConfig } from '@ergots/avltree';
import { TREE_KEY_LENGTH, bytesToHex, hash32 } from '@dagsocial/types';
import type { BlockHeader, OrderingBlock, UtxoTxTree } from '@dagsocial/types';
import { applyBlock, checkBlockCost, treeStateView, treeWritesOf, verifierSession } from '@dagsocial/consensus';
import type { ApplyContext, TreeWrite } from '@dagsocial/consensus';

/**
 * A leaf's replay of one block (CONSENSUS_INTERFACE → The tree session;
 * CONSENSUS_INTERFACE → The block proof): a verifier holding the block's
 * parent root alone, handed the block's header, its body and its proof, runs
 * the rules over the proof and reaches the header's `stateRoot` — or answers
 * why not. The code it runs is the node's: `applyBlock` over `treeStateView`,
 * `treeWritesOf`, `checkBlockCost`.
 *
 * `checkBlockCost` is this module's import of `@dagsocial/consensus`, so a
 * suite that lowers the budget through `blockBudgetSeam` imports this module
 * after the seam, as it imports the node's.
 */

/** The tree's shape (TYPES_INTERFACE → State format): keys of `TREE_KEY_LENGTH` bytes, values of any length. */
export const TREE_CONFIG: AvlTreeConfig = { keyLength: TREE_KEY_LENGTH, valueLengthOpt: null };

/** What a leaf holds for one block: its parent's root, the block as it was fetched, and the network's rules context. */
export interface LeafBlock {
  /** The 33-byte state root the block's parent committed to. */
  parentRoot: Uint8Array;
  header: BlockHeader;
  body: UtxoTxTree;
  proof: Uint8Array;
  ctx: ApplyContext;
}

/** The replay's answer: the block reached its header's `stateRoot`, or the reason it did not. */
export type LeafVerdict = { ok: true } | { ok: false; reason: string };

/** The reason a strict verifier refuses a proof `BatchAVLProver.generateProof` would never write. */
export const NOT_EXACT = 'the proof is not byte for byte the proof its operations write';

/**
 * The two step-by-step verifier classes `verifierSession` takes
 * (CONSENSUS_INTERFACE → The tree session): neither is a subtype of the
 * other, so the harness's core takes the two members it uses.
 */
type StepVerifier = Pick<
  BatchAVLVerifier,
  'performLookupWithNeighbors' | 'getLastFailReason' | 'performOneOperation' | 'digest'
>;

/**
 * The replay's core: given a `verifier` already built over the parent's
 * root, run the block's rules through it and answer whether it reached the
 * header's `stateRoot`. The ADProofs check is still the caller's — it comes
 * before verifier construction, since a proof the header does not commit to
 * is not the one to anchor. The `isFullyConsumed()` check is the strict
 * wrapper's — the plain `BatchAVLVerifier` has no such method.
 */
export function replayAgainst(verifier: StepVerifier, { header, body, ctx }: Omit<LeafBlock, 'proof' | 'parentRoot'>): LeafVerdict {
  const block: OrderingBlock = { header, utxoTxTree: body, validatorSignature: new Uint8Array(64) };
  const view = treeStateView(verifierSession(verifier));
  let signatures: number;
  let writes: TreeWrite[];
  try {
    const result = applyBlock(view, block, ctx);
    if (!result.ok) return { ok: false, reason: result.reason };
    signatures = result.effects.signatures;
    writes = treeWritesOf(result.effects, header.height, view);
  } catch (err) {
    // A lookup the proof cannot answer poisons the verifier, and the session
    // throws it as fatal to the block (CONSENSUS_INTERFACE → The tree session):
    // that throw is the proof's refusal. A throw from a healthy verifier is not.
    if (verifier.getLastFailReason() === null) throw err;
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  const overBudget = checkBlockCost({ signatures, lookups: view.lookupCount(), writes: writes.length });
  if (overBudget !== null) return { ok: false, reason: `Rejected block height=${header.height}: ${overBudget}` };

  for (const write of writes) {
    if (!verifier.performOneOperation(write).success) {
      return {
        ok: false,
        reason: `the proof refuses ${write.tag} of ${bytesToHex(write.key)}: ${verifier.getLastFailReason()}`,
      };
    }
  }

  const digest = verifier.digest();
  if (digest === null) return { ok: false, reason: `the verifier is poisoned: ${verifier.getLastFailReason()}` };
  const reached = bytesToHex(digest);
  if (reached !== header.stateRoot) {
    return { ok: false, reason: `the proof reaches ${reached}, the header's stateRoot is ${header.stateRoot}` };
  }
  return { ok: true };
}

/**
 * The replay as a plain `BatchAVLVerifier` runs it — the reference the suite
 * compares the strict replay against. Answers `{ ok: true }` for every proof
 * that decodes, anchors at `parentRoot`, replays the block's operations and
 * reaches the header's `stateRoot`, even one a prover would never write for
 * those operations.
 */
export function replayAsLeafPlain({ parentRoot, header, body, proof, ctx }: LeafBlock): LeafVerdict {
  const proofRoot = bytesToHex(hash32(proof));
  if (proofRoot !== header.adProofsRoot) {
    return { ok: false, reason: `the header's adProofsRoot ${header.adProofsRoot} is not the proof's hash32 ${proofRoot}` };
  }
  const verifier = new BatchAVLVerifier(parentRoot, proof, TREE_CONFIG);
  if (verifier.digest() === null) {
    return { ok: false, reason: `the proof does not anchor at the parent root: ${verifier.getLastFailReason()}` };
  }
  return replayAgainst(verifier, { header, body, ctx });
}

/**
 * The block replayed from `parentRoot` and `proof` alone. A refusal is an
 * answer, never a throw: the proof the header does not commit to, a proof that
 * does not anchor at `parentRoot`, a lookup or a write the proof cannot answer,
 * a rule's refusal, a block over the budget, and a digest that is not the
 * header's `stateRoot`. **The strict verifier's `isFullyConsumed()` is asked
 * once, after the last write** — a proof carrying a trailing byte, an
 * operation the replay never asks, a set padding bit or an unvisited node
 * written in full is refused where a plain verifier would accept the digest
 * (CONSENSUS_INTERFACE → The tree session, "A block replays from its proof
 * only on all of these").
 */
export function replayAsLeaf({ parentRoot, header, body, proof, ctx }: LeafBlock): LeafVerdict {
  const proofRoot = bytesToHex(hash32(proof));
  if (proofRoot !== header.adProofsRoot) {
    return { ok: false, reason: `the header's adProofsRoot ${header.adProofsRoot} is not the proof's hash32 ${proofRoot}` };
  }
  const verifier = new StrictBatchAVLVerifier(parentRoot, proof, TREE_CONFIG);
  if (verifier.digest() === null) {
    return { ok: false, reason: `the proof does not anchor at the parent root: ${verifier.getLastFailReason()}` };
  }
  const verdict = replayAgainst(verifier, { header, body, ctx });
  if (!verdict.ok) return verdict;
  if (!verifier.isFullyConsumed()) return { ok: false, reason: NOT_EXACT };
  return { ok: true };
}
