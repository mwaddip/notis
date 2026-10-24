/**
 * Constants and predicates for the stream-message decode boundary.
 *
 * Every stream message body is a positional codec checked by `decodeStruct`'s
 * four-part boundary (TYPES_INTERFACE → The boundary check). Domain bounds —
 * heights, counts, byte caps — throw inside each codec's `read` before any
 * value escapes. These constants and predicates are shared by the codecs and
 * by PeerDb's row admission gate.
 */

/**
 * Largest chain height a peer may advertise.
 *
 * `isHeight()` reads this against every peer-chosen height — the handshake
 * `chainHeight`, `SyncInfo.tipHeight` and the `peerHeight` the scheduler is
 * handed at peer-active. 100M blocks is ~190 years at one block per minute:
 * far beyond any real chain.
 */
export const MAX_ADVERTISED_HEIGHT = 100_000_000;

/** Largest protocol version / capability code accepted in a handshake. */
export const MAX_CAPABILITY_CODE = 65_535;

/**
 * Longest handshake frame the body admits (NET_INTERFACE → Handshake Body →
 * "The longest frame the body admits is `MAX_HANDSHAKE_FRAME_BYTES` (984)").
 * Every field at its bound builds a 972-byte body in a frame 12 bytes longer.
 * It bounds the handshake read (NET_INTERFACE → Handshake →
 * "A connection carries one handshake, opened by the side that dialled it").
 */
export const MAX_HANDSHAKE_FRAME_BYTES = 984;

/**
 * Handshake streams of one connection a listener accepts at once
 * (NET_INTERFACE → Handshake →
 * "A connection carries one handshake, opened by the side that dialled it").
 * An honest dialler opens one on each connection it dialled and none on one
 * it accepted; the registration passes this to libp2p and a stream over the
 * limit is aborted by libp2p before this node reads a byte.
 */
export const MAX_INBOUND_HANDSHAKE_STREAMS = 1;

/**
 * A connection's handshake deadline, in multiples of `syncRequestTimeoutMs`
 * (NET_INTERFACE → Handshake →
 * "A connection handshakes within its deadline, or is closed"). The factor
 * is the dialler's round trip at its longest: the stream's open, the write
 * and the read, each under `syncRequestTimeoutMs`.
 */
export const HANDSHAKE_DEADLINE_FACTOR = 3;

// ---------------------------------------------------------------------------
// Resource limits (untrusted counts and sizes)
//
// Shape checks alone are not enough: a body where every element is well-formed
// can still be arbitrarily long, and an element-wise loop over it is exactly the
// work an attacker wants to buy with one packet.
// ---------------------------------------------------------------------------

/**
 * Largest `ids` / `modifiers` array accepted from a peer.
 *
 * 400 is the send-side batch cap (NET_INTERFACE → ModifierRequest): at
 * most 400 ids per batch. The same number bounds what a peer may send
 * *us* — the cap has to be enforced on receipt, since a hostile sender
 * has no reason to honour the one we apply to ourselves. Over-cap
 * arrays are dropped and the sender penalized.
 */
export const MAX_INV_IDS = 400;

/**
 * Largest `peers` array accepted in a Peers response.
 *
 * 64 is the contract cap (NET_INTERFACE → Peers): at most 64 entries per
 * response. We only ever serve 8, but the cap has to be enforced on receipt —
 * an attacker has no reason to honour the one we apply to ourselves. A body
 * declaring more is a permanent ban of the sender.
 */
export const MAX_PEERS_ENTRIES = 64;

/**
 * Largest `capabilities` array accepted in a handshake or a Peers entry.
 *
 * 64 against a 17-row code table. Without this an 8 MiB frame of capability
 * codes is walked element-wise in the handshake and ×64 in a Peers body.
 */
export const MAX_CAPABILITY_ENTRIES = 64;

/** Largest byte span accepted for `agentName` / `nodeName` in a handshake or Peers entry. */
export const MAX_NAME_BYTES = 255;

/** Largest byte span accepted for `declaredAddress` (handshake) or `address` (Peers entry). */
export const MAX_ADDRESS_BYTES = 255;

/**
 * Largest number of hashes a `GetHeaders` (14) locator carries
 * (NET_INTERFACE → `GetHeaders` / `GetBlocks` responses).
 *
 * The locator is `h₀ = tip, hᵢ₊₁ = hᵢ − 2ⁱ` for as long as `hᵢ₊₁ ≥ 1`,
 * plus height 1 when the sequence did not land on it, so at most
 * `⌊log₂ tip⌋ + 2` entries. A tip below `MAX_ADVERTISED_HEIGHT` (10⁸ < 2²⁷)
 * reaches `26 + 2 = 28`.
 */
export const MAX_LOCATOR_HASHES = 28;

