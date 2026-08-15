/**
 * The coinbase's split and the inclusion bonus curve
 * (MINING_INTERFACE → Coinbase Application).
 *
 * Pure arithmetic over bigints, so this suite needs no database and no block:
 * every rule here is a property of the numbers, and the block-level wiring —
 * which outputs get minted, and what the applier compares them against — is in
 * `block-apply.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  COINBASE_TREASURY_PCT,
  COINBASE_BONUS_PCT,
  INCLUSION_BONUS_K,
} from '@dagsocial/types';
import type {
  AnyBox,
  CreditBox,
  InviteBox,
  KarmaBox,
  UtxoTransaction,
  VouchBox,
} from '@dagsocial/types';
import { countKarmaActors, splitCoinbase } from '../../src/services/coinbase-split.js';
import { uid } from '../helpers.js';

const ALICE = uid('alice');
const BOB = uid('bob');
const VALIDATOR = uid('validator');
const MALLORY = uid('mallory');

function karmaBox(value: bigint, owner: Uint8Array): KarmaBox {
  return { boxType: 'karma', value, owner, guard: 'owner_signature' } as KarmaBox;
}

function creditBox(value: bigint, owner: Uint8Array): CreditBox {
  return { boxType: 'credit', value, owner, guard: 'owner_signature' } as CreditBox;
}

function vouchBox(voucherId: Uint8Array, targetId: Uint8Array): VouchBox {
  return {
    boxType: 'vouch', value: 1n, voucherId, targetId, guard: 'owner_signature',
  } as VouchBox;
}

function inviteBox(inviterId: Uint8Array, inviteePublicKey: Uint8Array): InviteBox {
  return {
    boxType: 'invite', value: 0n, inviterId, inviteePublicKey, guard: 'invite_dual',
  } as InviteBox;
}

/** A transaction shell — only `outputs` and `signatures` matter to the count. */
function tx(outputs: object[], signatures: Record<string, Uint8Array> = {}): UtxoTransaction {
  return { inputs: [], outputs, signatures, protocolVersion: 1 } as unknown as UtxoTransaction;
}

function entry(t: UtxoTransaction, inputBoxes: AnyBox[]) {
  return { tx: t, inputBoxes };
}

