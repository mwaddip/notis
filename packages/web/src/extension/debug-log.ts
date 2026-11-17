// WEB_INTERFACE → The extension → "The debug log". The record a page keeps of
// what it did, kept in IndexedDB at the page's own origin, apart from
// `localStorage` (which holds the waiting writes a full log must never crowd
// out). This module imports nothing from the DOM at load — a Node script
// loading it to measure a pure function must not read the page at load — and
// every seam is a required argument of `createDebugLog`.

/** CONSTANTS → Client defaults — the debug log's size, over its events'
 *  serialised sizes. */
export const DEBUG_LOG_BYTES = 2_000_000;

/** WEB_INTERFACE → The extension → "The debug log" — the kinds the log
 *  records. This run fills `cleared` and `error`; the others are stubs for
 *  later runs and never written yet. */
export type DebugEventKind =
  | 'start'
  | 'mesh'
  | 'req'
  | 'write'
  | 'sign'
  | 'waiting'
  | 'tip'
  | 'figures'
  | 'names'
  | 'console'
  | 'cleared'
  | 'error'
  | 'page';

/** One recorded event. `t` is the clock at the record, `page` the page id
 *  drawn at load; the other fields belong to the kind. */
export interface DebugEvent {
  t: number;
  page: string;
  kind: DebugEventKind;
  [field: string]: unknown;
}

/** The log's running state the debug row and the snapshot read. `events` is
 *  the count stored, `bytes` the running total over their serialised sizes,
 *  `oldestT` the first event's clock (or `null` where the log is empty),
 *  `dropped` the batches a refused write counted, `open` whether a database
 *  stands open, and `unavailable` whether the browser offered IndexedDB at all
 *  (`unavailable` is true iff the factory the module was handed is
 *  `undefined`). */
export interface DebugLogStats {
  events: number;
  bytes: number;
  oldestT: number | null;
  dropped: number;
  open: boolean;
  unavailable: boolean;
}

/** The store the App is handed. `record` stamps `t` and `page` and buffers
 *  the event; `flush` writes the buffer in one transaction (also called
 *  automatically at the batch's size, at the batch's interval and at page
 *  hide); `clear` deletes every event and zeroes the total in one
 *  transaction, then records `cleared`; `stats` and `list` are the reads the
 *  debug row and the snapshot use. */
export interface DebugLog {
  record(kind: DebugEventKind, fields: Record<string, unknown>): void;
  flush(): Promise<void>;
  clear(): Promise<void>;
  stats(): Promise<DebugLogStats>;
  list(): Promise<DebugEvent[]>;
  stop(): void;
}

/** The handle the timer pair returns — the module's own type so no DOM lib
 *  is reached at load. */
export type DebugTimerHandle = unknown;
export interface DebugTimers {
  setInterval(fn: () => void, ms: number): DebugTimerHandle;
  clearInterval(handle: DebugTimerHandle): void;
}

/** Every seam the module takes. Nothing defaults in shipped code: the
 *  extension build hands each. */
export interface DebugLogDeps {
  indexedDB: IDBFactory | undefined;
  now: () => number;
  pageId: string;
  boundBytes: number;
  batchSize: number;
  batchInterval: number;
  timers: DebugTimers;
}

/** The pure route-shape function — a request URL in, the path (variable
 *  segments turned into parameter names) and the query (every value dropped
 *  but those of `limit`, `light`, `pending` and `tx`) out. A
 *  `notis-mesh://<id>/…` URL answers the path apart from the id
 *  (WEB_INTERFACE → The extension → "The debug log"). */
export interface RouteShape {
  path: string;
  query: Record<string, string>;
}

const ALLOWED_QUERY_KEYS = new Set(['limit', 'light', 'pending', 'tx']);

/** The mesh-URL scheme the client sends over the connection it holds
 *  (MESH_INTERFACE → The mesh URL). */
const MESH_SCHEME = 'notis-mesh://';

/** Fixed-path patterns: a segment starting with `:` names a parameter, every
 *  other segment is a fixed word of a route the extension requests. More
 *  fixed-word patterns come first, so `/blocks/current` matches
 *  `['blocks','current']` before `['blocks',':height']`. */
const ROUTES: ReadonlyArray<ReadonlyArray<string>> = [];

/** The host the attach functions take — the slice of `Document` / `Window`
 *  they need, so no DOM lib is reached at load. */
export interface EventHost {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

/** The slice of `Document` the hide attach reads `visibilityState` from. */
export interface DocumentHost extends EventHost {
  readonly visibilityState: string;
}

export function createDebugLog(_deps: DebugLogDeps): DebugLog {
  // Stub (WEB_INTERFACE → The extension → "The debug log"). The shipped store
  // writes through its timer pair and IDB factory; this stub answers nothing.
  return {
    record(_kind, _fields) { /* nothing */ },
    flush(): Promise<void> { return Promise.resolve(); },
    clear(): Promise<void> { return Promise.resolve(); },
    stats(): Promise<DebugLogStats> {
      return Promise.resolve({ events: 0, bytes: 0, oldestT: null, dropped: 0, open: false, unavailable: false });
    },
    list(): Promise<DebugEvent[]> { return Promise.resolve([]); },
    stop(): void { /* nothing */ },
  };
}

export function routeShape(_url: string): RouteShape {
  // Stub (WEB_INTERFACE → The extension → "The debug log"). The shipped
  // function matches the URL against the route table and keeps only the four
  // query keys the contract names.
  void ALLOWED_QUERY_KEYS; void MESH_SCHEME; void ROUTES;
  return { path: '', query: {} };
}

export function attachFlushOnHide(
  _log: Pick<DebugLog, 'flush'>,
  _doc: DocumentHost,
  _win: EventHost,
): () => void {
  // Stub (WEB_INTERFACE → The extension → "The debug log"). The shipped
  // attach listens for `visibilitychange` (when hidden) and `pagehide`, and
  // flushes the buffer at either. The detach removes both listeners.
  return (): void => { /* nothing */ };
}

export function attachErrorRecorder(
  _log: Pick<DebugLog, 'record'>,
  _win: EventHost,
): () => void {
  // Stub (WEB_INTERFACE → The extension → "The debug log"). The shipped
  // attach records an `error` event for each `error` and `unhandledrejection`
  // the window raises; the detach removes both listeners.
  return (): void => { /* nothing */ };
}
