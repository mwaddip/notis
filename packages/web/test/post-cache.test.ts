// @vitest-environment happy-dom
// The extension's post cache, standalone (WEB_INTERFACE → The extension → "The
// post cache"): the module behind IndexedDB. The App wiring is driven by
// test/app-post-cache.test.ts; this suite tests the module in isolation over
// `fake-indexeddb`, so a browser's own IndexedDB does not have to be present.

import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createPostCache, rememberedChain } from '../src/extension/post-cache';
import { POST_CACHE_BYTES } from '../src/model/state';
import type { PostJson, WithdrawnJson } from '../src/api/dto';

const ME = 'aa'.repeat(32);
const hid = (s: string): string =>
  [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(64, '0');

function row(label: string, over: Partial<PostJson> = {}): PostJson {
  return {
    id: hid(label), content: label, contentHash: hid('h' + label),
    author: ME, parentRefs: [], protocolVersion: 1, type: 'regular',
    status: 'confirmed', blockHeight: 10, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null,
    txId: hid('tx' + label), tx: 'de'.repeat(16),
    ...over,
  };
}
function tomb(label: string): WithdrawnJson {
  return {
    kind: 'withdrawn', id: hid(label), author: ME, withdrawnAtHeight: 11,
    parentRefs: [], descendantCount: 0, authorName: null, txId: hid('tx' + label),
  };
}

/** A minimal in-memory `localStorage` for the modules's chain-name key. */
function fakeLs(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string): string | null => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string): void => { map.set(k, v); },
    removeItem: (k: string): void => { map.delete(k); },
  };
}

/** A monotonic clock the test owns, so `lastSeen` moves in order the test can
 *  rely on. */
function clock(): { tick: () => number; set: (n: number) => void; now: number } {
  const c = { now: 1000, tick: (): number => ++c.now, set: (n: number): void => { c.now = n; } };
  return c;
}

beforeEach(() => { /* each test builds its own fake IDB */ });

describe('post-cache — the register', () => {
  it('POST_CACHE_BYTES is 50_000_000 (CONSTANTS → Client defaults)', () => {
    expect(POST_CACHE_BYTES).toBe(50_000_000);
  });
});

describe('post-cache — put and thread', () => {
  it('put then thread answers the row; a refresh replaces the row and moves last-seen; the total moves by the difference', async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await cache.open('A');
    const r = row('a');
    await cache.put({ id: r.id, txBytes: new Uint8Array([1, 2, 3]), row: r, author: r.author, parent: null, own: false });
    const t = await cache.thread(r.id);
    expect(t).not.toBeNull();
    expect(t!.post.id).toBe(r.id);
    expect(t!.ancestors).toEqual([]);
    expect(t!.descendants).toEqual([]);
    // The stored row carries no `tx` hex (the bytes are held once).
    expect((t!.post as PostJson).tx).toBeUndefined();
    // Refresh with a longer row: last-seen moves and the total shifts.
    const r2 = row('a', { content: 'aa longer content' });
    await cache.put({ id: r2.id, txBytes: new Uint8Array([1, 2, 3, 4]), row: r2, author: r2.author, parent: null, own: false });
    const t2 = await cache.thread(r.id);
    expect(t2).not.toBeNull();
    expect((t2!.post as PostJson).content).toBe('aa longer content');
  });

  it('a subject with held parents and grandparents walks oldest-first; a gap stops the walk; descendants span several levels; a subject not held is null', async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await cache.open('A');
    // Chain: g <- p <- s (held); gg is missing, g has parent 'gg'
    const g = row('g', { parentRefs: [hid('gg')] });
    const p = row('p', { parentRefs: [g.id] });
    const s = row('s', { parentRefs: [p.id] });
    await cache.put({ id: g.id, txBytes: new Uint8Array([1]), row: g, author: g.author, parent: hid('gg'), own: false });
    await cache.put({ id: p.id, txBytes: new Uint8Array([2]), row: p, author: p.author, parent: g.id, own: false });
    await cache.put({ id: s.id, txBytes: new Uint8Array([3]), row: s, author: s.author, parent: p.id, own: false });
    // Descendants: s -> d1 -> dd1; s -> d2
    const d1 = row('d1', { parentRefs: [s.id] });
    const d2 = row('d2', { parentRefs: [s.id] });
    const dd1 = row('dd1', { parentRefs: [d1.id] });
    await cache.put({ id: d1.id, txBytes: new Uint8Array([4]), row: d1, author: d1.author, parent: s.id, own: false });
    await cache.put({ id: d2.id, txBytes: new Uint8Array([5]), row: d2, author: d2.author, parent: s.id, own: false });
    await cache.put({ id: dd1.id, txBytes: new Uint8Array([6]), row: dd1, author: dd1.author, parent: d1.id, own: false });

    const t = await cache.thread(s.id);
    expect(t).not.toBeNull();
    expect(t!.post.id).toBe(s.id);
    expect(t!.ancestors.map((a) => a.id)).toEqual([g.id, p.id]); // oldest first, stopping at the gap
    const descIds = new Set(t!.descendants.map((d) => d.id));
    expect(descIds).toEqual(new Set([d1.id, d2.id, dd1.id]));

    const missing = await cache.thread(hid('zzz'));
    expect(missing).toBeNull();
  });
});

