import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fixtureProvenance, uid } from '../helpers.js';
import {
  INVITE_KARMA_AMOUNT,
  LIKE_KARMA_COST,
  VOUCH_KARMA_AMOUNT,
} from '@dagsocial/types';
import type { AnyBox } from '@dagsocial/types';

/**
 * The karma supply accounting at the box mutation choke point.
 *
 * `insertBox` and `consumeBox` are the only writers of the live UTXO set, so
 * accounting the karma supply there sees every change to it, whatever produced
 * one. These pin the two properties that rests on: which box types count, and
 * that the running total is the net of everything the block has done so far.
 *
 * ⛔ **The delta measures CIRCULATION, and while nothing names the pool that is
 * the same thing as compliance with the conservation axiom** (ARCHITECTURE → The
 * conservation axiom). Every operation is a transfer, so karma leaving a box must
 * enter another in the same operation; no box outside the supply set can receive
 * it today, so any nonzero delta here is a unit called into being or ended.
 *
 * ⛔ **THE TWO STOP COINCIDING THE MOMENT THE POOL IS NAMEABLE, AND A READER WHO
 * MISSES THAT WILL READ EVERY WITNESS BELOW BACKWARDS.** A like burn that moves
 * its karma to the pool by name is a legitimate transfer and **still accrues
 * `−LIKE_KARMA_COST` here**, because `karma_pool` is deliberately outside the
 * supply set — measured, not reasoned. The axiom's own measure is the sum over
 * circulating karma **and** the pool, which is a third question with a third
 * answer: `karma_pool` is not karma that exists, and is exactly what the total
 * that never changes is made of.
 *
 * ⛔ **A NONZERO DELTA IS THE DEFECT, NOT A FIGURE TO RECONCILE.** Removing value
 * at one point and restoring it later — end of block, end of transaction,
 * anywhere — leaves an instant at which the unit did not exist, which the axiom
 * forbids in the same breath as the burn itself. Nothing here settles a net.
 */

// ---------------------------------------------------------------------------
// Fresh-module helpers — the journal and the store both hold module state
// ---------------------------------------------------------------------------

async function freshStore() {
  const db = await import('../../src/store/db.js');
  const utxo = await import('../../src/store/utxo.js');
  const journal = await import('../../src/store/journal.js');
  db.initDb(':memory:');
  return { ...utxo, ...journal };
}

const OWNER = uid('supply-owner');
const OTHER = uid('supply-other');

/** A box of every type, each carrying a value the assertions can tell apart. */
function boxOfType(boxType: AnyBox['boxType'], value: bigint): AnyBox {
  const base = { boxType, value } as Record<string, unknown>;
  switch (boxType) {
    case 'karma':
    case 'credit':
      base['owner'] = OWNER;
      break;
    case 'bond':
      base['inviterId'] = OWNER;
      base['inviteePublicKey'] = OTHER;
      break;
    case 'post_lock':
      base['owner'] = OWNER;
      base['originalValue'] = value;
      break;
    case 'vouch':
      base['voucherId'] = OWNER;
      base['targetId'] = OTHER;
      break;
    case 'genesis_proof':
      base['payload'] = new Uint8Array([1, 2, 3]);
      break;
    // `emission`, `treasury`, `fee` and `karma_pool` have no owner and no
    // per-type fields — the shared prefix is the whole box.
    default:
      break;
  }
  const box = { ...base, ...fixtureProvenance(base, 1) } as unknown as AnyBox;
  box.id = `${boxType}-${value}`;
  return box;
}

/**
 * Every box type, and whether its value is karma in circulation.
 *
 * `Record<AnyBox['boxType'], boolean>` rather than a list of the true ones: a
 * new box type is then a **compile error here**, which is the shape the
 * membership rule asks for — *may a karma spend create it?*, *does its value
 * count as karma that exists?* and *does it belong to the total that never
 * changes?* are asked separately, and the answers may differ (NODE_INTERFACE →
 * "Three karma sets, and none derives from another").
 *
 * ⛔ **This table answers the SECOND question only.** `karma_pool` is `false`
 * here and `true` in the conservation set, which is the one type that makes the
 * distinction more than bookkeeping.
 */
const COUNTS_AS_CIRCULATING: Record<AnyBox['boxType'], boolean> = {
  karma: true,
  bond: true,
  post_lock: true,
  vouch: true,
  credit: false,
  emission: false,
  treasury: false,
  fee: false,
  genesis_proof: false,
  // ⛔ Karma-bearing and still `false`. The pool holds what is NOT in
  // circulation, so counting it would have the supply account for itself.
  karma_pool: false,
  // ⚠ Karma-bearing by their type definitions and `false` because no transition
  // emits either yet, so neither can hold karma. The unit that first emits one
  // adds it to the supply set (TYPES_INTERFACE → LikeAccrualBox /
  // VouchEscrowBox).
  like_accrual: false,
  vouch_escrow: false,
};

