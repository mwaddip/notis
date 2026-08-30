import * as validation from '@dagsocial/validation';
import { commitDecayClocks, deriveKarmaDecay } from './decay.js';
import { hasActiveVouchEscrow } from '../store/utxo.js';
import {
  CorruptChainStateError,
  MissingStoredBlockError,
  UnhashableStoredHeaderError,
  failStopIfCorruptChain,
} from './corrupt-state.js';
import { config } from '../config.js';
import {
  collectPostBodyKarma,
  computeBlockReward,
  computeUtxoTxRoot,
  clearTemplate,
  decayDeps,
  rebuildTemplate,
  settlementDepsWith,
} from './block-creator.js';
import {
  countKarmaActors,
  isCreditSideTx,
  type EmbeddedTx,
} from './coinbase-split.js';
import {
  bondInviteeOf,
  checkSettlement,
  contributeToBody,
  emptyBody,
} from './settlement.js';
import { postsOf, postIdsOf, prunesOf, withdrawalsOf } from './block-posts.js';
import { scheduledTargetBits, nowMs } from './difficulty.js';
import {
  applyTx,
  checkOutputShape,
  checkSettlementOutputShape,
  checkTxEnvelope,
  materializeOutput,
  validateTx,
  isMember,
} from './utxo-engine.js';
import {
  getKarmaBox,
  getKarmaValue,
  getPost,
  insertStump,
  insertBox,
  getBox,
  consumeBox,
  confirmPost,
  insertPost,
  deletePostRows,
  withdrawPost,
  isLivePost,
  isStoredPost,
  getCurrentHeight,
  createOrderingBlock as storeCreateOrderingBlock,
  getOrderingBlock,
  removeUtxoTxEntry,
  insertBlockTopology,
  getSubtreeTopology,
  deleteLikeRecordsForPosts,
  getTopologyAuthor,
  getTopologyAuthorBytes,
  getTopologyHeight,
  markPrunedTopology,
  getIdentityRecord,
  putIdentityRecord,
  recordKarmaActivity,
  hasLikeRecord,
  insertLikeRecord,
  getVouchEscrowsReleasableAt,
  purgeRefusedHeaders,
  getBoxProvenance,
  getInterlinks,
  getVouchBox,
  getNetworkRecord,
  getLapsedVouches,
} from '../store/index.js';
import { getDb } from '../store/db.js';
import {
  beginBlockJournal,
  finishBlockJournal,
  abortBlockJournal,
  recordConfirmedPosts,
  recordAppliedUtxoTx,
  recordDeletedPosts,
  recordInsertedStump,
  recordWithdrawnPost,
  insertBlockJournal,
  purgeOldJournals,
} from '../store/journal.js';
import type { BlockJournal } from '../store/journal.js';
import { tryGetAvlProver, applyBlockMutations, checkpointProver } from '../state/avl-prover.js';
import { emitPostIndexed } from '../journal.js';
import { countedVerifyOrderingBlockPoW, noteTip } from '../metrics.js';
import { getNet } from './net-instance.js';
import type { RecordPut, NetworkPut } from '../state/avl-prover.js';
import { networkRecordKey } from '../store/identity-records.js';
import {
  encodeTx,
  decodeTx,
  MAX_FUTURE_DRIFT_MS,
  GENESIS_PREV_BLOCK_HASH,
  PROTOCOL_VERSION,
  MAX_ESCROW_RETURNS_PER_BLOCK,
  MAX_LAPSE_WITHDRAWALS_PER_BLOCK,
  computeTxId,
  interlinkRoot,
  updateInterlinks,
  membershipBar as membershipBarFn,
  memberLikesBar,
} from '@dagsocial/types';
import type {
  AnyBox,
  KarmaBox,
  VouchBox,
  OrderingBlock,
  UtxoTransaction,
} from '@dagsocial/types';
import type { IdentityRecord } from '../store/identity-records.js';
import { putNetworkRecord } from '../store/identity-records.js';

/**
 * Signals "this block is invalid" from inside the transaction that wraps block
 * application. Thrown rather than returned because better-sqlite3 only rolls a
 * transaction back on a thrown error. Never escapes this module.
 */
class BlockRejected extends Error {}

/**
 * Apply an ordering block — all of it, or none of it.
 *
 * A block is a single unit of state transition, so every mutation it makes
 * (post confirmation, prune settlement, UTXO transactions,
 * per-block like settlement, decay) lives in one SQLite transaction. Any rejection — at any
 * step — rolls the whole thing back, leaving the node on the state it had
 * before the block arrived. Returns false for a rejected block; `reorg()`
 * nests this inside its own transaction, which SQLite handles as a savepoint.
 *
 * The funnel is total: no input makes this function throw. A block that causes
 * an unexpected exception is a block the node rejects, on the same terms as an
 * explicit rejection — transaction rolled back, journal dropped, `false`
 * returned, detail logged. That is not defensive padding. The gossip callback
 * is `async` and the net layer discards its promise, so a propagated throw
 * becomes an unhandled rejection, which exits the process on Node ≥ 15; and
 * because a rejected block is never stored, the node re-fetches it on restart
 * and dies again. One cheaply-mined block would otherwise be a permanent,
 * self-reapplying kill for every node that receives it.
 */
export function applyOrderingBlock(block: OrderingBlock): boolean {
  // Structure first, before any field of `block` is read. Until this returns
  // valid, nothing about the object's shape is known: the fields below are
  // decoded from an untrusted producer and reach `Buffer.from` further down,
  // which throws on a number or a plain object. It runs in the funnel rather
  // than in the gossip topic validator alone, so the guarantee is
  // path-independent: the pull-sync path decodes straight into the apply
  // handler, and a validator-only check leaves it reachable with fields of
  // arbitrary type. Same shape as the PoW target (M-2), coinbase maturity
  // (M-3), and the validator signature (H-1).
  const structure = validation.verifyOrderingBlockStructure(block);
  if (!structure.valid) {
    console.warn(`Rejected block: invalid structure: ${structure.error}`);
    return false;
  }
  // SQLite rollback does not reach the AVL prover's in-memory state, so the
  // funnel snapshots the digest before the transaction and restores it on
  // every rejection path — explicit rejection (including the stateRoot
  // mismatch, whose §13-local rollback this replaces) and the totality catch.
  const avlHandle = tryGetAvlProver();
  const preDigest = avlHandle ? avlHandle.prover.digest() : null;
  const restoreProver = (): void => {
    if (!avlHandle || !preDigest) return;
    const current = avlHandle.prover.digest();
    if (current && Buffer.from(current).equals(Buffer.from(preDigest))) return;
    avlHandle.prover.rollback(preDigest);
  };
  let applied: boolean;
  try {
    applied = getDb().transaction(() => {
      if (!applyBlockBody(block)) throw new BlockRejected();
      return true;
    })();
  } catch (err) {
    if (err instanceof BlockRejected) {
      restoreProver();
      return false;
    }
    // The one throw this funnel does not convert into a rejection.
    //
    // Totality here is a promise about **untrusted input** — no block a peer can
    // construct takes the node down. Our own stored header having no hash is not
    // in that class and cannot be put in it: the ordering store's one writer
    // runs inside `applyBlockBody` below, downstream of the
    // `verifyOrderingBlockStructure` call above — the same domain predicate —
    // so no peer can cause it. (`store/ordering.ts`'s `createOrderingBlock`
    // states the provenance.) Answering `false` would turn local corruption
    // into a permanent rejection of every subsequent block, logged as an
    // unexpected failure — a node that rejects everything while staying up looks
    // exactly like a quiet network. The unwinding below still runs, because the
    // boundary is the caller's decision and not this function's to presume.
    if (err instanceof CorruptChainStateError) {
      abortBlockJournal();
      restoreProver();
      throw err;
    }
    // better-sqlite3 has already rolled the transaction back by the time the
    // throw surfaces here (it issues ROLLBACK, or ROLLBACK TO for the nested
    // reorg savepoint, before re-throwing), so the node is on its pre-block
    // state. What is left is to drop the half-built journal (a no-op if the
    // body already finished it), restore the prover, and answer the caller
    // the same way an explicit rejection does.
    console.error(
      `Rejected block height=${block.header.height}: unexpected failure during apply: ${String(err)}`,
    );
    abortBlockJournal();
    restoreProver();
    return false;
  }

  // The tip moved, so a miner node's template moved with it — one template per
  // height, rebuilt on tip movement alone (MINING_INTERFACE → Template and
  // submit). Outside the try: a throw from here is not a verdict on this block,
  // which is committed, and the catch arms above would answer for it as though
  // it were — rolling the prover back off state SQLite has already kept.
  //
  // Only once the write is committed. Nested inside `reorg`'s transaction this
  // block is not the tip yet, and a template derived there describes a chain a
  // failed reorg rolls back; `reorg` rebuilds once, after its own commit, and
  // the tip metric moves with it (NODE_INTERFACE → Admin Listener).
  if (!getDb().inTransaction) {
    rebuildTemplate();
    noteTip(block.header.height);
    // The applied tip reaches net at the same seam, so a version boundary can
    // sweep peers below the new era (NET_INTERFACE → API).
    getNet()?.tipApplied(block.header.height);
  }
  return applied;
}

