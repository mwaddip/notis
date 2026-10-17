import type { OrderingBlock } from '@dagsocial/types';
import {
  decodeTx,
  MEMPOOL_EXPIRY_BLOCKS,
} from '@dagsocial/types';
import {
  getCurrentHeight,
  getBlockJournal,
  deleteBlockJournal,
  deleteBlockProof,
  deleteOrderingBlock,
  unconsumeBox,
  deleteBox,
  unconfirmPost,
  clearWithdrawal,
  deleteLikeRecord,
  insertUtxoTx,
  rollbackBlockTopology,
  MempoolFullError,
  PendingSpendConflictError,
  TxTooLargeError,
  getKarmaOwners,
  getStagedBlock,
  unstageBlock,
} from '../store/index.js';
import { ceilingOf } from '@dagsocial/consensus';
import { getDb } from '../store/db.js';
import type { BlockJournal } from '../store/journal.js';
import { putIdentityRecord, deleteIdentityRecord, putNetworkRecord } from '../store/identity-records.js';
import { putUsername, deleteUsername } from '../store/usernames.js';
import { tryGetAvlProver } from '../state/avl-prover.js';
import type { KeptRoot } from '../state/recent-roots.js';
import { label } from '@dagsocial/avltree';
import { applyOrderingBlockVerdict, announceAppliedBlock } from './block-apply.js';
import type { IndexedPost } from './block-apply.js';
import { registerPlaceholder } from './backfill.js';
import { getPlaceholdersAt } from '../store/index.js';
import { noteTip } from '../metrics.js';
import { getNet } from './net-instance.js';
import { clearTemplate, rebuildTemplate } from './block-creator.js';
import {
  MissingJournalError,
  MissingStagedBlockError,
  MissingStateVersionError,
  ReorgBlockRejectedError,
  ReorgAbortedError,
} from './corrupt-state.js';

/**
 * Whether the version digest describes the kept root — the 33 bytes
 * `rootLabel || treeHeight`, matching by content so the restore is of the
 * same tree a store resolve would build (NODE_INTERFACE → "A proof at an
 * older height restores a kept root").
 */
function versionDescribesKept(version: Uint8Array, kept: KeptRoot): boolean {
  if (version.length !== 33) return false;
  if (version[32] !== kept.treeHeight) return false;
  const rootLabel = label(kept.root);
  for (let i = 0; i < 32; i++) if (version[i] !== rootLabel[i]) return false;
  return true;
}

/**
 * Reverse all mutations from a single block using its journal.
 */
export function revertBlock(height: number): void {
  const journal = getBlockJournal(height);
  if (!journal) {
    throw new MissingJournalError('revertBlock', height);
  }

  // 1. Replay the primitive mutation log in reverse: box/insert → deleteBox,
  // box/remove → unconsumeBox, record → restore `replaced` or delete. This
  // restores the exact pre-block committed state for every mutation class —
  // including the pre-existing boxes merge-consumed inside settlement outputs,
  // tallied like boxes, and identity records.
  //
  // Reverse order is what makes a record written **more than once in one block**
  // (activity bump then decay, at the same height) revert correctly: each
  // inverse undoes one write, and the last one replayed is the *first* write's
  // `replaced` — the true pre-block value. A per-key single restore keeping the
  // last `replaced` would restore an intra-block intermediate instead.
  for (let i = journal.mutations.length - 1; i >= 0; i--) {
    const m = journal.mutations[i]!;
    if (m.kind === 'record') {
      if (m.replaced !== undefined) {
        putIdentityRecord(m.identityId, m.replaced);
      } else {
        deleteIdentityRecord(m.identityId);
      }
    } else if (m.kind === 'network') {
      putNetworkRecord(m.replaced);
    } else if (m.kind === 'username') {
      if (m.replaced !== undefined) {
        putUsername(m.replaced);
      } else {
        deleteUsername(m.nameLower);
      }
    } else if (m.kind === 'holder') {
      // Paired with a username mutation — the SQL row is restored there.
      // The AVL leaf is restored by the prover's version rollback.
    } else if (m.kind === 'box') {
      if (m.op === 'insert') {
        deleteBox(m.boxId);
      } else {
        unconsumeBox(m.boxId);
      }
    }
  }

  // 2. Side-record inverses
  for (const postId of journal.confirmedPostIds) {
    unconfirmPost(postId);
  }
  // A like-record is only ever inserted, so a block's record inserts have no
  // same-block inverse.
  for (const ins of journal.likeRecordInsertions) {
    deleteLikeRecord(ins.targetPostId, ins.likerId);
  }
  // Withdrawal inverses: restore content and clear the marker.
  for (const wp of journal.withdrawnPosts) {
    clearWithdrawal(wp.id, wp.content);
  }
  // ⛔ **The vouch escrow needs no side-record and no inverse of its own.** It
  // is a box, so the block's effects journal its creation and its spend as
  // `{kind:'box'}` with the exact inverses loop 1 above already replays — and
  // boxes are not keyed, so a second escrow is a second box rather than an
  // overwrite something has to restore.

  // 3. Roll back block_topology entries, delete block + journal + proof + the
  // height's AVL version rows. The version rows are per-block derived state
  // exactly like the block and journal rows: left behind, they make
  // versionAtOrBeforeHeight resolve rolled-back state, and re-applying a
  // block at this height (reorg back to a previously-reverted chain) would
  // find a row already standing at its height, which `update` refuses as
  // `DuplicateStateVersionError` (NODE_INTERFACE → AVL+ State Root). The proof
  // goes with its block (NODE_INTERFACE → The block proof).
  rollbackBlockTopology(height);
  deleteOrderingBlock(height);
  deleteBlockJournal(height);
  deleteBlockProof(height);
  const handle = tryGetAvlProver();
  handle?.storage.deleteVersionAtHeight(height);
  // The kept root for `height` is dropped with its block (NODE_INTERFACE →
  // "A proof at an older height restores a kept root"): the ring tracks
  // committed state, and the committed state no longer includes it.
  handle?.recentRoots.drop(height);
}