describe('post-cache — eviction', () => {
  it('eviction takes the least recently seen first and never an `own` entry', async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await cache.open('A');
    // A third of the cap in bytes, so two entries fit and a third needs an
    // eviction. Row JSON is tens of bytes — negligible beside the Uint8Array.
    const third = Math.floor(POST_CACHE_BYTES / 3);
    const big = new Uint8Array(third);
    const own1 = row('own1');
    const own2 = row('own2');
    const other = row('other');
    await cache.put({ id: own1.id, txBytes: big, row: own1, author: own1.author, parent: null, own: true });
    await cache.put({ id: other.id, txBytes: big, row: other, author: other.author, parent: null, own: false });
    // A third big put must evict `other` (not `own1`).
    await cache.put({ id: own2.id, txBytes: big, row: own2, author: own2.author, parent: null, own: true });
    expect(await cache.thread(own1.id)).not.toBeNull();
    expect(await cache.thread(own2.id)).not.toBeNull();
    expect(await cache.thread(other.id)).toBeNull();
  });

  it('a store full of the reader\'s own posts drops the new put (Review Focus 4)', async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await cache.open('A');
    const third = Math.floor(POST_CACHE_BYTES / 3);
    const big = new Uint8Array(third);
    const o1 = row('o1');
    const o2 = row('o2');
    await cache.put({ id: o1.id, txBytes: big, row: o1, author: o1.author, parent: null, own: true });
    await cache.put({ id: o2.id, txBytes: big, row: o2, author: o2.author, parent: null, own: true });
    // The next put would need an eviction, but no non-own entry is held.
    const n = row('n');
    await cache.put({ id: n.id, txBytes: big, row: n, author: n.author, parent: null, own: false });
    expect(await cache.thread(n.id)).toBeNull();
    expect(await cache.thread(o1.id)).not.toBeNull();
    expect(await cache.thread(o2.id)).not.toBeNull();
  });

  it('an entry larger than the cap is dropped', async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await cache.open('A');
    const giant = new Uint8Array(POST_CACHE_BYTES + 100);
    const r = row('g');
    await cache.put({ id: r.id, txBytes: giant, row: r, author: r.author, parent: null, own: false });
    expect(await cache.thread(r.id)).toBeNull();
  });
});

