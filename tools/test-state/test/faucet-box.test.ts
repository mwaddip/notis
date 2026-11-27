import { describe, it, expect } from 'vitest';
import { judgeFaucetGrantHoldings } from '../src/faucet-box.js';

// TEST_STATE_INTERFACE → Generation → "The faucet's credits stand in one box
// made by the state's last write". The judgement answers ok only when the
// current holdings are exactly one box and that box is not among the pre-grant
// set.

const GENESIS = 'a'.repeat(64);
const FRESH = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);

describe('judgeFaucetGrantHoldings', () => {
  it.fails('refuses holdings of the genesis box alone', () => {
    const verdict = judgeFaucetGrantHoldings({
      preGrantBoxIds: [GENESIS],
      currentBoxIds: [GENESIS],
    });
    expect(verdict.ok).toBe(false);
  });

  it.fails('refuses holdings of two boxes', () => {
    const verdict = judgeFaucetGrantHoldings({
      preGrantBoxIds: [GENESIS],
      currentBoxIds: [GENESIS, FRESH],
    });
    expect(verdict.ok).toBe(false);
  });

  it.fails('refuses holdings of no box', () => {
    const verdict = judgeFaucetGrantHoldings({
      preGrantBoxIds: [GENESIS],
      currentBoxIds: [],
    });
    expect(verdict.ok).toBe(false);
  });

  it.fails('accepts one box absent from the pre-grant set', () => {
    const verdict = judgeFaucetGrantHoldings({
      preGrantBoxIds: [GENESIS, OTHER],
      currentBoxIds: [FRESH],
    });
    expect(verdict.ok).toBe(true);
  });
});
