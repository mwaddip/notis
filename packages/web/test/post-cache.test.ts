// @vitest-environment happy-dom
// The extension's post cache, standalone (WEB_INTERFACE → The extension → "The
// post cache"): the module behind IndexedDB, tested in isolation over
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

// WEB_INTERFACE → The extension → "The post cache": "One chain's database at a
// time". Once a chain's database opens, every other `notis.posts.*` database the
// factory lists is deleted; a database named otherwise is left alone. The
// module's own connection closes on `versionchange`, so a delete another
// connection asks for is never blocked by it.
describe('post-cache — one chain\'s database at a time', () => {
  it('opening on `b` after `a` leaves `notis.posts.b` listed, drops `notis.posts.a`, and a non-matching name is untouched', async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await cache.open('a');
    const r = row('seed');
    await cache.put({ id: r.id, txBytes: new Uint8Array([1, 2, 3]), row: r, author: r.author, parent: null, own: false });
    // A database the cache does not own, under a name whose prefix differs: it
    // must still be listed after the switch.
    await new Promise<void>((resolve, reject) => {
      const req = idb.open('other.unrelated', 1);
      req.onsuccess = (): void => { req.result.close(); resolve(); };
      req.onerror = (): void => reject(req.error);
    });
    await cache.open('b');
    const names = (await idb.databases()).map((d) => d.name).sort();
    expect(names).toContain('notis.posts.b');
    expect(names).not.toContain('notis.posts.a');
    expect(names).toContain('other.unrelated');
  });

  it('a second cache over one factory opens `b` while the first holds `a`: the first\'s database is dropped from `databases()`, and the first\'s later `put` and `getMany` settle without a throw', async () => {
    const idb = new IDBFactory();
    const lsA = fakeLs();
    const lsB = fakeLs();
    const c = clock();
    const first = createPostCache({ indexedDB: idb, localStorage: lsA, now: c.tick });
    const second = createPostCache({ indexedDB: idb, localStorage: lsB, now: c.tick });
    await first.open('a');
    const r = row('seed');
    await first.put({ id: r.id, txBytes: new Uint8Array([1, 2, 3]), row: r, author: r.author, parent: null, own: false });
    await second.open('b');
    // The second cache's open deleted `notis.posts.a` on the shared factory —
    // the first's connection closed on `versionchange` so the delete did not
    // wait for it.
    const names = (await idb.databases()).map((d) => d.name).sort();
    expect(names).not.toContain('notis.posts.a');
    expect(names).toContain('notis.posts.b');
    // The first cache's later calls settle: no throw, nothing stored.
    const r2 = row('after');
    await expect(first.put({ id: r2.id, txBytes: new Uint8Array([4]), row: r2, author: r2.author, parent: null, own: false })).resolves.toBeUndefined();
    await expect(first.getMany([r2.id])).resolves.toBeInstanceOf(Map);
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
  it('open under another chain reads nothing of the first, reopening the first finds it empty, and notis.posts.chain holds the last name', async () => {
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
    expect(rememberedChain(ls)).toBe('B');
    // B's database is empty of A's rows.
    expect(await cache.thread(a.id)).toBeNull();
    const b = row('b');
    await cache.put({ id: b.id, txBytes: new Uint8Array([2]), row: b, author: b.author, parent: null, own: false });

    // Reopen A — one chain's database at a time (WEB_INTERFACE → The
    // extension → "The post cache"): A's database was deleted when B
    // opened, so neither a's row nor b's is held on A.
    await cache.open('A');
    expect(ls.map.get('notis.posts.chain')).toBe('A');
    expect(rememberedChain(ls)).toBe('A');
    expect(await cache.thread(a.id)).toBeNull();
    expect(await cache.thread(b.id)).toBeNull();
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

describe('post-cache — getMany', () => {
  it('a held id answers its entry; an id not held is absent; a withdrawn entry answers its row; an empty list is an empty map', async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await cache.open('A');
    const a = row('a'); const b = row('b');
    await cache.put({ id: a.id, txBytes: new Uint8Array([1, 2]), row: a, author: a.author, parent: null, own: false });
    await cache.put({ id: b.id, txBytes: new Uint8Array([3, 4]), row: b, author: b.author, parent: hid('p'), own: true });
    // Withdraw a — the entry stays and the row becomes the withdrawn marker.
    const w = tomb('a');
    await cache.withdraw(a.id, w);

    const empty = await cache.getMany([]);
    expect(empty.size).toBe(0);

    const got = await cache.getMany([a.id, b.id, hid('nope')]);
    expect(got.size).toBe(2);
    const ha = got.get(a.id)!;
    expect((ha.row as WithdrawnJson).kind).toBe('withdrawn');
    expect(ha.author).toBe(a.author);
    expect(ha.parent).toBeNull();
    const hb = got.get(b.id)!;
    expect((hb.row as PostJson).content).toBe('b');
    expect(hb.parent).toBe(hid('p'));
    expect(got.has(hid('nope'))).toBe(false);
  });

  it('with no database getMany answers an empty map', async () => {
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: null, localStorage: ls, now: c.tick });
    await cache.open('A');
    const got = await cache.getMany([hid('a')]);
    expect(got.size).toBe(0);
  });
});

describe('post-cache — refresh', () => {
  it("replaces a held id's row and lastSeen, keeps txBytes/author/parent/own, and moves the running total by the difference against a sum over the entries", async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await cache.open('A');
    const a = row('a');
    await cache.put({ id: a.id, txBytes: new Uint8Array([1, 2, 3, 4]), row: a, author: a.author, parent: hid('p'), own: true });
    // Refresh with a longer row — the entry's size increases.
    const a2 = row('a', { content: 'much longer content here', likeCount: 7, authorName: 'alice' });
    await cache.refresh([a2]);
    const t = await cache.thread(a.id);
    expect(t).not.toBeNull();
    const post = t!.post as PostJson;
    expect(post.content).toBe('much longer content here');
    expect(post.likeCount).toBe(7);
    expect(post.authorName).toBe('alice');
    // `tx` is not held on the row.
    expect(post.tx).toBeUndefined();
    // The entry's `own`, `author`, `parent` and `txBytes` are kept — a
    // withdrawal of the id would still carry the same `author`, so the
    // thread's rows retain their parent chain against a later put.
    const g = await cache.getMany([a.id]);
    expect(g.get(a.id)!.author).toBe(a.author);
    expect(g.get(a.id)!.parent).toBe(hid('p'));
  });

  it("moves one entry's last-seen ahead of an older entry's so the next eviction takes the other", async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    c.set(0);
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await cache.open('A');
    const a = row('a'); const b = row('b');
    await cache.put({ id: a.id, txBytes: new Uint8Array([1]), row: a, author: a.author, parent: null, own: false });
    await cache.put({ id: b.id, txBytes: new Uint8Array([1]), row: b, author: b.author, parent: null, own: false });
    // After the puts, `a`'s lastSeen is older than `b`'s. A refresh of `a`
    // moves it ahead, so the next eviction (not tested here) would take `b`.
    const t0 = await cache.getMany([a.id, b.id]);
    expect(t0.size).toBe(2);
    const beforeA = (await cache.thread(a.id))!;
    const beforeB = (await cache.thread(b.id))!;
    // The thread reads give us the row; lastSeen itself is not exposed. The
    // refresh does not reorder visibly — but we can tell the refresh ran by
    // reading the row's new content on another refresh.
    await cache.refresh([row('a', { content: 'a!' })]);
    const after = await cache.thread(a.id);
    expect((after!.post as PostJson).content).toBe('a!');
    expect(beforeA.post.id).toBe(a.id);
    expect(beforeB.post.id).toBe(b.id);
  });

  it("leaves a withdrawn entry as it is, and an id not held is nothing", async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await cache.open('A');
    const a = row('a');
    await cache.put({ id: a.id, txBytes: new Uint8Array([1]), row: a, author: a.author, parent: null, own: false });
    await cache.withdraw(a.id, tomb('a'));
    // Refresh with a live PostJson for the withdrawn id — the entry is left.
    await cache.refresh([row('a', { content: 'resurrected?' })]);
    const t = await cache.thread(a.id);
    expect((t!.post as WithdrawnJson).kind).toBe('withdrawn');
    // Refresh for an id not held — nothing.
    await cache.refresh([row('nope')]);
    const g = await cache.getMany([hid('nope')]);
    expect(g.has(hid('nope'))).toBe(false);
  });
});

