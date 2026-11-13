import { describe, it, expect } from 'vitest';
import { LIKE_KARMA_COST } from '@dagsocial/types';
import { DEVNET_FAUCET, fresh } from '../src/identities.js';
import { karmaBoxRefs } from '../src/tx/karma.js';
import { buildLikeTx } from '../src/tx/like.js';
import type { KarmaPageBox } from '../src/http.js';

// NODE_INTERFACE → UTXO queries — a karma box carries `income: true` when it
// is the owner's income box and no such key when it is their own
// (TYPES_INTERFACE → KarmaBox); the refs the spend reads carry the same mark
// (NODE_INTERFACE → Karma transition rules → "An identity holds at most two
// karma boxes").

const OWN_BOX_ID = 'a'.repeat(64);
const INCOME_BOX_ID = 'b'.repeat(64);
const POST_ID = 'c'.repeat(64);

describe('karma box refs', () => {
  it('a listing with an own box and an income box maps to refs where the income box carries the mark and the own box carries no income key, in the listing order', () => {
    const boxes: KarmaPageBox[] = [
      { boxId: OWN_BOX_ID, value: '10' },
      { boxId: INCOME_BOX_ID, value: '4', income: true },
    ];

    const refs = karmaBoxRefs({ boxes });

    expect(refs.length).toBe(2);
    expect(refs[0]!.boxId).toBe(OWN_BOX_ID);
    expect(refs[0]!.value).toBe(10n);
    expect(refs[1]!.boxId).toBe(INCOME_BOX_ID);
    expect(refs[1]!.value).toBe(4n);
    expect('income' in refs[0]!).toBe(false);
    expect(refs[1]!.income).toBe(true);
  });

  it('buildLikeTx over the refs names the own box alone when it covers the like cost and an income box stands by it', () => {
    const boxes: KarmaPageBox[] = [
      { boxId: OWN_BOX_ID, value: '10' },
      { boxId: INCOME_BOX_ID, value: '4', income: true },
    ];
    const refs = karmaBoxRefs({ boxes });
    const target = fresh();

    expect(refs.length).toBe(2);
    expect(refs[0]!.value >= LIKE_KARMA_COST).toBe(true);

    const tx = buildLikeTx(DEVNET_FAUCET, refs, POST_ID, target.publicKeyHex, 100, 1);
    expect(tx.json.inputs).toEqual([OWN_BOX_ID]);
  });

  it('buildLikeTx over the refs names the own box and the income box when the own box does not cover the like cost', () => {
    const boxes: KarmaPageBox[] = [
      { boxId: OWN_BOX_ID, value: '0' },
      { boxId: INCOME_BOX_ID, value: '4', income: true },
    ];
    const refs = karmaBoxRefs({ boxes });
    const target = fresh();

    expect(refs.length).toBe(2);
    expect(refs[0]!.value < LIKE_KARMA_COST).toBe(true);
    expect(refs[0]!.value + refs[1]!.value >= LIKE_KARMA_COST).toBe(true);

    const tx = buildLikeTx(DEVNET_FAUCET, refs, POST_ID, target.publicKeyHex, 100, 1);
    expect(tx.json.inputs).toEqual([OWN_BOX_ID, INCOME_BOX_ID]);
  });
});
