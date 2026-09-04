import { NodeClient, type Api } from './api/client';
import type { PostJson, Tombstone, FeedRow, ThreadResult, KarmaResult } from './api/dto';
import { POST_PRICE_THREAD, POST_PRICE_REPLY } from '@dagsocial/types';
import { el, shortHex } from './dom';
import { contentHashHex } from './integrity';
import { prefs, setTheme, setIdTint, setNode, setFaucet, writeStore, KEY_LAYOUT, type Theme, type IdTint } from './prefs';
import { renderFeedInto } from './view/feed';
import { renderPanesInto, renderRegionElement } from './view/panes';
import { makeComposer, type ComposerController } from './view/composer';
import { serialise, parse } from './model/arrangement';
import { reconcileNewer, isLivePost } from './model/feed-reconcile';
import { flattenThread } from './model/thread';
import { WriteClient, type Rejection } from './api/write';
import { FaucetClient, faucetLine } from './api/faucet';
import { PendingLedger, reconcilePost, reconcileLike, reconcileGrant, pendingLikeTargets } from './wallet/ledger';
import type { PendingEntry } from './wallet/types';
import { readBuildContext } from './wallet/reads';
import { submitPostFlow, submitLikeFlow, type SubmitDeps, type Signer } from './wallet/submit';
import { identity as identitySingleton } from './identity/identity';
import { renderKarmaField } from './view/profile';
import {
  newWorkspace, openWindow, closeWindow, moveLeft, moveRight, moveBelow, focusWindow, openSet,
  type Origin, type Region,
} from './model/workspace';
import { FEED_COMPOSER_KEY, type AppState, type ThreadState, type RenderCtx, type Handlers, type Submission, type FlightStage, type AppIdentity } from './model/state';

const FEED_LIMIT = 30;
const THREAD_LIMIT = 50;
const REFRESH_PAGE_CAP = 40; // a refresh re-reads a whole thread; this bounds the loop
const POLL_MS = 15000;       // the bounded landing poll, only while own submissions are pending
const FEED_COMPOSER = FEED_COMPOSER_KEY;

const isWin = (k: string): boolean => k.charAt(0) === '@';
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const composerKey = (parentId: string | null): string => parentId ?? FEED_COMPOSER;
const isSettled = (stage: FlightStage): boolean => stage === 'landed' || stage === 'expired' || stage === 'rejected';

/** Hand the reader a file — an exported identity. A data: URL needs no object-URL
 *  lifecycle and works from a static bundle (WEB_INTERFACE → The profile window). */
function download(filename: string, text: string): void {
  const a = document.createElement('a');
  a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(text);
  a.download = filename;
  a.click();
}

// A rejection in the voice register — say what happened, never a status code
// (HOUSE_STYLE → Voice). A client-side refusal (status 0) already reads that way.
function postRejectionCopy(r: Rejection): string {
  if (r.status === 0) return r.message;
  if (r.status === 409) return 'that karma is still tied up in a post that has not landed.';
  if (r.status === 503) return 'the node is full right now.';
  if (/karma/i.test(r.message)) return 'not enough karma to post right now.';
  return 'the node said: ' + r.message.toLowerCase();
}

function likeRejectionCopy(r: Rejection): string {
  if (r.status === 0) return r.message;
  if (r.status === 409) return 'you have already liked this post';
  if (/karma/i.test(r.message)) return 'not enough karma';
  return r.message.toLowerCase();
}

export class App {
  private state: AppState;
  private client: Api;
  private writeClient: WriteClient;
  private identity: Signer;
  // The identity module the App drives — its own reference beside the wallet's
  // Signer seam (submit.ts), which stays the extension swap point.
  private idm: AppIdentity;
  private faucetClient: FaucetClient;
  private ledger: PendingLedger;
  private appbar!: HTMLElement;
  private feedEl!: HTMLElement;
  private panesEl!: HTMLElement;
  private handlers: Handlers;

