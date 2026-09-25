import * as validation from '@dagsocial/validation';
import { applyBlock } from '@dagsocial/consensus';
import type { ApplyContext, BlockEffects, StateView } from '@dagsocial/consensus';
import {
  CorruptChainStateError,
  MissingStoredBlockError,
  UnhashableStoredHeaderError,
  failStopIfCorruptChain,
} from './corrupt-state.js';
import { config } from '../config.js';
import type { Config } from '../config.js';
import {
  computeUtxoTxRoot,
  clearTemplate,
  rebuildTemplate,
} from './block-creator.js';
import { scheduledTargetBits, nowMs } from './difficulty.js';
import {
  getPost,
  insertBox,
  getBox,
  consumeBox,
  confirmPost,
  insertPost,
  withdrawPost,
  isLivePost,
  getCurrentHeight,
  createOrderingBlock as storeCreateOrderingBlock,
  getOrderingBlock,
  removeUtxoTxEntry,
  insertBlockTopology,
  getTopologyAuthorBytes,
  getTopologyHeight,
  getIdentityRecord,
  putIdentityRecord,
  hasLikeRecord,
  insertLikeRecord,
  getVouchEscrowsReleasableAt,
  purgeRefusedHeaders,
  getBoxProvenance,
  getInterlinks,
  getNetworkRecord,
  putNetworkRecord,
  networkRecordKey,
  getLapsedVouches,
  getBackerPoolBox,
  putUsername,
  deleteUsername,
  getUsername,
  getUsernameByOwner,
  getEmissionBox,
  getTreasuryBox,
  getKarmaPoolBox,
  getKarmaBoxes,
  getVouchEscrowsFor,
  getVouchBoxes,
  getLikeAccrualBoxes,
  getBondsInvitedAt,
} from '../store/index.js';
import { getDb } from '../store/db.js';
import { insertBlockJournal, purgeOldJournals } from '../store/journal.js';
import type {
  BlockJournal,
  HolderMutation,
  JournalMutation,
  RecordMutation,
  UsernameMutation,
} from '../store/journal.js';
import {
  tryGetAvlProver,
  applyBlockMutations,
  checkpointProver,
  usernameRecordKey,
  holderRecordKey,
} from '../state/avl-prover.js';
import type { RecordPut, NetworkPut, UsernamePut, HolderPut } from '../state/avl-prover.js';
import { emitPostIndexed } from '../journal.js';
import { countedVerifyOrderingBlockPoW, noteTip } from '../metrics.js';
import { getNet } from './net-instance.js';
import {
  canonicalUsernameBytes,
  identityRecordKey,
  MAX_FUTURE_DRIFT_MS,
  GENESIS_PREV_BLOCK_HASH,
  protocolVersionAt,
  interlinkRoot,
  updateInterlinks,
} from '@dagsocial/types';
import type { AnyBox, OrderingBlock } from '@dagsocial/types';

/**
 * Signals "this block is invalid" from inside the transaction that wraps block
 * application. Thrown rather than returned because better-sqlite3 only rolls a
 * transaction back on a thrown error. Never escapes this module.
 */
class BlockRejected extends Error {}

/**
 * The future bound failed at apply (MINING_INTERFACE → Header timestamp rules).
 * A module-local marker: the funnel's catch classifies it as `'acceptance'`,
 * never letting it escape.
 */
class BlockBeyondFutureBound extends Error {}

/**
 * NODE_INTERFACE → "The funnel answers with a class".
 */
export type ApplyVerdict =
  | { applied: true }
  | { applied: false; class: 'consensus' | 'acceptance' | 'local'; detail?: string };

/**
 * The rules' reads over this node's store (CONSENSUS_INTERFACE → StateView):
 * each is the store's own query for it, its order and its limit included.
 */
