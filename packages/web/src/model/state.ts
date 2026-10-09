import type { PostJson, WithdrawnJson, LightJson, FeedRow, StatusResult, KarmaResult, VouchesTargetResult, BondsResult, CreditsResult, UsernameResult } from '../api/dto';
import type { Workspace, Origin } from './workspace';
import type { Theme, IdTint } from '../prefs';
import type { Flight } from '../view/card';
import type { YourVouch } from '../view/author';
import type { SendAnswer, SendRecipient } from '../view/wallet';
import type { SignResult } from '../wallet/submit';
import type { TipVerdict } from './tip-verdict';
import type { Anchor, FiguresResult, Listing, NameClaim, NameResult, PostCheck } from '@dagsocial/nipopow-client';
import type { BoundPost, ResolveEnd } from './post-resolve';
export type { Anchor };

/** What the App holds when a figures verifier run has returned — the tool's
 *  full result and the anchor it was proven against. The anchor's
 *  `suffixHead.header.height` is the height the *proven at block N* clause
 *  names; the anchor's presence beside the result lets a later run drop a
 *  result that no longer belongs to the anchor the App now holds
 *  (WEB_INTERFACE → The extension → "The verified figures"). The App's
 *  figures run writes one when it returns for the listings the App still
 *  holds; the App holds null until then, and again once the reader's state
 *  drops or a tip run ends without an anchor. */
export interface FiguresView {
  result: FiguresResult;
  anchor: Anchor;
}

// The read surface's runtime state, and the handler contract the pure view
// modules render against. Types only — no cycle between controller and views.

/** The composer key for the feed's new post; a reply composer keys on its parent
 *  id. Shared so the opener's data-composer-open matches composerFor(null). */
export const FEED_COMPOSER_KEY = '@feed';

export interface FeedState {
  /** The feed's live rows: confirmed posts, with withdrawn rows filtered out
   *  (WEB_INTERFACE → The withdrawn state), and the slot a reader that lacks
   *  the post holds against its id (WEB_INTERFACE → The extension → "The
   *  light read"). */
  posts: Array<PostJson | LightJson>;
  /** Mempool rows — a pending post or a pending slot (WEB_INTERFACE → The
   *  extension → "The light read"). */
  pending: Array<PostJson | LightJson>;
  next: string | null;      // keyset cursor for older posts
  report: string | null;    // what the last ↻ did
  olderReport: string | null; // what the last "load older" did
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** The count of `unbound` rows the list's standing reads withheld — a
   *  continuation adds, a refresh resets, zero when none (WEB_INTERFACE →
   *  The extension → "The post check"). */
  unboundCount: number;
}

export interface ThreadState {
  id: string;
  /** The subject the pane draws — a full post, a withdrawn marker, a slot for
   *  one not held, or `null` where no answer has stood yet (WEB_INTERFACE →
   *  The extension → "The light read"). */
  root: PostJson | WithdrawnJson | LightJson | null;
  ancestorIds: Set<string>;   // for the "↳ nested" check
  descendants: FeedRow[];
  descendantCount: number;
  next: string | null;
  report: string | null;
  loading: boolean;
  error: string | null;
  /** The count of `unbound` rows this thread's standing reads withheld
   *  (WEB_INTERFACE → The extension → "The post check"). */
  unboundCount: number;
  /** The withheld state of the thread's own subject (WEB_INTERFACE → The
   *  extension → "The post check"): `'unbound'` shows the clay line and
   *  nothing of the node's row; `'unserved'` shows one muted line and no
   *  row; `null` renders the thread as normal. */
  subjectWithheld: 'unbound' | 'unserved' | null;
}

export interface AppState {
  feed: FeedState;
  threads: Map<string, ThreadState>;
  workspace: Workspace;
  status: StatusResult | null;
  posts: Map<string, PostJson>; // every PostJson seen, for parent-reference lookup
  submissions: Submission[];    // the client's own in-flight posts, rendered as cards
}

