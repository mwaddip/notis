import {
  ByteWriter,
  decodeOrderingBlock,
  decodeTxPacket,
  encodeOrderingBlock,
  encodeTxPacket,
  hash32,
  MAX_ORDERING_BLOCK_BYTES,
  MAX_TX_PACKET_BYTES,
  protocolVersionAt,
  writeLpUtf8,
} from '@dagsocial/types';
import type { OrderingBlock, UtxoTransaction, BlockHeader, ProtocolEra } from '@dagsocial/types';
import { TopicValidatorResult } from '@libp2p/interface';
import type { PubSub } from '@libp2p/interface';
import type { GossipsubEvents } from '@chainsafe/libp2p-gossipsub';
import { PenaltyKind } from './types.js';
import type { NetValidators } from './types.js';
import type { PeerManager } from './peer-mgr.js';

// ---------------------------------------------------------------------------
// Minimal interface capturing what gossip.ts needs from a libp2p node.
// The full Libp2p<T> type has `services: T` defaulting to `Record<string,
// unknown>`, so we cannot access `.pubsub` without a type parameter or cast.
// This interface documents the contract: the caller must pass a libp2p node
// whose `services.pubsub` has been configured with gossipsub.
// ---------------------------------------------------------------------------

export interface Libp2pGossip {
  services: {
    pubsub: PubSub<GossipsubEvents>;
  };
}

// ---------------------------------------------------------------------------
// Topic strings and message id — NET_INTERFACE → Gossip Topics
// ---------------------------------------------------------------------------

export interface GossipTopics {
  readonly orderingBlock: string;
  readonly tx: string;
}

/**
 * NET_INTERFACE → Gossip Topics → "A topic is named for its network".
 *
 * The pair a node of this magic hears: the ordering-block topic and the tx
 * topic, each carrying the magic as eight lowercase hex digits. Throws when
 * `magic` is not an unsigned 32-bit integer — a node with no network does not
 * start on a topic of its own (`NET_INTERFACE → Config`).
 */
export function gossipTopics(magic: number): GossipTopics {
  if (!Number.isInteger(magic) || magic < 0 || magic > 0xffffffff) {
    throw new Error(`gossipTopics: magic must be an unsigned 32-bit integer, got ${magic}`);
  }
  const hex = magic.toString(16).padStart(8, '0');
  return {
    orderingBlock: `/dagsocial/${hex}/ordering-block/1`,
    tx: `/dagsocial/${hex}/tx/1`,
  };
}

// Tracked reservation (TYPES_INTERFACE → Tracked reservations, condition 3):
// the topic name `subblock` (NET_INTERFACE → Gossip Topics).

/**
 * NET_INTERFACE → Gossip Topics → "A message is heard once in a seen window".
 *
 * The router keeps every id it has named for two minutes and records it before
 * the topic validator runs; a second copy inside the window is not validated,
 * not delivered and not forwarded (`CONSTANTS → net`).
 */
export const GOSSIP_SEEN_WINDOW_MS = 120_000;

/**
 * NET_INTERFACE → Gossip Topics → "A message is named by its bytes".
 *
 * `hash32(lpUtf8(topic) ‖ data)` — the protocol hash
 * (`TYPES_INTERFACE → The protocol hash`) over the topic string,
 * length-prefixed, and the payload. The router's id function, for a message this
 * node publishes as for one it receives.
 */
export function gossipMessageId(topic: string, data: Uint8Array): Uint8Array {
  const w = new ByteWriter();
  writeLpUtf8(w, topic);
  return hash32(w.toBytes(), data);
}

// ---------------------------------------------------------------------------
// Relay-path membership gate (NODE_INTERFACE → Post transactions)
// ---------------------------------------------------------------------------

/**
 * The relay-path gate that replaces post PoW: **does this author hold karma at
 * all** (NODE_INTERFACE → Post transactions).
 *
 * A `ReadonlySet` and nothing more, because the whole point is that the check is
 * `Set.has()` — 0.023 µs against the 73.2 µs Ed25519 verify it sits beside, so
 * the relay path is ~2 % cheaper than it was with PoW. Net never writes it; node
 * owns the membership and moves it on exactly two events, an identity first
 * receiving karma and its balance reaching zero. Neither is on a hot path, which
 * is what makes a cached set legitimate where a store read would not be.
 *
 * ⛔ **Membership, not balance.** Whether the author can *afford* this post is
 * stateful consensus and belongs to the UTXO engine at mempool admission. This
 * gate exists only to make an unfunded flood cheap to drop before the signature
 * check, exactly as PoW did — and it is strictly weaker than the stateful check
 * downstream, never a substitute for it.
 */