export const storeStateView: StateView = {
  getBox,
  getBoxProvenance,
  getIdentityRecord,
  getNetworkRecord,
  getUsername,
  getUsernameByOwner,
  getEmissionBox,
  getTreasuryBox,
  getKarmaPoolBox,
  getBackerPoolBox,
  getKarmaBoxes,
  getVouchEscrowsFor,
  getVouchBoxes,
  getLikeAccrualBoxes,
  getBondsInvitedAt,
  getVouchEscrowsReleasableAt,
  getLapsedVouches,
  getTopologyAuthor: getTopologyAuthorBytes,
  getTopologyHeight,
  // `isLivePost` is the one liveness predicate (NODE_INTERFACE → Post
  // transactions); a row that is not live is a withdrawn one.
  getPostStanding: (postId) => {
    const post = getPost(postId);
    return post === null ? 'none' : isLivePost(post) ? 'live' : 'withdrawn';
  },
  hasLikeRecord,
};

/**
 * The network profile's numbers the rules read (CONSENSUS_INTERFACE →
 * ApplyContext), from a node's configuration.
 */
export function applyContextFrom(cfg: Config): ApplyContext {
  return {
    protocolVersionSchedule: cfg.protocolVersionSchedule,
    vouchCooldownBlocks: cfg.vouchCooldownBlocks,
    inviteBondMin: cfg.inviteBondMin,
    inviteBondMax: cfg.inviteBondMax,
    inviteProbationBlocks: cfg.inviteProbationBlocks,
    decayCfg: {
      staleThresholdBlocks: cfg.karmaStaleThresholdBlocks,
      decayIntervalBlocks: cfg.karmaDecayIntervalBlocks,
      decayAmount: cfg.karmaDecayAmount,
      karmaMinimum: cfg.karmaMinimum,
    },
    storageRentPeriodBlocks: cfg.storageRentPeriodBlocks,
    membershipBarMultiplier: cfg.membershipBarMultiplier,
    backerSupply: cfg.profile.backerSupply,
    creditFixedRateBlocks: cfg.creditFixedRateBlocks,
    creditEpochBlocks: cfg.creditEpochBlocks,
    creditMinerRewardDelay: cfg.creditMinerRewardDelay,
  };
}

/**
 * The boolean projection of the verdict — for callers that need only the
 * continue signal (NODE_INTERFACE → "The funnel answers with a class").
 */
export function applyOrderingBlock(block: OrderingBlock): boolean {
  return applyOrderingBlockVerdict(block).applied;
}

/**
 * Apply an ordering block — all of it, or none of it.
 *
 * A block is a single unit of state transition, so every mutation it makes
 * (post confirmation, UTXO transactions,
 * per-block like settlement, decay) lives in one SQLite transaction. Any rejection — at any
 * step — rolls the whole thing back, leaving the node on the state it had
 * before the block arrived. Returns a verdict whose `applied` is the boolean,
 * and whose `class` names the refusal when it is not; `reorg()` nests this
 * inside its own transaction, which SQLite handles as a savepoint.
 *
 * The funnel is total: no input makes this function throw. A block that causes
 * an unexpected exception is a block the node rejects, on the same terms as an
 * explicit rejection — transaction rolled back, prover restored, verdict
 * returned, detail logged. That is not defensive padding. The gossip callback
 * is `async` and the net layer discards its promise, so a propagated throw
 * becomes an unhandled rejection, which exits the process on Node ≥ 15; and
 * because a rejected block is never stored, the node re-fetches it on restart
 * and dies again. One cheaply-mined block would otherwise be a permanent,
 * self-reapplying kill for every node that receives it.
 */
