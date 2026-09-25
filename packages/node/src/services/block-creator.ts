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
  hexToBuf,
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
  storeStateView,
} from './block-apply.js';
import { bondOutputOf, buildBlockSettlement, materializeOutput } from '@dagsocial/consensus';
import {
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
    leafHash('utxotx', hexToBuf(id)));
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
    //    ⚠ **These two hold the USER transactions, and the tree holds the body.**
    //    The settlement is appended to the tree by `rebuildBody` rather than
    //    pushed here, so the fill and the trim both operate on the list they
    //    select from and never on the tail they do not own.
    const userTxIds: string[] = [];
    const userTxBytesList: Uint8Array[] = [];
    const includedRowids: number[] = [];
    const utxoTxTree: UtxoTxTree = {
      utxoTxIds: [],
      utxoTxs: [],
    };

    /**
     * Re-derive the settlement from the user transactions currently selected and
     * write the whole body — the users' entries then the settlement, last.
     */
    const rebuildBody = (): { valid: boolean; error?: string } => {
      const built = buildBlockSettlement(
        storeStateView, userTxBytesList, newHeight, validatorId,
        currentMinerPubkey ?? validatorId, applyContextFrom(nodeConfig),
      );
      if ('error' in built) return { valid: false, error: built.error };
      utxoTxTree.utxoTxIds = [...userTxIds, computeTxId(built.tx)];
      utxoTxTree.utxoTxs = [...userTxBytesList, encodeTx(built.tx)];
      return { valid: true };
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
    const seeded = rebuildBody();
    if (!seeded.valid) {
      console.warn(`Not producing block at height ${newHeight}: ${seeded.error}`);
      currentTemplate = null;
      confirmedRowids = new Set();
      return null;
    }
    let spent = utxoTxTreeByteLength(utxoTxTree);
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
        userTxIds.push(txId);
        userTxBytesList.push(entry.utxoTxBytes);
        includedRowids.push(entry.rowid);
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
      const txId = computeTxId(rentTx);
      userTxIds.push(txId);
      userTxBytesList.push(encoded);
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
    const settled = rebuildBody();
    if (!settled.valid) {
      console.warn(`Not producing block at height ${newHeight}: ${settled.error}`);
      currentTemplate = null;
      confirmedRowids = new Set();
      return null;
    }

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
    //    their total, so it cannot widen the encoding on its own.
    //
    //    ⚠ **The pop takes a USER entry**, never the settlement: a body with no
    //    last transaction is one `verifyOrderingBlockStructure` refuses outright.
    const settlementExceedsBound = (): boolean =>
      utxoTxTree.utxoTxs.length > 0 &&
      utxoTxTree.utxoTxs[utxoTxTree.utxoTxs.length - 1]!.length > MAX_SETTLEMENT_BYTES;
    while (
      userTxIds.length > 0 &&
      (utxoTxTreeByteLength(utxoTxTree) > budget || settlementExceedsBound())
    ) {
      userTxIds.pop();
      userTxBytesList.pop();
      includedRowids.pop();
      const retrimmed = rebuildBody();
      if (!retrimmed.valid) {
        console.warn(`Not producing block at height ${newHeight}: ${retrimmed.error}`);
        currentTemplate = null;
        confirmedRowids = new Set();
        return null;
      }
    }
    if (userTxIds.length === 0 && settlementExceedsBound()) {
      console.error(
        `Not producing block at height ${newHeight}: settlement ` +
        `${utxoTxTree.utxoTxs[utxoTxTree.utxoTxs.length - 1]!.length} bytes ` +
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

    // 12. Track confirmed rowids for finalizeBlock cleanup (MEMPOOL_INTERFACE →
    //     Block Creator Integration step 4).
    confirmedRowids = new Set<number>(includedRowids);

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

    // 18. Compute the Merkle root
    const utxoTxRoot = computeUtxoTxRoot(utxoTxTree);

    // 19. Build header template (powNonce=0). `stateRoot` is a placeholder here
    // and is replaced in 19b — the speculative run needs a whole candidate block,
    // and the mutation phase reads neither the nonce nor the signature.
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
    const headerTemplate: BlockHeader = {
      protocolVersion: era,
      height: newHeight,
      prevBlockHash,
      utxoTxRoot,
      stateRoot: EMPTY_STATE_ROOT,
      validatorId,
      powNonce: 0,
      powTargetBits,
      // MINING_INTERFACE → Header timestamp rules, producer side
      createdAt: Math.max(nowMs(), (prevBlock?.header.createdAt ?? 0) + 1),
      interlinkRoot: interlinkRoot(templateInterlinks),
    };
    const candidate: OrderingBlock = {
      header: headerTemplate,
      utxoTxTree,
      validatorSignature: new Uint8Array(64),
    };

    // 19b. Compute the POST-block state root (H-6) — the digest this block's own
    // body produces, obtained by running that body through the apply path's
    // mutation phase and restoring the prover after. Never the current (pre-block)
    // digest: apply compares against the post-mutation digest, so a pre-block
    // root can never verify. PoW covers the header, so this must be known before
    // mining. A node with no prover falls back to EMPTY_STATE_ROOT — test-only,
    // since production initializes one at startup, and a peer holding a prover
    // rejects such a block, which is correct.
    const speculation = computePostBlockStateRoot(candidate);

    // 19c. A body the mutation phase rejected is evicted and the build repeats
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
    if (speculation.kind === 'body-rejected') {
      if (confirmedRowids.size === 0) {
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
        `evicting ${confirmedRowids.size} mempool entries and rebuilding`,
      );
      for (const rowid of confirmedRowids) {
        removeEntry(rowid);
      }
      confirmedRowids = new Set();
      continue;
    }

    headerTemplate.stateRoot =
      speculation.kind === 'computed' ? speculation.stateRoot : EMPTY_STATE_ROOT;

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
