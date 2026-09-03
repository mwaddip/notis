import { describe, it, expect, vi, afterEach } from 'vitest';
import { WriteClient, isRejection } from '../src/api/write';

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
});
