// A fake `chrome.*` surface for the extension tests — modelled on fake-tabs.ts.
// The two storage areas are plain Maps and fire the same `onChanged` events the
// real API does; onMessage dispatches to registered listeners with a controllable
// `sender`; tabs / windows / action / permissions are the small pieces the
// background touches. Two `FakeChrome` instances over the same fixture prove the
// worker-restart claim WEB_INTERFACE → "The unlocked seed lives in `storage.session`" carries.

interface Fixture {
  local: Map<string, unknown>;
  session: Map<string, unknown>;
  changedListeners: Array<
    (changes: Record<string, chrome.storage.StorageChange>, area: 'local' | 'session') => void
  >;
  // The message router is per-instance — the second background instance shares
  // storage but has its own listeners.
}

export interface FakeChrome {
  api: typeof chrome;
  storage: {
    local: Map<string, unknown>;
    session: Map<string, unknown>;
    /** Fire an external change on the fixture — used to simulate one instance's
     *  writes reaching another's listeners. */
    fireChange(area: 'local' | 'session', key: string, oldValue: unknown, newValue: unknown): void;
  };
  /** Send a message to this instance's onMessage listeners. Returns the answer
   *  the listener produced through `sendResponse`. */
  send(message: unknown, sender?: chrome.runtime.MessageSender): Promise<unknown>;
  /** Trigger the runtime events the background registers. */
  fireStartup(): void;
  fireInstalled(reason: string): void;
  fireActionClicked(): void;
  fireWindowRemoved(windowId: number): void;
  fireTabRemoved(tabId: number): void;
  windows: {
    created: chrome.windows.CreateProps[];
    removed: number[];
    setNextId(id: number): void;
    /** The Window returned by `getLastFocused` — a plain object with any of
     *  `left`, `top`, `width`, `height` set (missing or non-numeric ⇒ the
     *  background reads it as an unknown geometry, WEB_INTERFACE → The extension
     *  → "The prompt window"). Null skips the call entirely. */
    setLastFocused(win: chrome.windows.Window | null): void;
  };
  tabs: {
    queried: Array<{ url?: string | string[] }>;
    updated: Array<[number, { active?: boolean }]>;
    created: Array<{ url: string }>;
    setQueryResult(result: chrome.tabs.Tab[]): void;
  };
  permissions: {
    requested: Array<{ origins?: string[]; permissions?: string[] }>;
    setNextRequestOutcome(result: boolean): void;
  };
  /** The URL the extension serves its pages under; runtime.getURL prefixes it. */
  origin: string;
}

/** Build a fake chrome API. Two instances built with the same `fixture` share
 *  storage — the worker-restart scenario. */
