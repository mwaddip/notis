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
 * accounting the karma supply there is what makes it non-inflatable **by
 * construction** rather than by every producer remembering to draw
 * (TYPES_INTERFACE → KarmaPoolBox). These pin the two properties that rests on:
 * which box types count, and that the running total is the block's net.
 *
 * ⛔ **The delta's sign is circulation's, not the pool's.** A mint is positive
 * here and the pool owes that much; the settlement negates it. Reading it as the
 * pool's own movement inverts every case below.
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
    case 'invite':
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
 * three-way membership rule asks for — *may a karma spend create it?* and *does
 * its value count as karma that exists?* are asked separately, and both answers
 * may be no (NODE_INTERFACE → "Two karma sets, and neither derives from the
 * other").
 */
const COUNTS_AS_CIRCULATING: Record<AnyBox['boxType'], boolean> = {
  karma: true,
  invite: true,
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
};

describe('the karma supply is accounted at the box mutation choke point', () => {
  beforeEach(async () => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
  });

  for (const [boxType, counts] of Object.entries(COUNTS_AS_CIRCULATING)) {
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
  // The four transaction shapes the pool has to square. Each is the box
  // arithmetic a real transaction performs, so the delta below is what block
  // application owes the pool for it.
  // -------------------------------------------------------------------------

  it('a conserving karma move owes the pool nothing', async () => {
    const s = await freshStore();
    const spent = boxOfType('karma', 40n);
    s.insertBox(spent);

    s.beginBlockJournal(1);
    s.consumeBox(spent.id!, 1);
    s.insertBox(boxOfType('karma', 15n));
    s.insertBox(boxOfType('post_lock', 25n));
    expect(s.openBlockJournalKarmaSupplyDelta()).toBe(0n);
  });

  it('a like burn returns exactly LIKE_KARMA_COST to the pool', async () => {
    const s = await freshStore();
    const spent = boxOfType('karma', 40n);
    s.insertBox(spent);

    s.beginBlockJournal(1);
    s.consumeBox(spent.id!, 1);
    s.insertBox(boxOfType('karma', 40n - LIKE_KARMA_COST));
    expect(s.openBlockJournalKarmaSupplyDelta()).toBe(-LIKE_KARMA_COST);
  });

  it('an invite claim draws exactly INVITE_KARMA_AMOUNT out of the pool', async () => {
    const s = await freshStore();
    // The claimed invite holds 0, so the whole karma output is a surplus — the
    // only karma a user transaction may create (NODE_INTERFACE → the claim row).
    const invite = boxOfType('invite', 0n);
    s.insertBox(invite);

    s.beginBlockJournal(1);
    s.consumeBox(invite.id!, 1);
    s.insertBox(boxOfType('karma', INVITE_KARMA_AMOUNT));
    expect(s.openBlockJournalKarmaSupplyDelta()).toBe(INVITE_KARMA_AMOUNT);
  });

  it('an unvouch returns the stake to the pool, and the escrow holds no karma', async () => {
    const s = await freshStore();
    const vouch = boxOfType('vouch', VOUCH_KARMA_AMOUNT);
    s.insertBox(vouch);

    // The zero-output spend: the stake leaves the UTXO set and `vouch_cooldowns`
    // records a claim on the pool rather than a holding, which is what keeps the
    // invariant free of an `+ escrowed` term over state the AVL root does not
    // cover.
    s.beginBlockJournal(1);
    s.consumeBox(vouch.id!, 1);
    expect(s.openBlockJournalKarmaSupplyDelta()).toBe(-VOUCH_KARMA_AMOUNT);

    // …and the maturity leg draws the same amount back out, so the round trip
    // costs the pool nothing.
    s.insertBox(boxOfType('karma', VOUCH_KARMA_AMOUNT));
    expect(s.openBlockJournalKarmaSupplyDelta()).toBe(0n);
  });

  // -------------------------------------------------------------------------
  // Lifetime — the accumulator is the open block's and nothing else's
  // -------------------------------------------------------------------------

  it('is null with no journal open, which is not the same as zero', async () => {
    const s = await freshStore();
    expect(s.openBlockJournalKarmaSupplyDelta()).toBeNull();
    // Genesis mints karma outside block application and accounts for it against
    // the pool it seeds; the choke point must stay out of that.
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
