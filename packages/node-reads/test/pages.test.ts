// WEB_INTERFACE → Reading a node's answer → "Every page is held to the page
// the node serves" and → "A whole-list read is bounded" — the two rules this
// file holds the package's new functions to, edge by edge.

import { describe, it, expect } from 'vitest';
import {
  KARMA_LISTING_MAX,
  parsePage,
  wholeListRead,
} from '../src/pages.js';
import type { PageResult } from '../src/pages.js';

interface Row {
  k: string;
}

describe('parsePage — the shape of one page the node serves', () => {
  it('a page at the limit asked with next null reads', () => {
    const rows: Row[] = [{ k: 'a' }, { k: 'b' }];
    const r = parsePage<Row>({ boxes: rows, next: null }, 'boxes', 2);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rows).toEqual(rows);
      expect(r.next).toBe(null);
    }
  });

  it('a page at the limit asked with next non-null reads', () => {
    const rows: Row[] = [{ k: 'a' }, { k: 'b' }];
    const r = parsePage<Row>({ boxes: rows, next: 'k1' }, 'boxes', 2);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.next).toBe('k1');
  });

  it('a page of limit minus one with next null reads (a list ends short)', () => {
    const r = parsePage<Row>({ boxes: [{ k: 'a' }], next: null }, 'boxes', 2);
    expect(r.ok).toBe(true);
  });

  it('a page of limit minus one with a non-null next is not a page', () => {
    const r = parsePage<Row>({ boxes: [{ k: 'a' }], next: 'k1' }, 'boxes', 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('beside a next');
  });

  it('a page of limit plus one is not a page', () => {
    const r = parsePage<Row>({ boxes: [{ k: 'a' }, { k: 'b' }, { k: 'c' }], next: null }, 'boxes', 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('over the 2');
  });

  it("a body that is not an object is not a page", () => {
    expect(parsePage(null, 'boxes', 2).ok).toBe(false);
    expect(parsePage([], 'boxes', 2).ok).toBe(false);
    expect(parsePage(42, 'boxes', 2).ok).toBe(false);
  });

  it("a body with a listName that is not an array is not a page", () => {
    const r = parsePage({ boxes: 'nope', next: null }, 'boxes', 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('boxes is not an array');
  });

  it("a next that is the empty string is not a page", () => {
    const r = parsePage({ boxes: [], next: '' }, 'boxes', 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('empty string');
  });

  it("a next that carries a lone surrogate is not a page", () => {
    // U+D800 by itself — a high surrogate with no low; iterating a string yields
    // the pair as one code point and a lone one on its own.
    const lone = '\uD800';
    const r = parsePage({ boxes: [{ k: 'a' }, { k: 'b' }], next: lone }, 'boxes', 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('lone surrogate');
  });

  it("a next that is a number is not a page", () => {
    const r = parsePage({ boxes: [], next: 42 }, 'boxes', 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('next is neither null nor a string');
  });
});

interface MakePagesOpts {
  pages: Array<{ rows: Row[]; next: string | null }>;
}

function fetchPagesFrom(opts: MakePagesOpts): {
  fetchPage: (after: string | null, limit: number) => Promise<PageResult<Row>>;
  calls: Array<{ after: string | null; limit: number }>;
} {
  const calls: Array<{ after: string | null; limit: number }> = [];
  let i = 0;
  const fetchPage = async (after: string | null, limit: number): Promise<PageResult<Row>> => {
    calls.push({ after, limit });
    const page = opts.pages[i++];
    if (page === undefined) return { ok: false, reason: 'past end' };
    return { ok: true, rows: page.rows, next: page.next };
  };
  return { fetchPage, calls };
}

describe('wholeListRead — the loop every whole-list read passes through', () => {
  it("reads every page until next is null, under the bound", async () => {
    const { fetchPage } = fetchPagesFrom({
      pages: [
        { rows: [{ k: 'a' }, { k: 'b' }], next: 'c1' },
        { rows: [{ k: 'c' }, { k: 'd' }], next: null },
      ],
    });
    const r = await wholeListRead<Row>({ fetchPage, keyOf: (x) => x.k, limit: 2, bound: 10 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows.map((x) => x.k)).toEqual(['a', 'b', 'c', 'd']);
  });

  it("asks the first page with after=null and limit=limit, then follows next", async () => {
    const { fetchPage, calls } = fetchPagesFrom({
      pages: [
        { rows: [{ k: 'a' }], next: 'c1' },
        { rows: [{ k: 'b' }], next: null },
      ],
    });
    await wholeListRead<Row>({ fetchPage, keyOf: (x) => x.k, limit: 100, bound: 10 });
    expect(calls[0]).toEqual({ after: null, limit: 100 });
    expect(calls[1]).toEqual({ after: 'c1', limit: 100 });
  });

  it("exactly the bound reads whole", async () => {
    const { fetchPage } = fetchPagesFrom({
      pages: [{ rows: [{ k: 'a' }, { k: 'b' }, { k: 'c' }], next: null }],
    });
    const r = await wholeListRead<Row>({ fetchPage, keyOf: (x) => x.k, limit: 3, bound: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows.length).toBe(3);
  });

  it("one row past the bound ends the listing", async () => {
    const { fetchPage } = fetchPagesFrom({
      pages: [{ rows: [{ k: 'a' }, { k: 'b' }, { k: 'c' }, { k: 'd' }], next: null }],
    });
    const r = await wholeListRead<Row>({ fetchPage, keyOf: (x) => x.k, limit: 10, bound: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('3-row bound');
      expect(r.reason).toContain('4 rows read');
    }
  });

  it("a page at the bound with a next still standing ends the listing, no further page asked", async () => {
    const { fetchPage, calls } = fetchPagesFrom({
      pages: [
        { rows: [{ k: 'a' }, { k: 'b' }], next: 'c1' },
        { rows: [{ k: 'c' }], next: null },
      ],
    });
    const r = await wholeListRead<Row>({ fetchPage, keyOf: (x) => x.k, limit: 2, bound: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('2-row bound');
      expect(r.reason).toContain('a next page still stands');
    }
    expect(calls.length).toBe(1);
  });

  it("a repeated cursor ends the listing", async () => {
    const { fetchPage, calls } = fetchPagesFrom({
      pages: [
        { rows: [{ k: 'a' }], next: 'c1' },
        { rows: [{ k: 'b' }], next: 'c1' }, // repeated cursor
        { rows: [{ k: 'c' }], next: null },
      ],
    });
    const r = await wholeListRead<Row>({ fetchPage, keyOf: (x) => x.k, limit: 1, bound: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('one cursor named twice');
      expect(r.reason).toContain('c1');
    }
    // The third page was never asked.
    expect(calls.length).toBe(2);
  });

  it("a repeated row key ends the listing", async () => {
    const { fetchPage } = fetchPagesFrom({
      pages: [
        { rows: [{ k: 'a' }], next: 'c1' },
        { rows: [{ k: 'a' }], next: null }, // same key as the first page
      ],
    });
    const r = await wholeListRead<Row>({ fetchPage, keyOf: (x) => x.k, limit: 1, bound: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('one row key named twice');
      expect(r.reason).toContain('a');
    }
  });

  it("a fetchPage refusal passes as the whole-list read's reason", async () => {
    const fetchPage = async (): Promise<PageResult<Row>> => ({ ok: false, reason: 'HTTP 500' });
    const r = await wholeListRead<Row>({ fetchPage, keyOf: (x) => x.k, limit: 2, bound: 10 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('HTTP 500');
  });
});

describe('KARMA_LISTING_MAX — the karma listing bound the protocol argues', () => {
  // NODE_INTERFACE → Karma transition rules → "An identity holds at most two
  // karma boxes" — the own box and the income box.
  it("is the number two, the protocol's own bound on the karma listing", () => {
    expect(KARMA_LISTING_MAX).toBe(2);
  });
});
