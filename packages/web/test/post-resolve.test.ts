// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import {
  resolvePosts,
  BATCH_READ_MAX,
  BATCH_RESOLVE_MS,
  type ResolveDeps,
  type BoundPost,
} from '../src/model/post-resolve';
import type { PostJson, PostStatus } from '../src/api/dto';
import type { PostCheck } from '@dagsocial/nipopow-client';

// The pure resolve (WEB_INTERFACE → The extension → "The resolve"): nothing
// of `fetch`, nothing of the clock, nothing of the DOM — a test drives it
// over fake nodes, a fake check and an injected clock.

const hid = (s: string): string =>
  [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(64, '0');

function id(label: string): string {
  return hid(label).slice(0, 64);
}

function nIds(count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(hid(String(i)));
  return out;
}

function fullRow(label: string, content: string | null = 'hello'): PostJson {
  return {
    id: id(label), content, contentHash: id('h' + label),
    author: id('author'), parentRefs: [], protocolVersion: 1, type: 'regular',
    status: 'confirmed' as PostStatus, blockHeight: 10, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null,
    txId: id('tx' + label), tx: 'de'.repeat(16),
  };
}

/** A fake clock the test drives by hand. `now` advances only when the test
 *  calls `tick`; `until(at)` resolves on the next microtask when the clock
 *  reads at or past `at`, and never until then. */
function clock(start = 0): {
  now(): number;
  tick(ms: number): Promise<void>;
  until: ResolveDeps['until'];
} {
  let t = start;
  const waiters: Array<{ at: number; resolve: () => void }> = [];
  const drain = (): void => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.at <= t) {
        waiters[i]!.resolve();
        waiters.splice(i, 1);
      }
    }
  };
  return {
    now: () => t,
    tick: async (ms: number): Promise<void> => {
      t += ms;
      drain();
      // Let the resolved waiters' continuations run.
      await Promise.resolve();
      await Promise.resolve();
    },
    until: (at: number): Promise<void> => new Promise<void>((resolve) => {
      if (t >= at) {
        resolve();
        return;
      }
      waiters.push({ at, resolve });
    }),
  };
}

/** A bound check for a row with text — content = row.content as a string. */
function bound(row: PostJson): PostCheck {
  return {
    status: 'bound', id: row.id, txBytes: new Uint8Array(0),
    author: row.author, parent: row.parentRefs[0] ?? null,
  };
}

function placeholderCheck(row: PostJson): PostCheck {
  return {
    status: 'bound', id: row.id, txBytes: new Uint8Array(0),
    author: row.author, parent: row.parentRefs[0] ?? null,
  };
}

function unbound(): PostCheck {
  return { status: 'unbound', reason: 'signature', verdict: 'bad' };
}

function unserved(): PostCheck {
  return { status: 'unserved' };
}

function nothingToBind(): PostCheck {
  return { status: 'nothing-to-bind' };
}

interface Call {
  base: string;
  ids: readonly string[];
  signal: AbortSignal;
}

interface AnswerMap {
  [base: string]: Array<{ ids: readonly string[]; body: unknown } | undefined>;
}

/** A fake set of nodes. Each node answers from a FIFO queue the test fills,
 *  and records the ids every call carried, with its base. `ask` resolves to
 *  the queued body or rejects where the body is `null`. An abort of the
 *  signal rejects a pending answer with an AbortError. */
function mockNodes(answers: AnswerMap): {
  calls: Call[];
  ask: ResolveDeps['ask'];
} {
  const calls: Call[] = [];
  return {
    calls,
    ask: (base, ids, signal) => {
      calls.push({ base, ids, signal });
      const q = answers[base] ?? [];
      const next = q.shift();
      if (next === undefined) {
        return Promise.reject(new Error('no answer'));
      }
      if (next.body === null) return Promise.reject(new Error('refused'));
      return new Promise<unknown>((resolve, reject) => {
        if (signal.aborted) { reject(new Error('aborted')); return; }
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        resolve(next.body);
      });
    },
  };
}

