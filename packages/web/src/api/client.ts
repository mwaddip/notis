import { PAGE_LIMIT_DEFAULT } from '@dagsocial/types';
import {
  fetchJson,
  FEED_PAGE_READ_BYTES, THREAD_READ_BYTES, POST_READ_BYTES,
  STATUS_READ_BYTES, HEIGHT_READ_BYTES, LISTING_PAGE_READ_BYTES,
  VOUCH_PAGE_READ_BYTES, BOND_PAGE_READ_BYTES, NAME_READ_BYTES,
  type HttpFetch,
} from '@dagsocial/node-reads';
import type {
  FeedResult, ThreadResult, PostResult, StatusResult, BlockCurrent, KarmaResult,
  VouchesTargetResult, VouchesVoucherResult, VouchCooldownsResult, BondsResult,
  UsernameResult, CreditsResult,
} from './dto';
import {
  readStatus, readBlockCurrent, readKarmaResult, readCreditsResult,
  readVouchesByTargetResult, readVouchesByVoucherResult,
  readVouchCooldownsResult, readBondsResult, readUsername, readPostResult,
  readFeedResult, readThreadResult,
} from './readers';
import { ApiError, PageError } from './errors';

// A caller that cast `{}` as `Page` carries no `limit`; the client falls back
// to `PAGE_LIMIT_DEFAULT`, the limit the node applies to a `GET` with no
// `limit` query (TYPES_INTERFACE → HTTP view bounds). Both the URL the client
// asks and the `parsePage` the reader applies take the same value, so the
// page the node serves is held to the limit the URL asks.
function askedLimit(page: Page): number {
  return page.limit ?? PAGE_LIMIT_DEFAULT;
}

// This module issues GET requests and nothing else — no POST, no body. A
// `viewer` parameter is a query on a GET, not a write, so it is carried
// here now that an identity can be loaded; a key, a signature or a write
// this module does not hold. The writes live next door in write.ts
// (WEB_INTERFACE → "The write client is its own module beside the read
// client").
//
// Every read goes through `@dagsocial/node-reads`' `fetchJson` under its
// route's cap and `REQUEST_TIMEOUT_MS` deadline, and every answer is
// rebuilt from its own fields by a total reader of its route (`./readers`,
// WEB_INTERFACE → Reading a node's answer). A non-2xx is `ApiError` (a 404
// `null` where the read answers `null` today), a transport failure or a
// timeout `ApiError` with status `0`, and a 2xx that is over its cap, does
// not parse, or is not the route's answer is `PageError`.

export { ApiError, PageError };

export interface Page {
  /** The rows this page asks for — at most `PAGE_LIMIT_MAX`
   *  (TYPES_INTERFACE → HTTP view bounds). Every paged read names it, so
   *  the page the node serves is held to the rule
   *  (`@dagsocial/node-reads`' `parsePage`, WEB_INTERFACE → Reading a
   *  node's answer → "Every page is held to the page the node serves"). */
  limit: number;
  after?: string | null;
}

/** The reads the client offers — the seam the App depends on, so a test can
 *  drive it over a fake. Every call is a GET. `viewer` is the loaded
 *  identity's key, carried once one exists so `likedByViewer` is the node's
 *  answer (WEB_INTERFACE → "Every read carries the viewer's key once an
 *  identity is loaded, and none does before"). */
