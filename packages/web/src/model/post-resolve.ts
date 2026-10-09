import type { PostJson } from '../api/dto';
import { readBoundRow } from '../api/post-row';
import type { PostCheck } from '@dagsocial/nipopow-client';

// The pure resolve (WEB_INTERFACE → The extension → "The resolve"). The posts
// a list lacks are read by id from the seed list's nodes in turn, through
// `POST /posts/batch` (NODE_INTERFACE → Posts → "The batch read answers posts
// by id"). This module takes nothing from `fetch`, from the clock or from
// IndexedDB; every seam is in `ResolveDeps`, so a test drives it over fakes
// and so the extension's resolver (`src/extension/post-resolver.ts`) is the
// one place `fetch` lives.

/** The most ids one request takes (CONSTANTS → HTTP view bounds). */
export const BATCH_READ_MAX = 100;
/** How long one resolve runs, over all its nodes and requests
 *  (CONSTANTS → Client defaults). */
export const BATCH_RESOLVE_MS = 10_000;

/** One id's end when no node bound its text. `'unserved'` — no node answered a
 *  row for it; `'unbound'` — some node answered a row that did not match its
 *  signature. An id a node bound has no end — its row goes to `onBound`
 *  (WEB_INTERFACE → The extension → "The resolve"). */
export type ResolveEnd = 'unserved' | 'unbound';

/** A row the resolve bound and the check that bound it. `row` is the row the
 *  reader (`readBoundRow`) rebuilt from the node's answer, held to its own
 *  fields alone — the one that reaches the client's state and the cache,
 *  never the node's; `check` is the `bound` arm the post check answered for
 *  it, carrying the transaction's bytes, the proven author and parent
 *  (WEB_INTERFACE → The extension → "A checked row is taken field by field").
 *  The caller folds the row's identity into a full `PostJson`
 *  (`model/light.ts → withNodeWord`), draws it, and puts it into the cache
 *  (WEB_INTERFACE → The extension → "The post check"). */
export interface BoundPost {
  row: PostJson;
  check: Extract<PostCheck, { status: 'bound' }>;
}

/** The seams the resolve takes. The caller answers each; this module computes
 *  the rounds, the chunks, the dedup, the deadline race and the end
 *  (WEB_INTERFACE → The extension → "The resolve"). */
export interface ResolveDeps {
  /** The seed list's bases, duplicates dropped, the reading node first. */
  nodes: readonly string[];
  /** The pointer for this call's first chunk — the index into `nodes` where
   *  round one starts. The resolver carries it across calls. */
  start: number;
  /** Ask one node for a chunk of ids, with the resolve's abort signal — a
   *  request still open when the deadline fires is aborted
   *  (WEB_INTERFACE → The extension → "A request the limit beats is
   *  aborted"). The 2xx body resolves; a status outside 2xx, a body that
   *  will not parse as JSON, a network failure and an aborted request all
   *  reject. */
  ask: (base: string, ids: readonly string[], signal: AbortSignal) => Promise<unknown>;
  /** The post check — `checkPosts` of `@dagsocial/nipopow-client`
   *  (WEB_INTERFACE → The extension → "The post check"). */
  check: (rows: unknown[]) => PostCheck[];
  /** The clock. Read once for the deadline, and again before every request
   *  the resolve would send. */
  now: () => number;
  /** Resolves when the clock reads `at`, called once a resolve for the race
   *  against the deadline across every request. The resolver answers one
   *  over `setTimeout`; a test answers one driven by `vi.useFakeTimers()`
   *  or by hand. */
  until: (at: number) => Promise<void>;
  /** Bound rows for the ids one chunk served. Called once per chunk; the
   *  caller draws the cards and puts the rows into the cache. */
  onBound: (posts: BoundPost[]) => void;
}

/** The result of one resolve. `chunks` is round one's chunk count — known
 *  when `resolvePosts` returns, so the resolver's round-robin pointer moves
 *  at the call (WEB_INTERFACE → The extension → "A pointer walks the
 *  nodes"); `ends` resolves to every id no node bound, with its status. */
export interface ResolveResult {
  chunks: number;
  ends: Promise<Map<string, ResolveEnd>>;
}