/**
 * Largest number of items in a `Headers` (15) or `Blocks` (17) response —
 * enforced on BOTH sides.
 *
 * 400 is the same batch cap `MAX_INV_IDS` carries for the modifier
 * messages (NET_INTERFACE → ModifierRequest), and the two responses
 * these codes serve are the same kind of thing: a bounded continuation
 * of the chain. The scheduler pages both its header walks and its
 * block fetch at exactly this cap (NET_INTERFACE → Pull Requests).
 *
 * **Receive side.** The count is a `vlqU` the peer chooses, and the decoder
 * allocates per item, so it is checked before the first element is read — a
 * four-byte count claiming millions of blocks must cost the reader nothing.
 * The effective cap is the smaller of this and *what the caller asked for*:
 * a peer answering a 40-header request with 18,900 headers is not answering
 * the question, and the caller is the only party that knows the question.
 *
 * **Serve side.** The same number bounds what we build. The headers loop
 * walks heights above the locator match for at most this many entries,
 * clamped to our tip; the blocks loop reads the request's ids, themselves
 * capped at this count by the codec. Without the cap the response size is a
 * peer-controlled knob over our whole chain.
 */
export const MAX_CHAIN_RESPONSE_ITEMS = 400;

/**
 * Largest number of bytes buffered from a single inbound stream.
 *
 * Stream readers accumulate chunks until the peer closes its side, so without a
 * ceiling a peer that never stops writing is an out-of-memory kill. 8 MiB leaves
 * ample headroom above the largest legitimate message (a `ModifierResponse`
 * batch, bounded below by `MAX_SERVE_BODY_BYTES`) while keeping the worst case
 * per connection bounded.
 */
export const MAX_STREAM_BYTES = 8 * 1024 * 1024;

/**
 * Largest number of inbound sync-protocol streams a single connection may hold
 * open at once (NET_INTERFACE → "A peer's sync streams are served one at a
 * time"). libp2p checks this against the connection's own inbound stream count
 * and aborts a stream over it. A waiting stream is unread, so it costs at most
 * one `YAMUX_STREAM_WINDOW_BYTES` worth of buffered bytes; 16 cost 4 MiB per
 * connection.
 */
export const MAX_INBOUND_SYNC_STREAMS = 16;

/**
 * The size — the initial and the maximum stream window alike, and the receive
 * buffer cap alike — net pins on a yamux stream (NET_INTERFACE → "A peer's
 * sync streams are served one at a time"). yamux refuses an initial below
 * 256 KiB and a maximum below the initial, so 256 KiB is the floor the library
 * admits for the window; the receive buffer cap is pinned to the same bound,
 * so a waiting stream (no reader attached yet) stays at one window's worth of
 * bytes instead of libp2p's 4 MiB default. The window bounds what a reading
 * stream may buffer between drains; the cap bounds a stream before its turn
 * comes. The two together make a peer that stops reading stall the write for
 * the serve deadline rather than the response arriving in a receive buffer
 * before the deadline fires.
 */
export const YAMUX_STREAM_WINDOW_BYTES = 256 * 1024;

/**
 * Shortest interval between two `SyncInfo`s from one peer that this node
 * acts on (NET_INTERFACE → Serve Side → "A peer's `SyncInfo` is acted on at
 * most once per `SYNC_INFO_MIN_INTERVAL_MS`"). A SyncInfo that arrives
 * sooner is held as that peer's pending one; the first timer tick past the
 * interval acts on it.
 */
export const SYNC_INFO_MIN_INTERVAL_MS = 100;

/**
 * NET_INTERFACE → Stall Detection — "A mark clears only when this node
 * enters `synced`, or `STALL_MARK_EXPIRY_MS` after it was set." 30 minutes.
 */
export const STALL_MARK_EXPIRY_MS = 1_800_000;

/**
 * NET_INTERFACE → Stall Detection — stall marks kept by peer id, in a map
 * of at most `MAX_STALL_MARKS` entries, the oldest dropped first.
 */
export const MAX_STALL_MARKS = 1_024;

/**
 * Largest response body we assemble when serving a peer.
 *
 * Kept at half of `MAX_STREAM_BYTES` so a response we produce always fits inside
 * the read cap on the other end, with room for framing overhead. A
 * request whose blocks do not fit is answered partially; the requester re-asks
 * for what is still missing on the next SyncInfo round, so truncating here costs
 * a round trip, never a stuck sync.
 */
export const MAX_SERVE_BODY_BYTES = 4 * 1024 * 1024;

/** True for a plain object — neither null nor an array. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * True for a non-negative integer no greater than `max`.
 *
 * Rejects `NaN`, `Infinity`, fractions, negatives, and bigints.
 * `Number.isInteger` alone lets negatives through.
 */
export function isBoundedInt(v: unknown, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
}

/** True for a height a peer may legitimately advertise. */
export function isHeight(v: unknown): v is number {
  return isBoundedInt(v, MAX_ADVERTISED_HEIGHT);
}

/** True for an array whose every element is a bounded non-negative integer. */
export function isBoundedIntArray(v: unknown, max: number): v is number[] {
  return Array.isArray(v) && v.every((x) => isBoundedInt(x, max));
}


