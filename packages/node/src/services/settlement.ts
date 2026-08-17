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
 * `ORDER BY id LIMIT 1` (NODE_INTERFACE → Determinism is this mechanism's whole
 * risk, which admits exactly three ordering sources).
 *
 * ## ⛔ What a verifier derives, and what it reads
 *
 * **The verifier derives every quantity and checks the producer's against it**;
 * it does not re-derive the whole transaction and compare ids. Two things in a
 * settlement are the producer's and are not in the body: **which key the miner
 * pays their own slice to** (`GET /mining/template?miner=` is authenticated and
 * redirects the coinbase — MINING_INTERFACE → GET /mining/template) **and across
 * how many outputs**. Everything else — the input list, all three successors'
 * values, every grant's owner and amount, the credit total, the maturity lock —
 * is pinned here, and conservation is checked over the whole transaction
 * (MINING_INTERFACE → the receipt checks survive: *"refused by conservation
 * itself rather than by a separate successor check"*).
 *
 * ⚠ **Determinism is still this mechanism's whole risk, one level in.** What
 * must agree across nodes is the *derivation*: two honest nodes deriving
 * different input orders reject each other's blocks. That is why every ordering
 * above is one the block or a stated `ORDER BY` fixes.
 */

import {
  INVITE_KARMA_AMOUNT,
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
  TreasuryBox,
  UtxoTransaction,
} from '@dagsocial/types';
import { splitCoinbase } from './coinbase-split.js';

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
}

/** The protocol boxes the settlement moves, read through the store. */
export interface SettlementDeps {
  getEmissionBox: () => EmissionBox | null;
  getTreasuryBox: () => TreasuryBox | null;
  getKarmaPoolBox: () => KarmaPoolBox | null;
  /** Resolve a box the body created or the chain holds — the settlement's inputs. */
  getBox: (id: string) => AnyBox | null;
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
  /** The emission successor, absent when this height releases nothing or the box empties. */
  emissionSuccessor: AnyBoxCandidate | null;
  treasurySuccessor: AnyBoxCandidate | null;
  poolSuccessor: AnyBoxCandidate | null;
  /** One per bond the body created, in committed transaction order. */
  grants: AnyBoxCandidate[];
  /** What the coinbase's credit outputs must sum to. */
  minerSlice: bigint;
  /** The maturity lock every credit output must carry. */
  lockedUntilBlock: number;
}

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

  // ---- The emission box ----
  //
  // Touched only when this height releases. At and above the terminus there is
  // no box and nothing is spent, which is why its absence there is not a fault
  // (TYPES_INTERFACE → EmissionBox).
  let emissionSuccessor: AnyBoxCandidate | null = null;
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
    if (remaining > 0n) {
      emissionSuccessor = { boxType: 'emission', value: remaining };
    }
  }

  // ---- The treasury box ----
  //
  // Nothing accrues on a block whose treasury slice rounds to zero, so it does
  // not touch the box — the shape that holds above the terminus with no fees,
  // where the block touches neither. Genesis creates none: it would hold `0`.
  let treasurySuccessor: AnyBoxCandidate | null = null;
  if (split.treasury > 0n) {
    const box = deps.getTreasuryBox();
    if (box) {
      if (!box.id) return { error: 'treasury box carries no id' };
      inputs.push(box.id);
    }
    treasurySuccessor = {
      boxType: 'treasury',
      value: (box?.value ?? 0n) + split.treasury,
    };
  }

  // ---- The karma pool ----
  //
  // ⛔ **The grant is a POOL SPEND, not a creation** (ARCHITECTURE → The
  // conservation axiom). The bond IS the request: one bond, one grant, and the
  // pairing is structural, so no rule compares two lists and no box is invented
  // to carry it.
  let poolSuccessor: AnyBoxCandidate | null = null;
  const grants: AnyBoxCandidate[] = [];
  const granted = INVITE_KARMA_AMOUNT * BigInt(body.invitees.length);
  if (granted > 0n) {
    const box = deps.getKarmaPoolBox();
    if (!box || !box.id) {
      return {
        error:
          `height ${height} grants ${granted} karma but this chain holds no ` +
          `karma pool box`,
      };
    }
    if (box.value < granted) {
      return {
        error: `karma pool holds ${box.value}, short of the ${granted} this block grants`,
      };
    }
    inputs.push(box.id);
    // ⛔ A zero-value successor IS created, and this is the one place the
    // emission box's rule inverts: the pool never terminates, so burns must
    // always have somewhere to return (TYPES_INTERFACE → KarmaPoolBox).
    poolSuccessor = { boxType: 'karma_pool', value: box.value - granted };
    for (const invitee of body.invitees) {
      grants.push({ boxType: 'karma', value: INVITE_KARMA_AMOUNT, owner: invitee });
    }
  }

  // ---- The fee boxes ----
  //
  // Block application is their only spender and it runs once per block, so a fee
  // box surviving its block would hand its value to a later miner and break the
  // coinbase identity (MINING_INTERFACE → Coinbase Application). They are the
  // precedent the marker inputs generalise.
  for (const feeBoxId of body.feeBoxIds) inputs.push(feeBoxId);

  return {
    derived: {
      inputs,
      emissionSuccessor,
      treasurySuccessor,
      poolSuccessor,
      grants,
      minerSlice: split.miner,
      lockedUntilBlock: height + minerRewardDelay,
    },
  };
}

