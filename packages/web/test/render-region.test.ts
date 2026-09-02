// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { App } from '../src/app';
import type { Api } from '../src/api/client';
import type { FeedResult, ThreadResult, PostJson } from '../src/api/dto';

const HEX = (c: string): string => c.repeat(64);
const P1 = HEX('a'), P2 = HEX('b'), R1 = HEX('1'), R2 = HEX('2');

function post(id: string, content: string, parents: string[] = []): PostJson {
  return {
    id, content, contentHash: HEX('0'), author: HEX('7'), parentRefs: parents,
    protocolVersion: 1, type: 'regular', status: 'confirmed',
    blockHeight: 1, blockIndex: 0, blockCreatedAt: 0, likeCount: 0, likedByViewer: null,
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
  };
}

describe('renderRegion isolation', () => {
  it('refreshing one region leaves the feed and the other region untouched — by node identity', async () => {
    const appbar = document.createElement('div');
    const feed = document.createElement('section'); feed.id = 'feed';
    const panes = document.createElement('section'); panes.id = 'panes';
    document.body.append(appbar, feed, panes);

    const app = new App(fakeApi());
    app.mount(appbar, feed, panes);
    const drive = app as unknown as {
      loadFeed(): Promise<void>;
      openThread(id: string, origin: { from: 'feed' } | { from: 'pane'; ci: number }): void;
      refreshThread(id: string): Promise<void>;
    };

    await drive.loadFeed();
    await flush();

    // Two threads in two columns → two regions.
    drive.openThread(P1, { from: 'feed' });
    await flush();
    drive.openThread(P2, { from: 'pane', ci: 0 });
    await flush();
    expect(panes.querySelectorAll('.region').length).toBe(2);

    // Stable node references and a scroll position, captured after the opens.
    const feedCardBefore = feed.querySelector('.card');
    expect(feedCardBefore).toBeTruthy();
    feed.scrollTop = 55;
    const region2Before = panes.querySelectorAll('.region')[1] as HTMLElement;
    const region2BodyBefore = region2Before.querySelector('.region-body');
    expect(region2BodyBefore).toBeTruthy();

    // Refresh region 1 (P1).
    await drive.refreshThread(P1);
    await flush();

    // The feed was not re-rendered: same card node, scroll intact. A global
    // rebuild would replace this node — which is the point of the assertion.
    expect(feed.querySelector('.card')).toBe(feedCardBefore);
    expect(feed.scrollTop).toBe(55);
    // Region 2 was not re-rendered: same region and body nodes.
    const region2After = panes.querySelectorAll('.region')[1] as HTMLElement;
    expect(region2After).toBe(region2Before);
    expect(region2After.querySelector('.region-body')).toBe(region2BodyBefore);
  });
});
