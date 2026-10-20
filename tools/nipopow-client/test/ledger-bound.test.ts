// WEB_INTERFACE → The extension → "The verified figures" — a credit ledger is
// read up to LEDGER_READ_MAX boxes; a karma ledger up to the two-box bound
// (NODE_INTERFACE → Karma transition rules → "An identity holds at most two
// karma boxes"); a range that runs past LEDGER_READ_MAX, at either height,
// ends that ledger's read unproven (CONSTANTS → Client reads).

import { describe, it, expect } from 'vitest';
import { hexToBytes, PAGE_LIMIT_MAX } from '@dagsocial/types';
import type { AnyBox, UserId } from '@dagsocial/types';
import type { HoldingKind } from '@dagsocial/consensus';
import { proveRange } from '../src/holdings.js';
import { fetchListing, proveFigures } from '../src/boxes.js';
import { makeAnchor } from './helpers.js';
import { profileFor } from '@dagsocial/types';
import { KARMA_LISTING_MAX, LEDGER_READ_MAX } from '@dagsocial/node-reads';
import type { HttpFetch } from '@dagsocial/node-reads';
import {
  buildHoldingsFixture,
  jsonResponse,
  karmaBoxFor,
  rangeAnswerFromProver,
} from './helpers.js';

const OWNER_HEX = 'ab'.repeat(32);
const OWNER = hexToBytes(OWNER_HEX) as UserId;
const HEIGHT = 100;

interface Routed {
  fetch: HttpFetch;
  calls: string[];
}

// A fetch that answers the range route from `prover`, with a configurable
// per-page cap: an honest node holds page size to its own limit, below the
// client's ask. The handler decodes the query params, performs the proof call,
// and returns the JSON. `calls` is the list of request URLs for assertions.
function rangeFetch(opts: {
  url: string;
  prover: Parameters<typeof rangeAnswerFromProver>[0];
  stateRoot: string;
  perPage: number;
}): Routed {
  const calls: string[] = [];
  const fetch: HttpFetch = async (reqUrl: string): Promise<Response> => {
    const u = new URL(reqUrl);
    calls.push(`${u.pathname}${u.search}`);
    const match = u.pathname.match(/^\/api\/v1\/range\/([a-z]+)\/([0-9a-f]{64})$/);
    if (!match) return jsonResponse(404, { error: 'not found' });
    const kind = match[1] as HoldingKind;
    const ownerHex = match[2]!;
    const atHeight = Number(u.searchParams.get('atHeight') ?? HEIGHT);
    const fromHex = u.searchParams.get('from');
    const from = fromHex === null ? null : hexToBytes(fromHex);
    return jsonResponse(
      200,
      rangeAnswerFromProver(
        opts.prover,
        opts.stateRoot,
        atHeight,
        kind,
        hexToBytes(ownerHex) as UserId,
        from,
        opts.perPage,
      ),
    );
  };
  return { fetch, calls };
}

