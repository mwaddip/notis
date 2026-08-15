import { blockHash, cumulativeWork } from '@dagsocial/validation';
import type { BlockHeader, OrderingBlock, PruneEntry } from '@dagsocial/types';
import {
  decodeTx,
  MAX_REORG_DEPTH,
  MEMPOOL_EXPIRY_BLOCKS,
  computePruneEntryId,
} from '@dagsocial/types';
import {
  getOrderingBlock,
  getCurrentHeight,
  getBlockJournal,
  deleteBlockJournal,
  deleteOrderingBlock,
  unconsumeBox,
  deleteBox,
  unconfirmPost,
  deleteLikeRecord,
  restoreLikeRecord,
  insertUtxoTx,
  insertMempoolPrune,
  removeMempoolPrunes,
  rollbackBlockTopology,
  MempoolFullError,
  PendingSpendConflictError,
} from '../store/index.js';
import { getDb } from '../store/db.js';
import { config } from '../config.js';
import { isBlockJournalOpen, type BlockJournal } from '../store/journal.js';
import { deleteVouchCooldown, insertVouchCooldown } from '../store/vouch-cooldowns.js';
import { putIdentityRecord, deleteIdentityRecord } from '../store/identity-records.js';
import { tryGetAvlProver } from '../state/avl-prover.js';
import { GENESIS_HEIGHT } from './genesis-state.js';
import { applyOrderingBlock } from './block-apply.js';
import { rebuildTemplate } from './block-creator.js';
import {
  CorruptChainStateError,
  MissingStoredBlockError,
  UnhashableStoredHeaderError,
} from './corrupt-state.js';
import type { DagService } from './dag-service.js';

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
 * Walk both chains back to find the common ancestor.
 * theirHeaders is newest-first (tip at index 0).
 * Returns fork height, `GENESIS_HEIGHT` when the chains share only the genesis
 * state, or null if the divergence is deeper than MAX_REORG_DEPTH.
 *
 * **Height 0 is a valid answer, not a dead end.** Heights still start at 1, so
 * height 0 holds no block and no hash — but it holds the genesis *state*, which
 * every node on a network shares byte for byte. Two chains that diverge at
 * height 1 therefore have a common ancestor, and it is the only one they have.
 * The rule and its bound are stated at the `reachedGenesis` return below.
 *
 * `ourTip` is a header of ours; `theirHeaders` is not. It arrives from
 * `net.requestHeaders`, which parses the response through `decodeHeaders` — a
 * real codec, capped at the caller's own request size and carrying the whole
 * boundary check (TYPES_INTERFACE → The boundary check), so the array is
 * structurally well-formed and canonically encoded. That is not the same as
 * trustworthy: every field is still peer-chosen within its domain, a
 * well-formed header is not a header of a chain that exists, and
 * `verifyOrderingBlockStructure` cannot cover the path because it takes an
 * `OrderingBlock` and this one carries bare headers.
 *
 * **A batch with an unhashable header in it is refused whole.** A header we
 * cannot hash is not "a header that did not match": it is input we cannot
 * interpret, and the difference decides fork depth. Skipping it and carrying on
 * lets the peer choose *which* of our blocks becomes the fork point — poison the
 * entry that would have matched at our height 8 and the scan falls through to an
 * older match, so the node reverts back to height 5 instead of 8 (bounded only
 * by MAX_REORG_DEPTH), and the poisoned entry stays in the array the caller
 * hands to `cumulativeWork` for the heavier-chain comparison. Refusing the batch
 * grants the peer nothing it does not already have: the same peer can answer
 * with no headers, or with headers matching nothing, and both already end in "no
 * reorg" — index.ts asks one peer and takes what it gets. So skip buys no
 * liveness and costs fork-choice integrity.
 *
 * The whole batch is hashed before any of it is matched, deliberately: checking
 * only until the first match would make the verdict depend on where the peer put
 * the poison relative to the match, which is the peer's choice again.
 */
