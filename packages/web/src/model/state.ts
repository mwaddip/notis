import type { PostJson, WithdrawnJson, FeedRow, StatusResult, KarmaResult, VouchesTargetResult, BondsResult, CreditsResult, UsernameResult } from '../api/dto';
import type { Workspace, Origin } from './workspace';
import type { Theme, IdTint } from '../prefs';
import type { Flight } from '../view/card';
import type { YourVouch } from '../view/author';
import type { SignResult } from '../wallet/submit';

// The read surface's runtime state, and the handler contract the pure view
// modules render against. Types only — no cycle between controller and views.

/** The composer key for the feed's new post; a reply composer keys on its parent
 *  id. Shared so the opener's data-composer-open matches composerFor(null). */
export const FEED_COMPOSER_KEY = '@feed';

export interface FeedState {
  posts: PostJson[];        // confirmed live posts (withdrawn rows filtered out)
  pending: PostJson[];      // mempool posts, newest and not yet in a block
  next: string | null;      // keyset cursor for older posts
  report: string | null;    // what the last ↻ did
  olderReport: string | null; // what the last "load older" did
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

export interface ThreadState {
  id: string;
  root: PostJson | WithdrawnJson | null;
  ancestorIds: Set<string>;   // for the "↳ nested" check
  descendants: FeedRow[];
  descendantCount: number;
  next: string | null;
  report: string | null;
  loading: boolean;
  error: string | null;
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
  // state; karma and membershipBars come from the node; grant is a faucet grant in
  // flight or one that lapsed. These inline shapes structurally match
  // view/profile.ts's ProfileCtx, so one contract serves both.
  identity: { pubKeyHex: string; locked: boolean } | null;
  backedUp: boolean;
  karma: KarmaResult | null;
  grant: { state: 'pending' } | { state: 'expired'; atHeight: number } | null;
  membershipBars: { memberBar: number; memberLikesBar: number } | null;
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
  // The username row (WEB_INTERFACE → The username row).
  usernameFlight: Flight | null;
  pendingUsername: { kind: 'claim' | 'burn'; name: string } | null;
  canSignClaim: boolean;
  canAffordBurn: boolean;
  // The $NOTIS row (WEB_INTERFACE → The profile window). credits is the reader's
  // own /credits, null before the first read; creditGrant is a faucet transfer
  // in flight or one that lapsed; sendFlight is the transient ending; pendingSend
  // is the ledger's own send entry — the durable line that survives a reload.
  // status is the last /status the App holds — its blockHeight is the tip the
  // row's spendable-at-height filter reads (WEB_INTERFACE → The wallet).
  status: StatusResult | null;
  credits: CreditsResult | null;
  creditGrant: { state: 'pending' } | { state: 'expired'; atHeight: number } | null;
  sendFlight: Flight | null;
  pendingSend: { toHex: string; toName: string | null; amount: bigint } | null;
  // The $NOTIS row's confirm — true on the web build (the confirm row stands),
  // false in the extension (the prompt is the one confirmation). WEB_INTERFACE
  // → The profile window → "The `$NOTIS` row". The App fills it
  // `!this.idm.policy`, the same predicate the policy row reads on.
  confirmInRow: boolean;
  // WEB_INTERFACE → Links
  linkUrl: (id: string) => string;
}

/** One open author window's reads and flight (WEB_INTERFACE → The author window). */
export interface AuthorWindowData {
  karma: KarmaResult | null;
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
  refreshProfile: () => void; // the @profile window's ↻ re-reads /karma
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
  setFaucet: (origin: string) => void;
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
  refreshAuthor: (key: string) => void;            // the author window's ↻ — re-reads /karma and the endorsers
  openAuthorPosts: (key: string, origin: Origin) => void;
  refreshAuthorPosts: (key: string) => void;       // the posts window's ↻ — reports what it did
  authorPostsMore: (key: string) => void;          // the posts window's `more`, following next
  moreEndorsers: (key: string) => void;            // the endorsers page's `more`, following next
  invite: (inviteeKey: string, bond: bigint) => void; // from the profile's invites row
  moreBonds: () => void;                           // the standing-bonds `more`, following next
  // The username row (WEB_INTERFACE → The username row).
  claimUsername: (name: string) => void;
  burnUsername: () => void;
  // The $NOTIS row (WEB_INTERFACE → The profile window). resolveRecipient is
  // the handle → holder read the row's send form runs at the press; send is
  // the credits transfer; askFaucetCredits is the faucet's $NOTIS step.
  resolveRecipient: (name: string) => Promise<{ key: string; name: string | null } | { refusal: string }>;
  send: (toHex: string, toName: string | null, amount: bigint) => void;
  askFaucetCredits: () => void;
  // The extension's binary sign policy (WEB_INTERFACE → The profile window).
  // Defined only in the extension build — the profile row renders only when
  // both are present.
  policy?: () => 'silent' | 'ask';
  setPolicy?: (p: 'silent' | 'ask') => Promise<void>;
  // The extension's faucet-origin permission gate — the faucet row's `set`
  // requests it from the press (WEB_INTERFACE → The profile window).
  requestFaucetOrigin?: (origin: string) => Promise<boolean>;
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
}
