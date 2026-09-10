// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { App } from '../src/app';
import type { Api } from '../src/api/client';
import type { FeedResult, ThreadResult, PostJson } from '../src/api/dto';
import { karmaResult } from './karma-fixture';
import { contentHashHex } from '../src/integrity';

// happy-dom computes no layout, so a scroll offset is the rendered proof's to pin.
// What a unit test can pin is the App's own seam: after an open it calls
// scrollIntoView on the column holding the window (WEB_INTERFACE → The workspace).
const HEX = (c: string): string => c.repeat(64);
const P1 = HEX('a'), P2 = HEX('b'), R1 = HEX('1'), R2 = HEX('2');

function post(id: string, content: string, parents: string[] = []): PostJson {
  return {
    id, content, contentHash: contentHashHex(content), author: HEX('7'), parentRefs: parents,
    protocolVersion: 1, type: 'regular', status: 'confirmed',
    blockHeight: 1, blockIndex: 0, blockCreatedAt: 0, likeCount: 0, descendantCount: 1, authorName: null, likedByViewer: null,
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

interface WidthDrive { onWidthClassChange(matches: boolean): void; }

describe('the header at one column', () => {
  it('the two controls are SVG glyph buttons with the labels, no .theme-btn, the arrows carry none', () => {
    const { app, appbar } = mountApp();
    (app as unknown as WidthDrive).onWidthClassChange(true); // cross the breakpoint

    // No word buttons at one column — the two controls are glyphs
    // (WEB_INTERFACE → The workspace → "What differs at one column, and nothing else does").
    expect(appbar.querySelectorAll('.theme-btn').length).toBe(0);

    // The profile control is a person glyph, the theme control the moon (Sand) or
    // the sun (Bistre); each a .hdr-glyph button holding one svg, with the label the
    // word carries. happy-dom keeps createElementNS svgs queryable (test/mark.test.ts).
    const profile = appbar.querySelector<HTMLElement>('button[aria-label="open profile"]')!;
    const theme = appbar.querySelector<HTMLElement>('button[aria-label^="switch to "]')!;
    expect(profile.classList.contains('hdr-glyph')).toBe(true);
    expect(theme.classList.contains('hdr-glyph')).toBe(true);
    expect(profile.querySelectorAll('svg').length).toBe(1);
    expect(theme.querySelectorAll('svg').length).toBe(1);

    // An empty workspace has nothing either way, so both arrows carry `none`
    // (the stylesheet makes it absent at one column, space-reserved at tiling).
    const arrows = appbar.querySelectorAll<HTMLElement>('.ctl');
    expect(arrows.length).toBe(2);
    for (const a of arrows) expect(a.classList.contains('none')).toBe(true);
  });
});
