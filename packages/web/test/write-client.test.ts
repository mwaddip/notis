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

function mockResponse(res: { status: number; body?: unknown; statusText?: string; noJson?: boolean }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      last = {
        url: String(url),
        method: init?.method,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      };
      const text = res.noJson ? 'not json' : JSON.stringify(res.body);
      return new Response(text, { status: res.status, statusText: res.statusText ?? '' });
    }),
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
});

const write = (): WriteClient => new WriteClient({ bases: () => [''], fetch: (url, init) => fetch(url, init) });

describe('write client — request envelopes', () => {
  it('submitPost POSTs { tx, content } to /posts and returns the 2xx body', async () => {
    mockResponse({ status: 200, body: { postId: '11'.repeat(32), status: 'pending', expiresAtHeight: 5720, txId: 'a1'.repeat(32) } });
    const tx = { inputs: ['cc'.repeat(32)], outputs: [], signatures: {}, protocolVersion: 1 };
    const res = await write().submitPost(tx, 'a body');
    expect(last.url).toBe('/posts');
    expect(last.method).toBe('POST');
    expect(last.body).toEqual({ tx, content: 'a body' });
    expect(isRejection(res)).toBe(false);
    expect(res).toEqual({ postId: '11'.repeat(32), status: 'pending', expiresAtHeight: 5720, txId: 'a1'.repeat(32) });
  });

  it('submitLike POSTs { tx } to /likes and returns the 2xx body', async () => {
    mockResponse({ status: 200, body: { status: 'pending', txId: 'a2'.repeat(32), expiresAtHeight: 5720 } });
    const tx = { inputs: [], outputs: [], signatures: {}, protocolVersion: 1, likeTarget: 'ee'.repeat(32) };
    const res = await write().submitLike(tx);
    expect(last.url).toBe('/likes');
    expect(last.body).toEqual({ tx });
    expect(res).toEqual({ status: 'pending', txId: 'a2'.repeat(32), expiresAtHeight: 5720 });
  });

  it('submitVouch POSTs { tx } to /vouches', async () => {
    mockResponse({ status: 200, body: { status: 'pending', txId: 'a3'.repeat(32), expiresAtHeight: 5720 } });
    const tx = { inputs: [], outputs: [], signatures: {}, protocolVersion: 1 };
    const res = await write().submitVouch(tx);
    expect(last.url).toBe('/vouches');
    expect(last.method).toBe('POST');
    expect(last.body).toEqual({ tx });
    expect(res).toEqual({ status: 'pending', txId: 'a3'.repeat(32), expiresAtHeight: 5720 });
  });

  it('submitUnvouch DELETEs { tx } to /vouches/:targetId — the one non-POST write', async () => {
    mockResponse({ status: 200, body: { status: 'pending', txId: 'a4'.repeat(32), expiresAtHeight: 5720, karmaReturnsAtBlock: 5800 } });
    const tx = { inputs: ['44'.repeat(32)], outputs: [], signatures: {}, protocolVersion: 1 };
    const res = await write().submitUnvouch('ee'.repeat(32), tx);
    expect(last.url).toBe(`/vouches/${'ee'.repeat(32)}`);
    expect(last.method).toBe('DELETE');
    expect(last.body).toEqual({ tx });
    // The node's extra karmaReturnsAtBlock is not modelled; the three bounded fields stand.
    expect(res).toMatchObject({ status: 'pending', txId: 'a4'.repeat(32), expiresAtHeight: 5720 });
  });

  it('submitInvite POSTs { tx } to /invites and returns bondBoxId', async () => {
    mockResponse({ status: 201, body: { status: 'pending', txId: 'a5'.repeat(32), expiresAtHeight: 5720, bondBoxId: 'b1'.repeat(32) } });
    const tx = { inputs: [], outputs: [], signatures: {}, protocolVersion: 1 };
    const res = await write().submitInvite(tx);
    expect(last.url).toBe('/invites');
    expect(last.method).toBe('POST');
    expect(last.body).toEqual({ tx });
    expect(res).toEqual({ status: 'pending', txId: 'a5'.repeat(32), expiresAtHeight: 5720, bondBoxId: 'b1'.repeat(32) });
  });

  it('submitClaim POSTs { tx } to /usernames and returns the 2xx body', async () => {
    mockResponse({ status: 200, body: { status: 'pending', txId: 'a6'.repeat(32), expiresAtHeight: 5720, name: 'Alice_01' } });
    const tx = { inputs: ['cc'.repeat(32)], outputs: [], signatures: {}, protocolVersion: 1 };
    const res = await write().submitClaim(tx);
    expect(last.url).toBe('/usernames');
    expect(last.method).toBe('POST');
    expect(last.body).toEqual({ tx });
    expect(res).toEqual({ status: 'pending', txId: 'a6'.repeat(32), expiresAtHeight: 5720, name: 'Alice_01' });
  });

  it('submitBurn POSTs { tx } to /usernames/:name/burn and encodes the name', async () => {
    mockResponse({ status: 200, body: { status: 'pending', txId: 'a7'.repeat(32), expiresAtHeight: 5720 } });
    const tx = { inputs: ['cc'.repeat(32)], outputs: [], signatures: {}, protocolVersion: 1 };
    const res = await write().submitBurn('Alice_01', tx);
    expect(last.url).toBe('/usernames/Alice_01/burn');
    expect(last.method).toBe('POST');
    expect(last.body).toEqual({ tx });
    expect(res).toMatchObject({ status: 'pending', txId: 'a7'.repeat(32), expiresAtHeight: 5720 });
  });

  it('submitWithdraw POSTs { tx } to /posts/:id/withdraw and returns the 2xx body', async () => {
    mockResponse({ status: 201, body: { status: 'submitted', txId: 'a8'.repeat(32), postId: 'c7'.repeat(32), expiresAtHeight: 5720 } });
    const tx = { inputs: ['cc'.repeat(32)], outputs: [], signatures: {}, protocolVersion: 1, postWithdraw: { postId: 'p7' } };
    const res = await write().submitWithdraw('p7', tx);
    expect(last.url).toBe('/posts/p7/withdraw');
    expect(last.method).toBe('POST');
    expect(last.body).toEqual({ tx });
    expect(res).toEqual({ status: 'submitted', txId: 'a8'.repeat(32), postId: 'c7'.repeat(32), expiresAtHeight: 5720 });
  });
});

