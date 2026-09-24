import { NodeClient, type Api } from './api/client';
import type { PostJson, WithdrawnJson, FeedRow, FeedResult, PostResult, ThreadResult, KarmaResult, BondsResult, CreditsResult, UsernameResult } from './api/dto';
import { POST_PRICE_THREAD, POST_PRICE_REPLY, VOUCH_MIN_BALANCE, USERNAME_BURN_PRICE } from '@dagsocial/types';
import type { Mode } from './mode';
import type { Tabs } from './tabs';
import { el, shortHex, preservingScroll } from './dom';
import { contentHashHex } from './integrity';
import { prefs, setTheme, setIdTint, setNode, writeStore, readStore, BUILD_NODES, BUILD_PUBLIC, KEY_LAYOUT, KEY_NODE, type Theme, type IdTint } from './prefs';
import { renderFeedInto, replaceFeedCard } from './view/feed';
import { renderPanesInto, renderRegionElement, renderBars } from './view/panes';
import { makeComposer, type ComposerController } from './view/composer';
import { personGlyph, sunGlyph, moonGlyph, gearGlyph, walletGlyph } from './view/glyphs';
import { MARK } from './view/mark';
import { serialise, parse, authorWindowId, postsWindowId, windowSubject } from './model/arrangement';
import { reconcileNewer, isLivePost } from './model/feed-reconcile';
import { flattenThread } from './model/thread';
import { WriteClient, type Rejection } from './api/write';
import { FaucetClient, faucetLine } from './api/faucet';
import {
  PendingLedger, reconcilePost, reconcileLike, reconcileGrant, reconcileVouch, reconcileUnvouch, reconcileInvite, reconcileWithdraw,
  reconcileClaim, reconcileBurn, reconcileSend, reconcileCreditGrant, pendingUsernameEntry, pendingSendEntries,
  pendingLikeTargets, pendingVouchTargets, pendingWithdrawTargets,
} from './wallet/ledger';
import type { PendingEntry, EntryOutcome } from './wallet/types';
import { readBuildContext } from './wallet/reads';
import { submitPostFlow, submitLikeFlow, submitVouchFlow, submitUnvouchFlow, submitInviteFlow, submitWithdrawFlow, submitClaimFlow, submitBurnFlow, submitSendFlow, type SubmitDeps } from './wallet/submit';
import { identity as identitySingleton } from './identity/identity';
import { renderKarmaField, renderInvitesRow, renderUsernameRow } from './view/profile';
import { renderCreditsRow, resetCreditsSendForm, type ResolvedRecipient } from './view/wallet';
import { cornerState, renderCorner, CORNER_POLL_MS, type CornerState } from './view/corner';
import type { TipVerdict } from './model/tip-verdict';
import { namePair, nameIsClay, recipientVerdict } from './model/name-verdict';
import { markHandle, landNameClay } from './view/name-handle';
import type { Anchor } from './model/state';
import type { Listing, NameResult } from '@dagsocial/nipopow-client';
import type { Flight } from './view/card';
import type { YourVouch } from './view/author';
import {
  newColumn, newWorkspace, openWindow, closeWindow, moveLeft, moveRight, focusWindow, openSet, locate,
  type Origin, type Column,
} from './model/workspace';
import {
  FEED_COMPOSER_KEY, type AppState, type ThreadState, type RenderCtx, type Handlers, type Submission,
  type FlightStage, type AppIdentity, type AuthorWindowData, type FeedState, type FiguresView,
  type TipVerifier, type TipRun, type FiguresVerifier, type NamesVerifier,
} from './model/state';
import { decideMove, type ScreenEntry } from './history';

const FEED_LIMIT = 30;
const THREAD_LIMIT = 50;
const REFRESH_PAGE_CAP = 40; // a refresh re-reads a whole thread; this bounds the loop
const POLL_MS = 15000;       // the bounded landing poll, only while own submissions are pending
const FEED_COMPOSER = FEED_COMPOSER_KEY;
/** The verifier's own cadence — every ten minutes while the tab is visible; a
 *  tab that becomes visible again runs one only when none has returned yet or
 *  the last began this long ago or more (WEB_INTERFACE → The extension →
 *  "The verified tip"). */
const VERIFY_INTERVAL_MS = 600_000;
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

/** A notSigned reason mapped to what the region shows (WEB_INTERFACE → The
 *  wallet, "the fourth ending is the composer still open"). `locked` reports
 *  the race directly; the extension's `busy` refusal reads *"one approval at a
 *  time."*; a `declined` reads *"<action> not sent."*; every other `refused`
 *  carries its reason — *"<action> not sent: <reason>."*. The trailing period
 *  of the reason is stripped before the template — the in-page module's
 *  *"…64 hex characters."* would otherwise render *"…characters.."*. */
