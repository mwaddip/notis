// MESH_INTERFACE → The node endpoint — `meshFetch` and
// `meshFetchOverConnection` are the two `HttpFetch` building blocks over
// libp2p: both open their stream themselves (so a signal fire can close it
// directly, past `@libp2p/http.fetch`'s hidden handle) and share the HTTP
// exchange — signal composition, body wrap, abort. `meshFetch` dials by
// key for callers without a client-side connection list; the client's
// reads use `meshFetchOverConnection` under the rule
// MESH_INTERFACE → The client's node list → "A read opens no connection".
// Browser-safe: no `node:` imports
// (`MESH_INTERFACE → Place in the workspace`).

import type { Connection, Libp2p, PeerId, Stream } from '@libp2p/interface';
import { fetch as httpFetch } from '@libp2p/http-fetch';
import type { HttpFetch } from '@dagsocial/node-reads';
import { REQUEST_TIMEOUT_MS } from '@dagsocial/node-reads';
import { notisIdFromPeerId, peerIdFromNotisId, MeshKeyError } from './identity.js';
import { parseMeshUrl, MeshUrlError } from './mesh-url.js';

// MESH_INTERFACE → The node endpoint — libp2p's HTTP/1.1 protocol id, the
// one `@libp2p/http`'s server and `@libp2p/http-fetch`'s client both dial
// (@libp2p/http/dist/src/constants.js). Carried locally so the mesh
// client's browser bundle does not reach `@libp2p/http` for a constant
// (its server half pulls `@libp2p/http-utils`'s `stream-to-socket.js`
// through the barrel, and the browser never serves HTTP over the mesh).
const HTTP_PROTOCOL = '/http/1.1';

/**
 * MESH_INTERFACE → The node endpoint — a mesh fetch's failure, by what the
 * caller is to make of it:
 * - `method` — the request's method is not `GET`, refused before any dial.
 * - `url` — the mesh URL did not parse (any scheme but `notis-mesh`, a key
 *   that is not 64 lowercase hex, an empty path).
 * - `transport` — the peer could not be reached or the stream broke; for
 *   the client's connection-only form (MESH_INTERFACE → The client's node
 *   list → "A read opens no connection"), this also carries the
 *   no-connection case.
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
 * MESH_INTERFACE → The node endpoint — build an `HttpFetch` over a given
 * libp2p node, dialling by key. For callers without a client-side
 * connection list (the plain mesh fetch, as `@dagsocial/mesh-poc`'s
 * entry point). The returned function takes a mesh URL
 * `notis-mesh://<notisId><path>`, opens a libp2p stream to the peer whose
 * key is `notisId` through `node.dialProtocol`, and runs
 * `@libp2p/http-fetch` over it. `init.signal` and `timeoutMs` compose:
 * whichever fires first closes the stream and ends the body reader with
 * the signal's reason.
 */
export function meshFetch(
  node: Libp2p,
  opts?: { timeoutMs?: number },
): HttpFetch {
  const timeoutMs = opts?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return (url, init) => meshFetchOne(
    (peerId, signal) => node.dialProtocol(peerId, HTTP_PROTOCOL, { signal }),
    url, init, timeoutMs,
  );
}

/**
 * MESH_INTERFACE → The client's node list → "A read opens no connection"
 * — "Every read the client makes over a mesh URL ... opens its stream on
 * a connection the client already holds to that key: an open one, a
 * direct one first, never a limited one. With none, the read fails as a
 * transport failure." The `pick` names which connection to open the
 * stream on for a given `notisId`; a `null` return rejects as
 * `MeshFetchError` of kind `transport` without any dial.
 */
export function meshFetchOverConnection(
  pick: (notisId: string) => Connection | null,
  opts?: { timeoutMs?: number },
): HttpFetch {
  const timeoutMs = opts?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return (url, init) => meshFetchOne(
    (peerId, signal) => {
      // The URL has already been parsed inside `meshFetchOne` by the
      // time the opener runs; `notisId` reaches us through `peerId`'s
      // mapping. The pick is given the `notisId` string the list keys
      // on, not the libp2p peer id.
      const notisId = notisIdFromPeerId(peerId);
      const conn = pick(notisId);
      if (conn === null) {
        return Promise.reject(new MeshFetchError('transport', `no open connection for ${notisId}`));
      }
      return conn.newStream(HTTP_PROTOCOL, { signal });
    },
    url, init, timeoutMs,
  );
}

async function meshFetchOne(
  openStream: (peerId: PeerId, signal: AbortSignal) => Promise<Stream>,
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

  // The opener runs the one step `meshFetch` and `meshFetchOverConnection`
  // differ on: dialProtocol by key, or a new stream on a connection the
  // client already picked. `@libp2p/http.fetch` hides its stream and never
  // closes it from the outside, so a server that keeps writing after the
  // client gives up leaves the stream open on both ends; owning the
  // handle here lets a signal fire call stream.abort directly.
  let stream: Stream;
  try {
    stream = await openStream(peerId, ctrl.signal);
  } catch (e) {
    if (ctrl.signal.aborted) throw ctrl.signal.reason;
    if (e instanceof MeshFetchError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new MeshFetchError('transport', msg);
  }

  // On signal fire, close the libp2p stream directly: `@libp2p/http-fetch`'s
  // response-parser listens for 'message' and 'remoteCloseWrite' and ignores
  // a local abort, so without this call the stream stays open against a
  // server that never finishes its body. `stream.abort` is idempotent — on a
  // closed, reset or already-aborted stream it transitions the state and
  // throws nothing, so no guard is needed around the call.
  ctrl.signal.addEventListener(
    'abort',
    () => {
      const reason = ctrl.signal.reason;
      stream.abort(reason instanceof Error ? reason : new Error('aborted'));
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
