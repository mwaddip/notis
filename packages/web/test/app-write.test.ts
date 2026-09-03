// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import type { Api } from '../src/api/client';
import type { Signer } from '../src/wallet/submit';
import type { WriteClient } from '../src/api/write';
import type { AppState } from '../src/model/state';
import type { KarmaResult, PostResult, StatusResult, FeedResult, BlockCurrent } from '../src/api/dto';

// The App's write-surface wiring: a submission's flight, the bounded poll, and
// the optimistic like — driven over fakes, asserted on state (the DOM rendering
// of these is the next sub-phase). render-region.test.ts covers the no-identity
// case; here an identity is always loaded.

const PUB = 'aa'.repeat(32);
const AUTHOR = 'bb'.repeat(32);
const BOX = '11'.repeat(32);
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 6000, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}
function confirmedPost(id: string, likedByViewer: boolean | null = null): PostResult {
  return {
    id, content: 'x', contentHash: '00'.repeat(32), author: AUTHOR, parentRefs: [], protocolVersion: 1,
    type: 'regular', status: 'confirmed', blockHeight: 6001, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, likedByViewer, confirmedAuthor: AUTHOR,
  };
}

interface Harness {
  app: App;
  ledger: PendingLedger;
  panes: HTMLElement;
  drive: {
    submitComposer(parentId: string | null, text: string): Promise<void>;
    likePost(postId: string): Promise<void>;
    loadFeed(): Promise<void>;
    pollTick(): Promise<void>;
    state: AppState;
    composers: Map<string, unknown>;
    optimisticLikes: Set<string>;
    pollTimer: unknown;
  };
  feedViewers: Array<string | undefined>;
  setHeight(h: number): void;
  setLiked(v: boolean): void;
}

interface ThrowOpts {
  submit?: boolean;
  like?: boolean;
  currentBlock?: boolean;
}

