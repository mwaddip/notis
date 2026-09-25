import {
  canonicalUsernameBytes,
  computeTxId,
  decodeTx,
  encodeTx,
  MAX_ESCROW_RETURNS_PER_BLOCK,
  MAX_LAPSE_WITHDRAWALS_PER_BLOCK,
  membershipBar as membershipBarFn,
  memberLikesBar,
} from '@dagsocial/types';
import type {
  AnyBox,
  IdentityRecord,
  KarmaBox,
  OrderingBlock,
  UsernameBox,
  UtxoTransaction,
  VouchBox,
} from '@dagsocial/types';
import { postsOf, withdrawalsOf } from './block-posts.js';
import type { BlockPost } from './block-posts.js';
import { computeBlockReward, countKarmaActors, isCreditSideTx, type EmbeddedTx } from './coinbase-split.js';
import { collectPostBodyKarma, commitDecayClocks, deriveKarmaDecay } from './decay.js';
import type { DecayDeps } from './decay.js';
import { BlockOverlay } from './overlay.js';
import type { BlockMutation } from './overlay.js';
import { bondOutputOf, checkSettlement, contributeToBody, emptyBody, settlementDepsWith } from './settlement.js';
import type { ApplyContext, StateView } from './state-view.js';
import {
  applyTx,
  checkOutputShape,
  checkSettlementOutputShape,
  checkTxEnvelope,
  isMember,
  isRoot,
  materializeOutput,
  validateTx,
} from './utxo-engine.js';
import type { UtxoEngineDeps } from './utxo-engine.js';

/** What the block did, returned instead of written (CONSENSUS_INTERFACE → BlockEffects). */
export interface BlockEffects {
  /** Every write to committed state, in the order the phase made it. */
  mutations: BlockMutation[];
  /** The block's posts in body order. */
  posts: BlockPost[];
  /** Each like record written, in apply order. */
  likeRecords: Array<{ targetPostId: string; likerId: Uint8Array }>;
  /** Each withdrawn post id, in body order. */
  withdrawals: string[];
  /** The user transactions in applied order, each id with its bytes; the settlement is not among them. */
  appliedTxs: Array<{ txId: string; txBytes: Uint8Array }>;
}

/** The block's effects, or the reason a rule refused it (CONSENSUS_INTERFACE → Applying a block). */
export type ApplyResult = { ok: true; effects: BlockEffects } | { ok: false; reason: string };

/**
 * The block's state transition — the mutation phase, whole (CONSENSUS_INTERFACE
 * → Applying a block): the block's posts and their topology · the body decoded,
 * every declared id proven, the settlement found by position · the pre-body
 * captures · the user transactions in committed order · the withdrawals · the
 * settlement · the grants · the like counters · the membership pass · the decay
 * clocks.
 *
 * It runs at `block.header.height` and reads no other header field but
 * `validatorId`: the node has run the checks that need the chain first, and the
 * producer's speculative run passes a candidate whose nonce, signature and
 * `stateRoot` are placeholders (NODE_INTERFACE → Post-block stateRoot). Every
 * read goes through a block-local overlay of the block's own writes, and `view`
 * is never written (CONSENSUS_INTERFACE → The overlay).
 *
 * A rule failure answers `{ ok: false, reason }`, the reason the text the node
 * logs. A throw is not a verdict, and none is caught here.
 */
