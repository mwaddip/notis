import type { PostJson, Tombstone, FeedRow, StatusResult } from '../api/dto';
import type { Workspace, Origin } from './workspace';
import type { Theme, IdTint } from '../prefs';

// The read surface's runtime state, and the handler contract the pure view
// modules render against. Types only — no cycle between controller and views.

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
}

/** What the views need to render, without reaching into the controller. */
export interface RenderCtx {
  openSet: Set<string>;
  thread: (id: string) => ThreadState | undefined;
  post: (id: string) => PostJson | undefined;
  arrangement: string; // the workspace as #r1,r2|r5 text, for @settings
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
}
