// CONSTANTS → Light client reads — the byte cap each route's answer is read
// under. Every reader names its route's cap; none reads a body whole
// (WEB_INTERFACE → The extension → "Every answer is read under its route's
// cap"). Each cap sits a power of two above the longest honest answer the
// route serves, argued in the register.
import { MAX_HEADER_BYTES } from '@dagsocial/types';
import { MAX_NIPOPOW_PREFIX } from '@dagsocial/nipopow';

/** CONSTANTS → Light client reads — the cap on `GET /api/v1/proof/:key`. */
export const LOOKUP_READ_BYTES = 32_768;

/** CONSTANTS → Light client reads — the cap on one page of
 *  `GET /api/v1/range/:kind/:owner`. */
export const RANGE_PAGE_READ_BYTES = 8_388_608;

/** CONSTANTS → Light client reads — the cap on one page of
 *  `GET /karma/:userId` or `GET /credits/:userId`. */
export const LISTING_PAGE_READ_BYTES = 16_384;

/** CONSTANTS → Light client reads — the cap on `GET /posts/:id?tx=1`. */
export const POST_READ_BYTES = 32_768;

/** CONSTANTS → Light client reads — the cap on one `POST /posts/batch?tx=1`
 *  answer; the extension's resolve imports it. */
export const POST_BATCH_READ_BYTES = 4_194_304;

/** CONSTANTS → Light client reads — the cap on `GET /usernames/:name` and
 *  `GET /usernames?owner=`. */
export const NAME_READ_BYTES = 1_024;

/** CONSTANTS → Light client reads — the cap on `GET /blocks/current`. */
export const HEIGHT_READ_BYTES = 1_024;

// CONSTANTS → Light client reads — a PoPowHeader is `lp(header)` and
// `lp(interlinks)`. `lp(header)` is `MAX_HEADER_BYTES` and its two-byte length
// prefix.
const LP_HEADER_BYTES = MAX_HEADER_BYTES + 2;
// CONSTANTS → Light client reads — `lp(interlinks)` at 40 entries, the highest
// level plus one under the prefix bound's premise
// (TYPES_INTERFACE → Interlink vector).
const LP_INTERLINKS_BYTES = 1_283;
const POPOW_HEADER_BYTES = LP_HEADER_BYTES + LP_INTERLINKS_BYTES;

/**
 * CONSTANTS → Light client reads — the cap on `GET /nipopow/proof/:m/:k`, a
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
