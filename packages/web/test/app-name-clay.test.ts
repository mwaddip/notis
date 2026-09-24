// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NameResult, NameStatus } from '@dagsocial/nipopow-client';
import { App } from '../src/app';
import type { Api } from '../src/api/client';
import type { AppIdentity, AppState, Submission } from '../src/model/state';
import type { FeedResult, PostJson, StatusResult, ThreadResult, UsernameResult } from '../src/api/dto';
import { namePair } from '../src/model/name-verdict';
import { karmaResult } from './karma-fixture';
import { contentHashHex } from '../src/integrity';

const appCss = readFileSync(resolve(process.cwd(), 'src/style/app.css'), 'utf8');

// Every handle the page renders reads one predicate — the App's nameClay over
// the checks it holds (WEB_INTERFACE → The identity display, → The extension →
// "The verified names"). The App is driven over fakes with results placed in its
// map, and every site is read through the App's own render context: the feed's
// cards and the reader's own root, a thread's bar, its cards and the reader's
// reply, the author window's bar, name row and endorser, the posts window's bar
// and card, the profile's bond and username rows, and the header's profile word.

const ME = 'aa'.repeat(32); // the reader, holding Me_1
const A = 'bb'.repeat(32);  // Alice — the root's author and the author window's subject
const B = 'cc'.repeat(32);  // Bob — the reply's author and the second root's
const V = 'dd'.repeat(32);  // Vic — Alice's endorser
const I = 'ee'.repeat(32);  // Ivy — the reader's invitee
const ROOT = '1'.repeat(64);
const ROOT2 = '2'.repeat(64);
const REPLY = '3'.repeat(64);

const NAMES = new Map<string, UsernameResult>([
  [ME, { name: 'Me_1', owner: ME, boxId: '51'.repeat(32), claimedAtBlock: 40 }],
  [A, { name: 'Alice', owner: A, boxId: '52'.repeat(32), claimedAtBlock: 41 }],
]);

function post(id: string, author: string, authorName: string, parents: string[] = []): PostJson {
  return {
    id, content: 'hi', contentHash: contentHashHex('hi'), author, parentRefs: parents,
    protocolVersion: 1, type: 'regular', status: 'confirmed', blockHeight: 90, blockIndex: 0,
    blockCreatedAt: 0, likeCount: 0, descendantCount: 0, authorName, likedByViewer: null,
  };
}

function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 100, protocolVersion: 1, postCount: 3, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 43200,
    vouchCooldownBlocks: 60, inviteBondMin: '100', inviteBondMax: '1000',
    membership: { memberCount: 2, memberBar: 3, memberLikesBar: 6 },
  };
}

function fakeApi(): Api {
  const root = post(ROOT, A, 'Alice');
  const feed: FeedResult = { posts: [root, post(ROOT2, B, 'Bob')], next: null, pending: [], pendingCount: 0 };
  const thread: ThreadResult = {
    post: root, ancestors: [], ancestorCount: 0,
    descendants: [post(REPLY, B, 'Bob', [ROOT])], descendantCount: 1,
    next: null, pending: [], pendingCount: 0,
  };
  return {
    feed: async (_page, _viewer, author) => (author === A ? { posts: [root], next: null, pending: [], pendingCount: 0 } : feed),
    thread: async (id) => (id === ROOT ? thread : null),
    post: async () => null,
    status: async () => statusResult(),
    currentBlock: async () => ({ height: 100, hash: null }),
    karma: async (key) => karmaResult({
      userId: key, member: true, invitesAvailable: 2, memberSinceBlock: 5, boxCount: 1,
      total: '250', effective: '250', boxes: [{ boxId: '11'.repeat(32), value: '250' }], height: 100,
    }),
    credits: async (key) => ({ userId: key, total: '0', boxes: [], boxCount: 0, next: null }),
    vouchesByTarget: async (key) => (key === A
      ? { vouches: [{ voucherId: V, targetId: A, voucherName: 'Vic', targetName: 'Alice' }], count: 1, next: null }
      : { vouches: [], count: 0, next: null }),
    vouchesByVoucher: async () => ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async () => ({ cooldowns: [], count: 0, next: null }),
    bonds: async () => ({
      bonds: [{ id: '44'.repeat(32), value: '100', inviterId: ME, inviteePublicKey: I, inviterName: 'Me_1', inviteeName: 'Ivy' }],
      bondCount: 1, next: null,
    }),
    usernameByOwner: async (key) => NAMES.get(key) ?? null,
    usernameByName: async () => null,
  };
}