export interface Api {
  /** `light` adds `light=1` beside the list reads, so every row of every
   *  list of the answer is a `LightJson` or a `WithdrawnJson` (NODE_INTERFACE
   *  → Posts → "A light row is a post's id and the node's word",
   *  WEB_INTERFACE → The extension → "The light read"). A list read brings
   *  no bytes and is not checked (→ "The post check" → "A list read brings
   *  no bytes and is not checked"), so these reads take no `tx`. `withTx`
   *  rides the single post read's call alone — the only post read whose
   *  row the check runs over, read with `tx=1` where a verifier is held
   *  (→ "The post check"). */
  feed(page: Page, viewer?: string, author?: string, roots?: boolean, light?: boolean): Promise<FeedResult>;
  thread(id: string, page: Page, viewer?: string, light?: boolean): Promise<ThreadResult | null>;
  post(id: string, viewer?: string, withTx?: boolean): Promise<PostResult | null>;
  status(): Promise<StatusResult>;
  currentBlock(): Promise<BlockCurrent>;
  karma(key: string, page: Page): Promise<KarmaResult>;
  credits(key: string, page: Page): Promise<CreditsResult>;
  // The membership reads — GETs, none viewer-bearing (WEB_INTERFACE → The author
  // window, → The profile window). Keyset-paged like `karma`.
  vouchesByTarget(key: string, page: Page): Promise<VouchesTargetResult>;
  vouchesByVoucher(key: string, page: Page): Promise<VouchesVoucherResult>;
  vouchCooldowns(key: string, page: Page): Promise<VouchCooldownsResult>;
  bonds(key: string, page: Page): Promise<BondsResult>;
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

  /** Call `fetchJson` with the live `fetch`, so a `vi.stubGlobal('fetch', …)`
   *  takes effect per call. */
  private httpFetch: HttpFetch = (url, init) => fetch(url, init);

  /** The parsed body of a 2xx, or a throw: a non-2xx is `ApiError`, a
   *  transport failure or a timeout `ApiError` with status `0`, and a 2xx
   *  that is over its cap or does not parse is `PageError`. The returned
   *  body is the parsed `unknown` the route reader rebuilds (it may itself
   *  be the JSON `null`, which the reader refuses as the route's shape). */
  private async read(url: string, cap: number): Promise<unknown> {
    const r = await fetchJson<unknown>(this.httpFetch, url, cap);
    if (r.ok) return r.data;
    if (r.status >= 200 && r.status < 300) throw new PageError();
    throw new ApiError(r.status, r.body);
  }

  /** As `read`, except a 404 answers the `absent` arm of the result (the
   *  caller returns `null`), never thrown. A 2xx whose body is JSON `null`
   *  stays `{ absent: false, data: null }` so the route reader refuses the
   *  shape. */
  private async readMaybeAbsent(url: string, cap: number): Promise<{ absent: true } | { absent: false; data: unknown }> {
    const r = await fetchJson<unknown>(this.httpFetch, url, cap);
    if (r.ok) return { absent: false, data: r.data };
    if (r.status >= 200 && r.status < 300) throw new PageError();
    if (r.status === 404) return { absent: true };
    throw new ApiError(r.status, r.body);
  }

  /** Rebuild a parsed body as a `T`, or throw `PageError`. */
  private rebuild<T>(data: unknown, reader: (d: unknown) => T | null): T {
    const out = reader(data);
    if (out === null) throw new PageError();
    return out;
  }

  async feed(page: Page, viewer?: string, author?: string, roots?: boolean, light?: boolean): Promise<FeedResult> {
    // `author` filters to one identity's committed posts — the author-posts
    // window (WEB_INTERFACE → The author window); `roots=1` restricts to
    // posts with no parent, the feed's own read (WEB_INTERFACE → What the
    // feed reads). The node rejects `roots=0`, so it is 1 or absent
    // (NODE_INTERFACE → Posts). `light=1` takes the two list rows field by
    // field (WEB_INTERFACE → The extension → "The light read"); a list
    // read brings no bytes and is not checked (→ "The post check" → "A
    // list read brings no bytes and is not checked").
    const limit = askedLimit(page);
    const q: Record<string, string | number | undefined> = {
      limit,
      after: page.after ?? undefined,
      author,
      viewer,
      roots: roots ? 1 : undefined,
    };
    if (light) q['light'] = 1;
    const data = await this.read(this.url('/posts', q), FEED_PAGE_READ_BYTES);
    return this.rebuild(data, (d) => readFeedResult(d, limit, light === true));
  }

  async thread(id: string, page: Page, viewer?: string, light?: boolean): Promise<ThreadResult | null> {
    const limit = askedLimit(page);
    const q: Record<string, string | number | undefined> = {
      limit,
      after: page.after ?? undefined,
      viewer,
    };
    if (light) q['light'] = 1;
    const r = await this.readMaybeAbsent(
      this.url(`/posts/${encodeURIComponent(id)}/thread`, q),
      THREAD_READ_BYTES,
    );
    if (r.absent) return null;
    return this.rebuild(r.data, (d) => readThreadResult(d, limit, light === true));
  }