function notSignedCopy(kind: 'locked' | 'declined' | 'refused', reason: string, action: string): string {
  if (kind === 'locked') return 'your key is locked';
  if (reason === 'busy') return 'one approval at a time.';
  if (kind === 'refused') return `${action} not sent: ${reason.replace(/\.$/, '')}.`;
  return `${action} not sent.`;
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

/** The rows a ↻ lands on. One that reconnected puts its new rows on top of the
 *  rows standing as it lands, deduped, so a landing or a `more` that wrote
 *  during its pages keeps what it wrote; one that never reconnected answers its
 *  own window, and its cursor with it (reconcileNewer). */
function landRefresh(standing: PostJson[], r: { posts: PostJson[]; next: string | null | undefined; newCount: number }): PostJson[] {
  if (r.next !== undefined) return r.posts;
  const fresh = r.posts.slice(0, r.newCount);
  const have = new Set(fresh.map((p) => p.id));
  return [...fresh, ...standing.filter((p) => !have.has(p.id))];
}

/** When a read of the reader's own listing began: the anchor sequence then, and
 *  whether an anchor stood. A run proves a listing read after its anchor and
 *  never one read before it (WEB_INTERFACE → The extension → "The verified
 *  figures"). */
interface ListingStamp {
  seq: number;
  anchored: boolean;
}

/** The pieces of the reader's own state, each held with the order the read that
 *  answered it began in: the two listings, /status, the vouch set with its
 *  escrow, the bonds and the reader's own name. */
type ReaderPiece = 'karma' | 'credits' | 'status' | 'vouches' | 'bonds' | 'name';

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
  // The status corner (WEB_INTERFACE → The status corner) — a timer independent
  // of the bounded landing poll, mounted once as a fixed element and driven
  // while the tab is visible.
  private cornerEl: HTMLButtonElement | null = null;
  private cornerTimer: ReturnType<typeof setInterval> | null = null;
  private cornerLastTip: number | null = null;
  private cornerLastRiseAt: number | null = null;
  private cornerLastReadOk: boolean | null = null;
  // A change of the reading node bumps `cornerGen`; a `cornerTick` captures
  // it at the top and drops its answer when a later change has moved it, so
  // an in-flight read never writes the node before's height back into
  // `cornerLastTip` (WEB_INTERFACE → The status corner).
  private cornerGen = 0;
  private cornerVisHandler: (() => void) | null = null;
  // The verified tip (WEB_INTERFACE → The extension → "The verified tip") —
  // the extension build hands in a verifier; the web build hands in none, and
  // the corner reads the first paragraph of the status corner, word for word.
  // The verdict is `undefined` with no verifier and `null` until the first run
  // returns; a run in flight is dropped by a later generation.
  private verifier: TipVerifier | null;
  private tipVerdict: TipVerdict | null | undefined;
  // The reading node's own verified headers (WEB_INTERFACE → The extension →
  // "The verified figures"). Non-null when and only when tipVerdict is
  // `verified`; every other verdict — and every run before its first return —
  // leaves this null. Written beside tipVerdict, cleared beside it, and read by
  // startFigures when a run has an identity, an anchor and a listing.
  private tipAnchor: Anchor | null = null;
  // Moves each time a run writes a non-null anchor. A read of the reader's own
  // listing captures it as the read begins (listingStamp), so a listing read
  // before the anchor it would be proven against is told apart from one read
  // after it (WEB_INTERFACE → The extension → "The verified figures").
  private anchorSeq = 0;
  private verifyTimer: ReturnType<typeof setInterval> | null = null;
  private lastVerifyBeganAt: number | null = null;
  private verifyInFlight = false;
  private verifyGen = 0;
  // The presses waiting on the run in flight — a send to a handle that needs a
  // fresh anchor (WEB_INTERFACE → The extension → "The verified names"). The
  // run's end settles each with its verdict and anchor; a run that ends without
  // a verdict, or that a node change drops, settles each with null.
  private tipRunWaiters: Array<(run: TipRun | null) => void> = [];
  // The verified figures (WEB_INTERFACE → The extension → "The verified
  // figures") — the seam runs proveFigures over the App's own listing and
  // hands the reading node's verified headers on. Non-null only in the
  // extension build; single flight, marks one more run when a trigger fires
  // during one, drops a result whose listing or generation has moved.
  private figuresVerifier: FiguresVerifier | null;
  private figures: FiguresView | null = null;
  private figuresGen = 0;
  private figuresInFlight = false;
  private figuresDirty = false;
  // The loaded key's /karma with the stamp its read began under — read at
  // identity load, the profile window's open and its ↻, every landing of the
  // reader's own transaction and, in the extension, every verified tip — and a
  // faucet grant in flight or one that lapsed; both feed the profile window's ctx.
  private profileKarma: KarmaResult | null = null;
  private profileKarmaStamp: ListingStamp | null = null;
  private grantView: { state: 'pending' } | { state: 'expired'; atHeight: number } | null = null;
  // The reader's own state is what the node answers for the loaded key; an
  // identity change and a change of the reading node drop it whole
  // (dropReaderState) and move the generation. Every read of it captures the
  // generation before its first await and writes nothing once it has moved, so
  // an answer for the node or the key before never lands after the drop
  // (WEB_INTERFACE → The settings window, → The identity module). The feed,
  // thread and author-posts reads capture it as well: a node change drops their
  // rows, and an identity change reads them again with the new viewer.
  private readerGen = 0;
  // The order reads of the reader's own state began in, and for each piece of it
  // the read whose answer it holds: an answer whose read began before the held
  // answer's read never replaces it, whichever lands last. The anchor stamp
  // decides what a figures run may prove; this decides which answer a row holds.
  // dropReaderState forgets the held reads with the answers.
  private readsBegun = 0;
  private heldRead = new Map<ReaderPiece, number>();
  // The posts whose withdrawal the client has seen land, each with the marker
  // the landing read. A withdrawal is final, the author's one act over a post
  // (ARCHITECTURE → Withdrawal), so an answer that shows one of these live is
  // older than the landing, whatever it is: every write of rows keeps such a
  // root out of a list and renders such a reply as its withdrawn card
  // (WEB_INTERFACE → The withdrawn state). Kept across a node or an identity
  // change, bounded by the session's own withdrawals.
  private withdrawnSeen = new Map<string, WithdrawnJson>();
  // A like's landing is not final: it stamps the row it wrote with the order it
  // landed in, and a read that began before it keeps that row over its answer's
  // (keeper).
  private landings = 0;
  private landedAt = new WeakMap<FeedRow, number>();
  // Membership state (WEB_INTERFACE → The identity display). The reader's vouch
  // set read from the node, the escrow gate, the optimistic overlay before a
  // vouch's 2xx, the tip the gates read, and the two window kinds' data. The
  // overlay is the reader's own act and drops with the identity alone; the rest
  // is the node's answer and drops with the reader's own state.
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
  // The verified names (WEB_INTERFACE → The extension → "The verified names") —
  // one check's result per key and name, held under namePair. Every handle on
  // screen reads it through nameClay; a pair with no result reads as it reads
  // without a verifier.
  private nameChecks = new Map<string, NameResult>();
  // The seam runs proveName over one pair on screen against the anchor
  // standing; non-null only in the extension build. One batch in flight, its
  // pairs checked one after another; a trigger during a batch marks one more,
  // `every` over `new`. A node change drops every result and moves the
  // generation, which drops a batch in flight at its next answer; an identity
  // change keeps them — a name's check reads no identity. nameRunAsked holds
  // once a check that ended `unchecked` has asked for its one tip run, until a
  // run no check asked for begins.
  private namesVerifier: NamesVerifier | null;
  private namesGen = 0;
  private namesInFlight = false;
  private namesMarked: 'new' | 'every' | null = null;
  private nameRunAsked = false;
  private usernameFlight: Flight | null = null;
  private usernameInFlight: { kind: 'claim' | 'burn'; name: string } | null = null;
  // The wallet window (WEB_INTERFACE → The wallet window). walletCredits is the
  // reader's own /credits with the stamp its read began under, read at the
  // wallet open, the wallet's ↻, an identity or node change and a verified tip
  // while the wallet is open, and each landing that moves the balance;
  // creditGrantView is a faucet transfer in flight or one that lapsed; sendFlight
  // is the transient ending for the row (the pending state lives in the ledger).
  private walletCredits: CreditsResult | null = null;
  private walletCreditsStamp: ListingStamp | null = null;
  private creditGrantView: { state: 'pending' } | { state: 'expired'; atHeight: number } | null = null;
  private sendFlight: Flight | null = null;

  // Optional in the extension build — the App's own hook, called synchronously
  // from `askFaucet` / `askFaucetCredits` before any await, so the browser's
  // user-input window is still open when the permission request leaves
  // (WEB_INTERFACE → The faucet step → "In the extension the press asks the
  // browser for the faucet's origin first"). Absent on the web build.
  private readonly requestFaucetOrigin: ((origin: string) => Promise<boolean>) | null;

  // Every dependency is injectable so a test can drive the App over fakes.
  constructor(
    client?: Api,
    writeClient?: WriteClient,
    identity?: AppIdentity,
    ledger?: PendingLedger,
    tabs?: Tabs,
    requestFaucetOrigin?: (origin: string) => Promise<boolean>,
    verifier?: TipVerifier | null,
    figuresVerifier?: FiguresVerifier | null,
    namesVerifier?: NamesVerifier | null,
  ) {
    this.client = client ?? new NodeClient(() => prefs.node);
    this.writeClient = writeClient ?? new WriteClient(() => prefs.node);
    this.idm = identity ?? identitySingleton;
    this.faucetClient = new FaucetClient(() => prefs.faucet);
    this.requestFaucetOrigin = requestFaucetOrigin ?? null;
    this.verifier = verifier ?? null;
    this.figuresVerifier = figuresVerifier ?? null;
    this.namesVerifier = namesVerifier ?? null;
    // With no verifier the verdict stays `undefined` — the corner reads the
    // first paragraph of the status corner, word for word (WEB_INTERFACE →
    // The status corner, → The extension → "The verified tip").
    this.tipVerdict = this.verifier === null ? undefined : null;
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
      openSettings: () => this.openSettings(),
      openWallet: () => this.openWallet(),
      refreshProfile: () => void this.refreshProfileKarma(),
      refreshWallet: () => void this.refreshWalletCredits(),
      focus: (id) => this.focus(id),
      refreshThread: (id) => void this.refreshThread(id),
      threadMore: (id) => void this.threadMore(id),
      moveLeft: (id) => this.moveWindow(id, () => moveLeft(this.state.workspace, id)),
      moveRight: (id) => this.moveWindow(id, () => moveRight(this.state.workspace, id)),
      close: (id) => this.closeWindow(id),
      setTheme: (t) => this.changeTheme(t),
      setIdTint: (m) => this.changeIdTint(m),
      setNode: (origin) => void this.changeNode(origin),
      inspectFile: (text) => this.idm.inspectFile(text),
      draftIdentity: () => this.idm.draft(),
      createIdentity: async (p) => { await this.idm.create(p); },
      discardDraft: () => this.idm.discardDraft(),
      importIdentity: async (text, p) => { await this.idm.importFile(text, p); },
      exportIdentity: (p) => this.exportIdentity(p),
      forgetIdentity: () => this.idm.forget(),
      lockIdentity: async () => { await this.idm.lock(); this.renderRegionsFor('@profile'); },
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
      // The wallet's send row (WEB_INTERFACE → The wallet window → "The `send`
      // row"). resolveRecipient is the handle → holder read the form runs at
      // the press; send is the credits transfer flow; askFaucetCredits is the
      // faucet's $NOTIS step (→ The faucet step).
      resolveRecipient: (name) => this.resolveRecipient(name),
      send: (toHex, toName, amount) => void this.send(toHex, toName, amount),
      askFaucetCredits: () => void this.askFaucetCredits(),
      // The extension's identity exposes both policy and setPolicy; the in-page
      // module implements neither, and the profile row renders only when both
      // are present (WEB_INTERFACE → The profile window). setPolicy re-renders
      // the profile after the proxy's snapshot refreshes, so the row's pressed
      // state moves without waiting on the next unrelated draw.
      ...(this.idm.policy && this.idm.setPolicy
        ? {
            policy: () => this.idm.policy!(),
            setPolicy: async (p) => { await this.idm.setPolicy!(p); this.renderRegionsFor('@settings'); },
          }
        : {}),
      // The extension's identity exposes both links and setLinks when the
      // build's `notis-public` is not empty; the in-page module implements
      // neither, and the settings row renders only when both are present
      // (WEB_INTERFACE → The settings window, → The extension → "Links into the extension").
      ...(this.idm.links && this.idm.setLinks
        ? {
            links: () => this.idm.links!(),
            setLinks: async (v) => { await this.idm.setLinks!(v); this.renderRegionsFor('@settings'); },
          }
        : {}),
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
    // The status corner mounts once, fixed to the viewport, in the workspace and
    // the standalone mode alike (WEB_INTERFACE → The status corner).
    this.mountCorner();
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
    // A restored identity's own state and a restored arrangement's windows — the
    // membership state, a @wallet's listing, an @author/@posts window's data: a
    // window restored at boot has opened, and reads as it does on a press.
    this.rereadReaderState();
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
      nameClay: (key, name) => this.nameClay(key, name),
      usernameFlight: this.usernameFlight,
      pendingUsername: this.usernameInFlight ?? pendingUsernameEntry(this.ledger.all()),
      canSignClaim: this.canSignWithdraw(), // same predicate — a spendable box
      canAffordBurn: this.canAffordBurn(),
      // The wallet's balance row (WEB_INTERFACE → The wallet window → "The
      // `balance` row"). status carries the tip the row's spendable-at-height
      // filter reads (WEB_INTERFACE → The wallet).
      status: this.state.status,
      credits: this.walletCredits,
      creditGrant: this.creditGrantView,
      sendFlight: this.sendFlight,
      pendingSend: pendingSendEntries(this.ledger.all())[0] ?? null,
      // The web build's identity module has no `policy`; the extension's proxy
      // has (WEB_INTERFACE → The profile window). `!this.idm.policy` is
      // therefore the same predicate the sign-each-rep-action row renders on:
      // the confirm row stands where policy is absent, and yields to the
      // prompt where policy is defined.
      confirmInRow: !this.idm.policy,
      // The extension's tip verifier's latest verdict — undefined without a
      // verifier, null while none has returned, else the corner's own value.
      // The pure `figuresLine` reads it for rows 1 and 3 (WEB_INTERFACE →
      // The extension → "The verified figures"). `figures` stands beside it
      // — the latest verified-figures run's result, held with the anchor it
      // was proven against; null until a run has returned for the identity,
      // anchor and listing the App now holds.
      verdict: this.tipVerdict,
      figures: this.figures,
      // notis-public names the origin + base a shareable link should carry;
      // empty means the current location, which is the web build's default
      // (WEB_INTERFACE → "The client is served from the node's own origin").
      linkUrl: (id) => BUILD_PUBLIC !== ''
        ? BUILD_PUBLIC + 'p/' + id
        : new URL(this.base + 'p/' + id, location.href).href,
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

  /** Whether the handle a key and a name render as reads clay — the check held
   *  for the pair, ink while none has decided it (WEB_INTERFACE → The extension
   *  → "The verified names"). */
  private nameClay(key: string, name: string): boolean {
    return nameIsClay(this.nameChecks.get(namePair(key, name)));
  }

  private renderHeader(): void {
    const bar = this.appbar;
    bar.textContent = '';

    if (this.standalone) {
      this.renderStandaloneHeader(bar);
      return;
    }
    // One header element serves both bars — set on the workspace render, cleared
    // on the standalone one, so the width-class rule that hides the workspace
    // wordmark leaves the standalone one alone (WEB_INTERFACE → The workspace
    // → "What differs at one column, and nothing else does", → The standalone
    // thread → "The header"). The name is not `.workspace`: that class owns the
    // strip scroller (`header` type would lose to it and the bar would grow).
    bar.classList.add('hdr-workspace');

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

    // The profile, wallet, settings and theme controls. At one column the
    // workspace carries no theme control — the theme is the settings window's
    // first row (WEB_INTERFACE → The workspace, → The settings window); the
    // three glyphs are a person, a wallet and a gear, inline SVG in currentColor
    // drawn in the house technique (HOUSE_STYLE → Illustration). At tiling
    // `profile`, `wallet` and `settings` wear one outlined class — .hdr-word —
    // beside the filled `theme` word; no avatar and no identity colour
    // (WEB_INTERFACE → The profile window; HOUSE_STYLE → Identity colour).
    const target: Theme = prefs.theme === 'dark' ? 'light' : 'dark';
    if (this.oneColumn) {
      const profile = el('button', 'hdr-glyph');
      profile.setAttribute('aria-label', 'open profile');
      profile.appendChild(personGlyph());
      profile.addEventListener('click', () => this.openProfile());
      bar.appendChild(profile);

      const wallet = el('button', 'hdr-glyph');
      wallet.setAttribute('aria-label', 'open wallet');
      wallet.appendChild(walletGlyph());
      wallet.addEventListener('click', () => this.openWallet());
      bar.appendChild(wallet);

      const settings = el('button', 'hdr-glyph');
      settings.setAttribute('aria-label', 'open settings');
      settings.appendChild(gearGlyph());
      settings.addEventListener('click', () => this.openSettings());
      bar.appendChild(settings);
    } else {
      const cur = this.idm.current();
      const profile = el('button', 'hdr-word');
      if (cur === null) {
        profile.textContent = 'profile';
      } else if (this.ownName) {
        profile.style.fontWeight = '600';
        profile.textContent = '@' + this.ownName.name;
        // In the extension a handle the chain does not back is clay — the text
        // alone, the same control (WEB_INTERFACE → The identity display).
        if (this.nameClay(cur.pubKeyHex, this.ownName.name)) profile.classList.add('clay');
        markHandle(profile, cur.pubKeyHex, this.ownName.name);
      } else {
        profile.style.fontFamily = 'var(--mono)';
        profile.textContent = shortHex(cur.pubKeyHex, 16);
      }
      profile.setAttribute('aria-label', 'open profile');
      profile.addEventListener('click', () => this.openProfile());
      bar.appendChild(profile);

      const wallet = el('button', 'hdr-word', 'wallet');
      wallet.setAttribute('aria-label', 'open wallet');
      wallet.addEventListener('click', () => this.openWallet());
      bar.appendChild(wallet);

      const settings = el('button', 'hdr-word', 'settings');
      settings.setAttribute('aria-label', 'open settings');
      settings.addEventListener('click', () => this.openSettings());
      bar.appendChild(settings);

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
    this.checkNames('new');
  }

  // WEB_INTERFACE → The standalone thread — no arrows, no profile control.
  private renderStandaloneHeader(bar: HTMLElement): void {
    bar.classList.remove('hdr-workspace');
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
    this.checkNames('new');
  }

  /** Replace one card in the feed by post id — the like's optimistic press and its
   *  rejection re-render only the acted-on card so nothing else moves. */
  private renderFeedPost(postId: string): void {
    if (this.standalone) return;
    const post = this.state.feed.posts.find((p) => p.id === postId);
    if (!post) return;
    replaceFeedCard(this.feedEl, post, this.ctx(), this.handlers);
    this.checkNames('new');
  }

  private renderPanes(): void {
    this.withComposerFocus(() => this.renderPanesBody());
    this.checkNames('new');
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
    this.checkNames('new');
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
    this.checkNames('new');
  }

  private structural(mutate: () => void): void {
    mutate();
    this.saveLayout();
    this.renderPanes();
  }

  // -------------------------------------------------------------------------
  // Row intake — the post index, every live row a read has answered, by id, from
  // which a thread window's bar takes its author while the thread loads; a
  // fetched row put in place of the one the client holds, wherever it holds it;
  // and what every write of rows keeps: a withdrawal the client saw land, and a
  // like that landed after the read began.
  // -------------------------------------------------------------------------

  private indexRows(rows: Array<PostJson | WithdrawnJson | null>): void {
    for (const row of rows) {
      if (!row) continue;
      if (!('kind' in row) && !this.withdrawnSeen.has(row.id)) this.state.posts.set(row.id, row);
    }
  }

  /** Replace a post's row wherever the client holds it — the feed, every thread
   *  that contains it, the posts index, and any open @posts window — so the
   *  surface that re-renders next draws the node's row, not the stale one. */
  private applyFetchedRow(fetched: PostResult | null): void {
    if (!fetched || 'kind' in fetched) return;
    this.stampLanding(fetched);
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

  /** A like's landing wrote this row where the client holds it: stamp it with
   *  the order it landed in, which a read that began before it keeps (keeper). */
  private stampLanding(row: FeedRow): void {
    this.landings += 1;
    this.landedAt.set(row, this.landings);
  }

  /** A list page's rows the list may hold: live, and none whose withdrawal the
   *  client saw land — a list holds live rows only (WEB_INTERFACE → The
   *  withdrawn state). */
  private liveRows(rows: FeedRow[]): PostJson[] {
    return rows.filter(isLivePost).filter((r) => !this.withdrawnSeen.has(r.id));
  }

  /** A thread row as the client knows it: a post whose withdrawal it saw land
   *  is that withdrawal's marker, whatever the answer showed. */
  private known(row: FeedRow): FeedRow {
    return this.withdrawnSeen.get(row.id) ?? row;
  }

  /** For a read that began when `landings` stood at `since`: each answered row
   *  a like landed on since then, among the rows the client holds, keeps the
   *  landed row — the read may predate the landing. */
  private keeper<T extends FeedRow>(standing: readonly T[], since: number): (row: T) => T {
    const landed = new Map<string, T>();
    for (const s of standing) if ((this.landedAt.get(s) ?? 0) > since) landed.set(s.id, s);
    return (row) => landed.get(row.id) ?? row;
  }

  // -------------------------------------------------------------------------
  // Feed actions
  // -------------------------------------------------------------------------

  private async loadFeed(): Promise<void> {
    if (this.standalone) return;
    const feed = this.state.feed;
    // A page read for the node or the viewer before writes nothing: the change
    // that moved the generation reads the feed again itself.
    const gen = this.readerGen;
    const since = this.landings;
    feed.loading = true;
    feed.error = null;
    this.renderFeed();
    try {
      const res = await this.client.feed({ limit: FEED_LIMIT }, this.viewer(), undefined, true);
      if (gen !== this.readerGen) return;
      this.takeFeedPage(res, since);
    } catch (e) {
      if (gen !== this.readerGen) return;
      // No stored preference and a seed list — walk it, adopting the first one
      // that answers, for the session only (WEB_INTERFACE → "The client is
      // served from the node's own origin"). When none answers, the friendly
      // line names the state. An adoption moves the generation, and its page
      // lands under the generation the adoption opened.
      if (readStore(KEY_NODE) === null && BUILD_NODES.length > 0) {
        const walked = await this.walkSeedList(gen);
        if (walked !== null) {
          if (walked.gen !== this.readerGen) return;
          this.takeFeedPage(walked.res, since);
        } else {
          if (gen !== this.readerGen) return;
          this.dropFeedRows();
          feed.error = 'no node answered — set one in settings';
        }
      } else {
        this.dropFeedRows();
        feed.error = msg(e);
      }
    }
    this.renderFeed();
  }

  /** A first page, read from when `landings` stood at `since`, replaces the
   *  feed's rows and its cursor — its live rows, a like that landed since keeping
   *  its row (keeper). */
  private takeFeedPage(res: FeedResult, since: number): void {
    const feed = this.state.feed;
    feed.posts = this.liveRows(res.posts).map(this.keeper(feed.posts, since));
    feed.pending = this.dedupeOwn(res.pending.filter(isLivePost));
    feed.next = res.next;
    feed.loaded = true;
    feed.loading = false;
    this.indexRows([...res.posts, ...res.pending]);
  }

  /** Empty the feed's rows — the posts, the mempool rows, the cursor and the
   *  reports — in the object every feed read writes into. A node change drops
   *  them before its re-read (WEB_INTERFACE → The settings window), and a first
   *  page that fails leaves none: the rows it was to replace are the node
   *  before's, or carry the viewer before's marks, which a ↻ never re-reads
   *  (WEB_INTERFACE → "An identity change takes effect at once"). */
  private dropFeedRows(): void {
    Object.assign(this.state.feed, emptyFeedState());
  }

  /** Adopt the first seed after `prefs.node` whose feed answers. In-memory,
   *  never stored — the list keeps governing across the session
   *  (WEB_INTERFACE → "The client is served from the node's own origin"). A
   *  node or identity change during the walk ends it adopting nothing: that
   *  change reads the feed itself, and a node the settings row set is never
   *  overridden by a seed. An adoption answers its page with the generation it
   *  opened. */
  private async walkSeedList(gen: number): Promise<{ res: FeedResult; gen: number } | null> {
    const seen = new Set([prefs.node]);
    for (const base of BUILD_NODES) {
      if (seen.has(base)) continue;
      seen.add(base);
      const probe = new NodeClient(() => base);
      let res: FeedResult;
      try {
        res = await probe.feed({ limit: FEED_LIMIT }, this.viewer(), undefined, true);
      } catch {
        if (gen !== this.readerGen) return null;
        continue; // try the next entry
      }
      if (gen !== this.readerGen) return null;
      prefs.node = base; // session only — no writeStore.
      // The corner's tip and, where the build carries one, the verified tip
      // are per reading node (WEB_INTERFACE → The status corner, → The
      // extension → "The verified tip"): the shared method drops them and
      // reads the adopted node at once.
      this.onReadingNodeChanged();
      return { res, gen: this.readerGen };
    }
    return null;
  }

  private async refreshFeed(): Promise<void> {
    if (this.standalone) return;
    const feed = this.state.feed;
    // A ↻ read for the node or the viewer before writes nothing: the change
    // that moved the generation reads the feed again itself.
    const gen = this.readerGen;
    this.clearSettledFeed();
    await this.refreshTip(); // a ↻ re-reads the tip, so a held mark can re-enable
    if (gen !== this.readerGen) return;
    // A feed holding no first page reads one: a ↻ never pages an empty feed to
    // the cap.
    if (!feed.loaded) return this.loadFeed();
    try {
      // The reconnection paging lives in reconcileNewer; this fetches each page
      // and takes the mempool from page 0 (the only call with a null cursor).
      // The rows land together once the last page has answered; a page offers
      // its live rows alone (liveRows).
      const rows: FeedRow[] = [];
      let pending: FeedRow[] = [];
      const r = await reconcileNewer(
        feed.posts,
        async (after) => {
          const res = await this.client.feed(after === null ? { limit: FEED_LIMIT } : { limit: FEED_LIMIT, after }, this.viewer(), undefined, true);
          rows.push(...res.posts, ...res.pending);
          if (after === null) pending = res.pending;
          return { posts: this.liveRows(res.posts), next: res.next };
        },
        REFRESH_PAGE_CAP,
      );
      if (gen !== this.readerGen) return;
      this.indexRows(rows);
      feed.pending = this.dedupeOwn(pending.filter(isLivePost));
      feed.posts = landRefresh(feed.posts, r);
      if (r.next !== undefined) feed.next = r.next; // reset only on the replace branch
      feed.report = r.newCount ? `${r.newCount} new ${r.newCount === 1 ? 'post' : 'posts'}` : 'no new posts';
      feed.error = null;
    } catch (e) {
      if (gen !== this.readerGen) return;
      feed.error = msg(e);
    }
    this.renderFeed();
  }

  /** `load older` continues the cursor it was asked for: a page for the node or
   *  the viewer before writes nothing, and neither does one whose cursor a ↻ or
   *  a first page moved meanwhile — the next `load older` continues the feed
   *  that stands. The cursor is the key: a landing replaces the rows' array. */
  private async loadOlder(): Promise<void> {
    if (this.standalone) return;
    const feed = this.state.feed;
    const cursor = feed.next;
    if (cursor === null) return;
    const gen = this.readerGen;
    feed.loading = true;
    this.renderFeed();
    try {
      const res = await this.client.feed({ limit: FEED_LIMIT, after: cursor }, this.viewer(), undefined, true);
      if (gen !== this.readerGen) return;
      if (feed.next === cursor) {
        const older = this.liveRows(res.posts);
        const have = new Set(feed.posts.map((p) => p.id));
        const added = older.filter((p) => !have.has(p.id));
        feed.posts = [...feed.posts, ...added];
        feed.next = res.next;
        feed.olderReport = added.length ? `${added.length} older ${added.length === 1 ? 'post' : 'posts'}` : 'no older posts';
        this.indexRows(res.posts);
      }
    } catch (e) {
      if (gen !== this.readerGen) return;
      if (feed.next === cursor) feed.error = msg(e);
    }
    feed.loading = false;
    this.renderFeed();
  }

  // WEB_INTERFACE → The way into the workspace → "The page offers the thread to an extension first"
  private wayIn(): void {
    const id = this.state.workspace.columns[0]?.wins[0];
    if (!id || !this.tabs) {
      this.toWorkspace(id ?? '');
      return;
    }
    // The offer runs synchronously in the press — before any await — so the
    // browser's transient user activation still stands when a listener takes it.
    if (this.tabs.offer(id)) { this.handedOver(); return; }
    void this.wayInAsync(id);
  }

  private async wayInAsync(id: string): Promise<void> {
    const elsewhere = await this.tabs!.heldElsewhere();
    if (elsewhere) {
      this.tabs!.announce(id);
      this.handedOver();
    } else {
      this.toWorkspace(id);
    }
  }

  // The report and the close both handed-over arms end with, so the offer arm
  // and the lock-held-elsewhere arm run identical closing steps
  // (WEB_INTERFACE → The way into the workspace). The close's history guard
  // reads history.length before the attempt, so the page never tries and fails.
  private handedOver(): void {
    const col = this.state.workspace.columns[0];
    if (col) { col.report = 'added to your workspace'; this.renderPanes(); }
    if (history.length === 1) window.close();
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

  private openSettings(): void {
    // No node read is owed: the settings window is preferences only
    // (WEB_INTERFACE → The settings window).
    const res = openWindow(this.state.workspace, '@settings', { from: 'feed' });
    this.saveLayout();
    if (res.raised) {
      this.renderRegion(res.column.uid);
    } else {
      this.renderPanes();
    }
    this.moveView('@settings');
  }

  private openWallet(): void {
    const res = openWindow(this.state.workspace, '@wallet', { from: 'feed' });
    this.saveLayout();
    if (res.raised) {
      this.renderRegion(res.column.uid);
    } else {
      this.renderPanes();
      // A fresh open fires /credits and moves the view at once — the read
      // lands in place through renderCreditsRowInPlace; a raise brings the
      // existing window forward (WEB_INTERFACE → The wallet window). Fire-
      // and-move: the view never waits on the network, so a hanging /credits
      // does not strand the press (openProfile's pattern for /karma).
      void this.refreshWalletCredits();
    }
    this.moveView('@wallet');
  }

  /** Re-read /credits and move the balance in place — the wallet window's
   *  opening, by a press or restored at boot, and its ↻, and the re-read an
   *  identity or node change and a verified tip owe while the window is open
   *  (WEB_INTERFACE → The wallet window). An answer for the node or the key
   *  before writes nothing. */
  private async refreshWalletCredits(): Promise<void> {
    const cur = this.idm.current();
    if (cur === null) return;
    const gen = this.readerGen;
    const stamp = this.listingStamp();
    const order = this.beginRead();
    let credits: CreditsResult;
    try {
      credits = await this.readOwnCredits(cur.pubKeyHex);
    } catch {
      return; // a failed read leaves the last-known state; the next ↻ retries
    }
    if (gen !== this.readerGen) return;
    this.takeCredits(credits, stamp, order);
  }

  /** Take a /credits listing as the balance row's, beside the stamp its read
   *  began under — unless the held listing's read began later (newerRead): the
   *  balance moves in its slot (HOUSE_STYLE → Motion) and the figures run
   *  follows (WEB_INTERFACE → The extension → "The verified figures"). Answers
   *  whether it took. */
  private takeCredits(credits: CreditsResult, stamp: ListingStamp, order: number): boolean {
    if (!this.newerRead('credits', order)) return false;
    this.walletCredits = credits;
    this.walletCreditsStamp = stamp;
    this.renderCreditsRowInPlace();
    this.startFigures();
    return true;
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

  private applyThread(t: ThreadState, res: ThreadResult, since: number): void {
    this.putThreadRows(t, since, res.post, res.descendants);
    t.ancestorIds = new Set(res.ancestors.map((a) => a.id));
    t.descendantCount = res.descendantCount;
    t.next = res.next;
    t.error = null;
    this.indexRows([t.root, ...res.ancestors, ...t.descendants, ...res.pending]);
  }

  /** Write a thread read's rows, read from when `landings` stood at `since`, as
   *  the client knows them: a like that landed since keeps its row (keeper), and
   *  a post whose withdrawal the client saw land is its withdrawn card (known). */
  private putThreadRows(t: ThreadState, since: number, root: PostJson | WithdrawnJson | null, descendants: FeedRow[]): void {
    const keep = this.keeper<FeedRow>(t.root ? [t.root, ...t.descendants] : t.descendants, since);
    t.root = root === null ? null : this.known(keep(root));
    t.descendants = descendants.map((r) => this.known(keep(r)));
  }

  /** Read a thread's first page. A read for the node or the viewer before
   *  writes nothing: the change that moved the generation reads every open
   *  thread again itself. */
  private async fetchThread(id: string): Promise<void> {
    const t = this.ensureThreadState(id);
    const gen = this.readerGen;
    const since = this.landings;
    t.loading = true;
    t.error = null;
    this.renderThreadLoad(id);
    try {
      const res = await this.client.thread(id, { limit: THREAD_LIMIT }, this.viewer());
      if (gen !== this.readerGen) return;
      if (res === null) {
        t.root = null; // 404 — the post is gone; the body says so, it is not an error
      } else {
        this.applyThread(t, res, since);
      }
    } catch (e) {
      if (gen !== this.readerGen) return;
      t.error = msg(e);
    }
    t.loading = false;
    this.renderThreadLoad(id);
  }

  /** Refresh re-reads the whole thread — descendants load oldest-first, so new
   *  replies are the newest and would otherwise sit past the last loaded page.
   *  It reports the change in reply count. A ↻ read for the node or the viewer
   *  before writes nothing, the report included, and the rows it writes keep
   *  every withdrawal the client saw land and every like that landed after it
   *  began (putThreadRows). */
  private async refreshThread(id: string): Promise<void> {
    const t = this.state.threads.get(id);
    if (!t) return;
    const gen = this.readerGen;
    const since = this.landings;
    const before = t.descendantCount;
    const region = this.regionFocusedOn(id);
    this.clearSettledThread(id);
    await this.refreshTip(); // a ↻ re-reads the tip
    if (gen !== this.readerGen) return;
    try {
      let res = await this.client.thread(id, { limit: THREAD_LIMIT }, this.viewer());
      if (gen !== this.readerGen) return;
      if (res === null) {
        t.root = null;
        if (region) region.report = null;
      } else {
        const all: FeedRow[] = [...res.descendants];
        let next = res.next;
        let pages = 1;
        while (next !== null && pages < REFRESH_PAGE_CAP) {
          const more = await this.client.thread(id, { limit: THREAD_LIMIT, after: next }, this.viewer());
          if (gen !== this.readerGen) return;
          if (more === null) break;
          all.push(...more.descendants);
          next = more.next;
          res = more;
          pages++;
        }
        this.putThreadRows(t, since, res.post, all);
        t.ancestorIds = new Set(res.ancestors.map((a) => a.id));
        t.descendantCount = res.descendantCount;
        t.next = next; // null once fully read; set only if the page cap was hit
        t.error = null;
        this.indexRows([t.root, ...t.descendants]);
        const delta = t.descendantCount - before;
        if (region) region.report = delta > 0 ? `${delta} new ${delta === 1 ? 'reply' : 'replies'}` : 'no new replies';
      }
    } catch (e) {
      if (gen !== this.readerGen) return;
      t.error = msg(e);
    }
    this.renderRegionsFor(id);
  }

  /** A thread's `more` continues the cursor it was asked for: a page for the
   *  node or the viewer before writes nothing, and neither does one whose
   *  cursor a ↻ or a first page moved meanwhile — the next `more` continues the
   *  thread that stands. The cursor is the key: a landing replaces the rows'
   *  array. */
  private async threadMore(id: string): Promise<void> {
    const t = this.state.threads.get(id);
    if (!t || t.next === null) return;
    const cursor = t.next;
    const gen = this.readerGen;
    try {
      const res = await this.client.thread(id, { limit: THREAD_LIMIT, after: cursor }, this.viewer());
      if (gen !== this.readerGen || t.next !== cursor) return;
      if (res !== null) {
        const have = new Set(t.descendants.map((d) => d.id));
        const added = res.descendants.filter((d) => !have.has(d.id)).map((d) => this.known(d));
        t.descendants = [...t.descendants, ...added];
        t.next = res.next;
        t.descendantCount = res.descendantCount;
        this.indexRows(added);
      }
    } catch (e) {
      if (gen !== this.readerGen || t.next !== cursor) return;
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
    this.renderRegionsFor('@settings');
  }

  private changeIdTint(m: IdTint): void {
    // The tint is :root's data-idtint and custom properties (src/prefs.ts
    // applyIdTint); the seg's own click moves the four words' pressed state in
    // place (WEB_INTERFACE → The settings window → "The identity tint shows
    // what it sets"), so no region re-render is owed.
    setIdTint(m);
  }

  private async changeNode(origin: string): Promise<void> {
    setNode(origin);
    // Everything loaded came from the old node; drop it and re-read. The shared
    // method the seed adoption calls too drops the threads, the feed's rows, the
    // reader's own state, the corner's tip and, where the build carries one, the
    // verified tip, and reads the new node at once (WEB_INTERFACE → The settings
    // window, → The status corner); the feed's own read follows.
    this.onReadingNodeChanged();
    await this.loadFeed();
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
    // The reader's own acts under the key before — its flights, its optimistic
    // overlays and its submissions — go with it; the node's answers for that key
    // drop with the reader's own state.
    this.optimisticLikes.clear();
    this.withdrawFlights.clear();
    this.state.submissions = [];
    this.grantView = null;
    this.optimisticVouches.clear();
    this.inviteFlight = null;
    this.usernameFlight = null;
    this.usernameInFlight = null;
    this.creditGrantView = null;
    this.sendFlight = null;
    this.dropReaderState();
    this.ledger = new PendingLedger(this.idm.current()?.pubKeyHex ?? null);
    this.startPoll(); // the new key's restored ledger may hold entries; guarded on empty
    this.renderHeader();
    this.renderPanes();
    void this.loadFeed();
    for (const id of openSet(this.state.workspace)) if (!isWin(id)) void this.fetchThread(id);
    this.rereadReaderState();
  }

  /** Drop the reader's own state — every answer the node gave for the loaded
   *  key — and move the generation, so a read in flight for the node or the key
   *  before writes nothing when it answers. The identity change and a change of
   *  the reading node both call it (WEB_INTERFACE → The identity module, → The
   *  settings window, → The status corner); the reader's own acts in flight are
   *  the identity change's to drop. */
  private dropReaderState(): void {
    this.readerGen += 1;
    this.lastPolledHeight = 0;
    this.profileKarma = null;
    this.profileKarmaStamp = null;
    this.state.status = null;
    this.vouched.clear();
    this.escrowHeldUntil = null;
    this.viewerTip = 0;
    this.authorData.clear();
    this.authorPostsData.clear();
    this.bondsView = null;
    this.ownName = null;
    this.ownNameLoaded = false;
    this.walletCredits = null;
    this.walletCreditsStamp = null;
    this.heldRead.clear();
    // The figures describe the listings dropped here. A run in flight for them
    // is dropped by its older generation, and the flags clear beside the
    // generation, so the run the re-read owes can start (WEB_INTERFACE → The
    // extension → "The verified figures").
    this.figures = null;
    this.figuresGen += 1;
    this.figuresInFlight = false;
    this.figuresDirty = false;
  }

  /** Read the reader's own state — the membership state with an identity, the
   *  wallet's listing while its window is open, and every open author and
   *  author-posts window: at start, for a restored identity and arrangement, and
   *  again after dropReaderState (WEB_INTERFACE → The identity module, → The
   *  settings window, → The wallet window). */
  private rereadReaderState(): void {
    if (this.idm.current() !== null) void this.loadMembershipState();
    if (this.idm.current() !== null && openSet(this.state.workspace).has('@wallet')) {
      void this.refreshWalletCredits();
    }
    this.loadAuthorWindows();
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

  /** Re-read /karma and move the rep row in place — the first read a verified tip
   *  owes (WEB_INTERFACE → The extension → "The verified figures"). An answer
   *  for the node or the key before writes nothing. */
  private async refreshOwnKarma(): Promise<void> {
    const cur = this.idm.current();
    if (cur === null) return;
    const gen = this.readerGen;
    const stamp = this.listingStamp();
    const order = this.beginRead();
    let karma: KarmaResult;
    try {
      karma = await this.readOwnKarma(cur.pubKeyHex);
    } catch {
      return; // a failed read leaves the last-known state; the next read retries
    }
    if (gen !== this.readerGen) return;
    this.takeKarma(karma, stamp, order);
  }

  /** Hold a /karma listing as the rep row's, beside the stamp its read began
   *  under — unless the held listing's read began later (newerRead). Answers
   *  whether it took. */
  private holdKarma(karma: KarmaResult, stamp: ListingStamp, order: number): boolean {
    if (!this.newerRead('karma', order)) return false;
    this.profileKarma = karma;
    this.profileKarmaStamp = stamp;
    return true;
  }

  /** Take a /karma listing as the rep row's: its height feeds the tip the gates
   *  read (bumpTip) whichever listing the row holds, then it is held
   *  (holdKarma), the number moves in its slot (HOUSE_STYLE → Motion) and the
   *  figures run follows (WEB_INTERFACE → The extension → "The verified
   *  figures"). Answers whether it took. */
  private takeKarma(karma: KarmaResult, stamp: ListingStamp, order: number): boolean {
    this.bumpTip(karma.height);
    if (!this.holdKarma(karma, stamp, order)) return false;
    this.renderProfileKarma();
    this.startFigures();
    return true;
  }

  /** Ask the faucet — a 202 rides the bounded poll as a grant entry; a rejection is
   *  one register line (WEB_INTERFACE → The faucet step). The request carries only
   *  the public key, so a locked identity can ask. In the extension the hook is
   *  called synchronously from the press before any await, so the browser's
   *  user-input window is still open (WEB_INTERFACE → The faucet step → "In the
   *  extension the press asks the browser for the faucet's origin first"). */
  private async askFaucet(): Promise<void> {
    const cur = this.idm.current();
    if (cur === null) return;
    // The hook is invoked synchronously here — an `await` in front of the
    // request loses the user-input window in Firefox.
    const permission = this.requestFaucetOrigin ? this.requestFaucetOrigin(prefs.faucet) : null;
    if (permission !== null) {
      const granted = await permission;
      if (!granted) {
        const region = this.regionFocusedOn('@profile');
        if (region) {
          region.report = 'the browser refused access to that origin.';
          this.renderRegion(region.uid);
        }
        return;
      }
    }
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
      // The pre-check: mount the unlock form in the composer foot. Esc returns to
      // editing with the draft intact (WEB_INTERFACE → The identity module).
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
    const ctrl = this.composers.get(composerKey(parentId));
    if (!ctrl) return;
    // The composer takes its `sending` look; the collapse into the hollow card
    // moves to after the signature (WEB_INTERFACE → The wallet, "the fourth
    // ending is the composer still open"). No hollow card exists while sign is
    // unresolved.
    ctrl.setSending(true);
    let submission = null as Submission | null;
    const onSigned = (): void => {
      // Between the sign and the POST: collapse the composer, push the pending
      // submission, and render the hollow card in the same slot.
      this.composers.delete(composerKey(parentId));
      submission = {
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
    };
    let result;
    try {
      result = await submitPostFlow({ ...this.submitDeps(), onSigned }, text, parentId);
    } catch {
      // A transport failure. Before the sign — a pre-sign read threw and
      // onSigned never fired — the composer is still open with its text; after
      // the sign, the submission is present and settles as *rejected*.
      if (submission === null) {
        ctrl.setSending(false);
        ctrl.setNotSent("can't reach the node right now.");
      } else {
        submission.stage = 'rejected';
        submission.reason = "can't reach the node right now.";
        this.renderForParent(parentId);
      }
      return;
    }
    if (result.ok) {
      // The sign fired, so onSigned fired, so the submission is present.
      this.settle(submission!, result);
      return;
    }
    if ('rejection' in result) {
      // A rejection can precede the sign (a no-confirmedAuthor reply,
      // InsufficientKarma). onSigned then never fired and the composer is still
      // open with its text; after the sign, the submission settles as *rejected*.
      if (submission === null) {
        ctrl.setSending(false);
        ctrl.setNotSent(postRejectionCopy(result.rejection));
      } else {
        this.settle(submission, result);
      }
      return;
    }
    // notSigned — no hollow card, composer still open with its text.
    if (result.notSigned === 'locked') {
      ctrl.setSending(false);
      ctrl.showUnlock(cur.pubKeyHex, async (p) => {
        await this.idm.unlock(p);
        await this.submitComposer(parentId, ctrl.text());
      });
    } else {
      ctrl.setSending(false);
      ctrl.setNotSent(notSignedCopy(result.notSigned, result.reason, 'post'));
    }
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

  /** Drive a submission's flight from a `try again`. notSigned there has no
   *  composer to return to, so it returns the card to *expired* with the same
   *  action still offered (WEB_INTERFACE → The wallet). */
  private async flight(
    sub: Submission,
    run: () => Promise<{ ok: true; entry: { txId: string; postId: string; expiresAtHeight: number } } | { ok: false; rejection: Rejection } | { ok: false; notSigned: 'locked' | 'declined' | 'refused'; reason: string }>,
  ): Promise<void> {
    let result;
    try {
      result = await run();
    } catch {
      sub.stage = 'rejected';
      sub.reason = "can't reach the node right now.";
      this.renderForParent(sub.parentId);
      return;
    }
    if (result.ok || 'rejection' in result) {
      this.settle(sub, result);
      return;
    }
    // notSigned during a try-again — return the card to *expired* with the
    // action still offered.
    sub.stage = 'expired';
    this.renderForParent(sub.parentId);
  }

  /** Land a signed submission's flight — the two settling arms shared by
   *  submitComposer and the try-again path (WEB_INTERFACE → The wallet). */
  private settle(
    sub: Submission,
    result: { ok: true; entry: { txId: string; postId: string; expiresAtHeight: number } } | { ok: false; rejection: Rejection },
  ): void {
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
    const line = 'rejection' in result
      ? 'like rejected: ' + likeRejectionCopy(result.rejection)
      : notSignedCopy(result.notSigned, result.reason, 'like');
    this.setReportForPost(postId, line);
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
    // renders 'submitted'; on a rejection or notSigned the control returns.
    this.withdrawFlights.delete(postId);
    if (result.ok) {
      this.startPoll();
    } else if ('rejection' in result) {
      this.setReportForPost(postId, 'withdraw rejected: ' + withdrawRejectionCopy(result.rejection));
    } else {
      this.setReportForPost(postId, notSignedCopy(result.notSigned, result.reason, 'withdraw'));
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
   *  whose regions the caller must re-render explicitly. The withdrawal joins
   *  the ones the client has seen land, which every later write of rows keeps. */
  private applyWithdrawLanding(postId: string, fetched: PostResult | null): { feedChanged: boolean; postsKeys: string[]; touchParents: string[] } {
    const withdrawn = fetched !== null && 'kind' in fetched ? fetched : null;
    if (withdrawn) this.withdrawnSeen.set(postId, withdrawn);
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
   *  vouch set, the escrow, /status, the bonds and the reader's own name — at
   *  identity load, the profile's open and ↻, and after an identity or node
   *  change. /credits is the wallet's own read (WEB_INTERFACE → The profile
   *  window, → The wallet window). An answer for the node or the key before
   *  writes nothing, and each piece keeps the answer of a read begun after this
   *  one (newerRead). */
  private async loadMembershipState(): Promise<void> {
    const cur = this.idm.current();
    if (cur === null) return;
    const gen = this.readerGen;
    const stamp = this.listingStamp();
    const order = this.beginRead();
    let karmaTaken = false;
    try {
      const [karma, status, vouched, escrow, bonds, ownName] = await Promise.all([
        this.readOwnKarma(cur.pubKeyHex),
        this.client.status(),
        this.readVouchSet(cur.pubKeyHex),
        this.readEscrow(cur.pubKeyHex),
        this.client.bonds(cur.pubKeyHex),
        this.client.usernameByOwner(cur.pubKeyHex),
      ]);
      if (gen !== this.readerGen) return;
      karmaTaken = this.holdKarma(karma, stamp, order);
      // vouchCooldownBlocks + the bond range for the invites row
      if (this.newerRead('status', order)) this.state.status = status;
      this.bumpTip(status.blockHeight);
      this.bumpTip(karma.height);
      if (this.newerRead('vouches', order)) {
        this.vouched = vouched;
        this.escrowHeldUntil = escrow;
      }
      if (this.newerRead('bonds', order)) this.bondsView = bonds;
      if (this.newerRead('name', order)) {
        this.ownName = ownName;
        this.ownNameLoaded = true;
      }
    } catch {
      return; // a failed read leaves the last-known state; the ↻ retries
    }
    this.renderHeader();
    this.renderFeed();
    this.renderPanes();
    // A fresh karma listing triggers a figures verifier run
    // (WEB_INTERFACE → The extension → "The verified figures").
    if (karmaTaken) this.startFigures();
  }

  /** Read the whole /credits for a key, following `next` to the end. The
   *  spendable view is the whole page; a landing needs to see every box the
   *  node has (WEB_INTERFACE → "Paging is keyset, never offset"). `total` is
   *  the identity's total on every page, so the first page's value stands. */
  private async readOwnCredits(key: string): Promise<CreditsResult> {
    const first: CreditsResult = await this.client.credits(key, {});
    const boxes = [...first.boxes];
    let after: string | null = first.next;
    while (after !== null) {
      const page: CreditsResult = await this.client.credits(key, { after });
      for (const b of page.boxes) boxes.push(b);
      after = page.next;
    }
    return { userId: first.userId, total: first.total, boxes, boxCount: boxes.length, next: null };
  }

  /** Read the whole /karma for a key, following `next` to the end
   *  (WEB_INTERFACE → "Paging is keyset, never offset"). The row's number is
   *  the first page's `effective`; the figures verifier will prove the whole
   *  listing (WEB_INTERFACE → The extension → "The verified figures"). Every
   *  field but `boxes` / `boxCount` / `next` is the identity's, the same on
   *  every page (NODE_INTERFACE → UTXO queries), so the first page's values
   *  stand. */
  private async readOwnKarma(key: string): Promise<KarmaResult> {
    const first: KarmaResult = await this.client.karma(key, {});
    const boxes = [...first.boxes];
    let after: string | null = first.next;
    while (after !== null) {
      const page: KarmaResult = await this.client.karma(key, { after });
      for (const b of page.boxes) boxes.push(b);
      after = page.next;
    }
    return {
      userId: first.userId,
      total: first.total,
      effective: first.effective,
      boxes,
      boxCount: boxes.length,
      next: null,
      lastActivityBlock: first.lastActivityBlock,
      lastDecayBlock: first.lastDecayBlock,
      lifetimeLikesReceived: first.lifetimeLikesReceived,
      memberSinceBlock: first.memberSinceBlock,
      memberBar: first.memberBar,
      memberVouches: first.memberVouches,
      memberLikes: first.memberLikes,
      invitesUsed: first.invitesUsed,
      member: first.member,
      invitesAvailable: first.invitesAvailable,
      height: first.height,
    };
  }

  /** The your-vouch row's escrow gate reads `viewerTip`, so it must follow every
   *  height the client reads — /status, /karma, /blocks/current — or a stake held
   *  "until block N" stays held past N once the poll stops (WEB_INTERFACE → The
   *  identity display). Monotonic within one node's reads: a stale read never
   *  rewinds it. An identity change and a change of the reading node drop it with
   *  everything else loaded, and a read in flight across either writes nothing
   *  (WEB_INTERFACE → The status corner). */
  private bumpTip(h: number): void {
    if (h > this.viewerTip) this.viewerTip = h;
  }

  /** A ↻ is the reader asking for fresh state, so a feed, pane or profile refresh
   *  re-reads the tip even when no membership entry is pending. */
  private async refreshTip(): Promise<void> {
    const gen = this.readerGen;
    try {
      const b = await this.client.currentBlock();
      if (gen === this.readerGen) this.bumpTip(b.height);
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
      const reason = 'rejection' in result
        ? 'vouch rejected: ' + vouchRejectionCopy(result.rejection)
        : notSignedCopy(result.notSigned, result.reason, 'vouch');
      if (d) d.flight = { stage: 'rejected', reason };
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
      d.flight = {
        stage: 'rejected',
        reason: 'rejection' in result
          ? 'unvouch rejected: ' + vouchRejectionCopy(result.rejection)
          : notSignedCopy(result.notSigned, result.reason, 'unvouch'),
      };
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
    if (!this.authorData.has(key)) this.authorData.set(key, { endorsers: null, endorsersNext: false, flight: null, username: null, usernameLoaded: false });
    return key;
  }

  private ensurePostsData(key: string): string {
    if (!this.authorPostsData.has(key)) this.authorPostsData.set(key, emptyFeedState());
    return key;
  }

  /** Load every open author and author-posts window's reads — the restored
   *  arrangement at start, and the re-read an identity or node change owes. A
   *  read still in flight for an entry the drop removed writes into that entry
   *  alone (WEB_INTERFACE → The author window). */
  private loadAuthorWindows(): void {
    for (const id of openSet(this.state.workspace)) {
      const sub = windowSubject(id);
      if (sub?.kind === 'author') void this.loadAuthorData(this.ensureAuthorData(sub.key));
      if (sub?.kind === 'posts') void this.loadAuthorPosts(this.ensurePostsData(sub.key));
    }
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
      const [endorsers, username] = await Promise.all([this.client.vouchesByTarget(key), this.client.usernameByOwner(key)]);
      d.endorsers = endorsers;
      d.endorsersNext = endorsers.next !== null;
      d.username = username;
      d.usernameLoaded = true;
    } catch {
      return; // leave the window's last data; the ↻ retries
    }
    this.renderRegionsFor(authorWindowId(key));
  }

  private refreshAuthor(key: string): Promise<void> {
    return this.loadAuthorData(key);
  }

  /** The endorsers' `more` continues the page it was asked for: once a ↻ or a
   *  raise re-read the endorsers it writes nothing, and the next `more`
   *  continues the list that stands. A page across a node or identity change
   *  lands in the entry the drop removed. */
  private async moreEndorsers(key: string): Promise<void> {
    const d = this.authorData.get(key);
    const from = d?.endorsers ?? null;
    if (!d || from === null || from.next === null) return;
    try {
      const page = await this.client.vouchesByTarget(key, { after: from.next });
      if (d.endorsers !== from) return;
      d.endorsers = { vouches: [...from.vouches, ...page.vouches], count: page.count, next: page.next };
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

  /** Read an author-posts window's first page. A read for the node or the
   *  viewer before writes nothing — its entry went with the drop, and its rows
   *  never reach the post index. */
  private async loadAuthorPosts(key: string): Promise<void> {
    const f = this.authorPostsData.get(key);
    if (!f) return;
    const gen = this.readerGen;
    const since = this.landings;
    f.loading = true;
    this.renderRegionsFor(postsWindowId(key));
    try {
      const res = await this.client.feed({ limit: FEED_LIMIT }, this.viewer(), key);
      if (gen !== this.readerGen) return;
      f.posts = this.liveRows(res.posts).map(this.keeper(f.posts, since));
      f.next = res.next;
      f.loaded = true;
      f.error = null;
      this.indexRows(res.posts);
    } catch (e) {
      if (gen !== this.readerGen) return;
      f.error = msg(e);
    }
    f.loading = false;
    this.renderRegionsFor(postsWindowId(key));
  }

  /** The posts window's ↻ reports what it did through the feed's own reconcile,
   *  keyed by the author (WEB_INTERFACE → The author window). A ↻ read for the
   *  node or the viewer before writes nothing, the report included. */
  private async refreshAuthorPosts(key: string): Promise<void> {
    const f = this.authorPostsData.get(key);
    if (!f) return;
    // A window holding no first page reads one: a ↻ never pages an empty list
    // to the cap.
    if (!f.loaded) return this.loadAuthorPosts(key);
    const gen = this.readerGen;
    const region = this.regionFocusedOn(postsWindowId(key));
    try {
      const rows: FeedRow[] = [];
      const r = await reconcileNewer(
        f.posts,
        async (after) => {
          const res = await this.client.feed(after === null ? { limit: FEED_LIMIT } : { limit: FEED_LIMIT, after }, this.viewer(), key);
          rows.push(...res.posts);
          return { posts: this.liveRows(res.posts), next: res.next };
        },
        REFRESH_PAGE_CAP,
      );
      if (gen !== this.readerGen) return;
      this.indexRows(rows);
      f.posts = landRefresh(f.posts, r);
      if (r.next !== undefined) f.next = r.next;
      f.error = null;
      if (region) region.report = r.newCount ? `${r.newCount} new ${r.newCount === 1 ? 'post' : 'posts'}` : 'no new posts';
    } catch (e) {
      if (gen !== this.readerGen) return;
      f.error = msg(e);
    }
    this.renderRegionsFor(postsWindowId(key));
  }

  /** An author-posts window's `more` continues the cursor it was asked for: a
   *  page for the node or the viewer before writes nothing, and neither does
   *  one whose cursor a ↻ or a first page moved meanwhile — the next `more`
   *  continues the list that stands. */
  private async authorPostsMore(key: string): Promise<void> {
    const f = this.authorPostsData.get(key);
    if (!f || f.next === null) return;
    const cursor = f.next;
    const gen = this.readerGen;
    try {
      const res = await this.client.feed({ limit: FEED_LIMIT, after: cursor }, this.viewer(), key);
      if (gen !== this.readerGen || f.next !== cursor) return;
      const older = this.liveRows(res.posts);
      const have = new Set(f.posts.map((p) => p.id));
      f.posts = [...f.posts, ...older.filter((p) => !have.has(p.id))];
      f.next = res.next;
      this.indexRows(res.posts);
    } catch (e) {
      if (gen !== this.readerGen || f.next !== cursor) return;
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
      const reason = 'rejection' in result
        ? 'invite rejected: ' + inviteRejectionCopy(result.rejection)
        : notSignedCopy(result.notSigned, result.reason, 'invite');
      this.inviteFlight = { stage: 'rejected', reason };
    }
    this.renderInvitesRowInPlace();
  }

  /** The invites row's `more` continues the page it was asked for: a page for
   *  the node or the key before, or for a first page a landing or a membership
   *  read replaced meanwhile, writes nothing, and the next `more` continues the
   *  page that stands. */
  private async moreBonds(): Promise<void> {
    const cur = this.idm.current();
    const from = this.bondsView;
    if (cur === null || from === null || from.next === null) return;
    const gen = this.readerGen;
    try {
      const page = await this.client.bonds(cur.pubKeyHex, { after: from.next });
      if (gen !== this.readerGen || this.bondsView !== from) return;
      this.bondsView = { bonds: [...from.bonds, ...page.bonds], bondCount: page.bondCount, next: page.next };
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
    this.checkNames('new');
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
      const reason = 'rejection' in result
        ? 'claim rejected: ' + usernameRejectionCopy(result.rejection)
        : notSignedCopy(result.notSigned, result.reason, 'claim');
      this.usernameFlight = { stage: 'rejected', reason };
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
      const reason = 'rejection' in result
        ? 'burn rejected: ' + usernameRejectionCopy(result.rejection)
        : notSignedCopy(result.notSigned, result.reason, 'burn');
      this.usernameFlight = { stage: 'rejected', reason };
    }
    this.renderUsernameRowInPlace();
  }

  private renderUsernameRowInPlace(): void {
    const field = document.querySelector<HTMLElement>('.username-field');
    if (field) renderUsernameRow(field, this.handlers, this.ctx());
    this.checkNames('new');
  }

  // ---- the wallet window's send row (WEB_INTERFACE → The wallet window) ----

  /** Resolve an @handle to its holder — the row's send form calls this at the
   *  press, the way the composer resolves nothing (a post has no recipient) and
   *  the vouch resolves its box at the press (WEB_INTERFACE → The wallet). In
   *  the extension the handle is proven against the verified chain first
   *  (proveRecipient); the web build takes the node's answer, one read per
   *  press, a 404 answering *no one holds that name.* */
  private async resolveRecipient(name: string): Promise<ResolvedRecipient | { refusal: string }> {
    if (this.namesVerifier !== null) return this.proveRecipient(this.namesVerifier, name);
    try {
      const held = await this.client.usernameByName(name);
      if (held === null) return { refusal: 'no one holds that name.' };
      return { key: held.owner, name: held.name };
    } catch {
      return { refusal: "can't reach the node right now." };
    }
  }

  /** A send to a handle is checked at the press (WEB_INTERFACE → The extension →
   *  "The verified names", → The wallet window → "The `send` row"): the typed
   *  handle against the anchor standing — with none, the anchor a tip run
   *  writes — and a check that ends `unchecked` once more against the anchor of
   *  one tip run. The answer is the proven result's (recipientVerdict), never
   *  the node's word. A press left with no anchor to check against, whose check
   *  throws, or whose checks a node change moved past, is *can't be checked*. */
  private async proveRecipient(verifier: NamesVerifier, name: string): Promise<ResolvedRecipient | { refusal: string }> {
    const gen = this.namesGen;
    const handle = '@' + name;
    const anchor = this.tipAnchor ?? (await this.tipRunForPress())?.anchor ?? null;
    let result = await this.checkHandle(verifier, name, anchor);
    if (result !== null && result.status === 'unchecked') {
      result = await this.checkHandle(verifier, name, (await this.tipRunForPress())?.anchor ?? null);
    }
    if (result === null || gen !== this.namesGen) {
      return { refusal: `${handle} can't be checked — the chain is not verified.` };
    }
    return recipientVerdict(result, handle);
  }

  /** One check of a typed handle at the reading node, or null with no anchor to
   *  check it against. A check is total, so a rejection is the seam's own
   *  failure — logged, and no result. */
  private async checkHandle(verifier: NamesVerifier, name: string, anchor: Anchor | null): Promise<NameResult | null> {
    if (anchor === null) return null;
    try {
      return await verifier.run(prefs.node, { name }, anchor);
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  /** Submit a credits send: the transient flight is submitting, then the ledger
   *  entry carries the pending line across a reload (WEB_INTERFACE → The wallet
   *  window → "The `send` row"). A rejection is the row's flight line; a
   *  landing re-reads /credits and moves the balance in place. */
  private async send(toHex: string, toName: string | null, amount: bigint): Promise<void> {
    const cur = this.idm.current();
    if (cur === null) return;
    this.sendFlight = { stage: 'submitting' };
    this.renderCreditsRowInPlace();
    let result;
    try {
      result = await submitSendFlow(this.submitDeps(), toHex, toName, amount);
    } catch {
      this.sendFlight = { stage: 'rejected', reason: "send rejected: can't reach the node right now." };
      this.renderCreditsRowInPlace();
      return;
    }
    if (result.ok) {
      this.sendFlight = null; // the pending line is now the ledger's entry
      // The form clears on an accepted submission; every other ending leaves
      // its values intact (WEB_INTERFACE → The wallet).
      const field = document.querySelector<HTMLElement>('.credits-field');
      if (field) resetCreditsSendForm(field);
      this.startPoll();
    } else if ('rejection' in result) {
      this.sendFlight = { stage: 'rejected', reason: 'send rejected: ' + result.rejection.message };
    } else {
      // notSigned — every arm's copy (WEB_INTERFACE → The wallet).
      this.sendFlight = { stage: 'rejected', reason: notSignedCopy(result.notSigned, result.reason, 'send') };
    }
    this.renderCreditsRowInPlace();
  }

  /** Ask the faucet for $NOTIS: a repeatable grant (NODE_INTERFACE → Faucet).
   *  A 202 rides the ledger as a `creditGrant` entry whose subject is the box
   *  id the faucet named, so the poll runs while it stands (WEB_INTERFACE → The
   *  faucet step). In the extension the hook is called synchronously from the
   *  press before any await, so the browser's user-input window is still open
   *  (WEB_INTERFACE → The faucet step → "In the extension the press asks the
   *  browser for the faucet's origin first"). */
  private async askFaucetCredits(): Promise<void> {
    const cur = this.idm.current();
    if (cur === null) return;
    // The hook is invoked synchronously here — an `await` in front of the
    // request loses the user-input window in Firefox.
    const permission = this.requestFaucetOrigin ? this.requestFaucetOrigin(prefs.faucet) : null;
    if (permission !== null) {
      const granted = await permission;
      if (!granted) {
        const region = this.regionFocusedOn('@wallet');
        if (region) {
          region.report = 'the browser refused access to that origin.';
          this.renderRegion(region.uid);
        }
        return;
      }
    }
    const res = await this.faucetClient.askCredits(cur.pubKeyHex);
    if ('message' in res) {
      const region = this.regionFocusedOn('@wallet');
      if (region) {
        region.report = faucetLine(res, 'credits');
        this.renderRegion(region.uid);
      }
      return;
    }
    const entry: PendingEntry = {
      txId: res.txId,
      kind: 'creditGrant',
      postId: res.boxId, // a credits grant's subject is the box id the faucet named
      inputs: [],
      expiresAtHeight: res.expiresAtHeight,
      submittedAtHeight: this.lastPolledHeight,
    };
    this.ledger.add(entry);
    this.creditGrantView = { state: 'pending' };
    this.startPoll();
    this.renderCreditsRowInPlace();
  }

  private renderCreditsRowInPlace(): void {
    const field = document.querySelector<HTMLElement>('.credits-field');
    if (field) renderCreditsRow(field, this.handlers, this.ctx());
  }

  // ---- the status corner (WEB_INTERFACE → The status corner) ----
  // A timer independent of the bounded landing poll: reads /blocks/current every
  // CORNER_POLL_MS while the tab is visible, feeds viewerTip, and re-renders the
  // corner in place — never a region re-render. The dot's colour comes from
  // cornerState over the last read's outcome; the height is the tip in mono.

  private mountCorner(): void {
    if (this.cornerEl !== null) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    renderCorner(btn, this.currentCornerState(), this.cornerLastTip, this.tipVerdict);
    // A press re-reads at once — the corner is a control (WEB_INTERFACE → The
    // status corner, HOUSE_STYLE → Interaction). Where the build carries a
    // verifier, the press runs a verification too (WEB_INTERFACE → The
    // extension → "The verified tip").
    btn.addEventListener('click', () => {
      void this.cornerTick();
      this.startVerification();
    });
    document.body.appendChild(btn);
    this.cornerEl = btn;
    // Visibility drives the timer: stop while hidden, an immediate read on
    // resume (WEB_INTERFACE → The status corner).
    this.cornerVisHandler = () => this.onCornerVisibility();
    document.addEventListener('visibilitychange', this.cornerVisHandler);
    if (this.cornerVisible()) {
      void this.cornerTick();
      this.startCornerPoll();
      // The verifier's timer and its first run — the first run only when the
      // build carries a verifier (WEB_INTERFACE → The extension → "The
      // verified tip").
      if (this.verifier !== null) {
        this.startVerifyTimer();
        this.startVerification();
      }
    }
  }

  private cornerVisible(): boolean {
    return document.visibilityState === 'visible';
  }

  private startCornerPoll(): void {
    if (this.cornerTimer !== null) return;
    this.cornerTimer = setInterval(() => void this.cornerTick(), CORNER_POLL_MS);
  }

  private stopCornerPoll(): void {
    if (this.cornerTimer === null) return;
    clearInterval(this.cornerTimer);
    this.cornerTimer = null;
  }

  private onCornerVisibility(): void {
    if (this.cornerVisible()) {
      void this.cornerTick();
      this.startCornerPoll();
      // A tab that becomes visible again runs a verification only when none
      // has returned yet or the last began ten minutes ago or more — never on
      // every tab switch (WEB_INTERFACE → The extension → "The verified tip").
      if (this.verifier !== null) {
        this.startVerifyTimer();
        if (this.shouldVerifyOnBecomeVisible()) this.startVerification();
      }
    } else {
      this.stopCornerPoll();
      this.stopVerifyTimer();
    }
  }

  /** cornerState over the App's own held state — the last tip, the last rise's
   *  time, whether the last read answered, and the verdict where the build
   *  carries a verifier (WEB_INTERFACE → The status corner, → The extension
   *  → "The verified tip"). */
  private currentCornerState(): CornerState {
    return cornerState({
      lastTip: this.cornerLastTip,
      lastRiseAt: this.cornerLastRiseAt,
      lastReadOk: this.cornerLastReadOk,
      now: Date.now(),
      verdict: this.tipVerdict,
    });
  }

  private renderCornerNow(): void {
    if (this.cornerEl === null) return;
    renderCorner(this.cornerEl, this.currentCornerState(), this.cornerLastTip, this.tipVerdict);
  }

  // ---- the verified tip (WEB_INTERFACE → The extension → "The verified tip") ----
  // The seam the corner's mount, press, ten-minute timer, visibility handler
  // and node-change hook share. A run reads `prefs.node` at the moment it
  // starts; a generation stamps the run so a change of the reading node drops
  // its late verdict rather than rendering it.

  private startVerifyTimer(): void {
    if (this.verifier === null) return;
    if (this.verifyTimer !== null) return;
    this.verifyTimer = setInterval(() => this.startVerification(), VERIFY_INTERVAL_MS);
  }

  private stopVerifyTimer(): void {
    if (this.verifyTimer === null) return;
    clearInterval(this.verifyTimer);
    this.verifyTimer = null;
  }

  private shouldVerifyOnBecomeVisible(): boolean {
    if (this.lastVerifyBeganAt === null) return true;
    return Date.now() - this.lastVerifyBeganAt >= VERIFY_INTERVAL_MS;
  }

  /** Start a verifier run, or drop the trigger. One run at a time: a trigger
   *  during a run is that run (WEB_INTERFACE → The extension → "The verified
   *  tip"). An empty reading base runs nothing; a hidden tab runs nothing.
   *  The gen stamps the run so a late verdict under an older generation is
   *  dropped and never touches the flag or the render. `askedByNames` marks a
   *  run a name check asks for — one that ended `unchecked`, or a send's check
   *  at the press (tipRunForPress); a run that begins on any other trigger lets
   *  a check ask again (→ "The verified names"). */
  private startVerification(askedByNames = false): void {
    if (this.verifier === null) return;
    if (!this.cornerVisible()) return;
    if (this.verifyInFlight) return;
    const readingBase = prefs.node;
    if (readingBase === '') return;
    if (!askedByNames) this.nameRunAsked = false;
    const gen = this.verifyGen;
    this.lastVerifyBeganAt = Date.now();
    this.verifyInFlight = true;
    const verifier = this.verifier;
    void verifier.run(readingBase).then(
      (run) => {
        // A late run under an older generation never touches the flag or
        // the render — the new run's own resolver owns them.
        if (gen !== this.verifyGen) return;
        this.verifyInFlight = false;
        this.tipVerdict = run.verdict;
        this.tipAnchor = run.anchor;
        this.renderCornerNow();
        // WEB_INTERFACE → The extension → "The verified figures" — a run proves
        // a listing read after its anchor, so a `verified` run reads the
        // reader's listings first: /karma always, /credits while the wallet
        // window is open. Each write takes its stamp, moves its row in place
        // and triggers the run. Every other verdict drops the last result so
        // no stale proof rides an unverified chain (figuresLine's row 3 reads
        // the verdict).
        if (run.anchor !== null) {
          this.anchorSeq += 1;
          void this.refreshOwnKarma();
          if (openSet(this.state.workspace).has('@wallet')) void this.refreshWalletCredits();
          // WEB_INTERFACE → The extension → "The verified names" — every pair
          // on screen, against the anchor this run wrote.
          this.checkNames('every');
        } else {
          this.figures = null;
          this.renderCreditsRowInPlace();
          this.renderProfileKarma();
        }
        this.settleTipRunWaiters(run);
      },
      (e) => {
        // A run that throws clears the verdict to `null` under the current
        // generation, so the corner reads *checking* (WEB_INTERFACE → The
        // extension → "The verified tip"). One console.error; a stale
        // rejection touches nothing but the log. The anchor drops with the
        // verdict, and with them the last figures result (→ "The verified
        // figures").
        console.error(e);
        if (gen !== this.verifyGen) return;
        this.verifyInFlight = false;
        this.tipVerdict = null;
        this.tipAnchor = null;
        this.renderCornerNow();
        this.figures = null;
        this.renderCreditsRowInPlace();
        this.renderProfileKarma();
        this.settleTipRunWaiters(null);
      },
    );
  }

  /** A tip run for a send's check at the press — one with no anchor standing, or
   *  one that ended `unchecked` (WEB_INTERFACE → The extension → "The verified
   *  names"): the run in flight joined, or one started as a run a name check
   *  asks for. Answers the run's verdict and anchor as it ends, and null where
   *  no run starts — no verifier, a hidden tab, an empty base — or the run ends
   *  without a verdict. */
  private tipRunForPress(): Promise<TipRun | null> {
    this.startVerification(true);
    if (!this.verifyInFlight) return Promise.resolve(null);
    return new Promise((settle) => this.tipRunWaiters.push(settle));
  }

  /** Settle every press waiting on the run — with its verdict and anchor, or
   *  null where it ends without a verdict. */
  private settleTipRunWaiters(run: TipRun | null): void {
    const waiters = this.tipRunWaiters;
    this.tipRunWaiters = [];
    for (const settle of waiters) settle(run);
  }

  /** The reading node changed — the settings row's `changeNode`, and the seed
   *  adoption at start. Everything loaded came from the node before, so in
   *  every build it drops and the new node is read at once (WEB_INTERFACE → The
   *  settings window, → The status corner): the threads and the post index, the
   *  feed's rows (dropFeedRows), the reader's own state (dropReaderState, the
   *  figures and the tip the gates read among it), and the corner's tip, rise
   *  and last-read flag, so the number beside the dot is never another node's;
   *  `cornerGen` bumps so a tick in flight for the node before drops its answer
   *  when it resolves. The header, the feed and the panes re-render from what
   *  is left — `—` where a figure stood while its read is in flight, never the
   *  node before's — and the corner reads *no tip yet*, tip `—`. Where the
   *  build carries a verifier, a run in flight for the previous node is dropped
   *  by its older generation, the verdict returns to `null` (checking), the
   *  flag is cleared so the new run can start, and it does (WEB_INTERFACE → The
   *  extension → "The verified tip"); a press waiting on the dropped run is
   *  settled without a verdict. Every name check's result is the node
   *  before's answer: the results drop with the generation, so a batch in
   *  flight writes nothing more, and its flags clear before the re-render, which
   *  draws every handle as it reads with no check (→ "The verified names"). */
  private onReadingNodeChanged(): void {
    this.cornerGen += 1;
    this.cornerLastTip = null;
    this.cornerLastRiseAt = null;
    this.cornerLastReadOk = null;
    if (this.verifier !== null) {
      this.verifyGen += 1;
      this.verifyInFlight = false;
      this.tipVerdict = null;
      this.tipAnchor = null;
      this.settleTipRunWaiters(null);
    }
    this.nameChecks.clear();
    this.namesGen += 1;
    this.namesInFlight = false;
    this.namesMarked = null;
    this.state.threads.clear();
    this.state.posts.clear();
    this.dropFeedRows();
    this.dropReaderState();
    this.renderHeader();
    this.renderFeed();
    this.renderPanes();
    this.renderCornerNow();
    void this.cornerTick();
    if (this.verifier !== null) this.startVerification();
    for (const id of openSet(this.state.workspace)) if (!isWin(id)) void this.fetchThread(id);
    this.rereadReaderState();
  }

  // ---- the verified figures (WEB_INTERFACE → The extension → "The verified
  // figures") ----
  // The App runs the figures verifier when it has an identity, an anchor and a
  // karma listing read after that anchor; a credits listing not read after it —
  // the wallet window closed, or its read older than the anchor — is passed
  // empty. Single flight: a trigger during a run marks one more run; a listing
  // that moved during a run drops the result and runs again; a result under an
  // older generation is dropped.

  /** Start a figures verifier run, or drop the trigger. Runs only when the App
   *  holds every input the tool needs, and proves only a listing read after the
   *  anchor it is proven against — one read before it may name a box spent
   *  since, which the chain rightly no longer holds. Object identity of
   *  `profileKarma` and `walletCredits` is the "listing moved" check — every
   *  write assigns a fresh object from readOwnKarma / readOwnCredits, so a
   *  captured pair identical to the field pair is the pair the run proved. */
  private startFigures(): void {
    if (this.figuresVerifier === null) return;
    const cur = this.idm.current();
    if (cur === null) return;
    const anchor = this.tipAnchor;
    if (anchor === null) return;
    const capturedKarma = this.profileKarma;
    if (capturedKarma === null || !this.readAfterAnchor(this.profileKarmaStamp)) return;
    if (this.figuresInFlight) {
      this.figuresDirty = true;
      return;
    }
    const capturedCredits = this.walletCredits;
    const listing: Listing = {
      karma: {
        boxes: capturedKarma.boxes,
        height: capturedKarma.height,
        effective: capturedKarma.effective,
      },
      credits: {
        boxes: capturedCredits !== null && this.readAfterAnchor(this.walletCreditsStamp) ? capturedCredits.boxes : [],
      },
    };
    const gen = this.figuresGen;
    this.figuresInFlight = true;
    const verifier = this.figuresVerifier;
    void verifier.run(prefs.node, cur.pubKeyHex, listing, anchor).then(
      (result) => {
        if (gen !== this.figuresGen) return;
        this.figuresInFlight = false;
        if (this.profileKarma !== capturedKarma || this.walletCredits !== capturedCredits) {
          // The listing moved during the run — the result belongs to the
          // listing that has passed; run again against the one the App now
          // holds. The dirty flag is cleared implicitly by the fresh call.
          this.figuresDirty = false;
          this.startFigures();
          return;
        }
        this.figures = { result, anchor };
        this.renderCreditsRowInPlace();
        this.renderProfileKarma();
        if (this.figuresDirty) {
          this.figuresDirty = false;
          this.startFigures();
        }
      },
      (e) => {
        // A run that throws leaves `figures` alone — a run in flight keeps
        // the line it had (WEB_INTERFACE → The extension → "The verified
        // figures" — "a run in flight keeps the line it had"). One
        // console.error; a stale rejection touches nothing but the log.
        console.error(e);
        if (gen !== this.figuresGen) return;
        this.figuresInFlight = false;
        if (this.figuresDirty) {
          this.figuresDirty = false;
          this.startFigures();
        }
      },
    );
  }

  /** The stamp of a read of the reader's own listing that begins now — taken
   *  before its first await, never at its write: a read that began before an
   *  anchor and ended after it predates the anchor. */
  private listingStamp(): ListingStamp {
    return { seq: this.anchorSeq, anchored: this.tipAnchor !== null };
  }

  /** A listing is read after the current anchor when an anchor stood as its read
   *  began and none has landed since (WEB_INTERFACE → The extension → "The
   *  verified figures"). */
  private readAfterAnchor(stamp: ListingStamp | null): boolean {
    return stamp !== null && stamp.anchored && stamp.seq === this.anchorSeq && this.tipAnchor !== null;
  }

  /** A read of the reader's own state begins: its place in the order such reads
   *  began in, taken before its first await as the stamp is. */
  private beginRead(): number {
    this.readsBegun += 1;
    return this.readsBegun;
  }

  /** Whether the answer of the read begun at `order` replaces the piece's held
   *  answer — never when the held answer's read began later — holding its order
   *  when it does. */
  private newerRead(piece: ReaderPiece, order: number): boolean {
    if (order < (this.heldRead.get(piece) ?? 0)) return false;
    this.heldRead.set(piece, order);
    return true;
  }

  // ---- the verified names (WEB_INTERFACE → The extension → "The verified
  // names") ----
  // The App checks the key-and-name pairs its surfaces show: every pair on
  // screen after each tip run that ends `verified`, and after each render of a
  // surface that draws handles the pairs no check has decided — a pair first on
  // a surface, whether a read brought its row or a window opened over rows the
  // App already held. A result that changes a pair's clay lands on its marked
  // handles where they stand (view/name-handle.ts).

  /** Check the pairs on screen — `every` one, or the `new` ones no check has
   *  decided — against the anchor standing, one after another. With no verifier
   *  or no anchor nothing runs; a trigger during a batch marks one more, `every`
   *  over `new`. */
  private checkNames(scope: 'new' | 'every'): void {
    if (this.namesVerifier === null) return;
    if (this.namesInFlight) {
      if (this.namesMarked !== 'every') this.namesMarked = scope;
      return;
    }
    if (this.tipAnchor === null) return;
    const pairs = this.namePairsOnScreen()
      .filter((p) => scope === 'every' || !this.nameChecks.has(namePair(p.key, p.name)));
    if (pairs.length === 0) return;
    this.namesInFlight = true;
    void this.runNameBatch(this.namesVerifier, pairs, prefs.node, this.namesGen);
  }

  /** One batch: each pair checked against the anchor standing as its check
   *  begins, the batch ending where none stands. A check is total, so a
   *  rejection is the seam's own failure — logged, and the pair keeps no result.
   *  A batch under an older generation writes nothing and leaves the flags to
   *  the generation that moved it. */
  private async runNameBatch(
    verifier: NamesVerifier,
    pairs: Array<{ key: string; name: string }>,
    readingBase: string,
    gen: number,
  ): Promise<void> {
    for (const { key, name } of pairs) {
      const anchor = this.tipAnchor;
      if (anchor === null) break;
      let result: NameResult;
      try {
        result = await verifier.run(readingBase, { key, name }, anchor);
      } catch (e) {
        console.error(e);
        if (gen !== this.namesGen) return;
        continue;
      }
      if (gen !== this.namesGen) return;
      this.landName(key, name, result);
      if (result.status === 'unchecked') this.askTipRunForNames();
    }
    this.namesInFlight = false;
    const marked = this.namesMarked;
    this.namesMarked = null;
    if (marked !== null) this.checkNames(marked);
  }

  /** Hold a check's result for its pair. A result that leaves the pair's clay
   *  as it was touches nothing on screen; one that changes it lands on the
   *  pair's handles in place (HOUSE_STYLE → Motion). */
  private landName(key: string, name: string, result: NameResult): void {
    const pair = namePair(key, name);
    const was = nameIsClay(this.nameChecks.get(pair));
    this.nameChecks.set(pair, result);
    const is = nameIsClay(result);
    if (was !== is) landNameClay([this.appbar, this.feedEl, this.panesEl], pair, is);
  }

  /** A check that ended `unchecked` — a block landed since the anchor — asks for
   *  one tip run, whose verified resolver checks every pair again against the
   *  fresh anchor. Once asked, no check asks again until a run no check asked
   *  for begins. */
  private askTipRunForNames(): void {
    if (this.nameRunAsked) return;
    this.nameRunAsked = true;
    this.startVerification(true);
  }

  /** The pairs the surfaces show, each once, read from the App's state — the
   *  sources every handle site renders from (WEB_INTERFACE → The identity
   *  display): the reader's own name beside the loaded key (the header, the
   *  profile's `username` row, the reader's own cards); the feed's rows; and for
   *  every open window, a thread's rows with the index row its bar reads while
   *  no root of its own stands, an author window's subject name and endorsers,
   *  a posts window's rows with the subject name its bar reads, and the
   *  profile's standing bonds. A window stacked behind another counts: its bar,
   *  and its body once focused, draw from the same state. */
  private namePairsOnScreen(): Array<{ key: string; name: string }> {
    const pairs = new Map<string, { key: string; name: string }>();
    const add = (key: string, name: string | null): void => {
      if (name === null) return;
      const pair = namePair(key, name);
      if (!pairs.has(pair)) pairs.set(pair, { key, name });
    };
    const addRow = (row: FeedRow | null | undefined): void => {
      if (row) add(row.author, row.authorName);
    };
    const cur = this.idm.current();
    if (cur !== null && this.ownName !== null) add(cur.pubKeyHex, this.ownName.name);
    if (!this.standalone) {
      for (const row of this.state.feed.pending) addRow(row);
      for (const row of this.state.feed.posts) addRow(row);
    }
    for (const id of openSet(this.state.workspace)) {
      const sub = windowSubject(id);
      if (sub !== null) {
        const d = this.authorData.get(sub.key);
        if (d?.username) add(sub.key, d.username.name);
        if (sub.kind === 'author') {
          for (const v of d?.endorsers?.vouches ?? []) add(v.voucherId, v.voucherName);
        } else {
          for (const row of this.authorPostsData.get(sub.key)?.posts ?? []) addRow(row);
        }
      } else if (id === '@profile') {
        for (const b of this.bondsView?.bonds ?? []) add(b.inviteePublicKey, b.inviteeName);
      } else if (!isWin(id)) {
        addRow(this.state.posts.get(id));
        const t = this.state.threads.get(id);
        if (t) {
          addRow(t.root);
          for (const row of t.descendants) addRow(row);
        }
      }
    }
    return [...pairs.values()];
  }

  /** Read /blocks/current, update the corner's state, feed viewerTip. The first
   *  answering read is treated as a rise, so a page opens fresh — the corner
   *  never opens clay on load for a chain the client has not yet observed
   *  (WEB_INTERFACE → The status corner). A failed read keeps the last known
   *  tip and turns the dot muted. The gen is captured at the top and checked
   *  after the await: an answer under a stale gen — a read in flight when the
   *  reading node changed — touches no field, no `bumpTip`, no render. */
  private async cornerTick(): Promise<void> {
    const gen = this.cornerGen;
    try {
      const b = await this.client.currentBlock();
      if (gen !== this.cornerGen) return;
      const now = Date.now();
      if (this.cornerLastTip === null || b.height > this.cornerLastTip) {
        this.cornerLastRiseAt = now;
      }
      this.cornerLastTip = b.height;
      this.cornerLastReadOk = true;
      this.bumpTip(b.height);
    } catch {
      if (gen !== this.cornerGen) return;
      this.cornerLastReadOk = false;
    }
    this.renderCornerNow();
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
    const gen = this.readerGen;
    try {
      const block = await this.client.currentBlock();
      // A height read for the node or the key before is dropped; the next tick
      // reads the one now in force.
      if (gen !== this.readerGen) return;
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
   *  pointer are lost even where the pixels match. Every landing of the reader's
   *  own transaction re-reads the listing it changed, once per tick however many
   *  land in it, and a grant is decided on that same read (WEB_INTERFACE → The
   *  profile window → "The `rep` row is the `effective` number alone", → The
   *  wallet window → "The `balance` row", → The faucet step). A read that
   *  answers after the reader's own state dropped ends the tick, writing nothing;
   *  a piece a read begun after the tick's own already answered keeps that
   *  answer (newerRead), and the tick still decides its entries on its own read. */
  private async reconcile(tip: number): Promise<void> {
    const gen = this.readerGen;
    let feedTouched = false;
    let inviteChanged = false;
    let usernameChanged = false;
    let grantSettled = false;
    let creditsChanged = false;
    let karmaLanded = false;
    let creditsLanded = false;
    const touchedPosts = new Set<string>();
    const touchedAuthors = new Set<string>();
    const postsWindowsTouched = new Set<string>(); // @posts windows a withdrawal landing emptied a row from

    // The vouch and unvouch entries reconcile against the reader's own vouch set
    // and escrow, and the invite entries against the bonds — read once when one
    // stands (WEB_INTERFACE → The wallet).
    const cur = this.idm.current();
    const entries = this.ledger.all();
    const hasMembership = cur !== null && entries.some((e) => e.kind === 'vouch' || e.kind === 'unvouch');
    const hasInvite = cur !== null && entries.some((e) => e.kind === 'invite');
    let vouchRows: { targetId: string }[] = [];
    let bondRows: { inviteePublicKey: string }[] = [];
    if (hasMembership && cur !== null) {
      const order = this.beginRead();
      const vouched = await this.readVouchSet(cur.pubKeyHex);
      const escrow = await this.readEscrow(cur.pubKeyHex);
      if (gen !== this.readerGen) return;
      if (this.newerRead('vouches', order)) {
        this.vouched = vouched;
        this.escrowHeldUntil = escrow;
      }
      this.bumpTip(tip);
      vouchRows = [...vouched.keys()].map((targetId) => ({ targetId }));
    }
    if (hasInvite && cur !== null) {
      const order = this.beginRead();
      const bonds = await this.client.bonds(cur.pubKeyHex);
      if (gen !== this.readerGen) return;
      if (this.newerRead('bonds', order)) this.bondsView = bonds;
      bondRows = bonds.bonds;
    }

    for (const entry of entries) {
      // A grant lands in the listing the tick reads once below; it is decided
      // there, on that read.
      if (entry.kind === 'grant' || entry.kind === 'creditGrant') continue;
      if (entry.kind === 'send') {
        if (cur === null) continue;
        const outcome = await this.reconcileSendEntry(entry, tip, gen);
        if (gen !== this.readerGen) return;
        if (outcome === 'landed') creditsLanded = true;
        if (outcome === 'landed' || outcome === 'expired') creditsChanged = true;
        continue;
      }
      if (entry.kind === 'vouch') {
        const outcome = reconcileVouch(entry, vouchRows, tip);
        if (outcome === 'pending') continue;
        this.ledger.remove(entry.txId);
        this.optimisticVouches.delete(entry.postId);
        const vd = this.authorData.get(entry.postId);
        if (vd) vd.flight = outcome === 'expired' ? { stage: 'expired', expiresAtHeight: entry.expiresAtHeight } : null;
        if (outcome === 'landed') karmaLanded = true;
        touchedAuthors.add(entry.postId);
        continue;
      }
      if (entry.kind === 'unvouch') {
        const outcome = reconcileUnvouch(entry, vouchRows, tip);
        if (outcome === 'pending') continue;
        this.ledger.remove(entry.txId);
        const d = this.authorData.get(entry.postId);
        if (d) d.flight = null;
        if (outcome === 'landed') karmaLanded = true;
        touchedAuthors.add(entry.postId);
        continue;
      }
      if (entry.kind === 'invite') {
        const outcome = reconcileInvite(entry, bondRows, tip);
        if (outcome === 'pending') continue;
        this.ledger.remove(entry.txId);
        if (outcome === 'landed') {
          // The line reads the new invitesAvailable from the tick's /karma read.
          this.inviteFlight = null;
          karmaLanded = true;
        } else {
          this.inviteFlight = { stage: 'expired', expiresAtHeight: entry.expiresAtHeight };
        }
        inviteChanged = true;
        continue;
      }
      if (entry.kind === 'claim' || entry.kind === 'burn') {
        if (cur === null) continue;
        const order = this.beginRead();
        const held = await this.client.usernameByOwner(cur.pubKeyHex);
        if (gen !== this.readerGen) return;
        const outcome = entry.kind === 'claim' ? reconcileClaim(entry, held, tip) : reconcileBurn(entry, held, tip);
        if (outcome === 'pending') continue;
        this.ledger.remove(entry.txId);
        if (outcome === 'landed') {
          if (this.newerRead('name', order)) {
            this.ownName = held;
            this.ownNameLoaded = true;
          }
          this.usernameFlight = null;
          karmaLanded = true;
        } else {
          this.usernameFlight = {
            stage: 'expired',
            expiresAtHeight: entry.expiresAtHeight,
            onTryAgain: entry.kind === 'claim'
              ? () => { this.usernameFlight = null; void this.claimUsername(entry.postId); }
              : () => { this.usernameFlight = null; void this.burnUsername(); },
          };
        }
        usernameChanged = true;
        continue;
      }
      const fetched = await this.client.post(entry.postId, this.viewer());
      if (gen !== this.readerGen) return;
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
        if (outcome === 'landed') karmaLanded = true;
      } else if (entry.kind === 'like') {
        const outcome = reconcileLike(entry, fetched, tip);
        if (outcome === 'pending') continue;
        this.optimisticLikes.delete(entry.postId);
        this.ledger.remove(entry.txId);
        if (outcome === 'expired') this.setReportForPost(entry.postId, 'a like expired before any block took it');
        if (outcome === 'landed') {
          this.applyFetchedRow(fetched);
          karmaLanded = true;
        }
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
          karmaLanded = true;
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

    // The tick's one /karma read: the listing every karma-side landing changed,
    // and the faucet grant's landing signal — `boxCount` risen (WEB_INTERFACE →
    // The faucet step). Read after every landing above was observed, so it holds
    // what they spent; a failed read keeps a grant pending and the rep row's last
    // listing, and the next tick or ↻ reads again.
    const grants = entries.filter((e) => e.kind === 'grant');
    let karmaTaken = false;
    if (cur !== null && (karmaLanded || grants.length > 0)) {
      const stamp = this.listingStamp();
      const order = this.beginRead();
      let karma: KarmaResult | null = null;
      try {
        karma = await this.readOwnKarma(cur.pubKeyHex);
      } catch {
        karma = null;
      }
      if (gen !== this.readerGen) return;
      if (karma !== null) {
        for (const entry of grants) {
          const outcome = reconcileGrant(entry, karma, tip);
          if (outcome === 'pending') continue;
          this.ledger.remove(entry.txId);
          this.grantView = outcome === 'landed' ? null : { state: 'expired', atHeight: entry.expiresAtHeight };
          if (outcome === 'landed') karmaLanded = true;
          grantSettled = true;
        }
        if (karmaLanded) karmaTaken = this.takeKarma(karma, stamp, order);
      }
    }

    // The tick's one /credits read of the reader's own key: the listing a send's
    // landing changed, and the credits grant's landing signal — the box the
    // faucet named, listed (WEB_INTERFACE → The faucet step, → The wallet).
    const creditGrants = entries.filter((e) => e.kind === 'creditGrant');
    let creditsTaken = false;
    if (cur !== null && (creditsLanded || creditGrants.length > 0)) {
      const stamp = this.listingStamp();
      const order = this.beginRead();
      let credits: CreditsResult | null = null;
      try {
        credits = await this.readOwnCredits(cur.pubKeyHex);
      } catch {
        credits = null;
      }
      if (gen !== this.readerGen) return;
      if (credits !== null) {
        for (const entry of creditGrants) {
          const outcome = reconcileCreditGrant(entry, credits, tip);
          if (outcome === 'pending') continue;
          this.ledger.remove(entry.txId);
          this.creditGrantView = outcome === 'landed' ? null : { state: 'expired', atHeight: entry.expiresAtHeight };
          if (outcome === 'landed') creditsLanded = true;
          creditsChanged = true;
        }
        if (creditsLanded) creditsTaken = this.takeCredits(credits, stamp, order);
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
    // A claim or burn that settled moves the username row and the header, after
    // the /karma the row's burn gate reads (WEB_INTERFACE → The username row).
    if (usernameChanged) {
      this.renderUsernameRowInPlace();
      this.renderHeader();
    }
    // A settled grant moves the rep row's line; where this tick's listing was
    // taken, the row moved with it already.
    if (grantSettled && !karmaTaken) this.renderProfileKarma();
    // A send's or a credits grant's ending moves the balance row in place — the
    // row moves colour and text in a fixed box (HOUSE_STYLE → Motion).
    if (creditsChanged && !creditsTaken) this.renderCreditsRowInPlace();
  }

  /** Reconcile a pending send: read the recipient's /credits and look for the
   *  payment box (`computeCandidateBoxId`, exact) among their boxes. The row's
   *  flight slot reads *sent* or the expiry on the render the tick ends with,
   *  beside the balance the tick's own /credits read moves (WEB_INTERFACE → The
   *  wallet window). Answers the outcome, or null when the read failed or
   *  answered after the reader's own state dropped. */
  private async reconcileSendEntry(entry: PendingEntry, tip: number, gen: number): Promise<EntryOutcome | null> {
    const recipient = entry.postId; // a send's subject is the recipient's key
    let recipientBoxes;
    try {
      recipientBoxes = await this.readAllCreditBoxes(recipient);
    } catch {
      return null; // a failed read keeps the entry; the next tick retries
    }
    if (gen !== this.readerGen) return null;
    const outcome = reconcileSend(entry, recipientBoxes, tip);
    if (outcome === 'pending') return outcome;
    this.ledger.remove(entry.txId);
    // The row renders *sent* directly from the landed stage; stageLine has no
    // `landed` case (WEB_INTERFACE → The wallet window → "The `send` row"). An
    // expiry reads once, then the reader may try again from the form; the
    // pending line is gone with the entry.
    this.sendFlight = outcome === 'landed'
      ? { stage: 'landed' }
      : { stage: 'expired', expiresAtHeight: entry.expiresAtHeight };
    return outcome;
  }

  /** Read every credit box the recipient holds — one page at a time, following
   *  `next`. The bare {boxId} shape reconcileSend needs. */
  private async readAllCreditBoxes(key: string): Promise<Array<{ boxId: string }>> {
    const boxes: Array<{ boxId: string }> = [];
    let after: string | null = null;
    do {
      const page: CreditsResult = await this.client.credits(key, after === null ? {} : { after });
      for (const b of page.boxes) boxes.push({ boxId: b.boxId });
      after = page.next;
    } while (after !== null);
    return boxes;
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
