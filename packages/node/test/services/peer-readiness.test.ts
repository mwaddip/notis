import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DISCOVERY_WINDOW_MS,
  isPeerReady,
  markDiscoveryStarted,
  markDiscoveryUnavailable,
  resetPeerReadiness,
} from '../../src/services/peer-readiness.js';
import { setNet } from '../../src/services/net-instance.js';
import type { NetNode } from '@dagsocial/net';

// ---------------------------------------------------------------------------
// A net stand-in whose only observable is the Active peer list. `setNet` takes a
// NetNode; the readiness predicate reads exactly one method off it, so a partial
// fake is the honest fixture — the same shape `routes/utxo.test.ts` uses.
// ---------------------------------------------------------------------------

function fakeNet(connected: string[]): NetNode {
  return { getConnectedPeers: () => connected } as unknown as NetNode;
}

beforeEach(() => {
  resetPeerReadiness();
  setNet(fakeNet([]));
  vi.useFakeTimers();
  // A fixed epoch: every assertion below is about an interval, and a real clock
  // would make the window boundary cases race the test runner.
  vi.setSystemTime(new Date('2026-08-13T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  resetPeerReadiness();
});

// ---------------------------------------------------------------------------
// The window's duration is derived, not chosen — see the constant's own comment.
// ---------------------------------------------------------------------------

describe('peer readiness — the discovery window', () => {
  it('spans at least one of net\'s 30s bootstrap re-dial ticks', () => {
    // A window shorter than the re-dial cadence means the node gives up looking
    // before it has made a second attempt. Measured cadence: 30.02s.
    expect(DISCOVERY_WINDOW_MS).toBeGreaterThan(30_000);
  });

  it('does not span a second tick, so a node alone starts inside a minute', () => {
    expect(DISCOVERY_WINDOW_MS).toBeLessThan(60_000);
  });
});

// ---------------------------------------------------------------------------
// Clause 1 — a connected peer
// ---------------------------------------------------------------------------

describe('peer readiness — a connected peer', () => {
  it('is not ready with no peers inside the window', () => {
    markDiscoveryStarted();
    expect(isPeerReady()).toBe(false);
  });

  it('is ready as soon as one peer is Active, well inside the window', () => {
    markDiscoveryStarted();
    setNet(fakeNet(['12D3KooWpeer1']));
    expect(isPeerReady()).toBe(true);
  });

  it('counts Active peers only — a connected-but-unhandshaken peer is not one', () => {
    // `peers()` lists every peer with an open libp2p connection, at any state:
    // `addPeer` runs on `peer:connect` and initialises state to Connecting.
    // Reading that list would let a peer that failed the magic/version
    // handshake — i.e. one on a DIFFERENT network — satisfy a gate whose whole
    // question is "have I met peers on MY network".
    const netWithKnownButInactive = {
      getConnectedPeers: () => [],
      peers: () => [{ id: 'wrong-network-peer', multiaddrs: [], protocols: [], connectedAt: 0 }],
    } as unknown as NetNode;
    setNet(netWithKnownButInactive);

    markDiscoveryStarted();
    expect(isPeerReady()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Clause 2 — the window elapses
// ---------------------------------------------------------------------------

describe('peer readiness — the window elapsing', () => {
  it('is not ready one millisecond before the window closes', () => {
    markDiscoveryStarted();
    vi.advanceTimersByTime(DISCOVERY_WINDOW_MS - 1);
    expect(isPeerReady()).toBe(false);
  });

  it('is ready at the instant the window closes', () => {
    markDiscoveryStarted();
    vi.advanceTimersByTime(DISCOVERY_WINDOW_MS);
    expect(isPeerReady()).toBe(true);
  });

  it('stays ready after the window, peers or not', () => {
    markDiscoveryStarted();
    vi.advanceTimersByTime(DISCOVERY_WINDOW_MS * 3);
    expect(isPeerReady()).toBe(true);
  });

  it('measures the window from the mark, not from process start', () => {
    // Discovery is entered after the store opens, the AVL tree bootstraps and
    // genesis seeds — none of which is dial time. Time spent before the mark
    // must not consume the window.
    vi.advanceTimersByTime(10 * 60_000);
    markDiscoveryStarted();
    expect(isPeerReady()).toBe(false);
    vi.advanceTimersByTime(DISCOVERY_WINDOW_MS);
    expect(isPeerReady()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Clause 3 — nothing to look for
//
// A node with no bootstrap addresses never dials: the floor phase iterates an
// empty list and `pickCandidate` returns null while outbound < minPeers, which
// it permanently is. Waiting out a window would stand in for an event that
// cannot occur.
// ---------------------------------------------------------------------------

describe('peer readiness — a node with nothing to dial', () => {
  it('is ready immediately when discovery is unavailable', () => {
    markDiscoveryUnavailable();
    expect(isPeerReady()).toBe(true);
  });

  it('is ready without waiting any part of the window', () => {
    markDiscoveryUnavailable();
    vi.advanceTimersByTime(1);
    expect(isPeerReady()).toBe(true);
  });

  it('control: the same node with one bootstrap address does wait', () => {
    markDiscoveryStarted();
    expect(isPeerReady()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Before either mark
//
// Unreachable through the route — `index.ts` awaits `net.start()` (and marks)
// before `app.listen`, so no request can arrive first. Pinned as a refusal
// rather than left to a coincidence: an unset state must not read as ready.
// ---------------------------------------------------------------------------

describe('peer readiness — before discovery is entered', () => {
  it('is not ready before either mark, even with the window long past', () => {
    vi.advanceTimersByTime(DISCOVERY_WINDOW_MS * 10);
    expect(isPeerReady()).toBe(false);
  });

  it('is ready before either mark once a peer is Active', () => {
    // The peer clause does not depend on the timer at all.
    setNet(fakeNet(['12D3KooWpeer1']));
    expect(isPeerReady()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No net at all
// ---------------------------------------------------------------------------

describe('peer readiness — no net instance', () => {
  it('falls back to the window when net is absent', () => {
    // `getNet()` is null only before `setNet`. Reading a peer count off null
    // must not throw inside an HTTP handler.
    setNet(null as unknown as NetNode);
    markDiscoveryStarted();
    expect(isPeerReady()).toBe(false);
    vi.advanceTimersByTime(DISCOVERY_WINDOW_MS);
    expect(isPeerReady()).toBe(true);
  });
});
