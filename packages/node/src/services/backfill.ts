import { emitPostReceived } from '../journal.js';

// ---------------------------------------------------------------------------
// Backfill driver — NODE_INTERFACE → "Backfill after sync" and
// NODE_INTERFACE → "A serving reader is asked for what has been due". The
// node's one body puller: requests bodies on a per-id schedule in block
// height, from the block-applied hook, one pass at a time; each pass, after
// its node-peer asks, asks every serving reader once for the entries whose
// schedule the puller has advanced before; and a serving reader's arrival
// asks it once for every such entry, on a trigger of its own that runs in
// the puller's one-at-a-time order and writes no entry's schedule.
// ---------------------------------------------------------------------------

interface BackfillEntry {
  id: string;
  contentHash: string;
  nextRetryHeight: number;
  retryInterval: number;
  fromPeerId: string;
  attemptCount: number;
  // Set true by the pass that advances the entry's schedule from its joining
  // height; a pass with no node peer still sets it, since the advance runs
  // before `pickPeer` (NODE_INTERFACE → "A serving reader is asked for what
  // has been due").
  dueOnce: boolean;
}

const MAX_RETRY_INTERVAL = 256;

const pending = new Map<string, BackfillEntry>();

export interface BackfillDeps {
  requestPostBodies: (
    wanted: Array<{ id: string; contentHash: string }>,
    peerId: string,
  ) => Promise<Array<{ id: string; content: string }>>;
  getConnectedPeers: () => string[];
  // NET_INTERFACE → "A reader is never asked for chain data" — the Active
  // readers whose handshake declared `ModifierRequest`; the puller asks them
  // for the entries a pass has made due before
  // (NODE_INTERFACE → "A serving reader is asked for what has been due").
  getServingReaders: () => string[];
  setPostBody: (postId: string, content: string) => boolean;
  // NODE_INTERFACE → Store Interface → Posts DAG: at init, every row this
  // answers joins the schedule, due at the next applied block.
  getMissingBodies: () => Array<{ id: string; contentHash: string }>;
  // NODE_INTERFACE → Store Interface → Posts DAG: a read answering which of a
  // set of ids are still placeholders. One query over the ids per pass.
  getStillPlaceholderIds: (ids: readonly string[]) => string[];
}

let deps: BackfillDeps | null = null;

// NODE_INTERFACE → "Backfill after sync" and "A serving reader is asked for
// what has been due" — one piece of work at a time. `running` names any task
// in flight: a pass over an applied block, or a reader's arrival ask.
// `latestScheduled` carries the newest block height arrived while a task was
// running — multiple applied blocks coalesce into one pass at the tip.
// `readerQueue` carries each arrival ask by itself: each one's promise
// resolves after its own call has run.
interface ReaderTask {
  peerId: string;
  resolve: () => void;
}
let running = false;
let latestScheduled: number | null = null;
const readerQueue: ReaderTask[] = [];

export function initBackfill(d: BackfillDeps): void {
  deps = d;
  for (const row of d.getMissingBodies()) {
    if (pending.has(row.id)) continue;
    pending.set(row.id, {
      id: row.id,
      contentHash: row.contentHash,
      nextRetryHeight: 0,
      retryInterval: 1,
      fromPeerId: '',
      attemptCount: 0,
      dueOnce: false,
    });
  }
}

export function registerPlaceholder(id: string, contentHash: string, height: number, fromPeerId: string): void {
  if (pending.has(id)) return;
  pending.set(id, {
    id,
    contentHash,
    nextRetryHeight: height,
    retryInterval: 1,
    fromPeerId,
    attemptCount: 0,
    dueOnce: false,
  });
}

function pickPeer(entry: BackfillEntry, connectedPeers: string[]): string | null {
  if (entry.attemptCount === 0 && entry.fromPeerId && connectedPeers.includes(entry.fromPeerId)) {
    return entry.fromPeerId;
  }
  if (connectedPeers.length === 0) return null;
  return connectedPeers[entry.attemptCount % connectedPeers.length] ?? null;
}

// NODE_INTERFACE → "Backfill after sync" and "A serving reader is asked
// for what has been due": one ask to `peerId` for `wanted`, each stored
// body leaving pending and emitting `post_received` with `via: 'pull'`.
// A throw from `requestPostBodies` leaves the helper — callers hold the
// catch and log line that keeps a failing peer from killing the pass.
async function requestAndStore(
  peerId: string,
  wanted: Array<{ id: string; contentHash: string }>,
): Promise<void> {
  const bodies = await deps!.requestPostBodies(wanted, peerId);
  for (const { id, content } of bodies) {
    const stored = deps!.setPostBody(id, content);
    if (stored) {
      pending.delete(id);
      emitPostReceived(id, peerId, 'pull');
    }
  }
}