export function findForkPoint(
  ourTip: BlockHeader,
  theirHeaders: BlockHeader[],
): number | null {
  // Collect our chain hashes: height -> hash
  const ourHashes = new Map<string, number>();
  let cursor = getOrderingBlock(ourTip.height);
  if (
    !cursor ||
    ourChainHash(cursor.header, 'findForkPoint') !== ourChainHash(ourTip, 'findForkPoint')
  ) {
    return null; // ourTip is stale — a reorg happened since caller fetched it
  }
  // Walk our chain down from the tip. A missing block ends this loop, and the
  // two reasons it can be missing are not the same thing: running out of
  // *blocks* is how the walk reaches the genesis state, while a height that
  // should hold a block and does not is the contiguity invariant broken.
  //
  // The two are cleanly separable because heights start at 1 — `applyBlockBody`
  // accepts a first block only at height 1, and every stored header cleared
  // `verifyOrderingBlockStructure`'s `height >= 1` — so height 0 is the
  // boundary and every height at or above 1 must be there. Those are the only
  // two cases: stored heights are integers ≥ 1, so `height - 1` is either 0 or
  // ≥ 1, with nothing in between and nothing outside.
  //
  // Truncating silently errs toward "no common ancestor", which is the safe
  // direction — but a node that can never reorg sits on the wrong chain
  // permanently without knowing, the same silence a forever-rejecting apply
  // funnel produces.
  let depth = 0;
  let reachedGenesis = false;
  while (depth < MAX_REORG_DEPTH) {
    ourHashes.set(ourChainHash(cursor.header, 'findForkPoint'), cursor.header.height);
    depth++;
    const nextHeight = cursor.header.height - 1;
    if (nextHeight < GENESIS_HEIGHT + 1) {
      // Height 0 holds no block, so there is no hash to record — but the state
      // it names is an ancestor both chains share (see the return below).
      reachedGenesis = true;
      break;
    }
    const next = getOrderingBlock(nextHeight);
    if (!next) throw new MissingStoredBlockError('findForkPoint', nextHeight);
    cursor = next;
  }

  // Hash their whole chain first — one unhashable entry refuses the batch
  const theirHashes: string[] = [];
  for (let i = 0; i < theirHeaders.length; i++) {
    const h = blockHash(theirHeaders[i]!);
    if (h === null) {
      console.warn(
        `Fork resolution: refusing peer header batch — entry ${i} of ` +
        `${theirHeaders.length} is outside the encodable domain`,
      );
      return null;
    }
    theirHashes.push(h);
  }

  // Walk their chain, check for match
  for (const h of theirHashes) {
    const matchHeight = ourHashes.get(h);
    if (matchHeight !== undefined) return matchHeight;
  }

  // No shared block, but the walk ran out of blocks rather than out of window:
  // our whole chain is inside the reorg bound, so the two chains diverge above
  // the genesis state and **that state is the common ancestor**, at depth =
  // our height.
  //
  // There is no hash to compare and none is needed. Every node on a network
  // holds a byte-identical height-0 state by construction — `seedGenesisState`
  // refuses any other (`assertGenesisRoot`) — and a peer's height-1 block has
  // its `prevBlockHash` checked as all-zeros before it can be stored. That
  // check is on every path that reaches the ordering store: the store's one
  // writer is called from `applyBlockBody`, below that function's own
  // chain-link gate (the provenance is stated on `store/ordering.ts`'s
  // `createOrderingBlock`), and all four callers of `applyOrderingBlock` —
  // gossip, sync pull, the block creator and `reorg` below — go through it.
  //
  // ⚠ **This is reachable only below `MAX_REORG_DEPTH`, and the bound does not
  // move.** Height 0 became a valid ancestor; how far back a reorg may go did
  // not. A divergence deeper than the window still answers null, because
  // journal retention is the real floor under revert depth — `revertBlock`
  // throws without a journal (`block-apply.ts` → the `purgeOldJournals` call).
  if (reachedGenesis) return GENESIS_HEIGHT;

  return null; // no common ancestor within MAX_REORG_DEPTH
}

/**
 * Reverse all mutations from a single block using its journal.
 * Returns the PruneEntry array from the reverted block so callers can
 * re-insert them into the mempool without relying on read-before-delete
 * ordering.
 */
