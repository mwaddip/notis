// @vitest-environment happy-dom
// The App's three thread reads under the extension's resolver (WEB_INTERFACE
// → The extension → "The light read", → "The resolve"): `fetchThread`,
// `refreshThread` and `threadMore` ask `light=1` and never `tx`, `intake`
// composes rows from the cache, `resolveSlots` reaches each thread, and
// `endSlots` sets the subject's withheld state and the thread's unbound
// count. With no resolver the three reads ask as at the tip.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PendingLedger } from '../src/wallet/ledger';
import type { PostCache, PostsVerifier } from '../src/model/state';
import type { PostCheck } from '@dagsocial/nipopow-client';
import type { PostJson, PostResult, ThreadResult } from '../src/api/dto';
import {
  ME, flush, settle, hid, fullRow, light, tomb,
  testResolver, makeCache, harness, seedCache,
} from './app-light-shared';

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function threadRes(over: Partial<ThreadResult> & { post: ThreadResult['post'] }): ThreadResult {
  return {
    post: over.post,
    ancestors: over.ancestors ?? [],
    ancestorCount: over.ancestorCount ?? (over.ancestors?.length ?? 0),
    descendants: over.descendants ?? [],
    descendantCount: over.descendantCount ?? (over.descendants?.length ?? 0),
    next: over.next ?? null,
    pending: over.pending ?? [],
    pendingCount: over.pendingCount ?? (over.pending?.length ?? 0),
  };
}

