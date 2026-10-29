// MESH_INTERFACE → The node endpoint — `meshFetch` is the client's HTTP over
// libp2p: an `HttpFetch` (CONSTANTS → Client reads) that reads a mesh URL
// `notis-mesh://<notisId><path>` by opening a libp2p stream to the node whose
// key is `notisId` and running `@libp2p/http-fetch` over it. The stream is
// opened by this module so a signal fire can close it directly; `@libp2p/
// http.fetch` hides its stream and leaves it open against a never-ending
// server. Browser-safe: no `node:` imports (`MESH_INTERFACE → Place in the
// workspace`).

import type { Libp2p, Stream } from '@libp2p/interface';
import { HTTP_PROTOCOL, type HTTP } from '@libp2p/http';
import { fetch as httpFetch } from '@libp2p/http-fetch';
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
 * <path>`, opens a libp2p stream to the peer whose key is `notisId`, and
 * runs `@libp2p/http-fetch` over it. `init.signal` and `timeoutMs` compose:
 * whichever fires first closes the stream and ends the body reader with
 * the signal's reason.
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
  let peerId;
  try {
    peerId = peerIdFromNotisId(notisId);
    peerIdString = peerId.toString();
  } catch (e) {
    if (e instanceof MeshKeyError) throw new MeshFetchError('url', e.message);
    throw e;
  }

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

  // Open the libp2p stream ourselves. @libp2p/http.fetch hides its stream
  // and never closes it from the outside, so a server that keeps writing
  // after the client gives up leaves the stream open on both ends; owning
  // the handle here lets a signal fire call stream.abort directly.
  let stream: Stream;
  try {
    stream = await node.dialProtocol(peerId, HTTP_PROTOCOL, { signal: ctrl.signal });
  } catch (e) {
    if (ctrl.signal.aborted) throw ctrl.signal.reason;
    const msg = e instanceof Error ? e.message : String(e);
    throw new MeshFetchError('transport', msg);
  }

  // On signal fire, close the libp2p stream directly: `@libp2p/http-fetch`'s
  // response-parser listens for 'message' and 'remoteCloseWrite' and ignores
  // a local abort, so without this call the stream stays open against a
  // server that never finishes its body.
  ctrl.signal.addEventListener(
    'abort',
    () => {
      const reason = ctrl.signal.reason;
      try {
        stream.abort(reason instanceof Error ? reason : new Error('aborted'));
      } catch { /* already closed */ }
    },
    { once: true },
  );

  // The response-parser needs a URL for the request line; the peer id
  // string is the Host header, exactly as `@libp2p/http.fetch` would set
  // it when addressed by peer id.
  const httpUrl = new URL(`http://${peerIdString}${path}`);
  const fetchPromise = httpFetch(stream, httpUrl, { signal: ctrl.signal });
  // Prevent an unhandled rejection: once the race is lost, nothing holds
  // the fetch promise, and a late reject (e.g. the stream reset above)
  // would otherwise surface at the process level.
  fetchPromise.catch(() => undefined);
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
    if (ctrl.signal.aborted) throw ctrl.signal.reason;
    const msg = e instanceof Error ? e.message : String(e);
    throw new MeshFetchError('transport', msg);
  }

  if (!res.body) return res;

  // Wrap the Response body so a signal fire past the headers also ends the
  // reader with the signal's reason: `stream.abort` closes the libp2p
  // stream but the parser's output stream has no abort listener of its
  // own, so a reader waiting on a chunk never returns and `fetchJson`'s
  // deadline never fires in the body.
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
