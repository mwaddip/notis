// TEST_STATE_INTERFACE → The clock offset. Every node-side process of a run
// reads `Date.now()` shifted by `tipCreatedAt + 1000 − now`, so a load any
// day resumes the chain one second after its tip, and the difficulty
// schedule reads as it did when the state was made.
import { pathToFileURL } from 'node:url';

export function computeClockOffsetMs(tipCreatedAtMs: number, nowMs: number): number {
  return tipCreatedAtMs + 1000 - nowMs;
}

// The `NODE_OPTIONS` entry a spawned process reads to install the preload.
// The offset itself rides in DAGSOCIAL_CLOCK_OFFSET_MS beside it.
export function nodeOptionsForPreload(preloadPath: string): string {
  return `--import=${pathToFileURL(preloadPath).href}`;
}