// ---------------------------------------------------------------------------
// A cold thread: one request, light=1 and no tx; slots at the depth each
// parentRefs gives; after the landing cards at the same depth, in the same
// order; the App called no `check`.
// ---------------------------------------------------------------------------
describe('a cold thread reads light and fills from the resolver', () => {
  it('one light request, no tx; slots at depths from parentRefs; cards after onBound; the verifier is never called', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const checked: unknown[][] = [];
    // A verifier that would count every check call; a thread's light reads
    // never pass rows through it (WEB_INTERFACE → The extension → "The
    // light read" → "A list read brings no bytes and is not checked").
    const verifier: PostsVerifier = { check: (rows) => { checked.push(rows); return rows.map(() => ({ status: 'nothing-to-bind' } as PostCheck)); } };
    const root = light('r');                                           // depth 0
    const reply = light('a', { parentRefs: [hid('r')] });              // depth 1
    const nested = light('b', { parentRefs: [hid('a')] });             // depth 2
    const h = harness({
      resolver: r.resolver, cache, verifier,
      threadResults: [threadRes({ post: root, descendants: [reply, nested] })],
    });
    h.drive.openThread(hid('r'), { from: 'feed' });
    await settle();
    expect(h.fake.threadCalls.length).toBe(1);
    expect(h.fake.threadCalls[0]!.light).toBe(true);
    expect(h.fake.threadCalls[0]!.url).toContain('light=1');
    expect(h.fake.threadCalls[0]!.url).not.toContain('tx=1');
    // The subject and both descendants stand as slots at their depths —
    // the root carries no depth class, a reply `depth-1`, a nested reply
    // `depth-2` (`src/view/card.ts`'s shellClasses).
    const slots = h.panes.querySelectorAll<HTMLElement>('.card.slot');
    expect(slots.length).toBe(3);
    expect(slots[0]!.dataset['postId']).toBe(root.id);
    expect(slots[1]!.dataset['postId']).toBe(reply.id);
    expect(slots[2]!.dataset['postId']).toBe(nested.id);
    expect(slots[0]!.classList.contains('depth-1')).toBe(false);
    expect(slots[0]!.classList.contains('depth-2')).toBe(false);
    expect(slots[1]!.classList.contains('depth-1')).toBe(true);
    expect(slots[2]!.classList.contains('depth-2')).toBe(true);
    // Resolve all three in one call, in listing order.
    expect(r.calls.length).toBe(1);
    expect(r.calls[0]!.ids.sort()).toEqual([root.id, reply.id, nested.id].sort());
    const fr = fullRow('r');
    const fa = fullRow('a', { parentRefs: [hid('r')] });
    const fb = fullRow('b', { parentRefs: [hid('a')] });
    r.calls[0]!.bound([fr, fa, fb]);
    r.calls[0]!.end({});
    await settle();
    // No slot stands; cards are the three composed posts in the same order,
    // each at the depth its slot carried.
    expect(h.panes.querySelectorAll('.card.slot').length).toBe(0);
    const cards = h.panes.querySelectorAll<HTMLElement>('[data-post-id]');
    expect(cards.length).toBe(3);
    expect(cards[0]!.dataset['postId']).toBe(fr.id);
    expect(cards[1]!.dataset['postId']).toBe(fa.id);
    expect(cards[2]!.dataset['postId']).toBe(fb.id);
    expect(cards[0]!.classList.contains('depth-1')).toBe(false);
    expect(cards[0]!.classList.contains('depth-2')).toBe(false);
    expect(cards[1]!.classList.contains('depth-1')).toBe(true);
    expect(cards[2]!.classList.contains('depth-2')).toBe(true);
    // The verifier was never asked (no post rows carry bytes on a light
    // read); `checked` tracks every check call.
    expect(checked.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A thread whose rows the cache holds whole: one request, no resolve call,
// cards at once under the listing's counts.
// ---------------------------------------------------------------------------
describe('a thread the cache holds whole draws at once', () => {
  it('one request; no resolve call; cards show the listing counts', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const fr = fullRow('r');
    const fa = fullRow('a', { parentRefs: [hid('r')] });
    await seedCache(cache, [fr, fa]);
    const lr = light('r', { likeCount: 5, descendantCount: 1, authorName: null });
    const la = light('a', { parentRefs: [hid('r')], likeCount: 2, descendantCount: 0, authorName: 'bob' });
    const h = harness({
      resolver: r.resolver, cache,
      threadResults: [threadRes({ post: lr, descendants: [la] })],
    });
    h.drive.openThread(hid('r'), { from: 'feed' });
    await settle();
    expect(h.fake.threadCalls.length).toBe(1);
    expect(h.fake.threadCalls[0]!.light).toBe(true);
    expect(r.calls.length).toBe(0);
    const t = h.drive.state.threads.get(hid('r'))!;
    // Both rows carry the listing's figures.
    expect((t.root as PostJson).likeCount).toBe(5);
    expect((t.root as PostJson).descendantCount).toBe(1);
    expect((t.descendants[0] as PostJson).likeCount).toBe(2);
    expect((t.descendants[0] as PostJson).authorName).toBe('bob');
    // No slot stands in the pane.
    expect(h.panes.querySelectorAll('.card.slot').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A thread half held asks only for the half the cache lacked.
// ---------------------------------------------------------------------------
describe('a thread half held asks only for the other half', () => {
  it('cache holds the subject; the resolver is asked for the descendant alone', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const fr = fullRow('r');
    await seedCache(cache, [fr]);
    const lr = light('r');
    const la = light('a', { parentRefs: [hid('r')] });
    const h = harness({
      resolver: r.resolver, cache,
      threadResults: [threadRes({ post: lr, descendants: [la] })],
    });
    h.drive.openThread(hid('r'), { from: 'feed' });
    await settle();
    expect(r.calls.length).toBe(1);
    expect(r.calls[0]!.ids).toEqual([la.id]);
  });
});

// ---------------------------------------------------------------------------
// Ancestors and pending are not resolved — the resolver is asked for the
// subject's and the descendants' ids and no other.
// ---------------------------------------------------------------------------
describe('ancestors and pending are not resolved', () => {
  it('resolver asked for subject and descendants only; ancestors give ancestorIds, pending gives nothing', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const subject = light('s');
    const ancestor = light('an');
    const descendant = light('d', { parentRefs: [hid('s')] });
    const pending = light('p');
    const h = harness({
      resolver: r.resolver, cache,
      threadResults: [threadRes({
        post: subject,
        ancestors: [ancestor],
        ancestorCount: 1,
        descendants: [descendant],
        pending: [pending],
      })],
    });
    h.drive.openThread(hid('s'), { from: 'feed' });
    await settle();
    expect(r.calls.length).toBe(1);
    expect(r.calls[0]!.ids.sort()).toEqual([subject.id, descendant.id].sort());
    const t = h.drive.state.threads.get(hid('s'))!;
    // ancestorIds gets the ancestor's id; pending leaves no state.
    expect([...t.ancestorIds]).toEqual([ancestor.id]);
    expect(t.descendantCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A subject that ends 'unserved': no row, muted line (.hint.unserved), no
// clay line. The line reads *no node can serve this post yet.* — the
// subject found a resolve that no node served (WEB_INTERFACE → The
// extension → "The post check" → "A thread whose subject ends so").
// ---------------------------------------------------------------------------
describe('a subject that ends unserved renders the muted line and no row', () => {
  it('subject slot unserved: root is null, subjectWithheld is unserved, pane shows the line and its words', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const ls = light('s');
    const h = harness({
      resolver: r.resolver, cache,
      threadResults: [threadRes({ post: ls })],
    });
    h.drive.openThread(hid('s'), { from: 'feed' });
    await settle();
    r.calls[0]!.end({ [ls.id]: 'unserved' });
    await settle();
    const t = h.drive.state.threads.get(hid('s'))!;
    expect(t.root).toBeNull();
    expect(t.subjectWithheld).toBe('unserved');
    const line = h.panes.querySelector('.hint.unserved');
    expect(line).not.toBeNull();
    expect(line!.textContent).toBe('no node can serve this post yet.');
    expect(h.panes.querySelector('.withheld')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A subject that ends 'unbound': no row, clay line *1 post withheld — it
// does not match its signature*; a ↻ asks for the subject again.
// ---------------------------------------------------------------------------
describe('a subject that ends unbound renders the clay line and no row', () => {
  it('subject slot unbound: root null, subjectWithheld unbound, pane shows the clay line; ↻ asks for the subject again', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const ls = light('s');
    const h = harness({
      resolver: r.resolver, cache,
      threadResults: [
        threadRes({ post: ls }),
        // The ↻ reads the thread again; the subject is listed once more.
        threadRes({ post: ls }),
      ],
    });
    h.drive.openThread(hid('s'), { from: 'feed' });
    await settle();
    r.calls[0]!.end({ [ls.id]: 'unbound' });
    await settle();
    const t = h.drive.state.threads.get(hid('s'))!;
    expect(t.root).toBeNull();
    expect(t.subjectWithheld).toBe('unbound');
    expect(t.unboundCount).toBe(1);
    const line = h.panes.querySelector('.withheld');
    expect(line?.textContent).toBe('1 post withheld — it does not match its signature');
    // A ↻ asks for the subject again — resolving was cleared when the end
    // landed, so the next first page lists the slot and the resolver is
    // asked again.
    await h.drive.refreshThread(hid('s'));
    await settle();
    expect(r.calls.length).toBe(2);
    expect(r.calls[1]!.ids).toEqual([ls.id]);
  });
});

// ---------------------------------------------------------------------------
// A descendant that ends 'unserved': leaves the thread, no line.
// ---------------------------------------------------------------------------
describe('a descendant that ends unserved leaves no line', () => {
  it('one unserved descendant: it leaves t.descendants, no clay line, unboundCount stays 0', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const lr = light('r');
    const ld = light('d', { parentRefs: [hid('r')] });
    const h = harness({
      resolver: r.resolver, cache,
      threadResults: [threadRes({ post: lr, descendants: [ld] })],
    });
    h.drive.openThread(hid('r'), { from: 'feed' });
    await settle();
    r.calls[0]!.bound([fullRow('r')]);
    r.calls[0]!.end({ [ld.id]: 'unserved' });
    await settle();
    const t = h.drive.state.threads.get(hid('r'))!;
    expect(t.descendants.length).toBe(0);
    expect(t.unboundCount).toBe(0);
    expect(h.panes.querySelector('.withheld')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A descendant that ends 'unbound': leaves, the clay line stands at the
// thread's head; a reply beneath it still stands, attached under the root
// by `flattenThread`.
// ---------------------------------------------------------------------------
describe('a descendant that ends unbound leaves the clay line at the thread head', () => {
  it('unbound descendant: leaves descendants, unboundCount is 1, the pane shows the clay line; a reply beneath it still renders', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const lr = light('r');
    const ld = light('d', { parentRefs: [hid('r')] });
    const lx = light('x', { parentRefs: [hid('d')] });
    const h = harness({
      resolver: r.resolver, cache,
      threadResults: [threadRes({ post: lr, descendants: [ld, lx] })],
    });
    h.drive.openThread(hid('r'), { from: 'feed' });
    await settle();
    r.calls[0]!.bound([fullRow('r'), fullRow('x', { parentRefs: [hid('d')] })]);
    r.calls[0]!.end({ [ld.id]: 'unbound' });
    await settle();
    const t = h.drive.state.threads.get(hid('r'))!;
    // The descendant left; the reply beneath it still stands.
    expect(t.descendants.map((d) => d.id)).toEqual([lx.id]);
    expect(t.unboundCount).toBe(1);
    const line = h.panes.querySelector('.withheld');
    expect(line?.textContent).toBe('1 post withheld — it does not match its signature');
    // The reply's card renders — attached under the root by flattenThread.
    const reply = h.panes.querySelector<HTMLElement>(`[data-post-id="${lx.id}"]`);
    expect(reply).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A placeholder subject at the end — content: null — is a card reading
// *content not on this node yet*.
// ---------------------------------------------------------------------------
describe('a placeholder subject at the end is a card reading content not on this node yet', () => {
  it('the subject becomes a card with the absent-content line; the cache entry has no text', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const ls = light('s');
    const h = harness({
      resolver: r.resolver, cache,
      threadResults: [threadRes({ post: ls })],
    });
    h.drive.openThread(hid('s'), { from: 'feed' });
    await settle();
    const fs = fullRow('s', { content: null });
    r.calls[0]!.bound([fs]);
    r.calls[0]!.end({});
    await settle();
    const card = h.panes.querySelector<HTMLElement>(`[data-post-id="${fs.id}"]`);
    expect(card).not.toBeNull();
    expect(card!.classList.contains('slot')).toBe(false);
    expect(card!.querySelector('.card-absent')?.textContent).toBe('content not on this node yet');
  });
});

// ---------------------------------------------------------------------------
// A ↻ over three pages resolves once: one resolve call carrying every slot's
// id; its report reads as at the tip.
// ---------------------------------------------------------------------------
describe('a ↻ over three pages resolves once', () => {
  it('three pages: one resolve call with every slot id; the report reads as at the tip', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const lr = light('r');
    const la = light('a', { parentRefs: [hid('r')] });
    const lb = light('b', { parentRefs: [hid('r')] });
    const lc = light('c', { parentRefs: [hid('r')] });
    const h = harness({
      resolver: r.resolver, cache,
      threadResults: [
        // fetchThread
        threadRes({ post: lr, descendants: [la], descendantCount: 3, next: null }),
        // refreshThread page 1
        threadRes({ post: lr, descendants: [la], descendantCount: 3, next: 'p1' }),
        // page 2
        threadRes({ post: lr, descendants: [lb], descendantCount: 3, next: 'p2' }),
        // page 3
        threadRes({ post: lr, descendants: [lc], descendantCount: 3, next: null }),
      ],
    });
    h.drive.openThread(hid('r'), { from: 'feed' });
    await settle();
    // The first fetch asked for subject + a.
    expect(r.calls.length).toBe(1);
    expect(r.calls[0]!.ids.sort()).toEqual([lr.id, la.id].sort());
    r.calls[0]!.bound([fullRow('r'), fullRow('a', { parentRefs: [hid('r')] })]);
    r.calls[0]!.end({});
    await settle();
    // ↻ reads three pages; one resolve call after they land.
    await h.drive.refreshThread(hid('r'));
    await settle();
    // Three thread calls (one per page) plus the fetch's one = 4 total.
    expect(h.fake.threadCalls.length).toBe(4);
    // The refresh landed with lr composed from the cache (so no new slot
    // for lr) and lb, lc as the only slots standing.
    expect(r.calls.length).toBe(2);
    expect(r.calls[1]!.ids.sort()).toEqual([lb.id, lc.id].sort());
  });
});

// ---------------------------------------------------------------------------
// `more` appends slots and fills them; a more whose cursor moved while its
// cache read was held writes nothing.
// ---------------------------------------------------------------------------
describe('threadMore appends slots and resolves them', () => {
  it('a more adds slots and asks the resolver for the new ids', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const lr = light('r');
    const la = light('a', { parentRefs: [hid('r')] });
    const lb = light('b', { parentRefs: [hid('r')] });
    const h = harness({
      resolver: r.resolver, cache,
      threadResults: [
        threadRes({ post: lr, descendants: [la], next: 'c1' }),
        threadRes({ post: lr, descendants: [lb], next: null }),
      ],
    });
    h.drive.openThread(hid('r'), { from: 'feed' });
    await settle();
    expect(r.calls.length).toBe(1);
    await h.drive.threadMore(hid('r'));
    await settle();
    const t = h.drive.state.threads.get(hid('r'))!;
    expect(t.descendants.map((d) => d.id)).toEqual([la.id, lb.id]);
    expect(r.calls.length).toBe(2);
    expect(r.calls[1]!.ids).toEqual([lb.id]);
  });

  it('a more whose cursor moved while its cache read was held writes nothing', async () => {
    const r = testResolver();
    const { cache: realCache } = makeCache();
    await realCache.open('C');
    const lr = light('r');
    const la = light('a', { parentRefs: [hid('r')] });
    const lb = light('b', { parentRefs: [hid('r')] });
    // Hold the next getMany after arming — threadMore's intake suspends.
    let holdNext = false;
    let heldRelease: (() => void) | null = null;
    const cache: PostCache = {
      open: realCache.open.bind(realCache),
      put: realCache.put.bind(realCache),
      withdraw: realCache.withdraw.bind(realCache),
      thread: realCache.thread.bind(realCache),
      refresh: realCache.refresh.bind(realCache),
      getMany: async (ids) => {
        const answer = await realCache.getMany(ids);
        if (!holdNext) return answer;
        holdNext = false;
        await new Promise<void>((resolve) => { heldRelease = resolve; });
        heldRelease = null;
        return answer;
      },
    };
    const h = harness({
      resolver: r.resolver, cache,
      threadResults: [
        threadRes({ post: lr, descendants: [la], next: 'c1' }),
        threadRes({ post: lr, descendants: [lb], next: 'c2' }),
      ],
    });
    h.drive.openThread(hid('r'), { from: 'feed' });
    await settle();
    const t = h.drive.state.threads.get(hid('r'))!;
    expect(t.next).toBe('c1');
    holdNext = true;
    const morePromise = h.drive.threadMore(hid('r'));
    while (heldRelease === null) await flush();
    // Move the cursor while the intake is held.
    t.next = 'moved';
    const release = heldRelease as () => void;
    release();
    await morePromise;
    await settle();
    // The row from the held page is not appended; t.next stays 'moved'.
    expect(t.descendants.map((d) => d.id)).toEqual([la.id]);
    expect(t.next).toBe('moved');
  });
});

// ---------------------------------------------------------------------------
// One resolve serves every list: an id standing as a slot in the feed and
// in an open thread is asked once and becomes a card in both; an unbound
// end of it is counted at the head of each.
// ---------------------------------------------------------------------------
describe('one resolve serves every list', () => {
  it('id in the feed and in a thread: one resolve call, both lists see the card', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const ls = light('s');
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [{ posts: [ls], next: null, pending: [], pendingCount: 0 }],
      threadResults: [threadRes({ post: ls })],
    });
    await h.drive.loadFeed();
    await settle();
    expect(r.calls.length).toBe(1);
    // Open the thread — intake sees the slot still waiting; resolveSlots
    // claims nothing new (the id is already in `resolving`).
    h.drive.openThread(hid('s'), { from: 'feed' });
    await settle();
    expect(r.calls.length).toBe(1);
    // The resolve lands — feed and thread both become cards.
    const fs = fullRow('s');
    r.calls[0]!.bound([fs]);
    r.calls[0]!.end({});
    await settle();
    const feedCard = h.feedEl.querySelector<HTMLElement>(`[data-post-id="${fs.id}"]`);
    const threadCard = h.panes.querySelector<HTMLElement>(`[data-post-id="${fs.id}"]`);
    expect(feedCard?.classList.contains('slot')).toBe(false);
    expect(threadCard?.classList.contains('slot')).toBe(false);
  });

  it('unbound end counted at the head of each list', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const ls = light('s');
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [{ posts: [ls], next: null, pending: [], pendingCount: 0 }],
      threadResults: [threadRes({ post: ls })],
    });
    await h.drive.loadFeed();
    await settle();
    h.drive.openThread(hid('s'), { from: 'feed' });
    await settle();
    r.calls[0]!.end({ [ls.id]: 'unbound' });
    await settle();
    expect(h.drive.state.feed.unboundCount).toBe(1);
    const t = h.drive.state.threads.get(hid('s'))!;
    expect(t.unboundCount).toBe(1);
    expect(t.subjectWithheld).toBe('unbound');
    expect(h.feedEl.querySelector('.withheld')?.textContent)
      .toBe('1 post withheld — it does not match its signature');
    expect(h.panes.querySelector('.withheld')?.textContent)
      .toBe('1 post withheld — it does not match its signature');
  });
});

// ---------------------------------------------------------------------------
// A thread read that throws: the error line over the cache's rows, no
// resolve call; the next ↻ that answers lands on them, and its slots
// resolve.
// ---------------------------------------------------------------------------
describe('a thread read that throws reads the cache and asks no resolve', () => {
  it('error over the cache rows; no resolve call; the next ↻ answers and its slots resolve', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    // Seed the cache with the subject and one descendant.
    const fr = fullRow('r');
    const fd = fullRow('d', { parentRefs: [hid('r')] });
    await seedCache(cache, [fr, fd]);
    const lr = light('r');
    const la = light('a', { parentRefs: [hid('r')] });
    const h = harness({
      resolver: r.resolver, cache,
      threadResults: [
        new Error('offline'),
        // The ↻ that answers; introduces a new slot.
        threadRes({ post: lr, descendants: [la] }),
      ],
    });
    h.drive.openThread(hid('r'), { from: 'feed' });
    await settle();
    const t = h.drive.state.threads.get(hid('r'))!;
    expect(t.error).not.toBeNull();
    // The cache's rows render beneath the error.
    expect(t.root!.id).toBe(fr.id);
    expect(r.calls.length).toBe(0);
    // The ↻ lands and the resolver is asked for the new descendant.
    await h.drive.refreshThread(hid('r'));
    await settle();
    expect(r.calls.length).toBe(1);
    expect(r.calls[0]!.ids).toEqual([la.id]);
  });
});

// ---------------------------------------------------------------------------
// A 404 reads *this post is gone.* and asks nothing.
// ---------------------------------------------------------------------------
describe('a 404 reads this post is gone and asks nothing', () => {
  it('a null thread answer: root is null, no error, no resolve call', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const h = harness({
      resolver: r.resolver, cache,
      threadResults: [null],
    });
    h.drive.openThread(hid('g'), { from: 'feed' });
    await settle();
    const t = h.drive.state.threads.get(hid('g'))!;
    expect(t.root).toBeNull();
    expect(t.error).toBeNull();
    expect(r.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A withdrawn row in a light page empties the held entry's text; a
// descendant draws as the withdrawn card at its depth.
// ---------------------------------------------------------------------------
describe('a withdrawn row in a light page empties the held entry', () => {
  it('withdrawn descendant and withdrawn ancestor: cache.withdraw fires for each; descendant draws as a withdrawn card', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    // Hold rows for both the descendant and the ancestor so withdraw's
    // "an id not held is nothing" rule doesn't bite.
    const fdesc = fullRow('d', { parentRefs: [hid('r')] });
    const fanc = fullRow('an');
    await seedCache(cache, [fdesc, fanc]);
    const lr = light('r');
    const wd = tomb('d');
    const wanc = tomb('an');
    const h = harness({
      resolver: r.resolver, cache,
      threadResults: [threadRes({ post: lr, descendants: [wd], ancestors: [wanc] })],
    });
    h.drive.openThread(hid('r'), { from: 'feed' });
    await settle();
    // The cache's two entries now carry a WithdrawnJson row.
    const dh = await cache.thread(fdesc.id);
    const ah = await cache.thread(fanc.id);
    expect(dh && 'kind' in dh.post && dh.post.kind === 'withdrawn').toBe(true);
    expect(ah && 'kind' in ah.post && ah.post.kind === 'withdrawn').toBe(true);
    // The descendant stands as a withdrawn card at its depth.
    const t = h.drive.state.threads.get(hid('r'))!;
    expect(t.descendants.length).toBe(1);
    expect('kind' in t.descendants[0]! && t.descendants[0]!.kind === 'withdrawn').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A landing after the list moved on, three sub-cases: window closed; node
// change; withdrawal landed on the subject.
// ---------------------------------------------------------------------------
describe('a landing after the list moved on', () => {
  it('after the thread window closed: nothing throws, nothing is drawn, state.threads is left as it is', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const ls = light('s');
    const h = harness({
      resolver: r.resolver, cache,
      threadResults: [threadRes({ post: ls })],
    });
    h.drive.openThread(hid('s'), { from: 'feed' });
    await settle();
    expect(r.calls.length).toBe(1);
    // Close the thread's window.
    (h.app as unknown as { closeWindow(id: string): void }).closeWindow(hid('s'));
    await settle();
    // The resolve answers — nothing drawn, nothing throws.
    const fs = fullRow('s');
    r.calls[0]!.bound([fs]);
    r.calls[0]!.end({});
    await settle();
    // No slot stands anywhere; no error raised. state.threads still holds
    // the entry (a closed thread's state is left as it is).
    expect(h.panes.querySelectorAll('.card.slot').length).toBe(0);
    expect(h.drive.state.threads.has(hid('s'))).toBe(true);
  });

  it('after a node change: no state is written, nothing enters the cache, the re-read asks the id again', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const ls = light('s');
    const h = harness({
      resolver: r.resolver, cache,
      threadResults: [
        threadRes({ post: ls }),
        // The node change clears state.threads and re-fetches every open
        // thread under the new generation; the re-read lists the slot
        // again and the resolver is asked for it.
        threadRes({ post: ls }),
      ],
    });
    h.drive.openThread(hid('s'), { from: 'feed' });
    await settle();
    expect(r.calls.length).toBe(1);
    await h.drive.changeNode('http://second');
    await settle();
    // The old resolve answers now — under the older gen; the id in it was
    // released from `resolving` on the gen change.
    const fs = fullRow('s');
    r.calls[0]!.bound([fs]);
    r.calls[0]!.end({});
    await settle();
    // Nothing landed in the cache for s under the current gen.
    const held = await cache.getMany([ls.id]);
    expect(held.size).toBe(0);
    // The re-read fetched the id and the new resolve was asked for it.
    expect(r.calls.length).toBe(2);
    expect(r.calls[1]!.ids).toEqual([ls.id]);
  });

  it('after a withdrawal landed on the subject: the withdrawn card stands', async () => {
    // The landing drives applyWithdrawLanding — a pending withdraw entry
    // in the ledger, the node answers the withdrawn row, pollTick fires
    // (WEB_INTERFACE → The withdraw control). A reply's drop writes the
    // withdrawn marker at its depth in every thread that holds it; the
    // resolve that answers bound after is skipped because withdrawnSeen
    // holds the id.
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const ls = light('s');
    const w = tomb('s');
    const h = harness({
      resolver: r.resolver, cache, identityKey: ME,
      threadResults: [threadRes({ post: ls })],
      postRes: w as unknown as PostResult,
    });
    h.drive.openThread(hid('s'), { from: 'feed' });
    await settle();
    const t0 = h.drive.state.threads.get(hid('s'))!;
    expect('kind' in t0.root! && t0.root.kind === 'light').toBe(true);
    const ledger = (h.app as unknown as { ledger: PendingLedger }).ledger;
    ledger.add({
      txId: hid('wd' + 's'),
      kind: 'withdraw',
      postId: ls.id,
      inputs: [],
      expiresAtHeight: 999,
      submittedAtHeight: 0,
    });
    await h.drive.pollTick();
    await settle();
    const t1 = h.drive.state.threads.get(hid('s'))!;
    expect(t1.root !== null && 'kind' in t1.root && t1.root.kind === 'withdrawn').toBe(true);
    const fs = fullRow('s');
    r.calls[0]!.bound([fs]);
    r.calls[0]!.end({});
    await settle();
    const t2 = h.drive.state.threads.get(hid('s'))!;
    expect(t2.root !== null && 'kind' in t2.root && t2.root.kind === 'withdrawn').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Every thread read of either build asks no `tx` — the web build (no
// verifier and no resolver) and the extension build (both). A list read
// brings no bytes and is not checked (WEB_INTERFACE → The extension → "The
// post check" → "A list read brings no bytes and is not checked").
// ---------------------------------------------------------------------------
describe('the three thread reads ask no tx in either build', () => {
  it('the web build: no light and no tx on fetchThread, refreshThread, threadMore', async () => {
    const h = harness({
      resolver: null, verifier: null, cache: null,
      threadResults: [
        threadRes({ post: fullRow('r'), descendants: [fullRow('a', { parentRefs: [hid('r')] })], next: 'c1' }),
        threadRes({ post: fullRow('r'), descendants: [], next: 'c2' }),
        threadRes({ post: fullRow('r'), descendants: [], next: null }),
      ],
    });
    h.drive.openThread(hid('r'), { from: 'feed' });
    await settle();
    await h.drive.refreshThread(hid('r'));
    await settle();
    await h.drive.threadMore(hid('r'));
    await settle();
    for (const call of h.fake.threadCalls) {
      expect(call.url).not.toContain('light=1');
      expect(call.url).not.toContain('tx=1');
    }
    expect(h.fake.threadCalls.length).toBeGreaterThanOrEqual(3);
  });

  it('the extension build: light and no tx on fetchThread, refreshThread, threadMore', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const h = harness({
      resolver: r.resolver, cache,
      threadResults: [
        threadRes({ post: light('r'), descendants: [light('a', { parentRefs: [hid('r')] })], next: 'c1' }),
        threadRes({ post: light('r'), descendants: [], next: 'c2' }),
        threadRes({ post: light('r'), descendants: [], next: null }),
      ],
    });
    h.drive.openThread(hid('r'), { from: 'feed' });
    await settle();
    // Settle the first resolve so the next read's claim is not blocked.
    r.calls[0]!.end({ [hid('r')]: 'unserved', [hid('a')]: 'unserved' });
    await settle();
    await h.drive.refreshThread(hid('r'));
    await settle();
    r.calls[r.calls.length - 1]!.end({});
    await settle();
    await h.drive.threadMore(hid('r'));
    await settle();
    for (const call of h.fake.threadCalls) {
      expect(call.url).toContain('light=1');
      expect(call.url).not.toContain('tx=1');
    }
    expect(h.fake.threadCalls.length).toBeGreaterThanOrEqual(3);
  });
});

