const HOUR_MS = 3_600_000;

/**
 * Per-IP request counting, in memory.
 *
 * ⚠ **The threat is a dead playground, not lost value** — nothing here is worth
 * stealing and the chain wipes. What a loop costs is the faucet's whole invite
 * capacity, so the next tester finds nothing; a counter is proportionate to
 * that and a captcha is not.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly perHour: number) {}

  /** True if this key may proceed, recording the hit when it may. */
  allow(key: string, now: number): boolean {
    const cutoff = now - HOUR_MS;
    const kept = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length >= this.perHour) {
      this.hits.set(key, kept);
      return false;
    }
    kept.push(now);
    this.hits.set(key, kept);
    return true;
  }
}
