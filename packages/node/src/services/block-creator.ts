import {
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import {
  PROTOCOL_VERSION,
  GENESIS_PREV_BLOCK_HASH,
  CREDIT_INITIAL_REWARD,
  CREDIT_REWARD_REDUCTION,
  EMPTY_STATE_ROOT,
  MAX_BLOCK_BODY_BYTES,
  STORAGE_RENT_PER_BYTE,
  boxRecordBytes,
  decodeTx,
  encodeTx,
  computeTxId,
  leafHash,
  buildMerkleRoot,
  serializePruneEntry,
  hexToBuf,
  utxoTxTreeByteLength,
} from '@dagsocial/types';
import {
  verifyOrderingBlockPoW,
  blockHash,
} from '@dagsocial/validation';
import type {
  OrderingBlock,
  BlockHeader,
  UtxoTxTree,
  AnyBox,
  AnyBoxCandidate,
  UtxoTransaction,
} from '@dagsocial/types';
// The process config, distinct from the injected `config` below. The two
// emission values read off it are re-checked by the applier against the same
// singleton (`block-apply` §5, §5b), and `computeBlockReward` runs on the apply
// path of server-role nodes, where the injected one is never assigned.
import { config as nodeConfig } from '../config.js';
import type { Config } from '../config.js';
import { expectedTarget } from './difficulty.js';
import { getNet } from './net-instance.js';
import {
  applyOrderingBlock,
  computePostBlockStateRoot,
} from './block-apply.js';
import {
  countKarmaActors,
  isCreditSideTx,
  type EmbeddedTx,
} from './coinbase-split.js';
import {
  bondInviteeOf,
  buildSettlement,
  contributeToBody,
  emptyBody,
  type SettlementBody,
  type SettlementDeps,
} from './settlement.js';
import { deriveKarmaDecay } from './decay.js';
import { planPruneSettlement } from './settle-prune-utxo.js';
import type { PruneEntry } from '@dagsocial/types';
import type { DecayDeps, DecayPlan } from './decay.js';
import type { KarmaBox, VouchEscrowBox } from '@dagsocial/types';
import { materializeOutput } from './utxo-engine.js';
import {
  MissingStoredBlockError,
  UnhashableStoredHeaderError,
  failStopIfCorruptChain,
} from './corrupt-state.js';
import {
  iteratePendingEntries,
  purgeExpired,
  removeEntry,
  selectMempoolPrunes,
  entryByteCost,
} from '../store/mempool.js';
import {
  getOrderingBlock,
  getCurrentHeight,
  getBox,
  getBondsInvitedAt,
  getEmissionBox,
  getIdentityRecord,
  getVouchEscrowsReleasableAt,
  getRentEligibleCreditBoxes,
  getKarmaBoxes,
  getLikeCarryBox,
  getTreasuryBox,
  getKarmaPoolBox,
  putIdentityRecord,
} from '../store/index.js';

// ---------------------------------------------------------------------------
// Merkle root computation
//
// Every leaf preimage is the committed struct's own wire bytes, supplied by
// `@dagsocial/types` — `serializePruneEntry`, and a bare 32-byte id for
// `utxotx`. Node states no
// layout of its own here (TYPES_INTERFACE → Layout — Merkle leaf preimages are
// the struct's own wire bytes): a second statement of a layout in a second package
// drifts with no compiler signal, and a consistent transposition round-trips
// perfectly, so no round-trip test could see it. Only the `leafHash` domain tag
// belongs to this side of the boundary — that is what makes an entry's wire form
// and its committed form byte-identical rather than merely parallel.
// ---------------------------------------------------------------------------

/**
 * The block's one committed root.
 *
 * ⛔ **Leaf ORDER is normative and it is `UtxoTxTree`'s field order** — every
 * transaction, then every prune entry (TYPES_INTERFACE → Ordering block).
 * Reordering is a consensus change with no compiler signal. The settlement is
 * the last `utxoTxIds` entry, so it is the last transaction leaf and its
 * position is committed here rather than stated anywhere else.
 *
 * What keeps the two kinds apart inside one root is the `leafHash` domain tag,
 * not their position: `'utxotx'` and `'prune'` are distinct and NUL-terminated,
 * so they are prefix-free and a prune leaf cannot be reread as a transaction
 * leaf. The `'coinbase'` domain is a tracked reservation (TYPES_INTERFACE →
 * Tracked reservations) — reachable from no leaf here and reserved while the
 * coinbase concept lives.
 */
export function computeUtxoTxRoot(tree: UtxoTxTree): string {
  const leaves: Uint8Array[] = [
    ...tree.utxoTxIds.map((id) =>
      leafHash('utxotx', hexToBuf(id))),
    ...tree.pruneEntries.map((entry) =>
      leafHash('prune', Buffer.from(serializePruneEntry(entry)))),
  ];
  return Buffer.from(buildMerkleRoot(leaves)).toString('hex');
}

// ---------------------------------------------------------------------------
// Body sizing
//
// `entryByteCost` lives in `store/mempool.ts`, which records it per entry so a
// transaction can be priced by the resource it consumes. This file spends that
// number against the budget; the pool divides a fee by it.
// ---------------------------------------------------------------------------

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
 * Compute the block reward at a given height using Ergo-style linear decay.
 *
 * The decay's last step is to nothing: epoch 49 is the last that pays, and
 * every height above it yields 0 (MINING_INTERFACE → Emission Schedule, which
 * holds the end height and the emission total). Above the terminus the coinbase
 * carries whatever the other income terms yield, and a block with none of them
 * carries no coinbase outputs at all.
 */
export function computeBlockReward(height: number): bigint {
  if (height <= 0) return 0n;
  if (height <= nodeConfig.creditFixedRateBlocks) {
    return CREDIT_INITIAL_REWARD;
  }
  const epochs = Math.floor(
    (height - nodeConfig.creditFixedRateBlocks - 1) / nodeConfig.creditEpochBlocks,
  ) + 1;
  const reward = CREDIT_INITIAL_REWARD - BigInt(epochs) * CREDIT_REWARD_REDUCTION;
  return reward > 0n ? reward : 0n;
}

/**
 * The sum of `computeBlockReward` over every height — this network's whole
 * credit emission, and the value genesis puts in the `EmissionBox`
 * (MINING_INTERFACE → Emission Schedule; TYPES_INTERFACE → EmissionBox).
 *
 * ```
 * total = F·R + E · Σ(k = 1..K) (R − k·d)     K = the largest k with R − k·d > 0
 * ```
 *
 * `F` = `creditFixedRateBlocks`, `E` = `creditEpochBlocks`,
 * `R` = `CREDIT_INITIAL_REWARD`, `d` = `CREDIT_REWARD_REDUCTION`. The closed
 * form is the same schedule the loop above walks: heights `1..F` pay `R`, and
 * epoch `k` covers exactly `E` heights paying `R − k·d`.
 *
 * ⛔ **Derived here rather than carried per profile, and that is the whole
 * point.** A stored total that disagreed with `computeBlockReward` fails in one
 * of two silent ways: too small and the box is empty before the terminus, so
 * every block from that height on is unproducible; too large and a residue is
 * stranded that no rule can ever release. Sharing the parameters makes the two
 * unable to disagree. `test/services/genesis-state.test.ts` pins mainnet's
 * result at `422,640,000 × 10⁸` so a schedule change is caught here instead of
 * silently re-deriving a different genesis.
 *
 * Every network derives its own: devnet's compressed `F` and `E` give a
 * different total against the same economics (ARCHITECTURE → Network Identity:
 * compress time, never economics).
 */
export function emissionTotal(): bigint {
  const fixed = BigInt(nodeConfig.creditFixedRateBlocks) * CREDIT_INITIAL_REWARD;
  let decay = 0n;
  for (
    let reward = CREDIT_INITIAL_REWARD - CREDIT_REWARD_REDUCTION;
    reward > 0n;
    reward -= CREDIT_REWARD_REDUCTION
  ) {
    decay += reward;
  }
  return fixed + BigInt(nodeConfig.creditEpochBlocks) * decay;
}

// ---------------------------------------------------------------------------
// Core block creation
// ---------------------------------------------------------------------------

export function createOrderingBlock(): OrderingBlock | null {
  const currentHeight = getCurrentHeight();
  const newHeight = currentHeight + 1;

  // A body-rejected build repeats until it holds a template or a body
  // carrying no pool row is rejected. Every repetition strictly shrinks the
  // pool, which is what bounds the loop (MINING_INTERFACE → Template and
  // submit).
  for (;;) {
    // 1. Purge expired mempool entries
    purgeExpired(currentHeight);

    // 2. The prune entries, read off the pool without removing them — a prune
    //    row leaves the pool the way a transaction row does: by `removeEntry`
    //    when the body finalizes or is rejected, or by `removeMempoolPrunes`
    //    when an applied block confirms it (MEMPOOL_INTERFACE →
    //    selectMempoolPrunes). The prune rowids are pushed into `includedRowids`
    //    so that `confirmedRowids` tracks every row the template carries.
    //
    //    The settlement cannot be built here: it consumes the fee boxes the body
    //    creates and pays a coinbase scaled by the actors the body carries, so it
    //    depends on what the fill selects — and it is itself part of the body the
    //    fill is spending. ⛔ **It has no bounded worst case to reserve**
    //    (MEMPOOL_INTERFACE → The fill budget is bytes; getPendingEntries is a
    //    count), so instead each entry's `entryByteCost` carries its own marginal
    //    cost to it and the sizer below has the last word.
    const MAX_PRUNES_PER_BLOCK = 32;
    const pruneSelected = selectMempoolPrunes(MAX_PRUNES_PER_BLOCK);
    const pruneEntries = pruneSelected.map((s) => s.entry);
    const pruneRowids = pruneSelected.map((s) => s.rowid);

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
      pruneEntries,
    };

    /**
     * Re-derive the settlement from the user transactions currently selected and
     * write the whole body — the users' entries then the settlement, last.
     */
    const rebuildBody = (): { valid: boolean; error?: string } => {
      const decoded = userTxBytesList.map((raw) => {
        const tx = decodeTx(raw);
        const txId = computeTxId(tx);
        return { txId, inputs: tx.inputs, outputs: tx.outputs.map((out, i) => materializeOutput(out as AnyBox, txId, i)) };
      });
      const postBody = collectPostBodyKarma(decoded);
      const escrows = getVouchEscrowsReleasableAt(newHeight);
      const built = buildSettlement(
        settlementDepsWith(() => deriveKarmaDecay(decayDeps, postBody, newHeight, decayConfig()), escrows),
        newHeight,
        computeBlockReward(newHeight),
        nodeConfig.creditMinerRewardDelay,
        predictSettlementBody(userTxBytesList, validatorId, pruneEntries),
        currentMinerPubkey ?? validatorId,
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
    //    coinbase.** `predictSettlementBody` below resolves every input itself,
    //    because the applier computes the block's fees from its own resolution of
    //    the body — a stored fee that has gone stale, or the zero an unpriceable
    //    entry carries, would make this node emit a coinbase its own applier
    //    rejects. Ordering by a stale number costs nothing; summing one costs the
    //    block.
    //
    //    ⛔ **An invitee may be named ONCE per block.** A second bond for the same
    //    key makes the whole body inapplicable (`block-apply` §11), so a fill that
    //    selected both would produce nothing at all. Skipping the second is an
    //    assembly preference like the karma-first ordering, not a consensus rule.
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
        const txId = computeTxId(tx);
        const invitee = bondInviteeOf(
          tx.outputs.map((out, i) => materializeOutput(out, txId, i)),
        );
        if (invitee !== null) {
          const inviteeHex = Buffer.from(invitee).toString('hex');
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
    const MAX_RENT_TXS_PER_BLOCK = 32;
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
        protocolVersion: PROTOCOL_VERSION,
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
    while (userTxIds.length > 0 && utxoTxTreeByteLength(utxoTxTree) > budget) {
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

    // 11. Always produce a block — a block with no user work still pays its
    //     miner the scheduled emission. Above the terminus it pays nothing, and
    //     the settlement there carries no credit output at all; the block is
    //     produced either way, because the chain advancing is not conditional on
    //     income.

    // 12. Track confirmed rowids for finalizeBlock cleanup — every row the
    //     template carries, transaction and prune rows alike (MEMPOOL_INTERFACE →
    //     Block Creator Integration step 4).
    confirmedRowids = new Set<number>([...pruneRowids, ...includedRowids]);

    // 14. Difficulty — fixed by the height schedule, and enforced at apply
    const powTargetBits = expectedTarget(newHeight);

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

    // 18. Compute the Merkle root
    const utxoTxRoot = computeUtxoTxRoot(utxoTxTree);

    // 19. Build header template (powNonce=0). `stateRoot` is a placeholder here
    // and is replaced in 19b — the speculative run needs a whole candidate block,
    // and the mutation phase reads neither the nonce nor the signature.
    const headerTemplate: BlockHeader = {
      protocolVersion: PROTOCOL_VERSION,
      height: newHeight,
      prevBlockHash,
      utxoTxRoot,
      stateRoot: EMPTY_STATE_ROOT,
      validatorId,
      powNonce: 0,
      powTargetBits,
      createdAt: Date.now(),
    };
    const candidate: OrderingBlock = {
      header: headerTemplate,
      utxoTxTree,
      validatorSignature: new Uint8Array(64),
    };

    // 19b. Compute the POST-block state root (H-6) — the digest this block's own
    // body produces, obtained by running that body through the apply path's
    // mutation phase and rolling everything back. Never the current (pre-block)
    // digest: apply compares against the post-mutation digest, so a pre-block
    // root can never verify. PoW covers the header, so this must be known before
    // mining. A node with no prover falls back to EMPTY_STATE_ROOT — test-only,
    // since production initializes one at startup, and a peer running with
    // VERIFY_STATE_ROOT on rejects such a block, which is correct.
    const speculation = computePostBlockStateRoot(candidate, newHeight);

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
// The settlement's body
// ---------------------------------------------------------------------------

/**
 * The three protocol boxes the settlement moves, read from this node's store.
 *
 * Each getter is `ORDER BY id LIMIT 1`, so "the emission box" names one row and
 * not whichever SQLite returned first — the stated total order the determinism
 * obligation requires of anything read from a table (NODE_INTERFACE → the
 * settlement transaction's determinism obligation).
 */
/**
 * The decay pass's seams, all through the store.
 *
 * ⛔ **`getKarmaOwners` carries an `ORDER BY`, and that is a consensus
 * obligation.** Its result is walked into the settlement's input and output
 * lists, which the transaction id hashes in order, so an unordered
 * `SELECT DISTINCT` is a fork between two nodes holding identical state
 * (NODE_INTERFACE → Determinism is this mechanism's whole risk).
 */
export const decayDeps: DecayDeps = {
  getKarmaBoxes,
  getIdentityRecord,
  putIdentityRecord,
};

/**
 * Post-body karma projection for each identity the block's body touches.
 *
 * ⛔ **The plan must name boxes the settlement can consume — post-body, not
 * pre-body.** A touched identity had a body tx consume one of its pre-body
 * karma boxes, so naming pre-body boxes in the plan double-spends. The
 * projection removes consumed boxes and adds the body's karma change outputs.
 *
 * The identity record is NOT projected: user transactions do not write it,
 * so the pre-body record is what the settlement reads.
 *
 * Both the creator and the applier call this with the same decoded txs and
 * the same pre-body store, so both derive the same post-body set.
 *
 * ⛔ **Order is a consensus obligation.** Entries are sorted ascending by
 * owner hex; `deriveKarmaDecay` emits plans in that order.
 */
export function collectPostBodyKarma(
  decodedTxs: { txId: string; inputs: string[]; outputs: AnyBox[] }[],
): Map<string, { owner: Uint8Array; boxes: KarmaBox[] }> {
  const allInputIds = new Set<string>();
  for (const tx of decodedTxs) {
    for (const id of tx.inputs) allInputIds.add(id);
  }

  const touchedOwnerHexes = new Set<string>();
  const touchedOwners = new Map<string, Uint8Array>();

  for (const id of allInputIds) {
    const box = getBox(id);
    if (box?.boxType === 'karma') {
      const hex = Buffer.from((box as KarmaBox).owner).toString('hex');
      if (!touchedOwnerHexes.has(hex)) {
        touchedOwnerHexes.add(hex);
        touchedOwners.set(hex, (box as KarmaBox).owner);
      }
    }
  }

  const bodyKarmaOutputs = new Map<string, KarmaBox[]>();
  for (const tx of decodedTxs) {
    for (const out of tx.outputs) {
      if (out.boxType === 'karma') {
        const k = out as KarmaBox;
        const hex = Buffer.from(k.owner).toString('hex');
        if (touchedOwnerHexes.has(hex)) {
          let arr = bodyKarmaOutputs.get(hex);
          if (!arr) { arr = []; bodyKarmaOutputs.set(hex, arr); }
          arr.push(k);
        }
      }
    }
  }

  const sorted = [...touchedOwnerHexes].sort();
  const result = new Map<string, { owner: Uint8Array; boxes: KarmaBox[] }>();
  for (const hex of sorted) {
    const preBody = getKarmaBoxes(touchedOwners.get(hex)!);
    const surviving = preBody.filter((b) => b.id && !allInputIds.has(b.id));
    const produced = (bodyKarmaOutputs.get(hex) ?? []).filter(
      (b) => b.id && !allInputIds.has(b.id),
    );
    result.set(hex, { owner: touchedOwners.get(hex)!, boxes: [...surviving, ...produced] });
  }
  return result;
}

/** Everything the decay pass needs from the network profile. */
export function decayConfig(): {
  staleThresholdBlocks: number;
  decayIntervalBlocks: number;
  decayAmount: bigint;
  karmaMinimum: bigint;
} {
  return {
    staleThresholdBlocks: nodeConfig.karmaStaleThresholdBlocks,
    decayIntervalBlocks: nodeConfig.karmaDecayIntervalBlocks,
    decayAmount: nodeConfig.karmaDecayAmount,
    karmaMinimum: nodeConfig.karmaMinimum,
  };
}

/**
 * The settlement's reads, every one with a stated total order.
 *
 * ⛔ **ONE WIRING, SHARED BY THE PRODUCER AND THE APPLIER.** They must derive
 * the same settlement from the same state, and two copies of this object are two
 * derivations that agree only by inspection — which is the drift the whole unit
 * exists to close.
 *
 * `plans` is a thunk because the caller has already derived the decay pass:
 * `checkSettlement` reads it, and so does the clock commit afterwards, and two
 * scans of the identity set that must agree is exactly what one scan avoids.
 *
 * `escrows` is a captured list: the escrow leg reads pre-body state, so both
 * sides snapshot the releasable set before the apply loop and hand it in
 * (NODE_INTERFACE → The settlement transaction).
 */
export function settlementDepsWith(
  plans: () => DecayPlan[],
  escrows: VouchEscrowBox[],
): SettlementDeps {
  return {
    getEmissionBox,
    getTreasuryBox,
    getKarmaPoolBox,
    getBox,
    getLikeCarryBox,
    // The deadline is computed here rather than in the store, so the query stays
    // free of network parameters — the standing `getBondsInvitedAt` rule.
    getBondsSettlingAt: (h: number) => {
      // `<= 0` and not `< 0`: `0` is the never-invited sentinel, so at exactly
      // `height == INVITE_PROBATION_BLOCKS` this lands on it and every identity
      // that never claimed would match at once. `getBondsInvitedAt` refuses the
      // same value in SQL — the same rule in two places, and either alone
      // suffices.
      const invitedAt = h - nodeConfig.inviteProbationBlocks;
      return invitedAt <= 0 ? [] : getBondsInvitedAt(invitedAt);
    },
    getEscrowsReleasableAt: () => escrows,
    // ⚠ **The count comes from the identity record, never from a scan of
    // `like_records`.** Those records die with the post on prune, so a count
    // derived from them would let a third party lower it: an invitee who replies
    // in someone else's thread earns likes that the thread's author could then
    // destroy by pruning, taking karma off an inviter who did nothing
    // (ARCHITECTURE → Bond outcomes).
    getLifetimeLikes: (invitee: Uint8Array) =>
      getIdentityRecord(invitee)?.lifetimeLikesReceived ?? 0n,
    getDecayPlans: plans,
  };
}

/**
 * Everything a body of these transactions contributes to the settlement: the
 * fee total and the fee box ids, the karma-side actor count, and the invitee of
 * every bond.
 *
 * ⚠ **A prediction, not the rule.** The rule is the applier's, which gathers the
 * same quantities while walking the transactions in dependency order
 * (`block-apply` → the settlement carries the block's income). This runs before
 * the body has been applied and cannot use that walk, because the settlement it
 * feeds is part of the body the mutation phase runs over.
 *
 * A wrong prediction cannot produce a bad block: `checkSettlement` runs in the
 * mutation phase, and `computePostBlockStateRoot` runs that phase over this
 * body, so a settlement that does not match its body makes the speculation
 * `body-rejected` and this node declines to produce rather than mining a block
 * every peer refuses.
 *
 * Inputs resolve against the confirmed set **and this block's own outputs**,
 * because a transaction may spend a box an earlier one here creates. Order does
 * not matter to the actor count — a set is commutative — and the fee box ids and
 * invitees are collected in the order the body itself fixes, which is the order
 * the applier walks them in. An input that resolves to neither leaves the body
 * unappliable, which the speculation above is what catches.
 */
export function predictSettlementBody(
  txBytesList: Uint8Array[],
  validator: Uint8Array,
  pruneEntries: PruneEntry[] = [],
): SettlementBody {
  const txs = txBytesList.map((raw) => decodeTx(raw));

  const materialized: AnyBox[][] = [];
  const ownOutputs = new Map<string, AnyBox>();
  for (const tx of txs) {
    const txId = computeTxId(tx);
    const outputs = (tx.outputs ?? []).map((out, index) =>
      materializeOutput(out, txId, index),
    );
    materialized.push(outputs);
    for (const box of outputs) if (box.id) ownOutputs.set(box.id, box);
  }
  const resolve = (boxId: string): AnyBox | null =>
    getBox(boxId) ?? ownOutputs.get(boxId) ?? null;

  const body = emptyBody();
  const embedded: EmbeddedTx[] = [];
  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i]!;
    const inputBoxes = (tx.inputs ?? [])
      .map(resolve)
      .filter((box): box is AnyBox => box !== null);
    embedded.push({ tx, inputBoxes });
    const isRent = isCreditSideTx(tx) && Object.keys(tx.signatures).length === 0;
    contributeToBody(body, materialized[i]!, isRent);
  }

  body.actors = countKarmaActors(embedded, validator);
  // ⛔ **The prune legs are part of the settlement and so part of the
  // prediction.** A producer that omitted them would build a settlement its own
  // applier refuses — the pruner's own locks would be inputs one side names and
  // the other does not. `settlePruneUtxo` reads only the subtree's lock boxes,
  // which the body does not touch, so deriving it here and at apply reaches the
  // same plan.
  //
  for (const entry of pruneEntries) {
    body.prunes.push(
      planPruneSettlement(entry.rootPostHash, entry.authorId, entry.subtreePostIds),
    );
  }
  return body;
}

/**
 * Build the settlement a body of these transactions requires, ready to ride as
 * the body's last entry.
 *
 * Shared with the test harness so a fixture's settlement is the one this node
 * would have produced, rather than a second construction that agrees by hand.
 */
export function buildBlockSettlement(
  txBytesList: Uint8Array[],
  height: number,
  validator: Uint8Array,
  minerOwner: Uint8Array,
  pruneEntries: PruneEntry[] = [],
): { tx: UtxoTransaction } | { error: string } {
  const decoded = txBytesList.map((raw) => {
    const tx = decodeTx(raw);
    const txId = computeTxId(tx);
    return { txId, inputs: tx.inputs, outputs: tx.outputs.map((out, i) => materializeOutput(out as AnyBox, txId, i)) };
  });
  const postBody = collectPostBodyKarma(decoded);
  const escrows = getVouchEscrowsReleasableAt(height);
  return buildSettlement(
    settlementDepsWith(() => deriveKarmaDecay(decayDeps, postBody, height, decayConfig()), escrows),
    height,
    computeBlockReward(height),
    nodeConfig.creditMinerRewardDelay,
    predictSettlementBody(txBytesList, validator, pruneEntries),
    minerOwner,
  );
}