export type KarmaMembers = ReadonlySet<string>;

// ---------------------------------------------------------------------------
// Handlers registered by node
// ---------------------------------------------------------------------------

export interface GossipHandlers {
  /**
   * `fromPeerId` is the peer that **relayed** this block to us
   * (`propagationSource`), not the peer that published it. Fork resolution asks
   * that peer for the competing chain, because it provably holds one — see the
   * listener below for why `propagationSource` is the value handed on.
   */
  onOrderingBlock: (block: OrderingBlock, fromPeerId: string) => void;
  onTx: (tx: UtxoTransaction, content: string | undefined, fromPeerId: string) => void;
}

// ---------------------------------------------------------------------------
// Subscribe
// ---------------------------------------------------------------------------

export function subscribeTopics(
  libp2p: Libp2pGossip,
  validators: NetValidators,
  peerMgr: PeerManager,
  handlers: GossipHandlers,
  topics: GossipTopics,
  karmaMembers: KarmaMembers,
  // The profile's era table and the sync store's tip read. The block validator
  // keys the era on each header's own height; the tx validator on the next
  // block's, chainHeight() + 1 (NET_INTERFACE → Stage 1).
  schedule: readonly ProtocolEra[],
  chainHeight: () => number,
  // NET_INTERFACE → Consensus parameters net enforces
  floorBits: number,
  scheduledTargetBits: (header: BlockHeader) => number | null,
  // NET_INTERFACE → Sync Handler Registration → setHeaderStandingProvider
  // (NET_INTERFACE → Stage 1 → "A header this node knows is Ignored"). A
  // provider that is not passed is read as `() => null`, every header judged
  // as one this node does not know. The leading `_` marks it reserved by the
  // signature pending the block validator's standing check.
  _headerStanding: (hash: string, height: number) => 'held' | 'refused' | null = () => null,
  // The clock the memory of accepted headers reads
  // (NET_INTERFACE → Stage 1 → "A header this node knows is Ignored"). Tests
  // drive it; production reads `Date.now()`. Reserved as `_headerStanding`.
  _nowMs: () => number = Date.now,
): void {
  const gs = libp2p.services.pubsub;

  // -------------------------------------------------------------------------
  // Topic validators — run BEFORE forwarding to mesh peers.  Invalid
  // messages are rejected at this layer and never propagated further.
  // -------------------------------------------------------------------------

  gs.topicValidators.set(topics.orderingBlock, (_peer, msg) => {
    try {
      const raw = new Uint8Array(msg.data);
      // NET_INTERFACE → Validation (and untrusted-input safety) →
      // "A peer's bytes are weighed before they are decoded"
      if (raw.length > MAX_ORDERING_BLOCK_BYTES) {
        peerMgr.recordPenaltyKind(
          PenaltyKind.ProtocolViolation,
          _peer.toString(),
          `ordering block ${raw.length} bytes exceeds MAX_ORDERING_BLOCK_BYTES (${MAX_ORDERING_BLOCK_BYTES})`,
        );
        return TopicValidatorResult.Reject;
      }
      const block = decodeOrderingBlock(raw);
      const vr = validators.verifyOrderingBlockStructure(block);
      if (!vr.valid) {
        // Bogus — well-formed message with invalid content.
        peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, vr.error ?? 'invalid ordering block');
        return TopicValidatorResult.Reject;
      }
      if (!validators.verifyProtocolVersion(block.header.protocolVersion, block.header.height, schedule)) {
        // A declared version that is not the era at the header's height is a
        // compatibility signal, never a violation (NET_INTERFACE → Peer Penalty
        // System): Transient, not misbehavior.
        const era = protocolVersionAt(schedule, block.header.height);
        peerMgr.recordPenaltyKind(
          PenaltyKind.Transient,
          _peer.toString(),
          `protocol version ${block.header.protocolVersion} != era ${era} at height ${block.header.height}`,
        );
        return TopicValidatorResult.Reject;
      }
      // No explicit height guard here, and adding one would be dead code:
      // `verifyOrderingBlockStructure` above covers the header's whole
      // encodable domain, and its `height` rule is `isU64Safe` (audit M-6), so
      // NaN and floats are already rejected one gate earlier — for every input,
      // not merely the NaN/1.5 cases the test below pins.

      // NET_INTERFACE → Consensus parameters net enforces
      if (block.header.powTargetBits < floorBits) {
        peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, 'ordering block below the network floor');
        return TopicValidatorResult.Reject;
      }
      if (!validators.verifyOrderingBlockPoW(block.header)) {
        // A zero-work block must die at the first hop, not be re-gossiped
        // mesh-wide (NET_INTERFACE → Stage 1).
        peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, 'ordering block PoW invalid');
        return TopicValidatorResult.Reject;
      }
      // NET_INTERFACE → Stage 1 →
      // "A worked header is forwarded with the body its root commits".
      // After the PoW check because this predicate hashes the whole body
      // (VALIDATION_INTERFACE → verifyUtxoTxRoot, its cost): a header must
      // have proven work before a node pays to hash its body.
      if (!validators.verifyUtxoTxRoot(block)) {
        peerMgr.recordPenalty(
          'misbehavior',
          _peer.toString(),
          100,
          'ordering block body is not the one the header\'s root commits',
        );
        return TopicValidatorResult.Reject;
      }
      // NET_INTERFACE → Stage 1 →
      // "A scheduled-target mismatch is refused, never forwarded, and never penalised"
      const expected = scheduledTargetBits(block.header);
      if (expected !== null && block.header.powTargetBits !== expected) {
        console.log(
          `[net] scheduled-target mismatch: height=${block.header.height} bits=${block.header.powTargetBits} expected=${expected}`,
        );
        return TopicValidatorResult.Reject;
      }
      return TopicValidatorResult.Accept;
    } catch (err) {
      // Malformed — cannot even decode. Permanent ban.
      peerMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, _peer.toString(), `malformed ordering block: ${String(err)}`);
      return TopicValidatorResult.Reject;
    }
  });

  gs.topicValidators.set(topics.tx, (_peer, msg) => {
    try {
      const raw = new Uint8Array(msg.data);
      // NET_INTERFACE → Validation (and untrusted-input safety) →
      // "A peer's bytes are weighed before they are decoded"
      if (raw.length > MAX_TX_PACKET_BYTES) {
        peerMgr.recordPenaltyKind(
          PenaltyKind.ProtocolViolation,
          _peer.toString(),
          `tx packet ${raw.length} bytes exceeds MAX_TX_PACKET_BYTES (${MAX_TX_PACKET_BYTES})`,
        );
        return TopicValidatorResult.Reject;
      }
      const packet = decodeTxPacket(raw);
      const { tx, content } = packet;
      const vr = validators.verifyTxStructure(tx);
      if (!vr.valid) {
        peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, vr.error ?? 'invalid tx');
        return TopicValidatorResult.Reject;
      }
      if (!validators.verifyTxProtocolVersion(tx, chainHeight() + 1, schedule)) {
        // The envelope's and the commit's declared version each equal the era
        // of the next block this node would apply; a mismatch is a compatibility
        // signal, Transient not misbehavior (NET_INTERFACE → Peer Penalty System).
        const era = protocolVersionAt(schedule, chainHeight() + 1);
        const declared = tx.post !== undefined
          ? `tx ${tx.protocolVersion}/commit ${tx.post.protocolVersion}`
          : `tx ${tx.protocolVersion}`;
        peerMgr.recordPenaltyKind(
          PenaltyKind.Transient,
          _peer.toString(),
          `protocol version ${declared} != era ${era}`,
        );
        return TopicValidatorResult.Reject;
      }
      // NET_INTERFACE → Gossip Topics: tx.post present ⟺ content present
      const hasPost = tx.post !== undefined;
      const hasContent = content !== undefined;
      if (hasPost !== hasContent) {
        peerMgr.recordPenalty('misbehavior', _peer.toString(), 100,
          hasPost ? 'post without body' : 'body without post');
        return TopicValidatorResult.Reject;
      }
      if (hasPost && hasContent) {
        const bv = validators.verifyPostBody(content, tx.post!.contentHash);
        if (!bv.valid) {
          peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, bv.error ?? 'post body verification failed');
          return TopicValidatorResult.Reject;
        }
      }
      // The post relay gate — see `KarmaMembers`. It runs only for a
      // post-bearing transaction and only after `verifyTxStructure`.
      //
      // ⚠ What makes the hex-encode safe on THIS path is the decoder, not that
      // check. `author` is `b32`, read as `readBytesN(r, 32)`, so
      // `decodeTxPacket` above cannot produce any other width — and it is the
      // only producer of the object this closure sees. `verifyTxStructure`'s own
      // 32-byte pin is depth rather than enforcement here; it is left in place
      // because it is what a caller reaching this gate without a decode would
      // land on, and that failure would otherwise be silent.
      //
      // ⚠ **Before any store read, and before the signature check**, which is the
      // whole reason it is a set: an unfunded flood costs one hash lookup, not
      // 73 µs of Ed25519 per message.
      if (tx.post !== undefined) {
        const author = Buffer.from(tx.post.author).toString('hex');
        if (!karmaMembers.has(author)) {
          peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, 'post author holds no karma');
          return TopicValidatorResult.Reject;
        }
      }
      return TopicValidatorResult.Accept;
    } catch (err) {
      peerMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, _peer.toString(), `malformed tx: ${String(err)}`);
      return TopicValidatorResult.Reject;
    }
  });

  // -------------------------------------------------------------------------
  // Event listener — delivers every message the router hands on
  // (NET_INTERFACE → Inbound Processing →
  // "A gossip message that passes Stage 1 is delivered, whichever peer carried it").
  // Topic validators (above) are the only gate before this point.
  // -------------------------------------------------------------------------

  gs.addEventListener('gossipsub:message', (evt) => {
    const { detail } = evt;
    if (!detail?.msg) return;

    const { topic } = detail.msg;
    const raw = new Uint8Array(detail.msg.data);

    // The peer that sent this message to *us* — the carrier — is handed on as
    // the relay source (NET_INTERFACE → Pull Requests): `propagationSource` is by
    // construction the peer we received it from, so it is the one that provably
    // holds the chain a competing block belongs to.
    //
    // Read defensively: the field is required by gossipsub's own type, so an
    // event without it is a broken event rather than a peer's doing, and no
    // method here panics on one. The empty string is not a peer id, so a
    // consumer testing membership in its connected set falls back exactly as it
    // does for a source that has since disconnected
    // (NET_INTERFACE → Inbound Processing →
    // "`fromPeerId` is not guaranteed to be a peer id").
    const relayPeerId =
      (detail as { propagationSource?: { toString(): string } }).propagationSource?.toString() ?? '';

    // Decode and dispatch are separated because they fail for different
    // reasons, and neither reason is the peer's.
    //
    // A single `try` spanning both would report neither: it would collapse a
    // validator bug and an app-layer handler throw into one silent span.
    //
    // Both stay contained rather than propagating: this is a gossipsub event
    // listener, and net's invariant is that one bad message degrades one
    // message, not the subsystem. Contained is not the same as silent — both
    // are `console.error`, because reaching either is a bug in our own code.
    const deliver = <T>(decode: (b: Uint8Array) => T, handle: (v: T) => void): void => {
      let value: T;
      try {
        value = decode(raw);
      } catch (err) {
        // Unreachable unless a topic validator is wrong: every message that
        // gets here was already decoded once, by the validator that accepted
        // it. So this is our bug and not the sender's — no penalty is
        // recorded, and it is logged loudly rather than absorbed.
        console.error(
          `[net] BUG: '${topic}' message passed its topic validator and then failed to decode: ${String(err)}`,
        );
        return;
      }
      try {
        handle(value);
      } catch (err) {
        console.error(`[net] handler for '${topic}' threw: ${String(err)}`);
      }
    };

    if (topic === topics.orderingBlock) {
      deliver(decodeOrderingBlock, (block) => handlers.onOrderingBlock(block, relayPeerId));
    } else if (topic === topics.tx) {
      deliver(decodeTxPacket, (packet) => handlers.onTx(packet.tx, packet.content, relayPeerId));
    }
  });

  // Subscribe to both topics
  gs.subscribe(topics.orderingBlock);
  gs.subscribe(topics.tx);
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

export async function broadcastOrderingBlock(
  libp2p: Libp2pGossip,
  topics: GossipTopics,
  block: OrderingBlock,
): Promise<void> {
  const data = encodeOrderingBlock(block);
  await libp2p.services.pubsub.publish(topics.orderingBlock, data);
}

export async function broadcastTx(
  libp2p: Libp2pGossip,
  topics: GossipTopics,
  tx: UtxoTransaction,
  content?: string,
): Promise<void> {
  const data = encodeTxPacket(tx, content);
  await libp2p.services.pubsub.publish(topics.tx, data);
}
