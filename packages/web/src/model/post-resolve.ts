import type { PostJson } from '../api/dto';
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
 *  (WEB_INTERFACE → The extension → "At the end"). */
export type ResolveEnd = 'unserved' | 'unbound';

/** A row the resolve bound and the check that bound it. `check.content` carries
 *  the body a node served or `null` for a placeholder. The caller folds the
 *  row's identity into a full `PostJson` (`model/light.ts → withNodeWord`),
 *  draws it, and puts it into the cache
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
  /** Ask one node for a chunk of ids. The 2xx body resolves; a status outside
   *  2xx, a body that will not parse as JSON and a network failure all
   *  reject. */
  ask: (base: string, ids: readonly string[]) => Promise<unknown>;
  /** The post check — `checkPosts` of `@dagsocial/nipopow-client`
   *  (WEB_INTERFACE → The extension → "The post check"). */
  check: (rows: unknown[]) => PostCheck[];
  /** The clock. Read once for the deadline, and again before every request
   *  the resolve would send. */
  now: () => number;
  /** Resolves when the clock reads `at`, for the per-chunk race against the
   *  deadline. The resolver answers one over `setTimeout`; a test answers
   *  one driven by `vi.useFakeTimers()` or by hand. */
  until: (at: number) => Promise<void>;
  /** Bound rows for the ids one chunk served. Called once per chunk; the
   *  caller draws the cards and puts the rows into the cache. */
  onBound: (posts: BoundPost[]) => void;
}

/** The result of one resolve. `ends` holds every id no node bound, with its
 *  status; `chunks` is round one's chunk count, round-robin from `start`. */
export interface ResolveResult {
  ends: Map<string, ResolveEnd>;
  chunks: number;
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
 *  through `deps`. Never rejects — a thrown `ask`, `check` or `onBound` is
 *  absorbed: a thrown `ask` is read as a request that failed, and a thrown
 *  `check` served nothing — the rule *"A node does not serve an id … whose
 *  request fails"* decides both (WEB_INTERFACE → The extension → "A node does
 *  not serve an id"). A thrown `onBound` leaves the ids bound: the caller's
 *  bug does not rewind what every other id was decided from, and rethrowing
 *  would make the resolve reject. */
export function resolvePosts(
  ids: readonly string[],
  deps: ResolveDeps,
): Promise<ResolveResult> {
  // Rule 1 — dedup in order, and the early end for no nodes or no ids.
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
    return Promise.resolve({ ends, chunks: 0 });
  }

  return runResolve(uniq, deps, n);
}

async function runResolve(
  ids: readonly string[],
  deps: ResolveDeps,
  n: number,
): Promise<ResolveResult> {
  // Rule 2 — the deadline is taken once.
  const deadline = deps.now() + BATCH_RESOLVE_MS;

  // The resolve's state. One entry per id; `done` holds the ids a node bound,
  // so round two never asks them again.
  const state = new Map<string, IdState>();
  for (let j = 0; j < ids.length; j++) {
    const id = ids[j]!;
    state.set(id, {
      nextNode: (deps.start + Math.floor(j / BATCH_READ_MAX)) % n,
      askedCount: 0,
      anyUnbound: false,
      placeholder: null,
    });
  }
  const done = new Set<string>();

  // Rule 3 — round one cuts the ids in order into chunks of at most
  // BATCH_READ_MAX, chunk j to node (start + j) mod n.
  let roundChunks: Chunk[] = [];
  for (let j = 0; j < ids.length; j += BATCH_READ_MAX) {
    const chunkIds = ids.slice(j, j + BATCH_READ_MAX);
    roundChunks.push({
      ids: chunkIds,
      nodeIndex: (deps.start + roundChunks.length) % n,
    });
  }
  const roundOneChunkCount = roundChunks.length;

  // The rounds. Each sends its chunks at once and waits for every one, each
  // raced against the deadline. A new round is built from the ids still
  // wanted whose askedCount is below n (rule 6).
  while (roundChunks.length > 0) {
    if (deps.now() >= deadline) break;
    await runRound(roundChunks, deadline, state, done, deps);
    roundChunks = nextRound(ids, state, done, n);
  }

  // Rule 7 — the end.
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
  return { ends, chunks: roundOneChunkCount };
}

/** Send a round's chunks at once; every chunk is raced against the deadline.
 *  Rule 4 and rule 5 apply here. */