export function revertBlock(height: number): PruneEntry[] {
  // Revert must never run while a journal is recording: the mutation replay
  // uses the never-recording inverses, but the vouch-cooldown restores below
  // go through recording primitives and would journal themselves into the
  // open block's log.
  if (isBlockJournalOpen()) {
    throw new Error(`revertBlock(${height}): a block journal is open`);
  }
  const journal = getBlockJournal(height);
  if (!journal) {
    throw new Error(`No journal for height ${height} — cannot revert`);
  }

  // Collect prune entries before the block is deleted
  const block = getOrderingBlock(height);
  const pruneEntries: PruneEntry[] = block?.utxoTxTree.pruneEntries ?? [];

  // 1. Replay the primitive mutation log in reverse: box/insert → deleteBox,
  // box/remove → unconsumeBox, record → restore `replaced` or delete. This
  // restores the exact pre-block committed state for every mutation class —
  // including the pre-existing boxes merge-consumed inside
  // mintKarma/mintCredits, tallied like boxes, prune settlement, and identity
  // records.
  //
  // Reverse order is what makes a record written **more than once in one block**
  // (activity bump then decay, at the same height) revert correctly: each
  // inverse undoes one write, and the last one replayed is the *first* write's
  // `replaced` — the true pre-block value. A per-key single restore keeping the
  // last `replaced` would restore an intra-block intermediate instead.
  //
  // `putIdentityRecord` is itself a recording primitive, exactly like the
  // `insertVouchCooldown` restore two loops below. That is safe only because
  // this function refuses to run while a journal is open (the guard at the top);
  // the guard is the mechanism, not a non-recording variant.
  for (let i = journal.mutations.length - 1; i >= 0; i--) {
    const m = journal.mutations[i]!;
    if (m.kind === 'record') {
      if (m.replaced !== undefined) {
        putIdentityRecord(m.identityId, m.replaced);
      } else {
        deleteIdentityRecord(m.identityId);
      }
    } else if (m.op === 'insert') {
      deleteBox(m.boxId);
    } else {
      unconsumeBox(m.boxId);
    }
  }

  // 2. Side-record inverses
  for (const subBlockId of journal.confirmedSubBlockIds) {
    unconfirmPost(subBlockId);
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
  for (const ins of journal.vouchCooldownInsertions) {
    deleteVouchCooldown(ins.voucherId, ins.targetId);
    // insertVouchCooldown is INSERT OR REPLACE — restore the row it overwrote
    if (ins.replaced) {
      insertVouchCooldown(
        ins.voucherId,
        ins.targetId,
        ins.replaced.releaseAtBlock,
        ins.replaced.karmaAmount,
      );
    }
  }
  // Restore escrow rows the block's cooldown mints deleted (H-7)
  for (const del of journal.vouchCooldownDeletions) {
    insertVouchCooldown(del.voucherId, del.targetId, del.releaseAtBlock, del.karmaAmount);
  }

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

  return pruneEntries;
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
 * Two refusals qualify, for that one reason:
 *
 * - `MempoolFullError` — the pool is at its cap.
 * - `PendingSpendConflictError` — an entry admitted since spends one of this
 *   tx's inputs. Both are valid now that the block is reverted and only one can
 *   be, so the incumbent keeps its place.
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
    throw err;
  }
}

/**
 * Reorg: revert our chain from currentHeight down to forkHeight+1,
 * then apply the competing chain forward.
 */
