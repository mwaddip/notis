// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import { createPostCache } from '../src/extension/post-cache';
import type { Api } from '../src/api/client';
import type { AppIdentity, PostCache } from '../src/model/state';
import type { WriteClient } from '../src/api/write';
import type { FeedResult, PostJson, PostResult, StatusResult, BlockCurrent, ThreadResult } from '../src/api/dto';
import { isFull } from '../src/api/dto';
import {
  ME, fullRow, light, status as fakeStatus, stubVerifier, testResolver, flush, settle,
} from './app-light-shared';
import { karmaResult } from './karma-fixture';

// WEB_INTERFACE → What the feed reads, and what a card shows for it →
// "A row the reader opened under a card outlasts a redraw of its list"
// — a row held under the card the reader opened it from (that post, in
// that list), kept across the redraws of that list.

interface LockableIdentity {
  identity: AppIdentity;
  unlocks: string[];
  setLocked(b: boolean): void;
  notify(): void;
}

function lockableIdentity(key: string): LockableIdentity {
  const unlocks: string[] = [];
  const listeners: Array<(id: { pubKeyHex: string } | null) => void> = [];
  let locked = true;
  const id = {
    unlocks,
    setLocked(b: boolean): void { locked = b; },
    notify(): void { for (const l of listeners) l({ pubKeyHex: key }); },
    identity: {
      current: () => ({ pubKeyHex: key, locked }),
      sign: async () => ({ signature: '00' }),
      draft: async () => ({ pubKeyHex: key }),
      create: async () => ({ pubKeyHex: key }),
      discardDraft: () => {},
      inspectFile: async () => ({ kind: 'clear' as const, pubKeyHex: key }),
      importFile: async () => ({ pubKeyHex: key }),
      exportFile: async () => '',
      unlock: async (p: string): Promise<void> => { unlocks.push(p); locked = false; },
      lock: async () => { locked = true; },
      forget: async () => {},
      backedUp: () => false,
      onChange: (l: (id: { pubKeyHex: string } | null) => void): void => { listeners.push(l); },
    } satisfies AppIdentity,
  };
  return id;
}

interface Harness {
  app: App;
  drive: {
    loadFeed(): Promise<void>;
    state: {
      feed: { posts: Array<PostJson | { kind: 'light'; id: string }> };
    };
  };
  feedEl: HTMLElement;
  likes: Array<{ likeTarget: string }>;
  identity: LockableIdentity;
  resolverCalls: ReturnType<typeof testResolver>['calls'];
  cache: PostCache;
}