describe('proveRange — a range past the bound ends unproven, the verdict naming the bound', () => {
  // The run bounds a range at the extension's own `maxBoxes`. A fixture of 11
  // boxes against a bound of 10 lets the ledger overflow in one request, with
  // the test harness holding the proof-generation cost well under a second.
  // The bound is passed as a function argument — `LEDGER_READ_MAX` stays the
  // production default (CONSTANTS → Client reads).
  const BOUND = 10;

  it('more than the bound boxes in one page ends the range unproven', async () => {
    const boxes: AnyBox[] = [];
    for (let i = 0; i < BOUND + 1; i++) boxes.push(karmaBoxFor(OWNER, 1n + BigInt(i), i + 1));
    const { prover, stateRoot } = buildHoldingsFixture({ boxes });
    const { fetch, calls } = rangeFetch({ url: 'http://a', prover, stateRoot, perPage: 256 });

    const result = await proveRange('http://a', 'karma', OWNER_HEX, { height: HEIGHT, stateRoot }, fetch, BOUND);

    // Control: the fixture holds one more box than the bound takes in.
    expect(boxes.length).toBe(BOUND + 1);
    // Control: the client did send a request for the range.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // The range refuses — the node served past the bound.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe('unproven');
      expect(result.verdict).toContain(String(BOUND));
    }
  });

  it('a page at the bound whose next still stands ends the range unproven, no further page asked', async () => {
    // 11 boxes, served half the bound a page: the first page brings 5 boxes,
    // the second 5 more (total at the bound), with the eleventh box pointed at
    // by the authenticated `next` — a next still standing at the bound.
    const boxes: AnyBox[] = [];
    for (let i = 0; i < BOUND + 1; i++) boxes.push(karmaBoxFor(OWNER, 1n + BigInt(i), i + 1));
    const { prover, stateRoot } = buildHoldingsFixture({ boxes });
    const PER_PAGE = BOUND / 2;
    const { fetch, calls } = rangeFetch({ url: 'http://a', prover, stateRoot, perPage: PER_PAGE });

    const result = await proveRange('http://a', 'karma', OWNER_HEX, { height: HEIGHT, stateRoot }, fetch, BOUND);

    // Control: the fixture is one over the bound.
    expect(boxes.length).toBe(BOUND + 1);
    // Control: the client sent at least the first range request.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // The range refuses, with no third page asked.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe('unproven');
      expect(result.verdict).toContain(String(BOUND));
      // Two pages carried the bound in boxes; the third page is not asked.
      expect(calls.length).toBe(2);
    }
  });
});

describe('proveRange — a range at exactly the bound reads whole', () => {
  it('exactly the bound reads whole', async () => {
    const BOUND = 10;
    const boxes: AnyBox[] = [];
    for (let i = 0; i < BOUND; i++) boxes.push(karmaBoxFor(OWNER, 1n + BigInt(i), i + 1));
    const { prover, stateRoot } = buildHoldingsFixture({ boxes });
    const { fetch } = rangeFetch({ url: 'http://a', prover, stateRoot, perPage: 256 });

    const result = await proveRange('http://a', 'karma', OWNER_HEX, { height: HEIGHT, stateRoot }, fetch, BOUND);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.boxes.length).toBe(BOUND);
  });
});

