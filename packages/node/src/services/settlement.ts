/**
 * The block's one settlement transaction — where every protocol effect happens,
 * and the only spender of the karma pool and the emission box
 * (NODE_INTERFACE → the settlement transaction).
 *
 * ⛔ **IT IS THE LAST ENTRY IN `utxoTxIds`, AND THAT IS HOW IT IS IDENTIFIED.**
 * Position is already committed — `utxoTxIds` order is normative and
 * `computeUtxoTxRoot` lays its leaves in it — so structural validation finds it
 * with no UTXO set at all. `@dagsocial/validation` owns the structural half
 * (`verifyOrderingBlockStructure` refuses a body with no last entry); what the
 * settlement *contains* is consensus and is this module's.
 *
 * ## What it consumes and emits
 *
 * | | |
 * |---|---|
 * | Consumes | the emission box (when this height releases), the treasury box (when this block accrues to it), the karma pool box (when this block draws from it), and every `FeeBox` the body's transactions created |
 * | Emits | the successors of those three, the coinbase's credit outputs, and one karma grant per `BondBox` the body created |
 *
 * ⛔ **A PROTOCOL BOX IS CONSUMED EXACTLY WHEN THIS BLOCK'S EFFECTS TOUCH IT.**
 * The emission box already carries that rule — above the terminus nothing is
 * released and the box is not spent (TYPES_INTERFACE → EmissionBox) — and the
 * treasury box and the pool follow it rather than a rule of their own. A block
 * that draws nothing from the pool leaves the pool's id alone, which is what
 * keeps a leaf from churning through the AVL tree on every block for no state
 * change.
 *
 * ⚠ **Above the emission terminus a body with no user work therefore settles to
 * a transaction with no inputs and no outputs.** It conserves, it applies as a
 * no-op, and its id is the same in every such block — which is harmless because
 * a transaction id names no box and the settlement is never pooled. A rule
 * forbidding it would have to be paid for by spending some box on every block.
 *
 * ⛔ **ITS INPUTS ARE DERIVED, NOT SERIALIZED**, and the enumeration order is
 * the one the block already fixes: the three protocol boxes in the fixed order
 * above, then the fee boxes in **committed transaction order**, and within a
 * transaction in output order. Nothing is sorted and nothing is read from a
 * table without a stated total order — the three protocol getters are
 * `ORDER BY id LIMIT 1`.
 *
 * ## ⛔ EVERY FIELD IS DERIVED OR PRODUCER-CHOSEN-AND-CONSTRAINED. NONE IS NEITHER.
 *
 * (NODE_INTERFACE → Determinism is this mechanism's whole risk — but it is
 * determinism of the VERDICT, not of the bytes.) A verifier **cannot** rebuild a
 * byte-identical settlement: `?miner=` makes the coinbase's payout key the
 * producer's, and it reaches a verifier only as an output of the very
 * transaction being checked. So the property that has to hold is that every
 * verifier reaches the same VERDICT — and a field that is neither recomputed nor
 * constrained is one a producer sets freely while the block still validates.
 *
 * | Field | |
 * |---|---|
 * | `inputs` | **derived**, element-wise and in order |
 * | emission / treasury / pool successors | **derived** — presence and value |
 * | the karma grants | **derived** — one per bond, its owner and its amount |
 * | the credit outputs | **producer's**, constrained: they sum to the miner's slice, each carries the scheduled maturity lock, none holds `0`, and no other box type is admitted |
 * | `signatures` | constrained — **must be empty**; no key authorizes a settlement |
 * | `protocolVersion` | constrained — exact |
 * | `likeTarget`, `post` | constrained — **must be absent** |
 *
 * ⚠ **Output ORDER is the producer's and is deliberately unconstrained.** It
 * moves the transaction id, every output's `index` and so every box id — but the
 * output multiset is pinned above, so no ordering carries value that another does
 * not. It is committed in `utxoTxRoot` like everything else, and every node
 * applies the order the block states.
 *
 * ⚠ **Determinism is still the risk, one level in.** What must agree across
 * nodes is the *derivation*: two honest nodes deriving different input orders
 * reject each other's blocks. That is why every ordering above is one the block
 * or a stated `ORDER BY` fixes.
 */

