import { describe, it, expect } from 'vitest';
import { MAX_BLOCK_COST, W_OP, W_SIG } from '@dagsocial/types';
import { blockCost, checkBlockCost } from '@dagsocial/consensus';

/**
 * The block's cost (CONSENSUS_INTERFACE → The block's cost): `signatures ×
 * W_SIG + (lookups + writes) × W_OP`, and a block over `MAX_BLOCK_COST`
 * refused with `cost C over the budget B`.
 */

describe('blockCost', () => {
  it('weighs a signature at W_SIG and a lookup or a write at W_OP', () => {
    expect(blockCost({ signatures: 0, lookups: 0, writes: 0 })).toBe(0);
    expect(blockCost({ signatures: 1, lookups: 0, writes: 0 })).toBe(W_SIG);
    expect(blockCost({ signatures: 0, lookups: 1, writes: 0 })).toBe(W_OP);
    expect(blockCost({ signatures: 0, lookups: 0, writes: 1 })).toBe(W_OP);
    expect(blockCost({ signatures: 3, lookups: 5, writes: 7 })).toBe(3 * W_SIG + (5 + 7) * W_OP);
  });

  it('answers 420 for three signatures, five lookups and seven writes at the weights 100 and 10', () => {
    expect(blockCost({ signatures: 3, lookups: 5, writes: 7 })).toBe(420);
  });
});

describe('checkBlockCost', () => {
  it('accepts a cost exactly at the budget: 6 000 signatures, 60 000 tree operations, or a mix', () => {
    expect(MAX_BLOCK_COST).toBe(600_000);
    expect(checkBlockCost({ signatures: 6_000, lookups: 0, writes: 0 })).toBeNull();
    expect(checkBlockCost({ signatures: 0, lookups: 35_000, writes: 25_000 })).toBeNull();
    expect(checkBlockCost({ signatures: 5_000, lookups: 6_000, writes: 4_000 })).toBeNull();
    expect(checkBlockCost({ signatures: 0, lookups: 0, writes: 0 })).toBeNull();
  });

  it('refuses one operation or one signature over, naming the cost and the budget', () => {
    expect(checkBlockCost({ signatures: 6_000, lookups: 1, writes: 0 })).toBe('cost 600010 over the budget 600000');
    expect(checkBlockCost({ signatures: 6_000, lookups: 0, writes: 1 })).toBe('cost 600010 over the budget 600000');
    expect(checkBlockCost({ signatures: 6_001, lookups: 0, writes: 0 })).toBe('cost 600100 over the budget 600000');
    expect(checkBlockCost({ signatures: 0, lookups: 35_000, writes: 25_001 })).toBe('cost 600010 over the budget 600000');
  });
});