// The flight of one of the client's own submissions — two stages then one of
// three endings; a pending card the reader may watch turn from hollow to landed
// without asking, because they asked for the post.
// HOUSE_STYLE → "Pending state is the one legitimate unsolicited update, and it pays for itself in geometry"
export type FlightStage = 'submitting' | 'submitted' | 'landed' | 'expired' | 'rejected';

/** A post the reader submitted, rendered from the composer's own data as a
 *  pending card until it lands, expires or is rejected. */
export interface Submission {
  localKey: string;             // stable while submitting, before a txId exists
  content: string;
  parentId: string | null;      // null → a feed root; a post id → a reply under it
  author: string;               // the loaded identity's key
  contentHash: string;          // computed locally, so the render-path check is silent
  stage: FlightStage;
  txId: string | null;
  postId: string | null;        // the node's own id, once the 200 body carries it
  blockHeight: number | null;   // the block that took it, once landed
  expiresAtHeight: number | null;
  reason: string | null;        // the node's reason, once rejected
}

/** What the views need to render, without reaching into the controller. */
export interface RenderCtx {
  openSet: Set<string>;
  thread: (id: string) => ThreadState | undefined;
  post: (id: string) => PostJson | undefined;
  // The width class — the client shows one column at a time below the breakpoint,
  // the same value as the stylesheet's media query (WEB_INTERFACE → The workspace).
  oneColumn: boolean;
  // WEB_INTERFACE → The standalone thread
  standalone: boolean;
  // Write surface — all inert with no identity loaded, so the client renders
  // exactly as the read surface does (WEB_INTERFACE → The write surface).
  writeEnabled: boolean;                                  // an identity is loaded
  ownKey: string | null;                                  // its public key, for the own-post like exclusion
  composerFor: (parentId: string | null) => HTMLElement | null; // the reused composer element, null → none open here
  submissionsFor: (parentId: string | null) => Submission[];    // own pending cards to place under a parent (null → the feed)
  likePending: (postId: string) => boolean;              // overlay onto likedByViewer until a like lands
  // Content — the images the reader has expanded this session, keyed
  // <postId>:<index in document order> (WEB_INTERFACE → Content).
  expandedImages: ReadonlySet<string>;
  // Profile window (WEB_INTERFACE → The profile window). identity carries the lock
  // state; karma is the loaded key's /karma; grant is a faucet grant in flight or
  // one that lapsed. These inline shapes structurally match view/profile.ts's
  // ProfileCtx, so one contract serves both.
  identity: { pubKeyHex: string; locked: boolean } | null;
  backedUp: boolean;
  karma: KarmaResult | null;
  grant: { state: 'pending' } | { state: 'expired'; atHeight: number } | null;
  // Membership actions (WEB_INTERFACE → The identity display).
  member: boolean;
  // The your-vouch row's state for an identity — the App derives it from the
  // vouch set, member, the escrow and /status's cooldown (WEB_INTERFACE → The
  // author window). null with no identity loaded — no row.
  yourVouch: (key: string) => YourVouch | null;
  // The author and author-posts windows, one entry per open window
  // (WEB_INTERFACE → The author window).
  author: Map<string, AuthorWindowData>;
  authorPosts: Map<string, FeedState>;
  // The profile's invites row (WEB_INTERFACE → The profile window). The bond
  // range and probation from /status, whether the spendable covers the minimum,
  // the reader's standing bonds, and the invite flight.
  invite: { bondMin: string; bondMax: string; probationBlocks: number } | null;
  canAffordMinBond: boolean;
  bonds: BondsResult | null;
  inviteFlight: Flight | null;
  // The author's own controls (WEB_INTERFACE → The withdraw control). withdrawState
  // is 'pending' from the ledger's entry (durable across a reload), else the
  // transient flight; canSignWithdraw is the spendable view non-empty.
  withdrawState: (postId: string) => 'pending' | Flight | null;
  canSignWithdraw: boolean;
  // The reader's own name (WEB_INTERFACE → The identity display).
  ownName: UsernameResult | null;
  ownNameLoaded: boolean;
  // Whether the handle a key and a name render as reads clay — the check the App
  // holds for the pair, false while none has decided it (WEB_INTERFACE → The
  // extension → "The verified names", → The identity display). Every view that
  // renders a handle reads it.
  nameClay: (key: string, name: string) => boolean;
  // The username row (WEB_INTERFACE → The username row).
  usernameFlight: Flight | null;
  pendingUsername: { kind: 'claim' | 'burn'; name: string } | null;
  canSignClaim: boolean;
  canAffordBurn: boolean;
  // The wallet window (WEB_INTERFACE → The wallet window). credits is the
  // reader's own /credits, null before the first read; creditGrant is a faucet
  // transfer in flight or one that lapsed; sendFlight is the transient ending;
  // pendingSend is the ledger's own send entry — the durable line that survives
  // a reload; sendCheck is the handle a press's check runs for in the
  // extension, `@` and the name as typed, null while none runs; sendAnswer the
  // answer the App gave the extension's press before — a refusal, or the key
  // the send goes to with the unlock a locked identity owes (→ "The `send`
  // row"). status is the last /status the App holds — its blockHeight is the
  // tip the balance row's spendable-at-height filter reads (WEB_INTERFACE → The
  // wallet).
  status: StatusResult | null;
  credits: CreditsResult | null;
  creditGrant: { state: 'pending' } | { state: 'expired'; atHeight: number } | null;
  sendFlight: Flight | null;
  pendingSend: { toHex: string; toName: string | null; amount: bigint } | null;
  sendCheck: string | null;
  sendAnswer: SendAnswer | null;
  // The wallet's send row confirm — true on the web build (the confirm row
  // stands), false in the extension (the prompt is the one confirmation —
  // WEB_INTERFACE → The wallet window → "in the web build, the confirm row",
  // → "in the extension there is no confirm row"). The App fills it
  // `!this.idm.policy`, the same predicate the policy row reads on.
  confirmInRow: boolean;
  // The extension's tip verifier's latest verdict, the pure `figuresLine` model's
  // rows 1 and 2 read it (WEB_INTERFACE → The extension → "The verified
  // figures"). undefined: the build has no verifier — nothing beneath the
  // figure. null: the verifier is present but no result stands — silence too,
  // unless the verdict is `thin` or `refused`, when the line names the
  // unverified chain.
  verdict: TipVerdict | null | undefined;
  // The verified-figures run's result and the anchor it was proven against —
  // the wallet's balance row and the profile's rep row read it through the
  // pure `figuresLine` model (WEB_INTERFACE → The extension → "The verified
  // figures"). The App passes the result its figures run holds — null while
  // none stands, and always in a build with no verifier.
  figures: FiguresView | null;
  // WEB_INTERFACE → Links
  linkUrl: (id: string) => string;
}