describe('fetchListing — the karma listing is held at the two-box bound, the credit listing at maxBoxes', () => {
  const BOUND = 10;

  function makeListingFetch(opts: {
    karmaPagesByCursor: Map<string | null, { boxes: Array<{ boxId: string; value: string }>; next: string | null }>;
    creditPagesByCursor: Map<string | null, { boxes: Array<{ boxId: string; value: string }>; next: string | null }>;
  }): Routed {
    const calls: string[] = [];
    const fetch: HttpFetch = async (reqUrl: string): Promise<Response> => {
      const u = new URL(reqUrl);
      calls.push(`${u.pathname}${u.search}`);
      const after = u.searchParams.get('after');
      if (u.pathname === `/karma/${OWNER_HEX}`) {
        const page = opts.karmaPagesByCursor.get(after);
        if (page === undefined) return jsonResponse(404, { error: 'not found' });
        return jsonResponse(200, { userId: OWNER_HEX, boxes: page.boxes, next: page.next, height: 100, effective: '0' });
      }
      if (u.pathname === `/credits/${OWNER_HEX}`) {
        const page = opts.creditPagesByCursor.get(after);
        if (page === undefined) return jsonResponse(404, { error: 'not found' });
        return jsonResponse(200, { userId: OWNER_HEX, boxes: page.boxes, next: page.next });
      }
      return jsonResponse(404, { error: 'not found' });
    };
    return { fetch, calls };
  }

  it('three karma rows end the karma listing, with the credits route unread', async () => {
    const rows = [
      { boxId: '01'.repeat(32), value: '1' },
      { boxId: '02'.repeat(32), value: '1' },
      { boxId: '03'.repeat(32), value: '1' },
    ];

    const { fetch, calls } = makeListingFetch({
      karmaPagesByCursor: new Map([[null, { boxes: rows, next: null }]]),
      creditPagesByCursor: new Map([[null, { boxes: [], next: null }]]),
    });

    const result = await fetchListing('http://a', OWNER_HEX, fetch, BOUND);

    // Control: three rows served, over the two-box bound.
    expect(rows.length).toBeGreaterThan(KARMA_LISTING_MAX);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('karma');
      expect(result.reason).toContain(String(KARMA_LISTING_MAX));
      // The credits route is not reached.
      expect(calls.every((c) => c.includes('/karma/'))).toBe(true);
    }
  });

  it('a credit listing past the bound fails, naming the route and the bound', async () => {
    const credits = [] as Array<{ boxId: string; value: string }>;
    for (let i = 0; i < BOUND + 1; i++) credits.push({ boxId: i.toString(16).padStart(64, '0'), value: '1' });

    const { fetch, calls } = makeListingFetch({
      karmaPagesByCursor: new Map([[null, { boxes: [], next: null }]]),
      creditPagesByCursor: new Map([[null, { boxes: credits, next: null }]]),
    });

    const result = await fetchListing('http://a', OWNER_HEX, fetch, BOUND);

    // Control: the karma listing was fetched before the credits one.
    expect(calls[0]!.startsWith(`/karma/${OWNER_HEX}`)).toBe(true);
    // Control: the credits listing carries more than the bound takes.
    expect(credits.length).toBe(BOUND + 1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('credits');
      expect(result.reason).toContain(String(BOUND));
    }
  });

  it('a listing of two karma rows and BOUND credit rows reads', async () => {
    const karma = [
      { boxId: '01'.repeat(32), value: '1' },
      { boxId: '02'.repeat(32), value: '1' },
    ];
    const credits = [] as Array<{ boxId: string; value: string }>;
    for (let i = 0; i < BOUND; i++) credits.push({ boxId: (100 + i).toString(16).padStart(64, '0'), value: '1' });

    const { fetch } = makeListingFetch({
      karmaPagesByCursor: new Map([[null, { boxes: karma, next: null }]]),
      creditPagesByCursor: new Map([[null, { boxes: credits, next: null }]]),
    });

    const result = await fetchListing('http://a', OWNER_HEX, fetch, BOUND);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.listing.karma.boxes.length).toBe(KARMA_LISTING_MAX);
      expect(result.listing.credits!.boxes.length).toBe(BOUND);
    }
  });
});

