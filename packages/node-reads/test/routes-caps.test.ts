// WEB_INTERFACE → Reading a node's answer
// CONSTANTS → Client reads

import { describe, it, expect } from 'vitest';
import { readCappedJson } from '../src/http.js';
import {
  FEED_PAGE_READ_BYTES,
  THREAD_READ_BYTES,
  STATUS_READ_BYTES,
  VOUCH_PAGE_READ_BYTES,
  BOND_PAGE_READ_BYTES,
  WRITE_ANSWER_READ_BYTES,
} from '../src/caps.js';
import {
  MAX_CONTENT_BYTES,
  MAX_PARENT_REFS,
  PAGE_LIMIT_MAX,
  USERNAME_MAX_BYTES,
} from '@dagsocial/types';

// The widest a safe-integer field writes — every height, index and count on
// the node's answers; 16 digits.
const SAFE_INT = Number.MAX_SAFE_INTEGER;

// The widest a box value's decimal writes — 2^63 - 1, 19 digits
// (TYPES_INTERFACE → Box value domain).
const BOX_VALUE_MAX_STR = (2n ** 63n - 1n).toString();

// Count the body as a `TextEncoder` does; the capped reader counts the same
// bytes off the wire (WEB_INTERFACE → Reading a node's answer).
function byteLength(json: string): number {
  return new TextEncoder().encode(json).byteLength;
}

// A 64-character lowercase hex string stood in for an id, with the character
// `ch` repeated. Only the length counts here, not the alphabet.
function hex64(ch: string): string {
  return ch.repeat(64);
}

// The widest handle a row carries — `USERNAME_MAX_BYTES` bytes of
// `[A-Za-z0-9_]` (TYPES_INTERFACE → Content limits).
function nameOfMaxBytes(): string {
  return 'A'.repeat(USERNAME_MAX_BYTES);
}

// Content whose every byte serialises to two of the JSON form — 300 double
// quotes become 600 escaped bytes under `JSON.stringify`
// (`verifyContentCharacters`: only `"`, `\` and `\n` are escaped).
function worstContent(): string {
  return '"'.repeat(MAX_CONTENT_BYTES);
}

// The widest `next` the feed and thread routes write: a post-key cursor
// `${blockHeight}:${blockIndex}`, each a safe integer written in decimal.
function postKeyCursor(): string {
  return `${SAFE_INT}:${SAFE_INT}`;
}

// A full-form `PostJson` row at every field's widest — a feed row without
// `tx` and the thread's rows share this shape (NODE_INTERFACE → Posts).
function longestFullPostRow(): Record<string, unknown> {
  return {
    id: hex64('a'),
    txId: hex64('b'),
    content: worstContent(),
    contentHash: hex64('c'),
    author: hex64('d'),
    parentRefs: Array.from({ length: MAX_PARENT_REFS }, () => hex64('e')),
    protocolVersion: SAFE_INT,
    type: 'profile',
    status: 'confirmed',
    blockHeight: SAFE_INT,
    blockIndex: SAFE_INT,
    blockCreatedAt: SAFE_INT,
    likeCount: SAFE_INT,
    descendantCount: SAFE_INT,
    authorName: nameOfMaxBytes(),
    likedByViewer: false,
  };
}

// A page with `PAGE_LIMIT_MAX` of the longest row in `posts`, as many in
// `pending`, every count at `Number.MAX_SAFE_INTEGER`'s width and the widest
// `next` the route writes.
function longestFeedAnswer(): string {
  const posts = Array.from({ length: PAGE_LIMIT_MAX }, () => longestFullPostRow());
  const pending = Array.from({ length: PAGE_LIMIT_MAX }, () => longestFullPostRow());
  return JSON.stringify({
    posts,
    next: postKeyCursor(),
    pending,
    pendingCount: SAFE_INT,
  });
}

describe('FEED_PAGE_READ_BYTES', () => {
  it('reads the longest honest answer under the cap', async () => {
    const body = longestFeedAnswer();
    // control — the honest body sits at or under the cap
    expect(byteLength(body)).toBeLessThanOrEqual(FEED_PAGE_READ_BYTES);
    const res = new Response(body, { status: 200 });
    const result = await readCappedJson(res, FEED_PAGE_READ_BYTES);
    // last — the body parses
    expect(result.ok).toBe(true);
  });

  it('refuses a body one byte over the cap', async () => {
    const body = 'x'.repeat(FEED_PAGE_READ_BYTES + 1);
    const res = new Response(body, { status: 200 });
    const result = await readCappedJson(res, FEED_PAGE_READ_BYTES);
    // last — refused, body names the cap
    expect(result).toEqual({
      ok: false,
      status: 200,
      body: `body over ${FEED_PAGE_READ_BYTES} bytes`,
    });
  });
});