describe('splitCoinbase', () => {
  // The load-bearing one. `sum(coinbaseOutputs) === income` is exact at apply,
  // so any pair of truncated divisions that fails to add back to the income is
  // a base unit created or destroyed. The miner floor takes the remainder for
  // exactly this reason, and `unearned` is a subtraction rather than a second
  // division for the same one.
  it('sums to exactly the income, at every actor count and every income', () => {
    const incomes: [bigint, bigint][] = [
      [100n, 0n], [100n, 37n], [0n, 1n], [999_983n, 7n],
      [1n, 0n], [0n, 0n], [7n, 3n], [10n ** 18n, 999_999_999n],
    ];
    for (const actors of [0, 1, 3, 5, 7, 13, 99, 1000]) {
      for (const [emission, fees] of incomes) {
        const s = splitCoinbase(emission, fees, actors);
        expect(s.treasury + s.miner).toBe(emission + fees);
        // Neither slice may go negative — a negative miner floor would be the
        // treasury minting from the miner rather than dividing an income.
        expect(s.treasury).toBeGreaterThanOrEqual(0n);
        expect(s.miner).toBeGreaterThanOrEqual(0n);
      }
    }
  });

  it('forfeits the whole bonus pool at zero actors', () => {
    const s = splitCoinbase(1000n, 0n, 0);
    expect(s.treasury).toBe(50n + 250n);   // 5% per-term, plus the entire 25% pool
    expect(s.miner).toBe(700n);
  });

  it('earns the miner half the pool at K actors', () => {
    const s = splitCoinbase(1000n, 0n, Number(INCLUSION_BONUS_K));
    expect(s.treasury).toBe(50n + 125n);
    expect(s.miner).toBe(825n);
  });

  // Uncapped: marginal value falls as 1/n² but never reaches zero, so no actor
  // count is worth nothing to include. A fixed cap is what this replaces.
  it('never saturates — the next actor always pays the miner more', () => {
    let prev = splitCoinbase(1_000_000n, 0n, 0).miner;
    for (let a = 1; a <= 200; a++) {
      const cur = splitCoinbase(1_000_000n, 0n, a).miner;
      expect(cur).toBeGreaterThan(prev);
      prev = cur;
    }
  });

  // The treasury is taken per income TERM, never off the total, because storage
  // rent becomes a third term that does not fund it (MINING_INTERFACE → the
  // slice table). At 1000/200 both readings give 60 and the distinction is
  // invisible; these values are chosen so truncation separates them — 5% of 10
  // truncates to 0 twice, while 5% of 20 is 1.
  it('takes the treasury per term rather than off the total', () => {
    const s = splitCoinbase(10n, 10n, 0);
    const perTerm = (10n * BigInt(COINBASE_TREASURY_PCT)) / 100n * 2n;   // 0
    const offTotal = (20n * BigInt(COINBASE_TREASURY_PCT)) / 100n;       // 1
    expect(perTerm).not.toBe(offTotal);

    // treasury = per-term base (0) + the forfeited pool (20 × 25% = 5)
    expect(s.treasury).toBe(0n + 5n);
    expect(s.treasury).not.toBe(offTotal + 5n);
  });

  // Two independent truncations of one pool leak a base unit; `unearned` is
  // derived by subtracting `earned` from the pool so the pair is exact by
  // construction. Swept across counts where both divisions truncate.
  it('splits the bonus pool exactly — earned plus unearned is the whole pool', () => {
    for (const income of [1000n, 999_983n, 7n, 123_456_789n]) {
      const pool = (income * BigInt(COINBASE_BONUS_PCT)) / 100n;
      for (let a = 0; a <= 40; a++) {
        const withActors = splitCoinbase(income, 0n, a);
        const withNone = splitCoinbase(income, 0n, 0);
        // `unearned` is the treasury's share above its per-term base, and
        // `earned` is what the miner gained relative to forfeiting everything.
        const unearned = withActors.treasury - (withNone.treasury - pool);
        const earned = withActors.miner - withNone.miner;
        expect(earned + unearned).toBe(pool);
      }
    }
  });

  // ⚠ **AHEAD OF CODE, and reachable only by calling this function.** No block
  // reaches income 0 while `computeBlockReward` floors at `CREDIT_TAIL_REWARD`
  // — devnet's height 5,900 pays 2e8, not 0, and the first zero-reward height
  // is 5,901 under the emission termination that has not landed. So the rule
  // that no coinbase output may carry zero cannot be exercised through a block
  // at income 0; what CAN be exercised is that the split leaves nothing to pay,
  // which is what makes the empty output list the only legal encoding there.
  it('leaves nothing for either slice at zero income', () => {
    const s = splitCoinbase(0n, 0n, 0);
    expect(s.treasury).toBe(0n);
    expect(s.miner).toBe(0n);

    // And at every actor count, so the bonus curve cannot conjure a slice from
    // an empty pool — `0 × a / (a + K)` is 0, but the subtraction that derives
    // `unearned` is where a stray base unit would appear if it appeared.
    for (const actors of [0, 1, 5, 40, 1000]) {
      const t = splitCoinbase(0n, 0n, actors);
      expect(t.treasury + t.miner).toBe(0n);
      expect(t.treasury).toBe(0n);
      expect(t.miner).toBe(0n);
    }
  });

  it('gives the miner every remainder the divisions leave', () => {
    // Below 4 the bonus pool truncates to zero as well as the treasury base, so
    // every slice is empty and the whole income lands on the floor — the miner
    // is the only slice that can hold a remainder.
    const s = splitCoinbase(3n, 0n, 0);
    expect(s.treasury).toBe(0n);
    expect(s.miner).toBe(3n);

    // And at 7 the pool alone rounds up to 1, which the forfeit sends to the
    // treasury: the floor keeps the other 6 rather than the split losing it.
    const t = splitCoinbase(7n, 0n, 0);
    expect(t.treasury).toBe(1n);
    expect(t.miner).toBe(6n);
  });
});