function applyBlockBody(block: OrderingBlock): boolean {
  const currentHeight = getCurrentHeight();

  // Open the record-once journal: from here on the store mutation primitives
  // record automatically, and every rejection path below aborts it. The
  // lifecycle is owned here rather than by the mutation phase, so the
  // speculative caller (`computePostBlockStateRoot`) records identically.
  beginBlockJournal(block.header.height);

  // 1. Chain-link check + interlink root + genesis pin
  // (NODE_INTERFACE → Ordering block apply-time authorization)
  let expectedInterlinks: string[];
  let prevBlock: OrderingBlock | null = null;
  if (currentHeight === 0) {
    // Genesis: prevBlockHash must be all zeros
    if (block.header.prevBlockHash !== GENESIS_PREV_BLOCK_HASH) {
      console.warn(`Rejected block height=${block.header.height}: genesis prevBlockHash mismatch`);
      abortBlockJournal();
      return false;
    }
    if (block.header.height !== 1) {
      console.warn(`Rejected block: first block must have height=1, got ${block.header.height}`);
      abortBlockJournal();
      return false;
    }
    expectedInterlinks = [];

    // Genesis pin (TYPES_INTERFACE → Network profiles)
    const genesisId = config.profile.genesisId;
    if (genesisId !== '') {
      const bh = validation.blockHash(block.header);
      if (bh !== genesisId) {
        console.warn(`Rejected block height=${block.header.height}: genesis pin mismatch`);
        abortBlockJournal();
        return false;
      }
    }
    // MINING_INTERFACE → Header timestamp rules, future bound (height 1)
    if (!validation.verifyCreatedAtBound(block.header, nowMs(), MAX_FUTURE_DRIFT_MS)) {
      console.warn(`Rejected block height=${block.header.height}: createdAt beyond the future bound`);
      abortBlockJournal();
      return false;
    }
  } else {
    // Every throw in this branch reads our own stored tip, not the arriving
    // block: a rejection would blame a peer for our store and repeat for
    // every block after it (NODE_INTERFACE → Ordering block apply-time
    // authorization; NODE_INTERFACE → Ordering blocks, the corrupt-header
    // tripwire).
    prevBlock = getOrderingBlock(currentHeight);
    if (!prevBlock) {
      throw new MissingStoredBlockError('applyOrderingBlock', currentHeight);
    }
    const prevHash = validation.blockHash(prevBlock.header);
    if (prevHash === null) {
      throw new UnhashableStoredHeaderError('applyOrderingBlock', currentHeight);
    }
    if (!validation.verifyBlockChainLink(block, prevBlock)) {
      console.warn(`Rejected block height=${block.header.height}: chain link check failed`);
      abortBlockJournal();
      return false;
    }
    // MINING_INTERFACE → Header timestamp rules, order rule
    if (!validation.verifyCreatedAtOrder(block.header, prevBlock.header)) {
      console.warn(`Rejected block height=${block.header.height}: createdAt not above the parent's`);
      abortBlockJournal();
      return false;
    }
    // MINING_INTERFACE → Header timestamp rules, future bound
    if (!validation.verifyCreatedAtBound(block.header, nowMs(), MAX_FUTURE_DRIFT_MS)) {
      console.warn(`Rejected block height=${block.header.height}: createdAt beyond the future bound`);
      abortBlockJournal();
      return false;
    }
    const storedInterlinks = getInterlinks(currentHeight);
    if (storedInterlinks === null) {
      throw new UnhashableStoredHeaderError('applyOrderingBlock/interlinks', currentHeight);
    }
    // VALIDATION_INTERFACE → level: null is no level, not a fail-stop
    const prevLevel = validation.level(prevBlock.header, config.orderingBlockPowTargetBits);
    expectedInterlinks = updateInterlinks(storedInterlinks, prevHash, prevLevel);
  }
  if (block.header.interlinkRoot !== interlinkRoot(expectedInterlinks)) {
    console.warn(`Rejected block height=${block.header.height}: interlinkRoot mismatch`);
    abortBlockJournal();
    return false;
  }

  // 2. Protocol version
  if (!validation.verifyProtocolVersion(block.header.protocolVersion)) {
    console.warn(`Rejected block height=${block.header.height}: unsupported protocol version ${block.header.protocolVersion}`);
    abortBlockJournal();
    return false;
  }

  // 3. PoW target — MINING_INTERFACE → Difficulty Schedule. Checked before the
  // PoW solution: `verifyOrderingBlockPoW` judges the solution against the
  // header's own `powTargetBits`, so a producer writing the floor into its
  // header mines a near-free block that satisfies its own claim.
  const scheduledTarget = currentHeight === 0
    ? config.orderingBlockPowTargetBits
    : scheduledTargetBits(prevBlock!.header);
  if (block.header.powTargetBits !== scheduledTarget) {
    console.warn(
      `Rejected block height=${block.header.height}: powTargetBits ` +
      `${block.header.powTargetBits} != scheduled ${scheduledTarget}`,
    );
    abortBlockJournal();
    return false;
  }
  if (!countedVerifyOrderingBlockPoW(block.header)) {
    console.warn(`Rejected block height=${block.header.height}: PoW invalid`);
    abortBlockJournal();
    return false;
  }

  // 3b. Validator signature (H-1)
  //
  // PoW proves work was spent; it does not prove who spent it. Without this,
  // any miner forges a block under any validatorId. Runs in applyBlockBody — the
  // funnel every apply path (gossip, sync, reorg) passes through — so no path skips it.
  if (!validation.verifyValidatorSignature(block.header, block.validatorSignature)) {
    console.warn(`Rejected block height=${block.header.height}: validator signature invalid`);
    abortBlockJournal();
    return false;
  }

  // 4. Merkle root verification — one root over one body (transactions, prune
  //    entries), each kept apart by its `leafHash` domain. The settlement is the
  //    last transaction leaf, so its position is committed here.

  const computedUtxoRoot = computeUtxoTxRoot(block.utxoTxTree);
  if (computedUtxoRoot !== block.header.utxoTxRoot) {
    console.warn(`Rejected block height=${block.header.height}: utxoTxRoot mismatch`);
    abortBlockJournal();
    return false;
  }

  // 5. The coinbase's maturity lock is checked with the rest of the settlement,
  //    in the mutation phase: the coinbase is an output of that transaction
  //    and every clause about it is one rule in one place
  //    (`settlement.ts` → checkSettlement).

  // 6. Store the block — the vector the funnel verified is the one stored
  storeCreateOrderingBlock(block, expectedInterlinks);

  // 6. Invalidate the local mining template (this height is taken). Only
  // invalidation here: the replacement commits to the post-block stateRoot, and
  // the mutation phase and AVL root update that produce it are still ahead. The
  // rebuild is at the end of `applyOrderingBlock`, once the write is committed.
  clearTemplate();

  // 7–12b. Mutation phase — the block's state transition, run verbatim (at an
  // explicitly passed height) by the block creator to obtain the post-block
  // stateRoot before mining (H-6). It never touches the journal lifecycle, so
  // its rejections are turned into an abort here.
  if (!applyMutationPhase(block, block.header.height)) {
    abortBlockJournal();
    return false;
  }

  // 13. AVL state root update (skipped if prover not initialized)
  //
  // Nothing mutates boxes past §12b, so the journal is complete: close it and
  // derive the prover feed from its mutation log.
  const journal = finishBlockJournal();
  const handle = tryGetAvlProver();
  if (handle) {
    const { consumed, created, recordPuts, networkPuts } = proverFeedFromJournal(journal);
    const computedDigest = applyBlockMutations(
      handle.prover, block.header.height, consumed, created, recordPuts, networkPuts,
    );

    // Verify against block header (gated). The prover is restored by the
    // funnel's single rollback point, not here.
    if (config.verifyStateRoot) {
      const expectedHex = Buffer.from(computedDigest).toString('hex');
      if (block.header.stateRoot !== expectedHex) {
        console.warn(
          `stateRoot mismatch at height ${block.header.height}: ` +
          `computed=${expectedHex.slice(0, 16)}... ` +
          `header=${block.header.stateRoot.slice(0, 16)}...`,
        );
        abortBlockJournal();
        return false;
      }
    }

    // Checkpoint prover state at this height
    checkpointProver(handle, block.header.height);
  }

  // 14. Persist journal and purge old ones
  insertBlockJournal(journal);
  // Retention is the real floor under revert depth — `revertBlock` throws
  // without a journal — so it tracks the depth the fork walk can reach
  // (NODE_INTERFACE → Fork choice decides on verified headers).
  purgeOldJournals(block.header.height - config.maxReorgDepth);
  purgeRefusedHeaders(block.header.height - config.maxReorgDepth);

  // The one site where an absence is simply printed. `applyOrderingBlock` ran
  // `verifyOrderingBlockStructure` over this header before calling us, so it is
  // inside the domain and this prints the hash. The block is applied and the
  // transaction is about to commit; turning a log line into a throw would roll
  // back a valid block, and inventing a placeholder would print a hash that is
  // not one. If the impossible happens the line says `hash=null`, which is true.
  const appliedHash = validation.blockHash(block.header);
  console.log(`Applied ordering block height=${block.header.height} hash=${appliedHash} (${block.utxoTxTree.utxoTxIds.length} txs)`);
  return true;
}

