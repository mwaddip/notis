import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fixtureProvenance, uid,
  FIXTURE_BOND_KARMA,
} from '../helpers.js';
import {
  LIKE_KARMA_COST,
  LIKES_PER_KARMA_PAYOUT,
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
function boxOfType(boxType: AnyBox['boxType'], value: bigint, tag = ''): AnyBox {
  // ⚠ `tag` separates two boxes of one type and value. It reaches the
  // provenance nonce as well as the id, because `(tx_id, output_index)` is
  // UNIQUE and identical candidates derive one synthetic txId.
  const nonce = tag ? [...tag].reduce((a, c) => a + c.charCodeAt(0), 0) : 0;
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
    case 'like_accrual':
      // ⛔ `author` is attribution, not authorization, and it is not the `owner`
      // column (TYPES_INTERFACE → LikeAccrualBox).
      base['author'] = OWNER;
      break;
    case 'vouch_escrow':
      base['owner'] = OWNER;
      base['releaseAtBlock'] = 100;
      break;
    // `emission`, `treasury`, `fee` and `karma_pool` have no owner and no
    // per-type fields — the shared prefix is the whole box.
    default:
      break;
  }
  const box = { ...base, ...fixtureProvenance(base, 1, nonce) } as unknown as AnyBox;
  box.id = tag ? `${boxType}-${value}-${tag}` : `${boxType}-${value}`;
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
  // ⛔ **Both `true`, each on its own evidence.** A marker holds the liker's
  // karma between the like and the settlement, a carry box holds an author's
  // remainder across blocks, and an escrow holds a voucher's stake for the length
  // of its cooldown. All three are karma a holder is waiting on rather than karma
  // that stopped existing — the standing of `bond`, `post_lock` and `vouch`
  // (TYPES_INTERFACE → LikeAccrualBox / VouchEscrowBox).
  like_accrual: true,
  vouch_escrow: true,
};

