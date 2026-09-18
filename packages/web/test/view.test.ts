// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { App } from '../src/app';
import type { Api } from '../src/api/client';
import type { FeedResult, ThreadResult, PostJson } from '../src/api/dto';
import { karmaResult } from './karma-fixture';
import { contentHashHex } from '../src/integrity';

const appCss = readFileSync(resolve(process.cwd(), 'src/style/app.css'), 'utf8');

// happy-dom computes no layout, so a scroll offset is the rendered proof's to pin.
// What a unit test can pin is the App's own seam: after an open it calls
// scrollIntoView on the column holding the window (WEB_INTERFACE → The workspace).
const HEX = (c: string): string => c.repeat(64);
const P1 = HEX('a'), P2 = HEX('b'), R1 = HEX('1'), R2 = HEX('2');

function post(id: string, content: string, parents: string[] = [], name: string | null = null): PostJson {
  return {
    id, content, contentHash: contentHashHex(content), author: HEX('7'), parentRefs: parents,
    protocolVersion: 1, type: 'regular', status: 'confirmed',
    blockHeight: 1, blockIndex: 0, blockCreatedAt: 0, likeCount: 0, descendantCount: 1, authorName: name, likedByViewer: null,
  };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function fakeApi(): Api {
  const feed: FeedResult = { posts: [post(P1, 'root one'), post(P2, 'root two')], next: null, pending: [], pendingCount: 0 };
  const thread = (root: string, reply: string): ThreadResult => ({
    post: post(root, 'root'), ancestors: [], ancestorCount: 0,
    descendants: [post(reply, 'a reply', [root])], descendantCount: 1,
    next: null, pending: [], pendingCount: 0,
  });
  return {
    feed: async () => feed,
    thread: async (id) => (id === P1 ? thread(P1, R1) : id === P2 ? thread(P2, R2) : null),
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

function mountApp(): { app: App; appbar: HTMLElement; panes: HTMLElement } {
  document.body.innerHTML = '';
  const appbar = document.createElement('header');
  const workspace = document.createElement('div'); workspace.className = 'workspace';
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  workspace.append(feed, panes);
  document.body.append(appbar, workspace);
  const app = new App(fakeApi());
  app.mount(appbar, feed, panes);
  return { app, appbar, panes };
}

interface Drive {
  loadFeed(): Promise<void>;
  openThread(id: string, origin: { from: 'feed' } | { from: 'pane'; ci: number }): void;
}

describe('the view moves to the column the reader acted on', () => {
  let scrolled: Element[];
  let orig: typeof Element.prototype.scrollIntoView;
  beforeEach(() => {
    scrolled = [];
    orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
  });
  afterEach(() => { Element.prototype.scrollIntoView = orig; });

  it('scrolls the column holding the window into view after an open from the feed and from a pane', async () => {
    const { app, panes } = mountApp();
    const drive = app as unknown as Drive;
    await drive.loadFeed();
    await flush();

    // An open from the feed lands in column 0; the view scrolls to that column.
    drive.openThread(P1, { from: 'feed' });
    await flush();
    const col0 = panes.querySelectorAll<HTMLElement>('.col')[0]!;
    expect(scrolled[scrolled.length - 1]).toBe(col0);

    // An open from a pane lands in the column immediately right; the view follows.
    drive.openThread(P2, { from: 'pane', ci: 0 });
    await flush();
    const cols = panes.querySelectorAll<HTMLElement>('.col');
    expect(cols.length).toBe(2);
    expect(scrolled[scrolled.length - 1]).toBe(cols[1]);
    // The scrolled column is the one framing the opened window's region.
    expect(cols[1]!.querySelector('.region')).toBeTruthy();
  });
});

describe('the header carries the arrows at every width', () => {
  it('a left and a right arrow, each a .ctl, with their labels and glyphs', () => {
    const { appbar } = mountApp();
    const arrows = appbar.querySelectorAll<HTMLElement>('.ctl');
    expect(arrows.length).toBe(2);
    // Tiling by node identity (matchMedia matches is false), so ‹ reads the tiling
    // label; › is always the same.
    expect(arrows[0]!.textContent).toBe('‹');
    expect(arrows[0]!.getAttribute('aria-label')).toMatch(/show the (feed|column to the left)/);
    expect(arrows[1]!.textContent).toBe('›');
    expect(arrows[1]!.getAttribute('aria-label')).toBe('show the column to the right');
  });
});

describe('the bar carries the handle where the root row carries a name', () => {
  it('the thread bar shows @Name when the root has authorName, else the hex prefix', async () => {
    const namedPost = post(P1, 'named root', [], 'Alice');
    const unnamedPost = post(P2, 'unnamed root');
    const namedFeed: FeedResult = { posts: [namedPost, unnamedPost], next: null, pending: [], pendingCount: 0 };
    const namedThread: ThreadResult = {
      post: namedPost, ancestors: [], ancestorCount: 0,
      descendants: [], descendantCount: 0,
      next: null, pending: [], pendingCount: 0,
    };
    const unnamedThread: ThreadResult = {
      post: unnamedPost, ancestors: [], ancestorCount: 0,
      descendants: [], descendantCount: 0,
      next: null, pending: [], pendingCount: 0,
    };
    const api: Api = {
      ...fakeApi(),
      feed: async () => namedFeed,
      thread: async (id) => (id === P1 ? namedThread : id === P2 ? unnamedThread : null),
    };
    document.body.innerHTML = '';
    const appbar = document.createElement('header');
    const workspace = document.createElement('div'); workspace.className = 'workspace';
    const feed = document.createElement('section'); feed.id = 'feed';
    const panes = document.createElement('section'); panes.id = 'panes';
    workspace.append(feed, panes);
    document.body.append(appbar, workspace);
    const app = new App(api);
    app.mount(appbar, feed, panes);
    const drive = app as unknown as { loadFeed(): Promise<void>; openThread(id: string, origin: { from: 'feed' }): void };
    await drive.loadFeed();
    await flush();
    drive.openThread(P1, { from: 'feed' });
    await flush();
    const bar1 = panes.querySelector('.bar .bar-label .handle');
    expect(bar1).not.toBeNull();
    expect(bar1!.textContent).toBe('@Alice');

    drive.openThread(P2, { from: 'pane', ci: 0 } as any);
    await flush();
    const bars = panes.querySelectorAll('.bar');
    const bar2Label = bars[bars.length - 1]!.querySelector('.bar-label');
    expect(bar2Label!.querySelector('.handle')).toBeNull();
    expect(bar2Label!.querySelector('.hex')).not.toBeNull();
  });
});

interface WidthDrive { onWidthClassChange(matches: boolean): void; }

describe('the header at one column', () => {
  it('the profile, wallet and settings controls are SVG glyph buttons; no theme control, no .theme-btn', () => {
    const { app, appbar } = mountApp();
    (app as unknown as WidthDrive).onWidthClassChange(true); // cross the breakpoint

    // No word buttons at one column — the workspace controls are glyphs, and
    // no theme control renders here (WEB_INTERFACE → The workspace →
    // "What differs at one column, and nothing else does"; → The settings
    // window: the theme is the settings window's first row).
    expect(appbar.querySelectorAll('.theme-btn').length).toBe(0);
    expect(appbar.querySelector('button[aria-label^="switch to "]')).toBeNull();

    // The profile control is a person glyph, the wallet control a wallet, the
    // settings control a gear; each a .hdr-glyph button holding one svg, with
    // the label the word carries. happy-dom keeps createElementNS svgs
    // queryable (test/mark.test.ts).
    const profile = appbar.querySelector<HTMLElement>('button[aria-label="open profile"]')!;
    const wallet = appbar.querySelector<HTMLElement>('button[aria-label="open wallet"]')!;
    const settings = appbar.querySelector<HTMLElement>('button[aria-label="open settings"]')!;
    expect(profile.classList.contains('hdr-glyph')).toBe(true);
    expect(wallet.classList.contains('hdr-glyph')).toBe(true);
    expect(settings.classList.contains('hdr-glyph')).toBe(true);
    expect(profile.querySelectorAll('svg').length).toBe(1);
    expect(wallet.querySelectorAll('svg').length).toBe(1);
    expect(settings.querySelectorAll('svg').length).toBe(1);
    // The three glyphs are the only header controls between the arrows.
    expect(appbar.querySelectorAll('.hdr-glyph').length).toBe(3);

    // An empty workspace has nothing either way, so both arrows carry `none`
    // (the stylesheet makes it absent at one column, space-reserved at tiling).
    const arrows = appbar.querySelectorAll<HTMLElement>('.ctl');
    expect(arrows.length).toBe(2);
    for (const a of arrows) expect(a.classList.contains('none')).toBe(true);
  });

  it('the tiling header carries three .hdr-word controls — profile, wallet, settings — beside the theme word', () => {
    const { appbar } = mountApp();
    // Default happy-dom is wide (1024) so oneColumn is false; the three word
    // controls stand together beside the filled theme word.
    const words = [...appbar.querySelectorAll<HTMLElement>('.hdr-word')];
    expect(words.length).toBe(3);
    const labels = words.map((w) => w.getAttribute('aria-label'));
    expect(labels).toEqual(['open profile', 'open wallet', 'open settings']);
    // The wallet word reads `wallet` and its class is .hdr-word (WEB_INTERFACE
    // → The profile window → "Three header controls open the three windows — profile, wallet, settings — at the right of the app bar, the theme toggle after them at tiling").
    expect(words[1]!.textContent).toBe('wallet');
    // The filled theme word stands after them.
    expect(appbar.querySelectorAll<HTMLElement>('.theme-btn').length).toBe(1);
  });

  it('the workspace bar carries a .hdr-workspace class the standalone bar does not', () => {
    // One header element serves both bars, so the class is set by the
    // workspace render and cleared by the standalone one (WEB_INTERFACE → The
    // workspace → "What differs at one column, and nothing else does",
    // → The standalone thread → "The header"). The under-372px stylesheet
    // rule keys on this class to hide the workspace wordmark alone.
    const { appbar } = mountApp();
    expect(appbar.classList.contains('hdr-workspace')).toBe(true);

    document.body.innerHTML = '';
    const ab = document.createElement('header');
    const ws = document.createElement('div'); ws.className = 'workspace';
    const feed = document.createElement('section'); feed.id = 'feed';
    const panes = document.createElement('section'); panes.id = 'panes';
    ws.append(feed, panes);
    document.body.append(ab, ws);
    const app = new App(fakeApi());
    const P = 'a'.repeat(64);
    app.mount(ab, feed, panes, { kind: 'standalone', id: P, base: '/' });
    expect(ab.classList.contains('hdr-workspace')).toBe(false);
  });

  it('with the class on the header, getComputedStyle reads the header rule — flex-grow 0 and gap 16px, not the .workspace scroller\'s grow and 24px gap', () => {
    // A class named `.workspace` on the header would inherit the strip
    // scroller's rules — flex 1 1 auto (grow), gap 24px, and at one column
    // overflow-x auto with scroll-snap-type. The hazard fires here as a
    // rendered-style read (card.test.ts's pattern): with the CSS injected and
    // the class on the header, the header's own type rule stays in force. The
    // header rule's padding shorthand uses max() and var(--gutter), which
    // happy-dom does not resolve — flex-grow and gap are literal values it
    // does read.
    const style = document.createElement('style');
    style.textContent = appCss;
    document.head.appendChild(style);
    try {
      const { appbar } = mountApp();
      expect(appbar.classList.contains('hdr-workspace')).toBe(true);
      const s = window.getComputedStyle(appbar);
      expect(s.flexGrow).toBe('0');
      expect(s.gap).toBe('16px');
    } finally {
      document.head.removeChild(style);
    }
  });
});
