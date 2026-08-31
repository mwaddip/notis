import { describe, it, expect } from 'vitest';
import { fetchJson } from '../src/http.js';

describe('fetchJson', () => {
  // A hung node must not stall the run, so every call carries a timeout signal.
  it('attaches a timeout signal to the request', async () => {
    let seen: RequestInit | undefined;
    const fake = async (_url: string, init?: RequestInit): Promise<Response> => {
      seen = init;
      return new Response('{}', { status: 200 });
    };
    await fetchJson(fake, 'http://node');
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });

  // NIPOPOW_INTERFACE → compareProofs — one dead or hostile peer is refused,
  // not fatal, so the reachable nodes still decide.
  it('reports a transport failure as a non-ok result, never a throw', async () => {
    const fake = async (): Promise<Response> => { throw new TypeError('fetch failed'); };
    const res = await fetchJson(fake, 'http://node');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(0);
      expect(res.body).toContain('fetch failed');
    }
  });

  // A 200 whose body will not parse is one node's fault, not the run's.
  it('reports an unparseable 200 body as a non-ok result, never a throw', async () => {
    const fake = async (): Promise<Response> => new Response('not json', { status: 200 });
    const res = await fetchJson(fake, 'http://node');
    expect(res.ok).toBe(false);
  });
});
