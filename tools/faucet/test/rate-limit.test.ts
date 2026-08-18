import { describe, it, expect } from 'vitest';
import { RateLimiter, SWEEP_ABOVE } from '../src/rate-limit.js';

const HOUR = 3_600_000;
const T = 1_000_000;

const flood = (limiter: RateLimiter, now: number, n = SWEEP_ABOVE + 1): void => {
  for (let i = 0; i < n; i++) limiter.allow(`flood-${i}`, now);
};

describe('RateLimiter', () => {
  it('admits N and refuses N+1 from one key', () => {
    const limiter = new RateLimiter(2);
    expect(limiter.allow('a', T)).toBe(true);
    expect(limiter.allow('a', T)).toBe(true);
    expect(limiter.allow('a', T)).toBe(false);
  });

  it('treats two keys independently', () => {
    const limiter = new RateLimiter(1);
    expect(limiter.allow('a', T)).toBe(true);
    expect(limiter.allow('a', T)).toBe(false);
    expect(limiter.allow('b', T)).toBe(true);
  });

  it('admits again once the window has passed', () => {
    const limiter = new RateLimiter(1);
    expect(limiter.allow('a', T)).toBe(true);
    expect(limiter.allow('a', T + HOUR - 1)).toBe(false);   // still inside the window
    // A hit expires exactly an hour later: the cutoff is `now - HOUR` and the
    // filter keeps `t > cutoff`. A refusal records nothing, so the hit at T is
    // still the only one being counted here.
    expect(limiter.allow('a', T + HOUR)).toBe(true);
  });

  it('drops entries whose every hit has expired, once the map is large', () => {
    const limiter = new RateLimiter(1);
    flood(limiter, T);
    expect(limiter.size).toBe(SWEEP_ABOVE + 1);
    limiter.allow('fresh', T + HOUR);
    expect(limiter.size).toBe(1);
  });

  // ⛔ The property that rules out cap-and-clear. Clearing the map wholesale at
  // a size threshold resets LIVE limits, so a caller could flush the counter of
  // whoever is currently capped just by generating traffic.
  it('never clears a live counter while sweeping', () => {
    const limiter = new RateLimiter(2);
    expect(limiter.allow('capped', T)).toBe(true);
    expect(limiter.allow('capped', T)).toBe(true);
    expect(limiter.allow('capped', T)).toBe(false);

    flood(limiter, T + 60_001);   // crosses the threshold and the sweep interval

    expect(limiter.allow('capped', T + 60_001)).toBe(false);
  });

  // The tradeoff, stated: below the threshold an expired entry is left in place
  // rather than costing every request a scan.
  it('leaves an expired entry in place below the threshold', () => {
    const limiter = new RateLimiter(1);
    limiter.allow('a', T);
    limiter.allow('b', T + HOUR);
    expect(limiter.size).toBe(2);
  });
});