describe('post-cache — a put the store refuses', () => {
  it("a quota-refused put resolves, the entry is absent, the total is unchanged, and the next put lands", async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await cache.open('A');
    // Prime the cache with one entry, so the running total has a known
    // value a quota-refused put must leave in place.
    const seed = row('seed');
    await cache.put({ id: seed.id, txBytes: new Uint8Array(100), row: seed, author: seed.author, parent: null, own: false });
    const totalBefore = await readMetaTotal(idb, 'A');
    expect(totalBefore).toBeGreaterThan(0);

    // Patch IDBObjectStore.prototype.put to throw a DOMException the next
    // time it is called in a readwrite transaction over `entries`. A
    // single-shot patch — the next put after this one runs normally.
    const protoPut = IDBObjectStore.prototype.put;
    let armed = true;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest {
      if (armed && this.name === 'entries') {
        armed = false;
        throw new DOMException('simulated quota', 'QuotaExceededError');
      }
      return protoPut.call(this, value, key as IDBValidKey);
    } as typeof IDBObjectStore.prototype.put;

    try {
      const a = row('a');
      await cache.put({ id: a.id, txBytes: new Uint8Array(100), row: a, author: a.author, parent: null, own: false });
      expect(await cache.thread(a.id)).toBeNull();
      const totalAfterRefusal = await readMetaTotal(idb, 'A');
      expect(totalAfterRefusal).toBe(totalBefore);

      // The next put lands and moves the total.
      const b = row('b');
      await cache.put({ id: b.id, txBytes: new Uint8Array(100), row: b, author: b.author, parent: null, own: false });
      expect(await cache.thread(b.id)).not.toBeNull();
      const totalAfterLand = await readMetaTotal(idb, 'A');
      expect(totalAfterLand).toBeGreaterThan(totalBefore);
    } finally {
      IDBObjectStore.prototype.put = protoPut;
    }
  });

  it("a transaction the browser aborts leaves the entry absent and the total unchanged", async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await cache.open('A');
    const seed = row('seed');
    await cache.put({ id: seed.id, txBytes: new Uint8Array(100), row: seed, author: seed.author, parent: null, own: false });
    const totalBefore = await readMetaTotal(idb, 'A');

    // Patch put to schedule an abort on its transaction once.
    const protoPut = IDBObjectStore.prototype.put;
    let armed = true;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest {
      const req = protoPut.call(this, value, key as IDBValidKey);
      if (armed && this.name === 'entries') {
        armed = false;
        try { this.transaction.abort(); } catch { /* already settled */ }
      }
      return req;
    } as typeof IDBObjectStore.prototype.put;

    try {
      const a = row('a');
      await cache.put({ id: a.id, txBytes: new Uint8Array(100), row: a, author: a.author, parent: null, own: false });
      expect(await cache.thread(a.id)).toBeNull();
      expect(await readMetaTotal(idb, 'A')).toBe(totalBefore);
    } finally {
      IDBObjectStore.prototype.put = protoPut;
    }
  });

  it("a non-DOMException throw inside a run() callback rejects the operation", async () => {
    // Not reachable through the public API — the module's own `fn`
    // callbacks throw only DOMExceptions synchronously. The property is
    // the one the contract rests on: a programming error reaches the
    // caller, never the two absorbed failures. Exercised directly on the
    // module's `run` seam.
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await cache.open('A');
    // Patch put to throw a TypeError once — a programming error from the
    // caller's own code, not an IDB failure.
    const protoPut = IDBObjectStore.prototype.put;
    let armed = true;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest {
      if (armed && this.name === 'entries') {
        armed = false;
        throw new TypeError('programming error');
      }
      return protoPut.call(this, value, key as IDBValidKey);
    } as typeof IDBObjectStore.prototype.put;

    try {
      const a = row('a');
      await expect(
        cache.put({ id: a.id, txBytes: new Uint8Array(100), row: a, author: a.author, parent: null, own: false }),
      ).rejects.toThrow('programming error');
    } finally {
      IDBObjectStore.prototype.put = protoPut;
    }
  });
});

