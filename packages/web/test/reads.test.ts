// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readBuildContext, readCreditContext } from '../src/wallet/reads';
import { NodeClient, PageError } from '../src/api/client';
import type { Api } from '../src/api/client';
import type { KarmaResult, KarmaBoxRow, StatusResult, CreditsResult, CreditBoxRow } from '../src/api/dto';
import { karmaResult } from './karma-fixture';
import { jsonResponse } from './honest-page';

// The order WEB_INTERFACE → "Reads before a write, in this order: `GET /karma/:key?pending=1` following `next`, then `GET /status`" states — /karma fully paged, THEN /status —
// is embodied here, not at call sites; the fake records call order so the
// test can see it.

const AUTHOR = 'aa'.repeat(32);
let calls: string[];

function karmaPage(boxes: KarmaBoxRow[], next: string | null): KarmaResult {
  return karmaResult({ userId: AUTHOR, boxes, boxCount: boxes.length, next, height: 5333 });
}

function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 5333, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}

function fakeReads(pages: KarmaResult[]): Pick<Api, 'karma' | 'status'> {
  let i = 0;
  return {
    karma: async (key, page) => {
      calls.push(`karma(${key},after=${page?.after ?? 'null'})`);
      return pages[i++]!;
    },
    status: async () => {
      calls.push('status');
      return statusResult();
    },
  };
}

beforeEach(() => {
  calls = [];
  localStorage.clear();
});

describe('readBuildContext — WEB_INTERFACE → "Reads before a write, in this order: `GET /karma/:key?pending=1` following `next`, then `GET /status`"', () => {
  it('reads /karma to the end of next, THEN /status, and assembles the context', async () => {
    const pages = [
      karmaPage([{ boxId: 'b1', value: '100' }], 'k1'),
      karmaPage([{ boxId: 'b2', value: '50' }], null),
    ];
    const ctx = await readBuildContext(fakeReads(pages), AUTHOR);
    // Every karma call precedes the single status call.
    expect(calls).toEqual([`karma(${AUTHOR},after=null)`, `karma(${AUTHOR},after=k1)`, 'status']);
    // The spendable view is the node's listing directly.
    expect(ctx.spendable).toEqual([{ boxId: 'b1', value: 100n }, { boxId: 'b2', value: 50n }]);
    expect(ctx.height).toBe(5333);
    expect(ctx.era).toBe(1);
    expect(ctx.author).toBe(AUTHOR);
  });
});

// --------------------------------------------------------------------------
// readCreditContext — the credit-side twin. Same order rule (boxes, then
// status), and a lock rule: `lockedUntilBlock > status.blockHeight` drops the
// box (the client is conservative by one block, since the node judges at
// tip + 1). `=== status.blockHeight` stays; `absent` (unlocked) stays.
// --------------------------------------------------------------------------

function creditsPage(boxes: CreditBoxRow[], next: string | null): CreditsResult {
  return { userId: AUTHOR, total: '0', boxes, boxCount: boxes.length, next };
}

function fakeCreditReads(pages: CreditsResult[]): Pick<Api, 'credits' | 'status'> {
  let i = 0;
  return {
    credits: async (key, page) => {
      calls.push(`credits(${key},after=${page?.after ?? 'null'})`);
      return pages[i++]!;
    },
    status: async () => {
      calls.push('status');
      return statusResult();
    },
  };
}

describe('readCreditContext — WEB_INTERFACE → The wallet ("A send reads the other ledger by the same rule")', () => {
  it('reads /credits to the end of next, THEN /status, and assembles the context', async () => {
    const pages = [
      creditsPage([{ boxId: 'c1', value: '100' }], 'k1'),
      creditsPage([{ boxId: 'c2', value: '50' }], null),
    ];
    const ctx = await readCreditContext(fakeCreditReads(pages), AUTHOR);
    expect(calls).toEqual([`credits(${AUTHOR},after=null)`, `credits(${AUTHOR},after=k1)`, 'status']);
    expect(ctx.spendable).toEqual([{ boxId: 'c1', value: 100n }, { boxId: 'c2', value: 50n }]);
  });

  it('the lock boundary — === height kept, height+1 dropped, absent kept', async () => {
    // status.blockHeight is 5333 (statusResult).
    const pages = [creditsPage([
      { boxId: 'c1', value: '100' },                        // absent — kept
      { boxId: 'c2', value: '50', lockedUntilBlock: 5333 }, // exactly at height — kept
      { boxId: 'c3', value: '25', lockedUntilBlock: 5334 }, // one past — dropped (client is conservative by one)
      { boxId: 'c4', value: '12', lockedUntilBlock: 1 },    // deep past — kept
    ], null)];
    const ctx = await readCreditContext(fakeCreditReads(pages), AUTHOR);
    expect(ctx.spendable.map((b) => b.boxId)).toEqual(['c1', 'c2', 'c4']);
  });
});