/** One open author window's reads and flight (WEB_INTERFACE → The author window). */
export interface AuthorWindowData {
  endorsers: VouchesTargetResult | null;
  endorsersNext: boolean;
  flight: Flight | null;
  username: UsernameResult | null;
  usernameLoaded: boolean;
}

export interface Handlers {
  // feed
  openThread: (id: string, origin: Origin) => void;
  refreshFeed: () => void;
  loadOlder: () => void;
  openProfile: () => void;
  openSettings: () => void; // the header's `settings` control (WEB_INTERFACE → The settings window)
  openWallet: () => void; // the header's `wallet` control (WEB_INTERFACE → The wallet window)
  refreshProfile: () => void; // the @profile window's ↻ re-reads /karma
  refreshWallet: () => void; // the @wallet window's ↻ re-reads /credits
  // region / window
  focus: (id: string) => void;
  refreshThread: (id: string) => void;
  threadMore: (id: string) => void;
  moveLeft: (id: string) => void;
  moveRight: (id: string) => void;
  close: (id: string) => void;
  // preferences
  setTheme: (t: Theme) => void;
  setIdTint: (m: IdTint) => void;
  setNode: (origin: string) => void;
  // identity operations (WEB_INTERFACE → The profile window)
  inspectFile: (text: string) => Promise<{ kind: 'clear' | 'encrypted'; pubKeyHex: string }>;
  draftIdentity: () => Promise<{ pubKeyHex: string }>;
  createIdentity: (passphrase: string) => Promise<void>;
  discardDraft: () => void;
  importIdentity: (text: string, passphrase: string) => Promise<void>;
  exportIdentity: (password: string) => Promise<void>;
  forgetIdentity: () => Promise<void>;
  lockIdentity: () => Promise<void>;
  unlockIdentity: (passphrase: string) => Promise<void>;
  askFaucet: () => void;
  // write surface
  openComposer: (parentId: string | null) => void; // null → the feed's new post; a post id → a reply
  // Content — an image loads on the reader's press (WEB_INTERFACE → Content).
  expandImage: (key: string) => void;   // the reader pressed to load an image
  collapseImage: (key: string) => void; // a shown image failed to load — drop its key
  likePost: (postId: string) => void;
  withdrawPost: (postId: string) => void;          // the author's own control (WEB_INTERFACE → The withdraw control)
  tryAgain: (localKey: string) => void;            // rebuild a fresh transaction from the current view
  // membership actions (WEB_INTERFACE → The identity display, → The author window)
  vouch: (key: string) => void;                    // + at once, no confirmation
  unvouch: (key: string) => void;                  // from the author window, the box resolved at the press
  openAuthor: (key: string, origin: Origin) => void;
  refreshAuthor: (key: string) => void;            // the author window's ↻ — re-reads the endorsers page and the subject's name
  openAuthorPosts: (key: string, origin: Origin) => void;
  refreshAuthorPosts: (key: string) => void;       // the posts window's ↻ — reports what it did
  authorPostsMore: (key: string) => void;          // the posts window's `more`, following next
  moreEndorsers: (key: string) => void;            // the endorsers page's `more`, following next
  invite: (inviteeKey: string, bond: bigint) => void; // from the profile's invites row
  moreBonds: () => void;                           // the standing-bonds `more`, following next
  // The username row (WEB_INTERFACE → The username row).
  claimUsername: (name: string) => void;
  burnUsername: () => void;
  // The wallet's send row (WEB_INTERFACE → The wallet window → "The `send`
  // row"). beginSendPress opens every press — false while a handle's check runs,
  // when the press does nothing; pressSend is the extension's press once the form
  // has read its amount and recipient; resolveRecipient is the handle → holder
  // read the web build's form runs at the press; send is the credits transfer;
  // askFaucetCredits is the faucet's $NOTIS step (→ The faucet step).
  beginSendPress: () => boolean;
  pressSend: (to: SendRecipient, amount: bigint) => void;
  resolveRecipient: (name: string) => Promise<{ key: string; name: string | null } | { refusal: string }>;
  send: (toHex: string, toName: string | null, amount: bigint) => void;
  askFaucetCredits: () => void;
  // The extension's binary sign policy (WEB_INTERFACE → The settings window).
  // Defined only in the extension build — the row renders only when both are
  // present.
  policy?: () => 'silent' | 'ask';
  setPolicy?: (p: 'silent' | 'ask') => Promise<void>;
  // The extension's links preference (WEB_INTERFACE → The settings window).
  // Defined only in an extension build whose `notis-public` is not empty — the
  // row renders only when both are present.
  links?: () => 'site' | 'here';
  setLinks?: (v: 'site' | 'here') => Promise<void>;
}