/** Simple check-by-dictionary. The test writes `{ id: PostCheck }`; unseen
 *  rows resolve to `nothing-to-bind`, which the resolve treats as "the id
 *  goes on". */
function makeCheck(dict: Record<string, PostCheck>): (rows: unknown[]) => PostCheck[] {
  return (rows: unknown[]): PostCheck[] => rows.map((row) => {
    if (typeof row !== 'object' || row === null) return nothingToBind();
    const rid = (row as { id?: unknown }).id;
    if (typeof rid !== 'string') return nothingToBind();
    return dict[rid] ?? nothingToBind();
  });
}

/** The resolve builds its own `done` set, so an `onBound` listener gathers
 *  every bound row the resolve emitted, call by call. */
function recorder(): { calls: BoundPost[][]; onBound: (p: BoundPost[]) => void } {
  const calls: BoundPost[][] = [];
  return { calls, onBound: (p) => calls.push(p) };
}

describe('resolvePosts — one node serves every id in one request', () => {
  it('onBound is called once, ends is empty, chunks is 1', async () => {
    const row0 = fullRow('r0'); const row1 = fullRow('r1');
    const r = recorder(); const c = clock();
    const net = mockNodes({ A: [{ ids: [row0.id, row1.id], body: { posts: [row0, row1] } }] });
    const check = makeCheck({ [row0.id]: bound(row0), [row1.id]: bound(row1) });
    const res = resolvePosts([row0.id, row1.id], {
      nodes: ['A'], start: 0, ask: net.ask, check, now: c.now, until: c.until, onBound: r.onBound,
    });
    expect(res.chunks).toBe(1);
    const ends = await res.ends;
    expect(ends.size).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toHaveLength(2);
  });
});

describe('resolvePosts — round-robin pointer across three nodes', () => {
  it('250 ids go as three chunks to three nodes from start, chunks is 3', async () => {
    const ids = nIds(250);
    const net = mockNodes({ A: [{ ids: [], body: { posts: [] } }], B: [{ ids: [], body: { posts: [] } }], C: [{ ids: [], body: { posts: [] } }] });
    const r = recorder(); const c = clock();
    const res = resolvePosts(ids, {
      nodes: ['A', 'B', 'C'], start: 0, ask: net.ask, check: makeCheck({}), now: c.now, until: c.until, onBound: r.onBound,
    });
    expect(res.chunks).toBe(3);
    await res.ends;
    // Three nodes were asked, each once in round one.
    const roundOneCalls = net.calls.slice(0, 3);
    expect(roundOneCalls.map((cc) => cc.base).sort()).toEqual(['A', 'B', 'C']);
    expect(roundOneCalls.map((cc) => cc.ids.length).reduce((a, b) => a + b, 0)).toBe(250);
    // The first chunk went to the node at start.
    expect(net.calls[0]!.base).toBe('A');
  });

  it('with two nodes and three chunks, the third chunk goes to the first node again', async () => {
    const ids = nIds(250);
    const net = mockNodes({
      A: [{ ids: [], body: { posts: [] } }, { ids: [], body: { posts: [] } }],
      B: [{ ids: [], body: { posts: [] } }],
    });
    const r = recorder(); const c = clock();
    const res = resolvePosts(ids, {
      nodes: ['A', 'B'], start: 0, ask: net.ask, check: makeCheck({}), now: c.now, until: c.until, onBound: r.onBound,
    });
    expect(res.chunks).toBe(3);
    await res.ends;
    expect(net.calls[0]!.base).toBe('A');
    expect(net.calls[1]!.base).toBe('B');
    expect(net.calls[2]!.base).toBe('A');
  });
});

