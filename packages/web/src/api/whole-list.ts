import { PAGE_LIMIT_MAX } from '@dagsocial/types';
import { wholeListRead, type PageResult } from '@dagsocial/node-reads';
import type { Page } from './client';
import { PageError } from './errors';

// WEB_INTERFACE → Reading a node's answer → "A whole-list read is bounded"
// — the one web wrapper over @dagsocial/node-reads' `wholeListRead`, so
// every whole-list loop asks every page at PAGE_LIMIT_MAX, refuses a cursor
// it has followed before and a row key it has taken before, and refuses
// past the list's bound. The row key per list is the box id (`/karma`,
// `/credits`, the voucher arm, the cooldowns) or the bond's id (`/invites`).

export interface WholeListReadOpts<Row, Answer> {
  /** Read one page of the node's list — the Api method the caller holds. */
  readPage(page: Page): Promise<Answer>;
  /** The list and its `next` inside the Api answer. */
  pick(answer: Answer): { rows: Row[]; next: string | null };
  /** A row's dedup key — stable, lowercased where it names hex. */
  keyOf(row: Row): string;
  /** The list's row bound (CONSTANTS → Client reads). */
  bound: number;
}

/** The whole list the node serves, refused as `PageError` past its bound,
 *  on a repeated cursor, or on a row whose key has been taken before. The
 *  node's answers are already held to their page by the client's readers;
 *  a `PageError` the client throws passes through. */
export async function readWholeList<Row, Answer>(opts: WholeListReadOpts<Row, Answer>): Promise<Row[]> {
  const result = await wholeListRead<Row>({
    fetchPage: async (after, limit): Promise<PageResult<Row>> => {
      const page: Page = after === null ? { limit } : { limit, after };
      const answer = await opts.readPage(page);
      const { rows, next } = opts.pick(answer);
      return { ok: true, rows, next };
    },
    keyOf: opts.keyOf,
    limit: PAGE_LIMIT_MAX,
    bound: opts.bound,
  });
  if (!result.ok) throw new PageError();
  return result.rows;
}
