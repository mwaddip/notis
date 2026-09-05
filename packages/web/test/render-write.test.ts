// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import type { Api } from '../src/api/client';
import type { AppIdentity } from '../src/model/state';
import type { WriteClient } from '../src/api/write';
import type { FeedResult, ThreadResult, PostJson, PostResult, StatusResult } from '../src/api/dto';
import { karmaResult } from './karma-fixture';
import { contentHashHex } from '../src/integrity';

// The write surface rendered: the composer opens in its slot and collapses to a
// hollow card, the composer element is reused by reference across a rebuild and
// across renderFeedInto, and the like control obeys §7's exclusions. render
// -region.test.ts covers the no-identity case; here an identity is loaded.

const PUB = 'aa'.repeat(32); // the reader
const OTHER = 'ee'.repeat(32); // someone else
const ROOT = 'b'.repeat(64);
const OWN_POST = 'c'.repeat(64);
const MY_POST = 'a'.repeat(64); // the reader's own post, listed in the @posts window
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function post(id: string, author: string, content: string, status: 'confirmed' | 'pending' = 'confirmed'): PostJson {
  return {
    id, content, contentHash: contentHashHex(content), author, parentRefs: [], protocolVersion: 1,
    type: 'regular', status, blockHeight: status === 'confirmed' ? 100 : null, blockIndex: 0,
    blockCreatedAt: 0, likeCount: 0, likedByViewer: null,
  };
}
function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 6000, protocolVersion: 1, postCount: 1, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}

interface Harness {
  drive: {
    loadFeed(): Promise<void>;
    openThread(id: string, origin: { from: 'feed' } | { from: 'pane'; ci: number }): void;
    openComposer(parentId: string | null): void;
    submitComposer(parentId: string | null, text: string): Promise<void>;
    refreshFeed(): Promise<void>;
    refreshThread(id: string): Promise<void>;
    openAuthorPosts(key: string, origin: { from: 'feed' } | { from: 'pane'; ci: number }): void;
  };
  feed: HTMLElement;
  panes: HTMLElement;
}