describe('resolvePosts — a node that leaves ids out, the next node serves them', () => {
  it('an id A left out is asked of B, which serves it', async () => {
    const r0 = fullRow('r0'); const r1 = fullRow('r1');
    const r = recorder(); const c = clock();
    const net = mockNodes({
      A: [{ ids: [r0.id, r1.id], body: { posts: [r0] } }], // only r0
      B: [{ ids: [r1.id], body: { posts: [r1] } }],
    });
    const check = makeCheck({ [r0.id]: bound(r0), [r1.id]: bound(r1) });
    const res = resolvePosts([r0.id, r1.id], {
      nodes: ['A', 'B'], start: 0, ask: net.ask, check, now: c.now, until: c.until, onBound: r.onBound,
    });
    const ends = await res.ends;
    expect(ends.size).toBe(0);
    expect(net.calls).toHaveLength(2);
    expect(net.calls[1]!.base).toBe('B');
    expect(net.calls[1]!.ids).toEqual([r1.id]);
  });
});

describe('resolvePosts — a request that fails, served nothing', () => {
  it('ask rejects — the ids are not asked again this round, and go to the next node', async () => {
    const r0 = fullRow('r0');
    const r = recorder(); const c = clock();
    const net = mockNodes({
      A: [{ ids: [r0.id], body: null }], // rejected
      B: [{ ids: [r0.id], body: { posts: [r0] } }],
    });
    const res = resolvePosts([r0.id], {
      nodes: ['A', 'B'], start: 0, ask: net.ask, check: makeCheck({ [r0.id]: bound(r0) }), now: c.now, until: c.until, onBound: r.onBound,
    });
    const ends = await res.ends;
    expect(ends.size).toBe(0);
    expect(net.calls.map((x) => x.base)).toEqual(['A', 'B']);
  });

  it('a body that is null, a string, {}, or { posts: "x" } each serve nothing', async () => {
    for (const bad of [null, 'oops', {}, { posts: 'x' }, { posts: 42 }]) {
      const r0 = fullRow('r0');
      const r = recorder(); const c = clock();
      const net = mockNodes({
        A: [{ ids: [r0.id], body: bad }],
        B: [{ ids: [r0.id], body: { posts: [r0] } }],
      });
      const res = resolvePosts([r0.id], {
        nodes: ['A', 'B'], start: 0, ask: net.ask, check: makeCheck({ [r0.id]: bound(r0) }), now: c.now, until: c.until, onBound: r.onBound,
      });
      const ends = await res.ends;
      expect(ends.size).toBe(0);
      expect(net.calls[1]!.base).toBe('B');
    }
  });
});

describe('resolvePosts — unbound rules', () => {
  it('unbound at one node and bound at the next ends with no unbound', async () => {
    const r0 = fullRow('r0');
    const r = recorder(); const c = clock();
    const net = mockNodes({
      A: [{ ids: [r0.id], body: { posts: [r0] } }],
      B: [{ ids: [r0.id], body: { posts: [r0] } }],
    });
    let calls = 0;
    const check = (rows: unknown[]): PostCheck[] => rows.map(() => (calls++ === 0 ? unbound() : bound(r0)));
    const res = resolvePosts([r0.id], {
      nodes: ['A', 'B'], start: 0, ask: net.ask, check, now: c.now, until: c.until, onBound: r.onBound,
    });
    const ends = await res.ends;
    expect(ends.size).toBe(0);
  });

  it('unbound at every node ends unbound', async () => {
    const r0 = fullRow('r0');
    const r = recorder(); const c = clock();
    const net = mockNodes({
      A: [{ ids: [r0.id], body: { posts: [r0] } }],
      B: [{ ids: [r0.id], body: { posts: [r0] } }],
    });
    const check = makeCheck({ [r0.id]: unbound() });
    const res = resolvePosts([r0.id], {
      nodes: ['A', 'B'], start: 0, ask: net.ask, check, now: c.now, until: c.until, onBound: r.onBound,
    });
    const ends = await res.ends;
    expect(ends.get(r0.id)).toBe('unbound');
  });

  it('unbound at one and left out by the rest ends unbound', async () => {
    const r0 = fullRow('r0');
    const r = recorder(); const c = clock();
    const net = mockNodes({
      A: [{ ids: [r0.id], body: { posts: [r0] } }],
      B: [{ ids: [r0.id], body: { posts: [] } }],
    });
    const check = makeCheck({ [r0.id]: unbound() });
    const res = resolvePosts([r0.id], {
      nodes: ['A', 'B'], start: 0, ask: net.ask, check, now: c.now, until: c.until, onBound: r.onBound,
    });
    const ends = await res.ends;
    expect(ends.get(r0.id)).toBe('unbound');
  });
});

