import {
  ByteWriter,
  decodeOrderingBlock,
  decodeTxPacket,
  decodeUtxoTxTree,
  encodeOrderingBlock,
  encodeTxPacket,
  hash32,
  MAX_ORDERING_BLOCK_BYTES,
  MAX_TX_PACKET_BYTES,
  protocolVersionAt,
  readOrderingBlockSections,
  writeLpUtf8,
} from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import type { OrderingBlock, UtxoTransaction, BlockHeader, ProtocolEra, UtxoTxTree } from '@dagsocial/types';
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

// NET_INTERFACE → Forwarding Rule → "An ordering block is forwarded once Stage 1
// passes; a transaction once this node admits it". gossipsub's
// `reportMessageValidationResult` is not in `PubSub<GossipsubEvents>`, so the
// listener below reads it off the gossipsub router directly.
export interface Libp2pGossip {
  services: {
    pubsub: PubSub<GossipsubEvents> & {
      reportMessageValidationResult(
        msgId: string,
        propagationSource: string,
        acceptance: TopicValidatorResult,
      ): void;
    };
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
  /**
   * NET_INTERFACE → Inbound Processing →
   * "A transaction is forwarded when a handler admits it":
   * the return is whether this node admitted the transaction. The listener
   * reports Accept to the router when it is true and Ignore otherwise.
   */
  onTx: (tx: UtxoTransaction, content: string | undefined, fromPeerId: string) => boolean;
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
  // The header-standing seam `setHeaderStandingProvider` carries
  // (NET_INTERFACE → Sync Handler Registration;
  // NET_INTERFACE → Stage 1 → "A header this node knows is Ignored"). A
  // provider that is not passed is read as `() => null`, every header judged
  // as one this node does not know; net's own memory of accepted headers
  // stands either way.
  headerStanding: (hash: string, height: number) => 'held' | 'refused' | null = () => null,
  // The clock behind the memory of accepted headers
  // (NET_INTERFACE → Stage 1 → "A header this node knows is Ignored"). Tests
  // drive it; production reads `Date.now()`.
  nowMs: () => number = Date.now,
): void {
  const gs = libp2p.services.pubsub;

  // -------------------------------------------------------------------------
  // Topic validators — run BEFORE forwarding to mesh peers.  Invalid
  // messages are rejected at this layer and never propagated further.
  // -------------------------------------------------------------------------

  // NET_INTERFACE → Stage 1 → "A header this node knows is Ignored". The
  // memory holds an accepted header's hash with its acceptance time; a stale
  // entry is pruned at the next Accept so nothing survives past the window.
  const seenAccepted = new Map<string, number>();

  gs.topicValidators.set(topics.orderingBlock, (_peer, msg) => {
    const peerId = _peer.toString();
    const raw = new Uint8Array(msg.data);
    // NET_INTERFACE → Validation (and untrusted-input safety) →
    // "A peer's bytes are weighed before they are decoded"
    if (raw.length > MAX_ORDERING_BLOCK_BYTES) {
      peerMgr.recordPenaltyKind(
        PenaltyKind.ProtocolViolation,
        peerId,
        `ordering block ${raw.length} bytes exceeds MAX_ORDERING_BLOCK_BYTES (${MAX_ORDERING_BLOCK_BYTES})`,
      );
      return TopicValidatorResult.Reject;
    }
    // NET_INTERFACE → Stage 1 → "A header is read before its body".
    // The sections read is the one throw ProtocolViolation covers at this
    // boundary; the body section's own decode runs separately below.
    let sections: ReturnType<typeof readOrderingBlockSections>;
    try {
      sections = readOrderingBlockSections(raw);
    } catch (err) {
      peerMgr.recordPenaltyKind(
        PenaltyKind.ProtocolViolation,
        peerId,
        `malformed ordering block header: ${String(err)}`,
      );
      return TopicValidatorResult.Reject;
    }
    const { header, utxoTxTreeBytes, validatorSignature } = sections;

    // NET_INTERFACE → Stage 1 → "A fault of this node's is no peer's".
    // Everything below is header-only or body-decoded by this function; a
    // throw here is a provider's or this node's chain, logged and Ignored.
    try {
      const domains = validators.verifyHeaderFieldDomains(header);
      if (!domains.valid) {
        peerMgr.recordPenalty('misbehavior', peerId, 100, domains.error ?? 'invalid ordering block header');
        return TopicValidatorResult.Reject;
      }
      if (!validators.verifyProtocolVersion(header.protocolVersion, header.height, schedule)) {
        // NET_INTERFACE → Peer Penalty System: a declared version that is not
        // the era at the header's height is a compatibility signal, Transient.
        const era = protocolVersionAt(schedule, header.height);
        peerMgr.recordPenaltyKind(
          PenaltyKind.Transient,
          peerId,
          `protocol version ${header.protocolVersion} != era ${era} at height ${header.height}`,
        );
        return TopicValidatorResult.Reject;
      }
      // NET_INTERFACE → Consensus parameters net enforces
      if (header.powTargetBits < floorBits) {
        peerMgr.recordPenalty('misbehavior', peerId, 100, 'ordering block below the network floor');
        return TopicValidatorResult.Reject;
      }
      if (!validators.verifyOrderingBlockPoW(header)) {
        // A zero-work block dies at the first hop, not re-gossiped mesh-wide
        // (NET_INTERFACE → Stage 1).
        peerMgr.recordPenalty('misbehavior', peerId, 100, 'ordering block PoW invalid');
        return TopicValidatorResult.Reject;
      }
      // NET_INTERFACE → Stage 1 →
      // "A scheduled-target mismatch is refused, never forwarded, and never penalised"
      const expected = scheduledTargetBits(header);
      if (expected !== null && header.powTargetBits !== expected) {
        console.log(
          `[net] scheduled-target mismatch: height=${header.height} bits=${header.powTargetBits} expected=${expected}`,
        );
        return TopicValidatorResult.Reject;
      }
      // NET_INTERFACE → Stage 1 → "A header this node knows is Ignored"
      const hash = blockHash(header);
      if (hash === null) {
        // `verifyHeaderFieldDomains` above answered valid, so this is this
        // node's own invariant violated — logged, Ignored, no penalty.
        console.error('[net] blockHash null on a header verifyHeaderFieldDomains accepted');
        return TopicValidatorResult.Ignore;
      }
      const standing = headerStanding(hash, header.height);
      if (standing === 'held' || standing === 'refused') {
        return TopicValidatorResult.Ignore;
      }
      const now = nowMs();
      const previous = seenAccepted.get(hash);
      if (previous !== undefined && now - previous < GOSSIP_SEEN_WINDOW_MS) {
        return TopicValidatorResult.Ignore;
      }
      // NET_INTERFACE → Peer Penalty System: an ordering block's validator
      // signature that does not verify is a `misbehavior` row.
      if (!validators.verifyValidatorSignature(header, validatorSignature)) {
        peerMgr.recordPenalty('misbehavior', peerId, 100, 'ordering block validator signature invalid');
        return TopicValidatorResult.Reject;
      }
      // The body — a second decode whose throw is ProtocolViolation.
      let utxoTxTree: UtxoTxTree;
      try {
        utxoTxTree = decodeUtxoTxTree(utxoTxTreeBytes);
      } catch (err) {
        peerMgr.recordPenaltyKind(
          PenaltyKind.ProtocolViolation,
          peerId,
          `malformed ordering block body: ${String(err)}`,
        );
        return TopicValidatorResult.Reject;
      }
      const block: OrderingBlock = { header, utxoTxTree, validatorSignature };
      const vr = validators.verifyOrderingBlockStructure(block);
      if (!vr.valid) {
        peerMgr.recordPenalty('misbehavior', peerId, 100, vr.error ?? 'invalid ordering block');
        return TopicValidatorResult.Reject;
      }
      // NET_INTERFACE → Stage 1 →
      // "A worked header is forwarded with the body its root commits"
      if (!validators.verifyUtxoTxRoot(block)) {
        peerMgr.recordPenalty(
          'misbehavior',
          peerId,
          100,
          "ordering block body is not the one the header's root commits",
        );
        return TopicValidatorResult.Reject;
      }
      // Record the acceptance; prune stale entries so the memory keeps
      // nothing past the seen window.
      seenAccepted.set(hash, now);
      for (const [k, t] of seenAccepted) {
        if (now - t >= GOSSIP_SEEN_WINDOW_MS) seenAccepted.delete(k);
      }
      return TopicValidatorResult.Accept;
    } catch (err) {
      console.error(`[net] block validator fault (ignored): ${String(err)}`);
      return TopicValidatorResult.Ignore;
    }
  });

  gs.topicValidators.set(topics.tx, (_peer, msg) => {
    const peerId = _peer.toString();
    const raw = new Uint8Array(msg.data);
    // NET_INTERFACE → Validation (and untrusted-input safety) →
    // "A peer's bytes are weighed before they are decoded"
    if (raw.length > MAX_TX_PACKET_BYTES) {
      peerMgr.recordPenaltyKind(
        PenaltyKind.ProtocolViolation,
        peerId,
        `tx packet ${raw.length} bytes exceeds MAX_TX_PACKET_BYTES (${MAX_TX_PACKET_BYTES})`,
      );
      return TopicValidatorResult.Reject;
    }
    // NET_INTERFACE → Stage 1 → "A fault of this node's is no peer's".
    // The decode is the one step whose throw is the sender's; everything below
    // reads this node's chain or runs validation's pure functions.
    let packet: ReturnType<typeof decodeTxPacket>;
    try {
      packet = decodeTxPacket(raw);
    } catch (err) {
      peerMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, peerId, `malformed tx: ${String(err)}`);
      return TopicValidatorResult.Reject;
    }
    const { tx, content } = packet;

    try {
      const vr = validators.verifyTxStructure(tx);
      if (!vr.valid) {
        peerMgr.recordPenalty('misbehavior', peerId, 100, vr.error ?? 'invalid tx');
        return TopicValidatorResult.Reject;
      }
      // NET_INTERFACE → Stage 1 →
      // "A refusal that rests on this node's state records nothing".
      // The era is read from this node's tip, which the sender may hold
      // differently; a declared-version mismatch is a Reject with no penalty.
      if (!validators.verifyTxProtocolVersion(tx, chainHeight() + 1, schedule)) {
        return TopicValidatorResult.Reject;
      }
      // NET_INTERFACE → Gossip Topics: tx.post present ⟺ content present
      const hasPost = tx.post !== undefined;
      const hasContent = content !== undefined;
      if (hasPost !== hasContent) {
        peerMgr.recordPenalty('misbehavior', peerId, 100,
          hasPost ? 'post without body' : 'body without post');
        return TopicValidatorResult.Reject;
      }
      if (hasPost && hasContent) {
        const bv = validators.verifyPostBody(content, tx.post!.contentHash);
        if (!bv.valid) {
          peerMgr.recordPenalty('misbehavior', peerId, 100, bv.error ?? 'post body verification failed');
          return TopicValidatorResult.Reject;
        }
      }
      // The post relay gate — see `KarmaMembers`. It runs only for a
      // post-bearing transaction and only after `verifyTxStructure`.
      //
      // NET_INTERFACE → Stage 1 →
      // "A refusal that rests on this node's state records nothing":
      // the karma set is this node's view, which a peer behind may not yet
      // carry; a miss Rejects with no penalty.
      //
      // ⚠ What makes the hex-encode safe on THIS path is the decoder, not that
      // check. `author` is `b32`, read as `readBytesN(r, 32)`, so
      // `decodeTxPacket` above cannot produce any other width — and it is the
      // only producer of the object this closure sees. `verifyTxStructure`'s own
      // 32-byte pin is depth rather than enforcement here; it is left in place
      // because it is what a caller reaching this gate without a decode would
      // land on, and that failure would otherwise be silent.
      if (tx.post !== undefined) {
        const author = Buffer.from(tx.post.author).toString('hex');
        if (!karmaMembers.has(author)) {
          return TopicValidatorResult.Reject;
        }
      }
      // NET_INTERFACE → Stage 1 →
      // "A transaction's signatures are checked at Stage 1":
      // last, because it is the dearest — 1.1–1.7 ms per signature.
      if (!validators.verifyTxSignatures(tx)) {
        peerMgr.recordPenalty('misbehavior', peerId, 100, 'tx signature invalid');
        return TopicValidatorResult.Reject;
      }
      return TopicValidatorResult.Accept;
    } catch (err) {
      console.error(`[net] tx validator fault (ignored): ${String(err)}`);
      return TopicValidatorResult.Ignore;
    }
  });

