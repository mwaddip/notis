// @vitest-environment happy-dom
// WEB_INTERFACE → The extension → "The debug log". The store runs in the
// extension pages' own origin, behind one module; the cases here exercise it
// over `fake-indexeddb` so a browser's own IndexedDB does not have to be
// present, and over fake timer and event seams so the batch's size, the
// batch's interval, `attachFlushOnHide` and `attachErrorRecorder` drive
// through the module's own entry points.

import { describe, it, expect } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  createDebugLog,
  routeShape,
  attachFlushOnHide,
  attachErrorRecorder,
  type DebugTimerHandle,
  type DebugTimers,
  type EventHost,
  type DocumentHost,
} from '../src/extension/debug-log';

const PAGE = 'ab12cd34';
const OTHER_PAGE = 'ef56ab78';

/** A clock the test owns, so every `t` the module stamps moves in a known
 *  order. */
function clock(start = 1000): { tick: () => number; now: () => number; set: (n: number) => void } {
  const state = { n: start };
  return {
    tick: (): number => ++state.n,
    now: (): number => state.n,
    set: (n: number): void => { state.n = n; },
  };
}

/** A timer pair the test drives — `setInterval` records the callback, the
 *  test invokes it on demand; `clearInterval` detaches. The `map` is public so
 *  a test can read the first registered handle. */
function fakeTimers(): DebugTimers & {
  fire(handle: DebugTimerHandle): void;
  active(): number;
  readonly map: Map<DebugTimerHandle, { fn: () => void; ms: number }>;
} {
  const map = new Map<DebugTimerHandle, { fn: () => void; ms: number }>();
  let seq = 0;
  return {
    map,
    setInterval(fn, ms): DebugTimerHandle {
      const h = ++seq;
      map.set(h, { fn, ms });
      return h;
    },
    clearInterval(handle): void { map.delete(handle); },
    fire(handle): void {
      const entry = map.get(handle);
      if (entry !== undefined) entry.fn();
    },
    active(): number { return map.size; },
  };
}

/** An event host the test drives — `addEventListener` records the listener,
 *  `dispatch` invokes every listener registered for the type. */
function fakeHost(): EventHost & { dispatch(type: string, event: unknown): void; active(): number } {
  const map = new Map<string, Array<(event: unknown) => void>>();
  return {
    addEventListener(type, listener): void {
      const list = map.get(type) ?? [];
      list.push(listener);
      map.set(type, list);
    },
    removeEventListener(type, listener): void {
      const list = map.get(type);
      if (list === undefined) return;
      const i = list.indexOf(listener);
      if (i >= 0) list.splice(i, 1);
    },
    dispatch(type, event): void {
      const list = map.get(type) ?? [];
      for (const fn of list.slice()) fn(event);
    },
    active(): number {
      let n = 0;
      for (const list of map.values()) n += list.length;
      return n;
    },
  };
}

function fakeDocumentHost(initialVisibility: string): DocumentHost & { dispatch(type: string, event: unknown): void; setVisibility(v: string): void; active(): number } {
  const host = fakeHost();
  let visibility = initialVisibility;
  return {
    get visibilityState(): string { return visibility; },
    addEventListener: host.addEventListener,
    removeEventListener: host.removeEventListener,
    dispatch: host.dispatch,
    setVisibility(v: string): void { visibility = v; },
    active: host.active,
  };
}

describe('debug-log — the bound and the eviction', () => {
  it('a write past the bound evicts oldest first; the total equals the stored events\' sizes', async () => {
    const idb = new IDBFactory();
    const t = fakeTimers();
    const log = createDebugLog({
      indexedDB: idb, now: clock().tick, pageId: PAGE,
      boundBytes: 300, batchSize: 1, batchInterval: 60_000, timers: t,
    });
    for (let i = 0; i < 10; i++) {
      log.record('error', { message: `event-${i}`, pad: 'x'.repeat(40) });
    }
    await log.flush();
    const list = await log.list();
    const stats = await log.stats();
    const sumOfJson = list
      .map((e) => new TextEncoder().encode(JSON.stringify(e)).length)
      .reduce((a, b) => a + b, 0);
    expect(stats.bytes).toBe(sumOfJson);
    expect(stats.bytes).toBeLessThanOrEqual(300);
    // Oldest evicted first — the earliest `event-0` is gone, the latest stays.
    expect(list.some((e) => e.message === 'event-9')).toBe(true);
    expect(list.some((e) => e.message === 'event-0')).toBe(false);
  });
});

