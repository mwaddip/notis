// WEB_INTERFACE → Reading a node's answer → "Every page is held to the page
// the node serves" and → "A whole-list read is bounded" — the two rules every
// paged read of a node's answer is held to. One definition each, so a client
// of the node's HTTP API runs the same check in every place that reads a page.

import { isRecord } from './http.js';

/**
 * One page the client's whole-list read holds the node's answer to. `rows`
 * are the entries the caller named `listName` for; `next` is the cursor to
 * ask the following page from, or `null` where the list ends at this one.
 */
export type PageResult<Row> =
  | { ok: true; rows: Row[]; next: string | null }
  | { ok: false; reason: string };

/**
 * WEB_INTERFACE → Reading a node's answer → "Every page is held to the page
 * the node serves" — hold a parsed body to the page the node serves. The
 * answer is an object; its `listName` list is an array of at most the
 * `limitAsked` rows; its `next` is `null` or a non-empty string with no
 * lone surrogate; and **a page that names a `next` carries exactly the
 * `limitAsked` rows** — the node reads one row past `limit` so only a
 * list's last page is short (NODE_INTERFACE → "Every list a view returns is
 * a page"). The row shape beyond `listName` holding an array is the caller's.
 */
export function parsePage<Row>(
  data: unknown,
  listName: string,
  limitAsked: number,
): PageResult<Row> {
  if (!isRecord(data)) return { ok: false, reason: 'page body is not an object' };
  const list = data[listName];
  if (!Array.isArray(list)) {
    return { ok: false, reason: `page ${listName} is not an array` };
  }
  if (list.length > limitAsked) {
    return { ok: false, reason: `page carries ${list.length} rows, over the ${limitAsked} the page asked` };
  }
  const next = data['next'];
  if (next !== null) {
    if (typeof next !== 'string') {
      return { ok: false, reason: 'page next is neither null nor a string' };
    }
    if (next === '') {
      return { ok: false, reason: 'page next is the empty string' };
    }
    if (!isWellFormedText(next)) {
      return { ok: false, reason: 'page next carries a lone surrogate' };
    }
    if (list.length !== limitAsked) {
      return { ok: false, reason: `page carries ${list.length} rows beside a next, not the ${limitAsked} the page asked` };
    }
  }
  return { ok: true, rows: list as Row[], next };
}

/** Text with no lone surrogate, the one thing `encodeURIComponent` throws on. */
function isWellFormedText(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && cp >= 0xd800 && cp <= 0xdfff) return false;
  }
  return true;
}

/** The outcome of one whole-list read: every row read, or the first
 *  refusal — a page the node served that failed its page rule, a cursor the
 *  read followed before, a row key named before, or the list's bound. */
export type WholeListResult<Row> =
  | { ok: true; rows: Row[] }
  | { ok: false; reason: string };

export interface WholeListOpts<Row> {
  /**
   * Read one page under one cursor and the limit the whole-list read asks.
   * `null` for the first page's cursor, else the cursor the whole-list read
   * followed from the page before. The callback holds the answer to its row
   * shape and the page rule before answering `{ ok: true, rows, next }`; any
   * other answer is `{ ok: false, reason }`. A throw passes through.
   */
  fetchPage: (after: string | null, limit: number) => Promise<PageResult<Row>>;
  /** A row's dedup key — stable, lowercased where it names hex. Two rows
   *  with the same key end the listing. */
  keyOf: (row: Row) => string;
  /** The limit asked on every page's URL, at most `PAGE_LIMIT_MAX`
   *  (TYPES_INTERFACE → HTTP view bounds). */
  limit: number;
  /** The list's row bound (CONSTANTS → Client reads). */
  bound: number;
}

/**
 * WEB_INTERFACE → Reading a node's answer → "A whole-list read is bounded" —
 * follow `next` to the end, holding each page to its page rule, refusing a
 * cursor the read has followed before and a row whose key the read has taken
 * before, and failing past the list's bound. A whole-list read asks at most
 * `⌈bound / limit⌉ + 1` pages. The run itself never throws on the node's
 * answer; a throw from `fetchPage` passes.
 */
export async function wholeListRead<Row>(opts: WholeListOpts<Row>): Promise<WholeListResult<Row>> {
  const { fetchPage, keyOf, limit, bound } = opts;
  // The initial `after` is `null`; a page's `next` is a repeat on its second
  // appearance as the cursor to ask from.
  const seenCursors = new Set<string>();
  const seenKeys = new Set<string>();
  const rows: Row[] = [];
  let after: string | null = null;

  for (;;) {
    const page = await fetchPage(after, limit);
    if (!page.ok) return { ok: false, reason: page.reason };
    for (const row of page.rows) {
      const key = keyOf(row);
      if (seenKeys.has(key)) {
        return { ok: false, reason: `one row key named twice across pages: ${key}` };
      }
      seenKeys.add(key);
      rows.push(row);
    }
    if (rows.length > bound) {
      return { ok: false, reason: `listing runs past the ${bound}-row bound (${rows.length} rows read)` };
    }
    if (page.next === null) return { ok: true, rows };
    if (rows.length >= bound) {
      return { ok: false, reason: `listing runs past the ${bound}-row bound: a next page still stands at the bound` };
    }
    if (seenCursors.has(page.next)) {
      return { ok: false, reason: `one cursor named twice across pages: ${page.next}` };
    }
    seenCursors.add(page.next);
    after = page.next;
  }
}

/**
 * NODE_INTERFACE → Karma transition rules → "An identity holds at most two
 * karma boxes" — the protocol's maximum on the karma listing, one `own` box
 * and one `income` box. A whole-list read of `/karma/:userId` is held to it.
 */
export const KARMA_LISTING_MAX = 2;
