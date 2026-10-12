import { karmaOwed } from '@dagsocial/consensus';
import type { DecayCfg } from '@dagsocial/types';
import {
  getKarmaValue as storeKarmaValue,
  getKarmaBoxes,
  getIdentityRecord,
  pendingKarmaSpend,
  getOwnKarmaBoxIdsWithPending,
} from '../store/index.js';

/**
 * The admission's `held` reader: the owner's confirmed karma sum less what the
 * pool's karma transactions have already spent of it (NODE_INTERFACE → Karma
 * transition rules → "Engine inputs the rule needs"; MEMPOOL_INTERFACE →
 * Correctness gates → "`pendingKarmaSpend` is an input of `validateTx`, not a
 * gate a path can skip"). The admission paths wire this as the engine's
 * `getKarmaValue`, so a karma spend admitted now is judged against the owner's
 * karma as the pool's entries ahead of it leave it.
 */
export function admissionHeld(owner: Uint8Array): bigint {
  return storeKarmaValue(owner) - pendingKarmaSpend(Buffer.from(owner).toString('hex'));
}

/**
 * The admission's `getKarmaOwed` reader: `karmaOwed(face, record, height,
 * decayCfg)` over the confirmed state at the judged-for height (NODE_INTERFACE
 * → Karma transition rules → "Engine inputs the rule needs"). `face` is the
 * confirmed sum — not `held` — because `karmaOwed` is the one implementation of
 * `face − effectiveKarma(face, record, height, decayCfg)` and the pool's
 * pending spends are not what the identity owes to decay.
 */
export function admissionOwed(
  decayCfg: DecayCfg,
): (owner: Uint8Array, height: number) => bigint {
  return (owner, height) =>
    karmaOwed(storeKarmaValue(owner), getIdentityRecord(owner), height, decayCfg);
}

/**
 * The HTTP routes' `getOwnKarmaBoxIds`: rule 3 of NODE_INTERFACE → Karma
 * transition rules → "An identity holds at most two karma boxes", under the
 * pending view the pool keeps. One implementation beside `admissionHeld`;
 * the HTTP deps wire it as the engine's `getOwnKarmaBoxIds`.
 */
export function admissionGetOwnKarmaBoxIds(owner: Uint8Array): string[] {
  return getOwnKarmaBoxIdsWithPending(Buffer.from(owner).toString('hex'));
}

/**
 * The relay's `getOwnKarmaBoxIds`: rule 3 over the confirmed set alone, as
 * `handleRelayedTx` resolves inputs (NODE_INTERFACE → Karma transition rules
 * → "`getOwnKarmaBoxIds(owner)` answers rule 3"). The pending view is
 * admission's; a block the relay carries resolves against the confirmed
 * state as the gossip handler does.
 */
export function relayGetOwnKarmaBoxIds(owner: Uint8Array): string[] {
  const ids: string[] = [];
  for (const box of getKarmaBoxes(owner)) {
    if (box.income === true) continue;
    if (box.id !== undefined) ids.push(box.id);
  }
  return ids;
}