async function runRound(
  chunks: readonly Chunk[],
  deadline: number,
  state: Map<string, IdState>,
  done: Set<string>,
  deps: ResolveDeps,
): Promise<void> {
  // The rule *"No request leaves at or after the deadline"*: a chunk the
  // deadline beats before `ask` is called served nothing. A chunk that leaves
  // and is still in flight when the deadline is reached is beaten by `until`.
  // One `until` promise serves the round — a chunk-local race against the
  // same deadline, called once.
  const beat: Promise<unknown> = deps.until(deadline).then(() => BEAT);
  const inFlight: Array<Promise<void>> = [];
  for (const chunk of chunks) {
    if (deps.now() >= deadline) {
      // Served nothing — rule 4. Treated as a failed request for every id in
      // the chunk, so each id's nextNode and askedCount advance (rule 6).
      recordFailedChunk(chunk, state, n(deps));
      continue;
    }
    inFlight.push(dispatchChunk(chunk, beat, state, done, deps));
  }
  await Promise.all(inFlight);
}

/** The number of distinct nodes. */
function n(deps: ResolveDeps): number {
  return deps.nodes.length;
}

/** Advance every still-wanted id in the chunk by one node (rule 6). An id
 *  already removed by a sibling chunk is left alone. */
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
 *  whose `ask` rejects synchronously or returns a bad body serves nothing
 *  (rule 4). */
async function dispatchChunk(
  chunk: Chunk,
  beat: Promise<unknown>,
  state: Map<string, IdState>,
  done: Set<string>,
  deps: ResolveDeps,
): Promise<void> {
  const base = deps.nodes[chunk.nodeIndex]!;
  let askPromise: Promise<unknown>;
  try {
    askPromise = deps.ask(base, chunk.ids);
  } catch {
    recordFailedChunk(chunk, state, n(deps));
    return;
  }
  // Guard against a non-Promise return by wrapping in Promise.resolve.
  const safe = Promise.resolve(askPromise).catch(() => FAILED);
  const outcome = await Promise.race<unknown>([safe, beat]);
  if (outcome === FAILED || outcome === BEAT) {
    recordFailedChunk(chunk, state, n(deps));
    return;
  }
  applyBody(outcome, chunk, state, done, deps);
}

/** Markers for the race. Private symbols so no body could spoof them. */
const FAILED: unique symbol = Symbol('ask failed');
const BEAT: unique symbol = Symbol('deadline beat');

/** Read one chunk's body: pick the first row under each id the chunk asked
 *  and still wants, send them to `check` as one call, and record each id's
 *  outcome. Rule 5. */
function applyBody(
  body: unknown,
  chunk: Chunk,
  state: Map<string, IdState>,
  done: Set<string>,
  deps: ResolveDeps,
): void {
  if (typeof body !== 'object' || body === null) {
    recordFailedChunk(chunk, state, n(deps));
    return;
  }
  const posts = (body as Record<string, unknown>)['posts'];
  if (!Array.isArray(posts)) {
    recordFailedChunk(chunk, state, n(deps));
    return;
  }
  // The ids this chunk asked and still wants, in a set the row-reader
  // consults. A row an earlier row of this body took is not read.
  const wantedByChunk = new Set<string>();
  for (const id of chunk.ids) if (!done.has(id)) wantedByChunk.add(id);

  // Rule 5 — the first row under each id. A row the chunk did not ask, or
  // whose id is not a string, or whose id was already taken, is not read.
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

  // Rule 5 — one `check` call a chunk. A thrown check is read as a request
  // that failed: every id in the chunk advances one node.
  let checks: PostCheck[];
  try {
    checks = deps.check(rowsForCheck);
  } catch {
    recordFailedChunk(chunk, state, n(deps));
    return;
  }

  // Decide each id in the chunk. A row read above answers from `checks`; an
  // id with no row read falls through to the "anything else" arm.
  const boundThisChunk: BoundPost[] = [];
  for (const id of chunk.ids) {
    const s = state.get(id);
    if (s === undefined) continue;
    s.askedCount += 1;
    s.nextNode = (chunk.nodeIndex + 1) % n(deps);
    const rowIndex = idsForRows.indexOf(id);
    if (rowIndex === -1) continue;
    const check = checks[rowIndex];
    if (check === undefined) continue;
    if (check.status === 'bound') {
      const row = rowsForCheck[rowIndex] as PostJson;
      if (typeof row.content === 'string') {
        done.add(id);
        state.delete(id);
        boundThisChunk.push({ row, check });
      } else if (row.content === null) {
        if (s.placeholder === null) s.placeholder = { row, check };
      }
      // A `bound` row whose `content` is neither a string nor `null` falls
      // through — nothing to draw and no placeholder to keep.
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
 *  below `n`, grouped by `nextNode`, in chunks of at most `BATCH_READ_MAX`
 *  (rule 6). The ids are iterated in the original order the caller passed in,
 *  so chunks are stable and tests can refer to them. */
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

/** Call `onBound` and swallow a throw — the ids are already bound, and
 *  rethrowing would make the resolve reject, which the contract forbids
 *  (`"The resolve"`). The caller's bug is theirs to see in its own logs. */
function tryOnBound(deps: ResolveDeps, posts: BoundPost[]): void {
  try {
    deps.onBound(posts);
  } catch {
    // Swallowed by design.
  }
}