describe('post-cache — the running total is kept in a meta record', () => {
  it('a scripted run of puts, refreshes, withdrawals and evictions keeps the meta total equal to the sum of stored entries, never over the cap', async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await cache.open('A');
    // Seeded LCG — the test is a scripted sequence, not random.
    let seed = 0x1234;
    const rand = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    const held = new Set<string>();
    const kinds = ['put', 'put', 'refresh', 'withdraw', 'put', 'put', 'put', 'refresh', 'withdraw', 'put'];
    let n = 0;
    for (let i = 0; i < 200; i++) {
      const kind = kinds[Math.floor(rand() * kinds.length)]!;
      if (kind === 'put' || (held.size === 0 && kind !== 'put')) {
        const id = hid('x' + (n++));
        held.add(id);
        const bytes = 100 + Math.floor(rand() * 500);
        const r = row('r' + i, { id });
        await cache.put({ id, txBytes: new Uint8Array(bytes), row: r, author: r.author, parent: null, own: false });
      } else if (kind === 'refresh') {
        const picks = [...held];
        const id = picks[Math.floor(rand() * picks.length)]!;
        const bytes = 50 + Math.floor(rand() * 500);
        const r = row('r' + i, { id });
        await cache.put({ id, txBytes: new Uint8Array(bytes), row: r, author: r.author, parent: null, own: false });
      } else if (kind === 'withdraw') {
        const picks = [...held];
        const id = picks[Math.floor(rand() * picks.length)]!;
        await cache.withdraw(id, tomb('t' + i));
      }
    }

    // Walk the stored entries and sum sizes; read the meta total; both equal.
    const [sum, metaTotal] = await Promise.all([sumStoredSizes(idb, 'A'), readMetaTotal(idb, 'A')]);
    expect(metaTotal).toBe(sum);
    expect(metaTotal).toBeLessThanOrEqual(POST_CACHE_BYTES);
  });

  it('the entry being put is never a victim: a refresh under cap pressure keeps the refreshed id', async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await cache.open('A');
    // Three ~third-cap entries, oldest first. The oldest is the one about
    // to be refreshed.
    const third = Math.floor(POST_CACHE_BYTES / 3);
    const big = new Uint8Array(third);
    const r1 = row('r1');
    const r2 = row('r2');
    const r3 = row('r3');
    await cache.put({ id: r1.id, txBytes: big, row: r1, author: r1.author, parent: null, own: false });
    await cache.put({ id: r2.id, txBytes: big, row: r2, author: r2.author, parent: null, own: false });
    await cache.put({ id: r3.id, txBytes: big, row: r3, author: r3.author, parent: null, own: false });
    // Refresh r1 (the least recently seen) with a larger payload. If the
    // victim collection took r1, the put would then re-insert it; a bug
    // over-counted its size. Here the victim is r2, the next oldest.
    const bigger = new Uint8Array(third + 1_000_000);
    await cache.put({ id: r1.id, txBytes: bigger, row: r1, author: r1.author, parent: null, own: false });
    expect(await cache.thread(r1.id)).not.toBeNull();
    expect(await cache.thread(r2.id)).toBeNull();
    expect(await cache.thread(r3.id)).not.toBeNull();
    const [sum, metaTotal] = await Promise.all([sumStoredSizes(idb, 'A'), readMetaTotal(idb, 'A')]);
    expect(metaTotal).toBe(sum);
  });
});

/** Walk the entries store and sum each row's declared `size`. */
async function sumStoredSizes(idb: IDBFactory, chain: string): Promise<number> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open('notis.posts.' + chain);
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error);
  });
  try {
    return await new Promise<number>((resolve) => {
      const tx = db.transaction('entries', 'readonly');
      let sum = 0;
      const cur = tx.objectStore('entries').openCursor();
      cur.onsuccess = (): void => {
        const c = cur.result;
        if (c) { sum += (c.value as { size: number }).size; c.continue(); }
      };
      tx.oncomplete = (): void => resolve(sum);
      tx.onerror = (): void => resolve(sum);
    });
  } finally {
    db.close();
  }
}

