// The extension's figures verifier — the seam the App knows sits in state.ts
// (WEB_INTERFACE → The extension → "The verified figures"). This module belongs
// to the extension build alone; the static `isExtension && BUILD_NETWORK !==
// null` condition in `main.ts` keeps it out of the web bundle.

import { proveFigures } from '@dagsocial/nipopow-client';
import type { Anchor, FiguresResult, HttpFetch, Listing } from '@dagsocial/nipopow-client';
import { profileFor } from '@dagsocial/types';
import type { NetworkType } from '@dagsocial/types';
import type { FiguresVerifier } from '../model/state';

export interface FiguresVerifierOptions {
  network: NetworkType;
  fetch: HttpFetch;
  /** An injection point for the tool's `proveFigures`; the default is the
   *  tool's own function (WEB_INTERFACE → The extension → "The verified
   *  figures"). */
  prove?: typeof proveFigures;
  /** An injection point for the clock the run deadline reads; the default
   *  is the browser's `Date.now`. A run is bounded at `RUN_DEADLINE_MS`
   *  milliseconds, so a request asked later rejects before the network sees
   *  it (WEB_INTERFACE → The extension → "The verified figures"). */
  now?: () => number;
}

/** A request a run would make later than this many ms after it began is
 *  rejected before the network sees it, so a node that paces its answers —
 *  a page an entry, each held to the request's timeout — cannot keep a run
 *  going past the next tip run (WEB_INTERFACE → The extension → "The
 *  verified figures"). */
const RUN_DEADLINE_MS = 60_000;

/** Strip one trailing `/` so the tool's `${nodeUrl}/api/v1/proof/...` never
 *  asks a double-slash URL — the same rule the tip verifier applies. */
function normaliseBase(base: string): string {
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

export function createFiguresVerifier(opts: FiguresVerifierOptions): FiguresVerifier {
  const prove = opts.prove ?? proveFigures;
  const profile = profileFor(opts.network);
  const now = opts.now ?? Date.now;
  const baseFetch = opts.fetch;
  return {
    async run(readingBase: string, user: string, listing: Listing, anchor: Anchor): Promise<FiguresResult> {
      // Each run gets its own deadline — a second run starts a fresh
      // `RUN_DEADLINE_MS` (WEB_INTERFACE → The extension → "The verified
      // figures"). A request asked after the deadline rejects at once;
      // `fetchJson` catches the throw and answers `status: 0`, which
      // `proveRange` reads as `no-proof` and `readHeightAfter` as unread,
      // so the tool need not know a deadline exists.
      const start = now();
      const fetch: HttpFetch = (url, init) => {
        if (now() - start > RUN_DEADLINE_MS) {
          return Promise.reject(new Error(`run deadline passed after ${RUN_DEADLINE_MS} ms`));
        }
        return baseFetch(url, init);
      };
      return prove(normaliseBase(readingBase), user, listing, anchor, profile, fetch);
    },
  };
}
