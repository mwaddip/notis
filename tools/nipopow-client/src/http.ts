export type HttpFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** A node call that has not answered in this many ms is treated as unreachable. */
const REQUEST_TIMEOUT_MS = 10_000;

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
    return { ok: false, status: res.status, body: `unparseable body: ${text.slice(0, 120)}` };
  }
}

/** A parsed body read as an object: not null, not an array. Its fields are the
 *  node's claims, each checked where a status is decided on it. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
