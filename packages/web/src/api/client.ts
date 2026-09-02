import type {
  FeedResult, ThreadResult, PostResult, StatusResult, BlockCurrent,
} from './dto';

// ⛔ The read surface issues GET requests and nothing else (WEB_INTERFACE →
// "The read surface holds no key and computes no hash"). There is no method,
// body, or viewer parameter anywhere in this module. If a call here ever needs
// a POST, the slice has been left — stop and report, do not add it.

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface Page {
  limit?: number;
  after?: string | null;
}

export class NodeClient {
  // The origin is read fresh on every call, never captured — the settings
  // window can repoint it, and a foreign origin fails until the node gains CORS
  // (spec → §2.1). The default is same-origin: an empty base.
  constructor(private origin: () => string) {}

  private url(path: string, query?: Record<string, string | number | undefined>): string {
    const base = this.origin().replace(/\/$/, '');
    const qs = query
      ? Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
          .join('&')
      : '';
    return base + path + (qs ? '?' + qs : '');
  }

  private async get<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  }

  /** A 404 is a legitimate absence (no such post), not a transport failure. */
  private async getOrNull<T>(url: string): Promise<T | null> {
    const res = await fetch(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  }

  feed(page: Page = {}): Promise<FeedResult> {
    return this.get<FeedResult>(this.url('/posts', { limit: page.limit, after: page.after ?? undefined }));
  }

  thread(id: string, page: Page = {}): Promise<ThreadResult | null> {
    return this.getOrNull<ThreadResult>(
      this.url(`/posts/${encodeURIComponent(id)}/thread`, { limit: page.limit, after: page.after ?? undefined }),
    );
  }

  post(id: string): Promise<PostResult | null> {
    return this.getOrNull<PostResult>(this.url(`/posts/${encodeURIComponent(id)}`));
  }

  status(): Promise<StatusResult> {
    return this.get<StatusResult>(this.url('/status'));
  }

  currentBlock(): Promise<BlockCurrent> {
    return this.get<BlockCurrent>(this.url('/blocks/current'));
  }
}
