// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { App } from '../src/app';
import type { Api } from '../src/api/client';
import type { FeedResult, ThreadResult, PostJson } from '../src/api/dto';
import { karmaResult } from './karma-fixture';
import { contentHashHex } from '../src/integrity';
import { KEY_LAYOUT } from '../src/prefs';

const HEX = (c: string): string => c.repeat(64);
const P1 = HEX('a'), P2 = HEX('b'), R1 = HEX('1');

function post(id: string, content: string, parents: string[] = []): PostJson {
  return {
    id, content, contentHash: contentHashHex(content), author: HEX('7'), parentRefs: parents,
    protocolVersion: 1, type: 'regular', status: 'confirmed',
    blockHeight: 1, blockIndex: 0, blockCreatedAt: 0, likeCount: 0, descendantCount: 1, authorVouchCount: 0, likedByViewer: null,
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
    app.mount(appbar, feed, panes, { kind: 'standalone', id: P1 });
    await flush();

    expect(feed.children.length).toBe(0);
    expect(panes.querySelector('.empty')).toBeNull();
    const bar = panes.querySelector('.bar');
    expect(bar).toBeTruthy();
    const ctls = [...bar!.querySelectorAll('.ctl')].map((c) => c.textContent);
    expect(ctls).toEqual(['↻']);
  });

  it('notis.layout is untouched by mount and a rebuild', async () => {
    localStorage.setItem(KEY_LAYOUT, '#' + HEX('f'));
    const { appbar, feed, panes } = mountShell();
    localStorage.setItem(KEY_LAYOUT, '#' + HEX('f'));
    const app = new App(fakeApi());
    app.mount(appbar, feed, panes, { kind: 'standalone', id: P1 });
    await flush();

    expect(localStorage.getItem(KEY_LAYOUT)).toBe('#' + HEX('f'));
  });

  it('the .workspace element carries the standalone class', () => {
    const { appbar, feed, panes } = mountShell();
    const app = new App(fakeApi());
    app.mount(appbar, feed, panes, { kind: 'standalone', id: P1 });
    const ws = panes.closest('.workspace');
    expect(ws?.classList.contains('standalone')).toBe(true);
  });

  it('the thread renders its cards on load', async () => {
    const { appbar, feed, panes } = mountShell();
    const app = new App(fakeApi());
    (app as unknown as { start(a: HTMLElement, b: HTMLElement, c: HTMLElement, m: { kind: 'standalone'; id: string }): void })
      .start(appbar, feed, panes, { kind: 'standalone', id: P1 });
    await flush();
    await flush();

    const cards = panes.querySelectorAll('.card');
    expect(cards.length).toBeGreaterThanOrEqual(1);
  });
});
