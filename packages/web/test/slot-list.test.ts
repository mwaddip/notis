// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { renderFeedInto } from '../src/view/feed';
import { authorPostsBody, type PostsCtx, type PostsHandlers } from '../src/view/author';
import { renderRegionElement } from '../src/view/panes';
import type { LightJson, PostJson } from '../src/api/dto';
import type { FeedState, Handlers, RenderCtx, ThreadState } from '../src/model/state';
import type { Column } from '../src/model/workspace';
import { contentHashHex } from '../src/integrity';

// A list that holds a slot between two cards: the feed, the author window and
// the pane keep the order and stand the slot at the row the node named — in a
// pane, at its parent's depth (WEB_INTERFACE → The extension → "The light
// read").

const AUTHOR = 'aa'.repeat(32);
const P1 = 'b'.repeat(64);
const SLOT = 'cc'.repeat(32);
const P3 = 'dd'.repeat(32);
const ROOT = 'ee'.repeat(32);
const SLOT_REPLY = 'ff'.repeat(32);

function post(id: string, author: string, over: Partial<PostJson> = {}): PostJson {
  return {
    id, content: 'hi', contentHash: contentHashHex('hi'), author, parentRefs: [],
    protocolVersion: 1, type: 'regular', status: 'confirmed', blockHeight: 10, blockIndex: 0,
    blockCreatedAt: 0, likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null, txId: 'ff'.repeat(32),
    ...over,
  };
}
function slot(id: string, over: Partial<LightJson> = {}): LightJson {
  return {
    kind: 'light', id, parentRefs: [], status: 'confirmed',
    blockHeight: 11, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, descendantCount: 0, authorName: 'bob', likedByViewer: null,
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
    openComposer: noop, expandImage: noop, collapseImage: noop, likePost: noop,
    withdrawPost: noop, tryAgain: noop, vouch: noop, unvouch: noop, openAuthor: noop,
    refreshAuthor: noop, openAuthorPosts: noop, refreshAuthorPosts: noop,
    authorPostsMore: noop, moreEndorsers: noop, invite: noop, moreBonds: noop,
    claimUsername: noop, burnUsername: noop,
    beginSendPress: () => true, pressSend: noop,
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
    grant: null, member: false, yourVouch: () => null, author: new Map(),
    authorPosts: new Map(), invite: null, canAffordMinBond: false, bonds: null,
    inviteFlight: null, withdrawState: () => null, canSignWithdraw: false,
    ownName: null, ownNameLoaded: false, nameClay: () => false,
    usernameFlight: null, pendingUsername: null, canSignClaim: false,
    canAffordBurn: false, status: null, credits: null, creditGrant: null,
    sendFlight: null, pendingSend: null, sendCheck: null, sendAnswer: null,
    confirmInRow: true, verdict: undefined, figures: null,
    linkUrl: (id) => `http://localhost/p/${id}`,
    heldCardRow: () => null,
    openUnlockForLike: () => {},
    openConfirmWithdraw: () => {},
    openLinkFallback: () => {},
    ...over,
  };
}

describe("the feed renders a slot between two cards — order kept, the slot card in its place", () => {
  it('three rows in [post, slot, post] render as three cards in the same order', () => {
    const feed: FeedState = {
      posts: [post(P1, AUTHOR), slot(SLOT), post(P3, AUTHOR)],
      pending: [], next: null, report: null, olderReport: null,
      reportCount: null, olderReportCount: null, loaded: true,
      loading: false, error: null, unboundCount: 0,
    };
    const container = document.createElement('div');
    renderFeedInto(container, feed, noopHandlers(), baseCtx());
    const cards = [...container.querySelectorAll('.card')] as HTMLElement[];
    expect(cards.map((c) => c.dataset['postId'])).toEqual([P1, SLOT, P3]);
    expect(cards[1]!.classList.contains('slot')).toBe(true);
    expect(cards[0]!.classList.contains('slot')).toBe(false);
    expect(cards[2]!.classList.contains('slot')).toBe(false);
    // The slot carries no control button (WEB_INTERFACE → The extension →
    // "Any other row stands as a slot").
    expect(cards[1]!.querySelector('button')).toBeNull();
  });
});

