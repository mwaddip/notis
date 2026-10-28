import {
  EMPTY_IDENTITY_RECORD,
  bytesToHex,
  decaySettledThrough,
  effectiveKarma,
  owedPeriods,
} from '@dagsocial/types';
import type { AnyBox, DecayCfg, IdentityRecord, KarmaBox } from '@dagsocial/types';
import type { StateView } from './state-view.js';

// The valuation — `effectiveKarma`, `owedPeriods`, `decaySettledThrough`,
// `DecayCfg` — is `@dagsocial/types`' (TYPES_INTERFACE → Identity record and
// karma valuation). The execution is `karmaOwed`, `collectPostBodyKarma`,
// `deriveKarmaDecay` and `commitDecayClocks` below.

/**
 * The decay an owner owes at `height` — face less effective karma, over the
 * valuation `@dagsocial/types` holds (NODE_INTERFACE → Karma transition rules →
 * "Engine inputs the rule needs"). The one implementation of the
 * formula: `applyBlock`'s pre-body capture reads it, and the node's admission
 * reads it over the confirmed set.
 */
export function karmaOwed(
  face: bigint,
  record: IdentityRecord | null,
  height: number,
  cfg: DecayCfg,
): bigint {
  return face - effectiveKarma(face, record, height, cfg);
}

// ---------------------------------------------------------------------------
// Decay execution
// ---------------------------------------------------------------------------

export interface DecayDeps {
  /** The identity's decay clock, or null if it has never held karma. */
  getIdentityRecord: (identityId: Uint8Array) => IdentityRecord | null;
  /** Write the clock back. */
  putIdentityRecord: (identityId: Uint8Array, record: IdentityRecord) => void;
}

/**
 * One identity's decay, as a plan rather than as a mutation.
 *
 * ⛔ **Decay moves no boxes any more.** Its burn's sink is the karma supply
 * pool, and the pool is spent by the block's settlement transaction and by
 * nothing else (NODE_INTERFACE → The settlement transaction) — so the boxes
 * this describes are consumed and re-emitted there, in one operation that names
 * both ends. Charging an owner here and crediting the pool later would be a burn
 * and a mint separated by steps, which `ARCHITECTURE → The conservation axiom`
 * forbids by name.
 *
 * ⚠ The trigger is touch or payment (NODE_INTERFACE → Karma decay → "A block
 * squares every identity it touches or pays"): the squaring fires per identity
 * when the block body consumes their boxes or the income leg pays them. There
 * is no per-block walk.
 *
 * `settledThrough` is `decaySettledThrough(record, h, cfg)` on the pre-body
 * record — the height a squaring at `h` writes as `lastDecayBlock`
 * (NODE_INTERFACE → Karma decay → "A squaring writes the height it settles
 * through, never its own height"). Carried on the plan so `commitDecayClocks`
 * does not read the record a second time after the body applied: an owner who
 * posts in the block has `lastActivityBlock = h` by then, and a clock derived
 * from that post-apply record would start one window later.
 */
export interface DecayPlan {
  owner: Uint8Array;
  /** Every karma box the owner holds — the settlement's inputs for this leg. */
  consumedBoxIds: string[];
  /** What the owner is left holding. */
  newValue: bigint;
  /** What returns to the pool. */
  burnAmount: bigint;
  /** The height the squaring settles through, from the pre-body record. */
  settledThrough: number;
}

/**
 * Post-body karma projection for every identity in the block's squared set:
 * the owners the body touches and the owners the income leg pays
 * (NODE_INTERFACE → Karma decay → "A block squares every identity it touches
 * or pays"). A touched owner carries the body's post-body karma
 * projection — surviving pre-body boxes less the body's own inputs, plus the
 * body's new karma outputs for them. A payee the body does not touch keeps
 * its pre-body karma boxes as read from the view.
 *
 * ⛔ **The plan must name boxes the settlement can consume — post-body, not
 * pre-body.** A touched identity had a body tx consume one of its pre-body
 * karma boxes, so naming pre-body boxes in the plan double-spends. The
 * projection removes consumed boxes and adds the body's karma change outputs.
 *
 * The identity record is not projected: `deriveKarmaDecay` reads it before
 * the body applies, so producer and applier read the same pre-body record
 * (NODE_INTERFACE → A derived quantity has TWO kinds of input).
 *
 * Both the creator and the applier call this with the same decoded txs and
 * the same `payees` map over the same pre-body state, so both derive the
 * same squared set.
 *
 * ⛔ **Order is a consensus obligation.** Entries are sorted ascending by
 * owner hex; `deriveKarmaDecay` emits plans in that order.
 */
