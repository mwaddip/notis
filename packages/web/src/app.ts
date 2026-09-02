import { NodeClient, type Api } from './api/client';
import type { PostJson, Tombstone, FeedRow, ThreadResult } from './api/dto';
import { el } from './dom';
import { prefs, setTheme, setIdTint, setNode, writeStore, KEY_LAYOUT, type Theme, type IdTint } from './prefs';
import { renderFeedInto } from './view/feed';
import { renderPanesInto, renderRegionElement } from './view/panes';
import { serialise, parse } from './model/arrangement';
import { reconcileNewer, isLivePost } from './model/feed-reconcile';
import {
  newWorkspace, openWindow, closeWindow, moveLeft, moveRight, moveBelow, focusWindow, openSet,
  type Origin, type Region,
} from './model/workspace';
import type { AppState, ThreadState, RenderCtx, Handlers } from './model/state';

const FEED_LIMIT = 30;
const THREAD_LIMIT = 50;
const REFRESH_PAGE_CAP = 40; // a refresh re-reads a whole thread; this bounds the loop

const isWin = (k: string): boolean => k.charAt(0) === '@';
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class App {
  private state: AppState;
  private client: Api;
  private appbar!: HTMLElement;
  private feedEl!: HTMLElement;
  private panesEl!: HTMLElement;
  private handlers: Handlers;

  // The client is injectable so a test can drive the App over a fake API.
  constructor(client?: Api) {
    this.client = client ?? new NodeClient(() => prefs.node);
    this.state = {
      feed: { posts: [], pending: [], next: null, report: null, olderReport: null, loaded: false, loading: false, error: null },
      threads: new Map(),
      workspace: newWorkspace(),
      status: null,
      posts: new Map(),
    };
    this.handlers = {
      openThread: (id, origin) => this.openThread(id, origin),
      refreshFeed: () => void this.refreshFeed(),
      loadOlder: () => void this.loadOlder(),
      openSettings: () => this.openSettings(),
      focus: (id) => this.focus(id),
      refreshThread: (id) => void this.refreshThread(id),
      threadMore: (id) => void this.threadMore(id),
      moveLeft: (id) => this.structural(() => moveLeft(this.state.workspace, id)),
      moveRight: (id) => this.structural(() => moveRight(this.state.workspace, id)),
      moveBelow: (id) => this.structural(() => moveBelow(this.state.workspace, id)),
      close: (id) => this.closeWindow(id),
      setTheme: (t) => this.changeTheme(t),
      setIdTint: (m) => this.changeIdTint(m),
      setNode: (origin) => void this.changeNode(origin),
    };
  }

  // -------------------------------------------------------------------------
  // Mount + boot
  // -------------------------------------------------------------------------

  // Set the DOM refs and paint the initial shell. Split from `start` so a test
  // can mount and drive actions without the network boot.
  mount(appbar: HTMLElement, feedEl: HTMLElement, panesEl: HTMLElement): void {
    this.appbar = appbar;
    this.feedEl = feedEl;
    this.panesEl = panesEl;
    this.restoreLayout();
    this.renderHeader();
    this.renderFeed();
    this.renderPanes();
  }

  start(appbar: HTMLElement, feedEl: HTMLElement, panesEl: HTMLElement): void {
    this.mount(appbar, feedEl, panesEl);
    this.suppressHoverWhileScrolling();

    void this.loadFeed();
    // A restored arrangement names post ids that must be fetched, and one may
    // have been pruned since — its window renders the tombstone, not an error.
    for (const id of openSet(this.state.workspace)) if (!isWin(id)) void this.fetchThread(id);
  }

  private restoreLayout(): void {
    const stored = (() => {
      try {
        return localStorage.getItem(KEY_LAYOUT);
      } catch {
        return null;
      }
    })();
    if (stored) this.state.workspace = parse(stored);
  }

  private saveLayout(): void {
    writeStore(KEY_LAYOUT, serialise(this.state.workspace));
  }

  // -------------------------------------------------------------------------
  // Render orchestration — per surface, so one action never tears down another:
  // a thread refresh leaves the feed and every other region untouched.
  // -------------------------------------------------------------------------

  private ctx(): RenderCtx {
    return {
      openSet: openSet(this.state.workspace),
      thread: (id) => this.state.threads.get(id),
      post: (id) => this.state.posts.get(id),
      arrangement: serialise(this.state.workspace),
    };
  }

  private renderHeader(): void {
    const bar = this.appbar;
    bar.textContent = '';
    // The mark + wordmark lockup. The mark is the micro tier — abstract at 24px
    // — so the wordmark stays to name it; together they are the standard mark.
    // <use> resolves against the sprite inlined in index.html.
    const brand = el('div', 'brand');
    brand.innerHTML = '<svg class="mark" viewBox="0 0 1000 1000" aria-hidden="true"><use href="#mark-micro"></use></svg>';
    brand.appendChild(el('h1', null, 'Notis'));
    bar.appendChild(brand);
    bar.appendChild(el('span', 'spacer'));

    const settings = el('button', 'theme-btn');
    settings.style.background = 'transparent';
    settings.style.color = 'var(--ink)';
    settings.style.border = '1px solid var(--borderStrong)';
    settings.textContent = 'settings';
    settings.setAttribute('aria-label', 'open settings');
    settings.addEventListener('click', () => this.openSettings());
    bar.appendChild(settings);

    // The theme control names and shows the theme it would switch TO
    // (HOUSE_STYLE → Colour).
    const target: Theme = prefs.theme === 'dark' ? 'light' : 'dark';
    const theme = el('button', 'theme-btn', target);
    theme.setAttribute('aria-label', `switch to ${target} theme`);
    theme.addEventListener('click', () => this.changeTheme(target));
    bar.appendChild(theme);
  }

  private renderFeed(): void {
    const top = this.feedEl.scrollTop;
    renderFeedInto(this.feedEl, this.state.feed, this.handlers, this.ctx());
    this.feedEl.scrollTop = top;
  }

  private renderPanes(): void {
    // Preserve every region body's scroll across a structural rebuild, keyed by
    // the region uid.
    const scrolls = new Map<string, number>();
    this.panesEl.querySelectorAll<HTMLElement>('.region').forEach((r) => {
      const uid = r.dataset['uid'];
      const body = r.querySelector<HTMLElement>('.region-body');
      if (uid && body) scrolls.set(uid, body.scrollTop);
    });
    renderPanesInto(this.panesEl, this.state.workspace, this.handlers, this.ctx());
    this.panesEl.querySelectorAll<HTMLElement>('.region').forEach((r) => {
      const uid = r.dataset['uid'];
      const body = r.querySelector<HTMLElement>('.region-body');
      const top = uid ? scrolls.get(uid) : undefined;
      if (body && top != null) body.scrollTop = top;
    });
  }

  private locateRegion(uid: number): { region: Region; ci: number } | null {
    const ws = this.state.workspace;
    for (let ci = 0; ci < ws.columns.length; ci++) {
      for (const region of ws.columns[ci]!.regions) {
        if (region.uid === uid) return { region, ci };
      }
    }
    return null;
  }

  /** Rebuild one region in place, preserving its body scroll — the feed and
   *  every other region are untouched, so their scroll and any text selection
   *  in them survive. */
  private renderRegion(uid: number): void {
    const found = this.locateRegion(uid);
    if (!found) return;
    const oldEl = this.panesEl.querySelector<HTMLElement>(`.region[data-uid="${uid}"]`);
    if (!oldEl) {
      this.renderPanes();
      return;
    }
    const top = oldEl.querySelector<HTMLElement>('.region-body')?.scrollTop ?? 0;
    const newEl = renderRegionElement(found.region, found.ci, this.handlers, this.ctx());
    oldEl.replaceWith(newEl);
    const newBody = newEl.querySelector<HTMLElement>('.region-body');
    if (newBody) newBody.scrollTop = top;
  }

  /** Re-render every region currently focused on a given window. */
  private renderRegionsFor(windowId: string): void {
    for (const col of this.state.workspace.columns) {
      for (const region of col.regions) {
        if (region.wins[region.focus] === windowId) this.renderRegion(region.uid);
      }
    }
  }

  private structural(mutate: () => void): void {
    mutate();
    this.saveLayout();
    this.renderPanes();
  }

  // -------------------------------------------------------------------------
  // Post index — for a feed reply's one-line parent reference
  // -------------------------------------------------------------------------

  private indexRows(rows: Array<PostJson | Tombstone | null>): void {
    for (const row of rows) {
      if (row && !('kind' in row)) this.state.posts.set(row.id, row);
    }
  }

  // -------------------------------------------------------------------------
  // Feed actions
  // -------------------------------------------------------------------------

  private async loadFeed(): Promise<void> {
    const feed = this.state.feed;
    feed.loading = true;
    feed.error = null;
    this.renderFeed();
    try {
      const res = await this.client.feed({ limit: FEED_LIMIT });
      feed.posts = res.posts.filter(isLivePost);
      feed.pending = res.pending.filter(isLivePost);
      feed.next = res.next;
      feed.loaded = true;
      feed.loading = false;
      this.indexRows([...res.posts, ...res.pending]);
    } catch (e) {
      feed.loading = false;
      feed.error = msg(e);
    }
    this.renderFeed();
  }

  private async refreshFeed(): Promise<void> {
    const feed = this.state.feed;
    try {
      // The reconnection paging lives in reconcileNewer; this fetches each page
      // and takes the mempool from page 0 (the only call with a null cursor).
      const r = await reconcileNewer(
        feed.posts,
        async (after) => {
          const res = await this.client.feed(after === null ? { limit: FEED_LIMIT } : { limit: FEED_LIMIT, after });
          this.indexRows([...res.posts, ...res.pending]);
          if (after === null) feed.pending = res.pending.filter(isLivePost);
          return { posts: res.posts, next: res.next };
        },
        REFRESH_PAGE_CAP,
      );
      feed.posts = r.posts;
      if (r.next !== undefined) feed.next = r.next; // reset only on the replace branch
      feed.report = r.newCount ? `${r.newCount} new ${r.newCount === 1 ? 'post' : 'posts'}` : 'no new posts';
      feed.error = null;
    } catch (e) {
      feed.error = msg(e);
    }
    this.renderFeed();
  }

  private async loadOlder(): Promise<void> {
    const feed = this.state.feed;
    if (feed.next === null) return;
    feed.loading = true;
    this.renderFeed();
    try {
      const res = await this.client.feed({ limit: FEED_LIMIT, after: feed.next });
      const older = res.posts.filter(isLivePost);
      const have = new Set(feed.posts.map((p) => p.id));
      const added = older.filter((p) => !have.has(p.id));
      feed.posts = [...feed.posts, ...added];
      feed.next = res.next;
      feed.olderReport = added.length ? `${added.length} older ${added.length === 1 ? 'post' : 'posts'}` : 'no older posts';
      this.indexRows(res.posts);
    } catch (e) {
      feed.error = msg(e);
    }
    feed.loading = false;
    this.renderFeed();
  }

  // -------------------------------------------------------------------------
  // Window / workspace actions
  // -------------------------------------------------------------------------

  private openThread(id: string, origin: Origin): void {
    const res = openWindow(this.state.workspace, id, origin);
    this.saveLayout();
    if (res.raised) {
      this.renderRegion(res.region.uid);
      return;
    }
    // A new window changed the structure, and the feed card flips to open.
    this.renderPanes();
    this.renderFeed();
    if (!isWin(id) && !this.threadLoaded(id)) void this.fetchThread(id);
  }

  private openSettings(): void {
    const res = openWindow(this.state.workspace, '@settings', { from: 'feed' });
    this.saveLayout();
    if (res.raised) this.renderRegion(res.region.uid);
    else this.renderPanes();
  }

  private focus(id: string): void {
    const region = focusWindow(this.state.workspace, id);
    if (region) this.renderRegion(region.uid);
    if (!isWin(id) && !this.threadLoaded(id)) void this.fetchThread(id);
  }

  private closeWindow(id: string): void {
    closeWindow(this.state.workspace, id);
    this.saveLayout();
    this.renderPanes();
    this.renderFeed(); // a closed thread un-fades its feed card
  }

  private threadLoaded(id: string): boolean {
    const t = this.state.threads.get(id);
    return !!t && !t.loading && t.error === null;
  }

  private ensureThreadState(id: string): ThreadState {
    let t = this.state.threads.get(id);
    if (!t) {
      t = { id, root: null, ancestorIds: new Set(), descendants: [], descendantCount: 0, next: null, report: null, loading: false, error: null };
      this.state.threads.set(id, t);
    }
    return t;
  }

  private applyThread(t: ThreadState, res: ThreadResult): void {
    t.root = res.post;
    t.ancestorIds = new Set(res.ancestors.map((a) => a.id));
    t.descendants = res.descendants;
    t.descendantCount = res.descendantCount;
    t.next = res.next;
    t.error = null;
    this.indexRows([res.post, ...res.ancestors, ...res.descendants, ...res.pending]);
  }

  private async fetchThread(id: string): Promise<void> {
    const t = this.ensureThreadState(id);
    t.loading = true;
    t.error = null;
    this.renderRegionsFor(id);
    try {
      const res = await this.client.thread(id, { limit: THREAD_LIMIT });
      if (res === null) {
        t.root = null; // 404 — the post is gone; the body says so, it is not an error
      } else {
        this.applyThread(t, res);
      }
    } catch (e) {
      t.error = msg(e);
    }
    t.loading = false;
    this.renderRegionsFor(id);
  }

  /** Refresh re-reads the whole thread — descendants load oldest-first, so new
   *  replies are the newest and would otherwise sit past the last loaded page.
   *  It reports the change in reply count. */
  private async refreshThread(id: string): Promise<void> {
    const t = this.state.threads.get(id);
    if (!t) return;
    const before = t.descendantCount;
    const region = this.regionFocusedOn(id);
    try {
      let res = await this.client.thread(id, { limit: THREAD_LIMIT });
      if (res === null) {
        t.root = null;
        if (region) region.report = null;
      } else {
        const all: FeedRow[] = [...res.descendants];
        let next = res.next;
        let pages = 1;
        while (next !== null && pages < REFRESH_PAGE_CAP) {
          const more = await this.client.thread(id, { limit: THREAD_LIMIT, after: next });
          if (more === null) break;
          all.push(...more.descendants);
          next = more.next;
          res = more;
          pages++;
        }
        t.root = res.post;
        t.ancestorIds = new Set(res.ancestors.map((a) => a.id));
        t.descendants = all;
        t.descendantCount = res.descendantCount;
        t.next = next; // null once fully read; set only if the page cap was hit
        t.error = null;
        this.indexRows([res.post, ...all]);
        const delta = t.descendantCount - before;
        if (region) region.report = delta > 0 ? `${delta} new ${delta === 1 ? 'reply' : 'replies'}` : 'no new replies';
      }
    } catch (e) {
      t.error = msg(e);
    }
    this.renderRegionsFor(id);
  }

  private async threadMore(id: string): Promise<void> {
    const t = this.state.threads.get(id);
    if (!t || t.next === null) return;
    try {
      const res = await this.client.thread(id, { limit: THREAD_LIMIT, after: t.next });
      if (res !== null) {
        const have = new Set(t.descendants.map((d) => d.id));
        const added = res.descendants.filter((d) => !have.has(d.id));
        t.descendants = [...t.descendants, ...added];
        t.next = res.next;
        t.descendantCount = res.descendantCount;
        this.indexRows(added);
      }
    } catch (e) {
      t.error = msg(e);
    }
    this.renderRegionsFor(id);
  }

  private regionFocusedOn(id: string): Region | null {
    for (const col of this.state.workspace.columns) {
      for (const region of col.regions) if (region.wins[region.focus] === id) return region;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Settings actions
  // -------------------------------------------------------------------------

  private changeTheme(t: Theme): void {
    setTheme(t);
    this.renderHeader();
    this.renderRegionsFor('@settings');
  }

  private changeIdTint(m: IdTint): void {
    setIdTint(m); // the bars follow the CSS custom properties — no re-render needed
    this.renderRegionsFor('@settings');
  }

  private async changeNode(origin: string): Promise<void> {
    setNode(origin);
    // Everything loaded came from the old node; drop it and re-read.
    this.state.threads.clear();
    this.state.posts.clear();
    this.renderRegionsFor('@settings');
    this.renderPanes();
    await this.loadFeed();
    for (const id of openSet(this.state.workspace)) if (!isWin(id)) void this.fetchThread(id);
  }

  // -------------------------------------------------------------------------
  // Interaction: hover is suppressed while scrolling and ~100ms after
  // (HOUSE_STYLE → Interaction).
  // -------------------------------------------------------------------------

  private suppressHoverWhileScrolling(): void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    for (const node of [this.feedEl, this.panesEl]) {
      node.addEventListener(
        'scroll',
        () => {
          node.classList.add('scrolling');
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            for (const x of document.querySelectorAll('.scrolling')) x.classList.remove('scrolling');
          }, 100);
        },
        { passive: true },
      );
    }
  }
}