/** What a chunk of a round carries while it is in flight. `ids` are the ids
 *  this chunk asked, in order; `nodeIndex` is the index of the node this
 *  chunk went to in `deps.nodes`. */
interface Chunk {
  ids: string[];
  nodeIndex: number;
}

/** The resolve's working state for an id — the next node to ask, how many
 *  nodes have been asked, whether any node answered the id unbound, and the
 *  first placeholder row some node answered. */
interface IdState {
  nextNode: number;
  askedCount: number;
  anyUnbound: boolean;
  placeholder: BoundPost | null;
}

/** Round-robin resolve. Pure of `fetch` and clocks; every seam reaches it
 *  through `deps`. The call is synchronous up to round one's chunk cut —
 *  `chunks` is known when it returns — then the async part walks the rounds
 *  under one deadline. Never rejects — a thrown `ask` reads as a request
 *  that failed and is not logged; a thrown `check` reads as a request that
 *  failed and is logged once through `console.error`; a thrown `onBound`
 *  leaves its ids bound and is logged once through `console.error`. */
export function resolvePosts(ids: readonly string[], deps: ResolveDeps): ResolveResult {
  // Dedup in order; the early end for no nodes or no ids.
  const uniq: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    uniq.push(id);
  }
  const n = deps.nodes.length;
  if (n === 0 || uniq.length === 0) {
    const ends = new Map<string, ResolveEnd>();
    for (const id of uniq) ends.set(id, 'unserved');
    return { chunks: 0, ends: Promise.resolve(ends) };
  }

  // Round one — cut the ids in order into chunks of at most BATCH_READ_MAX,
  // chunk j to node (start + j) mod n. The cut is computed once here; the
  // state's `nextNode` reads it rather than recomputing by division.
  const roundOneChunks: Chunk[] = [];
  for (let j = 0; j < uniq.length; j += BATCH_READ_MAX) {
    const chunkIds = uniq.slice(j, j + BATCH_READ_MAX);
    roundOneChunks.push({
      ids: chunkIds,
      nodeIndex: (deps.start + roundOneChunks.length) % n,
    });
  }

  return { chunks: roundOneChunks.length, ends: runResolve(uniq, deps, n, roundOneChunks) };
}

async function runResolve(
  ids: readonly string[],
  deps: ResolveDeps,
  n: number,
  roundOneChunks: Chunk[],
): Promise<Map<string, ResolveEnd>> {
  // The deadline is taken once; the controller aborts every open request
  // when the clock passes it, and `until` is called once a resolve
  // (WEB_INTERFACE → The extension → "A request the limit beats is
  // aborted").
  const deadline = deps.now() + BATCH_RESOLVE_MS;
  const controller = new AbortController();
  const beat: Promise<typeof BEAT> = deps.until(deadline).then(() => {
    controller.abort();
    return BEAT;
  });

  // One entry per id, keyed from the chunk the id landed in: `nextNode` is
  // the chunk's node, and `done` holds ids a node bound so a later round
  // never asks them again.
  const state = new Map<string, IdState>();
  for (const chunk of roundOneChunks) {
    for (const id of chunk.ids) {
      state.set(id, { nextNode: chunk.nodeIndex, askedCount: 0, anyUnbound: false, placeholder: null });
    }
  }
  const done = new Set<string>();

  // Each round sends its chunks at once and waits for every one. A new round
  // is built from the ids still wanted whose askedCount is below n.
  let round = roundOneChunks;
  while (round.length > 0) {
    if (deps.now() >= deadline) break;
    await runRound(round, deadline, controller, beat, state, done, n, deps);
    round = nextRound(ids, state, done, n);
  }

  // The end — every id not in `done` either leaves as a placeholder (some
  // node answered a `bound` row with no text), or ends `unbound` if any
  // node did, else `unserved` (WEB_INTERFACE → The extension → "The
  // resolve").
  const ends = new Map<string, ResolveEnd>();
  const placeholders: BoundPost[] = [];
  for (const id of ids) {
    if (done.has(id)) continue;
    const s = state.get(id)!;
    if (s.placeholder !== null) {
      placeholders.push(s.placeholder);
      continue;
    }
    ends.set(id, s.anyUnbound ? 'unbound' : 'unserved');
  }
  if (placeholders.length > 0) tryOnBound(deps, placeholders);
  return ends;
}

