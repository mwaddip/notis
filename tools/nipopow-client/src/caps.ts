// CONSTANTS → Client reads — the proof route's byte cap, a function of the
// `m` and `k` the client asks (NODE_INTERFACE → Nipopow). The literal caps
// every reader names come from @dagsocial/node-reads.
import { MAX_HEADER_BYTES } from '@dagsocial/types';
import { MAX_NIPOPOW_PREFIX } from '@dagsocial/nipopow';

// CONSTANTS → Client reads — a PoPowHeader is `lp(header)` and
// `lp(interlinks)`. `lp(header)` is `MAX_HEADER_BYTES` and its two-byte length
// prefix.
const LP_HEADER_BYTES = MAX_HEADER_BYTES + 2;
// CONSTANTS → Client reads — `lp(interlinks)` at 40 entries, the highest
// level plus one under the prefix bound's premise
// (TYPES_INTERFACE → Interlink vector).
const LP_INTERLINKS_BYTES = 1_283;
const POPOW_HEADER_BYTES = LP_HEADER_BYTES + LP_INTERLINKS_BYTES;

/**
 * CONSTANTS → Client reads — the cap on `GET /nipopow/proof/:m/:k`, a
 * function of the `m` and `k` asked. `2 · (P · 1_518 + 1_518 + 235 · (k − 1)
 * + 8) + 12`: a prefix of `P = 99m` PoPowHeaders, at most
 * `MAX_NIPOPOW_PREFIX`; the suffix head one more; `k − 1` tail headers of
 * `MAX_HEADER_BYTES` and its prefix; 8 bytes of counts; hex doubles a byte,
 * and 12 bytes of JSON.
 */
export function nipopowProofReadBytes(m: number, k: number): number {
  const prefix = Math.min(99 * m, MAX_NIPOPOW_PREFIX);
  const bodyBytes = prefix * POPOW_HEADER_BYTES
    + POPOW_HEADER_BYTES
    + LP_HEADER_BYTES * (k - 1)
    + 8;
  return 2 * bodyBytes + 12;
}