  async post(id: string, viewer?: string, withTx?: boolean): Promise<PostResult | null> {
    const r = await this.readMaybeAbsent(
      this.url(`/posts/${encodeURIComponent(id)}`, { viewer, tx: withTx ? 1 : undefined }),
      POST_READ_BYTES,
    );
    if (r.absent) return null;
    return this.rebuild(r.data, (d) => readPostResult(d, withTx === true));
  }

  async status(): Promise<StatusResult> {
    const data = await this.read(this.url('/status'), STATUS_READ_BYTES);
    return this.rebuild(data, readStatus);
  }

  async currentBlock(): Promise<BlockCurrent> {
    const data = await this.read(this.url('/blocks/current'), HEIGHT_READ_BYTES);
    return this.rebuild(data, readBlockCurrent);
  }

  // The spendable view's confirmed boxes, paged by `next`. No viewer — a balance
  // read is keyed by the identity in the path, not by a viewer query.
  async karma(key: string, page: Page): Promise<KarmaResult> {
    const limit = askedLimit(page);
    const data = await this.read(
      this.url(`/karma/${encodeURIComponent(key)}`, { limit, after: page.after ?? undefined }),
      LISTING_PAGE_READ_BYTES,
    );
    return this.rebuild(data, (d) => readKarmaResult(d, limit));
  }

  async credits(key: string, page: Page): Promise<CreditsResult> {
    const limit = askedLimit(page);
    const data = await this.read(
      this.url(`/credits/${encodeURIComponent(key)}`, { limit, after: page.after ?? undefined }),
      LISTING_PAGE_READ_BYTES,
    );
    return this.rebuild(data, (d) => readCreditsResult(d, limit));
  }

  async vouchesByTarget(key: string, page: Page): Promise<VouchesTargetResult> {
    const limit = askedLimit(page);
    const data = await this.read(
      this.url('/vouches', { target: key, limit, after: page.after ?? undefined }),
      VOUCH_PAGE_READ_BYTES,
    );
    return this.rebuild(data, (d) => readVouchesByTargetResult(d, limit));
  }

  async vouchesByVoucher(key: string, page: Page): Promise<VouchesVoucherResult> {
    const limit = askedLimit(page);
    const data = await this.read(
      this.url('/vouches', { voucher: key, limit, after: page.after ?? undefined }),
      VOUCH_PAGE_READ_BYTES,
    );
    return this.rebuild(data, (d) => readVouchesByVoucherResult(d, limit));
  }

  async vouchCooldowns(key: string, page: Page): Promise<VouchCooldownsResult> {
    const limit = askedLimit(page);
    const data = await this.read(
      this.url('/vouches', { voucher: key, cooldowns: 1, limit, after: page.after ?? undefined }),
      VOUCH_PAGE_READ_BYTES,
    );
    return this.rebuild(data, (d) => readVouchCooldownsResult(d, limit));
  }

  async bonds(key: string, page: Page): Promise<BondsResult> {
    const limit = askedLimit(page);
    const data = await this.read(
      this.url(`/invites/${encodeURIComponent(key)}`, { limit, after: page.after ?? undefined }),
      BOND_PAGE_READ_BYTES,
    );
    return this.rebuild(data, (d) => readBondsResult(d, limit));
  }

  async usernameByOwner(key: string): Promise<UsernameResult | null> {
    const r = await this.readMaybeAbsent(this.url('/usernames', { owner: key }), NAME_READ_BYTES);
    if (r.absent) return null;
    return this.rebuild(r.data, readUsername);
  }

  async usernameByName(name: string): Promise<UsernameResult | null> {
    const bare = name.startsWith('@') ? name.slice(1) : name;
    const r = await this.readMaybeAbsent(
      this.url(`/usernames/${encodeURIComponent(bare)}`),
      NAME_READ_BYTES,
    );
    if (r.absent) return null;
    return this.rebuild(r.data, readUsername);
  }
}
