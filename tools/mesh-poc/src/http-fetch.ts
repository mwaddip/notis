// MESH_INTERFACE → The node endpoint — `meshFetch` is the client's HTTP over
// libp2p: an `HttpFetch` (CONSTANTS → Client reads) that reads a mesh URL
// `notis-mesh://<notisId><path>` by opening a libp2p stream to the node whose
// key is `notisId` and letting `@libp2p/http` run the HTTP over it. Browser-
// safe: no `node:` imports (`MESH_INTERFACE → Place in the workspace`).

import type { Libp2p } from '@libp2p/interface';
import type { HTTP } from '@libp2p/http';
import { multiaddr } from '@multiformats/multiaddr';
import type { HttpFetch } from '@dagsocial/node-reads';
import { REQUEST_TIMEOUT_MS } from '@dagsocial/node-reads';
import { peerIdFromNotisId, MeshKeyError } from './identity.js';
import { parseMeshUrl, MeshUrlError } from './mesh-url.js';

/**
 * MESH_INTERFACE → The node endpoint — a mesh fetch's failure, by what the
 * caller is to make of it:
 * - `method` — the request's method is not `GET`, refused before any dial.
 * - `url` — the mesh URL did not parse (any scheme but `notis-mesh`, a key
 *   that is not 64 lowercase hex, an empty path).
 * - `transport` — the peer could not be reached or the stream broke.
 *
 * A timeout is the caller's signal, not a `MeshFetchError`: when the init
 * signal fires or the fetch's own `timeoutMs` elapses, the request rejects
 * with the signal's reason (a `DOMException` of name `'TimeoutError'` from
 * `AbortSignal.timeout`), so `fetchJson` marks a deadline the same way it
 * does over plain `fetch` (WEB_INTERFACE → Reading a node's answer).
 */
export class MeshFetchError extends Error {
  override readonly name = 'MeshFetchError';
  readonly kind: 'method' | 'url' | 'transport';
  constructor(kind: 'method' | 'url' | 'transport', message: string) {
    super(message);
    this.kind = kind;
  }
}

/**
 * `MESH_INTERFACE → The node endpoint` — build an `HttpFetch` over a given
 * libp2p node. The returned function takes a mesh URL `notis-mesh://<notisId>
 * <path>`, dials the peer whose key is `notisId`, and runs the GET as HTTP
 * over libp2p (`@libp2p/http`'s `fetch`). `init.signal` and `timeoutMs`
 * compose: whichever fires first ends the request with its reason.
 */
export function meshFetch(
  node: Libp2p<{ http: HTTP }>,
  opts?: { timeoutMs?: number },
): HttpFetch {
  const timeoutMs = opts?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return (url, init) => meshFetchOne(node, url, init, timeoutMs);
}

async function meshFetchOne(
  node: Libp2p<{ http: HTTP }>,
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    throw new MeshFetchError('method', `method ${method} not allowed over the mesh`);
  }

  let notisId: string;
  let path: string;
  try {
    const parsed = parseMeshUrl(url);
    notisId = parsed.notisId;
    path = parsed.path;
  } catch (e) {
    if (e instanceof MeshUrlError) throw new MeshFetchError('url', e.message);
    throw e;
  }

  let peerIdString: string;
  try {
    peerIdString = peerIdFromNotisId(notisId).toString();
  } catch (e) {
    if (e instanceof MeshKeyError) throw new MeshFetchError('url', e.message);
    throw e;
  }

  // `MESH_INTERFACE → The mesh URL` — `path` keeps its leading `/`. The
  // multiaddr `/http-path/` codec URL-decodes its value and prepends a
  // leading `/`, so the inner value is the path WITHOUT its own leading
  // slash, URL-encoded.
  const inner = path.slice(1);
  const resource = multiaddr(
    `/p2p/${peerIdString}/http-path/${encodeURIComponent(inner)}`,
  );

  // Combine the caller's signal with our own timeout. Whichever fires
  // first wins, and its reason reaches the caller unchanged — a
  // `DOMException` with `name === 'TimeoutError'` for `AbortSignal.timeout`.
  const ctrl = new AbortController();
  const userSignal = init?.signal ?? undefined;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const abortWith = (reason: unknown): void => {
    if (!ctrl.signal.aborted) ctrl.abort(reason);
  };
  if (userSignal) {
    if (userSignal.aborted) abortWith(userSignal.reason);
    else userSignal.addEventListener('abort', () => abortWith(userSignal.reason), { once: true });
  }
  if (timeoutSignal.aborted) abortWith(timeoutSignal.reason);
  else timeoutSignal.addEventListener('abort', () => abortWith(timeoutSignal.reason), { once: true });

  // Race the fetch against the combined signal — @libp2p/http.fetch does not
  // reliably reject once the connection is open, so we end the wait ourselves.
  const fetchPromise = node.services.http.fetch(resource, { signal: ctrl.signal });

  // On abort, make sure a Response that resolves after the race leaves no
  // dangling body (a late response's `TransformStream` keeps buffering
  // upstream chunks otherwise), and a late rejection does not surface as
  // an unhandled promise rejection.
  ctrl.signal.addEventListener(
    'abort',
    () => {
      fetchPromise.then(
        (lateRes) => {
          const body = lateRes.body;
          if (body !== null) body.cancel(ctrl.signal.reason).catch(() => undefined);
        },
        () => undefined,
      );
    },
    { once: true },
  );

  const abortPromise = new Promise<never>((_, reject) => {
    ctrl.signal.addEventListener(
      'abort',
      () => reject(ctrl.signal.reason),
      { once: true },
    );
  });

  let res: Response;
  try {
    res = await Promise.race([fetchPromise, abortPromise]);
  } catch (e) {
    // A signal-fired failure keeps its reason (fetchJson's deadline rule).
    if (ctrl.signal.aborted) throw ctrl.signal.reason;
    const msg = e instanceof Error ? e.message : String(e);
    throw new MeshFetchError('transport', msg);
  }

  if (!res.body) return res;

  // Wrap the Response body so a signal fire past the headers also ends the
  // reader with the signal's reason: without this, a reader waiting on a
  // chunk never returns, and fetchJson's deadline never fires in the body.
  const original = res.body;
  const wrapped = new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = original.getReader();
      // One place ends the stream, once; a second close/error must stay
      // silent to keep ReadableStream happy, but a different failure must
      // not be swallowed.
      let ended = false;
      const endNormally = (): void => {
        if (ended) return;
        ended = true;
        controller.close();
      };
      const endWith = (reason: unknown): void => {
        if (ended) return;
        ended = true;
        controller.error(reason);
      };
      const stopOnAbort = (): void => {
        reader.cancel(ctrl.signal.reason).catch(() => undefined);
        endWith(ctrl.signal.reason);
      };
      if (ctrl.signal.aborted) stopOnAbort();
      else ctrl.signal.addEventListener('abort', stopOnAbort, { once: true });
      void (async () => {
        try {
          for (;;) {
            const r = await reader.read();
            if (r.done) { endNormally(); return; }
            controller.enqueue(r.value);
          }
        } catch (e) {
          endWith(e);
        }
      })();
    },
    cancel(reason) {
      // The caller's `reader.cancel()` reaches the wrapped stream here;
      // propagate to the upstream reader so the libp2p stream closes too.
      original.cancel(reason).catch(() => undefined);
    },
  });

  // Preserve exact status, statusText and headers — a 404 or 405 that is
  // not in `[200, 599]` is still forwarded verbatim by the node side's
  // Response, so we keep whatever came in.
  return new Response(wrapped, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}