async function mkHarness(feedResult: FeedResult): Promise<Harness> {
  const r = testResolver();
  const likes: Array<{ likeTarget: string }> = [];
  const feedCalls: unknown[] = [];
  void feedCalls;
  const idw = lockableIdentity(ME);
  const api: Api = {
    feed: async (): Promise<FeedResult> => feedResult,
    thread: async (id: string): Promise<ThreadResult | null> => {
      const found = feedResult.posts.find((p) => p.id === id);
      if (!found || !isFull(found)) return null;
      return {
        post: found, ancestors: [], ancestorCount: 0,
        descendants: [], descendantCount: 0, next: null, pending: [], pendingCount: 0,
      };
    },
    post: async (id: string): Promise<PostResult | null> => {
      const found = feedResult.posts.find((p) => p.id === id);
      if (!found || !isFull(found)) return null;
      return { ...found, confirmedAuthor: found.author };
    },
    status: async (): Promise<StatusResult> => fakeStatus(),
    currentBlock: async (): Promise<BlockCurrent> => ({ height: 10, hash: null }),
    karma: async () => karmaResult({ userId: ME, total: '227', effective: '227', boxes: [{ boxId: '11'.repeat(32), value: '227' }], boxCount: 1, height: 10 }),
    vouchesByTarget: async () => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async () => ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async () => ({ cooldowns: [], count: 0, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async () => null,
    credits: async () => ({ userId: ME, total: '0', boxes: [], boxCount: 0, next: null }),
    usernameByName: async () => null,
  };
  const writeClient = {
    submitLike: async (tx: { likeTarget: string }) => {
      likes.push(tx);
      return { status: 'pending' as const, txId: 'ff'.repeat(32), expiresAtHeight: 100 };
    },
  } as unknown as WriteClient;
  const cache = createPostCache({
    indexedDB: new IDBFactory(),
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
  });
  const app = new App(
    api, writeClient, idw.identity, new PendingLedger(ME),
    undefined, undefined,
    null, null, null,
    stubVerifier(),
    cache,
    r.resolver,
  );
  const appbar = document.createElement('header');
  const feedEl = document.createElement('section'); feedEl.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  const workspace = document.createElement('div'); workspace.className = 'workspace';
  workspace.append(feedEl, panes);
  document.body.append(appbar, workspace);
  app.mount(appbar, feedEl, panes);
  return {
    app,
    drive: app as unknown as Harness['drive'],
    feedEl,
    likes,
    identity: idw,
    resolverCalls: r.calls,
    cache,
  };
}

// WEB_INTERFACE → What the feed reads, and what a card shows for it →
// "A row the reader opened under a card outlasts a redraw of its list" —
// the unlock row the reader opened under card A in the feed stands when a
// slot elsewhere in the feed leaves and renderFeed draws every card again.
describe('a feed card\'s unlock row outlasts a redraw of the feed', () => {
  it('a slot leaving redraws the feed; A\'s card is a new node, A\'s unlock row the same node beneath it, the field holds the text, the focus is in the field; the form submits, unlocks, and the like goes out for A', async () => {
    document.body.innerHTML = '';
    const A = fullRow('A', { author: 'ee'.repeat(32) });
    const B = light('B');
    const h = await mkHarness({ posts: [A, B], next: null, pending: [], pendingCount: 0 });
    await h.drive.loadFeed();
    await settle();

    const cardA = h.feedEl.querySelector<HTMLElement>(`[data-post-id="${A.id}"]`)!;
    expect(cardA).toBeTruthy();
    const likeBtn = [...cardA.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'like')!;
    expect(likeBtn).toBeTruthy();
    likeBtn.click();
    await flush();

    // The press triggers a redraw of the feed that attaches the held row
    // beneath A's card; the card A reference above is stale.
    const cardAafterPress = h.feedEl.querySelector<HTMLElement>(`[data-post-id="${A.id}"]`)!;
    const row = cardAafterPress.querySelector<HTMLElement>('.card-unlock');
    expect(row).not.toBeNull();
    const input = row!.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(input).not.toBeNull();
    input.value = 'secret';
    input.focus();
    expect(document.activeElement).toBe(input);

    // A slot elsewhere ends → endSlots → renderFeed (feed drawn whole).
    expect(h.resolverCalls.length).toBe(1);
    h.resolverCalls[0]!.end({ [B.id]: 'unserved' });
    await settle();

    // A's card is a new node — renderFeed replaced it; the row the reader
    // opened is the SAME node beneath it; the field holds what was typed;
    // the focus is back in the field.
    const cardAafter = h.feedEl.querySelector<HTMLElement>(`[data-post-id="${A.id}"]`)!;
    expect(cardAafter).not.toBe(cardAafterPress);
    const rowAfter = cardAafter.querySelector<HTMLElement>('.card-unlock');
    expect(rowAfter).toBe(row);
    const inputAfter = rowAfter!.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(inputAfter.value).toBe('secret');
    expect(document.activeElement).toBe(inputAfter);

    // Submitting unlocks with the kept text, and the like goes out for A.
    const form = rowAfter!.querySelector('form.pf') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(h.identity.unlocks).toEqual(['secret']);
    expect(h.likes.map((l) => l.likeTarget)).toEqual([A.id]);
  });
});

// WEB_INTERFACE → "A row the reader opened under a card outlasts a redraw of
// its list" — an identity change ends every row and empties the field.
describe('a change of identity ends every held row', () => {
  it('a change of key drops every unlock row the holder held and empties the fields', async () => {
    document.body.innerHTML = '';
    const A = fullRow('A', { author: 'ee'.repeat(32) });
    const h = await mkHarness({ posts: [A], next: null, pending: [], pendingCount: 0 });
    await h.drive.loadFeed();
    await settle();
    const cardA = h.feedEl.querySelector<HTMLElement>(`[data-post-id="${A.id}"]`)!;
    [...cardA.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'like')!.click();
    await flush();
    const cardAafter = h.feedEl.querySelector<HTMLElement>(`[data-post-id="${A.id}"]`)!;
    expect(cardAafter.querySelector('.card-unlock')).not.toBeNull();
    // A change of key fires onChange — the identity module's own notify path
    // (WEB_INTERFACE → The identity module). The App drops every held row,
    // and the field goes with the dropped element.
    h.identity.notify();
    await settle();
    const cardAfinal = h.feedEl.querySelector<HTMLElement>(`[data-post-id="${A.id}"]`);
    // The feed is re-read after an identity change — the card may be gone
    // until the new read lands. Either way, no held row anywhere.
    expect(document.querySelector('.card-unlock')).toBeNull();
    if (cardAfinal) expect(cardAfinal.querySelector('.card-unlock')).toBeNull();
  });
});

// WEB_INTERFACE → "A row the reader opened under a card outlasts a redraw of
// its list" — the key is `(list, postId)`, so one post drawn in two lists
// holds two independent rows: a feed card's row stands only under that
// card, and the pane's card has none.
describe('a row belongs to the card it was opened under', () => {
  it('two lists: a row opened under the feed\'s card is not under the pane\'s card for the same post', async () => {
    document.body.innerHTML = '';
    const A = fullRow('A', { author: 'ee'.repeat(32) });
    const h = await mkHarness({ posts: [A], next: null, pending: [], pendingCount: 0 });
    await h.drive.loadFeed();
    await settle();
    // Open the thread for A in a pane. The feed card draws A again, the pane
    // card draws A again — same id, two lists.
    (h.feedEl.querySelector('.strip') as HTMLButtonElement).click();
    await settle();
    // Press like on the feed card.
    const feedCardA = h.feedEl.querySelector<HTMLElement>(`[data-post-id="${A.id}"]`)!;
    [...feedCardA.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'like')!.click();
    await flush();
    const feedCardAafter = h.feedEl.querySelector<HTMLElement>(`[data-post-id="${A.id}"]`)!;
    expect(feedCardAafter.querySelector('.card-unlock')).not.toBeNull();
    // The pane's card for the same post holds no row.
    const paneA = document.querySelector<HTMLElement>(`.region [data-post-id="${A.id}"]`);
    expect(paneA).not.toBeNull();
    expect(paneA!.querySelector('.card-unlock')).toBeNull();
  });
});

// WEB_INTERFACE → Links — a clipboard-less feed card opens the link row;
// the row survives a redraw of the feed.
describe('a link row outlasts a redraw of the feed', () => {
  it('the clipboard refuses, the link row stands; a slot leaving redraws the feed and the row stands', async () => {
    document.body.innerHTML = '';
    // Fresh identity-less harness via existing lockable one with no key: we
    // need a feed with a confirmed card (feed cards carry the copy glyph).
    const A = fullRow('A', { author: 'ee'.repeat(32) });
    const B = light('B');
    const h = await mkHarness({ posts: [A, B], next: null, pending: [], pendingCount: 0 });
    // Make the clipboard refuse.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('refused')) },
      writable: true, configurable: true,
    });
    await h.drive.loadFeed();
    await settle();
    const cardA = h.feedEl.querySelector<HTMLElement>(`[data-post-id="${A.id}"]`)!;
    (cardA.querySelector('.linkbtn') as HTMLButtonElement).click();
    await settle();
    const cardAafterPress = h.feedEl.querySelector<HTMLElement>(`[data-post-id="${A.id}"]`)!;
    const row = cardAafterPress.querySelector<HTMLElement>('.card-link');
    expect(row).not.toBeNull();
    // A slot leaving redraws the feed.
    h.resolverCalls[0]!.end({ [B.id]: 'unserved' });
    await settle();
    const cardAlast = h.feedEl.querySelector<HTMLElement>(`[data-post-id="${A.id}"]`)!;
    expect(cardAlast).not.toBe(cardAafterPress);
    expect(cardAlast.querySelector('.card-link')).toBe(row);
  });
});
