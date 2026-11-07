// The extension's post cache (WEB_INTERFACE → The extension → "The post
// cache"): the posts the post check found `bound`, held in IndexedDB at the
// page's own origin behind one module. The App is handed the cache in the
// extension build alone; the web build is handed none, and `build-release.sh`
// refuses `notis.posts.` in its assets. A put never blocks or fails a render —
// the two failures the contract absorbs are a put that does not fit (quota and
// the module's cap) and a browser that gives the page no IndexedDB. This
// module answers no check and carries no `has`.

import type { PostJson, WithdrawnJson } from '../api/dto';
import { isWithdrawn } from '../api/dto';
import type { CachedThread, HeldPost, PostCache } from '../model/state';
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

  // WEB_INTERFACE → The extension → "A post checked before any tip run names a chain is kept until one does".
  // `chainNamed` is false until `open(chain)` has run — the first tip run's
  // naming — and true thereafter; while it is false and `idb` holds a factory,
  // every `put` keeps its entry in memory beside its write to the database the
  // remembered name opened, where one did. The kept entries follow the same
  // eviction rule as the stored ones; the named open writes them into the
  // opened database and clears the map.
  let chainNamed = false;
  const keptEntries = new Map<string, Entry>();
  let keptTotal = 0;

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

  /** Open the database for `chain` physically — the `IDBFactory.open`, the
   *  `versionchange` wiring, the delete of every other `notis.posts.*`, and
   *  the running total's read. Shared by `open(chain)` — the tip run's
   *  naming — and `openRemembered()`, which opens the remembered chain's
   *  database without naming it (WEB_INTERFACE → The extension → "The post
   *  cache", → "A post checked before any tip run names a chain is kept
   *  until one does"). */
  function openPhysical(chain: string): Promise<void> {
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
        // The module's own connection closes on `versionchange`, so another
        // of the extension's pages asking for a delete of this database is
        // never blocked by it (WEB_INTERFACE → The extension → "The post
        // cache"). The module then runs as it does with no database open.
        db.onversionchange = (): void => { closeDb(); };
        openedChain = chain;
        remember(chain);
        // One chain's database at a time (WEB_INTERFACE → The extension →
        // "The post cache"): every other `notis.posts.*` database the
        // factory lists is deleted, so what a chain reset or a chain a node
        // once named left behind goes with the next open. The open does not
        // wait for the deletes — a delete another connection holds must not
        // hold this cache shut.
        void deleteOtherChainDatabases(name);
        void readOrInitTotal().then(resolve, () => resolve());
      };
      req.onerror = (): void => resolve();
      req.onblocked = (): void => resolve();
    });
  }

  /** The tip run's naming — `PostCache.open(chain)`
   *  (WEB_INTERFACE → The extension → "A post checked before any tip run names a chain is kept until one does").
   *  The chain is marked named, the database is opened, every kept entry
   *  reaches the opened database — through the running total and the eviction
   *  rule exactly as a put moves them — and the kept entries clear, whether
   *  the open landed on a database or not. Rewriting an entry already in the
   *  remembered chain's database is a refresh of itself, so the total is not
   *  moved twice. A later `open` naming another chain carries nothing. */
  async function openInternal(chain: string): Promise<void> {
    chainNamed = true;
    await openPhysical(chain);
    if (db !== null) {
      const snapshot = [...keptEntries.values()];
      for (const e of snapshot) await writeEntryToDb(e);
    }
    keptEntries.clear();
    keptTotal = 0;
  }

  /** Open the remembered chain's database without naming it
   *  (WEB_INTERFACE → The extension → "A post checked before any tip run names a chain is kept until one does").
   *  Read at load, before the first tip run returns and where none does. A
   *  put before the first `open(chain)` is kept in memory beside its write to
   *  this database, where one opened. */
  async function openRememberedInternal(): Promise<void> {
    if (ls === null) return;
    let chain: string | null = null;
    try {
      const v = ls.getItem(CHAIN_KEY);
      chain = v === null || v === '' ? null : v;
    } catch { chain = null; }
    if (chain === null) return;
    await openPhysical(chain);
  }

  /** List the factory's databases and delete every `notis.posts.*` whose
   *  name is not the one we just opened. A factory without `databases` (an
   *  older browser) deletes nothing — the method is widely available but
   *  not universal, and its absence falls through silently
   *  (WEB_INTERFACE → The extension → "The post cache"). */
  function deleteOtherChainDatabases(keep: string): Promise<void> {
    if (idb === null) return Promise.resolve();
    const list = idb as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> };
    if (typeof list.databases !== 'function') return Promise.resolve();
    return list.databases().then(
      (dbs) => {
        for (const d of dbs) {
          const n = d.name;
          if (typeof n !== 'string') continue;
          if (!n.startsWith(DB_PREFIX)) continue;
          if (n === keep) continue;
          try { idb.deleteDatabase(n); } catch { /* the factory refused — fall silent */ }
        }
      },
      () => { /* the factory refused — fall silent */ },
    );
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

  /** Write a prepared Entry into the opened database, through the running
   *  total and the eviction rule exactly as a put moves them. The entry's
   *  `lastSeen` is kept — a put sets `lastSeen` to `now()` when building the
   *  Entry, while the kept-to-db replay at a named open keeps the kept
   *  entry's own last-seen (WEB_INTERFACE → The extension → "The post cache",
   *  → "A post checked before any tip run names a chain is kept until one does"). */
  async function writeEntryToDb(e: Entry): Promise<void> {
    if (db === null) return;
    const prior = await readEntry(e.id);
    const priorSize = prior ? prior.size : 0;
    const delta = e.size - priorSize;
    // A single entry larger than the cap is dropped — eviction would empty
    // the cache without ever fitting it (WEB_INTERFACE → The extension →
    // "The post cache").
    if (e.size > POST_CACHE_BYTES && priorSize === 0) return;
    let victims: Array<{ id: string; size: number }> = [];
    if (total + delta > POST_CACHE_BYTES) {
      const needed = total + delta - POST_CACHE_BYTES;
      victims = await collectVictims(needed, e.id);
      const freed = victims.reduce((s, v) => s + v.size, 0);
      if (total + delta - freed > POST_CACHE_BYTES) {
        // Still does not fit — the store is full of `own` entries. Drop
        // the put, including the refresh of a smaller held row (its
        // stored row stays as it was).
        return;
      }
    }
    // A refresh keeps `own` where the prior had it — a bound row for the
    // reader's own post refreshes it and leaves the mark alone.
    const toWrite: Entry = { ...e, own: e.own || (prior ? prior.own : false) };
    const freed = victims.reduce((s, v) => s + v.size, 0);
    const nextTotal = total + delta - freed;
    const applied = await run((entries, meta) => {
      for (const v of victims) entries.delete(v.id);
      entries.put(toWrite);
      meta.put({ key: META_KEY, bytes: nextTotal });
    });
    if (applied === null) return;
    total = nextTotal;
  }

  /** Keep an Entry in memory before any tip run names a chain
   *  (WEB_INTERFACE → The extension → "A post checked before any tip run names a chain is kept until one does").
   *  The kept entries are held to `POST_CACHE_BYTES` by the same rule the
   *  stored entries follow: least recently seen evicted first, the reader's
   *  own never, the entry being kept never, and a put that still does not
   *  fit is dropped. */
  function putKept(e: Entry): void {
    const prior = keptEntries.get(e.id);
    const priorSize = prior?.size ?? 0;
    const delta = e.size - priorSize;
    if (e.size > POST_CACHE_BYTES && priorSize === 0) return;
    const victims: Array<{ id: string; size: number }> = [];
    if (keptTotal + delta > POST_CACHE_BYTES) {
      const needed = keptTotal + delta - POST_CACHE_BYTES;
      const sorted = [...keptEntries.values()].sort((a, b) => a.lastSeen - b.lastSeen);
      let freed = 0;
      for (const v of sorted) {
        if (v.own) continue;
        if (v.id === e.id) continue;
        victims.push({ id: v.id, size: v.size });
        freed += v.size;
        if (freed >= needed) break;
      }
      if (keptTotal + delta - freed > POST_CACHE_BYTES) return;
    }
    const freed = victims.reduce((s, v) => s + v.size, 0);
    for (const v of victims) keptEntries.delete(v.id);
    // A refresh keeps `own` where the prior had it — a bound row for the
    // reader's own post refreshes it and leaves the mark alone.
    const toKeep: Entry = { ...e, own: e.own || (prior ? prior.own : false) };
    keptEntries.set(e.id, toKeep);
    keptTotal = keptTotal + delta - freed;
  }

  async function putInternal(entry: {
    id: string;
    txBytes: Uint8Array;
    row: PostJson;
    author: string;
    parent: string | null;
    own: boolean;
  }): Promise<void> {
    const row = stripTx(entry.row);
    const size = entrySize(entry.txBytes, row);
    const built: Entry = {
      id: entry.id,
      txBytes: entry.txBytes,
      row,
      author: entry.author,
      parent: entry.parent,
      lastSeen: now(),
      size,
      own: entry.own,
    };
    // WEB_INTERFACE → The extension → "A post checked before any tip run names a chain is kept until one does".
    if (!chainNamed && idb !== null) putKept(built);
    if (db === null) return;
    await writeEntryToDb(built);
  }

  /** Empty a kept entry's text and keep the entry
   *  (WEB_INTERFACE → The extension → "A post checked before any tip run names a chain is kept until one does").
   *  An id not kept is nothing. */
  function withdrawKept(id: string, row: WithdrawnJson): void {
    const prior = keptEntries.get(id);
    if (prior === undefined) return;
    const newSize = entrySize(new Uint8Array(0), row);
    const delta = newSize - prior.size;
    // The parent/author on the entry remain the transaction's — the
    // withdrawn row does not restate them.
    const next: Entry = { ...prior, txBytes: new Uint8Array(0), row, lastSeen: now(), size: newSize };
    keptEntries.set(id, next);
    keptTotal += delta;
  }

  async function withdrawInternal(id: string, row: WithdrawnJson): Promise<void> {
    if (keptEntries.has(id)) withdrawKept(id, row);
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

  /** Read entries for a list of ids as raw `Entry` records; an id not
   *  held is absent (WEB_INTERFACE → The extension → "The post cache"). An
   *  empty list and no database each answer an empty map; a transaction
   *  the browser refuses answers an empty map too (the module absorbs
   *  it). The shared read `getManyInternal` and `refreshInternal` both
   *  run. */
  function readEntries(ids: readonly string[]): Promise<Map<string, Entry>> {
    const out = new Map<string, Entry>();
    if (db === null || ids.length === 0) return Promise.resolve(out);
    return new Promise<Map<string, Entry>>((resolve) => {
      let tx: IDBTransaction;
      try {
        tx = db!.transaction(STORE, 'readonly');
      } catch { resolve(out); return; }
      const store = tx.objectStore(STORE);
      for (const id of ids) {
        const req = store.get(id);
        req.onsuccess = (): void => {
          const e = req.result as Entry | undefined;
          if (e !== undefined) out.set(e.id, e);
        };
      }
      tx.oncomplete = (): void => resolve(out);
      tx.onerror = (): void => resolve(out);
      tx.onabort = (): void => resolve(out);
    });
  }

  /** The entries the ids list name, each as a `HeldPost`: the row the
   *  entry holds, and the author and parent the transaction states
   *  (WEB_INTERFACE → The extension → "The post cache"). An id not held is
   *  absent from the map. */
  async function getManyInternal(ids: readonly string[]): Promise<Map<string, HeldPost>> {
    // WEB_INTERFACE → The extension → "A post checked before any tip run names a chain is kept until one does":
    // while no database is open, the kept entries answer the read.
    if (db === null) {
      const out = new Map<string, HeldPost>();
      for (const id of ids) {
        const e = keptEntries.get(id);
        if (e !== undefined) out.set(id, { row: e.row, author: e.author, parent: e.parent });
      }
      return out;
    }
    const entries = await readEntries(ids);
    const out = new Map<string, HeldPost>();
    for (const [id, e] of entries) out.set(id, { row: e.row, author: e.author, parent: e.parent });
    return out;
  }

  /** Refresh a kept entry's row and last-seen, as a refresh does a stored
   *  one (WEB_INTERFACE → The extension → "A post checked before any tip run names a chain is kept until one does").
   *  A withdrawn kept entry is left as it is. */
  function refreshKept(rows: readonly PostJson[]): void {
    if (rows.length === 0) return;
    for (const row of rows) {
      const prior = keptEntries.get(row.id);
      if (prior === undefined) continue;
      if (isWithdrawn(prior.row)) continue;
      const stripped = stripTx(row);
      const newSize = entrySize(prior.txBytes, stripped);
      const delta = newSize - prior.size;
      const next: Entry = { ...prior, row: stripped, lastSeen: now(), size: newSize };
      keptEntries.set(row.id, next);
      keptTotal += delta;
    }
  }

  /** For each row whose id is held, replace the entry's row (stored without
   *  `tx`) and `lastSeen`, keeping `txBytes`, `author`, `parent` and `own`;
   *  move the running total by the sum of the size differences, in the same
   *  transaction (WEB_INTERFACE → The extension → "The post cache"). An
   *  entry whose row is a `WithdrawnJson` is left as it is — the withdrawn
   *  row carries no text, and refresh never restores text or rewrites the
   *  withdrawal; an id not held is nothing; an empty list and no database
   *  are nothing. */
  async function refreshInternal(rows: readonly PostJson[]): Promise<void> {
    if (rows.length === 0) return;
    // WEB_INTERFACE → The extension → "A post checked before any tip run names a chain is kept until one does":
    // a refresh moves a kept entry as it moves a stored one.
    refreshKept(rows);
    if (db === null) return;
    // Read current entries in one transaction, decide the new entries, then
    // write them in one `run`.
    const prior = await readEntries(rows.map((r) => r.id));
    const updates: Array<{ id: string; entry: Entry; delta: number }> = [];
    for (const row of rows) {
      const held = prior.get(row.id);
      if (held === undefined) continue;
      if (isWithdrawn(held.row)) continue;
      const stripped = stripTx(row);
      const newSize = entrySize(held.txBytes, stripped);
      const delta = newSize - held.size;
      updates.push({
        id: held.id,
        entry: {
          ...held,
          row: stripped,
          lastSeen: now(),
          size: newSize,
        },
        delta,
      });
    }
    if (updates.length === 0) return;
    const totalDelta = updates.reduce((s, u) => s + u.delta, 0);
    const nextTotal = total + totalDelta;
    const applied = await run((entries, meta) => {
      for (const u of updates) entries.put(u.entry);
      meta.put({ key: META_KEY, bytes: nextTotal });
    });
    if (applied === null) return;
    total = nextTotal;
  }

  /** The height to place an entry at for the listing order
   *  (WEB_INTERFACE → The extension → "A failed listing draws the cache"):
   *  a withdrawn row is confirmed at its `withdrawnAtHeight`, a live post
   *  at its `blockHeight` (number) or `null` for pending. */
  function heightOf(row: PostJson | WithdrawnJson): number | null {
    if (isWithdrawn(row)) return row.withdrawnAtHeight;
    return row.blockHeight;
  }

  /** Compare two entries for the listing order (WEB_INTERFACE → The
   *  extension → "A failed listing draws the cache"): confirmed rows first
   *  by height descending, ties by id ascending; then the rows with no
   *  height (pending), ties by id ascending. */
  function compareEntries(a: Entry, b: Entry): number {
    const ha = heightOf(a.row);
    const hb = heightOf(b.row);
    if (ha === null && hb === null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    if (ha === null) return 1;
    if (hb === null) return -1;
    if (ha !== hb) return hb - ha;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  function sliceToHeld(entries: Entry[], limit: number): HeldPost[] {
    entries.sort(compareEntries);
    const out: HeldPost[] = [];
    for (let i = 0; i < entries.length && i < limit; i++) {
      const e = entries[i]!;
      out.push({ row: e.row, author: e.author, parent: e.parent });
    }
    return out;
  }

  /** Walk the entries store and collect the entries `parent === null` names.
   *  The parent index is non-unique over `parent`; IndexedDB does not index
   *  rows whose index key would be `null`, so an index cursor on the parent
   *  index cannot reach the roots — the store cursor is the one path
   *  (WEB_INTERFACE → The extension → "A failed listing draws the cache"). */
  function rootsInternal(limit: number): Promise<HeldPost[]> {
    if (limit <= 0) return Promise.resolve([]);
    // WEB_INTERFACE → The extension → "A post checked before any tip run names a chain is kept until one does":
    // while no database is open, roots answer from the kept entries.
    if (db === null) {
      const collected: Entry[] = [];
      for (const e of keptEntries.values()) if (e.parent === null) collected.push(e);
      return Promise.resolve(sliceToHeld(collected, limit));
    }
    return new Promise<HeldPost[]>((resolve) => {
      const collected: Entry[] = [];
      let tx: IDBTransaction;
      try {
        tx = db!.transaction(STORE, 'readonly');
      } catch { resolve([]); return; }
      const cur = tx.objectStore(STORE).openCursor();
      cur.onsuccess = (): void => {
        const c = cur.result;
        if (c) {
          const e = c.value as Entry;
          if (e.parent === null) collected.push(e);
          c.continue();
        }
      };
      tx.oncomplete = (): void => resolve(sliceToHeld(collected, limit));
      tx.onerror = (): void => resolve([]);
      tx.onabort = (): void => resolve([]);
    });
  }

  function byAuthorInternal(author: string, limit: number): Promise<HeldPost[]> {
    if (limit <= 0) return Promise.resolve([]);
    // WEB_INTERFACE → The extension → "A post checked before any tip run names a chain is kept until one does".
    if (db === null) {
      const collected: Entry[] = [];
      for (const e of keptEntries.values()) if (e.author === author) collected.push(e);
      return Promise.resolve(sliceToHeld(collected, limit));
    }
    return new Promise<HeldPost[]>((resolve) => {
      const collected: Entry[] = [];
      let tx: IDBTransaction;
      try {
        tx = db!.transaction(STORE, 'readonly');
      } catch { resolve([]); return; }
      const idx = tx.objectStore(STORE).index(IDX_AUTHOR);
      const cur = idx.openCursor(author);
      cur.onsuccess = (): void => {
        const c = cur.result;
        if (c) {
          collected.push(c.value as Entry);
          c.continue();
        }
      };
      tx.oncomplete = (): void => resolve(sliceToHeld(collected, limit));
      tx.onerror = (): void => resolve([]);
      tx.onabort = (): void => resolve([]);
    });
  }

  async function threadInternal(id: string): Promise<CachedThread | null> {
    // WEB_INTERFACE → The extension → "A post checked before any tip run names a chain is kept until one does":
    // while no database is open, thread walks kept parents and children.
    if (db === null) {
      const subject = keptEntries.get(id);
      if (subject === undefined) return null;
      const ancestors: Entry[] = [];
      const visited = new Set<string>([id]);
      let cur: Entry | undefined = subject;
      while (cur !== undefined && cur.parent !== null && !visited.has(cur.parent)) {
        const next = keptEntries.get(cur.parent);
        if (next === undefined) break;
        visited.add(next.id);
        ancestors.push(next);
        cur = next;
      }
      ancestors.reverse();
      const descendants: Entry[] = [];
      const queue: string[] = [id];
      const seen = new Set<string>([id]);
      while (queue.length > 0) {
        const parentId = queue.shift()!;
        for (const e of keptEntries.values()) {
          if (e.parent !== parentId) continue;
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          descendants.push(e);
          queue.push(e.id);
        }
      }
      return {
        post: subject.row,
        ancestors: ancestors.map((e) => e.row),
        descendants: descendants.map((e) => e.row),
      };
    }
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
    openRemembered(): Promise<void> {
      return serial(() => openRememberedInternal());
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
    getMany(ids): Promise<Map<string, HeldPost>> {
      return serial(() => getManyInternal(ids));
    },
    refresh(rows): Promise<void> {
      return serial(() => refreshInternal(rows));
    },
    roots(limit): Promise<HeldPost[]> {
      return serial(() => rootsInternal(limit));
    },
    byAuthor(author, limit): Promise<HeldPost[]> {
      return serial(() => byAuthorInternal(author, limit));
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
