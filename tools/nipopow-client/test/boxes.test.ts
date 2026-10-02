import { describe, it, expect } from 'vitest';
import { fetchListing, proveFigures } from '../src/boxes.js';
import type { Listing } from '../src/boxes.js';
import type { HttpFetch } from '../src/http.js';
import {
  avlProofJson,
  buildAvlWithInsertions,
  buildHoldingsFixture,
  creditBoxFor,
  devnetProfile,
  hexToBytes,
  identityProofKeyHex,
  jsonResponse,
  karmaBoxFor,
  makeAnchor,
  rangeAnswerFromProver,
  recordInsertion,
  singleKeyAnswerFromProver,
  twoHeightNode,
} from './helpers.js';
import { decayCfgFor, effectiveKarma } from '@dagsocial/types';
import type { IdentityRecord, UserId } from '@dagsocial/types';

// WEB_INTERFACE → The extension → "The verified figures" — proveFigures reads
// the key's holdings whole, by range, at `suffixHead` and at `tip`, then
// judges the listing against them. This file covers:
//   - each class (`proven`, `young`, `absent`, `unchecked`, `unlisted`,
//     `undecided`) over the two heights' holdings;
//   - the record proven/absent/unproven/no-proof paths at `suffixHead`;
//   - the valuation at `listing.karma.height`, bounded between `tip.height`
//     and `heightAfter`;
//   - a ledger whose `listing.credits` is `null` (not read);
//   - a holdings read failing at `suffixHead` or at `tip`;
//   - a `stale` tip read: listed boxes `unchecked`, nothing `unlisted` or
//     `undecided` of it, the ledger not failed;
//   - the AVL proof blob decode's totality;
//   - the run's call order: record at `suffixHead`, then the ranges, then
//     `/blocks/current`;
//   - `fetchListing` paged reads and failure cases.

const USER_HEX = 'ab'.repeat(32);
const USER_BYTES = hexToBytes(USER_HEX) as UserId;
const RECORD_KEY = identityProofKeyHex(USER_BYTES);
const SUFFIX_H = 100;
const TIP_H = 119;

const NEVER_ACTIVE_RECORD: IdentityRecord = {
  lastActivityBlock: 0,
  lastDecayBlock: 0,
  invitedAtBlock: 0,
  lifetimeLikesReceived: 0n,
  memberSinceBlock: 0,
  memberBar: 0,
  memberVouches: 0,
  memberLikes: 0n,
  invitesUsed: 0,
};

// The record stands in both heights' fixtures; stale clocks keep decay out of
// the valuation except in the dedicated decay case.
const RECORD_STANDING: IdentityRecord = {
  lastActivityBlock: 50,
  lastDecayBlock: 50,
  invitedAtBlock: 10,
  lifetimeLikesReceived: 3n,
  memberSinceBlock: 20,
  memberBar: 5,
  memberVouches: 2,
  memberLikes: 1n,
  invitesUsed: 0,
};

type PathStub = (path: string, query: URLSearchParams) => Response | undefined;
function makeFetch(stub: PathStub): HttpFetch {
  return async (url: string): Promise<Response> => {
    const u = new URL(url);
    const path = u.pathname;
    const res = stub(path, u.searchParams);
    return res ?? jsonResponse(404, { error: 'not found' });
  };
}

function karmaPage(
  boxes: { boxId: string; value: string | number }[],
  opts: { height?: number; effective?: string; next?: string | null } = {},
): unknown {
  return {
    userId: USER_HEX,
    total: '0',
    effective: opts.effective ?? '0',
    boxes: boxes.map((b) => ({ boxId: b.boxId, value: String(b.value) })),
    next: opts.next ?? null,
    height: opts.height ?? SUFFIX_H,
  };
}

function creditPage(
  boxes: { boxId: string; value: string | number; lockedUntilBlock?: number }[],
  opts: { next?: string | null } = {},
): unknown {
  return {
    userId: USER_HEX,
    total: '0',
    boxes: boxes.map((b) => ({
      boxId: b.boxId,
      value: String(b.value),
      ...(b.lockedUntilBlock !== undefined ? { lockedUntilBlock: b.lockedUntilBlock } : {}),
    })),
    next: opts.next ?? null,
  };
}