/**
 * The prover feed a finished journal implies — the one derivation both the
 * apply commit (§13) and the creator's speculative run use, so producer and
 * verifier can never disagree by construction.
 *
 * An insert later followed by a remove for the same boxId is a box that never
 * existed outside this block: the pair nets out (drop both); survivors keep
 * first-occurrence order, which `applyBlockMutations` then replaces with the
 * canonical one (M-12). Created-box bytes come from the journal's recorded
 * payload, never a store re-fetch: `getBox` returns null for a created-then-
 * consumed box, so a re-fetch would silently drop it.
 */
function proverFeedFromJournal(
  journal: BlockJournal,
): { consumed: string[]; created: AnyBox[]; recordPuts: RecordPut[]; networkPuts: NetworkPut[] } {
  // Netting is per-kind and the two rules do NOT share a code path: boxes
  // cancel insert+remove pairs; records collapse to the last write per key.
  const cancelled = new Set<number>();
  const pendingInsertIndex = new Map<string, number>();
  for (let i = 0; i < journal.mutations.length; i++) {
    const m = journal.mutations[i]!;
    if (m.kind !== 'box') continue;
    if (m.op === 'insert') {
      pendingInsertIndex.set(m.boxId, i);
    } else {
      const insertIdx = pendingInsertIndex.get(m.boxId);
      if (insertIdx !== undefined) {
        cancelled.add(insertIdx);
        cancelled.add(i);
        pendingInsertIndex.delete(m.boxId);
      }
    }
  }
  const consumed: string[] = [];
  const created: AnyBox[] = [];
  // Insertion-ordered by key, so the last write to a key wins while the map
  // itself stays deterministic. Collapsing must happen here, where journal
  // application order is still authoritative: record puts are not commutative,
  // so `applyBlockMutations`' sort-by-key could not recover which write is
  // last. The journal keeps both entries regardless — rollback needs the
  // first's `replaced`.
  const recordByKey = new Map<string, RecordPut>();
  let latestNetwork: NetworkPut | null = null;
  const nrKey = networkRecordKey();
  for (let i = 0; i < journal.mutations.length; i++) {
    if (cancelled.has(i)) continue;
    const m = journal.mutations[i]!;
    switch (m.kind) {
      case 'box':
        if (m.op === 'remove') consumed.push(m.boxId);
        else created.push(m.box!);
        break;
      case 'record':
        recordByKey.set(m.key, { key: m.key, record: m.record });
        break;
      case 'network':
        latestNetwork = { key: nrKey, network: { memberCount: m.memberCount } };
        break;
      default: {
        // Compile-time exhaustiveness: a new committed entity kind that nobody
        // feeds to the prover is silently absent from the stateRoot, and no
        // test can catch that — this assignment is the only enforcement.
        const _exhaustive: never = m;
        void _exhaustive;
        break;
      }
    }
  }
  return {
    consumed,
    created,
    recordPuts: [...recordByKey.values()],
    networkPuts: latestNetwork ? [latestNetwork] : [],
  };
}

/**
 * Carries the speculative run's result out through the throw that forces
 * better-sqlite3 to roll the transaction back — the value and the rollback are
 * the same event, so neither can happen without the other.
 */
class SpeculativeRollback extends Error {
  constructor(readonly digestHex: string) {
    super('speculative state-root run rolled back');
  }
}

/**
 * What the speculative state-root run answered. The two non-computed arms are
 * deliberately not one `null`: they demand opposite reactions from the block
 * creator, and conflating them puts a node back on the defect this type exists
 * to prevent — mining a body its own mutation phase has already rejected.
 */
export type StateRootSpeculation =
  /** The post-block digest the header must commit to. Mine over it. */
  | { kind: 'computed'; stateRoot: string }
  /** No usable prover — test-only; the caller writes `EMPTY_STATE_ROOT`. */
  | { kind: 'no-prover' }
  /**
   * Producing this block is forbidden — the body was rejected, or speculating
   * on it threw. One arm because the caller's obligation is one: do not mine,
   * and clear the body that produced it. The two are separated in the log,
   * where the difference is actionable, not in the type, where it is not.
   */
  | { kind: 'body-rejected' };

