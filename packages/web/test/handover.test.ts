// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { wrapTabs } from '../src/extension/handover';
import { install } from '../src/extension/background';
import { App } from '../src/app';
import type { Api } from '../src/api/client';
import type { FeedResult, ThreadResult, PostJson } from '../src/api/dto';
import { karmaResult } from './karma-fixture';
import { contentHashHex } from '../src/integrity';
import { fakeTabs } from './fake-tabs';
import { fakeChrome, type FakeChrome } from './fake-chrome';

// The page's half of the handover — WEB_INTERFACE → The extension → "Links into the extension".
// The holder asks the background for waiting threads at two moments: `claim()` resolving, and a
// `notis.open.` key appearing in `storage.session` while it holds; one ask in flight at a time,
// answers reach every listener, refusals leave the records standing and do not retry.

const HEX = (c: string): string => c.repeat(64);
const HEX_A = HEX('a');
const HEX_B = HEX('b');
const HEX_C = HEX('c');

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Count the `takeOpen` calls on the runtime message wire and steer their answers by index. A
 *  request without an answer is left pending until the caller resolves it — the "release the
 *  first answer by hand" moment the concurrency test asks for. */
function wireTakeOpen(c: FakeChrome): {
  count: () => number;
  push(answer: unknown): void;
  next(): { resolve: (v: unknown) => void; reject: (e: unknown) => void };
} {
  let count = 0;
  const answers: unknown[] = [];
  const gate: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  c.api.runtime.sendMessage = (async (message: unknown) => {
    const kind = (message as { kind?: string })?.kind ?? '';
    if (kind !== 'takeOpen') throw new Error('unexpected message kind: ' + kind);
    count += 1;
    if (answers.length > 0) return answers.shift();
    return new Promise((resolve, reject) => { gate.push({ resolve, reject }); });
  }) as typeof chrome.runtime.sendMessage;
  return {
    count: () => count,
    push: (answer) => answers.push(answer),
    next: () => {
      const g = gate.shift();
      if (!g) throw new Error('no pending ask to release');
      return g;
    },
  };
}