describe('proveFigures — each class in turn, over the two heights\' ranges', () => {
  it('proven — a listed karma box held in both S and T, in the ledger it was listed under', async () => {
    const karma = karmaBoxFor(USER_BYTES, 100n, 1);
    const fixture = buildHoldingsFixture({
      boxes: [karma],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const anchor = makeAnchor(TIP_H, fixture.stateRoot, SUFFIX_H, fixture.stateRoot);
    const node = twoHeightNode({ suffix: fixture, suffixHeight: SUFFIX_H, tip: fixture, tipHeight: TIP_H, heightAfter: TIP_H });
    const listing: Listing = {
      karma: { boxes: [{ boxId: karma.id!, value: '100' }], height: TIP_H, effective: '100' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), node.fetch);
    expect(result.boxes.map((b) => b.status)).toEqual(['proven']);
    expect(result.karma.proven).toBe(100n);
    expect(result.karma.holdings).toBe('read');
    expect(result.credits.holdings).toBe('read');
    expect(result.failed).toBe(false);
  });

  it('young — a listed karma box held in T, not in S', async () => {
    const karma = karmaBoxFor(USER_BYTES, 25n, 1);
    const suffix = buildHoldingsFixture({
      boxes: [],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const tip = buildHoldingsFixture({
      boxes: [karma],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const anchor = makeAnchor(TIP_H, tip.stateRoot, SUFFIX_H, suffix.stateRoot);
    const node = twoHeightNode({ suffix, suffixHeight: SUFFIX_H, tip, tipHeight: TIP_H, heightAfter: TIP_H });
    const listing: Listing = {
      karma: { boxes: [{ boxId: karma.id!, value: '25' }], height: TIP_H, effective: '25' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), node.fetch);
    expect(result.boxes.map((b) => b.status)).toEqual(['young']);
    expect(result.karma.proven).toBe(0n);
    expect(result.karma.young).toBe(25n);
    expect(result.failed).toBe(false);
  });

  it('absent — a listed box held in neither S nor T, heightAfter == tip.height', async () => {
    const absentBoxId = 'ff'.repeat(32);
    const emptyFixture = buildHoldingsFixture({
      boxes: [],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const anchor = makeAnchor(TIP_H, emptyFixture.stateRoot, SUFFIX_H, emptyFixture.stateRoot);
    const node = twoHeightNode({ suffix: emptyFixture, suffixHeight: SUFFIX_H, tip: emptyFixture, tipHeight: TIP_H, heightAfter: TIP_H });
    const listing: Listing = {
      karma: { boxes: [{ boxId: absentBoxId, value: '50' }], height: TIP_H, effective: '50' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), node.fetch);
    expect(result.boxes.map((b) => b.status)).toEqual(['absent']);
    expect(result.karma.absent).toBe(50n);
    expect(result.failed).toBe(true);
  });

  it('unchecked — a listed box held in neither S nor T, heightAfter above tip (a block landed since)', async () => {
    const absentBoxId = 'fe'.repeat(32);
    const emptyFixture = buildHoldingsFixture({
      boxes: [],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const anchor = makeAnchor(TIP_H, emptyFixture.stateRoot, SUFFIX_H, emptyFixture.stateRoot);
    const node = twoHeightNode({ suffix: emptyFixture, suffixHeight: SUFFIX_H, tip: emptyFixture, tipHeight: TIP_H, heightAfter: TIP_H + 1 });
    const listing: Listing = {
      karma: { boxes: [{ boxId: absentBoxId, value: '9' }], height: TIP_H, effective: '9' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), node.fetch);
    expect(result.boxes.map((b) => b.status)).toEqual(['unchecked']);
    expect(result.karma.unchecked).toBe(9n);
    expect(result.heightAfter).toBe(TIP_H + 1);
    expect(result.failed).toBe(false);
  });

  it('unchecked — heightAfter below tip (the node\'s height fell)', async () => {
    const absentBoxId = 'fd'.repeat(32);
    const emptyFixture = buildHoldingsFixture({
      boxes: [],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const anchor = makeAnchor(TIP_H, emptyFixture.stateRoot, SUFFIX_H, emptyFixture.stateRoot);
    const node = twoHeightNode({ suffix: emptyFixture, suffixHeight: SUFFIX_H, tip: emptyFixture, tipHeight: TIP_H, heightAfter: TIP_H - 3 });
    // The listing's height is TIP_H - 3, below the anchor's tip, so the
    // valuation range `[tip.height, heightAfter]` is empty and the valuation
    // is refused; the box is still `unchecked` against the empty tip range.
    const listing: Listing = {
      karma: { boxes: [{ boxId: absentBoxId, value: '7' }], height: TIP_H - 3, effective: '7' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), node.fetch);
    // The valuation is refused — listing.height < tip.height — so
    // effective is null and the run `failed`
    // (WEB_INTERFACE → The extension → "The verified figures").
    expect(result.boxes.map((b) => b.status)).toEqual(['unchecked']);
    expect(result.heightAfter).toBe(TIP_H - 3);
    expect(result.karma.effective).toBeNull();
    expect(result.failed).toBe(true);
  });

  it('unchecked — /blocks/current unavailable', async () => {
    const absentBoxId = 'fc'.repeat(32);
    const emptyFixture = buildHoldingsFixture({
      boxes: [],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const anchor = makeAnchor(TIP_H, emptyFixture.stateRoot, SUFFIX_H, emptyFixture.stateRoot);
    const node = twoHeightNode({ suffix: emptyFixture, suffixHeight: SUFFIX_H, tip: emptyFixture, tipHeight: TIP_H, heightAfter: null });
    const listing: Listing = {
      karma: { boxes: [{ boxId: absentBoxId, value: '4' }], height: TIP_H, effective: '4' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), node.fetch);
    expect(result.boxes[0]!.status).toBe('unchecked');
    expect(result.heightAfter).toBeNull();
    expect(result.failed).toBe(false);
  });

  it('unlisted — a karma box held in T the listing names nowhere, heightAfter == tip.height', async () => {
    const held = karmaBoxFor(USER_BYTES, 42n, 1);
    const fixture = buildHoldingsFixture({
      boxes: [held],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const anchor = makeAnchor(TIP_H, fixture.stateRoot, SUFFIX_H, fixture.stateRoot);
    const node = twoHeightNode({ suffix: fixture, suffixHeight: SUFFIX_H, tip: fixture, tipHeight: TIP_H, heightAfter: TIP_H });
    const listing: Listing = {
      karma: { boxes: [], height: TIP_H, effective: '0' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), node.fetch);
    expect(result.boxes.map((b) => b.status)).toEqual(['unlisted']);
    expect(result.boxes[0]!.boxId).toBe(held.id!);
    expect(result.boxes[0]!.boxClass).toBe('karma');
    expect(result.boxes[0]!.value).toBe(42n);
    expect(result.karma.unlisted).toBe(42n);
    expect(result.karma.proven).toBe(0n);
    expect(result.failed).toBe(true);
  });

  it('unlisted — a credit box held in T the listing names nowhere, its lock the proven lock', async () => {
    const held = creditBoxFor(USER_BYTES, 15n, 1, 1, 999);
    const fixture = buildHoldingsFixture({
      boxes: [held],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const anchor = makeAnchor(TIP_H, fixture.stateRoot, SUFFIX_H, fixture.stateRoot);
    const node = twoHeightNode({ suffix: fixture, suffixHeight: SUFFIX_H, tip: fixture, tipHeight: TIP_H, heightAfter: TIP_H });
    const listing: Listing = {
      karma: { boxes: [], height: TIP_H, effective: '0' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), node.fetch);
    expect(result.boxes.map((b) => b.status)).toEqual(['unlisted']);
    expect(result.boxes[0]!.boxClass).toBe('credit');
    expect(result.boxes[0]!.lockedUntilBlock).toBe(999);
    expect(result.credits.unlisted).toBe(15n);
    expect(result.failed).toBe(true);
  });

  it("unlisted does not raise `proven` — the unlisted sum is apart from the four", async () => {
    const listed = karmaBoxFor(USER_BYTES, 10n, 1);
    const unlisted = karmaBoxFor(USER_BYTES, 5n, 2);
    const fixture = buildHoldingsFixture({
      boxes: [listed, unlisted],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const anchor = makeAnchor(TIP_H, fixture.stateRoot, SUFFIX_H, fixture.stateRoot);
    const node = twoHeightNode({ suffix: fixture, suffixHeight: SUFFIX_H, tip: fixture, tipHeight: TIP_H, heightAfter: TIP_H });
    const listing: Listing = {
      karma: { boxes: [{ boxId: listed.id!, value: '10' }], height: TIP_H, effective: '10' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), node.fetch);
    expect(result.karma.proven).toBe(10n);
    expect(result.karma.unlisted).toBe(5n);
  });

  it.each([
    ['above the tip', TIP_H + 1],
    ['unread', null],
  ])('a held, unlisted karma box with heightAfter %s: an undecided FigureBox, undecided sum = box value, failed false', async (_name, heightAfter) => {
    const held = karmaBoxFor(USER_BYTES, 42n, 1);
    const fixture = buildHoldingsFixture({
      boxes: [held],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const anchor = makeAnchor(TIP_H, fixture.stateRoot, SUFFIX_H, fixture.stateRoot);
    const node = twoHeightNode({ suffix: fixture, suffixHeight: SUFFIX_H, tip: fixture, tipHeight: TIP_H, heightAfter: heightAfter as number | null });
    const listing: Listing = {
      karma: { boxes: [], height: TIP_H, effective: '0' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), node.fetch);
    // The held karma box the listing lacks reads `undecided`: a block may
    // have spent it or the node withheld it, and the run cannot say
    // (WEB_INTERFACE → The extension → "The verified figures" — "`undecided`
    // — held at `tip`, named nowhere in the listing of its ledger, and
    // `heightAfter` not `tip.height`"). The sum rides apart; failed stays
    // false — the run cannot decide what no block has refuted.
    expect(result.boxes.map((b) => b.status)).toEqual(['undecided']);
    expect(result.boxes[0]!.boxId).toBe(held.id!);
    expect(result.boxes[0]!.value).toBe(42n);
    expect(result.karma.undecided).toBe(42n);
    expect(result.karma.unlisted).toBe(0n);
    expect(result.failed).toBe(false);
  });

  // A listing height below `tip.height` is outside the valuation range
  // (WEB_INTERFACE → The extension → "The verified figures" — "That height is
  // the node's word, and is taken only from `tip.height` to `heightAfter`"),
  // so the run `failed` on the valuation; the held karma box still reads
  // `undecided`.
  it('a held, unlisted karma box with heightAfter below the tip reads undecided, and the run fails on the valuation range', async () => {
    const held = karmaBoxFor(USER_BYTES, 42n, 1);
    const fixture = buildHoldingsFixture({
      boxes: [held],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const anchor = makeAnchor(TIP_H, fixture.stateRoot, SUFFIX_H, fixture.stateRoot);
    const node = twoHeightNode({ suffix: fixture, suffixHeight: SUFFIX_H, tip: fixture, tipHeight: TIP_H, heightAfter: TIP_H - 1 });
    const listing: Listing = {
      karma: { boxes: [], height: TIP_H, effective: '0' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), node.fetch);
    expect(result.boxes.map((b) => b.status)).toEqual(['undecided']);
    expect(result.karma.undecided).toBe(42n);
    expect(result.karma.effective).toBeNull();
    expect(result.failed).toBe(true);
  });

  // WEB_INTERFACE → The extension → "The verified figures" — the reader's own
  // send: the listing was built after the anchor and holds the change box; the
  // chain holds the input the send spent, not the change box, and one block
  // landed since. The input box the listing lacks reads `undecided` — a block
  // landed and may have spent it or the node withheld it; the run cannot say
  // which. The change box the chain does not hold reads `unchecked` where
  // `heightAfter` is above the tip. The run does not `failed`.
  it('the reader\'s own send: change is unchecked, the spent input is undecided, failed false', async () => {
    const inputBox = creditBoxFor(USER_BYTES, 100n, 1);
    const changeBoxId = 'aa'.repeat(32);
    const fixture = buildHoldingsFixture({
      boxes: [inputBox],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const anchor = makeAnchor(TIP_H, fixture.stateRoot, SUFFIX_H, fixture.stateRoot);
    // heightAfter > tip: a block landed since the anchor.
    const node = twoHeightNode({ suffix: fixture, suffixHeight: SUFFIX_H, tip: fixture, tipHeight: TIP_H, heightAfter: TIP_H + 1 });
    const listing: Listing = {
      karma: { boxes: [], height: TIP_H, effective: '0' },
      credits: { boxes: [{ boxId: changeBoxId, value: '100' }] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), node.fetch);
    expect(result.boxes.map((b) => [b.boxClass, b.status])).toEqual([
      ['credit', 'unchecked'],
      ['credit', 'undecided'],
    ]);
    expect(result.boxes[0]!.boxId).toBe(changeBoxId);
    expect(result.boxes[1]!.boxId).toBe(inputBox.id!);
    expect(result.credits.undecided).toBe(100n);
    expect(result.failed).toBe(false);
  });
});

describe("proveFigures — the lying-node cases a tree's own holdings reads refuse", () => {
  // WEB_INTERFACE → The extension → "The verified figures" — the chain fixes
  // a box's owner and type through the range it was read from, so a listing
  // that names another key's box, the wrong ledger's, or a box the chain no
  // longer holds is caught by the heldT/heldS lookups going absent.

  it("another key's real karma box listed under this key: absent at tip-height, in no sum, never proven", async () => {
    const OTHER = hexToBytes('cd'.repeat(32)) as UserId;
    const otherKarma = karmaBoxFor(OTHER, 50n, 1);
    const fixture = buildHoldingsFixture({
      boxes: [otherKarma],
      records: [
        { identityId: USER_BYTES, record: RECORD_STANDING },
        { identityId: OTHER, record: RECORD_STANDING },
      ],
    });
    const anchor = makeAnchor(TIP_H, fixture.stateRoot, SUFFIX_H, fixture.stateRoot);
    const node = twoHeightNode({ suffix: fixture, suffixHeight: SUFFIX_H, tip: fixture, tipHeight: TIP_H, heightAfter: TIP_H });
    const listing: Listing = {
      karma: { boxes: [{ boxId: otherKarma.id!, value: '50' }], height: TIP_H, effective: '50' },
      credits: null,
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), node.fetch);
    expect(result.boxes.map((b) => b.status)).toEqual(['absent']);
    expect(result.karma.proven).toBe(0n);
    expect(result.karma.absent).toBe(50n);
    expect(result.failed).toBe(true);
  });

  it("another key's real karma box listed under this key, heightAfter above tip: unchecked", async () => {
    const OTHER = hexToBytes('cd'.repeat(32)) as UserId;
    const otherKarma = karmaBoxFor(OTHER, 50n, 1);
    const fixture = buildHoldingsFixture({
      boxes: [otherKarma],
      records: [
        { identityId: USER_BYTES, record: RECORD_STANDING },
        { identityId: OTHER, record: RECORD_STANDING },
      ],
    });
    const anchor = makeAnchor(TIP_H, fixture.stateRoot, SUFFIX_H, fixture.stateRoot);
    const node = twoHeightNode({ suffix: fixture, suffixHeight: SUFFIX_H, tip: fixture, tipHeight: TIP_H, heightAfter: TIP_H + 1 });
    const listing: Listing = {
      karma: { boxes: [{ boxId: otherKarma.id!, value: '50' }], height: TIP_H, effective: '50' },
      credits: null,
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), node.fetch);
    expect(result.boxes.map((b) => b.status)).toEqual(['unchecked']);
    expect(result.karma.unchecked).toBe(50n);
    expect(result.failed).toBe(false);
  });

  it("this key's own credit box listed under karma: karma place absent at tip-height, credits place unlisted", async () => {
    // The box is a credit box of USER_BYTES; the listing names it under
    // karma. The karma range does not include it (wrong ledger) → absent.
    // The credits listing does NOT name it, the credit range answers it →
    // unlisted at tip-height.
    const credit = creditBoxFor(USER_BYTES, 40n, 1);
    const fixture = buildHoldingsFixture({
      boxes: [credit],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const anchor = makeAnchor(TIP_H, fixture.stateRoot, SUFFIX_H, fixture.stateRoot);
    const node = twoHeightNode({ suffix: fixture, suffixHeight: SUFFIX_H, tip: fixture, tipHeight: TIP_H, heightAfter: TIP_H });
    const listing: Listing = {
      karma: { boxes: [{ boxId: credit.id!, value: '40' }], height: TIP_H, effective: '40' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), node.fetch);
    expect(result.boxes.map((b) => [b.boxClass, b.status])).toEqual([
      ['karma', 'absent'],
      ['credit', 'unlisted'],
    ]);
    expect(result.karma.absent).toBe(40n);
    expect(result.credits.unlisted).toBe(40n);
    expect(result.failed).toBe(true);
  });

  it("a listed box held at suffixHead and not at tip (spent since): absent at tip-height", async () => {
    const karma = karmaBoxFor(USER_BYTES, 25n, 1);
    const suffix = buildHoldingsFixture({
      boxes: [karma],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const tip = buildHoldingsFixture({
      boxes: [],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const anchor = makeAnchor(TIP_H, tip.stateRoot, SUFFIX_H, suffix.stateRoot);
    const node = twoHeightNode({ suffix, suffixHeight: SUFFIX_H, tip, tipHeight: TIP_H, heightAfter: TIP_H });
    const listing: Listing = {
      karma: { boxes: [{ boxId: karma.id!, value: '25' }], height: TIP_H, effective: '25' },
      credits: null,
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), node.fetch);
    expect(result.boxes.map((b) => b.status)).toEqual(['absent']);
    expect(result.karma.absent).toBe(25n);
    expect(result.failed).toBe(true);
  });

  it("an unlisted box held at suffixHead and not at tip: no FigureBox, every sum zero, failed false", async () => {
    const karma = karmaBoxFor(USER_BYTES, 25n, 1);
    const suffix = buildHoldingsFixture({
      boxes: [karma],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const tip = buildHoldingsFixture({
      boxes: [],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const anchor = makeAnchor(TIP_H, tip.stateRoot, SUFFIX_H, suffix.stateRoot);
    const node = twoHeightNode({ suffix, suffixHeight: SUFFIX_H, tip, tipHeight: TIP_H, heightAfter: TIP_H });
    const listing: Listing = {
      karma: { boxes: [], height: TIP_H, effective: '0' },
      credits: null,
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), node.fetch);
    expect(result.boxes).toEqual([]);
    expect(result.karma.proven).toBe(0n);
    expect(result.karma.unlisted).toBe(0n);
    expect(result.failed).toBe(false);
  });
});

describe("proveFigures — each ledger carries its own status", () => {
  // WEB_INTERFACE → The extension → "The verified figures" — "Each ledger's
  // read carries a status of its own beside its boxes'". A failure on one
  // ledger must not reach the other's status.

  function nodeWithRangeFailures(opts: {
    fixture: ReturnType<typeof buildHoldingsFixture>;
    fail: (kind: 'karma' | 'credit', atHeight: number) => Response | null;
  }): { fetch: HttpFetch; calls: string[] } {
    const base = twoHeightNode({ suffix: opts.fixture, suffixHeight: SUFFIX_H, tip: opts.fixture, tipHeight: TIP_H, heightAfter: TIP_H });
    const calls: string[] = [];
    const fetch: HttpFetch = async (url: string) => {
      const u = new URL(url);
      calls.push(`${u.pathname}${u.search}`);
      const m = u.pathname.match(/^\/api\/v1\/range\/([a-z]+)\/[0-9a-f]{64}$/);
      if (m) {
        const kind = m[1] as 'karma' | 'credit';
        const h = Number(u.searchParams.get('atHeight'));
        const failure = opts.fail(kind, h);
        if (failure !== null) return failure;
      }
      return base.fetch(url);
    };
    return { fetch, calls };
  }

  it('credit range answers 404 at suffixHead while karma verifies: karma boxes classed, karma.holdings read, credits.holdings no-proof', async () => {
    const karma = karmaBoxFor(USER_BYTES, 100n, 1);
    const credit = creditBoxFor(USER_BYTES, 50n, 2);
    const fixture = buildHoldingsFixture({
      boxes: [karma, credit],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const anchor = makeAnchor(TIP_H, fixture.stateRoot, SUFFIX_H, fixture.stateRoot);
    const { fetch } = nodeWithRangeFailures({
      fixture,
      fail: (kind, _h) => (kind === 'credit') ? jsonResponse(404, { error: 'height not available' }) : null,
    });
    const listing: Listing = {
      karma: { boxes: [{ boxId: karma.id!, value: '100' }], height: TIP_H, effective: '100' },
      credits: { boxes: [{ boxId: credit.id!, value: '50' }] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), fetch);
    expect(result.karma.holdings).toBe('read');
    expect(result.credits.holdings).toBe('no-proof');
    expect(result.boxes.map((b) => [b.boxClass, b.status])).toEqual([
      ['karma', 'proven'],
      ['credit', 'no-proof'],
    ]);
    expect(result.karma.proven).toBe(100n);
    expect(result.failed).toBe(false);
  });

  it('karma range answers 404 at suffixHead while credit verifies: credit boxes classed, credits.holdings read, karma.holdings no-proof', async () => {
    const karma = karmaBoxFor(USER_BYTES, 100n, 1);
    const credit = creditBoxFor(USER_BYTES, 50n, 2);
    const fixture = buildHoldingsFixture({
      boxes: [karma, credit],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const anchor = makeAnchor(TIP_H, fixture.stateRoot, SUFFIX_H, fixture.stateRoot);
    const { fetch } = nodeWithRangeFailures({
      fixture,
      fail: (kind, _h) => (kind === 'karma') ? jsonResponse(404, { error: 'height not available' }) : null,
    });
    const listing: Listing = {
      karma: { boxes: [{ boxId: karma.id!, value: '100' }], height: TIP_H, effective: '100' },
      credits: { boxes: [{ boxId: credit.id!, value: '50' }] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), fetch);
    expect(result.karma.holdings).toBe('no-proof');
    expect(result.credits.holdings).toBe('read');
    expect(result.boxes.map((b) => [b.boxClass, b.status])).toEqual([
      ['karma', 'no-proof'],
      ['credit', 'proven'],
    ]);
    expect(result.credits.proven).toBe(50n);
    expect(result.failed).toBe(false);
  });

  it('credit range fails at tip alone: karma reads both heights, karma.holdings read, credits.holdings no-proof', async () => {
    const karma = karmaBoxFor(USER_BYTES, 100n, 1);
    const credit = creditBoxFor(USER_BYTES, 50n, 2);
    const fixture = buildHoldingsFixture({
      boxes: [karma, credit],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const anchor = makeAnchor(TIP_H, fixture.stateRoot, SUFFIX_H, fixture.stateRoot);
    const { fetch } = nodeWithRangeFailures({
      fixture,
      fail: (kind, h) => (kind === 'credit' && h === TIP_H) ? jsonResponse(404, { error: 'height not available' }) : null,
    });
    const listing: Listing = {
      karma: { boxes: [{ boxId: karma.id!, value: '100' }], height: TIP_H, effective: '100' },
      credits: { boxes: [{ boxId: credit.id!, value: '50' }] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), fetch);
    expect(result.karma.holdings).toBe('read');
    expect(result.credits.holdings).toBe('no-proof');
    expect(result.credits.holdingsVerdict).toContain('tip');
    expect(result.failed).toBe(false);
  });

  it("one ledger's holdings is unproven, the other's read: failed true, the read ledger's sums are what they are", async () => {
    const karma = karmaBoxFor(USER_BYTES, 100n, 1);
    const credit = creditBoxFor(USER_BYTES, 50n, 2);
    const fixture = buildHoldingsFixture({
      boxes: [karma, credit],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const anchor = makeAnchor(TIP_H, fixture.stateRoot, SUFFIX_H, fixture.stateRoot);
    // Credit answers at suffix with a wrong stateRoot (unproven); karma reads.
    const { fetch } = nodeWithRangeFailures({
      fixture,
      fail: (kind, _h) => (kind === 'credit')
        ? jsonResponse(200, { kind: 'credit', owner: USER_HEX, atHeight: SUFFIX_H, stateRoot: '00'.repeat(33), from: null, limit: 256, proof: '' })
        : null,
    });
    const listing: Listing = {
      karma: { boxes: [{ boxId: karma.id!, value: '100' }], height: TIP_H, effective: '100' },
      credits: { boxes: [{ boxId: credit.id!, value: '50' }] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), fetch);
    expect(result.karma.holdings).toBe('read');
    expect(result.credits.holdings).toBe('unproven');
    expect(result.karma.proven).toBe(100n);
    expect(result.failed).toBe(true);
  });
});

describe('proveFigures — a listing whose credits is null is not read', () => {
  it('listing.credits: null makes no credit request and answers zero sums with holdings "not-read"', async () => {
    const emptyFixture = buildHoldingsFixture({
      boxes: [],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const anchor = makeAnchor(TIP_H, emptyFixture.stateRoot, SUFFIX_H, emptyFixture.stateRoot);
    const node = twoHeightNode({ suffix: emptyFixture, suffixHeight: SUFFIX_H, tip: emptyFixture, tipHeight: TIP_H, heightAfter: TIP_H });

    const listing: Listing = {
      karma: { boxes: [], height: TIP_H, effective: '0' },
      credits: null,
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), node.fetch);
    // No credit request was made.
    expect(node.calls.filter((c) => c.includes('/range/credit/'))).toEqual([]);
    expect(result.credits).toEqual({ proven: 0n, young: 0n, unchecked: 0n, absent: 0n, unlisted: 0n, undecided: 0n, holdings: 'not-read', holdingsVerdict: null });
    expect(result.karma.holdings).toBe('read');
  });
});

describe('proveFigures — a holdings read failure', () => {
  it('failing at suffixHead: every listed box carries no-proof, holdings is "no-proof", failed false', async () => {
    const karma = karmaBoxFor(USER_BYTES, 10n, 1);
    const fetch: HttpFetch = async (url: string): Promise<Response> => {
      const u = new URL(url);
      if (u.pathname === '/api/v1/proof/' + RECORD_KEY) {
        // The record route answers 500 — the record lands `no-proof`; the
        // range read fails below, so no listing-box replay runs.
        return jsonResponse(500, { error: 'internal' });
      }
      if (u.pathname.startsWith('/api/v1/range/')) {
        return jsonResponse(404, { error: 'height not available' });
      }
      if (u.pathname === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return jsonResponse(404, { error: 'not found' });
    };
    const anchor = makeAnchor(TIP_H, '00'.repeat(33), SUFFIX_H, '00'.repeat(33));
    const listing: Listing = {
      karma: { boxes: [{ boxId: karma.id!, value: '10' }], height: TIP_H, effective: '10' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), fetch);
    expect(result.boxes.map((b) => b.status)).toEqual(['no-proof']);
    expect(result.boxes[0]!.verdict).toContain('holdings read failed at suffixHead');
    expect(result.karma.holdings).toBe('no-proof');
    expect(result.failed).toBe(false);
  });

  it('failing at tip only: every listed box carries no-proof, holdings is "no-proof"', async () => {
    const karma = karmaBoxFor(USER_BYTES, 10n, 1);
    const fixture = buildHoldingsFixture({
      boxes: [karma],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const anchor = makeAnchor(TIP_H, fixture.stateRoot, SUFFIX_H, fixture.stateRoot);
    const fetch: HttpFetch = async (url: string): Promise<Response> => {
      const u = new URL(url);
      if (u.pathname === '/api/v1/proof/' + RECORD_KEY) {
        return jsonResponse(200, singleKeyAnswerFromProver(fixture.prover, fixture.stateRoot, SUFFIX_H, hexToBytes(RECORD_KEY), 'record'));
      }
      if (u.pathname.startsWith('/api/v1/range/')) {
        const atHeight = Number(u.searchParams.get('atHeight'));
        if (atHeight === SUFFIX_H) {
          const limit = Number(u.searchParams.get('limit') ?? '256');
          const kind = u.pathname.split('/')[4] as 'karma';
          return jsonResponse(200, rangeAnswerFromProver(fixture.prover, fixture.stateRoot, atHeight, kind, USER_BYTES, null, limit));
        }
        return jsonResponse(404, { error: 'height not available' });
      }
      if (u.pathname === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return jsonResponse(404, { error: 'not found' });
    };
    const listing: Listing = {
      karma: { boxes: [{ boxId: karma.id!, value: '10' }], height: TIP_H, effective: '10' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), fetch);
    expect(result.karma.holdings).toBe('no-proof');
    expect(result.boxes.map((b) => b.status)).toEqual(['no-proof']);
    expect(result.boxes[0]!.verdict).toContain('holdings read failed at tip');
    expect(result.failed).toBe(false);
  });

  it('an empty karma listing over a 404 range read: no box, holdings is "no-proof", failed false', async () => {
    const fetch: HttpFetch = async (url: string): Promise<Response> => {
      const u = new URL(url);
      if (u.pathname === '/api/v1/proof/' + RECORD_KEY) return jsonResponse(404, { error: 'height not available' });
      if (u.pathname.startsWith('/api/v1/range/')) return jsonResponse(404, { error: 'height not available' });
      if (u.pathname === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return jsonResponse(404, { error: 'not found' });
    };
    const anchor = makeAnchor(TIP_H, '00'.repeat(33), SUFFIX_H, '00'.repeat(33));
    const listing: Listing = {
      karma: { boxes: [], height: TIP_H, effective: '0' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), fetch);
    expect(result.boxes).toEqual([]);
    expect(result.karma.holdings).toBe('no-proof');
    expect(result.credits.holdings).toBe('no-proof');
    expect(result.failed).toBe(false);
  });

  it('an empty karma listing over a range read that does not verify: no box, holdings is "unproven", failed true', async () => {
    const karma = karmaBoxFor(USER_BYTES, 10n, 1);
    const fixture = buildHoldingsFixture({ boxes: [karma], records: [{ identityId: USER_BYTES, record: RECORD_STANDING }] });
    const anchor = makeAnchor(TIP_H, '00'.repeat(33), SUFFIX_H, '00'.repeat(33));
    // The server returns a valid proof answer BUT the client expects a
    // different `stateRoot` in its header — the client refuses the mismatch
    // before the proof is read.
    const fetch: HttpFetch = async (url: string): Promise<Response> => {
      const u = new URL(url);
      if (u.pathname === '/api/v1/proof/' + RECORD_KEY) return jsonResponse(404, { error: 'height not available' });
      if (u.pathname.startsWith('/api/v1/range/')) {
        const atHeight = Number(u.searchParams.get('atHeight'));
        const limit = Number(u.searchParams.get('limit') ?? '256');
        return jsonResponse(200, rangeAnswerFromProver(fixture.prover, fixture.stateRoot, atHeight, 'karma', USER_BYTES, null, limit));
      }
      if (u.pathname === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return jsonResponse(404, { error: 'not found' });
    };
    const listing: Listing = {
      karma: { boxes: [], height: TIP_H, effective: '0' },
      credits: null,
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), fetch);
    expect(result.boxes).toEqual([]);
    expect(result.karma.holdings).toBe('unproven');
    expect(result.failed).toBe(true);
  });

  it('an empty listing over an empty range: holdings "read", every sum zero, failed false', async () => {
    const empty = buildHoldingsFixture({ boxes: [], records: [{ identityId: USER_BYTES, record: RECORD_STANDING }] });
    const anchor = makeAnchor(TIP_H, empty.stateRoot, SUFFIX_H, empty.stateRoot);
    const node = twoHeightNode({ suffix: empty, suffixHeight: SUFFIX_H, tip: empty, tipHeight: TIP_H, heightAfter: TIP_H });
    const listing: Listing = {
      karma: { boxes: [], height: TIP_H, effective: '0' },
      credits: { boxes: [] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), node.fetch);
    expect(result.boxes).toEqual([]);
    expect(result.karma.holdings).toBe('read');
    expect(result.credits.holdings).toBe('read');
    expect(result.karma.proven).toBe(0n);
    expect(result.credits.proven).toBe(0n);
    expect(result.failed).toBe(false);
  });
});

describe('proveFigures — the identity record', () => {
  it('proven — the clocks read back exactly', async () => {
    const avl = buildAvlWithInsertions([recordInsertion(USER_BYTES, RECORD_STANDING)]);
    const anchor = makeAnchor(TIP_H, avl.digest, SUFFIX_H, avl.digest);
    const fetch = makeFetch((path, q) => {
      const at = Number(q.get('atHeight'));
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        const e = avl.entries.get(RECORD_KEY)!;
        return jsonResponse(200, avlProofJson(RECORD_KEY, at, avl.digest, e.proof, 'record', null));
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return undefined;
    });
    const listing: Listing = {
      karma: { boxes: [], height: TIP_H, effective: '0' },
      credits: null,
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), fetch);
    expect(result.record.status).toBe('proven');
    if (result.record.status === 'proven') {
      expect(result.record.record).toEqual(RECORD_STANDING);
    }
    expect(result.karma.effective).toBe(0n);
  });

  it('absent — the record exclusion, valued as the null-record path', async () => {
    const avl = buildAvlWithInsertions([], [RECORD_KEY]);
    const anchor = makeAnchor(TIP_H, avl.digest, SUFFIX_H, avl.digest);
    const fetch = makeFetch((path, q) => {
      const at = Number(q.get('atHeight'));
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        const e = avl.entries.get(RECORD_KEY)!;
        return jsonResponse(200, avlProofJson(RECORD_KEY, at, avl.digest, e.proof, null, null));
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return undefined;
    });
    const listing: Listing = {
      karma: { boxes: [], height: TIP_H, effective: '0' },
      credits: null,
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), fetch);
    expect(result.record.status).toBe('absent');
    expect(result.karma.effective).toBe(0n);
  });

  it('unproven — a flipped byte on the record proof leaves effective null and failed true', async () => {
    const avl = buildAvlWithInsertions([recordInsertion(USER_BYTES, RECORD_STANDING)]);
    const anchor = makeAnchor(TIP_H, avl.digest, SUFFIX_H, avl.digest);
    const fetch = makeFetch((path, q) => {
      const at = Number(q.get('atHeight'));
      if (path === `/api/v1/proof/${RECORD_KEY}`) {
        const e = avl.entries.get(RECORD_KEY)!;
        const flipped = Uint8Array.from(e.proof);
        if (flipped.length > 2) flipped[2] = (flipped[2] ?? 0) ^ 0xff;
        return jsonResponse(200, avlProofJson(RECORD_KEY, at, avl.digest, flipped, 'record', null));
      }
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return undefined;
    });
    const listing: Listing = {
      karma: { boxes: [], height: TIP_H, effective: '0' },
      credits: null,
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), fetch);
    expect(result.record.status).toBe('unproven');
    expect(result.karma.effective).toBeNull();
    expect(result.failed).toBe(true);
  });

  it('no-proof — a 404 on the record leaves effective null and does not fail', async () => {
    const anchor = makeAnchor(TIP_H, '00'.repeat(33), SUFFIX_H, '00'.repeat(33));
    const fetch = makeFetch((path) => {
      if (path === `/api/v1/proof/${RECORD_KEY}`) return jsonResponse(404, { error: 'height not available' });
      if (path === '/blocks/current') return jsonResponse(200, { height: TIP_H, hash: null });
      return undefined;
    });
    const listing: Listing = {
      karma: { boxes: [], height: TIP_H, effective: '0' },
      credits: null,
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), fetch);
    expect(result.record.status).toBe('no-proof');
    expect(result.karma.effective).toBeNull();
    expect(result.failed).toBe(false);
  });
});

describe('proveFigures — effective karma', () => {
  it('proven face + proven record at listing.height — equal to a direct effectiveKarma call', async () => {
    const karma = karmaBoxFor(USER_BYTES, 200n, 1);
    const fixture = buildHoldingsFixture({
      boxes: [karma],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const listingHeight = 300;
    // The listing's height values rep only inside `tip.height` to
    // `heightAfter` (WEB_INTERFACE → The extension → "The verified
    // figures"), so the anchor and the node's `/blocks/current` here reach
    // out to listingHeight for the valuation to run.
    const anchor = makeAnchor(listingHeight, fixture.stateRoot, SUFFIX_H, fixture.stateRoot);
    const node = twoHeightNode({ suffix: fixture, suffixHeight: SUFFIX_H, tip: fixture, tipHeight: listingHeight, heightAfter: listingHeight });

    const listing: Listing = {
      karma: { boxes: [{ boxId: karma.id!, value: '200' }], height: listingHeight, effective: '200' },
      credits: null,
    };
    const profile = devnetProfile();
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, profile, node.fetch);
    const expected = effectiveKarma(200n, RECORD_STANDING, listingHeight, decayCfgFor(profile));
    expect(result.karma.effective).toBe(expected);
  });

  it('decay applies — a stale record whose valuation is below face', async () => {
    const { KARMA_DECAY_AMOUNT } = await import('@dagsocial/types');
    const profile = devnetProfile();
    const listingHeight = profile.karmaStaleThresholdBlocks + 3 * profile.karmaDecayIntervalBlocks + 1;
    const staleRecord: IdentityRecord = { ...NEVER_ACTIVE_RECORD, lastActivityBlock: 1, lastDecayBlock: 1 };

    const karma = karmaBoxFor(USER_BYTES, 1000n, 1);
    const fixture = buildHoldingsFixture({
      boxes: [karma],
      records: [{ identityId: USER_BYTES, record: staleRecord }],
    });
    // The listing's height must lie between `tip.height` and `heightAfter`
    // for the valuation to run (WEB_INTERFACE → The extension → "The
    // verified figures"); anchor at listingHeight.
    const anchor = makeAnchor(listingHeight, fixture.stateRoot, SUFFIX_H, fixture.stateRoot);
    const node = twoHeightNode({ suffix: fixture, suffixHeight: SUFFIX_H, tip: fixture, tipHeight: listingHeight, heightAfter: listingHeight });

    const listing: Listing = {
      karma: { boxes: [{ boxId: karma.id!, value: '1000' }], height: listingHeight, effective: '999' },
      credits: null,
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, profile, node.fetch);
    const expected = effectiveKarma(1000n, staleRecord, listingHeight, decayCfgFor(profile));
    expect(result.karma.effective).toBe(expected);
    expect(result.karma.effective).toBeLessThan(1000n);
    expect(1000n - result.karma.effective!).toBeGreaterThanOrEqual(KARMA_DECAY_AMOUNT);
  });
});

describe('proveFigures — the run order is the rule', () => {
  it('record at suffixHead → ranges at suffixHead → ranges at tip → /blocks/current', async () => {
    const karma = karmaBoxFor(USER_BYTES, 7n, 1);
    const fixture = buildHoldingsFixture({
      boxes: [karma],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const anchor = makeAnchor(TIP_H, fixture.stateRoot, SUFFIX_H, fixture.stateRoot);
    const node = twoHeightNode({ suffix: fixture, suffixHeight: SUFFIX_H, tip: fixture, tipHeight: TIP_H, heightAfter: TIP_H });

    const listing: Listing = {
      karma: { boxes: [{ boxId: karma.id!, value: '7' }], height: TIP_H, effective: '7' },
      credits: { boxes: [] },
    };
    await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), node.fetch);

    // Expected order (paths without query):
    //   1. /api/v1/proof/<recordKey>?atHeight=SUFFIX_H
    //   2. /api/v1/range/karma/<user>?atHeight=SUFFIX_H...
    //   3. /api/v1/range/credit/<user>?atHeight=SUFFIX_H...
    //   4. /api/v1/range/karma/<user>?atHeight=TIP_H...
    //   5. /api/v1/range/credit/<user>?atHeight=TIP_H...
    //   6. /blocks/current
    const paths = node.calls.map((c) => c.split('?')[0]);
    expect(paths[0]).toBe(`/api/v1/proof/${RECORD_KEY}`);
    expect(paths[1]).toBe(`/api/v1/range/karma/${USER_HEX}`);
    expect(paths[2]).toBe(`/api/v1/range/credit/${USER_HEX}`);
    expect(paths[3]).toBe(`/api/v1/range/karma/${USER_HEX}`);
    expect(paths[4]).toBe(`/api/v1/range/credit/${USER_HEX}`);
    expect(paths[5]).toBe('/blocks/current');
    // The ranges at suffixHead carry atHeight=SUFFIX_H; the ranges at tip
    // carry atHeight=TIP_H.
    expect(node.calls[0]).toContain(`atHeight=${SUFFIX_H}`);
    expect(node.calls[1]).toContain(`atHeight=${SUFFIX_H}`);
    expect(node.calls[2]).toContain(`atHeight=${SUFFIX_H}`);
    expect(node.calls[3]).toContain(`atHeight=${TIP_H}`);
    expect(node.calls[4]).toContain(`atHeight=${TIP_H}`);
  });
});

describe('fetchListing — paged reads', () => {
  it('three karma pages followed to the end — height and effective from the first page', async () => {
    const fetch = makeFetch((path, q) => {
      if (path === `/karma/${USER_HEX}`) {
        const after = q.get('after');
        if (after === null) {
          return jsonResponse(200, karmaPage(
            [{ boxId: 'a1'.repeat(32), value: '10' }],
            { height: 555, effective: '30', next: 'cursor-1' },
          ));
        }
        if (after === 'cursor-1') {
          return jsonResponse(200, karmaPage(
            [{ boxId: 'a2'.repeat(32), value: '10' }],
            { height: 999, effective: 'wrong', next: 'cursor-2' },
          ));
        }
        if (after === 'cursor-2') {
          return jsonResponse(200, karmaPage(
            [{ boxId: 'a3'.repeat(32), value: '10' }],
            { height: 999, effective: 'wrong', next: null },
          ));
        }
        return undefined;
      }
      if (path === `/credits/${USER_HEX}`) return jsonResponse(200, creditPage([]));
      return undefined;
    });

    const result = await fetchListing('http://a', USER_HEX, fetch);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.listing.karma.boxes.length).toBe(3);
      expect(result.listing.karma.height).toBe(555);
      expect(result.listing.karma.effective).toBe('30');
    }
  });

  it('two credit pages followed to the end', async () => {
    const fetch = makeFetch((path, q) => {
      if (path === `/karma/${USER_HEX}`) return jsonResponse(200, karmaPage([], { height: 555 }));
      if (path !== `/credits/${USER_HEX}`) return undefined;
      const after = q.get('after');
      if (after === null) {
        return jsonResponse(200, creditPage(
          [{ boxId: 'c1'.repeat(32), value: '5' }],
          { next: 'cursor-c1' },
        ));
      }
      if (after === 'cursor-c1') {
        return jsonResponse(200, creditPage(
          [{ boxId: 'c2'.repeat(32), value: '5', lockedUntilBlock: 42 }],
          { next: null },
        ));
      }
      return undefined;
    });

    const result = await fetchListing('http://a', USER_HEX, fetch);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.listing.credits).not.toBeNull();
      expect(result.listing.credits!.boxes.length).toBe(2);
      expect(result.listing.credits!.boxes[1]!.lockedUntilBlock).toBe(42);
    }
  });

  // NODE_INTERFACE → UTXO queries — /karma/:userId and /credits/:userId
  // answer a hex key the node has never seen with the empty page at its
  // current height, never a 404; so a 404 on a hex key is a listing
  // failure, like any other non-ok.
  it('a 404 on karma fails the listing, the karma route named', async () => {
    const fetch = makeFetch((path) => {
      if (path === `/karma/${USER_HEX}`) return jsonResponse(404, { error: 'not found' });
      if (path === `/credits/${USER_HEX}`) return jsonResponse(200, creditPage([]));
      return undefined;
    });

    const result = await fetchListing('http://a', USER_HEX, fetch);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('karma');
      expect(result.reason).toContain('404');
    }
  });

  it('a 404 on credits fails the listing, the credits route named', async () => {
    const fetch = makeFetch((path) => {
      if (path === `/karma/${USER_HEX}`) return jsonResponse(200, karmaPage([]));
      if (path === `/credits/${USER_HEX}`) return jsonResponse(404, { error: 'not found' });
      return undefined;
    });

    const result = await fetchListing('http://a', USER_HEX, fetch);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('credits');
      expect(result.reason).toContain('404');
    }
  });

  it('a 500 on karma names the route', async () => {
    const fetch = makeFetch((path) => {
      if (path === `/karma/${USER_HEX}`) return jsonResponse(500, { error: 'internal' });
      return undefined;
    });
    const result = await fetchListing('http://a', USER_HEX, fetch);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('karma');
      expect(result.reason).toContain('500');
    }
  });

  it('a 500 on credits names the route', async () => {
    const fetch = makeFetch((path) => {
      if (path === `/karma/${USER_HEX}`) return jsonResponse(200, karmaPage([]));
      if (path === `/credits/${USER_HEX}`) return jsonResponse(500, { error: 'internal' });
      return undefined;
    });
    const result = await fetchListing('http://a', USER_HEX, fetch);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('credits');
      expect(result.reason).toContain('500');
    }
  });
});

// WEB_INTERFACE → The extension → "The verified figures" — the `undecided`
// rule. Fixed listing and proofs; only `heightAfter` moves. At `tip.height`,
// the held box the listing lacks reads `unlisted` and `failed` is true. At
// another height — a block landed, or unread — it reads `undecided`, apart
// from the five sums, and `failed` stays false.
describe("proveFigures — a held box the listing lacks is undecided at a height the anchor's tip did not match", () => {
  const held = karmaBoxFor(USER_BYTES, 12n, 1);
  const fixture = buildHoldingsFixture({
    boxes: [held],
    records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
  });
  const anchor = makeAnchor(TIP_H, fixture.stateRoot, SUFFIX_H, fixture.stateRoot);

  function run(heightAfter: number | null, karmaBoxes: Listing['karma']['boxes']) {
    const node = twoHeightNode({ suffix: fixture, suffixHeight: SUFFIX_H, tip: fixture, tipHeight: TIP_H, heightAfter });
    const listing: Listing = {
      karma: { boxes: karmaBoxes, height: TIP_H, effective: '0' },
      credits: { boxes: [] },
    };
    return proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), node.fetch);
  }

  it('under a non-empty listing: heightAfter == tip reads unlisted and failed; tip + 1 reads undecided, failed false', async () => {
    const other = karmaBoxFor(USER_BYTES, 1n, 2);
    const twoBoxFixture = buildHoldingsFixture({
      boxes: [held, other],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const anchor2 = makeAnchor(TIP_H, twoBoxFixture.stateRoot, SUFFIX_H, twoBoxFixture.stateRoot);
    const listing: Listing = {
      karma: { boxes: [{ boxId: other.id!, value: '1' }], height: TIP_H, effective: '1' },
      credits: { boxes: [] },
    };
    const atTip = await proveFigures('http://a', USER_HEX, listing, anchor2, devnetProfile(),
      twoHeightNode({ suffix: twoBoxFixture, suffixHeight: SUFFIX_H, tip: twoBoxFixture, tipHeight: TIP_H, heightAfter: TIP_H }).fetch);
    expect(atTip.boxes.map((b) => b.status)).toEqual(['proven', 'unlisted']);
    expect(atTip.karma.unlisted).toBe(12n);
    expect(atTip.karma.undecided).toBe(0n);
    expect(atTip.failed).toBe(true);

    const atTipPlus1 = await proveFigures('http://a', USER_HEX, listing, anchor2, devnetProfile(),
      twoHeightNode({ suffix: twoBoxFixture, suffixHeight: SUFFIX_H, tip: twoBoxFixture, tipHeight: TIP_H, heightAfter: TIP_H + 1 }).fetch);
    expect(atTipPlus1.boxes.map((b) => b.status)).toEqual(['proven', 'undecided']);
    expect(atTipPlus1.karma.unlisted).toBe(0n);
    expect(atTipPlus1.karma.undecided).toBe(12n);
    expect(atTipPlus1.failed).toBe(false);
  });

  it('under an empty listing: heightAfter == tip reads unlisted and failed; tip + 1 reads undecided; unread reads undecided', async () => {
    const atTip = await run(TIP_H, []);
    expect(atTip.boxes.map((b) => b.status)).toEqual(['unlisted']);
    expect(atTip.karma.unlisted).toBe(12n);
    expect(atTip.failed).toBe(true);

    const atTipPlus1 = await run(TIP_H + 1, []);
    expect(atTipPlus1.boxes.map((b) => b.status)).toEqual(['undecided']);
    expect(atTipPlus1.karma.undecided).toBe(12n);
    expect(atTipPlus1.karma.unlisted).toBe(0n);
    expect(atTipPlus1.failed).toBe(false);

    const unread = await run(null, []);
    expect(unread.boxes.map((b) => b.status)).toEqual(['undecided']);
    expect(unread.karma.undecided).toBe(12n);
    expect(unread.failed).toBe(false);
  });
});

// WEB_INTERFACE → The extension → "The verified figures" — "A `stateRoot`
// other than the header's at `tip` is no failed proof". At `tip` the ledger
// is `stale`, every listed box of it `unchecked`, nothing `unlisted` or
// `undecided` of it, and `failed` is not set by the stale. The other
// ledger's reads are untouched.
describe("proveFigures — a tip range answering another block's state is stale, not unproven", () => {
  it("a credit tip range whose stateRoot is not the header's: credits stale, boxes unchecked, karma reads, failed false", async () => {
    const karma = karmaBoxFor(USER_BYTES, 100n, 1);
    const credit = creditBoxFor(USER_BYTES, 50n, 2);
    const otherCredit = creditBoxFor(USER_BYTES, 60n, 3);
    const fixtureA = buildHoldingsFixture({
      boxes: [karma, credit],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    // A different fixture (another `stateRoot`) answers the credit tip read.
    const fixtureB = buildHoldingsFixture({
      boxes: [karma, otherCredit],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const anchor = makeAnchor(TIP_H, fixtureA.stateRoot, SUFFIX_H, fixtureA.stateRoot);
    const fetch: HttpFetch = async (url: string): Promise<Response> => {
      const u = new URL(url);
      const m = u.pathname.match(/^\/api\/v1\/range\/([a-z]+)\/[0-9a-f]{64}$/);
      if (m && m[1] === 'credit' && Number(u.searchParams.get('atHeight')) === TIP_H) {
        const limit = Number(u.searchParams.get('limit') ?? '256');
        return jsonResponse(200, rangeAnswerFromProver(fixtureB.prover, fixtureB.stateRoot, TIP_H, 'credit', USER_BYTES, null, limit));
      }
      return twoHeightNode({ suffix: fixtureA, suffixHeight: SUFFIX_H, tip: fixtureA, tipHeight: TIP_H, heightAfter: TIP_H }).fetch(url);
    };
    const listing: Listing = {
      karma: { boxes: [{ boxId: karma.id!, value: '100' }], height: TIP_H, effective: '100' },
      credits: { boxes: [{ boxId: credit.id!, value: '50' }] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), fetch);
    expect(result.credits.holdings).toBe('stale');
    expect(result.boxes.map((b) => [b.boxClass, b.status])).toEqual([
      ['karma', 'proven'],
      ['credit', 'unchecked'],
    ]);
    expect(result.credits.unlisted).toBe(0n);
    expect(result.credits.undecided).toBe(0n);
    expect(result.credits.unchecked).toBe(50n);
    expect(result.karma.holdings).toBe('read');
    expect(result.karma.proven).toBe(100n);
    expect(result.failed).toBe(false);
  });

  // The shape check runs before the comparison: an answer at `tip` whose
  // stateRoot is missing, null, or no root reads `unproven` for the whole
  // range; the ledger `unproven`, every listed box of it `unproven`, and the
  // run `failed` (WEB_INTERFACE → The extension → "The verified figures").
  it.each([
    ['empty body', {}],
    ['body with only an error field', { error: 'internal' }],
    ['stateRoot a number', (base: Record<string, unknown>) => ({ ...base, stateRoot: 7 })],
    ['stateRoot null', (base: Record<string, unknown>) => ({ ...base, stateRoot: null })],
  ])('a credit tip answer with %s is unproven, the run failed', async (_label, body) => {
    const karma = karmaBoxFor(USER_BYTES, 100n, 1);
    const credit = creditBoxFor(USER_BYTES, 50n, 2);
    const fixture = buildHoldingsFixture({
      boxes: [karma, credit],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const anchor = makeAnchor(TIP_H, fixture.stateRoot, SUFFIX_H, fixture.stateRoot);
    const fetch: HttpFetch = async (url: string): Promise<Response> => {
      const u = new URL(url);
      const m = u.pathname.match(/^\/api\/v1\/range\/([a-z]+)\/[0-9a-f]{64}$/);
      if (m && m[1] === 'credit' && Number(u.searchParams.get('atHeight')) === TIP_H) {
        const limit = Number(u.searchParams.get('limit') ?? '256');
        const base = rangeAnswerFromProver(fixture.prover, fixture.stateRoot, TIP_H, 'credit', USER_BYTES, null, limit) as Record<string, unknown>;
        const payload = typeof body === 'function' ? body(base) : body;
        return jsonResponse(200, payload);
      }
      return twoHeightNode({ suffix: fixture, suffixHeight: SUFFIX_H, tip: fixture, tipHeight: TIP_H, heightAfter: TIP_H }).fetch(url);
    };
    const listing: Listing = {
      karma: { boxes: [{ boxId: karma.id!, value: '100' }], height: TIP_H, effective: '100' },
      credits: { boxes: [{ boxId: credit.id!, value: '50' }] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), fetch);
    expect(result.credits.holdings).toBe('unproven');
    expect(result.boxes.map((b) => [b.boxClass, b.status])).toEqual([
      ['karma', 'proven'],
      ['credit', 'unproven'],
    ]);
    expect(result.karma.holdings).toBe('read');
    expect(result.failed).toBe(true);
  });

  it("a credit suffix range whose stateRoot is not the header's: credits unproven at suffixHead, karma reads, failed true", async () => {
    const karma = karmaBoxFor(USER_BYTES, 100n, 1);
    const credit = creditBoxFor(USER_BYTES, 50n, 2);
    const fixtureA = buildHoldingsFixture({
      boxes: [karma, credit],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const fixtureB = buildHoldingsFixture({
      boxes: [karma],
      records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
    });
    const anchor = makeAnchor(TIP_H, fixtureA.stateRoot, SUFFIX_H, fixtureA.stateRoot);
    const fetch: HttpFetch = async (url: string): Promise<Response> => {
      const u = new URL(url);
      const m = u.pathname.match(/^\/api\/v1\/range\/([a-z]+)\/[0-9a-f]{64}$/);
      if (m && m[1] === 'credit' && Number(u.searchParams.get('atHeight')) === SUFFIX_H) {
        const limit = Number(u.searchParams.get('limit') ?? '256');
        return jsonResponse(200, rangeAnswerFromProver(fixtureB.prover, fixtureB.stateRoot, SUFFIX_H, 'credit', USER_BYTES, null, limit));
      }
      return twoHeightNode({ suffix: fixtureA, suffixHeight: SUFFIX_H, tip: fixtureA, tipHeight: TIP_H, heightAfter: TIP_H }).fetch(url);
    };
    const listing: Listing = {
      karma: { boxes: [{ boxId: karma.id!, value: '100' }], height: TIP_H, effective: '100' },
      credits: { boxes: [{ boxId: credit.id!, value: '50' }] },
    };
    const result = await proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), fetch);
    expect(result.credits.holdings).toBe('unproven');
    expect(result.boxes.map((b) => [b.boxClass, b.status])).toEqual([
      ['karma', 'proven'],
      ['credit', 'unproven'],
    ]);
    expect(result.karma.holdings).toBe('read');
    expect(result.failed).toBe(true);
  });
});

// WEB_INTERFACE → The extension → "The verified figures" — "That height is
// the node's word, and is taken only from `tip.height` to `heightAfter`". A
// listing height below `tip.height`, or above `heightAfter` where
// `heightAfter` was read, fails the valuation.
describe('proveFigures — the valuation is bounded between tip.height and heightAfter', () => {
  const karma = karmaBoxFor(USER_BYTES, 100n, 1);
  const fixture = buildHoldingsFixture({
    boxes: [karma],
    records: [{ identityId: USER_BYTES, record: RECORD_STANDING }],
  });

  function runWith(listingHeight: number, heightAfter: number | null) {
    const anchor = makeAnchor(TIP_H, fixture.stateRoot, SUFFIX_H, fixture.stateRoot);
    const node = twoHeightNode({ suffix: fixture, suffixHeight: SUFFIX_H, tip: fixture, tipHeight: TIP_H, heightAfter });
    const listing: Listing = {
      karma: { boxes: [{ boxId: karma.id!, value: '100' }], height: listingHeight, effective: '100' },
      credits: null,
    };
    return proveFigures('http://a', USER_HEX, listing, anchor, devnetProfile(), node.fetch);
  }

  it('listing height below tip.height: effective null, failed true', async () => {
    const r = await runWith(TIP_H - 1, TIP_H);
    expect(r.karma.effective).toBeNull();
    expect(r.failed).toBe(true);
  });

  it('listing height above heightAfter: effective null, failed true', async () => {
    const r = await runWith(TIP_H + 2, TIP_H + 1);
    expect(r.karma.effective).toBeNull();
    expect(r.failed).toBe(true);
  });

  it('heightAfter unread, listing height at tip.height: effective is a value, failed false', async () => {
    const r = await runWith(TIP_H, null);
    expect(r.karma.effective).not.toBeNull();
    expect(r.failed).toBe(false);
  });

  it('heightAfter unread, listing height above tip.height: effective is a value, failed false', async () => {
    const r = await runWith(TIP_H + 100, null);
    expect(r.karma.effective).not.toBeNull();
    expect(r.failed).toBe(false);
  });
});

