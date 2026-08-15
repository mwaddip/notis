import {
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import {
  PROTOCOL_VERSION,
  CREDIT_INITIAL_REWARD,
  CREDIT_REWARD_REDUCTION,
  CREDIT_TAIL_REWARD,
  EMPTY_STATE_ROOT,
  MAX_BLOCK_BODY_BYTES,
  decodeTx,
  computeTxId,
  leafHash,
  buildMerkleRoot,
  serializePruneEntry,
  coinbaseOutputBytes,
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
  CoinbaseOutput,
  Post,
  AnyBox,
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
  splitCoinbase,
  type EmbeddedTx,
} from './coinbase-split.js';
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
  drainMempoolPrunes,
  entryByteCost,
} from '../store/mempool.js';
import {
  getOrderingBlock,
  getCurrentHeight,
  getPost,
  getBox,
} from '../store/index.js';

// ---------------------------------------------------------------------------
// Merkle root computation
//
// Every leaf preimage is the committed struct's own wire bytes, supplied by
// `@dagsocial/types` — `serializePruneEntry`, `coinbaseOutputBytes`, and a bare
// 32-byte id for `utxotx`. Node states no
// layout of its own here (TYPES_INTERFACE → "Merkle leaf preimages are the
// struct's own wire bytes"): a second statement of a layout in a second package
// drifts with no compiler signal, and a consistent transposition round-trips
// perfectly, so no round-trip test could see it. Only the `leafHash` domain tag
// belongs to this side of the boundary — that is what makes an entry's wire form
// and its committed form byte-identical rather than merely parallel.
// ---------------------------------------------------------------------------

/**
 * The block's one committed root.
 *
 * ⛔ **Leaf ORDER is normative and it is `UtxoTxTree`'s field order** — every
 * transaction, then every prune entry, then every coinbase output
 * (TYPES_INTERFACE → OrderingBlock). Reordering is a consensus change with no
 * compiler signal.
 *
 * What keeps the three kinds apart inside one root is the `leafHash` domain tag,
 * not their position: `'utxotx'`, `'prune'` and `'coinbase'` are distinct and
 * NUL-terminated, so they are prefix-free and a prune leaf cannot be reread as a
 * transaction leaf. The retired `'subblock'` domain is reachable from no leaf
 * here and stays reserved.
 */