  // Open composer widgets, held by key so the same element is re-parented across
  // a region rebuild rather than recreated (WEB_INTERFACE → The write surface).
  private composers = new Map<string, ComposerController>();
  // Targets the reader pressed like on, shown liked at once and reverted on a
  // rejection or expiry (WEB_INTERFACE → The wallet).
  private optimisticLikes = new Set<string>();
  private submitSeq = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastPolledHeight = 0;
  // The loaded key's /karma, read on the profile window's open and its ↻, and a
  // faucet grant in flight or one that lapsed — both feed the profile window's ctx.
  private profileKarma: KarmaResult | null = null;
  private grantView: { state: 'pending' } | { state: 'expired'; atHeight: number } | null = null;

  // Every dependency is injectable so a test can drive the App over fakes.
  constructor(client?: Api, writeClient?: WriteClient, identity?: Signer, ledger?: PendingLedger, idm?: AppIdentity) {
    this.client = client ?? new NodeClient(() => prefs.node);
    this.writeClient = writeClient ?? new WriteClient(() => prefs.node);
    this.identity = identity ?? identitySingleton;
    this.idm = idm ?? identitySingleton;
    this.faucetClient = new FaucetClient(() => prefs.faucet);
    // The ledger is for the identity loaded at construction; a change of identity
    // rebuilds it at once through onChange (WEB_INTERFACE → "An identity change
    // takes effect at once").
    this.ledger = ledger ?? new PendingLedger(this.identity.current()?.pubKeyHex ?? null);
    this.state = {
      feed: { posts: [], pending: [], next: null, report: null, olderReport: null, loaded: false, loading: false, error: null },
      threads: new Map(),
      workspace: newWorkspace(),
      status: null,
      posts: new Map(),
      submissions: [],
    };
    this.handlers = {
      openThread: (id, origin) => this.openThread(id, origin),
      refreshFeed: () => void this.refreshFeed(),
      loadOlder: () => void this.loadOlder(),
      openProfile: () => this.openProfile(),
      refreshProfile: () => void this.refreshProfileKarma(),
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
      setFaucet: (origin) => this.changeFaucet(origin),
      inspectFile: (text) => this.idm.inspectFile(text),
      draftIdentity: () => this.idm.draft(),
      createIdentity: async (p) => { await this.idm.create(p); },
      discardDraft: () => this.idm.discardDraft(),
      importIdentity: async (text, p) => { await this.idm.importFile(text, p); },
      exportIdentity: (p) => this.exportIdentity(p),
      forgetIdentity: () => this.idm.forget(),
      lockIdentity: () => this.idm.lock(),
      unlockIdentity: (p) => this.idm.unlock(p),
      askFaucet: () => void this.askFaucet(),
      openComposer: (parentId) => this.openComposer(parentId),
      likePost: (postId) => void this.likePost(postId),
      tryAgain: (localKey) => void this.tryAgain(localKey),
    };
  }