  // -------------------------------------------------------------------------
  // Event listener — delivers every message the router hands on and reports
  // each message's verdict (NET_INTERFACE → Forwarding Rule → "An ordering
  // block is forwarded once Stage 1 passes; a transaction once this node
  // admits it"). Topic validators (above) are the only gate before this point;
  // gossipsub's `asyncValidation` holds a message that passed one until the
  // report lands.
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
    const msgId = (detail as { msgId?: string }).msgId;

    const report = (acceptance: TopicValidatorResult): void => {
      if (msgId === undefined) return;
      gs.reportMessageValidationResult(msgId, relayPeerId, acceptance);
    };

    if (topic === topics.orderingBlock) {
      // NET_INTERFACE → Inbound Processing → "A transaction is forwarded when
      // a handler admits it": the block's report runs before its handlers.
      report(TopicValidatorResult.Accept);
      let block: OrderingBlock;
      try {
        block = decodeOrderingBlock(raw);
      } catch (err) {
        // Unreachable unless the topic validator is wrong: every message that
        // gets here was already decoded once, by the validator that accepted
        // it. So this is our bug and not the sender's — no penalty is
        // recorded, and it is logged loudly rather than absorbed.
        console.error(
          `[net] BUG: '${topic}' message passed its topic validator and then failed to decode: ${String(err)}`,
        );
        return;
      }
      try {
        handlers.onOrderingBlock(block, relayPeerId);
      } catch (err) {
        console.error(`[net] handler for '${topic}' threw: ${String(err)}`);
      }
    } else if (topic === topics.tx) {
      let packet: ReturnType<typeof decodeTxPacket>;
      try {
        packet = decodeTxPacket(raw);
      } catch (err) {
        console.error(
          `[net] BUG: '${topic}' message passed its topic validator and then failed to decode: ${String(err)}`,
        );
        report(TopicValidatorResult.Ignore);
        return;
      }
      let admitted = false;
      try {
        admitted = handlers.onTx(packet.tx, packet.content, relayPeerId) === true;
      } catch (err) {
        console.error(`[net] handler for '${topic}' threw: ${String(err)}`);
      }
      report(admitted ? TopicValidatorResult.Accept : TopicValidatorResult.Ignore);
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