describe("the author-posts window renders a slot between two cards — order kept", () => {
  it('three rows in [post, slot, post] render as three cards in the same order', () => {
    const feed: FeedState = {
      posts: [post(P1, AUTHOR), slot(SLOT), post(P3, AUTHOR)],
      pending: [], next: null, report: null, olderReport: null,
      reportCount: null, olderReportCount: null, loaded: true,
      loading: false, error: null, unboundCount: 0,
    };
    const handlers: PostsHandlers = {
      openThread: () => {}, openAuthor: () => {}, likePost: () => {},
      authorPostsMore: () => {},
      expandImage: () => {}, collapseImage: () => {},
    };
    const ctx: PostsCtx = {
      authorKey: AUTHOR, origin: { from: 'feed' }, feed,
      writeEnabled: false, ownKey: null, locked: false, likePending: () => false,
      linkUrl: (id) => `/p/${id}`, expandedImages: new Set(), nameClay: () => false,
      listKey: '@posts:' + AUTHOR,
      heldCardRow: () => null,
      openUnlockForLike: () => {},
      openLinkFallback: () => {},
    };
    const body = authorPostsBody(handlers, ctx);
    const cards = [...body.querySelectorAll('.card')] as HTMLElement[];
    expect(cards.map((c) => c.dataset['postId'])).toEqual([P1, SLOT, P3]);
    expect(cards[1]!.classList.contains('slot')).toBe(true);
    expect(cards[1]!.querySelector('button')).toBeNull();
  });
});

describe("the pane renders a slot descendant at its parent's depth", () => {
  it('a thread [root, reply, slot-under-reply] renders in order, the slot one deeper than its parent', () => {
    const rootRow = post(ROOT, AUTHOR, { descendantCount: 2 });
    const replyRow = post(P1, AUTHOR, { parentRefs: [ROOT], descendantCount: 1 });
    const slotRow = slot(SLOT_REPLY, { parentRefs: [P1] });
    const thread: ThreadState = {
      id: ROOT, root: rootRow, ancestorIds: new Set(), descendants: [replyRow, slotRow],
      descendantCount: 2, next: null, report: null, loading: false, error: null,
      unboundCount: 0, subjectWithheld: null,
    };
    const ctx = baseCtx({ thread: (id) => (id === ROOT ? thread : undefined) });
    const col: Column = { uid: 1, wins: [ROOT], focus: 0, report: null };
    const region = renderRegionElement(col, 0, noopHandlers(), ctx);
    const cards = [...region.querySelectorAll('.region-body .card')] as HTMLElement[];
    expect(cards.map((c) => c.dataset['postId'])).toEqual([ROOT, P1, SLOT_REPLY]);
    const slotCard = cards[2]!;
    expect(slotCard.classList.contains('slot')).toBe(true);
    // The slot's depth matches its parent's depth + 1 — the reply is at depth
    // 1, the slot at depth 2.
    expect(slotCard.classList.contains('depth-2')).toBe(true);
    expect(cards[1]!.classList.contains('depth-1')).toBe(true);
  });

  it('a thread whose root is a slot renders it at depth 0 and nothing below', () => {
    const rootSlot = slot(ROOT, { descendantCount: 0 });
    const thread: ThreadState = {
      id: ROOT, root: rootSlot, ancestorIds: new Set(), descendants: [],
      descendantCount: 0, next: null, report: null, loading: false, error: null,
      unboundCount: 0, subjectWithheld: null,
    };
    const ctx = baseCtx({ thread: (id) => (id === ROOT ? thread : undefined) });
    const col: Column = { uid: 1, wins: [ROOT], focus: 0, report: null };
    const region = renderRegionElement(col, 0, noopHandlers(), ctx);
    const cards = [...region.querySelectorAll('.region-body .card')] as HTMLElement[];
    expect(cards).toHaveLength(1);
    expect(cards[0]!.dataset['postId']).toBe(ROOT);
    expect(cards[0]!.classList.contains('slot')).toBe(true);
    // The root slot has no depth class — depth 0.
    expect([...cards[0]!.classList].some((c) => c.startsWith('depth-'))).toBe(false);
  });
});