describe('resolvePosts — withdrawn and tx:null do not serve', () => {
  it('a withdrawn row (nothing-to-bind) and a row with tx:null (unserved) each go on', async () => {
    const r0 = fullRow('r0'); const r1 = fullRow('r1');
    const r = recorder(); const c = clock();
    const net = mockNodes({
      A: [{ ids: [r0.id, r1.id], body: { posts: [{ kind: 'withdrawn', id: r0.id }, { ...r1, tx: null }] } }],
      B: [{ ids: [r0.id, r1.id], body: { posts: [r0, r1] } }],
    });
    const check = (rows: unknown[]): PostCheck[] => rows.map((row) => {
      const rid = (row as { id?: unknown }).id;
      if (rid === r0.id && (row as { kind?: string }).kind === 'withdrawn') return nothingToBind();
      if (rid === r1.id && (row as { tx?: unknown }).tx === null) return unserved();
      if (rid === r0.id) return bound(r0);
      if (rid === r1.id) return bound(r1);
      return nothingToBind();
    });
    const res = resolvePosts([r0.id, r1.id], {
      nodes: ['A', 'B'], start: 0, ask: net.ask, check, now: c.now, until: c.until, onBound: r.onBound,
    });
    const ends = await res.ends;
    expect(ends.size).toBe(0);
    expect(net.calls[1]!.base).toBe('B');
    expect(net.calls[1]!.ids).toEqual([r0.id, r1.id]);
  });
});

describe('resolvePosts — placeholder vs the text', () => {
  it('a placeholder at one node and the text at the next: the text lands, once', async () => {
    const place = fullRow('r0', null); const text = fullRow('r0', 'the text');
    const r = recorder(); const c = clock();
    const net = mockNodes({
      A: [{ ids: [place.id], body: { posts: [place] } }],
      B: [{ ids: [place.id], body: { posts: [text] } }],
    });
    const check = makeCheck({ [place.id]: placeholderCheck(place) });
    const res = resolvePosts([place.id], {
      nodes: ['A', 'B'], start: 0, ask: net.ask, check, now: c.now, until: c.until, onBound: r.onBound,
    });
    const ends = await res.ends;
    expect(ends.size).toBe(0);
    // Exactly one onBound call for the text — the chunk's bound rows.
    const flat = r.calls.flat();
    expect(flat).toHaveLength(1);
    expect(flat[0]!.row.content).toBe('the text');
  });

  it("a placeholder at every node: the placeholder lands at the end, and the id has no end", async () => {
    const p0 = fullRow('r0', null); const p1 = fullRow('r0', null);
    const r = recorder(); const c = clock();
    const net = mockNodes({
      A: [{ ids: [p0.id], body: { posts: [p0] } }],
      B: [{ ids: [p0.id], body: { posts: [p1] } }],
    });
    const check = makeCheck({ [p0.id]: placeholderCheck(p0) });
    const res = resolvePosts([p0.id], {
      nodes: ['A', 'B'], start: 0, ask: net.ask, check, now: c.now, until: c.until, onBound: r.onBound,
    });
    const ends = await res.ends;
    expect(ends.has(p0.id)).toBe(false);
    const flat = r.calls.flat();
    expect(flat).toHaveLength(1);
    expect(flat[0]!.row.content).toBeNull();
  });
});

