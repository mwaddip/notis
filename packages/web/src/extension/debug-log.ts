// WEB_INTERFACE → The extension → "The debug log". The record a page keeps of
// what it did, kept in IndexedDB at the page's own origin, apart from
// `localStorage` (which holds the waiting writes a full log must never crowd
// out). This module imports nothing from the DOM at load — a Node script
// loading it to measure a pure function must not read the page at load — and
// every seam is a required argument of `createDebugLog`.

/** CONSTANTS → Client defaults — the debug log's size, over its events'
 *  serialised sizes. */
export const DEBUG_LOG_BYTES = 2_000_000;

/** WEB_INTERFACE → The extension → "The debug log" — a kind is the class of
 *  event the log stores a record under. The kinds other code records join the
 *  union with the code that records them. */
export type DebugEventKind =
  | 'cleared'
  | 'error'
  | 'page'
  | 'verdict'
  | 'dial'
  | 'connection'
  | 'handshake'
  | 'check'
  | 'gossip-block'
  | 'request'
  | 'request-body'
  | 'serving-stream'
  | 'serving-call'
  | 'write'
  | 'sign'
  | 'wait';

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

const DB_NAME = 'notis.debug';
const EVENTS_STORE = 'events';
const META_STORE = 'meta';
const META_KEY = 'total';
const ALLOWED_QUERY_KEYS = new Set(['limit', 'light', 'pending', 'tx']);
const MESH_SCHEME = 'notis-mesh://';
const MESSAGE_MAX = 500;
const STACK_MAX = 1000;

/** The route table — the fixed words of every path the extension requests
 *  (derived from `src/api/client.ts`, `src/api/write.ts`, `src/api/faucet.ts`,
 *  `src/extension/post-resolver.ts`, `src/mesh/mesh-client.ts` and
 *  `@dagsocial/nipopow-client`'s requests). A segment starting with `:` is a
 *  parameter name; every other segment is a fixed word. More-specific patterns
 *  come before less-specific ones so `/blocks/current` matches
 *  `['blocks','current']` before `['blocks',':height']`. */
const ROUTES: ReadonlyArray<ReadonlyArray<string>> = [
  ['posts', 'batch'],
  ['posts', ':id', 'thread'],
  ['posts', ':id', 'withdraw'],
  ['posts', ':id'],
  ['posts'],
  ['status'],
  ['blocks', 'current'],
  ['blocks', ':height'],
  ['blocks'],
  ['karma', ':key'],
  ['karma'],
  ['credits', 'transfer'],
  ['credits', ':key'],
  ['credits'],
  ['vouches', ':targetId'],
  ['vouches'],
  ['invites', ':key'],
  ['invites'],
  ['usernames', ':name', 'burn'],
  ['usernames', ':name'],
  ['usernames'],
  ['likes'],
  ['api', 'v1', 'proof', ':key'],
  ['api', 'v1', 'range', ':kind', ':owner'],
  ['nipopow', 'proof', ':m', ':k'],
];

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

/** The record as it goes to the store — the event's own fields plus a
 *  pre-computed size (so eviction reads each entry's size without computing
 *  it again). */
interface StoredEvent {
  t: number;
  page: string;
  kind: DebugEventKind;
  fields: DebugEvent;
  size: number;
}

