import {
  blockHash,
  cumulativeWork,
  level,
  verifyHeaderChain,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyValidatorSignature,
} from '@dagsocial/validation';
import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import {
  decodeTx,
  GENESIS_PREV_BLOCK_HASH,
  MEMPOOL_EXPIRY_BLOCKS,
  updateInterlinks,
} from '@dagsocial/types';
import { MAX_CHAIN_RESPONSE_ITEMS } from '@dagsocial/net';
import {
  getOrderingBlock,
  getCurrentHeight,
  getOrderingBlockHash,
  getHeadersAbove,
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
  insertRefusedHeader,
  anyRefusedHeader,
  getInterlinks,
  getKarmaOwners,
  getLowestJournalHeight,
} from '../store/index.js';
import { ceilingOf } from '@dagsocial/consensus';
import { getDb } from '../store/db.js';
import type { BlockJournal } from '../store/journal.js';
import { putIdentityRecord, deleteIdentityRecord, putNetworkRecord } from '../store/identity-records.js';
import { putUsername, deleteUsername } from '../store/usernames.js';
import { tryGetAvlProver } from '../state/avl-prover.js';
import type { KeptRoot } from '../state/recent-roots.js';
import { label } from '@dagsocial/avltree';
import { GENESIS_HEIGHT } from './genesis-state.js';
import { announceAppliedBlock, applyOrderingBlockVerdict } from './block-apply.js';
import type { IndexedPost } from './block-apply.js';
import { registerPlaceholder } from './backfill.js';
import { getPlaceholdersAt } from '../store/index.js';
import { noteTip } from '../metrics.js';
import { getNet } from './net-instance.js';
import { clearTemplate, rebuildTemplate } from './block-creator.js';
import {
  CorruptChainStateError,
  MissingStoredBlockError,
  MissingJournalError,
  MissingStateVersionError,
  UnhashableStoredHeaderError,
  ReorgBlockRejectedError,
  ReorgAbortedError,
} from './corrupt-state.js';
import { retargetParams, anchorCreatedAt as storedAnchorCreatedAt, nowMs } from './difficulty.js';
import { config } from '../config.js';

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
 * The hash of a header from our own chain.
 *
 * `blockHash` answers `null` for a header outside the encodable domain,
 * and no *stored* header can be one: the ordering store's one writer sits
 * downstream of the header-domain gate, so every stored header cleared
 * `verifyHeaderFieldDomains` (the provenance is stated on `store/ordering.ts`'s
 * `createOrderingBlock`). So a `null` here is not a rejection to absorb — it
 * is our own chain having become something apply could never have written, and
 * every fork-choice answer computed from it would be computed from state we
 * cannot hash. Say so and stop, rather than returning a verdict we have no basis
 * for.
 */
function ourChainHash(header: BlockHeader, site: string): string {
  const hash = blockHash(header);
  if (hash === null) {
    throw new UnhashableStoredHeaderError(site, header.height);
  }
  return hash;
}

/**
 * Does this block extend our current canonical tip?
 */
