import { resolvePosts, type ResolveEnd, type BoundPost } from '../model/post-resolve';
import type { PostResolver } from '../model/state';
import type { PostCheck } from '@dagsocial/nipopow-client';

// The extension's resolver (WEB_INTERFACE → The extension → "The resolve"):
// `createPostResolver` wraps the pure `resolvePosts` with a real `fetch`,
// a real clock and a real timer, and keeps the round-robin pointer across
// calls so one resolve's chunks pick up where the last left off. The App
// holds this seam only in the extension build; the web build is handed none,
// and `build-release.sh` refuses `posts/batch` in `dist/assets/*.js`
// (WEB_INTERFACE → "The build check that keeps the web bundle honest").

/** The seams the resolver takes. `nodes` is read at each call — the reading
 *  base first, then the seed list — so a change of the reading node moves
 *  the first node in the next call's round one. */
export interface PostResolverDeps {
  nodes: () => string[];
  fetch: typeof fetch;
  check: (rows: unknown[]) => PostCheck[];
  /** The clock, read for the deadline. Defaults to `Date.now`; a caller
   *  that drives the clock itself passes one of its own. */
  now?: () => number;
  /** A timer that resolves when the clock reads `at`. Defaults to
   *  `setTimeout` over the real clock; a caller driving the clock passes
   *  one that fires under the same clock. */
  until?: (at: number) => Promise<void>;
}

/** Strip one trailing `/` from a base, as `NodeClient.url` does, so
 *  `<base>/posts/batch` builds the same URL whichever form the caller
 *  passed in. */
function trimBase(base: string): string {
  return base.replace(/\/$/, '');
}

/** Trim bases, then drop duplicates — `https://a/` and `https://a` are one
 *  node (WEB_INTERFACE → The extension → "The resolve"). */
function trimAndDedup(xs: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of xs) {
    const t = trimBase(x);
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

const DEFAULT_UNTIL = (at: number): Promise<void> =>
  new Promise<void>((resolve) => {
    const ms = Math.max(0, at - Date.now());
    setTimeout(resolve, ms);
  });

export function createPostResolver(deps: PostResolverDeps): PostResolver {
  const now = deps.now ?? Date.now;
  const until = deps.until ?? DEFAULT_UNTIL;
  // The pointer across calls (WEB_INTERFACE → The extension →
  // "A pointer walks the nodes"). It moves at the call, by that call's
  // round-one chunk count; the `% n` is taken in the pure resolve, so the
  // raw sum is kept here and read `% n` at each call.
  let pointer = 0;

  const ask = (base: string, ids: readonly string[], signal: AbortSignal): Promise<unknown> => {
    // `POST <base>/posts/batch?tx=1` with `Content-Type: application/json`
    // and the body `{"ids":[…]}` — no `viewer`, no other parameter, no
    // credentials — and the resolve's abort signal, so a request still
    // open when the deadline fires is aborted (WEB_INTERFACE → The
    // extension → "The resolve"). A status outside 2xx, a body that will
    // not parse as JSON, a network failure and the aborted arm all
    // reject.
    const url = base + '/posts/batch?tx=1';
    return deps.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
      signal,
    }).then((res) => {
      if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
      return res.json();
    });
  };

  const resolve = async (
    ids: readonly string[],
    onBound: (posts: BoundPost[]) => void,
  ): Promise<Map<string, ResolveEnd>> => {
    const bases = trimAndDedup(deps.nodes());
    const n = bases.length;
    const start = n === 0 ? 0 : pointer % n;
    // The pointer moves at the call: `resolvePosts` returns `chunks`
    // synchronously, so a second `resolve()` made before this one's
    // promise settles starts at the node after this one's last
    // (WEB_INTERFACE → The extension → "A pointer walks the nodes").
    const { chunks, ends } = resolvePosts(ids, {
      nodes: bases, start,
      ask, check: deps.check, now, until, onBound,
    });
    pointer = pointer + chunks;
    return await ends;
  };

  return { resolve };
}
