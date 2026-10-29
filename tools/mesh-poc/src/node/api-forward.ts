// MESH_INTERFACE → The node endpoint — a node's mesh service answers HTTP
// over libp2p (`@libp2p/http`) by forwarding each `GET` to its own Notis
// node's HTTP base and answering with the upstream's status, `content-type`
// and body bytes as they came. Any other method answers 405. The server is
// built by passing this factory's `WebServer` to `http({ server })` at
// libp2p construction.
//
// Node-only: it reads from an upstream HTTP server, which is a Node.js
// service (`MESH_INTERFACE → Place in the workspace`).

import type { WebServer } from '@libp2p/http';
import {
  streamToRequest,
  responseToStream,
  Response as HttpResponse,
} from '@libp2p/http-utils';
import { REQUEST_TIMEOUT_MS } from '@dagsocial/node-reads';

export function nodeApiServer(
  upstream: string,
  opts?: { upstreamTimeoutMs?: number },
): WebServer {
  const base = upstream.replace(/\/+$/, '');
  const upstreamTimeoutMs = opts?.upstreamTimeoutMs ?? REQUEST_TIMEOUT_MS;
  return {
    async inject(info, stream, _connection) {
      try {
        const req = streamToRequest(info, stream);
        if (req.method !== 'GET') {
          await responseToStream(new HttpResponse(null, { status: 405 }), stream);
          await stream.close().catch(() => undefined);
          return;
        }
        const url = new URL(req.url);
        // The upstream wait is bounded: `fetch` with `AbortSignal.timeout`
        // ends both the request-headers wait and the body-stream read at
        // `upstreamTimeoutMs`; the catch below invents no status and aborts
        // the libp2p stream, which the client's reader surfaces as a
        // transport failure (MESH_INTERFACE → The node endpoint).
        const upstreamRes = await fetch(base + url.pathname + url.search, {
          signal: AbortSignal.timeout(upstreamTimeoutMs),
        });
        // `MESH_INTERFACE → The node endpoint` — forward status, content-type
        // and body bytes as they came. Other headers would need re-encoding
        // (`transfer-encoding: chunked`, `connection: close`) that the client
        // parser cannot track across the HTTP-over-libp2p stream, so we omit
        // them.
        const outHeaders = new Headers();
        const ct = upstreamRes.headers.get('content-type');
        if (ct !== null) outHeaders.set('content-type', ct);
        await responseToStream(
          new HttpResponse(upstreamRes.body, {
            status: upstreamRes.status,
            headers: outHeaders,
          }),
          stream,
        );
        await stream.close().catch(() => undefined);
      } catch (err) {
        try {
          stream.abort(err instanceof Error ? err : new Error(String(err)));
        } catch { /* stream already torn down */ }
      }
    },
  };
}
