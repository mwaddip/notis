import { getNet } from './net-instance.js';

/**
 * The clock the window is measured on.
 *
 * **Monotonic, not wall-clock, and the window's position is why.** It is armed
 * from `net.start()`'s return and runs 45 seconds — entirely inside the first
 * minute after boot, which is exactly when an undisciplined clock gets stepped:
 * a fresh VM syncing NTP, a resumed container, a Pi with no RTC.
 *
 * Under `Date.now()` a backward step larger than the remainder means the
 * subtraction never reaches the window, so a node with no Active peer withholds
 * templates **for ever** — and says nothing, because 404 is also the ordinary
 * absent-template answer and `miner.mjs` retries it with no give-up count. A
 * forward step opens the gate on the first poll with zero peers, which is the
 * stranding the gate exists to prevent.
 *
 * Nothing here is persisted or compared across processes, so a value that only
 * means something within this process costs nothing.
 */
const now = (): number => performance.now();

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
 * `unavailable` means the node is the origin of its own network by
 * configuration: no bootstrap address, so it never dials and no window can
 * stand for an event that cannot occur.
 */
type Discovery =
  | { readonly kind: 'searching'; readonly startedAtMs: number }
  | { readonly kind: 'unavailable' };

let discovery: Discovery | null = null;

/**
 * Whether a peer has been Active since the window was last armed. The
 * transition this records — *had a peer, has none* — is what re-arms it below.
 *
 * **The two halves are learned differently, and neither choice is free.** A
 * peer arriving is an event: `net.onPeerActive` fires on handshake completion,
 * on both the inbound and the outbound path, so `notePeerMet` cannot miss one.
 * A peer *leaving* has no counterpart to subscribe to — net's `peer:disconnect`
 * listener removes the peer and notifies the sync machine internally, and
 * nothing is exported for a consumer to hook — so the drop is noticed by
 * `isPeerReady` looking, which is what it already does.
 *
 * Driving the arrival half from the event rather than from the poll is what
 * closes the gap a purely-polled version leaves: a node whose miner is not
 * asking observes nothing, so a peer that arrived and left between two polls
 * would look like a peer that never existed, and the node would inherit a
 * window that ran down while nobody was watching.
 */
let sawPeer = false;

/**
 * Record that a peer completed the handshake. Wired to `net.onPeerActive` in
 * `index.ts`; also set by `isPeerReady` when it finds one, so a caller driving
 * readiness without an event source still observes arrivals.
 */
export function notePeerMet(): void {
  sawPeer = true;
}

/**
 * Enter the discovery window. Called once, after `net.start()` returns, on a
 * node that has at least one bootstrap address.
 *
 * Marked from `net.start()`'s return rather than from process start so the
 * window bounds *dial* time and not store opening, AVL bootstrap or genesis
 * seeding — all of which precede it and none of which look for a peer.
 */
export function markDiscoveryStarted(): void {
  discovery = { kind: 'searching', startedAtMs: now() };
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
 * Enter discovery, by the one rule both outcomes of `net.start()` answer to.
 *
 * **The question is what this node was configured to be, not whether net came
 * up.** A bootstrap address means it is joining somebody else's network and has
 * something to wait for; no bootstrap address means it is the origin of its own
 * and never dials. `unavailable` is the verdict reserved for the second, and it
 * makes `isPeerReady` answer true unconditionally — so a node that failed to
 * start *with bootstrap peers configured* must not receive it, or the gate opens
 * with zero Active peers on the node that most needs it shut.
 *
 * One function for both paths rather than the same test written twice: a caller
 * that reaches this from a `catch` is answering the same question as one
 * reaching it from a return.
 */
export function enterDiscovery(bootstrapPeerCount: number): void {
  if (bootstrapPeerCount > 0) {
    markDiscoveryStarted();
    return;
  }
  console.log('No bootstrap peers configured — mining without waiting for a mesh');
  markDiscoveryUnavailable();
}

/**
 * Whether the node has met its peers, or has finished looking.
 *
 * Gates template *serving* (`MINING_INTERFACE` → "The peer-readiness gate"). The
 * bound it protects is journal retention: `block-apply.ts` purges journals below
 * `height - MAX_REORG_DEPTH`, so a node that mines past that depth alone has no
 * journal to revert and can never rejoin a mesh it later meets.
 *
 * **Readiness is not latched** (`MINING_INTERFACE` → "The peer-readiness gate"),
 * and the window is what carries that rather than the peer clause alone. A
 * standing "the window elapsed once" would answer for the rest of the process's
 * life, so a node that meets peers, syncs, and then loses every one of them —
 * upstream down, every peer past `penaltyScoreThreshold`, bootstrap host rotated
 * — would keep serving templates, mine past `height - MAX_REORG_DEPTH`, have its
 * journals purged, and be unable to revert far enough to rejoin. That is the
 * stranding this gate exists to prevent, reached through the gate's own success
 * path.
 *
 * So losing the last peer re-arms the window: it is a fresh reason to look, and
 * the timer means *"I have finished looking"* rather than *"time has passed"*.
 * A node that never met anyone is untouched — it has nothing to lose, its window
 * runs down once, and it mines alone as before.
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
  if (net && net.getConnectedPeers().length > 0) {
    sawPeer = true;
    return true;
  }

  if (sawPeer) {
    sawPeer = false;
    // Only a searching node re-arms. `unavailable` is a statement about
    // configuration, not about a peer count — such a node is the origin of its
    // network, and an inbound visitor arriving and leaving does not make it
    // something else. Re-arming there would stall every `pnpm dev` single node
    // that anyone ever connected to.
    if (discovery?.kind === 'searching') {
      discovery = { kind: 'searching', startedAtMs: now() };
    }
  }

  if (discovery === null) return false;
  if (discovery.kind === 'unavailable') return true;
  return now() - discovery.startedAtMs >= DISCOVERY_WINDOW_MS;
}

/** Test seam: drop the recorded discovery state. */
export function resetPeerReadiness(): void {
  discovery = null;
  sawPeer = false;
}
