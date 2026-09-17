// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { readBuildContext, readCreditContext } from '../src/wallet/reads';
import { PendingLedger } from '../src/wallet/ledger';
import type { Api } from '../src/api/client';
import type { KarmaResult, KarmaBoxRow, StatusResult, CreditsResult, CreditBoxRow } from '../src/api/dto';
import { karmaResult } from './karma-fixture';

// The order WEB_INTERFACE → "Reads before a write, in this order: `GET /karma/:key` following `next`, then `GET /status`" states — /karma fully paged, THEN /status —
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

describe('readBuildContext — WEB_INTERFACE → "Reads before a write, in this order: `GET /karma/:key` following `next`, then `GET /status`"', () => {
  it('reads /karma to the end of next, THEN /status, and assembles the context', async () => {
    const pages = [
      karmaPage([{ boxId: 'b1', value: '100' }], 'k1'),
      karmaPage([{ boxId: 'b2', value: '50' }], null),
    ];
    const ctx = await readBuildContext(fakeReads(pages), new PendingLedger(AUTHOR), AUTHOR);
    // Every karma call precedes the single status call.
    expect(calls).toEqual([`karma(${AUTHOR},after=null)`, `karma(${AUTHOR},after=k1)`, 'status']);
    // Box values crossed as bigint; no pending entries, so both are spendable.
    expect(ctx.spendable).toEqual([{ boxId: 'b1', value: 100n }, { boxId: 'b2', value: 50n }]);
    expect(ctx.height).toBe(5333);
    expect(ctx.era).toBe(1);
    expect(ctx.author).toBe(AUTHOR);
  });

  it('the ledger removes a pending input and adds the predicted change', async () => {
    const ledger = new PendingLedger(AUTHOR);
    ledger.add({
      txId: 't1', kind: 'post', postId: 'p1', inputs: ['b1'],
      change: { boxId: 'chg', value: 95n, createdAtBlock: 5333 }, expiresAtHeight: 6053, submittedAtHeight: 5333,
    });
    const pages = [karmaPage([{ boxId: 'b1', value: '100' }, { boxId: 'b2', value: '50' }], null)];
    const ctx = await readBuildContext(fakeReads(pages), ledger, AUTHOR);
    expect(ctx.spendable).toEqual([{ boxId: 'b2', value: 50n }, { boxId: 'chg', value: 95n }]);
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
    const ctx = await readCreditContext(fakeCreditReads(pages), new PendingLedger(AUTHOR), AUTHOR);
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
    const ctx = await readCreditContext(fakeCreditReads(pages), new PendingLedger(AUTHOR), AUTHOR);
    expect(ctx.spendable.map((b) => b.boxId)).toEqual(['c1', 'c2', 'c4']);
  });
});
