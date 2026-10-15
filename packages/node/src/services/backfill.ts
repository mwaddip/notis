import { emitPostReceived } from '../journal.js';

// ---------------------------------------------------------------------------
// Backfill driver — NODE_INTERFACE → Store Interface → Posts DAG, "Backfill
// after sync". The node's one body puller: requests bodies on a per-id
// schedule in block height, from the block-applied hook, one pass at a time.
// ---------------------------------------------------------------------------

interface BackfillEntry {
  id: string;
  contentHash: string;
  nextRetryHeight: number;
  retryInterval: number;
  fromPeerId: string;
  attemptCount: number;
}

const MAX_RETRY_INTERVAL = 256;

const pending = new Map<string, BackfillEntry>();

export interface BackfillDeps {
  requestPostBodies: (
    wanted: Array<{ id: string; contentHash: string }>,
    peerId: string,
  ) => Promise<Array<{ id: string; content: string }>>;
  getConnectedPeers: () => string[];
  setPostBody: (postId: string, content: string) => boolean;
  // NODE_INTERFACE → Store Interface → Posts DAG: at init, every row this
  // answers joins the schedule, due at the next applied block.
  getMissingBodies: () => Array<{ id: string; contentHash: string }>;
  // NODE_INTERFACE → Store Interface → Posts DAG: a read answering which of a
  // set of ids are still placeholders. One query over the ids per pass.
  getStillPlaceholderIds: (ids: readonly string[]) => string[];
}

let deps: BackfillDeps | null = null;

// NODE_INTERFACE → "Backfill after sync" — one pass at a time, from the
// block-applied hook. `passRunning` names a pass in flight; `latestScheduled`
// carries the newest height arrived while one was running.
let passRunning = false;
let latestScheduled: number | null = null;

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
  });
}

function pickPeer(entry: BackfillEntry, connectedPeers: string[]): string | null {
  if (entry.attemptCount === 0 && entry.fromPeerId && connectedPeers.includes(entry.fromPeerId)) {
    return entry.fromPeerId;
  }
  if (connectedPeers.length === 0) return null;
  return connectedPeers[entry.attemptCount % connectedPeers.length] ?? null;
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

  // Mark each remaining entry asked — the next due height and the interval
  // advanced — before any request goes out.
  for (const entry of dueEntries) {
    entry.nextRetryHeight = height + entry.retryInterval;
    entry.retryInterval = Math.min(entry.retryInterval * 2, MAX_RETRY_INTERVAL);
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
      const bodies = await deps.requestPostBodies(wanted, peerId);
      for (const { id, content } of bodies) {
        const stored = deps.setPostBody(id, content);
        if (stored) {
          pending.delete(id);
          emitPostReceived(id, peerId, 'pull');
        }
      }
    } catch (err) {
      console.warn(`Backfill request to ${peerId} failed: ${String(err)}`);
    }
    for (const entry of entries) entry.attemptCount++;
  }
}

export async function onBlockApplied(height: number): Promise<void> {
  if (!deps) return;
  latestScheduled = latestScheduled === null ? height : Math.max(latestScheduled, height);
  if (passRunning) return;
  passRunning = true;
  try {
    while (latestScheduled !== null) {
      const h = latestScheduled;
      latestScheduled = null;
      await runPass(h);
    }
  } finally {
    passRunning = false;
  }
}

export function getPendingCount(): number {
  return pending.size;
}

export function clearPending(): void {
  pending.clear();
}