/** What the App calls on the identity module — the single reference it holds
 *  (WEB_INTERFACE → The identity module). It extends the wallet's Signer seam
 *  and adds the operations the profile window and the reader's own flow need.
 *  The extension's proxy implements the same interface over the background
 *  service; the in-page module implements it directly (WEB_INTERFACE → The
 *  extension). */
export interface AppIdentity {
  current(): { pubKeyHex: string; locked: boolean } | null;
  sign(txBytes: Uint8Array, txIdHex: string, hint?: { content?: string }): Promise<SignResult>;
  /** Draft a fresh keypair — asynchronous because the extension's proxy sends
   *  it as a message; the in-page module wraps its result in Promise.resolve. */
  draft(): Promise<{ pubKeyHex: string }>;
  create(passphrase: string): Promise<{ pubKeyHex: string }>;
  discardDraft(): void;
  /** Read a file's shape — asynchronous for the same reason as `draft`. */
  inspectFile(text: string): Promise<{ kind: 'clear' | 'encrypted'; pubKeyHex: string }>;
  importFile(text: string, passphrase: string): Promise<{ pubKeyHex: string }>;
  exportFile(password: string): Promise<string>;
  unlock(passphrase: string): Promise<void>;
  lock(): Promise<void>;
  forget(): Promise<void>;
  backedUp(): boolean;
  onChange(listener: (id: { pubKeyHex: string } | null) => void): void;
  /** The extension's binary policy for karma-side signs (WEB_INTERFACE → The
   *  profile window). Absent on the in-page module — the profile row renders
   *  only when both are present. */
  policy?(): 'silent' | 'ask';
  setPolicy?(p: 'silent' | 'ask'): Promise<void>;
  /** The extension's links preference (WEB_INTERFACE → The settings window).
   *  Absent on the in-page module and on an extension build whose `notis-public`
   *  is empty — the settings row renders only when both are present. */
  links?(): 'site' | 'here';
  setLinks?(v: 'site' | 'here'): Promise<void>;
}

