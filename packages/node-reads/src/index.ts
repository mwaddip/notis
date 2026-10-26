// The barrel — the one surface a client of @dagsocial/node-reads sees.

export { fetchJson, readCappedJson, isRecord, capped, REQUEST_TIMEOUT_MS } from './http.js';
export type { HttpFetch, NodeResponse, NodeError, NodeResult } from './http.js';

export {
  LOOKUP_READ_BYTES,
  RANGE_PAGE_READ_BYTES,
  LISTING_PAGE_READ_BYTES,
  POST_READ_BYTES,
  POST_BATCH_READ_BYTES,
  NAME_READ_BYTES,
  HEIGHT_READ_BYTES,
  FEED_PAGE_READ_BYTES,
  THREAD_READ_BYTES,
  STATUS_READ_BYTES,
  VOUCH_PAGE_READ_BYTES,
  BOND_PAGE_READ_BYTES,
  WRITE_ANSWER_READ_BYTES,
  LEDGER_READ_MAX,
} from './caps.js';

export {
  isNonNegSafeInt,
  isNonNegSafeIntOrNull,
  isBoxValue,
  isSum,
  isAuthorName,
} from './fields.js';

export {
  parsePage,
  wholeListRead,
  KARMA_LISTING_MAX,
} from './pages.js';
export type { PageResult, WholeListResult, WholeListOpts } from './pages.js';
