import { NodeClient, type Api } from './api/client';
import type { PostJson, WithdrawnJson, FeedRow, PostResult, ThreadResult, KarmaResult, BondsResult, UsernameResult } from './api/dto';
import { POST_PRICE_THREAD, POST_PRICE_REPLY, VOUCH_MIN_BALANCE, USERNAME_BURN_PRICE } from '@dagsocial/types';
import type { Mode } from './mode';
import type { Tabs } from './tabs';
import { el, shortHex, preservingScroll } from './dom';
import { contentHashHex } from './integrity';
import { prefs, setTheme, setIdTint, setNode, setFaucet, writeStore, KEY_LAYOUT, type Theme, type IdTint } from './prefs';
import { renderFeedInto, replaceFeedCard } from './view/feed';
import { renderPanesInto, renderRegionElement, renderBars } from './view/panes';
import { makeComposer, type ComposerController } from './view/composer';
import { personGlyph, sunGlyph, moonGlyph } from './view/glyphs';
import { MARK } from './view/mark';
import { serialise, parse, authorWindowId, postsWindowId, windowSubject } from './model/arrangement';
import { reconcileNewer, isLivePost } from './model/feed-reconcile';
import { flattenThread } from './model/thread';
import { WriteClient, type Rejection } from './api/write';
import { FaucetClient, faucetLine } from './api/faucet';
import {
  PendingLedger, reconcilePost, reconcileLike, reconcileGrant, reconcileVouch, reconcileUnvouch, reconcileInvite, reconcileWithdraw,
  reconcileClaim, reconcileBurn, pendingUsernameEntry,
  pendingLikeTargets, pendingVouchTargets, pendingWithdrawTargets,
} from './wallet/ledger';
import type { PendingEntry } from './wallet/types';
import { readBuildContext } from './wallet/reads';
import { submitPostFlow, submitLikeFlow, submitVouchFlow, submitUnvouchFlow, submitInviteFlow, submitWithdrawFlow, submitClaimFlow, submitBurnFlow, type SubmitDeps } from './wallet/submit';
import { identity as identitySingleton } from './identity/identity';
import { renderKarmaField, renderInvitesRow, renderUsernameRow } from './view/profile';
import type { Flight } from './view/card';
import type { YourVouch } from './view/author';
import {
  newColumn, newWorkspace, openWindow, closeWindow, moveLeft, moveRight, focusWindow, openSet, locate,
  type Origin, type Column,
} from './model/workspace';
import {
  FEED_COMPOSER_KEY, type AppState, type ThreadState, type RenderCtx, type Handlers, type Submission,
  type FlightStage, type AppIdentity, type AuthorWindowData, type FeedState,
} from './model/state';
import { decideMove, type ScreenEntry } from './history';

const FEED_LIMIT = 30;
const THREAD_LIMIT = 50;
const REFRESH_PAGE_CAP = 40; // a refresh re-reads a whole thread; this bounds the loop
const POLL_MS = 15000;       // the bounded landing poll, only while own submissions are pending
const FEED_COMPOSER = FEED_COMPOSER_KEY;
/** The one-column line: below it the feed and one column at the floor no longer
 *  fit, so the feed joins the strip and the screen shows one member at a time.
 *  The stylesheet's @media reads the same number, pinned equal by style.test.ts
 *  (WEB_INTERFACE → The workspace). */
export const ONE_COLUMN_MAX_PX = 955;

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
  if (r.status === 409) return 'that rep is still tied up in a post that has not landed.';
  if (r.status === 503) return 'the node is full right now.';
  if (/karma/i.test(r.message)) return 'not enough rep to post right now.';
  return 'the node said: ' + r.message.toLowerCase();
}

function likeRejectionCopy(r: Rejection): string {
  if (r.status === 0) return r.message;
  if (r.status === 409) return 'you have already liked this post';
  if (/karma/i.test(r.message)) return 'not enough rep';
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
  if (/balance|karma/.test(m)) return 'not enough rep held to vouch';
  return 'the node said: ' + m;
}

/** An invite rejection in the voice register (HOUSE_STYLE → Voice). */
function inviteRejectionCopy(r: Rejection): string {
  if (r.status === 0) return r.message;
  const m = r.message.toLowerCase();
  if (/already|holds|account|record|exist/.test(m)) return 'that key already holds an account';
  if (/no invites|available/.test(m)) return 'no invites available right now';
  if (/bond|range|min|max/.test(m)) return 'that bond is outside the allowed range';
  if (/karma|balance/.test(m)) return 'not enough rep to cover the bond';
  return 'the node said: ' + m;
}

/** A withdraw rejection in the voice register — the like's and the vouch's sibling,
 *  the node's known refusals mapped to their sentences (HOUSE_STYLE → Voice,
 *  WEB_INTERFACE → The withdraw control). A client-side refusal (status 0) already
 *  reads that way. */
function withdrawRejectionCopy(r: Rejection): string {
  if (r.status === 0) return r.message;
  if (r.status === 409) return 'that rep box is still tied up in a transaction that has not landed';
  if (r.status === 503) return "the node's pool is full right now";
  const m = r.message.toLowerCase();
  if (/earlier block|not confirmed/.test(m)) return 'this post has not landed yet';
  if (/already/.test(m)) return 'this post is already withdrawn';
  if (/author/.test(m)) return 'only the author can withdraw this post';
  return 'the node said: ' + m;
}

/** A username rejection in the voice register (WEB_INTERFACE → The username row,
 *  HOUSE_STYLE → Voice). A client-side refusal (status 0) already reads that way. */