/** The chain the extension reads is checked against the build's own profile
 *  and the other bases of the seed list (WEB_INTERFACE → The extension →
 *  "The verified tip"). The App holds an implementation only in the extension
 *  build; the web build is handed none. `run` takes the reading base at the
 *  moment the trigger fires and answers a verdict and — under `verified`
 *  alone — the reading node's own headers, for the figures verifier to prove
 *  boxes against (→ "The verified figures"). */
export interface TipRun {
  verdict: TipVerdict;
  anchor: Anchor | null;
  /** The hash of the first header of the reading node's verified proof — block
   *  1, held to the profile's `genesisId` where one is pinned
   *  (WEB_INTERFACE → The extension → "The chain's name"). Non-null whenever
   *  the reading node's proof verified, under `verified` and under `thin`
   *  alike; null for a reading node whose own proof did not verify. The post
   *  cache's name reads it (→ "The post cache"); nothing else does. */
  chain: string | null;
}
export interface TipVerifier {
  run(readingBase: string): Promise<TipRun>;
}

/** The extension proves the two figures the reading node serves for the loaded
 *  key — the wallet's balance and the profile's rep — against the state the
 *  verified chain committed (WEB_INTERFACE → The extension → "The verified
 *  figures"). The App holds an implementation only in the extension build; the
 *  web build is handed none. `run` proves the App's own listing against the
 *  reading node's own verified headers, both captured at the moment the
 *  trigger fires. */
export interface FiguresVerifier {
  run(readingBase: string, user: string, listing: Listing, anchor: Anchor): Promise<FiguresResult>;
}

/** The extension proves every handle it shows against the state the verified
 *  chain committed (WEB_INTERFACE → The extension → "The verified names"). The
 *  App holds an implementation only in the extension build; the web build is
 *  handed none. `run` checks one claim — a label, a key and the name a row
 *  carries beside it, or a typed handle — against the reading node's own
 *  verified headers standing when the check begins. */
export interface NamesVerifier {
  run(readingBase: string, claim: NameClaim, anchor: Anchor): Promise<NameResult>;
}

/** The extension checks every row that carries a post's bytes — the single
 *  post read's row, the resolver's batch answer, and the reader's own post
 *  at its submit — before it enters the client's state (WEB_INTERFACE →
 *  The extension → "The post check"). A call's rows go as one batch; the
 *  result is positional over them. A list read brings no bytes and is not
 *  checked (→ "A list read brings no bytes and is not checked"). The App
 *  holds an implementation only in the extension build; the web build is
 *  handed none, and sends no `tx` on any read. */
export interface PostsVerifier {
  check(rows: unknown[]): PostCheck[];
}

/** The size budget the post cache holds its entries' sizes to
 *  (CONSTANTS → Client defaults, WEB_INTERFACE → The extension → "The post
 *  cache"). A put past it evicts the least recently seen first, never the
 *  reader's own; a put that still does not fit is dropped. */
