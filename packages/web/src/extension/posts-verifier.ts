// The extension's posts verifier — the seam the App knows sits in state.ts
// (WEB_INTERFACE → The extension → "The post check"). This module belongs to
// the extension build alone; the static `isExtension && BUILD_NETWORK !==
// null` condition in `main.ts` keeps it out of the web bundle.

import { checkPosts } from '@dagsocial/nipopow-client';
import type { PostCheck } from '@dagsocial/nipopow-client';
import type { PostsVerifier } from '../model/state';

export interface PostsVerifierOptions {
  /** An injection point for the tool's `checkPosts`; the default is the
   *  tool's own function (WEB_INTERFACE → The extension → "The post
   *  check"). A test overrides it to count the calls or steer the
   *  verdicts. */
  check?: (rows: unknown[]) => PostCheck[];
}

export function createPostsVerifier(opts: PostsVerifierOptions = {}): PostsVerifier {
  const check = opts.check ?? ((rows: unknown[]): PostCheck[] => checkPosts(rows));
  return {
    check(rows: unknown[]): PostCheck[] {
      return check(rows);
    },
  };
}
