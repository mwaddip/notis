const HOUR_MS = 3_600_000;

/**
 * Entries to hold before a sweep is worth its cost. Below this the map is left
 * alone, so an ordinary request never pays for a scan.
 */
export const SWEEP_ABOVE = 10_000;

/** The most often a sweep runs, so a map that stays large does not scan per request. */
const SWEEP_INTERVAL_MS = 60_000;

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
  private lastSweep = 0;

  constructor(private readonly perHour: number) {}

  /** How many keys are being tracked. */
  get size(): number {
    return this.hits.size;
  }

  /** True if this key may proceed, recording the hit when it may. */
  allow(key: string, now: number): boolean {
    const cutoff = now - HOUR_MS;
    this.maybeSweep(now, cutoff);

    const kept = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length >= this.perHour) {
      this.hits.set(key, kept);
      return false;
    }
    kept.push(now);
    this.hits.set(key, kept);
    return true;
  }

  /**
   * Drop the keys that carry no live hits, bounding the map by **concurrent**
   * callers rather than by every address ever seen.
   *
   * ⛔ **By expiry, never by clearing the map at a size threshold.** A wholesale
   * clear resets LIVE limits, so a caller could flush the counter of whoever is
   * currently capped simply by generating enough traffic to trip the threshold.
   * An entry whose every recorded hit is already outside the window decides
   * nothing, so dropping it changes no verdict.
   */
  private maybeSweep(now: number, cutoff: number): void {
    if (this.hits.size <= SWEEP_ABOVE || now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    for (const [key, times] of this.hits) {
      if (times.every((t) => t <= cutoff)) this.hits.delete(key);
    }
  }
}
