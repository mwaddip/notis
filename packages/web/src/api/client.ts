import type {
  FeedResult, ThreadResult, PostResult, StatusResult, BlockCurrent, KarmaResult,
  VouchesTargetResult, VouchesVoucherResult, VouchCooldownsResult, BondsResult,
} from './dto';

// This module issues GET requests and nothing else — no POST, no body. A `viewer`
// parameter is a query on a GET, not a write, so it is carried here now that an
// identity can be loaded; a key, a signature or a write this module does not hold.
// The writes live next door in write.ts.
// WEB_INTERFACE → "The write client is its own module beside the read client".

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

/** The reads the client offers — the seam the App depends on, so a test can drive
 *  it over a fake. Every call is a GET. `viewer` is the loaded identity's key,
 *  carried once one exists so `likedByViewer` is the node's answer
 *  (WEB_INTERFACE → "Every read carries the viewer's key once an identity is loaded, and none does before"). */
export interface Api {
  feed(page?: Page, viewer?: string, author?: string): Promise<FeedResult>;
  thread(id: string, page?: Page, viewer?: string): Promise<ThreadResult | null>;
  post(id: string, viewer?: string): Promise<PostResult | null>;
  status(): Promise<StatusResult>;
  currentBlock(): Promise<BlockCurrent>;
  karma(key: string, page?: Page): Promise<KarmaResult>;
  // The membership reads — GETs, none viewer-bearing (WEB_INTERFACE → The author
  // window, → The profile window). Keyset-paged like `karma`.
  vouchesByTarget(key: string, page?: Page): Promise<VouchesTargetResult>;
  vouchesByVoucher(key: string, page?: Page): Promise<VouchesVoucherResult>;
  vouchCooldowns(key: string, page?: Page): Promise<VouchCooldownsResult>;
  bonds(key: string, page?: Page): Promise<BondsResult>;
}

export class NodeClient implements Api {
  // The origin is read fresh on every call, never captured — the settings
  // window can repoint it, and a foreign origin fails until the node gains CORS.
  // The default is same-origin: an empty base.
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

  feed(page: Page = {}, viewer?: string, author?: string): Promise<FeedResult> {
    // `author` filters to one identity's committed posts — the author-posts window
    // (WEB_INTERFACE → The author window); the feed passes it undefined.
    return this.get<FeedResult>(this.url('/posts', { limit: page.limit, after: page.after ?? undefined, author, viewer }));
  }

  thread(id: string, page: Page = {}, viewer?: string): Promise<ThreadResult | null> {
    return this.getOrNull<ThreadResult>(
      this.url(`/posts/${encodeURIComponent(id)}/thread`, { limit: page.limit, after: page.after ?? undefined, viewer }),
    );
  }

  post(id: string, viewer?: string): Promise<PostResult | null> {
    return this.getOrNull<PostResult>(this.url(`/posts/${encodeURIComponent(id)}`, { viewer }));
  }

  status(): Promise<StatusResult> {
    return this.get<StatusResult>(this.url('/status'));
  }

  currentBlock(): Promise<BlockCurrent> {
    return this.get<BlockCurrent>(this.url('/blocks/current'));
  }

  // The spendable view's confirmed boxes, paged by `next`. No viewer — a balance
  // read is keyed by the identity in the path, not by a viewer query.
  karma(key: string, page: Page = {}): Promise<KarmaResult> {
    return this.get<KarmaResult>(this.url(`/karma/${encodeURIComponent(key)}`, { limit: page.limit, after: page.after ?? undefined }));
  }

  vouchesByTarget(key: string, page: Page = {}): Promise<VouchesTargetResult> {
    return this.get<VouchesTargetResult>(this.url('/vouches', { target: key, limit: page.limit, after: page.after ?? undefined }));
  }

  vouchesByVoucher(key: string, page: Page = {}): Promise<VouchesVoucherResult> {
    return this.get<VouchesVoucherResult>(this.url('/vouches', { voucher: key, limit: page.limit, after: page.after ?? undefined }));
  }

  vouchCooldowns(key: string, page: Page = {}): Promise<VouchCooldownsResult> {
    return this.get<VouchCooldownsResult>(this.url('/vouches', { voucher: key, cooldowns: 1, limit: page.limit, after: page.after ?? undefined }));
  }

  bonds(key: string, page: Page = {}): Promise<BondsResult> {
    return this.get<BondsResult>(this.url(`/invites/${encodeURIComponent(key)}`, { limit: page.limit, after: page.after ?? undefined }));
  }
}