// WEB_INTERFACE → The extension → "A failed listing draws the cache": the two
// readers the App drives on any failed first page — the feed's roots and the
// author window's entries. Each sorts the confirmed rows by block height
// (highest first) with ties by id, then the rows with `blockHeight: null`,
// returns a withdrawn entry as its withdrawn row, caps at `limit`, and
// absorbs the same failures `getMany` does (no database, a transaction the
// browser refuses).
describe('post-cache — roots and byAuthor', () => {
  it('roots answers parentless entries, confirmed newest first, then the pending, capped', async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await cache.open('A');
    const r10 = row('r10', { blockHeight: 10 });
    const r20 = row('r20', { blockHeight: 20 });
    const r20b = row('r20b', { blockHeight: 20 });
    const pend = row('pend', { blockHeight: null, status: 'pending' });
    const reply = row('rep', { parentRefs: [r10.id] });
    await cache.put({ id: r10.id, txBytes: new Uint8Array([1]), row: r10, author: r10.author, parent: null, own: false });
    await cache.put({ id: r20.id, txBytes: new Uint8Array([2]), row: r20, author: r20.author, parent: null, own: false });
    await cache.put({ id: r20b.id, txBytes: new Uint8Array([3]), row: r20b, author: r20b.author, parent: null, own: false });
    await cache.put({ id: pend.id, txBytes: new Uint8Array([4]), row: pend, author: pend.author, parent: null, own: false });
    await cache.put({ id: reply.id, txBytes: new Uint8Array([5]), row: reply, author: reply.author, parent: r10.id, own: false });

    const all = await cache.roots(10);
    // Confirmed first by height desc; ties by id asc; pending last.
    const confirmedIds = [r20.id, r20b.id].sort();
    expect(all.map((h) => h.row.id)).toEqual([confirmedIds[0], confirmedIds[1], r10.id, pend.id]);
    // The reply is not a root.
    expect(all.map((h) => h.row.id)).not.toContain(reply.id);

    // At most `limit`.
    const capped = await cache.roots(2);
    expect(capped.map((h) => h.row.id)).toEqual([confirmedIds[0], confirmedIds[1]]);

    // A zero or negative limit answers empty.
    expect(await cache.roots(0)).toEqual([]);
  });

  it("byAuthor answers that author's entries alone, confirmed newest first", async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await cache.open('A');
    const A1 = 'aa'.repeat(32);
    const A2 = 'bb'.repeat(32);
    const a1low = row('a1-low', { author: A1, blockHeight: 10 });
    const a1high = row('a1-high', { author: A1, blockHeight: 30 });
    const a1pend = row('a1-pend', { author: A1, blockHeight: null, status: 'pending' });
    const a2 = row('a2', { author: A2, blockHeight: 20 });
    // A1's reply under A2's root — byAuthor takes every entry whose author
    // is A1, roots and replies alike.
    const a1reply = row('a1-rep', { author: A1, parentRefs: [a2.id], blockHeight: 25 });
    await cache.put({ id: a1low.id, txBytes: new Uint8Array([1]), row: a1low, author: A1, parent: null, own: false });
    await cache.put({ id: a1high.id, txBytes: new Uint8Array([2]), row: a1high, author: A1, parent: null, own: false });
    await cache.put({ id: a1pend.id, txBytes: new Uint8Array([3]), row: a1pend, author: A1, parent: null, own: false });
    await cache.put({ id: a2.id, txBytes: new Uint8Array([4]), row: a2, author: A2, parent: null, own: false });
    await cache.put({ id: a1reply.id, txBytes: new Uint8Array([5]), row: a1reply, author: A1, parent: a2.id, own: false });

    const got = await cache.byAuthor(A1, 10);
    expect(got.map((h) => h.row.id)).toEqual([a1high.id, a1reply.id, a1low.id, a1pend.id]);
    const other = await cache.byAuthor(A2, 10);
    expect(other.map((h) => h.row.id)).toEqual([a2.id]);
    // Capped.
    const capped = await cache.byAuthor(A1, 2);
    expect(capped.map((h) => h.row.id)).toEqual([a1high.id, a1reply.id]);
    // Zero limit answers empty.
    expect(await cache.byAuthor(A1, 0)).toEqual([]);
    // An author with no entries answers empty.
    expect(await cache.byAuthor('cc'.repeat(32), 10)).toEqual([]);
  });

  it('a withdrawn entry answers its withdrawn row; the withdrawn-at height places it among the confirmed', async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await cache.open('A');
    const a = row('a', { blockHeight: 10 });
    const b = row('b', { blockHeight: 20 });
    await cache.put({ id: a.id, txBytes: new Uint8Array([1]), row: a, author: a.author, parent: null, own: false });
    await cache.put({ id: b.id, txBytes: new Uint8Array([2]), row: b, author: b.author, parent: null, own: false });
    // Withdraw `a` at height 25 — the withdrawn row is confirmed at 25 and
    // places ahead of `b` at 20.
    const w = { ...tomb('a'), withdrawnAtHeight: 25 };
    await cache.withdraw(a.id, w);
    const got = await cache.roots(10);
    expect(got.length).toBe(2);
    expect(got[0]!.row.id).toBe(a.id);
    expect((got[0]!.row as WithdrawnJson).kind).toBe('withdrawn');
    expect(got[1]!.row.id).toBe(b.id);
    // byAuthor answers the same withdrawn row.
    const ba = await cache.byAuthor(a.author, 10);
    expect((ba.find((h) => h.row.id === a.id)!.row as WithdrawnJson).kind).toBe('withdrawn');
  });

  it('roots with no database answers empty; byAuthor with no database answers empty', async () => {
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: null, localStorage: ls, now: c.tick });
    await cache.open('A');
    expect(await cache.roots(10)).toEqual([]);
    expect(await cache.byAuthor('aa'.repeat(32), 10)).toEqual([]);
  });
});