describe('the karma supply is accounted at the box mutation choke point', () => {
  beforeEach(async () => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
  });

  // ⚠ **`like_accrual` and `vouch_escrow` are answered by the predicate alone.**
  // Nothing creates either yet, so the store carries no row mapping for them and
  // there is no choke-point behaviour to measure — the unit that first emits one
  // adds both together (TYPES_INTERFACE → LikeAccrualBox / VouchEscrowBox).
  const UNPRODUCED: ReadonlySet<string> = new Set(['like_accrual', 'vouch_escrow']);

  for (const [boxType, counts] of Object.entries(COUNTS_AS_CIRCULATING)) {
    if (UNPRODUCED.has(boxType)) {
      it(`'${boxType}': the supply set ${counts ? 'admits' : 'excludes'} it`, async () => {
        const { countsAsCirculatingKarma } = await import('../../src/karma-supply.js');
        expect(countsAsCirculatingKarma(boxType as AnyBox['boxType'])).toBe(counts);
      });
      continue;
    }

    it(`'${boxType}': inserting one ${counts ? 'raises' : 'leaves'} circulating karma`, async () => {
      const s = await freshStore();
      s.beginBlockJournal(1);
      s.insertBox(boxOfType(boxType as AnyBox['boxType'], 70n));
      expect(s.openBlockJournalKarmaSupplyDelta()).toBe(counts ? 70n : 0n);
    });

    it(`'${boxType}': consuming one ${counts ? 'lowers' : 'leaves'} circulating karma`, async () => {
      const s = await freshStore();
      const box = boxOfType(boxType as AnyBox['boxType'], 70n);
      // Seeded before the journal opens, so the insert is not in the total the
      // consume is measured against.
      s.insertBox(box);
      s.beginBlockJournal(1);
      s.consumeBox(box.id!, 1);
      expect(s.openBlockJournalKarmaSupplyDelta()).toBe(counts ? -70n : 0n);
    });
  }

  it('the delta is the running net, not the last mutation', async () => {
    const s = await freshStore();
    const seeded = boxOfType('karma', 100n);
    s.insertBox(seeded);

    s.beginBlockJournal(1);
    s.consumeBox(seeded.id!, 1);
    s.insertBox(boxOfType('karma', 130n));
    s.insertBox(boxOfType('bond', 25n));
    expect(s.openBlockJournalKarmaSupplyDelta()).toBe(55n);
  });

  // -------------------------------------------------------------------------
  // Four transaction shapes, measured against the axiom. Each is the box
  // arithmetic a real transaction performs.
  //
  // ⚠ **The three VIOLATION cases assert a defect, deliberately.** The axiom is
  // `AHEAD OF CODE`, so these shapes are what the tree does and what it must
  // stop doing; pinning the exact amount each one conjures or destroys is what
  // makes the gap measurable instead of asserted.
  //
  // ⚠ **They witness the tree AS IT STANDS, where no box outside the supply set
  // can receive karma.** Giving one of them a pool sink does NOT turn it green —
  // the delta would be unchanged, because the pool sits outside this set on
  // purpose. What retires a witness is the shape gaining a source and a sink
  // *and* this file gaining the conservation total to measure them against.
  // -------------------------------------------------------------------------

  it('a conserving karma move satisfies the axiom: nothing appears, nothing vanishes', async () => {
    const s = await freshStore();
    const spent = boxOfType('karma', 40n);
    s.insertBox(spent);

    s.beginBlockJournal(1);
    s.consumeBox(spent.id!, 1);
    s.insertBox(boxOfType('karma', 15n));
    s.insertBox(boxOfType('post_lock', 25n));
    expect(s.openBlockJournalKarmaSupplyDelta()).toBe(0n);
  });

  it('⚠ VIOLATION: a like burn destroys LIKE_KARMA_COST and names no sink', async () => {
    const s = await freshStore();
    const spent = boxOfType('karma', 40n);
    s.insertBox(spent);

    s.beginBlockJournal(1);
    s.consumeBox(spent.id!, 1);
    s.insertBox(boxOfType('karma', 40n - LIKE_KARMA_COST));
    expect(s.openBlockJournalKarmaSupplyDelta()).toBe(-LIKE_KARMA_COST);
  });

  it('an invite grant draws INVITE_KARMA_AMOUNT from the pool and names it', async () => {
    // ⛔ **THE CASE THIS FILE'S HEADER PREDICTED, AND IT IS NOW LIVE.** The
    // settlement spends the pool to the invitee, so the delta below is a
    // CIRCULATION change with a named source, not a unit called into being
    // (ARCHITECTURE → The conservation axiom). `karma_pool` sits outside the
    // supply set deliberately, which is why a legitimate transfer still moves
    // this number — a reader who takes a nonzero delta here as the defect will
    // read it backwards.
    const s = await freshStore();
    const pool = boxOfType('karma_pool', 1000n);
    s.insertBox(pool);

    s.beginBlockJournal(1);
    s.consumeBox(pool.id!, 1);
    s.insertBox(boxOfType('karma_pool', 1000n - INVITE_KARMA_AMOUNT));
    s.insertBox(boxOfType('karma', INVITE_KARMA_AMOUNT));

    // Circulation grew by the grant …
    expect(s.openBlockJournalKarmaSupplyDelta()).toBe(INVITE_KARMA_AMOUNT);
    // … and the pool fell by exactly the same amount, which is the half the
    // supply delta cannot see and the half the axiom is about.
    const poolAfter = s.getKarmaPoolBox();
    expect(poolAfter!.value).toBe(1000n - INVITE_KARMA_AMOUNT);
  });

  it('⚠ VIOLATION: a bond forfeit ends karma and names no sink', async () => {
    // The remainder a bond forfeits at its probation deadline is destroyed by
    // the ABSENCE of a mint (`processMaturedBonds`), which leaves no box holding
    // it. C3b routes it back to the pool; until then this witness stands.
    const s = await freshStore();
    const bond = boxOfType('bond', 40n);
    s.insertBox(bond);

    s.beginBlockJournal(1);
    s.consumeBox(bond.id!, 1);
    s.insertBox(boxOfType('karma', 10n));
    expect(s.openBlockJournalKarmaSupplyDelta()).toBe(-30n);
  });

  it('⚠ VIOLATION: an unvouch moves the stake to a sink no box names', async () => {
    const s = await freshStore();
    const vouch = boxOfType('vouch', VOUCH_KARMA_AMOUNT);
    s.insertBox(vouch);

    // The zero-output spend: the stake leaves the UTXO set entirely and
    // `vouch_cooldowns` — a table, not a box — is the only record of it.
    s.beginBlockJournal(1);
    s.consumeBox(vouch.id!, 1);
    expect(s.openBlockJournalKarmaSupplyDelta()).toBe(-VOUCH_KARMA_AMOUNT);

    // ⛔ **The maturity leg restoring it is exactly what the axiom refuses to
    // accept as conservation.** The two legs net to zero, and between them there
    // was a stretch of chain — blocks, not instants — in which the stake existed
    // nowhere. A round trip is still a burn followed by a mint.
    s.insertBox(boxOfType('karma', VOUCH_KARMA_AMOUNT));
    expect(s.openBlockJournalKarmaSupplyDelta()).toBe(0n);
  });

  // -------------------------------------------------------------------------
  // Lifetime — the accumulator is the open block's and nothing else's
  // -------------------------------------------------------------------------

  it('is null with no journal open, which is not the same as zero', async () => {
    const s = await freshStore();
    expect(s.openBlockJournalKarmaSupplyDelta()).toBeNull();
    // Genesis creates the supply and is the **only** operation permitted to
    // (ARCHITECTURE → The conservation axiom). It runs outside block application
    // and opens no journal, so it is the one nonzero delta that is not a defect
    // — and the choke point stays out of it rather than exempting it by name.
    s.insertBox(boxOfType('karma', 500n));
    expect(s.openBlockJournalKarmaSupplyDelta()).toBeNull();
  });

  it('a rejected block leaves nothing behind for the next one', async () => {
    const s = await freshStore();
    s.beginBlockJournal(1);
    s.insertBox(boxOfType('karma', 90n));
    s.abortBlockJournal();

    s.beginBlockJournal(2);
    expect(s.openBlockJournalKarmaSupplyDelta()).toBe(0n);
  });

  it('a finished block leaves nothing behind for the next one', async () => {
    const s = await freshStore();
    s.beginBlockJournal(1);
    s.insertBox(boxOfType('karma', 90n));
    s.finishBlockJournal();

    s.beginBlockJournal(2);
    expect(s.openBlockJournalKarmaSupplyDelta()).toBe(0n);
  });

  it('a refused consume accounts nothing, for the reason it journals nothing', async () => {
    const s = await freshStore();
    const box = boxOfType('karma', 60n);
    s.insertBox(box);

    s.beginBlockJournal(1);
    s.consumeBox(box.id!, 1);
    expect(() => s.consumeBox(box.id!, 1)).toThrow(s.BoxNotLiveError);
    // −60 from the spend that happened, and nothing from the one that did not.
    expect(s.openBlockJournalKarmaSupplyDelta()).toBe(-60n);
  });
});