  /** The loaded identity's key, sent on every read once one exists and never
   *  before (WEB_INTERFACE → "Every read carries the viewer's key once an identity is loaded, and none does before"). */
  private viewer(): string | undefined {
    return this.identity.current()?.pubKeyHex ?? undefined;
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
    // An identity change takes effect at once (WEB_INTERFACE → The identity module).
    this.idm.onChange(() => this.onIdentityChange());
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
    const cur = this.identity.current();
    const likeTargets = pendingLikeTargets(this.ledger.all());
    return {
      openSet: openSet(this.state.workspace),
      thread: (id) => this.state.threads.get(id),
      post: (id) => this.state.posts.get(id),
      arrangement: serialise(this.state.workspace),
      writeEnabled: cur !== null,
      ownKey: cur?.pubKeyHex ?? null,
      composerFor: (parentId) => this.composers.get(composerKey(parentId))?.el ?? null,
      submissionsFor: (parentId) => this.state.submissions.filter((s) => s.parentId === parentId),
      likePending: (postId) => this.optimisticLikes.has(postId) || likeTargets.has(postId),
      // Profile window (WEB_INTERFACE → The profile window). identity carries the
      // lock state the header prefix does not need.
      identity: this.idm.current(),
      backedUp: this.idm.backedUp(),
      karma: this.profileKarma,
      grant: this.grantView,
      membershipBars: this.state.status?.membership ?? null,
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

    // The identity control — 'profile' with no identity, the key prefix in mono
    // with one (shortHex(pubKeyHex, 16), the card's own rule), so an identity reads
    // the same way in the header and on a card. No avatar, no identity colour
    // (WEB_INTERFACE → The profile window; HOUSE_STYLE → Identity colour).
    const cur = this.identity.current();
    const profile = el('button', 'theme-btn');
    profile.style.background = 'transparent';
    profile.style.color = 'var(--ink)';
    profile.style.border = '1px solid var(--borderStrong)';
    if (cur === null) {
      profile.textContent = 'profile';
    } else {
      profile.style.fontFamily = 'var(--mono)';
      profile.textContent = shortHex(cur.pubKeyHex, 16);
    }
    profile.setAttribute('aria-label', 'open profile');
    profile.addEventListener('click', () => this.openProfile());
    bar.appendChild(profile);

    // The theme control names and shows the theme it would switch TO
    // (HOUSE_STYLE → Colour).
    const target: Theme = prefs.theme === 'dark' ? 'light' : 'dark';
    const theme = el('button', 'theme-btn', target);
    theme.setAttribute('aria-label', `switch to ${target} theme`);
    theme.addEventListener('click', () => this.changeTheme(target));
    bar.appendChild(theme);
  }

  private renderFeed(): void {
    this.withComposerFocus(() => {
      const top = this.feedEl.scrollTop;
      renderFeedInto(this.feedEl, this.state.feed, this.handlers, this.ctx());
      this.feedEl.scrollTop = top;
    });
  }

  private renderPanes(): void {
    this.withComposerFocus(() => this.renderPanesBody());
  }

  private renderPanesBody(): void {
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
    this.withComposerFocus(() => this.renderRegionInPlace(uid));
  }

  private renderRegionInPlace(uid: number): void {
    const found = this.locateRegion(uid);
    if (!found) return;
    const oldEl = this.panesEl.querySelector<HTMLElement>(`.region[data-uid="${uid}"]`);
    if (!oldEl) {
      this.renderPanesBody();
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
      const res = await this.client.feed({ limit: FEED_LIMIT }, this.viewer());
      feed.posts = res.posts.filter(isLivePost);
      feed.pending = this.dedupeOwn(res.pending.filter(isLivePost));
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
    this.clearSettledFeed();
    try {
      // The reconnection paging lives in reconcileNewer; this fetches each page
      // and takes the mempool from page 0 (the only call with a null cursor).
      const r = await reconcileNewer(
        feed.posts,
        async (after) => {
          const res = await this.client.feed(after === null ? { limit: FEED_LIMIT } : { limit: FEED_LIMIT, after }, this.viewer());
          this.indexRows([...res.posts, ...res.pending]);
          if (after === null) feed.pending = this.dedupeOwn(res.pending.filter(isLivePost));
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
      const res = await this.client.feed({ limit: FEED_LIMIT, after: feed.next }, this.viewer());
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

  private openProfile(): void {
    const res = openWindow(this.state.workspace, '@profile', { from: 'feed' });
    this.saveLayout();
    if (res.raised) {
      this.renderRegion(res.region.uid);
    } else {
      this.renderPanes();
      // Read /karma for the loaded key when the window opens (WEB_INTERFACE → The
      // profile window); a raise just brings the existing window forward.
      void this.refreshProfileKarma();
    }
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
      const res = await this.client.thread(id, { limit: THREAD_LIMIT }, this.viewer());
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
    this.clearSettledThread(id);
    try {
      let res = await this.client.thread(id, { limit: THREAD_LIMIT }, this.viewer());
      if (res === null) {
        t.root = null;
        if (region) region.report = null;
      } else {
        const all: FeedRow[] = [...res.descendants];
        let next = res.next;
        let pages = 1;
        while (next !== null && pages < REFRESH_PAGE_CAP) {
          const more = await this.client.thread(id, { limit: THREAD_LIMIT, after: next }, this.viewer());
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
      const res = await this.client.thread(id, { limit: THREAD_LIMIT, after: t.next }, this.viewer());
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
    this.renderRegionsFor('@profile');
  }

  private changeIdTint(m: IdTint): void {
    setIdTint(m); // the bars follow the CSS custom properties — no re-render needed
    this.renderRegionsFor('@profile');
  }

  private async changeNode(origin: string): Promise<void> {
    setNode(origin);
    // Everything loaded came from the old node; drop it and re-read.
    this.state.threads.clear();
    this.state.posts.clear();
    this.renderRegionsFor('@profile');
    this.renderPanes();
    await this.loadFeed();
    for (const id of openSet(this.state.workspace)) if (!isWin(id)) void this.fetchThread(id);
  }

  private changeFaucet(origin: string): void {
    setFaucet(origin);
    this.renderRegionsFor('@profile'); // the faucet row shows the new base, the step its availability
  }

  // -------------------------------------------------------------------------
  // Identity — the profile window's operations, the /karma read, the faucet step
  // (WEB_INTERFACE → The profile window, → The faucet step).
  // -------------------------------------------------------------------------

  /** An identity change (create, import, forget) takes effect at once: a fresh
   *  ledger for the new key, the old key's poll and optimistic likes dropped, and
   *  every open surface re-read with the new viewer (WEB_INTERFACE → "An identity
   *  change takes effect at once"). */
  private onIdentityChange(): void {
    this.stopPoll();
    this.optimisticLikes.clear();
    this.state.submissions = [];
    this.lastPolledHeight = 0;
    this.profileKarma = null;
    this.grantView = null;
    this.ledger = new PendingLedger(this.identity.current()?.pubKeyHex ?? null);
    this.renderHeader();
    this.renderPanes();
    void this.loadFeed();
    for (const id of openSet(this.state.workspace)) if (!isWin(id)) void this.fetchThread(id);
    if (this.identity.current() !== null) void this.refreshProfileKarma();
  }

  /** A fresh sealed file for the reader to keep. Needs the seed, so the profile
   *  unlocks first; the backup line then clears (WEB_INTERFACE → The profile window). */
  private async exportIdentity(password: string): Promise<void> {
    const text = await this.idm.exportFile(password);
    const cur = this.idm.current();
    download(`notis-identity-${cur ? cur.pubKeyHex.slice(0, 8) : 'key'}.json`, text);
    this.renderRegionsFor('@profile'); // export fires no onChange; re-render clears the backup line
  }

  /** Read the loaded key's /karma for the profile window — on open and on the
   *  window's ↻ (WEB_INTERFACE → The profile window). */
  private async refreshProfileKarma(): Promise<void> {
    const cur = this.identity.current();
    if (cur === null) return;
    try {
      this.profileKarma = await this.client.karma(cur.pubKeyHex);
    } catch {
      return; // a failed read leaves the last-known karma; the ↻ retries
    }
    this.renderProfileKarma();
  }

  /** Ask the faucet — a 202 rides the bounded poll as a grant entry; a rejection is
   *  one register line (WEB_INTERFACE → The faucet step). The request carries only
   *  the public key, so a locked identity can ask. */
  private async askFaucet(): Promise<void> {
    const cur = this.identity.current();
    if (cur === null) return;
    const res = await this.faucetClient.askKarma(cur.pubKeyHex);
    if ('message' in res) {
      const region = this.regionFocusedOn('@profile');
      if (region) {
        region.report = faucetLine(res);
        this.renderRegion(region.uid);
      }
      return;
    }
    const entry: PendingEntry = {
      txId: res.txId,
      kind: 'grant',
      postId: cur.pubKeyHex, // the key the grant was asked for; a grant has no post
      inputs: [],
      expiresAtHeight: res.expiresAtHeight,
      submittedAtHeight: this.lastPolledHeight,
    };
    this.ledger.add(entry);
    this.grantView = { state: 'pending' };
    this.startPoll();
    this.renderProfileKarma();
  }

  /** Reconcile a grant against /karma: landed when a box appears, expired past its
   *  height while still zero (WEB_INTERFACE → The faucet step). The karma field
   *  updates in place — colour and text in a fixed box (HOUSE_STYLE → Motion). */
  private async reconcileGrantEntry(entry: PendingEntry, tip: number): Promise<void> {
    let karma;
    try {
      karma = await this.client.karma(entry.postId);
    } catch {
      return; // a failed read keeps the entry; the next tick retries
    }
    const outcome = reconcileGrant(entry, karma, tip);
    if (outcome === 'pending') return;
    this.ledger.remove(entry.txId);
    if (outcome === 'landed') {
      this.profileKarma = karma;
      this.grantView = null;
    } else {
      this.grantView = { state: 'expired', atHeight: entry.expiresAtHeight };
    }
    this.renderProfileKarma();
  }

  /** Rebuild the profile window's karma field in place from the current ctx. */
  private renderProfileKarma(): void {
    const field = document.querySelector<HTMLElement>('.karma-field');
    if (field) renderKarmaField(field, this.handlers, this.ctx());
  }

  // -------------------------------------------------------------------------
  // Write surface — the composer, submissions, like, and the bounded poll. All
  // inert with no identity loaded (WEB_INTERFACE → The write surface).
  // -------------------------------------------------------------------------

  private submitDeps(): SubmitDeps {
    return { reads: this.client, write: this.writeClient, ledger: this.ledger, identity: this.identity };
  }

  private openComposer(parentId: string | null): void {
    if (this.identity.current() === null) return;
    const key = composerKey(parentId);
    const open = this.composers.get(key);
    if (open) {
      open.focus();
      return;
    }
    const isReply = parentId !== null;
    const price = isReply ? Number(POST_PRICE_REPLY) : Number(POST_PRICE_THREAD);
    const ctrl = makeComposer({
      isReply,
      price,
      depth: isReply ? this.replyDepth(parentId) : 0,
      onSubmit: (text) => void this.submitComposer(parentId, text),
      onClose: () => this.closeComposer(parentId),
    });
    this.composers.set(key, ctrl);
    this.renderForParent(parentId);
    ctrl.focus();
    // Affordability is read once when the composer opens (WEB_INTERFACE →
    // "Affordability is known before the attempt").
    void this.readAffordability(key, BigInt(price));
  }

  private async readAffordability(key: string, price: bigint): Promise<void> {
    const cur = this.identity.current();
    if (cur === null) return;
    try {
      const ctx = await readBuildContext(this.client, this.ledger, cur.pubKeyHex);
      const total = ctx.spendable.reduce((sum, b) => sum + b.value, 0n);
      this.composers.get(key)?.setAffordable(total >= price);
    } catch {
      // The spendable view could not be read; the foot says so and post stays
      // disabled, rather than a disabled button with no reason.
      this.composers.get(key)?.setKarmaError("can't read your karma right now");
    }
  }

  private closeComposer(parentId: string | null): void {
    this.composers.delete(composerKey(parentId));
    this.renderForParent(parentId);
    this.focusOpener(parentId);
  }

  private async submitComposer(parentId: string | null, text: string): Promise<void> {
    const cur = this.identity.current();
    if (cur === null) return;
    // Collapse the composer into the hollow card in the same slot at once.
    this.composers.delete(composerKey(parentId));
    const submission: Submission = {
      localKey: 'local-' + ++this.submitSeq,
      content: text,
      parentId,
      author: cur.pubKeyHex,
      contentHash: contentHashHex(text),
      stage: 'submitting',
      txId: null,
      postId: null,
      blockHeight: null,
      expiresAtHeight: null,
      reason: null,
    };
    this.state.submissions.push(submission);
    this.renderForParent(parentId);
    this.focusOpener(parentId);
    await this.flight(submission, () => submitPostFlow(this.submitDeps(), text, parentId));
  }

  private async tryAgain(localKey: string): Promise<void> {
    const sub = this.state.submissions.find((s) => s.localKey === localKey);
    if (!sub || sub.stage !== 'expired') return;
    // A fresh transaction from the current spendable view — the old one left the
    // mempool and its inputs may have moved.
    sub.stage = 'submitting';
    sub.reason = null;
    sub.txId = null;
    sub.postId = null;
    sub.expiresAtHeight = null;
    sub.blockHeight = null;
    this.renderForParent(sub.parentId);
    await this.flight(sub, () => submitPostFlow(this.submitDeps(), sub.content, sub.parentId));
  }

  /** Drive a submission's flight: submitted on a 2xx, rejected otherwise. */
  private async flight(
    sub: Submission,
    run: () => Promise<{ ok: true; entry: { txId: string; postId: string; expiresAtHeight: number } } | { ok: false; rejection: Rejection }>,
  ): Promise<void> {
    let result;
    try {
      result = await run();
    } catch {
      // A transport failure is an ending, not a stuck 'submitting' (WEB_INTERFACE →
      // The wallet: every flight ends in one of the three endings).
      sub.stage = 'rejected';
      sub.reason = "can't reach the node right now.";
      this.renderForParent(sub.parentId);
      return;
    }
    if (result.ok) {
      sub.stage = 'submitted';
      sub.txId = result.entry.txId;
      sub.postId = result.entry.postId;
      sub.expiresAtHeight = result.entry.expiresAtHeight;
      this.startPoll();
    } else {
      sub.stage = 'rejected';
      sub.reason = postRejectionCopy(result.rejection);
    }
    this.renderForParent(sub.parentId);
  }

  private async likePost(postId: string): Promise<void> {
    const cur = this.identity.current();
    if (cur === null || this.optimisticLikes.has(postId)) return;
    // The reader did it — show liked and move the count at once (WEB_INTERFACE →
    // The wallet). A number that moves in direct response to the reader's own
    // click is not the ticking readout the motion contract bans.
    this.optimisticLikes.add(postId);
    this.renderRegionsForPost(postId);
    let result;
    try {
      result = await submitLikeFlow(this.submitDeps(), postId);
    } catch {
      // A transport failure leaves no like optimistic — the reader is told and
      // the control returns to `like`.
      this.optimisticLikes.delete(postId);
      this.setReportForPost(postId, "like rejected: can't reach the node right now.");
      this.renderRegionsForPost(postId);
      return;
    }
    if (result.ok) {
      this.startPoll();
    } else {
      this.optimisticLikes.delete(postId);
      this.setReportForPost(postId, 'like rejected: ' + likeRejectionCopy(result.rejection));
    }
    this.renderRegionsForPost(postId);
  }

  // ---- the bounded landing poll (WEB_INTERFACE → The wallet) ----

  private startPoll(): void {
    if (this.pollTimer !== null || this.ledger.size === 0) return;
    this.pollTimer = setInterval(() => void this.pollTick(), POLL_MS);
  }

  private stopPoll(): void {
    if (this.pollTimer === null) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async pollTick(): Promise<void> {
    // Runs only while the client's own submissions are pending, and stops at zero.
    if (this.ledger.size === 0) {
      this.stopPoll();
      return;
    }
    try {
      const block = await this.client.currentBlock();
      if (block.height !== this.lastPolledHeight) {
        this.lastPolledHeight = block.height; // reconcile only when the height moves
        await this.reconcile(block.height);
      }
    } catch {
      // A failed read keeps the cadence rather than an unhandled rejection every
      // interval; the next tick retries.
      return;
    }
    if (this.ledger.size === 0) this.stopPoll();
  }

  /** Reconcile the ledger's entries against the node and nothing else — no feed,
   *  no thread, no injected row (WEB_INTERFACE → The wallet). Only the surfaces
   *  holding a settled entry are re-rendered: the one unsolicited update may not
   *  replace the DOM of a surface it does not touch, or a selection and a parked
   *  pointer are lost even where the pixels match. */
  private async reconcile(tip: number): Promise<void> {
    let feedTouched = false;
    const touchedPosts = new Set<string>();
    for (const entry of this.ledger.all()) {
      if (entry.kind === 'grant') {
        await this.reconcileGrantEntry(entry, tip);
        continue;
      }
      const fetched = await this.client.post(entry.postId, this.viewer());
      if (entry.kind === 'post') {
        const outcome = reconcilePost(entry, fetched, tip);
        if (outcome === 'pending') continue;
        const sub = this.state.submissions.find((s) => s.txId === entry.txId);
        if (sub) {
          sub.stage = outcome;
          if (outcome === 'landed' && fetched !== null && !('kind' in fetched)) sub.blockHeight = fetched.blockHeight;
          if (sub.parentId === null) feedTouched = true;
          else touchedPosts.add(sub.parentId);
        }
        this.ledger.remove(entry.txId);
      } else {
        const outcome = reconcileLike(entry, fetched, tip);
        if (outcome === 'pending') continue;
        this.optimisticLikes.delete(entry.postId);
        this.ledger.remove(entry.txId);
        if (outcome === 'expired') this.setReportForPost(entry.postId, 'a like expired before any block took it');
        touchedPosts.add(entry.postId);
      }
    }
    // A landed card changes colour and nothing else; the geometry is identical.
    if (feedTouched) this.renderFeed();
    this.renderRegionsForPosts(touchedPosts);
  }

  // ---- placement, focus and reports for the write surface ----

  private renderForParent(parentId: string | null): void {
    if (parentId === null) this.renderFeed();
    else this.renderRegionsForPost(parentId);
  }

  private renderRegionsForPost(postId: string): void {
    this.renderRegionsForPosts(new Set([postId]));
  }

  /** Re-render only the regions whose focused thread contains one of the posts —
   *  every other region survives by reference. */
  private renderRegionsForPosts(postIds: Set<string>): void {
    if (postIds.size === 0) return;
    const wanted = [...postIds];
    for (const col of this.state.workspace.columns) {
      for (const region of col.regions) {
        const fk = region.wins[region.focus];
        if (fk !== undefined && !isWin(fk) && wanted.some((p) => this.threadContains(fk, p))) {
          this.renderRegion(region.uid);
        }
      }
    }
  }

  private focusOpener(parentId: string | null): void {
    document.querySelector<HTMLElement>(`[data-composer-open="${composerKey(parentId)}"]`)?.focus();
  }

  private withComposerFocus(fn: () => void): void {
    const key = this.focusedComposerKey();
    fn();
    if (key !== null) this.composers.get(key)?.focus();
  }

  private focusedComposerKey(): string | null {
    const active = document.activeElement;
    if (active === null) return null;
    for (const [key, ctrl] of this.composers) if (ctrl.el.contains(active)) return key;
    return null;
  }

  private replyDepth(parentId: string): number {
    for (const t of this.state.threads.values()) {
      if (!t.root) continue;
      for (const node of flattenThread(t.root, t.descendants)) {
        if (node.row.id === parentId) return Math.min(node.depth + 1, 3);
      }
    }
    return 1;
  }

  private ownPostIds(): Set<string> {
    const s = new Set<string>();
    for (const e of this.ledger.all()) if (e.kind === 'post') s.add(e.postId);
    for (const sub of this.state.submissions) if (sub.postId !== null) s.add(sub.postId);
    return s;
  }

  private dedupeOwn(rows: PostJson[]): PostJson[] {
    const own = this.ownPostIds();
    return rows.filter((r) => !own.has(r.id));
  }

  private clearSettledFeed(): void {
    this.state.submissions = this.state.submissions.filter((s) => !(s.parentId === null && isSettled(s.stage)));
  }

  private clearSettledThread(threadId: string): void {
    this.state.submissions = this.state.submissions.filter(
      (s) => !(s.parentId !== null && isSettled(s.stage) && this.threadContains(threadId, s.parentId)),
    );
  }

  private setReportForPost(postId: string, text: string): void {
    for (const col of this.state.workspace.columns) {
      for (const region of col.regions) {
        const fk = region.wins[region.focus];
        if (fk !== undefined && !isWin(fk) && this.threadContains(fk, postId)) region.report = text;
      }
    }
  }

  private threadContains(threadId: string, postId: string): boolean {
    if (threadId === postId) return true;
    const t = this.state.threads.get(threadId);
    if (!t || !t.root) return false;
    return flattenThread(t.root, t.descendants).some((n) => n.row.id === postId);
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