/** Send a round's chunks at once; a chunk the deadline beats is a failed
 *  request for the ids it carried (WEB_INTERFACE → The extension → "A
 *  request the limit beats is aborted"). */
async function runRound(
  chunks: readonly Chunk[],
  deadline: number,
  controller: AbortController,
  beat: Promise<typeof BEAT>,
  state: Map<string, IdState>,
  done: Set<string>,
  n: number,
  deps: ResolveDeps,
): Promise<void> {
  const inFlight: Array<Promise<void>> = [];
  for (const chunk of chunks) {
    if (deps.now() >= deadline) {
      // No request leaves at or after the deadline — treated as a failed
      // request so each id advances a node.
      recordFailedChunk(chunk, state, n);
      continue;
    }
    inFlight.push(dispatchChunk(chunk, controller, beat, state, done, n, deps));
  }
  await Promise.all(inFlight);
}

/** Advance every still-wanted id in the chunk by one node. An id already
 *  removed by a sibling chunk is left alone (WEB_INTERFACE → The extension
 *  → "A node does not serve an id"). */
function recordFailedChunk(
  chunk: Chunk,
  state: Map<string, IdState>,
  totalNodes: number,
): void {
  for (const id of chunk.ids) {
    const s = state.get(id);
    if (s === undefined) continue;
    s.askedCount += 1;
    s.nextNode = (chunk.nodeIndex + 1) % totalNodes;
  }
}

/** Send one chunk, race it against the deadline, apply the body. A chunk
 *  whose `ask` rejects synchronously, whose promise rejects (the aborted
 *  arm included), or returns a bad body served nothing. */
async function dispatchChunk(
  chunk: Chunk,
  controller: AbortController,
  beat: Promise<typeof BEAT>,
  state: Map<string, IdState>,
  done: Set<string>,
  n: number,
  deps: ResolveDeps,
): Promise<void> {
  const base = deps.nodes[chunk.nodeIndex]!;
  let askPromise: Promise<unknown>;
  try {
    askPromise = deps.ask(base, chunk.ids, controller.signal);
  } catch {
    recordFailedChunk(chunk, state, n);
    return;
  }
  const safe = Promise.resolve(askPromise).catch(() => FAILED);
  const outcome = await Promise.race<unknown>([safe, beat]);
  if (outcome === FAILED || outcome === BEAT) {
    recordFailedChunk(chunk, state, n);
    return;
  }
  applyBody(outcome, chunk, state, done, n, deps);
}

/** Markers for the race. Private symbols so no body could spoof them. */
const FAILED: unique symbol = Symbol('ask failed');
const BEAT: unique symbol = Symbol('deadline beat');

/** Read one chunk's body: pick the first row under each id the chunk asked
 *  and still wants, send them to `check` as one call, and record each id's
 *  outcome. One `check` call a chunk, a thrown `check` logged once through
 *  `console.error` and treated as a request that failed (WEB_INTERFACE →
 *  The extension → "The resolve"). */
