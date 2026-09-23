export type HttpFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** A node call that has not answered in this many ms is treated as unreachable. */
const REQUEST_TIMEOUT_MS = 10_000;

/** The most characters of any one node-supplied string a verdict names. */
const VERDICT_TEXT_MAX = 120;

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
 * One node's failure — unreachable, timed out, a body cut off in flight, or a
 * body that will not parse — is reported as a non-ok result (`status: 0` for a
 * transport failure), never thrown. Asking two or more independent nodes is the
 * tool's whole defence against an eclipsing node (NIPOPOW_INTERFACE →
 * compareProofs), so a single dead or hostile peer must leave the reachable
 * nodes to decide rather than sink the run.
 */
export async function fetchJson<T>(
  httpFetch: HttpFetch,
  url: string,
): Promise<NodeResult<T>> {
  let res: Response;
  let text: string;
  try {
    res = await httpFetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    text = await res.text();
  } catch (e) {
    return { ok: false, status: 0, body: e instanceof Error ? e.message : String(e) };
  }
  if (!res.ok) return { ok: false, status: res.status, body: text };
  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return { ok: false, status: res.status, body: `unparseable body: ${capped(text)}` };
  }
}

/**
 * A node's text as a verdict names it: whole up to 120 characters, else its
 * first 120 and `…`, a surrogate pair never split. Applied where the text
 * enters a verdict, never to the data a status is decided on — the nipopow
 * route's 404 is classified by its body's `error` (NODE_INTERFACE → Nipopow).
 */
export function capped(text: string): string {
  if (text.length <= VERDICT_TEXT_MAX) return text;
  const last = text.charCodeAt(VERDICT_TEXT_MAX - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? VERDICT_TEXT_MAX - 1 : VERDICT_TEXT_MAX;
  return `${text.slice(0, end)}…`;
}

/** A parsed body read as an object: not null, not an array. Its fields are the
 *  node's claims, each checked where a status is decided on it. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