/**
 * Return a reverted entry to the mempool, tolerating the pool's own refusals.
 *
 * Re-insertion is bookkeeping — it gives txs from the losing chain a chance to
 * be re-mined. A refusal here must not abort the reorg: that would turn mempool
 * state into a consensus-liveness failure, leaving the node stuck on the lighter
 * chain (the whole reorg runs in one SQLite transaction, so a throw rolls back
 * the chain switch too). Dropped entries are lost from the local pool only; the
 * ledger state is already reverted, and peers still hold the txs.
 *
 * Three refusals qualify, for that one reason:
 *
 * - `MempoolFullError` — the pool is at its cap.
 * - `PendingSpendConflictError` — an entry admitted since spends one of this
 *   tx's inputs. Both are valid now that the block is reverted and only one can
 *   be, so the incumbent keeps its place.
 * - `TxTooLargeError` — the transaction re-encodes above `MAX_TX_BYTES`. The
 *   reverted block carried it, so its bytes as they arrived were inside the
 *   bound; what the pool measures is this node's own re-encoding, and the two
 *   measures differ by design (VALIDATION_INTERFACE → The size bound measures
 *   `encodeTx`). A transaction only this node's encoder finds over-size is one no
 *   block it produces could carry anyway.
 *
 * ⛔ **The conflict gate is not opted out of here.** Admitting both would leave
 * the pool holding two spends of one box, which is the composition a block is
 * refused for carrying — the node would then be unable to produce a block at
 * all until one of them expired. Dropping one entry costs strictly less.
 */
function reinsert(insert: () => void, label: string): void {
  try {
    insert();
  } catch (err) {
    if (err instanceof MempoolFullError) {
      console.warn(`Reorg re-insertion dropped, mempool full: ${label}`);
      return;
    }
    if (err instanceof PendingSpendConflictError) {
      console.warn(`Reorg re-insertion dropped, input spent by a pending entry: ${label}`);
      return;
    }
    if (err instanceof TxTooLargeError) {
      console.warn(
        `Reorg re-insertion dropped, above the transaction size limit: ${label}`,
      );
      return;
    }
    throw err;
  }
}

/**
 * Reorg: revert our chain from currentHeight down to forkHeight+1, then
 * apply the competing chain forward.
 *
 * The branch's blocks are named by their hashes, in height order; each
 * body is read out of `staged_blocks` one at a time inside the transaction,
 * so one block body is in memory at a time (NODE_INTERFACE → Fork choice
 * decides on verified headers → "A bound block is staged, and applied from
 * staging."). A null read is `MissingStagedBlockError`, fail-stop under the
 * transaction's catch — the switch checks the prefix staged in the same
 * synchronous item.
 */