describe('the karma supply is accounted at the box mutation choke point', () => {
  beforeEach(async () => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
  });

  // ⛔ **EVERY TYPE IS MEASURED AT THE CHOKE POINT, none on the predicate
  // alone.** The like transaction emits a marker and the unvouch emits an
  // escrow, so the store carries a row mapping for each and both move the supply
  // like any other karma-bearing type
  // (TYPES_INTERFACE → LikeAccrualBox / VouchEscrowBox). The set is empty and
  // kept, so a type that becomes unproducible has somewhere to go.
  const UNPRODUCED: ReadonlySet<string> = new Set<string>();

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
  // ⛔ **EVERY SHAPE HERE NAMES A SOURCE AND A SINK**, so each case pins a
  // CIRCULATION change rather than a unit called into being or ended
  // (ARCHITECTURE → The conservation axiom).
  //
  // ⚠ **A non-zero delta is not a violation, and reading it as one is the error
  // this header exists to prevent.** `karma_pool` sits OUTSIDE the supply set on
  // purpose, so karma moving to or from the pool moves this figure by design —
  // the pool holds what is not in circulation. The conservation total is
  // `circulating + pool`, a different sum over a different set, and
  // `conservation-axiom.test.ts` is where it is asserted
  // (NODE_INTERFACE → Three karma sets, and none derives from another).
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

  it('a like moves LIKE_KARMA_COST into a marker, and circulation is unchanged', async () => {
    // ⛔ **The cost lands in a `LikeAccrualBox`**, which is karma-bearing and in
    // the supply set — so the like is a transfer between two boxes and this
    // figure does not move at all (ARCHITECTURE → The conservation axiom, third
    // shape: a marker must carry its value).
    const s = await freshStore();
    const spent = boxOfType('karma', 40n);
    s.insertBox(spent);

    s.beginBlockJournal(1);
    s.consumeBox(spent.id!, 1);
    s.insertBox(boxOfType('karma', 40n - LIKE_KARMA_COST));
    s.insertBox(boxOfType('like_accrual', LIKE_KARMA_COST));
    expect(s.openBlockJournalKarmaSupplyDelta()).toBe(0n);
  });

  it('the like PAYOUT sends the remainder to the pool, so circulation falls by it', async () => {
    // ⛔ **The settlement's leg, and the one place this figure SHOULD move.**
    // `markers×x → authorKarma(x−1) + pool(1)`: the author's share stays in
    // circulation and the remainder leaves it for the pool, which is outside
    // this set. ⚠ **A `-1` here is the deflation dial working**, not a defect —
    // `conservation-axiom.test.ts` is what proves nothing was destroyed.
    const s = await freshStore();
    const X = BigInt(LIKES_PER_KARMA_PAYOUT);
    const markers = Array.from({ length: LIKES_PER_KARMA_PAYOUT }, (_, i) =>
      boxOfType('like_accrual', LIKE_KARMA_COST, `marker-${i}`),
    );
    for (const m of markers) s.insertBox(m);

    s.beginBlockJournal(1);
    for (const m of markers) s.consumeBox(m.id!, 1);
    s.insertBox(boxOfType('karma', (X - 1n) * LIKE_KARMA_COST));
    expect(s.openBlockJournalKarmaSupplyDelta()).toBe(-LIKE_KARMA_COST);
  });

  it('an invite grant draws FIXTURE_BOND_KARMA from the pool and names it', async () => {
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
    s.insertBox(boxOfType('karma_pool', 1000n - FIXTURE_BOND_KARMA));
    s.insertBox(boxOfType('karma', FIXTURE_BOND_KARMA));

    // Circulation grew by the grant …
    expect(s.openBlockJournalKarmaSupplyDelta()).toBe(FIXTURE_BOND_KARMA);
    // … and the pool fell by exactly the same amount, which is the half the
    // supply delta cannot see and the half the axiom is about.
    const poolAfter = s.getKarmaPoolBox();
    expect(poolAfter!.value).toBe(1000n - FIXTURE_BOND_KARMA);
  });

  it('a bond forfeit sends the unvested remainder to the pool', async () => {
    // ⛔ **The forfeit is a TRANSFER and the settlement names its sink**
    // (ARCHITECTURE → Bond outcomes). The vested part returns to the inviter and
    // stays in circulation; the remainder goes to the pool, which is outside
    // this set — so the figure falls by exactly the forfeit and by nothing else.
    const s = await freshStore();
    const bond = boxOfType('bond', 40n);
    s.insertBox(bond);

    s.beginBlockJournal(1);
    s.consumeBox(bond.id!, 1);
    s.insertBox(boxOfType('karma', 10n));
    expect(s.openBlockJournalKarmaSupplyDelta()).toBe(-30n);
  });

  it('an unvouch escrows the stake, and circulation never moves', async () => {
    // ⛔ **`VouchEscrowBox` IS IN THE SUPPLY SET**, so the stake stays in
    // circulation for the whole cooldown — the unvouch is a transfer between two
    // karma-bearing boxes and this figure does not move (ARCHITECTURE → Vouch
    // boxes).
    const s = await freshStore();
    const vouch = boxOfType('vouch', VOUCH_KARMA_AMOUNT);
    s.insertBox(vouch);

    s.beginBlockJournal(1);
    s.consumeBox(vouch.id!, 1);
    s.insertBox(boxOfType('vouch_escrow', VOUCH_KARMA_AMOUNT));
    expect(s.openBlockJournalKarmaSupplyDelta()).toBe(0n);

    // ⛔ **And the release moves it no further.** The escrow becomes karma; both
    // types are in the set, so there is no stretch of chain in which the stake
    // is anywhere but a box — which is what *"not even as an intermediary
    // step"* asks for and a net-zero round trip does not give.
    s.consumeBox(
      s.getUnspentBoxes().find((b) => b.boxType === 'vouch_escrow')!.id!,
      2,
    );
    s.insertBox(boxOfType('karma', VOUCH_KARMA_AMOUNT, 'released'));
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