import {
  INVITE_BOND_VEST_PER_LIKES,
  INVITE_KARMA_AMOUNT,
  LIKES_PER_KARMA_PAYOUT,
  PROTOCOL_VERSION,
  encodeTx,
} from '@dagsocial/types';
import type {
  AnyBox,
  AnyBoxCandidate,
  BondBox,
  CreditBox,
  EmissionBox,
  KarmaBox,
  KarmaPoolBox,
  LikeAccrualBox,
  TreasuryBox,
  UtxoTransaction,
  VouchEscrowBox,
} from '@dagsocial/types';
import { splitCoinbase } from './coinbase-split.js';
import type { DecayPlan } from './decay.js';
import type { PruneSettlement } from './settle-prune-utxo.js';

// ---------------------------------------------------------------------------
// The body a settlement is derived from
// ---------------------------------------------------------------------------

/**
 * Everything about the block's other transactions that the settlement reads.
 *
 * Assembled by the producer from the transactions the fill selected, and by the
 * verifier from the transactions it has just applied. Both walk the body in
 * committed transaction order, so the two lists are the same list.
 */
export interface SettlementBody {
  /** `Σ FeeBox.value` over the body (MINING_INTERFACE → Coinbase Application). */
  fees: bigint;
  /** Distinct karma-side actors, the block's own validator excluded. */
  actors: number;
  /** The ids of those fee boxes, in committed transaction order. */
  feeBoxIds: string[];
  /** The invitees of the `BondBox`es the body creates, in committed transaction order. */
  invitees: Uint8Array[];
  /**
   * Every `LikeAccrualBox` the body's like transactions emitted, in committed
   * transaction order and within a transaction in output order.
   *
   * ⛔ **This is what makes the like payout DERIVED rather than counted.** The
   * quantity is committed in the block as boxes, so a producer and a verifier
   * cannot disagree about it — strictly stronger than the in-memory counter it
   * replaces, which merely had to be recomputed the same way on both sides
   * (NODE_INTERFACE → Per-block like settlement).
   */
  markers: Array<{ id: string; author: Uint8Array; value: bigint }>;
  /** What each of the block's prune entries owes, in prune-entry order. */
  prunes: PruneSettlement[];
}

/**
 * Everything the settlement reads that is not in the body.
 *
 * ⛔ **EVERY LISTED READ CARRIES A STATED TOTAL ORDER**, because each one feeds
 * a list this transaction hashes: two nodes reading a table in different orders
 * derive two different settlements (NODE_INTERFACE → Determinism is this
 * mechanism's whole risk). Three ordering sources are permitted and no fourth
 * is — the block's committed transaction order, ascending box id, and ascending
 * height.
 */
export interface SettlementDeps {
  getEmissionBox: () => EmissionBox | null;
  getTreasuryBox: () => TreasuryBox | null;
  getKarmaPoolBox: () => KarmaPoolBox | null;
  /** Resolve a box the body created or the chain holds — the settlement's inputs. */
  getBox: (id: string) => AnyBox | null;
  /**
   * The author's live carry box, or null.
   *
   * ⚠ **`exclude` is not an optimisation.** A marker and a carry box share a
   * type and are told apart only by lifetime (TYPES_INTERFACE → LikeAccrualBox),
   * so a query over live `like_accrual` boxes at this point in the block would
   * return one of this block's own markers. The block's marker ids are the only
   * thing that separates them.
   */
  getLikeCarryBox: (author: Uint8Array, exclude: Set<string>) => LikeAccrualBox | null;
  /** Escrows whose cooldown has run out, ascending box id. */
  getVouchEscrowsDueAt: (height: number) => VouchEscrowBox[];
  /** Bonds whose probation deadline is this height, ascending box id. */
  getBondsSettlingAt: (height: number) => BondBox[];
  /** `IdentityRecord.lifetimeLikesReceived` — the one field a bond settles against. */
  getLifetimeLikes: (invitee: Uint8Array) => bigint;
  /** What every stale identity owes, in the decay pass's stated owner order. */
  getDecayPlans: () => DecayPlan[];
}

/** What a settlement's construction or check answers with. */
export interface SettlementResult {
  valid: boolean;
  error?: string;
}

/** An empty result object, so both arms read the same way. */
const OK: SettlementResult = { valid: true };

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * The derived half of a settlement: its inputs, and every output whose content
 * the body decides.
 *
 * Shared by the builder and the checker so there is one derivation rather than
 * two that must agree — the property the whole unit rests on.
 */
