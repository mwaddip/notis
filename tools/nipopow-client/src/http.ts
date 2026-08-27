export type HttpFetch = (url: string) => Promise<Response>;

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

export async function fetchJson<T>(
  httpFetch: HttpFetch,
  url: string,
): Promise<NodeResult<T>> {
  const res = await httpFetch(url);
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, body: text };
  return { ok: true, data: JSON.parse(text) as T };
}