export function extendsOurTip(block: OrderingBlock): boolean {
  const ourTip = getOrderingBlock(getCurrentHeight());
  if (!ourTip) return false;
  return block.header.prevBlockHash === ourChainHash(ourTip.header, 'extendsOurTip');
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
 * Reorg: revert our chain from currentHeight down to forkHeight+1,
 * then apply the competing chain forward.
 */
export function reorg(forkHeight: number, newBlocks: OrderingBlock[]): void {
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
  const newTipHeight = forkHeight + newBlocks.length;
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
  // (NODE_INTERFACE → Fork choice decides on verified headers, step 10). Each
  // applied block's verdict carries the posts it first stored, held with the
  // block for the post-commit `announceAppliedBlock` and `registerPlaceholder`
  // loop below (NODE_INTERFACE → "What follows the commit is the commit's";
  // NODE_INTERFACE → Store Interface → Posts DAG → "Backfill after sync").
  for (const block of newBlocks) {
    const verdict = applyOrderingBlockVerdict(block);
    if (!verdict.applied) {
      const hash = blockHash(block.header) ?? 'unhashable';
      if (verdict.class === 'consensus') {
        throw new ReorgBlockRejectedError(block.header.height, hash);
      }
      throw new ReorgAbortedError(block.header.height, hash, verdict.class, verdict.detail);
    }
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
  noteTip(forkHeight + newBlocks.length);
  // net learns of the reorg's tip at the same seam, so a version boundary can
  // sweep peers below the new era (NET_INTERFACE → API).
  getNet()?.tipApplied(forkHeight + newBlocks.length);

  // A reorg is one tip move, however many blocks it applies. The per-block
  // rebuild inside `applyOrderingBlock` stands down while nested in the
  // transaction above, so a miner node's template is built once, here, against
  // the chain that committed (MINING_INTERFACE → Template and submit).
  rebuildTemplate();
}

// ---------------------------------------------------------------------------
// ForkResolutionNet — the net surface fork resolution uses
// ---------------------------------------------------------------------------

/**
 * The `net` surface fork resolution uses, structurally rather than as
 * `NetNode`. These four calls are the whole dependency, and naming them is
 * what lets a test drive `resolveFork` against a stub peer — `reorg` and
 * `revertBlock` are reachable from a test on their own; the decision that calls
 * them is not.
 *
 * **`getConnectedPeers`, not `peers`, and the distinction decides a reorg.**
 * `peers()` lists every *known* peer, including ones that have not completed —
 * or have failed — the DAGsocial handshake; only `getConnectedPeers()` filters
 * on Active. A peer that failed the handshake is on another network, and a
 * counterparty chosen off the wrong list can revert this node's entire chain:
 * below `maxReorgDepth` the fork walk reaches the genesis state, so a stranger
 * with more work wins at height 0.
 */
export interface ForkResolutionNet {
  getConnectedPeers(): string[];
  requestHeaders(startHeight: number, maxCount: number, peerId: string): Promise<BlockHeader[]>;
  requestBlocks(startHeight: number, endHeight: number, peerId: string): Promise<OrderingBlock[]>;
  penalizePeer(peerId: string, kind: 'misbehavior' | 'transient', reason: string): void;
  peerTipHeight(peerId: string): number | null;
}

// ---------------------------------------------------------------------------
// Re-score memo (NODE_INTERFACE → "Re-scoring is memoised")
// ---------------------------------------------------------------------------

const forkResolutionMemo = new Map<string, { theirTip: number; atOurTip: number }>();

export function resetForkResolutionMemo(): void {
  forkResolutionMemo.clear();
}

/**
 * NODE_INTERFACE → "Re-scoring is memoised": the memo entry a peer owns
 * leaves with it on disconnect. The runner's own disconnect hook calls this.
 */
export function dropForkResolutionMemoForPeer(peerId: string): void {
  forkResolutionMemo.delete(peerId);
}

// ---------------------------------------------------------------------------
// resolveFork — the decision, step by step
// ---------------------------------------------------------------------------

/**
 * NODE_INTERFACE → Fork choice decides on verified headers →
 * "A resolution that ends because the tip moved hands its own block back the same way"
 * and → "A resolution that ends in a switch hands its own block back too". The
 * runner reads this to decide whether to hand the resolution's own block back
 * for a second judgment: `'tip-moved'` names step 7's between-pages re-read and
 * step 9's, `'switched'` names the one path that completes `reorg(…)`, and
 * `'done'` names every other end.
 */
export type ResolveForkOutcome = 'done' | 'tip-moved' | 'switched';

/**
 * Decide a fork against one peer and, if their chain wins, switch to it.
 *
 * The decision order follows NODE_INTERFACE → Fork choice decides on verified
 * headers, step by step. `reorg` is the mechanism that carries out a decision
 * already made.
 */
export async function resolveFork(
  block: OrderingBlock,
  net: ForkResolutionNet,
  fromPeerId: string,
): Promise<ResolveForkOutcome> {
  const currentHeight = getCurrentHeight();
  // NODE_INTERFACE → Fork choice decides on verified headers, step 9: the
  // tip the resolution reads at its start is a height AND a hash, so a chain
  // switched at the same height is a tip that moved exactly as a growth to a
  // new height is. At height 0 there is no block to hash, and extendsOurTip's
  // path handles every height-0 case ahead of this function.
  const currentHash = currentHeight > 0 ? getOrderingBlockHash(currentHeight) : null;

  console.log(
    `Fork detected: our height=${currentHeight}, ` +
    `competing block height=${block.header.height}`,
  );

  // 1. Counterparty — Active peers only (see `ForkResolutionNet`).
  const peers = net.getConnectedPeers();
  if (peers.length === 0) {
    console.warn('Fork resolution failed: no connected peers');
    return 'done';
  }
  const peerId = peers.includes(fromPeerId) ? fromPeerId : peers[0]!;

  try {
    // 2. The memo (NODE_INTERFACE → "Re-scoring is memoised").
    const memo = forkResolutionMemo.get(peerId);
    const peerTip = net.peerTipHeight(peerId);
    if (memo) {
      if (memo.atOurTip !== currentHeight) {
        forkResolutionMemo.delete(peerId);
      } else if (peerTip !== null && memo.theirTip === peerTip) {
        return 'done';
      }
    }

    // 3. The fork walk — page down from ourTip
    // (NODE_INTERFACE → Fork choice decides on verified headers, step 3).
    // NODE_INTERFACE → "The walk reaches as deep as the journals do, and no deeper":
    // the walk is bounded by `lowestJournal − 1` and the genesis fall-through
    // is gated on `lowestJournal ≤ 1`. `lowestJournal` is read once beside the
    // tip; a null answer (no journal kept) is treated as `currentHeight + 1`,
    // which collapses the bound to the depth cap alone.
    const maxReorgDepth = config.maxReorgDepth;
    const lowestJournalRow = getLowestJournalHeight();
    const lowestJournal = lowestJournalRow ?? currentHeight + 1;
    const lowestExamined = Math.max(
      currentHeight - maxReorgDepth + 1,
      lowestJournal - 1,
      1,
    );
    let forkHeight: number | null = null;
    const allForkWalkHeaders: BlockHeader[] = [];
    let requestStart = currentHeight;
    const maxPages = Math.ceil(maxReorgDepth / MAX_CHAIN_RESPONSE_ITEMS);
    let pageCount = 0;

    forkWalk: while (requestStart >= lowestExamined) {
      const page = await net.requestHeaders(requestStart, MAX_CHAIN_RESPONSE_ITEMS, peerId);
      if (page.length === 0) {
        console.warn('Fork resolution failed: no headers from peer');
        return 'done';
      }

      // NET_INTERFACE → `GetHeaders` / `GetBlocks` responses: a page has
      // one shape, and the requester holds a page to it.
      if (page[0]!.height > requestStart) {
        net.penalizePeer(peerId, 'misbehavior',
          `fork-walk page: height ${page[0]!.height} above the requested start ${requestStart}`);
        return 'done';
      }
      for (let i = 1; i < page.length; i++) {
        const expected = page[i - 1]!.height - 1;
        const actual = page[i]!.height;
        if (actual !== expected) {
          const fault = actual > page[i - 1]!.height ? 'ascent'
            : actual === page[i - 1]!.height ? 'repeat'
            : 'hole';
          net.penalizePeer(peerId, 'misbehavior',
            `fork-walk page: ${fault} at height ${actual} (expected ${expected})`);
          return 'done';
        }
      }
      const lowestInPage = page[page.length - 1]!.height;
      if (page.length < MAX_CHAIN_RESPONSE_ITEMS && lowestInPage > 1) {
        net.penalizePeer(peerId, 'transient',
          `fork-walk page: short page (${page.length} headers, lowest height ${lowestInPage})`);
        return 'done';
      }

      pageCount++;
      if (pageCount > maxPages) {
        throw new Error(
          `Fork walk exceeded ${maxPages} pages — every accepted page moves ` +
          `the start by ${MAX_CHAIN_RESPONSE_ITEMS}, so this is unreachable`);
      }

      // Each accepted page is hashed in full before any of it is matched:
      // an unhashable header anywhere in the page refuses the page whole
      // (`misbehavior`), and never falls through to genesis. Hashing only
      // until the first match would let the peer choose where the poison
      // sits relative to the match, which is the peer's choice again.
      const pageHashes: Array<{ header: BlockHeader; hash: string }> = [];
      for (let i = 0; i < page.length; i++) {
        const h = blockHash(page[i]!);
        if (h === null) {
          console.warn(
            `Fork resolution: unhashable header in fork-walk page at index ${i}, ` +
            `penalising peer ${peerId} (misbehavior)`,
          );
          net.penalizePeer(peerId, 'misbehavior', `unhashable header in fork-walk page at index ${i}`);
          return 'done';
        }
        pageHashes.push({ header: page[i]!, hash: h });
      }

      for (const { header, hash } of pageHashes) {
        if (header.height < lowestExamined) continue;

        // A null from getOrderingBlockHash at 1 ≤ h ≤ ourTip is the
        // contiguity invariant broken — fail-stop rather than reading it
        // as "no match".
        const ourHash = getOrderingBlockHash(header.height);
        if (ourHash === null && header.height >= 1 && header.height <= currentHeight) {
          throw new MissingStoredBlockError('forkWalk', header.height);
        }
        if (ourHash !== null && ourHash === hash) {
          forkHeight = header.height;
          break forkWalk;
        }

        allForkWalkHeaders.push(header);
      }

      requestStart = lowestInPage - 1;
    }

    if (forkHeight === null) {
      // NODE_INTERFACE → Fork choice decides on verified headers, step 3:
      // the fork walk answers genesis only when the tip is at or below the
      // horizon AND the journals still reach height 1. The journals clause is
      // why a tip that dropped below the horizon from above never reaches
      // genesis — the walk stops at the lowest journal.
      if (currentHeight <= maxReorgDepth && lowestJournal <= 1) {
        // NODE_INTERFACE → Fork resolution bottoms out at the genesis state.
        forkHeight = GENESIS_HEIGHT;
      } else {
        console.warn(
          `Fork resolution failed: no common ancestor within ${maxReorgDepth} blocks`,
        );
        return 'done';
      }
    }

    // 4. The anchor and our work
    // (NODE_INTERFACE → Fork choice decides on verified headers, step 4).
    let anchorPrevBlockHash: string;
    let anchorInterlinks: string[];
    let anchorCreatedAt: number | null;
    if (forkHeight === 0) {
      anchorPrevBlockHash = GENESIS_PREV_BLOCK_HASH;
      anchorInterlinks = [];
      anchorCreatedAt = null;
    } else {
      const forkBlock = getOrderingBlock(forkHeight);
      if (!forkBlock) throw new MissingStoredBlockError('resolveFork anchor', forkHeight);
      anchorPrevBlockHash = ourChainHash(forkBlock.header, 'resolveFork anchor');
      anchorCreatedAt = forkBlock.header.createdAt;
      const storedInterlinks = getInterlinks(forkHeight);
      if (storedInterlinks === null) {
        throw new UnhashableStoredHeaderError('resolveFork/interlinks', forkHeight);
      }
      const forkLevel = level(forkBlock.header, config.orderingBlockPowTargetBits);
      anchorInterlinks = updateInterlinks(
        storedInterlinks, anchorPrevBlockHash, forkLevel,
      );
    }
    let anchor = {
      prevBlockHash: anchorPrevBlockHash,
      height: forkHeight,
      interlinks: anchorInterlinks,
      createdAt: anchorCreatedAt,
    };

    // ourWork — once, through `getHeadersAbove`, which the caller bounds at
    // `ourTip − f ≤ maxReorgDepth` (NODE_INTERFACE → Ordering blocks).
    const ourHeaders = getHeadersAbove(forkHeight, currentHeight - forkHeight);
    const ourWork = cumulativeWork(ourHeaders);

    // 5. The scoring walk — upward in pages, fetch → verify → stop rules
    // (NODE_INTERFACE → Fork choice decides on verified headers, step 5).
    //
    // The fork walk's pages already hold headers f+1 … min(ourTip, theirTip)
    // in descending order; reverse to chronological for the first scoring page.
    let theirWork = 0n;
    const allVerifiedHashes: string[] = [];
    let t_a = forkHeight === 0 ? null : storedAnchorCreatedAt();
    const params = retargetParams();

    const forkWalkAboveFork = allForkWalkHeaders
      .filter(h => h.height > forkHeight)
      .sort((a, b) => a.height - b.height);

    // Slice the residual into ≤ MAX_CHAIN_RESPONSE_ITEMS pages so the
    // "page-aligned, at most 399 blocks past the shortest heavier prefix"
    // bound holds for the residual too.
    const residualPages: BlockHeader[][] = [];
    for (let i = 0; i < forkWalkAboveFork.length; i += MAX_CHAIN_RESPONSE_ITEMS) {
      residualPages.push(forkWalkAboveFork.slice(i, i + MAX_CHAIN_RESPONSE_ITEMS));
    }

    let topScored = forkHeight;
    let residualIndex = 0;

    // One loop: get a page (or use the fork walk's residual), verify, stop rules.
    while (true) {
      let page: BlockHeader[];

      if (residualIndex < residualPages.length) {
        page = residualPages[residualIndex]!;
        topScored = page[page.length - 1]!.height;
        residualIndex++;
      } else {
        const requestH = topScored + MAX_CHAIN_RESPONSE_ITEMS;
        const raw = await net.requestHeaders(requestH, MAX_CHAIN_RESPONSE_ITEMS, peerId);
        const trimmed = raw.filter(h => h.height > topScored);
        if (trimmed.length === 0) break;

        page = trimmed.sort((a, b) => a.height - b.height);
        topScored = page[page.length - 1]!.height;
      }

      // Verify this page (VALIDATION_INTERFACE → verifyHeaderChain).
      const verdict = verifyHeaderChain(page, anchor, params, t_a, nowMs(), config.protocolVersionSchedule);
      if (!verdict.ok) {
        if (verdict.reason === 'clock') {
          console.warn(
            `Fork resolution: future-bound refusal, no penalty ` +
            `(index=${verdict.index})`,
          );
          return 'done';
        }
        // A 'version' verdict is a compatibility refusal — the peer serves a
        // chain of another era — penalised transient, not misbehavior
        // (NODE_INTERFACE → Fork choice decides on verified headers).
        const tier = verdict.reason === 'version' ? 'transient' : 'misbehavior';
        console.warn(
          `Fork resolution: header verification failed ` +
          `(index=${verdict.index}, reason=${verdict.reason}), penalising peer ${peerId} (${tier})`,
        );
        net.penalizePeer(peerId, tier, `header verification: ${verdict.reason} at index ${verdict.index}`);
        return 'done';
      }

      // 6. Memory — any verified hash in refused_headers, per page.
      if (anyRefusedHeader(verdict.hashes)) {
        console.warn(
          `Fork resolution: scoring page contains a previously refused header, ` +
          `penalising peer ${peerId}`,
        );
        net.penalizePeer(peerId, 'misbehavior', 'served a chain containing a refused header');
        return 'done';
      }

      allVerifiedHashes.push(...verdict.hashes);
      theirWork += verdict.work;
      anchor = verdict.next;
      t_a = verdict.next.t_a;

      // 7. Work — the stop rules
      // (NODE_INTERFACE → Fork choice decides on verified headers, step 7).
      if (theirWork > ourWork) break;

      // Our tip moved between pages → abort, no penalty. The re-read compares
      // height AND the tip's hash: a chain switched at the same height is
      // "a tip that moved" exactly as a growth to a new height is.
      const heightBetween = getCurrentHeight();
      const hashBetween = heightBetween > 0 ? getOrderingBlockHash(heightBetween) : null;
      if (heightBetween !== currentHeight || hashBetween !== currentHash) {
        console.warn(
          `Tip changed during fork resolution scoring ` +
          `(was ${currentHeight}/${currentHash ?? 'genesis'}, ` +
          `now ${heightBetween}/${hashBetween ?? 'genesis'}), aborting`,
        );
        return 'tip-moved';
      }
    }

    const n = allVerifiedHashes.length;

    if (theirWork <= ourWork) {
      console.log(
        `Fork resolution: our chain has more or equal work ` +
        `(ours=${ourWork}, theirs=${theirWork}), ignoring`,
      );
      // Write memo on "keep ours" at their tip (step 7).
      if (peerTip !== null) {
        forkResolutionMemo.set(peerId, { theirTip: peerTip, atOurTip: currentHeight });
      }
      return 'done';
    }

    console.log(
      `Fork resolution: competing chain has more work ` +
      `(ours=${ourWork}, theirs=${theirWork}), reorging ${n} blocks...`,
    );

    // 8. Their blocks — paged
    // (NODE_INTERFACE → Fork choice decides on verified headers, step 8).
    const allBlocks: OrderingBlock[] = [];
    let blockStart = forkHeight + 1;
    const blockEnd = forkHeight + n;
    while (blockStart <= blockEnd) {
      const page = await net.requestBlocks(blockStart, blockEnd, peerId);
      if (page.length === 0) {
        console.warn(
          `Fork resolution: peer ${peerId} served no blocks from height ${blockStart}, ` +
          `penalising (transient)`,
        );
        net.penalizePeer(peerId, 'transient', `empty block page from height ${blockStart}`);
        return 'done';
      }

      for (let i = 0; i < page.length; i++) {
        const expectedHeight = blockStart + i;
        if (page[i]!.header.height !== expectedHeight) {
          console.warn(
            `Fork resolution: block height ${page[i]!.header.height} at index ${i} ` +
            `does not match expected ${expectedHeight}, penalising (misbehavior)`,
          );
          net.penalizePeer(peerId, 'misbehavior', `block height mismatch at index ${i}`);
          return 'done';
        }
        const deliveredHash = blockHash(page[i]!.header);
        const hashIndex = expectedHeight - forkHeight - 1;
        if (deliveredHash !== allVerifiedHashes[hashIndex]) {
          console.warn(
            `Fork resolution: block at height ${expectedHeight} hash mismatch, ` +
            `penalising peer ${peerId} (misbehavior)`,
          );
          net.penalizePeer(peerId, 'misbehavior', `block identity mismatch at height ${expectedHeight}`);
          return 'done';
        }
        // NODE_INTERFACE → Fork choice decides on verified headers →
        // "A served block is bound to its header before it is kept".
        // A hash that matches says the header is the verified one and
        // nothing of what arrived with it: each block then passes, in
        // order, structure, the body's root against the header's root
        // and the validator's signature. The first failure ends the
        // resolution — misbehavior, nothing reverted, nothing marked: the
        // peer served a block no node applied, and nothing here judges
        // the header.
        const structure = verifyOrderingBlockStructure(page[i]!);
        if (!structure.valid) {
          console.warn(
            `Fork resolution: served block at height ${expectedHeight} fails structure ` +
            `(${structure.error}), penalising peer ${peerId} (misbehavior)`,
          );
          net.penalizePeer(peerId, 'misbehavior', `served block structure at height ${expectedHeight}: ${structure.error}`);
          return 'done';
        }
        if (!verifyUtxoTxRoot(page[i]!)) {
          console.warn(
            `Fork resolution: served block at height ${expectedHeight} fails utxoTxRoot check, ` +
            `penalising peer ${peerId} (misbehavior)`,
          );
          net.penalizePeer(peerId, 'misbehavior', `served block utxoTxRoot at height ${expectedHeight}`);
          return 'done';
        }
        if (!verifyValidatorSignature(page[i]!.header, page[i]!.validatorSignature)) {
          console.warn(
            `Fork resolution: served block at height ${expectedHeight} fails validator signature check, ` +
            `penalising peer ${peerId} (misbehavior)`,
          );
          net.penalizePeer(peerId, 'misbehavior', `served block validatorSignature at height ${expectedHeight}`);
          return 'done';
        }
      }

      allBlocks.push(...page);
      blockStart += page.length;
    }

    // 9. Tip re-read — height AND hash
    // (NODE_INTERFACE → Fork choice decides on verified headers, step 9).
    const heightNow = getCurrentHeight();
    const hashNow = heightNow > 0 ? getOrderingBlockHash(heightNow) : null;
    if (heightNow !== currentHeight || hashNow !== currentHash) {
      console.warn(
        `Tip changed during fork resolution ` +
        `(was ${currentHeight}/${currentHash ?? 'genesis'}, ` +
        `now ${heightNow}/${hashNow ?? 'genesis'}), aborting reorg`,
      );
      return 'tip-moved';
    }

    // 10. The switch — nothing awaits between the re-read and this call.
    // NODE_INTERFACE → Fork choice decides on verified headers →
    // "A resolution that ends in a switch hands its own block back too":
    // the shortest heavier prefix can end below the block this resolution
    // started from, so a completed `reorg(…)` answers `'switched'` and the
    // runner hands the block back through the same seam a moved tip does.
    // NODE_INTERFACE → Fork choice decides on verified headers →
    // "A served block is bound to its header before it is kept": the
    // page loop above held each block to its header, so what the funnel
    // refuses here is bytes the header's hash commits.
    reorg(forkHeight, allBlocks);
    console.log(`Reorg complete: new tip at height=${forkHeight + n}`);
    return 'switched';
  } catch (err) {
    // NODE_INTERFACE → Fork choice decides on verified headers, step 10–11.
    if (err instanceof ReorgAbortedError) {
      if (err.class_ === 'acceptance') {
        console.warn(
          `Fork resolution: reorg aborted at height ${err.height} (${err.hash}), ` +
          `class=acceptance — no mark, no penalty`,
        );
      } else {
        console.error(
          `Fork resolution: reorg aborted at height ${err.height} (${err.hash}), ` +
          `class=local: ${err.detail ?? '(no detail)'}`,
        );
      }
      return 'done';
    }
    // 11. The mark — after the rollback, in its own write.
    // NODE_INTERFACE → Fork choice decides on verified headers →
    // "A served block is bound to its header before it is kept": step 8
    // kept only blocks that are their headers', so the consensus refusal
    // the funnel raised is of bytes the header's hash commits, and the
    // mark on the header is a verdict on those bytes.
    if (err instanceof ReorgBlockRejectedError) {
      insertRefusedHeader(err.hash, err.height, getCurrentHeight());
      net.penalizePeer(peerId, 'misbehavior', `reorg rejected block at height ${err.height}`);
      console.warn(`Fork resolution: reorg rejected block at height ${err.height} (${err.hash}), marked and penalised`);
      return 'done';
    }
    if (err instanceof CorruptChainStateError) throw err;
    console.warn(`Fork resolution error: ${String(err)}`);
    return 'done';
  }
}
