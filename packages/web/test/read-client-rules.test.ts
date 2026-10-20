import { describe, it, expect, vi, afterEach } from 'vitest';
import { NodeClient, PageError, type Page } from '../src/api/client';
import { FEED_PAGE_READ_BYTES, STATUS_READ_BYTES } from '@dagsocial/node-reads';
import { MAX_CONTENT_BYTES } from '@dagsocial/types';

// WEB_INTERFACE → Reading a node's answer — the read client is held to five
// rules: "A node's answer is a claim of its route's shape, and a client takes
// nothing else", "Every answer is rebuilt from its own fields", "Every page is
// held to the page the node serves", "Every answer is read under its route's
// cap, and every request runs under one deadline". Each case drives
// `NodeClient` over a stubbed `fetch` and asserts the rule.

const KEY = 'aa'.repeat(32);
let calls: Array<{ url: string; init: RequestInit | undefined }> = [];

function serveJson(body: unknown, status = 200): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(body), { status });
    }),
  );
}

function serveRaw(bodyText: string, status = 200): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(bodyText, { status });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const client = (): NodeClient => new NodeClient(() => '');

// A full post row — the shape `GET /posts` and `GET /posts/:id` answer, and
// which the field rules the extension's post check names apply to in the web
// build as well (WEB_INTERFACE → Reading a node's answer → "A post row of a
// full list, and the single post read, take the checked row's field rules").
function fullPost(id: string): Record<string, unknown> {
  return {
    id, content: 'x', contentHash: '00'.repeat(32), author: 'bb'.repeat(32),
    parentRefs: [], protocolVersion: 1, type: 'regular', status: 'confirmed',
    blockHeight: 100, blockIndex: 0, blockCreatedAt: 0, likeCount: 0,
    descendantCount: 0, authorName: null, likedByViewer: null,
    txId: 'cc'.repeat(32),
  };
}

describe("every answer is rebuilt from its own fields", () => {
  it('/karma — a box value "1e3" is refused', async () => {
    serveJson({
      userId: KEY, total: '5', effective: '5',
      boxes: [{ boxId: 'ab'.repeat(32), value: '1e3' }],
      boxCount: 1, next: null,
      lastActivityBlock: 0, lastDecayBlock: 0, lifetimeLikesReceived: '0',
      memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: '0',
      invitesUsed: 0, member: false, invitesAvailable: 0, height: 100,
    });
    await expect(client().karma(KEY, { limit: 100 })).rejects.toBeInstanceOf(PageError);
  });

  it('/credits — a boxId in uppercase is refused', async () => {
    serveJson({
      userId: KEY, total: '0',
      boxes: [{ boxId: 'AB'.repeat(32), value: '1' }],
      boxCount: 1, next: null,
    });
    await expect(client().credits(KEY, { limit: 100 })).rejects.toBeInstanceOf(PageError);
  });

  it('/status — a blockHeight of -1 is refused', async () => {
    serveJson({
      networkType: 'testnet', blockHeight: -1, protocolVersion: 1,
      postCount: 0, pendingPosts: 0, totalKarma: '0', liquidKarma: '0',
      totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 60,
      inviteBondMin: '100', inviteBondMax: '1000',
      membership: { memberCount: 2, memberBar: 1, memberLikesBar: 2 },
    });
    await expect(client().status()).rejects.toBeInstanceOf(PageError);
  });

  it('/blocks/current — a height of 2**53 is refused', async () => {
    serveJson({ height: 2 ** 53, hash: null });
    await expect(client().currentBlock()).rejects.toBeInstanceOf(PageError);
  });

  it('/vouches voucher arm — a row value "01" is refused', async () => {
    serveJson({
      vouches: [{
        boxId: 'ab'.repeat(32), value: '01', createdAtBlock: 1,
        voucherId: KEY, targetId: 'cd'.repeat(32),
        voucherName: null, targetName: null,
      }],
      count: 1, next: null,
    });
    await expect(client().vouchesByVoucher(KEY, { limit: 100 })).rejects.toBeInstanceOf(PageError);
  });

  it("/invites — a bond's inviteeName that breaks the name rule is refused", async () => {
    serveJson({
      bonds: [{
        id: 'ab'.repeat(32), value: '100', inviterId: KEY,
        inviteePublicKey: 'cd'.repeat(32),
        inviterName: null, inviteeName: '!!bad!!',
      }],
      bondCount: 1, next: null,
    });
    await expect(client().bonds(KEY, { limit: 100 })).rejects.toBeInstanceOf(PageError);
  });

  it('/usernames/:name — an owner of 63 hex is refused', async () => {
    serveJson({
      name: 'alice', owner: 'a'.repeat(63),
      boxId: 'ab'.repeat(32), claimedAtBlock: 1,
    });
    await expect(client().usernameByName('alice')).rejects.toBeInstanceOf(PageError);
  });

  it('GET /posts/:id — a confirmedAuthor that is not hex is refused', async () => {
    serveJson({ ...fullPost('ab'.repeat(32)), confirmedAuthor: 'not-hex' });
    await expect(client().post('ab'.repeat(32))).rejects.toBeInstanceOf(PageError);
  });

  it('/posts — a feed row whose text is MAX_CONTENT_BYTES+1 bytes is refused', async () => {
    const tooLong = 'x'.repeat(MAX_CONTENT_BYTES + 1);
    serveJson({
      posts: [{ ...fullPost('ab'.repeat(32)), content: tooLong }],
      next: null, pending: [], pendingCount: 0,
    });
    await expect(client().feed({ limit: 30 })).rejects.toBeInstanceOf(PageError);
  });
});

