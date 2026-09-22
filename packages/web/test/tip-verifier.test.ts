import { describe, it, expect } from 'vitest';
import { createTipVerifier } from '../src/extension/tip-verifier';
import type { TipResult, NodeTipResult } from '@dagsocial/nipopow-client';
import type { NetworkProfile, NetworkType } from '@dagsocial/types';
import { profileFor } from '@dagsocial/types';

// createTipVerifier is the extension's seam over `resolveTip`
// (WEB_INTERFACE → The extension → "The verified tip"). It asks the reading
// base first, then every other base of the seed list with duplicates dropped
// (compare after stripping one trailing `/`), pins `m=6` and `k=20`, and
// answers `tipVerdict(result)`. `resolve` is an optional injection point for
// these tests, defaulting to the tool's real function.

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

  it("the answer is tipVerdict of what resolve returned — an outworked verdict (the winner's suffix does not carry the reading node's tip) names the winner's URL", async () => {
    // Set up a result where the second node wins and the reading node's tip
    // is not on the winner's chain (`behind: null`); `tipVerdict` reads
    // `refused: outworked` and names the winner's URL as `by`.
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
    const verdict = await v.run('https://a.example');

    expect(verdict).toEqual({
      kind: 'refused',
      reason: 'outworked',
      by: 'https://b.example',
      height: 200,
    });
  });
});