function fakeIdentity(): AppIdentity {
  return {
    current: () => ({ pubKeyHex: ME, locked: false }),
    sign: async () => ({ signature: 'ab'.repeat(64) }),
    onChange: () => {},
    draft: async () => ({ pubKeyHex: ME }),
    create: async () => ({ pubKeyHex: ME }),
    discardDraft: () => {},
    inspectFile: async () => ({ kind: 'clear' as const, pubKeyHex: ME }),
    importFile: async () => ({ pubKeyHex: ME }),
    exportFile: async () => '',
    unlock: async () => {},
    lock: async () => {},
    forget: async () => {},
    backedUp: () => true,
  };
}

type Origin = { from: 'feed' } | { from: 'pane'; ci: number };
interface Drive {
  loadFeed(): Promise<void>;
  loadMembershipState(): Promise<void>;
  openProfile(): void;
  openThread(id: string, origin: Origin): void;
  openAuthor(key: string, origin: Origin): void;
  openAuthorPosts(key: string, origin: Origin): void;
  onWidthClassChange(matches: boolean): void;
  renderFeed(): void;
  renderPanes(): void;
  nameChecks: Map<string, NameResult>;
  state: AppState;
}

function result(status: NameStatus): NameResult {
  return { status, owner: null, name: null, boxId: null, heightAfter: null, verdict: status };
}

