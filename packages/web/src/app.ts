import { NodeClient, type Api } from './api/client';
import type { PostJson, Tombstone, FeedRow, ThreadResult, KarmaResult, BondsResult } from './api/dto';
import { POST_PRICE_THREAD, POST_PRICE_REPLY, VOUCH_MIN_BALANCE } from '@dagsocial/types';
import { el, shortHex } from './dom';
import { contentHashHex } from './integrity';
import { prefs, setTheme, setIdTint, setNode, setFaucet, writeStore, KEY_LAYOUT, type Theme, type IdTint } from './prefs';
import { renderFeedInto } from './view/feed';
import { renderPanesInto, renderRegionElement } from './view/panes';
import { makeComposer, type ComposerController } from './view/composer';
import { serialise, parse, authorWindowId, postsWindowId, windowSubject } from './model/arrangement';
import { reconcileNewer, isLivePost } from './model/feed-reconcile';
import { flattenThread } from './model/thread';
import { WriteClient, type Rejection } from './api/write';
import { FaucetClient, faucetLine } from './api/faucet';
import {
  PendingLedger, reconcilePost, reconcileLike, reconcileGrant, reconcileVouch, reconcileUnvouch, reconcileInvite,
  pendingLikeTargets, pendingVouchTargets,
} from './wallet/ledger';
import type { PendingEntry } from './wallet/types';
import { readBuildContext } from './wallet/reads';
import { submitPostFlow, submitLikeFlow, submitVouchFlow, submitUnvouchFlow, submitInviteFlow, type SubmitDeps } from './wallet/submit';
import { identity as identitySingleton } from './identity/identity';
import { renderKarmaField, renderInvitesRow } from './view/profile';
import type { Mark, Flight } from './view/card';
import type { YourVouch } from './view/author';
import {
  newWorkspace, openWindow, closeWindow, moveLeft, moveRight, moveBelow, focusWindow, openSet,
  type Origin, type Region,
} from './model/workspace';
import {
  FEED_COMPOSER_KEY, type AppState, type ThreadState, type RenderCtx, type Handlers, type Submission,
  type FlightStage, type AppIdentity, type AuthorWindowData, type FeedState,
} from './model/state';

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

/** A vouch or unvouch rejection in the voice register — the like's sibling, the
 *  node's membership refusals mapped to their sentences (HOUSE_STYLE → Voice). A
 *  client-side refusal (status 0) already reads that way. */
function vouchRejectionCopy(r: Rejection): string {
  if (r.status === 0) return r.message;
  const m = r.message.toLowerCase();
  if (/member/.test(m)) return 'only members can vouch';
  if (/self|yourself/.test(m)) return "you can't vouch for yourself";
  if (/already|duplicate|exist/.test(m)) return 'you already vouch for this identity';
  if (/cooldown|escrow|held/.test(m)) return 'your last unvouch is still in its cooldown';
  if (/balance|karma/.test(m)) return 'not enough karma held to vouch';
  return 'the node said: ' + m;
}

/** An invite rejection in the voice register (HOUSE_STYLE → Voice). */
function inviteRejectionCopy(r: Rejection): string {
  if (r.status === 0) return r.message;
  const m = r.message.toLowerCase();
  if (/already|holds|account|record|exist/.test(m)) return 'that key already holds an account';
  if (/no invites|available/.test(m)) return 'no invites available right now';
  if (/bond|range|min|max/.test(m)) return 'that bond is outside the allowed range';
  if (/karma|balance/.test(m)) return 'not enough karma to cover the bond';
  return 'the node said: ' + m;
}

/** A fresh empty feed state — the author-posts window's body shape, the feed's own. */
function emptyFeedState(): FeedState {
  return { posts: [], pending: [], next: null, report: null, olderReport: null, loaded: false, loading: false, error: null };
}

