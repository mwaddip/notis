import { describe, it, expect } from 'vitest';
import { MEMPOOL_EXPIRY_BLOCKS } from '@dagsocial/types';
import { boundedExpiry, heldEntry, isBlockHeight } from '../src/wallet/expiry';
import type { UnboundedEntry } from '../src/wallet/types';

// A pending entry's expiry is the client's, and a node's answer can only bring it
// sooner (WEB_INTERFACE → The wallet): the entry's build height plus
// MEMPOOL_EXPIRY_BLOCKS, or the answered height when that is a block height
// below it. Total over every shape an answer can take.

const BUILT = 1000;
const OWN = BUILT + MEMPOOL_EXPIRY_BLOCKS;

describe('isBlockHeight — a safe, non-negative integer', () => {
  it('takes 0, a height and the largest safe integer', () => {
    for (const v of [0, 1, 1720, Number.MAX_SAFE_INTEGER]) expect(isBlockHeight(v), String(v)).toBe(true);
  });

  it('refuses a negative, a fraction, NaN, the infinities, an unsafe integer and every non-number', () => {
    for (const v of [-1, 1.5, NaN, Infinity, -Infinity, 2 ** 53, '1720', 1720n, null, undefined, true, {}, []]) {
      expect(isBlockHeight(v), String(v)).toBe(false);
    }
  });
});

describe('boundedExpiry', () => {
  it('an answered block height below the bound is taken — a node can bring the expiry sooner', () => {
    expect(boundedExpiry(BUILT, 1500)).toBe(1500);
    expect(boundedExpiry(BUILT, OWN - 1)).toBe(OWN - 1);
  });

  it('an answered height exactly at the bound is the bound', () => {
    expect(boundedExpiry(BUILT, OWN)).toBe(OWN);
  });

  it('an answered height below the build height is still a block height below the bound, and is taken', () => {
    expect(boundedExpiry(BUILT, 900)).toBe(900);
    expect(boundedExpiry(BUILT, 0)).toBe(0);
  });

  it('a later answered height gives the client\'s own — a node can never hold an entry longer', () => {
    expect(boundedExpiry(BUILT, OWN + 1)).toBe(OWN);
    expect(boundedExpiry(BUILT, 1e15)).toBe(OWN);
    expect(boundedExpiry(BUILT, Number.MAX_SAFE_INTEGER)).toBe(OWN);
  });

  it('an answer that is not a block height gives the client\'s own', () => {
    for (const answered of [undefined, null, '1500', NaN, 1500.5, -1, Infinity, 2 ** 53, 1500n, true, {}, [1500]]) {
      expect(boundedExpiry(BUILT, answered), String(answered)).toBe(OWN);
    }
  });

  it('never throws, and never coerces the answer', () => {
    const hostile = { valueOf(): number { throw new Error('coerced'); } };
    expect(boundedExpiry(BUILT, hostile)).toBe(OWN);
    expect(boundedExpiry(BUILT, Symbol('height'))).toBe(OWN);
  });
});

describe('heldEntry', () => {
  it('answers a new entry with the bounded expiry and every other field as given, the input untouched', () => {
    const entry: UnboundedEntry = {
      txId: 't1', kind: 'post', postId: 'p1', inputs: ['in1'],
      change: { boxId: 'chg1', value: 222n, createdAtBlock: BUILT },
      expiresAtHeight: 1e15, submittedAtHeight: BUILT,
    };
    const held = heldEntry(entry);
    expect(held).toEqual({ ...entry, expiresAtHeight: OWN });
    expect(held).not.toBe(entry);
    expect(entry.expiresAtHeight).toBe(1e15);
  });

  it('an entry whose answer carried no expiry is held at the client\'s own', () => {
    const held = heldEntry({ txId: 't2', kind: 'like', postId: 'p2', inputs: [], expiresAtHeight: undefined, submittedAtHeight: BUILT });
    expect(held.expiresAtHeight).toBe(OWN);
  });
});
