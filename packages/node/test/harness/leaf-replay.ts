import { StrictBatchAVLVerifier } from '@ergots/avltree';
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
const TREE_CONFIG: AvlTreeConfig = { keyLength: TREE_KEY_LENGTH, valueLengthOpt: null };

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

/**
 * The block replayed from `parentRoot` and `proof` alone. A refusal is an
 * answer, never a throw: the proof the header does not commit to, a proof that
 * does not anchor at `parentRoot`, a lookup or a write the proof cannot answer,
 * a rule's refusal, a block over the budget, and a digest that is not the
 * header's `stateRoot`. A throw is what it is in the node — a defect, not a
 * verdict (CONSENSUS_INTERFACE → Applying a block).
 */
export function replayAsLeaf({ parentRoot, header, body, proof, ctx }: LeafBlock): LeafVerdict {
  // The header commits to its proof (TYPES_INTERFACE → Layout — Block,
  // `adProofsRoot`), and the proof is not used before it is known to be that one.
  const proofRoot = bytesToHex(hash32(proof));
  if (proofRoot !== header.adProofsRoot) {
    return { ok: false, reason: `the header's adProofsRoot ${header.adProofsRoot} is not the proof's hash32 ${proofRoot}` };
  }

  // A proof that fails to decode or anchor poisons the verifier at
  // construction. `StrictBatchAVLVerifier` so `isFullyConsumed()` can refuse
  // a proof carrying a trailing byte, an operation the replay never asks, a
  // set padding bit or an unvisited node written in full
  // (CONSENSUS_INTERFACE → The tree session, "A block replays from its proof
  // only on all of these").
  const verifier = new StrictBatchAVLVerifier(parentRoot, proof, TREE_CONFIG);
  if (verifier.digest() === null) {
    return { ok: false, reason: `the proof does not anchor at the parent root: ${verifier.getLastFailReason()}` };
  }

  // `applyBlock` reads the header's height and `validatorId` and the body, and
  // no signature (CONSENSUS_INTERFACE → Applying a block): the block handed to
  // it carries a placeholder, as the producer's speculative run's does.
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

  // Once the writes are derived and before they are performed
  // (CONSENSUS_INTERFACE → The block's cost), named as the node names it.
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
  // The proof is byte for byte the proof `BatchAVLProver.generateProof`
  // writes for the operations the replay performed (CONSENSUS_INTERFACE →
  // The tree session). Asked once, after the last write.
  if (!verifier.isFullyConsumed()) {
    return { ok: false, reason: NOT_EXACT };
  }
  return { ok: true };
}

/** The reason a strict verifier refuses a proof `BatchAVLProver.generateProof` would never write. */
export const NOT_EXACT = 'the proof is not byte for byte the proof its operations write';