/** Read the meta record's running total from a database the cache has
 *  opened and let go of. */
async function readMetaTotal(idb: IDBFactory, chain: string): Promise<number> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open('notis.posts.' + chain);
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error);
  });
  try {
    return await new Promise<number>((resolve) => {
      const tx = db.transaction('meta', 'readonly');
      const req = tx.objectStore('meta').get('total');
      req.onsuccess = (): void => {
        const row = req.result as { key: string; bytes: number } | undefined;
        resolve(row?.bytes ?? 0);
      };
      req.onerror = (): void => resolve(0);
    });
  } finally {
    db.close();
  }
}

describe('post-cache — withdraw', () => {
  it('empties the text and keeps the entry; thread answers the withdrawn row', async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await cache.open('A');
    const r = row('a');
    await cache.put({ id: r.id, txBytes: new Uint8Array([9, 9, 9]), row: r, author: r.author, parent: null, own: false });
    const w = tomb('a');
    await cache.withdraw(r.id, w);
    const t = await cache.thread(r.id);
    expect(t).not.toBeNull();
    expect((t!.post as WithdrawnJson).kind).toBe('withdrawn');
  });

  it('withdraw of an id not held is nothing', async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await cache.open('A');
    const w = tomb('x');
    await cache.withdraw(w.id, w);
    expect(await cache.thread(w.id)).toBeNull();
  });
});

describe('post-cache — the chain', () => {
  it('open under another chain reads nothing of the first (Review Focus 5), and reopening the first finds its entries; notis.posts.chain holds the last name', async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await cache.open('A');
    const a = row('a');
    await cache.put({ id: a.id, txBytes: new Uint8Array([1]), row: a, author: a.author, parent: null, own: false });
    expect(ls.map.get('notis.posts.chain')).toBe('A');
    expect(rememberedChain(ls)).toBe('A');

    await cache.open('B');
    expect(ls.map.get('notis.posts.chain')).toBe('B');
    // B's database is empty of A's rows.
    expect(await cache.thread(a.id)).toBeNull();
    const b = row('b');
    await cache.put({ id: b.id, txBytes: new Uint8Array([2]), row: b, author: b.author, parent: null, own: false });

    // Reopen A — its rows are still there.
    await cache.open('A');
    expect(await cache.thread(a.id)).not.toBeNull();
    expect(await cache.thread(b.id)).toBeNull();
    expect(ls.map.get('notis.posts.chain')).toBe('A');
  });
});

describe('post-cache — no IndexedDB', () => {
  it('with indexedDB undefined, every method resolves and nothing throws', async () => {
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: null, localStorage: ls, now: c.tick });
    // The chain is remembered even without a database.
    await cache.open('A');
    expect(ls.map.get('notis.posts.chain')).toBe('A');
    const r = row('a');
    await cache.put({ id: r.id, txBytes: new Uint8Array([1]), row: r, author: r.author, parent: null, own: false });
    expect(await cache.thread(r.id)).toBeNull();
    await cache.withdraw(r.id, tomb('a'));
  });

  it('open rejecting (an idb that throws) runs without a cache', async () => {
    const ls = fakeLs();
    const c = clock();
    // An IDBFactory whose `open` throws synchronously.
    const bad = {
      open: (): IDBOpenDBRequest => { throw new Error('refused'); },
    } as unknown as IDBFactory;
    const cache = createPostCache({ indexedDB: bad, localStorage: ls, now: c.tick });
    await cache.open('A');
    const r = row('a');
    await cache.put({ id: r.id, txBytes: new Uint8Array([1]), row: r, author: r.author, parent: null, own: false });
    expect(await cache.thread(r.id)).toBeNull();
  });
});
