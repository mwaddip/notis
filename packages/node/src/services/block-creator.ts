import {
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import {
  protocolVersionAt,
  GENESIS_PREV_BLOCK_HASH,
  CREDIT_INITIAL_REWARD,
  CREDIT_REWARD_REDUCTION,
  EMPTY_STATE_ROOT,
  MAX_BLOCK_BODY_BYTES,
  STORAGE_RENT_PER_BYTE,
  MAX_SETTLEMENT_BYTES,
  boxRecordBytes,
  decodeTx,
  encodeTx,
  computeTxId,
  leafHash,
  buildMerkleRoot,
  hexToBytes,
  utxoTxTreeByteLength,
  interlinkRoot,
  updateInterlinks,
} from '@dagsocial/types';
import {
  verifyOrderingBlockPoW,
  blockHash,
  level,
} from '@dagsocial/validation';
import type {
  OrderingBlock,
  BlockHeader,
  UtxoTxTree,
  AnyBoxCandidate,
  DecayCfg,
  UtxoTransaction,
} from '@dagsocial/types';
// The process config, distinct from the injected `config` below: the rules'
// context comes from it (`applyContextFrom`), as block application takes it on
// every node, server-role nodes included, where the injected one is never
// assigned.
import { config as nodeConfig } from '../config.js';
import type { Config } from '../config.js';
import { scheduledTargetBits, nowMs } from './difficulty.js';
import { getNet } from './net-instance.js';
import {
  applyContextFrom,
  applyOrderingBlock,
  computePostBlockStateRoot,
} from './block-apply.js';
import type { StateRootSpeculation } from './block-apply.js';
import {
  bondOutputOf,
  buildBlockSettlement,
  materializeOutput,
  treeStateView,
  TreeInconsistencyError,
} from '@dagsocial/consensus';
import { tryGetAvlProver } from '../state/avl-prover.js';
import { proverSession } from '../state/prover-session.js';
import {
  InconsistentStateTreeError,
  MissingStoredBlockError,
  UnhashableStoredHeaderError,
  failStopIfCorruptChain,
} from './corrupt-state.js';
import {
  iteratePendingEntries,
  purgeExpired,
  removeEntry,
  entryByteCost,
} from '../store/mempool.js';
import {
  getOrderingBlock,
  getCurrentHeight,
  getRentEligibleCreditBoxes,
  getInterlinks,
} from '../store/index.js';

// ---------------------------------------------------------------------------
// Merkle root computation
//
// Every leaf preimage is a bare 32-byte id under the `'utxotx'` domain tag.
// Node states no layout of its own here (TYPES_INTERFACE → Layout — Merkle
// leaf preimages are the struct's own wire bytes): a second statement of a
// layout in a second package drifts with no compiler signal.
// ---------------------------------------------------------------------------

/**
 * The block's one committed root.
 *
 * ⛔ **Leaf ORDER is normative and it is `UtxoTxTree`'s field order** — every
 * transaction id as a `'utxotx'` leaf (TYPES_INTERFACE → Ordering block).
 * The settlement is the last `utxoTxIds` entry, so it is the last leaf and its
 * position is committed here rather than stated anywhere else.
 *
 * The `'coinbase'` domain is a tracked reservation
 * (TYPES_INTERFACE → Tracked reservations).
 */
export function computeUtxoTxRoot(tree: UtxoTxTree): string {
  const leaves: Uint8Array[] = tree.utxoTxIds.map((id) =>
    leafHash('utxotx', hexToBytes(id)));
  return Buffer.from(buildMerkleRoot(leaves)).toString('hex');
}

// ---------------------------------------------------------------------------
// Body sizing
//
// `entryByteCost` lives in `store/mempool.ts`, which records it per entry so a
// transaction can be priced by the resource it consumes. This file spends that
// number against the budget; the pool divides a fee by it.
// ---------------------------------------------------------------------------

// NODE_INTERFACE → "Storage rent is a transition requiring no signature";
// CONSTANTS → Producer policy.
const MAX_RENT_TXS_PER_BLOCK = 32;

// ---------------------------------------------------------------------------
// The selection and its speculations
// ---------------------------------------------------------------------------

/** One entry of the fill's selection: a pooled transaction and its row, or a rent transaction this node built, which has none. */
interface SelectedEntry {
  txId: string;
  txBytes: Uint8Array;
  rowid: number | null;
}

/** The speculation over the selection's first `length` entries, and the candidate block it ran over. */
interface Speculated {
  length: number;
  candidate: OrderingBlock;
  speculation: StateRootSpeculation;
}

type Computed = Speculated & { speculation: Extract<StateRootSpeculation, { kind: 'computed' }> };
type OverBudget = Speculated & { speculation: Extract<StateRootSpeculation, { kind: 'over-budget' }> };

function isComputed(run: Speculated | { error: string }): run is Computed {
  return 'speculation' in run && run.speculation.kind === 'computed';
}

function isOverBudget(run: Speculated | { error: string }): run is OverBudget {
  return 'speculation' in run && run.speculation.kind === 'over-budget';
}

/** The pool rows `entries` carry. */
function rowidsOf(entries: readonly SelectedEntry[]): Set<number> {
  const rowids = new Set<number>();
  for (const { rowid } of entries) if (rowid !== null) rowids.add(rowid);
  return rowids;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let config: Config;
let validatorPubKey: Uint8Array;
let validatorPrivKey: KeyObject;
let validatorId: Uint8Array;
let currentTemplate: OrderingBlock | null = null;   // The block the miner solves
let confirmedRowids: Set<number> = new Set();       // Mempool rowids included in current block

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startBlockCreator(cfg: Config): void {
  config = cfg;

  // Generate validator keypair
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  validatorPubKey = new Uint8Array(pubDer.subarray(pubDer.length - 32));
  validatorPrivKey = privateKey;
  validatorId = validatorPubKey;

  // A miner node holds a template from the moment it starts, and one per height
  // thereafter: production is regulated by difficulty, not by an interval
  // (MINING_INTERFACE → Template and submit). Serving is separate — the
  // peer-readiness gate withholds it until peers are met.
  createOrderingBlock();
}

/**
 * Drop what the creator holds — its template and its claim on the mempool rows
 * that template confirmed. The rebuild trigger is a block being applied, so
 * this is the whole of stopping: there is nothing else running.
 */
export function stopBlockCreator(): void {
  clearTemplate();
  confirmedRowids = new Set();
}

/**
 * Build the template for the next height. `applyOrderingBlock` calls this once a
 * block is committed — the tip moved, so the height this node mines moved with
 * it (MINING_INTERFACE → Template and submit).
 *
 * `startBlockCreator` is the only assignment of `config` and `index.ts` calls it
 * on a miner node alone, so an unassigned `config` *is* a server-role node: it
 * applies blocks and builds no templates.
 */
export function rebuildTemplate(): void {
  if (!config) return;
  createOrderingBlock();
}

// ---------------------------------------------------------------------------
// Miner pubkey override
// ---------------------------------------------------------------------------

let currentMinerPubkey: Uint8Array | null = null;

/**
 * Set the pubkey that receives coinbase rewards. Called when a miner requests a
 * template with their own wallet address.
 * Pass null to revert to the node's validator key.
 */
export function setMinerPubkey(pubkey: Uint8Array | null): void {
  currentMinerPubkey = pubkey;
}

/**
 * Return the current block template for the miner.
 * Returns null if no template has been built yet.
 */
export function getCurrentTemplate(): OrderingBlock | null {
  return currentTemplate;
}

/**
 * Invalidate the current template. Called mid-apply, where the block being
 * applied has already taken this height: the template is void from that point
 * on, and the replacement cannot be derived until the mutation phase and the
 * AVL root update have run.
 */
export function clearTemplate(): void {
  currentTemplate = null;
}

/**
 * Submit a mined nonce from the miner.
 * Verifies PoW, finalizes the block, stores it, and broadcasts.
 * Returns the finalized block hash on success, null on failure.
 */
export function submitMinedBlock(powNonce: number, submittedHeight: number): string | null {
  const tpl = currentTemplate;
  // Reject if no template, wrong height, or height already mined
  if (!tpl || tpl.header.height !== submittedHeight || getCurrentHeight() >= submittedHeight) {
    return null;
  }

  // Build header with the submitted nonce
  const header: BlockHeader = {
    ...tpl.header,
    powNonce,
  };

  // Verify PoW against the header
  if (!verifyOrderingBlockPoW(header)) {
    return null;
  }

  // Sign the header hash. `verifyOrderingBlockPoW` above already established
  // this exact domain — it computes the preimage with `computePowHash`
  // and answers `false` for any header outside it, which is what keeps the
  // route's `powNonce` (a JSON number, so a float or a value past 2^53 reaches
  // here) from arriving unpinned. So `null` is unreachable; declining to sign is
  // still the right answer if it ever is not, because the alternative is
  // producing a signature over a hash we could not compute.
  const hh = blockHash(header);
  if (hh === null) return null;
  const sig = cryptoSign(null, Buffer.from(hh, 'hex'), validatorPrivKey);

  const block: OrderingBlock = {
    header,
    utxoTxTree: tpl.utxoTxTree,
    validatorSignature: new Uint8Array(sig),
  };

  // Finalize and broadcast
  finalizeBlock(block);

  return hh;
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

/**
 * This network's credit emission total — the value genesis puts in the
 * `EmissionBox` (MINING_INTERFACE → Emission Schedule; TYPES_INTERFACE →
 * EmissionBox).
 *
 * ⛔ **Read from the profile, not derived.** A bound deliberately below the
 * curve's sum cannot be a function of the schedule's parameters, so each
 * profile carries its own. The guard inverts: the carried total must be
 * **strictly below** the curve's own sum, because the curve's unpaid tail is
 * what a returned bonus drains through.
 */
export function emissionTotal(): bigint {
  const total = nodeConfig.creditEmissionTotal;

  // The curve's own sum — the ceiling the carried total must sit below.
  const fixed = BigInt(nodeConfig.creditFixedRateBlocks) * CREDIT_INITIAL_REWARD;
  let decay = 0n;
  for (
    let reward = CREDIT_INITIAL_REWARD - CREDIT_REWARD_REDUCTION;
    reward > 0n;
    reward -= CREDIT_REWARD_REDUCTION
  ) {
    decay += reward;
  }
  const curveSum = fixed + BigInt(nodeConfig.creditEpochBlocks) * decay;

  if (total >= curveSum) {
    throw new Error(
      `creditEmissionTotal ${total} must be strictly below the curve's sum ${curveSum}`,
    );
  }

  return total;
}

// ---------------------------------------------------------------------------
// Core block creation
// ---------------------------------------------------------------------------

export function createOrderingBlock(): OrderingBlock | null {
  const currentHeight = getCurrentHeight();
  const newHeight = currentHeight + 1;

  // The era in force for the block being built — the producer stamps it on the
  // header template, the rent transaction and the settlement (MINING_INTERFACE →
  // GET /mining/template; NODE_INTERFACE → The settlement transaction).
  const era = protocolVersionAt(nodeConfig.protocolVersionSchedule, newHeight);
  if (era === null) {
    console.warn(`Not producing block at height ${newHeight}: no protocol era scheduled`);
    return null;
  }

  // The settlement is built over the tree and the stateRoot computed on it, so a
  // node with no prover produces nothing and evicts nothing — a missing prover is
  // not the body's fault (NODE_INTERFACE → Post-block stateRoot → "A node applies
  // and produces over its prover, and has no other way to").
  const handle = tryGetAvlProver();
  if (handle === null) {
    console.warn(`Not producing block at height ${newHeight}: no prover`);
    currentTemplate = null;
    confirmedRowids = new Set();
    return null;
  }

  // A body-rejected build repeats until it holds a template or a body
  // carrying no pool row is rejected. Every repetition strictly shrinks the
  // pool, which is what bounds the loop (MINING_INTERFACE → Template and
  // submit).
  for (;;) {
    // 1. Purge expired mempool entries
    purgeExpired(currentHeight);

    // 2. The settlement cannot be built here: it consumes the fee boxes the body
    //    creates and pays a coinbase scaled by the actors the body carries, so it
    //    depends on what the fill selects — and it is itself part of the body the
    //    fill is spending. ⛔ **It has no bounded worst case to reserve**
    //    (MEMPOOL_INTERFACE → The fill budget is bytes; getPendingEntries is a
    //    count), so instead each entry's `entryByteCost` carries its own marginal
    //    cost to it and the sizer below has the last word.

    // 3. The body's byte budget. `blockBodyBudgetBytes` is local — a miner may
    //    publish smaller blocks — while `MAX_BLOCK_BODY_BYTES` is consensus, so
    //    the clamp stands here as well as at load: `loadConfig` guards the
    //    environment, and this guards every `Config` assembled without it
    //    (NODE_INTERFACE → Configuration). Nothing is
    //    enforced here beyond the fill — an oversized block is refused by
    //    `verifyOrderingBlockStructure`, on this node and on every peer.
    const budget = Math.min(config.blockBodyBudgetBytes, MAX_BLOCK_BODY_BYTES);

    // 4. One entry type carries user work: transactions. A post is one of them
    //    (NODE_INTERFACE → Post transactions), so there is no second list to
    //    resolve, no batch to regroup, and no entry whose content might not have
    //    arrived — the payload is inside the transaction.
    //
    //    Bodies ride in `utxoTxs` in the same order as `utxoTxIds` — the
    //    alignment `verifyOrderingBlockStructure` checks, and the reason a
    //    syncing node holds the whole post rather than a claim about it (audit
    //    H-3). The ids are derived from the bytes that ride beside them rather
    //    than read off the pool row, because that derivation is the property
    //    block application re-checks and rejects on.
    //
    //    ⚠ **The selection holds the USER transactions, and the body is built
    //    from it.** The settlement is appended by `bodyOf` rather than pushed
    //    here, so the fill, the trim and the packing all operate on the list they
    //    select from and never on the tail they do not own. Each entry carries the
    //    pool row it came from, or none for a rent transaction this node built.
    const selection: SelectedEntry[] = [];

    /**
     * The whole body for the selection's first `length` entries — their
     * transactions, then the settlement re-derived from them, last. Read through
     * one tree view of the pre-body state (NODE_INTERFACE → AVL+ State Root →
     * "The rules read the tree, and nothing else"), unrecorded (NODE_INTERFACE →
     * The block proof); every speculation puts the tree back where the view read
     * it, and the build repeats with a fresh view.
     */
    const view = treeStateView(proverSession(handle.prover));
    const bodyOf = (length: number): { tree: UtxoTxTree } | { error: string } => {
      const entries = selection.slice(0, length);
      // A read of the tree that contradicts itself is local corruption, never
      // a body the settlement declines to build — the boundary directly, like
      // this function's other corrupt-state checks below, because nothing
      // above `createOrderingBlock` on this path catches for it
      // (NODE_INTERFACE → "What the funnel's totality catch is FOR").
      let built: ReturnType<typeof buildBlockSettlement>;
      try {
        built = buildBlockSettlement(
          view, entries.map((entry) => entry.txBytes), newHeight, validatorId,
          currentMinerPubkey ?? validatorId, applyContextFrom(nodeConfig),
        );
      } catch (err) {
        if (err instanceof TreeInconsistencyError) {
          failStopIfCorruptChain(
            new InconsistentStateTreeError('createOrderingBlock', newHeight, err),
          );
        }
        throw err;
      }
      if ('error' in built) return { error: built.error };
      return {
        tree: {
          utxoTxIds: [...entries.map((entry) => entry.txId), computeTxId(built.tx)],
          utxoTxs: [...entries.map((entry) => entry.txBytes), encodeTx(built.tx)],
        },
      };
    };

    /** No template, and nothing evicted: a build this chain state cannot finish. */
    const decline = (reason: string): null => {
      console.warn(`Not producing block at height ${newHeight}: ${reason}`);
      currentTemplate = null;
      confirmedRowids = new Set();
      return null;
    };

    // 5. Spend what the mandatory sections left. Karma-side entries are offered
    //    the budget first, then credit entries in descending fee rate
    //    (MEMPOOL_INTERFACE → Ordering). Within each class the first transaction
    //    that does not fit ends that class's fill: reaching past it for a smaller
    //    one behind it is a priority rule the pool's order already settled.
    //
    //    ⚠ **This order is a node's own assembly preference and no validator
    //    enforces it.** It is the reference implementation of the coinbase's
    //    inclusion bonus, not a rule: a miner who rewrites this loop to fill
    //    credits first forfeits the quarter of the block's income that scales
    //    with karma-side actors, which is what makes including them rational
    //    rather than altruistic. A *consensus* rule removing that revenue would
    //    make inclusion free; an incentive paying for it makes inclusion
    //    profitable, and only the second survives a miner who re-implements this.
    //
    //    ⛔ **The pool's stored `tx_fee` orders this loop and never feeds the
    //    coinbase.** The settlement build resolves every input itself,
    //    because the applier computes the block's fees from its own resolution of
    //    the body — a stored fee that has gone stale, or the zero an unpriceable
    //    entry carries, would make this node emit a coinbase its own applier
    //    rejects. Ordering by a stale number costs nothing; summing one costs the
    //    block.
    //
    //    ⛔ **An invitee may be named ONCE per block.** A second bond for the same
    //    key makes the whole body inapplicable (NODE_INTERFACE → Legal box
    //    transitions), so a fill that selected both would produce nothing at all.
    //    Skipping the second is an assembly preference like the karma-first
    //    ordering, not a consensus rule.
    //
    //    ⛔ **The accumulator is SEEDED with the settlement an empty body
    //    produces.** Its baseline — the emission and treasury successors and the
    //    coinbase — is there whatever the fill selects, and
    //    `entryByteCost` carries only each entry's MARGINAL growth on top
    //    (MEMPOOL_INTERFACE → The fill budget is bytes; getPendingEntries is a
    //    count). Left out, the accumulator under-counts by the whole settlement
    //    and the trim loop stops running at most once.
    //
    //    ⚠ **A chain that cannot back even the empty settlement produces
    //    nothing**, and says so here rather than after a wasted fill.
    const seeded = bodyOf(0);
    if ('error' in seeded) return decline(seeded.error);
    let spent = utxoTxTreeByteLength(seeded.tree);
    const invitedThisBlock = new Set<string>();
    const offerBudgetTo = (klass: 'karma' | 'credit'): void => {
      for (const entry of iteratePendingEntries({ klass })) {
        if (entry.entryType !== 'utxo_tx' || entry.utxoTxBytes === null) continue;
        const tx = decodeTx(entry.utxoTxBytes);
        // The fill skips an entry whose declared version is not the era of the
        // block being built — not evicted, not counted against the budget; a
        // skipped entry leaves by expiry (MEMPOOL_INTERFACE → Block Creator
        // Integration).
        if (tx.protocolVersion !== era) continue;
        const txId = computeTxId(tx);
        const bondOut = bondOutputOf(
          tx.outputs.map((out, i) => materializeOutput(out, txId, i)),
        );
        if (bondOut !== null) {
          const inviteeHex = Buffer.from(bondOut.inviteePublicKey).toString('hex');
          if (invitedThisBlock.has(inviteeHex)) continue;
          invitedThisBlock.add(inviteeHex);
        }
        const cost = entryByteCost(entry.utxoTxBytes);
        if (spent + cost > budget) return;
        spent += cost;
        selection.push({ txId, txBytes: entry.utxoTxBytes, rowid: entry.rowid });
      }
    };
    offerBudgetTo('karma');
    offerBudgetTo('credit');

    // 5b. Rent transactions — the producer selects eligible boxes and builds
    // unsigned credit spends (NODE_INTERFACE → "Storage rent is a transition
    // requiring no signature"). Selection is discretionary; a verifier checks
    // eligibility and the charge and nothing else.
    const eligible = getRentEligibleCreditBoxes(
      newHeight, nodeConfig.storageRentPeriodBlocks, MAX_RENT_TXS_PER_BLOCK,
    );
    for (const { box, txId: boxTxId, index: boxIndex } of eligible) {
      const recordLen = BigInt(boxRecordBytes(box, boxTxId, boxIndex).length);
      const charge = STORAGE_RENT_PER_BYTE * recordLen;
      const outputs: AnyBoxCandidate[] = [];
      if (box.value >= charge) {
        outputs.push({
          boxType: 'credit',
          value: box.value - charge,
          owner: box.owner,
          createdAtBlock: newHeight,
        } as AnyBoxCandidate);
      }
      const feeValue = box.value >= charge ? charge : box.value;
      outputs.push({ boxType: 'fee', value: feeValue, createdAtBlock: newHeight } as AnyBoxCandidate);
      const rentTx: UtxoTransaction = {
        inputs: [box.id!],
        outputs,
        signatures: {},
        protocolVersion: era,
      };
      const encoded = encodeTx(rentTx);
      const cost = entryByteCost(encoded);
      if (spent + cost > budget) break;
      spent += cost;
      selection.push({ txId: computeTxId(rentTx), txBytes: encoded, rowid: null });
    }

    // 6. The settlement, from the transactions the fill actually selected, and
    //    appended as the body's LAST entry — which is the whole of how every node
    //    identifies it (NODE_INTERFACE → It is the LAST entry in `utxoTxIds`).
    //
    //    ⛔ **Only the producer can build it**, since only they know the block's
    //    contents — the position the coinbase already occupied. A chain that
    //    cannot back it (no emission box at a height that releases, a pool short
    //    of the grants the body owes) yields no block: mining a body this node's
    //    own applier refuses spends PoW on a block no peer accepts.
    const settled = bodyOf(selection.length);
    if ('error' in settled) return decline(settled.error);
    let body = settled.tree;

    // 7. The sizer has the last word. `spent` is exact per entry — its own
    //    encoding plus its marginal cost to the settlement — and blind to the two
    //    array count prefixes, which widen with the entry COUNT rather than with
    //    any one entry, so the assembled body can measure a few bytes above what
    //    the accumulator tracked. What `utxoTxTreeByteLength` returns over the
    //    finished tree is the number `verifyOrderingBlockStructure` measures, and
    //    a body above the budget is one every peer refuses.
    //
    //    ⛔ **The settlement is REBUILT on each iteration**, not measured once
    //    (MEMPOOL_INTERFACE → The fill budget is bytes; getPendingEntries is a
    //    count). Popping is still monotone: removing a transaction removes its
    //    fee, its actor and its bond, so the income can only fall, the
    //    settlement's input and output counts can only fall, and the body shrinks.
    //    The split moves value between the miner and the treasury without changing
    //    their total, so it cannot widen the encoding on its own. Every prefix of
    //    the selection this leaves fits the same two bounds, for the same reason.
    //
    //    ⚠ **The pop takes a USER entry**, never the settlement: a body with no
    //    last transaction is one `verifyOrderingBlockStructure` refuses outright.
    const settlementExceedsBound = (tree: UtxoTxTree): boolean =>
      tree.utxoTxs[tree.utxoTxs.length - 1]!.length > MAX_SETTLEMENT_BYTES;
    while (
      selection.length > 0 &&
      (utxoTxTreeByteLength(body) > budget || settlementExceedsBound(body))
    ) {
      selection.pop();
      const retrimmed = bodyOf(selection.length);
      if ('error' in retrimmed) return decline(retrimmed.error);
      body = retrimmed.tree;
    }
    if (selection.length === 0 && settlementExceedsBound(body)) {
      console.error(
        `Not producing block at height ${newHeight}: settlement ` +
        `${body.utxoTxs[body.utxoTxs.length - 1]!.length} bytes ` +
        `exceeds MAX_SETTLEMENT_BYTES ${MAX_SETTLEMENT_BYTES} with no user entries`,
      );
      currentTemplate = null;
      confirmedRowids = new Set();
      return null;
    }

    // 11. Always produce a block — a block with no user work still pays its
    //     miner the scheduled emission. Above the terminus it pays nothing, and
    //     the settlement there carries no credit output at all; the block is
    //     produced either way, because the chain advancing is not conditional on
    //     income.

    // 16. Previous block hash. `prevBlock` is our own stored tip: `currentHeight`
    // is `MAX(height)` over the same table, so on a non-empty chain the row is
    // there by construction, and its header passed the apply gate on the way in.
    // Either failure means the store is no longer what this node wrote.
    //
    // Both go to the boundary rather than declining to produce. Declining is the
    // producer's mirror of blaming an arriving block for our own store — and the
    // tip moving is the only rebuild trigger, so a node that declines here holds
    // no template, produces nothing, and is handed no second attempt: a node that
    // never produces while staying up is indistinguishable from an idle miner —
    // the same silence, from the other end of the same fault.
    const prevBlock = currentHeight > 0 ? getOrderingBlock(currentHeight) : null;
    if (currentHeight > 0 && !prevBlock) {
      failStopIfCorruptChain(new MissingStoredBlockError('createOrderingBlock', currentHeight));
    }
    const prevBlockHash = prevBlock
      ? blockHash(prevBlock.header)
      : GENESIS_PREV_BLOCK_HASH;
    if (prevBlockHash === null) {
      failStopIfCorruptChain(
        new UnhashableStoredHeaderError('createOrderingBlock', currentHeight),
      );
    }

    // 14. MINING_INTERFACE → Difficulty Schedule
    const powTargetBits = currentHeight === 0
      ? config.orderingBlockPowTargetBits
      : scheduledTargetBits(prevBlock!.header);

    // 19. The header template (powNonce=0). `utxoTxRoot` is the Merkle root of
    // the body it heads and `stateRoot` a placeholder, replaced in 19b — the
    // speculative run needs a whole candidate block, and the mutation phase reads
    // neither the nonce nor the signature.
    //
    // interlinkRoot: the root the header commits to (TYPES_INTERFACE → Interlink
    // vector). A null level or missing vector on our own tip → the boundary.
    let templateInterlinks: string[];
    if (prevBlock) {
      const storedInterlinks = getInterlinks(currentHeight);
      if (storedInterlinks === null) {
        failStopIfCorruptChain(
          new UnhashableStoredHeaderError('createOrderingBlock/interlinks', currentHeight),
        );
      }
      // VALIDATION_INTERFACE → level: null is no level, not a fail-stop
      const prevLevel = level(prevBlock.header, config.orderingBlockPowTargetBits);
      templateInterlinks = updateInterlinks(storedInterlinks!, prevBlockHash!, prevLevel);
    } else {
      templateInterlinks = [];
    }
    // MINING_INTERFACE → Header timestamp rules, producer side
    const createdAt = Math.max(nowMs(), (prevBlock?.header.createdAt ?? 0) + 1);
    const candidateOf = (tree: UtxoTxTree): OrderingBlock => ({
      header: {
        protocolVersion: era,
        height: newHeight,
        prevBlockHash,
        // 18. The Merkle root
        utxoTxRoot: computeUtxoTxRoot(tree),
        stateRoot: EMPTY_STATE_ROOT,
        validatorId,
        powNonce: 0,
        powTargetBits,
        createdAt,
        interlinkRoot: interlinkRoot(templateInterlinks),
      },
      utxoTxTree: tree,
      validatorSignature: new Uint8Array(64),
    });

    // 19b. Compute the POST-block state root (H-6) — the digest this block's own
    // body produces, obtained by running that body through the apply path's
    // mutation phase and restoring the prover after. Never the current (pre-block)
    // digest: apply compares against the post-mutation digest, so a pre-block
    // root can never verify. PoW covers the header, so this must be known before
    // mining.
    const speculate = (length: number): Speculated | { error: string } => {
      const built = length === selection.length ? { tree: body } : bodyOf(length);
      if ('error' in built) return built;
      const candidate = candidateOf(built.tree);
      return { length, candidate, speculation: computePostBlockStateRoot(candidate, handle) };
    };
    let run = speculate(selection.length);

    // 19c. Packing to the budget (MINING_INTERFACE → Template and submit →
    // "Packing to the budget"). A body's cost is known only by executing it, so a
    // selection over the budget is trimmed from the tail: halved until a prefix
    // fits, then grown back across the gap between the longest length known to
    // fit and the shortest known not to, halving the gap each time — every
    // length a speculation, at most 2·log₂(n) + 1 after the selection's own. The
    // template is always a prefix whose speculation answered `computed`, so no
    // template is ever over the budget, and nothing is evicted for it: an entry
    // trimmed stays pooled for a later block. A speculation that answers
    // `body-rejected` ends the search, and 19d evicts the body it rejected.
    if (isOverBudget(run)) {
      let over = selection.length;
      while (isOverBudget(run) && over > 0) {
        run = speculate(Math.floor(over / 2));
        if (isOverBudget(run)) over = run.length;
      }
      if (isComputed(run)) {
        let fits = run;
        while (over - fits.length > 1) {
          run = speculate(Math.floor((fits.length + over) / 2));
          if (isOverBudget(run)) over = run.length;
          else if (isComputed(run)) fits = run;
          else break;
        }
        if (isOverBudget(run) || isComputed(run)) {
          run = fits;
          console.log(
            `Block at height ${newHeight}: ${fits.length} of ${selection.length} ` +
            `selected transactions fit the block's budget; the rest stay pooled`,
          );
        }
      }
    }
    if ('error' in run) return decline(run.error);
    if (run.speculation.kind === 'over-budget') {
      return decline(`the body with no user transaction costs ${run.speculation.cost}, over the budget`);
    }

    // 19d. A body the mutation phase rejected is evicted and the build repeats
    // from purgeExpired, until the body holds or no pool row remains to evict
    // (MINING_INTERFACE → Template and submit). Reachable with unmutated code:
    // a pooled tx whose validity reads third-party state (a bond settlement's
    // threshold leg) goes stale in the pool while its inputs stay live. Evict
    // what the body included — the same cleanup a rejected finalize runs — or
    // every later rebuild reassembles this exact body: purgeExpired cannot break
    // that loop, because it keys on a chain height that stops advancing. A
    // rejected body that carried no pool row is terminal: the chain state cannot
    // back even the empty body, or a defect is throwing, and no repetition
    // changes either.
    const rowids = rowidsOf(selection.slice(0, run.length));
    if (run.speculation.kind === 'body-rejected') {
      if (rowids.size === 0) {
        console.warn(
          `Not producing block at height ${newHeight}: speculation returned ` +
          `body-rejected on a body with no pool rows`,
        );
        currentTemplate = null;
        confirmedRowids = new Set();
        return null;
      }
      // States the verdict, not the cause: `body-rejected` also carries the
      // speculation's unclaimed throws, which that arm logs itself. Naming the
      // mutation phase here would assert a diagnosis this frame does not have.
      console.warn(
        `Block at height ${newHeight}: speculation returned body-rejected; ` +
        `evicting ${rowids.size} mempool entries and rebuilding`,
      );
      for (const rowid of rowids) {
        removeEntry(rowid);
      }
      confirmedRowids = new Set();
      continue;
    }

    // 12. Track confirmed rowids for finalizeBlock cleanup (MEMPOOL_INTERFACE →
    //     Block Creator Integration step 4) — every row the template carries.
    confirmedRowids = rowids;
    const candidate = run.candidate;
    candidate.header.stateRoot = run.speculation.stateRoot;

    // 21. Store the full block template (header + bodies) for the miner. Its
    // stateRoot is this height's post-block digest, so the template stops being
    // submittable once a competing block moves the pre-state — which is exactly
    // what clearTemplate() on apply guarantees.
    //
    // This is where a produced block ends on this side: the nonce arrives from
    // `POST /mining/submit`, and `submitMinedBlock` is what finalizes.
    currentTemplate = candidate;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Block finalization
// ---------------------------------------------------------------------------

function finalizeBlock(block: OrderingBlock): void {
  // applyOrderingBlock handles validation, storage, coinbase, confirmations,
  // UTXO tx application, journal recording, and basic mempool cleanup
  //
  // The boundary sits here rather than at the caller because the one path in —
  // `POST /mining/submit` via `submitMinedBlock` — ends inside an Express
  // handler, which turns a throw into a 500 and keeps the node running.
  //
  // The rows this block confirmed are read off the module before the apply: an
  // accepted block moves the tip, which rebuilds the template and re-points
  // `confirmedRowids` at the rows of the *next* height.
  const minedRowids = confirmedRowids;
  let applied: boolean;
  try {
    applied = applyOrderingBlock(block);
  } catch (err) {
    failStopIfCorruptChain(err);
  }

  // Clean up any remaining mempool entries that applyOrderingBlock didn't
  // remove. Double-removal is harmless.
  //
  // This runs even when the block was rejected: whatever made it invalid came
  // out of the mempool, so leaving those entries in place would reassemble the
  // same rejected block at every rebuild and stall the chain.
  for (const rowid of minedRowids) {
    removeEntry(rowid);
  }

  // Broadcast (not handled by applyOrderingBlock) — only for a block we
  // ourselves accepted. Peers apply the same rules, so gossiping a block our
  // own validation rejected can only waste their bandwidth.
  const net = getNet();
  if (net && applied) {
    net.broadcastOrderingBlock(block).catch((err: Error) => {
      console.warn(`Failed to broadcast ordering block: ${err.message}`);
    });
  }

  // An accepted block has already rebuilt the template for the next height on
  // its way through the apply. A rejected one leaves the tip where it was, so
  // nothing rebuilt — and the body it was built from has just had its entries
  // dropped above, so rebuilding here is what stops the next solve being spent
  // on a body this node has already refused.
  if (!applied) {
    rebuildTemplate();
  }
}

// ---------------------------------------------------------------------------
// The decay configuration
// ---------------------------------------------------------------------------

/**
 * The four numbers karma decay reads (TYPES_INTERFACE → Identity record and
 * karma valuation): the rules' context's own, so a reader of this and a rule
 * run under `applyContextFrom` read one mapping of the profile.
 */
export function decayConfig(): DecayCfg {
  return applyContextFrom(nodeConfig).decayCfg;
}
