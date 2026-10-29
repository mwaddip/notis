// MESH_INTERFACE → The node endpoint — `meshFetch` is the client's HTTP over
// libp2p: an `HttpFetch` (CONSTANTS → Client reads) that reads a mesh URL
// `notis-mesh://<notisId><path>` by opening a libp2p stream to the node whose
// key is `notisId` and letting `@libp2p/http` run the HTTP over it. Browser-
// safe: no `node:` imports (`MESH_INTERFACE → Place in the workspace`).

import type { Libp2p } from '@libp2p/interface';
import type { HTTP } from '@libp2p/http';
import type { HttpFetch } from '@dagsocial/node-reads';

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

export function meshFetch(
  _node: Libp2p<{ http: HTTP }>,
  _opts?: { timeoutMs?: number },
): HttpFetch {
  throw new Error('not implemented yet');
}