describe('debug-log — two pages, one total', () => {
  it('two stores over one database keep one total', async () => {
    const idb = new IDBFactory();
    const timersA = fakeTimers();
    const timersB = fakeTimers();
    const logA = createDebugLog({
      indexedDB: idb, now: clock().tick, pageId: PAGE,
      boundBytes: 2000, batchSize: 1, batchInterval: 60_000, timers: timersA,
    });
    const logB = createDebugLog({
      indexedDB: idb, now: clock().tick, pageId: OTHER_PAGE,
      boundBytes: 2000, batchSize: 1, batchInterval: 60_000, timers: timersB,
    });
    logA.record('error', { message: 'from-A' });
    await logA.flush();
    logB.record('error', { message: 'from-B' });
    await logB.flush();
    const sA = await logA.stats();
    const sB = await logB.stats();
    // Both stores read one total — B sees A's write.
    expect(sA.bytes).toBe(sB.bytes);
    expect(sA.events).toBe(2);
    expect(sB.events).toBe(2);
  });
});

describe('debug-log — the batch: size, interval, flush', () => {
  it('one write at the batch\'s size, one at the interval, one on `flush()`', async () => {
    const idb = new IDBFactory();
    const t = fakeTimers();
    const log = createDebugLog({
      indexedDB: idb, now: clock().tick, pageId: PAGE,
      boundBytes: 100_000, batchSize: 3, batchInterval: 1000, timers: t,
    });
    // Under the size, nothing is written yet.
    log.record('error', { message: 'a' });
    log.record('error', { message: 'b' });
    expect((await log.stats()).events).toBe(0);
    // At the size, one write.
    log.record('error', { message: 'c' });
    // Give the write time to land.
    await new Promise<void>((r) => setTimeout(r, 0));
    expect((await log.stats()).events).toBe(3);
    // Under the size again, then fire the interval.
    log.record('error', { message: 'd' });
    const [firstHandle] = [...(t as unknown as { map: Map<unknown, { fn: () => void }> }).map.keys()];
    t.fire(firstHandle!);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect((await log.stats()).events).toBe(4);
    // Then a plain flush for the last one.
    log.record('error', { message: 'e' });
    await log.flush();
    expect((await log.stats()).events).toBe(5);
  });
});

describe('debug-log — clear', () => {
  it('`clear()` deletes every event and zeroes the total in one transaction, then records `cleared`', async () => {
    const idb = new IDBFactory();
    const t = fakeTimers();
    const log = createDebugLog({
      indexedDB: idb, now: clock().tick, pageId: PAGE,
      boundBytes: 100_000, batchSize: 1, batchInterval: 60_000, timers: t,
    });
    log.record('error', { message: 'x' });
    await log.flush();
    expect((await log.stats()).events).toBe(1);
    await log.clear();
    const list = await log.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.kind).toBe('cleared');
    const stats = await log.stats();
    expect(stats.events).toBe(1);
    expect(stats.bytes).toBe(new TextEncoder().encode(JSON.stringify(list[0])).length);
  });
});

describe('debug-log — a transaction the browser aborts', () => {
  it('each aborted batch drops exactly its events, counts them, rejects nothing', async () => {
    const real = new IDBFactory();
    // A factory whose database returns the real transaction and aborts it
    // before it completes, so the module's `onabort` fires — the path a quota
    // or an abort reaches in a browser.
    const factory = {
      open(name: string, version?: number): IDBOpenDBRequest {
        const req = real.open(name, version);
        req.addEventListener('success', () => {
          const db = req.result;
          const origTx = db.transaction.bind(db);
          (db as unknown as { transaction: typeof db.transaction }).transaction = ((
            stores: string | string[], mode?: IDBTransactionMode,
          ) => {
            const tx = origTx(stores, mode);
            // Abort through a microtask so the caller's requests queue
            // first and `onabort` fires on an otherwise-active transaction.
            if (mode === 'readwrite') queueMicrotask(() => tx.abort());
            return tx;
          }) as typeof db.transaction;
        });
        return req;
      },
      deleteDatabase: real.deleteDatabase.bind(real),
      databases: real.databases.bind(real),
      cmp: real.cmp.bind(real),
    } as unknown as IDBFactory;
    const log = createDebugLog({
      indexedDB: factory, now: clock().tick, pageId: PAGE,
      boundBytes: 100_000, batchSize: 1, batchInterval: 60_000, timers: fakeTimers(),
    });
    log.record('error', { message: 'x' });
    await expect(log.flush()).resolves.toBeUndefined();
    log.record('error', { message: 'y' });
    await expect(log.flush()).resolves.toBeUndefined();
    const stats = await log.stats();
    expect(stats.dropped).toBe(2);
    expect(stats.events).toBe(0);
  });
});

describe('debug-log — no IndexedDB', () => {
  it('with no factory the stats say unavailable, no record stands', async () => {
    const t = fakeTimers();
    const log = createDebugLog({
      indexedDB: undefined, now: clock().tick, pageId: PAGE,
      boundBytes: 100_000, batchSize: 1, batchInterval: 60_000, timers: t,
    });
    log.record('error', { message: 'nothing' });
    await log.flush();
    const stats = await log.stats();
    expect(stats.unavailable).toBe(true);
    expect(stats.open).toBe(false);
    expect(stats.events).toBe(0);
    expect(stats.bytes).toBe(0);
    const list = await log.list();
    expect(list).toEqual([]);
  });
});

