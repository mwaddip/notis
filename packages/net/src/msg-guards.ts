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
 * Advertised heights drive serve loops that walk the chain height by height, so
 * an unbounded — or negative — value turns a single packet into a multi-second
 * synchronous DB scan. 100M blocks is ~190 years at one block per minute: far
 * beyond any real chain, far below anything that costs us a loop.
 */
export const MAX_ADVERTISED_HEIGHT = 100_000_000;

/** Largest value for a uint32 wire field (session magic). */
export const MAX_UINT32 = 0xffff_ffff;

/** Largest protocol version / capability code accepted in a handshake. */
export const MAX_CAPABILITY_CODE = 65_535;

// ---------------------------------------------------------------------------
// Resource limits (untrusted counts and sizes)
//
// Shape checks alone are not enough: a body where every element is well-formed
// can still be arbitrarily long, and an element-wise loop over it is exactly the
// work an attacker wants to buy with one packet.
// ---------------------------------------------------------------------------

/**
 * Largest `ids` / `anchors` / `modifiers` array accepted from a peer.
 *
 * 400 is the send-side batch cap (NET_INTERFACE → Inv: "max 400 per batch"). The
 * same number bounds what a peer may send *us* — the cap has to be enforced on
 * receipt, since an attacker has no reason to honour the one we apply to
 * ourselves. Over-cap arrays are dropped and the sender penalized.
 */
export const MAX_INV_IDS = 400;

/**
 * Largest `peers` array accepted in a Peers response.
 *
 * 64 is the contract cap (NET_INTERFACE → Peers: "Max 64 entries per
 * response"). We only ever serve 8, but the cap has to be enforced on receipt —
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
 * Largest anchor count accepted in a SyncInfo body.
 *
 * The locator is `[tip, tip-16, tip-128, tip-512]` — four entries, fewer if
 * the chain is shorter. Zero is legal (genesis-height chain).
 */
export const MAX_SYNC_ANCHORS = 4;

/**
 * Largest number of items in a `Headers` (15) or `Blocks` (17) response —
 * enforced on BOTH sides.
 *
 * 400 is the same batch cap `MAX_INV_IDS` carries for the inventory messages
 * (NET_INTERFACE → Inv), and the two responses these codes serve are the same
 * kind of thing: a bounded continuation of the chain. Fork resolution is their
 * only caller and it asks for at most `MAX_REORG_DEPTH * 2` (40) headers and
 * the blocks above the fork point, so the cap is an order of magnitude above
 * any honest request.
 *
 * **Receive side.** The count is a `vlqU` the peer chooses, and the decoder
 * allocates per item, so it is checked before the first element is read — a
 * four-byte count claiming millions of blocks must cost the reader nothing.
 * The effective cap is the smaller of this and *what the caller asked for*:
 * a peer answering a 40-header request with 18,900 headers is not answering
 * the question, and the caller is the only party that knows the question.
 *
 * **Serve side.** The same number bounds what we build. Both serve loops read
 * the store once per height into an in-memory array, and `maxCount` /
 * `endHeight` are peer-chosen (bounded only by `MAX_ADVERTISED_HEIGHT` and our
 * own tip), so without this the response size is a peer-controlled knob over
 * our whole chain.
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


