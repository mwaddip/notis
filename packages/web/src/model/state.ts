import type { PostJson, Tombstone, FeedRow, StatusResult, KarmaResult, VouchesTargetResult } from '../api/dto';
import type { Workspace, Origin } from './workspace';
import type { Theme, IdTint } from '../prefs';
import type { Mark, Flight } from '../view/card';
import type { YourVouch } from '../view/author';

// The read surface's runtime state, and the handler contract the pure view
// modules render against. Types only — no cycle between controller and views.

/** The composer key for the feed's new post; a reply composer keys on its parent
 *  id. Shared so the opener's data-composer-open matches composerFor(null). */
export const FEED_COMPOSER_KEY = '@feed';

export interface FeedState {
  posts: PostJson[];        // confirmed live posts (withdrawn/tombstones filtered out)
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
  root: PostJson | Tombstone | null;
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
  arrangement: string; // the workspace as #r1,r2|r5 text, for @profile
  // Write surface — all inert with no identity loaded, so the client renders
  // exactly as the read surface does (WEB_INTERFACE → The write surface).
  writeEnabled: boolean;                                  // an identity is loaded
  ownKey: string | null;                                  // its public key, for the own-post like exclusion
  composerFor: (parentId: string | null) => HTMLElement | null; // the reused composer element, null → none open here
  submissionsFor: (parentId: string | null) => Submission[];    // own pending cards to place under a parent (null → the feed)
  likePending: (postId: string) => boolean;              // overlay onto likedByViewer until a like lands
  // Profile window (WEB_INTERFACE → The profile window). identity carries the lock
  // state; karma and membershipBars come from the node; grant is a faucet grant in
  // flight or one that lapsed. These inline shapes structurally match
  // view/profile.ts's ProfileCtx, so one contract serves both.
  identity: { pubKeyHex: string; locked: boolean } | null;
  backedUp: boolean;
  karma: KarmaResult | null;
  grant: { state: 'pending' } | { state: 'expired'; atHeight: number } | null;
  membershipBars: { memberBar: number; memberLikesBar: number } | null;
  // Membership actions (WEB_INTERFACE → The identity display). The reader is a
  // member (may vouch); the mark for any identity, its state and count computed
  // from the vouch set, the pending overlay, the escrow gate and the count cache.
  member: boolean;
  markFor: (key: string) => Mark | null;
  // The your-vouch row's state for an identity — the App derives it from the
  // vouch set, member, the escrow and /status's cooldown (WEB_INTERFACE → The
  // author window). null with no identity loaded — no row.
  yourVouch: (key: string) => YourVouch | null;
  // The author and author-posts windows, one entry per open window
  // (WEB_INTERFACE → The author window).
  author: Map<string, AuthorWindowData>;
  authorPosts: Map<string, FeedState>;
}

/** One open author window's reads and flight (WEB_INTERFACE → The author window). */
export interface AuthorWindowData {
  karma: KarmaResult | null;
  endorsers: VouchesTargetResult | null;
  endorsersNext: boolean;
  flight: Flight | null;
}

export interface Handlers {
  // feed
  openThread: (id: string, origin: Origin) => void;
  refreshFeed: () => void;
  loadOlder: () => void;
  openProfile: () => void;
  refreshProfile: () => void; // the @profile window's ↻ re-reads /karma
  // region / window
  focus: (id: string) => void;
  refreshThread: (id: string) => void;
  threadMore: (id: string) => void;
  moveLeft: (id: string) => void;
  moveRight: (id: string) => void;
  moveBelow: (id: string) => void;
  close: (id: string) => void;
  // preferences
  setTheme: (t: Theme) => void;
  setIdTint: (m: IdTint) => void;
  setNode: (origin: string) => void;
  setFaucet: (origin: string) => void;
  // identity operations (WEB_INTERFACE → The profile window)
  inspectFile: (text: string) => { kind: 'clear' | 'encrypted'; pubKeyHex: string };
  draftIdentity: () => { pubKeyHex: string };
  createIdentity: (passphrase: string) => Promise<void>;
  discardDraft: () => void;
  importIdentity: (text: string, passphrase: string) => Promise<void>;
  exportIdentity: (password: string) => Promise<void>;
  forgetIdentity: () => void;
  lockIdentity: () => void;
  unlockIdentity: (passphrase: string) => Promise<void>;
  askFaucet: () => void;
  // write surface
  openComposer: (parentId: string | null) => void; // null → the feed's new post; a post id → a reply
  likePost: (postId: string) => void;
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
}

/** What the App calls on the identity module — the single reference it holds
 *  (WEB_INTERFACE → The identity module). The wallet keeps its own narrower Signer
 *  seam (submit.ts), the extension swap point, so this is not it. */
export interface AppIdentity {
  current(): { pubKeyHex: string; locked: boolean } | null;
  sign(txIdHex: string): string;
  draft(): { pubKeyHex: string };
  create(passphrase: string): Promise<{ pubKeyHex: string }>;
  discardDraft(): void;
  inspectFile(text: string): { kind: 'clear' | 'encrypted'; pubKeyHex: string };
  importFile(text: string, passphrase: string): Promise<{ pubKeyHex: string }>;
  exportFile(password: string): Promise<string>;
  unlock(passphrase: string): Promise<void>;
  lock(): void;
  forget(): void;
  backedUp(): boolean;
  onChange(listener: (id: { pubKeyHex: string } | null) => void): void;
}
