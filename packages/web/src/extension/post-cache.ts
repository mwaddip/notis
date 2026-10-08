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
   *  JSON length. An estimate: the running total is the sum of this across
   *  every entry. */
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
  // The row holds no `tx` hex (held once in `txBytes`), so a size's row JSON
  // length is small — tens of hundreds of bytes.
  return txBytes.byteLength + JSON.stringify(row).length;
}

/** Strip the row of its `tx` hex before persisting: the transaction's bytes
 *  are held once in `txBytes`, so repeating them in the row doubles the entry
 *  (WEB_INTERFACE → The extension → "The post cache" — "the transaction's
 *  bytes; the row as the node last gave it, without its `tx` hex"). */
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
      };
      req.onsuccess = (): void => {
        db = req.result;
        openedChain = chain;
        remember(chain);
        // Compute the running total from the entries on disk.
        total = 0;
        try {
          const tx = db.transaction(STORE, 'readonly');
          const store = tx.objectStore(STORE);
          const cur = store.openCursor();
          cur.onsuccess = (): void => {
            const c = cur.result;
            if (c) {
              const e = c.value as Entry;
              total += e.size;
              c.continue();
            }
          };
          tx.oncomplete = (): void => resolve();
          tx.onerror = (): void => resolve();
          tx.onabort = (): void => resolve();
        } catch {
          resolve();
        }
      };
      req.onerror = (): void => resolve();
      req.onblocked = (): void => resolve();
    });
  }

  /** Run a store operation under one `readwrite` transaction, awaiting its
   *  completion. Resolves even on an abort — a put that quota refused is
   *  dropped, not thrown (WEB_INTERFACE → The extension → "The post cache"). */
  function run<T>(fn: (store: IDBObjectStore) => T): Promise<T | null> {
    if (db === null) return Promise.resolve(null);
    return new Promise<T | null>((resolve) => {
      let result: T | null = null;
      let tx: IDBTransaction;
      try {
        tx = db!.transaction(STORE, 'readwrite');
      } catch {
        resolve(null);
        return;
      }
      const store = tx.objectStore(STORE);
      try {
        result = fn(store);
      } catch {
        // A programming error in the callback — the transaction will abort.
      }
      tx.oncomplete = (): void => resolve(result);
      // A `QuotaExceededError` (or any put the browser refused) aborts the
      // transaction; the put is dropped and the running total was not moved.
      // This is the one failure path the module absorbs (→ "The post cache").
      tx.onerror = (): void => resolve(null);
      tx.onabort = (): void => resolve(null);
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

  /** Read every child of `parent`, through the parent index. */
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
      // `openCursor` takes a key directly (no IDBKeyRange needed): happy-dom
      // does not define `IDBKeyRange` globally, so we pass the parent id as
      // the key query.
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

  /** Evict least-recently-seen entries until `needed` bytes are free, never
   *  taking an `own` entry. Returns the bytes freed. */
  async function evictFor(needed: number): Promise<number> {
    if (db === null) return 0;
    if (needed <= 0) return 0;
    // Collect the non-own entries ordered by lastSeen asc through the index.
    const victims = await new Promise<Array<{ id: string; size: number }>>((resolve) => {
      const out: Array<{ id: string; size: number }> = [];
      let tx: IDBTransaction;
      try {
        tx = db!.transaction(STORE, 'readonly');
      } catch {
        resolve([]);
        return;
      }
      const idx = tx.objectStore(STORE).index(IDX_LAST_SEEN);
      const cur = idx.openCursor();
      let freed = 0;
      cur.onsuccess = (): void => {
        const c = cur.result;
        if (c) {
          const e = c.value as Entry;
          if (!e.own) {
            out.push({ id: e.id, size: e.size });
            freed += e.size;
            if (freed >= needed) {
              resolve(out);
              return;
            }
          }
          c.continue();
        }
      };
      tx.oncomplete = (): void => resolve(out);
      tx.onerror = (): void => resolve(out);
    });
    if (victims.length === 0) return 0;
    let freed = 0;
    const applied = await run((store) => {
      for (const v of victims) {
        store.delete(v.id);
        freed += v.size;
      }
    });
    if (applied === null) return 0;
    total -= freed;
    return freed;
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
    if (total + delta > POST_CACHE_BYTES) {
      await evictFor(total + delta - POST_CACHE_BYTES);
      if (total + delta > POST_CACHE_BYTES) {
        // Still does not fit — the store is full of `own` entries. Drop the
        // put, including the refresh of a smaller held row (its stored row
        // stays as it was).
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
    const applied = await run((store) => {
      store.put(e);
    });
    if (applied === null) {
      // Quota refused — the entry was not stored; the total is unchanged.
      return;
    }
    total += delta;
  }

  async function withdrawInternal(id: string, row: WithdrawnJson): Promise<void> {
    if (db === null) return;
    const prior = await readEntry(id);
    if (prior === null) return;
    const newSize = entrySize(new Uint8Array(0), row);
    const delta = newSize - prior.size;
    // A withdraw never evicts: it only shrinks or holds steady, since the row
    // keeps the entry's id and the bytes go.
    const e: Entry = {
      ...prior,
      txBytes: new Uint8Array(0),
      row,
      lastSeen: now(),
      size: newSize,
      // The parent/author on the entry remain the transaction's — the
      // withdrawn row does not restate them.
    };
    const applied = await run((store) => {
      store.put(e);
    });
    if (applied === null) return;
    total += delta;
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
    // throws — the two absorbed failures resolve), so pending is always a
    // resolved tail.
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
