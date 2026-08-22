import { emitPostReceived } from '../journal.js';

// ---------------------------------------------------------------------------
// Backfill driver — NODE_INTERFACE → Store Interface → Posts DAG, "Backfill
// after sync". Runs from the block-applied hook, never a timer. Requests
// bodies on a per-id schedule in block height: at creation, then after 1, 2,
// 4, … blocks, capped at 256 — so an unserved body costs a bounded trickle.
//
// `pending` is in-memory; after a restart it is empty and the sync machine's
// `backfill` phase covers the rows (`getMissingBodies`).
// ---------------------------------------------------------------------------

interface BackfillEntry {
  id: string;
  contentHash: string;
  createdAtHeight: number;
  nextRetryHeight: number;
  retryInterval: number;
  fromPeerId: string;
  attemptCount: number;
}

const MAX_RETRY_INTERVAL = 256;

const pending = new Map<string, BackfillEntry>();

export interface BackfillDeps {
  requestPostBodies: (wanted: Array<{ id: string; contentHash: string }>, peerId: string) => Promise<Array<{ id: string; content: string }>>;
  getConnectedPeers: () => string[];
  setPostBody: (postId: string, content: string) => boolean;
}

let deps: BackfillDeps | null = null;

export function initBackfill(d: BackfillDeps): void {
  deps = d;
}

export function registerPlaceholder(id: string, contentHash: string, height: number, fromPeerId: string): void {
  if (pending.has(id)) return;
  pending.set(id, {
    id,
    contentHash,
    createdAtHeight: height,
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

export async function onBlockApplied(height: number): Promise<void> {
  if (!deps) return;
  const due: BackfillEntry[] = [];
  for (const entry of pending.values()) {
    if (height >= entry.nextRetryHeight) {
      due.push(entry);
    }
  }
  if (due.length === 0) return;

  const connectedPeers = deps.getConnectedPeers();

  const byPeer = new Map<string, BackfillEntry[]>();
  for (const entry of due) {
    const peerId = pickPeer(entry, connectedPeers);
    if (!peerId) continue;
    let list = byPeer.get(peerId);
    if (!list) {
      list = [];
      byPeer.set(peerId, list);
    }
    list.push(entry);
  }

  for (const [peerId, entries] of byPeer) {
    const wanted = entries.map(e => ({ id: e.id, contentHash: e.contentHash }));
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

    for (const entry of entries) {
      if (pending.has(entry.id)) {
        entry.attemptCount++;
        entry.nextRetryHeight = height + entry.retryInterval;
        entry.retryInterval = Math.min(entry.retryInterval * 2, MAX_RETRY_INTERVAL);
      }
    }
  }
}

export function getPendingCount(): number {
  return pending.size;
}

export function clearPending(): void {
  pending.clear();
}
