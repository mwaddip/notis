import { describe, it, expect, vi, afterEach } from 'vitest';
import { NodeClient, PageError } from '../src/api/client';
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
  it.fails('/karma — a box value "1e3" is refused', async () => {
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

  it.fails('/credits — a boxId in uppercase is refused', async () => {
    serveJson({
      userId: KEY, total: '0',
      boxes: [{ boxId: 'AB'.repeat(32), value: '1' }],
      boxCount: 1, next: null,
    });
    await expect(client().credits(KEY, { limit: 100 })).rejects.toBeInstanceOf(PageError);
  });

  it.fails('/status — a blockHeight of -1 is refused', async () => {
    serveJson({
      networkType: 'testnet', blockHeight: -1, protocolVersion: 1,
      postCount: 0, pendingPosts: 0, totalKarma: '0', liquidKarma: '0',
      totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 60,
      inviteBondMin: '100', inviteBondMax: '1000',
      membership: { memberCount: 2, memberBar: 1, memberLikesBar: 2 },
    });
    await expect(client().status()).rejects.toBeInstanceOf(PageError);
  });

  it.fails('/blocks/current — a height of 2**53 is refused', async () => {
    serveJson({ height: 2 ** 53, hash: null });
    await expect(client().currentBlock()).rejects.toBeInstanceOf(PageError);
  });

  it.fails('/vouches voucher arm — a row value "01" is refused', async () => {
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

  it.fails("/invites — a bond's inviteeName that breaks the name rule is refused", async () => {
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

  it.fails('/usernames/:name — an owner of 63 hex is refused', async () => {
    serveJson({
      name: 'alice', owner: 'a'.repeat(63),
      boxId: 'ab'.repeat(32), claimedAtBlock: 1,
    });
    await expect(client().usernameByName('alice')).rejects.toBeInstanceOf(PageError);
  });

  it.fails('GET /posts/:id — a confirmedAuthor that is not hex is refused', async () => {
    serveJson({ ...fullPost('ab'.repeat(32)), confirmedAuthor: 'not-hex' });
    await expect(client().post('ab'.repeat(32))).rejects.toBeInstanceOf(PageError);
  });

  it.fails('/posts — a feed row whose text is MAX_CONTENT_BYTES+1 bytes is refused', async () => {
    const tooLong = 'x'.repeat(MAX_CONTENT_BYTES + 1);
    serveJson({
      posts: [{ ...fullPost('ab'.repeat(32)), content: tooLong }],
      next: null, pending: [], pendingCount: 0,
    });
    await expect(client().feed({ limit: 30 })).rejects.toBeInstanceOf(PageError);
  });
});

describe("every page is held to the page the node serves", () => {
  it.fails('/posts — a page naming a next with fewer rows than the limit asked is refused', async () => {
    serveJson({
      posts: [fullPost('ab'.repeat(32))],
      next: 'cursor', pending: [], pendingCount: 0,
    });
    await expect(client().feed({ limit: 30 })).rejects.toBeInstanceOf(PageError);
  });
});

describe("every answer is read under its route's cap", () => {
  it.fails('/posts — a feed body one byte over its route cap is refused', async () => {
    const base = '{"posts":[],"next":null,"pending":[],"pendingCount":0,"pad":"';
    const tail = '"}';
    const padLen = FEED_PAGE_READ_BYTES + 1 - base.length - tail.length;
    serveRaw(`${base}${'x'.repeat(padLen)}${tail}`);
    await expect(client().feed({ limit: 30 })).rejects.toBeInstanceOf(PageError);
  });

  it.fails('/status — a status body one byte over its route cap is refused', async () => {
    const base = '{"pad":"';
    const tail = '"}';
    const padLen = STATUS_READ_BYTES + 1 - base.length - tail.length;
    serveRaw(`${base}${'x'.repeat(padLen)}${tail}`);
    await expect(client().status()).rejects.toBeInstanceOf(PageError);
  });
});

describe("every request runs under one deadline", () => {
  it.fails('fetch is called with an AbortSignal from a timed deadline', async () => {
    serveJson({ height: 100, hash: null });
    await client().currentBlock();
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("every paged read's URL carries its limit", () => {
  it.fails('/karma — a karma read with no page named carries a limit= query', async () => {
    serveJson({
      userId: KEY, total: '0', effective: '0', boxes: [], boxCount: 0,
      next: null, lastActivityBlock: 0, lastDecayBlock: 0,
      lifetimeLikesReceived: '0', memberSinceBlock: 0, memberBar: 0,
      memberVouches: 0, memberLikes: '0', invitesUsed: 0,
      member: false, invitesAvailable: 0, height: 100,
    });
    await client().karma(KEY);
    expect(calls[0]?.url).toMatch(/[?&]limit=\d+/);
  });
});
