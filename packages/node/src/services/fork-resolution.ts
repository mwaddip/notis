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
  getHeadersAfter,
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
  if (isBlockJournalOpen()) {
    throw new Error(`revertBlock(${height}): a block journal is open`);
  }
  const journal = getBlockJournal(height);
  if (!journal) {
    throw new MissingJournalError('revertBlock', height);
  }

  // 1. Replay the primitive mutation log in reverse: box/insert → deleteBox,
  // box/remove → unconsumeBox, record → restore `replaced` or delete.
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
  for (const ins of journal.likeRecordInsertions) {
    deleteLikeRecord(ins.targetPostId, ins.likerId);
  }
  for (const del of journal.likeRecordDeletions) {
    restoreLikeRecord(del.targetPostId, del.likerId, del.appliedAtBlock);
  }
  if (journal.deletedPosts.length > 0) {
    restorePostRows(journal.deletedPosts);
  }
  for (const stump of journal.insertedStumps) {
    deleteStump(stump.rootPostHash);
  }
  for (const wp of journal.withdrawnPosts ?? []) {
    clearWithdrawal(wp.id, wp.content);
  }
  if ((journal.prunedTopologyRows ?? []).length > 0) {
    clearPrunedTopology(journal.prunedTopologyRows!);
  }

  // 3. Roll back block_topology, block, journal, AVL version.
  rollbackBlockTopology(height);
  deleteOrderingBlock(height);
  deleteBlockJournal(height);
  tryGetAvlProver()?.storage.deleteVersionAtHeight(height);
}

