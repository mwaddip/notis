// WEB_INTERFACE → Reading a node's answer — the one reader every client of
// the node's HTTP API passes a body through: capped at the byte count the
// caller names, ended at REQUEST_TIMEOUT_MS, and non-ok results instead of
// thrown exceptions. One dead or hostile peer is a non-ok, not fatal, so the
// reachable nodes still decide (NIPOPOW_INTERFACE → compareProofs).

export type HttpFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** CONSTANTS → Client reads — a call that has not answered in this many ms
 *  reads as a transport failure. */
export const REQUEST_TIMEOUT_MS = 10_000;

export interface NodeResponse<T> {
  ok: true;
  data: T;
}
export interface NodeError {
  ok: false;
  status: number;
  body: string;
}
export type NodeResult<T> = NodeResponse<T> | NodeError;

/**
 * WEB_INTERFACE → Reading a node's answer — a transport failure, a timed-out
 * call, a body cut off in flight, or a body that will not parse as JSON is a
 * non-ok result (`status: 0` for a transport failure). The caller names the
 * byte cap (CONSTANTS → Client reads).
 */
export async function fetchJson<T>(
  httpFetch: HttpFetch,
  url: string,
  cap: number,
): Promise<NodeResult<T>> {
  let res: Response;
  try {
    res = await httpFetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    return { ok: false, status: 0, body: e instanceof Error ? e.message : String(e) };
  }
  return readCappedJson<T>(res, cap);
}

/**
 * WEB_INTERFACE → Reading a node's answer — read a `Response` under a byte
 * cap and parse it. A caller that already holds a `Response` (the batch
 * answer the extension's resolve reads) hands it here instead of going
 * through `fetchJson`. The returned shape is what every caller maps the same
 * way: an over-cap body is `{ ok: false, status, body: \`body over <cap>
 * bytes\` }`, a non-2xx body is `{ ok: false, status, body: text }`, an
 * unparseable 2xx body is `{ ok: false, status, body: 'unparseable body: …' }`,
 * and a parsed 2xx is `{ ok: true, data }`. A mid-stream transport failure
 * answers `{ ok: false, status: 0, body: errorMessage }`, as a connect
 * failure does.
 */
export async function readCappedJson<T>(
  res: Response,
  cap: number,
): Promise<NodeResult<T>> {
  let read: { ok: true; text: string } | { ok: false; overflowed: true };
  try {
    read = await readCappedText(res, cap);
  } catch (e) {
    return { ok: false, status: 0, body: e instanceof Error ? e.message : String(e) };
  }
  if (!read.ok) return { ok: false, status: res.status, body: `body over ${cap} bytes` };
  if (!res.ok) return { ok: false, status: res.status, body: read.text };
  try {
    return { ok: true, data: JSON.parse(read.text) as T };
  } catch {
    return { ok: false, status: res.status, body: `unparseable body: ${truncate(read.text)}` };
  }
}

/**
 * Read a `Response`'s body as UTF-8 text, counting the bytes delivered by the
 * stream. The stream is read chunk by chunk; once more than `cap` bytes have
 * arrived, the reader is cancelled and the body is refused. A `Response` with
 * no body reads as the empty string. UTF-8 is decoded as `res.text()` does
 * (replacement characters, no throw) through a `TextDecoder` with
 * `fatal: false`.
 */
async function readCappedText(
  res: Response,
  cap: number,
): Promise<{ ok: true; text: string } | { ok: false; overflowed: true }> {
  const body = res.body;
  if (body === null) return { ok: true, text: '' };
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let count = 0;
  let text = '';
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    count += r.value.byteLength;
    text += decoder.decode(r.value, { stream: true });
    if (count > cap) {
      await reader.cancel();
      return { ok: false, overflowed: true };
    }
  }
  text += decoder.decode();
  return { ok: true, text };
}

// A bounded prefix for the body field of an unparseable-2xx result — the raw
// text up to 120 code points, else as much of it as fits and `…`, a surrogate
// pair never split. Readers that quote the body for a person read it through
// their own escape rule; here the aim is to bound the string's length.
function truncate(text: string): string {
  const LIMIT = 120;
  let out = '';
  // A string iterates by code point, a surrogate pair as one step.
  for (const ch of text) {
    if (out.length + ch.length > LIMIT) return `${out}…`;
    out += ch;
  }
  return out;
}

/** A parsed body read as an object: not null, not an array. Its fields are
 *  the node's claims, each checked where a status is decided on it. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
