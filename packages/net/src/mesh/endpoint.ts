// MESH_INTERFACE → The node endpoint — a mesh node answers HTTP over
// libp2p (`@libp2p/http`) by forwarding each `GET` and `POST` to its own
// public HTTP API on loopback, a `POST`'s body and `content-type` as
// sent, and answering with the upstream's status, `content-type` and
// body bytes as they came. Any other method answers 405. The server is
// built by passing this factory's `WebServer` to `http({ server })` at
// libp2p construction.
//
// Node-only: it reads from an upstream HTTP server, which is a Node.js
// service (`MESH_INTERFACE → Place in the workspace`).

import type { WebServer } from '@libp2p/http';
import type { HeaderInfo } from '@libp2p/http-utils';
import {
  responseToStream,
  Response as HttpResponse,
  normalizeUrl,
} from '@libp2p/http-utils';
import { REQUEST_TIMEOUT_MS } from '@dagsocial/node-reads';

export function meshEndpoint(
  httpBase: string,
  opts?: { upstreamTimeoutMs?: number },
): WebServer {
  const base = httpBase.replace(/\/+$/, '');
  const upstreamTimeoutMs = opts?.upstreamTimeoutMs ?? REQUEST_TIMEOUT_MS;
  return {
    async inject(info, stream, _connection) {
      try {
        const method = info.method;
        if (method !== 'GET' && method !== 'POST') {
          await responseToStream(new HttpResponse(null, { status: 405 }), stream);
          await stream.close().catch(() => undefined);
          return;
        }
        const url = normalizeUrl(info);
        const init: RequestInit = {
          method,
          signal: AbortSignal.timeout(upstreamTimeoutMs),
        };
        if (method === 'POST') {
          const cl = info.headers.get('content-length');
          const bytes = cl == null ? NaN : Number.parseInt(cl, 10);
          if (!Number.isFinite(bytes) || bytes < 0) {
            await responseToStream(new HttpResponse(null, { status: 411 }), stream);
            await stream.close().catch(() => undefined);
            return;
          }
          const body = await readBody(info, stream, bytes);
          // A Blob wraps the bytes so Node's fetch reads a known-length
          // body; a plain Uint8Array is not a `BodyInit` in the DOM
          // lib's types. The slice copies into a fresh `ArrayBuffer`
          // (not `SharedArrayBuffer`), which `BlobPart` names.
          const copy = new Uint8Array(body.byteLength);
          copy.set(body);
          init.body = new Blob([copy]);
          const ct = info.headers.get('content-type');
          if (ct !== null) {
            // `fetch` wants plain `Headers` here; copy only the header
            // the endpoint forwards (`MESH_INTERFACE → The node endpoint` —
            // a POST's `content-type` goes through as sent).
            const h = new Headers();
            h.set('content-type', ct);
            init.headers = h;
          }
        }
        // The upstream wait is bounded: `fetch` with `AbortSignal.timeout`
        // ends both the request-headers wait and the body-stream read at
        // `upstreamTimeoutMs`; the catch below invents no status and
        // aborts the libp2p stream. `@libp2p/http`'s client parser does
        // not watch for a stream reset, so the client learns of this
        // abort at its own deadline, not here
        // (`MESH_INTERFACE → The node endpoint`).
        const upstreamRes = await fetch(base + url.pathname + url.search, init);
        // Forward status, `content-type` and body bytes as they came.
        // Other headers would need re-encoding (`transfer-encoding:
        // chunked`, `connection: close`) that the client parser cannot
        // track across the HTTP-over-libp2p stream, so they are omitted.
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
        // `stream.abort` is idempotent — on a stream the client has
        // already reset it transitions the state and throws nothing, so
        // no guard is needed around the call.
        stream.abort(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };
}

/**
 * Read the request body. `@libp2p/http-utils@2.0.6`'s `readHeaders`
 * runs its HTTPParser with only `kOnHeadersComplete` set — its default
 * `kOnBody` is a no-op, and when a single incoming buffer carries
 * headers *and* body, the parser's `BODY_SIZED` state consumes the
 * body bytes through that no-op and `parser.execute` returns the full
 * buffer length. The pushback branch `read < buf.byteLength` never
 * fires, so the body bytes never land back on the stream's read
 * buffer. The same bytes are reachable through `info.raw` — the
 * `Uint8ArrayList` `earlyData` that `readHeaders` appends to after
 * every `execute` call, which `HeaderInfo.raw` references. Any
 * content-length not already in `info.raw` comes off the stream's
 * `'message'` events as usual.
 */
async function readBody(
  info: HeaderInfo,
  stream: unknown,
  bytes: number,
): Promise<Uint8Array> {
  if (bytes === 0) return new Uint8Array();
  const out = new Uint8Array(bytes);
  let n = 0;
  // The parser-eaten tail of `info.raw` is everything after the
  // `\r\n\r\n` headers terminator.
  const raw = info.raw;
  const headerEnd = findHeadersEnd(raw);
  const fromRawLen = Math.min(bytes, raw.byteLength - headerEnd);
  if (fromRawLen > 0) {
    out.set(raw.subarray(headerEnd, headerEnd + fromRawLen), 0);
    n = fromRawLen;
  }
  if (n === bytes) return out;
  // Read the remainder straight off the stream's `'message'` events.
  const s = stream as {
    addEventListener(
      type: string,
      cb: (ev: { data: { subarray(start?: number, end?: number): Uint8Array } }) => void,
    ): void;
    removeEventListener(type: string, cb: unknown): void;
    push(bytes: Uint8Array): void;
  };
  return new Promise<Uint8Array>((resolve, reject) => {
    let settled = false;
    const onMessage = (ev: { data: { subarray(start?: number, end?: number): Uint8Array } }): void => {
      if (settled) return;
      const buf = ev.data.subarray();
      const need = bytes - n;
      if (buf.byteLength <= need) {
        out.set(buf, n);
        n += buf.byteLength;
        if (n === bytes) {
          settled = true;
          s.removeEventListener('message', onMessage);
          s.removeEventListener('end', onEnd);
          s.removeEventListener('close', onEnd);
          resolve(out);
        }
      } else {
        out.set(buf.subarray(0, need), n);
        n = bytes;
        settled = true;
        s.removeEventListener('message', onMessage);
        s.removeEventListener('end', onEnd);
        s.removeEventListener('close', onEnd);
        s.push(buf.subarray(need));
        resolve(out);
      }
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      s.removeEventListener('message', onMessage);
      s.removeEventListener('end', onEnd);
      s.removeEventListener('close', onEnd);
      reject(new Error(`request body ended at ${n} of ${bytes} bytes`));
    };
    s.addEventListener('message', onMessage);
    s.addEventListener('end', onEnd);
    s.addEventListener('close', onEnd);
  });
}

/**
 * Find the offset of the first byte past the `\r\n\r\n` headers
 * terminator in `raw`. The HTTPParser only sets `kOnHeadersComplete`
 * after it has consumed the terminator, so `raw` always contains it.
 */
function findHeadersEnd(raw: {
  byteLength: number;
  indexOf(search: Uint8Array): number;
}): number {
  const idx = raw.indexOf(CRLF_CRLF);
  if (idx < 0) {
    // A `readHeaders` that returned without the terminator is a
    // library invariant break — treat `info.raw` as containing only
    // headers so body reading falls through to the stream.
    return raw.byteLength;
  }
  return idx + CRLF_CRLF.byteLength;
}

const CRLF_CRLF = new Uint8Array([13, 10, 13, 10]);
