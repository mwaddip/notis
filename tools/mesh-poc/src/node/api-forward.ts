// MESH_INTERFACE → The node endpoint — a node's mesh service answers HTTP
// over libp2p (`@libp2p/http`) by forwarding each `GET` to its own Notis
// node's HTTP base and answering with the upstream's status, `content-type`
// and body bytes as they came. Any other method answers 405.
//
// Node-only: it reads from an upstream HTTP server, which is a Node.js
// service (`MESH_INTERFACE → Place in the workspace`).

import type { Libp2p, Connection, Stream } from '@libp2p/interface';
import type { HTTP } from '@libp2p/http';
import {
  streamToRequest,
  responseToStream,
  type HeaderInfo,
  Response as HttpResponse,
} from '@libp2p/http-utils';

// The HTTP service's registrar carries an optional `endpoint`: a `WebServer`
// invoked for any request whose path matches no registered handler. The
// field is set from `HTTPInit.server` at service construction; a POC that
// takes an already-created node installs it here. The service's typed API
// does not surface it, so we reach it through this minimal shape — if the
// field is renamed in a future `@libp2p/http`, this call fails loudly.
interface Endpoint {
  inject(info: HeaderInfo, stream: Stream, connection: Connection): Promise<void>;
}
interface RegistrarHandle {
  httpRegistrar: { endpoint?: Endpoint };
}

export function forwardNodeApi(
  node: Libp2p<{ http: HTTP }>,
  upstream: string,
): void {
  const base = upstream.replace(/\/+$/, '');
  const endpoint: Endpoint = {
    async inject(info, stream, _connection) {
      try {
        const req = streamToRequest(info, stream);
        if (req.method !== 'GET') {
          await responseToStream(new HttpResponse(null, { status: 405 }), stream);
          await stream.close().catch(() => undefined);
          return;
        }
        const url = new URL(req.url);
        const upstreamRes = await fetch(base + url.pathname + url.search);
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
  const svc = node.services.http as unknown as RegistrarHandle;
  svc.httpRegistrar.endpoint = endpoint;
}