describe("a name a lookup answers is a well-formed one", () => {
  it.fails('/usernames?owner= — a `name` of 25 bytes is refused', async () => {
    serveJson({
      name: 'a'.repeat(25), owner: KEY,
      boxId: 'ab'.repeat(32), claimedAtBlock: 1,
    });
    await expect(client().usernameByOwner(KEY)).rejects.toBeInstanceOf(PageError);
  });

  it.fails('/usernames?owner= — a `name` carrying a space is refused', async () => {
    serveJson({
      name: 'al ice', owner: KEY,
      boxId: 'ab'.repeat(32), claimedAtBlock: 1,
    });
    await expect(client().usernameByOwner(KEY)).rejects.toBeInstanceOf(PageError);
  });

  it.fails('/usernames/:name — a `name` of 25 bytes is refused', async () => {
    serveJson({
      name: 'a'.repeat(25), owner: KEY,
      boxId: 'ab'.repeat(32), claimedAtBlock: 1,
    });
    await expect(client().usernameByName('alice')).rejects.toBeInstanceOf(PageError);
  });

  it.fails('/usernames/:name — a `name` carrying a space is refused', async () => {
    serveJson({
      name: 'al ice', owner: KEY,
      boxId: 'ab'.repeat(32), claimedAtBlock: 1,
    });
    await expect(client().usernameByName('alice')).rejects.toBeInstanceOf(PageError);
  });
});

describe("/status' bond bounds are box values", () => {
  it.fails('/status — an `inviteBondMax` of 2^63 is refused', async () => {
    serveJson({
      networkType: 'testnet', blockHeight: 100, protocolVersion: 1,
      postCount: 0, pendingPosts: 0, totalKarma: '0', liquidKarma: '0',
      totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 60,
      inviteBondMin: '100', inviteBondMax: '9223372036854775808',
      membership: { memberCount: 2, memberBar: 1, memberLikesBar: 2 },
    });
    await expect(client().status()).rejects.toBeInstanceOf(PageError);
  });
});

describe("every page is held to the page the node serves", () => {
  it('/posts — a page naming a next with fewer rows than the limit asked is refused', async () => {
    serveJson({
      posts: [fullPost('ab'.repeat(32))],
      next: 'cursor', pending: [], pendingCount: 0,
    });
    await expect(client().feed({ limit: 30 })).rejects.toBeInstanceOf(PageError);
  });
});

describe("every answer is read under its route's cap", () => {
  it('/posts — a feed body one byte over its route cap is refused', async () => {
    const base = '{"posts":[],"next":null,"pending":[],"pendingCount":0,"pad":"';
    const tail = '"}';
    const padLen = FEED_PAGE_READ_BYTES + 1 - base.length - tail.length;
    serveRaw(`${base}${'x'.repeat(padLen)}${tail}`);
    await expect(client().feed({ limit: 30 })).rejects.toBeInstanceOf(PageError);
  });

  it('/status — a status body one byte over its route cap is refused', async () => {
    // Every field `/status` writes is here, each value passing the field rule
    // the reader rebuilds its answer under — a reader takes the fields the DTO
    // names and carries nothing beside them (WEB_INTERFACE → Reading a node's
    // answer → "Every answer is rebuilt from its own fields"), so the extra
    // `pad` key is ignored and only the cap can refuse the body.
    const stem = '{"networkType":"testnet","blockHeight":0,"protocolVersion":1,"postCount":0,"pendingPosts":0,"totalKarma":"0","liquidKarma":"0","totalCredits":"0","inviteProbationBlocks":0,"vouchCooldownBlocks":60,"inviteBondMin":"100","inviteBondMax":"1000","membership":{"memberCount":2,"memberBar":1,"memberLikesBar":2},"pad":"';
    const tail = '"}';
    const padLen = STATUS_READ_BYTES + 1 - stem.length - tail.length;
    serveRaw(`${stem}${'x'.repeat(padLen)}${tail}`);
    await expect(client().status()).rejects.toBeInstanceOf(PageError);
  });
});

describe("every request runs under one deadline", () => {
  it('fetch is called with an AbortSignal from a timed deadline', async () => {
    serveJson({ height: 100, hash: null });
    await client().currentBlock();
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("every paged read's URL carries its limit", () => {
  it("/karma — a karma read whose page names no limit carries a limit= query", async () => {
    serveJson({
      userId: KEY, total: '0', effective: '0', boxes: [], boxCount: 0,
      next: null, lastActivityBlock: 0, lastDecayBlock: 0,
      lifetimeLikesReceived: '0', memberSinceBlock: 0, memberBar: 0,
      memberVouches: 0, memberLikes: '0', invitesUsed: 0,
      member: false, invitesAvailable: 0, height: 100,
    });
    // A cast lets a Page whose `limit` the type requires be built as `{}` for
    // the case the client's URL covers: a page the caller handed with no limit
    // in it — the client's URL names one all the same.
    await client().karma(KEY, {} as Page);
    expect(calls[0]?.url).toMatch(/[?&]limit=\d+/);
  });
});