describe('resolvePosts — every node is asked for an id at most once; a served id is never asked again', () => {
  it('three nodes and an id served by the first — no later node is asked for it', async () => {
    const r0 = fullRow('r0'); const r1 = fullRow('r1');
    const r = recorder(); const c = clock();
    const net = mockNodes({
      A: [{ ids: [r0.id, r1.id], body: { posts: [r0] } }], // only r0
      B: [{ ids: [r1.id], body: { posts: [r1] } }],
      C: [], // never asked
    });
    const check = makeCheck({ [r0.id]: bound(r0), [r1.id]: bound(r1) });
    const res = resolvePosts([r0.id, r1.id], {
      nodes: ['A', 'B', 'C'], start: 0, ask: net.ask, check, now: c.now, until: c.until, onBound: r.onBound,
    });
    const ends = await res.ends;
    expect(ends.size).toBe(0);
    // Only two calls — A and B.
    expect(net.calls.map((x) => x.base)).toEqual(['A', 'B']);
  });
});

describe('resolvePosts — nobody-asked-for rows are not read', () => {
  it('rows under foreign ids, one id a hundred times, 10 000 rows: check is called once with at most the chunk ids, first row of each', async () => {
    const r0 = fullRow('r0'); const r1 = fullRow('r1');
    const r = recorder(); const c = clock();
    const foreign = fullRow('foreign');
    // The chunk asked [r0, r1]; the body carries extras, repeats and a non-string id.
    const extras: unknown[] = [foreign, r0, { ...r0, content: 'later' }, { id: 42 }];
    for (let i = 0; i < 100; i++) extras.push(r1);
    const big: unknown[] = [...extras];
    for (let i = 0; i < 10000; i++) big.push(fullRow('r' + String(i + 2)));
    const net = mockNodes({ A: [{ ids: [r0.id, r1.id], body: { posts: big } }] });
    let checkCalls = 0; let checkedCount = 0;
    const check = (rows: unknown[]): PostCheck[] => {
      checkCalls += 1;
      checkedCount = rows.length;
      return rows.map((row) => {
        const rid = (row as { id?: unknown }).id;
        if (rid === r0.id) return bound(r0);
        if (rid === r1.id) return bound(r1);
        return nothingToBind();
      });
    };
    const res = resolvePosts([r0.id, r1.id], {
      nodes: ['A'], start: 0, ask: net.ask, check, now: c.now, until: c.until, onBound: r.onBound,
    });
    const ends = await res.ends;
    expect(ends.size).toBe(0);
    expect(checkCalls).toBe(1);
    // At most two rows reached check — the first row under each of r0 and r1.
    expect(checkedCount).toBeLessThanOrEqual(2);
    // Only r0's and r1's rows were counted; the second r0 row was dropped.
    expect(checkedCount).toBe(2);
  });
});

describe("resolvePosts — a node that never answers: the clock reaches the deadline, the promise resolves", () => {
  it("ids end 'unserved' and no request leaves at or after the deadline", async () => {
    const r0 = fullRow('r0');
    const r = recorder(); const c = clock();
    // A node whose answer is a Promise that never resolves and never rejects.
    const stall = new Promise<unknown>(() => {});
    const calls: Call[] = [];
    const ask: ResolveDeps['ask'] = (base, ids, signal) => { calls.push({ base, ids, signal }); return stall; };
    const res = resolvePosts([r0.id], {
      nodes: ['A'], start: 0, ask, check: makeCheck({}), now: c.now, until: c.until, onBound: r.onBound,
    });
    // Advance the clock past the deadline so `until` resolves.
    await c.tick(BATCH_RESOLVE_MS + 1);
    const ends = await res.ends;
    expect(ends.get(r0.id)).toBe('unserved');
    expect(calls).toHaveLength(1); // No second request leaves after the deadline.
  });
});