describe('write client — rejection normalisation', () => {
  it('the status+reason shape becomes { status, message: reason } — the 409 conflict', async () => {
    mockResponse({ status: 409, body: { error: 409, reason: 'that karma is still tied up in a post' } });
    const res = await write().submitPost({}, 'x');
    expect(isRejection(res)).toBe(true);
    expect(res).toEqual({ status: 409, message: 'that karma is still tied up in a post' });
  });

  it('the message shape becomes { status, message: error } — the 503 mempool full', async () => {
    mockResponse({ status: 503, body: { error: 'mempool full' } });
    expect(await write().submitLike({})).toEqual({ status: 503, message: 'mempool full' });
  });

  it('a 400 with the status+reason shape from the post route', async () => {
    mockResponse({ status: 400, body: { error: 400, reason: 'tx.post required' } });
    expect(await write().submitPost({}, 'x')).toEqual({ status: 400, message: 'tx.post required' });
  });

  it('a 413 with no JSON body keeps the status text', async () => {
    mockResponse({ status: 413, statusText: 'Payload Too Large', noJson: true });
    expect(await write().submitPost({}, 'x')).toEqual({ status: 413, message: 'Payload Too Large' });
  });

  it('a 500 message-shape body', async () => {
    mockResponse({ status: 500, body: { error: 'Internal error' } });
    expect(await write().submitLike({})).toEqual({ status: 500, message: 'Internal error' });
  });

  it('a withdraw rejection normalises — the 403 not the author', async () => {
    mockResponse({ status: 403, body: { error: 403, reason: 'not the post author' } });
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
  it('a 2xx carrying a txId that is not 64 lowercase hex is a client rejection', async () => {
    mockResponse({ status: 200, body: { status: 'pending', txId: 'FF'.repeat(32), expiresAtHeight: 5720 } });
    const res = await write().submitLike({});
    expect(isRejection(res)).toBe(true);
    expect(res).toMatchObject({ status: 0 });
  });

  it('a post 2xx whose postId is 63 hex is a client rejection', async () => {
    mockResponse({
      status: 200,
      body: { postId: 'ab'.repeat(31) + 'a', status: 'pending', expiresAtHeight: 5720, txId: TX_LOWER },
    });
    const res = await write().submitPost({}, 'x');
    expect(isRejection(res)).toBe(true);
    expect(res).toMatchObject({ status: 0 });
  });

  it('an invite 2xx whose bondBoxId is 63 hex is a client rejection', async () => {
    mockResponse({
      status: 200,
      body: { txId: TX_LOWER, status: 'pending', expiresAtHeight: 5720, bondBoxId: 'ab'.repeat(31) + 'a' },
    });
    const res = await write().submitInvite({});
    expect(isRejection(res)).toBe(true);
    expect(res).toMatchObject({ status: 0 });
  });

  it('a withdraw 2xx whose postId is in uppercase is a client rejection', async () => {
    mockResponse({
      status: 200,
      body: { txId: TX_LOWER, status: 'pending', expiresAtHeight: 5720, postId: 'AB'.repeat(32) },
    });
    const res = await write().submitWithdraw('p7', {});
    expect(isRejection(res)).toBe(true);
    expect(res).toMatchObject({ status: 0 });
  });

  it('a claim 2xx whose name holds a space is a client rejection', async () => {
    mockResponse({
      status: 200,
      body: { txId: TX_LOWER, status: 'pending', expiresAtHeight: 5720, name: 'two words' },
    });
    const res = await write().submitClaim({});
    expect(isRejection(res)).toBe(true);
    expect(res).toMatchObject({ status: 0 });
  });
});

describe('write client — the cap and the deadline', () => {
  it('a 2xx one byte over WRITE_ANSWER_READ_BYTES ends as a transport failure does', async () => {
    const answer = { status: 'pending', txId: TX_LOWER, expiresAtHeight: 5720 };
    const bare = JSON.stringify({ ...answer, pad: '' });
    const pad = 'a'.repeat(WRITE_ANSWER_READ_BYTES + 1 - new TextEncoder().encode(bare).length);
    const over = JSON.stringify({ ...answer, pad });
    expect(new TextEncoder().encode(over).length).toBe(WRITE_ANSWER_READ_BYTES + 1);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(over, { status: 200 })));
    const res = await write().submitLike({});
    expect(isRejection(res)).toBe(true);
    expect(res).toMatchObject({ status: 0 });
  });

  it('every write request carries the deadline signal', async () => {
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
    mockResponse({ status: 200, body: { status: 'pending', txId: 'a9'.repeat(32), expiresAtHeight: 5720 } });
    const tx = { inputs: ['cc'.repeat(32)], outputs: [], signatures: {}, protocolVersion: 1 };
    const res = await write().submitSend(tx);
    expect(last.url).toBe('/credits/transfer');
    expect(last.method).toBe('POST');
    expect(last.body).toEqual({ tx });
    expect(res).toEqual({ status: 'pending', txId: 'a9'.repeat(32), expiresAtHeight: 5720 });
  });

  it('a rejection body normalises', async () => {
    mockResponse({ status: 400, body: { error: 400, reason: 'insufficient credit inputs' } });
    expect(await write().submitSend({})).toEqual({ status: 400, message: 'insufficient credit inputs' });
  });
});

