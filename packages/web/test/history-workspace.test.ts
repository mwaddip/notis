// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App, ONE_COLUMN_MAX_PX } from '../src/app';
import type { Api } from '../src/api/client';
import type { FeedResult, ThreadResult, PostJson } from '../src/api/dto';
import { karmaResult } from './karma-fixture';
import { contentHashHex } from '../src/integrity';

const HEX = (c: string): string => c.repeat(64);
const P1 = HEX('a'), P2 = HEX('b'), R1 = HEX('1');

function post(id: string, content: string, parents: string[] = []): PostJson {
  return {
    id, content, contentHash: contentHashHex(content), author: HEX('7'), parentRefs: parents,
    protocolVersion: 1, type: 'regular', status: 'confirmed',
    blockHeight: 1, blockIndex: 0, blockCreatedAt: 0, likeCount: 0, descendantCount: 1, authorName: null, likedByViewer: null,
  };
}

function fakeApi(): Api {
  const feed: FeedResult = { posts: [post(P1, 'root one'), post(P2, 'root two')], next: null, pending: [], pendingCount: 0 };
  const thread = (root: string, reply: string): ThreadResult => ({
    post: post(root, 'root'), ancestors: [], ancestorCount: 0,
    descendants: [post(reply, 'a reply', [root])], descendantCount: 1,
    next: null, pending: [], pendingCount: 0,
  });
  return {
    feed: async () => feed,
    thread: async (id) => (id === P1 ? thread(P1, R1) : id === P2 ? thread(P2, HEX('2')) : null),
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
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Drive {
  loadFeed(): Promise<void>;
  openThread(id: string, origin: { from: 'feed' } | { from: 'pane'; ci: number }): void;
  closeWindow(id: string): void;
  state: { workspace: { columns: Array<{ wins: string[]; focus: number; uid: number }> } };
}

/** Simulate a browser traversal: set the entry and fire popstate. */
function simulatePop(entry: { member: string; prev: string | null; depth: number }): void {
  history.replaceState(entry, '', location.href);
  window.dispatchEvent(new PopStateEvent('popstate', { state: entry }));
}

function oneColumnMatchMedia(): typeof window.matchMedia {
  const orig = window.matchMedia;
  window.matchMedia = (q: string) => {
    if (q.includes(String(ONE_COLUMN_MAX_PX))) {
      return {
        matches: true, media: q, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {},
        dispatchEvent: () => true,
      } as unknown as MediaQueryList;
    }
    return orig.call(window, q);
  };
  return orig;
}

function mountShell(): { appbar: HTMLElement; feed: HTMLElement; panes: HTMLElement; workspace: HTMLElement } {
  document.body.innerHTML = '';
  const appbar = document.createElement('header');
  const workspace = document.createElement('div'); workspace.className = 'workspace';
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  workspace.append(feed, panes);
  document.body.append(appbar, workspace);
  return { appbar, feed, panes, workspace };
}

describe('screens as history at one column', () => {
  let scrolled: Element[];
  let origScrollIntoView: typeof Element.prototype.scrollIntoView;
  let origMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    scrolled = [];
    origScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function () { scrolled.push(this); };
    origMatchMedia = oneColumnMatchMedia();
    history.replaceState({ member: 'feed', prev: null, depth: 0 }, '', location.href);
    localStorage.clear();
  });
  afterEach(() => {
    Element.prototype.scrollIntoView = origScrollIntoView;
    window.matchMedia = origMatchMedia;
  });

  it('an open pushes an entry naming the window with prev=feed and depth 1', async () => {
    const { appbar, feed, panes } = mountShell();
    const app = new App(fakeApi());
    const drive = app as unknown as Drive;
    app.mount(appbar, feed, panes);
    await drive.loadFeed();
    await flush();

    const lenBefore = history.length;
    drive.openThread(P1, { from: 'feed' });
    await flush();

    expect(history.length).toBe(lenBefore + 1);
    expect(history.state).toEqual({ member: P1, prev: 'feed', depth: 1 });
  });

  it('a raise of the visible column pushes nothing', async () => {
    const { appbar, feed, panes } = mountShell();
    const app = new App(fakeApi());
    const drive = app as unknown as Drive;
    app.mount(appbar, feed, panes);
    await drive.loadFeed();
    await flush();

    drive.openThread(P1, { from: 'feed' });
    await flush();
    const lenAfterOpen = history.length;
    const stateAfterOpen = history.state;

    drive.openThread(P1, { from: 'feed' });
    await flush();

    expect(history.length).toBe(lenAfterOpen);
    expect(history.state).toEqual(stateAfterOpen);
  });

  it('‹ back to the feed calls history.back() and pushes nothing', async () => {
    const { appbar, feed, panes, workspace } = mountShell();
    const app = new App(fakeApi());
    const drive = app as unknown as Drive;
    app.mount(appbar, feed, panes);
    await drive.loadFeed();
    await flush();

    drive.openThread(P1, { from: 'feed' });
    await flush();
    const lenAfterOpen = history.length;

    // Simulate the view on the thread's column: feed off-screen, col0 at left edge
    const col0 = panes.querySelector('.col')!;
    feed.getBoundingClientRect = () => ({ left: -390, top: 0, right: 0, bottom: 0, width: 390, height: 0, x: -390, y: 0, toJSON: () => {} }) as DOMRect;
    col0.getBoundingClientRect = () => ({ left: 0, top: 0, right: 390, bottom: 0, width: 390, height: 0, x: 0, y: 0, toJSON: () => {} }) as DOMRect;
    workspace.getBoundingClientRect = () => ({ left: 0, top: 0, right: 390, bottom: 0, width: 390, height: 0, x: 0, y: 0, toJSON: () => {} }) as DOMRect;

    const backSpy = vi.spyOn(history, 'back');
    const leftBtn = appbar.querySelector('button.ctl') as HTMLButtonElement;
    leftBtn.click();

    expect(backSpy).toHaveBeenCalled();
    expect(history.length).toBe(lenAfterOpen);
    backSpy.mockRestore();
  });

  it('a driven popstate with { member } scrolls that window\'s column', async () => {
    const { appbar, feed, panes } = mountShell();
    const app = new App(fakeApi());
    const drive = app as unknown as Drive;
    app.mount(appbar, feed, panes);
    await drive.loadFeed();
    await flush();

    drive.openThread(P1, { from: 'feed' });
    await flush();
    scrolled.length = 0;

    window.dispatchEvent(new PopStateEvent('popstate', { state: { member: P1, prev: 'feed', depth: 1 } }));
    await flush();

    const col0 = panes.querySelector('.col');
    expect(scrolled).toContain(col0);
  });

  it('back onto a closed window steps back toward the feed', async () => {
    const { appbar, feed, panes } = mountShell();
    const app = new App(fakeApi());
    const drive = app as unknown as Drive;
    app.mount(appbar, feed, panes);
    await drive.loadFeed();
    await flush();

    drive.openThread(P1, { from: 'feed' });
    await flush();
    drive.openThread(P2, { from: 'pane', ci: 0 });
    await flush();
    drive.closeWindow(P1);
    await flush();

    const backSpy = vi.spyOn(history, 'back').mockImplementation(() => {});
    const fwdSpy = vi.spyOn(history, 'forward').mockImplementation(() => {});
    simulatePop({ member: P1, prev: 'feed', depth: 1 });

    expect(backSpy).toHaveBeenCalled();
    expect(fwdSpy).not.toHaveBeenCalled();
    backSpy.mockRestore();
    fwdSpy.mockRestore();
  });

  it('forward onto a closed window steps forward toward the next live entry', async () => {
    const { appbar, feed, panes } = mountShell();
    const app = new App(fakeApi());
    const drive = app as unknown as Drive;
    app.mount(appbar, feed, panes);
    await drive.loadFeed();
    await flush();

    drive.openThread(P1, { from: 'feed' });
    await flush();
    drive.openThread(P2, { from: 'pane', ci: 0 });
    await flush();
    drive.closeWindow(P1);
    await flush();

    const backSpy = vi.spyOn(history, 'back').mockImplementation(() => {});
    const fwdSpy = vi.spyOn(history, 'forward').mockImplementation(() => {});
    simulatePop({ member: P1, prev: 'feed', depth: 1 });
    backSpy.mockClear(); fwdSpy.mockClear();

    // Reset lastDepth to 0 to simulate forward traversal from the feed
    simulatePop({ member: 'feed', prev: null, depth: 0 });
    backSpy.mockClear(); fwdSpy.mockClear();
    simulatePop({ member: P1, prev: 'feed', depth: 1 });

    expect(fwdSpy).toHaveBeenCalled();
    expect(backSpy).not.toHaveBeenCalled();
    backSpy.mockRestore();
    fwdSpy.mockRestore();
  });

  it('at tiling an open pushes nothing', async () => {
    window.matchMedia = origMatchMedia;
    const { appbar, feed, panes } = mountShell();
    const app = new App(fakeApi());
    const drive = app as unknown as Drive;
    app.mount(appbar, feed, panes);
    await drive.loadFeed();
    await flush();

    const lenBefore = history.length;
    drive.openThread(P1, { from: 'feed' });
    await flush();

    expect(history.length).toBe(lenBefore);
  });
});