describe('countKarmaActors', () => {
  // Signing is free, so a signature-keyed count is inflated by appending keys
  // that hold nothing. The actor is the owner of the box that was SPENT.
  it('counts the owner of a spent karma box, never a signature', () => {
    const t = tx([karmaBox(9n, ALICE)], {
      [Buffer.from(MALLORY).toString('hex')]: new Uint8Array(64),
      [Buffer.from(BOB).toString('hex')]: new Uint8Array(64),
    });
    expect(countKarmaActors([entry(t, [karmaBox(10n, ALICE)])], VALIDATOR)).toBe(1);
  });

  // Generalises the author ≠ validator rule: a validator cannot raise their own
  // bonus by including their own work.
  it('does not count the validator as their own actor', () => {
    const t = tx([karmaBox(9n, VALIDATOR)]);
    expect(countKarmaActors([entry(t, [karmaBox(10n, VALIDATOR)])], VALIDATOR)).toBe(0);
  });

  it('counts one actor once however many transactions they spend', () => {
    const a = entry(tx([karmaBox(9n, ALICE)]), [karmaBox(10n, ALICE)]);
    const b = entry(tx([karmaBox(8n, ALICE)]), [karmaBox(9n, ALICE)]);
    const c = entry(tx([karmaBox(7n, ALICE)]), [karmaBox(8n, ALICE)]);
    expect(countKarmaActors([a, b, c], VALIDATOR)).toBe(1);
  });

  it('counts distinct owners separately', () => {
    const a = entry(tx([karmaBox(9n, ALICE)]), [karmaBox(10n, ALICE)]);
    const b = entry(tx([karmaBox(9n, BOB)]), [karmaBox(10n, BOB)]);
    expect(countKarmaActors([a, b], VALIDATOR)).toBe(2);
  });

  // Credits are the other ledger: they pay a fee instead, and counting them
  // would pay the bonus twice for one transaction.
  it('counts no actor for a credit transfer', () => {
    const t = tx([creditBox(900n, BOB)]);
    expect(countKarmaActors([entry(t, [creditBox(1000n, ALICE)])], VALIDATOR)).toBe(0);
  });

  // A VouchBox names its voucher, and casting it cost karma.
  it('counts the voucher for an unvouch', () => {
    const t = tx([]);
    expect(countKarmaActors([entry(t, [vouchBox(ALICE, BOB)])], VALIDATOR)).toBe(1);
  });

  // The two invite shapes have different actors, and the discriminant is the
  // output list: a cancel spends to nothing and belongs to the inviter, a claim
  // mints to the key the box names and belongs to the invitee.
  it('counts the inviter for a cancel and the invitee for a claim', () => {
    const cancel = entry(tx([]), [inviteBox(ALICE, BOB)]);
    expect(countKarmaActors([cancel], VALIDATOR)).toBe(1);

    const claim = entry(tx([karmaBox(25n, BOB)]), [inviteBox(ALICE, BOB)]);
    // Same box, different shape — so if the discriminant were ignored, these
    // two would collapse to one actor instead of naming two different people.
    expect(countKarmaActors([cancel, claim], VALIDATOR)).toBe(2);
  });

  it('counts nothing for a transaction with no inputs resolved', () => {
    expect(countKarmaActors([entry(tx([karmaBox(9n, ALICE)]), [])], VALIDATOR)).toBe(0);
  });

  it('counts nothing in an empty block', () => {
    expect(countKarmaActors([], VALIDATOR)).toBe(0);
  });
});
