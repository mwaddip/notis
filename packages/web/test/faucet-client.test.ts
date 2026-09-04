import { describe, it, expect, vi, afterEach } from 'vitest';
import { FaucetClient, faucetLine } from '../src/api/faucet';

// The faucet client POSTs { pubkey } to <base>/karma and returns either the grant
// or one normalised Rejection; faucetLine turns a rejection into one register
// sentence (WEB_INTERFACE → The faucet step).

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

const faucet = (base = '/faucet'): FaucetClient => new FaucetClient(() => base);
const KEY = 'ab'.repeat(32);
const TX = 'cc'.repeat(32); // a well-formed 64-hex transaction id

describe('faucet client — the request and the grant', () => {
  it('askKarma POSTs { pubkey } to <base>/karma and returns the grant', async () => {
    mockResponse({ ok: true, status: 202, body: { txId: TX, status: 'pending', expiresAtHeight: 5900 } });
    const res = await faucet().askKarma(KEY);
    expect(last.url).toBe('/faucet/karma');
    expect(last.method).toBe('POST');
    expect(last.body).toEqual({ pubkey: KEY });
    expect(res).toEqual({ txId: TX, status: 'pending', expiresAtHeight: 5900 });
  });

  it('the deploy base carries its own prefix — <base>/karma', async () => {
    mockResponse({ ok: true, status: 202, body: { txId: TX, status: 'pending', expiresAtHeight: 1 } });
    await faucet('/testnet/faucet').askKarma(KEY);
    expect(last.url).toBe('/testnet/faucet/karma');
  });

  it('a 202 without a numeric expiresAtHeight is refused client-side', async () => {
    mockResponse({ ok: true, status: 202, body: { txId: TX, status: 'pending' } });
    const res = await faucet().askKarma(KEY);
    expect(res).toEqual({ status: 0, message: 'the faucet did not say when its invite expires.' });
  });

  it('a 202 whose txId is not 64 lowercase hex is refused — never "undefined" as a txId', async () => {
    mockResponse({ ok: true, status: 202, body: { txId: 'nope', status: 'pending', expiresAtHeight: 5900 } });
    expect(await faucet().askKarma(KEY)).toEqual({ status: 0, message: 'the faucet did not name the transaction it made.' });
    // A missing txId would have stringified to "undefined" — refused the same way.
    mockResponse({ ok: true, status: 202, body: { status: 'pending', expiresAtHeight: 5900 } });
    expect(await faucet().askKarma(KEY)).toEqual({ status: 0, message: 'the faucet did not name the transaction it made.' });
  });

  it("the faucet's { error } bodies normalise to { status, message }", async () => {
    mockResponse({ ok: false, status: 400, body: { error: 'identity already exists' } });
    expect(await faucet().askKarma(KEY)).toEqual({ status: 400, message: 'identity already exists' });
    mockResponse({ ok: false, status: 429, body: { error: 'slow down' } });
    expect(await faucet().askKarma(KEY)).toEqual({ status: 429, message: 'slow down' });
  });
});

describe('faucet client — the rejection lines', () => {
  it('a relayed 400 is the once-per-key line', () => {
    expect(faucetLine({ status: 400, message: 'identity already exists' })).toBe('this key already had its faucet grant.');
  });

  it('429 is busy, 503 is empty', () => {
    expect(faucetLine({ status: 429, message: 'slow down' })).toBe('the faucet is busy right now. try again in a while.');
    expect(faucetLine({ status: 503, message: 'drained' })).toBe('the faucet is empty right now.');
  });

  it('any other status is the faucet said, lowercased', () => {
    expect(faucetLine({ status: 500, message: 'Internal Error' })).toBe('the faucet said: internal error');
  });

  it('a client-side refusal (status 0) stands as its own sentence', () => {
    expect(faucetLine({ status: 0, message: 'the faucet did not say when its invite expires.' })).toBe(
      'the faucet did not say when its invite expires.',
    );
  });
});
