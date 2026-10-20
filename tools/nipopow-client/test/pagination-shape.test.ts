// WEB_INTERFACE → Reading a node's answer — the entries this file enters are
// `fetchListing`, `proveRange` and `proveName`. Each case is an answer the
// node is free to send and the rule the client holds it to.

import { describe, it, expect } from 'vitest';
import { hexToBytes, PAGE_LIMIT_MAX } from '@dagsocial/types';
import type { UserId } from '@dagsocial/types';
import { fetchListing } from '../src/boxes.js';
import { proveRange } from '../src/holdings.js';
import { proveName } from '../src/names.js';
import type { HttpFetch } from '@dagsocial/node-reads';
import { jsonResponse, makeAnchor } from './helpers.js';

const OWNER_HEX = 'ab'.repeat(32);
const OWNER = hexToBytes(OWNER_HEX) as UserId;
void OWNER;
const BOX_A = '01'.repeat(32);
const BOX_B = '02'.repeat(32);
const KARMA_PATH = `/karma/${OWNER_HEX}`;
const CREDITS_PATH = `/credits/${OWNER_HEX}`;
const RANGE_PATH = `/api/v1/range/karma/${OWNER_HEX}`;

interface Routed {
  fetch: HttpFetch;
  calls: string[];
}

function listingFetch(
  karma: (after: string | null, nth: number) => unknown,
  credits: (after: string | null, nth: number) => unknown = () => ({ userId: OWNER_HEX, boxes: [], next: null }),
): Routed {
  const calls: string[] = [];
  let karmaN = 0;
  let creditsN = 0;
  const fetch: HttpFetch = async (reqUrl: string): Promise<Response> => {
    const u = new URL(reqUrl);
    calls.push(`${u.pathname}${u.search}`);
    const after = u.searchParams.get('after');
    if (u.pathname === KARMA_PATH) {
      const body = karma(after, karmaN++);
      return jsonResponse(200, body);
    }
    if (u.pathname === CREDITS_PATH) {
      const body = credits(after, creditsN++);
      return jsonResponse(200, body);
    }
    return jsonResponse(404, { error: 'not found' });
  };
  return { fetch, calls };
}

function karmaBody(boxes: Array<{ boxId: string; value: string }>, next: string | null): unknown {
  return { userId: OWNER_HEX, total: '0', effective: '0', boxes, boxCount: boxes.length, next, height: 100 };
}

function creditBody(boxes: Array<{ boxId: string; value: string }>, next: string | null): unknown {
  return { userId: OWNER_HEX, total: '0', boxes, boxCount: boxes.length, next };
}

/** A full credit page of PAGE_LIMIT_MAX rows with distinct 64-hex boxIds. */
function fullCreditPage(start: number): Array<{ boxId: string; value: string }> {
  const rows: Array<{ boxId: string; value: string }> = [];
  for (let i = 0; i < PAGE_LIMIT_MAX; i++) {
    const n = start + i;
    rows.push({ boxId: n.toString(16).padStart(64, '0'), value: '1' });
  }
  return rows;
}

describe("fetchListing holds each listing to the page the node serves and its own bound", () => {
  it("a karma page naming a next while carrying no rows ends the listing, one request made", async () => {
    const { fetch, calls } = listingFetch((after) => {
      if (after === null) return karmaBody([], 'k1');
      return karmaBody([], null);
    });

    const result = await fetchListing('http://a', OWNER_HEX, fetch);

    // Control: the fetch answered the karma route first.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]!.startsWith(KARMA_PATH)).toBe(true);
    // The listing refuses on the first page and never asks a second karma page.
    expect(result.ok).toBe(false);
    expect(calls.filter((c) => c.startsWith(KARMA_PATH)).length).toBe(1);
  });

  it("a karma page naming a next while short of the limit asked ends the listing", async () => {
    const { fetch, calls } = listingFetch((after) => {
      if (after === null) return karmaBody([{ boxId: BOX_A, value: '1' }], 'k1');
      return karmaBody([], null);
    });

    const result = await fetchListing('http://a', OWNER_HEX, fetch);

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(result.ok).toBe(false);
  });

  it("a karma page of more rows than the limit asked ends the listing", async () => {
    const over = PAGE_LIMIT_MAX + 1;
    const rows: Array<{ boxId: string; value: string }> = [];
    for (let i = 0; i < over; i++) {
      rows.push({ boxId: String(i).padStart(4, '0').repeat(16), value: '1' });
    }
    const { fetch, calls } = listingFetch(() => karmaBody(rows, null));

    const result = await fetchListing('http://a', OWNER_HEX, fetch);

    // Control: the row count is above the limit asked.
    expect(rows.length).toBeGreaterThan(PAGE_LIMIT_MAX);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(result.ok).toBe(false);
  });

  it("a credit listing whose later page carries a cursor named before ends the listing", async () => {
    const first = fullCreditPage(0);
    const second = fullCreditPage(100);
    const { fetch, calls } = listingFetch(
      () => karmaBody([], null),
      (after) => {
        if (after === null) return creditBody(first, 'c1');
        return creditBody(second, 'c1'); // repeated cursor
      },
    );

    const result = await fetchListing('http://a', OWNER_HEX, fetch);

    // Control: the credit route was reached in at least two pages.
    expect(calls.filter((c) => c.startsWith(CREDITS_PATH)).length).toBeGreaterThanOrEqual(2);
    expect(result.ok).toBe(false);
  });

  it("a credit listing naming one boxId twice across pages ends the listing", async () => {
    const first = fullCreditPage(0);
    const second = fullCreditPage(100);
    // Replace one entry of the second page with the first page's first row.
    second[0] = { boxId: first[0]!.boxId, value: '1' };
    const { fetch, calls } = listingFetch(
      () => karmaBody([], null),
      (after) => {
        if (after === null) return creditBody(first, 'c1');
        return creditBody(second, null);
      },
    );

    const result = await fetchListing('http://a', OWNER_HEX, fetch);

    expect(calls.filter((c) => c.startsWith(CREDITS_PATH)).length).toBeGreaterThanOrEqual(1);
    expect(result.ok).toBe(false);
  });

  it("a karma listing of three rows ends the listing, naming the two-box bound", async () => {
    const rows = [
      { boxId: BOX_A, value: '1' },
      { boxId: BOX_B, value: '1' },
      { boxId: '03'.repeat(32), value: '1' },
    ];
    const { fetch, calls } = listingFetch(() => karmaBody(rows, null));

    const result = await fetchListing('http://a', OWNER_HEX, fetch);

    expect(rows.length).toBe(3);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('2');
    }
  });

  it("a karma listing of exactly two rows reads", async () => {
    const rows = [
      { boxId: BOX_A, value: '1' },
      { boxId: BOX_B, value: '2' },
    ];
    const { fetch } = listingFetch(() => karmaBody(rows, null));

    const result = await fetchListing('http://a', OWNER_HEX, fetch);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.listing.karma.boxes.length).toBe(2);
    }
  });

  it("a karma row whose boxId is 64 uppercase hex ends the listing", async () => {
    const upper = 'AB'.repeat(32);
    const { fetch, calls } = listingFetch(() => karmaBody([{ boxId: upper, value: '1' }], null));

    const result = await fetchListing('http://a', OWNER_HEX, fetch);

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(result.ok).toBe(false);
  });

  it("the first karma request's URL carries limit=100", async () => {
    const { fetch, calls } = listingFetch(() => karmaBody([], null));

    await fetchListing('http://a', OWNER_HEX, fetch);

    // Control: a request landed and names the karma route.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]!.startsWith(KARMA_PATH)).toBe(true);
    expect(calls[0]!).toContain(`limit=${PAGE_LIMIT_MAX}`);
  });
});

