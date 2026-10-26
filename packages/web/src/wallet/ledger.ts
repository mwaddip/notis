import { readStore, writeStore } from '../prefs';
import { isWithdrawn } from '../api/dto';
import { heldEntry } from './expiry';
import type { PostJson, WithdrawnJson, KarmaResult, UsernameResult, CreditsResult } from '../api/dto';
import type { PendingEntry, EntryOutcome, SendRef, UnboundedEntry } from './types';

// The persisted pending ledger holds the reader's own submissions, for what
// they draw (WEB_INTERFACE → The wallet → "The pending ledger holds the
// reader's own submissions, for what they draw"); it chooses no input and
// gates no spend, which the node's pending views do. A reload that forgot the
// ledger would lose the pending cards, the like overlay, each flight's stage
// line and the bounded poll, so it is persisted, bigints as decimal strings.
//
// ⛔ Keyed by the identity that owns the entries — `notis.pending.<pubKeyHex>`.
// A per-identity key keeps one key's entries from another.

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

  /** Hold an entry and answer it as held, its expiry the ledger's whatever the
   *  answer carried (heldEntry). Every writer adds through here, and restore
   *  holds a stored entry the same way, so no entry in the ledger outlives its
   *  bound (WEB_INTERFACE → The wallet → "A pending entry's expiry is the
   *  client's, and a node's answer can only bring it sooner"). */
  add(entry: UnboundedEntry): PendingEntry {
    const held = heldEntry(entry);
    this.entries.set(held.txId, held);
    this.persist();
    return held;
  }

  /** Drop an entry — a landed or expired one, or a 409 whose transaction the
   *  node's mempool never accepted (WEB_INTERFACE → "Nothing retries"). */
  remove(txId: string): void {
    if (this.entries.delete(txId)) this.persist();
  }

  private persist(): void {
    if (this.storageKey === null) return; // no identity → persists nothing
    writeStore(this.storageKey, JSON.stringify(this.all().map(toStored)));
  }

  /** localStorage is untrusted input, validated rather than trusted the way the
   *  identity module refuses a malformed file: every entry's shape is checked and
   *  any malformed one starts the ledger empty — all or nothing, so a single bad
   *  row cannot let a partial ledger re-spend a box the node holds pending. The
   *  stored `expiresAtHeight` is held as an added one is, so an entry carrying a
   *  later height, or none, is bounded here. */
  private restore(): void {
    if (this.storageKey === null) return;
    const raw = readStore(this.storageKey);
    if (raw === null) return;
    let entries: PendingEntry[];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('pending ledger is not an array');
      entries = parsed.map((v) => heldEntry(parseStoredEntry(v))); // throws before any insert on a bad entry
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
// expiresAtHeight; a pending like is landed when likedByViewer turns true. A
// withheld answer — the extension's post check reads the row `unbound` or
// `unserved` (WEB_INTERFACE → The extension → "The post check") — decides
// nothing: the entry stays pending until the tip passes `expiresAtHeight`,
// never expired as on the node's 404.
// ---------------------------------------------------------------------------

export function reconcilePost(entry: PendingEntry, fetched: PostJson | WithdrawnJson | null, tip: number, withheld = false): EntryOutcome {
  if (withheld) return tip > entry.expiresAtHeight ? 'expired' : 'pending';
  if (fetched === null) return 'expired'; // 404 — the mempool purged it, or it was never admitted
  if (isWithdrawn(fetched)) return 'landed'; // on-chain, then withdrawn
  if (fetched.status === 'confirmed') return 'landed';
  return tip > entry.expiresAtHeight ? 'expired' : 'pending';
}

export function reconcileLike(entry: PendingEntry, fetched: PostJson | WithdrawnJson | null, tip: number, withheld = false): EntryOutcome {
  if (withheld) return tip > entry.expiresAtHeight ? 'expired' : 'pending';
  if (fetched !== null && !isWithdrawn(fetched) && fetched.likedByViewer === true) return 'landed';
  return tip > entry.expiresAtHeight ? 'expired' : 'pending';
}

/** A faucet grant is landed once `/karma` shows any box — the key held none when
 *  the grant was asked, so a risen boxCount is the grant — expired past its height
 *  while still zero, else pending (WEB_INTERFACE → The faucet step). */
export function reconcileGrant(entry: PendingEntry, karma: KarmaResult, tip: number): EntryOutcome {
  if (karma.boxCount > 0) return 'landed';
  return tip > entry.expiresAtHeight ? 'expired' : 'pending';
}

/** A pending send is landed when the recipient's `/credits` lists the payment
 *  box the client predicted (`send.boxId`), expired past `expiresAtHeight`, else
 *  pending (WEB_INTERFACE → The wallet, → The wallet window → "The `send` row").
 *  The list is one page the caller has already followed to the end, so the
 *  presence check is O(n). */
export function reconcileSend(
  entry: PendingEntry,
  recipientBoxes: ReadonlyArray<{ boxId: string }>,
  tip: number,
): EntryOutcome {
  const boxId = entry.send?.boxId;
  if (boxId === undefined) return 'expired'; // a send entry missing its payload cannot land
  if (recipientBoxes.some((b) => b.boxId === boxId)) return 'landed';
  return tip > entry.expiresAtHeight ? 'expired' : 'pending';
}

/** A pending credits grant is landed when the reader's own `/credits` lists the
 *  box the faucet named — `entry.postId` is that box id (WEB_INTERFACE → The
 *  faucet step). Expired past its height while absent, else pending. */
export function reconcileCreditGrant(entry: PendingEntry, credits: CreditsResult, tip: number): EntryOutcome {
  if (credits.boxes.some((b) => b.boxId === entry.postId)) return 'landed';
  return tip > entry.expiresAtHeight ? 'expired' : 'pending';
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
 *  `GET /vouches?voucher=<me>` — the `vouch` box is spent (WEB_INTERFACE → The
 *  wallet). The escrow it creates is not the signal: a vouch held past one
 *  cooldown yields an escrow born already releasable, which the next block's
 *  settlement returns (NODE_INTERFACE → Vouch transition rules), so the cooldown
 *  row can stand for a single block the poll never catches. The one absence the
 *  target does not distinguish — the lapse leg spending the box first — leaves the
 *  reader the same state. */
export function reconcileUnvouch(
  entry: PendingEntry,
  vouches: ReadonlyArray<{ targetId: string }>,
  tip: number,
): EntryOutcome {
  const gone = !vouches.some((v) => v.targetId === entry.postId);
  if (gone) return 'landed';
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

/** A pending withdrawal is landed when `GET /posts/:id` answers the withdrawn
 *  marker (NODE_INTERFACE → The withdrawal phase): the post is gone, and the
 *  entry is done. A 404 is expired — the post is unknown to this node, so
 *  nothing can land — as is the tip passing `expiresAtHeight`. A live post is
 *  still pending, unlike a post entry: a confirmed live post is not a landing
 *  for a withdrawal (WEB_INTERFACE → The withdraw control). */
export function reconcileWithdraw(entry: PendingEntry, fetched: PostJson | WithdrawnJson | null, tip: number, withheld = false): EntryOutcome {
  if (withheld) return tip > entry.expiresAtHeight ? 'expired' : 'pending';
  if (fetched === null) return 'expired';
  if (isWithdrawn(fetched)) return 'landed';
  return tip > entry.expiresAtHeight ? 'expired' : 'pending';
}

/** A pending claim is landed when `GET /usernames?owner=<key>` answers the name;
 *  expired once the tip passes `expiresAtHeight`; else pending
 *  (WEB_INTERFACE → The wallet). */
export function reconcileClaim(entry: PendingEntry, held: UsernameResult | null, tip: number): EntryOutcome {
  if (held !== null && held.name === entry.postId) return 'landed';
  return tip > entry.expiresAtHeight ? 'expired' : 'pending';
}

/** A pending burn is landed when the owner holds no name (or a different one);
 *  expired past the height; else pending (WEB_INTERFACE → The wallet). */
export function reconcileBurn(entry: PendingEntry, held: UsernameResult | null, tip: number): EntryOutcome {
  if (held === null || held.name !== entry.postId) return 'landed';
  return tip > entry.expiresAtHeight ? 'expired' : 'pending';
}

/** At most one pending claim or burn — the node refuses a second claim while one
 *  is pending, and a burn's box does not exist until the claim lands
 *  (WEB_INTERFACE → The username row). */
export function pendingUsernameEntry(entries: PendingEntry[]): { kind: 'claim' | 'burn'; name: string } | null {
  for (const e of entries) {
    if (e.kind === 'claim' || e.kind === 'burn') return { kind: e.kind, name: e.postId };
  }
  return null;
}

/** The posts the client has a pending withdrawal for — the flight renders
 *  `submitted` from the ledger after a reload, the way a pending like overlays
 *  `likedByViewer` (WEB_INTERFACE → The withdraw control). */
export function pendingWithdrawTargets(entries: PendingEntry[]): Set<string> {
  return new Set(entries.filter((e) => e.kind === 'withdraw').map((e) => e.postId));
}

/** The client's pending sends, each with its resolved recipient, handle (when
 *  the reader typed one) and amount — the flight slot reads *<amount> $NOTIS to
 *  @bob · submitted* from the ledger, so a reload keeps it (WEB_INTERFACE → The
 *  profile window). */
export function pendingSendEntries(entries: PendingEntry[]): Array<{ toHex: string; toName: string | null; amount: bigint }> {
  const out: Array<{ toHex: string; toName: string | null; amount: bigint }> = [];
  for (const e of entries) {
    if (e.kind !== 'send' || !e.send) continue;
    out.push({ toHex: e.send.toHex, toName: e.send.toName, amount: e.send.amount });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Persisted shape — bigints as decimal strings.
// ---------------------------------------------------------------------------

interface StoredSend {
  toHex: string;
  toName: string | null;
  amount: string; // decimal — parsed back to bigint
  boxId: string;
}
interface StoredEntry {
  txId: string;
  kind: PendingEntry['kind'];
  postId: string;
  send?: StoredSend;
  expiresAtHeight: number;
  submittedAtHeight: number;
}

function toStored(e: PendingEntry): StoredEntry {
  return {
    txId: e.txId,
    kind: e.kind,
    postId: e.postId,
    ...(e.send ? { send: { toHex: e.send.toHex, toName: e.send.toName, amount: e.send.amount.toString(), boxId: e.send.boxId } } : {}),
    expiresAtHeight: e.expiresAtHeight,
    submittedAtHeight: e.submittedAtHeight,
  };
}

const KNOWN_KINDS: ReadonlySet<PendingEntry['kind']> = new Set<PendingEntry['kind']>([
  'post', 'like', 'grant', 'creditGrant', 'vouch', 'unvouch', 'invite',
  'withdraw', 'claim', 'burn', 'send',
]);

/** Validate and convert one stored entry, throwing on any malformed field so
 *  restore() can drop the whole ledger rather than load a partial one.
 *  `submittedAtHeight` need only be a number, and the stored `expiresAtHeight`
 *  is not checked at all: restore holds both through the bound, which takes
 *  any shape. The function reads neither `inputs` nor `change` — the ledger
 *  holds no input and no change (WEB_INTERFACE → The wallet → "An entry holds
 *  no input and no change") — and accepts a stored entry carrying either, so
 *  a browser holding one keeps its pending state. */
function parseStoredEntry(v: unknown): UnboundedEntry {
  if (typeof v !== 'object' || v === null) throw new Error('entry is not an object');
  const o = v as Record<string, unknown>;
  if (typeof o.txId !== 'string' || typeof o.postId !== 'string') throw new Error('entry has non-string ids');
  if (typeof o.kind !== 'string' || !KNOWN_KINDS.has(o.kind as PendingEntry['kind'])) {
    throw new Error('entry has an unknown kind');
  }
  if (typeof o.submittedAtHeight !== 'number') throw new Error('entry submittedAtHeight is not a number');
  let send: SendRef | undefined;
  if (o.send !== undefined) {
    const s = o.send;
    if (typeof s !== 'object' || s === null) throw new Error('entry send is not an object');
    const so = s as Record<string, unknown>;
    if (
      typeof so.toHex !== 'string' ||
      (so.toName !== null && typeof so.toName !== 'string') ||
      typeof so.amount !== 'string' ||
      typeof so.boxId !== 'string'
    ) {
      throw new Error('entry send has a malformed field');
    }
    send = { toHex: so.toHex, toName: so.toName as string | null, amount: BigInt(so.amount), boxId: so.boxId };
  }
  return {
    txId: o.txId,
    kind: o.kind as PendingEntry['kind'],
    postId: o.postId,
    ...(send ? { send } : {}),
    expiresAtHeight: o.expiresAtHeight,
    submittedAtHeight: o.submittedAtHeight,
  };
}
