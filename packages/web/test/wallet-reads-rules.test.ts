// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PAGE_LIMIT_MAX } from '@dagsocial/types';
import { readBuildContext, readCreditContext } from '../src/wallet/reads';
import { NodeClient, PageError } from '../src/api/client';
import { jsonResponse } from './honest-page';
import { karmaResult } from './karma-fixture';

// WEB_INTERFACE → Reading a node's answer → "A whole-list read is bounded":
// a /karma listing holds at most two boxes (`NODE_INTERFACE → Karma transition
// rules → "An identity holds at most two karma boxes"`), and every other list
// is bounded by `LEDGER_READ_MAX` (`CONSTANTS → Client reads`). A listing past
// its bound is a refused listing, never a figure read from part of it — the
// reader's own figures past the bound read as a failed read.

const AUTHOR = 'aa'.repeat(32);

function statusBody(): Record<string, unknown> {
  return {
    networkType: 'testnet', blockHeight: 5333, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}

function karmaBody(boxes: Array<{ boxId: string; value: string }>, next: string | null): Record<string, unknown> {
  return { ...karmaResult({ userId: AUTHOR, boxes, boxCount: boxes.length, next, height: 5333 }), next };
}

function creditsBody(boxes: Array<{ boxId: string; value: string }>, next: string | null): Record<string, unknown> {
  return { userId: AUTHOR, total: '0', boxes, boxCount: boxes.length, next };
}

/** A /karma box id formed from a two-hex seed, repeated to 64 chars. */
function kBox(seed: string): string {
  return seed.padStart(2, '0').repeat(32);
}

interface FetchCall {
  url: URL;
}

function script(answers: Record<string, (nth: number) => unknown>): FetchCall[] {
  const calls: FetchCall[] = [];
  const counts: Record<string, number> = {};
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const u = new URL(String(input), 'http://node.test');
    calls.push({ url: u });
    const path = u.pathname;
    const route = path.startsWith('/karma/') ? 'karma'
      : path.startsWith('/credits/') ? 'credits'
      : path === '/status' ? 'status'
      : null;
    if (route === null) throw new Error(`no scripted route for ${u.href}`);
    counts[route] = (counts[route] ?? 0) + 1;
    const answer = answers[route];
    if (!answer) throw new Error(`no scripted answer for ${route}`);
    return jsonResponse(answer(counts[route]!));
  }));
  return calls;
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readBuildContext — the /karma whole-list is bounded by two boxes', () => {
  it('a /karma of three boxes refuses readBuildContext (KARMA_LISTING_MAX)', async () => {
    const calls = script({
      karma: () => karmaBody([
        { boxId: kBox('11'), value: '10' },
        { boxId: kBox('22'), value: '20' },
        { boxId: kBox('33'), value: '30' },
      ], null),
      status: () => statusBody(),
    });
    // The call enters through the real reader on a real NodeClient (a 2xx body
    // the parser accepts): three boxes on one page is a valid page the node
    // could serve, but the whole-list rule refuses the listing (two is the
    // protocol's maximum).
    expect(calls).toHaveLength(0); // control: no request has left yet
    const run = readBuildContext(new NodeClient(() => ''), AUTHOR);
    await expect(run).rejects.toBeInstanceOf(PageError);
  });
});

describe('readCreditContext — the credits whole-list is bounded by LEDGER_READ_MAX', () => {
  it('a credits chain of fresh full pages past LEDGER_READ_MAX refuses after at most ⌈LEDGER_READ_MAX / PAGE_LIMIT_MAX⌉ + 1 requests', async () => {
    // Every page carries exactly PAGE_LIMIT_MAX unique rows beside a non-null
    // next (the honest-page shape: a page beside a next carries exactly the
    // limit asked — WEB_INTERFACE → Reading a node's answer → "Every page is
    // held to the page the node serves"). The fake has a TERMINAL page past
    // the bound so the current (unbounded) loop answers rather than running
    // forever; the bounded rule refuses before reaching it.
    const uniquePrefix = (page: number, row: number): string => {
      const hex = ((page * 1000 + row) >>> 0).toString(16).padStart(8, '0');
      return `${hex}${'00'.repeat(28)}`; // 8 + 56 = 64 hex chars
    };
    const TERMINAL_PAGE = 102; // one past ⌈10000/100⌉ + 1
    const makePage = (page: number): Record<string, unknown> => {
      const boxes = Array.from({ length: page === TERMINAL_PAGE ? 1 : PAGE_LIMIT_MAX }, (_, row) => ({
        boxId: uniquePrefix(page, row), value: '1',
      }));
      return creditsBody(boxes, page === TERMINAL_PAGE ? null : `c-${page}`);
    };
    const calls = script({
      credits: (nth) => makePage(nth),
      status: () => statusBody(),
    });
    expect(calls).toHaveLength(0); // control
    const run = readCreditContext(new NodeClient(() => ''), AUTHOR);
    await expect(run).rejects.toBeInstanceOf(PageError);
    // ⌈10000 / 100⌉ + 1 = 101 at the ceiling (and in practice fewer: the loop
    // refuses on the first page that stands at the bound with a next).
    const creditsCalls = calls.filter((c) => c.url.pathname.startsWith('/credits/'));
    expect(creditsCalls.length).toBeLessThanOrEqual(101);
  });
});

