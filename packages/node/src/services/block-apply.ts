import { createHash, createPublicKey, verify } from 'crypto';
import * as validation from '@dagsocial/validation';
import { transferKarma } from './karma-transfer.js';
import {
  postlockRemainderContext,
  postlockUnlockContext,
} from '../mint-provenance.js';
import { commitDecayClocks, deriveKarmaDecay } from './decay.js';
import { hasActiveVouchEscrow } from '../store/utxo.js';
import { planPruneSettlement } from './settle-prune-utxo.js';
import type { PruneSettlement } from './settle-prune-utxo.js';
import {
  CorruptChainStateError,
  MissingStoredBlockError,
  UnhashableStoredHeaderError,
  failStopIfCorruptChain,
} from './corrupt-state.js';
import type { DecayDeps, DecayPlan } from './decay.js';
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
  type EmbeddedTx,
} from './coinbase-split.js';
import {
  bondInviteeOf,
  checkSettlement,
  contributeToBody,
  emptyBody,
} from './settlement.js';
import { postsOf, postIdsOf } from './block-posts.js';
import { expectedTarget } from './difficulty.js';
import { DagService } from './dag-service.js';
import {
  applyTx,
  checkOutputShape,
  checkSettlementOutputShape,
  checkTxEnvelope,
  materializeOutput,
  validateTx,
} from './utxo-engine.js';
import {
  getKarmaBox,
  getKarmaBoxes,
  getKarmaValue,
  getPost,
  insertStump,
  insertBox,
  getBox,
  consumeBox,
  confirmPost,
  insertPost,
  pruneSubtree,
  getCurrentHeight,
  createOrderingBlock as storeCreateOrderingBlock,
  getOrderingBlock,
  removeUtxoTxEntry,
  insertBlockTopology,
  getSubtreeTopology,
  deleteLikeRecordsForPosts,
  getTopologyAuthor,
  getTopologyAuthorBytes,
  getIdentityRecord,
  putIdentityRecord,
  getEmissionBox,
  getTreasuryBox,
  getKarmaPoolBox,
  hasLikeRecord,
  insertLikeRecord,
  getLikeRecordCount,
  getBondFor,
  getBondsInvitedAt,
  getPostLockBox,
  purgeRefusedHeaders,
} from '../store/index.js';
import { getDb } from '../store/db.js';
import {
  beginBlockJournal,
  finishBlockJournal,
  abortBlockJournal,
  recordConfirmedSubBlocks,
  recordAppliedUtxoTx,
  insertBlockJournal,
  purgeOldJournals,
} from '../store/journal.js';
import type { BlockJournal } from '../store/journal.js';
import { tryGetAvlProver, applyBlockMutations, checkpointProver } from '../state/avl-prover.js';
import { emitPostIndexed } from '../journal.js';
import type { RecordPut } from '../state/avl-prover.js';
import {
  encodeTx,
  decodeTx,
  encodePost,
  MAX_REORG_DEPTH,
  GENESIS_PREV_BLOCK_HASH,
  PROTOCOL_VERSION,
  INVITE_BOND_VEST_PER_LIKES,
  LIKES_PER_KARMA_PAYOUT,
  POST_LOCK_UNLOCK_PER_LIKES,
  computeTxId,
  leafHash,
  buildMerkleRoot,
  hexToBuf,
} from '@dagsocial/types';
import type {
  AnyBox,
  EmissionBox,
  KarmaBox,
  OrderingBlock,
  TreasuryBox,
  UtxoTransaction,
} from '@dagsocial/types';

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
export function applyOrderingBlock(block: OrderingBlock, dagService?: DagService): boolean {
  // Structure first, before any field of `block` is read. Until this returns
  // valid, nothing about the object's shape is known: the fields below are
  // decoded CBOR from an untrusted producer, and `pruneEntries` in particular
  // reaches `Buffer.from` and `createHash().update()` further down, which throw
  // on a number or a plain object. It runs in the funnel rather than in the
  // gossip topic validator alone, so the guarantee is path-independent: the
  // pull-sync path CBOR-decodes straight into the apply handler, and a
  // validator-only check leaves it reachable with fields of arbitrary type.
  // Same shape as the PoW target (M-2), coinbase maturity (M-3), and the
  // validator signature (H-1).
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
      if (!applyBlockBody(block, dagService)) throw new BlockRejected();
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
  // failed reorg rolls back; `reorg` rebuilds once, after its own commit.
  if (!getDb().inTransaction) rebuildTemplate();
  return applied;
}