export function applyOrderingBlockVerdict(block: OrderingBlock): ApplyVerdict {
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
    return { applied: false, class: 'consensus' };
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
  try {
    getDb().transaction(() => {
      if (!applyBlockBody(block)) throw new BlockRejected();
    })();
  } catch (err) {
    if (err instanceof BlockRejected) {
      restoreProver();
      return { applied: false, class: 'consensus' };
    }
    // MINING_INTERFACE → Header timestamp rules: the future bound is an
    // acceptance rule, not a consensus verdict.
    if (err instanceof BlockBeyondFutureBound) {
      restoreProver();
      return { applied: false, class: 'acceptance' };
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
      restoreProver();
      throw err;
    }
    // better-sqlite3 has already rolled the transaction back by the time the
    // throw surfaces here (it issues ROLLBACK, or ROLLBACK TO for the nested
    // reorg savepoint, before re-throwing), so the node is on its pre-block
    // state. What is left is to restore the prover and answer the caller the
    // same way an explicit rejection does.
    const detail = String(err);
    console.error(
      `Rejected block height=${block.header.height}: unexpected failure during apply: ${detail}`,
    );
    restoreProver();
    return { applied: false, class: 'local', detail };
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
  return { applied: true };
}

function applyBlockBody(block: OrderingBlock): boolean {
  const currentHeight = getCurrentHeight();

  // 1. Chain-link check + interlink root + genesis pin
  // (NODE_INTERFACE → Ordering block apply-time authorization)
  let expectedInterlinks: string[];
  let prevBlock: OrderingBlock | null = null;
  if (currentHeight === 0) {
    // Genesis: prevBlockHash must be all zeros
    if (block.header.prevBlockHash !== GENESIS_PREV_BLOCK_HASH) {
      console.warn(`Rejected block height=${block.header.height}: genesis prevBlockHash mismatch`);
      return false;
    }
    if (block.header.height !== 1) {
      console.warn(`Rejected block: first block must have height=1, got ${block.header.height}`);
      return false;
    }
    expectedInterlinks = [];

    // Genesis pin (TYPES_INTERFACE → Network profiles)
    const genesisId = config.profile.genesisId;
    if (genesisId !== '') {
      const bh = validation.blockHash(block.header);
      if (bh !== genesisId) {
        console.warn(`Rejected block height=${block.header.height}: genesis pin mismatch`);
        return false;
      }
    }
    // MINING_INTERFACE → Header timestamp rules, future bound (height 1)
    if (!validation.verifyCreatedAtBound(block.header, nowMs(), MAX_FUTURE_DRIFT_MS)) {
      console.warn(`Rejected block height=${block.header.height}: createdAt beyond the future bound`);
      throw new BlockBeyondFutureBound();
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
      return false;
    }
    // MINING_INTERFACE → Header timestamp rules, order rule
    if (!validation.verifyCreatedAtOrder(block.header, prevBlock.header)) {
      console.warn(`Rejected block height=${block.header.height}: createdAt not above the parent's`);
      return false;
    }
    // MINING_INTERFACE → Header timestamp rules, future bound
    if (!validation.verifyCreatedAtBound(block.header, nowMs(), MAX_FUTURE_DRIFT_MS)) {
      console.warn(`Rejected block height=${block.header.height}: createdAt beyond the future bound`);
      throw new BlockBeyondFutureBound();
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
    return false;
  }

  // 2. Protocol version
  // The header's version equals the era at its own height
  // (VALIDATION_INTERFACE → Protocol Version).
  if (!validation.verifyProtocolVersion(block.header.protocolVersion, block.header.height, config.protocolVersionSchedule)) {
    console.warn(`Rejected block height=${block.header.height}: protocol version ${block.header.protocolVersion} is not the era ${protocolVersionAt(config.protocolVersionSchedule, block.header.height)}`);
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
    return false;
  }
  if (!countedVerifyOrderingBlockPoW(block.header)) {
    console.warn(`Rejected block height=${block.header.height}: PoW invalid`);
    return false;
  }

  // 3b. Validator signature (H-1)
  //
  // PoW proves work was spent; it does not prove who spent it. Without this,
  // any miner forges a block under any validatorId. Runs in applyBlockBody — the
  // funnel every apply path (gossip, sync, reorg) passes through — so no path skips it.
  if (!validation.verifyValidatorSignature(block.header, block.validatorSignature)) {
    console.warn(`Rejected block height=${block.header.height}: validator signature invalid`);
    return false;
  }

  // 4. Merkle root verification — one root over one body of transactions, each
  //    kept apart by its `leafHash` domain. The settlement is the last
  //    transaction leaf, so its position is committed here.

  const computedUtxoRoot = computeUtxoTxRoot(block.utxoTxTree);
  if (computedUtxoRoot !== block.header.utxoTxRoot) {
    console.warn(`Rejected block height=${block.header.height}: utxoTxRoot mismatch`);
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

  // 7–13. The mutation phase (NODE_INTERFACE → "Apply funnel: validation and
  // mutation phases"): the rules over the store's view, answering the block's
  // effects or the reason a rule refused it, and writing nothing. The block
  // creator runs the same call over the same view to obtain the post-block
  // stateRoot before mining (NODE_INTERFACE → Post-block stateRoot).
  const height = block.header.height;
  const result = applyBlock(storeStateView, block, applyContextFrom(config));
  if (!result.ok) {
    // A refusal is a verdict, not an error.
    console.warn(result.reason);
    return false;
  }

  // The AVL feed from the effects and the stateRoot compare, before any effect
  // is written — unconditional on every node holding a prover (NODE_INTERFACE →
  // AVL+ State Root). The prover is restored by the funnel's single rollback
  // point, not here.
  const handle = tryGetAvlProver();
  if (handle) {
    const feed = proverFeedFromEffects(result.effects);
    const computedDigest = applyBlockMutations(
      handle.prover, height,
      feed.consumed, feed.created, feed.recordPuts, feed.networkPuts,
      feed.usernamePuts, feed.holderPuts, feed.removedRecordKeys,
    );
    const expectedHex = Buffer.from(computedDigest).toString('hex');
    if (block.header.stateRoot !== expectedHex) {
      console.warn(
        `stateRoot mismatch at height ${height}: ` +
        `computed=${expectedHex.slice(0, 16)}... ` +
        `header=${block.header.stateRoot.slice(0, 16)}...`,
      );
      return false;
    }
  }

  // The effects written to the store, and the block journal built from them.
  const journal = writeBlockEffects(result.effects, height);

  // Checkpoint prover state at this height
  if (handle) checkpointProver(handle, height);

  // 14. Persist journal and purge old ones
  insertBlockJournal(journal);
  // Retention is the real floor under revert depth — `revertBlock` throws
  // without a journal — so it tracks the depth the fork walk can reach
  // (NODE_INTERFACE → Fork choice decides on verified headers).
  purgeOldJournals(height - config.maxReorgDepth);
  purgeRefusedHeaders(height - config.maxReorgDepth);

  // The one site where an absence is simply printed. `applyOrderingBlock` ran
  // `verifyOrderingBlockStructure` over this header before calling us, so it is
  // inside the domain and this prints the hash. The block is applied and the
  // transaction is about to commit; turning a log line into a throw would roll
  // back a valid block, and inventing a placeholder would print a hash that is
  // not one. If the impossible happens the line says `hash=null`, which is true.
  const appliedHash = validation.blockHash(block.header);
  console.log(`Applied ordering block height=${height} hash=${appliedHash} (${block.utxoTxTree.utxoTxIds.length} txs)`);
  return true;
}

/** The mutation set one block hands the prover, each group in any order. */
export interface ProverFeed {
  consumed: string[];
  created: AnyBox[];
  recordPuts: RecordPut[];
  networkPuts: NetworkPut[];
  usernamePuts: UsernamePut[];
  holderPuts: HolderPut[];
  removedRecordKeys: string[];
}

/**
 * The prover feed a block's effects imply — the one derivation the apply commit
 * and the creator's speculative run both use, so producer and verifier cannot
 * disagree by construction (NODE_INTERFACE → AVL+ State Root).
 *
 * - A box inserted and later removed in the block never existed outside it: the
 *   pair nets out. An inserted box's bytes are the effect's box, never a store
 *   re-fetch, which answers nothing for a box created and spent in one block.
 * - An identity or the network record keeps its last write
 *   (NODE_INTERFACE → "Where record collapsing happens, and why it is not
 *   arbitrary").
 * - A name or holder key keeps its last write too, and a last write that
 *   removes the key reaches the prover only for a key the state held before the
 *   block, which its first mutation in the block says: a key the block both
 *   creates and removes gives the feed nothing (NODE_INTERFACE → "A removable
 *   record the block creates and removes nets out, as a box does").
 *
 * `applyBlockMutations` puts each group in canonical order (M-12). The switch
 * on `kind` is exhaustive (NODE_INTERFACE → "One log, not parallel arrays").
 */
export function proverFeedFromEffects(effects: BlockEffects): ProverFeed {
  const mutations = effects.mutations;
  const cancelled = new Set<number>();
  const pendingInsertIndex = new Map<string, number>();
  for (let i = 0; i < mutations.length; i++) {
    const m = mutations[i]!;
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
  const recordByKey = new Map<string, RecordPut>();
  let latestNetwork: NetworkPut | null = null;
  // Per removable key: whether the state held it before the block, and the
  // block's last write to it — a put, or null for a removal.
  const usernameByKey = new Map<string, { heldBefore: boolean; last: UsernamePut | null }>();
  const holderByKey = new Map<string, { heldBefore: boolean; last: HolderPut | null }>();
  for (let i = 0; i < mutations.length; i++) {
    if (cancelled.has(i)) continue;
    const m = mutations[i]!;
    switch (m.kind) {
      case 'box':
        if (m.op === 'remove') consumed.push(m.boxId);
        else created.push(m.box);
        break;
      case 'record': {
        const key = identityRecordKey(m.identityId);
        recordByKey.set(key, { key, record: m.record });
        break;
      }
      case 'network':
        latestNetwork = { key: networkRecordKey(), network: { memberCount: m.record.memberCount } };
        break;
      case 'username': {
        const key = usernameRecordKey(canonicalUsernameBytes(Buffer.from(m.nameLower, 'utf8')));
        const last = m.row ? { key, username: { boxId: m.row.boxId } } : null;
        const seen = usernameByKey.get(key);
        if (seen) seen.last = last;
        else usernameByKey.set(key, { heldBefore: m.heldBefore, last });
        break;
      }
      case 'holder': {
        const key = holderRecordKey(m.owner);
        const last = m.record ? { key, holder: m.record } : null;
        const seen = holderByKey.get(key);
        if (seen) seen.last = last;
        else holderByKey.set(key, { heldBefore: m.heldBefore, last });
        break;
      }
      default: {
        const _exhaustive: never = m;
        void _exhaustive;
        break;
      }
    }
  }

  const usernamePuts: UsernamePut[] = [];
  const holderPuts: HolderPut[] = [];
  const removedRecordKeys: string[] = [];
  for (const [key, { heldBefore, last }] of usernameByKey) {
    if (last) usernamePuts.push(last);
    else if (heldBefore) removedRecordKeys.push(key);
  }
  for (const [key, { heldBefore, last }] of holderByKey) {
    if (last) holderPuts.push(last);
    else if (heldBefore) removedRecordKeys.push(key);
  }

  return {
    consumed,
    created,
    recordPuts: [...recordByKey.values()],
    networkPuts: latestNetwork ? [latestNetwork] : [],
    usernamePuts,
    holderPuts,
    removedRecordKeys,
  };
}

/**
 * Write a block's effects to the store, in their order, and build the block's
 * journal from them (NODE_INTERFACE → Block Journal): each mutation becomes its
 * entry, and a record, network, name or holder write captures the row it
 * replaces just before it writes, so a key written twice journals twice. Every
 * write runs inside the funnel's transaction and nothing here catches: a write
 * that fails fails the block (NODE_INTERFACE → "The funnel is total").
 */
function writeBlockEffects(effects: BlockEffects, height: number): BlockJournal {
  // The block's posts, confirmed at their committed positions: a row this node
  // holds as it is, a placeholder from the commit for one it lacks
  // (NODE_INTERFACE → Post transactions → "A post applied without its packet
  // is a placeholder").
  effects.posts.forEach(({ postId, post }, index) => {
    if (getPost(postId) === null) {
      insertPost(postId, post, null);
      emitPostIndexed(postId, post.parentRefs.length);
    }
    confirmPost(postId, height, index);
  });
  // block_topology from the block's post transactions: the consensus author
  // and parent refs, never local DAG content (NODE_INTERFACE → Block Topology).
  for (const { postId, post } of effects.posts) {
    insertBlockTopology(postId, post.parentRefs, Buffer.from(post.author).toString('hex'), height);
  }

  const mutations: JournalMutation[] = [];
  for (let i = 0; i < effects.mutations.length; i++) {
    const m = effects.mutations[i]!;
    switch (m.kind) {
      case 'box':
        if (m.op === 'insert') {
          insertBox(m.box);
          mutations.push({ kind: 'box', op: 'insert', boxId: m.boxId, box: m.box });
        } else {
          consumeBox(m.boxId, height);
          mutations.push({ kind: 'box', op: 'remove', boxId: m.boxId });
        }
        break;
      case 'record': {
        const replaced = getIdentityRecord(m.identityId);
        putIdentityRecord(m.identityId, m.record);
        const entry: RecordMutation = {
          kind: 'record',
          key: identityRecordKey(m.identityId),
          identityId: m.identityId,
          record: m.record,
        };
        if (replaced !== null) entry.replaced = replaced;
        mutations.push(entry);
        break;
      }
      case 'network': {
        const replaced = getNetworkRecord();
        putNetworkRecord(m.record);
        mutations.push({ kind: 'network', memberCount: m.record.memberCount, replaced });
        break;
      }
      case 'username': {
        // The name record and the holder record after it are one `usernames`
        // row (NODE_INTERFACE → Username records): both rows they replace are
        // captured before the one write that moves them.
        const holder = effects.mutations[i + 1];
        if (holder?.kind !== 'holder') {
          throw new Error(`effects at height ${height}: the name record ${m.nameLower} is not followed by its holder record`);
        }
        const replacedName = getUsername(m.nameLower);
        const replacedHolder = getUsernameByOwner(holder.owner);
        const rowOwner = m.row !== null ? m.row.owner : replacedName?.owner;
        if (rowOwner !== Buffer.from(holder.owner).toString('hex')) {
          throw new Error(`effects at height ${height}: the holder record after ${m.nameLower} names another owner`);
        }
        if (m.row !== null) putUsername(m.row);
        else deleteUsername(m.nameLower);
        const nameEntry: UsernameMutation = { kind: 'username', nameLower: m.nameLower, row: m.row };
        if (replacedName !== null) nameEntry.replaced = replacedName;
        const holderEntry: HolderMutation = { kind: 'holder', owner: holder.owner, record: holder.record };
        if (replacedHolder !== null) holderEntry.replaced = { claimAvailable: false, boxId: replacedHolder.boxId };
        mutations.push(nameEntry, holderEntry);
        i++;
        break;
      }
      case 'holder':
        throw new Error(`effects at height ${height}: a holder record with no name record before it`);
      default: {
        const _exhaustive: never = m;
        void _exhaustive;
        break;
      }
    }
  }

  const likeRecordInsertions = effects.likeRecords.map(({ targetPostId, likerId }) => {
    insertLikeRecord(targetPostId, likerId, height);
    return { targetPostId, likerId };
  });

  const withdrawnPosts = effects.withdrawals.map((postId) => {
    const post = getPost(postId);
    if (post === null) {
      throw new Error(`effects at height ${height}: withdrawn post ${postId} has no row`);
    }
    withdrawPost(postId, height);
    return { id: postId, content: post.content };
  });

  // Remove each applied transaction from the local mempool if present. This is
  // the whole of the cleanup for a block that arrived from a peer — a block
  // this node mined is cleaned by rowid in `finalizeBlock`, which reaches every
  // included entry wherever it sits (MEMPOOL_INTERFACE → Confirmed-entry
  // cleanup reaches every row).
  for (const { txId } of effects.appliedTxs) removeUtxoTxEntry(txId);

  return {
    blockHeight: height,
    mutations,
    confirmedPostIds: effects.posts.map(({ postId }) => postId),
    appliedUtxoTxs: effects.appliedTxs.map(({ txId, txBytes }) => ({ txId, txBytes })),
    likeRecordInsertions,
    withdrawnPosts,
  };
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
 * state transition is to run the block's own body: `applyBlock` over the
 * store's view, the prover feed derived from its effects exactly as apply
 * derives it, the digest read, and the prover restored to its snapshot. It
 * writes nothing to the store — no block, no effect, no journal — and performs
 * no `clearTemplate` and no prover checkpoint.
 *
 * The candidate carries a placeholder header (`powNonce` 0, empty signature):
 * the mutation phase reads neither, and runs at the header's height.
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
 * unwind, so the prover restore is skipped. That is correct — the process is
 * ending and nothing reads the tree afterwards — but a reader who assumes
 * `finally` always runs will mis-reason about it.
 */
export function computePostBlockStateRoot(block: OrderingBlock): StateRootSpeculation {
  const handle = tryGetAvlProver();
  if (!handle) return { kind: 'no-prover' };
  const snapshot = handle.prover.digest();
  if (!snapshot) return { kind: 'no-prover' };
  const height = block.header.height;

  try {
    const result = applyBlock(storeStateView, block, applyContextFrom(config));
    if (!result.ok) {
      console.warn(result.reason);
      console.warn(
        `stateRoot speculation at height ${height}: the body was rejected by its ` +
        `own mutation phase — the block cannot be produced`,
      );
      return { kind: 'body-rejected' };
    }
    const feed = proverFeedFromEffects(result.effects);
    const digest = applyBlockMutations(
      handle.prover, height,
      feed.consumed, feed.created, feed.recordPuts, feed.networkPuts,
      feed.usernamePuts, feed.holderPuts, feed.removedRecordKeys,
    );
    return { kind: 'computed', stateRoot: Buffer.from(digest).toString('hex') };
  } catch (err) {
    // Above the unclaimed-throw arm, because that arm would swallow it into a
    // verdict about the block. Never returns.
    if (err instanceof CorruptChainStateError) {
      failStopIfCorruptChain(err);
    }
    // No arm above claimed this throw, so it is not a rejection this node
    // decided. The verdict stays `body-rejected` — the apply funnel converts
    // the same throw into a rejection, so no node would apply this body — but
    // it must not be *logged* as one: forever-rejecting and never-producing are
    // the same silence from two different faults, and the refusal arm above
    // prints the one that is a verdict. `err` rather than `String(err)`,
    // because for an unclaimed throw the stack is the whole diagnosis.
    console.error(
      `INTERNAL: unclaimed throw in stateRoot speculation at height ${height} ` +
      `— not producing this block`,
      err,
    );
    return { kind: 'body-rejected' };
  } finally {
    const current = handle.prover.digest();
    if (!current || !Buffer.from(current).equals(Buffer.from(snapshot))) {
      handle.prover.rollback(snapshot);
    }
  }
}