/**
 * Build the block's settlement transaction.
 *
 * ⛔ **Pure in everything but the three protocol-box reads**, which are
 * `ORDER BY id LIMIT 1` — no wall clock, no local table, no iteration order the
 * block does not already fix.
 *
 * `minerOwner` is the one parameter that is not derived: the coinbase's payout
 * key is the producer's and is committed in the settlement's own bytes rather
 * than recomputed by a verifier.
 *
 * Output order is fixed here so a producer's own two runs agree, but it is
 * **not** a consensus rule: `checkSettlement` matches outputs by content, since
 * how the miner partitions their slice is theirs.
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

  const outputs: AnyBoxCandidate[] = [];
  if (derived.emissionSuccessor) outputs.push(derived.emissionSuccessor);
  if (derived.treasurySuccessor) outputs.push(derived.treasurySuccessor);
  if (derived.poolSuccessor) outputs.push(derived.poolSuccessor);
  // Skipped at zero, because no coinbase output may carry a zero value: `[]` and
  // `[{value: 0}]` are two encodings of one block with different `utxoTxRoot`.
  if (derived.minerSlice > 0n) {
    const coinbase: AnyBoxCandidate = {
      boxType: 'credit',
      value: derived.minerSlice,
      owner: minerOwner,
      lockedUntilBlock: derived.lockedUntilBlock,
    };
    outputs.push(coinbase);
  }
  outputs.push(...derived.grants);

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

/** Match by content, never by position — the partition is the producer's. */
function takeOne(
  pool: AnyBoxCandidate[],
  match: (o: AnyBoxCandidate) => boolean,
): AnyBoxCandidate | undefined {
  const i = pool.findIndex(match);
  return i === -1 ? undefined : pool.splice(i, 1)[0];
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

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

  // ---- 3. The derived outputs ----
  const remaining = [...settlement.outputs];

  const pinOne = (
    expected: AnyBoxCandidate | null,
    boxType: AnyBoxCandidate['boxType'],
    what: string,
  ): string | null => {
    const present = remaining.filter((o) => o.boxType === boxType).length;
    if (expected === null) {
      return present === 0 ? null : `settlement emits a ${what} this block does not`;
    }
    if (present !== 1) {
      return `settlement emits ${present} ${what} boxes, expected exactly 1`;
    }
    const got = takeOne(remaining, (o) => o.boxType === boxType)!;
    if (got.value !== expected.value) {
      return `settlement ${what} holds ${got.value}, the body derives ${expected.value}`;
    }
    return null;
  };

  for (const [expected, boxType, what] of [
    [derived.emissionSuccessor, 'emission', 'emission successor'],
    [derived.treasurySuccessor, 'treasury', 'treasury successor'],
    [derived.poolSuccessor, 'karma_pool', 'karma pool successor'],
  ] as const) {
    const err = pinOne(expected, boxType, what);
    if (err) return { valid: false, error: err };
  }

  // ---- 4. The grants — one per bond, on the key the bond names ----
  //
  // Matched by owner rather than by position. Two bonds naming one key are
  // refused before this runs (block application's duplicate-invitee rule), so
  // every grant owner is distinct and the match is exact.
  for (const expected of derived.grants) {
    const owner = (expected as KarmaBox).owner;
    const got = takeOne(
      remaining,
      (o) => o.boxType === 'karma' && hex((o as KarmaBox).owner) === hex(owner),
    );
    if (!got) {
      return {
        valid: false,
        error: `settlement carries no invite grant for ${hex(owner)}`,
      };
    }
    if (got.value !== INVITE_KARMA_AMOUNT) {
      return {
        valid: false,
        error:
          `invite grant for ${hex(owner)} holds ${got.value}, expected ` +
          `${INVITE_KARMA_AMOUNT}`,
      };
    }
  }

  // ---- 5. The coinbase ----
  //
  // The sum is the rule; the partition and the payout key are the producer's
  // (MINING_INTERFACE → Coinbase Application, receipt step 2).
  let coinbaseTotal = 0n;
  for (const out of remaining) {
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

  // ---- 6. Conservation, over the whole transaction ----
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
    }
  }
}

/** A body with nothing in it yet. */
export function emptyBody(): SettlementBody {
  return { fees: 0n, actors: 0, feeBoxIds: [], invitees: [] };
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
