import { describe, it, expect } from 'vitest';
import { createTipVerifier } from '../src/extension/tip-verifier';
import type { Anchor, TipResult, NodeTipResult } from '@dagsocial/nipopow-client';
import type { BlockHeader, NetworkProfile, NetworkType } from '@dagsocial/types';
import { profileFor } from '@dagsocial/types';

// PoPowHeader / VerifyResult reach the web through nipopow-client, so tests
// derive them from the exposed shapes rather than importing @dagsocial/nipopow
// directly (not a web dep).
type PoPowHeader = Anchor['suffixHead'];
type VerifyResult = NonNullable<NodeTipResult['verifyResult']>;

// createTipVerifier is the extension's seam over `resolveTip`
// (WEB_INTERFACE → The extension → "The verified tip"). It asks the reading
// base first, then every other base of the seed list with duplicates dropped
// (compare after stripping one trailing `/`), pins `m=6` and `k=20`, and
// answers `{ verdict, anchor }` — the anchor is the reading node's own
// verified headers under `verified` alone (→ "The verified figures").
// `resolve` is an optional injection point for these tests, defaulting to
// the tool's real function.

function verifiedNode(url: string, behind: NodeTipResult['behind'] = 0): NodeTipResult {
  return {
    url,
    verified: true,
    proof: null,
    verifyResult: null,
    refuseReason: null,
    refuseCode: null,
    behind,
  };
}

/** A minimal `TipResult` — the wiring tests read only `winnerIndex`, `nodes`
 *  and `tip.height`; other fields are the tool's own. */
function verifiedResult(urls: string[]): TipResult {
  return {
    winner: verifiedNode(urls[0]!),
    winnerIndex: 0,
    nodes: urls.map(verifiedNode),
    tip: { height: 100 } as unknown as TipResult['tip'],
    suffixHead: null,
    splits: [],
  };
}