function harness(thrown: ThrowOpts = {}): Harness {
  const signCalls: string[] = [];
  const identity: Signer = { current: () => ({ pubKeyHex: PUB }), sign: (t) => { signCalls.push(t); return 'ab'.repeat(64); } };
  const last = (): string => signCalls[signCalls.length - 1]!;
  const feedViewers: Array<string | undefined> = [];
  let blockHeight = 6001;
  let liked = false;

  const karma: KarmaResult = { userId: PUB, total: '227', effective: '227', boxes: [{ boxId: BOX, value: '227' }], boxCount: 1, next: null, height: 6000 };
  const fakeApi: Api = {
    feed: async (_p, viewer): Promise<FeedResult> => { feedViewers.push(viewer); return { posts: [], next: null, pending: [], pendingCount: 0 }; },
    thread: async () => null,
    post: async (id) => confirmedPost(id, liked),
    status: async () => statusResult(),
    currentBlock: async (): Promise<BlockCurrent> => {
      if (thrown.currentBlock) throw new Error('node unreachable');
      return { height: blockHeight, hash: null };
    },
    karma: async () => karma,
  };
  const writeClient = {
    submitPost: async () => {
      if (thrown.submit) throw new Error('node unreachable');
      return { postId: 'newpost', status: 'pending', expiresAtHeight: 6720, txId: last() };
    },
    submitLike: async () => {
      if (thrown.like) throw new Error('node unreachable');
      return { status: 'pending', txId: last(), expiresAtHeight: 6720 };
    },
  } as unknown as WriteClient;

  const ledger = new PendingLedger();
  const app = new App(fakeApi, writeClient, identity, ledger);
  const appbar = document.createElement('div');
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  document.body.append(appbar, feed, panes);
  app.mount(appbar, feed, panes);

  return {
    app, ledger, panes, feedViewers,
    drive: app as unknown as Harness['drive'],
    setHeight: (h) => { blockHeight = h; },
    setLiked: (v) => { liked = v; },
  };
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the App write surface — a post flight', () => {
  it('submitComposer lands a submission and a ledger entry, and starts the poll', async () => {
    const h = harness();
    await h.drive.submitComposer(null, 'a new thread');
    expect(h.drive.state.submissions).toHaveLength(1);
    const sub = h.drive.state.submissions[0]!;
    expect(sub).toMatchObject({ parentId: null, author: PUB, stage: 'submitted', postId: 'newpost' });
    expect(h.ledger.all().map((e) => e.kind)).toEqual(['post']);
    expect(h.drive.pollTimer).not.toBeNull();
  });

  it('the bounded poll lands the submission on a height change and stops at zero', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.drive.submitComposer(null, 'a new thread');
    // One poll tick: the tip has moved (0 → 6001), the post reads confirmed.
    await h.drive.pollTick();
    const sub = h.drive.state.submissions[0]!;
    expect(sub.stage).toBe('landed');
    expect(sub.blockHeight).toBe(6001);
    expect(h.ledger.size).toBe(0);
    expect(h.drive.pollTimer).toBeNull(); // stopped at zero
  });

  it('a settled submission is cleared on a feed refresh so the node data takes over', async () => {
    const h = harness();
    await h.drive.submitComposer(null, 'a new thread');
    h.drive.state.submissions[0]!.stage = 'landed';
    await (h.app as unknown as { refreshFeed(): Promise<void> }).refreshFeed();
    expect(h.drive.state.submissions).toHaveLength(0);
  });

  it('a landing re-renders only the region holding the reply — others survive by reference', async () => {
    const h = harness();
    const drive = h.app as unknown as {
      openThread(id: string, origin: { from: 'feed' } | { from: 'pane'; ci: number }): void;
    };
    const P1 = 'a'.repeat(64);
    const P2 = 'd'.repeat(64);
    drive.openThread(P1, { from: 'feed' });
    drive.openThread(P2, { from: 'pane', ci: 0 });
    await flush();
    const panes = h.panes;
    expect(panes.querySelectorAll('.region').length).toBe(2);
    const region2Before = panes.querySelectorAll('.region')[1];

    // A reply under P1's thread lands through the poll.
    await h.drive.submitComposer(P1, 'a reply');
    await h.drive.pollTick();

    // The reply's region was re-rendered, but the unrelated region survived by
    // reference — a landing must not replace the DOM of a surface it does not touch.
    expect(panes.querySelectorAll('.region')[1]).toBe(region2Before);
    expect(h.drive.state.submissions[0]!.stage).toBe('landed');
  });
});

describe('the App write surface — like and reads', () => {
  it('likePost marks the target liked at once and lands a like entry', async () => {
    const h = harness();
    await h.drive.likePost('cc'.repeat(32));
    expect(h.drive.optimisticLikes.has('cc'.repeat(32))).toBe(true);
    expect(h.ledger.all().map((e) => e.kind)).toEqual(['like']);
  });

  it('every read carries the viewer once an identity is loaded', async () => {
    const h = harness();
    await h.drive.loadFeed();
    expect(h.feedViewers.every((v) => v === PUB)).toBe(true);
    expect(h.feedViewers.length).toBeGreaterThan(0);
  });
});

describe('the App write surface — transport failures end cleanly', () => {
  it('a submit that throws ends the flight as rejected, never stuck submitting', async () => {
    const h = harness({ submit: true });
    await h.drive.submitComposer(null, 'a thread');
    const sub = h.drive.state.submissions[0]!;
    expect(sub.stage).toBe('rejected');
    expect(sub.reason).toBe("can't reach the node right now.");
    expect(h.ledger.size).toBe(0);
  });

  it('a like that throws leaves no like optimistic', async () => {
    const h = harness({ like: true });
    await h.drive.likePost('cc'.repeat(32));
    expect(h.drive.optimisticLikes.has('cc'.repeat(32))).toBe(false);
    expect(h.ledger.size).toBe(0);
  });

  it('the poll survives a failed read and keeps its cadence', async () => {
    const h = harness({ currentBlock: true });
    await h.drive.submitComposer(null, 'a thread'); // succeeds; only currentBlock throws
    expect(h.ledger.size).toBe(1);
    await expect(h.drive.pollTick()).resolves.toBeUndefined(); // no unhandled rejection
    expect(h.ledger.size).toBe(1); // nothing reconciled, the entry stands
  });
});
