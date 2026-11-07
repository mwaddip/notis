// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { renderFeedInto } from '../src/view/feed';
import type { PostJson } from '../src/api/dto';
import type { FeedState, Handlers, RenderCtx } from '../src/model/state';
import { contentHashHex } from '../src/integrity';

// WEB_INTERFACE → The extension → "A failed listing draws the cache": on a
// failed first page the feed renders the error line and, beneath it, the rows
// the cache fallback wrote; with no rows the error line alone, never the
// loading… or the no-posts-yet line.

const AUTHOR = 'aa'.repeat(32);
const P1 = 'b'.repeat(64);
const P2 = 'cc'.repeat(32);

function post(id: string, over: Partial<PostJson> = {}): PostJson {
  return {
    id, content: 'hi', contentHash: contentHashHex('hi'), author: AUTHOR, parentRefs: [],
    protocolVersion: 1, type: 'regular', status: 'confirmed', blockHeight: 10, blockIndex: 0,
    blockCreatedAt: 0, likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null,
    txId: 'ff'.repeat(32),
    ...over,
  };
}

function noopHandlers(): Handlers {
  const noop = (): void => {};
  const async = async (): Promise<void> => {};
  return {
    openThread: noop, refreshFeed: noop, loadOlder: noop, openProfile: noop,
    openSettings: noop, openWallet: noop, refreshProfile: noop, refreshWallet: noop,
    focus: noop, refreshThread: noop, threadMore: noop, moveLeft: noop, moveRight: noop,
    close: noop, setTheme: noop, setIdTint: noop, setNode: noop,
    inspectFile: async () => ({ kind: 'clear', pubKeyHex: '' }),
    draftIdentity: async () => ({ pubKeyHex: '' }),
    createIdentity: async, discardDraft: noop, importIdentity: async, exportIdentity: async,
    forgetIdentity: async, lockIdentity: async, unlockIdentity: async, askFaucet: noop,
    openComposer: noop, expandImage: noop, collapseImage: noop, pressLike: noop,
    pressWithdraw: noop, linkRefused: noop, tryAgain: noop, vouch: noop, unvouch: noop, openAuthor: noop,
    refreshAuthor: noop, openAuthorPosts: noop, refreshAuthorPosts: noop,
    authorPostsMore: noop, moreEndorsers: noop, invite: noop, moreBonds: noop,
    claimUsername: noop, burnUsername: noop,
    beginSendPress: () => true, endSendPress: noop, pressSend: noop,
    resolveRecipient: async () => ({ refusal: 'none' }),
    send: noop, askFaucetCredits: noop,
  };
}

function baseCtx(over: Partial<RenderCtx> = {}): RenderCtx {
  return {
    openSet: new Set(), thread: () => undefined, post: () => undefined,
    oneColumn: false, standalone: false, writeEnabled: false, ownKey: null,
    composerFor: () => null, submissionsFor: () => [], likePending: () => false,
    expandedImages: new Set(), identity: null, backedUp: false, karma: null,
    karmaPlain: null, grant: null, member: false, author: new Map(),
    authorPosts: new Map(), invite: null, canAffordMinBond: false, bonds: null,
    inviteFlight: null, withdrawState: () => null, canSignWithdraw: false,
    ownName: null, ownNameLoaded: false, nameClay: () => false,
    usernameFlight: null, pendingUsername: null, canSignClaim: false,
    canAffordBurn: false, status: null, credits: null, creditsPlain: null, creditGrant: null,
    sendFlight: null, pendingSend: null, sendCheck: null, sendAnswer: null,
    confirmInRow: true, verdict: undefined, figures: null,
    linkUrl: (id) => `http://localhost/p/${id}`,
    rowsUnder: () => [],
    windowBody: () => null,
    ...over,
  };
}

function feedState(over: Partial<FeedState> = {}): FeedState {
  return {
    posts: [], pending: [], next: null, report: null, olderReport: null,
    reportCount: null, olderReportCount: null, loaded: false, loading: false,
    error: null, unboundCount: 0,
    ...over,
  };
}

describe('the feed view beneath a failed listing', () => {
  it('a feed with an error and rows draws the line and then the cards', () => {
    const feed = feedState({
      posts: [post(P1), post(P2)],
      loaded: false, loading: false,
      error: 'node answered 500',
      next: null,
    });
    const container = document.createElement('section');
    renderFeedInto(container, feed, noopHandlers(), baseCtx());
    const err = container.querySelector<HTMLElement>('.error');
    expect(err).not.toBeNull();
    expect(err!.textContent).toBe("can't reach the node right now — node answered 500");
    const cards = [...container.querySelectorAll('.card')] as HTMLElement[];
    expect(cards.map((c) => c.dataset['postId'])).toEqual([P1, P2]);
    // No `load older` beyond the cache — next is null and loaded is false.
    expect([...container.querySelectorAll('button')].find((x) => x.textContent === 'load older')).toBeUndefined();
    // Neither `loading…` nor `no posts yet.` stands.
    expect(container.querySelector('.loading')).toBeNull();
  });

  it('a feed with an error and no rows draws the line alone', () => {
    const feed = feedState({
      posts: [], loaded: false, loading: false,
      error: 'no node answered — set one in settings',
      next: null,
    });
    const container = document.createElement('section');
    renderFeedInto(container, feed, noopHandlers(), baseCtx());
    expect(container.querySelector<HTMLElement>('.error')?.textContent)
      .toBe("can't reach the node right now — no node answered — set one in settings");
    expect(container.querySelectorAll('.card').length).toBe(0);
    // No `loading…` line stands — loading is false; and no `no posts yet.`
    // line, which the feed only draws under `feed.loaded`.
    expect(container.querySelector('.loading')).toBeNull();
  });
});
