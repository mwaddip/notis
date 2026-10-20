import { describe, it, expect, vi, afterEach } from 'vitest';
import { WriteClient, isRejection } from '../src/api/write';
import { WRITE_ANSWER_READ_BYTES } from '@dagsocial/node-reads';

// The write client wraps a serialised tx in the node's envelope and normalises
// both rejection body shapes into one Rejection { status, message }.

interface Call {
  url: string;
  method: string | undefined;
  body: unknown;
}
let last: Call;

function mockResponse(res: { ok: boolean; status: number; body?: unknown; statusText?: string; noJson?: boolean }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      last = {
        url: String(url),
        method: init?.method,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      };
      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText ?? '',
        json: async () => {
          if (res.noJson) throw new Error('not json');
          return res.body;
        },
      } as Response;
    }),
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
});

const write = (): WriteClient => new WriteClient(() => '');

describe('write client — request envelopes', () => {
  it('submitPost POSTs { tx, content } to /posts and returns the 2xx body', async () => {
    mockResponse({ ok: true, status: 200, body: { postId: 'p1', status: 'pending', expiresAtHeight: 5720, txId: 't1' } });
    const tx = { inputs: ['cc'.repeat(32)], outputs: [], signatures: {}, protocolVersion: 1 };
    const res = await write().submitPost(tx, 'a body');
    expect(last.url).toBe('/posts');
    expect(last.method).toBe('POST');
    expect(last.body).toEqual({ tx, content: 'a body' });
    expect(isRejection(res)).toBe(false);
    expect(res).toEqual({ postId: 'p1', status: 'pending', expiresAtHeight: 5720, txId: 't1' });
  });

  it('submitLike POSTs { tx } to /likes and returns the 2xx body', async () => {
    mockResponse({ ok: true, status: 200, body: { status: 'pending', txId: 't2', expiresAtHeight: 5720 } });
    const tx = { inputs: [], outputs: [], signatures: {}, protocolVersion: 1, likeTarget: 'ee'.repeat(32) };
    const res = await write().submitLike(tx);
    expect(last.url).toBe('/likes');
    expect(last.body).toEqual({ tx });
    expect(res).toEqual({ status: 'pending', txId: 't2', expiresAtHeight: 5720 });
  });

  it('submitVouch POSTs { tx } to /vouches', async () => {
    mockResponse({ ok: true, status: 200, body: { status: 'pending', txId: 'tv', expiresAtHeight: 5720 } });
    const tx = { inputs: [], outputs: [], signatures: {}, protocolVersion: 1 };
    const res = await write().submitVouch(tx);
    expect(last.url).toBe('/vouches');
    expect(last.method).toBe('POST');
    expect(last.body).toEqual({ tx });
    expect(res).toEqual({ status: 'pending', txId: 'tv', expiresAtHeight: 5720 });
  });

  it('submitUnvouch DELETEs { tx } to /vouches/:targetId — the one non-POST write', async () => {
    mockResponse({ ok: true, status: 200, body: { status: 'pending', txId: 'tu', expiresAtHeight: 5720, karmaReturnsAtBlock: 5800 } });
    const tx = { inputs: ['44'.repeat(32)], outputs: [], signatures: {}, protocolVersion: 1 };
    const res = await write().submitUnvouch('ee'.repeat(32), tx);
    expect(last.url).toBe(`/vouches/${'ee'.repeat(32)}`);
    expect(last.method).toBe('DELETE');
    expect(last.body).toEqual({ tx });
    // The node's extra karmaReturnsAtBlock is not modelled; the three bounded fields stand.
    expect(res).toMatchObject({ status: 'pending', txId: 'tu', expiresAtHeight: 5720 });
  });

  it('submitInvite POSTs { tx } to /invites and returns bondBoxId', async () => {
    mockResponse({ ok: true, status: 201, body: { status: 'pending', txId: 'ti', expiresAtHeight: 5720, bondBoxId: 'bond1' } });
    const tx = { inputs: [], outputs: [], signatures: {}, protocolVersion: 1 };
    const res = await write().submitInvite(tx);
    expect(last.url).toBe('/invites');
    expect(last.method).toBe('POST');
    expect(last.body).toEqual({ tx });
    expect(res).toEqual({ status: 'pending', txId: 'ti', expiresAtHeight: 5720, bondBoxId: 'bond1' });
  });

  it('submitClaim POSTs { tx } to /usernames and returns the 2xx body', async () => {
    mockResponse({ ok: true, status: 200, body: { status: 'pending', txId: 'tc', expiresAtHeight: 5720, name: 'Alice_01' } });
    const tx = { inputs: ['cc'.repeat(32)], outputs: [], signatures: {}, protocolVersion: 1 };
    const res = await write().submitClaim(tx);
    expect(last.url).toBe('/usernames');
    expect(last.method).toBe('POST');
    expect(last.body).toEqual({ tx });
    expect(res).toEqual({ status: 'pending', txId: 'tc', expiresAtHeight: 5720, name: 'Alice_01' });
  });

  it('submitBurn POSTs { tx } to /usernames/:name/burn and encodes the name', async () => {
    mockResponse({ ok: true, status: 200, body: { status: 'pending', txId: 'tb', expiresAtHeight: 5720 } });
    const tx = { inputs: ['cc'.repeat(32)], outputs: [], signatures: {}, protocolVersion: 1 };
    const res = await write().submitBurn('Alice_01', tx);
    expect(last.url).toBe('/usernames/Alice_01/burn');
    expect(last.method).toBe('POST');
    expect(last.body).toEqual({ tx });
    expect(res).toMatchObject({ status: 'pending', txId: 'tb', expiresAtHeight: 5720 });
  });

  it('submitWithdraw POSTs { tx } to /posts/:id/withdraw and returns the 2xx body', async () => {
    mockResponse({ ok: true, status: 201, body: { status: 'submitted', txId: 'tw', postId: 'p7', expiresAtHeight: 5720 } });
    const tx = { inputs: ['cc'.repeat(32)], outputs: [], signatures: {}, protocolVersion: 1, postWithdraw: { postId: 'p7' } };
    const res = await write().submitWithdraw('p7', tx);
    expect(last.url).toBe('/posts/p7/withdraw');
    expect(last.method).toBe('POST');
    expect(last.body).toEqual({ tx });
    expect(res).toEqual({ status: 'submitted', txId: 'tw', postId: 'p7', expiresAtHeight: 5720 });
  });
});

