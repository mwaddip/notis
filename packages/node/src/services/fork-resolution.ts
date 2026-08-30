import { blockHash, cumulativeWork, level, verifyHeaderChain } from '@dagsocial/validation';
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
  deleteOrderingBlock,
  unconsumeBox,
  deleteBox,
  unconfirmPost,
  restorePostRows,
  clearWithdrawal,
  clearPrunedTopology,
  deleteStump,
  deleteLikeRecord,
  restoreLikeRecord,
  insertUtxoTx,
  rollbackBlockTopology,
  MempoolFullError,
  PendingSpendConflictError,
  TxTooLargeError,
  insertRefusedHeader,
  anyRefusedHeader,
  getInterlinks,
} from '../store/index.js';
import { ceilingOf } from './utxo-engine.js';
import { getDb } from '../store/db.js';
import { isBlockJournalOpen, type BlockJournal } from '../store/journal.js';
import { putIdentityRecord, deleteIdentityRecord, putNetworkRecord } from '../store/identity-records.js';
import { tryGetAvlProver } from '../state/avl-prover.js';
import { GENESIS_HEIGHT } from './genesis-state.js';
import { applyOrderingBlock } from './block-apply.js';
import { registerPlaceholder } from './backfill.js';
import { getPlaceholdersAt } from '../store/index.js';
import { noteTip } from '../metrics.js';
import { getNet } from './net-instance.js';
import { rebuildTemplate } from './block-creator.js';
import {
  CorruptChainStateError,
  MissingStoredBlockError,
  MissingJournalError,
  MissingStateVersionError,
  UnhashableStoredHeaderError,
  ReorgBlockRejectedError,
} from './corrupt-state.js';
import { retargetParams, anchorCreatedAt as storedAnchorCreatedAt, nowMs } from './difficulty.js';
import { config } from '../config.js';

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
  // Revert must never run while a journal is recording: the mutation replay
  // uses the never-recording inverses, but the vouch-cooldown restores below
  // go through recording primitives and would journal themselves into the
  // open block's log.
  if (isBlockJournalOpen()) {
    throw new Error(`revertBlock(${height}): a block journal is open`);
  }
  const journal = getBlockJournal(height);
  if (!journal) {
    throw new MissingJournalError('revertBlock', height);
  }

  // 1. Replay the primitive mutation log in reverse: box/insert → deleteBox,
  // box/remove → unconsumeBox, record → restore `replaced` or delete. This
  // restores the exact pre-block committed state for every mutation class —
  // including the pre-existing boxes merge-consumed inside settlement outputs,
  // tallied like boxes, prune settlement, and identity records.
  //
  // Reverse order is what makes a record written **more than once in one block**
  // (activity bump then decay, at the same height) revert correctly: each
  // inverse undoes one write, and the last one replayed is the *first* write's
  // `replaced` — the true pre-block value. A per-key single restore keeping the
  // last `replaced` would restore an intra-block intermediate instead.
  //
  // `putIdentityRecord` is itself a recording primitive, exactly like the
  // like-record restores two loops below. That is safe only because this
  // function refuses to run while a journal is open (the guard at the top); the
  // guard is the mechanism, not a non-recording variant.
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
    } else if (m.op === 'insert') {
      deleteBox(m.boxId);
    } else {
      unconsumeBox(m.boxId);
    }
  }

  // 2. Side-record inverses
  for (const postId of journal.confirmedPostIds) {
    unconfirmPost(postId);
  }
  // Like-record inverses. Order between the two arrays is immaterial:
  // a record cannot be both inserted and prune-deleted in one block — the
  // same-block exclusion (prune settles before embedded txs, so a like on a
  // post the block also prunes finds a stump and the block is rejected) —
  // so the two sets are disjoint by construction.
  for (const ins of journal.likeRecordInsertions) {
    deleteLikeRecord(ins.targetPostId, ins.likerId);
  }
  for (const del of journal.likeRecordDeletions) {
    restoreLikeRecord(del.targetPostId, del.likerId, del.appliedAtBlock);
  }
  // Prune inverses: restore deleted post rows, remove the stump.
  if (journal.deletedPosts.length > 0) {
    restorePostRows(journal.deletedPosts);
  }
  for (const stump of journal.insertedStumps) {
    deleteStump(stump.rootPostHash);
  }
  // Withdrawal inverses: restore content and clear the marker.
  for (const wp of journal.withdrawnPosts ?? []) {
    clearWithdrawal(wp.id, wp.content);
  }
  // Prune topology inverses: clear the pruned marks.
  if ((journal.prunedTopologyRows ?? []).length > 0) {
    clearPrunedTopology(journal.prunedTopologyRows!);
  }
  // ⛔ **The vouch escrow needs no side-record and no inverse of its own.** It
  // is a box, so `insertBox`/`consumeBox` journal its creation and its spend as
  // `{kind:'box'}` with the exact inverses loop 1 above already replays — and
  // boxes are not keyed, so a second escrow is a second box rather than an
  // overwrite something has to restore.

  // 3. Roll back block_topology entries, delete block + journal + the
  // height's AVL version rows. The version rows are per-block derived state
  // exactly like the block and journal rows: left behind, they make
  // versionAtOrBeforeHeight resolve rolled-back state, and re-applying a
  // block at this height (reorg back to a previously-reverted chain) would
  // re-insert the same content-addressed version and trip its PRIMARY KEY —
  // the funnel's totality catch would then reject every re-applied block.
  rollbackBlockTopology(height);
  deleteOrderingBlock(height);
  deleteBlockJournal(height);
  tryGetAvlProver()?.storage.deleteVersionAtHeight(height);
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
  // prover's in-memory state: the per-block funnel restore only covers the
  // failing block, not the fork-point rollback plus the applied prefix. So the
  // reorg snapshots the digest before anything is reverted and restores it on
  // abort (mirrors the apply funnel's restoreProver).
  const avlHandle = tryGetAvlProver();
  const preDigest = avlHandle ? avlHandle.prover.digest() : null;
  const restoreProver = (): void => {
    if (!avlHandle || !preDigest) return;
    const current = avlHandle.prover.digest();
    if (current && Buffer.from(current).equals(Buffer.from(preDigest))) return;
    avlHandle.prover.rollback(preDigest);
  };
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

  // Phase 1b: roll back AVL prover to fork point.
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
  if (avlHandle) {
    const version = avlHandle.storage.versionAtOrBeforeHeight(forkHeight);
    if (!version) {
      throw new MissingStateVersionError('reorg', forkHeight);
    }
    avlHandle.prover.rollback(version);
  }

  // Phase 2: re-insert reverted txs to mempool.
  //
  // A post rides its own transaction, so re-inserting the transactions
  // re-inserts the posts. `journal.confirmedPostIds` is the un-confirm half
  // of the rollback and not a mempool key (NODE_INTERFACE → Block Journal).
  const newTipHeight = forkHeight + newBlocks.length;
  const mempoolExpiry = newTipHeight + MEMPOOL_EXPIRY_BLOCKS;
  for (const journal of revertedJournals) {
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

  // Phase 3: apply new chain
  for (const block of newBlocks) {
    if (!applyOrderingBlock(block)) {
      const hash = blockHash(block.header) ?? 'unhashable';
      throw new ReorgBlockRejectedError(block.header.height, hash);
    }
    for (const p of getPlaceholdersAt(block.header.height)) {
      registerPlaceholder(p.id, p.contentHash, block.header.height, '');
    }
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

// ---------------------------------------------------------------------------
// resolveFork — the decision, step by step
// ---------------------------------------------------------------------------

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
): Promise<void> {
  const currentHeight = getCurrentHeight();

  console.log(
    `Fork detected: our height=${currentHeight}, ` +
    `competing block height=${block.header.height}`,
  );

  // 1. Counterparty — Active peers only (see `ForkResolutionNet`).
  const peers = net.getConnectedPeers();
  if (peers.length === 0) {
    console.warn('Fork resolution failed: no connected peers');
    return;
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
        return;
      }
    }

    // 3. The fork walk — page down from ourTip
    // (NODE_INTERFACE → Fork choice decides on verified headers, step 3).
    //
    // Each page is hashed in full before any of it is matched: an unhashable
    // header anywhere in the page refuses the page whole (`misbehavior`), and
    // never falls through to genesis. Hashing only until the first match
    // would let the peer choose where the poison sits relative to the match,
    // which is the peer's choice again.
    const maxReorgDepth = config.maxReorgDepth;
    const lowestExamined = Math.max(currentHeight - maxReorgDepth + 1, 1);
    let forkHeight: number | null = null;
    const allForkWalkHeaders: BlockHeader[] = [];
    let requestStart = currentHeight;

    forkWalk: while (requestStart >= lowestExamined) {
      const page = await net.requestHeaders(requestStart, MAX_CHAIN_RESPONSE_ITEMS, peerId);
      if (page.length === 0) {
        console.warn('Fork resolution failed: no headers from peer');
        return;
      }

      // Hash the whole page first — one unhashable entry refuses it.
      const pageHashes: Array<{ header: BlockHeader; hash: string }> = [];
      for (let i = 0; i < page.length; i++) {
        const h = blockHash(page[i]!);
        if (h === null) {
          console.warn(
            `Fork resolution: unhashable header in fork-walk page at index ${i}, ` +
            `penalising peer ${peerId} (misbehavior)`,
          );
          net.penalizePeer(peerId, 'misbehavior', `unhashable header in fork-walk page at index ${i}`);
          return;
        }
        pageHashes.push({ header: page[i]!, hash: h });
      }

      // Now match — heights above ourTip cannot occur (the request starts there).
      for (const { header, hash } of pageHashes) {
        if (header.height > currentHeight) {
          throw new Error(
            `Fork walk: peer served header at height ${header.height} above ` +
            `our tip ${currentHeight} — the request started there`,
          );
        }
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

      const lowestSeen = page.reduce(
        (min, hdr) => Math.min(min, hdr.height),
        page[0]!.height,
      );
      requestStart = lowestSeen - 1;
    }

    if (forkHeight === null) {
      if (currentHeight <= maxReorgDepth) {
        // NODE_INTERFACE → Fork resolution bottoms out at the genesis state.
        forkHeight = GENESIS_HEIGHT;
      } else {
        console.warn(
          `Fork resolution failed: no common ancestor within ${maxReorgDepth} blocks`,
        );
        return;
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

    // ourWork — once, through `getHeadersAbove` (NODE_INTERFACE → Fork choice
    // decides on verified headers, step 4; NODE_INTERFACE → Store Interface →
    // Ordering blocks). Not the NiPoPoW prover's `getHeadersAfter`, which is
    // capped at `MAX_NIPOPOW_PARAM` (128) — the walk needs every header above
    // the fork, up to `maxReorgDepth`.
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
          return;
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
        return;
      }

      // 6. Memory — any verified hash in refused_headers, per page.
      if (anyRefusedHeader(verdict.hashes)) {
        console.warn(
          `Fork resolution: scoring page contains a previously refused header, ` +
          `penalising peer ${peerId}`,
        );
        net.penalizePeer(peerId, 'misbehavior', 'served a chain containing a refused header');
        return;
      }

      allVerifiedHashes.push(...verdict.hashes);
      theirWork += verdict.work;
      anchor = verdict.next;
      t_a = verdict.next.t_a;

      // 7. Work — the stop rules
      // (NODE_INTERFACE → Fork choice decides on verified headers, step 7).
      if (theirWork > ourWork) break;

      // Our tip moved between pages → abort, no penalty.
      if (getCurrentHeight() !== currentHeight) {
        console.warn(
          `Tip changed during fork resolution scoring ` +
          `(was ${currentHeight}, now ${getCurrentHeight()}), aborting`,
        );
        return;
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
      return;
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
        return;
      }

      for (let i = 0; i < page.length; i++) {
        const expectedHeight = blockStart + i;
        if (page[i]!.header.height !== expectedHeight) {
          console.warn(
            `Fork resolution: block height ${page[i]!.header.height} at index ${i} ` +
            `does not match expected ${expectedHeight}, penalising (misbehavior)`,
          );
          net.penalizePeer(peerId, 'misbehavior', `block height mismatch at index ${i}`);
          return;
        }
        const deliveredHash = blockHash(page[i]!.header);
        const hashIndex = expectedHeight - forkHeight - 1;
        if (deliveredHash !== allVerifiedHashes[hashIndex]) {
          console.warn(
            `Fork resolution: block at height ${expectedHeight} hash mismatch, ` +
            `penalising peer ${peerId} (misbehavior)`,
          );
          net.penalizePeer(peerId, 'misbehavior', `block identity mismatch at height ${expectedHeight}`);
          return;
        }
      }

      allBlocks.push(...page);
      blockStart += page.length;
    }

    // 9. Tip re-read.
    const heightNow = getCurrentHeight();
    if (heightNow !== currentHeight) {
      console.warn(
        `Tip changed during fork resolution ` +
        `(was ${currentHeight}, now ${heightNow}), aborting reorg`,
      );
      return;
    }

    // 10. The switch — nothing awaits between the re-read and this call.
    reorg(forkHeight, allBlocks);
    console.log(`Reorg complete: new tip at height=${forkHeight + n}`);
  } catch (err) {
    // 11. The mark — after the rollback, in its own write.
    if (err instanceof ReorgBlockRejectedError) {
      insertRefusedHeader(err.hash, err.height, getCurrentHeight());
      net.penalizePeer(peerId, 'misbehavior', `reorg rejected block at height ${err.height}`);
      console.warn(`Fork resolution: reorg rejected block at height ${err.height} (${err.hash}), marked and penalised`);
      return;
    }
    if (err instanceof CorruptChainStateError) throw err;
    console.warn(`Fork resolution error: ${String(err)}`);
  }
}
