import type { PostJson, Tombstone, FeedRow, StatusResult } from '../api/dto';
import type { Workspace, Origin } from './workspace';
import type { Theme, IdTint } from '../prefs';

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
  arrangement: string; // the workspace as #r1,r2|r5 text, for @settings
  // Write surface — all inert with no identity loaded, so the client renders
  // exactly as the read surface does (WEB_INTERFACE → The write surface).
  writeEnabled: boolean;                                  // an identity is loaded
  ownKey: string | null;                                  // its public key, for the own-post like exclusion
  composerFor: (parentId: string | null) => HTMLElement | null; // the reused composer element, null → none open here
  submissionsFor: (parentId: string | null) => Submission[];    // own pending cards to place under a parent (null → the feed)
  likePending: (postId: string) => boolean;              // overlay onto likedByViewer until a like lands
}

export interface Handlers {
  // feed
  openThread: (id: string, origin: Origin) => void;
  refreshFeed: () => void;
  loadOlder: () => void;
  openSettings: () => void;
  // region / window
  focus: (id: string) => void;
  refreshThread: (id: string) => void;
  threadMore: (id: string) => void;
  moveLeft: (id: string) => void;
  moveRight: (id: string) => void;
  moveBelow: (id: string) => void;
  close: (id: string) => void;
  // settings
  setTheme: (t: Theme) => void;
  setIdTint: (m: IdTint) => void;
  setNode: (origin: string) => void;
  // write surface
  openComposer: (parentId: string | null) => void; // null → the feed's new post; a post id → a reply
  likePost: (postId: string) => void;
  tryAgain: (localKey: string) => void;            // rebuild a fresh transaction from the current view
}
