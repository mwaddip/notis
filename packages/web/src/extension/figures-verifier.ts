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
}

/** Strip one trailing `/` so the tool's `${nodeUrl}/api/v1/proof/...` never
 *  asks a double-slash URL — the same rule the tip verifier applies. */
function normaliseBase(base: string): string {
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

export function createFiguresVerifier(opts: FiguresVerifierOptions): FiguresVerifier {
  const prove = opts.prove ?? proveFigures;
  const profile = profileFor(opts.network);
  return {
    async run(readingBase: string, user: string, listing: Listing, anchor: Anchor): Promise<FiguresResult> {
      return prove(normaliseBase(readingBase), user, listing, anchor, profile, opts.fetch);
    },
  };
}
