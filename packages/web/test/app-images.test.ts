// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { App } from '../src/app';
import type { Api } from '../src/api/client';
import type { FeedResult, PostJson } from '../src/api/dto';
import { karmaResult } from './karma-fixture';
import { contentHashHex } from '../src/integrity';

// The App remembers an expanded image per post and image for the session, so a
// re-render renders the img directly (WEB_INTERFACE → Content). The feed rebuilds
// its cards on a refresh (renderFeedInto clears the container), so a card that
// keeps its image across a refresh proves the App held the key, not the node.

const IMG = 'https://img.example/c.png';
function imagePost(): PostJson {
  const content = `![a cat](${IMG})`;
  return {
    id: 'p1', content, contentHash: contentHashHex(content), author: 'a'.repeat(64), parentRefs: [],
    protocolVersion: 1, type: 'regular', status: 'confirmed', blockHeight: 1, blockIndex: 0,
    blockCreatedAt: 0, likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null,
  };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function fakeApi(): Api {
  const feed: FeedResult = { posts: [imagePost()], next: null, pending: [], pendingCount: 0 };
  return {
    feed: async () => feed,
    thread: async () => null,
    post: async () => null,
    status: async () => ({
      networkType: 'test', blockHeight: 1, protocolVersion: 1, postCount: 1, pendingPosts: 0,
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

describe('the App remembers an expanded image', () => {
  it('a press records the key, and a feed refresh renders the img directly', async () => {
    const appbar = document.createElement('div');
    const feed = document.createElement('section');
    const panes = document.createElement('section');
    document.body.append(appbar, feed, panes);

    const app = new App(fakeApi());
    app.mount(appbar, feed, panes);
    const drive = app as unknown as { loadFeed(): Promise<void>; refreshFeed(): Promise<void> };
    await drive.loadFeed();
    await flush();

    // No img before the press; the control is there.
    expect(feed.querySelector('img')).toBeNull();
    const btn = feed.querySelector('.img-show') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    btn.click();
    expect(feed.querySelector('img')).not.toBeNull(); // swapped in place

    // A refresh rebuilds the feed's cards; the App remembered the key, so the img
    // renders directly and the control is gone.
    await drive.refreshFeed();
    await flush();
    expect(feed.querySelector('img')).not.toBeNull();
    expect(feed.querySelector('.img-show')).toBeNull();
  });
});