async function runPass(height: number): Promise<void> {
  if (!deps) return;

  const dueIds: string[] = [];
  for (const [, entry] of pending) {
    if (height >= entry.nextRetryHeight) dueIds.push(entry.id);
  }
  if (dueIds.length === 0) return;

  // Drop retired placeholders unasked (NODE_INTERFACE → "An entry whose row is
  // no longer a placeholder leaves at its turn, unasked").
  const stillSet = new Set(deps.getStillPlaceholderIds(dueIds));
  for (const id of dueIds) {
    if (!stillSet.has(id)) pending.delete(id);
  }

  const dueEntries: BackfillEntry[] = [];
  for (const id of dueIds) {
    const entry = pending.get(id);
    if (entry) dueEntries.push(entry);
  }
  if (dueEntries.length === 0) return;

  // NODE_INTERFACE → "A serving reader is asked for what has been due": the
  // reader-eligible set is the due entries whose schedule a pass has
  // advanced before — captured before this pass advances the schedule.
  const readerEligible = dueEntries.filter((e) => e.dueOnce);

  // Mark each remaining entry asked — the next due height and the interval
  // advanced, and `dueOnce` set — before any request goes out.
  for (const entry of dueEntries) {
    entry.nextRetryHeight = height + entry.retryInterval;
    entry.retryInterval = Math.min(entry.retryInterval * 2, MAX_RETRY_INTERVAL);
    entry.dueOnce = true;
  }

  // Group by peer: the relaying peer on the first ask, then the connected
  // peers in turn.
  const connectedPeers = deps.getConnectedPeers();
  const byPeer = new Map<string, BackfillEntry[]>();
  for (const entry of dueEntries) {
    const peerId = pickPeer(entry, connectedPeers);
    if (!peerId) continue;
    let list = byPeer.get(peerId);
    if (!list) {
      list = [];
      byPeer.set(peerId, list);
    }
    list.push(entry);
  }

  // One call per peer, one after another. Net splits a call into requests of
  // at most `MAX_INV_IDS`; the driver does not (NET_INTERFACE → Pull Requests).
  for (const [peerId, entries] of byPeer) {
    const wanted = entries.map((e) => ({ id: e.id, contentHash: e.contentHash }));
    try {
      await requestAndStore(peerId, wanted);
    } catch (err) {
      console.warn(`Backfill request to ${peerId} failed: ${String(err)}`);
    }
    for (const entry of entries) entry.attemptCount++;
  }

  // NODE_INTERFACE → "A serving reader is asked for what has been due": each
  // pass, after the node-peer asks, sends the reader-eligible set to every
  // serving reader, one call each, in the order `getServingReaders()`
  // answers; an entry a node peer stored in the same pass has left
  // `pending`, so the reader arm asks only for what remains, and sends
  // nothing when nothing does. A call that rejects leaves the pass asking
  // the next reader.
  const stillEligible = readerEligible.filter((e) => pending.has(e.id));
  if (stillEligible.length > 0) {
    const wanted = stillEligible.map((e) => ({ id: e.id, contentHash: e.contentHash }));
    for (const readerId of deps.getServingReaders()) {
      try {
        await requestAndStore(readerId, wanted);
      } catch (err) {
        console.warn(`Backfill request to ${readerId} failed: ${String(err)}`);
      }
    }
  }
}

// NODE_INTERFACE → "A serving reader is asked for what has been due":
// an arrival asks a reader once for every pending entry whose schedule a
// pass has advanced, after the entries no longer placeholders leave
// unasked. The schedule is left alone.
async function askArrivedReader(peerId: string): Promise<void> {
  if (!deps) return;
  const eligibleIds: string[] = [];
  for (const [, entry] of pending) {
    if (entry.dueOnce) eligibleIds.push(entry.id);
  }
  if (eligibleIds.length === 0) return;
  const stillSet = new Set(deps.getStillPlaceholderIds(eligibleIds));
  for (const id of eligibleIds) {
    if (!stillSet.has(id)) pending.delete(id);
  }
  const entries: BackfillEntry[] = [];
  for (const id of eligibleIds) {
    if (!stillSet.has(id)) continue;
    const entry = pending.get(id);
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) return;

  const wanted = entries.map((e) => ({ id: e.id, contentHash: e.contentHash }));
  try {
    await requestAndStore(peerId, wanted);
  } catch (err) {
    console.warn(`Backfill request to ${peerId} failed: ${String(err)}`);
  }
}

// The puller's one-at-a-time serializer: at most one pass or arrival ask
// runs at a time (NODE_INTERFACE → "A serving reader is asked for what has
// been due"). Passes drain first so an arrival registered during a pass
// waits for it.
async function runLoop(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (latestScheduled !== null || readerQueue.length > 0) {
      if (latestScheduled !== null) {
        const h = latestScheduled;
        latestScheduled = null;
        await runPass(h);
      } else {
        const task = readerQueue.shift()!;
        try {
          await askArrivedReader(task.peerId);
        } finally {
          task.resolve();
        }
      }
    }
  } finally {
    running = false;
  }
}

export async function onBlockApplied(height: number): Promise<void> {
  if (!deps) return;
  latestScheduled = latestScheduled === null ? height : Math.max(latestScheduled, height);
  await runLoop();
}

export function getPendingCount(): number {
  return pending.size;
}

export function clearPending(): void {
  pending.clear();
}

// NODE_INTERFACE → "A serving reader is asked for what has been due": a
// peer id `getServingReaders()` does not name is asked nothing; otherwise
// the arrival joins the puller's queue and the promise resolves after its
// own ask has run.
export async function readerArrived(peerId: string): Promise<void> {
  if (!deps) return;
  if (!deps.getServingReaders().includes(peerId)) return;
  let resolve!: () => void;
  const done = new Promise<void>((res) => { resolve = res; });
  readerQueue.push({ peerId, resolve });
  void runLoop();
  await done;
}
