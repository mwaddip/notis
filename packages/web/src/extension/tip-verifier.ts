// The extension's tip verifier — the seam the App knows sits in state.ts
// (WEB_INTERFACE → The extension → "The verified tip"). This module belongs to
// the extension build alone; the static `isExtension` in `main.ts` keeps it
// out of the web bundle.

import { resolveTip } from '@dagsocial/nipopow-client';
import type { TipResult, HttpFetch } from '@dagsocial/nipopow-client';
import { profileFor } from '@dagsocial/types';
import type { NetworkType } from '@dagsocial/types';
import { tipVerdict } from '../model/tip-verdict';
import type { TipVerdict } from '../model/tip-verdict';
import type { TipVerifier } from '../model/state';

// NIPOPOW_INTERFACE → NipopowProof — `m` is the security parameter and `k` the
// suffix length; the pair `6, 20` is WEB_INTERFACE → The extension → "The
// verified tip"'s, and NODE_INTERFACE → Nipopow serves the same route.
const M = 6;
const K = 20;

export interface TipVerifierOptions {
  network: NetworkType;
  nodes: string[];
  fetch: HttpFetch;
  now: () => number;
  /** An injection point for the tool's `resolveTip`; the default is the tool's
   *  own function (WEB_INTERFACE → The extension → "The verified tip"). */
  resolve?: typeof resolveTip;
}

/** Strip one trailing `/` so a base and its trailing-slash twin de-duplicate. */
function normaliseBase(base: string): string {
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

export function createTipVerifier(opts: TipVerifierOptions): TipVerifier {
  const resolve = opts.resolve ?? resolveTip;
  const profile = profileFor(opts.network);
  return {
    async run(readingBase: string): Promise<TipVerdict> {
      // The reading base is asked first; the fold's own rule then gives the
      // comparison its meaning — `winnerIndex === 0` says the reading node
      // holds the best chain or ties for it (WEB_INTERFACE → The extension
      // → "The verified tip"; NIPOPOW_INTERFACE → compareProofs).
      const urls: string[] = [];
      const seen = new Set<string>();
      const addIfNew = (base: string): void => {
        const key = normaliseBase(base);
        if (seen.has(key)) return;
        seen.add(key);
        urls.push(key);
      };
      addIfNew(readingBase);
      for (const b of opts.nodes) addIfNew(b);
      const result: TipResult = await resolve(urls, M, K, profile, opts.now, opts.fetch);
      return tipVerdict(result);
    },
  };
}