// WEB_INTERFACE → The extension → "The verified figures" — the default on the
// credit listing is `LEDGER_READ_MAX`: a caller that passes no `maxBoxes`
// reads credits up to that bound (CONSTANTS → Client reads). The cases below
// pin that default by never passing the argument. The karma listing has its
// own protocol bound of two, with no `maxBoxes` seam
// (NODE_INTERFACE → Karma transition rules → "An identity holds at most two
// karma boxes").
describe("fetchListing's default on the credit listing holds at LEDGER_READ_MAX", () => {
  // Honest keyset pages of PAGE_LIMIT_MAX. Each page carries a decimal
  // `after` cursor the next request echoes; each row is a 64-hex id and a
  // decimal value.
  const PAGE = PAGE_LIMIT_MAX;

  function makeCreditFetch(totalRows: number): { fetch: HttpFetch; calls: string[] } {
    const karmaPath = `/karma/${OWNER_HEX}`;
    const creditsPath = `/credits/${OWNER_HEX}`;
    const calls: string[] = [];
    const fetch: HttpFetch = async (reqUrl: string): Promise<Response> => {
      const u = new URL(reqUrl);
      calls.push(`${u.pathname}${u.search}`);
      if (u.pathname === karmaPath) {
        return new Response(
          JSON.stringify({ userId: OWNER_HEX, boxes: [], next: null, height: 1, effective: '0' }),
          { status: 200 },
        );
      }
      if (u.pathname === creditsPath) {
        const afterParam = u.searchParams.get('after');
        const start = afterParam === null ? 0 : Number(afterParam);
        const end = Math.min(start + PAGE, totalRows);
        const boxes: Array<{ boxId: string; value: string }> = [];
        for (let i = start; i < end; i++) {
          boxes.push({ boxId: i.toString(16).padStart(64, '0'), value: '1' });
        }
        const next = end < totalRows ? String(end) : null;
        return new Response(
          JSON.stringify({ userId: OWNER_HEX, boxes, next }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    };
    return { fetch, calls };
  }

  it("LEDGER_READ_MAX + 1 credit rows served in honest pages fail with LEDGER_READ_MAX named", async () => {
    const { fetch, calls } = makeCreditFetch(LEDGER_READ_MAX + 1);

    // Default `maxBoxes` — no fourth argument.
    const result = await fetchListing('http://a', OWNER_HEX, fetch);

    // Control: the client sent the karma page first and then at least one credit page.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]!.startsWith(`/karma/${OWNER_HEX}`)).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('credits');
      expect(result.reason).toContain('10000');
    }
  });

  it('LEDGER_READ_MAX credit rows served in honest pages read whole', async () => {
    const { fetch, calls } = makeCreditFetch(LEDGER_READ_MAX);

    const result = await fetchListing('http://a', OWNER_HEX, fetch);

    // Control: one karma page plus one credit page per PAGE_LIMIT_MAX.
    expect(calls.length).toBe(1 + Math.ceil(LEDGER_READ_MAX / PAGE));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.listing.credits!.boxes.length).toBe(LEDGER_READ_MAX);
  });
});

describe("proveRange's default bounds the range at LEDGER_READ_MAX", () => {
  // LEDGER_READ_MAX + 1 real karma boxes under one owner: the fixture builds
  // a BatchAVLProver with every box seeded through consensus' write path,
  // then paging generates proofs page by page.
  it('a real range of LEDGER_READ_MAX + 1 boxes ends unproven, no maxBoxes passed', async () => {
    const boxes: AnyBox[] = [];
    for (let i = 0; i < LEDGER_READ_MAX + 1; i++) {
      boxes.push(karmaBoxFor(OWNER, 1n + BigInt(i), i + 1));
    }
    const { prover, stateRoot } = buildHoldingsFixture({ boxes });
    const { fetch } = rangeFetch({ url: 'http://a', prover, stateRoot, perPage: 256 });

    // Default `maxBoxes` — no sixth argument.
    const result = await proveRange('http://a', 'karma', OWNER_HEX, { height: HEIGHT, stateRoot }, fetch);

    expect(boxes.length).toBe(LEDGER_READ_MAX + 1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe('unproven');
      expect(result.verdict).toContain('10000');
    }
  }, 60_000);
});

describe("proveFigures's default threads LEDGER_READ_MAX to proveRange", () => {
  it("a real karma range of LEDGER_READ_MAX + 1 boxes under proveFigures's default leaves karma.holdings 'unproven'", async () => {
    const boxes: AnyBox[] = [];
    for (let i = 0; i < LEDGER_READ_MAX + 1; i++) {
      boxes.push(karmaBoxFor(OWNER, 1n + BigInt(i), i + 1));
    }
    const { prover, stateRoot } = buildHoldingsFixture({ boxes });
    const { fetch } = rangeFetch({ url: 'http://a', prover, stateRoot, perPage: 256 });

    const anchor = makeAnchor(HEIGHT, stateRoot, HEIGHT, stateRoot);
    const listing = { karma: { boxes: [], height: HEIGHT, effective: '0' }, credits: null };

    // Default `maxBoxes` — no seventh argument.
    const result = await proveFigures('http://a', OWNER_HEX, listing, anchor, profileFor('devnet'), fetch);

    expect(result.karma.holdings).toBe('unproven');
    expect(result.karma.holdingsVerdict).toContain('10000');
    expect(result.failed).toBe(true);
  }, 60_000);
});