function applyBlockBody(block: OrderingBlock, dagService?: DagService): boolean {
  const currentHeight = getCurrentHeight();

  // Open the record-once journal: from here on the store mutation primitives
  // record automatically, and every rejection path below aborts it. The
  // lifecycle is owned here rather than by the mutation phase, so the
  // speculative caller (`computePostBlockStateRoot`) records identically.
  beginBlockJournal(block.header.height);

  // 1. Chain-link check
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
  } else {
    // `currentHeight` *is* `MAX(height)` over this table, so a missing block at
    // exactly that height is not "we don't have it yet" — it is the row the tip
    // was read from having gone. Same fault as the unhashable header below it,
    // and it throws rather than rejecting: reporting it as the arriving block's
    // rejection blames a peer for our own store and then repeats for every
    // block after it.
    const prevBlock = getOrderingBlock(currentHeight);
    if (!prevBlock) {
      throw new MissingStoredBlockError('applyOrderingBlock', currentHeight);
    }
    // `prevBlock` is our own stored tip, not the arriving block, so a header
    // outside the encodable domain here is not this block's fault and is not a
    // rejection at all: the store has produced a header the gate above
    // (`verifyOrderingBlockStructure`, same domain predicate) could never have
    // let in. It leaves through the funnel's catch untouched — see the note
    // there — and the node stops at the boundary.
    const prevHash = validation.blockHash(prevBlock.header);
    if (prevHash === null) {
      throw new UnhashableStoredHeaderError('applyOrderingBlock', currentHeight);
    }
    if (!validation.verifyBlockChainLink(block, prevBlock)) {
      console.warn(`Rejected block height=${block.header.height}: chain link check failed`);
      abortBlockJournal();
      return false;
    }
  }

  // 2. Protocol version
  if (!validation.verifyProtocolVersion(block.header.protocolVersion)) {
    console.warn(`Rejected block height=${block.header.height}: unsupported protocol version ${block.header.protocolVersion}`);
    abortBlockJournal();
    return false;
  }

  // 3. PoW verification
  //
  // The scheduled target is checked first, because `verifyOrderingBlockPoW`
  // only checks the solution against the header's *own* `powTargetBits`: a
  // producer that writes the floor target into its header mines a near-free
  // block that satisfies its own claim, and every node accepts it. The target
  // is a deterministic function of height (MINING contract, invariant 4), and
  // every path into the chain — gossip, sync, reorg — funnels through here, so
  // this is where the schedule can be enforced for all of them.
  const scheduledTarget = expectedTarget(block.header.height);
  if (block.header.powTargetBits !== scheduledTarget) {
    console.warn(
      `Rejected block height=${block.header.height}: powTargetBits ` +
      `${block.header.powTargetBits} != scheduled ${scheduledTarget}`,
    );
    abortBlockJournal();
    return false;
  }
  if (!validation.verifyOrderingBlockPoW(block.header)) {
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

  // 6. Store the block
  storeCreateOrderingBlock(block);

  // 6. Invalidate the local mining template (this height is taken). Only
  // invalidation here: the replacement commits to the post-block stateRoot, and
  // the mutation phase and AVL root update that produce it are still ahead. The
  // rebuild is at the end of `applyOrderingBlock`, once the write is committed.
  clearTemplate();

  // 7–12b. Mutation phase — the block's state transition, run verbatim (at an
  // explicitly passed height) by the block creator to obtain the post-block
  // stateRoot before mining (H-6). It never touches the journal lifecycle, so
  // its rejections are turned into an abort here.
  if (!applyMutationPhase(block, block.header.height, dagService)) {
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
    const { consumed, created, recordPuts } = proverFeedFromJournal(journal);
    const computedDigest = applyBlockMutations(
      handle.prover, block.header.height, consumed, created, recordPuts,
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
  // without a journal — so it tracks the depth `findForkPoint` can walk back
  // to rather than restating the number.
  purgeOldJournals(block.header.height - MAX_REORG_DEPTH);
  purgeRefusedHeaders(block.header.height - MAX_REORG_DEPTH);

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
): { consumed: string[]; created: AnyBox[]; recordPuts: RecordPut[] } {
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
      default: {
        // Compile-time exhaustiveness, deliberately not a runtime throw: a new
        // committed entity kind that nobody feeds to the prover is silently
        // absent from the stateRoot, and no test can catch that — producer and
        // verifier omit it identically and agree on a digest over incomplete
        // state. This assignment is the only enforcement that invariant has.
        const _exhaustive: never = m;
        void _exhaustive;
        break;
      }
    }
  }
  return { consumed, created, recordPuts: [...recordByKey.values()] };
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
 * `stateRoot` (H-6; NODE_INTERFACE "Post-block stateRoot"), as a
 * `StateRootSpeculation`.
 *
 * PoW covers the header, so the producer has to know this digest *before*
 * mining, and the only way to know it without a second implementation of the
 * state transition is to run the block's own body. That happens here: the
 * mutation phase, verbatim, at the block's height, inside a SQLite transaction
 * that is always rolled back. No `DagService` (its canonical-branch updates
 * are in-memory and would survive the rollback; they touch no UTXO box, so the
 * digest is unaffected), no block storage, no `clearTemplate`, no journal
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
      if (!applyMutationPhase(block, height, undefined)) throw new BlockRejected();
      const { consumed, created, recordPuts } = proverFeedFromJournal(finishBlockJournal());
      // The digest rides out on the throw: nothing this run did may survive.
      throw new SpeculativeRollback(
        Buffer.from(
          applyBlockMutations(handle.prover, height, consumed, created, recordPuts),
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
 * validation and the commit (NODE_INTERFACE "Apply funnel: validation and
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
  dagService?: DagService,
): boolean {
  // What each of this block's prune entries owes, in prune-entry order. Filled
  // by §5 and consumed by §11a — the settlement pays every leg.
  const prunePlans: PruneSettlement[] = [];

  // ⛔ **DECAY IS DERIVED FROM PRE-BODY STATE, AND IT HAS TO BE.** Computed
  // after decoding (the touched set comes from the decoded transactions'
  // inputs) but before the apply loop, so the UTXO state is pre-body.
  // `decayPlans` is declared here and assigned after the decode loop at §9b.

  // Every post id the block commits to, independent of per-post confirm
  // outcomes — same semantics as the confirm loop in §7, which tolerates
  // per-post failures. Both read `postsOf`, so rollback un-confirms exactly what
  // apply confirmed.
  const blockPosts = postsOf(block);
  recordConfirmedSubBlocks(postIdsOf(block));

  // 7. The coinbase is applied with the rest of the settlement, at §11a — after
  // the body, because the fees it pays out are a property of what the body
  // applied. ⛔ **There is no mint**: the credits are spent from the
  // `EmissionBox` by the same transaction that emits them, so source and
  // destination are named in one operation (MINING_INTERFACE → Coinbase
  // Application).

  // 7. Store and confirm the posts this block creates.
  //
  // ⛔ **There is no claim to verify here, and that is the point** (audit H-3).
  // The block carries the post itself inside its creating transaction, so a node
  // syncing from ordering blocks alone holds the content and the author's
  // signature over the `TxId` — it verifies authorship rather than recording a
  // `SubBlockEntry`'s assertion of it on trust. A producer cannot graft a
  // victim's post under its own root or claim its authorship, because it cannot
  // produce the victim's signature over a transaction spending the victim's
  // karma.
  //
  // A post absent locally is simply inserted: the body is right here. There is no
  // placeholder state and nothing for a content sweep to resolve.
  for (let idx = 0; idx < blockPosts.length; idx++) {
    const { postId, post } = blockPosts[idx]!;
    if (!getPost(postId)) {
      try {
        insertPost(postId, post, encodePost(post));
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

  // 8. Compute DAG scores and evaluate canonical tip
  if (dagService) {
    let bestScore = 0;
    let bestId: string | null = null;

    for (const { postId, post } of blockPosts) {
      let maxParent = 0;
      for (const pid of post.parentRefs) {
        const ps = dagService.getScore(pid);
        if (ps !== null && ps > maxParent) {
          maxParent = ps;
        }
      }
      const score = maxParent + 1; // uniform weight: ownWork = 1
      dagService.saveScore(postId, score);

      if (score > bestScore) {
        bestScore = score;
        bestId = postId;
      }
    }

    if (bestId !== null) {
      try {
        const plan = dagService.buildReorgPlan(bestId, bestScore);
        if (plan) {
          dagService.switchToBranch(plan);
        }
      } catch (err) {
        console.error(`DagService reorg evaluation failed: ${String(err)}`);
      }
    }
  }

  // 8b. Populate block_topology from this block's post transactions.
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

  // 8c. Process prune entries from this block
  // Six verification + settlement steps per entry:
  //   1. Bind authorId to the root's consensus-recorded author (block_topology)
  //   2. Verify Ed25519 author signature over (rootPostHash || subtreeMerkleRoot)
  //   3. Verify postId set against block_topology (deterministic, no DAG walk)
  //   4. Verify Merkle root from entry.subtreePostIds
  //   5. Settle UTXO — consume PostLockBoxes, refund karma to every owner
  //      but the pruning author via the settlement, delete the subtree's
  //      like-records (journalled)
  //   6. Prune DAG content, insert simplified Stump for historical record
  for (const entry of block.utxoTxTree.pruneEntries) {
    // 1. Authorship binding (H-3)
    //
    // The signature check below proves the entry was signed *by* authorId; it
    // says nothing about authorId being the root's author. Without this bind,
    // any miner signs blake2b(root ‖ merkleRoot) with their own key and prunes
    // an arbitrary victim's subtree network-wide. block_topology is the
    // authority — it is built from block data alone, so a node that synced from
    // ordering blocks and holds no DAG content reaches the same verdict. A root
    // no applied block has confirmed has no recorded author and is not prunable
    // (this also forecloses the unconfirmed-root/empty-subtree edge).
    //
    // First, before any Buffer.from on adversarial fields: it is the cheapest
    // check and the only total one.
    const recordedAuthor =
      typeof entry.rootPostHash === 'string' ? getTopologyAuthor(entry.rootPostHash) : null;
    // authorId is UserId (raw 32 bytes) at runtime — CBOR preserves the bytes.
    const claimedAuthor =
      entry.authorId instanceof Uint8Array
        ? Buffer.from(entry.authorId).toString('hex')
        : null;
    if (recordedAuthor === null || recordedAuthor !== claimedAuthor) {
      console.error(
        `Block ${height}: prune authorId does not match the ` +
        `recorded author of ${entry.rootPostHash}`,
      );
      return false;
    }

    // 2. Verify authorization
    const rootBytes = Buffer.from(entry.subtreeMerkleRoot);
    const payload = createHash('blake2b512')
      .update(entry.rootPostHash)
      .update(rootBytes)
      .digest()
      .subarray(0, 32);

    const authorKeyBytes = Buffer.from(entry.authorId);
    const keyObject = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: authorKeyBytes.toString('base64url'),
      },
      format: 'jwk',
    });

    const sigBytes = Buffer.from(entry.authorSignature);
    if (!verify(null, payload, keyObject, sigBytes)) {
      console.error(`Block ${height}: invalid prune signature for ${entry.rootPostHash}`);
      return false;
    }

    // 3. Verify postId set against block_topology
    const topologyIds = getSubtreeTopology(entry.rootPostHash);
    const entryIds = new Set(entry.subtreePostIds);
    if (topologyIds.size !== entryIds.size ||
        ![...topologyIds].every(id => entryIds.has(id))) {
      console.error(`Block ${height}: prune postId set mismatch for ${entry.rootPostHash}`);
      return false;
    }

    // 4. Verify Merkle root
    const leaves = [...entry.subtreePostIds]
      .sort()
      .map(id => leafHash('stump', hexToBuf(id)));
    const computedRoot = Buffer.from(buildMerkleRoot(leaves)).toString('hex');
    const entryRoot = Buffer.from(entry.subtreeMerkleRoot).toString('hex');
    if (computedRoot !== entryRoot) {
      console.error(`Block ${height}: prune Merkle root mismatch for ${entry.rootPostHash}`);
      return false;
    }

    // 5. Settle UTXO — deterministic from post IDs.
    //
    // ⛔ **It names boxes rather than moving them.** The pruner's own locks
    // leave circulation and their sink is the karma pool, which only the
    // settlement transaction spends, so consuming them here and crediting the
    // pool at §11a would leave that karma nowhere in between — the intermediary
    // step `ARCHITECTURE → The conservation axiom` forbids by name. The
    // settlement consumes them and pays every leg in one operation.
    let likeTally: number;
    try {
      prunePlans.push(
        planPruneSettlement(entry.rootPostHash, entry.authorId, entry.subtreePostIds),
      );
      // The subtree's like-records die with the prune. The store choke point
      // captures every doomed row as a `likeRecordDeletions` side-record before
      // deleting, so a reverted prune restores them exactly. Done here rather
      // than in the planner, which also runs inside the creator's template fill
      // and must mutate nothing.
      likeTally = deleteLikeRecordsForPosts(entry.subtreePostIds);
    } catch (err) {
      console.error(`Block ${height}: prune settlement failed for ${entry.rootPostHash}: ${String(err)}`);
      return false;
    }

    // 6. Insert the Stump, then prune DAG content (when present)
    //
    // The stump is derived state — a projection of this verified entry — and
    // recording it is part of settlement: a node holding no DAG content for
    // the subtree records the same stump (NODE_INTERFACE "Stumps are derived
    // state"). Unconditional by construction: it must not sit behind any
    // content-dependent guard, so it runs before and outside the content
    // prune's try/catch.
    insertStump({
      rootPostHash: entry.rootPostHash,
      authorId: entry.authorId,
      replyCount: entry.subtreePostIds.length - 1, // exclude root
      upvoteCount: likeTally,
      protocolVersion: PROTOCOL_VERSION,
      compactedAtBlockHeight: height,
    });
    try {
      pruneSubtree(entry.rootPostHash);
    } catch (err) {
      console.warn(`Failed to prune DAG subtree for ${entry.rootPostHash}: ${String(err)}`);
      // Non-fatal — DAG content may not be present
    }
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
    // ⛔ The like marker's author, from `block_topology` and never
    // `dag_posts.author` (ARCHITECTURE → Likes). The same read §11's apply arm
    // makes, so the marker's pin and the like-record's author cannot disagree.
    getTopologyAuthor: getTopologyAuthorBytes,
    // The invite-create not-already-an-account bar (NODE_INTERFACE → "Bond
    // transition rules") — same rule again.
    getIdentityRecord,
    runInTransaction: (fn: () => void) => {
      getDb().transaction(fn)();
    },
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
    const txCbor = block.utxoTxTree.utxoTxs[i];
    const isSettlement = i === lastIndex;

    if (!txCbor) {
      console.warn(
        `Rejected block height=${height}: embedded UTXO tx ${txId} carries no body`,
      );
      return false;
    }

    let tx: UtxoTransaction;
    try {
      tx = decodeTx(txCbor);
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
    // user transaction may not — the same closed key set and the same field
    // types, over a wider set of box types.
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
  const likesPerPost = new Map<string, number>(); // post id → likes this block

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
  const appliedTxs: EmbeddedTx[] = [];

  // ⛔ **Two inviters naming the same key in one block must not both grant**
  // (NODE_INTERFACE → Legal box transitions). The eligibility test each invite
  // passed is `IdentityRecord` existence, and the grant that writes that record
  // is the settlement's — which runs after every transaction here — so a
  // record-existence test cannot see a sibling transaction in the same block.
  // Without this the second bond draws a second grant from the pool for one
  // key, sized by whatever bond the second inviter chose.
  const invitedThisBlock = new Set<string>();

  // §9b. Decay: squared per identity on touch (ARCHITECTURE → Karma decay).
  // The post-body projection derives from decoded transactions + the pre-body
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

      // Like apply rules (NODE_INTERFACE "Per-block like settlement"):
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
        // Live at this height: likes on pruned posts are rejected by stated
        // rule — without it, dropping like-records at prune would reopen
        // duplicate likes on stumps. A pruned root comes back as a Stump
        // (no `content` field); a pruned non-root comes back as null (its
        // stump lookup misses); so anything but a Post rejects.
        const target = getPost(targetPostId);
        if (target === null || !('content' in target)) {
          console.warn(
            `Rejected block height=${height}: like tx ${item.txId} targets ` +
            `pruned or unknown post ${targetPostId}`,
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
      if (firstInput !== undefined) {
        appliedTxs.push({ tx: item.tx, inputBoxes: [getBox(firstInput)!] });
      }
      // Keyed by the declared id rather than pushed, so the settlement reads
      // these in committed order and not in the order deferral resolved them.
      // `item.outputs` are the materialized outputs `validateTx` computed, the
      // same ones `applyTx` is about to insert, so the id collected here is the
      // id that exists.
      perTxOutputs.set(item.txId, item.outputs);

      applyTx(utxoDeps, item.tx, item.outputs, height);
      applied++;

      if (likeToRecord !== null) {
        // Journalled side-record (inverse: deleteLikeRecord), plus the
        // in-memory accrual §11b settles.
        insertLikeRecord(likeToRecord.targetPostId, likeToRecord.likerId, height);
        likesPerAuthor.set(
          likeToRecord.authorHex,
          (likesPerAuthor.get(likeToRecord.authorHex) ?? 0) + 1,
        );
        likesPerPost.set(
          likeToRecord.targetPostId,
          (likesPerPost.get(likeToRecord.targetPostId) ?? 0) + 1,
        );
      }

      // Remove from the local mempool if present. This is the whole of the
      // cleanup for a block that arrived from a peer — a block this node mined
      // is cleaned by rowid in `finalizeBlock`, which reaches every included
      // entry wherever it sits (MEMPOOL_INTERFACE → "Confirmed-entry cleanup is
      // bounded by the pool, not by a literal").
      removeUtxoTxEntry(item.txId);

      // Box mutations are journaled by the store choke point; the tx itself
      // is kept for mempool re-insertion on reorg.
      recordAppliedUtxoTx(item.txId, encodeTx(item.tx));
    }

    if (applied === 0) {
      // No progress, so these inputs will never exist: the block commits in
      // `utxoTxIds` to a transaction its own `stateRoot` cannot reflect. Reject
      // it, like the two arms above — the block is invalid if any embedded
      // transaction does not apply (NODE_INTERFACE → the apply funnel's block
      // validity).
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
    const outputs = perTxOutputs.get(block.utxoTxTree.utxoTxIds[i]!);
    if (outputs) contributeToBody(settlementBody, outputs);
  }
  settlementBody.actors = countKarmaActors(appliedTxs, block.header.validatorId);
  settlementBody.prunes = prunePlans;

  const emission = computeBlockReward(height);
  const settlementCheck = checkSettlement(
    settlementDepsWith(() => decayPlans),
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
  applyTx(utxoDeps, settlement.tx, settlement.outputs, height);

  // 11a-ii. The clock epoch: a new record's `lastActivityBlock` starts at the
  // claim height (NODE_INTERFACE → Identity Records; ARCHITECTURE → Karma
  // decay, "the clock starts at onboarding"). The grant output carries
  // `nonActivity: true`, so `insertBox` does not bump the clock — the epoch
  // is this record write's, not a box bump's. A legal invitee has no record
  // yet, so `after` is null and the fallback applies; a pre-existing record
  // is a consensus bar violation upstream, not something this write papers
  // over. Ascending invitee order, so two grants in one block write in an
  // order the block fixes rather than one a map's iteration happens to produce.
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
  // post-lock vesting → decay clocks.

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
    });
  }

  // Post-lock vesting, ascending post-id order, for posts liked this block that
  // hold a live PostLockBox. Evaluated per block, from the post's lifetime like
  // count — so the result is independent of how the likes were spread across
  // blocks.
  //
  // ⚠ **The one karma path still outside the settlement, and it belongs
  // outside.** A `PostLockBox` vests into its own owner's karma and a reduced
  // lock, so the pool is uninvolved — the first of the three shapes
  // (ARCHITECTURE → How a source and a sink get named), which needs no
  // protocol box and therefore no place in the block's one pool spend.
  for (const postId of [...likesPerPost.keys()].sort()) {
    const lockBox = getPostLockBox(postId);
    if (!lockBox || !lockBox.id) continue;
    const totalLikes = BigInt(getLikeRecordCount(postId)); // lifetime, live post
    const alreadyUnlocked = lockBox.originalValue - lockBox.value;
    const shouldUnlock = totalLikes / BigInt(POST_LOCK_UNLOCK_PER_LIKES);
    const unlockable = shouldUnlock - alreadyUnlocked;
    const toUnlock = lockBox.value < unlockable ? lockBox.value : unlockable;
    if (toUnlock <= 0n) continue;
    // ⛔ **The `PostLockBox` is the source, and naming it is the whole change**
    // (ARCHITECTURE → How a source and a sink get named, first shape). The
    // unlocked karma returns to the lock's owner — the author who locked it:
    // committed value-layer state, not a `dag_posts` read — and whatever the
    // schedule has not yet released stays in a reduced lock whose value
    // `transferKarma` computes. A fully-unlocked lock is consumed without a
    // remainder. One remainder per post per block, so
    // `(height, 'postlock-remainder', postId)` cannot repeat.
    transferKarma(
      [lockBox],
      [{ owner: lockBox.owner, amount: toUnlock, ctx: postlockUnlockContext(postId), nonActivity: true }],
      {
        shape: (value) => ({
          boxType: 'post_lock',
          value,
          createdAtBlock: height,
          originalValue: lockBox.originalValue,
          owner: lockBox.owner,
        }),
        ctx: postlockRemainderContext(postId),
        // ⛔ Derivation route 2 (`insertBox`): this box's provenance names the
        // MINT, not the post, so the target must be passed. Deriving it from
        // the remainder's `txId` would produce an id computed from a synthetic
        // mint.
        postLockTarget: postId,
      },
      height,
    );
  }

  // 12. Advance the decay clock for every identity the settlement charged.
  //
  // ⚠ **Only firings reach here.** A stale identity sitting at the karma floor
  // produces no plan and keeps its clock where it was, rather than silently
  // forfeiting the intervals it is owed — the same gate the eager pass always
  // had, now expressed as the plan's existence.
  commitDecayClocks(decayDeps, decayPlans, height);

  return true;
}
