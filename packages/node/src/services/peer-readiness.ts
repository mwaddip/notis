import { getNet } from './net-instance.js';

/**
 * How long a node keeps looking for peers before it will mine alone.
 *
 * ⚠ **This is a timer, and naming it one is the point.** It stands for "I have
 * finished looking", not for "something is ready" — the state it reports is the
 * *absence* of a peer after a bounded search, which no event can announce.
 *
 * **The duration is derived from net's re-dial cadence, not chosen.** A failed
 * initial bootstrap dial gets its next attempt on the outbound manager's tick,
 * which is 30s (`net/src/node.ts` → the `setInterval` in `start`, measured at
 * 30.02s on a three-node devnet). A window below that gives up before making a
 * second attempt, which on devnet means mining ~180 blocks alone and never being
 * able to rejoin — the precise failure this gate exists to prevent. 45s spans
 * one tick with margin for the dial and handshake, and stops short of a second
 * so a node that is genuinely alone starts inside a minute.
 *
 * Reaching a listening peer takes ~10ms (measured, and it completes inside
 * `net.start()`), so the empirical dial time is not what sizes this. **Shortening
 * net's re-dial cadence is what would let this shrink.**
 *
 * A node-local constant rather than a profile field: `ARCHITECTURE.md` → "The
 * per-network parameter set" scopes profiles to the timescale, difficulty and
 * genesis axes, and on a live network this never fires at all — peers exist, so
 * the peer clause answers first and the duration is never read.
 */
export const DISCOVERY_WINDOW_MS = 45_000;

/**
 * Whether the node has anywhere to look for peers, and since when.
 *
 * `unavailable` covers two cases that share a shape: no bootstrap address is
 * configured, and net failed to start. Neither can produce a dial, so a window
 * measuring dial time would be standing in for an event that cannot occur.
 */
type Discovery =
  | { readonly kind: 'searching'; readonly startedAtMs: number }
  | { readonly kind: 'unavailable' };

let discovery: Discovery | null = null;

/**
 * Enter the discovery window. Called once, after `net.start()` returns, on a
 * node that has at least one bootstrap address.
 *
 * Marked from `net.start()`'s return rather than from process start so the
 * window bounds *dial* time and not store opening, AVL bootstrap or genesis
 * seeding — all of which precede it and none of which look for a peer.
 */
export function markDiscoveryStarted(): void {
  discovery = { kind: 'searching', startedAtMs: Date.now() };
}

/**
 * Record that there is no discovery to wait for.
 *
 * A node with no bootstrap address never dials: the floor phase iterates an
 * empty list, and the fill phase's `pickCandidate` returns null while outbound
 * connections are below `minPeers`, which such a node permanently is — inbound
 * connections do not count toward that floor. It is the origin of its network by
 * configuration, and `pnpm dev` with one node is exactly that node.
 */
export function markDiscoveryUnavailable(): void {
  discovery = { kind: 'unavailable' };
}

/**
 * Whether the node has met its peers, or has finished looking.
 *
 * Gates template *serving* (`MINING_INTERFACE` → "The peer-readiness gate"). The
 * bound it protects is journal retention: `block-apply.ts` purges journals below
 * `height - MAX_REORG_DEPTH`, so a node that mines past that depth alone has no
 * journal to revert and can never rejoin a mesh it later meets.
 */
export function isPeerReady(): boolean {
  // The peer clause answers on its own and does not consult the timer: a node
  // that has met a peer is ready whenever that happened.
  //
  // Active peers only. `peers()` lists every peer holding an open libp2p
  // connection at any state — `addPeer` runs on `peer:connect` and starts them
  // at Connecting — so it counts peers that have not completed, or have failed,
  // the DAGsocial handshake. A peer that failed it is on another network, and
  // must not answer "have I met peers on mine".
  const net = getNet();
  if (net && net.getConnectedPeers().length > 0) return true;

  if (discovery === null) return false;
  if (discovery.kind === 'unavailable') return true;
  return Date.now() - discovery.startedAtMs >= DISCOVERY_WINDOW_MS;
}

/** Test seam: drop the recorded discovery state. */
export function resetPeerReadiness(): void {
  discovery = null;
}
