import { describe, it, expect } from 'vitest';
import { BASE } from '../src/generator.js';

// TEST_STATE_INTERFACE → The base state
describe('base state definition', () => {
  it('promotes R and S, claims Sk5send for S, and starts at height 60', () => {
    expect(BASE.promotions).toEqual(['R', 'S']);
    expect(BASE.claim).toEqual({ identity: 'S', name: 'Sk5send' });
    expect(BASE.startingHeight).toBe(60);
  });
});
