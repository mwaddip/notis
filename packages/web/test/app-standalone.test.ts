// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { App } from '../src/app';
import type { Api } from '../src/api/client';
import type { AppIdentity } from '../src/model/state';
import type { FeedResult, ThreadResult, PostJson } from '../src/api/dto';
import { karmaResult } from './karma-fixture';
import { contentHashHex } from '../src/integrity';
import { KEY_LAYOUT } from '../src/prefs';
import { ME, fullRow, tomb, harness, settle, lockableIdentity, recordingWrites, karmaWithBox, type Harness } from './app-light-shared';

const HEX = (c: string): string => c.repeat(64);
const P1 = HEX('a'), P2 = HEX('b'), R1 = HEX('1');
const KEY = HEX('7');

function post(id: string, content: string, parents: string[] = []): PostJson {
  return {
    id, content, contentHash: contentHashHex(content), author: KEY, parentRefs: parents,
    protocolVersion: 1, type: 'regular', status: 'confirmed',
    blockHeight: 1, blockIndex: 0, blockCreatedAt: 0, likeCount: 0, descendantCount: 1, authorName: null, likedByViewer: null, txId: 'ff'.repeat(32),
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
    usernameByOwner: async () => null,
    credits: async () => ({ userId: "", total: "0", boxes: [], boxCount: 0, next: null }),
    usernameByName: async () => null,
  };
}

