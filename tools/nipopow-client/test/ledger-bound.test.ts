// WEB_INTERFACE → The extension → "The verified figures" — a ledger is read up
// to LEDGER_READ_MAX boxes; a range that runs past it, at either height, ends
// that ledger's read unproven; the command line's listing is held to the same
// bound (CONSTANTS → Light client reads).

import { describe, it, expect } from 'vitest';
import { hexToBytes } from '@dagsocial/types';
import type { AnyBox, UserId } from '@dagsocial/types';
import type { HoldingKind } from '@dagsocial/consensus';
import { proveRange } from '../src/holdings.js';
import { fetchListing } from '../src/boxes.js';
import type { HttpFetch } from '../src/http.js';
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
  // production default (CONSTANTS → Light client reads).
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

describe('fetchListing — a listing past the bound fails the listing, no further page asked', () => {
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

  it('a karma listing past the bound fails, with the credits route unread', async () => {
    // Three karma pages of 5, 5, and 1 — totalling 11 rows, one past the
    // bound. The last page carries `next: null` so the current tree reads
    // the whole listing cleanly; the overflow refusal lands at the second
    // page the moment boxes hits the bound and `next` still stands.
    const rowsFirst = [] as Array<{ boxId: string; value: string }>;
    for (let i = 0; i < BOUND / 2; i++) rowsFirst.push({ boxId: String(i).padStart(2, '0').slice(-2).repeat(32), value: '1' });
    const rowsSecond = [] as Array<{ boxId: string; value: string }>;
    for (let i = 0; i < BOUND / 2; i++) rowsSecond.push({ boxId: String(50 + i).padStart(2, '0').slice(-2).repeat(32), value: '1' });
    const rowsThird = [{ boxId: '77'.repeat(32), value: '1' }];

    const { fetch, calls } = makeListingFetch({
      karmaPagesByCursor: new Map([
        [null, { boxes: rowsFirst, next: 'cursor-1' }],
        ['cursor-1', { boxes: rowsSecond, next: 'cursor-2' }],
        ['cursor-2', { boxes: rowsThird, next: null }],
      ]),
      creditPagesByCursor: new Map([[null, { boxes: [], next: null }]]),
    });

    const result = await fetchListing('http://a', OWNER_HEX, fetch, BOUND);

    // Control: the three served pages add up to over the bound.
    expect(rowsFirst.length + rowsSecond.length + rowsThird.length).toBeGreaterThan(BOUND);
    // Control: the client asked for at least the first karma page.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('karma');
      expect(result.reason).toContain(String(BOUND));
      // Only karma was asked — the credits route is not reached, so the two
      // pages here are the karma pages the overflow brought.
      expect(calls.length).toBe(2);
      expect(calls.every((c) => c.includes('/karma/'))).toBe(true);
    }
  });

  it('a credit listing past the bound fails, naming the route and the bound', async () => {
    const credits = [] as Array<{ boxId: string; value: string }>;
    for (let i = 0; i < BOUND + 1; i++) credits.push({ boxId: String(i).padStart(2, '0').slice(-2).repeat(32), value: '1' });

    const { fetch, calls } = makeListingFetch({
      karmaPagesByCursor: new Map([[null, { boxes: [], next: null }]]),
      creditPagesByCursor: new Map([[null, { boxes: credits, next: null }]]),
    });

    const result = await fetchListing('http://a', OWNER_HEX, fetch, BOUND);

    // Control: the karma listing was fetched before the credits one.
    expect(calls[0]).toBe(`/karma/${OWNER_HEX}`);
    // Control: the credits listing carries more than the bound takes.
    expect(credits.length).toBe(BOUND + 1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('credits');
      expect(result.reason).toContain(String(BOUND));
    }
  });

  it('a listing of exactly the bound reads', async () => {
    const karma = [] as Array<{ boxId: string; value: string }>;
    for (let i = 0; i < BOUND; i++) karma.push({ boxId: String(i).padStart(2, '0').slice(-2).repeat(32), value: '1' });
    const credits = [] as Array<{ boxId: string; value: string }>;
    for (let i = 0; i < BOUND; i++) credits.push({ boxId: String(100 + i).padStart(2, '0').slice(-2).repeat(32), value: '1' });

    const { fetch } = makeListingFetch({
      karmaPagesByCursor: new Map([[null, { boxes: karma, next: null }]]),
      creditPagesByCursor: new Map([[null, { boxes: credits, next: null }]]),
    });

    const result = await fetchListing('http://a', OWNER_HEX, fetch, BOUND);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.listing.karma.boxes.length).toBe(BOUND);
      expect(result.listing.credits!.boxes.length).toBe(BOUND);
    }
  });
});
