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

export type FailureKind = 'timeout' | 'refused' | 'dropped' | 'transport';

export interface LieEvidence {
  kind: 'malformed' | 'proof-invalid';
  atMs: number;
  detail: string;
}

export type NodeStatus = 'ok' | 'retry' | 'behind' | 'blacklisted' | 'new';

export interface NodeEntry {
  notisId: string;
  anchor: boolean;
  status: NodeStatus;
  failures: number;
  retryAtMs: number;
  addrs: string[];
  droppedAddrs: string[];
  evidence: LieEvidence | null;
}

const NOTIS_ID_RE = /^[0-9a-f]{64}$/;

function assertNotisId(id: string): void {
  if (!NOTIS_ID_RE.test(id)) {
    throw new MeshKeyError('id must be 64 lowercase hex characters');
  }
}

/**
 * Each entry's writable form; `storedRetryAtMs` is the raw clock + wait at the
 * moment of the last failure. The exposed `retryAtMs` clamps it to
 * `clock() + RETRY_CAP_MS` on read, so a clock that steps back cannot hold a
 * node out past the cap (MESH_INTERFACE → The client's node list, Retry).
 */
interface InternalEntry {
  notisId: string;
  anchor: boolean;
  status: NodeStatus;
  failures: number;
  storedRetryAtMs: number;
  addrs: string[];
  droppedAddrs: string[];
  evidence: LieEvidence | null;
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
        // the first entry stands; the rest's addresses merge into it.
        this.mergeAddrs(existing, a.addrs);
      } else {
        this.entries_.set(a.notisId, {
          notisId: a.notisId,
          anchor: true,
          status: 'new',
          failures: 0,
          storedRetryAtMs: 0,
          addrs: [...a.addrs],
          droppedAddrs: [],
          evidence: null,
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
      status: 'new',
      failures: 0,
      storedRetryAtMs: 0,
      addrs: [...addrs],
      droppedAddrs: [],
      evidence: null,
    });
  }

  success(id: string): void {
    assertNotisId(id);
    const e = this.entries_.get(id);
    if (!e || e.status === 'blacklisted') return;
    e.failures = 0;
    e.storedRetryAtMs = 0;
    e.status = 'ok';
  }

  failure(id: string, _kind: FailureKind): void {
    assertNotisId(id);
    const e = this.entries_.get(id);
    if (!e || e.status === 'blacklisted') return;
    e.failures += 1;
    // `min(RETRY_CAP_MS, RETRY_BASE_MS · 2^(failures − 1))` on a monotonic
    // clock (MESH_INTERFACE → The client's node list, Retry).
    const wait = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * Math.pow(2, e.failures - 1));
    e.storedRetryAtMs = this.clock() + wait;
    e.status = 'retry';
  }

  behind(id: string): void {
    assertNotisId(id);
    const e = this.entries_.get(id);
    if (!e || e.status === 'blacklisted') return;
    e.failures = 0;
    e.storedRetryAtMs = 0;
    e.status = 'behind';
  }

  wrongKey(id: string, addr: string, _answeredId: string | null): void {
    assertNotisId(id);
    const e = this.entries_.get(id);
    if (!e) return;
    // "the address lied, not the key" (MESH_INTERFACE → The client's node
    // list): the address drops; status and failure count are unchanged.
    const idx = e.addrs.indexOf(addr);
    if (idx !== -1) e.addrs.splice(idx, 1);
    if (!e.droppedAddrs.includes(addr)) e.droppedAddrs.push(addr);
  }

  lie(id: string, evidence: LieEvidence): void {
    assertNotisId(id);
    const e = this.entries_.get(id);
    if (!e) return;
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
   * could check — a success, or a valid proof that is behind
   * (MESH_INTERFACE → No anchor reached). The status captures the latest
   * event; `ok` or `behind` means the anchor was reached.
   */
  anchorReached(): boolean {
    for (const e of this.entries_.values()) {
      if (e.anchor && (e.status === 'ok' || e.status === 'behind')) return true;
    }
    return false;
  }

  /**
   * Ordering: `ok`, then `behind`, then nodes not yet tried, then `retry`
   * nodes whose time has come; never a `blacklisted` node
   * (MESH_INTERFACE → The client's node list, Candidates). Inside a group the
   * Map's insertion order answers "first known", with anchors in their given
   * order first because the constructor inserts them before any `add`.
   */
  candidates(): string[] {
    const ok: string[] = [];
    const behind: string[] = [];
    const fresh: string[] = [];
    const retry: string[] = [];
    const now = this.clock();
    for (const e of this.entries_.values()) {
      if (e.status === 'ok') ok.push(e.notisId);
      else if (e.status === 'behind') behind.push(e.notisId);
      else if (e.status === 'new') fresh.push(e.notisId);
      else if (e.status === 'retry') {
        if (now >= this.clampedRetryAt(e)) retry.push(e.notisId);
      }
      // `blacklisted` is dropped: never a candidate.
    }
    return [...ok, ...behind, ...fresh, ...retry];
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
   * The clamp: a `retry` entry's exposed `retryAtMs` never exceeds
   * `clock() + RETRY_CAP_MS`, so a clock stepped back of its own does not
   * hold the entry out past the longest wait the schedule allows
   * (MESH_INTERFACE → The client's node list, Retry).
   */
  private clampedRetryAt(e: InternalEntry): number {
    return Math.min(e.storedRetryAtMs, this.clock() + RETRY_CAP_MS);
  }

  private view(e: InternalEntry): NodeEntry {
    const retryAtMs = e.status === 'retry' ? this.clampedRetryAt(e) : e.storedRetryAtMs;
    return {
      notisId: e.notisId,
      anchor: e.anchor,
      status: e.status,
      failures: e.failures,
      retryAtMs,
      addrs: [...e.addrs],
      droppedAddrs: [...e.droppedAddrs],
      evidence: e.evidence,
    };
  }
}
