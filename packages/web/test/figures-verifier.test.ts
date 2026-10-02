import { describe, it, expect } from 'vitest';
import { createFiguresVerifier } from '../src/extension/figures-verifier';
import { proveFigures as realProveFigures } from '@dagsocial/nipopow-client';
import type { Anchor, FiguresResult, HttpFetch, Listing, proveFigures } from '@dagsocial/nipopow-client';
import type { BlockHeader, NetworkProfile, NetworkType } from '@dagsocial/types';
import { profileFor } from '@dagsocial/types';

// createFiguresVerifier is the extension's seam over the tool's `proveFigures`
// (WEB_INTERFACE → The extension → "The verified figures"). Its one job is to
// strip a trailing `/` from the reading base, pin the build's profile, and
// hand every other argument through unchanged. The tests inject a `prove`
// stub so the wire is asserted without a real proof engine.

type PoPowHeader = Anchor['suffixHead'];

function header(height: number, tag: string): BlockHeader {
  const suffix = tag.padStart(2, '0');
  return {
    protocolVersion: 1,
    height,
    prevBlockHash: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32),
    stateRoot: '11'.repeat(31) + suffix,
    validatorId: new Uint8Array(32),
    powNonce: 0,
    powTargetBits: 0x1d00ffff,
    createdAt: 0,
    interlinkRoot: '00'.repeat(32),
    adProofsRoot: '00'.repeat(32),
  };
}

function popow(h: BlockHeader): PoPowHeader {
  return { header: h, interlinks: [] };
}

function anchorFor(h: number): Anchor {
  return { tip: header(h, 'aa'), suffixHead: popow(header(h - 19, 'bb')) };
}

function emptyResult(): FiguresResult {
  return {
    boxes: [],
    record: { status: 'absent' },
    karma: { proven: 0n, young: 0n, unchecked: 0n, absent: 0n, unlisted: 0n, undecided: 0n, effective: 0n, holdings: 'read', holdingsVerdict: null },
    credits: { proven: 0n, young: 0n, unchecked: 0n, absent: 0n, unlisted: 0n, undecided: 0n, holdings: 'read', holdingsVerdict: null },
    heightAfter: 100,
    failed: false,
  };
}

function emptyListing(): Listing {
  return { karma: { boxes: [], height: 50, effective: '0' }, credits: { boxes: [] } };
}

const USER = 'aa'.repeat(32);

describe('createFiguresVerifier — the seam the App knows', () => {
  it('calls `prove` with the normalised base, the user, the listing, the anchor, and profileFor(network)', async () => {
    // A trailing slash on the reading base is stripped so the tool's
    // `${nodeUrl}/api/v1/proof/…` never asks a double-slash URL — the same
    // rule the tip verifier applies.
    let seen: {
      nodeUrl: string;
      user: string;
      listing: Listing;
      anchor: Anchor;
      profile: NetworkProfile;
    } | null = null;
    const prove = (async (
      nodeUrl: string,
      user: string,
      listing: Listing,
      anchor: Anchor,
      profile: NetworkProfile,
    ): Promise<FiguresResult> => {
      seen = { nodeUrl, user, listing, anchor, profile };
      return emptyResult();
    }) as typeof proveFigures;

    const network: NetworkType = 'testnet';
    const listing = emptyListing();
    const anchor = anchorFor(200);
    const v = createFiguresVerifier({
      network,
      fetch: (async () => new Response('')) as typeof fetch,
      prove,
    });
    await v.run('https://a.example/', USER, listing, anchor);

    expect(seen).not.toBeNull();
    expect(seen!.nodeUrl).toBe('https://a.example'); // trailing slash stripped
    expect(seen!.user).toBe(USER);
    expect(seen!.listing).toBe(listing);
    expect(seen!.anchor).toBe(anchor);
    expect(seen!.profile).toBe(profileFor(network));
  });

  it('a base without a trailing slash reaches `prove` unchanged', async () => {
    let seenUrl = '';
    const prove = (async (nodeUrl: string): Promise<FiguresResult> => {
      seenUrl = nodeUrl;
      return emptyResult();
    }) as typeof proveFigures;
    const v = createFiguresVerifier({
      network: 'testnet',
      fetch: (async () => new Response('')) as typeof fetch,
      prove,
    });
    await v.run('https://a.example', USER, emptyListing(), anchorFor(200));
    expect(seenUrl).toBe('https://a.example');
  });

  it('the tool\'s FiguresResult reaches the caller unchanged', async () => {
    const custom: FiguresResult = {
      ...emptyResult(),
      heightAfter: 4242,
      karma: { proven: 5n, young: 0n, unchecked: 0n, absent: 0n, unlisted: 0n, undecided: 0n, effective: 5n, holdings: 'read', holdingsVerdict: null },
    };
    const prove = (async (): Promise<FiguresResult> => custom) as typeof proveFigures;
    const v = createFiguresVerifier({
      network: 'testnet',
      fetch: (async () => new Response('')) as typeof fetch,
      prove,
    });
    const got = await v.run('https://a.example', USER, emptyListing(), anchorFor(200));
    expect(got).toBe(custom);
  });
});