export function reorg(forkHeight: number, newHashes: readonly string[]): void {
  // A failed reorg rolls the whole transaction back — DB and AVL storage rows
  // live in the same SQLite file — but SQLite rollback cannot reach the
  // prover's in-memory state. The pre-reorg root and tree height are captured
  // here, by reference, and put back on abort with `inner.restoreRoot`: SQLite
  // has already put the rows back, and the pre-reorg root is the tree they
  // describe (NODE_INTERFACE → "A proof at an older height restores a kept
  // root"; → "Rejection-safe"). The ring is snapshotted alongside and
  // restored on abort, so the heights the proof routes answered before do
  // not change under a failed switch.
  const avlHandle = tryGetAvlProver();
  const saved = avlHandle
    ? { root: avlHandle.prover.prover.root, height: avlHandle.prover.prover.height }
    : null;
  const ringSnapshot = avlHandle ? avlHandle.recentRoots.snapshot() : null;
  const restoreProver = (): void => {
    if (!avlHandle || !saved) return;
    avlHandle.prover.prover.restoreRoot(saved.root, saved.height);
    if (ringSnapshot !== null) avlHandle.recentRoots.restore(ringSnapshot);
  };
  // Phase 3 keeps each applied block with its verdict's `indexed` in this
  // list; the post-commit sequence below iterates it. On abort the list is
  // dropped with the catch, so a rolled-back reorg announces nothing
  // (NODE_INTERFACE → "What follows the commit is the commit's").
  const appliedWithIndexed: Array<{ block: OrderingBlock; indexed: readonly IndexedPost[] }> = [];
  try {
    getDb().transaction(() => {
  const currentHeight = getCurrentHeight();

  // Phase 1: revert our blocks, collecting journals for re-insertion
  const revertedJournals: BlockJournal[] = [];
  for (let h = currentHeight; h > forkHeight; h--) {
    const journal = getBlockJournal(h);
    if (journal) revertedJournals.push(journal);
    revertBlock(h);
  }

  // Phase 1b: resolve the prover to the fork point.
  //
  // A missing version here is not a case to skip past. Phase 3 would apply the
  // peer's chain onto a prover still holding our reverted tip's tree, so the
  // state root would stop covering the UTXO set — and that surfaces later, on
  // some other node, as a mismatch blamed on whoever sent the next block.
  // Refusing the reorg costs one chain switch; proceeding costs the invariant.
  //
  // The throw lands inside the transaction, so better-sqlite3 rolls the revert
  // back and the catch below restores the in-memory digest: the node keeps the
  // chain it had, which is a chain whose root it can still compute.
  //
  // Reachable through a `Config` assembled without `loadConfig` (tests);
  // otherwise a row the store lost. `loadConfig` refuses
  // `MAX_PROOF_HISTORY < maxReorgDepth` at load (NODE_INTERFACE →
  // Configuration).
  //
  // **Where the ring holds a root at `forkHeight` whose digest is the store's
  // version** — the invariant *"Every kept root is a root of the one tree the
  // node holds in memory"* (NODE_INTERFACE → "A proof at an older height
  // restores a kept root") — the restore is by reference on the inner prover,
  // with no store re-read: `prover.rollback(version)` builds a second object
  // graph of the same tree, and the ring's roots at and below the fork still
  // reach the first, so the node holds the tree twice. The kept roots at and
  // below the fork survive — they share state with the fork's tree.
  //
  // **Where it does not** — a fork below every kept root, or a node restarted
  // since — `prover.rollback(version)` resolves from the store, **and the
  // ring is emptied**: nothing kept before a store resolve shares a node with
  // the tree it built.
  if (avlHandle) {
    const version = avlHandle.storage.versionAtOrBeforeHeight(forkHeight);
    if (!version) {
      throw new MissingStateVersionError('reorg', forkHeight);
    }
    const kept = avlHandle.recentRoots.get(forkHeight);
    if (kept !== null && versionDescribesKept(version, kept)) {
      avlHandle.prover.prover.restoreRoot(kept.root, kept.treeHeight);
    } else {
      avlHandle.prover.rollback(version);
      avlHandle.recentRoots.clear();
    }
  }

  // Phase 2: re-insert reverted txs to mempool, lowest height first.
  //
  // A post rides its own transaction, so re-inserting the transactions
  // re-inserts the posts. `journal.confirmedPostIds` is the un-confirm half
  // of the rollback and not a mempool key (NODE_INTERFACE → Block Journal).
  // Ascending order re-pools a predecessor before its dependent, so the fill
  // preserves the ordering rule at apply (NODE_INTERFACE → Block finalization).
  const newTipHeight = forkHeight + newHashes.length;
  const mempoolExpiry = newTipHeight + MEMPOOL_EXPIRY_BLOCKS;
  for (const journal of [...revertedJournals].reverse()) {
    // Re-insert UTXO txs
    for (const txRecord of journal.appliedUtxoTxs) {
      const tx = decodeTx(txRecord.txBytes);
      // MEMPOOL_INTERFACE → Validity ceiling — the reorg caller screens.
      const ceiling = ceilingOf(tx);
      if (ceiling !== null && ceiling < newTipHeight) {
        console.warn(`Reorg re-insertion skipped, past ceiling ${ceiling} at height ${newTipHeight}: tx ${txRecord.txId}`);
        continue;
      }
      reinsert(() => insertUtxoTx(tx, mempoolExpiry), `tx ${txRecord.txId}`);
    }
  }

  // Phase 3: apply new chain — through the classified entry
  // (NODE_INTERFACE → Fork choice decides on verified headers → "The switch."). Each
  // staged body is read out of `staged_blocks` one at a time and unstaged on
  // apply; one block body is in memory at a time
  // (NODE_INTERFACE → Fork choice decides on verified headers → "A bound
  // block is staged, and applied from staging.").
  for (let i = 0; i < newHashes.length; i++) {
    const hash = newHashes[i]!;
    const expectedHeight = forkHeight + 1 + i;
    const staged = getStagedBlock(hash);
    if (staged === null) {
      throw new MissingStagedBlockError('reorg', expectedHeight, hash);
    }
    const block = staged.block;
    const verdict = applyOrderingBlockVerdict(block);
    if (!verdict.applied) {
      if (verdict.class === 'consensus') {
        throw new ReorgBlockRejectedError(block.header.height, hash);
      }
      throw new ReorgAbortedError(block.header.height, hash, verdict.class, verdict.detail);
    }
    unstageBlock(hash);
    appliedWithIndexed.push({ block, indexed: verdict.indexed });
  }
    })();
  } catch (err) {
    // better-sqlite3 has already rolled the transaction back (chain, boxes,
    // AVL storage rows — the pre-reorg version row this restore targets is
    // back in place). Restore the in-memory prover, then rethrow: callers'
    // error semantics are unchanged.
    restoreProver();
    throw err;
  }

  // NODE_INTERFACE → Triggers → "The template is voided at the commit that
  // moves the tip, and nowhere else".
  clearTemplate();

  // Net's relay gate, re-seeded from the store the reorg committed
  // (NODE_INTERFACE → Post transactions → "The set moves after a commit, never
  // inside a transaction").
  getNet()?.setKarmaMembers(getKarmaOwners());

  // NODE_INTERFACE → "What follows the commit is the commit's": for each
  // applied block, in order, `emitPostIndexed` and the applied log line
  // (`announceAppliedBlock`), then the placeholder registrations the block
  // produced (NODE_INTERFACE → Store Interface → Posts DAG → "Backfill after
  // sync"). The query answers what the transaction committed, less what a
  // later block of the same reorg withdrew.
  for (const { block, indexed } of appliedWithIndexed) {
    announceAppliedBlock(block, indexed);
    for (const p of getPlaceholdersAt(block.header.height)) {
      registerPlaceholder(p.id, p.contentHash, block.header.height, '');
    }
  }

  // NODE_INTERFACE → Admin Listener: the tip the reorg left.
  noteTip(forkHeight + newHashes.length);
  // net learns of the reorg's tip at the same seam, so a version boundary can
  // sweep peers below the new era (NET_INTERFACE → API).
  getNet()?.tipApplied(forkHeight + newHashes.length);

  // A reorg is one tip move, however many blocks it applies. The per-block
  // rebuild inside `applyOrderingBlock` stands down while nested in the
  // transaction above, so a miner node's template is built once, here, against
  // the chain that committed (MINING_INTERFACE → Template and submit).
  rebuildTemplate();
}

