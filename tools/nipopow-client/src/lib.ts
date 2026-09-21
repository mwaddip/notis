// The importable entry — re-exports only, no side effect at import time.
// The command line stays at src/index.ts and its dist/index.js.

export { resolveTip } from './tip.js';
export type { TipResult, NodeTipResult } from './tip.js';

export { proveBoxes } from './boxes.js';
export type { BoxesResult, BoxVerdict, BoxClass, BoxStatus } from './boxes.js';

export { verifierProfile } from './config.js';
export type { VerifyProfile } from './config.js';

export type { HttpFetch } from './http.js';
