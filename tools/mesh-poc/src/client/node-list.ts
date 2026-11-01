// MESH_INTERFACE → The client's node list — one entry per node key, moved by
// what a failure is evidence of (the split NET_INTERFACE → Handshake →
// "Ban policy" draws): a frame-tier failure (nothing proven about the peer)
// earns a growing retry, never a ban; a body-tier failure (a lie,
// authenticated to the key) is permanent with its evidence.
//
// Pure, browser-safe (MESH_INTERFACE → Place in the workspace); the module
// mutates nothing but its own entries and reads a monotonic clock the caller
// supplies.

import { MeshKeyError } from '../identity.js';
import { RETRY_BASE_MS, RETRY_CAP_MS } from '../protocols.js';

export interface Anchor {
  notisId: string;
  addrs: string[];
}

export type FailureKind = 'timeout' | 'refused' | 'dropped' | 'transport' | 'clock';

export interface LieEvidence {
  kind: 'malformed' | 'proof-invalid';
  atMs: number;
  detail: string;
}

/**
 * MESH_INTERFACE → The client's node list — "An entry keeps its last
 * failure's kind and message, for the page to show why a node is in
 * `retry`; the message is shown, never acted on."
 */
export interface LastFailure {
  kind: FailureKind;
  message: string;
  atMs: number;
}

export type NodeStatus = 'ok' | 'trailing' | 'retry' | 'behind' | 'blacklisted' | 'new';

export interface NodeEntry {
  notisId: string;
  anchor: boolean;
  /**
   * MESH_INTERFACE → The client's node list → "A node added by hand" —
   * true for an entry a reader has added through `addByHand`, carrying
   * forward across later events; the gater reads it through
   * `configuredAddrs` (MESH_INTERFACE → Transports → "A client dials a
   * private address only when its own configuration names it").
   */
  byHand: boolean;
  status: NodeStatus;
  failures: number;
  retryAtMs: number;
  /**
   * MESH_INTERFACE → The client's node list → "A check" — "it times
   * each node's proof read; that time is the node's speed until the
   * next check." Written by the client's decoration pass from the
   * latest check's measurement; `null` from the list, and `null` until
   * a check has timed a proof read for this key, or after a failed
   * read.
   */
  readMs: number | null;
  /**
   * MESH_INTERFACE → The client's node list — this node's
   * `TipResult.nodes[i].behind` in the latest check; `null` when it
   * did not verify. Written by the client's decoration pass; `null`
   * from the list.
   */
  behindBy: number | null;
  addrs: string[];
  droppedAddrs: string[];
  evidence: LieEvidence | null;
  /**
   * MESH_INTERFACE → The client's node list — "An entry keeps its
   * last failure's kind and message, for the page to show why a node
   * is in `retry`". `lastFailure` holds the most recent failure (any
   * address); `lastFailures` keeps one entry per address, so a reader
   * can see which address failed how. A success clears both.
   */
  lastFailure: LastFailure | null;
  lastFailures: Record<string, LastFailure>;
  /**
   * MESH_INTERFACE → NAT / The client's node list — the transport and
   * path of the connection the display reads for this entry's key,
   * read with the same pick + classify the top-level pair uses
   * (`pickConnectionForLabel` + `classifyConnectionAddr`). `null`
   * when the client holds no open connection to this key. The pair for
   * the node in use agrees with `ClientState.transport` /
   * `ClientState.path`. Written by `mesh-client`'s decoration pass; the
   * node list itself holds no transport state.
   */
  transport: 'webrtc-direct' | 'webrtc' | 'wss' | null;
  path: 'direct' | 'relay' | null;
}

const NOTIS_ID_RE = /^[0-9a-f]{64}$/;

function assertNotisId(id: string): void {
  if (!NOTIS_ID_RE.test(id)) {
    throw new MeshKeyError('id must be 64 lowercase hex characters');
  }
}

/**
 * Each entry's writable form. `clockAtFailure` is the clock reading at the
 * latest failure; `storedRetryAtMs` is that reading plus the capped wait. The
 * exposed `retryAtMs` is the stored value except when the current clock sits
 * behind `clockAtFailure` — the stepped-back case, where the clamp caps the
 * exposed wait (MESH_INTERFACE → The client's node list, Retry).
 */