describe('resolvePosts — no id and no node', () => {
  it('no id: ends is empty, chunks is 0, nothing is asked', async () => {
    const net = mockNodes({});
    const r = recorder(); const c = clock();
    const res = resolvePosts([], {
      nodes: ['A'], start: 0, ask: net.ask, check: makeCheck({}), now: c.now, until: c.until, onBound: r.onBound,
    });
    expect(res.chunks).toBe(0);
    const ends = await res.ends;
    expect(ends.size).toBe(0);
    expect(net.calls).toHaveLength(0);
  });

  it("no node: every id ends 'unserved' and nothing is asked", async () => {
    const r0 = fullRow('r0');
    const net = mockNodes({});
    const r = recorder(); const c = clock();
    const res = resolvePosts([r0.id, id('r1')], {
      nodes: [], start: 0, ask: net.ask, check: makeCheck({}), now: c.now, until: c.until, onBound: r.onBound,
    });
    expect(res.chunks).toBe(0);
    const ends = await res.ends;
    expect(ends.get(r0.id)).toBe('unserved');
    expect(ends.get(id('r1'))).toBe('unserved');
    expect(net.calls).toHaveLength(0);
  });
});

describe('resolvePosts — check is called once a chunk, never once a row', () => {
  it('two chunks across two nodes: two check calls, each over its chunk', async () => {
    const ids = nIds(BATCH_READ_MAX + 1);
    const net = mockNodes({
      A: [{ ids: [], body: { posts: [] } }],
      B: [{ ids: [], body: { posts: [] } }],
    });
    const r = recorder(); const c = clock();
    let checkCalls = 0;
    const check = (rows: unknown[]): PostCheck[] => {
      checkCalls += 1;
      return rows.map(() => nothingToBind());
    };
    const res = resolvePosts(ids, {
      nodes: ['A', 'B'], start: 0, ask: net.ask, check, now: c.now, until: c.until, onBound: r.onBound,
    });
    await res.ends;
    expect(checkCalls).toBe(2);
  });
});

describe('resolvePosts — dedup in order and the pointer at `start`', () => {
  it('ids repeated are deduped in order; chunks is 1 and the chunk went to node at `start`', async () => {
    const r0 = fullRow('r0');
    const r = recorder(); const c = clock();
    const net = mockNodes({ B: [{ ids: [r0.id], body: { posts: [r0] } }] });
    const check = makeCheck({ [r0.id]: bound(r0) });
    const res = resolvePosts([r0.id, r0.id, r0.id], {
      nodes: ['A', 'B'], start: 1, ask: net.ask, check, now: c.now, until: c.until, onBound: r.onBound,
    });
    expect(res.chunks).toBe(1);
    await res.ends;
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]!.base).toBe('B');
    expect(net.calls[0]!.ids).toEqual([r0.id]);
  });
});