export function createDebugLog(deps: DebugLogDeps): DebugLog {
  const { indexedDB, now, pageId, boundBytes, batchSize, batchInterval, timers } = deps;
  const unavailable = indexedDB === undefined;

  const buffer: Array<{ event: DebugEvent; size: number }> = [];
  let dropped = 0;

  let db: IDBDatabase | null = null;
  let openPromise: Promise<void> | null = null;
  let timerHandle: DebugTimerHandle | undefined;

  const openDb = (): Promise<void> => {
    if (unavailable) return Promise.resolve();
    if (openPromise !== null) return openPromise;
    openPromise = new Promise<void>((resolve) => {
      let req: IDBOpenDBRequest;
      try {
        req = indexedDB!.open(DB_NAME, 1);
      } catch {
        resolve();
        return;
      }
      req.onupgradeneeded = (): void => {
        const d = req.result;
        if (!d.objectStoreNames.contains(EVENTS_STORE)) {
          d.createObjectStore(EVENTS_STORE, { autoIncrement: true });
        }
        if (!d.objectStoreNames.contains(META_STORE)) {
          d.createObjectStore(META_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = (): void => {
        const opened = req.result;
        // The module closes its connection on `versionchange` (so a delete
        // another page asks for is never blocked by it, as the post cache
        // does) and on the connection's `close`; the next write opens
        // again.
        const releaseConnection = (): void => {
          if (db === opened) {
            db = null;
            openPromise = null;
          }
          try { opened.close(); } catch { /* ignore */ }
        };
        opened.addEventListener('versionchange', releaseConnection);
        opened.addEventListener('close', releaseConnection);
        db = opened;
        resolve();
      };
      req.onerror = (): void => resolve();
      req.onblocked = (): void => resolve();
    });
    return openPromise;
  };

  if (!unavailable) {
    timerHandle = timers.setInterval((): void => { void flushInternal(); }, batchInterval);
  }

  const computeSize = (event: DebugEvent): number =>
    new TextEncoder().encode(JSON.stringify(event)).length;

  function record(kind: DebugEventKind, fields: Record<string, unknown>): void {
    if (unavailable) return;
    const event: DebugEvent = { ...fields, t: now(), page: pageId, kind };
    const size = computeSize(event);
    buffer.push({ event, size });
    if (buffer.length >= batchSize) void flushInternal();
  }

  function flushInternal(): Promise<void> {
    if (unavailable) return Promise.resolve();
    if (buffer.length === 0) return Promise.resolve();
    return openDb().then(() => {
      if (db === null) {
        const batch = buffer.splice(0, buffer.length);
        dropped += batch.length;
        return;
      }
      const batch = buffer.splice(0, buffer.length);
      const delta = batch.reduce((s, b) => s + b.size, 0);
      // WEB_INTERFACE → The extension → "The debug log" — the browser's
      // refusals the write path absorbs are the transaction aborted
      // (`onabort`, an `AbortError` or `QuotaExceededError` on the
      // transaction's `error`) and no database to open; anything else
      // reaches the caller (or the page's error handler, from inside a
      // request callback).
      return new Promise<void>((resolve, reject) => {
        const tx = db!.transaction([EVENTS_STORE, META_STORE], 'readwrite');
        let settled = false;
        tx.onabort = (): void => {
          if (settled) return;
          settled = true;
          dropped += batch.length;
          resolve();
        };
        tx.onerror = (): void => {
          if (settled) return;
          const err = tx.error;
          if (err === null) return;
          const name = err.name;
          if (name === 'AbortError' || name === 'QuotaExceededError') return;
          settled = true;
          reject(err);
        };
        tx.oncomplete = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const events = tx.objectStore(EVENTS_STORE);
        const meta = tx.objectStore(META_STORE);
        const getReq = meta.get(META_KEY);
        getReq.onsuccess = (): void => {
          const row = getReq.result as { key: string; bytes: number } | undefined;
          const current = row !== undefined && typeof row.bytes === 'number' ? row.bytes : 0;
          for (const b of batch) {
            const stored: StoredEvent = {
              t: b.event.t,
              page: b.event.page,
              kind: b.event.kind,
              fields: b.event,
              size: b.size,
            };
            events.add(stored);
          }
          let newTotal = current + delta;
          if (newTotal <= boundBytes) {
            meta.put({ key: META_KEY, bytes: newTotal });
            return;
          }
          const cursorReq = events.openCursor();
          cursorReq.onsuccess = (): void => {
            if (newTotal <= boundBytes) {
              meta.put({ key: META_KEY, bytes: newTotal });
              return;
            }
            const c = cursorReq.result;
            if (c) {
              const victim = c.value as StoredEvent;
              newTotal -= victim.size;
              c.delete();
              c.continue();
            } else {
              meta.put({ key: META_KEY, bytes: newTotal });
            }
          };
        };
      });
    });
  }

  function clearInternal(): Promise<void> {
    if (unavailable) return Promise.resolve();
    return openDb().then(() => {
      if (db === null) return;
      // Drop any buffered records — the reader asked for a clear.
      buffer.length = 0;
      const clearedEvent: DebugEvent = { t: now(), page: pageId, kind: 'cleared' };
      const size = computeSize(clearedEvent);
      return new Promise<void>((resolve) => {
        let tx: IDBTransaction;
        try {
          tx = db!.transaction([EVENTS_STORE, META_STORE], 'readwrite');
        } catch {
          resolve();
          return;
        }
        const events = tx.objectStore(EVENTS_STORE);
        const meta = tx.objectStore(META_STORE);
        events.clear();
        const stored: StoredEvent = {
          t: clearedEvent.t, page: clearedEvent.page, kind: 'cleared',
          fields: clearedEvent, size,
        };
        events.add(stored);
        meta.put({ key: META_KEY, bytes: size });
        tx.oncomplete = (): void => resolve();
        tx.onerror = (): void => resolve();
        tx.onabort = (): void => resolve();
      });
    });
  }

  function statsInternal(): Promise<DebugLogStats> {
    if (unavailable) {
      return Promise.resolve({
        events: 0, bytes: 0, oldestT: null, dropped, open: false, unavailable: true,
      });
    }
    return openDb().then(() => {
      if (db === null) {
        return { events: 0, bytes: 0, oldestT: null, dropped, open: false, unavailable: false };
      }
      return new Promise<DebugLogStats>((resolve) => {
        let tx: IDBTransaction;
        try {
          tx = db!.transaction([EVENTS_STORE, META_STORE], 'readonly');
        } catch {
          resolve({ events: 0, bytes: 0, oldestT: null, dropped, open: true, unavailable: false });
          return;
        }
        const events = tx.objectStore(EVENTS_STORE);
        const meta = tx.objectStore(META_STORE);
        let count = 0;
        let bytes = 0;
        let oldestT: number | null = null;
        const countReq = events.count();
        countReq.onsuccess = (): void => { count = countReq.result; };
        const metaReq = meta.get(META_KEY);
        metaReq.onsuccess = (): void => {
          const row = metaReq.result as { key: string; bytes: number } | undefined;
          if (row !== undefined && typeof row.bytes === 'number') bytes = row.bytes;
        };
        const cursorReq = events.openCursor();
        cursorReq.onsuccess = (): void => {
          const c = cursorReq.result;
          if (c && oldestT === null) oldestT = (c.value as StoredEvent).t;
        };
        tx.oncomplete = (): void => resolve({
          events: count, bytes, oldestT, dropped, open: true, unavailable: false,
        });
        tx.onerror = (): void => resolve({
          events: 0, bytes: 0, oldestT: null, dropped, open: true, unavailable: false,
        });
      });
    });
  }

  function listInternal(): Promise<DebugEvent[]> {
    if (unavailable) return Promise.resolve([]);
    return openDb().then(() => {
      if (db === null) return [];
      return new Promise<DebugEvent[]>((resolve) => {
        let tx: IDBTransaction;
        try {
          tx = db!.transaction(EVENTS_STORE, 'readonly');
        } catch {
          resolve([]);
          return;
        }
        const events = tx.objectStore(EVENTS_STORE);
        const out: DebugEvent[] = [];
        const cursorReq = events.openCursor();
        cursorReq.onsuccess = (): void => {
          const c = cursorReq.result;
          if (c) {
            out.push((c.value as StoredEvent).fields);
            c.continue();
          }
        };
        tx.oncomplete = (): void => resolve(out);
        tx.onerror = (): void => resolve(out);
      });
    });
  }

  function stop(): void {
    if (timerHandle !== undefined) timers.clearInterval(timerHandle);
    timerHandle = undefined;
  }

  return {
    record,
    flush: flushInternal,
    clear: clearInternal,
    stats: statsInternal,
    list: listInternal,
    stop,
  };
}

export function routeShape(url: string): RouteShape {
  let pathPart: string;
  let params: URLSearchParams;
  if (url.startsWith(MESH_SCHEME)) {
    const rest = url.substring(MESH_SCHEME.length);
    const slash = rest.indexOf('/');
    const afterId = slash === -1 ? '' : rest.substring(slash);
    const q = afterId.indexOf('?');
    pathPart = q === -1 ? afterId : afterId.substring(0, q);
    const queryPart = q === -1 ? '' : afterId.substring(q + 1);
    params = new URLSearchParams(queryPart);
  } else {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { path: '', query: {} };
    }
    pathPart = u.pathname;
    params = u.searchParams;
  }

  const segments = pathPart.split('/').filter((s) => s.length > 0);
  const path = matchSegments(segments);

  // Every query key is kept — the allowed ones with their values, every
  // other with an empty value — so the log records what a request asked
  // for without recording what the reader opened.
  const query: Record<string, string> = {};
  for (const k of params.keys()) {
    if (ALLOWED_QUERY_KEYS.has(k)) {
      const v = params.get(k);
      query[k] = v !== null ? v : '';
    } else {
      query[k] = '';
    }
  }

  return { path, query };
}

/** Match the trailing segments of a path against the route table, trying
 *  longer suffixes first; nothing matched means every segment of `segments`
 *  becomes a generic name. */
function matchSegments(segments: string[]): string {
  for (let take = segments.length; take > 0; take--) {
    const suffix = segments.slice(segments.length - take);
    for (const route of ROUTES) {
      if (route.length !== take) continue;
      if (patternMatches(suffix, route)) return '/' + route.join('/');
    }
  }
  if (segments.length === 0) return '/';
  return '/' + segments.map((_, i) => `:${i + 1}`).join('/');
}

function patternMatches(segments: readonly string[], pattern: readonly string[]): boolean {
  for (let i = 0; i < segments.length; i++) {
    const p = pattern[i]!;
    if (p.startsWith(':')) continue;
    if (p !== segments[i]) return false;
  }
  return true;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.substring(0, max);
}

export function attachFlushOnHide(
  log: Pick<DebugLog, 'flush'>,
  doc: DocumentHost,
  win: EventHost,
): () => void {
  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') void log.flush();
  };
  const onPageHide = (): void => { void log.flush(); };
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pagehide', onPageHide);
  return (): void => {
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('pagehide', onPageHide);
  };
}

export function attachErrorRecorder(
  log: Pick<DebugLog, 'record'>,
  win: EventHost,
): () => void {
  const onError = (event: unknown): void => {
    const e = event as { message?: unknown; error?: { stack?: unknown } };
    const message = typeof e.message === 'string' ? e.message : String(e.message ?? '');
    const stack = typeof e.error?.stack === 'string' ? e.error.stack : '';
    log.record('error', { message: truncate(message, MESSAGE_MAX), stack: truncate(stack, STACK_MAX) });
  };
  const onRejection = (event: unknown): void => {
    const e = event as { reason?: { message?: unknown; stack?: unknown } };
    const reason = e.reason;
    const message = typeof reason?.message === 'string' ? reason.message : String(reason ?? '');
    const stack = typeof reason?.stack === 'string' ? reason.stack : '';
    log.record('error', { message: truncate(message, MESSAGE_MAX), stack: truncate(stack, STACK_MAX) });
  };
  win.addEventListener('error', onError);
  win.addEventListener('unhandledrejection', onRejection);
  return (): void => {
    win.removeEventListener('error', onError);
    win.removeEventListener('unhandledrejection', onRejection);
  };
}