describe('wrapTabs — the holder asks the background for waiting threads', () => {
  it('a record standing at boot, holder → one takeOpen after claim resolves, listener gets the id', async () => {
    const c = fakeChrome();
    c.storage.session.set('notis.open.' + HEX_A, { raise: true });
    const inner = fakeTabs();
    const wire = wireTakeOpen(c);
    wire.push({ ids: [HEX_A] });
    const wrap = wrapTabs(inner, c.api);
    const received: string[] = [];
    wrap.onOpen((id) => received.push(id));
    inner.setHolding(true);
    await wrap.claim();
    await flush();
    await flush();
    expect(wire.count()).toBe(1);
    expect(received).toEqual([HEX_A]);
  });

  it('a record standing, tab not holder at claim → no message; when claim later resolves → the ask', async () => {
    const c = fakeChrome();
    c.storage.session.set('notis.open.' + HEX_A, { raise: true });
    const inner = fakeTabs();
    const wire = wireTakeOpen(c);
    wire.push({ ids: [HEX_A] });
    const wrap = wrapTabs(inner, c.api);
    const received: string[] = [];
    wrap.onOpen((id) => received.push(id));
    // Start claim while the inner reports not holding — the wrapper awaits its resolution.
    const claim = wrap.claim();
    await flush();
    expect(wire.count()).toBe(0);
    inner.setHolding(true);
    await claim;
    await flush();
    await flush();
    expect(wire.count()).toBe(1);
    expect(received).toEqual([HEX_A]);
  });

  it('nothing standing at claim → no message (a boot with nothing waiting wakes no worker)', async () => {
    const c = fakeChrome();
    const inner = fakeTabs();
    const wire = wireTakeOpen(c);
    const wrap = wrapTabs(inner, c.api);
    wrap.onOpen(() => {});
    inner.setHolding(true);
    await wrap.claim();
    await flush();
    await flush();
    expect(wire.count()).toBe(0);
  });

  it('a record appearing while holding → the ask → the listener', async () => {
    const c = fakeChrome();
    const inner = fakeTabs();
    const wire = wireTakeOpen(c);
    wire.push({ ids: [HEX_A] });
    const wrap = wrapTabs(inner, c.api);
    const received: string[] = [];
    wrap.onOpen((id) => received.push(id));
    inner.setHolding(true);
    await wrap.claim();
    await flush();
    // Nothing at boot, so claim's resolution asks nothing.
    expect(wire.count()).toBe(0);
    // A record appears while holding — the storage listener triggers the ask.
    await c.api.storage.session.set({ ['notis.open.' + HEX_A]: { raise: true } });
    await flush();
    await flush();
    expect(wire.count()).toBe(1);
    expect(received).toEqual([HEX_A]);
  });

  it('a record appearing while not holding → nothing', async () => {
    const c = fakeChrome();
    const inner = fakeTabs();
    const wire = wireTakeOpen(c);
    const wrap = wrapTabs(inner, c.api);
    wrap.onOpen(() => {});
    // Never claim; the inner reports not holding, so a session write is ignored.
    await c.api.storage.session.set({ ['notis.open.' + HEX_A]: { raise: true } });
    await flush();
    await flush();
    expect(wire.count()).toBe(0);
  });

  it('a notis.open. removal event → nothing; a local change or another key → nothing', async () => {
    const c = fakeChrome();
    const inner = fakeTabs();
    const wire = wireTakeOpen(c);
    const wrap = wrapTabs(inner, c.api);
    wrap.onOpen(() => {});
    inner.setHolding(true);
    await wrap.claim();
    await flush();

    // A session write under an unrelated key.
    await c.api.storage.session.set({ 'notis.seed': 'deadbeef' });
    await flush();
    expect(wire.count()).toBe(0);

    // A write under notis.open.<id> — the ask fires; drop the queued answer so the second run
    // starts clean.
    wire.push({ ids: [] });
    await c.api.storage.session.set({ ['notis.open.' + HEX_A]: { raise: false } });
    await flush();
    await flush();
    expect(wire.count()).toBe(1);

    // A removal of that same key — no newValue, no notice.
    await c.api.storage.session.remove('notis.open.' + HEX_A);
    await flush();
    expect(wire.count()).toBe(1);

    // A local-area write under notis.open.<id> — the wrong area, no notice.
    await c.api.storage.local.set({ ['notis.open.' + HEX_A]: { raise: true } });
    await flush();
    expect(wire.count()).toBe(1);
  });

  it('two records standing → one ask, both ids delivered', async () => {
    const c = fakeChrome();
    c.storage.session.set('notis.open.' + HEX_A, { raise: true });
    c.storage.session.set('notis.open.' + HEX_B, { raise: false });
    const inner = fakeTabs();
    const wire = wireTakeOpen(c);
    wire.push({ ids: [HEX_A, HEX_B] });
    const wrap = wrapTabs(inner, c.api);
    const received: string[] = [];
    wrap.onOpen((id) => received.push(id));
    inner.setHolding(true);
    await wrap.claim();
    await flush();
    await flush();
    expect(wire.count()).toBe(1);
    expect(received.sort()).toEqual([HEX_A, HEX_B].sort());
  });

  it('a record appearing during a flight → exactly one further ask after the first answers, never two in flight', async () => {
    const c = fakeChrome();
    c.storage.session.set('notis.open.' + HEX_A, { raise: true });
    const inner = fakeTabs();
    const wire = wireTakeOpen(c);
    const wrap = wrapTabs(inner, c.api);
    const received: string[] = [];
    wrap.onOpen((id) => received.push(id));
    inner.setHolding(true);
    await wrap.claim();
    await flush();
    expect(wire.count()).toBe(1);

    // A record appears while the first ask is still pending.
    await c.api.storage.session.set({ ['notis.open.' + HEX_B]: { raise: false } });
    await flush();
    // No concurrent ask — the second is queued behind the first.
    expect(wire.count()).toBe(1);

    // Release the first answer by hand — the wrapper then fires exactly one more ask.
    wire.next().resolve({ ids: [HEX_A] });
    await flush();
    await flush();
    expect(wire.count()).toBe(2);
    // Answer the second so nothing dangles.
    wire.next().resolve({ ids: [HEX_B] });
    await flush();
    await flush();
    expect(received).toEqual([HEX_A, HEX_B]);
    expect(wire.count()).toBe(2);
  });

  it('an id in the answer that is not 64 lower-case hex is dropped, the others delivered', async () => {
    const c = fakeChrome();
    c.storage.session.set('notis.open.' + HEX_A, { raise: true });
    const inner = fakeTabs();
    const wire = wireTakeOpen(c);
    wire.push({ ids: [HEX_A, 'not-hex', 'A'.repeat(64), 42, HEX_C] });
    const wrap = wrapTabs(inner, c.api);
    const received: string[] = [];
    wrap.onOpen((id) => received.push(id));
    inner.setHolding(true);
    await wrap.claim();
    await flush();
    await flush();
    expect(received).toEqual([HEX_A, HEX_C]);
  });

  it('a refused ask: no listener call, no retry loop', async () => {
    const c = fakeChrome();
    c.storage.session.set('notis.open.' + HEX_A, { raise: true });
    const inner = fakeTabs();
    const wire = wireTakeOpen(c);
    wire.push({ error: 'nope' });
    const wrap = wrapTabs(inner, c.api);
    const received: string[] = [];
    wrap.onOpen((id) => received.push(id));
    inner.setHolding(true);
    await wrap.claim();
    await flush();
    await flush();
    await flush();
    expect(wire.count()).toBe(1);
    expect(received).toEqual([]);
  });

  it('an id announced on the channel reaches a listener once', async () => {
    const c = fakeChrome();
    const inner = fakeTabs();
    wireTakeOpen(c);
    const wrap = wrapTabs(inner, c.api);
    const received: string[] = [];
    wrap.onOpen((id) => received.push(id));
    inner.setHolding(true);
    // The fake channel: fireOpen only fires when holding, and it goes through inner.onOpen —
    // the wrapper's own listener list is fired only by takeOpen answers.
    inner.fireOpen(HEX_A);
    await flush();
    expect(received).toEqual([HEX_A]);
  });
});