describe('createTipVerifier — the seam the App knows', () => {
  it('asks the reading base first, then every other base of the seed list', async () => {
    const observed: string[][] = [];
    const resolve = (async (urls: string[]): Promise<TipResult> => {
      observed.push([...urls]);
      return verifiedResult(urls);
    }) as typeof import('@dagsocial/nipopow-client').resolveTip;

    const v = createTipVerifier({
      network: 'testnet',
      nodes: ['https://a.example', 'https://b.example', 'https://c.example'],
      fetch: (async () => new Response('')) as typeof fetch,
      now: () => 0,
      resolve,
    });
    await v.run('https://a.example');

    expect(observed).toHaveLength(1);
    expect(observed[0]![0]).toBe('https://a.example');
    expect(observed[0]).toEqual(['https://a.example', 'https://b.example', 'https://c.example']);
  });

  it('drops duplicates — an exact repeat and a trailing-slash twin', async () => {
    const observed: string[][] = [];
    const resolve = (async (urls: string[]): Promise<TipResult> => {
      observed.push([...urls]);
      return verifiedResult(urls);
    }) as typeof import('@dagsocial/nipopow-client').resolveTip;

    const v = createTipVerifier({
      network: 'testnet',
      // The reading base has a trailing slash; the seed list carries the same
      // base with and without it, and one that duplicates a later entry.
      nodes: ['https://a.example/', 'https://a.example', 'https://b.example', 'https://b.example'],
      fetch: (async () => new Response('')) as typeof fetch,
      now: () => 0,
      resolve,
    });
    await v.run('https://a.example');

    expect(observed).toHaveLength(1);
    // The trailing-slash twin and its exact repeat are both dropped, and only
    // one `b.example` reaches `resolve`. Every entry reaches `resolve` with
    // one trailing `/` stripped.
    expect(observed[0]).toEqual(['https://a.example', 'https://b.example']);
  });

  it('a trailing-slash reading base reaches `resolve` stripped', async () => {
    // The tool asks `${url}/nipopow/proof/6/20`, so a base ending in `/` would
    // ask `…//nipopow/proof/6/20`; the verifier strips one trailing `/` before
    // handing bases in.
    const observed: string[][] = [];
    const resolve = (async (urls: string[]): Promise<TipResult> => {
      observed.push([...urls]);
      return verifiedResult(urls);
    }) as typeof import('@dagsocial/nipopow-client').resolveTip;

    const v = createTipVerifier({
      network: 'testnet',
      nodes: ['https://b.example'],
      fetch: (async () => new Response('')) as typeof fetch,
      now: () => 0,
      resolve,
    });
    await v.run('https://a.example/');

    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual(['https://a.example', 'https://b.example']);
  });

  it('a reading base outside the seed list is asked first and the seeds follow', async () => {
    const observed: string[][] = [];
    const resolve = (async (urls: string[]): Promise<TipResult> => {
      observed.push([...urls]);
      return verifiedResult(urls);
    }) as typeof import('@dagsocial/nipopow-client').resolveTip;

    const v = createTipVerifier({
      network: 'testnet',
      nodes: ['https://a.example', 'https://b.example'],
      fetch: (async () => new Response('')) as typeof fetch,
      now: () => 0,
      resolve,
    });
    await v.run('https://outside.example');

    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual(['https://outside.example', 'https://a.example', 'https://b.example']);
  });

  it('passes m=6, k=20 and profileFor(network) to resolve', async () => {
    let mSeen = -1;
    let kSeen = -1;
    let profileSeen: NetworkProfile | null = null;
    const resolve = (async (
      urls: string[],
      m: number,
      k: number,
      profile: NetworkProfile,
    ): Promise<TipResult> => {
      mSeen = m;
      kSeen = k;
      profileSeen = profile;
      return verifiedResult(urls);
    }) as typeof import('@dagsocial/nipopow-client').resolveTip;

    const network: NetworkType = 'testnet';
    const v = createTipVerifier({
      network,
      nodes: [],
      fetch: (async () => new Response('')) as typeof fetch,
      now: () => 0,
      resolve,
    });
    await v.run('https://a.example');

    expect(mSeen).toBe(6);
    expect(kSeen).toBe(20);
    expect(profileSeen).toBe(profileFor(network));
  });

  it("the answer's verdict is tipVerdict of what resolve returned — an outworked verdict (the winner's suffix does not carry the reading node's tip) names the winner's URL, and the anchor is null", async () => {
    // Set up a result where the second node wins and the reading node's tip
    // is not on the winner's chain (`behind: null`); `tipVerdict` reads
    // `refused: outworked` and names the winner's URL as `by`. Only under
    // `verified` does the anchor stand — every other verdict is null.
    const resolve = (async (urls: string[]): Promise<TipResult> => {
      const nodes: NodeTipResult[] = [
        verifiedNode(urls[0]!, null),
        ...urls.slice(1).map((u) => verifiedNode(u)),
      ];
      return {
        winner: nodes[1]!,
        winnerIndex: 1,
        nodes,
        tip: { height: 200 } as unknown as TipResult['tip'],
        suffixHead: null,
        splits: [],
      };
    }) as typeof import('@dagsocial/nipopow-client').resolveTip;

    const v = createTipVerifier({
      network: 'testnet',
      nodes: ['https://b.example'],
      fetch: (async () => new Response('')) as typeof fetch,
      now: () => 0,
      resolve,
    });
    const run = await v.run('https://a.example');

    expect(run.verdict).toEqual({
      kind: 'refused',
      reason: 'outworked',
      by: 'https://b.example',
      height: 200,
    });
    expect(run.anchor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The anchor (WEB_INTERFACE → The extension → "The verified figures"). The
// verifier answers `{ verdict, anchor }`; `anchor` carries the reading node's
// own verified `tip` and `suffixHead` under `verified` alone, else `null`.
// ---------------------------------------------------------------------------

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
  };
}

function popow(h: BlockHeader): PoPowHeader {
  return { header: h, interlinks: [] };
}

function okVerify(tip: BlockHeader, suffix: PoPowHeader): VerifyResult {
  return { ok: true, headers: [], tip, tipHeight: tip.height, suffixHead: suffix };
}

/** A NodeTipResult with a verified `{ ok: true }` verifyResult carrying the
 *  given tip and suffixHead — the shape the verdict's totality gate says
 *  `verified` guarantees, so the anchor helper narrows and reads them. */
function verifiedWithHeaders(url: string, tip: BlockHeader, suffix: PoPowHeader, behind: NodeTipResult['behind'] = 0): NodeTipResult {
  return {
    url,
    verified: true,
    proof: null,
    verifyResult: okVerify(tip, suffix),
    refuseReason: null,
    refuseCode: null,
    behind,
  };
}

describe('createTipVerifier — the anchor beside the verdict', () => {
  it('carries the reading node\'s tip and suffixHead under `verified`', async () => {
    const readingTip = header(200, 'aa');
    const readingSuffix = popow(header(181, 'bb'));
    const winnerTip = header(200, 'cc'); // A different header for the same height on the winner's chain — the anchor is the READING node's, never the winner's.
    const winnerSuffix = popow(header(181, 'dd'));
    const resolve = (async (urls: string[]): Promise<TipResult> => {
      const nodes: NodeTipResult[] = [
        verifiedWithHeaders(urls[0]!, readingTip, readingSuffix),
        verifiedWithHeaders(urls[1]!, winnerTip, winnerSuffix),
      ];
      return {
        winner: nodes[1]!,
        winnerIndex: 1,
        nodes,
        tip: winnerTip,
        suffixHead: winnerSuffix,
        splits: [],
      };
    }) as typeof import('@dagsocial/nipopow-client').resolveTip;

    const v = createTipVerifier({
      network: 'testnet',
      nodes: ['https://b.example'],
      fetch: (async () => new Response('')) as typeof fetch,
      now: () => 0,
      resolve,
    });
    const run = await v.run('https://a.example');

    // The verdict is `verified` (the reading node is at index 0 with `behind: 0`,
    // and there is a second verified node in the result).
    expect(run.verdict.kind).toBe('verified');
    // The anchor is the READING node's own `tip` and `suffixHead`, not the winner's.
    expect(run.anchor).not.toBeNull();
    expect(run.anchor!.tip).toBe(readingTip);
    expect(run.anchor!.suffixHead).toBe(readingSuffix);
  });

  // Each of the six non-verified verdict rows leaves the anchor null.
  // WEB_INTERFACE → The extension → "The verified tip" — the row table.

  it('anchor is null under `thin: one-node`', async () => {
    // Only the reading node verifies; a `verified` result has fewer than two
    // nodes verified, so tipVerdict reads `thin: one-node`.
    const readingTip = header(100, 'aa');
    const readingSuffix = popow(header(81, 'bb'));
    const resolve = (async (urls: string[]): Promise<TipResult> => {
      const nodes: NodeTipResult[] = [
        verifiedWithHeaders(urls[0]!, readingTip, readingSuffix),
      ];
      return {
        winner: nodes[0]!,
        winnerIndex: 0,
        nodes,
        tip: readingTip,
        suffixHead: readingSuffix,
        splits: [],
      };
    }) as typeof import('@dagsocial/nipopow-client').resolveTip;

    const v = createTipVerifier({
      network: 'testnet',
      nodes: [],
      fetch: (async () => new Response('')) as typeof fetch,
      now: () => 0,
      resolve,
    });
    const run = await v.run('https://a.example');
    expect(run.verdict.kind).toBe('thin');
    expect((run.verdict as { reason: string }).reason).toBe('one-node');
    expect(run.anchor).toBeNull();
  });

  it('anchor is null under `thin: split`', async () => {
    const readingTip = header(100, 'aa');
    const readingSuffix = popow(header(81, 'bb'));
    const otherTip = header(100, 'cc');
    const otherSuffix = popow(header(81, 'dd'));
    const resolve = (async (urls: string[]): Promise<TipResult> => {
      const nodes: NodeTipResult[] = [
        verifiedWithHeaders(urls[0]!, readingTip, readingSuffix),
        verifiedWithHeaders(urls[1]!, otherTip, otherSuffix),
      ];
      return {
        winner: nodes[0]!,
        winnerIndex: 0,
        nodes,
        tip: readingTip,
        suffixHead: readingSuffix,
        splits: [{ indexA: 0, indexB: 1, reason: 'no shared prefix' }],
      };
    }) as typeof import('@dagsocial/nipopow-client').resolveTip;

    const v = createTipVerifier({
      network: 'testnet',
      nodes: ['https://b.example'],
      fetch: (async () => new Response('')) as typeof fetch,
      now: () => 0,
      resolve,
    });
    const run = await v.run('https://a.example');
    expect(run.verdict.kind).toBe('thin');
    expect((run.verdict as { reason: string }).reason).toBe('split');
    expect(run.anchor).toBeNull();
  });

  it('anchor is null under `thin: too-short`', async () => {
    // The reading node refuses with `too-short` — no verified result.
    const resolve = (async (urls: string[]): Promise<TipResult> => {
      const nodes: NodeTipResult[] = urls.map((u) => ({
        url: u,
        verified: false,
        proof: null,
        verifyResult: null,
        refuseReason: 'chain too short',
        refuseCode: 'too-short' as const,
        behind: null,
      }));
      return { winner: null, winnerIndex: -1, nodes, tip: null, suffixHead: null, splits: [] };
    }) as typeof import('@dagsocial/nipopow-client').resolveTip;

    const v = createTipVerifier({
      network: 'testnet',
      nodes: [],
      fetch: (async () => new Response('')) as typeof fetch,
      now: () => 0,
      resolve,
    });
    const run = await v.run('https://a.example');
    expect(run.verdict.kind).toBe('thin');
    expect((run.verdict as { reason: string }).reason).toBe('too-short');
    expect(run.anchor).toBeNull();
  });

  it('anchor is null under `thin: no-proof`', async () => {
    // The reading node is unreachable — no verified result at all.
    const resolve = (async (urls: string[]): Promise<TipResult> => {
      const nodes: NodeTipResult[] = urls.map((u) => ({
        url: u,
        verified: false,
        proof: null,
        verifyResult: null,
        refuseReason: 'unreachable',
        refuseCode: 'unreachable' as const,
        behind: null,
      }));
      return { winner: null, winnerIndex: -1, nodes, tip: null, suffixHead: null, splits: [] };
    }) as typeof import('@dagsocial/nipopow-client').resolveTip;

    const v = createTipVerifier({
      network: 'testnet',
      nodes: [],
      fetch: (async () => new Response('')) as typeof fetch,
      now: () => 0,
      resolve,
    });
    const run = await v.run('https://a.example');
    expect(run.verdict.kind).toBe('thin');
    expect((run.verdict as { reason: string }).reason).toBe('no-proof');
    expect(run.anchor).toBeNull();
  });

  it('anchor is null under `refused: invalid-proof`', async () => {
    // The reading node's proof did not verify.
    const resolve = (async (urls: string[]): Promise<TipResult> => {
      const nodes: NodeTipResult[] = urls.map((u) => ({
        url: u,
        verified: false,
        proof: null,
        verifyResult: null,
        refuseReason: 'verify failed',
        refuseCode: 'invalid' as const,
        behind: null,
      }));
      return { winner: null, winnerIndex: -1, nodes, tip: null, suffixHead: null, splits: [] };
    }) as typeof import('@dagsocial/nipopow-client').resolveTip;

    const v = createTipVerifier({
      network: 'testnet',
      nodes: [],
      fetch: (async () => new Response('')) as typeof fetch,
      now: () => 0,
      resolve,
    });
    const run = await v.run('https://a.example');
    expect(run.verdict.kind).toBe('refused');
    expect((run.verdict as { reason: string }).reason).toBe('invalid-proof');
    expect(run.anchor).toBeNull();
  });

  it('anchor is null under `refused: outworked`', async () => {
    // The reading node verified but the winner's suffix does not carry its tip.
    const readingTip = header(180, 'aa');
    const readingSuffix = popow(header(161, 'bb'));
    const winnerTip = header(200, 'cc');
    const winnerSuffix = popow(header(181, 'dd'));
    const resolve = (async (urls: string[]): Promise<TipResult> => {
      const nodes: NodeTipResult[] = [
        // Reading node's `behind` is null — not on the winner's chain.
        verifiedWithHeaders(urls[0]!, readingTip, readingSuffix, null),
        verifiedWithHeaders(urls[1]!, winnerTip, winnerSuffix),
      ];
      return {
        winner: nodes[1]!,
        winnerIndex: 1,
        nodes,
        tip: winnerTip,
        suffixHead: winnerSuffix,
        splits: [],
      };
    }) as typeof import('@dagsocial/nipopow-client').resolveTip;

    const v = createTipVerifier({
      network: 'testnet',
      nodes: ['https://b.example'],
      fetch: (async () => new Response('')) as typeof fetch,
      now: () => 0,
      resolve,
    });
    const run = await v.run('https://a.example');
    expect(run.verdict.kind).toBe('refused');
    expect((run.verdict as { reason: string }).reason).toBe('outworked');
    expect(run.anchor).toBeNull();
  });

  it('a `verified` result whose reading node lacks the ok: true shape gives a null anchor, never a throw', async () => {
    // The verdict's totality gate says a `verified` result carries an ok-shape
    // verifyResult on nodes[0], but the anchor is derived defensively: if
    // node[0].verifyResult is missing or `ok: false`, the anchor is null.
    // Built by hand — a verifier that read this shape once caused a throw here.
    const winnerTip = header(200, 'cc');
    const winnerSuffix = popow(header(181, 'dd'));
    const resolve = (async (urls: string[]): Promise<TipResult> => {
      const nodes: NodeTipResult[] = [
        // Reading node marked `verified: true` (so tipVerdict passes the gate)
        // but its `verifyResult` is null — the shape that would normally be
        // impossible for a verified result, guarded here anyway.
        { url: urls[0]!, verified: true, proof: null, verifyResult: null, refuseReason: null, refuseCode: null, behind: 0 },
        verifiedWithHeaders(urls[1]!, winnerTip, winnerSuffix),
      ];
      return {
        winner: nodes[0]!,
        winnerIndex: 0,
        nodes,
        tip: winnerTip,
        suffixHead: winnerSuffix,
        splits: [],
      };
    }) as typeof import('@dagsocial/nipopow-client').resolveTip;

    const v = createTipVerifier({
      network: 'testnet',
      nodes: ['https://b.example'],
      fetch: (async () => new Response('')) as typeof fetch,
      now: () => 0,
      resolve,
    });
    const run = await v.run('https://a.example');
    // Verdict is `verified` — reading node passes the gate as far as
    // tipVerdict can tell — but the anchor helper narrows further and finds
    // no shape to lift `tip`/`suffixHead` out of.
    expect(run.verdict.kind).toBe('verified');
    expect(run.anchor).toBeNull();
  });
});