function harness(): Harness {
  const signed: string[] = [];
  const identity: AppIdentity = {
    current: () => ({ pubKeyHex: PUB, locked: false }),
    sign: (txId) => {
      signed.push(txId);
      return 'ab'.repeat(64);
    },
    draft: () => ({ pubKeyHex: PUB }),
    create: async () => ({ pubKeyHex: PUB }),
    discardDraft: () => {},
    inspectFile: () => ({ kind: 'clear', pubKeyHex: PUB }),
    importFile: async () => ({ pubKeyHex: PUB }),
    exportFile: async () => '{}',
    unlock: async () => {},
    lock: () => {},
    forget: () => {},
    backedUp: () => false,
    onChange: () => {},
  };
  const echoTxId = (): string => signed[signed.length - 1]!; // a matching node echoes the client's id
  const feedResult: FeedResult = { posts: [post(ROOT, OTHER, 'a root by someone else')], next: null, pending: [], pendingCount: 0 };
  const thread: ThreadResult = {
    post: post(ROOT, OTHER, 'a root by someone else'),
    ancestors: [], ancestorCount: 0,
    descendants: [post(OWN_POST, PUB, 'my own reply')],
    descendantCount: 1, next: null, pending: [], pendingCount: 0,
  };
  const fakeApi: Api = {
    // The @posts window reads with the author arg; the reader's own posts come back
    // there, everywhere else the shared feed.
    feed: async (_page, _viewer, author) =>
      author === PUB
        ? { posts: [post(MY_POST, PUB, 'my own post')], next: null, pending: [], pendingCount: 0 }
        : feedResult,
    thread: async (id) => (id === ROOT ? thread : null),
    post: async (id): Promise<PostResult> => ({ ...post(id, OTHER, 'x'), confirmedAuthor: OTHER }),
    status: async () => statusResult(),
    currentBlock: async () => ({ height: 6000, hash: null }),
    karma: async () => karmaResult({ userId: PUB, total: '227', effective: '227', boxes: [{ boxId: '11'.repeat(32), value: '227' }], boxCount: 1, height: 6000 }),
    vouchesByTarget: async () => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async () => ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async () => ({ cooldowns: [], count: 0, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
  };
  const writeClient = {
    submitPost: async () => ({ postId: 'newpost', status: 'pending', expiresAtHeight: 6720, txId: echoTxId() }),
    submitLike: async () => ({ status: 'pending', txId: echoTxId(), expiresAtHeight: 6720 }),
  } as unknown as WriteClient;

  const app = new App(fakeApi, writeClient, identity, new PendingLedger(PUB));
  const appbar = document.createElement('div');
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  document.body.append(appbar, feed, panes);
  app.mount(appbar, feed, panes);
  return { drive: app as unknown as Harness['drive'], feed, panes };
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('the feed composer', () => {
  it('shows a new post control, opens in its slot, and collapses to a hollow card', async () => {
    const h = harness();
    await h.drive.loadFeed();
    expect(h.feed.querySelector('[data-composer-open="@feed"]')).toBeTruthy(); // new post
    expect(h.feed.querySelector('.composer')).toBeNull();

    h.drive.openComposer(null);
    expect(h.feed.querySelector('.composer')).toBeTruthy();

    await h.drive.submitComposer(null, 'a new thread');
    // The composer is gone; a hollow pending card with a stage line is in its slot.
    expect(h.feed.querySelector('.composer')).toBeNull();
    const card = h.feed.querySelector('.card.pending');
    expect(card).toBeTruthy();
    expect(card!.querySelector('.stage')).toBeTruthy();
    expect(card!.querySelector('.stage')!.textContent).toContain('submitted');
  });

  it('the feed composer element survives renderFeedInto by reference', async () => {
    const h = harness();
    await h.drive.loadFeed();
    h.drive.openComposer(null);
    const composerBefore = h.feed.querySelector('.composer');
    expect(composerBefore).toBeTruthy();
    await h.drive.refreshFeed();
    expect(h.feed.querySelector('.composer')).toBe(composerBefore); // reused, not recreated
  });
});

describe('a reply composer in a pane', () => {
  it('survives its region rebuild by reference', async () => {
    const h = harness();
    await h.drive.loadFeed();
    h.drive.openThread(ROOT, { from: 'feed' });
    await flush();
    h.drive.openComposer(ROOT);
    const composerBefore = h.panes.querySelector('.composer');
    expect(composerBefore).toBeTruthy();
    await h.drive.refreshThread(ROOT);
    expect(h.panes.querySelector('.composer')).toBe(composerBefore);
  });
});

describe('the like control obeys the exclusions', () => {
  it('a like button on someone else\'s post, the withdraw control on the reader\'s own', async () => {
    const h = harness();
    await h.drive.loadFeed();
    h.drive.openThread(ROOT, { from: 'feed' });
    await flush();
    const cards = [...h.panes.querySelectorAll('.card')];
    // The root is by OTHER → a like button; the descendant is by PUB (own) → the
    // withdraw control fills the slot, no like button.
    const rootCard = cards.find((c) => c.textContent?.includes('a root by someone else'))!;
    const ownCard = cards.find((c) => c.textContent?.includes('my own reply'))!;
    expect(rootCard.querySelector('.likebtn')).toBeTruthy();
    expect(rootCard.querySelector('.withdraw-ctl')).toBeNull();
    expect(ownCard.querySelector('.likebtn')).toBeNull();
    expect(ownCard.querySelector('.withdraw-ctl')).toBeTruthy();
    // Both carry a ↩ reply control.
    expect(rootCard.querySelector('.reply-ctl')).toBeTruthy();
    expect(ownCard.querySelector('.reply-ctl')).toBeTruthy();
  });
});

describe('the @posts window is read-only', () => {
  it("the reader's own posts there carry no withdraw — nor like, nor reply", async () => {
    const h = harness();
    h.drive.openAuthorPosts(PUB, { from: 'feed' });
    await flush();
    const ownCard = [...h.panes.querySelectorAll('.card')].find((c) => c.textContent?.includes('my own post'))!;
    expect(ownCard).toBeTruthy();
    expect(ownCard.querySelector('.you')?.textContent).toBe('· you'); // recognised as own
    expect(ownCard.querySelector('.withdraw-ctl')).toBeNull(); // the write controls live in the pane, not here
    expect(ownCard.querySelector('.likebtn')).toBeNull();
    expect(ownCard.querySelector('.reply-ctl')).toBeNull();
  });
});
