// The extension's names verifier — the seam the App knows sits in state.ts
// (WEB_INTERFACE → The extension → "The verified names"). This module belongs
// to the extension build alone; the static `isExtension && BUILD_NETWORK !==
// null` condition in `main.ts` keeps it out of the web bundle.

import { proveName } from '@dagsocial/nipopow-client';
import type { Anchor, HttpFetch, NameClaim, NameResult } from '@dagsocial/nipopow-client';
import { trimBase } from '../base';
import type { NamesVerifier } from '../model/state';

export interface NamesVerifierOptions {
  fetch: HttpFetch;
  /** An injection point for the tool's `proveName`; the default is the tool's
   *  own function (WEB_INTERFACE → The extension → "The verified names"). */
  prove?: typeof proveName;
}

export function createNamesVerifier(opts: NamesVerifierOptions): NamesVerifier {
  const prove = opts.prove ?? proveName;
  return {
    async run(readingBase: string, claim: NameClaim, anchor: Anchor): Promise<NameResult> {
      return prove(trimBase(readingBase), claim, anchor, opts.fetch);
    },
  };
}