export function collectPostBodyKarma(
  view: Pick<StateView, 'getBox' | 'getKarmaBoxes'>,
  decodedTxs: { txId: string; inputs: string[]; outputs: AnyBox[] }[],
  payees: ReadonlyMap<string, Uint8Array> = new Map(),
): Map<string, { owner: Uint8Array; boxes: KarmaBox[] }> {
  const allInputIds = new Set<string>();
  for (const tx of decodedTxs) {
    for (const id of tx.inputs) allInputIds.add(id);
  }

  const touchedOwnerHexes = new Set<string>();
  const owners = new Map<string, Uint8Array>();

  for (const id of allInputIds) {
    const box = view.getBox(id);
    if (box?.boxType === 'karma') {
      const hex = bytesToHex((box as KarmaBox).owner);
      if (!touchedOwnerHexes.has(hex)) {
        touchedOwnerHexes.add(hex);
        owners.set(hex, (box as KarmaBox).owner);
      }
    }
  }
  for (const [hex, owner] of payees) {
    if (!owners.has(hex)) owners.set(hex, owner);
  }

  const bodyKarmaOutputs = new Map<string, KarmaBox[]>();
  for (const tx of decodedTxs) {
    for (const out of tx.outputs) {
      if (out.boxType === 'karma') {
        const k = out as KarmaBox;
        const hex = bytesToHex(k.owner);
        if (touchedOwnerHexes.has(hex)) {
          let arr = bodyKarmaOutputs.get(hex);
          if (!arr) { arr = []; bodyKarmaOutputs.set(hex, arr); }
          arr.push(k);
        }
      }
    }
  }

  const sorted = [...owners.keys()].sort();
  const result = new Map<string, { owner: Uint8Array; boxes: KarmaBox[] }>();
  for (const hex of sorted) {
    const owner = owners.get(hex)!;
    const preBody = view.getKarmaBoxes(owner);
    let boxes: KarmaBox[];
    if (touchedOwnerHexes.has(hex)) {
      const surviving = preBody.filter((b) => b.id && !allInputIds.has(b.id));
      const produced = (bodyKarmaOutputs.get(hex) ?? []).filter(
        (b) => b.id && !allInputIds.has(b.id),
      );
      boxes = [...surviving, ...produced];
    } else {
      // A payee the body does not touch keeps its pre-body boxes.
      boxes = preBody;
    }
    result.set(hex, { owner, boxes });
  }
  return result;
}

/**
 * Derive the decay owed by every identity in the block's squared set at
 * `currentHeight` (NODE_INTERFACE → Karma decay → "A block squares every
 * identity it touches or pays").
 *
 * ⛔ **Pure with respect to the ledger: it reads and returns, and writes
 * nothing.** The settlement emits its boxes and `commitDecayClocks` writes
 * the clocks, so a block whose settlement is refused has not moved a decay
 * clock either.
 *
 * `postBodyKarma` is the squared set's post-body karma projection — a touched
 * owner holds the boxes they are left with after the body's user
 * transactions, a payee the body does not touch holds their pre-body boxes
 * (`collectPostBodyKarma`). The caller provides entries in ascending
 * owner-hex order. The identity record is read from pre-body state (user
 * transactions do not write it).
 *
 * A plan exists for every owner whose `owedPeriods(record, h, cfg) > 0`.
 * Where the burn is positive the plan names the post-body boxes as inputs
 * and `effective` as its newValue. Where the burn is zero the plan is a
 * clock write and no leg: `consumedBoxIds` is empty, no karma output is
 * emitted, and `newValue` is the face the plan did not touch (NODE_INTERFACE
 * → Karma decay → "The floor forgives what it stops").
 */
export function deriveKarmaDecay(
  deps: DecayDeps,
  postBodyKarma: Map<string, { owner: Uint8Array; boxes: KarmaBox[] }>,
  currentHeight: number,
  cfg: DecayCfg,
): DecayPlan[] {
  const plans: DecayPlan[] = [];

  for (const [, { owner, boxes }] of postBodyKarma) {
    const record = deps.getIdentityRecord(owner);
    const periods = owedPeriods(record, currentHeight, cfg);
    if (periods <= 0) continue;

    const faceTotal = boxes.reduce((sum, b) => sum + b.value, 0n);
    const effective = effectiveKarma(faceTotal, record, currentHeight, cfg);
    const burnAmount = faceTotal - effective;
    const settledThrough = decaySettledThrough(record, currentHeight, cfg);

    if (burnAmount > 0n) {
      plans.push({
        owner,
        consumedBoxIds: boxes.filter((b) => b.id).map((b) => b.id!),
        newValue: effective,
        burnAmount,
        settledThrough,
      });
    } else {
      // Zero burn — a clock write and no leg. `consumedBoxIds` empty keeps
      // the settlement's decay leg from naming any of the owner's boxes;
      // `newValue` records the face the plan did not touch.
      plans.push({
        owner,
        consumedBoxIds: [],
        newValue: faceTotal,
        burnAmount: 0n,
        settledThrough,
      });
    }
  }

  return plans;
}

/**
 * Advance the decay half of the clock for every identity the squared set
 * includes at this height.
 *
 * Written **after** the settlement's boxes are in, so the journal's reverse
 * replay undoes the record before deleting the box that caused it. Every
 * plan writes its clock — a zero-burn plan included: the periods the floor
 * stopped are settled, never carried (NODE_INTERFACE → Karma decay → "The
 * floor forgives what it stops").
 *
 * Writes `plan.settledThrough` as `lastDecayBlock` (NODE_INTERFACE → Karma
 * decay → "A squaring writes the height it settles through, never its own
 * height"). The record read at commit carries every other field — the
 * activity clock bumped by a post earlier in the block, the like counters,
 * the membership state — and `lastDecayBlock` writes over whatever the
 * record carries for it. `invitedAtBlock` and `lifetimeLikesReceived` are
 * among those carried fields, so a decay-burn box the settlement emitted
 * does not un-bar the address or forfeit a bond the invitee had earned.
 */
export function commitDecayClocks(
  deps: DecayDeps,
  plans: DecayPlan[],
): void {
  for (const plan of plans) {
    const record = deps.getIdentityRecord(plan.owner);
    deps.putIdentityRecord(plan.owner, {
      ...(record ?? EMPTY_IDENTITY_RECORD),
      lastDecayBlock: plan.settledThrough,
    });
  }
}
