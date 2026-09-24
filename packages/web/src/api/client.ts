import type {
  FeedResult, ThreadResult, PostResult, StatusResult, BlockCurrent, KarmaResult,
  VouchesTargetResult, VouchesVoucherResult, VouchCooldownsResult, BondsResult,
  UsernameResult, CreditsResult,
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

/** A 2xx whose body is not the page its route answers — thrown where a non-2xx
 *  throws `ApiError`, so every caller's failure path takes it. */
export class PageError extends Error {
  constructor() {
    super("the node's answer is not a page");
    this.name = 'PageError';
  }
}

/** The list each paged route answers its rows in: `posts`, the thread's
 *  `descendants`, the `boxes` of /karma and /credits, the `vouches` of both
 *  /vouches arms, the cooldown arm's `cooldowns` and the `bonds` of /invites
 *  (NODE_INTERFACE → "Every list a view returns is a page"). */
type PageList = 'posts' | 'descendants' | 'boxes' | 'vouches' | 'cooldowns' | 'bonds';

// The one thing `encodeURIComponent` throws on.
const LONE_SURROGATE = /\p{Cs}/u;

/** A page is an object whose list is an array and whose `next` is null or a
 *  key the next read carries as `after` — a non-empty string, since `url()`
 *  drops an empty query value, with no lone surrogate (NODE_INTERFACE → "Every
 *  list a view returns is a page", WEB_INTERFACE → "Paging is keyset, never
 *  offset"). */
function isPage(data: unknown, list: PageList): boolean {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  const fields = data as Record<string, unknown>;
  if (!Array.isArray(fields[list])) return false;
  const next = fields['next'];
  return next === null || (typeof next === 'string' && next !== '' && !LONE_SURROGATE.test(next));
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
  feed(page?: Page, viewer?: string, author?: string, roots?: boolean): Promise<FeedResult>;
  thread(id: string, page?: Page, viewer?: string): Promise<ThreadResult | null>;
  post(id: string, viewer?: string): Promise<PostResult | null>;
  status(): Promise<StatusResult>;
  currentBlock(): Promise<BlockCurrent>;
  karma(key: string, page?: Page): Promise<KarmaResult>;
  credits(key: string, page?: Page): Promise<CreditsResult>;
  // The membership reads — GETs, none viewer-bearing (WEB_INTERFACE → The author
  // window, → The profile window). Keyset-paged like `karma`.
  vouchesByTarget(key: string, page?: Page): Promise<VouchesTargetResult>;
  vouchesByVoucher(key: string, page?: Page): Promise<VouchesVoucherResult>;
  vouchCooldowns(key: string, page?: Page): Promise<VouchCooldownsResult>;
  bonds(key: string, page?: Page): Promise<BondsResult>;
  usernameByOwner(key: string): Promise<UsernameResult | null>;
  // The handle → holder resolution the send form runs at the press; a leading
  // `@` is stripped, a 404 answers null (WEB_INTERFACE → The wallet window →
  // "The `send` row").
  usernameByName(name: string): Promise<UsernameResult | null>;
}

export class NodeClient implements Api {
  // The origin is read fresh on every call, never captured — the settings
  // window can repoint it to any origin (NODE_INTERFACE → Cross-origin requests).
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

  private async get<T>(url: string, list?: keyof T & PageList): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`);
    return this.body<T>(res, list);
  }

  /** A 404 is a legitimate absence (no such post), not a transport failure. */
  private async getOrNull<T>(url: string, list?: keyof T & PageList): Promise<T | null> {
    const res = await fetch(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`);
    return this.body<T>(res, list);
  }

  /** A 2xx's body. A paged read names its list, and a body that is not a page
   *  throws there. */
  private async body<T>(res: Response, list?: keyof T & PageList): Promise<T> {
    const data: unknown = await res.json();
    if (list !== undefined && !isPage(data, list)) throw new PageError();
    return data as T;
  }

  feed(page: Page = {}, viewer?: string, author?: string, roots?: boolean): Promise<FeedResult> {
    // `author` filters to one identity's committed posts — the author-posts window
    // (WEB_INTERFACE → The author window); `roots=1` restricts to posts with no
    // parent, the feed's own read (WEB_INTERFACE → What the feed reads). The node
    // rejects `roots=0`, so it is 1 or absent (NODE_INTERFACE → Posts).
    return this.get<FeedResult>(this.url('/posts', { limit: page.limit, after: page.after ?? undefined, author, viewer, roots: roots ? 1 : undefined }), 'posts');
  }

  thread(id: string, page: Page = {}, viewer?: string): Promise<ThreadResult | null> {
    return this.getOrNull<ThreadResult>(
      this.url(`/posts/${encodeURIComponent(id)}/thread`, { limit: page.limit, after: page.after ?? undefined, viewer }),
      'descendants',
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
    return this.get<KarmaResult>(this.url(`/karma/${encodeURIComponent(key)}`, { limit: page.limit, after: page.after ?? undefined }), 'boxes');
  }

  credits(key: string, page: Page = {}): Promise<CreditsResult> {
    return this.get<CreditsResult>(this.url(`/credits/${encodeURIComponent(key)}`, { limit: page.limit, after: page.after ?? undefined }), 'boxes');
  }

  vouchesByTarget(key: string, page: Page = {}): Promise<VouchesTargetResult> {
    return this.get<VouchesTargetResult>(this.url('/vouches', { target: key, limit: page.limit, after: page.after ?? undefined }), 'vouches');
  }

  vouchesByVoucher(key: string, page: Page = {}): Promise<VouchesVoucherResult> {
    return this.get<VouchesVoucherResult>(this.url('/vouches', { voucher: key, limit: page.limit, after: page.after ?? undefined }), 'vouches');
  }

  vouchCooldowns(key: string, page: Page = {}): Promise<VouchCooldownsResult> {
    return this.get<VouchCooldownsResult>(this.url('/vouches', { voucher: key, cooldowns: 1, limit: page.limit, after: page.after ?? undefined }), 'cooldowns');
  }

  bonds(key: string, page: Page = {}): Promise<BondsResult> {
    return this.get<BondsResult>(this.url(`/invites/${encodeURIComponent(key)}`, { limit: page.limit, after: page.after ?? undefined }), 'bonds');
  }

  usernameByOwner(key: string): Promise<UsernameResult | null> {
    return this.getOrNull<UsernameResult>(this.url('/usernames', { owner: key }));
  }

  usernameByName(name: string): Promise<UsernameResult | null> {
    const bare = name.startsWith('@') ? name.slice(1) : name;
    return this.getOrNull<UsernameResult>(this.url(`/usernames/${encodeURIComponent(bare)}`));
  }
}