describe('debug-log — the route\'s shape', () => {
  it('every query key is kept, the four allowed with their values, every other with an empty value; a mesh URL\'s id apart from its path', () => {
    const idHex = 'a'.repeat(64);
    const author = 'b'.repeat(64);
    // Variable path segments turn into parameter names; a fixed word of a
    // known route is kept.
    expect(routeShape(`https://notis.fun/api/posts/${idHex}/thread?viewer=${author}&limit=50`))
      .toEqual({ path: '/posts/:id/thread', query: { viewer: '', limit: '50' } });
    expect(routeShape('https://notis.fun/api/usernames/alice'))
      .toEqual({ path: '/usernames/:name', query: {} });
    expect(routeShape('https://notis.fun/api/blocks/12345'))
      .toEqual({ path: '/blocks/:height', query: {} });
    expect(routeShape('https://notis.fun/api/blocks/current'))
      .toEqual({ path: '/blocks/current', query: {} });
    expect(routeShape(`https://notis.fun/api/karma/${idHex}?pending=1&owner=${author}&limit=50`))
      .toEqual({ path: '/karma/:key', query: { pending: '1', owner: '', limit: '50' } });
    expect(routeShape(`https://notis.fun/api/posts/${idHex}?tx=1&viewer=${author}`))
      .toEqual({ path: '/posts/:id', query: { tx: '1', viewer: '' } });
    expect(routeShape('https://notis.fun/api/posts?light=1&after=aa&limit=100'))
      .toEqual({ path: '/posts', query: { light: '1', after: '', limit: '100' } });
    // The author's key beside the limit: `author` is dropped, `limit` is kept.
    expect(routeShape(`https://notis.fun/api/posts?author=${author}&limit=20`))
      .toEqual({ path: '/posts', query: { author: '', limit: '20' } });
    // A mesh URL: the authority is the node id, dropped; the path is what the
    // request asks over the connection.
    expect(routeShape(`notis-mesh://${idHex}/blocks/current`))
      .toEqual({ path: '/blocks/current', query: {} });
    // A malformed percent-escape in a value returns, not throws.
    expect(routeShape('https://notis.fun/api/posts?after=%E0%A4%A&limit=10'))
      .toEqual({ path: '/posts', query: { after: '', limit: '10' } });
  });
});

describe('debug-log — flush at hide', () => {
  it('`visibilitychange` when hidden and `pagehide` each flush the buffer', async () => {
    const idb = new IDBFactory();
    const t = fakeTimers();
    const log = createDebugLog({
      indexedDB: idb, now: clock().tick, pageId: PAGE,
      boundBytes: 100_000, batchSize: 1000, batchInterval: 60_000, timers: t,
    });
    const doc = fakeDocumentHost('visible');
    const win = fakeHost();
    const detach = attachFlushOnHide(log, doc, win);
    log.record('error', { message: 'buffered-1' });
    doc.setVisibility('hidden');
    doc.dispatch('visibilitychange', {});
    await new Promise<void>((r) => setTimeout(r, 0));
    expect((await log.stats()).events).toBe(1);
    log.record('error', { message: 'buffered-2' });
    win.dispatch('pagehide', {});
    await new Promise<void>((r) => setTimeout(r, 0));
    expect((await log.stats()).events).toBe(2);
    detach();
    expect(doc.active() + win.active()).toBe(0);
  });
});

describe('debug-log — the error recorder', () => {
  it('records an `error` event for each `error` and `unhandledrejection`, each bounded', async () => {
    const idb = new IDBFactory();
    const t = fakeTimers();
    const log = createDebugLog({
      indexedDB: idb, now: clock().tick, pageId: PAGE,
      boundBytes: 100_000, batchSize: 1, batchInterval: 60_000, timers: t,
    });
    const win = fakeHost();
    const detach = attachErrorRecorder(log, win);
    const stack = 'Error: boom\n    at a:1\n    at b:2\n    at c:3\n    at d:4\n    at e:5\n    at f:6';
    win.dispatch('error', { message: 'something broke', error: { stack } });
    win.dispatch('unhandledrejection', { reason: { message: 'rejected', stack } });
    await new Promise<void>((r) => setTimeout(r, 0));
    await log.flush();
    const list = await log.list();
    expect(list.length).toBe(2);
    for (const e of list) {
      expect(e.kind).toBe('error');
      expect(typeof e.message).toBe('string');
      expect(typeof e.stack).toBe('string');
      // Both fields are bounded.
      expect((e.message as string).length).toBeLessThan(1_000);
      expect((e.stack as string).length).toBeLessThan(2_000);
    }
    detach();
    expect(win.active()).toBe(0);
  });
});
