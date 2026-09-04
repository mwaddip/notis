import { readStore, writeStore } from '../prefs';
import { isTombstone } from '../api/dto';
import type { PostResult, KarmaResult } from '../api/dto';
import type { SpendableBox, ChangeRef, PendingEntry, EntryOutcome } from './types';

// The persisted pending ledger and the spendable view over it
// (WEB_INTERFACE → The wallet). A reload that forgot the ledger would re-spend a
// box the node holds pending and receive a 409 for a failure the reader never
// saw, so it is persisted, bigints as decimal strings.
//
// ⛔ Keyed by the identity that owns the entries — `notis.pending.<pubKeyHex>`.
// One browser ledger shared across keys would let a second identity try to spend
// the first's predicted change; a per-identity key keeps them apart.

export const PENDING_KEY_PREFIX = 'notis.pending.';

/** The per-identity storage key, or null with no identity loaded. */
export function pendingKeyFor(pubKeyHex: string | null): string | null {
  return pubKeyHex === null ? null : PENDING_KEY_PREFIX + pubKeyHex;
}

export class PendingLedger {
  private entries = new Map<string, PendingEntry>();
  private readonly storageKey: string | null;

  /** No identity → an empty ledger that persists nothing. */
  constructor(pubKeyHex: string | null) {
    this.storageKey = pendingKeyFor(pubKeyHex);
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
    if (this.storageKey === null) return; // no identity → persists nothing
    writeStore(this.storageKey, JSON.stringify(this.all().map(toStored)));
  }

  /** localStorage is untrusted input, validated rather than trusted the way the
   *  identity module refuses a malformed file: every entry's shape is checked and
   *  any malformed one starts the ledger empty — all or nothing, so a single bad
   *  row cannot let a partial ledger re-spend a box the node holds pending. */
  private restore(): void {
    if (this.storageKey === null) return;
    const raw = readStore(this.storageKey);
    if (raw === null) return;
    let entries: PendingEntry[];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('pending ledger is not an array');
      entries = parsed.map((v) => parseStoredEntry(v)); // throws before any insert on a bad entry
    } catch {
      this.entries.clear();
      return;
    }
    for (const e of entries) this.entries.set(e.txId, e);
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

/** A faucet grant is landed once `/karma` shows any box — the key held none when
 *  the grant was asked, so a risen boxCount is the grant — expired past its height
 *  while still zero, else pending (WEB_INTERFACE → The faucet step). */
export function reconcileGrant(entry: PendingEntry, karma: KarmaResult, tip: number): EntryOutcome {
  if (karma.boxCount > 0) return 'landed';
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

/** The targets the client has a pending vouch for — overlaid onto the vouch set
 *  so the mark reads `✓` (muted) the moment the vouch is submitted, before it
 *  lands (WEB_INTERFACE → The identity display). */
export function pendingVouchTargets(entries: PendingEntry[]): Set<string> {
  return new Set(entries.filter((e) => e.kind === 'vouch').map((e) => e.postId));
}

/** A pending vouch is landed when `GET /vouches?voucher=<me>` lists the pair —
 *  the target names the reader's `vouch` box (WEB_INTERFACE → The wallet). */
export function reconcileVouch(
  entry: PendingEntry,
  vouches: ReadonlyArray<{ targetId: string }>,
  tip: number,
): EntryOutcome {
  if (vouches.some((v) => v.targetId === entry.postId)) return 'landed';
  return tip > entry.expiresAtHeight ? 'expired' : 'pending';
}

/** A pending unvouch is landed when the pair is absent from
 *  `GET /vouches?voucher=<me>` — the `vouch` box is spent — and a cooldown row
 *  stands for the escrow it created (WEB_INTERFACE → The wallet). Every vouch
 *  holds VOUCH_KARMA_AMOUNT, so the escrow's value is that same amount and the
 *  discriminator is the pair's absence, keyed on the target. */
export function reconcileUnvouch(
  entry: PendingEntry,
  vouches: ReadonlyArray<{ targetId: string }>,
  cooldowns: ReadonlyArray<{ releaseAtBlock: number }>,
  tip: number,
): EntryOutcome {
  const gone = !vouches.some((v) => v.targetId === entry.postId);
  if (gone && cooldowns.length > 0) return 'landed';
  return tip > entry.expiresAtHeight ? 'expired' : 'pending';
}

/** A pending invite is landed when `GET /invites/<me>` lists a bond naming the
 *  invitee (WEB_INTERFACE → The wallet). */
export function reconcileInvite(
  entry: PendingEntry,
  bonds: ReadonlyArray<{ inviteePublicKey: string }>,
  tip: number,
): EntryOutcome {
  if (bonds.some((b) => b.inviteePublicKey === entry.postId)) return 'landed';
  return tip > entry.expiresAtHeight ? 'expired' : 'pending';
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

/** Validate and convert one stored entry, throwing on any malformed field so
 *  restore() can drop the whole ledger rather than load a partial one. */
function parseStoredEntry(v: unknown): PendingEntry {
  if (typeof v !== 'object' || v === null) throw new Error('entry is not an object');
  const o = v as Record<string, unknown>;
  if (typeof o.txId !== 'string' || typeof o.postId !== 'string') throw new Error('entry has non-string ids');
  if (o.kind !== 'post' && o.kind !== 'like' && o.kind !== 'grant' && o.kind !== 'vouch' && o.kind !== 'unvouch' && o.kind !== 'invite') {
    throw new Error('entry has an unknown kind');
  }
  if (!Array.isArray(o.inputs) || !o.inputs.every((x) => typeof x === 'string')) throw new Error('entry inputs are not strings');
  if (typeof o.expiresAtHeight !== 'number' || typeof o.submittedAtHeight !== 'number') throw new Error('entry heights are not numbers');
  let change: ChangeRef | undefined;
  if (o.change !== undefined) {
    const c = o.change;
    if (typeof c !== 'object' || c === null) throw new Error('entry change is not an object');
    const co = c as Record<string, unknown>;
    if (typeof co.boxId !== 'string' || typeof co.value !== 'string' || typeof co.createdAtBlock !== 'number') {
      throw new Error('entry change has a malformed field');
    }
    change = { boxId: co.boxId, value: BigInt(co.value), createdAtBlock: co.createdAtBlock };
  }
  return {
    txId: o.txId,
    kind: o.kind,
    postId: o.postId,
    inputs: o.inputs as string[],
    ...(change ? { change } : {}),
    expiresAtHeight: o.expiresAtHeight,
    submittedAtHeight: o.submittedAtHeight,
  };
}
