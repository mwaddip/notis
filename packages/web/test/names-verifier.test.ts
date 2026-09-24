import { describe, it, expect } from 'vitest';
import { createNamesVerifier } from '../src/extension/names-verifier';
import type { Anchor, HttpFetch, NameClaim, NameResult, proveName } from '@dagsocial/nipopow-client';
import type { BlockHeader } from '@dagsocial/types';

// createNamesVerifier is the extension's seam over the tool's `proveName`
// (WEB_INTERFACE → The extension → "The verified names"). Its one job is to
// strip a trailing `/` from the reading base and hand the claim, the anchor
// and the fetch through unchanged — proveName takes no profile. The first
// tests inject a `prove` stub; the last runs the tool's own function over a
// fake fetch, so the default is pinned to be it.

type PoPowHeader = Anchor['suffixHead'];

function header(height: number, tag: string): BlockHeader {
  return {
    protocolVersion: 1,
    height,
    prevBlockHash: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32),
    stateRoot: '11'.repeat(31) + tag,
    validatorId: new Uint8Array(32),
    powNonce: 0,
    powTargetBits: 0x1d00ffff,
    createdAt: 0,
    interlinkRoot: '00'.repeat(32),
  };
}

function anchorFor(h: number): Anchor {
  const suffixHead: PoPowHeader = { header: header(h - 19, 'bb'), interlinks: [] };
  return { tip: header(h, 'aa'), suffixHead };
}

const KEY = 'ab'.repeat(32);
const PROVEN: NameResult = {
  status: 'proven', owner: KEY, name: 'Alice', boxId: '5a'.repeat(32), heightAfter: null, verdict: 'proven',
};

interface Seen {
  nodeUrl: string;
  claim: NameClaim;
  anchor: Anchor;
  httpFetch: HttpFetch;
}

function stub(): { prove: typeof proveName; seen: Seen[] } {
  const seen: Seen[] = [];
  const prove = (async (nodeUrl: string, claim: NameClaim, anchor: Anchor, httpFetch: HttpFetch): Promise<NameResult> => {
    seen.push({ nodeUrl, claim, anchor, httpFetch });
    return PROVEN;
  }) as typeof proveName;
  return { prove, seen };
}

describe('createNamesVerifier — the seam the App knows', () => {
  it('calls `prove` with the base stripped of one trailing slash, the claim, the anchor and the fetch, and answers its result', async () => {
    const { prove, seen } = stub();
    const fetch: HttpFetch = async () => new Response('');
    const anchor = anchorFor(200);
    const claim: NameClaim = { key: KEY, name: 'Alice' };
    const v = createNamesVerifier({ fetch, prove });
    const result = await v.run('https://a.example/api/', claim, anchor);
    expect(result).toBe(PROVEN);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.nodeUrl).toBe('https://a.example/api');
    expect(seen[0]!.claim).toBe(claim);
    expect(seen[0]!.anchor).toBe(anchor);
    expect(seen[0]!.httpFetch).toBe(fetch);
  });

  it('a base with no trailing slash passes unchanged, and a typed handle passes as it is', async () => {
    const { prove, seen } = stub();
    const v = createNamesVerifier({ fetch: async () => new Response(''), prove });
    const claim: NameClaim = { name: 'bob' };
    await v.run('https://a.example/api', claim, anchorFor(200));
    expect(seen[0]!.nodeUrl).toBe('https://a.example/api');
    expect(seen[0]!.claim).toBe(claim);
  });

  it('the default is the tool\'s own proveName — a label the node answers 404 for reads `none`, asked once at the normalised base', async () => {
    const urls: string[] = [];
    const fetch: HttpFetch = async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ error: 'no name' }), { status: 404 });
    };
    const v = createNamesVerifier({ fetch });
    const result = await v.run('https://a.example/api/', { key: KEY, name: 'Alice' }, anchorFor(200));
    expect(result.status).toBe('none');
    expect(urls).toEqual([`https://a.example/api/usernames?owner=${KEY}`]);
  });

  it('the default refuses a label whose key is not 64 hex with no request — the tool\'s own rule', async () => {
    const urls: string[] = [];
    const v = createNamesVerifier({ fetch: async (url) => { urls.push(url); return new Response(''); } });
    const result = await v.run('https://a.example/api', { key: 'not-a-key', name: 'Alice' }, anchorFor(200));
    expect(result.status).toBe('unproven');
    expect(urls).toEqual([]);
  });
});
