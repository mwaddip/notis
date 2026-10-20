// A fake-fetch helper for a paged route: given a list's rows in their stated
// order, their key function, and the request's URL (its `after` and `limit`),
// it answers what an honest node answers — the rows strictly after `after`
// by the list's key, at most the `limit` asked (the node's default where the
// URL names none, clamped to `PAGE_LIMIT_MAX`), and `next` the last row's
// key exactly when a row follows (NODE_INTERFACE → "Every list a view
// returns is a page", WEB_INTERFACE → Reading a node's answer → "Every page
// is held to the page the node serves").

import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from '@dagsocial/types';

/** The slice of a list's rows a page the URL asks for carries, and the
 *  `next` key of the row that would follow it, or `null` where the list
 *  ends there. The list's rows are the whole list in its stated order; a
 *  caller already filtered the slice its route serves. */
export function honestPageSlice<Row>(
  rows: readonly Row[],
  keyOf: (row: Row) => string,
  url: string | URL,
): { rows: Row[]; next: string | null; limit: number; after: string | null } {
  const u = typeof url === 'string' ? new URL(url, 'http://node.test') : url;
  const limitParam = u.searchParams.get('limit');
  let limit = limitParam === null ? PAGE_LIMIT_DEFAULT : Number(limitParam);
  if (!Number.isSafeInteger(limit) || limit < 1) limit = PAGE_LIMIT_DEFAULT;
  if (limit > PAGE_LIMIT_MAX) limit = PAGE_LIMIT_MAX;
  const after = u.searchParams.get('after');
  const start = after === null ? 0 : rows.findIndex((r) => keyOf(r) === after) + 1;
  const slice = rows.slice(start, start + limit);
  const nextIdx = start + slice.length;
  const next = nextIdx < rows.length ? keyOf(slice[slice.length - 1]!) : null;
  return { rows: slice, next, limit, after };
}

/** A Response the fake answers for a 2xx body, wrapping the JSON an honest
 *  node sends. Every fake in the suite answers through a real `Response` so
 *  the stream reader `@dagsocial/node-reads`' `fetchJson` holds the body
 *  under its cap. */
export function jsonResponse(body: unknown, status = 200): Response {
  const text = body === undefined ? '' : JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': 'application/json' } });
}
