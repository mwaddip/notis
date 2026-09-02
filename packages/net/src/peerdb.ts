import type { PeerRecord } from './types.js';
import {
  isRecord,
  isBoundedInt,
  isBoundedIntArray,
  MAX_CAPABILITY_CODE,
  MAX_CAPABILITY_ENTRIES,
  MAX_NAME_BYTES,
  MAX_ADDRESS_BYTES,
} from './msg-guards.js';

export interface PeerStorage {
  loadAll(): PeerRecord[];
  put(record: PeerRecord): void;
  delete(address: string): void;
}

/**
 * True for a row PeerDb may hold.
 *
 * `recent()` feeds a `Peers` body verbatim, and the receiver bounds every entry
 * it decodes: one out-of-domain field rejects the whole body and permanently
 * bans the sender (NET_INTERFACE → Peers). A row is therefore admitted only if
 * we can serve it — the guarantee that response rests on is a property of
 * PeerDb's contents, not of any one way in.
 *
 * The five wire fields carry the bounds `decodePeers` and `validateHandshake`
 * apply to the same names, through the same predicates; a second spelling of a
 * bound is a second rule to keep in step. `lastSeenMs` is not a wire field —
 * it orders `recent()` and picks the eviction victim — so its bound is the
 * non-negative integer both writers produce by stamping a clock.
 *
 * `loadAll()` declares `PeerRecord[]`; that is the storage implementation's
 * claim, and this is where it is checked.
 */
function isServableRecord(rec: unknown): rec is PeerRecord {
  if (!isRecord(rec)) return false;
  if (typeof rec.address !== 'string') return false;
  if (Buffer.byteLength(rec.address as string, 'utf8') > MAX_ADDRESS_BYTES) return false;
  if (!isBoundedInt(rec.lastSeenMs, Number.MAX_SAFE_INTEGER)) return false;
  if (typeof rec.agentName !== 'string' || (rec.agentName as string).length === 0) return false;
  if (Buffer.byteLength(rec.agentName as string, 'utf8') > MAX_NAME_BYTES) return false;
  if (typeof rec.nodeName !== 'string') return false;
  if (Buffer.byteLength(rec.nodeName as string, 'utf8') > MAX_NAME_BYTES) return false;
  if (!isBoundedInt(rec.protocolVersion, MAX_CAPABILITY_CODE)) return false;
  if (!isBoundedIntArray(rec.capabilities, MAX_CAPABILITY_CODE)) return false;
  if (Array.isArray(rec.capabilities) && rec.capabilities.length > MAX_CAPABILITY_ENTRIES) return false;
  return true;
}

/**
 * The most banned addresses to keep. Like the peer-id ban set, this is a bounded
 * hint, not a ledger (NET_INTERFACE → "Ban tracking is a bounded hint, not a
 * ledger"): a permanent ban whose address is never lifted otherwise grows without
 * bound. Past the cap the oldest lapse first.
 */
export const MAX_BANNED_ADDRS = 10_000;

export class PeerDb {
  private entries: Map<string, PeerRecord> = new Map();
  private bannedAddrs: Set<string> = new Set();
  private selfAddrs: Set<string>;

  constructor(
    private storage: PeerStorage | null,
    private cap: number,
    selfAddresses: string[],
  ) {
    this.selfAddrs = new Set(selfAddresses);
    // Load persisted entries on construction. An unservable row is dropped, not
    // repaired: a capability code is an identity rather than a magnitude, so a
    // clamped one advertises a capability the peer never declared. The row
    // stays in storage — the peer re-enters PeerDb through a handshake or a
    // Peers intake, with bounded fields, the next time we meet it.
    if (storage) {
      for (const rec of storage.loadAll() as unknown[]) {
        if (!isServableRecord(rec)) {
          const addr = isRecord(rec) ? String(rec.address) : String(rec);
          console.warn(`[net] not loading peer row ${addr}: out of domain for a Peers body`);
          continue;
        }
        if (!this.selfAddrs.has(rec.address)) {
          this.entries.set(rec.address, rec);
        }
      }
    }
  }

  record(record: PeerRecord): void {
    if (this.selfAddrs.has(record.address)) return;
    if (this.bannedAddrs.has(record.address)) return;

    const existing = this.entries.get(record.address);
    const merged: PeerRecord = existing
      ? { ...record, lastSeenMs: Math.max(existing.lastSeenMs, record.lastSeenMs) }
      : record;

    this.entries.set(record.address, merged);

    // Evict oldest if over cap
    if (this.entries.size > this.cap) {
      let oldestAddr = '';
      let oldestMs = Infinity;
      for (const [addr, rec] of this.entries) {
        if (rec.lastSeenMs < oldestMs) {
          oldestMs = rec.lastSeenMs;
          oldestAddr = addr;
        }
      }
      if (oldestAddr) {
        this.entries.delete(oldestAddr);
        this.storage?.delete(oldestAddr);
      }
    }

    // Only persist if the entry survived eviction
    if (this.entries.has(record.address)) {
      this.storage?.put(merged);
    }
  }

  forget(addr: string): void {
    this.entries.delete(addr);
    this.storage?.delete(addr);
  }

  /**
   * An address whose dial resolved to this node's own peer id: forgotten now,
   * and filtered from every later `record` the way our own listen addresses
   * are — a Peers intake or a handshake naming the same address is dropped
   * thereafter (NET_INTERFACE → PeerDb).
   */
  forgetSelf(addr: string): void {
    this.forget(addr);
    this.selfAddrs.add(addr);
  }

  /** Ban a peer address — removes from entries and prevents re-add. */
  ban(addr: string): void {
    this.bannedAddrs.add(addr);
    // Insertion order is chronological, so the first entries are the oldest bans.
    while (this.bannedAddrs.size > MAX_BANNED_ADDRS) {
      const oldest = this.bannedAddrs.values().next().value;
      if (oldest === undefined) break;
      this.bannedAddrs.delete(oldest);
    }
    this.entries.delete(addr);
    this.storage?.delete(addr);
  }

  /** Check if an address is banned. */
  isBanned(addr: string): boolean {
    return this.bannedAddrs.has(addr);
  }

  /** Lift a ban (e.g., temporal ban expired). */
  unban(addr: string): void {
    this.bannedAddrs.delete(addr);
  }

  get(addr: string): PeerRecord | null {
    if (this.bannedAddrs.has(addr)) return null;
    return this.entries.get(addr) ?? null;
  }

  recent(limit: number, excludeAddrs: Set<string>): PeerRecord[] {
    const filtered = Array.from(this.entries.values())
      .filter((r) => !excludeAddrs.has(r.address) && !this.bannedAddrs.has(r.address));
    filtered.sort((a, b) => b.lastSeenMs - a.lastSeenMs);
    return filtered.slice(0, limit);
  }

  all(): PeerRecord[] {
    return Array.from(this.entries.values());
  }

  count(): number {
    return this.entries.size;
  }
}