export function reorg(forkHeight: number, newBlocks: OrderingBlock[], dagService?: DagService): void {
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

  // Phase 1: revert our blocks, collecting journals and prune entries for re-insertion
  const revertedJournals: BlockJournal[] = [];
  const revertedPruneEntries: PruneEntry[] = [];
  for (let h = currentHeight; h > forkHeight; h--) {
    const journal = getBlockJournal(h);
    if (journal) revertedJournals.push(journal);
    // revertBlock() returns prune entries from the deleted block — no implicit
    // read-before-delete ordering dependency between caller and callee
    revertedPruneEntries.push(...revertBlock(h));
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
  // ⚠ **Reachable by configuration, not only by corruption.** `MAX_PROOF_HISTORY`
  // is env-tunable and `checkpointProver` prunes versions below
  // `height - maxProofHistory`, while `MAX_REORG_DEPTH` is fixed — so a value
  // under 20 prunes inside the window the fork walk still answers within, and
  // `findForkPoint` reaching the genesis state makes height 0 one of the answers
  // it can give. The message names the two numbers because their relationship is
  // the fault.
  if (avlHandle) {
    const version = avlHandle.storage.versionAtOrBeforeHeight(forkHeight);
    if (!version) {
      throw new Error(
        `reorg to fork height ${forkHeight}: no AVL version at or before it. ` +
        `MAX_PROOF_HISTORY=${config.maxProofHistory} prunes versions this reorg ` +
        `needs — it must not be below MAX_REORG_DEPTH=${MAX_REORG_DEPTH}.`,
      );
    }
    avlHandle.prover.rollback(version);
  }

  // Phase 2: re-insert reverted txs to mempool.
  //
  // ⛔ **A post rides its own transaction, so re-inserting the transactions
  // re-inserts the posts.** The separate sub-block injection this loop used to do
  // is gone with the mempool's second entry type — and with it the injection
  // primitive that a list of ids the block never committed made reachable.
  // `journal.confirmedSubBlockIds` survives for the *un-confirm* half of the
  // rollback; it is not a mempool key.
  const newTipHeight = forkHeight + newBlocks.length;
  const mempoolExpiry = newTipHeight + MEMPOOL_EXPIRY_BLOCKS;
  for (const journal of revertedJournals) {
    // Re-insert UTXO txs
    for (const txRecord of journal.appliedUtxoTxs) {
      const tx = decodeTx(txRecord.txCbor);
      reinsert(() => insertUtxoTx(tx, mempoolExpiry), `tx ${txRecord.txId}`);
    }
  }

  // Re-insert prune entries from reverted blocks
  if (revertedPruneEntries.length > 0) {
    const entryIds = revertedPruneEntries.map(e => computePruneEntryId(e));
    removeMempoolPrunes(entryIds);
    for (const entry of revertedPruneEntries) {
      reinsert(() => insertMempoolPrune(entry, mempoolExpiry), `prune entry ${entry.rootPostHash}`);
    }
  }

  // Phase 3: apply new chain
  for (const block of newBlocks) {
    if (!applyOrderingBlock(block, dagService)) {
      throw new Error(`reorg failed: block at height ${block.header.height} rejected`);
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

  // A reorg is one tip move, however many blocks it applies. The per-block
  // rebuild inside `applyOrderingBlock` stands down while nested in the
  // transaction above, so a miner node's template is built once, here, against
  // the chain that committed (MINING_INTERFACE → Template and submit).
  rebuildTemplate();
}

/**
 * The `net` surface fork resolution uses, structurally rather than as
 * `NetNode`. These three calls are the whole dependency, and naming them is
 * what lets a test drive `resolveFork` against a stub peer — `reorg` and
 * `revertBlock` are reachable from a test on their own; the decision that calls
 * them is not.
 *
 * **`getConnectedPeers`, not `peers`, and the distinction decides a reorg.**
 * `peers()` lists every *known* peer, including ones that have not completed —
 * or have failed — the DAGsocial handshake; only `getConnectedPeers()` filters
 * on Active. A peer that failed the handshake is on another network, and a
 * counterparty chosen off the wrong list can revert this node's entire chain:
 * below `MAX_REORG_DEPTH` the fork walk reaches the genesis state, so a stranger
 * with more work wins at height 0.
 */
export interface ForkResolutionNet {
  getConnectedPeers(): string[];
  requestHeaders(startHeight: number, maxCount: number, peerId: string): Promise<BlockHeader[]>;
  requestBlocks(startHeight: number, endHeight: number, peerId: string): Promise<OrderingBlock[]>;
}

/**
 * Decide a fork against one peer and, if their chain wins, switch to it.
 *
 * Entered when a gossiped block neither is genesis nor extends our tip. Every
 * fork-choice rule lives here — common-ancestor depth, the cumulative-work
 * comparison, the tip-changed re-read, and the shorter-chain refusal — while
 * `reorg` below stays the mechanism that carries out a decision already made.
 *
 * `fromPeerId` is the peer that relayed the competing block (NET_INTERFACE →
 * Inbound Processing), which is therefore a peer that holds the chain the block
 * belongs to. It is the counterparty when the Active list agrees; the selection
 * is at the `peers.includes` line below.
 */
export async function resolveFork(
  block: OrderingBlock,
  net: ForkResolutionNet,
  fromPeerId: string,
  dagService?: DagService,
): Promise<void> {
  const currentHeight = getCurrentHeight();

  console.log(
    `Fork detected: our height=${currentHeight}, ` +
    `competing block height=${block.header.height}`,
  );

  // Active peers only — the same list the readiness gate reads, for the same
  // reason (see `ForkResolutionNet`). A handshake-failed peer must not be picked
  // as the counterparty whose chain this node might adopt.
  const peers = net.getConnectedPeers();
  if (peers.length === 0) {
    console.warn('Fork resolution failed: no connected peers');
    return;
  }
  // Ask the peer that relayed the block: it holds the competing chain, where
  // any other connected peer may hold nothing about it — and at this call site
  // "knows nothing about this fork" and "has no reorg to offer" are the same
  // answer, an empty header list (NET_INTERFACE → Pull Requests).
  //
  // The gossip source is filtered **through** the Active list, never around it:
  // membership is the whole guarantee stated on `ForkResolutionNet`, and this
  // selection admits nothing that list does not already admit. Any
  // `fromPeerId` outside it — a relay that has since disconnected among them —
  // takes the fallback.
  const peerId = peers.includes(fromPeerId) ? fromPeerId : peers[0]!;

  try {
    // Request headers from competing tip going backward (newest-first)
    const theirHeaders = await net.requestHeaders(
      block.header.height,
      MAX_REORG_DEPTH * 2,
      peerId,
    );
    if (theirHeaders.length === 0) {
      console.warn('Fork resolution failed: no headers from peer');
      return;
    }

    const ourTip = getOrderingBlock(currentHeight);
    if (!ourTip) {
      console.warn('Fork resolution failed: cannot retrieve our tip');
      return;
    }

    const forkHeight = findForkPoint(ourTip.header, theirHeaders);
    if (forkHeight === null) {
      console.warn(
        `Fork resolution failed: no common ancestor within ${MAX_REORG_DEPTH} blocks`,
      );
      return;
    }

    // Build our chain headers from fork+1 to current tip.
    //
    // Every height in this range must hold a block. `findForkPoint` answers
    // either a height out of our own hash map or `GENESIS_HEIGHT`, which is
    // **not** in that map — height 0 holds no block, so the walk records no hash
    // for it. Both answers leave this range inside our chain: a mapped height is
    // one we hold, and 0 starts the range at 1, our first block. The block at
    // `currentHeight` was just read above, the store is contiguous between them,
    // and nothing awaits between that read and this loop, so it cannot move
    // underneath us.
    //
    // Skipping a missing one is the worst available handling, because of which
    // way it errs: `ourHeaders` feeds `cumulativeWork(ourHeaders)`, so a skipped
    // block *understates our own chain's work* and tips `theirWork > ourWork`
    // toward abandoning our chain — silently, on a comparison we got wrong in
    // the one direction that costs us the chain rather than the reorg.
    const ourHeaders: BlockHeader[] = [];
    for (let h = forkHeight + 1; h <= currentHeight; h++) {
      const b = getOrderingBlock(h);
      if (!b) throw new MissingStoredBlockError('fork resolution', h);
      ourHeaders.push(b.header);
    }

    // Extract competing chain headers above fork point (theirHeaders is newest-first)
    const theirChainHeaders = theirHeaders
      .filter((h) => h.height > forkHeight)
      .reverse(); // chronological order for cumulativeWork

    const ourWork = cumulativeWork(ourHeaders);
    const theirWork = cumulativeWork(theirChainHeaders);

    if (theirWork <= ourWork) {
      console.log(
        `Fork resolution: our chain has more or equal work ` +
        `(ours=${ourWork}, theirs=${theirWork}), ignoring`,
      );
      return;
    }

    console.log(
      `Fork resolution: competing chain has more work ` +
      `(ours=${ourWork}, theirs=${theirWork}), reorging...`,
    );

    // Request blocks from fork+1 to competing tip
    const theirTipHeight = theirHeaders[0]!.height;
    const newBlocks = await net.requestBlocks(
      forkHeight + 1,
      theirTipHeight,
      peerId,
    );

    // Re-check tip — our chain may have advanced during the async requests
    const heightNow = getCurrentHeight();
    if (heightNow !== currentHeight) {
      console.warn(
        `Tip changed during fork resolution ` +
        `(was ${currentHeight}, now ${heightNow}), aborting reorg`,
      );
      return;
    }

    // NODE_INTERFACE → AVL+ State Root → "Never reorg to a shorter chain". The
    // predicate is the resulting tip, not `newBlocks.length`: any answer short
    // of the range asked for lands it at or below where it started.
    //
    // `heightNow` is what `reorg` will read — nothing awaits between here and
    // the call, so the comparison cannot go stale.
    const newTipHeight = forkHeight + newBlocks.length;
    if (newTipHeight <= heightNow) {
      console.warn(
        `Fork resolution: peer ${peerId} answered ${newBlocks.length} block(s) for ` +
        `heights ${forkHeight + 1}..${theirTipHeight}, which would leave the tip at ` +
        `${newTipHeight} (now ${heightNow}), aborting reorg`,
      );
      return;
    }

    reorg(forkHeight, newBlocks, dagService);
    console.log(`Reorg complete: new tip at height=${newTipHeight}`);
  } catch (err) {
    // This catch is for the peer and the network — a request that timed out, a
    // response that would not decode, a reorg the apply path refused. Failing to
    // hash our *own* chain is none of those, and warning about it here would put
    // the boundary's decision back in the hands of whichever line noticed first.
    if (err instanceof CorruptChainStateError) throw err;
    console.warn(`Fork resolution error: ${String(err)}`);
  }
}