// A thread answer carries a subject row and three lists of `PAGE_LIMIT_MAX`
// rows — ancestors, descendants and pending — each row the longest full form,
// the counts at `Number.MAX_SAFE_INTEGER`'s width and the widest `next`.
function longestThreadAnswer(): string {
  const rowList = (n: number) =>
    Array.from({ length: n }, () => longestFullPostRow());
  return JSON.stringify({
    post: longestFullPostRow(),
    ancestors: rowList(PAGE_LIMIT_MAX),
    ancestorCount: SAFE_INT,
    descendants: rowList(PAGE_LIMIT_MAX),
    descendantCount: SAFE_INT,
    next: postKeyCursor(),
    pending: rowList(PAGE_LIMIT_MAX),
    pendingCount: SAFE_INT,
  });
}

describe('THREAD_READ_BYTES', () => {
  it('reads the longest honest answer under the cap', async () => {
    const body = longestThreadAnswer();
    expect(byteLength(body)).toBeLessThanOrEqual(THREAD_READ_BYTES);
    const res = new Response(body, { status: 200 });
    const result = await readCappedJson(res, THREAD_READ_BYTES);
    expect(result.ok).toBe(true);
  });

  it('refuses a body one byte over the cap', async () => {
    const body = 'x'.repeat(THREAD_READ_BYTES + 1);
    const res = new Response(body, { status: 200 });
    const result = await readCappedJson(res, THREAD_READ_BYTES);
    expect(result).toEqual({
      ok: false,
      status: 200,
      body: `body over ${THREAD_READ_BYTES} bytes`,
    });
  });
});

// `/status` with every field at its widest: the network name, heights and
// counts at `Number.MAX_SAFE_INTEGER`'s width, every sum a 19-digit decimal
// (karma `pool.value + circulating == BOX_VALUE_BOUND - 1`, so each karma
// sum sits inside the box value domain — `node/src/store/system.ts`'s
// `KARMA_SUPPLY_TOTAL`; `totalCredits` sits in the box value domain by the
// box value domain itself — a stricter bound reads from `creditEmissionTotal`,
// `42_264_000_000_000_000n`, 17 digits), the bond bounds in the box value
// domain, and the membership object.
function longestStatusAnswer(): string {
  return JSON.stringify({
    networkType: 'mainnet',
    blockHeight: SAFE_INT,
    protocolVersion: SAFE_INT,
    postCount: SAFE_INT,
    pendingPosts: SAFE_INT,
    usernameCount: SAFE_INT,
    totalKarma: BOX_VALUE_MAX_STR,
    liquidKarma: BOX_VALUE_MAX_STR,
    totalCredits: BOX_VALUE_MAX_STR,
    inviteProbationBlocks: SAFE_INT,
    vouchCooldownBlocks: SAFE_INT,
    inviteBondMin: BOX_VALUE_MAX_STR,
    inviteBondMax: BOX_VALUE_MAX_STR,
    membership: {
      memberCount: SAFE_INT,
      memberBar: SAFE_INT,
      memberLikesBar: SAFE_INT,
    },
  });
}

describe('STATUS_READ_BYTES', () => {
  it('reads the longest honest answer under the cap', async () => {
    const body = longestStatusAnswer();
    expect(byteLength(body)).toBeLessThanOrEqual(STATUS_READ_BYTES);
    const res = new Response(body, { status: 200 });
    const result = await readCappedJson(res, STATUS_READ_BYTES);
    expect(result.ok).toBe(true);
  });

  it('refuses a body one byte over the cap', async () => {
    const body = 'x'.repeat(STATUS_READ_BYTES + 1);
    const res = new Response(body, { status: 200 });
    const result = await readCappedJson(res, STATUS_READ_BYTES);
    expect(result).toEqual({
      ok: false,
      status: 200,
      body: `body over ${STATUS_READ_BYTES} bytes`,
    });
  });
});

// The widest `/vouches` arm — the voucher arm's rows carry a `boxId`, a
// `value` in the box value domain, `createdAtBlock` at `Number.MAX_SAFE_INTEGER`
// and two keys with two names; the `next` is a `boxId`
// (NODE_INTERFACE → Vouches).
function longestVoucherRow(): Record<string, unknown> {
  return {
    boxId: hex64('a'),
    value: BOX_VALUE_MAX_STR,
    createdAtBlock: SAFE_INT,
    voucherId: hex64('b'),
    voucherName: nameOfMaxBytes(),
    targetId: hex64('c'),
    targetName: nameOfMaxBytes(),
  };
}

function longestVouchAnswer(): string {
  return JSON.stringify({
    vouches: Array.from({ length: PAGE_LIMIT_MAX }, () => longestVoucherRow()),
    count: SAFE_INT,
    next: hex64('f'),
  });
}