describe('the swipe — scrollend on the one-column scroller', () => {
  let scrolled: Element[];
  let origScrollIntoView: typeof Element.prototype.scrollIntoView;
  let origMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    scrolled = [];
    origScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function () { scrolled.push(this); };
    origMatchMedia = oneColumnMatchMedia();
    history.replaceState({ member: 'feed', prev: null, depth: 0 }, '', location.href);
    localStorage.clear();
  });
  afterEach(() => {
    Element.prototype.scrollIntoView = origScrollIntoView;
    window.matchMedia = origMatchMedia;
  });

  it('a scrollend landing on prev steps the history back', async () => {
    const { appbar, feed, panes, workspace } = mountShell();
    const app = new App(fakeApi());
    const drive = app as unknown as Drive;
    app.mount(appbar, feed, panes);
    await drive.loadFeed();
    await flush();

    drive.openThread(P1, { from: 'feed' });
    await flush();

    // Simulate the swipe landing on the feed (prev): feed at left edge, col off-screen
    const col0 = panes.querySelector('.col')!;
    feed.getBoundingClientRect = () => ({ left: 0, top: 0, right: 390, bottom: 0, width: 390, height: 0, x: 0, y: 0, toJSON: () => {} }) as DOMRect;
    col0.getBoundingClientRect = () => ({ left: 390, top: 0, right: 780, bottom: 0, width: 390, height: 0, x: 390, y: 0, toJSON: () => {} }) as DOMRect;
    workspace.getBoundingClientRect = () => ({ left: 0, top: 0, right: 390, bottom: 0, width: 390, height: 0, x: 0, y: 0, toJSON: () => {} }) as DOMRect;

    const backSpy = vi.spyOn(history, 'back');
    workspace.dispatchEvent(new Event('scrollend'));

    expect(backSpy).toHaveBeenCalled();
    backSpy.mockRestore();
  });

  it('backInFlight suppresses scrollend between closeWindow and popstate settle', async () => {
    const { appbar, feed, panes, workspace } = mountShell();
    const app = new App(fakeApi());
    const drive = app as unknown as Drive;
    app.mount(appbar, feed, panes);
    await drive.loadFeed();
    await flush();

    drive.openThread(P1, { from: 'feed' });
    await flush();
    drive.openThread(R1, { from: 'pane', ci: 0 });
    await flush();

    // State is { member: R1, prev: P1, depth: 2 }. Mock history.back() to
    // prevent happy-dom's synchronous popstate cascade; closeWindow →
    // moveView(P1) → decideMove → back → sets backInFlight, calls back().
    const backSpy = vi.spyOn(history, 'back').mockImplementation(() => {});
    drive.closeWindow(R1);
    await flush();
    expect(backSpy).toHaveBeenCalledTimes(1);

    // Simulate the DOM-change scrollend landing on the feed.
    // backInFlight is true — the listener skips it.
    feed.getBoundingClientRect = () => ({ left: 0, top: 0, right: 390, bottom: 0, width: 390, height: 0, x: 0, y: 0, toJSON: () => {} }) as DOMRect;
    workspace.getBoundingClientRect = () => ({ left: 0, top: 0, right: 390, bottom: 0, width: 390, height: 0, x: 0, y: 0, toJSON: () => {} }) as DOMRect;
    backSpy.mockClear();
    workspace.dispatchEvent(new Event('scrollend'));
    expect(backSpy).not.toHaveBeenCalled();

    // No popstate arrives (back is mocked), so backInFlight stays true
    // and a second scrollend is still suppressed.
    workspace.dispatchEvent(new Event('scrollend'));
    expect(backSpy).not.toHaveBeenCalled();
    backSpy.mockRestore();
  });

  it('a scrollend landing on neither current nor prev does nothing', async () => {
    const { appbar, feed, panes, workspace } = mountShell();
    const app = new App(fakeApi());
    const drive = app as unknown as Drive;
    app.mount(appbar, feed, panes);
    await drive.loadFeed();
    await flush();

    drive.openThread(P1, { from: 'feed' });
    await flush();
    drive.openThread(P2, { from: 'pane', ci: 0 });
    await flush();

    // Simulate a swipe landing on the feed (neither current P2 nor prev P1)
    const cols = panes.querySelectorAll('.col');
    feed.getBoundingClientRect = () => ({ left: 0, top: 0, right: 390, bottom: 0, width: 390, height: 0, x: 0, y: 0, toJSON: () => {} }) as DOMRect;
    cols[0]!.getBoundingClientRect = () => ({ left: 390, top: 0, right: 780, bottom: 0, width: 390, height: 0, x: 390, y: 0, toJSON: () => {} }) as DOMRect;
    cols[1]!.getBoundingClientRect = () => ({ left: 780, top: 0, right: 1170, bottom: 0, width: 390, height: 0, x: 780, y: 0, toJSON: () => {} }) as DOMRect;
    workspace.getBoundingClientRect = () => ({ left: 0, top: 0, right: 390, bottom: 0, width: 390, height: 0, x: 0, y: 0, toJSON: () => {} }) as DOMRect;

    const backSpy = vi.spyOn(history, 'back');
    const lenBefore = history.length;
    workspace.dispatchEvent(new Event('scrollend'));

    expect(backSpy).not.toHaveBeenCalled();
    expect(history.length).toBe(lenBefore);
    backSpy.mockRestore();
  });
});
