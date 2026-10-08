// The extension's post cache (WEB_INTERFACE → The extension → "The post
// cache"): the posts the post check found `bound`, held in IndexedDB at the
// page's own origin behind one module. The App is handed the cache in the
// extension build alone; the web build is handed none, and `build-release.sh`
// refuses `notis.posts.` in its assets. A put never blocks or fails a render —
// the two failures the contract absorbs are a put that does not fit (quota and
// the module's cap) and a browser that gives the page no IndexedDB. Every
// read still checks every row: this module answers no check and carries no
// `has`.

import type { PostJson, WithdrawnJson } from '../api/dto';
import type { CachedThread, PostCache } from '../model/state';
import { POST_CACHE_BYTES } from '../model/state';

/** `localStorage` key that remembers the last chain's name
 *  (WEB_INTERFACE → The extension → "The post cache"). */
const CHAIN_KEY = 'notis.posts.chain';
/** The IndexedDB name prefix (→ "The post cache"). */
const DB_PREFIX = 'notis.posts.';
const STORE = 'entries';
const META = 'meta';
/** The one record of the meta store — the running sum of the entries' sizes,
 *  held with the entries so a put, a withdraw and an eviction move it in the
 *  same transaction (WEB_INTERFACE → The extension → "The post cache",
 *  "Size"). The store's shape is `{ key: 'total', bytes: number }`. */
const META_KEY = 'total';
const IDX_PARENT = 'parent';
const IDX_AUTHOR = 'author';
const IDX_LAST_SEEN = 'lastSeen';

/** One cached post. The transaction's bytes, the row the node last gave us
 *  without its `tx` hex (the bytes are held once), the author and the parent
 *  as the transaction states them (the check's, not the row's), when it was
 *  last seen, its size in bytes, and whether the reader signed it
 *  (WEB_INTERFACE → The extension → "The post cache"). A withdrawn row is
 *  held as a `WithdrawnJson` under the same id; `txBytes` is empty there. */
interface Entry {
  id: string;
  txBytes: Uint8Array;
  /** The row as the node last gave it (or the reader composed), without its
   *  `tx` hex. A withdrawn row is a `WithdrawnJson`; the entry's `txBytes` is
   *  empty then and the entry stays held — the node's word, and a lie costs a
   *  re-fetch. */
  row: PostJson | WithdrawnJson;
  /** The transaction's author, lowercase hex (the `bound` check's). */
  author: string;
  /** The transaction's one parent, or `null`. */
  parent: string | null;
  lastSeen: number;
  /** The entry's size, in bytes — the transaction's bytes plus the row's
   *  JSON length. An estimate held per entry; the meta store's `total` is
   *  the running sum of this across every entry
   *  (WEB_INTERFACE → The extension → "The post cache"). */
  size: number;
  own: boolean;
}

/** The dependencies the module takes — an injected clock for `lastSeen`, the
 *  `indexedDB` factory and the `localStorage` for the chain's name. Each
 *  defaults to the browser's own; a test substitutes `fake-indexeddb` and a
 *  Map-backed `localStorage`. */