export function fakeChrome(fixture: Fixture = freshFixture(), origin = 'chrome-extension://xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/'): FakeChrome {
  const state: FakeChrome = {
    api: {} as unknown as typeof chrome,
    storage: {
      local: fixture.local,
      session: fixture.session,
      fireChange: (area, key, oldValue, newValue) => fireChange(fixture, area, key, oldValue, newValue),
    },
    send: async (message, sender) => {
      const s: chrome.runtime.MessageSender = sender ?? {};
      for (const listener of messageListeners) {
        const r = await new Promise<unknown>((resolve) => {
          let responded = false;
          const send = (v: unknown): void => { if (!responded) { responded = true; resolve(v); } };
          const returnValue = listener(message, s, send);
          if (returnValue !== true) {
            // Synchronous listeners: no sendResponse expected.
            queueMicrotask(() => resolve(undefined));
          }
        });
        if (r !== undefined) return r;
      }
      return undefined;
    },
    fireStartup: () => { for (const l of onStartupListeners) l(); },
    fireInstalled: (reason) => { for (const l of onInstalledListeners) l({ reason }); },
    fireActionClicked: () => { for (const l of onActionClickedListeners) l({}); },
    fireWindowRemoved: (windowId) => { for (const l of onWindowRemovedListeners) l(windowId); },
    fireTabRemoved: (tabId) => { for (const l of onTabRemovedListeners) l(tabId); },
    windows: {
      created: [],
      removed: [],
      setNextId: (id) => { nextWindowId = id; },
      setLastFocused: (win) => { lastFocused = win; },
    },
    tabs: {
      queried: [],
      updated: [],
      created: [],
      setQueryResult: (result) => { queryResult = result; },
    },
    permissions: {
      requested: [],
      setNextRequestOutcome: (v) => { nextRequestOutcome = v; },
    },
    origin,
  };

  const messageListeners: Array<
    (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (v?: unknown) => void) => boolean | void
  > = [];
  const onStartupListeners: Array<() => void> = [];
  const onInstalledListeners: Array<(d: { reason: string }) => void> = [];
  const onActionClickedListeners: Array<(t: chrome.tabs.Tab) => void> = [];
  const onWindowRemovedListeners: Array<(id: number) => void> = [];
  const onTabRemovedListeners: Array<(id: number) => void> = [];

  let nextWindowId = 100;
  let queryResult: chrome.tabs.Tab[] = [];
  let nextRequestOutcome = true;
  // The Window `getLastFocused` returns; null means the API throws — a caller
  // reading it defensively must treat it as an unknown geometry.
  let lastFocused: chrome.windows.Window | null = { left: 100, top: 50, width: 1200, height: 800 };

  const storageArea = (map: Map<string, unknown>, area: 'local' | 'session'): chrome.storage.StorageArea => ({
    async get(keys) {
      if (keys === undefined || keys === null) {
        return Object.fromEntries(map.entries());
      }
      if (typeof keys === 'string') {
        return map.has(keys) ? { [keys]: map.get(keys) } : {};
      }
      if (Array.isArray(keys)) {
        const out: Record<string, unknown> = {};
        for (const k of keys) if (map.has(k)) out[k] = map.get(k);
        return out;
      }
      const out: Record<string, unknown> = {};
      for (const [k, defaultValue] of Object.entries(keys)) out[k] = map.has(k) ? map.get(k) : defaultValue;
      return out;
    },
    async set(items) {
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const [k, v] of Object.entries(items)) {
        const oldValue = map.get(k);
        map.set(k, v);
        changes[k] = { oldValue, newValue: v };
      }
      fireChangeSet(fixture, area, changes);
    },
    async remove(keys) {
      const arr = Array.isArray(keys) ? keys : [keys];
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const k of arr) {
        if (map.has(k)) {
          changes[k] = { oldValue: map.get(k), newValue: undefined };
          map.delete(k);
        }
      }
      if (Object.keys(changes).length) fireChangeSet(fixture, area, changes);
    },
    async clear() {
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const [k, v] of map.entries()) changes[k] = { oldValue: v, newValue: undefined };
      map.clear();
      if (Object.keys(changes).length) fireChangeSet(fixture, area, changes);
    },
  });

  const api: typeof chrome = {
    runtime: {
      onMessage: {
        addListener(listener: (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (v?: unknown) => void) => boolean | void) {
          messageListeners.push(listener);
        },
      } as unknown as chrome.runtime.OnMessageEvent,
      onInstalled: {
        addListener(listener: (d: { reason: string }) => void) { onInstalledListeners.push(listener); },
      } as unknown as chrome.runtime.OnInstalledEvent,
      onStartup: {
        addListener(listener: () => void) { onStartupListeners.push(listener); },
      } as unknown as chrome.runtime.OnStartupEvent,
      async sendMessage(_message: unknown) { return undefined; },
      getURL(path: string) { return origin + path.replace(/^\/+/, ''); },
      id: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    },
    storage: {
      local: storageArea(fixture.local, 'local'),
      session: storageArea(fixture.session, 'session'),
      onChanged: {
        addListener(
          listener: (changes: Record<string, chrome.storage.StorageChange>, area: 'local' | 'session') => void,
        ) {
          fixture.changedListeners.push(listener);
        },
        removeListener(
          listener: (changes: Record<string, chrome.storage.StorageChange>, area: 'local' | 'session') => void,
        ) {
          const i = fixture.changedListeners.indexOf(listener);
          if (i >= 0) fixture.changedListeners.splice(i, 1);
        },
      } as unknown as chrome.storage.OnChangedEvent,
    },
    tabs: {
      async query(info) {
        state.tabs.queried.push(info);
        return queryResult;
      },
      async update(tabId, props) {
        state.tabs.updated.push([tabId, props]);
        return { id: tabId };
      },
      async create(props) {
        state.tabs.created.push({ url: props.url });
        return { id: nextWindowId++, url: props.url };
      },
      onRemoved: {
        addListener(listener: (tabId: number) => void) { onTabRemovedListeners.push(listener); },
      } as unknown as chrome.tabs.OnRemovedEvent,
    },
    windows: {
      async create(props) {
        state.windows.created.push(props);
        const id = nextWindowId++;
        return { id };
      },
      async update(_id, _props) { return {}; },
      async remove(id) { state.windows.removed.push(id); },
      async getLastFocused() {
        if (lastFocused === null) throw new Error('no last-focused window');
        return lastFocused;
      },
      onRemoved: {
        addListener(listener: (id: number) => void) { onWindowRemovedListeners.push(listener); },
      } as unknown as chrome.windows.OnRemovedEvent,
    },
    action: {
      onClicked: {
        addListener(listener: (t: chrome.tabs.Tab) => void) { onActionClickedListeners.push(listener); },
      } as unknown as chrome.action.OnClickedEvent,
    },
    permissions: {
      async request(perms) {
        state.permissions.requested.push(perms);
        return nextRequestOutcome;
      },
      async contains() { return false; },
    },
  };

  state.api = api;
  return state;
}

/** A fresh in-memory fixture — two instances built with the same fixture
 *  share storage. */
export function freshFixture(): Fixture {
  return { local: new Map(), session: new Map(), changedListeners: [] };
}

function fireChange(
  fixture: Fixture,
  area: 'local' | 'session',
  key: string,
  oldValue: unknown,
  newValue: unknown,
): void {
  fireChangeSet(fixture, area, { [key]: { oldValue, newValue } });
}

function fireChangeSet(
  fixture: Fixture,
  area: 'local' | 'session',
  changes: Record<string, chrome.storage.StorageChange>,
): void {
  for (const listener of fixture.changedListeners) listener(changes, area);
}