interface DerivedSettlement {
  inputs: string[];
  /**
   * Every output whose content the body decides, **in the order they are
   * emitted**.
   *
   * ⛔ **OUTPUT ORDERING IS DERIVED, NOT THE PRODUCER'S** (NODE_INTERFACE →
   * Determinism is this mechanism's whole risk — the table names output ordering
   * among the derived fields). The one producer choice left is how the miner
   * partitions their own slice, and those outputs are the tail.
   *
   * ⚠ **This is stricter than matching the output MULTISET**, and the extra
   * strictness is load-bearing now rather than tidy. A settlement emits many
   * karma outputs — grants, payouts, escrow releases, vested bonds, decay
   * replacements, prune refunds — and two of them can name one owner in one
   * block, so a content match has no single answer to give.
   */
  derivedOutputs: AnyBoxCandidate[];
  /** What the coinbase's credit outputs must sum to. */
  minerSlice: bigint;
  /** The maturity lock every credit output must carry. */
  lockedUntilBlock: number;
}

/** Hex of a raw key, for grouping and for ordering. */
const hexOf = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/**
 * Derive everything the body decides.
 *
 * Returns an error rather than throwing when the chain cannot back the block —
 * no emission box at a height that releases, a pool short of the grants it owes
 * — because both are a verdict on the block and reach a caller that rejects it.
 */