// ---------------------------------------------------------------------------
// The DTO reads the mark — WEB_INTERFACE → The wallet. A `/karma/:userId`
// answer with a marked box parses to a view that carries the mark; a bare
// row parses as the owner's own box. `income: false`, or any value but
// `true`, is a refused answer and not an unmarked box — the mark's domain is
// `true` or absent (TYPES_INTERFACE → KarmaBox). The rule rides in the
// `/karma` reader (WEB_INTERFACE → Reading a node's answer → "Every answer
// is rebuilt from its own fields"), so the case enters through `NodeClient`
// over a fake `fetch`.
// ---------------------------------------------------------------------------

describe("readBuildContext — the mark on each karma row", () => {
  it('a marked and an unmarked box parse to one own box and one income box', async () => {
    // The row with `income: true` reaches the view carrying the mark; the
    // bare row has no `income` key.
    const pages = [karmaPage(
      [
        { boxId: '00'.repeat(32), value: '50' },
        { boxId: '11'.repeat(32), value: '100', income: true } as unknown as KarmaBoxRow,
      ],
      null,
    )];
    const ctx = await readBuildContext(fakeReads(pages), AUTHOR);
    expect(ctx.spendable).toEqual([
      { boxId: '00'.repeat(32), value: 50n },
      { boxId: '11'.repeat(32), value: 100n, income: true },
    ]);
  });
});

describe("the /karma reader rebuilds a row with `income` of the mark's domain", () => {
  // The real NodeClient over a fake `fetch` answers the karma body the fake
  // builds: the reader rebuilds each row of `boxes` through `isHex64Lower`
  // and `isBoxValue`, and `income` holds to `true` or absent — any other
  // value refuses the page (`PageError`).
  const BOX = 'ab'.repeat(32);
  function serve(bodies: unknown[]): void {
    let i = 0;
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(bodies[i++] ?? bodies[bodies.length - 1])));
  }
  afterEach(() => { vi.unstubAllGlobals(); });

  const readFor = async (): Promise<unknown> => {
    const client = new NodeClient(() => '');
    return readBuildContext(client, AUTHOR);
  };

  it('income: false — any value but true — refuses the page', async () => {
    serve([karmaPage([{ boxId: BOX, value: '10', income: false } as unknown as KarmaBoxRow], null)]);
    await expect(readFor()).rejects.toBeInstanceOf(PageError);
  });

  for (const bad of ['yes', 1, 0, null]) {
    it(`income as ${JSON.stringify(bad)} refuses the page`, async () => {
      serve([karmaPage([{ boxId: BOX, value: '10', income: bad } as unknown as KarmaBoxRow], null)]);
      await expect(readFor()).rejects.toBeInstanceOf(PageError);
    });
  }
});

// WEB_INTERFACE → The wallet → "The spendable views are the node's pending view":
// `readBuildContext` asks `/karma/:key?pending=1`; `readCreditContext` asks
// `/credits/:key?pending=1`. The fake karma/credits record whether a read
// passes `{ pending: true }`, so a case can assert the view a read asks.
describe('readBuildContext asks the pending view', () => {
  it('karma is asked with { pending: true }', async () => {
    const seen: boolean[] = [];
    const reads: Pick<Api, 'karma' | 'status'> = {
      karma: async (_k, _p, opts) => { seen.push(opts?.pending === true); return karmaPage([], null); },
      status: async () => statusResult(),
    };
    await readBuildContext(reads, AUTHOR);
    expect(seen.length).toBeGreaterThan(0); // control: karma was asked
    expect(seen.every((p) => p === true)).toBe(true);
  });
});

describe('readCreditContext asks the pending view', () => {
  it('credits is asked with { pending: true }', async () => {
    const seen: boolean[] = [];
    const reads: Pick<Api, 'credits' | 'status'> = {
      credits: async (_k, _p, opts) => { seen.push(opts?.pending === true); return creditsPage([], null); },
      status: async () => statusResult(),
    };
    await readCreditContext(reads, AUTHOR);
    expect(seen.length).toBeGreaterThan(0); // control: credits was asked
    expect(seen.every((p) => p === true)).toBe(true);
  });
});