/**
 * The post-block AVL digest a candidate block's header must commit to as
 * `stateRoot` (H-6; NODE_INTERFACE → Post-block stateRoot), as a
 * `StateRootSpeculation`.
 *
 * PoW covers the header, so the producer has to know this digest *before*
 * mining, and the only way to know it without a second implementation of the
 * state transition is to run the block's own body. That happens here: the
 * mutation phase, verbatim, at the block's height, inside a SQLite transaction
 * that is always rolled back. No block storage, no `clearTemplate`, no journal
 * persistence, no prover checkpoint.
 *
 * SQLite rollback does not reach the prover's in-memory tree, so the digest is
 * snapshotted up front and restored explicitly afterwards — the same asymmetry
 * the apply funnel handles for rejected blocks.
 *
 * The candidate carries a placeholder header (`powNonce` 0, empty signature):
 * the mutation phase reads neither, and takes its height as an argument.
 *
 * An unexpected throw maps to `body-rejected`, not to the proverless fallback:
 * the apply funnel treats the same throw as a rejection of the block, so a
 * body that crashes speculation is a body no node — this one included —
 * will apply.
 *
 * ⛔ **`CorruptChainStateError` is the exception, and it calls the boundary
 * here rather than re-throwing.** Producing is where the fault would otherwise
 * be silent: mapped to `body-rejected` it would stop this node producing while
 * it stayed up, which is the one outcome `services/corrupt-state.ts` exists to
 * prevent. Re-throwing is not open either — the caller in `createOrderingBlock`
 * has no try/catch around it, and its neighbours already call
 * `failStopIfCorruptChain` directly.
 *
 * ⚠ **The `finally` below does NOT run on that arm.** `process.exit(1)` does not
 * unwind, so the journal abort and the prover restore are both skipped. That is
 * correct — the process is ending and nothing reads the tree afterwards — but a
 * reader who assumes `finally` always runs will mis-reason about it.
 */
export function computePostBlockStateRoot(
  block: OrderingBlock,
  height: number,
): StateRootSpeculation {
  const handle = tryGetAvlProver();
  if (!handle) return { kind: 'no-prover' };
  const snapshot = handle.prover.digest();
  if (!snapshot) return { kind: 'no-prover' };

  try {
    getDb().transaction((): void => {
      beginBlockJournal(height);
      if (!applyMutationPhase(block, height)) throw new BlockRejected();
      const { consumed, created, recordPuts, networkPuts } = proverFeedFromJournal(finishBlockJournal());
      // The digest rides out on the throw: nothing this run did may survive.
      throw new SpeculativeRollback(
        Buffer.from(
          applyBlockMutations(handle.prover, height, consumed, created, recordPuts, networkPuts),
        ).toString('hex'),
      );
    })();
    throw new Error('unreachable: speculative run must exit via throw');
  } catch (err) {
    if (err instanceof SpeculativeRollback) {
      return { kind: 'computed', stateRoot: err.digestHex };
    }
    if (err instanceof BlockRejected) {
      console.warn(
        `stateRoot speculation at height ${height}: the body was rejected by its ` +
        `own mutation phase — the block cannot be produced`,
      );
      return { kind: 'body-rejected' };
    }
    // Above the unclaimed-throw arm, because that arm would swallow it into a
    // verdict about the block. Never returns.
    if (err instanceof CorruptChainStateError) {
      failStopIfCorruptChain(err);
    }
    // No arm above claimed this throw, so it is not a rejection this node
    // decided. The verdict stays `body-rejected` — the apply funnel converts
    // the same throw into a rejection, so no node would apply this body — but
    // it must not be *logged* as one: forever-rejecting and never-producing are
    // the same silence from two different faults, and the arm above already
    // prints the one that is a verdict. `err` rather than `String(err)`,
    // because for an unclaimed throw the stack is the whole diagnosis.
    console.error(
      `INTERNAL: unclaimed throw in stateRoot speculation at height ${height} ` +
      `— not producing this block`,
      err,
    );
    return { kind: 'body-rejected' };
  } finally {
    // The transaction is rolled back by the time this runs (better-sqlite3
    // issues ROLLBACK before re-throwing). These undo what it cannot reach.
    abortBlockJournal();
    const current = handle.prover.digest();
    if (!current || !Buffer.from(current).equals(Buffer.from(snapshot))) {
      handle.prover.rollback(snapshot);
    }
  }
}

/**
 * The block's state transition — everything between the header-dependent
 * validation and the commit (NODE_INTERFACE → "Apply funnel: validation and
 * mutation phases").
 *
 * Height is a parameter rather than `block.header.height` because the block
 * creator runs this phase before its header exists, to compute the post-block
 * `stateRoot` it must commit to (H-6). The split is structural: there is no
 * "skip the checks" mode on the apply path, and the body-level rejections here
 * (prune verification, embedded-tx re-validation) reject on both paths
 * identically.
 *
 * Journal-lifecycle-free by contract: a journal is already open when this runs
 * and the caller finishes or aborts it, so both callers record the same way.
 */
