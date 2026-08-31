import { PeerState, PenaltyKind } from './types.js';
import type { NetConfig, Peer, PenaltyType, PeerMetadata } from './types.js';

/**
 * Points drained from an accumulated penalty score per elapsed
 * `penaltySafeIntervalMs` (NET_INTERFACE → Accrual and decay).
 * Break-even is one MisbehaviorPenalty (100) per interval: misbehave
 * faster and the score climbs toward a ban, slower and it fades to zero.
 */
const PENALTY_DECAY_PER_INTERVAL = 100;

/**
 * The most bans to keep. A ban keys on a peer id, which regenerates freely, so a
 * permanent ban is a hint against a lazy repeat rather than a guarantee — and an
 * unbounded set of hints is a leak an attacker mints by misbehaving under fresh
 * ids (NET_INTERFACE → "Ban tracking is a bounded hint, not a ledger"). Past the
 * cap the oldest lapse first; a lapsed hint grants nothing a fresh id could not
 * already take.
 */
export const MAX_TRACKED_BANS = 10_000;

interface PeerEntry {
  peer: Peer;
  penaltyScore: number;
  lastPenaltyTime: number;
  banExpiresAt: number | null;
}

interface BanEntry {
  peerId: string;
  bannedAt: number;
  banExpiresAt: number | null; // null = permanent
  /**
   * The peer's declared address at ban time, captured before the ban path
   * deletes the metadata. Expiry propagates the unban from here — by then
   * the metadata may be long gone (removePeer on disconnect).
   */
  address: string | null;
}

/**
 * Optional callbacks fired when a ban is imposed or expires, carrying the
 * peer's declared address. NetNode binds these to PeerDb.ban/unban so the
 * peerId-keyed and address-keyed ban surfaces cannot drift apart (contract:
 * "Ban surfaces are unified"). Callbacks — not a PeerDb import — keep
 * peer-mgr a leaf module.
 */
export interface PeerBanHooks {
  onBan?: (address: string) => void;
  onUnban?: (address: string) => void;
  onPenalty?: (peerId: string, kind: string, detail: string | null) => void;
}

export class PeerManager {
  private peers: Map<string, PeerEntry> = new Map();
  private bans: Map<string, BanEntry> = new Map();
  private metadata: Map<string, PeerMetadata> = new Map();
  private config: NetConfig;
  private hooks: PeerBanHooks;

  constructor(config: NetConfig, hooks: PeerBanHooks = {}) {
    this.config = config;
    this.hooks = hooks;
  }

  // -----------------------------------------------------------------------
  // Peer tracking
  // -----------------------------------------------------------------------

  getPeers(): Peer[] {
    return Array.from(this.peers.values()).map((e) => e.peer);
  }

  getPeerCount(): number {
    return this.peers.size;
  }

  addPeer(peer: Peer): void {
    if (this.isBanned(peer.id)) return;
    this.peers.set(peer.id, {
      peer,
      penaltyScore: 0,
      lastPenaltyTime: 0,
      banExpiresAt: null,
    });
    // Initialize peer metadata if not already present
    if (!this.metadata.has(peer.id)) {
      this.metadata.set(peer.id, {
        peerId: peer.id,
        state: PeerState.Connecting,
        penaltyCount: 0,
        bannedUntil: null,
        lastSeenMs: Date.now(),
        address: null,
        protocolVersion: null,
      });
    }
  }

  /**
   * Record the peer's declared address once the handshake reveals it. No-op
   * for an untracked peer, like setPeerState. A peer banned before this is
   * called simply has no address to propagate — that is correct, not an
   * error.
   */
  setPeerAddress(peerId: string, address: string): void {
    const meta = this.metadata.get(peerId);
    if (meta) meta.address = address;
  }

  /**
   * Record the peer's declared `protocolVersion` once the handshake reveals it.
   * No-op for an untracked peer, like setPeerAddress. It is what the boundary
   * sweep reads (NET_INTERFACE → Post-Handshake Routing).
   */
  setPeerVersion(peerId: string, protocolVersion: number): void {
    const meta = this.metadata.get(peerId);
    if (meta) meta.protocolVersion = protocolVersion;
  }

  /**
   * The peer ids of every Active peer whose declared `protocolVersion` is known
   * and below `era` — the boundary sweep's targets (NET_INTERFACE →
   * Post-Handshake Routing). A peer whose version is null has not handshaken and
   * is not Active, so it is never returned.
   */
  activePeersBelowVersion(era: number): string[] {
    const below: string[] = [];
    for (const meta of this.metadata.values()) {
      if (
        meta.state === PeerState.Active &&
        meta.protocolVersion !== null &&
        meta.protocolVersion < era
      ) {
        below.push(meta.peerId);
      }
    }
    return below;
  }

  removePeer(peerId: string): void {
    this.peers.delete(peerId);
    this.metadata.delete(peerId);
  }

  // -----------------------------------------------------------------------
  // Penalty system (legacy score-based)
  // -----------------------------------------------------------------------