interface InternalEntry {
  notisId: string;
  anchor: boolean;
  byHand: boolean;
  status: NodeStatus;
  failures: number;
  clockAtFailure: number;
  storedRetryAtMs: number;
  addrs: string[];
  /**
   * MESH_INTERFACE → The client's node list → "A node added by hand" —
   * the addresses the client's own configuration names for the key: an
   * anchor's given addresses and those entered by hand, never one
   * merged from the DHT or a seed. `configuredAddrs(id)` reads this
   * list; `add(id, addrs)` leaves it unchanged.
   */
  configured: string[];
  droppedAddrs: string[];
  evidence: LieEvidence | null;
  lastFailure: LastFailure | null;
  lastFailures: Record<string, LastFailure>;
}

export class NodeList {
  private readonly entries_: Map<string, InternalEntry> = new Map();
  private readonly clock: () => number;

  constructor(anchors: Anchor[], ownId: string, clock: () => number) {
    assertNotisId(ownId);
    this.clock = clock;
    for (const a of anchors) {
      assertNotisId(a.notisId);
      // "the client's own key is none" (MESH_INTERFACE → Discovery).
      if (a.notisId === ownId) continue;
      const existing = this.entries_.get(a.notisId);
      if (existing) {
        // "Two anchors with one key are one anchor" (MESH_INTERFACE → Discovery):
        // the first entry stands; the rest's addresses merge into it. Both
        // sets are anchor-given, so the merged addresses count as configured.
        this.mergeAddrs(existing, a.addrs);
        this.mergeConfigured(existing, a.addrs);
      } else {
        this.entries_.set(a.notisId, {
          notisId: a.notisId,
          anchor: true,
          byHand: false,
          status: 'new',
          failures: 0,
          clockAtFailure: 0,
          storedRetryAtMs: 0,
          addrs: [...a.addrs],
          configured: [...a.addrs],
          droppedAddrs: [],
          evidence: null,
          lastFailure: null,
          lastFailures: {},
        });
      }
    }
  }

  add(id: string, addrs: string[]): void {
    assertNotisId(id);
    const existing = this.entries_.get(id);
    if (existing) {
      // A lie is permanent (MESH_INTERFACE → The client's node list): no later
      // `add` revives a blacklisted entry's state.
      if (existing.status === 'blacklisted') return;
      this.mergeAddrs(existing, addrs);
      return;
    }
    this.entries_.set(id, {
      notisId: id,
      anchor: false,
      byHand: false,
      status: 'new',
      failures: 0,
      clockAtFailure: 0,
      storedRetryAtMs: 0,
      addrs: [...addrs],
      // MESH_INTERFACE → The client's node list → "A node added by hand":
      // `add` is a seed- or DHT-sourced add; its addresses are not
      // configured. `addByHand` is the one entry point that writes
      // `configured`.
      configured: [],
      droppedAddrs: [],
      evidence: null,
      lastFailure: null,
      lastFailures: {},
    });
  }

  /**
   * MESH_INTERFACE → The client's node list → "A node added by hand" —
   * the reader may add a node by its key and an address. A new entry
   * gets `anchor = trusted`, `byHand = true`; an existing one merges
   * the addresses, sets `byHand = true`, and `anchor ||= trusted`; a
   * `blacklisted` one is unchanged. The addresses are added to
   * `configured` for the gater (→ Transports → "A client dials a
   * private address only when its own configuration names it"). The
   * key check is `add`'s (64 lowercase hex); the address checks (DNS,
   * `/webrtc-direct/`) are the client's, not the list's.
   */
  addByHand(id: string, addrs: string[], trusted: boolean): void {
    assertNotisId(id);
    const existing = this.entries_.get(id);
    if (existing) {
      if (existing.status === 'blacklisted') return;
      this.mergeAddrs(existing, addrs);
      this.mergeConfigured(existing, addrs);
      existing.byHand = true;
      existing.anchor = existing.anchor || trusted;
      return;
    }
    this.entries_.set(id, {
      notisId: id,
      anchor: trusted,
      byHand: true,
      status: 'new',
      failures: 0,
      clockAtFailure: 0,
      storedRetryAtMs: 0,
      addrs: [...addrs],
      configured: [...addrs],
      droppedAddrs: [],
      evidence: null,
      lastFailure: null,
      lastFailures: {},
    });
  }

  /**
   * MESH_INTERFACE → The client's node list → "A node added by hand"
   * — the addresses the client's own configuration names for the key:
   * an anchor's given addresses and those entered by hand, never one
   * merged from the DHT or a seed. An id the list does not hold reads
   * as the empty list — the gater is a hot path where every dial asks
   * about addresses the list may never have seen.
   */
  configuredAddrs(id: string): string[] {
    assertNotisId(id);
    const e = this.entries_.get(id);
    if (!e) return [];
    return [...e.configured];
  }