export function computeUtxoTxRoot(tree: UtxoTxTree): string {
  const leaves: Uint8Array[] = [
    ...tree.utxoTxIds.map((id) =>
      leafHash('utxotx', hexToBuf(id))),
    ...tree.pruneEntries.map((entry) =>
      leafHash('prune', Buffer.from(serializePruneEntry(entry)))),
    ...tree.coinbaseOutputs.map((o) =>
      leafHash('coinbase', coinbaseOutputBytes(o))),
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
let dagService: import('./dag-service.js').DagService | undefined;

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
  // thereafter: production is regulated by difficulty, so a miner polling
  // `GET /mining/template` is never told to come back later
  // (MINING_INTERFACE → Template and submit).
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

export function setDagServiceForMiner(ds: import('./dag-service.js').DagService): void {
  dagService = ds;
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
  return reward > CREDIT_TAIL_REWARD ? reward : CREDIT_TAIL_REWARD;
}

// ---------------------------------------------------------------------------
// Core block creation
// ---------------------------------------------------------------------------

export function createOrderingBlock(): OrderingBlock | null {
  const currentHeight = getCurrentHeight();
  const newHeight = currentHeight + 1;

  // 1. Purge expired mempool entries
  purgeExpired(currentHeight);

  // 2. The prune entries, which the drain reads off the pool alone. The
  //    coinbase cannot be built here: its value is the block's income and its
  //    split is scaled by the actors the body carries, so it depends on what
  //    the fill selects — which in turn depends on the budget the coinbase
  //    leaves. The budget is seeded with the largest encoding a coinbase could
  //    take, and the real one replaces it once the fill is done.
  const MAX_PRUNES_PER_BLOCK = 32;
  const pruneEntries = drainMempoolPrunes(MAX_PRUNES_PER_BLOCK);
  const coinbaseOutputs = worstCaseCoinbaseOutputs(newHeight);

  // 3. The body's byte budget. `blockBodyBudgetBytes` is local — a miner may
  //    publish smaller blocks — while `MAX_BLOCK_BODY_BYTES` is consensus, so
  //    the clamp stands here as well as at load: `loadConfig` guards the
  //    environment, and this guards every `Config` assembled without it
  //    (NODE_INTERFACE → the `BLOCK_BODY_BUDGET_BYTES` row). Nothing is
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
  const utxoTxIds: string[] = [];
  const utxoTxCbors: Uint8Array[] = [];
  const includedRowids: number[] = [];
  const utxoTxTree: UtxoTxTree = {
    utxoTxIds,
    utxoTxs: utxoTxCbors,
    pruneEntries,
    coinbaseOutputs,
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
  //    coinbase.** `predictIncome` below resolves every input itself, because
  //    the applier computes the block's fees from its own resolution of the
  //    body — a stored fee that has gone stale, or the zero an unpriceable
  //    entry carries, would make this node emit a coinbase its own applier
  //    rejects. Ordering by a stale number costs nothing; summing one costs the
  //    block.
  let spent = utxoTxTreeByteLength(utxoTxTree);
  const offerBudgetTo = (klass: 'karma' | 'credit'): void => {
    for (const entry of iteratePendingEntries({ klass })) {
      if (entry.entryType !== 'utxo_tx' || entry.utxoTxCbor === null) continue;
      const cost = entryByteCost(entry.utxoTxCbor);
      if (spent + cost > budget) return;
      spent += cost;
      utxoTxIds.push(computeTxId(decodeTx(entry.utxoTxCbor)));
      utxoTxCbors.push(entry.utxoTxCbor);
      includedRowids.push(entry.rowid);
    }
  };
  offerBudgetTo('karma');
  offerBudgetTo('credit');

  // 6. The real coinbase, from the transactions the fill actually selected.
  //    Replacing the worst-case seed can only shrink the body, so the trim
  //    below has less to do than it was given room for, never more.
  const filled = predictIncome(utxoTxCbors, validatorId);
  utxoTxTree.coinbaseOutputs = buildCoinbaseOutputs(newHeight, filled.fees, filled.actors, currentMinerPubkey ?? validatorId);

  // 7. The sizer has the last word. `spent` is exact per entry and blind to the
  //    two array count prefixes, which widen with the entry COUNT rather than
  //    with any one entry, so the assembled body can measure a few bytes above
  //    what the accumulator tracked — at most one entry's worth. What
  //    `utxoTxTreeByteLength` returns over the finished tree is the number
  //    `verifyOrderingBlockStructure` measures, and a body above the budget is
  //    one every peer refuses.
  //
  //    It terminates with the coinbase in the loop, because popping a
  //    transaction can only remove a fee and can only remove an actor, so the
  //    income can only fall and the coinbase's encoding can only shrink or
  //    hold — monotone downward, never oscillating. The split moves value
  //    between the two outputs without changing their total, so it cannot widen
  //    the encoding on its own; an output count that changes does so by a slice
  //    reaching zero, which only removes an output.
  while (utxoTxIds.length > 0 && utxoTxTreeByteLength(utxoTxTree) > budget) {
    utxoTxIds.pop();
    utxoTxCbors.pop();
    includedRowids.pop();
    const trimmed = predictIncome(utxoTxCbors, validatorId);
    utxoTxTree.coinbaseOutputs = buildCoinbaseOutputs(newHeight, trimmed.fees, trimmed.actors, currentMinerPubkey ?? validatorId);
  }

  // 11. Always produce a block — miners need coinbase rewards even when
  //     there is no user work.  The block will be empty but still carries
  //     credit emission.

  // 12. Track confirmed rowids for finalizeBlock cleanup
  confirmedRowids = new Set<number>(includedRowids);

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
    : '0000000000000000000000000000000000000000000000000000000000000000';
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

  // 19c. A body the mutation phase rejected must not be mined or templated:
  // the PoW would be spent on a block this node's own apply — and
  // every peer's — rejects. Reachable with unmutated code: a pooled tx whose
  // validity reads third-party state (a bond settlement's threshold leg) goes
  // stale in the pool while its inputs stay live. Evict what the body included
  // — the same cleanup a rejected finalize runs — or every later rebuild
  // reassembles this exact body: purgeExpired cannot break that loop, because
  // it keys on a chain height that stops advancing.
  if (speculation.kind === 'body-rejected') {
    // States the verdict, not the cause: `body-rejected` also carries the
    // speculation's unclaimed throws, which that arm logs itself. Naming the
    // mutation phase here would assert a diagnosis this frame does not have.
    console.warn(
      `Not producing block at height ${newHeight}: speculation returned ` +
      `body-rejected; evicting ${confirmedRowids.size} mempool entries`,
    );
    for (const rowid of confirmedRowids) {
      removeEntry(rowid);
    }
    currentTemplate = null;
    confirmedRowids = new Set();
    return null;
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
    applied = applyOrderingBlock(block, dagService);
  } catch (err) {
    failStopIfCorruptChain(err);
  }

  // Clean up any remaining mempool entries that applyOrderingBlock didn't
  // remove (e.g. UTXO txs that were attached to sub-blocks and removed
  // from utxoTxIds). Double-removal is harmless.
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
// Coinbase
// ---------------------------------------------------------------------------

/**
 * The largest encoding any coinbase can take, used to seed the fill's budget
 * before the real one is known.
 *
 * Two outputs is the maximum the split produces, and `value` is bounded by its
 * own encoder at `2^64 − 1`, so no real coinbase encodes wider than this. Over-
 * reserving costs at most a transaction's place in a block that was within a
 * few bytes of the budget; under-reserving would put the assembled body over a
 * budget every peer measures.
 */
export function worstCaseCoinbaseOutputs(height: number): CoinbaseOutput[] {
  const lockedUntilBlock = height + nodeConfig.creditMinerRewardDelay;
  const widest = { owner: new Uint8Array(32), value: 2n ** 64n - 1n, lockedUntilBlock };
  return [
    { ...widest, isTreasury: false },
    { ...widest, isTreasury: true },
  ];
}

/**
 * The fees and the actor count a body of these transactions will yield.
 *
 * ⚠ **A prediction, not the rule.** The rule is the applier's, which sums the
 * same quantities while walking the transactions in dependency order
 * (`block-apply` → the coinbase carries the block's income). This runs before
 * the body has been applied and cannot use that walk, because the coinbase it
 * feeds has to exist before the mutation phase can run at all.
 *
 * A wrong prediction cannot produce a bad block: the coinbase check lives in
 * the mutation phase, and `computePostBlockStateRoot` runs that phase over this
 * body, so a coinbase that does not match its income makes the speculation
 * `body-rejected` and this node declines to produce rather than mining a block
 * every peer refuses.
 *
 * Inputs resolve against the confirmed set **and this block's own outputs**,
 * because a transaction may spend a box an earlier one here creates. Order does
 * not matter to either quantity — a sum and a set are both commutative — so
 * this agrees with the applier's dependency-ordered walk without reproducing
 * it. An input that resolves to neither leaves the body unappliable, which the
 * speculation above is what catches.
 */
export function predictIncome(
  txCbors: Uint8Array[],
  validator: Uint8Array,
): { fees: bigint; actors: number } {
  const txs = txCbors.map((cbor) => decodeTx(cbor));

  const ownOutputs = new Map<string, AnyBox>();
  for (const tx of txs) {
    const txId = computeTxId(tx);
    (tx.outputs ?? []).forEach((out, index) => {
      const box = materializeOutput(out as AnyBox, txId, index);
      if (box.id) ownOutputs.set(box.id, box);
    });
  }
  const resolve = (boxId: string): AnyBox | null =>
    getBox(boxId) ?? ownOutputs.get(boxId) ?? null;

  let fees = 0n;
  const embedded: EmbeddedTx[] = [];
  for (const tx of txs) {
    const inputBoxes = (tx.inputs ?? [])
      .map(resolve)
      .filter((box): box is AnyBox => box !== null);
    embedded.push({ tx, inputBoxes });

    if (!isCreditSideTx(tx)) continue;
    if (inputBoxes.length !== (tx.inputs ?? []).length) continue;
    const inputSum = inputBoxes.reduce((sum, box) => sum + box.value, 0n);
    const outputSum = tx.outputs.reduce((sum, out) => sum + out.value, 0n);
    fees += inputSum - outputSum;
  }

  return { fees, actors: countKarmaActors(embedded, validator) };
}

/**
 * The coinbase for a block of this income and this many karma-side actors
 * (MINING_INTERFACE → Coinbase Application).
 *
 * ⛔ **Every value here is consensus and none of it comes from the injected
 * config.** The applier recomputes this same split and compares it output by
 * output, so a creator reading a local value would build coinbases its own
 * network refuses. The percentages are universal constants and the treasury key
 * is profile data — "this network has no treasury" is a property of the
 * network, which is what stops two nodes on one network disagreeing about it.
 * Same rule, and the same reason, as the maturity lock below.
 */
export function buildCoinbaseOutputs(
  height: number,
  fees: bigint,
  actors: number,
  minerOwner: Uint8Array,
): CoinbaseOutput[] {
  const split = splitCoinbase(computeBlockReward(height), fees, actors);
  const outputs: CoinbaseOutput[] = [];

  // The applier rejects any coinbase whose lock is not exactly this
  // (MINING invariant 3), so it reads the singleton, not the injected config.
  const lockedUntilBlock = height + nodeConfig.creditMinerRewardDelay;

  // Skipped at zero, because no coinbase output may carry a zero value.
  if (split.miner > 0n) {
    outputs.push({
      owner: minerOwner,
      value: split.miner,
      lockedUntilBlock,
      isTreasury: false,
    });
  }

  // On a profile with no treasury key the treasury's share and the forfeited
  // bonus are simply not minted, and the block's income is smaller by exactly
  // that much. They are never handed to the miner: a miner who recovered their
  // own forfeit would make the inclusion bonus a delay rather than a cost, and
  // the bonus would price nothing.
  const treasuryKeyHex = nodeConfig.profile.treasuryPubKey;
  if (treasuryKeyHex.length === 64 && split.treasury > 0n) {
    outputs.push({
      owner: new Uint8Array(Buffer.from(treasuryKeyHex, 'hex')),
      value: split.treasury,
      lockedUntilBlock,
      isTreasury: true,
    });
  }

  return outputs;
}
