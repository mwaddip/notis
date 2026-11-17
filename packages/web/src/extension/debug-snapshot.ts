// WEB_INTERFACE → The extension → "The snapshot". One function that composes
// the snapshot the debug row renders and the file carries. Every seam is a
// required argument; the function is total — a seam that throws leaves every
// other part whole and that part `{ error: <message> }`. A snapshot is a deep
// copy: `state()` hands back a shallow object whose `traffic` the client
// keeps mutating, so the mesh section is copied once at its read and nothing
// in the returned snapshot moves after it is taken.

import type { MeshClient, ClientState, MeshDiagnostics } from '../mesh/mesh-client.js';
import type { DebugLog, DebugLogStats } from './debug-log.js';

/** The build the page was loaded as (WEB_INTERFACE → The extension → "The
 *  snapshot" — "the build"). The page's `startDebugLog` already records these
 *  in its `page` event; the snapshot carries them as the file's self-report. */
export interface BuildFacts {
  version: string;
  commit: string;
  network: string;
  userAgent: string;
}

/** The settings section's own shape (WEB_INTERFACE → The extension → "The
 *  snapshot" — "the settings"). The hand-added node is read as `{ address,
 *  off }`; an extension built with no faucet reads `links` as `null`, and the
 *  row reads `null` the same way where the browser gave the page none. */
export interface SettingsFacts {
  serve: boolean;
  links: 'site' | 'here' | null;
  signPolicy: 'silent' | 'ask';
  handNode: { address: string; off: boolean };
}

/** A pending entry as the snapshot carries it (WEB_INTERFACE → The extension →
 *  "The snapshot" — "each pending entry's kind, transaction id, expiry and
 *  stage"). `stage` is the App's own stage word for the entry (`pending`,
 *  `waiting`, `submitted`, `expired`, `rejected`), not the ledger's internal
 *  outcome. `postId` carries the post or box id the entry names so the file's
 *  replacement step reads it. */
export interface SnapshotPending {
  kind: string;
  txId: string;
  postId: string;
  expiresAtHeight: number;
  stage: string;
}

/** A waiting write as the snapshot carries it (WEB_INTERFACE → The extension →
 *  "The snapshot" — "each waiting write's kind, transaction id, sequence,
 *  ledger and chain"). The record's `tx` and `content` never reach the
 *  snapshot: the log never holds a signed transaction's bytes or a post's
 *  text (→ "What the log never holds"). `postId` carries the post or box id
 *  the record names, for the same reason as a pending entry's. */
export interface SnapshotWaiting {
  kind: string;
  txId: string;
  postId: string;
  seq: number;
  ledger: 'rep' | 'credits';
  chain: string;
}

/** The reader section — what the App answers the snapshot with (WEB_INTERFACE →
 *  The extension → "The snapshot" — "the reader"). `observedAddress` is the
 *  address a node observes the reader at where the client learns one; absent
 *  where it does not. */
export interface ReaderFacts {
  identityLoaded: boolean;
  unlocked: boolean;
  pubKeyHex: string | null;
  name: string | null;
  pending: SnapshotPending[];
  waiting: SnapshotWaiting[];
  lastTipRun: Record<string, unknown> | null;
  lastFiguresRun: Record<string, unknown> | null;
  lastNamesRun: Record<string, unknown> | null;
  observedAddress?: string | null;
}

/** The post cache section (WEB_INTERFACE → The extension → "The snapshot" —
 *  "the post cache"). The cache's module answers no stats of its own —
 *  `src/extension/post-cache.ts` exports `open`, `openRemembered`, `put`,
 *  `withdraw`, `thread`, `getMany`, `refresh`, `roots` and `byAuthor`, none
 *  of which carries the database name, an entry count, a byte total or the
 *  reader-own / kept-entry counts. The snapshot's own section is empty; the
 *  five counts the contract names are reports, not new reads. */
export interface PostCacheFacts {
  // Intentionally empty — see the comment above.
}

