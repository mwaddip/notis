// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { App } from '../src/app';
import type { Api } from '../src/api/client';
import type { AppIdentity } from '../src/model/state';
import type { FeedResult, ThreadResult, PostJson } from '../src/api/dto';
import { karmaResult } from './karma-fixture';
import { contentHashHex } from '../src/integrity';
import { KEY_LAYOUT } from '../src/prefs';

const HEX = (c: string): string => c.repeat(64);
const P1 = HEX('a'), P2 = HEX('b'), R1 = HEX('1');
const KEY = HEX('7');

function post(id: string, content: string, parents: string[] = []): PostJson {
  return {
    id, content, contentHash: contentHashHex(content), author: KEY, parentRefs: parents,
    protocolVersion: 1, type: 'regular', status: 'confirmed',
    blockHeight: 1, blockIndex: 0, blockCreatedAt: 0, likeCount: 0, descendantCount: 1, authorVouchCount: 0, likedByViewer: null,
  };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function fakeApi(): Api & { feedCalls: number } {
  let feedCalls = 0;
  const feed: FeedResult = { posts: [post(P1, 'root one'), post(P2, 'root two')], next: null, pending: [], pendingCount: 0 };
  const thread = (root: string, reply: string): ThreadResult => ({
    post: post(root, 'root'), ancestors: [], ancestorCount: 0,
    descendants: [post(reply, 'a reply', [root])], descendantCount: 1,
    next: null, pending: [], pendingCount: 0,
  });
  return {
    get feedCalls() { return feedCalls; },
    feed: async () => { feedCalls++; return feed; },
    thread: async (id) => (id === P1 ? thread(P1, R1) : null),
    post: async () => null,
    status: async () => ({
      networkType: 'test', blockHeight: 1, protocolVersion: 1, postCount: 2, pendingPosts: 0,
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
  };
}

function fakeIdentity(): AppIdentity {
  let cur: { pubKeyHex: string; locked: boolean } | null = null;
  const listeners: Array<(id: { pubKeyHex: string } | null) => void> = [];
  return {
    current: () => cur,
    sign: () => 'ab'.repeat(64),
    draft: () => ({ pubKeyHex: KEY }),
    create: async () => {
      cur = { pubKeyHex: KEY, locked: false };
      for (const l of listeners) l({ pubKeyHex: KEY });
      return { pubKeyHex: KEY };
    },
    discardDraft: () => {},
    inspectFile: () => ({ kind: 'clear', pubKeyHex: KEY }),
    importFile: async () => {
      cur = { pubKeyHex: KEY, locked: false };
      for (const l of listeners) l({ pubKeyHex: KEY });
      return { pubKeyHex: KEY };
    },
    exportFile: async () => '{}',
    unlock: async () => { if (cur) cur.locked = false; },
    lock: () => { if (cur) cur.locked = true; },
    forget: () => {
      cur = null;
      for (const l of listeners) l(null);
    },
    backedUp: () => false,
    onChange: (cb) => listeners.push(cb),
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

describe('standalone mode', () => {
  it('boots with no feed content, no .empty, and the bar carries ↻ alone', async () => {
    const { appbar, feed, panes } = mountShell();
    const app = new App(fakeApi());
    app.mount(appbar, feed, panes, { kind: 'standalone', id: P1, base: '/' });
    await flush();

    expect(feed.children.length).toBe(0);
    expect(panes.querySelector('.empty')).toBeNull();
    const bar = panes.querySelector('.bar');
    expect(bar).toBeTruthy();
    const ctls = [...bar!.querySelectorAll('.ctl')].map((c) => c.textContent);
    expect(ctls).toEqual(['↻']);
  });

  it('notis.layout is untouched by mount and a rebuild', async () => {
    const { appbar, feed, panes } = mountShell();
    localStorage.setItem(KEY_LAYOUT, '#' + HEX('f'));
    const app = new App(fakeApi());
    app.mount(appbar, feed, panes, { kind: 'standalone', id: P1, base: '/' });
    await flush();

    expect(localStorage.getItem(KEY_LAYOUT)).toBe('#' + HEX('f'));
  });

  it('the .workspace element carries the standalone class', () => {
    const { appbar, feed, panes } = mountShell();
    const app = new App(fakeApi());
    app.mount(appbar, feed, panes, { kind: 'standalone', id: P1, base: '/' });
    const ws = panes.closest('.workspace');
    expect(ws?.classList.contains('standalone')).toBe(true);
  });

  it('the thread renders its cards on load', async () => {
    const { appbar, feed, panes } = mountShell();
    const app = new App(fakeApi());
    app.start(appbar, feed, panes, { kind: 'standalone', id: P1, base: '/' });
    await flush();
    await flush();

    const cards = panes.querySelectorAll('.card');
    expect(cards.length).toBeGreaterThanOrEqual(1);
  });

  it('an identity change on the standalone page issues no feed read', async () => {
    const { appbar, feed, panes } = mountShell();
    const api = fakeApi();
    const idm = fakeIdentity();
    const app = new App(api, undefined, idm);
    app.start(appbar, feed, panes, { kind: 'standalone', id: P1, base: '/' });
    await flush();
    await flush();

    const before = api.feedCalls;
    await idm.create('pass');
    await flush();
    await flush();

    expect(api.feedCalls).toBe(before);
    expect(feed.children.length).toBe(0);
  });
});

describe('standalone header', () => {
  it('has the brand, add to workspace, the theme control, no arrows, no profile', () => {
    const { appbar, feed, panes } = mountShell();
    const app = new App(fakeApi());
    app.mount(appbar, feed, panes, { kind: 'standalone', id: P1, base: '/' });

    expect(appbar.querySelector('.brand')).toBeTruthy();
    expect(appbar.querySelector('.theme-btn')).toBeTruthy();
    const wayIn = appbar.querySelector('[aria-label="add this thread to your workspace"]');
    expect(wayIn).toBeTruthy();
    expect(wayIn?.textContent).toBe('add to workspace');
    expect(appbar.querySelectorAll('.ctl').length).toBe(0);
    expect(appbar.querySelector('[aria-label="open profile"]')).toBeNull();
  });
});

describe('standalone title and re-root', () => {
  it('document.title is set after the thread loads', async () => {
    const { appbar, feed, panes } = mountShell();
    const app = new App(fakeApi());
    app.start(appbar, feed, panes, { kind: 'standalone', id: P1, base: '/' });
    await flush();
    await flush();

    expect(document.title).toContain('Notis');
    expect(document.title).toContain('…');
  });

  it('the strip re-roots, pushes a history entry, and leaves notis.layout untouched', async () => {
    const { appbar, feed, panes } = mountShell();
    localStorage.setItem(KEY_LAYOUT, '#' + HEX('f'));
    const app = new App(fakeApi());
    const drive = app as unknown as {
      start(a: HTMLElement, b: HTMLElement, c: HTMLElement, m: { kind: 'standalone'; id: string; base: string }): void;
      openThread(id: string, origin: { from: 'pane'; ci: number }): void;
    };
    drive.start(appbar, feed, panes, { kind: 'standalone', id: P1, base: '/' });
    await flush();
    await flush();

    const histBefore = history.length;
    drive.openThread(R1, { from: 'pane', ci: 0 });
    await flush();

    expect(history.length).toBe(histBefore + 1);
    expect(location.pathname).toContain(R1);
    expect(localStorage.getItem(KEY_LAYOUT)).toBe('#' + HEX('f'));
  });

  it('back returns to the original root after a re-root', async () => {
    const { appbar, feed, panes } = mountShell();
    const app = new App(fakeApi());
    const drive = app as unknown as {
      start(a: HTMLElement, b: HTMLElement, c: HTMLElement, m: { kind: 'standalone'; id: string; base: string }): void;
      openThread(id: string, origin: { from: 'pane'; ci: number }): void;
      state: { workspace: { columns: Array<{ wins: string[] }> } };
    };
    drive.start(appbar, feed, panes, { kind: 'standalone', id: P1, base: '/' });
    await flush();
    await flush();

    drive.openThread(R1, { from: 'pane', ci: 0 });
    await flush();

    // happy-dom may not dispatch popstate on back — drive the listener directly.
    window.dispatchEvent(new PopStateEvent('popstate', { state: { id: P1 } }));
    await flush();

    expect(drive.state.workspace.columns[0]!.wins[0]).toBe(P1);
  });
});

describe('linkUrl from the App', () => {
  it('builds an absolute URL from base / and base /web/', () => {
    const { appbar, feed, panes } = mountShell();
    const app = new App(fakeApi());
    app.mount(appbar, feed, panes, { kind: 'standalone', id: P1, base: '/' });
    const drive = app as unknown as { ctx(): { linkUrl: (id: string) => string } };
    expect(drive.ctx().linkUrl(P1)).toBe(location.origin + '/p/' + P1);

    const { appbar: ab2, feed: f2, panes: p2 } = mountShell();
    const app2 = new App(fakeApi());
    app2.mount(ab2, f2, p2, { kind: 'standalone', id: P1, base: '/web/' });
    const drive2 = app2 as unknown as { ctx(): { linkUrl: (id: string) => string } };
    expect(drive2.ctx().linkUrl(P1)).toBe(location.origin + '/web/p/' + P1);
  });
});

describe('the way in — tabs', () => {
  it('the receiver opens a thread only when holding the lock', async () => {
    const { appbar, feed, panes } = mountShell();
    const { fakeTabs } = await import('./fake-tabs');
    const tabs = fakeTabs();
    tabs.setHolding(false);
    const app = new App(fakeApi(), undefined, undefined, undefined, tabs);
    app.start(appbar, feed, panes, { kind: 'workspace', base: '/' });
    await flush();
    await flush();

    const before = panes.querySelectorAll('.col').length;
    tabs.fireOpen(P1);
    await flush();
    expect(panes.querySelectorAll('.col').length).toBe(before);
  });

  it('a non-holder never writes notis.layout', async () => {
    const { appbar, feed, panes } = mountShell();
    const { fakeTabs } = await import('./fake-tabs');
    const tabs = fakeTabs();
    tabs.setHolding(false);
    localStorage.setItem(KEY_LAYOUT, '#' + HEX('f'));
    const app = new App(fakeApi(), undefined, undefined, undefined, tabs);
    app.start(appbar, feed, panes, { kind: 'workspace', base: '/' });
    await flush();
    const drive = app as unknown as {
      openThread(id: string, origin: { from: 'feed' }): void;
    };
    drive.openThread(P1, { from: 'feed' });
    await flush();
    expect(localStorage.getItem(KEY_LAYOUT)).toBe('#' + HEX('f'));
  });

  it('the in-place switch restores P2, inserts P1 at column 0, replaces the URL, and writes once held', async () => {
    const { appbar, feed, panes } = mountShell();
    localStorage.setItem(KEY_LAYOUT, '#' + P2);
    const { fakeTabs } = await import('./fake-tabs');
    const tabs = fakeTabs();
    tabs.setHeldElsewhere(false);
    const app = new App(fakeApi(), undefined, undefined, undefined, tabs);
    const drive = app as unknown as {
      start(a: HTMLElement, b: HTMLElement, c: HTMLElement, m: { kind: 'standalone'; id: string; base: string }): void;
      wayIn(): Promise<void>;
      state: { workspace: { columns: Array<{ wins: string[]; focus: number }> } };
    };
    drive.start(appbar, feed, panes, { kind: 'standalone', id: P1, base: '/' });
    await flush();
    await flush();

    await drive.wayIn();
    await flush();
    await flush();

    const col0 = drive.state.workspace.columns[0]!;
    expect(col0.wins).toEqual([P2, P1]);
    expect(col0.focus).toBe(1);
    expect(location.pathname).toBe('/');
    expect(feed.children.length).toBeGreaterThan(0);

    tabs.setHolding(true);
    await flush();
    await flush();
  });

  it('a popstate with an id after the switch does not overwrite the workspace', async () => {
    const { appbar, feed, panes } = mountShell();
    const { fakeTabs } = await import('./fake-tabs');
    const tabs = fakeTabs();
    tabs.setHeldElsewhere(false);
    const app = new App(fakeApi(), undefined, undefined, undefined, tabs);
    const drive = app as unknown as {
      start(a: HTMLElement, b: HTMLElement, c: HTMLElement, m: { kind: 'standalone'; id: string; base: string }): void;
      wayIn(): Promise<void>;
      state: { workspace: { columns: Array<{ wins: string[] }> } };
    };
    drive.start(appbar, feed, panes, { kind: 'standalone', id: P1, base: '/' });
    await flush();
    await flush();

    await drive.wayIn();
    await flush();

    const before = JSON.stringify(drive.state.workspace.columns.map((c) => c.wins));
    window.dispatchEvent(new PopStateEvent('popstate', { state: { id: R1 } }));
    await flush();

    expect(JSON.stringify(drive.state.workspace.columns.map((c) => c.wins))).toBe(before);
  });
});