function usernameRejectionCopy(r: Rejection): string {
  if (r.status === 0) return r.message;
  if (r.status === 503) return "the node's pool is full right now.";
  const m = r.message.toLowerCase();
  if (/name invalid|invalid name/.test(m)) return 'that name is not 1 to 24 letters, digits or _.';
  if (/name taken/.test(m)) return 'that name is taken.';
  if (/identity holds a name/.test(m)) return 'this key already holds a name.';
  if (/pending claim.*name|name.*pending claim/.test(m)) return 'a claim for that name is already pending.';
  if (/pending claim|already.*pending/.test(m)) return 'this key already has a claim pending.';
  if (/not held/.test(m)) return 'that name is not held any more.';
  if (/price/.test(m)) return 'the burn\'s price did not match; refresh and try again.';
  return m;
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
  // The workspace is the one-column scroller; the panes the tiling scroller. Null
  // when the App is mounted without the shell (a test without .workspace).
  private workspaceEl: HTMLElement | null = null;
  private handlers: Handlers;

  // The width class and the header arrows (WEB_INTERFACE → The workspace). oneColumn
  // is one media query read into the ctx; the arrows scroll the active scroller and
  // carry `none` when no column lies that way — space-reserved at tiling, absent at
  // one column.
  private oneColumn = false;
  private standalone = false;
  private base = '/';
  private tabs: Tabs | null = null;
  private mql: MediaQueryList | null = null;
  private headerLeftArrow: HTMLElement | null = null;
  private headerRightArrow: HTMLElement | null = null;
  // WEB_INTERFACE → The workspace → "At one column the screens are history"
  private lastDepth = 0;
  // A back the App issued is in flight until its popstate settles; a scroll
  // settle in between is the rebuild clamp, not a swipe.
  private backInFlight = false;

  // Open composer widgets, held by key so the same element is re-parented across
  // a region rebuild rather than recreated (WEB_INTERFACE → The write surface).
  private composers = new Map<string, ComposerController>();
  // Targets the reader pressed like on, shown liked at once and reverted on a
  // rejection or expiry (WEB_INTERFACE → The wallet).
  private optimisticLikes = new Set<string>();
  // Images the reader expanded this session, keyed <postId>:<index in document
  // order>. Not per identity — content viewing, not a write (WEB_INTERFACE → Content).
  private expandedImages = new Set<string>();
  // The transient withdraw flight per post — submitting and expired; 'submitted'
  // is the ledger's durable state (WEB_INTERFACE → The withdraw control).
  private withdrawFlights = new Map<string, Flight>();
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
  private viewerTip = 0;
  private authorData = new Map<string, AuthorWindowData>();
  private authorPostsData = new Map<string, FeedState>();
  // The profile's invites row (WEB_INTERFACE → The profile window): the reader's
  // standing bonds and the invite flight.
  private bondsView: BondsResult | null = null;
  private inviteFlight: Flight | null = null;
  // The reader's own name (WEB_INTERFACE → The identity display).
  private ownName: UsernameResult | null = null;
  private ownNameLoaded = false;
  private usernameFlight: Flight | null = null;
  private usernameInFlight: { kind: 'claim' | 'burn'; name: string } | null = null;

  // Every dependency is injectable so a test can drive the App over fakes.
  constructor(client?: Api, writeClient?: WriteClient, identity?: AppIdentity, ledger?: PendingLedger, tabs?: Tabs) {
    this.client = client ?? new NodeClient(() => prefs.node);
    this.writeClient = writeClient ?? new WriteClient(() => prefs.node);
    this.idm = identity ?? identitySingleton;
    this.faucetClient = new FaucetClient(() => prefs.faucet);
    // The ledger is for the identity loaded at construction; a change of identity
    // rebuilds it at once through onChange (WEB_INTERFACE → "An identity change
    // takes effect at once").
    this.ledger = ledger ?? new PendingLedger(this.idm.current()?.pubKeyHex ?? null);
    this.tabs = tabs ?? null;
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
      moveLeft: (id) => this.moveWindow(id, () => moveLeft(this.state.workspace, id)),
      moveRight: (id) => this.moveWindow(id, () => moveRight(this.state.workspace, id)),
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
      // The press records the key; the error drops it. Neither re-renders — the
      // card already swapped the img or the failure line in place (WEB_INTERFACE → Content).
      expandImage: (key) => { this.expandedImages.add(key); },
      collapseImage: (key) => { this.expandedImages.delete(key); },
      likePost: (postId) => void this.likePost(postId),
      withdrawPost: (postId) => void this.withdrawPost(postId),
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
      claimUsername: (name) => void this.claimUsername(name),
      burnUsername: () => void this.burnUsername(),
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
  mount(appbar: HTMLElement, feedEl: HTMLElement, panesEl: HTMLElement, mode?: Mode): void {
    this.appbar = appbar;
    this.feedEl = feedEl;
    this.panesEl = panesEl;
    this.workspaceEl = panesEl.closest<HTMLElement>('.workspace');
    if (mode) this.base = mode.base;
    if (mode?.kind === 'standalone') {
      this.standalone = true;
      this.state.workspace = { columns: [newColumn([mode.id])] };
      this.workspaceEl?.classList.add('standalone');
      history.replaceState({ id: mode.id }, '', location.href);
      // WEB_INTERFACE → The standalone thread — popstate re-roots without pushing.
      window.addEventListener('popstate', (e) => {
        if (!this.standalone) return;
        const id = e.state?.id;
        if (typeof id === 'string' && /^[0-9a-f]{64}$/i.test(id)) {
          this.standaloneReroot(id);
        }
      });
    }
    // One media query is the width class the header prefix and the panes read; its
    // change re-renders both (WEB_INTERFACE → The workspace). The header arrows
    // follow the active scroller's position and the width class.
    this.mql = window.matchMedia(`(max-width: ${ONE_COLUMN_MAX_PX}px)`);
    this.oneColumn = this.mql.matches;
    this.mql.addEventListener('change', (e) => this.onWidthClassChange(e.matches));
    for (const s of [this.panesEl, this.workspaceEl]) {
      s?.addEventListener('scroll', () => this.updateHeaderArrows(), { passive: true });
    }
    window.addEventListener('resize', () => this.updateHeaderArrows());
    // WEB_INTERFACE → The workspace → "At one column the screens are history"
    this.workspaceEl?.addEventListener('scrollend', () => {
      if (this.standalone || !this.oneColumn) return;
      // WEB_INTERFACE → The workspace → "At one column the screens are history"
      if (this.backInFlight) return;
      const name = this.memberNameAt(this.currentMemberIndex());
      if (name === null) return;
      const s = history.state;
      const current: ScreenEntry | null = s && typeof s.member === 'string' ? s as ScreenEntry : null;
      const result = decideMove(current, name, (a, b) => this.sameScreen(a, b), 'swipe');
      if (result.kind === 'back') history.back();
    });
    window.addEventListener('popstate', (e) => {
      this.backInFlight = false;
      if (this.standalone || !this.oneColumn) return;
      const s = (e as PopStateEvent).state;
      if (!s || typeof s.member !== 'string') return;
      const entry = s as ScreenEntry;
      const goingBack = entry.depth < this.lastDepth;
      this.lastDepth = entry.depth;
      if (entry.member === 'feed') {
        this.scrollToMember('feed');
        return;
      }
      const at = locate(this.state.workspace, entry.member);
      if (at) {
        this.scrollColumnIntoView(at.column.uid);
      } else {
        if (goingBack) history.back();
        else history.forward();
      }
    });
    // An identity change takes effect at once (WEB_INTERFACE → The identity module).
    this.idm.onChange(() => this.onIdentityChange());
    if (!this.standalone) this.restoreLayout();
    // WEB_INTERFACE → The workspace → "At one column the screens are history"
    if (!this.standalone && this.oneColumn) {
      const kept = history.state;
      const ours = kept && typeof kept.member === 'string';
      history.replaceState(
        { member: 'feed', prev: ours ? kept.prev : null, depth: ours ? kept.depth : 0 },
        '', location.href,
      );
      this.lastDepth = ours ? (kept.depth as number) : 0;
    }
    this.renderHeader();
    this.renderFeed();
    this.renderPanes();
    // A restored ledger may already hold pending entries from a prior session; the
    // poll runs while it holds one (WEB_INTERFACE → The wallet). startPoll guards on
    // an empty ledger, so this is a no-op when there is nothing to reconcile.
    this.startPoll();
  }

  start(appbar: HTMLElement, feedEl: HTMLElement, panesEl: HTMLElement, mode?: Mode): void {
    this.mount(appbar, feedEl, panesEl, mode);
    this.suppressHoverWhileScrolling();

    // WEB_INTERFACE → The way into the workspace — the workspace tab claims the
    // lock and listens for handovers.
    if (!this.standalone && this.tabs) {
      void this.tabs.claim().then(() => {
        window.name = 'notis-workspace';
      });
      this.tabs.onOpen((id) => {
        if (!this.tabs?.holds()) return;
        this.openThread(id, { from: 'feed' });
      });
    }

    void this.loadFeed();
    // A restored arrangement names post ids that must be fetched, and one may
    // have been withdrawn since — its window renders the withdrawn marker, not
    // an error.
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
    if (this.standalone) return;
    // WEB_INTERFACE → The way into the workspace — only the lock holder writes.
    if (this.tabs && !this.tabs.holds()) return;
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
      oneColumn: this.oneColumn,
      standalone: this.standalone,
      writeEnabled: cur !== null,
      ownKey: cur?.pubKeyHex ?? null,
      composerFor: (parentId) => this.composers.get(composerKey(parentId))?.el ?? null,
      submissionsFor: (parentId) => this.state.submissions.filter((s) => s.parentId === parentId),
      likePending: (postId) => this.optimisticLikes.has(postId) || likeTargets.has(postId),
      expandedImages: this.expandedImages,
      // Profile window (WEB_INTERFACE → The profile window). identity carries the
      // lock state the header prefix does not need.
      identity: this.idm.current(),
      backedUp: this.idm.backedUp(),
      karma: this.profileKarma,
      grant: this.grantView,
      membershipBars: this.state.status?.membership ?? null,
      member: this.isMember(),
      yourVouch: (key) => this.yourVouchFor(key),
      author: this.authorData,
      authorPosts: this.authorPostsData,
      invite: this.state.status
        ? { bondMin: this.state.status.inviteBondMin, bondMax: this.state.status.inviteBondMax, probationBlocks: this.state.status.inviteProbationBlocks }
        : null,
      canAffordMinBond: this.canAffordMinBond(),
      bonds: this.bondsView,
      inviteFlight: this.inviteFlight,
      withdrawState: (postId) => this.withdrawState(postId),
      canSignWithdraw: this.canSignWithdraw(),
      ownName: this.ownName,
      ownNameLoaded: this.ownNameLoaded,
      usernameFlight: this.usernameFlight,
      pendingUsername: this.usernameInFlight ?? pendingUsernameEntry(this.ledger.all()),
      canSignClaim: this.canSignWithdraw(), // same predicate — a spendable box
      canAffordBurn: this.canAffordBurn(),
      linkUrl: (id) => new URL(this.base + 'p/' + id, location.href).href,
    };
  }

  /** The withdraw slot's state for a post: 'pending' when the ledger holds its
   *  entry — the durable 'submitted' that survives a reload — else the transient
   *  flight, or null (WEB_INTERFACE → The withdraw control). */
  private withdrawState(postId: string): 'pending' | Flight | null {
    if (pendingWithdrawTargets(this.ledger.all()).has(postId)) return 'pending';
    return this.withdrawFlights.get(postId) ?? null;
  }

  /** The spendable view is non-empty — the courtesy gate the withdraw button reads,
   *  from the wallet's view the App already holds; the node's refusal is the truth
   *  (WEB_INTERFACE → The withdraw control). */
  private canSignWithdraw(): boolean {
    if (this.profileKarma === null) return false;
    const confirmed = this.profileKarma.boxes.map((b) => ({ boxId: b.boxId, value: BigInt(b.value) }));
    return this.ledger.spendable(confirmed).length > 0;
  }

  /** The spendable view covers the minimum bond — a courtesy that shows the invite
   *  form only when it can be filled; the effective balance is the proxy, the
   *  node's refusal the truth (WEB_INTERFACE → The profile window). */
  private canAffordMinBond(): boolean {
    if (this.profileKarma === null || this.state.status === null) return false;
    return BigInt(this.profileKarma.effective) >= BigInt(this.state.status.inviteBondMin);
  }

  private canAffordBurn(): boolean {
    if (this.profileKarma === null) return false;
    return BigInt(this.profileKarma.effective) >= USERNAME_BURN_PRICE;
  }

  private renderHeader(): void {
    const bar = this.appbar;
    bar.textContent = '';

    if (this.standalone) {
      this.renderStandaloneHeader(bar);
      return;
    }

    // ‹ at the left edge scrolls the view one column that way. When no column lies
    // left it carries `none` — space-reserved at tiling, absent at one column
    // (WEB_INTERFACE → The workspace); updateHeaderArrows toggles it and sets the
    // label from the scroller's position.
    const left = el('button', 'ctl', '‹') as HTMLButtonElement;
    left.setAttribute('aria-label', 'show the column to the left');
    left.addEventListener('click', () => this.scrollByOneColumn(-1));
    this.headerLeftArrow = left;
    bar.appendChild(left);

    const brand = el('div', 'brand');
    brand.innerHTML = MARK;
    brand.appendChild(el('h1', null, 'Notis'));
    bar.appendChild(brand);
    bar.appendChild(el('span', 'spacer'));

    // The profile and theme controls. The theme control names and shows the theme
    // it would switch TO (HOUSE_STYLE → Colour); the profile control shows a person
    // or the key prefix. At one column both are glyphs at the header's control
    // size — a person, and the moon on Sand / the sun on Bistre — inline SVG in
    // currentColor drawn in the house technique, the same for every reader and for
    // none since the window says who (WEB_INTERFACE → The profile window,
    // HOUSE_STYLE → Colour → "On a phone the theme control is a sun or a moon",
    // HOUSE_STYLE → Illustration). At tiling they are words: 'profile' or the key
    // prefix in mono, and the theme's word; no avatar, no identity colour
    // (WEB_INTERFACE → The profile window; HOUSE_STYLE → Identity colour).
    const target: Theme = prefs.theme === 'dark' ? 'light' : 'dark';
    if (this.oneColumn) {
      const profile = el('button', 'hdr-glyph');
      profile.setAttribute('aria-label', 'open profile');
      profile.appendChild(personGlyph());
      profile.addEventListener('click', () => this.openProfile());
      bar.appendChild(profile);

      const theme = el('button', 'hdr-glyph');
      theme.setAttribute('aria-label', `switch to ${target} theme`);
      theme.appendChild(target === 'dark' ? moonGlyph() : sunGlyph());
      theme.addEventListener('click', () => this.changeTheme(target));
      bar.appendChild(theme);
    } else {
      const cur = this.idm.current();
      const profile = el('button', 'theme-btn');
      profile.style.background = 'transparent';
      profile.style.color = 'var(--ink)';
      profile.style.border = '1px solid var(--borderStrong)';
      if (cur === null) {
        profile.textContent = 'profile';
      } else if (this.ownName) {
        profile.style.fontWeight = '600';
        profile.textContent = '@' + this.ownName.name;
      } else {
        profile.style.fontFamily = 'var(--mono)';
        profile.textContent = shortHex(cur.pubKeyHex, 16);
      }
      profile.setAttribute('aria-label', 'open profile');
      profile.addEventListener('click', () => this.openProfile());
      bar.appendChild(profile);

      const theme = el('button', 'theme-btn', target);
      theme.setAttribute('aria-label', `switch to ${target} theme`);
      theme.addEventListener('click', () => this.changeTheme(target));
      bar.appendChild(theme);
    }

    // › at the right edge, the converse of ‹.
    const right = el('button', 'ctl', '›') as HTMLButtonElement;
    right.setAttribute('aria-label', 'show the column to the right');
    right.addEventListener('click', () => this.scrollByOneColumn(1));
    this.headerRightArrow = right;
    bar.appendChild(right);

    this.updateHeaderArrows();
  }

  // WEB_INTERFACE → The standalone thread — no arrows, no profile control.
  private renderStandaloneHeader(bar: HTMLElement): void {
    const brand = el('div', 'brand');
    brand.innerHTML = MARK;
    brand.appendChild(el('h1', null, 'Notis'));
    bar.appendChild(brand);
    bar.appendChild(el('span', 'spacer'));

    // WEB_INTERFACE → The standalone thread — on one column a ghost (outline,
    // no fill); at two columns and more the inverse fill stays.
    const wayIn = el('button', this.oneColumn ? 'btn btn-ghost' : 'theme-btn', 'add to workspace');
    wayIn.setAttribute('aria-label', 'add this thread to your workspace');
    wayIn.addEventListener('click', () => this.wayIn());
    bar.appendChild(wayIn);

    const target: Theme = prefs.theme === 'dark' ? 'light' : 'dark';
    if (this.oneColumn) {
      const theme = el('button', 'hdr-glyph');
      theme.setAttribute('aria-label', `switch to ${target} theme`);
      theme.appendChild(target === 'dark' ? moonGlyph() : sunGlyph());
      theme.addEventListener('click', () => this.changeTheme(target));
      bar.appendChild(theme);
    } else {
      const cur = this.idm.current();
      if (cur !== null) {
        if (this.ownName) {
          const handle = el('span', 'handle hdr-prefix');
          handle.textContent = '@' + this.ownName.name;
          bar.appendChild(handle);
        } else {
          const prefix = el('span', 'hex hdr-prefix');
          prefix.style.fontFamily = 'var(--mono)';
          prefix.textContent = shortHex(cur.pubKeyHex, 16);
          bar.appendChild(prefix);
        }
      }
      const theme = el('button', 'theme-btn', target);
      theme.setAttribute('aria-label', `switch to ${target} theme`);
      theme.addEventListener('click', () => this.changeTheme(target));
      bar.appendChild(theme);
    }
  }

  // WEB_INTERFACE → The standalone thread — document.title is the author's handle
  // when the root row carries a name, else the prefix, and Notis.
  private updateStandaloneTitle(id: string): void {
    const t = this.state.threads.get(id);
    const root = t?.root;
    if (!root) return;
    const display = root.authorName !== null ? '@' + root.authorName : shortHex(root.author, 16);
    document.title = display + ' · Notis';
  }

  /** The active scroller: the workspace at one column (the feed and every column
   *  are its members), the panes at tiling (the feed is pinned outside it)
   *  (WEB_INTERFACE → The workspace). */
  private activeScroller(): HTMLElement | null {
    return this.oneColumn ? this.workspaceEl : this.panesEl;
  }

  /** The scroller's members in strip order — the feed and the columns at one
   *  column, the columns alone at tiling (the feed is pinned outside)
   *  (WEB_INTERFACE → The workspace). */
  private orderedMembers(): HTMLElement[] {
    const cols = [...this.panesEl.querySelectorAll<HTMLElement>('.col')];
    return this.oneColumn ? [this.feedEl, ...cols] : cols;
  }

  /** The member index nearest the active scroller's left edge — 0 is the feed at
   *  one column, the first column at tiling. Used by the arrows and the swipe. */
  currentMemberIndex(): number {
    const scroller = this.activeScroller();
    if (!scroller) return 0;
    const members = this.orderedMembers();
    if (members.length === 0) return 0;
    const sLeft = scroller.getBoundingClientRect().left;
    let cur = 0;
    let best = Infinity;
    members.forEach((m, i) => {
      const d = Math.abs(m.getBoundingClientRect().left - sLeft);
      if (d < best) { best = d; cur = i; }
    });
    return cur;
  }

  /** ‹ / › move the view one column — the neighbour's name goes through moveView
   *  so the tap pushes or pops at one column (WEB_INTERFACE → The workspace). */
  private scrollByOneColumn(dir: -1 | 1): void {
    const cur = this.currentMemberIndex();
    const name = this.memberNameAt(cur + dir);
    if (name === null) return;
    this.moveView(name);
  }

  /** Bring the column holding a window into view — a no-op when it is already
   *  there, a whole-column jump when it is not, in either scroller
   *  (WEB_INTERFACE → The workspace → "The view moves to the column the reader
   *  acted on, by an instant scroll"). */
  private scrollColumnIntoView(uid: number): void {
    const region = this.panesEl.querySelector<HTMLElement>(`.region[data-uid="${uid}"]`);
    const col = region?.closest<HTMLElement>('.col');
    col?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    this.updateHeaderArrows();
  }

  // WEB_INTERFACE → The workspace → "At one column the screens are history"

  private sameScreen(a: string, b: string): boolean {
    if (a === 'feed' && b === 'feed') return true;
    const la = locate(this.state.workspace, a);
    const lb = locate(this.state.workspace, b);
    return la !== null && lb !== null && la.ci === lb.ci;
  }

  private memberNameAt(idx: number): string | null {
    if (this.oneColumn) {
      if (idx === 0) return 'feed';
      const col = this.state.workspace.columns[idx - 1];
      return col ? col.wins[col.focus] ?? null : null;
    }
    const col = this.state.workspace.columns[idx];
    return col ? col.wins[col.focus] ?? null : null;
  }

  private scrollToMember(name: string): void {
    if (name === 'feed') {
      this.feedEl.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      this.updateHeaderArrows();
    } else {
      const at = locate(this.state.workspace, name);
      if (at) this.scrollColumnIntoView(at.column.uid);
    }
  }

  /** Every tap that moves the view goes through moveView — at one column in
   *  workspace mode it decides whether to push, pop or scroll, at tiling it
   *  scrolls (WEB_INTERFACE → The workspace → "At one column the screens are
   *  history"). */
  private moveView(name: string): void {
    if (this.oneColumn && !this.standalone) {
      const s = history.state;
      const current: ScreenEntry | null = s && typeof s.member === 'string' ? s as ScreenEntry : null;
      const result = decideMove(current, name, (a, b) => this.sameScreen(a, b), 'tap');
      if (result.kind === 'push') {
        history.pushState(result.entry, '', location.href);
        this.lastDepth = result.entry.depth;
        this.scrollToMember(name);
      } else if (result.kind === 'back') {
        this.backInFlight = true;
        history.back();
      } else {
        this.scrollToMember(name);
      }
    } else {
      this.scrollToMember(name);
    }
  }

  /** The header arrows' `none` class and the left arrow's label, from the active
   *  scroller's position and the width class: an arrow with nothing that way carries
   *  `none` — hidden with its space reserved at tiling, absent at one column — the
   *  stylesheet drawing the difference (WEB_INTERFACE → The workspace). */
  private updateHeaderArrows(): void {
    const left = this.headerLeftArrow;
    const right = this.headerRightArrow;
    if (!left || !right) return;
    const scroller = this.activeScroller();
    const sl = scroller?.scrollLeft ?? 0;
    const max = scroller ? scroller.scrollWidth - scroller.clientWidth : 0;
    const EPS = 2;
    left.classList.toggle('none', !(sl > EPS));
    right.classList.toggle('none', !(sl < max - EPS));
    // At one column the feed is the first member, so the member left of column 0
    // is the feed itself.
    const prevIsFeed = this.oneColumn && scroller !== null && scroller.clientWidth > 0
      && Math.round(sl / scroller.clientWidth) === 1;
    left.setAttribute('aria-label', prevIsFeed ? 'show the feed' : 'show the column to the left');
  }

  /** The width class changed: the header prefix and arrows, and the panes' bars,
   *  follow it (WEB_INTERFACE → The workspace). */
  private onWidthClassChange(matches: boolean): void {
    this.oneColumn = matches;
    // WEB_INTERFACE → The workspace → "At one column the screens are history"
    if (matches && !this.standalone) {
      const name = this.memberNameAt(this.currentMemberIndex()) ?? 'feed';
      const s = history.state;
      const ours = s && typeof s.member === 'string';
      history.replaceState(
        { member: name, prev: ours ? s.prev : null, depth: ours ? s.depth : 0 },
        '', location.href,
      );
      this.lastDepth = ours ? (s.depth as number) : 0;
    }
    this.renderHeader();
    this.renderPanes();
  }

  private renderFeed(): void {
    if (this.standalone) return;
    this.withComposerFocus(() => {
      const top = this.feedEl.scrollTop;
      renderFeedInto(this.feedEl, this.state.feed, this.handlers, this.ctx());
      this.feedEl.scrollTop = top;
    });
  }

  /** Replace one card in the feed by post id — the like's optimistic press and its
   *  rejection re-render only the acted-on card so nothing else moves. */
  private renderFeedPost(postId: string): void {
    if (this.standalone) return;
    const post = this.state.feed.posts.find((p) => p.id === postId);
    if (!post) return;
    replaceFeedCard(this.feedEl, post, this.ctx(), this.handlers);
  }

  private renderPanes(): void {
    this.withComposerFocus(() => this.renderPanesBody());
  }

  private renderPanesBody(): void {
    const rebuild = (): void => {
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
    };
    // Both scrollers' horizontal position survives the rebuild — the panes at
    // tiling, the workspace at one column — so a structural rebuild never snaps the
    // strip to its left edge (WEB_INTERFACE → The workspace).
    const ws = this.workspaceEl;
    preservingScroll(this.panesEl, ws ? () => preservingScroll(ws, rebuild) : rebuild);
    this.updateHeaderArrows();
  }

  private locateRegion(uid: number): { column: Column; ci: number } | null {
    const ws = this.state.workspace;
    for (let ci = 0; ci < ws.columns.length; ci++) {
      const column = ws.columns[ci]!;
      if (column.uid === uid) return { column, ci };
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
    const newEl = renderRegionElement(found.column, found.ci, this.handlers, this.ctx());
    oldEl.replaceWith(newEl);
    const newBody = newEl.querySelector<HTMLElement>('.region-body');
    if (newBody) newBody.scrollTop = top;
  }

  /** Re-render every column currently focused on a given window. */
  private renderRegionsFor(windowId: string): void {
    for (const column of this.state.workspace.columns) {
      if (column.wins[column.focus] === windowId) this.renderRegion(column.uid);
    }
  }

  /** A thread's load updates its bar in every column holding it — in place, the
   *  body untouched — and re-renders the body only where the window is focused, so
   *  a selection or a scroll in a body focused elsewhere survives and a restored
   *  stack shows every excerpt as its thread lands (WEB_INTERFACE → The workspace). */
  private renderThreadLoad(id: string): void {
    if (this.standalone && this.state.workspace.columns[0]?.wins[0] === id) {
      this.updateStandaloneTitle(id);
    }
    this.state.workspace.columns.forEach((column, ci) => {
      if (!column.wins.includes(id)) return;
      if (column.wins[column.focus] === id) this.renderRegion(column.uid);
      else this.replaceBars(column, ci);
    });
  }

  /** Replace a column's bars in place from the current ctx, leaving its body. */
  private replaceBars(column: Column, ci: number): void {
    const region = this.panesEl.querySelector<HTMLElement>(`.region[data-uid="${column.uid}"]`);
    const oldBars = region?.querySelector<HTMLElement>('.bars');
    if (oldBars) oldBars.replaceWith(renderBars(column, ci, this.handlers, this.ctx()));
  }

  private structural(mutate: () => void): void {
    mutate();
    this.saveLayout();
    this.renderPanes();
  }

  // -------------------------------------------------------------------------
  // Row intake — the post index (author lookup for a pane's spine) and the
  // vouch-count cache: every rendered row carries its author's count, live or
  // withdrawn, so the cache fills as pages land, no per-author read
  // (WEB_INTERFACE → The identity display).
  // -------------------------------------------------------------------------

  private indexRows(rows: Array<PostJson | WithdrawnJson | null>): void {
    for (const row of rows) {
      if (!row) continue;
      if (!('kind' in row)) this.state.posts.set(row.id, row);
    }
  }

  /** Replace a post's row wherever the client holds it — the feed, every thread
   *  that contains it, the posts index, and any open @posts window — so the
   *  surface that re-renders next draws the node's row, not the stale one. */
  private applyFetchedRow(fetched: PostResult | null): void {
    if (!fetched || 'kind' in fetched) return;
    const id = fetched.id;
    this.state.posts.set(id, fetched);
    const fi = this.state.feed.posts.findIndex((p) => p.id === id);
    if (fi !== -1) this.state.feed.posts[fi] = fetched;
    for (const t of this.state.threads.values()) {
      if (t.root && !('kind' in t.root) && t.root.id === id) t.root = fetched;
      for (let i = 0; i < t.descendants.length; i++) {
        const d = t.descendants[i]!;
        if (!('kind' in d) && d.id === id) t.descendants[i] = fetched;
      }
    }
    for (const [, f] of this.authorPostsData) {
      const pi = f.posts.findIndex((p) => p.id === id);
      if (pi !== -1) f.posts[pi] = fetched;
    }
  }

  // -------------------------------------------------------------------------
  // Feed actions
  // -------------------------------------------------------------------------

  private async loadFeed(): Promise<void> {
    if (this.standalone) return;
    const feed = this.state.feed;
    feed.loading = true;
    feed.error = null;
    this.renderFeed();
    try {
      const res = await this.client.feed({ limit: FEED_LIMIT }, this.viewer(), undefined, true);
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
    if (this.standalone) return;
    const feed = this.state.feed;
    this.clearSettledFeed();
    await this.refreshTip(); // a ↻ re-reads the tip, so a held mark can re-enable
    try {
      // The reconnection paging lives in reconcileNewer; this fetches each page
      // and takes the mempool from page 0 (the only call with a null cursor).
      const r = await reconcileNewer(
        feed.posts,
        async (after) => {
          const res = await this.client.feed(after === null ? { limit: FEED_LIMIT } : { limit: FEED_LIMIT, after }, this.viewer(), undefined, true);
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
    if (this.standalone) return;
    const feed = this.state.feed;
    if (feed.next === null) return;
    feed.loading = true;
    this.renderFeed();
    try {
      const res = await this.client.feed({ limit: FEED_LIMIT, after: feed.next }, this.viewer(), undefined, true);
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

  // WEB_INTERFACE → The way into the workspace
  private async wayIn(): Promise<void> {
    const id = this.state.workspace.columns[0]?.wins[0];
    if (!id || !this.tabs) {
      this.toWorkspace(id ?? '');
      return;
    }
    const elsewhere = await this.tabs.heldElsewhere();
    if (elsewhere) {
      this.tabs.announce(id);
      const col = this.state.workspace.columns[0];
      if (col) { col.report = 'added to your workspace'; this.renderPanes(); }
      // WEB_INTERFACE → The way into the workspace — close only while the history
      // holds one entry, so the page never tries and fails.
      if (history.length === 1) window.close();
    } else {
      this.toWorkspace(id);
    }
  }

  private toWorkspace(id: string): void {
    this.standalone = false;
    this.workspaceEl?.classList.remove('standalone');
    this.restoreLayout();
    if (id) openWindow(this.state.workspace, id, { from: 'feed' });
    // WEB_INTERFACE → The way into the workspace — the lock is requested, never
    // awaited; the arrangement persists once it is granted.
    if (this.tabs) {
      void this.tabs.claim().then(() => {
        window.name = 'notis-workspace';
        this.saveLayout();
      });
      this.tabs.onOpen((tid) => {
        if (!this.tabs?.holds()) return;
        this.openThread(tid, { from: 'feed' });
      });
    }
    // WEB_INTERFACE → The workspace → "At one column the screens are history"
    const kept = history.state;
    const ours = kept && typeof kept.member === 'string';
    history.replaceState(
      { member: 'feed', prev: ours ? kept.prev : null, depth: ours ? kept.depth : 0 },
      '', this.base,
    );
    this.lastDepth = ours ? (kept.depth as number) : 0;
    document.title = 'Notis';
    this.renderHeader();
    this.renderFeed();
    this.renderPanes();
    void this.loadFeed();
    if (id) this.moveView(id);
    for (const wid of openSet(this.state.workspace)) {
      if (!isWin(wid) && !this.threadLoaded(wid)) void this.fetchThread(wid);
    }
  }

  // -------------------------------------------------------------------------
  // Window / workspace actions
  // -------------------------------------------------------------------------

  private standaloneReroot(id: string): void {
    this.state.workspace.columns[0]!.wins[0] = id;
    if (!this.threadLoaded(id)) void this.fetchThread(id);
    this.renderPanes();
    this.updateStandaloneTitle(id);
  }

  private openThread(id: string, origin: Origin): void {
    if (this.standalone) {
      if (this.state.workspace.columns[0]?.wins[0] === id) return;
      this.standaloneReroot(id);
      history.pushState({ id }, '', this.base + 'p/' + id);
      return;
    }
    const res = openWindow(this.state.workspace, id, origin);
    this.saveLayout();
    if (res.raised) {
      this.renderRegion(res.column.uid);
    } else {
      // A new window changed the structure, and the feed card flips to open.
      this.renderPanes();
      this.renderFeed();
      if (!isWin(id) && !this.threadLoaded(id)) void this.fetchThread(id);
    }
    this.moveView(id);
  }

  private openProfile(): void {
    const res = openWindow(this.state.workspace, '@profile', { from: 'feed' });
    this.saveLayout();
    if (res.raised) {
      this.renderRegion(res.column.uid);
    } else {
      this.renderPanes();
      // Read /karma for the loaded key when the window opens (WEB_INTERFACE → The
      // profile window); a raise just brings the existing window forward.
      void this.refreshProfileKarma();
    }
    this.moveView('@profile');
  }

  private focus(id: string): void {
    const column = focusWindow(this.state.workspace, id);
    if (column) {
      this.renderRegion(column.uid);
      this.moveView(id);
    }
    if (!isWin(id) && !this.threadLoaded(id)) void this.fetchThread(id);
  }

  /** A ← or → move rebuilds the strip and brings the window's new column into
   *  view (WEB_INTERFACE → The workspace). */
  private moveWindow(id: string, mutate: () => void): void {
    this.structural(mutate);
    this.moveView(id);
  }

  private closeWindow(id: string): void {
    // A ✕ that empties its column shows the column on its left, the feed when it
    // was column 0 (WEB_INTERFACE → The workspace). Capture the position first.
    const at = locate(this.state.workspace, id);
    const emptiedCi = at && at.column.wins.length === 1 ? at.ci : -1;
    closeWindow(this.state.workspace, id);
    this.saveLayout();
    this.renderPanes();
    this.renderFeed(); // a closed thread un-fades its feed card
    if (emptiedCi >= 0) {
      const ws = this.state.workspace;
      const target = emptiedCi > 0
        ? ws.columns[emptiedCi - 1]!.wins[ws.columns[emptiedCi - 1]!.focus] ?? 'feed'
        : 'feed';
      this.moveView(target);
    }
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
    this.renderThreadLoad(id);
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
    this.renderThreadLoad(id);
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

  private regionFocusedOn(id: string): Column | null {
    for (const column of this.state.workspace.columns) {
      if (column.wins[column.focus] === id) return column;
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
    this.withdrawFlights.clear();
    this.state.submissions = [];
    this.lastPolledHeight = 0;
    this.profileKarma = null;
    this.grantView = null;
    // The membership state is per identity: a second key never sees the first's
    // vouches, escrow or count cache (WEB_INTERFACE → The identity display).
    this.vouched.clear();
    this.escrowHeldUntil = null;
    this.optimisticVouches.clear();
    this.viewerTip = 0;
    this.authorData.clear();
    this.authorPostsData.clear();
    this.bondsView = null;
    this.inviteFlight = null;
    this.ownName = null;
    this.ownNameLoaded = false;
    this.usernameFlight = null;
    this.usernameInFlight = null;
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
      this.composers.get(key)?.setKarmaError("can't read your rep right now");
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
    this.renderFeedPost(postId);
    let result;
    try {
      result = await submitLikeFlow(this.submitDeps(), postId);
    } catch {
      this.optimisticLikes.delete(postId);
      this.setReportForPost(postId, "like rejected: can't reach the node right now.");
      this.renderRegionsForPost(postId);
      if (this.feedHasPost(postId)) this.renderFeed();
      return;
    }
    if (result.ok) {
      this.startPoll();
      return;
    }
    this.optimisticLikes.delete(postId);
    this.setReportForPost(postId, 'like rejected: ' + likeRejectionCopy(result.rejection));
    this.renderRegionsForPost(postId);
    if (this.feedHasPost(postId)) this.renderFeed();
  }

  /** Withdraw the reader's own post: the flight in the slot, then submit. On a 2xx
   *  the ledger's entry renders 'submitted' and the poll lands it; a rejection or a
   *  transport failure reports in the region line and returns the control, leaving
   *  nothing pending (WEB_INTERFACE → The withdraw control). */
  private async withdrawPost(postId: string): Promise<void> {
    const cur = this.idm.current();
    if (cur === null) return;
    // A second press is ignored while one is in flight or already pending.
    if (this.withdrawFlights.has(postId) || pendingWithdrawTargets(this.ledger.all()).has(postId)) return;
    this.withdrawFlights.set(postId, { stage: 'submitting' });
    this.renderRegionsForPost(postId);
    let result;
    try {
      result = await submitWithdrawFlow(this.submitDeps(), postId);
    } catch {
      this.withdrawFlights.delete(postId);
      this.setReportForPost(postId, "withdraw rejected: can't reach the node right now.");
      this.renderRegionsForPost(postId);
      return;
    }
    // Either way the transient flight steps aside: on ok the ledger's entry now
    // renders 'submitted'; on a rejection the control returns.
    this.withdrawFlights.delete(postId);
    if (result.ok) {
      this.startPoll();
    } else {
      this.setReportForPost(postId, 'withdraw rejected: ' + withdrawRejectionCopy(result.rejection));
    }
    this.renderRegionsForPost(postId);
  }

  /** A withdrawal landed: replace the post in place with the fetched withdrawn
   *  marker (WEB_INTERFACE → The withdraw control). In every open thread the row
   *  becomes the withdrawn card at its depth (the marker's parentRefs); the feed,
   *  the author-posts windows and the live-post index drop it. The client's own
   *  submission of the post is settled the same way, not left standing until the ↻:
   *  a root's leaves the feed, a reply's becomes the withdrawn card at its depth by
   *  joining every open thread that holds its parent, the count staying the node's
   *  (WEB_INTERFACE → The withdraw control, → The wallet). Returns whether the feed
   *  changed, the keys of the @posts windows that lost the row, and the parent ids
   *  whose regions the caller must re-render explicitly. */
  private applyWithdrawLanding(postId: string, fetched: PostResult | null): { feedChanged: boolean; postsKeys: string[]; touchParents: string[] } {
    const withdrawn = fetched !== null && 'kind' in fetched ? fetched : null;
    for (const t of this.state.threads.values()) {
      if (t.root && t.root.id === postId && withdrawn) t.root = withdrawn;
      if (withdrawn) t.descendants = t.descendants.map((r) => (r.id === postId ? withdrawn : r));
    }
    let feedChanged = this.state.feed.posts.some((p) => p.id === postId);
    this.state.feed.posts = this.state.feed.posts.filter((p) => p.id !== postId);
    this.state.feed.pending = this.state.feed.pending.filter((p) => p.id !== postId);
    // Any open @posts window that listed the row loses it; the caller re-renders
    // those windows, which renderRegionsForPosts skips (it re-renders threads only).
    const postsKeys: string[] = [];
    for (const [key, f] of this.authorPostsData) {
      if (f.posts.some((p) => p.id === postId) || f.pending.some((p) => p.id === postId)) postsKeys.push(key);
      f.posts = f.posts.filter((p) => p.id !== postId);
      f.pending = f.pending.filter((p) => p.id !== postId);
    }
    this.state.posts.delete(postId); // the live-post index holds live rows only

    // The client's own submission of the withdrawn post is settled here, sooner
    // than the ↻ (WEB_INTERFACE → The withdraw control). A root's drop is a feed
    // change. A reply's becomes the withdrawn card at its depth by joining the
    // descendants of every open thread that holds its parent, where the marker is
    // not already a row — a route that listed the reply as a real row replaced it
    // above; the caller's touch of the withdrawn id then reaches those threads,
    // since each now contains it.
    const sub = this.state.submissions.find((s) => s.postId === postId);
    const touchParents: string[] = [];
    if (sub) {
      if (sub.parentId === null) feedChanged = true;
      else if (withdrawn) {
        for (const t of this.state.threads.values()) {
          if (this.threadContains(t.id, sub.parentId) && !t.descendants.some((r) => r.id === postId)) {
            t.descendants = [...t.descendants, withdrawn];
          }
        }
      } else touchParents.push(sub.parentId);
      this.state.submissions = this.state.submissions.filter((s) => s.postId !== postId);
    }
    return { feedChanged, postsKeys, touchParents };
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
      return { kind: 'reason', text: `vouching needs ${VOUCH_MIN_BALANCE} rep held` };
    }
    const v = this.vouched.get(key);
    if (v) return { kind: 'vouched', sinceBlock: v.createdAtBlock, cooldownBlocks };
    if (this.optimisticVouches.has(key) || pendingVouchTargets(this.ledger.all()).has(key)) return { kind: 'pending' };
    return { kind: 'plus', cooldownBlocks };
  }

  /** Read the reader's membership state — /karma (member, the floor, the tip), the
   *  vouch set, and the escrow — at identity load and the profile's ↻
   *  (WEB_INTERFACE → The identity display). */
  private async loadMembershipState(): Promise<void> {
    const cur = this.idm.current();
    if (cur === null) return;
    try {
      const [karma, status, vouched, escrow, bonds, ownName] = await Promise.all([
        this.client.karma(cur.pubKeyHex),
        this.client.status(),
        this.readVouchSet(cur.pubKeyHex),
        this.readEscrow(cur.pubKeyHex),
        this.client.bonds(cur.pubKeyHex),
        this.client.usernameByOwner(cur.pubKeyHex),
      ]);
      this.profileKarma = karma;
      this.state.status = status; // vouchCooldownBlocks + the bond range for the invites row
      this.bumpTip(status.blockHeight);
      this.bumpTip(karma.height);
      this.vouched = vouched;
      this.escrowHeldUntil = escrow;
      this.bondsView = bonds;
      this.ownName = ownName;
      this.ownNameLoaded = true;
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

  // ---- vouch, from the author window (WEB_INTERFACE → The author window) ----

  private async vouch(key: string): Promise<void> {
    const cur = this.idm.current();
    if (cur === null || this.optimisticVouches.has(key) || this.vouched.has(key)) return;
    this.optimisticVouches.add(key);
    const d = this.authorData.get(key);
    if (d) d.flight = { stage: 'submitting' };
    this.renderRegionsFor(authorWindowId(key));
    let result;
    try {
      result = await submitVouchFlow(this.submitDeps(), key);
    } catch {
      this.optimisticVouches.delete(key);
      if (d) d.flight = { stage: 'rejected', reason: "vouch rejected: can't reach the node right now." };
      this.renderRegionsFor(authorWindowId(key));
      return;
    }
    if (result.ok) {
      this.optimisticVouches.delete(key);
      if (d) d.flight = { stage: 'submitted' };
      this.startPoll();
    } else {
      this.optimisticVouches.delete(key);
      if (d) d.flight = { stage: 'rejected', reason: 'vouch rejected: ' + vouchRejectionCopy(result.rejection) };
    }
    this.renderRegionsFor(authorWindowId(key));
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


  /** Re-render the feed and the panes whose focused surface shows this author —
   *  a card by them, or their author/posts window. The mark changes glyph in a
   *  fixed slot, so geometry holds (HOUSE_STYLE → Motion). */
  private renderRegionsForAuthor(key: string): void {
    if (this.feedHasAuthor(key)) this.renderFeed();
    for (const column of this.state.workspace.columns) {
      const fk = column.wins[column.focus];
      if (fk === undefined) continue;
      const sub = windowSubject(fk);
      if ((sub && sub.key === key) || (!isWin(fk) && this.threadHasAuthor(fk, key))) this.renderRegion(column.uid);
    }
  }

  private feedHasPost(id: string): boolean {
    return this.state.feed.posts.some((p) => p.id === id);
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
    if (!this.authorData.has(key)) this.authorData.set(key, { karma: null, endorsers: null, endorsersNext: false, flight: null, username: null, usernameLoaded: false });
    return key;
  }

  private ensurePostsData(key: string): string {
    if (!this.authorPostsData.has(key)) this.authorPostsData.set(key, emptyFeedState());
    return key;
  }

  private openAuthor(key: string, origin: Origin): void {
    const wid = authorWindowId(key);
    const res = openWindow(this.state.workspace, wid, origin);
    this.saveLayout();
    this.ensureAuthorData(key);
    if (res.raised) this.renderRegion(res.column.uid);
    else this.renderPanes();
    this.moveView(wid);
    void this.loadAuthorData(key);
  }

  private async loadAuthorData(key: string): Promise<void> {
    const d = this.authorData.get(key);
    if (!d) return;
    try {
      const [karma, endorsers, username] = await Promise.all([this.client.karma(key), this.client.vouchesByTarget(key), this.client.usernameByOwner(key)]);
      d.karma = karma;
      d.endorsers = endorsers;
      d.endorsersNext = endorsers.next !== null;
      d.username = username;
      d.usernameLoaded = true;
      this.bumpTip(karma.height);
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
    const wid = postsWindowId(key);
    const res = openWindow(this.state.workspace, wid, origin);
    this.saveLayout();
    this.ensurePostsData(key);
    if (res.raised) this.renderRegion(res.column.uid);
    else this.renderPanes();
    this.moveView(wid);
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
      const column = this.state.workspace.columns[ci]!;
      if (column.wins[column.focus] === '@profile') return { from: 'pane', ci };
    }
    return { from: 'feed' };
  }

  // ---- username, from the profile's username row (WEB_INTERFACE → The username row) ----

  private async claimUsername(name: string): Promise<void> {
    const cur = this.idm.current();
    if (cur === null) return;
    this.usernameInFlight = { kind: 'claim', name };
    this.usernameFlight = { stage: 'submitting' };
    this.renderUsernameRowInPlace();
    let result;
    try {
      result = await submitClaimFlow(this.submitDeps(), name);
    } catch {
      this.usernameInFlight = null;
      this.usernameFlight = { stage: 'rejected', reason: "claim rejected: can't reach the node right now." };
      this.renderUsernameRowInPlace();
      return;
    }
    this.usernameInFlight = null;
    if (result.ok) {
      this.usernameFlight = null;
      this.startPoll();
    } else {
      this.usernameFlight = { stage: 'rejected', reason: 'claim rejected: ' + usernameRejectionCopy(result.rejection) };
    }
    this.renderUsernameRowInPlace();
  }

  private async burnUsername(): Promise<void> {
    const cur = this.idm.current();
    if (cur === null) return;
    const name = this.ownName?.name;
    if (!name) return;
    this.usernameInFlight = { kind: 'burn', name };
    this.usernameFlight = { stage: 'submitting' };
    this.renderUsernameRowInPlace();
    let result;
    try {
      result = await submitBurnFlow(this.submitDeps());
    } catch {
      this.usernameInFlight = null;
      this.usernameFlight = { stage: 'rejected', reason: "burn rejected: can't reach the node right now." };
      this.renderUsernameRowInPlace();
      return;
    }
    this.usernameInFlight = null;
    if (result.ok) {
      this.usernameFlight = null;
      this.startPoll();
    } else {
      this.usernameFlight = { stage: 'rejected', reason: 'burn rejected: ' + usernameRejectionCopy(result.rejection) };
    }
    this.renderUsernameRowInPlace();
  }

  private renderUsernameRowInPlace(): void {
    const field = document.querySelector<HTMLElement>('.username-field');
    if (field) renderUsernameRow(field, this.handlers, this.ctx());
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
    const postsWindowsTouched = new Set<string>(); // @posts windows a withdrawal landing emptied a row from

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
        const vd = this.authorData.get(entry.postId);
        if (vd) vd.flight = outcome === 'expired' ? { stage: 'expired', expiresAtHeight: entry.expiresAtHeight } : null;
        touchedAuthors.add(entry.postId);
        continue;
      }
      if (entry.kind === 'unvouch') {
        const outcome = reconcileUnvouch(entry, vouchRows, tip);
        if (outcome === 'pending') continue;
        this.ledger.remove(entry.txId);
        const d = this.authorData.get(entry.postId);
        if (d) d.flight = null;
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
      if (entry.kind === 'claim' || entry.kind === 'burn') {
        if (cur === null) continue;
        const held = await this.client.usernameByOwner(cur.pubKeyHex);
        const outcome = entry.kind === 'claim' ? reconcileClaim(entry, held, tip) : reconcileBurn(entry, held, tip);
        if (outcome === 'pending') continue;
        this.ledger.remove(entry.txId);
        if (outcome === 'landed') {
          this.ownName = held;
          this.ownNameLoaded = true;
          this.usernameFlight = null;
          if (cur !== null) this.profileKarma = await this.client.karma(cur.pubKeyHex);
        } else {
          this.usernameFlight = {
            stage: 'expired',
            expiresAtHeight: entry.expiresAtHeight,
            onTryAgain: entry.kind === 'claim'
              ? () => { this.usernameFlight = null; void this.claimUsername(entry.postId); }
              : () => { this.usernameFlight = null; void this.burnUsername(); },
          };
        }
        this.renderUsernameRowInPlace();
        this.renderHeader();
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
      } else if (entry.kind === 'like') {
        const outcome = reconcileLike(entry, fetched, tip);
        if (outcome === 'pending') continue;
        this.optimisticLikes.delete(entry.postId);
        this.ledger.remove(entry.txId);
        if (outcome === 'expired') this.setReportForPost(entry.postId, 'a like expired before any block took it');
        if (outcome === 'landed') this.applyFetchedRow(fetched);
        touchedPosts.add(entry.postId);
        if (this.feedHasPost(entry.postId)) feedTouched = true;
      } else {
        // withdraw — landed on any tombstone, the row replaced in place; expired
        // renders the sentence and `try again` (WEB_INTERFACE → The withdraw control).
        const outcome = reconcileWithdraw(entry, fetched, tip);
        if (outcome === 'pending') continue;
        this.ledger.remove(entry.txId);
        if (outcome === 'landed') {
          const landing = this.applyWithdrawLanding(entry.postId, fetched);
          if (landing.feedChanged) feedTouched = true;
          for (const key of landing.postsKeys) postsWindowsTouched.add(key);
          for (const parent of landing.touchParents) touchedPosts.add(parent);
        } else {
          this.withdrawFlights.set(entry.postId, {
            stage: 'expired',
            expiresAtHeight: entry.expiresAtHeight,
            onTryAgain: () => { this.withdrawFlights.delete(entry.postId); void this.withdrawPost(entry.postId); },
          });
        }
        touchedPosts.add(entry.postId);
      }
    }
    // A landed card changes colour and nothing else; the geometry is identical.
    if (feedTouched) this.renderFeed();
    this.renderRegionsForPosts(touchedPosts);
    for (const key of touchedAuthors) this.renderRegionsForAuthor(key);
    // A withdrawal landing empties a row from an open @posts window; renderRegionsForPosts
    // skips windows, so re-render those windows explicitly (WEB_INTERFACE → The withdraw control).
    for (const key of postsWindowsTouched) this.renderRegionsFor(postsWindowId(key));
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
    for (const column of this.state.workspace.columns) {
      const fk = column.wins[column.focus];
      if (fk !== undefined && !isWin(fk) && wanted.some((p) => this.threadContains(fk, p))) {
        this.renderRegion(column.uid);
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
    if (this.feedHasPost(postId)) this.state.feed.report = text;
    for (const column of this.state.workspace.columns) {
      const fk = column.wins[column.focus];
      if (fk !== undefined && !isWin(fk) && this.threadContains(fk, postId)) column.report = text;
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
