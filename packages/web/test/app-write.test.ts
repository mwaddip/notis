// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import type { Api } from '../src/api/client';
import type { AppIdentity } from '../src/model/state';
import type { WriteClient } from '../src/api/write';
import type { AppState } from '../src/model/state';
import type { KarmaResult, PostResult, StatusResult, FeedResult, BlockCurrent } from '../src/api/dto';
import { karmaResult } from './karma-fixture';

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
    likeCount: 0, descendantCount: 0, authorName: null, likedByViewer, confirmedAuthor: AUTHOR,
  };
}

interface Harness {
  app: App;
  ledger: PendingLedger;
  panes: HTMLElement;
  drive: {
    submitComposer(parentId: string | null, text: string): Promise<void>;
    openComposer(parentId: string | null): void;
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
  setLocked(v: boolean): void;
}

/** The composer's onSubmit is what fires the flow in production; a test that
 *  starts from submitComposer alone bypasses the composer and its collapse
 *  hook. Open the composer first, then submit — the natural user path. No
 *  setTimeout: it would hang under `vi.useFakeTimers()`. openComposer's
 *  fire-and-forget affordability read is not on submitComposer's path. */
async function post(h: Harness, parentId: string | null, text: string): Promise<void> {
  h.drive.openComposer(parentId);
  await h.drive.submitComposer(parentId, text);
}

interface ThrowOpts {
  submit?: boolean;
  like?: boolean;
  currentBlock?: boolean;
  karma?: boolean;
  /** post returns confirmedAuthor: null — a reply's parent that never confirmed. */
  noConfirmedAuthor?: boolean;
  /** post throws — a transport failure BEFORE the sign happens. */
  postThrows?: boolean;
  /** karma returns a spendable view below the thread's price — an
   *  InsufficientKarma rejection BEFORE the sign happens. */
  lowKarma?: boolean;
  /** Steer the fake signer for the notSigned tests. Absent is a plain success. */
  sign?: { kind: 'locked' | 'declined' | 'refused' | 'never'; reason?: string };
}

function harness(thrown: ThrowOpts = {}): Harness {
  const signCalls: string[] = [];
  const identity: AppIdentity = {
    current: () => ({ pubKeyHex: PUB, locked }),
    sign: async (_bytes, t) => {
      signCalls.push(t);
      if (thrown.sign?.kind === 'locked') return { locked: true };
      if (thrown.sign?.kind === 'declined') return { declined: true };
      if (thrown.sign?.kind === 'refused') return { refused: thrown.sign.reason ?? 'refused' };
      if (thrown.sign?.kind === 'never') return await new Promise(() => {}); // hangs forever
      return { signature: 'ab'.repeat(64) };
    },
    draft: async () => ({ pubKeyHex: PUB }),
    create: async () => ({ pubKeyHex: PUB }),
    discardDraft: () => {},
    inspectFile: async () => ({ kind: 'clear', pubKeyHex: PUB }),
    importFile: async () => ({ pubKeyHex: PUB }),
    exportFile: async () => '{}',
    unlock: async () => { locked = false; },
    lock: () => { locked = true; },
    forget: () => {},
    backedUp: () => false,
    onChange: () => {},
  };
  const last = (): string => signCalls[signCalls.length - 1]!;
  const feedViewers: Array<string | undefined> = [];
  let blockHeight = 6001;
  let liked = false;
  let locked = false;

  const karma: KarmaResult = thrown.lowKarma
    ? karmaResult({ userId: PUB, total: '4', effective: '4', boxes: [{ boxId: BOX, value: '4' }], boxCount: 1, height: 6000 })
    : karmaResult({ userId: PUB, total: '227', effective: '227', boxes: [{ boxId: BOX, value: '227' }], boxCount: 1, height: 6000 });
  const fakeApi: Api = {
    feed: async (_p, viewer): Promise<FeedResult> => { feedViewers.push(viewer); return { posts: [], next: null, pending: [], pendingCount: 0 }; },
    thread: async () => null,
    post: async (id) => {
      if (thrown.postThrows) throw new Error('node unreachable');
      const p = confirmedPost(id, liked);
      if (thrown.noConfirmedAuthor) return { ...p, confirmedAuthor: null };
      return p;
    },
    status: async () => statusResult(),
    currentBlock: async (): Promise<BlockCurrent> => {
      if (thrown.currentBlock) throw new Error('node unreachable');
      return { height: blockHeight, hash: null };
    },
    karma: async () => {
      if (thrown.karma) throw new Error('node unreachable');
      return karma;
    },
    vouchesByTarget: async () => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async () => ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async () => ({ cooldowns: [], count: 0, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async () => null,
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

  const ledger = new PendingLedger(PUB);
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
    setLocked: (v) => { locked = v; },
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
    await post(h, null, 'a new thread');
    expect(h.drive.state.submissions).toHaveLength(1);
    const sub = h.drive.state.submissions[0]!;
    expect(sub).toMatchObject({ parentId: null, author: PUB, stage: 'submitted', postId: 'newpost' });
    expect(h.ledger.all().map((e) => e.kind)).toEqual(['post']);
    expect(h.drive.pollTimer).not.toBeNull();
  });

  it('a locked post unlocks in the foot and posts the current draft, edits and all', async () => {
    const h = harness();
    h.setLocked(true);
    (h.app as unknown as { openComposer(p: string | null): void }).openComposer(null);
    await flush();
    const composer = (h.drive.composers as Map<string, { el: HTMLElement }>).get('@feed')!;
    const ta = composer.el.querySelector('.composer-text') as HTMLTextAreaElement;
    ta.value = 'first draft';
    await h.drive.submitComposer(null, ta.value);
    // No submission yet — the composer foot holds the unlock form, draft intact.
    expect(h.drive.state.submissions).toHaveLength(0);
    const form = composer.el.querySelector('form.pf') as HTMLFormElement;
    expect(form).not.toBeNull();
    // The reader edits the draft while the unlock form is open.
    ta.value = 'edited while unlocking';
    (form.querySelector('input[type="password"]') as HTMLInputElement).value = 'pw';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    // Unlocked — the flight posts the CURRENT draft, not the stale captured text.
    expect(h.drive.state.submissions).toHaveLength(1);
    expect(h.drive.state.submissions[0]!.stage).toBe('submitted');
    expect(h.drive.state.submissions[0]!.content).toBe('edited while unlocking');
    expect(h.ledger.all().map((e) => e.kind)).toEqual(['post']);
  });

  it('the bounded poll lands the submission on a height change and stops at zero', async () => {
    vi.useFakeTimers();
    const h = harness();
    await post(h, null, 'a new thread');
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
    await post(h, null, 'a new thread');
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
    await post(h, P1, 'a reply');
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
    await post(h, null, 'a thread');
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
    await post(h, null, 'a thread'); // succeeds; only currentBlock throws
    expect(h.ledger.size).toBe(1);
    await expect(h.drive.pollTick()).resolves.toBeUndefined(); // no unhandled rejection
    expect(h.ledger.size).toBe(1); // nothing reconciled, the entry stands
  });

  it('a failed karma read on open shows the reason in the composer foot', async () => {
    const h = harness({ karma: true });
    (h.app as unknown as { openComposer(p: string | null): void }).openComposer(null);
    await flush(); // let the fire-and-forget affordability read settle
    const ctrl = (h.drive.composers as Map<string, { el: HTMLElement }>).get('@feed')!;
    expect(ctrl.el.querySelector('.karma')?.textContent).toBe("can't read your rep right now");
  });
});

// The fourth ending — the composer is still open with its text, no hollow card
// exists while sign is unresolved, and every other write undoes its optimistic
// state (WEB_INTERFACE → The wallet).
describe('the App write surface — the notSigned arm', () => {
  const composer = (h: Harness): { el: HTMLElement; text: () => string } | undefined => {
    return (h.drive.composers as Map<string, { el: HTMLElement; text: () => string }>).get('@feed');
  };

  it('declined: the composer stays open with its text, the foot reads "not sent."', async () => {
    const h = harness({ sign: { kind: 'declined' } });
    h.drive.openComposer(null);
    const ctrl = composer(h)!;
    (ctrl.el.querySelector('.composer-text') as HTMLTextAreaElement).value = 'draft that never sent';
    await h.drive.submitComposer(null, 'draft that never sent');
    // No hollow card pushed; composer still present with its text.
    expect(h.drive.state.submissions).toHaveLength(0);
    expect(composer(h)).toBeDefined();
    expect((composer(h)!.el.querySelector('.composer-text') as HTMLTextAreaElement).value).toBe('draft that never sent');
    expect(composer(h)!.el.querySelector('.karma')?.textContent).toBe('post not sent.');
  });

  it('refused: the composer stays open, the foot names the reason (or "one approval at a time." for busy)', async () => {
    const h = harness({ sign: { kind: 'refused', reason: 'busy' } });
    h.drive.openComposer(null);
    await h.drive.submitComposer(null, 'draft');
    expect(h.drive.state.submissions).toHaveLength(0);
    expect(composer(h)!.el.querySelector('.karma')?.textContent).toBe('one approval at a time.');
  });

  it('locked: the composer stays open and the unlock form takes its foot', async () => {
    const h = harness({ sign: { kind: 'locked' } });
    h.drive.openComposer(null);
    (composer(h)!.el.querySelector('.composer-text') as HTMLTextAreaElement).value = 'still here';
    await h.drive.submitComposer(null, 'still here');
    expect(h.drive.state.submissions).toHaveLength(0);
    expect(composer(h)!.el.querySelector('form.pf')).not.toBeNull();
  });

  it('no hollow card exists while sign is unresolved', async () => {
    const h = harness({ sign: { kind: 'never' } });
    h.drive.openComposer(null);
    // Fire the flow without awaiting — the sign will hang forever.
    void h.drive.submitComposer(null, 'a thread');
    await flush();
    // The composer is still present; no submission pushed.
    expect(h.drive.state.submissions).toHaveLength(0);
    expect(composer(h)).toBeDefined();
  });

  it('try again → expired on notSigned; the card holds the action', async () => {
    // First run: succeed, then set the submission to expired to prepare try-again.
    const h = harness();
    await post(h, null, 'a thread');
    const sub = h.drive.state.submissions[0]!;
    sub.stage = 'expired';
    sub.expiresAtHeight = 6720;
    // Now steer the signer into a decline, run tryAgain, and observe the card
    // returns to expired (not rejected).
    const tryAgain = (h.app as unknown as { tryAgain(key: string): Promise<void> }).tryAgain.bind(h.app);
    // Swap the identity's sign to return declined for this run.
    const idm = (h.app as unknown as { idm: AppIdentity }).idm;
    const originalSign = idm.sign.bind(idm);
    idm.sign = async () => ({ declined: true });
    try {
      await tryAgain(sub.localKey);
    } finally {
      idm.sign = originalSign;
    }
    expect(sub.stage).toBe('expired');
  });

  it('like: notSigned undoes the optimistic like and reports "like not sent."', async () => {
    const target = 'cc'.repeat(32);
    // Place the target in the feed so setReportForPost has a surface to write to.
    const h = harness({ sign: { kind: 'declined' } });
    h.drive.state.feed.posts = [
      { ...confirmedPost(target), id: target, likedByViewer: false } as unknown as (typeof h.drive.state.feed.posts)[number],
    ];
    await h.drive.likePost(target);
    expect(h.drive.optimisticLikes.has(target)).toBe(false);
    expect(h.ledger.size).toBe(0);
    expect(h.drive.state.feed.report).toBe('like not sent.');
  });

  it('like: locked reports "your key is locked" on the feed', async () => {
    const target = 'cc'.repeat(32);
    const h = harness({ sign: { kind: 'locked' } });
    h.drive.state.feed.posts = [
      { ...confirmedPost(target), id: target, likedByViewer: false } as unknown as (typeof h.drive.state.feed.posts)[number],
    ];
    await h.drive.likePost(target);
    expect(h.drive.optimisticLikes.has(target)).toBe(false);
    expect(h.ledger.size).toBe(0);
    expect(h.drive.state.feed.report).toBe('your key is locked');
  });

  // A rejection or a transport failure BEFORE the sign leaves submission === null
  // in submitComposer — onSigned never fired. The composer is still open with its
  // text and its foot names the reason; nothing was spent (WEB_INTERFACE →
  // The wallet).
  it('a reply to a parent with no confirmed author returns the composer with the reason', async () => {
    const h = harness({ noConfirmedAuthor: true });
    const parent = 'dd'.repeat(32);
    h.drive.openComposer(parent);
    const ctrl = composer(h) ?? (h.drive.composers as Map<string, { el: HTMLElement }>).get(parent);
    (ctrl!.el.querySelector('.composer-text') as HTMLTextAreaElement).value = 'a reply';
    await h.drive.submitComposer(parent, 'a reply');
    expect(h.drive.state.submissions).toHaveLength(0);
    // The composer under the parent key is still present with its text.
    const still = (h.drive.composers as Map<string, { el: HTMLElement }>).get(parent);
    expect(still).toBeDefined();
    expect((still!.el.querySelector('.composer-text') as HTMLTextAreaElement).value).toBe('a reply');
    expect(still!.el.querySelector('.karma')?.textContent).toBe('that post has no confirmed author to reply under.');
  });

  it('an InsufficientKarma rejection at build time returns the composer with the reason', async () => {
    const h = harness({ lowKarma: true });
    h.drive.openComposer(null);
    (composer(h)!.el.querySelector('.composer-text') as HTMLTextAreaElement).value = 'draft';
    await h.drive.submitComposer(null, 'draft');
    expect(h.drive.state.submissions).toHaveLength(0);
    expect(composer(h)).toBeDefined();
    expect(composer(h)!.el.querySelector('.karma')?.textContent).toBe('not enough rep to post right now.');
  });

  it('a transport failure before the sign returns the composer with the node line', async () => {
    // A reply — post throws before the sign runs. The composer stays open.
    const h = harness({ postThrows: true });
    const parent = 'dd'.repeat(32);
    h.drive.openComposer(parent);
    const ctrl = (h.drive.composers as Map<string, { el: HTMLElement }>).get(parent)!;
    (ctrl.el.querySelector('.composer-text') as HTMLTextAreaElement).value = 'a reply';
    await h.drive.submitComposer(parent, 'a reply');
    expect(h.drive.state.submissions).toHaveLength(0);
    const still = (h.drive.composers as Map<string, { el: HTMLElement }>).get(parent);
    expect(still).toBeDefined();
    expect(still!.el.querySelector('.karma')?.textContent).toBe("can't reach the node right now.");
  });

  it("refused strips a trailing period from the reason so \"characters.\" does not render as \"characters..\"", async () => {
    const h = harness({ sign: { kind: 'refused', reason: 'a transaction id to sign must be 64 hex characters.' } });
    h.drive.openComposer(null);
    (composer(h)!.el.querySelector('.composer-text') as HTMLTextAreaElement).value = 'x';
    await h.drive.submitComposer(null, 'x');
    expect(composer(h)!.el.querySelector('.karma')?.textContent)
      .toBe('post not sent: a transaction id to sign must be 64 hex characters.');
  });
});