describe('VOUCH_PAGE_READ_BYTES', () => {
  it('reads the longest honest answer under the cap', async () => {
    const body = longestVouchAnswer();
    expect(byteLength(body)).toBeLessThanOrEqual(VOUCH_PAGE_READ_BYTES);
    const res = new Response(body, { status: 200 });
    const result = await readCappedJson(res, VOUCH_PAGE_READ_BYTES);
    expect(result.ok).toBe(true);
  });

  it('refuses a body one byte over the cap', async () => {
    const body = 'x'.repeat(VOUCH_PAGE_READ_BYTES + 1);
    const res = new Response(body, { status: 200 });
    const result = await readCappedJson(res, VOUCH_PAGE_READ_BYTES);
    expect(result).toEqual({
      ok: false,
      status: 200,
      body: `body over ${VOUCH_PAGE_READ_BYTES} bytes`,
    });
  });
});

// A bond row the invite listing writes — `id`, `value` in the box value
// domain, two keys with two names and `createdAtBlock` at
// `Number.MAX_SAFE_INTEGER` (NODE_INTERFACE → UTXO queries).
function longestBondRow(): Record<string, unknown> {
  return {
    id: hex64('a'),
    value: BOX_VALUE_MAX_STR,
    inviterId: hex64('b'),
    inviterName: nameOfMaxBytes(),
    inviteePublicKey: hex64('c'),
    inviteeName: nameOfMaxBytes(),
    createdAtBlock: SAFE_INT,
  };
}

function longestBondAnswer(): string {
  return JSON.stringify({
    bonds: Array.from({ length: PAGE_LIMIT_MAX }, () => longestBondRow()),
    bondCount: SAFE_INT,
    next: hex64('f'),
  });
}

describe('BOND_PAGE_READ_BYTES', () => {
  it('reads the longest honest answer under the cap', async () => {
    const body = longestBondAnswer();
    expect(byteLength(body)).toBeLessThanOrEqual(BOND_PAGE_READ_BYTES);
    const res = new Response(body, { status: 200 });
    const result = await readCappedJson(res, BOND_PAGE_READ_BYTES);
    expect(result.ok).toBe(true);
  });

  it('refuses a body one byte over the cap', async () => {
    const body = 'x'.repeat(BOND_PAGE_READ_BYTES + 1);
    const res = new Response(body, { status: 200 });
    const result = await readCappedJson(res, BOND_PAGE_READ_BYTES);
    expect(result).toEqual({
      ok: false,
      status: 200,
      body: `body over ${BOND_PAGE_READ_BYTES} bytes`,
    });
  });
});

// The longest rejection a write route writes: `admitWriteTx` prefixes the
// engine's envelope error with its opening words, and `respondError`
// wraps it as either `{ error: <status>, reason: <message> }` or
// `{ error: <message> }`. The envelope error for a non-`Uint8Array` signature
// value interpolates `describeValue` of a value — a string there is sliced to
// 64 code units with an ellipsis appended, serialised through `JSON.stringify`
// — so 64 control characters escaped as `\u0000` plus `…` is the widest
// `describeValue` writes, and the signatures hex key is 64 characters. The
// widest opening words (`'Invalid postWithdraw transaction: '`, 34 characters)
// go with the message-shape response (`POST /posts/:id/withdraw`); the
// status-plus-reason shape adds `"error":<status>,"reason":`, which outweighs
// the shorter opening words of the other routes.
function longestRejectionBody(): string {
  const sigKey = hex64('a');
  const sliced = '\u0000'.repeat(64) + '…';
  const described = JSON.stringify(sliced);
  const message =
    `Invalid postWithdraw transaction: Invalid tx envelope: signatures['${sigKey}'] ` +
    `must be a Uint8Array, got ${described}`;
  return JSON.stringify({ error: 400, reason: message });
}

describe('WRITE_ANSWER_READ_BYTES', () => {
  it('reads the longest honest rejection under the cap', async () => {
    const body = longestRejectionBody();
    expect(byteLength(body)).toBeLessThanOrEqual(WRITE_ANSWER_READ_BYTES);
    const res = new Response(body, { status: 400 });
    const result = await readCappedJson(res, WRITE_ANSWER_READ_BYTES);
    // control — the body is held as the node's text, under the cap
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // last — the status is kept and the body is the node's own text
    expect(result.status).toBe(400);
    expect(result.body).toBe(body);
  });

  it('refuses a body one byte over the cap', async () => {
    const body = 'x'.repeat(WRITE_ANSWER_READ_BYTES + 1);
    const res = new Response(body, { status: 400 });
    const result = await readCappedJson(res, WRITE_ANSWER_READ_BYTES);
    expect(result).toEqual({
      ok: false,
      status: 400,
      body: `body over ${WRITE_ANSWER_READ_BYTES} bytes`,
    });
  });
});
