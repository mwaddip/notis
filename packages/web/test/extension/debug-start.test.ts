// @vitest-environment happy-dom
// WEB_INTERFACE → The extension → "The debug log" — the module that starts
// the page's log over required seams. The cases exercise its visible acts:
// recording one `page` event with the four fields, attaching the hide flush
// so a dispatched `pagehide` writes the buffer, and attaching the error
// recorder so a dispatched `error` records one event.

import { describe, it, expect } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { startDebugLog } from '../../src/extension/debug-start';
import type {
  DebugTimerHandle,
  DebugTimers,
  DocumentHost,
  EventHost,
} from '../../src/extension/debug-log';

function fakeTimers(): DebugTimers {
  let seq = 0;
  const map = new Map<DebugTimerHandle, () => void>();
  return {
    setInterval(fn, _ms): DebugTimerHandle {
      const h = ++seq;
      map.set(h, fn);
      return h;
    },
    clearInterval(handle): void {
      map.delete(handle);
    },
  };
}

function fakeHost(): EventHost & { dispatch(type: string, event: unknown): void } {
  const map = new Map<string, Array<(e: unknown) => void>>();
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
  };
}

function fakeDoc(initial: string): DocumentHost & {
  dispatch(type: string, event: unknown): void;
  setVisibility(v: string): void;
} {
  const host = fakeHost();
  let vis = initial;
  return {
    get visibilityState(): string {
      return vis;
    },
    addEventListener: host.addEventListener,
    removeEventListener: host.removeEventListener,
    dispatch: host.dispatch,
    setVisibility(v): void {
      vis = v;
    },
  };
}

const VERSION = '0.7.0';
const COMMIT = 'c'.repeat(40);
const NETWORK = 'devnet';
const USER_AGENT = 'Mozilla/5.0';

describe('debug-start — the page event', () => {
  it.fails('records one `page` event carrying the version, commit, network and user agent', async () => {
    const idb = new IDBFactory();
    const { log } = startDebugLog({
      indexedDB: idb,
      now: () => 1_000,
      random: () => 0.5,
      timers: fakeTimers(),
      document: fakeDoc('visible'),
      window: fakeHost(),
      version: VERSION,
      commit: COMMIT,
      network: NETWORK,
      userAgent: USER_AGENT,
    });
    await log.flush();
    const list = await log.list();
    const pageEvents = list.filter((e) => e.kind === 'page');
    expect(pageEvents).toHaveLength(1);
    expect(pageEvents[0]).toMatchObject({
      version: VERSION,
      commit: COMMIT,
      network: NETWORK,
      userAgent: USER_AGENT,
    });
  });
});

describe('debug-start — the hide flush and the error recorder', () => {
  it.fails('a dispatched `pagehide` writes the buffer, and a dispatched `error` records one `error` event', async () => {
    const idb = new IDBFactory();
    const doc = fakeDoc('visible');
    const win = fakeHost();
    const { log } = startDebugLog({
      indexedDB: idb,
      now: () => 1_000,
      random: () => 0.5,
      timers: fakeTimers(),
      document: doc,
      window: win,
      version: VERSION,
      commit: COMMIT,
      network: NETWORK,
      userAgent: USER_AGENT,
    });
    // `pagehide` writes what was recorded before (the `page` event itself).
    win.dispatch('pagehide', {});
    await new Promise<void>((r) => setTimeout(r, 0));
    const after1 = await log.list();
    expect(after1.filter((e) => e.kind === 'page')).toHaveLength(1);
    // A window error is recorded once by the error recorder.
    win.dispatch('error', { message: 'boom', error: { stack: 'stack' } });
    await log.flush();
    const after2 = await log.list();
    expect(after2.filter((e) => e.kind === 'error')).toHaveLength(1);
  });
});