describe('write client — rejection normalisation', () => {
  it('the status+reason shape becomes { status, message: reason } — the 409 conflict', async () => {
    mockResponse({ ok: false, status: 409, body: { error: 409, reason: 'that karma is still tied up in a post' } });
    const res = await write().submitPost({}, 'x');
    expect(isRejection(res)).toBe(true);
    expect(res).toEqual({ status: 409, message: 'that karma is still tied up in a post' });
  });

  it('the message shape becomes { status, message: error } — the 503 mempool full', async () => {
    mockResponse({ ok: false, status: 503, body: { error: 'mempool full' } });
    expect(await write().submitLike({})).toEqual({ status: 503, message: 'mempool full' });
  });

  it('a 400 with the status+reason shape from the post route', async () => {
    mockResponse({ ok: false, status: 400, body: { error: 400, reason: 'tx.post required' } });
    expect(await write().submitPost({}, 'x')).toEqual({ status: 400, message: 'tx.post required' });
  });

  it('a 413 with no JSON body keeps the status text', async () => {
    mockResponse({ ok: false, status: 413, statusText: 'Payload Too Large', noJson: true });
    expect(await write().submitPost({}, 'x')).toEqual({ status: 413, message: 'Payload Too Large' });
  });

  it('a 500 message-shape body', async () => {
    mockResponse({ ok: false, status: 500, body: { error: 'Internal error' } });
    expect(await write().submitLike({})).toEqual({ status: 500, message: 'Internal error' });
  });

  it('a withdraw rejection normalises — the 403 not the author', async () => {
    mockResponse({ ok: false, status: 403, body: { error: 403, reason: 'not the post author' } });
    expect(await write().submitWithdraw('p7', {})).toEqual({ status: 403, message: 'not the post author' });
  });
});

// The hex id a well-formed 2xx carries; a route-shape reader rebuilds the
// answer from its own fields and refuses one that is not what the route
// serves (WEB_INTERFACE → Reading a node's answer → "Every answer is rebuilt
// from its own fields"). A rejection the reader answers takes the shape every
// transport-level refusal takes — status 0, a sentence a reader of the error
// line reads.
const TX_LOWER = 'ff'.repeat(32);

describe('write client — the shape the route serves', () => {
  it.fails('a 2xx carrying a txId that is not 64 lowercase hex is a client rejection', async () => {
    mockResponse({ ok: true, status: 200, body: { status: 'pending', txId: 'FF'.repeat(32), expiresAtHeight: 5720 } });
    const res = await write().submitLike({});
    expect(isRejection(res)).toBe(true);
    expect(res).toMatchObject({ status: 0 });
  });

  it.fails('a post 2xx whose postId is 63 hex is a client rejection', async () => {
    mockResponse({
      ok: true, status: 200,
      body: { postId: 'ab'.repeat(31) + 'a', status: 'pending', expiresAtHeight: 5720, txId: TX_LOWER },
    });
    const res = await write().submitPost({}, 'x');
    expect(isRejection(res)).toBe(true);
    expect(res).toMatchObject({ status: 0 });
  });
});

describe('write client — the cap and the deadline', () => {
  it.fails('a 2xx one byte over WRITE_ANSWER_READ_BYTES ends as a transport failure does', async () => {
    const over = 'a'.repeat(WRITE_ANSWER_READ_BYTES + 1);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(over, { status: 200 })));
    const res = await write().submitLike({});
    expect(isRejection(res)).toBe(true);
    expect(res).toMatchObject({ status: 0 });
  });

  it.fails('every write request carries the deadline signal', async () => {
    let seen: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return new Response(
        JSON.stringify({ status: 'pending', txId: TX_LOWER, expiresAtHeight: 5720 }),
        { status: 200 },
      );
    }));
    await write().submitLike({});
    expect(seen).toBeInstanceOf(AbortSignal);
  });
});

describe('write client — submitSend', () => {
  it('submitSend POSTs { tx } to /credits/transfer and returns the 2xx body', async () => {
    mockResponse({ ok: true, status: 200, body: { status: 'pending', txId: 't9', expiresAtHeight: 5720 } });
    const tx = { inputs: ['cc'.repeat(32)], outputs: [], signatures: {}, protocolVersion: 1 };
    const res = await write().submitSend(tx);
    expect(last.url).toBe('/credits/transfer');
    expect(last.method).toBe('POST');
    expect(last.body).toEqual({ tx });
    expect(res).toEqual({ status: 'pending', txId: 't9', expiresAtHeight: 5720 });
  });

  it('a rejection body normalises', async () => {
    mockResponse({ ok: false, status: 400, body: { error: 400, reason: 'insufficient credit inputs' } });
    expect(await write().submitSend({})).toEqual({ status: 400, message: 'insufficient credit inputs' });
  });
});
