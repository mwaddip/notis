// CONSTANTS → Client reads — the byte cap each route's answer is read
// under. Every reader names its route's cap; none reads a body whole
// (WEB_INTERFACE → Reading a node's answer). Each cap sits a power of two
// above the longest honest answer the route serves, argued in the register.

/** CONSTANTS → Client reads — the cap on one key's AVL+ lookup proof. */
export const LOOKUP_READ_BYTES = 32_768;

/** CONSTANTS → Client reads — the cap on one page of a key's holdings
 *  range. */
export const RANGE_PAGE_READ_BYTES = 8_388_608;

/** CONSTANTS → Client reads — the cap on one page of `GET /karma/:userId` or
 *  `GET /credits/:userId` — the reader's own listings, the reads before a
 *  write, a send's landing read and the command line's listing of one
 *  ledger. */
export const LISTING_PAGE_READ_BYTES = 16_384;

/** CONSTANTS → Client reads — the cap on `GET /posts/:id`, with `tx=1` or
 *  without. */
export const POST_READ_BYTES = 32_768;

/** CONSTANTS → Client reads — the cap on one batch read's answer; the
 *  extension's resolve imports it. */
export const POST_BATCH_READ_BYTES = 4_194_304;

/** CONSTANTS → Client reads — the cap on `GET /usernames/:name` and
 *  `GET /usernames?owner=`. */
export const NAME_READ_BYTES = 1_024;

/** CONSTANTS → Client reads — the cap on `GET /blocks/current`. */
export const HEIGHT_READ_BYTES = 1_024;

/** CONSTANTS → Client reads — the cap on one page of `GET /posts` — the
 *  feed and an author's list — full or light. */
export const FEED_PAGE_READ_BYTES = 262_144;

/** CONSTANTS → Client reads — the cap on one `GET /posts/:id/thread`
 *  answer. */
export const THREAD_READ_BYTES = 1_048_576;

/** CONSTANTS → Client reads — the cap on `GET /status`. */
export const STATUS_READ_BYTES = 1_024;

/** CONSTANTS → Client reads — the cap on one page of `GET /vouches` — the
 *  target arm, the voucher arm, the cooldowns. */
export const VOUCH_PAGE_READ_BYTES = 65_536;

/** CONSTANTS → Client reads — the cap on one page of
 *  `GET /invites/:userId`. */
export const BOND_PAGE_READ_BYTES = 65_536;

/** CONSTANTS → Client reads — the cap on any write route's answer, a 2xx's
 *  or a rejection's — the node's nine writes and the faucet's two. */
export const WRITE_ANSWER_READ_BYTES = 1_024;

/** CONSTANTS → Client reads — the most boxes one ledger read takes in, a
 *  range at one height or the command line's listing of one ledger
 *  (WEB_INTERFACE → Reading a node's answer → "A whole-list read is
 *  bounded"). */
export const LEDGER_READ_MAX = 10_000;