export const POST_CACHE_BYTES = 50_000_000;

/** The subject, its held ancestors (oldest first) and every held descendant,
 *  each row in the shape the App's render path already takes
 *  (WEB_INTERFACE → The extension → "The post cache"). */
export interface CachedThread {
  post: PostJson | WithdrawnJson;
  ancestors: Array<PostJson | WithdrawnJson>;
  descendants: Array<PostJson | WithdrawnJson>;
}

/** The post cache the extension build hands the App — IndexedDB at the page's
 *  own origin, behind one module (WEB_INTERFACE → The extension → "The post
 *  cache"). The App holds an implementation only in the extension build; the
 *  web build is handed none and the App behaves as it does at HEAD.
 *
 *  Rules: a put never blocks or fails a render — the render path starts a put
 *  and does not await it, and the module absorbs the two failures the contract
 *  names, a put that does not fit or that the browser refuses, and a browser
 *  without IndexedDB; every other failure is a programming error. Every read
 *  still checks every row — the cache never answers for the check and carries
 *  no `has`. The cache is read only when the node's read fails. */
export interface PostCache {
  /** Open the database named for `chain`; a second call with another name
   *  closes the first. The last name is kept in `localStorage` under
   *  `notis.posts.chain` and opens the cache before the first tip run
   *  returns and where none does. */
  open(chain: string): Promise<void>;
  /** Put, or refresh, one checked row. `own` marks the reader's own post —
   *  eviction never takes an `own` entry. A refresh of a held id replaces its
   *  row and last-seen and adjusts the running total by the difference. */
  put(entry: {
    id: string;
    txBytes: Uint8Array;
    row: PostJson;
    author: string;
    parent: string | null;
    own: boolean;
  }): Promise<void>;
  /** A withdrawn row for a held id: the entry's text goes, the entry stays
   *  (the node's word, and a lie costs a re-fetch). An id not held is nothing. */
  withdraw(id: string, row: WithdrawnJson): Promise<void>;
  /** The subject, its held ancestors and its held descendants — or `null`
   *  when the subject is not held. The walk stops at the first parent not
   *  held; descendants are collected through the parent index. */
  thread(id: string): Promise<CachedThread | null>;
  /** The ids held, each with its row and the author and parent the
   *  transaction states them. An id not held is absent from the map, so no
   *  key is a placeholder. One read-only transaction over the entries store.
   *  An empty list, no database or a transaction the browser refuses answers
   *  an empty map. */
  getMany(ids: readonly string[]): Promise<Map<string, HeldPost>>;
  /** Refresh the rows held for the given ids. For each row whose id is
   *  held, the entry's row (stored without `tx`) and `lastSeen` are
   *  replaced; `txBytes`, `author`, `parent` and `own` are kept, and the
   *  running total moves by the sum of the size differences in the same
   *  transaction. An id not held is nothing. An entry whose row is a
   *  `WithdrawnJson` is left as it is — the node's word, and a lie costs a
   *  re-fetch. */
  refresh(rows: readonly PostJson[]): Promise<void>;
}

/** One row held in the cache, as `getMany` answers. The row is the entry's
 *  (`PostJson` or `WithdrawnJson`); the author and parent are the
 *  transaction's, which the extension's post check wrote (WEB_INTERFACE →
 *  The extension → "The post check"). */
export interface HeldPost {
  row: PostJson | WithdrawnJson;
  author: string;
  parent: string | null;
}

/** The extension's resolver (WEB_INTERFACE → The extension → "The resolve")
 *  — the seam the App drives for the posts a list lacks. One resolver
 *  serves every list; a call carries a batch of ids and resolves with the
 *  end of every id no node bound. Never rejects: an id a node did not
 *  serve ends `'unserved'` or `'unbound'`, and an id a node bound reaches
 *  `onBound` as answers land. The App holds an implementation only in the
 *  extension build; the web build is handed none. */
export interface PostResolver {
  resolve(
    ids: readonly string[],
    onBound: (posts: BoundPost[]) => void,
  ): Promise<Map<string, ResolveEnd>>;
}
