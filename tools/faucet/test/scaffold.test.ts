import { describe, it, expect } from 'vitest';
import { computeTxId, selectBoxes } from '@dagsocial/types';

// The barrel is the surface under test (ARCHITECTURE → "Build and test
// resolution"): a symbol a module exports but `index.ts` does not still fails
// at import, and this package sits a directory deeper than the five, so its
// resolution is the one thing the scaffolding has to establish.
describe('workspace wiring', () => {
  it('resolves @dagsocial/types from the faucet package', () => {
    expect(typeof computeTxId).toBe('function');
    expect(typeof selectBoxes).toBe('function');
  });

  it('selectBoxes covers the required amount largest-first', () => {
    const boxes = [{ value: 100n }, { value: 40n }, { value: 5n }];
    expect(selectBoxes(boxes, 120n)).toEqual([{ value: 100n }, { value: 40n }]);
  });
});