// ---------------------------------------------------------------------------
// One App-level test — the whole path, no step faked between the background's
// record and the App's window.
// ---------------------------------------------------------------------------

function post(id: string, content: string, parents: string[] = []): PostJson {
  return {
    id, content, contentHash: contentHashHex(content), author: '7'.repeat(64), parentRefs: parents,
    protocolVersion: 1, type: 'regular', status: 'confirmed',
    blockHeight: 1, blockIndex: 0, blockCreatedAt: 0, likeCount: 0, descendantCount: 0,
    authorName: null, likedByViewer: null,
  };
}

function fakeApi(): Api {
  const feed: FeedResult = { posts: [], next: null, pending: [], pendingCount: 0 };
  const thread = (root: string): ThreadResult => ({
    post: post(root, 'root'), ancestors: [], ancestorCount: 0,
    descendants: [], descendantCount: 0, next: null, pending: [], pendingCount: 0,
  });
  return {
    feed: async () => feed,
    thread: async (id) => thread(id),
    post: async (id) => ({ ...post(id, 'root'), confirmedAuthor: '7'.repeat(64) }),
    status: async () => ({
      networkType: 'test', blockHeight: 1, protocolVersion: 1, postCount: 0, pendingPosts: 0,
      totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0,
      vouchCooldownBlocks: 0, inviteBondMin: '0', inviteBondMax: '0',
      membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
    }),
    currentBlock: async () => ({ height: 1, hash: null }),
    karma: async () => karmaResult({ userId: 'x', height: 1 }),
    vouchesByTarget: async () => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async () => ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async () => ({ cooldowns: [], count: 0, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async () => null,
    credits: async () => ({ userId: '', total: '0', boxes: [], boxCount: 0, next: null }),
    usernameByName: async () => null,
  };
}

function mountShell(): { appbar: HTMLElement; feed: HTMLElement; panes: HTMLElement } {
  document.body.innerHTML = '';
  localStorage.clear();
  const ws = document.createElement('div'); ws.className = 'workspace';
  const appbar = document.createElement('header');
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  ws.append(feed, panes);
  document.body.append(appbar, ws);
  return { appbar, feed, panes };
}

describe('wrapTabs — driven from the App, the whole path', () => {
  it('a bridge-shaped arrived to the background lands as a window in column 0', async () => {
    const PUBLIC = 'https://notis.fun/web/';
    const c = fakeChrome();
    install(c.api, { publicBase: PUBLIC });
    // Route the wrapper's sendMessage through the fake dispatch so the real background answers.
    c.api.runtime.sendMessage = ((m: unknown) => c.send(m)) as typeof chrome.runtime.sendMessage;
    // Pre-set the links preference so the bridge's `arrived` is not refused.
    await c.send({ kind: 'links', opens: 'here' });
    // The App plays the workspace holder; the wrapper's storage listener fires on the record's write.
    c.tabs.setQueryResult([{ id: 99, url: c.origin + 'index.html', discarded: false }]);
    const inner = fakeTabs();
    inner.setHolding(true);
    const wrap = wrapTabs(inner, c.api);

    const { appbar, feed, panes } = mountShell();
    const app = new App(fakeApi(), undefined, undefined, undefined, wrap);
    app.start(appbar, feed, panes, { kind: 'workspace', base: '/' });
    await flush();
    await flush();

    // The bridge sends `arrived` for the target thread; the background writes the pending record.
    const bridgeSender: chrome.runtime.MessageSender = {
      id: c.api.runtime.id,
      tab: { id: 42, active: true, windowId: 500 },
      url: PUBLIC + 'p/' + HEX_A,
    };
    await c.send({ kind: 'arrived', id: HEX_A }, bridgeSender);
    // The wrapper's storage listener asks takeOpen; the background answers and the App opens the window.
    await flush();
    await flush();
    await flush();

    const drive = app as unknown as { state: { workspace: { columns: Array<{ wins: string[] }> } } };
    const col0 = drive.state.workspace.columns[0];
    expect(col0).toBeDefined();
    expect(col0!.wins).toContain(HEX_A);
  });
});