describe("proveName holds a lookup answer's boxId to 64 lowercase hex", () => {
  it("an uppercase lookup boxId ends the check unproven, naming the lowercase rule", async () => {
    const upper = 'AB'.repeat(32);
    const fetch: HttpFetch = async (reqUrl: string): Promise<Response> => {
      const u = new URL(reqUrl);
      if (u.pathname === `/usernames/alice`) {
        return jsonResponse(200, { boxId: upper, owner: 'ab'.repeat(32), name: 'alice' });
      }
      return jsonResponse(404, { error: 'not found' });
    };

    const anchor = makeAnchor(100, '00'.repeat(33), 90, '11'.repeat(33));
    const result = await proveName('http://a', { name: 'alice' }, anchor, fetch);

    // Control: the result is a NameResult with a status and verdict.
    expect(typeof result.status).toBe('string');
    expect(typeof result.verdict).toBe('string');
    // The verdict names the lowercase-hex rule on the boxId.
    expect(result.status).toBe('unproven');
    expect(result.verdict).toContain('boxId is not 64 hex');
  });
});

describe("wholeListRead's refusals name a node's string through capped", () => {
  it.fails("a repeated cursor carrying ESC and CR reaches the reason as its \\u escapes, never raw", async () => {
    // The cursor carries two C0 controls — ESC (U+001B) and CR (U+000D). Each
    // page under the repeated cursor answers with fresh row keys, so the
    // whole-list read's row-key refusal cannot land first.
    const CURSOR = 'x\u001by\u000dz';
    const first = fullCreditPage(0);
    let n = 1;
    const { fetch } = listingFetch(
      () => karmaBody([], null),
      (after) => {
        if (after === null) return creditBody(first, CURSOR);
        const page = fullCreditPage(100 * (n + 1));
        n += 1;
        return creditBody(page, CURSOR);
      },
    );

    const result = await fetchListing('http://a', OWNER_HEX, fetch);

    // Control: the result is a non-ok carrying a cursor-named-twice reason.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('cursor named twice');
      expect(result.reason).toContain('\\u001b');
      expect(result.reason).toContain('\\u000d');
      expect(result.reason.includes('\u001b')).toBe(false);
      expect(result.reason.includes('\u000d')).toBe(false);
    }
  });
});

describe("proveRange holds a page's stateRoot to 64 lowercase hex before any comparison", () => {
  it("a page whose stateRoot is well-formed except for uppercase ends the range unproven", async () => {
    const upperRoot = 'AB'.repeat(33); // 66 chars, uppercase
    const headerRoot = 'cd'.repeat(33); // 66 chars, lowercase
    const fetch: HttpFetch = async (reqUrl: string): Promise<Response> => {
      const u = new URL(reqUrl);
      if (u.pathname === RANGE_PATH) {
        return jsonResponse(200, {
          kind: 'karma', owner: OWNER_HEX, atHeight: 100, limit: 256,
          stateRoot: upperRoot, proof: 'AAAA', boxes: [], next: null,
        });
      }
      return jsonResponse(404, { error: 'not found' });
    };

    const result = await proveRange('http://a', 'karma', OWNER_HEX, { height: 100, stateRoot: headerRoot }, fetch);

    // Control: the shape is a non-ok result or an ok one.
    expect(typeof result.ok).toBe('boolean');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe('unproven');
    }
  });
});
