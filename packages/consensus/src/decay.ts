import {
  bytesToHex,
  effectiveKarma,
  isIdentityStale,
  owedPeriods,
} from '@dagsocial/types';
import type { AnyBox, DecayCfg, IdentityRecord, KarmaBox } from '@dagsocial/types';
import type { StateView } from './state-view.js';

// The valuation — `effectiveKarma`, `isIdentityStale`, `owedPeriods`, `DecayCfg`
// — is `@dagsocial/types`' (TYPES_INTERFACE → Identity record and karma
// valuation). `decay.ts` keeps the execution: `collectPostBodyKarma`,
// `deriveKarmaDecay` and `commitDecayClocks` below.

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
 * ⚠ The trigger is touch: the squaring fires per identity when the block
 * body consumes their boxes. There is no per-block walk.
 */
export interface DecayPlan {
  owner: Uint8Array;
  /** Every karma box the owner holds — the settlement's inputs for this leg. */
  consumedBoxIds: string[];
  /** What the owner is left holding. */
  newValue: bigint;
  /** What returns to the pool. */
  burnAmount: bigint;
}

/**
 * Post-body karma projection for each identity the block's body touches.
 *
 * ⛔ **The plan must name boxes the settlement can consume — post-body, not
 * pre-body.** A touched identity had a body tx consume one of its pre-body
 * karma boxes, so naming pre-body boxes in the plan double-spends. The
 * projection removes consumed boxes and adds the body's karma change outputs.
 *
 * The identity record is not projected: `deriveKarmaDecay` reads it before the
 * body applies, so producer and applier read the same pre-body record
 * (NODE_INTERFACE → A derived quantity has TWO kinds of input).
 *
 * Both the creator and the applier call this with the same decoded txs over
 * the same pre-body state, so both derive the same post-body set.
 *
 * ⛔ **Order is a consensus obligation.** Entries are sorted ascending by
 * owner hex; `deriveKarmaDecay` emits plans in that order.
 */
export function collectPostBodyKarma(
  view: Pick<StateView, 'getBox' | 'getKarmaBoxes'>,
  decodedTxs: { txId: string; inputs: string[]; outputs: AnyBox[] }[],
): Map<string, { owner: Uint8Array; boxes: KarmaBox[] }> {
  const allInputIds = new Set<string>();
  for (const tx of decodedTxs) {
    for (const id of tx.inputs) allInputIds.add(id);
  }

  const touchedOwnerHexes = new Set<string>();
  const touchedOwners = new Map<string, Uint8Array>();

  for (const id of allInputIds) {
    const box = view.getBox(id);
    if (box?.boxType === 'karma') {
      const hex = bytesToHex((box as KarmaBox).owner);
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
        const hex = bytesToHex(k.owner);
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
    const preBody = view.getKarmaBoxes(touchedOwners.get(hex)!);
    const surviving = preBody.filter((b) => b.id && !allInputIds.has(b.id));
    const produced = (bodyKarmaOutputs.get(hex) ?? []).filter(
      (b) => b.id && !allInputIds.has(b.id),
    );
    result.set(hex, { owner: touchedOwners.get(hex)!, boxes: [...surviving, ...produced] });
  }
  return result;
}

/**
 * Derive the decay owed by each TOUCHED identity at `currentHeight`.
 *
 * ⛔ **Pure with respect to the ledger: it reads and returns, and writes
 * nothing.** The settlement emits its boxes and `commitDecayClocks` advances the
 * clocks, so a block whose settlement is refused has not moved a decay clock
 * either.
 *
 * `postBodyKarma` is the post-body karma projection — for each identity the
 * block's body touched, the karma boxes they hold AFTER the body's user
 * transactions but BEFORE the settlement. The caller provides entries in
 * ascending owner-hex order (ARCHITECTURE → Karma decay). The identity record
 * is read from pre-body state (user transactions do not write it).
 */
export function deriveKarmaDecay(
  deps: DecayDeps,
  postBodyKarma: Map<string, { owner: Uint8Array; boxes: KarmaBox[] }>,
  currentHeight: number,
  cfg: DecayCfg,
): DecayPlan[] {
  const plans: DecayPlan[] = [];

  for (const [, { owner, boxes }] of postBodyKarma) {
    if (boxes.length === 0) continue;

    const record = deps.getIdentityRecord(owner);

    if (!isIdentityStale(record, currentHeight, cfg.staleThresholdBlocks)) {
      continue;
    }

    const periods = owedPeriods(record, currentHeight, cfg.decayIntervalBlocks);
    if (periods <= 0) continue;

    const faceTotal = boxes.reduce((sum, b) => sum + b.value, 0n);
    const effective = effectiveKarma(faceTotal, record, currentHeight, cfg);
    const burnAmount = faceTotal - effective;
    if (burnAmount <= 0n) continue;

    plans.push({
      owner,
      consumedBoxIds: boxes.filter((b) => b.id).map((b) => b.id!),
      newValue: effective,
      burnAmount,
    });
  }

  return plans;
}

/**
 * Advance the decay half of the clock for every identity the settlement charged.
 *
 * Written **after** the settlement's boxes are in, so the journal's reverse
 * replay undoes the record before deleting the box that caused it. Only firings
 * reach here — a stale identity sitting at the karma floor produces no plan and
 * keeps its clock where it was, rather than silently forfeiting the intervals it
 * is owed.
 *
 * `lastActivityBlock` is carried through unchanged: the decay-burn box the
 * settlement emitted is deliberately *not* activity, and resetting the activity
 * half here would make an identity look freshly active every time it was
 * charged. `invitedAtBlock` the same — block application's grant path owns it,
 * and a decay that reset it would both un-bar the address and move the paired
 * bond's settlement deadline. `lifetimeLikesReceived` too: it is monotonic, and
 * a decay that reset it would forfeit a bond the invitee had earned.
 */
export function commitDecayClocks(
  deps: DecayDeps,
  plans: DecayPlan[],
  currentHeight: number,
): void {
  for (const plan of plans) {
    const record = deps.getIdentityRecord(plan.owner);
    deps.putIdentityRecord(plan.owner, {
      lastActivityBlock: record?.lastActivityBlock ?? 0,
      lastDecayBlock: currentHeight,
      invitedAtBlock: record?.invitedAtBlock ?? 0,
      lifetimeLikesReceived: record?.lifetimeLikesReceived ?? 0n,
      memberSinceBlock: record?.memberSinceBlock ?? 0,
      memberBar: record?.memberBar ?? 0,
      memberVouches: record?.memberVouches ?? 0,
      memberLikes: record?.memberLikes ?? 0n,
      invitesUsed: record?.invitesUsed ?? 0,
    });
  }
}