function derive(
  deps: SettlementDeps,
  height: number,
  emission: bigint,
  minerRewardDelay: number,
  body: SettlementBody,
): { derived: DerivedSettlement } | { error: string } {
  const split = splitCoinbase(emission, body.fees, body.actors);
  const inputs: string[] = [];
  const outputs: AnyBoxCandidate[] = [];

  // What the pool owes and what it is owed, accumulated across every leg below
  // and settled once. ⛔ **The pool box is spent by this transaction and by
  // nothing else** (NODE_INTERFACE → The settlement transaction), so a leg
  // cannot reach it on its own — which is the whole reason decay, the bond
  // forfeit, the like remainder and the pruner's own locks are derived here
  // rather than where they used to run.
  let poolDraw = 0n;
  let poolSink = 0n;

  // ---- 1. The emission box ----
  //
  // Touched only when this height releases. At and above the terminus there is
  // no box and nothing is spent, which is why its absence there is not a fault
  // (TYPES_INTERFACE → EmissionBox).
  if (emission > 0n) {
    const box = deps.getEmissionBox();
    if (!box || !box.id) {
      return {
        error:
          `schedule releases ${emission} at height ${height} but this chain holds ` +
          `no emission box`,
      };
    }
    if (box.value < emission) {
      // Unreachable while `emissionTotal()` and `computeBlockReward` share the
      // profile's parameters — the total IS the sum, so the box covers every
      // release. Kept as the loud failure for the case where they stop
      // agreeing, because the alternative is a negative successor value.
      return {
        error:
          `emission box holds ${box.value}, short of the ${emission} height ` +
          `${height} releases`,
      };
    }
    inputs.push(box.id);
    const remaining = box.value - emission;
    // ⛔ A successor whose value would be `0` is not created. The genesis total
    // is exactly the schedule's sum, so the last emitting block consumes the box
    // and leaves none — one block, one encoding.
    if (remaining > 0n) outputs.push({ boxType: 'emission', value: remaining });
  }

  // ---- 2. The treasury box ----
  //
  // Nothing accrues on a block whose treasury slice rounds to zero, so it does
  // not touch the box — the shape that holds above the terminus with no fees,
  // where the block touches neither. Genesis creates none: it would hold `0`.
  if (split.treasury > 0n) {
    const box = deps.getTreasuryBox();
    if (box) {
      if (!box.id) return { error: 'treasury box carries no id' };
      inputs.push(box.id);
    }
    outputs.push({
      boxType: 'treasury',
      value: (box?.value ?? 0n) + split.treasury,
    });
  }

  // ---- 3. What every karma leg owes the pool, and what it draws ----
  //
  // Derived before the pool is touched, because the pool's successor is one
  // figure and every leg contributes to it. Each leg's own boxes are appended in
  // the sections that follow, in the order stated there.

  // 3a. The invite grants. ⛔ **A POOL SPEND, not a creation** (ARCHITECTURE →
  // The conservation axiom). The bond IS the request: one bond, one grant, and
  // the pairing is structural, so no rule compares two lists and no box is
  // invented to carry it.
  poolDraw += INVITE_KARMA_AMOUNT * BigInt(body.invitees.length);

  // 3b. The like settlement. For an author with markers totalling `n` this block
  // and a carry box holding `r`, where `x = LIKES_PER_KARMA_PAYOUT`:
  //
  //     markers×n + carry(r) → authorKarma(q·(x−1)) + pool(q) + carry(r′)
  //     total = n + r,  q = ⌊total / x⌋,  r′ = total mod x
  //
  // ⛔ **THE POOL IS A SINK HERE AND NEVER A SOURCE — the likers funded it**
  // (ARCHITECTURE → Likes). The remainder goes to the pool and never to the
  // treasury: to the pool it leaves circulation for good and the dial stays
  // deflationary; to the treasury it becomes spendable by something later,
  // which is redistribution wearing deflation's name.
  //
  // ⚠ **Derived from VALUE, not from a count of likes.** The contract states
  // `total = n + r` over likes, which coincides with the karma sum only while
  // `LIKE_KARMA_COST` is `1`. Summing value conserves at any cost and agrees
  // with the contract at this one, so the arithmetic does not quietly depend on
  // a constant it never names.
  const PAYOUT_X = BigInt(LIKES_PER_KARMA_PAYOUT);
  const markerIds = new Set(body.markers.map((m) => m.id));
  const byAuthor = new Map<string, { author: Uint8Array; total: bigint }>();
  // Marker inputs first, in committed transaction order — the enumeration order
  // the block already fixes, so it needs no sort and no rule of its own.
  for (const marker of body.markers) {
    inputs.push(marker.id);
    const key = hexOf(marker.author);
    const entry = byAuthor.get(key);
    if (entry) entry.total += marker.value;
    else byAuthor.set(key, { author: marker.author, total: marker.value });
  }
  // Then each credited author's carry box, ascending author-hex — the order the
  // contract pins for emitting an author's outputs.
  const authorsInOrder = [...byAuthor.keys()].sort();
  const likePayouts: Array<{ author: Uint8Array; paid: bigint; carry: bigint }> = [];
  for (const key of authorsInOrder) {
    const entry = byAuthor.get(key)!;
    const carryBox = deps.getLikeCarryBox(entry.author, markerIds);
    let total = entry.total;
    if (carryBox && carryBox.id) {
      inputs.push(carryBox.id);
      total += carryBox.value;
    }
    const q = total / PAYOUT_X;
    likePayouts.push({
      author: entry.author,
      paid: q * (PAYOUT_X - 1n),
      carry: total % PAYOUT_X,
    });
    poolSink += q;
  }

  // 3c. The vouch escrows this height releases. ✅ **No pool leg at all** — the
  // value moves from a box the settlement consumes into one it creates, so both
  // ends are named and the escrow is the first shape rather than the third
  // (ARCHITECTURE → How a source and a sink get named).
  const escrows = deps.getVouchEscrowsDueAt(height);
  for (const escrow of escrows) {
    if (!escrow.id) return { error: 'vouch escrow carries no id' };
    inputs.push(escrow.id);
  }

  // 3d. The bonds settling at this height (ARCHITECTURE → Bond outcomes). The
  // vested part returns to the inviter out of the `BondBox`; ⛔ **the unvested
  // remainder's sink is the POOL**, which under the retired shape was the
  // *absence* of a mint — a burn with no positive trace, and therefore invisible
  // to any search keyed on a mint's name.
  const VEST_PER_LIKES = BigInt(INVITE_BOND_VEST_PER_LIKES);
  const bonds = deps.getBondsSettlingAt(height);
  const bondSettlements: Array<{ inviter: Uint8Array; invitee: Uint8Array; vested: bigint }> = [];
  for (const bond of bonds) {
    if (!bond.id) return { error: 'bond box carries no id' };
    inputs.push(bond.id);
    const earned = deps.getLifetimeLikes(bond.inviteePublicKey) / VEST_PER_LIKES;
    const vested = earned < bond.value ? earned : bond.value;
    bondSettlements.push({
      inviter: bond.inviterId,
      invitee: bond.inviteePublicKey,
      vested,
    });
    poolSink += bond.value - vested;
  }

  // 3e. Decay. ⛔ **The burn's sink is the pool** (ARCHITECTURE → The
  // conservation axiom: "burn" means *move back to the supply pool*). The
  // mechanism is untouched — the same eager per-identity pass, staleness
  // predicate and karma floor; only the destination is named.
  const decayPlans = deps.getDecayPlans();
  for (const plan of decayPlans) {
    for (const id of plan.consumedBoxIds) inputs.push(id);
    poolSink += plan.burnAmount;
  }

  // 3f. The prune settlements, in prune-entry order. The refunds recirculate;
  // the pruner's own locks are the fourth burn and go to the pool.
  for (const prune of body.prunes) {
    for (const id of prune.lockBoxIds) inputs.push(id);
    poolSink += prune.toPool;
  }

  // ---- 4. The karma pool, settled once ----
  //
  // ⛔ **ONE POOL SPEND PER BLOCK.** The pool's id changes every time it is
  // spent, so two spenders naming it conflict — and unlike an ordinary contended
  // box the loser is not deferred but permanently invalid. Every leg above
  // contributes to one figure for that reason, not for tidiness.
  //
  // ⚠ **A net figure is not a net-delta reconciliation.** The axiom forbids
  // removing value at one point and restoring it later; here every unit moves in
  // the same transaction that takes it, and the pool's successor is what one
  // atomic operation leaves behind.
  if (poolDraw > 0n || poolSink > 0n) {
    const box = deps.getKarmaPoolBox();
    if (!box || !box.id) {
      return {
        error:
          `height ${height} settles ${poolDraw} out of and ${poolSink} into the ` +
          `karma pool but this chain holds no karma pool box`,
      };
    }
    const successor = box.value - poolDraw + poolSink;
    if (successor < 0n) {
      return {
        error:
          `karma pool holds ${box.value} and takes in ${poolSink}, short of the ` +
          `${poolDraw} this block grants`,
      };
    }
    inputs.push(box.id);
    // ⛔ A zero-value successor IS created, and this is the one place the
    // emission box's rule inverts: the pool never terminates, so burns must
    // always have somewhere to return (TYPES_INTERFACE → KarmaPoolBox).
    outputs.push({ boxType: 'karma_pool', value: successor });
  }

  // ---- 5. The fee boxes ----
  //
  // Block application is their only spender and it runs once per block, so a fee
  // box surviving its block would hand its value to a later miner and break the
  // coinbase identity (MINING_INTERFACE → Coinbase Application).
  for (const feeBoxId of body.feeBoxIds) inputs.push(feeBoxId);

  // ---- 6. The karma this block pays out ----
  //
  // ⛔ **NO CONSOLIDATION, and that is a change from `mintKarma`.** A recipient
  // ends the block holding one more karma box rather than one merged box.
  // Consolidating would make this transaction's INPUT list depend on the
  // recipient's unrelated holdings instead of on the block's content — and two
  // legs crediting one owner would both want to consume the same boxes, which
  // inside one transaction is a double spend. Nothing in the axiom counts boxes;
  // `getKarmaValue` sums them.
  for (const invitee of body.invitees) {
    outputs.push({ boxType: 'karma', value: INVITE_KARMA_AMOUNT, owner: invitee });
  }
  for (const payout of likePayouts) {
    // Skipped at zero on both halves: `[]` and `[{value: 0}]` are two encodings
    // of one state. An author whose total has not reached `x` is paid nothing and
    // their whole accrual rides the carry box.
    if (payout.paid > 0n) {
      outputs.push({ boxType: 'karma', value: payout.paid, owner: payout.author });
    }
    if (payout.carry > 0n) {
      outputs.push({ boxType: 'like_accrual', value: payout.carry, author: payout.author });
    }
  }
  for (const escrow of escrows) {
    outputs.push({ boxType: 'karma', value: escrow.value, owner: escrow.owner });
  }
  for (const settled of bondSettlements) {
    if (settled.vested > 0n) {
      outputs.push({ boxType: 'karma', value: settled.vested, owner: settled.inviter });
    }
  }
  for (const plan of decayPlans) {
    // ⛔ `decayBurn` is what keeps this box from resetting the owner's activity
    // clock. Without it every charged identity looks freshly active and decay
    // stops after one interval.
    if (plan.newValue > 0n) {
      outputs.push({
        boxType: 'karma',
        value: plan.newValue,
        owner: plan.owner,
        decayBurn: true,
      });
    }
  }
  for (const prune of body.prunes) {
    for (const refund of prune.refunds) {
      outputs.push({ boxType: 'karma', value: refund.amount, owner: refund.owner });
    }
  }

  return {
    derived: {
      inputs,
      derivedOutputs: outputs,
      minerSlice: split.miner,
      lockedUntilBlock: height + minerRewardDelay,
    },
  };
}