function applyBody(
  body: unknown,
  chunk: Chunk,
  state: Map<string, IdState>,
  done: Set<string>,
  n: number,
  deps: ResolveDeps,
): void {
  if (typeof body !== 'object' || body === null) {
    recordFailedChunk(chunk, state, n);
    return;
  }
  const posts = (body as Record<string, unknown>)['posts'];
  if (!Array.isArray(posts)) {
    recordFailedChunk(chunk, state, n);
    return;
  }
  // The ids this chunk asked and still wants, in a set the row-reader
  // consults. A row an earlier row of this body took is not read.
  const wantedByChunk = new Set<string>();
  for (const id of chunk.ids) if (!done.has(id)) wantedByChunk.add(id);

  // The first row under each id the chunk asked. A row the chunk did not
  // ask, or whose id is not a string, or whose id was already taken, is
  // not read.
  const rowsForCheck: unknown[] = [];
  const idsForRows: string[] = [];
  const takenByRow: Set<string> = new Set();
  for (const row of posts) {
    if (typeof row !== 'object' || row === null) continue;
    const id = (row as Record<string, unknown>)['id'];
    if (typeof id !== 'string') continue;
    if (!wantedByChunk.has(id)) continue;
    if (takenByRow.has(id)) continue;
    takenByRow.add(id);
    rowsForCheck.push(row);
    idsForRows.push(id);
  }

  let checks: PostCheck[];
  try {
    checks = deps.check(rowsForCheck);
  } catch (e) {
    console.error(e);
    recordFailedChunk(chunk, state, n);
    return;
  }

  // Decide each id in the chunk. A row read above answers from `checks`; an
  // id with no row read falls through to the "anything else" arm.
  const boundThisChunk: BoundPost[] = [];
  for (const id of chunk.ids) {
    const s = state.get(id);
    if (s === undefined) continue;
    s.askedCount += 1;
    s.nextNode = (chunk.nodeIndex + 1) % n;
    const rowIndex = idsForRows.indexOf(id);
    if (rowIndex === -1) continue;
    const check = checks[rowIndex];
    if (check === undefined) continue;
    if (check.status === 'bound') {
      // The checked row is taken field by field — a bound row the reader
      // refuses is one the node did not serve: the id goes on to its next
      // node, `anyUnbound` is not set, nothing lands (WEB_INTERFACE → The
      // extension → "A row that is not well-formed is not shown and not
      // cached").
      const rebuilt = readBoundRow(rowsForCheck[rowIndex]);
      if (rebuilt === null) continue;
      if (typeof rebuilt.content === 'string') {
        done.add(id);
        state.delete(id);
        boundThisChunk.push({ row: rebuilt, check });
      } else {
        // content is null — the placeholder; the reader leaves no row
        // whose content is neither (WEB_INTERFACE → The extension → "A
        // `bound` placeholder is kept while the rest are asked for the
        // text").
        if (s.placeholder === null) s.placeholder = { row: rebuilt, check };
      }
      continue;
    }
    if (check.status === 'unbound') {
      s.anyUnbound = true;
      continue;
    }
    // `nothing-to-bind` and `unserved` — the id goes on.
  }

  if (boundThisChunk.length > 0) tryOnBound(deps, boundThisChunk);
}

/** Build the next round from the ids still wanted whose `askedCount` is
 *  below `n`, grouped by `nextNode`, in chunks of at most `BATCH_READ_MAX`.
 *  The ids are iterated in the original order the caller passed in, so
 *  chunks are stable and tests can refer to them. */
function nextRound(
  originalIds: readonly string[],
  state: Map<string, IdState>,
  done: Set<string>,
  totalNodes: number,
): Chunk[] {
  const buckets = new Map<number, string[]>();
  for (const id of originalIds) {
    if (done.has(id)) continue;
    const s = state.get(id);
    if (s === undefined) continue;
    if (s.askedCount >= totalNodes) continue;
    const list = buckets.get(s.nextNode);
    if (list) list.push(id);
    else buckets.set(s.nextNode, [id]);
  }
  const chunks: Chunk[] = [];
  // Round-robin by `nextNode` ascending — a deterministic walk a test can
  // assert on. The order among chunks does not affect correctness; the
  // chunks of a round all leave at once.
  const nodeIndices = [...buckets.keys()].sort((a, b) => a - b);
  for (const nodeIndex of nodeIndices) {
    const ids = buckets.get(nodeIndex)!;
    for (let j = 0; j < ids.length; j += BATCH_READ_MAX) {
      chunks.push({ ids: ids.slice(j, j + BATCH_READ_MAX), nodeIndex });
    }
  }
  return chunks;
}

/** Call `onBound` for the chunk's bound rows. A thrown `onBound` is logged
 *  once through `console.error` and the resolve carries on — the ids are
 *  already bound, and rethrowing would reject the resolve (WEB_INTERFACE →
 *  The extension → "The resolve"). */
function tryOnBound(deps: ResolveDeps, posts: BoundPost[]): void {
  try {
    deps.onBound(posts);
  } catch (e) {
    console.error(e);
  }
}