describe('resolvePosts — a thrown check is logged once and read as a request that failed', () => {
  it("every id in the chunk advances a node; the resolve resolves", async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r0 = fullRow('r0');
    const r = recorder(); const c = clock();
    const net = mockNodes({
      A: [{ ids: [r0.id], body: { posts: [r0] } }],
      B: [{ ids: [r0.id], body: { posts: [r0] } }],
    });
    let calls = 0;
    const check = (rows: unknown[]): PostCheck[] => {
      calls += 1;
      if (calls === 1) throw new Error('check blew up');
      return rows.map(() => bound(r0));
    };
    const res = resolvePosts([r0.id], {
      nodes: ['A', 'B'], start: 0, ask: net.ask, check, now: c.now, until: c.until, onBound: r.onBound,
    });
    const ends = await res.ends;
    expect(ends.size).toBe(0);
    expect(net.calls.map((x) => x.base)).toEqual(['A', 'B']);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("resolvePosts — a thrown onBound is logged once and the resolve resolves", () => {
  it('throws from onBound do not reject the resolve', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r0 = fullRow('r0');
    const c = clock();
    const net = mockNodes({ A: [{ ids: [r0.id], body: { posts: [r0] } }] });
    const check = makeCheck({ [r0.id]: bound(r0) });
    const res = resolvePosts([r0.id], {
      nodes: ['A'], start: 0, ask: net.ask, check, now: c.now, until: c.until,
      onBound: (): void => { throw new Error('oops'); },
    });
    const ends = await res.ends;
    expect(ends.size).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('resolvePosts — a synchronously thrown ask is a failed request', () => {
  it("ids advance to the next node, which serves", async () => {
    const r0 = fullRow('r0');
    const r = recorder(); const c = clock();
    const calls: Call[] = [];
    let first = true;
    const ask: ResolveDeps['ask'] = (base, ids, signal) => {
      calls.push({ base, ids, signal });
      if (first) { first = false; throw new Error('synchronous'); }
      return Promise.resolve({ posts: [r0] });
    };
    const res = resolvePosts([r0.id], {
      nodes: ['A', 'B'], start: 0, ask, check: makeCheck({ [r0.id]: bound(r0) }), now: c.now, until: c.until, onBound: r.onBound,
    });
    const ends = await res.ends;
    expect(ends.size).toBe(0);
    expect(calls.map((x) => x.base)).toEqual(['A', 'B']);
  });
});

// New cases (AF1 · Task 4b)

describe("resolvePosts — a bound row the reader refuses is not well-formed: the id goes on, no unbound counted", () => {
  it("a `bound` with a string for likeCount at one node and the well-formed row at the next: the second lands", async () => {
    const r0 = fullRow('r0');
    // The first node answers a row that is bound but malformed under the
    // reader — likeCount a string.
    const badRow = { ...r0, likeCount: '3' };
    const r = recorder(); const c = clock();
    const net = mockNodes({
      A: [{ ids: [r0.id], body: { posts: [badRow] } }],
      B: [{ ids: [r0.id], body: { posts: [r0] } }],
    });
    const check = (rows: unknown[]): PostCheck[] => rows.map(() => bound(r0));
    const res = resolvePosts([r0.id], {
      nodes: ['A', 'B'], start: 0, ask: net.ask, check, now: c.now, until: c.until, onBound: r.onBound,
    });
    const ends = await res.ends;
    expect(ends.size).toBe(0);
    const flat = r.calls.flat();
    expect(flat).toHaveLength(1);
    expect(flat[0]!.row.content).toBe('hello');
  });

  it("a bound-but-malformed row at every node ends 'unserved', never 'unbound'", async () => {
    const r0 = fullRow('r0');
    const badRow = { ...r0, likeCount: '3' };
    const r = recorder(); const c = clock();
    const net = mockNodes({
      A: [{ ids: [r0.id], body: { posts: [badRow] } }],
      B: [{ ids: [r0.id], body: { posts: [badRow] } }],
    });
    const check = (rows: unknown[]): PostCheck[] => rows.map(() => bound(r0));
    const res = resolvePosts([r0.id], {
      nodes: ['A', 'B'], start: 0, ask: net.ask, check, now: c.now, until: c.until, onBound: r.onBound,
    });
    const ends = await res.ends;
    expect(ends.get(r0.id)).toBe('unserved');
  });
});

describe('resolvePosts — the rebuilt row the resolve emits', () => {
  it('an extra key is not carried on the row onBound receives, nor `tx`', async () => {
    const r0 = fullRow('r0');
    const rowWithExtra: unknown = { ...r0, surprise: 'ignored', confirmedAuthor: 'x' };
    const r = recorder(); const c = clock();
    const net = mockNodes({ A: [{ ids: [r0.id], body: { posts: [rowWithExtra] } }] });
    const check = (): PostCheck[] => [bound(r0)];
    const res = resolvePosts([r0.id], {
      nodes: ['A'], start: 0, ask: net.ask, check, now: c.now, until: c.until, onBound: r.onBound,
    });
    await res.ends;
    const flat = r.calls.flat();
    expect(flat).toHaveLength(1);
    const row = flat[0]!.row as unknown as Record<string, unknown>;
    expect(row['surprise']).toBeUndefined();
    expect(row['confirmedAuthor']).toBeUndefined();
    expect(row['tx']).toBeUndefined();
  });
});

describe('resolvePosts — the signal is aborted when the deadline fires, the second node is never asked', () => {
  it("the signal reads `aborted` after the clock passes the deadline", async () => {
    const r0 = fullRow('r0');
    const r = recorder(); const c = clock();
    const stall = new Promise<unknown>(() => {});
    const calls: Call[] = [];
    const ask: ResolveDeps['ask'] = (base, ids, signal) => { calls.push({ base, ids, signal }); return stall; };
    const res = resolvePosts([r0.id], {
      nodes: ['A', 'B'], start: 0, ask, check: makeCheck({}), now: c.now, until: c.until, onBound: r.onBound,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal.aborted).toBe(false);
    await c.tick(BATCH_RESOLVE_MS + 1);
    const ends = await res.ends;
    expect(ends.get(r0.id)).toBe('unserved');
    expect(calls).toHaveLength(1); // B never asked
    expect(calls[0]!.signal.aborted).toBe(true);
  });
});

describe('resolvePosts — a body that arrives after the deadline lands nothing', () => {
  it("`onBound` is not called and the id ends 'unserved'", async () => {
    const r0 = fullRow('r0');
    const r = recorder(); const c = clock();
    // `ask` returns a promise the test settles after the deadline fires.
    let settle: (v: unknown) => void = () => {};
    const askPromise = new Promise<unknown>((resolve) => { settle = resolve; });
    const calls: Call[] = [];
    const ask: ResolveDeps['ask'] = (base, ids, signal) => { calls.push({ base, ids, signal }); return askPromise; };
    const res = resolvePosts([r0.id], {
      nodes: ['A'], start: 0, ask, check: makeCheck({ [r0.id]: bound(r0) }), now: c.now, until: c.until, onBound: r.onBound,
    });
    // Pass the deadline — beat wins the race before the body settles.
    await c.tick(BATCH_RESOLVE_MS + 1);
    // Now settle the body after the tick.
    settle({ posts: [r0] });
    const ends = await res.ends;
    expect(ends.get(r0.id)).toBe('unserved');
    expect(r.calls).toHaveLength(0);
  });
});

describe('resolvePosts — until is called once a resolve, never once a round', () => {
  it('a resolve of three rounds calls `until` once', async () => {
    const r0 = fullRow('r0');
    // Three nodes, each failing r0 — a round advances all unbound counts
    // and the next round asks the next node.
    const r = recorder();
    let untilCalls = 0;
    const c = clock();
    const wrappedUntil: ResolveDeps['until'] = (at: number): Promise<void> => {
      untilCalls += 1;
      return c.until(at);
    };
    const net = mockNodes({
      A: [{ ids: [r0.id], body: null }],
      B: [{ ids: [r0.id], body: null }],
      C: [{ ids: [r0.id], body: null }],
    });
    const res = resolvePosts([r0.id], {
      nodes: ['A', 'B', 'C'], start: 0, ask: net.ask, check: makeCheck({}), now: c.now, until: wrappedUntil, onBound: r.onBound,
    });
    await res.ends;
    expect(untilCalls).toBe(1);
    // All three nodes were asked, each in its own round.
    expect(net.calls.map((x) => x.base)).toEqual(['A', 'B', 'C']);
  });
});

describe('resolvePosts — a resolve that ends before the deadline leaves its signal not aborted', () => {
  it("the signal is not aborted at the moment the promise settles", async () => {
    const r0 = fullRow('r0');
    const r = recorder(); const c = clock();
    const net = mockNodes({ A: [{ ids: [r0.id], body: { posts: [r0] } }] });
    const check = makeCheck({ [r0.id]: bound(r0) });
    const seenSignals: AbortSignal[] = [];
    const ask: ResolveDeps['ask'] = (base, ids, signal) => {
      seenSignals.push(signal);
      return net.ask(base, ids, signal);
    };
    const res = resolvePosts([r0.id], {
      nodes: ['A'], start: 0, ask, check, now: c.now, until: c.until, onBound: r.onBound,
    });
    const ends = await res.ends;
    expect(ends.size).toBe(0);
    expect(seenSignals).toHaveLength(1);
    expect(seenSignals[0]!.aborted).toBe(false);
  });
});