  success(id: string): void {
    assertNotisId(id);
    const e = this.unknown('success', id);
    if (e.status === 'blacklisted') return;
    e.failures = 0;
    e.storedRetryAtMs = 0;
    e.status = 'ok';
    // MESH_INTERFACE → The client's node list — "cleared on success":
    // a node that answers again clears the diagnostic that was on it.
    e.lastFailure = null;
    e.lastFailures = {};
  }

  failure(id: string, kind: FailureKind, message = '', addr?: string): void {
    assertNotisId(id);
    const e = this.unknown('failure', id);
    if (e.status === 'blacklisted') return;
    e.failures += 1;
    // `min(RETRY_CAP_MS, RETRY_BASE_MS · 2^(failures − 1))` on a monotonic
    // clock (MESH_INTERFACE → The client's node list, Retry).
    const wait = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * Math.pow(2, e.failures - 1));
    const now = this.clock();
    e.clockAtFailure = now;
    e.storedRetryAtMs = now + wait;
    e.status = 'retry';
    // MESH_INTERFACE → The client's node list — "An entry keeps its
    // last failure's kind and message". Captured here, cleared on
    // success. The clock reading is the monotonic one — same clock
    // every other `atMs` reads. When the caller names an `addr`, the
    // failure also lands in `lastFailures[addr]` so a reader sees
    // which address failed how (one entry per address).
    const record: LastFailure = { kind, message, atMs: now };
    e.lastFailure = record;
    if (typeof addr === 'string' && addr !== '') {
      e.lastFailures[addr] = record;
    }
  }

  /**
   * MESH_INTERFACE → The client's node list → "A node's addresses are
   * dialled as one operation" — "each address libp2p reports it dialled
   * has its failure recorded against it". Writes `lastFailures[addr]`
   * alone, with no change to `failures`, `status` or the retry
   * schedule — those move once per dial through `failure`, not
   * per-address. The caller (`dialByAddresses`) folds every attributed
   * address error through this method, then calls `failure` once for
   * the aggregate.
   */
  recordAddrFailure(id: string, addr: string, kind: FailureKind, message = ''): void {
    assertNotisId(id);
    const e = this.unknown('recordAddrFailure', id);
    if (e.status === 'blacklisted') return;
    if (typeof addr !== 'string' || addr === '') return;
    const now = this.clock();
    e.lastFailures[addr] = { kind, message, atMs: now };
  }

  behind(id: string): void {
    assertNotisId(id);
    const e = this.unknown('behind', id);
    if (e.status === 'blacklisted') return;
    e.failures = 0;
    e.storedRetryAtMs = 0;
    e.status = 'behind';
  }

  /**
   * MESH_INTERFACE → The client's node list — the "one block behind on
   * the tip's chain" row. Mirrors `behind`: resets the retry schedule
   * and the failure count, leaves evidence and dropped addresses
   * alone, and a `blacklisted` entry is unchanged.
   */
  trailing(id: string): void {
    assertNotisId(id);
    const e = this.unknown('trailing', id);
    if (e.status === 'blacklisted') return;
    e.failures = 0;
    e.storedRetryAtMs = 0;
    e.status = 'trailing';
  }

  wrongKey(id: string, addr: string, _answeredId: string | null): void {
    assertNotisId(id);
    const e = this.unknown('wrongKey', id);
    if (e.status === 'blacklisted') return;
    // "the address lied, not the key" (MESH_INTERFACE → The client's node
    // list): the address drops; status and failure count are unchanged.
    // A hand-added address that lied also leaves `configured` so the
    // gater refuses its next dial.
    const idx = e.addrs.indexOf(addr);
    if (idx !== -1) e.addrs.splice(idx, 1);
    const cidx = e.configured.indexOf(addr);
    if (cidx !== -1) e.configured.splice(cidx, 1);
    if (!e.droppedAddrs.includes(addr)) e.droppedAddrs.push(addr);
  }

  lie(id: string, evidence: LieEvidence): void {
    assertNotisId(id);
    const e = this.unknown('lie', id);
    // "no later event or `add` changes either": the first lie fixes both the
    // status and the evidence (MESH_INTERFACE → The client's node list).
    if (e.status === 'blacklisted') return;
    e.status = 'blacklisted';
    e.evidence = evidence;
    e.storedRetryAtMs = 0;
  }

  entry(id: string): NodeEntry | undefined {
    const e = this.entries_.get(id);
    if (!e) return undefined;
    return this.view(e);
  }

  entries(): NodeEntry[] {
    const out: NodeEntry[] = [];
    for (const e of this.entries_.values()) out.push(this.view(e));
    return out;
  }

  /**
   * `anchorReached` is true while some anchor's latest event is an answer it
   * could check — a success, a valid proof one block behind, or a valid
   * proof further behind (MESH_INTERFACE → No anchor reached). The status
   * captures the latest event; `ok`, `trailing` or `behind` means the
   * anchor was reached.
   */
  anchorReached(): boolean {
    for (const e of this.entries_.values()) {
      if (e.anchor && (e.status === 'ok' || e.status === 'trailing' || e.status === 'behind')) return true;
    }
    return false;
  }

  /**
   * Ordering: `ok`, `trailing`, `behind`, nodes not yet tried, then
   * `retry` nodes whose time has come; never a `blacklisted` node
   * (MESH_INTERFACE → The client's node list → "Candidates"). Inside a
   * group the Map's insertion order answers "first known", with anchors
   * in their given order first because the constructor inserts them
   * before any `add`.
   */
  candidates(): string[] {
    const ok: string[] = [];
    const trailing: string[] = [];
    const behind: string[] = [];
    const fresh: string[] = [];
    const retry: string[] = [];
    const now = this.clock();
    for (const e of this.entries_.values()) {
      if (e.status === 'ok') ok.push(e.notisId);
      else if (e.status === 'trailing') trailing.push(e.notisId);
      else if (e.status === 'behind') behind.push(e.notisId);
      else if (e.status === 'new') fresh.push(e.notisId);
      else if (e.status === 'retry') {
        if (now >= this.clampedRetryAt(e)) retry.push(e.notisId);
      }
      // `blacklisted` is dropped: never a candidate.
    }
    return [...ok, ...trailing, ...behind, ...fresh, ...retry];
  }

  /**
   * Fetch the entry under `id` and throw a plain `Error` naming the method
   * and the id when the list does not hold it: a correct caller sends an
   * event only for an id it `add`ed or saw through `candidates()`, so an
   * unknown id is a bug on the caller's side and silence would hide it
   * (MESH_INTERFACE → The client's node list).
   */
  private unknown(method: string, id: string): InternalEntry {
    const e = this.entries_.get(id);
    if (!e) throw new Error(`${method}: unknown id ${id}`);
    return e;
  }

  private mergeAddrs(e: InternalEntry, addrs: string[]): void {
    for (const addr of addrs) {
      // "`add` never brings a dropped address back"
      // (MESH_INTERFACE → The client's node list).
      if (e.droppedAddrs.includes(addr)) continue;
      if (!e.addrs.includes(addr)) e.addrs.push(addr);
    }
  }

  /**
   * Merge the given addresses into `configured`, respecting the same
   * dropped-address rule `mergeAddrs` holds: an address a key lied
   * through does not return through a later anchor merge or hand-add.
   */
  private mergeConfigured(e: InternalEntry, addrs: string[]): void {
    for (const addr of addrs) {
      if (e.droppedAddrs.includes(addr)) continue;
      if (!e.configured.includes(addr)) e.configured.push(addr);
    }
  }

  /**
   * The clamp caps the exposed wait at `RETRY_CAP_MS` from the current clock
   * when, and only when, the clock has stepped back of its own below the
   * failure moment: on a monotonic clock the write-time cap suffices, and the
   * clamp exists for the stepped-back case alone — an injected test clock, a
   * laptop sleep, an NTP step (MESH_INTERFACE → The client's node list, Retry).
   */
  private clampedRetryAt(e: InternalEntry): number {
    const now = this.clock();
    if (now < e.clockAtFailure) {
      return Math.min(e.storedRetryAtMs, now + RETRY_CAP_MS);
    }
    return e.storedRetryAtMs;
  }

  private view(e: InternalEntry): NodeEntry {
    const retryAtMs = e.status === 'retry' ? this.clampedRetryAt(e) : e.storedRetryAtMs;
    return {
      notisId: e.notisId,
      anchor: e.anchor,
      byHand: e.byHand,
      status: e.status,
      failures: e.failures,
      retryAtMs,
      // `readMs` and `behindBy` are written by `mesh-client`'s
      // decoration pass; the node list itself holds no measurement, so
      // it emits `null` here.
      readMs: null,
      behindBy: null,
      addrs: [...e.addrs],
      droppedAddrs: [...e.droppedAddrs],
      evidence: e.evidence,
      lastFailure: e.lastFailure,
      lastFailures: { ...e.lastFailures },
      // The transport/path pair is written by `mesh-client`'s decoration
      // pass over `getConnections()`; the node list itself holds no
      // transport state, so it emits `null`/`null` here.
      transport: null,
      path: null,
    };
  }
}
