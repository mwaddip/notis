import { readStore, writeStore } from '../prefs';
import { isTombstone } from '../api/dto';
import type { PostResult } from '../api/dto';
import type { SpendableBox, PendingEntry, EntryOutcome } from './types';

// The persisted pending ledger and the spendable view over it
// (WEB_INTERFACE → The wallet). A reload that forgot the ledger would re-spend a
// box the node holds pending and receive a 409 for a failure the reader never
// saw, so it is persisted under `notis.pending`, bigints as decimal strings.

export const PENDING_KEY = 'notis.pending';

export class PendingLedger {
  private entries = new Map<string, PendingEntry>();

  constructor() {
    this.restore();
  }

  all(): PendingEntry[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }

  add(entry: PendingEntry): void {
    this.entries.set(entry.txId, entry);
    this.persist();
  }

  /** Drop an entry — a landed or expired one, or a 409 whose transaction the
   *  node's mempool never accepted (WEB_INTERFACE → "Nothing retries"). */
  remove(txId: string): void {
    if (this.entries.delete(txId)) this.persist();
  }

  /**
   * The spendable view: confirmed boxes, minus the inputs of the client's own
   * pending transactions, plus their predicted change — a box (confirmed or a
   * predicted change) is spendable exactly when no pending transaction names it
   * as an input, so a change already chained into a later pending transaction
   * drops out too.
   */
  spendable(confirmed: SpendableBox[]): SpendableBox[] {
    const spent = new Set<string>();
    const changes: SpendableBox[] = [];
    for (const e of this.entries.values()) {
      for (const id of e.inputs) spent.add(id);
      if (e.change) changes.push({ boxId: e.change.boxId, value: e.change.value });
    }
    return [...confirmed, ...changes].filter((b) => !spent.has(b.boxId));
  }

  private persist(): void {
    writeStore(PENDING_KEY, JSON.stringify(this.all().map(toStored)));
  }

  /** localStorage is untrusted input, guarded like prefs.ts: a value that no
   *  longer parses starts the ledger empty rather than throwing. */
  private restore(): void {
    const raw = readStore(PENDING_KEY);
    if (raw === null) return;
    try {
      const parsed = JSON.parse(raw) as StoredEntry[];
      for (const s of parsed) {
        const e = fromStored(s);
        this.entries.set(e.txId, e);
      }
    } catch {
      this.entries.clear();
    }
  }
}

// ---------------------------------------------------------------------------
// Reconcile — WEB_INTERFACE → The wallet: a pending post is landed when
// GET /posts/:postId answers confirmed, expired on a 404 or once the tip passes
// expiresAtHeight; a pending like is landed when likedByViewer turns true.
// ---------------------------------------------------------------------------

export function reconcilePost(entry: PendingEntry, fetched: PostResult | null, tip: number): EntryOutcome {
  if (fetched === null) return 'expired'; // 404 — the mempool purged it, or it was never admitted
  if (isTombstone(fetched)) return 'landed'; // on-chain, then withdrawn or pruned
  if (fetched.status === 'confirmed') return 'landed';
  return tip > entry.expiresAtHeight ? 'expired' : 'pending';
}

export function reconcileLike(entry: PendingEntry, fetched: PostResult | null, tip: number): EntryOutcome {
  if (fetched !== null && !isTombstone(fetched) && fetched.likedByViewer === true) return 'landed';
  return tip > entry.expiresAtHeight ? 'expired' : 'pending';
}

/** Drop the node's pending rows the ledger already holds, so the client's own
 *  submission never renders twice (WEB_INTERFACE → "The feed carries four things"). */
export function dedupePending<T extends { id: string }>(nodePending: T[], entries: PendingEntry[]): T[] {
  const own = new Set(entries.filter((e) => e.kind === 'post').map((e) => e.postId));
  return nodePending.filter((row) => !own.has(row.id));
}

/** The targets the client has a pending like for — overlaid onto `likedByViewer`
 *  until they land or expire, because the node's field reflects store records
 *  only (WEB_INTERFACE → The wallet). */
export function pendingLikeTargets(entries: PendingEntry[]): Set<string> {
  return new Set(entries.filter((e) => e.kind === 'like').map((e) => e.postId));
}

// ---------------------------------------------------------------------------
// Persisted shape — bigints as decimal strings.
// ---------------------------------------------------------------------------

interface StoredChange {
  boxId: string;
  value: string;
  createdAtBlock: number;
}
interface StoredEntry {
  txId: string;
  kind: PendingEntry['kind'];
  postId: string;
  inputs: string[];
  change?: StoredChange;
  expiresAtHeight: number;
  submittedAtHeight: number;
}

function toStored(e: PendingEntry): StoredEntry {
  return {
    txId: e.txId,
    kind: e.kind,
    postId: e.postId,
    inputs: e.inputs,
    ...(e.change ? { change: { boxId: e.change.boxId, value: e.change.value.toString(), createdAtBlock: e.change.createdAtBlock } } : {}),
    expiresAtHeight: e.expiresAtHeight,
    submittedAtHeight: e.submittedAtHeight,
  };
}

function fromStored(s: StoredEntry): PendingEntry {
  return {
    txId: s.txId,
    kind: s.kind,
    postId: s.postId,
    inputs: s.inputs,
    ...(s.change ? { change: { boxId: s.change.boxId, value: BigInt(s.change.value), createdAtBlock: s.change.createdAtBlock } } : {}),
    expiresAtHeight: s.expiresAtHeight,
    submittedAtHeight: s.submittedAtHeight,
  };
}
