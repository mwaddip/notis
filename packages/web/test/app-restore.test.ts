// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { App } from '../src/app';
import type { Api } from '../src/api/client';
import type { FeedResult, ThreadResult, PostJson } from '../src/api/dto';
import { karmaResult } from './karma-fixture';
import { contentHashHex } from '../src/integrity';

// A restored stack shows every window's excerpt as its thread lands, even the
// windows not focused, and a load leaves the focused body's node in place
// (WEB_INTERFACE → The workspace).
const HEX = (c: string): string => c.repeat(64);
const A = HEX('a'), B = HEX('b');

function post(id: string, content: string): PostJson {
  return {
    id, content, contentHash: contentHashHex(content), author: HEX('7'), parentRefs: [],
    protocolVersion: 1, type: 'regular', status: 'confirmed',
    blockHeight: 1, blockIndex: 0, blockCreatedAt: 0, likeCount: 0, descendantCount: 0, authorVouchCount: 0, likedByViewer: null,
  };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const root = (id: string, content: string): ThreadResult => ({
  post: post(id, content), ancestors: [], ancestorCount: 0,
  descendants: [], descendantCount: 0, next: null, pending: [], pendingCount: 0,
});

function fakeApi(): Api {
  return {
    feed: async (): Promise<FeedResult> => ({ posts: [], next: null, pending: [], pendingCount: 0 }),
    thread: async (id) => (id === A ? root(A, 'alpha root') : id === B ? root(B, 'bravo root') : null),
    post: async () => null,
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
  };
}

interface Drive { fetchThread(id: string): Promise<void>; }
const excerpt = (bar: Element): string | null => bar.querySelector('.excerpt')?.textContent ?? null;

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('a restored stack labels every window as its thread lands', () => {
  it("resolving an unfocused window's thread updates its bar in place, the focused body untouched", async () => {
    // A stored [A, B] — one column, two windows, focused on A (focus is not encoded).
    localStorage.setItem('notis.layout', `${A},${B}`);
    const appbar = document.createElement('div');
    const feed = document.createElement('section'); feed.id = 'feed';
    const panes = document.createElement('section'); panes.id = 'panes';
    document.body.append(appbar, feed, panes);
    const app = new App(fakeApi());
    app.mount(appbar, feed, panes);

    // Both bars read loading… before the threads resolve; A is focused, B is not.
    const bars = (): NodeListOf<HTMLElement> => panes.querySelectorAll('.bar');
    expect(bars().length).toBe(2);
    expect(bars()[0]!.classList.contains('focused')).toBe(true);
    expect(bars()[1]!.classList.contains('focused')).toBe(false);
    expect(excerpt(bars()[1]!)).toBe('loading…');

    const drive = app as unknown as Drive;
    await drive.fetchThread(A); // the focused window — a full re-render of its column
    await flush();
    const focusedBody = panes.querySelector('.region-body');

    await drive.fetchThread(B); // NOT focused — its bar must still update
    await flush();

    // B's bar now carries its excerpt, not loading…; the focused body's node survived.
    expect(excerpt(bars()[1]!)).toBe('bravo root');
    expect(excerpt(bars()[0]!)).toBe('alpha root');
    expect(panes.querySelector('.region-body')).toBe(focusedBody);
  });
});
