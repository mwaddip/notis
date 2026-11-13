// @vitest-environment happy-dom
// WEB_INTERFACE → The settings window → "The serve row",
// → The extension → "The post cache" → "A serving read is answered from
// it": the provider the mesh client's serving reader answers
// `ModifierRequest` from, read through the real post cache over
// `fake-indexeddb`.

import { describe, it, expect } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createPostCache } from '../../src/extension/post-cache';
import { postTextsFromCache } from '../../src/extension/post-texts';
import { POST_CACHE_BYTES } from '../../src/model/state';
import type { PostJson, WithdrawnJson } from '../../src/api/dto';

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

function fakeLs(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

function clock(): { tick: () => number; now: number } {
  const c = { now: 1000, tick: (): number => ++c.now };
  return c;
}

/** `openRemembered` is a method of the cache module; the test calls it
 *  through the public interface. */
function openRemembered(cache: ReturnType<typeof createPostCache>): Promise<void> {
  return (cache as unknown as { openRemembered(): Promise<void> }).openRemembered();
}

describe('postTextsFromCache — the provider', () => {
  it("answers a live entry's text, and nothing for a withdrawn or textless one", async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await cache.open('A');
    const live = row('live', { content: 'hello world' });
    const dead = row('dead');
    await cache.put({ id: live.id, txBytes: new Uint8Array([1, 2]), row: live, author: live.author, parent: null, own: false });
    await cache.put({ id: dead.id, txBytes: new Uint8Array([3, 4]), row: dead, author: dead.author, parent: null, own: false });
    await cache.withdraw(dead.id, tomb('dead'));
    const provider = postTextsFromCache(cache);
    const out = await provider([live.id, dead.id, hid('missing')]);
    expect(out.size).toBe(1);
    expect(out.get(live.id)).toBe('hello world');
    expect(out.has(dead.id)).toBe(false);
    expect(out.has(hid('missing'))).toBe(false);
  });

  it('answers the kept entries before a chain is named', async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    // `openRemembered` with no stored name opens no database: the put
    // keeps the entry in memory, and the provider answers it.
    await openRemembered(cache);
    const r = row('r', { content: 'kept' });
    await cache.put({ id: r.id, txBytes: new Uint8Array([1, 2, 3]), row: r, author: r.author, parent: null, own: false });
    const provider = postTextsFromCache(cache);
    const out = await provider([r.id]);
    expect(out.get(r.id)).toBe('kept');
  });

  it("moves no entry's last-seen", async () => {
    const idb = new IDBFactory();
    const ls = fakeLs();
    const c = clock();
    const cache = createPostCache({ indexedDB: idb, localStorage: ls, now: c.tick });
    await cache.open('A');
    // Three non-own entries and one own, each about a third of
    // POST_CACHE_BYTES, so a fourth put forces an eviction. `older` is
    // put first, so its last-seen is earliest.
    const third = Math.floor(POST_CACHE_BYTES / 3) - 2000;
    const big = new Uint8Array(third);
    const older = row('older');
    const newer = row('newer');
    const own1 = row('own1');
    await cache.put({ id: older.id, txBytes: big, row: older, author: older.author, parent: null, own: false });
    await cache.put({ id: newer.id, txBytes: big, row: newer, author: newer.author, parent: null, own: false });
    await cache.put({ id: own1.id, txBytes: big, row: own1, author: own1.author, parent: null, own: true });
    // The provider reads `older` — if it moved last-seen, `older` would
    // be newer than `newer`, and the next eviction would take `newer`.
    const provider = postTextsFromCache(cache);
    const out = await provider([older.id]);
    expect(out.get(older.id)).toBe('older');
    // A fourth put forces an eviction of the least recently seen non-own
    // entry — that is `older`, because the provider did not move it.
    const extra = row('extra');
    await cache.put({ id: extra.id, txBytes: big, row: extra, author: extra.author, parent: null, own: false });
    const got = await cache.getMany([older.id, newer.id, own1.id, extra.id]);
    expect(got.has(own1.id)).toBe(true);
    expect(got.has(extra.id)).toBe(true);
    expect(got.has(newer.id)).toBe(true);
    expect(got.has(older.id)).toBe(false);
  });
});