/**
 * Return a reverted entry to the mempool, tolerating the pool's own refusals
 * (NODE_INTERFACE → Fork choice decides on verified headers, step 10).
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

  const revertedJournals: BlockJournal[] = [];
  for (let h = currentHeight; h > forkHeight; h--) {
    const journal = getBlockJournal(h);
    if (journal) revertedJournals.push(journal);
    revertBlock(h);
  }

  // Roll back AVL prover to fork point (NODE_INTERFACE → Configuration).
  if (avlHandle) {
    const version = avlHandle.storage.versionAtOrBeforeHeight(forkHeight);
    if (!version) {
      throw new MissingStateVersionError('reorg', forkHeight);
    }
    avlHandle.prover.rollback(version);
  }

  const newTipHeight = forkHeight + newBlocks.length;
  const mempoolExpiry = newTipHeight + MEMPOOL_EXPIRY_BLOCKS;
  for (const journal of revertedJournals) {
    for (const txRecord of journal.appliedUtxoTxs) {
      const tx = decodeTx(txRecord.txBytes);
      const ceiling = ceilingOf(tx);
      if (ceiling !== null && ceiling < newTipHeight) {
        console.warn(`Reorg re-insertion skipped, past ceiling ${ceiling} at height ${newTipHeight}: tx ${txRecord.txId}`);
        continue;
      }
      reinsert(() => insertUtxoTx(tx, mempoolExpiry), `tx ${txRecord.txId}`);
    }
  }

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
    restoreProver();
    throw err;
  }

  noteTip(forkHeight + newBlocks.length);
  rebuildTemplate();
}

// ---------------------------------------------------------------------------
// ForkResolutionNet — the net surface fork resolution uses
// ---------------------------------------------------------------------------

/**
 * NODE_INTERFACE → Fork choice decides on verified headers.
 *
 * `getConnectedPeers`, not `peers` — Active peers only. A peer that failed
 * the handshake is on another network, and below `maxReorgDepth` the fork
 * walk reaches genesis (NODE_INTERFACE → Fork resolution bottoms out at the
 * genesis state).
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
 * NODE_INTERFACE → Fork choice decides on verified headers: each step that
 * ends the resolution ends it with the chain untouched.
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

  // 1. Counterparty — Active peers only.
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
    const maxReorgDepth = config.maxReorgDepth;
    const lowestExamined = Math.max(currentHeight - maxReorgDepth + 1, 1);
    let forkHeight: number | null = null;
    let reachedGenesis = false;
    const allForkWalkHeaders: BlockHeader[] = [];
    let requestStart = currentHeight;

    forkWalk: while (requestStart >= lowestExamined) {
      const page = await net.requestHeaders(requestStart, MAX_CHAIN_RESPONSE_ITEMS, peerId);
      if (page.length === 0) {
        // No headers at all → no decision, no penalty.
        console.warn('Fork resolution failed: no headers from peer');
        return;
      }

      // Hash the page — one unhashable entry refuses it whole.
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

        const header = page[i]!;
        // Heights above ourTip cannot occur — the request starts there.
        if (header.height > currentHeight) {
          throw new Error(
            `Fork walk: peer served header at height ${header.height} above ` +
            `our tip ${currentHeight} — the request started there`,
          );
        }
        // Heights below the horizon are past the walk's reach.
        if (header.height < lowestExamined) continue;

        const ourHash = getOrderingBlockHash(header.height);
        if (ourHash !== null && ourHash === h) {
          forkHeight = header.height;
          break forkWalk;
        }

        allForkWalkHeaders.push(header);
      }

      // Next page from lowestSeen − 1.
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
        reachedGenesis = true;
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

    // ourWork — once, from getHeadersAfter
    // (NODE_INTERFACE → Fork choice decides on verified headers, step 4).
    const ourHeaders = getHeadersAfter(forkHeight, currentHeight - forkHeight);
    const ourWork = cumulativeWork(ourHeaders);

    // 5. The scoring walk — upward in pages
    // (NODE_INTERFACE → Fork choice decides on verified headers, step 5).
    let theirWork = 0n;
    const allVerifiedHashes: string[] = [];
    let t_a = forkHeight === 0 ? null : storedAnchorCreatedAt();
    const params = retargetParams();

    // The fork walk's pages already hold headers f+1 … min(ourTip, theirTip)
    // in descending order; reverse to chronological.
    const forkWalkAboveFork = allForkWalkHeaders
      .filter(h => h.height > forkHeight)
      .sort((a, b) => a.height - b.height);

    let scoringPages: BlockHeader[][] = [];
    if (forkWalkAboveFork.length > 0) {
      scoringPages.push(forkWalkAboveFork);
    }

    // Extend above the fork walk's reach with fresh requests.
    let topScored = forkWalkAboveFork.length > 0
      ? forkWalkAboveFork[forkWalkAboveFork.length - 1]!.height
      : forkHeight;

    let needMorePages = true;
    if (forkWalkAboveFork.length === 0 && allForkWalkHeaders.length === 0 && !reachedGenesis) {
      needMorePages = false;
    }

    while (needMorePages) {
      const requestH = topScored + MAX_CHAIN_RESPONSE_ITEMS;
      const page = await net.requestHeaders(requestH, MAX_CHAIN_RESPONSE_ITEMS, peerId);
      const trimmed = page.filter(h => h.height > topScored);
      if (trimmed.length === 0) break;

      const sorted = trimmed.sort((a, b) => a.height - b.height);
      scoringPages.push(sorted);
      topScored = sorted[sorted.length - 1]!.height;

      // A page whose top is below the request is their tip.
      if (sorted[sorted.length - 1]!.height < requestH) break;
    }

    for (const page of scoringPages) {
      // refused_headers check per page — before verification.
      const pageHashes: string[] = [];
      for (let i = 0; i < page.length; i++) {
        const h = blockHash(page[i]!);
        if (h === null) {
          net.penalizePeer(peerId, 'misbehavior', `unhashable header in scoring page at index ${i}`);
          return;
        }
        pageHashes.push(h);
      }

      // 6. Memory — any verified hash in refused_headers.
      if (anyRefusedHeader(pageHashes)) {
        console.warn(
          `Fork resolution: scoring page contains a previously refused header, ` +
          `penalising peer ${peerId}`,
        );
        net.penalizePeer(peerId, 'misbehavior', 'served a chain containing a refused header');
        return;
      }

      const verdict = verifyHeaderChain(page, anchor, params, t_a, nowMs());
      if (!verdict.ok) {
        if (verdict.reason === 'clock') {
          console.warn(
            `Fork resolution: future-bound refusal, no penalty ` +
            `(index=${verdict.index})`,
          );
          return;
        }
        console.warn(
          `Fork resolution: header verification failed ` +
          `(index=${verdict.index}, reason=${verdict.reason}), penalising peer ${peerId}`,
        );
        net.penalizePeer(peerId, 'misbehavior', `header verification: ${verdict.reason} at index ${verdict.index}`);
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

      // Heights consecutive from blockStart, each hash matches the verified hash.
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

    // 10. The switch.
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