function applyMutationPhase(
  block: OrderingBlock,
  height: number,
): boolean {
  // ⛔ **DECAY AND ESCROWS ARE DERIVED FROM PRE-BODY STATE, AND THEY HAVE
  // TO BE.** Decay is computed after decoding (the touched set comes from the
  // decoded transactions' inputs) but before the apply loop, so the UTXO
  // state is pre-body. Escrows are captured here for the same reason: the
  // body can create one (an unvouch of a long-held vouch), and a post-body
  // read would see it on one side only
  // (NODE_INTERFACE → The settlement transaction).
  // Both are assigned at §9b, after decoding and before the apply loop.

  // Every post id the block commits to, independent of per-post confirm
  // outcomes — same semantics as the confirm loop in §7, which tolerates
  // per-post failures. Both read `postsOf`, so rollback un-confirms exactly what
  // apply confirmed.
  const blockPosts = postsOf(block);
  recordConfirmedPosts(postIdsOf(block));

  // 7. The coinbase is applied with the rest of the settlement, at §11a — after
  // the body, because the fees it pays out are a property of what the body
  // applied. ⛔ **There is no mint**: the credits are spent from the
  // `EmissionBox` by the same transaction that emits them, so source and
  // destination are named in one operation (MINING_INTERFACE → Coinbase
  // Application).

  // 7. Confirm the posts this block creates; insert a placeholder for any absent row.
  //
  // A row already present (pending, from the packet) is confirmed as-is. A row
  // absent — the packet never reached this node — is inserted from the commit
  // with content = NULL (the placeholder). The body is backfilled by id
  // (NODE_INTERFACE → Store Interface → Posts DAG, "Backfill after sync").
  for (let idx = 0; idx < blockPosts.length; idx++) {
    const { postId, post } = blockPosts[idx]!;
    if (!getPost(postId)) {
      try {
        insertPost(postId, post, null);
        emitPostIndexed(postId, post.parentRefs.length);
      } catch (err) {
        console.warn(`Failed to store post ${postId}: ${String(err)}`);
      }
    }
    try {
      confirmPost(postId, height, idx);
    } catch (err) {
      console.warn(`Failed to confirm post ${postId}: ${String(err)}`);
    }
  }

  // 8. Populate block_topology from this block's post transactions.
  // Consensus data only — this, not dag_posts.author, is the authority for prune
  // authorization, and it is derivable by any node holding the block body.
  for (const { postId, post } of blockPosts) {
    insertBlockTopology(
      postId,
      post.parentRefs,
      Buffer.from(post.author).toString('hex'),
      height,
    );
  }

  // 11. Apply UTXO transactions from the block.
  //
  // Two distinct failure modes, deliberately handled differently:
  //
  //  - Inputs not present yet → defer and retry. A tx may consume a box
  //    created by an earlier tx in the same block, and block order does not
  //    have to be dependency order, so the loop makes repeated passes until it
  //    stops making progress. A tx whose inputs never arrive rejects the block:
  //    the block commits to it in `utxoTxIds`, so a body that cannot apply it
  //    is a body its own `stateRoot` cannot reflect.
  //
  //  - Inputs present but the tx is invalid → reject the whole block. Validator
  //    selection is permissionless PoW, so the producer is untrusted and
  //    nothing about an embedded tx may be assumed: it may never have passed
  //    pool entry or relay validation on any node. Once a tx's inputs are all
  //    present it is fully decidable, so it is re-validated here in full —
  //    signatures, authorization, transitions, conservation — and a failure means the
  //    block itself is malformed. A valid block cannot contain an invalid tx.
  const utxoDeps = {
    getBox,
      insertBox,
    consumeBox,
    getKarmaBox,
    // The vouch cast's minimum-balance gate reads the voucher's current summed
    // karma (ARCHITECTURE → "Vouch boxes"). The store's getKarmaValue is the
    // single implementation shared with the pool and relay paths — a different
    // read here would be a consensus split, not a style difference.
    getKarmaValue,
    // The vouch cast's cooldown gate (NODE_INTERFACE → "Vouch transition
    // rules") — same single-implementation rule as getKarmaValue.
    hasActiveVouchEscrow,
    vouchCooldownBlocks: config.vouchCooldownBlocks,
    inviteBondMin: config.inviteBondMin,
    inviteBondMax: config.inviteBondMax,
    decayCfg: {
      staleThresholdBlocks: config.karmaStaleThresholdBlocks,
      decayIntervalBlocks: config.karmaDecayIntervalBlocks,
      decayAmount: config.karmaDecayAmount,
      karmaMinimum: config.karmaMinimum,
    },
    storageRentPeriodBlocks: config.storageRentPeriodBlocks,
    getBoxProvenance,
    // ⛔ The like marker's author, from `block_topology` and never
    // `dag_posts.author` (ARCHITECTURE → Likes). The same read §11's apply arm
    // makes, so the marker's pin and the like-record's author cannot disagree.
    getTopologyAuthor: getTopologyAuthorBytes,
    // NODE_INTERFACE → Post transactions: at apply only `block_topology` is read.
    getPendingPostAuthor: () => null,
    // The invite-create not-already-an-account bar (NODE_INTERFACE → "Bond
    // transition rules") — same rule again.
    getIdentityRecord,
    runInTransaction: (fn: () => void) => {
      getDb().transaction(fn)();
    },
    getVouchBox,
    getNetworkRecord,
    membershipBarMultiplier: config.membershipBarMultiplier,
    putIdentityRecord,
    protocolVersionSchedule: config.protocolVersionSchedule,
  };

  // The proof obligation (NODE_INTERFACE → "Embedded transactions: a mismatch
  // rejects the block"): every declared `utxoTxId` must be proven to be the id
  // of the bytes carried beside it, and an arm that cannot complete that proof
  // rejects the block. A body that does not match its committed ids would
  // otherwise apply different state under one block hash. Stated as a property
  // rather than as a list, so a guard added here later inherits the verdict.
  interface QueuedTx {
    txId: string;
    tx: UtxoTransaction;
    outputs: AnyBox[];
  }
  const queue: QueuedTx[] = [];
  // ⛔ **The LAST entry is the settlement, and that is the whole of how it is
  // identified** (NODE_INTERFACE → It is the LAST entry in `utxoTxIds`).
  // `verifyOrderingBlockStructure` has already refused a body with no entries,
  // so this index exists; identifying the settlement by position rather than by
  // what it spends is what lets a node find it with no UTXO set at all.
  const lastIndex = block.utxoTxTree.utxoTxIds.length - 1;
  let settlement: { txId: string; tx: UtxoTransaction; outputs: AnyBox[] } | null = null;
  for (let i = 0; i < block.utxoTxTree.utxoTxIds.length; i++) {
    const txId = block.utxoTxTree.utxoTxIds[i]!;
    const txBytes = block.utxoTxTree.utxoTxs[i];
    const isSettlement = i === lastIndex;

    if (!txBytes) {
      console.warn(
        `Rejected block height=${height}: embedded UTXO tx ${txId} carries no body`,
      );
      return false;
    }

    let tx: UtxoTransaction;
    try {
      tx = decodeTx(txBytes);
    } catch (err) {
      console.warn(
        `Rejected block height=${height}: embedded UTXO tx ${txId} did not ` +
        `decode: ${String(err)}`,
      );
      return false;
    }

    // Both gates run before `computeTxId` hashes the decoded value, and
    // together they are what makes that hash total: the envelope types every
    // field `txIdBytes` reads directly, the output check the fields it
    // reaches through `canonicalBoxBytes`' throwing writers (NODE_INTERFACE →
    // "The output domain check"). Unchecked, an out-of-domain output field
    // becomes an exception absorbed by the funnel's totality handler instead of
    // the stated rejection below.
    //
    // ⚠ **The settlement gets the schema that admits the three protocol
    // boxes.** It creates the emission, treasury and pool successors, which a
    // user transaction may not — the same closed key set (the four required
    // fields plus `likeTarget`, `post`, `prune` and `postWithdraw`) and the
    // same field types, over a wider set of box types.
    const envelopeCheck = checkTxEnvelope(tx);
    if (!envelopeCheck.valid) {
      console.warn(
        `Rejected block height=${height}: embedded UTXO tx ${txId} has a ` +
        `malformed envelope: ${envelopeCheck.error}`,
      );
      return false;
    }

    const outputCheck = isSettlement
      ? checkSettlementOutputShape(tx.outputs)
      : checkOutputShape(tx.outputs);
    if (!outputCheck.valid) {
      console.warn(
        `Rejected block height=${height}: embedded UTXO tx ${txId} has an ` +
        `out-of-domain output: ${outputCheck.error}`,
      );
      return false;
    }

    const decodedTxId = computeTxId(tx);
    if (decodedTxId !== txId) {
      console.warn(
        `Rejected block height=${height}: embedded UTXO tx ${txId} declares an ` +
        `id its bytes do not produce (${decodedTxId})`,
      );
      return false;
    }

    // `txId` here is the block's declared id, already checked byte-for-byte
    // against `computeTxId(tx)` above — so it is the real creating transaction,
    // not a re-derivation. Position in `tx.outputs` is the `index`.
    const outputs = tx.outputs.map((box, index) =>
      materializeOutput(box as AnyBox, txId, index),
    );
    // ⛔ **The settlement never enters the queue.** `validateTx` governs user
    // transactions: no signer authorizes a settlement and no transition row
    // admits the pool, the emission box or a fee box as an input, so putting it
    // through that gate would reject every valid block. Its own rule is
    // `checkSettlement`, at §11a, after the body it is derived from has applied.
    if (isSettlement) settlement = { txId, tx, outputs };
    else queue.push({ txId, tx, outputs });
  }
  if (settlement === null) {
    console.warn(
      `Rejected block height=${height}: body carries no settlement transaction`,
    );
    return false;
  }

  // Per-block like accrual: in-memory, this invocation only — the
  // end-of-phase settlement (§11b) reads both maps. Local by design, so the
  // speculative (creator) run accrues and settles identically and its rollback
  // discards everything with it.
  const likesPerAuthor = new Map<string, number>(); // author hex → likes this block
  const memberLikesPerAuthor = new Map<string, number>(); // author hex → member-likes this block
  // Identities the membership pass evaluates — every vouch target whose box was
  // cast or consumed, every author whose memberLikes rose. Captured during the
  // apply loop; the pass runs after the like counters.
  const membershipTouched = new Set<string>();
  // Pre-block records for touched identities — the first write's `replaced`.
  const preBlockRecords = new Map<string, IdentityRecord | null>();

  // What the settlement is derived from, accumulated as each transaction is
  // applied (MINING_INTERFACE → Coinbase Application). Gathered here rather than
  // ahead of the loop because this is the only place an input is guaranteed to
  // resolve: a transaction may spend a box an earlier transaction in this same
  // block creates, and until the loop has applied that one, the confirmed set
  // this phase reads through does not hold the output.
  //
  // ⛔ **Collected in COMMITTED TRANSACTION ORDER, not apply order.** The
  // deferral loop below may apply a later transaction first, and the settlement
  // lists its fee-box inputs in the order the body fixes — so each transaction's
  // contribution is written to its own slot and the slots are flattened after
  // the loop. That is the difference between an order the block fixes and one
  // this node's dependency resolution happened to produce.
  //
  // `appliedTxs` carries each transaction with its FIRST input box, which is
  // all `actorOf` reads, and reading it is sound only because `validateTx` has
  // passed by the time it is recorded — step 3's boxType pin is what makes the
  // first input speak for the transaction rather than being the producer's
  // choice.
  const perTxOutputs = new Map<string, AnyBox[]>();
  const rentTxIds = new Set<string>();
  const appliedTxs: EmbeddedTx[] = [];

  // ⛔ **Two inviters naming the same key in one block must not both grant**
  // (NODE_INTERFACE → Legal box transitions). The eligibility test each invite
  // passed is `IdentityRecord` existence, and the grant that writes that record
  // is the settlement's — which runs after every transaction here — so a
  // record-existence test cannot see a sibling transaction in the same block.
  // Without this the second bond draws a second grant from the pool for one
  // key, sized by whatever bond the second inviter chose.
  const invitedThisBlock = new Set<string>();

  // §9b. Pre-body captures: decay and escrows.
  //
  // Decay: squared per identity on touch (ARCHITECTURE → Karma decay). The
  // post-body projection derives from decoded transactions + the pre-body
  // UTXO set — both available before the apply loop. The settlement consumes
  // the projected boxes, which are the ones that exist after the body applies.
  const postBodyKarma = collectPostBodyKarma(
    queue.map((q) => ({ txId: q.txId, inputs: q.tx.inputs, outputs: q.outputs })),
  );
  const decayPlans = deriveKarmaDecay(decayDeps, postBodyKarma, height, {
    staleThresholdBlocks: config.karmaStaleThresholdBlocks,
    decayIntervalBlocks: config.karmaDecayIntervalBlocks,
    decayAmount: config.karmaDecayAmount,
    karmaMinimum: config.karmaMinimum,
  });
  // Escrows and release candidates: captured before the apply loop so the
  // body's own mutations do not appear in the settlement's input list on one
  // side only. A prune in this block's body marks rows during §8c, after the
  // capture, so its locks are candidates from h + 1.
  const escrows = getVouchEscrowsReleasableAt(height, MAX_ESCROW_RETURNS_PER_BLOCK);
  const lapsedVouches = getLapsedVouches(MAX_LAPSE_WITHDRAWALS_PER_BLOCK);

  // Multi-pass: try to apply txs, retrying those whose inputs aren't
  // available yet (may have been created by an earlier tx in this block).
  //
  // ⛔ **There is no pass bound, and adding one would create a consensus
  // parameter.** Validity is "every embedded transaction applied", with no
  // number in it; a cap makes a block carrying a chain deeper than the cap
  // invalid here and valid on a node that chose a larger one, from the same
  // bytes. Selection cannot fix that — selection is local, and an incoming
  // block is not bound by it.
  //
  // Termination does not rest on a cap either. The `applied === 0` return below
  // ends the loop the moment a pass makes no progress, so every pass that
  // continues applied at least one transaction and the pass count is bounded by
  // the block's transaction count.
  while (queue.length > 0) {
    const remaining: QueuedTx[] = [];
    let applied = 0;

    for (const item of queue) {
      const allInputsExist = item.tx.inputs.every((id) => getBox(id) !== null);
      if (!allInputsExist) {
        remaining.push(item);
        continue;
      }

      // Every input is present, so the verdict cannot change on a later pass:
      // full re-validation, and anything it rejects rejects the block. Testing
      // presence first is what keeps the two cases apart — the only reason
      // validateTx could still fail on liveness is a tx that lists the same
      // input twice, which is malformed, not deferrable.
      const revalidated = validateTx(utxoDeps, item.tx, height);
      if (!revalidated.valid) {
        console.warn(
          `Rejected block height=${height}: embedded UTXO tx ` +
          `${item.txId} failed re-validation: ${revalidated.error}`,
        );
        return false;
      }

      // Like apply rules (NODE_INTERFACE → Per-block like settlement):
      // re-checked at apply — consensus, not gateway courtesy — and BEFORE
      // applyTx, so a failing like never mutates state. Any failure rejects
      // the whole block, like any other invalid embedded tx.
      let likeToRecord: {
        targetPostId: string;
        likerId: Uint8Array;
        authorHex: string;
      } | null = null;
      if (item.tx.likeTarget !== undefined) {
        const targetPostId = item.tx.likeTarget;
        // Confirmed ⟺ a topology row exists, and its author — never
        // dag_posts.author — is who the like credits: placeholder rows carry
        // a zeroed author, and a like on a confirmed but content-less post
        // must credit the consensus-recorded author.
        const authorHex = getTopologyAuthor(targetPostId);
        if (authorHex === null) {
          console.warn(
            `Rejected block height=${height}: like tx ${item.txId} targets ` +
            `unconfirmed post ${targetPostId}`,
          );
          return false;
        }
        // NODE_INTERFACE → Karma transition rules: a like targets a live post
        // only — a placeholder is live (credits the topology author). A stump,
        // tombstone, or null rejects.
        const target = getPost(targetPostId);
        if (!isLivePost(target)) {
          console.warn(
            `Rejected block height=${height}: like tx ${item.txId} targets ` +
            `pruned, withdrawn or unknown post ${targetPostId}`,
          );
          return false;
        }
        // The liker is the karma inputs' owner, read from the input boxes —
        // never from the signature map. The gateway's one-signature rule is
        // gateway policy; a validator can embed a spare-signature like tx
        // directly, and it must still apply with the liker the owner state
        // names. validateTx above pinned every input to one karma owner, so
        // the first input names it.
        const likerId = (getBox(item.tx.inputs[0]!) as KarmaBox).owner;
        // One like per account per post, structurally: the key exists or it
        // does not. Applied likes earlier in this block already inserted
        // their record, so an intra-block duplicate fails here too.
        if (hasLikeRecord(targetPostId, likerId)) {
          console.warn(
            `Rejected block height=${height}: like tx ${item.txId} ` +
            `duplicates an existing like-record for ${targetPostId}`,
          );
          return false;
        }
        likeToRecord = { targetPostId, likerId, authorHex };
      }

      // ⛔ **THE UNVOUCH NEEDS NO ARM HERE.** The stake moves into a
      // `VouchEscrowBox` the voucher's own transaction outputs, so `applyTx`
      // inserts it like any other output and the store's choke point journals it
      // with an exact inverse. ✅ **The obligation is committed state**, in the
      // UTXO set and therefore in the `stateRoot`, so nothing has to remember it
      // (ARCHITECTURE → Vouch boxes).

      // ⛔ **One invitee per block.** The bond IS the request, so a second bond
      // naming a key an earlier transaction in this block already named would
      // draw a second grant from the pool for one key. Refused before `applyTx`,
      // so a rejected block has mutated nothing on this transaction's account.
      const invitee = bondInviteeOf(item.outputs);
      if (invitee !== null) {
        const inviteeHex = Buffer.from(invitee).toString('hex');
        if (invitedThisBlock.has(inviteeHex)) {
          console.warn(
            `Rejected block height=${height}: invite tx ${item.txId} names ` +
            `${inviteeHex}, which another bond in this block already names`,
          );
          return false;
        }
        invitedThisBlock.add(inviteeHex);
      }

      // Before `applyTx` consumes them. Every input is present (tested at the
      // top of this iteration) and reading the first is sound because
      // `validateTx` has just passed (NODE_INTERFACE → `validateTx` step 3).
      const firstInput = item.tx.inputs[0];
      const firstInputBox = firstInput !== undefined ? getBox(firstInput)! : null;
      if (firstInputBox !== null) {
        appliedTxs.push({ tx: item.tx, inputBoxes: [firstInputBox] });
      }

      // Rent recognition by shape: an unsigned credit-side tx that passed
      // authorization is a rent collection (NODE_INTERFACE → "Storage rent
      // is a transition requiring no signature"). The biconditional is
      // structural — authorization refuses unsigned non-eligible credit.
      if (isCreditSideTx(item.tx) && Object.keys(item.tx.signatures).length === 0) {
        rentTxIds.add(item.txId);
      }

      perTxOutputs.set(item.txId, item.outputs);

      // Track vouch targets for the membership pass. Capture the pre-block
      // record BEFORE applyTx modifies it — both inputs (consumed) and outputs
      // (created), so the pass sees the true pre-block value.
      for (const inputId of item.tx.inputs) {
        const inputBox = getBox(inputId);
        if (inputBox && inputBox.boxType === 'vouch') {
          const targetHex = Buffer.from((inputBox as VouchBox).targetId).toString('hex');
          membershipTouched.add(targetHex);
          if (!preBlockRecords.has(targetHex)) {
            preBlockRecords.set(targetHex, getIdentityRecord((inputBox as VouchBox).targetId));
          }
        }
      }
      for (const out of item.outputs) {
        if (out.boxType === 'vouch') {
          const targetHex = Buffer.from((out as VouchBox).targetId).toString('hex');
          membershipTouched.add(targetHex);
          if (!preBlockRecords.has(targetHex)) {
            preBlockRecords.set(targetHex, getIdentityRecord((out as VouchBox).targetId));
          }
        }
      }

      applyTx(utxoDeps, item.tx, item.outputs, height);
      applied++;

      // The spend is the activity (ARCHITECTURE → Karma decay). The karma arm
      // pins one owner for all karma inputs; the first input's owner is that
      // owner. The write lands after applyTx's box writes, so reverse replay
      // restores it first (NODE_INTERFACE → Populating the record).
      if (firstInputBox?.boxType === 'karma') {
        recordKarmaActivity((firstInputBox as KarmaBox).owner);
      }

      if (likeToRecord !== null) {
        // Journalled side-record (inverse: deleteLikeRecord), plus the
        // in-memory accrual §11b settles.
        insertLikeRecord(likeToRecord.targetPostId, likeToRecord.likerId, height);
        likesPerAuthor.set(
          likeToRecord.authorHex,
          (likesPerAuthor.get(likeToRecord.authorHex) ?? 0) + 1,
        );
        // ARCHITECTURE → Membership: memberLikes bumped iff member(liker).
        const likerRecord = getIdentityRecord(likeToRecord.likerId);
        if (likerRecord && isMember(likerRecord)) {
          memberLikesPerAuthor.set(
            likeToRecord.authorHex,
            (memberLikesPerAuthor.get(likeToRecord.authorHex) ?? 0) + 1,
          );
        }
      }

      // Remove from the local mempool if present. This is the whole of the
      // cleanup for a block that arrived from a peer — a block this node mined
      // is cleaned by rowid in `finalizeBlock`, which reaches every included
      // entry wherever it sits (MEMPOOL_INTERFACE → Confirmed-entry cleanup reaches every row).
      removeUtxoTxEntry(item.txId);

      // Box mutations are journaled by the store choke point; the tx itself
      // is kept for mempool re-insertion on reorg.
      recordAppliedUtxoTx(item.txId, encodeTx(item.tx));
    }

    if (applied === 0) {
      // No progress, so these inputs will never exist: the block commits in
      // `utxoTxIds` to a transaction its own `stateRoot` cannot reflect. Reject
      // it, like the two arms above — the block is invalid if any embedded
      // transaction does not apply (NODE_INTERFACE → "A block is invalid if any
      // embedded transaction does not apply").
      for (const item of remaining) {
        console.warn(
          `Rejected block height=${height}: embedded UTXO tx ${item.txId} ` +
          `has an input no transaction in this block creates and the chain ` +
          `does not hold`,
        );
      }
      return false;
    }
    queue.length = 0;
    queue.push(...remaining);
  }

  // 8b. Process withdrawal transactions from this block.
  const withdrawnThisBlock = new Set<string>();
  const blockWithdrawals = withdrawalsOf(block, getTopologyAuthorBytes);
  for (const bw of blockWithdrawals) {
    const { postWithdraw } = bw;
    const postId = postWithdraw.postId;

    const postHeight = getTopologyHeight(postId);
    if (postHeight === null || postHeight >= height) {
      console.error(
        `Block ${height}: postWithdraw ${postId} is not confirmed ` +
        `in an earlier block (topology height ${postHeight})`,
      );
      return false;
    }

    const existing = getPost(postId);
    if (!isStoredPost(existing) || existing.withdrawnAtHeight !== null) {
      console.error(
        `Block ${height}: postWithdraw ${postId} targets an already-withdrawn or unknown post`,
      );
      return false;
    }
    if (withdrawnThisBlock.has(postId)) {
      console.error(
        `Block ${height}: duplicate postWithdraw for ${postId} in the same block`,
      );
      return false;
    }
    withdrawnThisBlock.add(postId);

    const priorContent = existing.content;
    recordWithdrawnPost(postId, priorContent);
    withdrawPost(postId, height);
  }

  // 8c. Prune transactions — derived set (NODE_INTERFACE → Prune transactions).
  //
  // The set is derived from `getSubtreeTopology(rootPostHash)` as topology
  // stands after §8 populated it from this block, so a same-block reply is
  // in the set.
  const blockPrunes = prunesOf(block, getTopologyAuthorBytes);
  for (const bp of blockPrunes) {
    const { prune } = bp;

    // Maturity bind (NODE_INTERFACE → Prune transactions).
    const rootHeight = getTopologyHeight(prune.rootPostHash);
    if (rootHeight === null || rootHeight >= height) {
      console.error(
        `Block ${height}: prune root ${prune.rootPostHash} is not confirmed ` +
        `in an earlier block (topology height ${rootHeight})`,
      );
      return false;
    }

    // The set is derived, not from the payload.
    const subtreePostIds = [...getSubtreeTopology(prune.rootPostHash)];

    const likeTally = deleteLikeRecordsForPosts(subtreePostIds);

    const stump = {
      rootPostHash: prune.rootPostHash,
      authorId: bp.author,
      replyCount: subtreePostIds.length - 1,
      upvoteCount: likeTally,
      protocolVersion: PROTOCOL_VERSION,
      compactedAtBlockHeight: height,
    };
    insertStump(stump);
    recordInsertedStump(stump);

    const deleted = deletePostRows(subtreePostIds);
    recordDeletedPosts(deleted);

    markPrunedTopology(subtreePostIds, height, prune.rootPostHash);
  }

  // 11a. The settlement transaction — the block's every protocol effect, in one
  // transaction committed under `utxoTxRoot` (NODE_INTERFACE → the settlement
  // transaction).
  //
  // It sits after the loop because what it consumes and pays is a property of
  // what the body applied, and inside this phase because the phase is the one
  // derivation both the applier and the creator's speculative run share — so a
  // creator whose own settlement does not match its body declines to produce the
  // block instead of mining one every peer will refuse.
  //
  // ⛔ **The body is read in COMMITTED transaction order**, walking
  // `utxoTxIds` rather than the order deferral applied them in. The settlement
  // lists its fee-box inputs in that order and its id hashes them in that order,
  // so a node whose dependency resolution ran differently must still derive the
  // same transaction.
  const settlementBody = emptyBody();
  for (let i = 0; i < lastIndex; i++) {
    const txId = block.utxoTxTree.utxoTxIds[i]!;
    const outputs = perTxOutputs.get(txId);
    if (outputs) contributeToBody(settlementBody, outputs, rentTxIds.has(txId));
  }
  settlementBody.actors = countKarmaActors(appliedTxs, block.header.validatorId);

  const emission = computeBlockReward(height);
  const settlementCheck = checkSettlement(
    settlementDepsWith(() => decayPlans, escrows, lapsedVouches),
    height,
    emission,
    config.creditMinerRewardDelay,
    settlementBody,
    settlement.tx,
  );
  if (!settlementCheck.valid) {
    console.warn(
      `Rejected block height=${height}: settlement ${settlement.txId}: ` +
      `${settlementCheck.error}`,
    );
    return false;
  }

  // 11a-i. Apply it, like any other transaction: consume the inputs, insert the
  // outputs. That is what makes the coinbase, the emission and treasury
  // successors and every invite grant one operation with a named source and a
  // named sink (ARCHITECTURE → The conservation axiom).
  //
  // ⛔ **The fee boxes are consumed HERE, as the settlement's inputs.** Block
  // application is their only spender and it runs once per block, so a fee box
  // surviving its block would hand its value to a later miner and break the
  // coinbase identity. Every insert above is followed by its remove here, so
  // `proverFeedFromJournal` nets the pair and neither operation reaches the
  // prover — a fee box is absent from the AVL tree in the only block it ever
  // exists in.
  //
  // ⛔ **NOT `recordAppliedUtxoTx`, and that is not an omission.** The journal's
  // transaction records exist for one purpose — `revertBlock` re-inserts them
  // into the mempool — and the settlement is derived from a body rather than
  // submitted by anyone. Recording it would put a protocol transaction into the
  // pool on every reorg, where the next fill would draw it in as a user entry.
  // Its box mutations are journalled by the store choke point like every other,
  // so the rollback inverse is unaffected.
  // The lapse leg's vouch consumptions lower targets' memberVouches through
  // applyTx below — capture each target before the apply so the membership pass
  // evaluates them.
  for (const v of lapsedVouches) {
    const targetHex = Buffer.from(v.targetId).toString('hex');
    membershipTouched.add(targetHex);
    if (!preBlockRecords.has(targetHex)) {
      preBlockRecords.set(targetHex, getIdentityRecord(v.targetId));
    }
  }

  applyTx(utxoDeps, settlement.tx, settlement.outputs, height);

  // 11a-ii. The clock epoch: a new record's `lastActivityBlock` starts at the
  // claim height (NODE_INTERFACE → Identity Records; ARCHITECTURE → Karma
  // decay, "the clock starts at onboarding"). The grant is a settlement
  // output, and only the user loop advances the clock — the epoch is this
  // record write's, not a spend event's. A legal invitee has no record yet,
  // so `after` is null and the fallback applies; a pre-existing record is a
  // consensus bar violation upstream, not something this write papers over.
  // Ascending invitee order, so two grants in one block write in an order the
  // block fixes rather than one a map's iteration happens to produce.
  for (const inviteeHex of [...invitedThisBlock].sort()) {
    const invitee = new Uint8Array(Buffer.from(inviteeHex, 'hex'));
    const after = getIdentityRecord(invitee);
    putIdentityRecord(invitee, {
      lastActivityBlock: after?.lastActivityBlock ?? height,
      lastDecayBlock: after?.lastDecayBlock ?? 0,
      invitedAtBlock: height,
      // Carried through rather than written, and it is always 0 here: a legal
      // invitee is not an account yet, so it has never held karma, never posted
      // and never been liked. The read is what keeps that a consequence of the
      // bar rather than an assumption this line makes.
      lifetimeLikesReceived: after?.lifetimeLikesReceived ?? 0n,
      memberSinceBlock: after?.memberSinceBlock ?? 0,
      memberBar: after?.memberBar ?? 0,
      memberVouches: after?.memberVouches ?? 0,
      memberLikes: after?.memberLikes ?? 0n,
      invitesUsed: after?.invitesUsed ?? 0,
    });
  }

  // 11b. The bookkeeping the settlement's boxes do not carry.
  //
  // ⛔ **EVERY VALUE MOVEMENT IS ABOVE THIS LINE.** The like payout, the carry,
  // the escrow releases, the vested bonds, the decay charges and the prune
  // refunds are all outputs of the settlement transaction, because each one
  // either draws from or returns to the karma pool and the settlement is the
  // pool's only spender (NODE_INTERFACE → The settlement transaction). What is
  // left here is committed state that is not a box: the like counter and the
  // decay clock.
  //
  // Order pinned by the contract: embedded txs → settlement → author counters →
  // decay clocks.

  // The lifetime like counter, ascending author-hex order.
  //
  // ⛔ **This settlement is the counter's ONLY writer, and it only ever adds.**
  // Nothing subtracts — prune deletes the like-records behind these likes and
  // must not reach this field, or a pruning author could lower a count somebody
  // else's bond settles against (ARCHITECTURE → Bond outcomes).
  //
  // ⚠ **The outstanding accrual is NOT written back**, because there is nothing
  // to write: the carry is a `LikeAccrualBox` the settlement just emitted, and
  // the box IS the carry (ARCHITECTURE → Likes).
  for (const authorHex of [...likesPerAuthor.keys()].sort()) {
    const author = new Uint8Array(Buffer.from(authorHex, 'hex'));
    const received = BigInt(likesPerAuthor.get(authorHex)!);
    // Re-read after the settlement so the activity bump its karma output wrote
    // is preserved; a missing record means maximally stale ({0, 0}), never
    // "skip this author".
    const after = getIdentityRecord(author);
    putIdentityRecord(author, {
      lastActivityBlock: after?.lastActivityBlock ?? 0,
      lastDecayBlock: after?.lastDecayBlock ?? 0,
      // Carried through: the grant path owns it, and an author being paid for
      // likes in the same block they were invited is reachable.
      invitedAtBlock: after?.invitedAtBlock ?? 0,
      lifetimeLikesReceived: (after?.lifetimeLikesReceived ?? 0n) + received,
      memberSinceBlock: after?.memberSinceBlock ?? 0,
      memberBar: after?.memberBar ?? 0,
      memberVouches: after?.memberVouches ?? 0,
      memberLikes: (after?.memberLikes ?? 0n) + BigInt(memberLikesPerAuthor.get(authorHex) ?? 0),
      invitesUsed: after?.invitesUsed ?? 0,
    });
  }

  // 12. The membership pass (NODE_INTERFACE → Membership pass).
  //
  // Between the like counters and the decay clocks. Reads N, D(N), Y(N) once
  // from the network record of pre-body state. Over the identities the block
  // touched, ascending hex. Set / lapse / re-qualify. N written once at the end.
  // No value moves.
  // Add authors whose memberLikes rose to the membership pass's touched set.
  for (const authorHex of memberLikesPerAuthor.keys()) {
    membershipTouched.add(authorHex);
  }

  {
    const N = getNetworkRecord().memberCount;
    const D = membershipBarFn(N, config.membershipBarMultiplier);
    const Y = memberLikesBar(N, config.membershipBarMultiplier);

    let newN = N;
    for (const idHex of [...membershipTouched].sort()) {
      const id = new Uint8Array(Buffer.from(idHex, 'hex'));
      const pre = preBlockRecords.get(idHex) ?? getIdentityRecord(id);
      const current = getIdentityRecord(id);
      if (!current) continue;

      const wasMember = pre !== null && pre.memberSinceBlock > 0 && pre.memberVouches >= pre.memberBar;

      if (current.memberSinceBlock === 0 &&
          current.memberVouches >= D &&
          current.memberLikes >= BigInt(Y)) {
        putIdentityRecord(id, {
          ...current,
          memberSinceBlock: height,
          memberBar: D,
        });
        newN++;
      } else if (current.memberSinceBlock > 0 && current.memberBar > 0) {
        const isMemberNow = current.memberVouches >= current.memberBar;
        if (wasMember && !isMemberNow) {
          newN--;
        } else if (!wasMember && isMemberNow) {
          newN++;
        }
      }
    }

    if (newN !== N) {
      putNetworkRecord({ memberCount: newN });
    }
  }

  // 13. Advance the decay clock for every identity the settlement charged.
  //
  // ⚠ **Only firings reach here.** A stale identity sitting at the karma floor
  // produces no plan and keeps its clock where it was, rather than silently
  // forfeiting the intervals it is owed — the same gate the eager pass always
  // had, now expressed as the plan's existence.
  commitDecayClocks(decayDeps, decayPlans, height);

  return true;
}