// WEB_INTERFACE → The extension → "A write goes to one node and, with no
// answer, to the next": a send reads `bases()` once, posts the same bytes to
// each in turn, and stops on the first response of any status. Every base
// failing reads as today's transport failure, `timedOut: true` carried when
// the last attempt was ended by the deadline. The web build hands
// `[prefs.node]` and the behaviour is unchanged.

const TX_OK = 'ff'.repeat(32);
function okLikeBody(): unknown {
  return { status: 'pending', txId: TX_OK, expiresAtHeight: 5720 };
}
function timeoutError(): Error {
  // The error `AbortSignal.timeout` aborts with — `fetchJson` reads the
  // deadline off its `name` (WEB_INTERFACE → Reading a node's answer →
  // "A failure the deadline ended says so").
  return Object.assign(new Error('timed out'), { name: 'TimeoutError' });
}

describe('a write with no answer goes again, the same bytes, to the next node', () => {
  interface Attempt { url: string; body: string | undefined }
  function stubBases(bases: string[], per: Array<(a: Attempt) => Response | Promise<Response> | Error>): Attempt[] {
    const attempts: Attempt[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const attempt: Attempt = { url: String(url), body: init?.body as string | undefined };
      attempts.push(attempt);
      const step = per[attempts.length - 1];
      if (step === undefined) throw new Error(`no step for attempt ${attempts.length}`);
      const out = step(attempt);
      if (out instanceof Error) throw out;
      return out;
    }));
    void bases; // the write client reads bases() itself; the stub only answers per attempt
    return attempts;
  }
  function writeOver(bases: string[]): WriteClient {
    return new WriteClient({ bases: () => bases, fetch: (url, init) => fetch(url, init) });
  }

  it('every base failing reads as today\'s transport failure — `timedOut: true` the last attempt\'s', async () => {
    const attempts = stubBases(['http://a', 'http://b'], [
      () => new Error('ECONNREFUSED'),
      () => timeoutError(),
    ]);
    const res = await writeOver(['http://a', 'http://b']).submitLike({});
    expect(attempts.length).toBe(2);
    expect(isRejection(res)).toBe(true);
    if (!isRejection(res)) return;
    expect(res.status).toBe(0);
    expect(res.timedOut).toBe(true);
    expect(res.message).toBe('timed out');
  });

  it('two attempts carry the same body bytes', async () => {
    const attempts = stubBases(['http://a', 'http://b'], [
      () => timeoutError(),
      () => new Response(JSON.stringify(okLikeBody()), { status: 200 }),
    ]);
    const tx = { inputs: ['cc'.repeat(32)], outputs: [], signatures: {}, protocolVersion: 1 };
    await writeOver(['http://a', 'http://b']).submitLike(tx);
    expect(attempts.length).toBe(2);
    expect(attempts[0]!.body).toBeDefined();
    expect(attempts[0]!.body).toBe(attempts[1]!.body);
  });

  it('a 400 from the first base is the answer — no second request', async () => {
    const attempts = stubBases(['http://a', 'http://b'], [
      () => new Response(JSON.stringify({ error: 400, reason: 'bad' }), { status: 400 }),
    ]);
    const res = await writeOver(['http://a', 'http://b']).submitLike({});
    expect(attempts.length).toBe(1);
    expect(isRejection(res)).toBe(true);
    if (!isRejection(res)) return;
    expect(res.status).toBe(400);
    expect(res.message).toBe('bad');
  });

  it('one base in the list — one request, as the web build sends', async () => {
    const attempts = stubBases(['http://a'], [
      () => new Response(JSON.stringify(okLikeBody()), { status: 200 }),
    ]);
    const res = await writeOver(['http://a']).submitLike({});
    expect(attempts.length).toBe(1);
    expect(attempts[0]!.url).toBe('http://a/likes');
    expect(isRejection(res)).toBe(false);
  });
});