export function applyBlock(view: StateView, block: OrderingBlock, ctx: ApplyContext): ApplyResult {
  const height = block.header.height;
  const state = new BlockOverlay(view);
  const reject = (reason: string): ApplyResult => ({ ok: false, reason });

  // ⛔ **DECAY AND ESCROWS ARE DERIVED FROM PRE-BODY STATE, AND THEY HAVE
  // TO BE.** Decay is computed after decoding (the touched set comes from the
  // decoded transactions' inputs) but before the apply loop, so the UTXO
  // state is pre-body. Escrows are captured here for the same reason: the
  // body can create one (an unvouch of a long-held vouch), and a post-body
  // read would see it on one side only
  // (NODE_INTERFACE → The settlement transaction).
  // Both are assigned at §9b, after decoding and before the apply loop.

  // Every post id the block commits to, read once from the committed
  // transaction list: the effects carry this list, and the node confirms — and
  // on a revert un-confirms — exactly these (CONSENSUS_INTERFACE → BlockEffects).
  const blockPosts = postsOf(block);

  // 7. The coinbase is applied with the rest of the settlement, at §11a — after
  // the body, because the fees it pays out are a property of what the body
  // applied. ⛔ **There is no mint**: the credits are spent from the
  // `EmissionBox` by the same transaction that emits them, so source and
  // destination are named in one operation (MINING_INTERFACE → Coinbase
  // Application).

  // 7. Confirm the posts this block creates. A post whose row the view lacks —
  // its packet never reached the node — is a placeholder, live from here on
  // (NODE_INTERFACE → Post transactions → "A post applied without its packet is
  // a placeholder").
  for (const { postId } of blockPosts) {
    state.confirmPost(postId);
  }

  // 8. Populate block_topology from this block's post transactions.
  // Consensus data only — this, not dag_posts.author, is the authority for
  // withdrawal authorization, and it is derivable by any node holding the block body.
  for (const { postId, post } of blockPosts) {
    state.insertBlockTopology(postId, post.author, height);
  }

  // 11. Apply UTXO transactions from the block.
  //
  // NODE_INTERFACE → Block finalization → "The body is in dependency order,
  // and that is a consensus rule". One pass over the body in committed order:
  // every input resolves in the confirmed set as it stands at that point —
  // the pre-block set plus this block's earlier transactions' outputs, minus
  // their consumed inputs — or the block is rejected. Then full re-validation
  // (signatures, authorization, transitions, conservation), then apply. A
  // block producer is untrusted (permissionless PoW), so nothing about an
  // embedded tx is assumed verified.
  const utxoDeps = utxoDepsOver(state, ctx);

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
  // `verifyOrderingBlockStructure` refuses a body with no entries ahead of this
  // phase, and one that reaches it anyway is refused below as carrying no
  // settlement; identifying the settlement by position rather than by what it
  // spends is what lets a node find it with no UTXO set at all.
  const lastIndex = block.utxoTxTree.utxoTxIds.length - 1;
  let settlement: { txId: string; tx: UtxoTransaction; outputs: AnyBox[] } | null = null;
  for (let i = 0; i < block.utxoTxTree.utxoTxIds.length; i++) {
    const txId = block.utxoTxTree.utxoTxIds[i]!;
    const txBytes = block.utxoTxTree.utxoTxs[i];
    const isSettlement = i === lastIndex;

    if (!txBytes) {
      return reject(
        `Rejected block height=${height}: embedded UTXO tx ${txId} carries no body`,
      );
    }

    let tx: UtxoTransaction;
    try {
      tx = decodeTx(txBytes);
    } catch (err) {
      return reject(
        `Rejected block height=${height}: embedded UTXO tx ${txId} did not ` +
        `decode: ${String(err)}`,
      );
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
    // fields plus `likeTarget`, `post` and `postWithdraw`) and the
    // same field types, over a wider set of box types.
    const envelopeCheck = checkTxEnvelope(tx, height, ctx.protocolVersionSchedule);
    if (!envelopeCheck.valid) {
      return reject(
        `Rejected block height=${height}: embedded UTXO tx ${txId} has a ` +
        `malformed envelope: ${envelopeCheck.error}`,
      );
    }

    const outputCheck = isSettlement
      ? checkSettlementOutputShape(tx.outputs)
      : checkOutputShape(tx.outputs);
    if (!outputCheck.valid) {
      return reject(
        `Rejected block height=${height}: embedded UTXO tx ${txId} has an ` +
        `out-of-domain output: ${outputCheck.error}`,
      );
    }

    const decodedTxId = computeTxId(tx);
    if (decodedTxId !== txId) {
      return reject(
        `Rejected block height=${height}: embedded UTXO tx ${txId} declares an ` +
        `id its bytes do not produce (${decodedTxId})`,
      );
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
    return reject(
      `Rejected block height=${height}: body carries no settlement transaction`,
    );
  }

  // Per-block like accrual: in-memory, this invocation only — the
  // end-of-phase settlement (§11b) reads both maps. Local by design, so every
  // run of the phase, the producer's speculative one included, accrues and
  // settles identically.
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
  // block creates, and until the loop has applied that one, the state this
  // phase reads through does not hold the output.
  //
  // Apply order is committed order (NODE_INTERFACE → Block finalization), so
  // `perTxOutputs`, `appliedTxs` and every per-transaction list are in the
  // body's order — the order the settlement's fee-box inputs must follow.
  //
  // `appliedTxs` carries each transaction with its FIRST input box, which is
  // all `actorOf` reads, and reading it is sound only because `validateTx` has
  // passed by the time it is recorded — step 3's boxType pin is what makes the
  // first input speak for the transaction rather than being the producer's
  // choice.
  const perTxOutputs = new Map<string, AnyBox[]>();
  const rentTxIds = new Set<string>();
  const appliedTxs: EmbeddedTx[] = [];
  const appliedTxBytes: Array<{ txId: string; txBytes: Uint8Array }> = [];

  // ⛔ **Two inviters naming the same key in one block must not both grant**
  // (NODE_INTERFACE → Legal box transitions). The eligibility test each invite
  // passed is `IdentityRecord` existence, and the grant that writes that record
  // is the settlement's — which runs after every transaction here — so a
  // record-existence test cannot see a sibling transaction in the same block.
  // Without this the second bond draws a second grant from the pool for one
  // key, sized by whatever bond the second inviter chose.
  //
  // Keyed on the invitee hex; the value is the bond's `inviterId`, which the
  // grant step reads to decide the conferral
  // (NODE_INTERFACE → "A root's grant confers membership").
  const invitedThisBlock = new Map<string, Uint8Array>();

  // §9b. Pre-body captures: decay and escrows.
  //
  // Decay: squared per identity on touch (ARCHITECTURE → Karma decay). The
  // post-body projection derives from decoded transactions + the pre-body
  // UTXO set — both available before the apply loop. The settlement consumes
  // the projected boxes, which are the ones that exist after the body applies.
  const postBodyKarma = collectPostBodyKarma(
    state,
    queue.map((q) => ({ txId: q.txId, inputs: q.tx.inputs, outputs: q.outputs })),
  );
  const decayDeps = decayDepsOver(state);
  const decayPlans = deriveKarmaDecay(decayDeps, postBodyKarma, height, ctx.decayCfg);
  // Escrows and release candidates: captured before the apply loop so the
  // body's own mutations do not appear in the settlement's input list on one
  // side only.
  const escrows = state.getVouchEscrowsReleasableAt(height, MAX_ESCROW_RETURNS_PER_BLOCK);
  const lapsedVouches = state.getLapsedVouches(MAX_LAPSE_WITHDRAWALS_PER_BLOCK);
  const capturedBackerPool = state.getBackerPoolBox();

  // One pass, in committed order (NODE_INTERFACE → Block finalization).
  for (const item of queue) {
    const unresolvedInput = item.tx.inputs.find((id) => state.getBox(id) === null);
    if (unresolvedInput !== undefined) {
      return reject(
        `Rejected block height=${height}: embedded UTXO tx ${item.txId} ` +
        `has an unresolved input ${unresolvedInput}`,
      );
    }

    // Every input resolves — full re-validation. A tx that lists the same
    // input twice is refused by validateTx step 1 (duplicate input ids),
    // before any liveness read.
    const revalidated = validateTx(utxoDeps, item.tx, height);
    if (!revalidated.valid) {
      return reject(
        `Rejected block height=${height}: embedded UTXO tx ` +
        `${item.txId} failed re-validation: ${revalidated.error}`,
      );
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
      const author = state.getTopologyAuthor(targetPostId);
      if (author === null) {
        return reject(
          `Rejected block height=${height}: like tx ${item.txId} targets ` +
          `unconfirmed post ${targetPostId}`,
        );
      }
      const authorHex = Buffer.from(author).toString('hex');
      // NODE_INTERFACE → Karma transition rules: a like targets a live post
      // only — a placeholder is live (credits the topology author). A
      // withdrawn post, or an unknown one, rejects.
      if (state.getPostStanding(targetPostId) !== 'live') {
        return reject(
          `Rejected block height=${height}: like tx ${item.txId} targets ` +
          `withdrawn or unknown post ${targetPostId}`,
        );
      }
      // The liker is the karma inputs' owner, read from the input boxes —
      // never from the signature map. The gateway's one-signature rule is
      // gateway policy; a validator can embed a spare-signature like tx
      // directly, and it must still apply with the liker the owner state
      // names. validateTx above pinned every input to one karma owner, so
      // the first input names it.
      const likerId = (state.getBox(item.tx.inputs[0]!) as KarmaBox).owner;
      // One like per account per post, structurally: the key exists or it
      // does not. Applied likes earlier in this block already inserted
      // their record, so an intra-block duplicate fails here too.
      if (state.hasLikeRecord(targetPostId, likerId)) {
        return reject(
          `Rejected block height=${height}: like tx ${item.txId} ` +
          `duplicates an existing like-record for ${targetPostId}`,
        );
      }
      likeToRecord = { targetPostId, likerId, authorHex };
    }

    // ⛔ **THE UNVOUCH NEEDS NO ARM HERE.** The stake moves into a
    // `VouchEscrowBox` the voucher's own transaction outputs, so `applyTx`
    // inserts it like any other output, and it is a box mutation like every
    // other. ✅ **The obligation is committed state**, in the
    // UTXO set and therefore in the `stateRoot`, so nothing has to remember it
    // (ARCHITECTURE → Vouch boxes).

    // ⛔ **One invitee per block.** The bond IS the request, so a second bond
    // naming a key an earlier transaction in this block already named would
    // draw a second grant from the pool for one key. Refused before `applyTx`,
    // so a rejected block has mutated nothing on this transaction's account.
    const bondOut = bondOutputOf(item.outputs);
    if (bondOut !== null) {
      const inviteeHex = Buffer.from(bondOut.inviteePublicKey).toString('hex');
      if (invitedThisBlock.has(inviteeHex)) {
        return reject(
          `Rejected block height=${height}: invite tx ${item.txId} names ` +
          `${inviteeHex}, which another bond in this block already names`,
        );
      }
      invitedThisBlock.set(inviteeHex, bondOut.inviterId);
    }

    // Before `applyTx` consumes them. Every input is present (tested at the
    // top of this iteration) and reading the first is sound because
    // `validateTx` has just passed (NODE_INTERFACE → `validateTx` step 3).
    const firstInput = item.tx.inputs[0];
    const firstInputBox = firstInput !== undefined ? state.getBox(firstInput)! : null;

    // Capture a username input before applyTx consumes it — the burn's
    // deleteUsername needs the name from the box.
    let capturedUsernameInput: AnyBox | null = null;
    for (const inputId of item.tx.inputs) {
      const b = state.getBox(inputId);
      if (b && b.boxType === 'username') { capturedUsernameInput = b; break; }
    }
    if (firstInputBox !== null) {
      appliedTxs.push({ tx: item.tx, inputBoxes: [firstInputBox] });
    }

    // Rent recognition by shape: an unsigned credit-side tx that passed
    // authorization is a rent collection (NODE_INTERFACE → Storage rent is a
    // transition requiring no signature). The biconditional is
    // structural — authorization refuses unsigned non-eligible credit.
    if (isCreditSideTx(item.tx) && Object.keys(item.tx.signatures).length === 0) {
      rentTxIds.add(item.txId);
    }

    perTxOutputs.set(item.txId, item.outputs);

    // Track vouch targets for the membership pass. Capture the pre-block
    // record BEFORE applyTx modifies it — both inputs (consumed) and outputs
    // (created), so the pass sees the true pre-block value.
    for (const inputId of item.tx.inputs) {
      const inputBox = state.getBox(inputId);
      if (inputBox && inputBox.boxType === 'vouch') {
        const targetHex = Buffer.from((inputBox as VouchBox).targetId).toString('hex');
        membershipTouched.add(targetHex);
        if (!preBlockRecords.has(targetHex)) {
          preBlockRecords.set(targetHex, state.getIdentityRecord((inputBox as VouchBox).targetId));
        }
      }
    }
    for (const out of item.outputs) {
      if (out.boxType === 'vouch') {
        const targetHex = Buffer.from((out as VouchBox).targetId).toString('hex');
        membershipTouched.add(targetHex);
        if (!preBlockRecords.has(targetHex)) {
          preBlockRecords.set(targetHex, state.getIdentityRecord((out as VouchBox).targetId));
        }
      }
    }

    applyTx(utxoDeps, item.tx, item.outputs, height);

    // Posting is the activity (NODE_INTERFACE → Populating the record). The
    // post arm pins the author to the karma inputs' owner, so firstInputBox
    // is the author. The write lands after applyTx's box writes, so reverse
    // replay restores it first.
    if (item.tx.post !== undefined) {
      advanceActivityClock(state, (firstInputBox as KarmaBox).owner, height);
    }

    if (likeToRecord !== null) {
      // The like record (CONSENSUS_INTERFACE → BlockEffects), plus the
      // in-memory accrual §11b settles.
      state.insertLikeRecord(likeToRecord.targetPostId, likeToRecord.likerId);
      likesPerAuthor.set(
        likeToRecord.authorHex,
        (likesPerAuthor.get(likeToRecord.authorHex) ?? 0) + 1,
      );
      // ARCHITECTURE → Membership: memberLikes bumped iff member(liker).
      const likerRecord = state.getIdentityRecord(likeToRecord.likerId);
      if (likerRecord && isMember(likerRecord)) {
        memberLikesPerAuthor.set(
          likeToRecord.authorHex,
          (memberLikesPerAuthor.get(likeToRecord.authorHex) ?? 0) + 1,
        );
      }
    }

    // NODE_INTERFACE → Username transition rules.
    // Claim: a username output → putUsername.
    const usernameOut = item.outputs.find(o => o.boxType === 'username');
    if (usernameOut) {
      const u = usernameOut as UsernameBox;
      const canonical = Buffer.from(canonicalUsernameBytes(u.name)).toString('utf8');
      state.putUsername({
        nameLower: canonical,
        name: Buffer.from(u.name).toString('utf8'),
        owner: Buffer.from(u.owner).toString('hex'),
        boxId: usernameOut.id!,
        claimedAtBlock: height,
      });
    }
    // Burn: a username input → deleteUsername. The box is read before applyTx
    // consumed it (capturedUsernameInput, captured above).
    if (capturedUsernameInput) {
      const u = capturedUsernameInput as UsernameBox;
      const canonical = Buffer.from(canonicalUsernameBytes(u.name)).toString('utf8');
      state.deleteUsername(canonical);
    }

    // The transaction itself rides the effects, for the node to return to its
    // pool when a reorg reverts the block (NODE_INTERFACE → Block Journal).
    appliedTxBytes.push({ txId: item.txId, txBytes: encodeTx(item.tx) });
  }

  // 8b. Process withdrawal transactions from this block.
  const withdrawnThisBlock = new Set<string>();
  const blockWithdrawals = withdrawalsOf(block, (postId) => state.getTopologyAuthor(postId));
  for (const bw of blockWithdrawals) {
    const { postWithdraw } = bw;
    const postId = postWithdraw.postId;

    const postHeight = state.getTopologyHeight(postId);
    if (postHeight === null || postHeight >= height) {
      return reject(
        `Block ${height}: postWithdraw ${postId} is not confirmed ` +
        `in an earlier block (topology height ${postHeight})`,
      );
    }

    if (state.getPostStanding(postId) !== 'live') {
      return reject(
        `Block ${height}: postWithdraw ${postId} targets an already-withdrawn or unknown post`,
      );
    }
    if (withdrawnThisBlock.has(postId)) {
      return reject(
        `Block ${height}: duplicate postWithdraw for ${postId} in the same block`,
      );
    }
    withdrawnThisBlock.add(postId);

    state.withdrawPost(postId);
  }

  // 11a. The settlement transaction — the block's every protocol effect, in one
  // transaction committed under `utxoTxRoot` (NODE_INTERFACE → The settlement
  // transaction).
  //
  // It sits after the loop because what it consumes and pays is a property of
  // what the body applied, and inside this phase because the phase is the one
  // derivation both the applier and the creator's speculative run share — so a
  // creator whose own settlement does not match its body declines to produce the
  // block instead of mining one every peer will refuse.
  //
  // The settlement reads the body in committed order — which IS the apply
  // order (NODE_INTERFACE → Block finalization). The settlement's fee-box
  // inputs and its id hash them in that order.
  const settlementBody = emptyBody();
  for (let i = 0; i < lastIndex; i++) {
    const txId = block.utxoTxTree.utxoTxIds[i]!;
    const outputs = perTxOutputs.get(txId);
    if (outputs) contributeToBody(settlementBody, outputs, rentTxIds.has(txId));
  }
  settlementBody.actors = countKarmaActors(appliedTxs, block.header.validatorId);

  const emission = computeBlockReward(height, ctx);
  const settlementCheck = checkSettlement(
    settlementDepsWith(state, ctx, () => decayPlans, escrows, lapsedVouches, () => capturedBackerPool),
    height,
    ctx.protocolVersionSchedule,
    emission,
    ctx.creditMinerRewardDelay,
    settlementBody,
    settlement.tx,
  );
  if (!settlementCheck.valid) {
    return reject(
      `Rejected block height=${height}: settlement ${settlement.txId}: ` +
      `${settlementCheck.error}`,
    );
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
  // the AVL feed nets the pair and neither operation reaches the prover — a fee
  // box is absent from the AVL tree in the only block it ever exists in
  // (NODE_INTERFACE → AVL+ State Root).
  //
  // ⛔ **The settlement is not among the effects' applied transactions**
  // (CONSENSUS_INTERFACE → BlockEffects). That list exists for one purpose — a
  // reverted block's transactions return to the pool — and the settlement is
  // derived from a body rather than submitted by anyone: listed, it would enter
  // the pool on every reorg, where the next fill would draw it in as a user
  // entry. Its box mutations are in `mutations` like every other.
  // The lapse leg's vouch consumptions lower targets' memberVouches through
  // applyTx below — capture each target before the apply so the membership pass
  // evaluates them.
  for (const v of lapsedVouches) {
    const targetHex = Buffer.from(v.targetId).toString('hex');
    membershipTouched.add(targetHex);
    if (!preBlockRecords.has(targetHex)) {
      preBlockRecords.set(targetHex, state.getIdentityRecord(v.targetId));
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
  //
  // NODE_INTERFACE → "A root's grant confers membership": the inviter's
  // standing is read from its record as it stands when the settlement
  // grants — after every apply of this block, like the budget check beside
  // it (NODE_INTERFACE → Bond transition rules) — and a root's invitee is
  // written a member from this block; a member's invitee is written a
  // resident.
  for (const inviteeHex of [...invitedThisBlock.keys()].sort()) {
    const invitee = new Uint8Array(Buffer.from(inviteeHex, 'hex'));
    const inviterId = invitedThisBlock.get(inviteeHex)!;
    const inviterRecord = state.getIdentityRecord(inviterId);
    if (!inviterRecord) {
      // The invite-create arm refuses a bond whose inviter holds no identity
      // record (NODE_INTERFACE → "Only a root or a member creates a bond,
      // and a member's invites are a budget"), so a bond that reached this
      // grant always names one; a null read here is a defect, not a shape a
      // peer chose.
      throw new Error(
        `unreachable: bond inviter ${Buffer.from(inviterId).toString('hex')} ` +
        `holds no identity record at the grant`,
      );
    }
    const conferred = isRoot(inviterRecord);
    const after = state.getIdentityRecord(invitee);
    // NODE_INTERFACE → Membership pass → "A record the block first wrote has
    // no pre-block state, and the pass reads none": a legal invitee has no
    // record before this block, so the pre-image captured here is the
    // absence itself, never the record this write is about to create.
    preBlockRecords.set(inviteeHex, null);
    membershipTouched.add(inviteeHex);
    state.putIdentityRecord(invitee, {
      lastActivityBlock: after?.lastActivityBlock ?? height,
      lastDecayBlock: after?.lastDecayBlock ?? 0,
      invitedAtBlock: height,
      // Carried through rather than written, and it is always 0 here: a legal
      // invitee is not an account yet, so it has never held karma, never posted
      // and never been liked. The read is what keeps that a consequence of the
      // bar rather than an assumption this line makes.
      lifetimeLikesReceived: after?.lifetimeLikesReceived ?? 0n,
      memberSinceBlock: conferred ? height : (after?.memberSinceBlock ?? 0),
      memberBar: conferred ? 0 : (after?.memberBar ?? 0),
      memberVouches: after?.memberVouches ?? 0,
      memberLikes: after?.memberLikes ?? 0n,
      invitesUsed: after?.invitesUsed ?? 0,
    });
  }

  // 11b. The bookkeeping the settlement's boxes do not carry.
  //
  // ⛔ **EVERY VALUE MOVEMENT IS ABOVE THIS LINE.** The like payout, the carry,
  // the escrow releases, the vested bonds and the decay charges are all
  // outputs of the settlement transaction, because each one either draws from
  // or returns to the karma pool and the settlement is the
  // pool's only spender (NODE_INTERFACE → The settlement transaction). What is
  // left here is committed state that is not a box: the like counter and the
  // decay clock.
  //
  // Order pinned by the contract: embedded txs → settlement → author counters →
  // decay clocks.

  // The lifetime like counter, ascending author-hex order.
  //
  // ⛔ **This settlement is the counter's ONLY writer, and it only ever adds.**
  // Nothing decrements it: a withdrawal empties a post's content but leaves
  // its like-records untouched, so no author act can ever lower a count
  // somebody else's bond settles against (ARCHITECTURE → Bond outcomes).
  //
  // ⚠ **The outstanding accrual is NOT written back**, because there is nothing
  // to write: the carry is a `LikeAccrualBox` the settlement just emitted, and
  // the box IS the carry (ARCHITECTURE → Likes).
  for (const authorHex of [...likesPerAuthor.keys()].sort()) {
    const author = new Uint8Array(Buffer.from(authorHex, 'hex'));
    const received = BigInt(likesPerAuthor.get(authorHex)!);
    // Re-read here, after every earlier write of the block, so none is lost; a
    // missing record means maximally stale ({0, 0}), never "skip this author".
    const after = state.getIdentityRecord(author);
    state.putIdentityRecord(author, {
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
  // touched, ascending hex. Four cases: set / lapse / re-qualify / conferred
  // (case 4 — the grant step above already wrote the age and the bar for a
  // root's invitee; this pass only counts it). N written once at the end.
  // No value moves.
  // Add authors whose memberLikes rose to the membership pass's touched set.
  for (const authorHex of memberLikesPerAuthor.keys()) {
    membershipTouched.add(authorHex);
  }

  {
    const N = state.getNetworkRecord().memberCount;
    const D = membershipBarFn(N, ctx.membershipBarMultiplier);
    const Y = memberLikesBar(N, ctx.membershipBarMultiplier);

    let newN = N;
    for (const idHex of [...membershipTouched].sort()) {
      const id = new Uint8Array(Buffer.from(idHex, 'hex'));
      // NODE_INTERFACE → "A record the block first wrote has no pre-block
      // state, and the pass reads none": `??` would treat a captured `null`
      // — the grant step's pre-image for a legal invitee — as absent and
      // fall through to the post-grant record, reading a conferred member as
      // one that was already there. The existing captures (vouch targets)
      // are unaffected: a vouch target always holds a record.
      const pre = preBlockRecords.has(idHex) ? preBlockRecords.get(idHex)! : state.getIdentityRecord(id);
      const current = state.getIdentityRecord(id);
      if (!current) continue;

      const wasMember = pre !== null && pre.memberSinceBlock > 0 && pre.memberVouches >= pre.memberBar;

      if (current.memberSinceBlock === 0 &&
          current.memberVouches >= D &&
          current.memberLikes >= BigInt(Y)) {
        state.putIdentityRecord(id, {
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
      } else if (current.memberSinceBlock > 0 && current.memberBar === 0 && !wasMember) {
        // Case 4: conferred. The grant step already wrote the age and the
        // bar; a root cannot reach here, since its record is seeded at
        // genesis and `wasMember` is true for it on every block.
        newN++;
      }
    }

    if (newN !== N) {
      state.putNetworkRecord({ memberCount: newN });
    }
  }

  // 13. Advance the decay clock for every identity the settlement charged.
  //
  // ⚠ **Only firings reach here.** A stale identity sitting at the karma floor
  // produces no plan and keeps its clock where it was, rather than silently
  // forfeiting the intervals it is owed: the plan's existence is the gate.
  commitDecayClocks(decayDeps, decayPlans, height);

  return {
    ok: true,
    effects: {
      mutations: state.mutations,
      posts: blockPosts,
      likeRecords: state.likeRecords,
      withdrawals: state.withdrawals,
      appliedTxs: appliedTxBytes,
    },
  };
}

/**
 * Advance an identity's activity clock to the applying block's height
 * (NODE_INTERFACE → Populating the record). Every other field is carried
 * through: `lastDecayBlock`, `invitedAtBlock` and the like and membership
 * counters each have writers of their own, and an activity bump that reset one
 * would hand the owner a free interval, move a probation deadline or forfeit a
 * vested bond.
 */
function advanceActivityClock(state: BlockOverlay, owner: Uint8Array, height: number): void {
  const existing = state.getIdentityRecord(owner);
  state.putIdentityRecord(owner, {
    lastActivityBlock: height,
    lastDecayBlock: existing?.lastDecayBlock ?? 0,
    invitedAtBlock: existing?.invitedAtBlock ?? 0,
    lifetimeLikesReceived: existing?.lifetimeLikesReceived ?? 0n,
    memberSinceBlock: existing?.memberSinceBlock ?? 0,
    memberBar: existing?.memberBar ?? 0,
    memberVouches: existing?.memberVouches ?? 0,
    memberLikes: existing?.memberLikes ?? 0n,
    invitesUsed: existing?.invitesUsed ?? 0,
  });
}

/**
 * The engine's deps over the overlay (CONSENSUS_INTERFACE → The overlay): every
 * read answers over the state as the block has left it, and every write lands in
 * the overlay, so `validateTx` and `applyTx` run unchanged.
 */
function utxoDepsOver(state: BlockOverlay, ctx: ApplyContext): UtxoEngineDeps {
  return {
    getBox: (id) => state.getBox(id),
    insertBox: (box) => state.insertBox(box),
    consumeBox: (id) => state.consumeBox(id),
    // The vouch cast's minimum-balance gate reads the voucher's current summed
    // karma (ARCHITECTURE → Vouch boxes): the sum over the owner's whole live
    // set, the one definition the pool's check sums too (NODE_INTERFACE → UTXO).
    getKarmaValue: (owner) => state.getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n),
    // The vouch cast's cooldown gate (NODE_INTERFACE → Vouch transition rules).
    hasActiveVouchEscrow: (voucherId) => state.getVouchEscrowsFor(voucherId).length > 0,
    vouchCooldownBlocks: ctx.vouchCooldownBlocks,
    inviteBondMin: ctx.inviteBondMin,
    inviteBondMax: ctx.inviteBondMax,
    decayCfg: ctx.decayCfg,
    storageRentPeriodBlocks: ctx.storageRentPeriodBlocks,
    getBoxProvenance: (id) => state.getBoxProvenance(id),
    // ⛔ The like marker's author, from `block_topology` and never
    // `dag_posts.author` (ARCHITECTURE → Likes). The same read the like arm
    // makes, so the marker's pin and the like-record's author cannot disagree.
    getTopologyAuthor: (postId) => state.getTopologyAuthor(postId),
    // NODE_INTERFACE → Post transactions: at apply only `block_topology` is read.
    getPendingPostAuthor: () => null,
    // The invite-create not-already-an-account bar (NODE_INTERFACE → Bond
    // transition rules) among its readers.
    getIdentityRecord: (identityId) => state.getIdentityRecord(identityId),
    runInTransaction: (fn) => fn(),
    getVouchBox: (voucherId, targetId) => state.getVouchBoxes(voucherId, targetId)[0] ?? null,
    getNetworkRecord: () => state.getNetworkRecord(),
    membershipBarMultiplier: ctx.membershipBarMultiplier,
    putIdentityRecord: (identityId, record) => state.putIdentityRecord(identityId, record),
    protocolVersionSchedule: ctx.protocolVersionSchedule,
    getUsername: (nameLower) => state.getUsername(nameLower),
    getUsernameByOwner: (owner) =>
      state.getUsernameByOwner(typeof owner === 'string' ? Buffer.from(owner, 'hex') : owner),
  };
}

/** Decay's deps over the overlay: the clocks it commits are the block's writes. */
function decayDepsOver(state: BlockOverlay): DecayDeps {
  return {
    getKarmaBoxes: (owner) => state.getKarmaBoxes(owner),
    getIdentityRecord: (identityId) => state.getIdentityRecord(identityId),
    putIdentityRecord: (identityId, record) => state.putIdentityRecord(identityId, record),
  };
}