/** The seam that answers mesh state and diagnostics at the moment the
 *  snapshot is taken. The mesh client's `state()` returns a shallow copy
 *  whose `traffic` the client keeps mutating, so the composer deep-copies
 *  the pair once; nothing in the taken snapshot moves after. */
export type MeshSnapshotSeam = Pick<MeshClient, 'state' | 'diagnostics'>;

/** The reader seam the App answers. One call per snapshot; a throw lands as
 *  the reader section's `{ error }`. */
export type ReaderSeam = () => ReaderFacts;

/** The settings seam the App answers. Each read is one call. */
export type SettingsSeam = () => SettingsFacts;

/** The seams the composer takes. Every one is required. */
export interface SnapshotSeams {
  build: () => BuildFacts;
  settings: SettingsSeam;
  mesh: MeshSnapshotSeam;
  reader: ReaderSeam;
  debugLog: Pick<DebugLog, 'stats'>;
}

/** A section of the snapshot: the facts the seam answered, or the error its
 *  seam threw. */
export type SectionOr<T> = T | { error: string };

/** The snapshot itself — the shape the debug row renders and the file carries
 *  (WEB_INTERFACE → The extension → "The snapshot"). */
export interface DebugSnapshot {
  build: SectionOr<BuildFacts>;
  settings: SectionOr<SettingsFacts>;
  mesh: SectionOr<{ state: ClientState; diagnostics: MeshDiagnostics }>;
  reader: SectionOr<ReaderFacts>;
  postCache: SectionOr<PostCacheFacts>;
  log: SectionOr<DebugLogStats>;
}

function messageOf(e: unknown): string {
  if (e instanceof Error && typeof e.message === 'string') return e.message;
  return String(e);
}

/** Deep-copy a section after its seam answered. `structuredClone` is
 *  available in the extension and in `happy-dom`; a diagnostics answer may
 *  carry `RTCIceServer` objects that are plain enough to clone. A clone that
 *  throws leaves the section as `{ error }`. */
function deepCopy<T>(value: T): SectionOr<T> {
  try {
    return structuredClone(value);
  } catch (e) {
    return { error: messageOf(e) };
  }
}

/** Compose a snapshot from the seams it is handed. Total: a seam that throws
 *  (or whose deep-copy throws) makes its own section `{ error }` and leaves
 *  every other section whole (WEB_INTERFACE → The extension → "The snapshot").
 *  `debugLog.stats()` is async; the result is awaited and any rejection lands
 *  as the log section's `{ error }`. */
export async function takeSnapshot(seams: SnapshotSeams): Promise<DebugSnapshot> {
  const build: SectionOr<BuildFacts> = (() => {
    try { return deepCopy(seams.build()); } catch (e) { return { error: messageOf(e) }; }
  })();
  const settings: SectionOr<SettingsFacts> = (() => {
    try { return deepCopy(seams.settings()); } catch (e) { return { error: messageOf(e) }; }
  })();
  const mesh: SectionOr<{ state: ClientState; diagnostics: MeshDiagnostics }> = (() => {
    try {
      const state = seams.mesh.state();
      const diagnostics = seams.mesh.diagnostics();
      return deepCopy({ state, diagnostics });
    } catch (e) {
      return { error: messageOf(e) };
    }
  })();
  const reader: SectionOr<ReaderFacts> = (() => {
    try { return deepCopy(seams.reader()); } catch (e) { return { error: messageOf(e) }; }
  })();
  // The post cache module exports no stats; the section is empty here, and
  // the five counts the contract names are reports (see `PostCacheFacts`).
  const postCache: SectionOr<PostCacheFacts> = {};
  let log: SectionOr<DebugLogStats>;
  try {
    const stats = await seams.debugLog.stats();
    log = deepCopy(stats);
  } catch (e) {
    log = { error: messageOf(e) };
  }
  return { build, settings, mesh, reader, postCache, log };
}