describe('the whole-list rules refuse a repeat and a duplicate key', () => {
  it('a repeated cursor across two pages refuses the credits whole-list read', async () => {
    const uniquePrefix = (page: number, row: number): string => {
      const hex = ((page * 1000 + row) >>> 0).toString(16).padStart(8, '0');
      return `${hex}${'00'.repeat(28)}`;
    };
    // Pages 1 and 2 both name next='cursor-same' (the repeat). A terminal
    // page past them so the current unbounded loop ends — the rule refuses
    // on page 2.
    const page = (nth: number): Record<string, unknown> => ({
      userId: AUTHOR, total: '0',
      boxes: nth >= 3
        ? [{ boxId: `${'ff'.repeat(32)}`, value: '1' }]
        : Array.from({ length: PAGE_LIMIT_MAX }, (_, row) => ({
            boxId: uniquePrefix(nth, row), value: '1',
          })),
      boxCount: nth >= 3 ? 1 : PAGE_LIMIT_MAX,
      next: nth >= 3 ? null : 'cursor-same',
    });
    const calls = script({
      credits: (nth) => page(nth),
      status: () => statusBody(),
    });
    expect(calls).toHaveLength(0); // control
    const run = readCreditContext(new NodeClient(() => ''), AUTHOR);
    await expect(run).rejects.toBeInstanceOf(PageError);
    const creditsCalls = calls.filter((c) => c.url.pathname.startsWith('/credits/'));
    expect(creditsCalls.length).toBeLessThanOrEqual(3);
  });

  it('a box id named on two pages refuses the credits whole-list read', async () => {
    // The duplicate: page 2 names a boxId page 1 already took. Page 3 is a
    // terminal page so the current unbounded loop ends — the rule refuses on
    // page 2.
    const uniquePrefix = (page: number, row: number): string => {
      const hex = ((page * 1000 + row) >>> 0).toString(16).padStart(8, '0');
      return `${hex}${'00'.repeat(28)}`;
    };
    const SHARED = `${'ab'.padStart(8, '0')}${'00'.repeat(28)}`;
    const page1Boxes = Array.from({ length: PAGE_LIMIT_MAX }, (_, row) => ({
      boxId: row === 0 ? SHARED : uniquePrefix(1, row), value: '1',
    }));
    const page2Boxes = Array.from({ length: PAGE_LIMIT_MAX }, (_, row) => ({
      boxId: row === 0 ? SHARED : uniquePrefix(2, row), value: '1',
    }));
    const calls = script({
      credits: (nth) => nth === 1
        ? { userId: AUTHOR, total: '0', boxes: page1Boxes, boxCount: PAGE_LIMIT_MAX, next: 'cursor-a' }
        : nth === 2
          ? { userId: AUTHOR, total: '0', boxes: page2Boxes, boxCount: PAGE_LIMIT_MAX, next: 'cursor-b' }
          : { userId: AUTHOR, total: '0', boxes: [{ boxId: `${'ff'.repeat(32)}`, value: '1' }], boxCount: 1, next: null },
      status: () => statusBody(),
    });
    expect(calls).toHaveLength(0); // control
    const run = readCreditContext(new NodeClient(() => ''), AUTHOR);
    await expect(run).rejects.toBeInstanceOf(PageError);
  });
});