function submission(localKey: string, parentId: string | null): Submission {
  return {
    localKey, content: 'mine', parentId, author: ME, contentHash: contentHashHex('mine'),
    stage: 'submitted', txId: null, postId: null, blockHeight: null, expiresAtHeight: 190, reason: null,
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Surfaces {
  appbar: HTMLElement;
  feed: HTMLElement;
  panes: HTMLElement;
  drive: Drive;
}

/** Mount the App with the given checks held, then bring every surface that renders
 *  a handle on screen at once: the profile in column 0, the root's thread in 1,
 *  Alice's author window in 2 and her posts window in 3, the reader's own root and
 *  reply submissions, and the header at tiling. */
async function everySurface(checks: Array<[key: string, name: string, status: NameStatus]>): Promise<Surfaces> {
  const appbar = document.createElement('header');
  const workspace = document.createElement('div'); workspace.className = 'workspace';
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  workspace.append(feed, panes);
  document.body.append(appbar, workspace);
  const app = new App(fakeApi(), undefined, fakeIdentity());
  const drive = app as unknown as Drive;
  for (const [key, name, status] of checks) drive.nameChecks.set(namePair(key, name), result(status));
  app.mount(appbar, feed, panes);
  await drive.loadFeed();
  await drive.loadMembershipState();
  drive.state.submissions.push(submission('own-root', null), submission('own-reply', ROOT));
  drive.renderFeed();
  drive.openProfile();
  await flush();
  drive.openThread(ROOT, { from: 'pane', ci: 0 });
  await flush();
  drive.openAuthor(A, { from: 'pane', ci: 1 });
  await flush();
  drive.openAuthorPosts(A, { from: 'pane', ci: 2 });
  await flush();
  return { appbar, feed, panes, drive };
}

function col(s: Surfaces, ci: number): HTMLElement {
  return s.panes.querySelectorAll<HTMLElement>('.col')[ci]!;
}
function rowField(root: HTMLElement, label: string): HTMLElement {
  const r = [...root.querySelectorAll('.row')].find((x) => x.querySelector('label')?.textContent === label);
  return r!.querySelector<HTMLElement>('.field')!;
}
function handle(root: Element, text: string): HTMLElement {
  const h = [...root.querySelectorAll<HTMLElement>('.handle')].find((x) => x.textContent === text);
  expect(h, `a handle reading ${text}`).toBeDefined();
  return h!;
}
function feedCard(s: Surfaces, id: string): HTMLElement {
  return s.feed.querySelector<HTMLElement>(`.card[data-post-id="${id}"]`)!;
}
function ownRootCard(s: Surfaces): HTMLElement {
  return s.feed.querySelector<HTMLElement>('.card[data-post-id="own-root"]')!;
}

/** Every handle site, with the handle it renders there. */
function sites(s: Surfaces): Record<string, HTMLElement> {
  const [c0, c1, c2, c3] = [col(s, 0), col(s, 1), col(s, 2), col(s, 3)];
  return {
    'the feed card': handle(feedCard(s, ROOT).querySelector('.who')!, '@Alice'),
    'the reader\'s own root': handle(ownRootCard(s).querySelector('.who')!, '@Me_1'),
    'the thread bar': handle(c1.querySelector('.bar-label')!, '@Alice'),
    'the pane root card': handle(c1.querySelector(`.card[data-post-id="${ROOT}"] .who`)!, '@Alice'),
    'the reader\'s own reply': handle(c1.querySelector('.card[data-post-id="own-reply"] .who')!, '@Me_1'),
    'the author window bar': handle(c2.querySelector('.bar-label')!, '@Alice'),
    'the author window name row': handle(rowField(c2, 'name'), '@Alice'),
    'the endorser row': handle(c2.querySelector('.endorser')!, '@Vic'),
    'the posts window bar': handle(c3.querySelector('.bar-label')!, '@Alice'),
    'the posts window card': handle(c3.querySelector(`.card[data-post-id="${ROOT}"] .who`)!, '@Alice'),
    'the standing-bond row': handle(c0.querySelector('.bond')!, '@Ivy'),
    'the profile username row': handle(rowField(c0, 'username'), '@Me_1'),
  };
}
function headerWord(s: Surfaces): HTMLElement {
  return s.appbar.querySelector<HTMLElement>('button[aria-label="open profile"]')!;
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('with no check held, every handle renders as it does without a verifier', () => {
  it('no site carries clay and the author window grows no line', async () => {
    const s = await everySurface([]);
    const all = sites(s);
    expect(Object.keys(all)).toHaveLength(12);
    for (const [site, h] of Object.entries(all)) {
      expect(h.classList.contains('clay'), site).toBe(false);
    }
    expect(headerWord(s).textContent).toBe('@Me_1');
    expect([...headerWord(s).classList]).toEqual(['hdr-word']);
    expect(document.querySelector('.clay')).toBeNull();
    expect(rowField(col(s, 2), 'name').querySelector('.hint')).toBeNull();
  });
});

describe('a clay pair is clay at every site that renders it, and no other pair is', () => {
  it('Alice, the reader, Vic and Ivy unproven — every one of their handles clay; Bob proven stays ink', async () => {
    const s = await everySurface([
      [A, 'Alice', 'unproven'], [ME, 'Me_1', 'absent'], [V, 'Vic', 'none'], [I, 'Ivy', 'no-proof'], [B, 'Bob', 'proven'],
    ]);
    for (const [site, h] of Object.entries(sites(s))) {
      expect(h.classList.contains('clay'), site).toBe(true);
    }
    expect(headerWord(s).classList.contains('clay')).toBe(true);
    expect(headerWord(s).textContent).toBe('@Me_1');
    // Bob's proven pair reads ink — the second feed root and the thread's reply.
    expect(handle(feedCard(s, ROOT2).querySelector('.who')!, '@Bob').classList.contains('clay')).toBe(false);
    expect(handle(col(s, 1).querySelector(`.card[data-post-id="${REPLY}"] .who`)!, '@Bob').classList.contains('clay')).toBe(false);
  });

  it('the author window\'s name row carries the one clay line beneath its handle, and no other site grows a line', async () => {
    const s = await everySurface([[A, 'Alice', 'unproven'], [ME, 'Me_1', 'unproven'], [V, 'Vic', 'unproven'], [I, 'Ivy', 'unproven']]);
    const field = rowField(col(s, 2), 'name');
    const line = field.querySelector<HTMLElement>('div.hint.clay');
    expect(line?.textContent).toBe("this node's answer for this name did not verify");
    expect(line!.previousElementSibling).toBe(handle(field, '@Alice'));
    // The one line on the page.
    expect(document.querySelectorAll('.hint.clay')).toHaveLength(1);
  });

  it('a pair is the key and the name exactly — the same name beside another key, or in another case, stays ink', async () => {
    const s = await everySurface([[B, 'Alice', 'unproven'], [A, 'alice', 'unproven']]);
    for (const [site, h] of Object.entries(sites(s))) {
      expect(h.classList.contains('clay'), site).toBe(false);
    }
  });

  it.each<NameStatus>(['proven', 'young', 'unchecked'])('%s reads ink at every site', async (status) => {
    const s = await everySurface([[A, 'Alice', status], [ME, 'Me_1', status], [V, 'Vic', status], [I, 'Ivy', status]]);
    for (const [site, h] of Object.entries(sites(s))) {
      expect(h.classList.contains('clay'), site).toBe(false);
    }
    expect(headerWord(s).classList.contains('clay')).toBe(false);
    expect(rowField(col(s, 2), 'name').querySelector('.hint')).toBeNull();
  });
});

describe('the header\'s profile word', () => {
  it('at one column the header carries the person glyph and never the name, so nothing there turns clay', async () => {
    const s = await everySurface([[ME, 'Me_1', 'unproven']]);
    expect(headerWord(s).classList.contains('clay')).toBe(true);
    s.drive.onWidthClassChange(true);
    const glyph = headerWord(s);
    expect(glyph.classList.contains('hdr-glyph')).toBe(true);
    expect(glyph.textContent).toBe('');
    expect(s.appbar.textContent).not.toContain('Me_1');
    expect(s.appbar.querySelector('.clay')).toBeNull();
  });
});

describe('under the stylesheet each site computes clay, in the token of either theme', () => {
  it('every clay handle computes the clay token and keeps its weight; the ink beside them computes ink', async () => {
    const style = document.createElement('style');
    style.textContent = appCss;
    document.head.appendChild(style);
    try {
      const s = await everySurface([[A, 'Alice', 'unproven'], [ME, 'Me_1', 'unproven'], [V, 'Vic', 'unproven'], [I, 'Ivy', 'unproven']]);
      const all = sites(s);
      for (const [site, h] of Object.entries(all)) {
        const c = window.getComputedStyle(h);
        expect(c.color, site).toBe('#9A4A2F');
        expect(c.fontWeight, site).toBe('600');
      }
      const word = window.getComputedStyle(headerWord(s));
      expect(word.color).toBe('#9A4A2F');
      expect(word.fontWeight).toBe('600');
      expect(window.getComputedStyle(rowField(col(s, 2), 'name').querySelector('.hint.clay')!).color).toBe('#9A4A2F');
      // Bob's handles and the header's other words stay ink.
      expect(window.getComputedStyle(handle(feedCard(s, ROOT2).querySelector('.who')!, '@Bob')).color).toBe('#2A2419');
      const wallet = s.appbar.querySelector<HTMLElement>('button[aria-label="open wallet"]')!;
      expect(window.getComputedStyle(wallet).color).toBe('#2A2419');
      // Bistre — the token's dark value (HOUSE_STYLE → Colour).
      document.documentElement.setAttribute('data-t', 'dark');
      for (const [site, h] of Object.entries(all)) {
        expect(window.getComputedStyle(h).color, site).toBe('#CC7658');
      }
      expect(window.getComputedStyle(headerWord(s)).color).toBe('#CC7658');
    } finally {
      document.documentElement.removeAttribute('data-t');
      document.head.removeChild(style);
    }
  });
});
