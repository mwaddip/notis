// Errors the read client raises. Lives in a module neither `api/client.ts` nor
// `api/light-page.ts` depends on the other for, so each imports here.

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/** A 2xx whose body is not the page its route answers — thrown where a non-2xx
 *  throws `ApiError`, so every caller's failure path takes it. */
export class PageError extends Error {
  constructor() {
    super("the node's answer is not a page");
    this.name = 'PageError';
  }
}

/** The read client's reading of *no answer*
 *  (WEB_INTERFACE → The wallet → "A write no node answers waits"): an
 *  `ApiError` carrying status 0 — a transport failure or the deadline. A
 *  `PageError`, an `ApiError` of any other status, and anything else is the
 *  node's. */
export function isNoAnswer(e: unknown): boolean {
  return e instanceof ApiError && e.status === 0;
}