export class App {
  private state: AppState;
  private client: Api;
  private writeClient: WriteClient;
  // The one identity reference the App holds; the wallet keeps its own narrower
  // Signer seam (submit.ts), the extension swap point (WEB_INTERFACE → The identity module).
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
  // Membership state (WEB_INTERFACE → The identity display). The reader's vouch
  // set read from the node, the escrow gate, the optimistic overlay before a
  // vouch's 2xx, the per-author count cache, the tip the gates read, and the two
  // window kinds' data — all rebuilt on an identity change.
  private vouched = new Map<string, { boxId: string; createdAtBlock: number }>();
  private escrowHeldUntil: number | null = null;
  private optimisticVouches = new Set<string>();
  private vouchCounts = new Map<string, number>();
  private viewerTip = 0;
  private authorData = new Map<string, AuthorWindowData>();
  private authorPostsData = new Map<string, FeedState>();
  // The profile's invites row (WEB_INTERFACE → The profile window): the reader's
  // standing bonds and the invite flight.
  private bondsView: BondsResult | null = null;
  private inviteFlight: Flight | null = null;

  // Every dependency is injectable so a test can drive the App over fakes.
  constructor(client?: Api, writeClient?: WriteClient, identity?: AppIdentity, ledger?: PendingLedger) {
    this.client = client ?? new NodeClient(() => prefs.node);
    this.writeClient = writeClient ?? new WriteClient(() => prefs.node);
    this.idm = identity ?? identitySingleton;
    this.faucetClient = new FaucetClient(() => prefs.faucet);
    // The ledger is for the identity loaded at construction; a change of identity
    // rebuilds it at once through onChange (WEB_INTERFACE → "An identity change
    // takes effect at once").
    this.ledger = ledger ?? new PendingLedger(this.idm.current()?.pubKeyHex ?? null);
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
      vouch: (key) => void this.vouch(key),
      unvouch: (key) => void this.unvouch(key),
      openAuthor: (key, origin) => this.openAuthor(key, origin),
      refreshAuthor: (key) => void this.refreshAuthor(key),
      openAuthorPosts: (key, origin) => this.openAuthorPosts(key, origin),
      refreshAuthorPosts: (key) => void this.refreshAuthorPosts(key),
      authorPostsMore: (key) => void this.authorPostsMore(key),
      moreEndorsers: (key) => void this.moreEndorsers(key),
      invite: (inviteeKey, bond) => void this.invite(inviteeKey, bond),
      moreBonds: () => void this.moreBonds(),
    };
  }

  /** The loaded identity's key, sent on every read once one exists and never
   *  before (WEB_INTERFACE → "Every read carries the viewer's key once an identity is loaded, and none does before"). */
  private viewer(): string | undefined {
    return this.idm.current()?.pubKeyHex ?? undefined;
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
    // A restored ledger may already hold pending entries from a prior session; the
    // poll runs while it holds one (WEB_INTERFACE → The wallet). startPoll guards on
    // an empty ledger, so this is a no-op when there is nothing to reconcile.
    this.startPoll();
  }

  start(appbar: HTMLElement, feedEl: HTMLElement, panesEl: HTMLElement): void {
    this.mount(appbar, feedEl, panesEl);
    this.suppressHoverWhileScrolling();

    void this.loadFeed();
    // A restored arrangement names post ids that must be fetched, and one may
    // have been pruned since — its window renders the tombstone, not an error.
    for (const id of openSet(this.state.workspace)) if (!isWin(id)) void this.fetchThread(id);
    // A restored identity's membership state — the vouch set, the member flag —
    // so the marks resolve on the read the reader's own load triggers.
    if (this.idm.current() !== null) void this.loadMembershipState();
    // A restored arrangement may hold an @author/@posts window; load its data.
    for (const id of openSet(this.state.workspace)) {
      const sub = windowSubject(id);
      if (sub?.kind === 'author') void this.loadAuthorData(this.ensureAuthorData(sub.key));
      if (sub?.kind === 'posts') void this.loadAuthorPosts(this.ensurePostsData(sub.key));
    }
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
    const cur = this.idm.current();
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
      member: this.isMember(),
      markFor: (key) => this.markFor(key),
      yourVouch: (key) => this.yourVouchFor(key),
      author: this.authorData,
      authorPosts: this.authorPostsData,
      invite: this.state.status
        ? { bondMin: this.state.status.inviteBondMin, bondMax: this.state.status.inviteBondMax, probationBlocks: this.state.status.inviteProbationBlocks }
        : null,
      canAffordMinBond: this.canAffordMinBond(),
      bonds: this.bondsView,
      inviteFlight: this.inviteFlight,
    };
  }

  /** The spendable view covers the minimum bond — a courtesy that shows the invite
   *  form only when it can be filled; the effective balance is the proxy, the
   *  node's refusal the truth (WEB_INTERFACE → The profile window). */
  private canAffordMinBond(): boolean {
    if (this.profileKarma === null || this.state.status === null) return false;
    return BigInt(this.profileKarma.effective) >= BigInt(this.state.status.inviteBondMin);
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
    const cur = this.idm.current();
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
    this.ensureCountsForRendered();
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
    this.ensureCountsForRendered();
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
    this.ensureCountsForRendered();
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
    await this.refreshTip(); // a ↻ re-reads the tip, so a held mark can re-enable
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
    // A region's ↻ re-reads the vouch count for the authors it re-renders.
    this.clearCountsFor(feed.posts.map((p) => p.author));
    this.renderFeed();
  }

  /** Drop the cached vouch count for these authors, so the next render re-reads
   *  it (WEB_INTERFACE → The identity display: re-read on the region's ↻). */
  private clearCountsFor(keys: Iterable<string>): void {
    for (const k of keys) this.vouchCounts.delete(k);
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
    await this.refreshTip(); // a ↻ re-reads the tip
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
    // The ↻ re-reads the vouch count for the authors in this thread.
    if (t.root) this.clearCountsFor(flattenThread(t.root, t.descendants).map((n) => n.row).filter((r): r is PostJson => !('kind' in r)).map((r) => r.author));
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
    // The membership state is per identity: a second key never sees the first's
    // vouches, escrow or count cache (WEB_INTERFACE → The identity display).
    this.vouched.clear();
    this.escrowHeldUntil = null;
    this.optimisticVouches.clear();
    this.vouchCounts.clear();
    this.viewerTip = 0;
    this.authorData.clear();
    this.authorPostsData.clear();
    this.bondsView = null;
    this.inviteFlight = null;
    this.ledger = new PendingLedger(this.idm.current()?.pubKeyHex ?? null);
    this.startPoll(); // the new key's restored ledger may hold entries; guarded on empty
    this.renderHeader();
    this.renderPanes();
    void this.loadFeed();
    for (const id of openSet(this.state.workspace)) if (!isWin(id)) void this.fetchThread(id);
    // The vouch set, member flag and escrow for the new key, then the marks re-render.
    if (this.idm.current() !== null) void this.loadMembershipState();
  }

  /** A fresh sealed file for the reader to keep. Needs the seed, so the profile
   *  unlocks first; the backup line then clears (WEB_INTERFACE → The profile window). */
  private async exportIdentity(password: string): Promise<void> {
    const text = await this.idm.exportFile(password);
    const cur = this.idm.current();
    download(`notis-identity-${cur ? cur.pubKeyHex.slice(0, 8) : 'key'}.json`, text);
    this.renderRegionsFor('@profile'); // export fires no onChange; re-render clears the backup line
  }

  /** The profile window's open and ↻ read the loaded key's /karma, and with it
   *  the membership state — the vouch set, the escrow and the member flag the
   *  marks read (WEB_INTERFACE → The profile window, → The identity display). */
  private refreshProfileKarma(): Promise<void> {
    return this.loadMembershipState();
  }

  /** Ask the faucet — a 202 rides the bounded poll as a grant entry; a rejection is
   *  one register line (WEB_INTERFACE → The faucet step). The request carries only
   *  the public key, so a locked identity can ask. */
  private async askFaucet(): Promise<void> {
    const cur = this.idm.current();
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
    return { reads: this.client, write: this.writeClient, ledger: this.ledger, identity: this.idm };
  }

  private openComposer(parentId: string | null): void {
    if (this.idm.current() === null) return;
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
    const cur = this.idm.current();
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
    const cur = this.idm.current();
    if (cur === null) return;
    if (cur.locked) {
      // The seed is not loaded and sign is synchronous, so the unlock is a form in
      // the composer foot; on success the flight continues (WEB_INTERFACE → The
      // identity module). Esc returns to editing with the draft intact.
      const ctrl = this.composers.get(composerKey(parentId));
      if (!ctrl) return;
      ctrl.showUnlock(cur.pubKeyHex, async (p) => {
        await this.idm.unlock(p);
        // Re-read the current draft — the reader may have edited it while the unlock
        // form was open, so the captured text would be stale.
        await this.submitComposer(parentId, ctrl.text());
      });
      return;
    }
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
    const cur = this.idm.current();
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

  // -------------------------------------------------------------------------
  // Membership actions — the mark, the vouch set, the two windows
  // (WEB_INTERFACE → The identity display, → The author window). All inert with
  // no identity loaded.
  // -------------------------------------------------------------------------

  /** The reader may vouch — a member, or a root (which implies member). Read from
   *  /karma at identity load and the profile's ↻ (WEB_INTERFACE → The identity display). */
  private isMember(): boolean {
    const k = this.profileKarma;
    return k !== null && (k.member || k.invitesAvailable === null);
  }

  /** The mark for any identity — its state and count from the vouch set, the
   *  optimistic overlay, the escrow gate and the count cache. Absent with no
   *  identity, for a non-member, and on the reader's own key; disabled while an
   *  escrow stands or the balance is below the floor (WEB_INTERFACE → The identity
   *  display). The floor and the escrow are courtesies; the node's refusal is the
   *  truth. */
  private markFor(key: string): Mark | null {
    const cur = this.idm.current();
    if (cur === null || key === cur.pubKeyHex || !this.isMember()) return null;
    const count = this.vouchCounts.get(key) ?? null;
    if (this.escrowHeldUntil !== null && this.escrowHeldUntil > this.viewerTip) {
      return { state: 'disabled', count, reason: `your stake from an unvouch is held until block ${this.escrowHeldUntil}` };
    }
    if (this.profileKarma !== null && BigInt(this.profileKarma.effective) < VOUCH_MIN_BALANCE) {
      return { state: 'disabled', count, reason: `vouching needs ${VOUCH_MIN_BALANCE} karma held` };
    }
    if (this.vouched.has(key)) return { state: 'check', count };
    if (this.optimisticVouches.has(key) || pendingVouchTargets(this.ledger.all()).has(key)) return { state: 'pending', count };
    return { state: 'plus', count };
  }

  /** The author window's your-vouch row state — the reader's relation to the
   *  subject and the action, or the one-line reason they cannot (WEB_INTERFACE →
   *  The author window). null with no identity loaded, so the row is absent. */
  private yourVouchFor(key: string): YourVouch | null {
    const cur = this.idm.current();
    if (cur === null) return null;
    if (key === cur.pubKeyHex) return { kind: 'reason', text: 'this is you' };
    if (!this.isMember()) return { kind: 'reason', text: 'vouching comes with membership' };
    const cooldownBlocks = this.state.status?.vouchCooldownBlocks ?? 0;
    if (this.escrowHeldUntil !== null && this.escrowHeldUntil > this.viewerTip) {
      return { kind: 'reason', text: `your stake from an unvouch is held until block ${this.escrowHeldUntil}` };
    }
    if (this.profileKarma !== null && BigInt(this.profileKarma.effective) < VOUCH_MIN_BALANCE) {
      return { kind: 'reason', text: `vouching needs ${VOUCH_MIN_BALANCE} karma held` };
    }
    const v = this.vouched.get(key);
    if (v) return { kind: 'vouched', sinceBlock: v.createdAtBlock, cooldownBlocks };
    return { kind: 'plus', cooldownBlocks };
  }

  /** Read the reader's membership state — /karma (member, the floor, the tip), the
   *  vouch set, and the escrow — at identity load and the profile's ↻
   *  (WEB_INTERFACE → The identity display). */
  private async loadMembershipState(): Promise<void> {
    const cur = this.idm.current();
    if (cur === null) return;
    try {
      const [karma, status, vouched, escrow, bonds] = await Promise.all([
        this.client.karma(cur.pubKeyHex),
        this.client.status(),
        this.readVouchSet(cur.pubKeyHex),
        this.readEscrow(cur.pubKeyHex),
        this.client.bonds(cur.pubKeyHex),
      ]);
      this.profileKarma = karma;
      this.state.status = status; // vouchCooldownBlocks + the bond range for the invites row
      this.bumpTip(status.blockHeight);
      this.bumpTip(karma.height);
      this.vouched = vouched;
      this.escrowHeldUntil = escrow;
      this.bondsView = bonds;
    } catch {
      return; // a failed read leaves the last-known state; the ↻ retries
    }
    this.renderHeader();
    this.renderFeed();
    this.renderPanes();
  }

  /** The mark's gates read `viewerTip`, so it must follow every height the client
   *  reads — /status, /karma, /blocks/current — or a mark held "until block N"
   *  stays disabled past N once the poll stops (WEB_INTERFACE → The identity
   *  display). Monotonic: a stale read never rewinds it. */
  private bumpTip(h: number): void {
    if (h > this.viewerTip) this.viewerTip = h;
  }

  /** A ↻ is the reader asking for fresh state, so a feed, pane or profile refresh
   *  re-reads the tip even when no membership entry is pending. */
  private async refreshTip(): Promise<void> {
    try {
      this.bumpTip((await this.client.currentBlock()).height);
    } catch {
      // A failed read leaves the last-known tip; the next ↻ or the poll retries.
    }
  }

  private async readVouchSet(key: string): Promise<Map<string, { boxId: string; createdAtBlock: number }>> {
    const set = new Map<string, { boxId: string; createdAtBlock: number }>();
    let after: string | null = null;
    do {
      const page = await this.client.vouchesByVoucher(key, after === null ? {} : { after });
      for (const v of page.vouches) set.set(v.targetId, { boxId: v.boxId, createdAtBlock: v.createdAtBlock });
      after = page.next;
    } while (after !== null);
    return set;
  }

  private async readEscrow(key: string): Promise<number | null> {
    let after: string | null = null;
    let held: number | null = null;
    do {
      const page = await this.client.vouchCooldowns(key, after === null ? {} : { after });
      for (const c of page.cooldowns) held = held === null ? c.releaseAtBlock : Math.max(held, c.releaseAtBlock);
      after = page.next;
    } while (after !== null);
    return held;
  }

  // ---- the count cache: read once per distinct author on a rendered page, kept
  // for the session, the title set on the live node when the read lands so a mark
  // is never withheld for want of a tooltip (WEB_INTERFACE → The identity display).

  private ensureCountsForRendered(): void {
    if (!this.isMember()) return;
    const keys = new Set<string>();
    for (const n of document.querySelectorAll<HTMLElement>('[data-mark-author]')) {
      const k = n.dataset['markAuthor'];
      if (k !== undefined) keys.add(k);
    }
    this.applyCountTitles();
    const uncached = [...keys].filter((k) => !this.vouchCounts.has(k));
    if (uncached.length > 0) void this.readCounts(uncached);
  }

  private async readCounts(keys: string[]): Promise<void> {
    await Promise.all(
      keys.map(async (k) => {
        try {
          const res = await this.client.vouchesByTarget(k, { limit: 1 });
          this.vouchCounts.set(k, res.count);
        } catch {
          // A failed count read leaves the title empty rather than wrong.
        }
      }),
    );
    this.applyCountTitles();
  }

  /** Set the count title on every live mark — a tooltip, not motion, so it lands
   *  on the existing node rather than re-rendering. A disabled mark keeps its
   *  reason. */
  private applyCountTitles(): void {
    for (const n of document.querySelectorAll<HTMLElement>('[data-mark-author]:not(.disabled)')) {
      const k = n.dataset['markAuthor'];
      if (k === undefined) continue;
      const c = this.vouchCounts.get(k);
      if (c === undefined) continue;
      (n as HTMLElement).title = c <= 0 ? 'no vouches' : c === 1 ? '1 vouch' : `${c} vouches`;
    }
  }

  // ---- vouch, from the mark (WEB_INTERFACE → The identity display) ----

  private async vouch(key: string): Promise<void> {
    const cur = this.idm.current();
    if (cur === null || this.optimisticVouches.has(key) || this.vouched.has(key)) return;
    // Muted ✓ at once — the reader did it, the same optimistic rule as a like.
    this.optimisticVouches.add(key);
    this.renderRegionsForAuthor(key);
    let result;
    try {
      result = await submitVouchFlow(this.submitDeps(), key);
    } catch {
      this.optimisticVouches.delete(key);
      this.reportVouch(key, "vouch rejected: can't reach the node right now.");
      this.renderRegionsForAuthor(key);
      return;
    }
    if (result.ok) {
      // The ledger now holds the pending vouch; the mark reads pending from it.
      this.optimisticVouches.delete(key);
      this.startPoll();
    } else {
      this.optimisticVouches.delete(key);
      this.reportVouch(key, 'vouch rejected: ' + vouchRejectionCopy(result.rejection));
    }
    this.renderRegionsForAuthor(key);
  }

  // ---- unvouch, from the author window (WEB_INTERFACE → The author window) ----

  private async unvouch(key: string): Promise<void> {
    const cur = this.idm.current();
    if (cur === null) return;
    const d = this.authorData.get(key);
    if (d) d.flight = { stage: 'submitting' };
    this.renderRegionsFor(authorWindowId(key));
    let result;
    try {
      result = await submitUnvouchFlow(this.submitDeps(), key);
    } catch {
      if (d) d.flight = { stage: 'rejected', reason: "unvouch rejected: can't reach the node right now." };
      this.renderRegionsFor(authorWindowId(key));
      return;
    }
    if (result.ok) {
      if (d) d.flight = { stage: 'submitted' };
      this.startPoll();
    } else if (d) {
      d.flight = { stage: 'rejected', reason: 'unvouch rejected: ' + vouchRejectionCopy(result.rejection) };
    }
    this.renderRegionsFor(authorWindowId(key));
  }

  /** Report a vouch rejection where the author's mark is visible — the region
   *  report in a pane, the feed's line where the feed shows the author (likes are
   *  panes-only, so this feed case is the vouch's own). */
  private reportVouch(key: string, text: string): void {
    if (this.feedHasAuthor(key)) this.state.feed.report = text;
    for (const col of this.state.workspace.columns) {
      for (const region of col.regions) {
        const fk = region.wins[region.focus];
        if (fk === undefined) continue;
        const sub = windowSubject(fk);
        if ((sub && sub.key === key) || (!isWin(fk) && this.threadHasAuthor(fk, key))) region.report = text;
      }
    }
  }

  /** Re-render the feed and the panes whose focused surface shows this author —
   *  a card by them, or their author/posts window. The mark changes glyph in a
   *  fixed slot, so geometry holds (HOUSE_STYLE → Motion). */
  private renderRegionsForAuthor(key: string): void {
    if (this.feedHasAuthor(key)) this.renderFeed();
    for (const col of this.state.workspace.columns) {
      for (const region of col.regions) {
        const fk = region.wins[region.focus];
        if (fk === undefined) continue;
        const sub = windowSubject(fk);
        if ((sub && sub.key === key) || (!isWin(fk) && this.threadHasAuthor(fk, key))) this.renderRegion(region.uid);
      }
    }
  }

  private feedHasAuthor(key: string): boolean {
    return this.state.feed.posts.some((p) => p.author === key) || this.state.feed.pending.some((p) => p.author === key);
  }

  private threadHasAuthor(threadId: string, key: string): boolean {
    const t = this.state.threads.get(threadId);
    if (!t || !t.root) return false;
    return flattenThread(t.root, t.descendants).some((n) => !('kind' in n.row) && (n.row as PostJson).author === key);
  }

  // ---- the author window and the author-posts window ----

  private ensureAuthorData(key: string): string {
    if (!this.authorData.has(key)) this.authorData.set(key, { karma: null, endorsers: null, endorsersNext: false, flight: null });
    return key;
  }

  private ensurePostsData(key: string): string {
    if (!this.authorPostsData.has(key)) this.authorPostsData.set(key, emptyFeedState());
    return key;
  }

  private openAuthor(key: string, origin: Origin): void {
    const res = openWindow(this.state.workspace, authorWindowId(key), origin);
    this.saveLayout();
    this.ensureAuthorData(key);
    if (res.raised) this.renderRegion(res.region.uid);
    else this.renderPanes();
    void this.loadAuthorData(key);
  }

  private async loadAuthorData(key: string): Promise<void> {
    const d = this.authorData.get(key);
    if (!d) return;
    try {
      const [karma, endorsers] = await Promise.all([this.client.karma(key), this.client.vouchesByTarget(key)]);
      d.karma = karma;
      d.endorsers = endorsers;
      d.endorsersNext = endorsers.next !== null;
      this.bumpTip(karma.height); // an author read carries the node's tip too
      this.vouchCounts.set(key, endorsers.count); // the subject's count, re-read on the window's ↻
      this.clearCountsFor(endorsers.vouches.map((v) => v.voucherId)); // the endorsers' counts too

    } catch {
      return; // leave the window's last data; the ↻ retries
    }
    this.renderRegionsFor(authorWindowId(key));
  }

  private refreshAuthor(key: string): Promise<void> {
    return this.loadAuthorData(key);
  }

  private async moreEndorsers(key: string): Promise<void> {
    const d = this.authorData.get(key);
    if (!d || d.endorsers === null || d.endorsers.next === null) return;
    try {
      const page = await this.client.vouchesByTarget(key, { after: d.endorsers.next });
      d.endorsers = { vouches: [...d.endorsers.vouches, ...page.vouches], count: page.count, next: page.next };
      d.endorsersNext = page.next !== null;
    } catch {
      return;
    }
    this.renderRegionsFor(authorWindowId(key));
  }

  private openAuthorPosts(key: string, origin: Origin): void {
    const res = openWindow(this.state.workspace, postsWindowId(key), origin);
    this.saveLayout();
    this.ensurePostsData(key);
    if (res.raised) this.renderRegion(res.region.uid);
    else this.renderPanes();
    void this.loadAuthorPosts(key);
  }

  private async loadAuthorPosts(key: string): Promise<void> {
    const f = this.authorPostsData.get(key);
    if (!f) return;
    f.loading = true;
    this.renderRegionsFor(postsWindowId(key));
    try {
      const res = await this.client.feed({ limit: FEED_LIMIT }, this.viewer(), key);
      f.posts = res.posts.filter(isLivePost);
      f.next = res.next;
      f.loaded = true;
      f.error = null;
      this.indexRows(res.posts);
    } catch (e) {
      f.error = msg(e);
    }
    f.loading = false;
    this.renderRegionsFor(postsWindowId(key));
  }

  /** The posts window's ↻ reports what it did through the feed's own reconcile,
   *  keyed by the author (WEB_INTERFACE → The author window). */
  private async refreshAuthorPosts(key: string): Promise<void> {
    const f = this.authorPostsData.get(key);
    if (!f) return;
    const region = this.regionFocusedOn(postsWindowId(key));
    try {
      const r = await reconcileNewer(
        f.posts,
        async (after) => {
          const res = await this.client.feed(after === null ? { limit: FEED_LIMIT } : { limit: FEED_LIMIT, after }, this.viewer(), key);
          this.indexRows(res.posts);
          return { posts: res.posts, next: res.next };
        },
        REFRESH_PAGE_CAP,
      );
      f.posts = r.posts;
      if (r.next !== undefined) f.next = r.next;
      f.error = null;
      if (region) region.report = r.newCount ? `${r.newCount} new ${r.newCount === 1 ? 'post' : 'posts'}` : 'no new posts';
    } catch (e) {
      f.error = msg(e);
    }
    this.renderRegionsFor(postsWindowId(key));
  }

  private async authorPostsMore(key: string): Promise<void> {
    const f = this.authorPostsData.get(key);
    if (!f || f.next === null) return;
    try {
      const res = await this.client.feed({ limit: FEED_LIMIT, after: f.next }, this.viewer(), key);
      const older = res.posts.filter(isLivePost);
      const have = new Set(f.posts.map((p) => p.id));
      f.posts = [...f.posts, ...older.filter((p) => !have.has(p.id))];
      f.next = res.next;
      this.indexRows(res.posts);
    } catch (e) {
      f.error = msg(e);
    }
    this.renderRegionsFor(postsWindowId(key));
  }

  // ---- invite, from the profile's invites row (WEB_INTERFACE → The profile window) ----

  private async invite(inviteeKey: string, bond: bigint): Promise<void> {
    const cur = this.idm.current();
    if (cur === null) return;
    this.inviteFlight = { stage: 'submitting' };
    this.renderInvitesRowInPlace();
    let result;
    try {
      result = await submitInviteFlow(this.submitDeps(), inviteeKey, bond);
    } catch {
      this.inviteFlight = { stage: 'rejected', reason: "invite rejected: can't reach the node right now." };
      this.renderInvitesRowInPlace();
      return;
    }
    if (result.ok) {
      this.inviteFlight = { stage: 'submitted' };
      this.startPoll();
    } else {
      this.inviteFlight = { stage: 'rejected', reason: 'invite rejected: ' + inviteRejectionCopy(result.rejection) };
    }
    this.renderInvitesRowInPlace();
  }

  private async moreBonds(): Promise<void> {
    const cur = this.idm.current();
    if (cur === null || this.bondsView === null || this.bondsView.next === null) return;
    try {
      const page = await this.client.bonds(cur.pubKeyHex, { after: this.bondsView.next });
      this.bondsView = { bonds: [...this.bondsView.bonds, ...page.bonds], bondCount: page.bondCount, next: page.next };
    } catch {
      return;
    }
    this.renderInvitesRowInPlace();
  }

  /** Rebuild the invites row's line, flight and bonds in place from the current
   *  ctx — the invite flight and its landing move colour and text, never the form
   *  the reader may be filling (WEB_INTERFACE → The profile window). A closed
   *  profile has no field; the state is already updated for the next open. */
  private renderInvitesRowInPlace(): void {
    const field = document.querySelector<HTMLElement>('.invites-field');
    if (field) renderInvitesRow(field, this.handlers, this.ctx(), this.profileOrigin());
  }

  private profileOrigin(): Origin {
    for (let ci = 0; ci < this.state.workspace.columns.length; ci++) {
      for (const region of this.state.workspace.columns[ci]!.regions) {
        if (region.wins[region.focus] === '@profile') return { from: 'pane', ci };
      }
    }
    return { from: 'feed' };
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
      this.bumpTip(block.height);
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
    let inviteChanged = false;
    const touchedPosts = new Set<string>();
    const touchedAuthors = new Set<string>();

    // The vouch and unvouch entries reconcile against the reader's own vouch set
    // and escrow, and the invite entries against the bonds — read once when one
    // stands (WEB_INTERFACE → The wallet).
    const cur = this.idm.current();
    const hasMembership = cur !== null && this.ledger.all().some((e) => e.kind === 'vouch' || e.kind === 'unvouch');
    const hasInvite = cur !== null && this.ledger.all().some((e) => e.kind === 'invite');
    let vouchRows: { targetId: string }[] = [];
    let bondRows: { inviteePublicKey: string }[] = [];
    if (hasMembership && cur !== null) {
      this.vouched = await this.readVouchSet(cur.pubKeyHex);
      this.escrowHeldUntil = await this.readEscrow(cur.pubKeyHex);
      this.bumpTip(tip);
      vouchRows = [...this.vouched.keys()].map((targetId) => ({ targetId }));
    }
    if (hasInvite && cur !== null) {
      this.bondsView = await this.client.bonds(cur.pubKeyHex);
      bondRows = this.bondsView.bonds;
    }

    for (const entry of this.ledger.all()) {
      if (entry.kind === 'grant') {
        await this.reconcileGrantEntry(entry, tip);
        continue;
      }
      if (entry.kind === 'vouch') {
        const outcome = reconcileVouch(entry, vouchRows, tip);
        if (outcome === 'pending') continue;
        this.ledger.remove(entry.txId);
        this.optimisticVouches.delete(entry.postId);
        if (outcome === 'expired') this.reportVouch(entry.postId, 'a vouch expired before any block took it');
        this.vouchCounts.delete(entry.postId); // the count changed; re-read on the next render
        touchedAuthors.add(entry.postId);
        continue;
      }
      if (entry.kind === 'unvouch') {
        const outcome = reconcileUnvouch(entry, vouchRows, tip);
        if (outcome === 'pending') continue;
        this.ledger.remove(entry.txId);
        const d = this.authorData.get(entry.postId);
        if (d) d.flight = null; // the flight ended; the escrow gate now holds the mark
        this.vouchCounts.delete(entry.postId);
        touchedAuthors.add(entry.postId);
        continue;
      }
      if (entry.kind === 'invite') {
        const outcome = reconcileInvite(entry, bondRows, tip);
        if (outcome === 'pending') continue;
        this.ledger.remove(entry.txId);
        if (outcome === 'landed') {
          // The line re-reads /karma for the new invitesAvailable, in place.
          this.inviteFlight = null;
          if (cur !== null) this.profileKarma = await this.client.karma(cur.pubKeyHex);
        } else {
          this.inviteFlight = { stage: 'expired', expiresAtHeight: entry.expiresAtHeight };
        }
        inviteChanged = true;
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
    for (const key of touchedAuthors) this.renderRegionsForAuthor(key);
    // An invite landing updates the invites row in place, so a form the reader is
    // filling for the next key survives (WEB_INTERFACE → The profile window).
    if (inviteChanged) this.renderInvitesRowInPlace();
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