export interface PostCacheDeps {
  now?: () => number;
  indexedDB?: IDBFactory | null;
  localStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

/** Compute an entry's size — the transaction's bytes plus the row's JSON
 *  length. An estimate, enough for the running total the cap holds. */
function entrySize(txBytes: Uint8Array, row: PostJson | WithdrawnJson): number {
  // The row holds no `tx` hex (held once in `txBytes`), so a row's JSON
  // length is small — tens of hundreds of bytes.
  return txBytes.byteLength + JSON.stringify(row).length;
}

/** The row is stored without its `tx` hex — the transaction's bytes are held
 *  once in `txBytes`, so repeating them in the row would double the entry
 *  (WEB_INTERFACE → The extension → "The post cache"). */
function stripTx(row: PostJson): PostJson {
  if (row.tx === undefined) return row;
  const out = { ...row };
  delete out.tx;
  return out;
}

export function createPostCache(deps: PostCacheDeps = {}): PostCache {
  const now = deps.now ?? Date.now;
  // The browser's own `indexedDB` and `localStorage`, or the dependencies the
  // test injects. With no `indexedDB` — a browser that gives the page none —
  // the module runs without a cache and says nothing (→ "The post cache").
  const idb: IDBFactory | null = deps.indexedDB === undefined
    ? (typeof indexedDB === 'undefined' ? null : indexedDB)
    : deps.indexedDB;
  const ls: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = deps.localStorage === undefined
    ? (typeof localStorage === 'undefined' ? null : localStorage)
    : deps.localStorage;

  // The current chain's handle and the in-memory running total; both move
  // together whenever `open` lands on a database. `pending` is the next
  // open's work, awaited by every operation so a put during an open does
  // not race the open.
  let db: IDBDatabase | null = null;
  let openedChain: string | null = null;
  let total = 0;
  let pending: Promise<void> = Promise.resolve();

  function remember(chain: string): void {
    if (ls === null) return;
    try { ls.setItem(CHAIN_KEY, chain); } catch { /* storage refused — fall silent */ }
  }

  function closeDb(): void {
    if (db !== null) {
      try { db.close(); } catch { /* already closed */ }
      db = null;
      openedChain = null;
      total = 0;
    }
  }

  function openInternal(chain: string): Promise<void> {
    if (idb === null) {
      // No IndexedDB — the module runs without a cache. Remember the chain
      // all the same, so a later browser that has one opens on it.
      remember(chain);
      return Promise.resolve();
    }
    if (openedChain === chain && db !== null) {
      remember(chain);
      return Promise.resolve();
    }
    closeDb();
    const name = DB_PREFIX + chain;
    return new Promise<void>((resolve) => {
      let req: IDBOpenDBRequest;
      try {
        req = idb.open(name, 1);
      } catch {
        // The factory refused — run without a cache.
        resolve();
        return;
      }
      req.onupgradeneeded = (): void => {
        const database = req.result;
        if (!database.objectStoreNames.contains(STORE)) {
          const store = database.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex(IDX_PARENT, 'parent', { unique: false });
          store.createIndex(IDX_AUTHOR, 'author', { unique: false });
          store.createIndex(IDX_LAST_SEEN, 'lastSeen', { unique: false });
        }
        if (!database.objectStoreNames.contains(META)) {
          database.createObjectStore(META, { keyPath: 'key' });
        }
      };
      req.onsuccess = (): void => {
        db = req.result;
        openedChain = chain;
        remember(chain);
        void readOrInitTotal().then(resolve, () => resolve());
      };
      req.onerror = (): void => resolve();
      req.onblocked = (): void => resolve();
    });
  }

  /** Read the running total from the meta store at open; where no record
   *  stands (a database that holds entries and no total record) sum the
   *  entries once and write the record (WEB_INTERFACE → The extension →
   *  "The post cache"). */
  function readOrInitTotal(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (db === null) { resolve(); return; }
      let tx: IDBTransaction;
      try {
        tx = db.transaction(META, 'readonly');
      } catch (e) { reject(e); return; }
      const req = tx.objectStore(META).get(META_KEY);
      req.onsuccess = (): void => {
        const row = req.result as { key: string; bytes: number } | undefined;
        if (row !== undefined && typeof row.bytes === 'number') {
          total = row.bytes;
          resolve();
          return;
        }
        void sumEntriesAndPersist().then(resolve, () => resolve());
      };
      req.onerror = (): void => resolve();
    });
  }

  function sumEntriesAndPersist(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (db === null) { resolve(); return; }
      let tx: IDBTransaction;
      try {
        tx = db.transaction([STORE, META], 'readwrite');
      } catch { resolve(); return; }
      const store = tx.objectStore(STORE);
      const meta = tx.objectStore(META);
      let sum = 0;
      const cur = store.openCursor();
      cur.onsuccess = (): void => {
        const c = cur.result;
        if (c) {
          const e = c.value as Entry;
          sum += e.size;
          c.continue();
          return;
        }
        meta.put({ key: META_KEY, bytes: sum });
      };
      tx.oncomplete = (): void => { total = sum; resolve(); };
      tx.onerror = (): void => resolve();
      tx.onabort = (): void => resolve();
    });
  }

  /** Read one entry, or `null` where the id is not held. */
  function readEntry(id: string): Promise<Entry | null> {
    if (db === null) return Promise.resolve(null);
    return new Promise<Entry | null>((resolve) => {
      let tx: IDBTransaction;
      try {
        tx = db!.transaction(STORE, 'readonly');
      } catch {
        resolve(null);
        return;
      }
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = (): void => resolve((req.result as Entry | undefined) ?? null);
      req.onerror = (): void => resolve(null);
    });
  }

  /** Read every entry whose `parent` field equals the given id, through the
   *  parent index. `openCursor` takes the id as its key directly — an
   *  `IDBKeyRange.only` is not needed and the fake IndexedDB happy-dom tests
   *  run against has no global `IDBKeyRange`. */
  function readChildren(parent: string): Promise<Entry[]> {
    if (db === null) return Promise.resolve([]);
    return new Promise<Entry[]>((resolve) => {
      const out: Entry[] = [];
      let tx: IDBTransaction;
      try {
        tx = db!.transaction(STORE, 'readonly');
      } catch {
        resolve([]);
        return;
      }
      const idx = tx.objectStore(STORE).index(IDX_PARENT);
      const cur = idx.openCursor(parent);
      cur.onsuccess = (): void => {
        const c = cur.result;
        if (c) {
          out.push(c.value as Entry);
          c.continue();
        }
      };
      tx.oncomplete = (): void => resolve(out);
      tx.onerror = (): void => resolve(out);
    });
  }

  /** Collect non-own entries ordered by lastSeen asc, skipping the given id,
   *  until the sum of their sizes covers `needed`. Runs in its own readonly
   *  transaction before the writing one that applies the eviction and put;
   *  the entry being put is never a victim (`skipId`). */
  function collectVictims(needed: number, skipId: string): Promise<Array<{ id: string; size: number }>> {
    if (db === null) return Promise.resolve([]);
    return new Promise((resolve) => {
      const out: Array<{ id: string; size: number }> = [];
      let tx: IDBTransaction;
      try {
        tx = db!.transaction(STORE, 'readonly');
      } catch { resolve([]); return; }
      const idx = tx.objectStore(STORE).index(IDX_LAST_SEEN);
      const cur = idx.openCursor();
      let freed = 0;
      cur.onsuccess = (): void => {
        const c = cur.result;
        if (c) {
          const e = c.value as Entry;
          if (!e.own && e.id !== skipId) {
            out.push({ id: e.id, size: e.size });
            freed += e.size;
            if (freed >= needed) { resolve(out); return; }
          }
          c.continue();
        }
      };
      tx.oncomplete = (): void => resolve(out);
      tx.onerror = (): void => resolve(out);
    });
  }

  /** Run a store operation over `entries` and `meta` under one `readwrite`
   *  transaction, awaiting its completion. The callback receives both
   *  stores, so the running total moves in the same transaction as the put,
   *  withdraw or eviction. Resolves `null` on a transaction the browser
   *  aborted or on a `DOMException` the IDB raised synchronously — the two
   *  failures the contract absorbs (WEB_INTERFACE → The extension →
   *  "The post cache": "a put that does not fit, or that the browser
   *  refuses, is dropped"). A throw that is not a `DOMException` — a
   *  programming error in the callback — rejects. */
  function run<T>(fn: (entries: IDBObjectStore, meta: IDBObjectStore) => T): Promise<T | null> {
    if (db === null) return Promise.resolve(null);
    return new Promise<T | null>((resolve, reject) => {
      let result: T | null = null;
      let tx: IDBTransaction;
      try {
        tx = db!.transaction([STORE, META], 'readwrite');
      } catch (e) {
        if (e instanceof DOMException) { resolve(null); return; }
        reject(e); return;
      }
      const entries = tx.objectStore(STORE);
      const meta = tx.objectStore(META);
      try {
        result = fn(entries, meta);
      } catch (e) {
        if (e instanceof DOMException) {
          // A `QuotaExceededError` on a `put`, or another storage failure
          // the browser raised synchronously, aborts the transaction and
          // the running total was not moved; the module absorbs it.
        } else {
          reject(e);
          return;
        }
      }
      tx.oncomplete = (): void => resolve(result);
      tx.onerror = (): void => resolve(null);
      tx.onabort = (): void => resolve(null);
    });
  }

  async function putInternal(entry: {
    id: string;
    txBytes: Uint8Array;
    row: PostJson;
    author: string;
    parent: string | null;
    own: boolean;
  }): Promise<void> {
    if (db === null) return;
    const row = stripTx(entry.row);
    const size = entrySize(entry.txBytes, row);
    const prior = await readEntry(entry.id);
    const priorSize = prior ? prior.size : 0;
    const delta = size - priorSize;
    // A single entry larger than the cap is dropped — eviction would empty
    // the cache without ever fitting it (WEB_INTERFACE → The extension →
    // "The post cache").
    if (size > POST_CACHE_BYTES && priorSize === 0) return;
    let victims: Array<{ id: string; size: number }> = [];
    if (total + delta > POST_CACHE_BYTES) {
      const needed = total + delta - POST_CACHE_BYTES;
      victims = await collectVictims(needed, entry.id);
      const freed = victims.reduce((s, v) => s + v.size, 0);
      if (total + delta - freed > POST_CACHE_BYTES) {
        // Still does not fit — the store is full of `own` entries. Drop
        // the put, including the refresh of a smaller held row (its
        // stored row stays as it was).
        return;
      }
    }
    const e: Entry = {
      id: entry.id,
      txBytes: entry.txBytes,
      row,
      author: entry.author,
      parent: entry.parent,
      lastSeen: now(),
      size,
      // A refresh keeps `own` where the prior had it — a bound row for the
      // reader's own post refreshes it and leaves the mark alone.
      own: entry.own || (prior ? prior.own : false),
    };
    const freed = victims.reduce((s, v) => s + v.size, 0);
    const nextTotal = total + delta - freed;
    const applied = await run((entries, meta) => {
      for (const v of victims) entries.delete(v.id);
      entries.put(e);
      meta.put({ key: META_KEY, bytes: nextTotal });
    });
    if (applied === null) return;
    total = nextTotal;
  }

  async function withdrawInternal(id: string, row: WithdrawnJson): Promise<void> {
    if (db === null) return;
    const prior = await readEntry(id);
    if (prior === null) return;
    const newSize = entrySize(new Uint8Array(0), row);
    const delta = newSize - prior.size;
    const nextTotal = total + delta;
    const e: Entry = {
      ...prior,
      txBytes: new Uint8Array(0),
      row,
      lastSeen: now(),
      size: newSize,
      // The parent/author on the entry remain the transaction's — the
      // withdrawn row does not restate them.
    };
    const applied = await run((entries, meta) => {
      entries.put(e);
      meta.put({ key: META_KEY, bytes: nextTotal });
    });
    if (applied === null) return;
    total = nextTotal;
  }

  async function threadInternal(id: string): Promise<CachedThread | null> {
    if (db === null) return null;
    const subject = await readEntry(id);
    if (subject === null) return null;
    // Walk parent links up through held entries; stop at the first parent not
    // held (WEB_INTERFACE → The extension → "The post cache"). Guard against
    // a cycle in the cache's data by holding a visited set.
    const ancestors: Entry[] = [];
    const visited = new Set<string>([id]);
    let cur: Entry | null = subject;
    while (cur !== null && cur.parent !== null && !visited.has(cur.parent)) {
      const next = await readEntry(cur.parent);
      if (next === null) break;
      visited.add(next.id);
      ancestors.push(next);
      cur = next;
    }
    ancestors.reverse(); // oldest first
    // Collect held descendants through the parent index, breadth-first.
    const descendants: Entry[] = [];
    const queue: string[] = [id];
    const seen = new Set<string>([id]);
    while (queue.length > 0) {
      const parentId = queue.shift()!;
      const kids = await readChildren(parentId);
      for (const kid of kids) {
        if (seen.has(kid.id)) continue;
        seen.add(kid.id);
        descendants.push(kid);
        queue.push(kid.id);
      }
    }
    return {
      post: subject.row,
      ancestors: ancestors.map((e) => e.row),
      descendants: descendants.map((e) => e.row),
    };
  }

  // Serialize operations so a second call does not race the first — the
  // module makes one order of events the test and the App can both rely on.
  function serial<T>(op: () => Promise<T>): Promise<T> {
    const next = pending.then(op);
    // Keep the chain alive even if the op throws (nothing in this module
    // throws under its absorbed failures — a programming error does, and
    // the operation surfaces it), so pending is always a resolved tail.
    pending = next.then(() => undefined, () => undefined);
    return next;
  }

  return {
    open(chain: string): Promise<void> {
      return serial(() => openInternal(chain));
    },
    put(entry): Promise<void> {
      return serial(() => putInternal(entry));
    },
    withdraw(id, row): Promise<void> {
      return serial(() => withdrawInternal(id, row));
    },
    thread(id): Promise<CachedThread | null> {
      return serial(() => threadInternal(id));
    },
  };
}

/** The last chain's name the module remembered (WEB_INTERFACE → The extension
 *  → "The post cache"). The App reads it at start so the cache opens before
 *  the first tip run returns and where none does. */
export function rememberedChain(ls?: Pick<Storage, 'getItem'> | null): string | null {
  const store = ls === undefined
    ? (typeof localStorage === 'undefined' ? null : localStorage)
    : ls;
  if (store === null) return null;
  try {
    const v = store.getItem(CHAIN_KEY);
    return v === null || v === '' ? null : v;
  } catch {
    return null;
  }
}