// A node that paces its answers — a page an entry, each held to the request's
// timeout — keeps a run open past the ten-minute tip run, which re-reads the
// listing and drops the result as it lands. The verifier bounds a run at 60 s:
// a request a run would make later is rejected before the network sees it,
// the tool reads it as not served, and the row has a line
// (WEB_INTERFACE → The extension → "The verified figures").
describe('createFiguresVerifier — a run ends', () => {
  const DEADLINE_MS = 60_000;
  const KEY_HEX = 'aa'.repeat(32);

  it('every real network call began at or before 60 s, the ledgers read no-proof', async () => {
    const clock = { ms: 0 };
    const now = () => clock.ms;
    const callTimes: number[] = [];
    // Each fetch advances the clock 40 s before returning a 404, so by the
    // third fetch the deadline has passed and the next request rejects
    // before the base fetch is reached.
    const baseFetch: HttpFetch = (_url) => {
      callTimes.push(clock.ms);
      clock.ms += 40_000;
      return Promise.resolve(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));
    };
    const listing: Listing = {
      karma: { boxes: [{ boxId: 'bb'.repeat(32), value: '7' }], height: 500, effective: '7' },
      credits: { boxes: [{ boxId: 'cc'.repeat(32), value: '100000000' }] },
    };
    const v = createFiguresVerifier({
      network: 'testnet',
      fetch: baseFetch,
      prove: realProveFigures,
      now,
    });
    const result = await v.run('https://a.example', KEY_HEX, listing, anchorFor(500));
    expect(result.karma.holdings).toBe('no-proof');
    expect(result.credits.holdings).toBe('no-proof');
    // Every real network call began at or before the deadline; a call later
    // than it is rejected before the base fetch is reached.
    expect(callTimes.length).toBeGreaterThan(0);
    for (const t of callTimes) expect(t).toBeLessThanOrEqual(DEADLINE_MS);
    // The clock passed the deadline during the run.
    expect(clock.ms).toBeGreaterThan(DEADLINE_MS);
  });

  it('a run inside the deadline reaches every request', async () => {
    const clock = { ms: 0 };
    const now = () => clock.ms;
    const seen: string[] = [];
    const fetch: HttpFetch = (url) => {
      clock.ms += 10;
      seen.push(new URL(url, 'http://a').pathname);
      return Promise.resolve(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));
    };
    const listing: Listing = {
      karma: { boxes: [{ boxId: 'bb'.repeat(32), value: '7' }], height: 500, effective: '7' },
      credits: { boxes: [{ boxId: 'cc'.repeat(32), value: '100000000' }] },
    };
    const v = createFiguresVerifier({
      network: 'testnet',
      fetch,
      prove: realProveFigures,
      now,
    });
    await v.run('https://a.example', KEY_HEX, listing, anchorFor(500));
    // The record at suffixHead, each ledger's range at suffixHead and
    // `/blocks/current` — four requests all under the deadline.
    expect(seen.some((p) => p.startsWith('/api/v1/proof/'))).toBe(true);
    expect(seen.some((p) => p.startsWith('/api/v1/range/'))).toBe(true);
    expect(seen).toContain('/blocks/current');
    expect(seen.length).toBeGreaterThanOrEqual(4);
    // The run finished well inside the deadline.
    expect(clock.ms).toBeLessThan(DEADLINE_MS);
  });

  it('the deadline is a run\'s own — a second run begins a fresh 60 seconds', async () => {
    const clock = { ms: 0 };
    const now = () => clock.ms;
    const callTimes: number[] = [];
    const fetch: HttpFetch = (_url) => {
      callTimes.push(clock.ms);
      return Promise.resolve(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));
    };
    const prove = (async (
      _nodeUrl: string,
      _user: string,
      _listing: Listing,
      _anchor: Anchor,
      _profile: NetworkProfile,
      f: HttpFetch,
    ): Promise<FiguresResult> => {
      await f('http://a/api/v1/proof/' + KEY_HEX);
      return emptyResult();
    }) as typeof proveFigures;
    const v = createFiguresVerifier({
      network: 'testnet',
      fetch,
      prove,
      now,
    });
    await v.run('https://a.example', KEY_HEX, emptyListing(), anchorFor(500));
    expect(callTimes).toHaveLength(1);
    // Push the clock far past the first run's deadline before the second
    // begins.
    clock.ms += 10 * DEADLINE_MS;
    await v.run('https://a.example', KEY_HEX, emptyListing(), anchorFor(500));
    // The second run's request reached the base fetch — the first run's
    // deadline did not carry over.
    expect(callTimes).toHaveLength(2);
    expect(callTimes[1]).toBeGreaterThan(DEADLINE_MS);
  });

  it('through figuresLine the ledger reads muted "the node served no proof for 1 $NOTIS"', async () => {
    const { figuresLine } = await import('../src/model/figures-line');
    const clock = { ms: 0 };
    const now = () => clock.ms;
    const baseFetch: HttpFetch = (_url) => {
      clock.ms += 40_000;
      return Promise.resolve(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));
    };
    const v = createFiguresVerifier({
      network: 'testnet',
      fetch: baseFetch,
      prove: realProveFigures,
      now,
    });
    const listing: Listing = {
      karma: { boxes: [{ boxId: 'bb'.repeat(32), value: '7' }], height: 500, effective: '7' },
      credits: { boxes: [{ boxId: 'cc'.repeat(32), value: '100000000' }] },
    };
    const result = await v.run('https://a.example', KEY_HEX, listing, anchorFor(500));
    const line = figuresLine({
      ledger: 'credits',
      verdict: { kind: 'verified', nodes: 2, height: 500 },
      result,
      shown: 0n,
      suffixHeight: 481,
      boxCount: 1,
      height: 500,
    });
    expect(line).toEqual({ text: 'the node served no proof for 1 $NOTIS', weight: 'muted' });
  });
});
