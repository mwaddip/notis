// The importable entry — re-exports only, no side effect at import time.
// The command line stays at src/index.ts and its dist/index.js.

export { resolveTip } from './tip.js';
export type { TipResult, NodeTipResult } from './tip.js';

export { fetchListing, proveFigures, proveBoxes } from './boxes.js';
export type {
  ListedBox,
  Listing,
  ListingResult,
  Anchor,
  FigureStatus,
  FigureBox,
  RecordResult,
  LedgerSums,
  FiguresResult,
  HoldingsRead,
} from './boxes.js';

export { proveHoldings, proveRange } from './holdings.js';
export type { HoldingsResult, RangeResult } from './holdings.js';

export { proveName } from './names.js';
export type { NameClaim, NameStatus, NameResult } from './names.js';

export { verifierProfile, DEFAULT_M, DEFAULT_K } from './config.js';
export type { VerifyProfile } from './config.js';

export type { HttpFetch } from './http.js';
