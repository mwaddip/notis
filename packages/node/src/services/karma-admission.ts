import { karmaOwed } from '@dagsocial/consensus';
import type { DecayCfg } from '@dagsocial/types';
import {
  getKarmaValue as storeKarmaValue,
  getIdentityRecord,
  pendingKarmaSpend,
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
