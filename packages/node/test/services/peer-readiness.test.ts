import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DISCOVERY_WINDOW_MS,
  enterDiscovery,
  isPeerReady,
  markDiscoveryStarted,
  markDiscoveryUnavailable,
  notePeerMet,
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

/**
 * A peer completing the handshake, the way production reaches readiness: net
 * fires `onPeerActive`, which `index.ts` wires to `notePeerMet`, and the peer is
 * on the Active list from then on. Using this rather than `setNet` alone is what
 * keeps these cases independent of whether anything happened to poll while the
 * peer was up.
 */
function peerArrives(ids: string[]): void {
  setNet(fakeNet(ids));
  notePeerMet();
}

beforeEach(() => {
  resetPeerReadiness();
  setNet(fakeNet([]));
  // ⚠ **`performance` is not in vitest's default `toFake` list, and the window
  // is measured on `performance.now()`.** Left out, `advanceTimersByTime` moves
  // the fake `Date` while the window reads a real monotonic clock, so every
  // interval assertion below silently measures nothing.
  vi.useFakeTimers({
    toFake: [
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
      'setImmediate', 'clearImmediate', 'Date', 'performance',
    ],
  });
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

  it('stays ready after the window on a node that never met anyone', () => {
    // Scoped to a node with no peer to lose. It is **not** the general claim
    // that readiness survives the window — the un-latch cases below pin the
    // opposite for a node that did meet one, and `MINING_INTERFACE` → "The
    // peer-readiness gate" states readiness is not latched.
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
// Entering discovery — the decision `index.ts` makes on both outcomes of
// `net.start()`. What it keys on is the node's configuration, never whether net
// came up: `unavailable` says "I am the origin of my network", which is a claim
// a node with bootstrap addresses may not make however badly its startup went.
// ---------------------------------------------------------------------------

describe('peer readiness — entering discovery', () => {
  it('waits out the window when a bootstrap address is configured', () => {
    enterDiscovery(1);
    expect(isPeerReady()).toBe(false);
    vi.advanceTimersByTime(DISCOVERY_WINDOW_MS);
    expect(isPeerReady()).toBe(true);
  });

  it('is ready at once with no bootstrap address', () => {
    enterDiscovery(0);
    expect(isPeerReady()).toBe(true);
  });

  it('still waits with bootstrap addresses when net failed to start', () => {
    // The `catch` case, and the one that was wrong: a node whose `net.start()`
    // threw *with three bootstrap peers configured* was handed the verdict
    // reserved for a node with nothing to dial, so the gate opened with zero
    // Active peers and it mined alone past MAX_REORG_DEPTH. Net's state is not
    // an input here — three configured peers is three configured peers.
    setNet(null as unknown as NetNode);
    enterDiscovery(3);
    expect(isPeerReady()).toBe(false);
  });

  it('is ready at once when net failed to start and there was nothing to dial', () => {
    // The control: same failure, no bootstrap address. This node genuinely is
    // the origin of its network, and waiting would stand in for a dial it was
    // never going to make.
    setNet(null as unknown as NetNode);
    enterDiscovery(0);
    expect(isPeerReady()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Readiness is not latched (MINING_INTERFACE → "The peer-readiness gate").
//
// The stranding this gate exists to prevent is reachable through its own
// success path: a node meets peers, syncs, then loses every one of them, and a
// standing "the window elapsed once" keeps it serving templates while it mines
// past `height - MAX_REORG_DEPTH` and purges the journals it would need to
// rejoin. Losing the last peer is a fresh reason to look, so the window re-arms.
// ---------------------------------------------------------------------------

describe('peer readiness — losing every peer', () => {
  it('withholds again when the last peer drops after the window elapsed', () => {
    markDiscoveryStarted();
    setNet(fakeNet(['12D3KooWpeer1']));
    expect(isPeerReady()).toBe(true);

    // Long past the window — this is exactly where the latch used to answer
    // "ready" for the rest of the process's life.
    vi.advanceTimersByTime(DISCOVERY_WINDOW_MS * 10);
    expect(isPeerReady()).toBe(true);

    setNet(fakeNet([]));
    expect(isPeerReady()).toBe(false);
  });

  it('withholds again when the last peer drops before the window elapses', () => {
    markDiscoveryStarted();
    setNet(fakeNet(['12D3KooWpeer1']));
    expect(isPeerReady()).toBe(true);

    setNet(fakeNet([]));
    expect(isPeerReady()).toBe(false);
  });

  it('re-arms the whole window rather than resuming the original one', () => {
    // The re-armed window is a fresh 45s, not the remainder of the first: what
    // it has to outlast is net's 30s re-dial tick, and a remainder can be
    // shorter than that.
    markDiscoveryStarted();
    peerArrives(['12D3KooWpeer1']);
    vi.advanceTimersByTime(DISCOVERY_WINDOW_MS * 10);

    setNet(fakeNet([]));
    expect(isPeerReady()).toBe(false);

    vi.advanceTimersByTime(DISCOVERY_WINDOW_MS - 1);
    expect(isPeerReady()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(isPeerReady()).toBe(true);
  });

  it('a peer returning inside the re-armed window answers immediately', () => {
    markDiscoveryStarted();
    peerArrives(['12D3KooWpeer1']);
    vi.advanceTimersByTime(DISCOVERY_WINDOW_MS * 10);
    setNet(fakeNet([]));
    expect(isPeerReady()).toBe(false);

    // net's re-dial tick landing is the outcome the re-armed window exists to
    // wait for.
    vi.advanceTimersByTime(30_000);
    setNet(fakeNet(['12D3KooWpeer2']));
    expect(isPeerReady()).toBe(true);
  });

  it('a peer that arrived and left between two polls still re-arms the window', () => {
    // The hole a purely-polled `sawPeer` leaves. Nothing calls `isPeerReady`
    // while the peer is up — a node whose miner is not asking — so the arrival
    // is known only from `net.onPeerActive`. Without the event half, this node
    // reads as one that never met anybody and mines straight on.
    markDiscoveryStarted();
    vi.advanceTimersByTime(DISCOVERY_WINDOW_MS);

    notePeerMet();      // net fired onPeerActive
    setNet(fakeNet([])); // and the peer was gone again before anything polled

    expect(isPeerReady()).toBe(false);
  });

  it('a poll that finds a peer records the arrival too', () => {
    // The event is the reliable half, not the only one: readiness driven
    // without an event source must still notice the peer it is looking at.
    markDiscoveryStarted();
    setNet(fakeNet(['12D3KooWpeer1']));
    expect(isPeerReady()).toBe(true);

    vi.advanceTimersByTime(DISCOVERY_WINDOW_MS * 10);
    setNet(fakeNet([]));
    expect(isPeerReady()).toBe(false);
  });

  it('re-arms on the first call after a gap in polling, not on a missed transition', () => {
    // Readiness learns that a peer left by looking — `net` publishes
    // `onPeerActive` and no disconnect counterpart — so the drop has to survive
    // a miner that stopped asking. A node that saw a peer, went quiet for ten
    // minutes and comes back alone must withhold, not inherit a window that ran
    // down while nobody was watching.
    markDiscoveryStarted();
    setNet(fakeNet(['12D3KooWpeer1']));
    expect(isPeerReady()).toBe(true);

    setNet(fakeNet([]));
    vi.advanceTimersByTime(10 * 60_000); // nothing polls across this gap
    expect(isPeerReady()).toBe(false);
  });

  it('re-arms once per drop, not on every poll while alone', () => {
    // Otherwise the window never runs down and a node whose peers are genuinely
    // gone withholds for ever, which is the opposite failure.
    markDiscoveryStarted();
    setNet(fakeNet(['12D3KooWpeer1']));
    expect(isPeerReady()).toBe(true);
    setNet(fakeNet([]));

    for (let elapsed = 0; elapsed < DISCOVERY_WINDOW_MS; elapsed += 1_000) {
      expect(isPeerReady()).toBe(false);
      vi.advanceTimersByTime(1_000);
    }
    expect(isPeerReady()).toBe(true);
  });

  it('a flapping peer withholds while it is down and serves while it is up', () => {
    markDiscoveryStarted();
    for (let i = 0; i < 3; i++) {
      setNet(fakeNet([`12D3KooWpeer${i}`]));
      expect(isPeerReady()).toBe(true);
      setNet(fakeNet([]));
      expect(isPeerReady()).toBe(false);
      vi.advanceTimersByTime(5_000);
    }
  });

  it('an unhandshaken peer arriving and leaving does not re-arm anything', () => {
    // The peer clause counts Active peers only, so a wrong-network peer never
    // makes `sawPeer` true and its departure is not a drop.
    markDiscoveryStarted();
    vi.advanceTimersByTime(DISCOVERY_WINDOW_MS);
    expect(isPeerReady()).toBe(true);

    setNet({
      getConnectedPeers: () => [],
      peers: () => [{ id: 'wrong-network-peer', multiaddrs: [], protocols: [], connectedAt: 0 }],
    } as unknown as NetNode);
    expect(isPeerReady()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The window survives a stepped wall clock.
//
// It is armed from `net.start()`'s return and runs 45s, so it sits entirely
// inside the first minute after boot — which is when a clock is most likely to
// be stepped: a fresh VM syncing NTP, a resumed container, a Pi with no RTC.
// `vi.setSystemTime` moves the wall clock without moving the monotonic one,
// which is exactly the discrimination these cases need.
// ---------------------------------------------------------------------------

describe('peer readiness — a stepped wall clock', () => {
  it('still closes the window after a large backward step', () => {
    // On `Date.now()` the subtraction never reaches the window again, so a node
    // with no Active peer withholds for ever — and says nothing, because 404 is
    // also the ordinary absent-template answer and `miner.mjs` retries it with
    // no give-up count.
    markDiscoveryStarted();
    vi.setSystemTime(new Date('2026-08-12T00:00:00.000Z')); // a day backwards
    expect(isPeerReady()).toBe(false);

    vi.advanceTimersByTime(DISCOVERY_WINDOW_MS);
    expect(isPeerReady()).toBe(true);
  });

  it('does not open the window early on a forward step', () => {
    // The other direction, and the one that costs the chain: a forward jump
    // would open the gate on the first poll with zero peers, which is the
    // stranding the gate exists to prevent.
    markDiscoveryStarted();
    vi.setSystemTime(new Date('2026-08-14T00:00:00.000Z')); // a day forwards
    expect(isPeerReady()).toBe(false);

    vi.advanceTimersByTime(DISCOVERY_WINDOW_MS - 1);
    expect(isPeerReady()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(isPeerReady()).toBe(true);
  });

  it('measures a re-armed window on the same clock', () => {
    markDiscoveryStarted();
    peerArrives(['12D3KooWpeer1']);
    vi.advanceTimersByTime(DISCOVERY_WINDOW_MS * 2);

    setNet(fakeNet([]));
    expect(isPeerReady()).toBe(false);
    vi.setSystemTime(new Date('2026-08-11T00:00:00.000Z'));
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

  it('an inbound visitor arriving and leaving does not make it wait', () => {
    // `unavailable` states this node's configuration, not its peer count: it is
    // the origin of its network and has no address to dial. Re-arming a window
    // on a departing inbound peer would stall every `pnpm dev` single node that
    // anyone ever connected to, for a dial it will never make.
    markDiscoveryUnavailable();
    setNet(fakeNet(['12D3KooWvisitor']));
    expect(isPeerReady()).toBe(true);

    setNet(fakeNet([]));
    expect(isPeerReady()).toBe(true);
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