  recordPenalty(type: PenaltyType, peerId: string, score: number, reason: string): void {
    const now = Date.now();

    if (type === 'permanent') {
      // Instant permanent ban — works even if peer was never added.
      // imposeBan reads the address before the metadata.delete below.
      this.imposeBan(peerId, now, null);
      this.peers.delete(peerId);
      this.metadata.delete(peerId);
      this.hooks.onPenalty?.(peerId, type, reason);
      return;
    }

    this.accrueScoredPenalty(peerId, score, now);
    this.hooks.onPenalty?.(peerId, type, reason);
  }

  /**
   * Impose a ban and propagate it to the address surface. The metadata read
   * happens here, before the permanent-ban callers delete the metadata —
   * reading after that delete would silently drop the propagation. A peer
   * with no recorded address (banned before its handshake completed) has
   * nothing to propagate.
   */
  private imposeBan(peerId: string, now: number, banExpiresAt: number | null): void {
    const address = this.metadata.get(peerId)?.address ?? null;
    this.bans.set(peerId, { peerId, bannedAt: now, banExpiresAt, address });
    // Insertion order is chronological, so the first keys are the oldest bans.
    while (this.bans.size > MAX_TRACKED_BANS) {
      const oldest = this.bans.keys().next().value;
      if (oldest === undefined) break;
      this.bans.delete(oldest);
    }
    if (address !== null) this.hooks.onBan?.(address);
  }

  // -----------------------------------------------------------------------
  // Three-tier penalty attribution (contract: Penalty Attribution)
  // -----------------------------------------------------------------------

  /**
   * Record a penalty using the two-tier system.
   *
   * - Transient: scored (50), decays over time, peer stays in PeerDb
   *   (timeout, slow response)
   * - ProtocolViolation: permanent ban, peer removed from PeerDb
   */
  recordPenaltyKind(kind: PenaltyKind, peerId: string, reason: string): void {
    const now = Date.now();

    switch (kind) {
      case PenaltyKind.ProtocolViolation: {
        // Permanent ban — remove peer entirely.
        // imposeBan reads the address before the metadata.delete below.
        this.imposeBan(peerId, now, null);
        this.peers.delete(peerId);
        this.metadata.delete(peerId);
        this.hooks.onPenalty?.(peerId, kind, reason);
        return;
      }
      case PenaltyKind.Transient: {
        this.accrueScoredPenalty(peerId, 50, now);
        this.hooks.onPenalty?.(peerId, kind, reason);
        return;
      }
    }
  }

  /**
   * Shared accrual + decay for every non-permanent penalty
   * (NET_INTERFACE → Accrual and decay).
   *
   * Every penalty accrues — none are discarded for arriving quickly.
   * Instead the accumulated score decays by PENALTY_DECAY_PER_INTERVAL per
   * `penaltySafeIntervalMs` elapsed since the last penalty, proportionally
   * and floored at zero, computed lazily here — no timers. The config field
   * keeps its "safe interval" name because @dagsocial/node sets it from the
   * environment, but it is a decay interval, not a cooldown.
   */
  private accrueScoredPenalty(peerId: string, score: number, now: number): void {
    const entry = this.peers.get(peerId);
    if (!entry) return;

    const intervalMs = this.config.penaltySafeIntervalMs;
    // Clamped: a clock running backwards must not mint negative decay,
    // which would inflate the score.
    const elapsedMs = Math.max(0, now - entry.lastPenaltyTime);
    if (intervalMs > 0 && elapsedMs > 0) {
      const decay = (elapsedMs / intervalMs) * PENALTY_DECAY_PER_INTERVAL;
      entry.penaltyScore = Math.max(0, entry.penaltyScore - decay);
    }

    entry.penaltyScore += score;
    entry.lastPenaltyTime = now;

    const meta = this.metadata.get(peerId);
    if (meta) {
      meta.penaltyCount++;
      meta.lastSeenMs = now;
    }

    if (entry.penaltyScore >= this.config.penaltyScoreThreshold) {
      const banExpiresAt = now + this.config.temporalBanDurationMs;
      this.imposeBan(peerId, now, banExpiresAt);
      this.peers.delete(peerId);
      if (meta) {
        meta.state = PeerState.Banned;
        meta.bannedUntil = banExpiresAt;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Peer state machine
  // -----------------------------------------------------------------------

  /** Transition a peer to a new state. Idempotent — ignores redundant transitions. */
  setPeerState(peerId: string, state: PeerState): void {
    const meta = this.metadata.get(peerId);
    if (meta) {
      meta.state = state;
      meta.lastSeenMs = Date.now();
    }
  }

  /** Get metadata for a peer, or null if not tracked. */
  getPeerMetadata(peerId: string): PeerMetadata | null {
    return this.metadata.get(peerId) ?? null;
  }

  /** Guard: returns true only if the peer is in the Active state. */
  isPeerActive(peerId: string): boolean {
    const meta = this.metadata.get(peerId);
    return meta?.state === PeerState.Active;
  }

  isBanned(peerId: string): boolean {
    const ban = this.bans.get(peerId);
    if (!ban) return false;
    if (ban.banExpiresAt === null) return true; // permanent
    if (Date.now() >= ban.banExpiresAt) {
      // Ban expired, clean up and lift the address-surface ban with it
      this.bans.delete(peerId);
      if (ban.address !== null) this.hooks.onUnban?.(ban.address);
      return false;
    }
    return true;
  }
}
