import { describe, it, expect } from 'vitest';
import { identityHue, identityStop, ID_ARC_START, ID_ARC_SPAN, ID_STOPS } from '../src/model/identity';

const STEP = ID_ARC_SPAN / ID_STOPS;
const STOP_HUES = Array.from({ length: ID_STOPS }, (_, i) => ID_ARC_START + i * STEP);

function keyOf(n: number): string {
  // A plausible 64-hex key from a seed.
  let h = (2166136261 ^ n) >>> 0;
  let out = '';
  for (let i = 0; i < 8; i++) {
    h = Math.imul(h, 16777619) >>> 0;
    out += (h >>> 0).toString(16).padStart(8, '0');
  }
  return out.slice(0, 64);
}

describe('identity spine hue', () => {
  it('is deterministic in the author key', () => {
    const k = keyOf(42);
    expect(identityHue(k)).toBe(identityHue(k));
  });

  it('lands on exactly one of twelve quantised stops, never continuously', () => {
    const seen = new Set<number>();
    for (let n = 0; n < 500; n++) {
      const stop = identityStop(keyOf(n));
      expect(stop).toBeGreaterThanOrEqual(0);
      expect(stop).toBeLessThan(ID_STOPS);
      const hue = identityHue(keyOf(n));
      expect(STOP_HUES).toContain(hue);
      seen.add(hue);
    }
    expect(seen.size).toBeLessThanOrEqual(ID_STOPS);
  });

  it('stays inside the 175–345° arc (never into gold, green, clay or red)', () => {
    for (let n = 0; n < 500; n++) {
      const hue = identityHue(keyOf(n));
      expect(hue).toBeGreaterThanOrEqual(ID_ARC_START);
      expect(hue).toBeLessThan(ID_ARC_START + ID_ARC_SPAN); // < 345
    }
  });
});
