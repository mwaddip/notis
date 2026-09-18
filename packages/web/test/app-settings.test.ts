// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { App } from '../src/app';
import type { Api } from '../src/api/client';
import type {
  FeedResult, BlockCurrent, KarmaResult, StatusResult,
} from '../src/api/dto';
import { KEY_LAYOUT, prefs, setTheme } from '../src/prefs';
import { karmaResult } from './karma-fixture';

// The @settings window driven from the App — the header control opens it, its
// bar reads `settings` with a disabled ↻, its body holds the theme row, a raise
// is not a duplicate, a theme press flips both the header word and the row's
// word, and the arrangement persists. Companion to app-identity.test.ts, whose
// pattern this borrows (WEB_INTERFACE → The settings window).

function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 1, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}

function fakeApi(): Api {
  const feed: FeedResult = { posts: [], next: null, pending: [], pendingCount: 0 };
  return {
    feed: async () => feed,
    thread: async () => null,
    post: async () => null,
    status: async () => statusResult(),
    currentBlock: async (): Promise<BlockCurrent> => ({ height: 1, hash: null }),
    karma: async (key): Promise<KarmaResult> => karmaResult({ userId: key }),
    vouchesByTarget: async () => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async () => ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async () => ({ cooldowns: [], count: 0, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async () => null,
    credits: async () => ({ userId: '', total: '0', boxes: [], boxCount: 0, next: null }),
    usernameByName: async () => null,
  };
}

function mount(): { app: App; appbar: HTMLElement; feed: HTMLElement; panes: HTMLElement } {
  document.body.innerHTML = '';
  const appbar = document.createElement('header');
  const workspace = document.createElement('div'); workspace.className = 'workspace';
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  workspace.append(feed, panes);
  document.body.append(appbar, workspace);
  const app = new App(fakeApi());
  app.mount(appbar, feed, panes);
  return { app, appbar, feed, panes };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  prefs.faucet = '';
  setTheme('light'); // the header word reads the target (dark) at rest
});

describe('the App settings control', () => {
  it('a press on open settings mounts a window whose bar reads settings, ↻ disabled, and whose body holds the theme row', async () => {
    const { appbar, panes } = mount();
    const control = appbar.querySelector<HTMLElement>('button[aria-label="open settings"]')!;
    expect(control).not.toBeNull();
    control.click();
    await flush();

    const bar = panes.querySelector('.bar');
    expect(bar).not.toBeNull();
    // The bar's label reads 'settings' — the panes arm's own text.
    expect(bar!.querySelector('.bar-label .name')?.textContent).toBe('settings');
    // The ↻ renders disabled — nothing to re-read on the settings window
    // (WEB_INTERFACE → The workspace, → The settings window).
    const refresh = [...bar!.querySelectorAll<HTMLButtonElement>('.ctl')].find((c) => c.textContent === '↻')!;
    expect(refresh.disabled).toBe(true);
    // The body carries the theme row — a live App drove the panes arm through
    // settingsBody (WEB_INTERFACE → The settings window).
    const rows = [...panes.querySelectorAll('.winbody .row')];
    const themeRow = rows.find((r) => r.querySelector('label')?.textContent === 'theme');
    expect(themeRow).toBeDefined();
  });

  it('a second press raises the open window and never duplicates it', async () => {
    const { appbar, panes } = mount();
    const control = appbar.querySelector<HTMLElement>('button[aria-label="open settings"]')!;
    control.click();
    await flush();
    control.click();
    await flush();

    const bars = panes.querySelectorAll('.bars .bar');
    // A raise brings the existing window forward — one bar, not two.
    expect(bars.length).toBe(1);
    // notis.layout carries exactly one @settings, so the raise wrote no duplicate.
    const stored = localStorage.getItem(KEY_LAYOUT) ?? '';
    expect(stored.match(/@settings/g)?.length ?? 0).toBe(1);
  });

  it('a press on the row\'s theme word flips both the header word and the row', async () => {
    const { appbar, panes } = mount();
    const control = appbar.querySelector<HTMLElement>('button[aria-label="open settings"]')!;
    // At tiling with light theme the header carries the filled 'dark' theme word.
    const headerTheme = (): HTMLElement | null => appbar.querySelector<HTMLElement>('button.theme-btn');
    expect(headerTheme()?.textContent).toBe('dark');
    control.click();
    await flush();
    const themeRow = [...panes.querySelectorAll('.winbody .row')]
      .find((r) => r.querySelector('label')?.textContent === 'theme')!;
    const rowBtn = themeRow.querySelector<HTMLButtonElement>('button.theme-btn')!;
    expect(rowBtn.textContent).toBe('dark');
    rowBtn.click();
    await flush();
    // Both the header's word and the row's word now name the new target (light).
    expect(headerTheme()?.textContent).toBe('light');
    const rowAfter = [...panes.querySelectorAll('.winbody .row')]
      .find((r) => r.querySelector('label')?.textContent === 'theme')!;
    expect(rowAfter.querySelector<HTMLButtonElement>('button.theme-btn')?.textContent).toBe('light');
  });

  // WEB_INTERFACE → The settings window → "The identity tint shows what it
  // sets": the press moves the four words' pressed state in place and rebuilds
  // nothing, so the same nodes stand before and after, the pressed word keeps
  // the keyboard's focus, and :root carries the new data-idtint.
  it('a tint press rebuilds nothing: same nodes, focus preserved, :root data-idtint updated', async () => {
    const { appbar, panes } = mount();
    appbar.querySelector<HTMLElement>('button[aria-label="open settings"]')!.click();
    await flush();
    const tintRow = [...panes.querySelectorAll('.winbody .row')]
      .find((r) => r.querySelector('label')?.textContent === 'identity tint')!;
    const wordsBefore = [...tintRow.querySelectorAll<HTMLButtonElement>('.seg .word')];
    const samplesBefore = [...tintRow.querySelectorAll<HTMLElement>('.tint-sample')];
    expect(wordsBefore).toHaveLength(4);
    expect(samplesBefore).toHaveLength(2);
    const off = wordsBefore.find((w) => w.textContent === 'off')!;
    off.focus();
    expect(document.activeElement).toBe(off);
    off.click();
    await flush();
    const wordsAfter = [...tintRow.querySelectorAll<HTMLButtonElement>('.seg .word')];
    const samplesAfter = [...tintRow.querySelectorAll<HTMLElement>('.tint-sample')];
    for (let i = 0; i < 4; i++) expect(wordsAfter[i]).toBe(wordsBefore[i]);
    for (let i = 0; i < 2; i++) expect(samplesAfter[i]).toBe(samplesBefore[i]);
    expect(wordsAfter.map((w) => w.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false', 'true']);
    expect(document.activeElement).toBe(off);
    expect(document.documentElement.getAttribute('data-idtint')).toBe('off');
  });

  it('notis.layout holds @settings after an open, and a fresh App restores the window', async () => {
    const { appbar } = mount();
    appbar.querySelector<HTMLElement>('button[aria-label="open settings"]')!.click();
    await flush();
    // The layout persists the arrangement — @settings is one live token
    // (arrangement.test.ts pins its round-trip).
    const stored = localStorage.getItem(KEY_LAYOUT);
    expect(stored).toContain('@settings');

    // A fresh App reads the same layout and restores the window on mount.
    document.body.innerHTML = '';
    const appbar2 = document.createElement('header');
    const workspace = document.createElement('div'); workspace.className = 'workspace';
    const feed2 = document.createElement('section'); feed2.id = 'feed';
    const panes2 = document.createElement('section'); panes2.id = 'panes';
    workspace.append(feed2, panes2);
    document.body.append(appbar2, workspace);
    const app2 = new App(fakeApi());
    app2.mount(appbar2, feed2, panes2);
    const bar = panes2.querySelector('.bar');
    expect(bar).not.toBeNull();
    expect(bar!.querySelector('.bar-label .name')?.textContent).toBe('settings');
  });
});