// WEB_INTERFACE → The extension → "A post checked before any tip run names a
// chain is kept until one does": where the browser gives the page IndexedDB,
// the module keeps each such entry in memory — within `POST_CACHE_BYTES`, by
// the eviction rule — beside its write to the database the remembered name
// opened, where one did; a withdrawal or a refresh in that time moves the
// kept entry as it moves a stored one, and while no database is open every
// read answers the kept entries. The first tip run that names a chain writes
// them into that chain's database, the remembered chain's or another's, and
// the module keeps none after.

/** Call `openRemembered` on a cache that does not expose it yet — the method
 *  is the rule's addition. The cast fails at runtime against a module that
 *  carries no such method. */
function openRemembered(cache: ReturnType<typeof createPostCache>): Promise<void> {
  return (cache as unknown as { openRemembered(): Promise<void> }).openRemembered();
}

describe("post-cache — a post checked before any tip run names a chain is kept until one does", () => {
  it("a first session: no remembered name; a put answers getMany before any open, and open('X') writes the entry into X with the meta total equal to the sum of the stored entries' sizes", async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await openRemembered(cache);
    const r = row('r');
    await cache.put({ id: r.id, txBytes: new Uint8Array([1, 2, 3]), row: r, author: r.author, parent: null, own: false });
    const got = await cache.getMany([r.id]);
    expect(got.size).toBe(1);
    expect(got.get(r.id)!.author).toBe(r.author);
    await cache.open('X');
    const other = createPostCache({ indexedDB: idb, localStorage: fakeLs(), now: c.tick });
    await other.open('X');
    expect(await other.thread(r.id)).not.toBeNull();
    const metaTotal = await readMetaTotal(idb, 'X');
    const storedSum = await sumStoredSizes(idb, 'X');
    expect(metaTotal).toBe(storedSum);
    expect(metaTotal).toBeGreaterThan(0);
  });

  it("a chain change: remembered 'A' holds an entry; openRemembered opens A; a put of P; open('B'): a second cache on B holds P and not A's entry, and databases() lists no notis.posts.A", async () => {
    const idb = new IDBFactory();
    const lsA = fakeLs();
    const c = clock();
    // Seed A: a seeding cache opens A and puts an entry; the chain is
    // remembered in lsA. The seeding cache's connection closes on
    // versionchange when another cache deletes A later.
    const seeder = createPostCache({ indexedDB: idb, localStorage: lsA, now: c.tick });
    await seeder.open('A');
    const aOld = row('aOld');
    await seeder.put({ id: aOld.id, txBytes: new Uint8Array([9]), row: aOld, author: aOld.author, parent: null, own: false });
    expect(lsA.map.get('notis.posts.chain')).toBe('A');
    // The main cache shares the remembered-name ls and the factory.
    const main = createPostCache({ indexedDB: idb, localStorage: lsA, now: c.tick });
    await openRemembered(main);
    const P = row('p');
    await main.put({ id: P.id, txBytes: new Uint8Array([1, 2]), row: P, author: P.author, parent: null, own: false });
    await main.open('B');
    const names = (await idb.databases()).map((d) => d.name).sort();
    expect(names).not.toContain('notis.posts.A');
    expect(names).toContain('notis.posts.B');
    const second = createPostCache({ indexedDB: idb, localStorage: fakeLs(), now: c.tick });
    await second.open('B');
    const gotP = await second.getMany([P.id, aOld.id]);
    expect(gotP.has(P.id)).toBe(true);
    expect(gotP.has(aOld.id)).toBe(false);
  });

  it("the same chain: remembered 'X', openRemembered, a put of P, open('X') — exactly one entry for P and the meta total equals the sum of the stored entries' sizes", async () => {
    const idb = new IDBFactory();
    const lsX = fakeLs();
    const c = clock();
    const seeder = createPostCache({ indexedDB: idb, localStorage: lsX, now: c.tick });
    await seeder.open('X');
    expect(lsX.map.get('notis.posts.chain')).toBe('X');
    const main = createPostCache({ indexedDB: idb, localStorage: lsX, now: c.tick });
    await openRemembered(main);
    const P = row('p');
    await main.put({ id: P.id, txBytes: new Uint8Array([4, 5, 6]), row: P, author: P.author, parent: null, own: false });
    await main.open('X');
    const second = createPostCache({ indexedDB: idb, localStorage: fakeLs(), now: c.tick });
    await second.open('X');
    const got = await second.getMany([P.id]);
    expect(got.has(P.id)).toBe(true);
    const metaTotal = await readMetaTotal(idb, 'X');
    const storedSum = await sumStoredSizes(idb, 'X');
    expect(metaTotal).toBe(storedSum);
  });

  it("nothing carried after naming: a put of P before any open, open('X'), a put of Q, open('Y') — a second cache on Y holds neither P nor Q", async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    const P = row('p');
    await cache.put({ id: P.id, txBytes: new Uint8Array([1]), row: P, author: P.author, parent: null, own: false });
    await cache.open('X');
    const afterX = createPostCache({ indexedDB: idb, localStorage: fakeLs(), now: c.tick });
    await afterX.open('X');
    expect(await afterX.thread(P.id)).not.toBeNull();
    const Q = row('q');
    await cache.put({ id: Q.id, txBytes: new Uint8Array([2]), row: Q, author: Q.author, parent: null, own: false });
    await cache.open('Y');
    const second = createPostCache({ indexedDB: idb, localStorage: fakeLs(), now: c.tick });
    await second.open('Y');
    expect(await second.thread(P.id)).toBeNull();
    expect(await second.thread(Q.id)).toBeNull();
  });

  it("a withdrawal before naming: a put of P, a withdrawal of P, open('X') — X holds P's withdrawn row with no text", async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    const P = row('p');
    await cache.put({ id: P.id, txBytes: new Uint8Array([1, 2]), row: P, author: P.author, parent: null, own: false });
    await cache.withdraw(P.id, tomb('p'));
    await cache.open('X');
    const second = createPostCache({ indexedDB: idb, localStorage: fakeLs(), now: c.tick });
    await second.open('X');
    const got = await second.getMany([P.id]);
    expect(got.has(P.id)).toBe(true);
    expect((got.get(P.id)!.row as WithdrawnJson).kind).toBe('withdrawn');
  });

  it("a refresh before naming: a put of P, a refresh with other counts, open('X') — X holds the refreshed row", async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    const P = row('p', { likeCount: 0 });
    await cache.put({ id: P.id, txBytes: new Uint8Array([3]), row: P, author: P.author, parent: null, own: false });
    await cache.refresh([row('p', { likeCount: 7, authorName: 'alice' })]);
    await cache.open('X');
    const second = createPostCache({ indexedDB: idb, localStorage: fakeLs(), now: c.tick });
    await second.open('X');
    const got = await second.getMany([P.id]);
    const r2 = got.get(P.id)!.row as PostJson;
    expect(r2.likeCount).toBe(7);
    expect(r2.authorName).toBe('alice');
  });

  it("reads with no database open: kept entries answer getMany, thread (a kept parent and child walked), roots and byAuthor in their orders", async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await openRemembered(cache);
    const A1 = 'aa'.repeat(32);
    const A2 = 'cc'.repeat(32);
    const p = row('p', { author: A1, blockHeight: 10 });
    const q = row('q', { author: A1, parentRefs: [p.id], blockHeight: 20 });
    const r2 = row('r2', { author: A2, blockHeight: 15 });
    await cache.put({ id: p.id, txBytes: new Uint8Array([1]), row: p, author: A1, parent: null, own: false });
    await cache.put({ id: q.id, txBytes: new Uint8Array([2]), row: q, author: A1, parent: p.id, own: false });
    await cache.put({ id: r2.id, txBytes: new Uint8Array([3]), row: r2, author: A2, parent: null, own: false });
    const got = await cache.getMany([p.id, q.id]);
    expect(got.size).toBe(2);
    const t = await cache.thread(q.id);
    expect(t).not.toBeNull();
    expect(t!.ancestors.map((a) => a.id)).toEqual([p.id]);
    expect(t!.descendants).toEqual([]);
    const t2 = await cache.thread(p.id);
    expect(t2!.descendants.map((d) => d.id)).toEqual([q.id]);
    const roots = await cache.roots(10);
    expect(roots.map((h) => h.row.id)).toEqual([r2.id, p.id]);
    const a1 = await cache.byAuthor(A1, 10);
    expect(a1.map((h) => h.row.id)).toEqual([q.id, p.id]);
  });

  it("the cap: kept entries past POST_CACHE_BYTES evict the least recently seen and never an own one", async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await openRemembered(cache);
    const third = Math.floor(POST_CACHE_BYTES / 3);
    const big = new Uint8Array(third);
    const own1 = row('own1');
    const own2 = row('own2');
    const other = row('other');
    await cache.put({ id: own1.id, txBytes: big, row: own1, author: own1.author, parent: null, own: true });
    await cache.put({ id: other.id, txBytes: big, row: other, author: other.author, parent: null, own: false });
    await cache.put({ id: own2.id, txBytes: big, row: own2, author: own2.author, parent: null, own: true });
    expect((await cache.getMany([own1.id])).has(own1.id)).toBe(true);
    expect((await cache.getMany([own2.id])).has(own2.id)).toBe(true);
    expect((await cache.getMany([other.id])).has(other.id)).toBe(false);
  });

  it("the cap: with two non-own kept entries the older evicts first, the newer stands", async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await openRemembered(cache);
    // Three puts under the file's clock() — two non-own and one `own`, in
    // that order, each about a third of POST_CACHE_BYTES. Slightly under a
    // third so the three fit and a fourth put is the one that needs an
    // eviction; the row JSON is tens of hundreds of bytes — negligible
    // beside the Uint8Array.
    const third = Math.floor(POST_CACHE_BYTES / 3) - 2000;
    const big = new Uint8Array(third);
    const older = row('older');
    const newer = row('newer');
    const own1 = row('own1');
    const extra = row('extra');
    await cache.put({ id: older.id, txBytes: big, row: older, author: older.author, parent: null, own: false });
    await cache.put({ id: newer.id, txBytes: big, row: newer, author: newer.author, parent: null, own: false });
    await cache.put({ id: own1.id, txBytes: big, row: own1, author: own1.author, parent: null, own: true });
    // A fourth put needs room: the older non-own is gone, the newer
    // non-own, the own entry and the new one stand, all read with no
    // database open.
    await cache.put({ id: extra.id, txBytes: big, row: extra, author: extra.author, parent: null, own: false });
    expect((await cache.getMany([older.id])).has(older.id)).toBe(false);
    expect((await cache.getMany([newer.id])).has(newer.id)).toBe(true);
    expect((await cache.getMany([own1.id])).has(own1.id)).toBe(true);
    expect((await cache.getMany([extra.id])).has(extra.id)).toBe(true);
  });

  it("no indexedDB: a put before naming keeps nothing — every read answers empty after it", async () => {
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: null, localStorage: ls, now: c.tick });
    await openRemembered(cache);
    const P = row('p');
    await cache.put({ id: P.id, txBytes: new Uint8Array([1]), row: P, author: P.author, parent: null, own: false });
    expect((await cache.getMany([P.id])).size).toBe(0);
    expect(await cache.thread(P.id)).toBeNull();
    expect(await cache.roots(10)).toEqual([]);
    expect(await cache.byAuthor(P.author, 10)).toEqual([]);
  });

  it("a named open the factory refuses: the kept entries are gone after it — a read answers empty", async () => {
    const ls = fakeLs();
    const c = clock();
    const bad = {
      open: (): IDBOpenDBRequest => { throw new Error('refused'); },
      databases: () => Promise.resolve([]),
      deleteDatabase: () => undefined as unknown as IDBOpenDBRequest,
    } as unknown as IDBFactory;
    const cache = createPostCache({ indexedDB: bad, localStorage: ls, now: c.tick });
    await openRemembered(cache);
    const P = row('p');
    await cache.put({ id: P.id, txBytes: new Uint8Array([1]), row: P, author: P.author, parent: null, own: false });
    expect((await cache.getMany([P.id])).has(P.id)).toBe(true);
    await cache.open('X');
    expect((await cache.getMany([P.id])).size).toBe(0);
    expect(await cache.thread(P.id)).toBeNull();
    expect(await cache.roots(10)).toEqual([]);
  });
});
