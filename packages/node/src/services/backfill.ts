import { setPostBody } from '../store/posts.js';
import { emitPostReceived } from '../journal.js';

// ---------------------------------------------------------------------------
// Backfill driver — NODE_INTERFACE → Store Interface → Posts DAG, "Backfill
// after sync". Runs from the block-applied hook, never a timer. Requests
// bodies on a per-id schedule in block height: at creation, then after 1, 2,
// 4, … blocks, capped at 256 — so an unserved body costs a bounded trickle.
// ---------------------------------------------------------------------------

interface BackfillEntry {
  id: string;
  contentHash: string;
  createdAtHeight: number;
  nextRetryHeight: number;
  retryInterval: number;
  fromPeerId: string;
}

const MAX_RETRY_INTERVAL = 256;

const pending = new Map<string, BackfillEntry>();

export interface BackfillDeps {
  requestPostBodies: (wanted: Array<{ id: string; contentHash: string }>, peerId: string) => Promise<Array<{ id: string; content: string }>>;
  getConnectedPeers: () => string[];
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
  });
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

  const byPeer = new Map<string, BackfillEntry[]>();
  for (const entry of due) {
    const peerId = entry.fromPeerId || deps.getConnectedPeers()[0] || '';
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
        const stored = setPostBody(id, content);
        if (stored) {
          pending.delete(id);
          emitPostReceived(id, peerId, 'pull');
        }
      }
    } catch {
      // peer unavailable — entries stay pending for next height
    }

    for (const entry of entries) {
      if (pending.has(entry.id)) {
        entry.nextRetryHeight = height + entry.retryInterval;
        entry.retryInterval = Math.min(entry.retryInterval * 2, MAX_RETRY_INTERVAL);
      }
    }
  }
}

export function clearPending(): void {
  pending.clear();
}