function fakeIdentity(): AppIdentity {
  let cur: { pubKeyHex: string; locked: boolean } | null = null;
  const listeners: Array<(id: { pubKeyHex: string } | null) => void> = [];
  return {
    current: () => cur,
    sign: async () => ({ signature: 'ab'.repeat(64) }),
    draft: async () => ({ pubKeyHex: KEY }),
    create: async () => {
      cur = { pubKeyHex: KEY, locked: false };
      for (const l of listeners) l({ pubKeyHex: KEY });
      return { pubKeyHex: KEY };
    },
    discardDraft: () => {},
    inspectFile: async () => ({ kind: 'clear', pubKeyHex: KEY }),
    importFile: async () => {
      cur = { pubKeyHex: KEY, locked: false };
      for (const l of listeners) l({ pubKeyHex: KEY });
      return { pubKeyHex: KEY };
    },
    exportFile: async () => '{}',
    unlock: async () => { if (cur) cur.locked = false; },
    lock: async () => { if (cur) cur.locked = true; },
    forget: async () => {
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
  it('has the brand, add to workspace, the theme control, no arrows, no window controls', () => {
    const { appbar, feed, panes } = mountShell();
    const app = new App(fakeApi());
    app.mount(appbar, feed, panes, { kind: 'standalone', id: P1, base: '/' });

    expect(appbar.querySelector('.brand')).toBeTruthy();
    expect(appbar.querySelector('.theme-btn')).toBeTruthy();
    const wayIn = appbar.querySelector('[aria-label="add this thread to your workspace"]');
    expect(wayIn).toBeTruthy();
    expect(wayIn?.textContent).toBe('add to workspace');
    expect(appbar.querySelectorAll('.ctl').length).toBe(0);
    // No workspace-window controls: WEB_INTERFACE → The standalone thread —
    // creating, importing, exporting and forgetting an identity are the
    // workspace's; there is no profile, no wallet, no settings here.
    expect(appbar.querySelector('[aria-label="open profile"]')).toBeNull();
    expect(appbar.querySelector('[aria-label="open wallet"]')).toBeNull();
    expect(appbar.querySelector('[aria-label="open settings"]')).toBeNull();
  });

  it('the way-in is theme-btn at wide width and btn-ghost at one column', () => {
    // Wide (default happy-dom 1024px): inverse fill (theme-btn).
    const wide = mountShell();
    const appWide = new App(fakeApi());
    appWide.mount(wide.appbar, wide.feed, wide.panes, { kind: 'standalone', id: P1, base: '/' });
    const wayInWide = wide.appbar.querySelector('[aria-label="add this thread to your workspace"]')!;
    expect(wayInWide.classList.contains('theme-btn')).toBe(true);
    expect(wayInWide.classList.contains('btn-ghost')).toBe(false);

    // Narrow: mock matchMedia so oneColumn is true.
    const orig = window.matchMedia.bind(window);
    window.matchMedia = ((q: string) => {
      const mql = orig(q);
      if (q.includes('max-width')) {
        Object.defineProperty(mql, 'matches', { value: true, configurable: true });
      }
      return mql;
    }) as typeof window.matchMedia;
    try {
      const narrow = mountShell();
      const appNarrow = new App(fakeApi());
      appNarrow.mount(narrow.appbar, narrow.feed, narrow.panes, { kind: 'standalone', id: P1, base: '/' });
      const wayInNarrow = narrow.appbar.querySelector('[aria-label="add this thread to your workspace"]')!;
      expect(wayInNarrow.classList.contains('btn-ghost')).toBe(true);
      expect(wayInNarrow.classList.contains('theme-btn')).toBe(false);
    } finally {
      window.matchMedia = orig as typeof window.matchMedia;
    }
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

  it('document.title reads @Name · Notis when the root row carries a name', async () => {
    const named = post(P1, 'named root');
    named.authorName = 'Alice';
    const namedApi: Api & { feedCalls: number } = {
      ...fakeApi(),
      thread: async () => ({
        post: named, ancestors: [], ancestorCount: 0,
        descendants: [], descendantCount: 0,
        next: null, pending: [], pendingCount: 0,
      }),
    };
    const { appbar, feed, panes } = mountShell();
    const app = new App(namedApi);
    app.start(appbar, feed, panes, { kind: 'standalone', id: P1, base: '/' });
    await flush();
    await flush();

    expect(document.title).toBe('@Alice · Notis');
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

    expect(localStorage.getItem(KEY_LAYOUT)).toBe('#' + P2);

    tabs.setHolding(true);
    await flush();
    await flush();

    const stored = localStorage.getItem(KEY_LAYOUT);
    expect(stored).toContain(P2);
    expect(stored).toContain(P1);
  });

  it('add to workspace switches a standalone tab in place: the header carries the .hdr-workspace class after the switch', async () => {
    // One header element serves both bars; the class is set on the workspace
    // render and cleared on the standalone one (WEB_INTERFACE → The workspace,
    // → The standalone thread). At boot the standalone bar carries no class;
    // after wayIn switches in place, the workspace render sets it.
    const { appbar, feed, panes } = mountShell();
    const { fakeTabs } = await import('./fake-tabs');
    const tabs = fakeTabs();
    tabs.setHeldElsewhere(false);
    const app = new App(fakeApi(), undefined, undefined, undefined, tabs);
    const drive = app as unknown as {
      start(a: HTMLElement, b: HTMLElement, c: HTMLElement, m: { kind: 'standalone'; id: string; base: string }): void;
      wayIn(): Promise<void>;
    };
    drive.start(appbar, feed, panes, { kind: 'standalone', id: P1, base: '/' });
    await flush();
    expect(appbar.classList.contains('hdr-workspace')).toBe(false);

    await drive.wayIn();
    await flush();
    expect(appbar.classList.contains('hdr-workspace')).toBe(true);
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

describe('the way in — the extension offer', () => {
  it('offer taken: the report reads, no announce, no heldElsewhere, no switch in place', async () => {
    const { appbar, feed, panes } = mountShell();
    const { fakeTabs } = await import('./fake-tabs');
    const tabs = fakeTabs();
    tabs.setOffer(true);
    const app = new App(fakeApi(), undefined, undefined, undefined, tabs);
    app.start(appbar, feed, panes, { kind: 'standalone', id: P1, base: '/' });
    await flush();
    await flush();
    const urlBefore = location.pathname;

    const button = appbar.querySelector('[aria-label="add this thread to your workspace"]') as HTMLButtonElement;
    const origClose = window.close.bind(window);
    let closes = 0;
    window.close = () => { closes += 1; };
    try {
      button.click();
    } finally {
      window.close = origClose;
    }

    expect(tabs.offered).toEqual([P1]);
    expect(tabs.calls).toEqual(['offer']);
    expect(tabs.announced).toEqual([]);
    const report = panes.querySelector('.report');
    expect(report?.textContent).toContain('added to your workspace');
    // The page did not switch in place: the workspace stays standalone and the URL is unchanged.
    expect(panes.closest('.workspace')?.classList.contains('standalone')).toBe(true);
    expect(location.pathname).toBe(urlBefore);
    // history.length is 1 in this fresh mount, so close was called.
    if (history.length === 1) expect(closes).toBe(1);
  });

  it('offer taken with history.length > 1: window.close is not called', async () => {
    const { appbar, feed, panes } = mountShell();
    const { fakeTabs } = await import('./fake-tabs');
    const tabs = fakeTabs();
    tabs.setOffer(true);
    const app = new App(fakeApi(), undefined, undefined, undefined, tabs);
    app.start(appbar, feed, panes, { kind: 'standalone', id: P1, base: '/' });
    await flush();
    await flush();
    // Push a second entry so history.length is at least 2 at the click.
    history.pushState({ id: P1 }, '', location.href);
    expect(history.length).toBeGreaterThan(1);

    const button = appbar.querySelector('[aria-label="add this thread to your workspace"]') as HTMLButtonElement;
    const origClose = window.close.bind(window);
    let closes = 0;
    window.close = () => { closes += 1; };
    try {
      button.click();
    } finally {
      window.close = origClose;
    }

    expect(tabs.offered).toEqual([P1]);
    expect(closes).toBe(0);
    // Report still stands.
    const report = panes.querySelector('.report');
    expect(report?.textContent).toContain('added to your workspace');
  });

  it('the offer runs inside the press — synchronously, before heldElsewhere', async () => {
    const { appbar, feed, panes } = mountShell();
    const { fakeTabs } = await import('./fake-tabs');
    const tabs = fakeTabs();
    tabs.setOffer(false);
    tabs.setHeldElsewhere(true);
    const app = new App(fakeApi(), undefined, undefined, undefined, tabs);
    app.start(appbar, feed, panes, { kind: 'standalone', id: P1, base: '/' });
    await flush();
    await flush();

    const button = appbar.querySelector('[aria-label="add this thread to your workspace"]') as HTMLButtonElement;
    const origClose = window.close.bind(window);
    window.close = () => {};
    try {
      button.click();
      // Synchronously after the press, before any await in the test: the fake
      // has already recorded the offer with the id.
      expect(tabs.offered).toEqual([P1]);
      // The offer is recorded before heldElsewhere.
      const iOffer = tabs.calls.indexOf('offer');
      const iHeld = tabs.calls.indexOf('heldElsewhere');
      expect(iOffer).toBeGreaterThanOrEqual(0);
      if (iHeld !== -1) expect(iOffer).toBeLessThan(iHeld);
    } finally {
      window.close = origClose;
    }
    await flush();
    await flush();
  });

  it('the offered id is the current root — after a strip re-root, the new root', async () => {
    const { appbar, feed, panes } = mountShell();
    const { fakeTabs } = await import('./fake-tabs');
    const tabs = fakeTabs();
    tabs.setOffer(false);
    const app = new App(fakeApi(), undefined, undefined, undefined, tabs);
    const drive = app as unknown as {
      start(a: HTMLElement, b: HTMLElement, c: HTMLElement, m: { kind: 'standalone'; id: string; base: string }): void;
      openThread(id: string, origin: { from: 'pane'; ci: number }): void;
    };
    drive.start(appbar, feed, panes, { kind: 'standalone', id: P1, base: '/' });
    await flush();
    await flush();

    drive.openThread(R1, { from: 'pane', ci: 0 });
    await flush();

    const button = appbar.querySelector('[aria-label="add this thread to your workspace"]') as HTMLButtonElement;
    const origClose = window.close.bind(window);
    window.close = () => {};
    try {
      button.click();
    } finally {
      window.close = origClose;
    }

    expect(tabs.offered).toEqual([R1]);
  });

  it('with no Tabs injected: nothing is offered and the press switches in place', async () => {
    const { appbar, feed, panes } = mountShell();
    const app = new App(fakeApi());
    app.start(appbar, feed, panes, { kind: 'standalone', id: P1, base: '/' });
    await flush();
    await flush();

    const button = appbar.querySelector('[aria-label="add this thread to your workspace"]') as HTMLButtonElement;
    button.click();
    await flush();
    await flush();

    // No tabs to observe; the switch in place is asserted by the workspace class dropping.
    expect(panes.closest('.workspace')?.classList.contains('standalone')).toBe(false);
    expect(appbar.classList.contains('hdr-workspace')).toBe(true);
  });

  it('real DOM — a document listener stands in for the bridge, cancels notis:open with the id, the press hands over', async () => {
    const { appbar, feed, panes } = mountShell();
    // The real createTabs — no fake, so the offer path goes through the real
    // document.dispatchEvent and the bridge stand-in listens for it.
    const { createTabs } = await import('../src/tabs');
    const tabs = createTabs();
    const app = new App(fakeApi(), undefined, undefined, undefined, tabs);
    app.start(appbar, feed, panes, { kind: 'standalone', id: P1, base: '/' });
    await flush();
    await flush();

    const details: unknown[] = [];
    const bridge = (e: Event): void => {
      const ce = e as CustomEvent<unknown>;
      details.push(ce.detail);
      e.preventDefault();
    };
    document.addEventListener('notis:open', bridge);

    const button = appbar.querySelector('[aria-label="add this thread to your workspace"]') as HTMLButtonElement;
    const origClose = window.close.bind(window);
    window.close = () => {};
    try {
      button.click();
    } finally {
      window.close = origClose;
      document.removeEventListener('notis:open', bridge);
    }

    expect(details).toEqual([P1]);
    // The handover ran — the bar's report reads and the workspace stays standalone.
    const report = panes.querySelector('.report');
    expect(report?.textContent).toContain('added to your workspace');
    expect(panes.closest('.workspace')?.classList.contains('standalone')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WEB_INTERFACE → The standalone thread → "A card's author prefix is display on
// this page, not a control": the same text, face and clay as the control's;
// the page holds one window and opens no other. After the way into the
// workspace the prefix is the control (→ The identity display).
// ---------------------------------------------------------------------------

describe('a card\'s author prefix on the standalone page', () => {
  const OTHER = 'ee'.repeat(32);
  const BOB = 'bb'.repeat(32);
  const CAT = 'cc'.repeat(32);
  const DAVE = 'dd'.repeat(32);
  const row = (label: string, over: Partial<PostJson>): PostJson =>
    fullRow(label, { content: 'says ' + label, contentHash: contentHashHex('says ' + label), ...over });
  const Q = row('Q', { author: OTHER });
  const R_BOB = row('rb', { author: BOB, authorName: 'Bob', parentRefs: [Q.id] });
  const R_CAT = row('rc', { author: CAT, parentRefs: [Q.id] });
  const R_MINE = row('rm', { author: ME, parentRefs: [Q.id] });
  const R_GONE = { ...tomb('rw'), author: DAVE, authorName: 'Dave', parentRefs: [Q.id] }; // withdrawn by its author
  const thread = (): ThreadResult => ({
    post: { ...Q, descendantCount: 4 }, ancestors: [], ancestorCount: 0,
    descendants: [R_BOB, R_CAT, R_MINE, R_GONE], descendantCount: 4,
    next: null, pending: [], pendingCount: 0,
  });
  const cardOf = (root: ParentNode, id: string): HTMLElement =>
    root.querySelector<HTMLElement>(`.card[data-post-id="${id}"]`)!;
  /** The node a card's who row leads with — the author's handle or prefix. */
  const prefixOf = (card: HTMLElement): HTMLElement => card.querySelector<HTMLElement>('.who')!.firstElementChild as HTMLElement;
  const word = (root: ParentNode, text: string): HTMLButtonElement =>
    [...root.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement;

  /** The page booted on Q's thread with an identity loaded and unlocked: Bob's
   *  reply under his name, Cat's under her key, the reader's own, and one Dave
   *  withdrew. */
  async function bootOnQ(): Promise<Harness & { posts: string[] }> {
    document.body.innerHTML = '';
    localStorage.clear();
    history.replaceState(null, '', '/p/' + Q.id);
    const id = lockableIdentity(ME, false);
    const writes = recordingWrites(id);
    const h = harness({
      identityKey: ME, identity: id.identity, writeClient: writes.client, karma: karmaWithBox(ME),
      threadResults: [thread()],
      mode: { kind: 'standalone', id: Q.id, base: '/' }, boot: 'start',
    });
    h.fake.threadById!.set(Q.id, thread());
    h.fake.postById!.set(Q.id, { ...Q, confirmedAuthor: Q.author }); // the read a reply's flow makes of its parent
    await settle();
    return { ...h, posts: writes.posts };
  }

  /** A reply typed under Q and posted: the reader's own card, not in a block yet. */
  async function replyUnderQ(h: Harness): Promise<HTMLElement> {
    cardOf(h.panes, Q.id).querySelector<HTMLButtonElement>('.reply-ctl')!.click();
    await settle();
    const composer = h.panes.querySelector<HTMLElement>('.composer')!;
    const text = composer.querySelector<HTMLTextAreaElement>('textarea.composer-text')!;
    text.value = 'my pending reply';
    text.dispatchEvent(new Event('input'));
    word(composer, 'post').click();
    await settle();
    return [...h.panes.querySelectorAll<HTMLElement>('.card')].find((c) => c.textContent!.includes('my pending reply'))!;
  }

  it('a thread with replies by a named author, an unnamed one and the reader, a withdrawn reply, and the reader\'s own pending reply: no author control stands on the page, each who row leads with a span reading the handle or the 16-glyph prefix, · you on the reader\'s own, and a click on it opens nothing', async () => {
    const h = await bootOnQ();
    const pending = await replyUnderQ(h);
    expect(h.posts).toEqual(['my pending reply']);
    expect(pending.textContent).toContain('submitted');

    const cards = [...h.panes.querySelectorAll<HTMLElement>('.card')];
    expect(cards).toHaveLength(6);
    expect([...document.querySelectorAll('.authorbtn')].map((b) => b.textContent)).toEqual([]);
    expect(document.querySelector('[aria-label="open this author"]')).toBeNull();
    const read = (card: HTMLElement): [string, string, string | null, boolean] => {
      const p = prefixOf(card);
      return [p.tagName, p.className, p.textContent, card.querySelector('.who .you') !== null];
    };
    expect(read(cardOf(h.panes, Q.id))).toEqual(['SPAN', 'hex', OTHER.slice(0, 16) + '…', false]);
    expect(read(cardOf(h.panes, R_BOB.id))).toEqual(['SPAN', 'handle', '@Bob', false]);
    expect(read(cardOf(h.panes, R_CAT.id))).toEqual(['SPAN', 'hex', CAT.slice(0, 16) + '…', false]);
    expect(read(cardOf(h.panes, R_MINE.id))).toEqual(['SPAN', 'hex', ME.slice(0, 16) + '…', true]);
    expect(read(cardOf(h.panes, R_GONE.id))).toEqual(['SPAN', 'handle', '@Dave', false]);
    expect(read(pending)).toEqual(['SPAN', 'hex', ME.slice(0, 16) + '…', true]);

    for (const id of [Q.id, R_BOB.id, R_CAT.id, R_MINE.id, R_GONE.id]) prefixOf(cardOf(h.panes, id)).click();
    prefixOf(pending).click();
    await settle();
    expect(h.panes.querySelectorAll('.col')).toHaveLength(1);
    expect(h.panes.querySelectorAll('.bar')).toHaveLength(1);
    expect(h.drive.state.workspace.columns.map((c) => c.wins)).toEqual([[Q.id]]);
    expect(localStorage.getItem(KEY_LAYOUT)).toBeNull();
  });

  it('add to workspace pressed: the same cards\' prefixes are the control again, and a press opens that author\'s window in the column beside the thread', async () => {
    const h = await bootOnQ();
    expect(document.querySelectorAll('.authorbtn')).toHaveLength(0);

    document.querySelector<HTMLButtonElement>('[aria-label="add this thread to your workspace"]')!.click();
    await settle();
    const bob = prefixOf(cardOf(h.panes, R_BOB.id));
    expect([bob.tagName, bob.className, bob.textContent, bob.getAttribute('aria-label')])
      .toEqual(['BUTTON', 'handle authorbtn', '@Bob', 'open this author']);
    const cat = prefixOf(cardOf(h.panes, R_CAT.id));
    expect([cat.tagName, cat.className, cat.textContent]).toEqual(['BUTTON', 'hex authorbtn', CAT.slice(0, 16) + '…']);
    expect(prefixOf(cardOf(h.panes, Q.id)).tagName).toBe('BUTTON');
    const dave = prefixOf(cardOf(h.panes, R_GONE.id));
    expect([dave.tagName, dave.className, dave.textContent]).toEqual(['BUTTON', 'handle authorbtn', '@Dave']);

    bob.click();
    await settle();
    expect(h.drive.state.workspace.columns.map((c) => c.wins)).toEqual([[Q.id], ['@author:' + BOB]]);
    const regions = [...h.panes.querySelectorAll<HTMLElement>('.region')];
    expect(regions).toHaveLength(2);
    expect(regions[1]!.querySelector('.bar.focused .name')?.textContent).toBe('author');
    expect(regions[1]!.querySelector('.region-body > .winbody')).not.toBeNull();
  });
});
