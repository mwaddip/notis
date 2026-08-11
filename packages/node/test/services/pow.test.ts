import { describe, it, expect } from 'vitest';
import { generateChallenge } from '../../src/services/pow.js';

describe('generateChallenge', () => {
  it('returns 32 bytes', () => {
    const challenge = generateChallenge();
    expect(challenge).toBeInstanceOf(Uint8Array);
    expect(challenge.length).toBe(32);
  });

  it('is random (two calls produce different results)', () => {
    const a = generateChallenge();
    const b = generateChallenge();
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});