/**
 * Build the block's settlement transaction.
 *
 * ⛔ **Pure in everything but the derivation's own reads**, every one of which
 * carries a stated total order — no wall clock, no node-local table, no
 * iteration order the block does not already fix.
 *
 * `minerOwner` is the one parameter that is not derived: the coinbase's payout
 * key is the producer's and is committed in the settlement's own bytes rather
 * than recomputed by a verifier.
 *
 * ⛔ **The derived outputs come first, in derivation order; the coinbase's
 * credit outputs are the tail.** That is a consensus rule and not a convention
 * of this function — `checkSettlement` requires the same shape.
 */
export function buildSettlement(
  deps: SettlementDeps,
  height: number,
  emission: bigint,
  minerRewardDelay: number,
  body: SettlementBody,
  minerOwner: Uint8Array,
): { tx: UtxoTransaction } | { error: string } {
  const d = derive(deps, height, emission, minerRewardDelay, body);
  if ('error' in d) return d;
  const { derived } = d;

  const outputs: AnyBoxCandidate[] = [...derived.derivedOutputs];
  // Skipped at zero, because no coinbase output may carry a zero value: `[]` and
  // `[{value: 0}]` are two encodings of one block with different `utxoTxRoot`.
  if (derived.minerSlice > 0n) {
    outputs.push({
      boxType: 'credit',
      value: derived.minerSlice,
      owner: minerOwner,
      lockedUntilBlock: derived.lockedUntilBlock,
    });
  }

  return {
    tx: {
      inputs: derived.inputs,
      outputs,
      // ⛔ **No key authorizes a settlement**, so the map is empty and a
      // non-empty one is refused: it would be bytes inside `utxoTxRoot` that no
      // rule reads (NODE_INTERFACE → Legal box transitions — no requirement may
      // name a key that is not already in consensus state).
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    },
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * A candidate's whole content as one comparable string.
 *
 * ⚠ **Every field, sorted by key** — `checkSettlementOutputShape` has already
 * pinned the exact key set and every field's runtime type, so this is total over
 * what reaches it. A comparison that named fields explicitly would silently stop
 * covering a field a later box type adds.
 */
function candidateKey(o: AnyBoxCandidate): string {
  const rec = o as unknown as Record<string, unknown>;
  return Object.keys(rec)
    .sort()
    // ⛔ **A present-`undefined` optional IS absent, and the encoder is the
    // authority.** `opt()` gives absence exactly one encoding, so a settlement
    // that has been through `decodeTx` carries every optional field present and
    // holding `undefined`, while the derivation this compares it against never
    // wrote the key at all. Two encodings of one box must produce one key here
    // or every decoded settlement is refused.
    .filter((k) => rec[k] !== undefined)
    .map((k) => {
      const v = rec[k];
      if (typeof v === 'bigint') return `${k}=${v}`;
      if (v instanceof Uint8Array) return `${k}=${hexOf(v)}`;
      return `${k}=${String(v)}`;
    })
    .join('|');
}

/**
 * Check the producer's settlement against the derivation this node makes from
 * the same body.
 *
 * Every rejection is the block's: a settlement that fails any clause here makes
 * the whole block invalid, on the same terms as an embedded transaction that
 * does not apply.
 */
export function checkSettlement(
  deps: SettlementDeps,
  height: number,
  emission: bigint,
  minerRewardDelay: number,
  body: SettlementBody,
  settlement: UtxoTransaction,
): SettlementResult {
  const d = derive(deps, height, emission, minerRewardDelay, body);
  if ('error' in d) return { valid: false, error: d.error };
  const { derived } = d;

  // ---- 1. The input list, exactly and in order ----
  //
  // Order is part of the transaction id, so a settlement whose inputs are the
  // right set in a different order is a different transaction. Compared
  // element-wise rather than as sets for that reason.
  if (settlement.inputs.length !== derived.inputs.length) {
    return {
      valid: false,
      error:
        `settlement consumes ${settlement.inputs.length} boxes, the body derives ` +
        `${derived.inputs.length}`,
    };
  }
  for (let i = 0; i < derived.inputs.length; i++) {
    if (settlement.inputs[i] !== derived.inputs[i]) {
      return {
        valid: false,
        error:
          `settlement input ${i} is ${settlement.inputs[i]}, the body derives ` +
          `${derived.inputs[i]}`,
      };
    }
  }

  // ---- 2. Nothing but the transaction ----
  //
  // A settlement carries no signature, no like and no post. Each would be bytes
  // inside `utxoTxRoot` that no rule reads, which is the malleability
  // `checkTxEnvelope`'s closed key set refuses for user transactions.
  if (Object.keys(settlement.signatures ?? {}).length !== 0) {
    return { valid: false, error: 'settlement carries a signature; no key authorizes it' };
  }
  if (settlement.likeTarget !== undefined) {
    return { valid: false, error: 'settlement carries a likeTarget' };
  }
  if (settlement.post !== undefined) {
    return { valid: false, error: 'settlement carries a post' };
  }
  if (settlement.protocolVersion !== PROTOCOL_VERSION) {
    return {
      valid: false,
      error: `settlement declares protocol version ${settlement.protocolVersion}`,
    };
  }

  // ---- 3. The derived outputs, element-wise and in order ----
  //
  // ⛔ **Positional, because output ordering is DERIVED** (NODE_INTERFACE →
  // Determinism is this mechanism's whole risk names it among the derived
  // fields). Matching by content alone has no answer when two legs credit one
  // owner in one block — an invite grant and a like payout to the same key are
  // two karma boxes a multiset match cannot tell apart from one of each other's.
  const n = derived.derivedOutputs.length;
  if (settlement.outputs.length < n) {
    return {
      valid: false,
      error:
        `settlement emits ${settlement.outputs.length} outputs, short of the ` +
        `${n} the body derives`,
    };
  }
  for (let i = 0; i < n; i++) {
    const got = candidateKey(settlement.outputs[i]!);
    const want = candidateKey(derived.derivedOutputs[i]!);
    if (got !== want) {
      return {
        valid: false,
        error: `settlement output ${i} is ${got}, the body derives ${want}`,
      };
    }
  }

  // ---- 4. The coinbase ----
  //
  // The sum is the rule; the partition and the payout key are the producer's
  // (MINING_INTERFACE → Coinbase Application, receipt step 2).
  let coinbaseTotal = 0n;
  for (const out of settlement.outputs.slice(n)) {
    if (out.boxType !== 'credit') {
      return {
        valid: false,
        error: `settlement emits an unexpected ${out.boxType} box`,
      };
    }
    const credit = out as CreditBox;
    // One block, one encoding — after the total, because that is the
    // substantive rule and a coinbase claiming the wrong amount must be named as
    // that rather than as an encoding fault. Checked here because a zero-value
    // output satisfies conservation.
    if (credit.value === 0n) {
      return { valid: false, error: 'zero-value coinbase output' };
    }
    // Each output's lock travels into the ledger exactly as the producer wrote
    // it, so an unchecked `0` mints a coinbase spendable in the block that
    // created it (MINING invariant 3).
    if (credit.lockedUntilBlock !== derived.lockedUntilBlock) {
      return {
        valid: false,
        error:
          `coinbase lockedUntilBlock ${credit.lockedUntilBlock} != expected ` +
          `${derived.lockedUntilBlock}`,
      };
    }
    coinbaseTotal += credit.value;
  }
  if (coinbaseTotal !== derived.minerSlice) {
    return {
      valid: false,
      error:
        `coinbase value ${coinbaseTotal} != miner slice ${derived.minerSlice} ` +
        `(emission ${emission} + fees ${body.fees})`,
    };
  }

  // ---- 5. Conservation, over the whole transaction ----
  //
  // ⛔ **The axiom's own check** (ARCHITECTURE → The conservation axiom). Every
  // clause above pins a value, so this cannot fail on its own — and it is where
  // *"a block paying the whole income to its miner sums correctly against
  // nothing"* is refused, which is why the contract names it the enforcement
  // point rather than a consequence (MINING_INTERFACE → the receipt checks
  // survive).
  let totalIn = 0n;
  for (const id of settlement.inputs) {
    const box = deps.getBox(id);
    if (!box) {
      return { valid: false, error: `settlement input not found or already spent: ${id}` };
    }
    totalIn += box.value;
  }
  const totalOut = settlement.outputs.reduce((sum, o) => sum + o.value, 0n);
  if (totalIn !== totalOut) {
    return {
      valid: false,
      error: `settlement non-conservation: inputs=${totalIn}, outputs=${totalOut}`,
    };
  }

  return OK;
}

// ---------------------------------------------------------------------------
// Byte cost
// ---------------------------------------------------------------------------

/**
 * A settlement of this shape, used only to measure. Its field values are
 * irrelevant to the length except where a VLQ widens, so the probes below carry
 * the real `INVITE_KARMA_AMOUNT` and a full-width credit value.
 */
function probe(inputs: number, grants: number): UtxoTransaction {
  return {
    inputs: Array.from({ length: inputs }, (_, i) =>
      i.toString(16).padStart(64, '0'),
    ),
    outputs: Array.from({ length: grants }, () => ({
      boxType: 'karma' as const,
      value: INVITE_KARMA_AMOUNT,
      owner: new Uint8Array(32),
    })),
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
}

// ⛔ **Measured through the encoder, never restated as a byte count.** A second
// copy of the layout in this package would drift with no compiler signal, and a
// consistent transposition round-trips perfectly — the same reason
// `utxoTxTreeByteLength` exists rather than an arithmetic in the block creator
// (TYPES_INTERFACE → Sizing without encoding).
const PROBE_BASE = encodeTx(probe(0, 0)).length;
const INPUT_BYTES = encodeTx(probe(1, 0)).length - PROBE_BASE;
const GRANT_BYTES = encodeTx(probe(0, 1)).length - PROBE_BASE;

/**
 * What one pooled transaction adds to the settlement, in bytes.
 *
 * ⚠ **`entryByteCost` must include this** (MEMPOOL_INTERFACE → the settlement
 * transaction replaces `coinbaseOutputs` here), or the accumulator stops being
 * nearly right before the final exact measurement and *"the trim loop runs at
 * most once"* stops holding. A flat per-entry surcharge would over-reserve on the common
 * case and under-reserve on a block full of invites; under-reserving is the
 * direction that puts an assembled body over a budget every peer measures.
 *
 * **Not uniform across entry kinds, deliberately.** A fee box adds one derived
 * input; a bond adds one grant output; an ordinary karma transfer adds nothing.
 *
 * Blind to the same two things the block creator's accumulator is: the settlement's
 * own array count prefixes widen with the counts rather than with any one entry,
 * and its first contribution turns an absent protocol-box input into a present
 * one. Both are bounded by a few bytes across the whole body, and the sizer has
 * the last word.
 */
export function settlementMarginalBytes(tx: UtxoTransaction): number {
  let bytes = 0;
  for (const out of tx.outputs ?? []) {
    if (out.boxType === 'fee') bytes += INPUT_BYTES;
    else if (out.boxType === 'bond') bytes += GRANT_BYTES;
    // ⛔ **A marker's term is an INPUT, not an output**, and that is the whole
    // reason a per-like surcharge does not compound. Each like adds one derived
    // input to the settlement; the payout it eventually joins is one output per
    // AUTHOR, however many likes they received, so an author's second like in a
    // block costs an input and nothing more (ARCHITECTURE → the settlement's
    // marker inputs are derived, not serialized).
    //
    // ⚠ **The carry box is not priced here and is bounded rather than ignored.**
    // At most one input and one output per credited author, which the marker
    // terms already over-count against — an author with `k` likes reserves `k`
    // inputs and needs `k + 1`, and the sizer has the last word either way.
    else if (out.boxType === 'like_accrual') bytes += INPUT_BYTES;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Reading a body
// ---------------------------------------------------------------------------

/**
 * The fee boxes and bonds one transaction's materialized outputs contribute.
 *
 * ⛔ **A sum over boxes, resolving no inputs** (MINING_INTERFACE → Coinbase
 * Application). Every fee in the block is written down in it, so the total is a
 * property of the body's own bytes — which is what makes the producer's
 * prediction and the applier's walk the same arithmetic rather than two walks
 * that must agree.
 */
export function contributeToBody(body: SettlementBody, outputs: AnyBox[]): void {
  for (const out of outputs) {
    if (out.boxType === 'fee') {
      body.fees += out.value;
      body.feeBoxIds.push(out.id!);
    } else if (out.boxType === 'bond') {
      body.invitees.push((out as BondBox).inviteePublicKey);
    } else if (out.boxType === 'like_accrual') {
      // ⛔ **Only a like transaction can put one here**, and the engine's
      // biconditional is what makes that true in both directions: `likeTarget`
      // present ⟺ exactly one marker of `LIKE_KARMA_COST` naming the target's
      // author (NODE_INTERFACE → Karma transition rules). Without the converse
      // an ordinary karma transfer could emit a marker, balance, and be paid out
      // here — so this loop's correctness is the engine's, not its own.
      const marker = out as LikeAccrualBox;
      body.markers.push({ id: marker.id!, author: marker.author, value: marker.value });
    }
  }
}

/** A body with nothing in it yet. */
export function emptyBody(): SettlementBody {
  return { fees: 0n, actors: 0, feeBoxIds: [], invitees: [], markers: [], prunes: [] };
}

/**
 * The invitee of a bond this transaction creates, or null.
 *
 * ⛔ **At most one bond per transaction** — the invite arm pins it
 * (NODE_INTERFACE → Legal box transitions), which is what lets block
 * application's duplicate-invitee rule key on one value per transaction.
 */
export function bondInviteeOf(outputs: AnyBox[]): Uint8Array | null {
  for (const out of outputs) {
    if (out.boxType === 'bond') return (out as BondBox).inviteePublicKey;
  }
  return null;
}
