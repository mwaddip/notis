import {
  bytesToHex,
  decodeTxPacket,
  encodeOrderingBlock,
  encodeTxPacket,
  MAX_TX_PACKET_BYTES,
} from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import type { OrderingBlock, UtxoTransaction, BlockHeader, ProtocolEra } from '@dagsocial/types';
import { TopicValidatorResult } from '@libp2p/gossipsub';
import type { GossipSub } from '@libp2p/gossipsub';
import { PenaltyKind } from './types.js';
import type { NetValidators } from './types.js';
import type { PeerManager } from './peer-mgr.js';
import type { GossipTopics } from './gossip-rules.js';
import { BlockCheck } from './block-check.js';
import type { BlockValidators } from './block-check.js';

// ---------------------------------------------------------------------------
// Minimal interface capturing what gossip.ts needs from a libp2p node.
// The full Libp2p<T> type has `services: T` defaulting to `Record<string,
// unknown>`, so we cannot access `.pubsub` without a type parameter or cast.
// This interface documents the contract: the caller must pass a libp2p node
// whose `services.pubsub` has been configured with gossipsub.
// ---------------------------------------------------------------------------

// NET_INTERFACE → Forwarding Rule → "An ordering block is forwarded once Stage 1
// passes; a transaction once this node admits it". `reportMessageValidationResult`
// is a method on the concrete `GossipSub` class but is not published on the
// public `GossipSub` interface, so the listener below reads it off the service
// through this intersection type.
export interface Libp2pGossip {
  services: {
    pubsub: GossipSub & {
      reportMessageValidationResult(
        msgId: string,
        propagationSource: string,
        acceptance: TopicValidatorResult,
      ): void;
    };
  };
}

// The topic strings, the message id and the seen window live in
// `./gossip-rules.js` (browser-safe) — re-exported here so `index.ts`
// still finds them at this module's name.
export {
  GOSSIP_SEEN_WINDOW_MS,
  GOSSIP_IP_COLOCATION_WEIGHT,
  gossipMessageId,
  gossipTopics,
} from './gossip-rules.js';
export type { GossipTopics } from './gossip-rules.js';

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
   * (`propagationSource`), not the peer that published it. The relayer
   * provably holds the chain this block is on, so the pipeline asks it for
   * the headers the tree lacks below the block (NET_INTERFACE → Pull
   * Requests → "A gossiped block's relayer is asked for the headers the tree
   * lacks") — see the listener below for why `propagationSource` is the
   * value handed on.
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

  // NET_INTERFACE → Inbound Processing → "A gossiped message is decoded once"
  // — each validator keeps its accepted value against the message object the
  // router hands it, and the listener reads that value for the handlers.
  // `WeakMap` lets the entry fall when the message object does, so nothing a
  // delivery drops survives.
  const acceptedBlocks = new WeakMap<object, OrderingBlock>();
  const acceptedTxPackets = new WeakMap<object, { tx: UtxoTransaction; content?: string }>();

  // -------------------------------------------------------------------------
  // Topic validators — run BEFORE forwarding to mesh peers.  Invalid
  // messages are rejected at this layer and never propagated further.
  // -------------------------------------------------------------------------

  // NET_INTERFACE → The browser entry — BlockCheck is the one copy of the
  // ordering-block topic's checks of NET_INTERFACE → Stage 1. The validator
  // reads its verdict (penalty, Accept/Reject/Ignore, the record).
  const blockValidators: BlockValidators = {
    verifyHeaderFieldDomains: validators.verifyHeaderFieldDomains,
    verifyProtocolVersion: validators.verifyProtocolVersion,
    verifyOrderingBlockPoW: validators.verifyOrderingBlockPoW,
    verifyValidatorSignature: validators.verifyValidatorSignature,
    verifyOrderingBlockStructure: validators.verifyOrderingBlockStructure,
    verifyUtxoTxRoot: validators.verifyUtxoTxRoot,
    blockHash,
  };
  const blockCheck = new BlockCheck(blockValidators, {
    schedule,
    floorBits,
    scheduledTargetBits,
    standing: headerStanding,
    nowMs,
  });

  gs.topicValidators.set(topics.orderingBlock, (_peer, msg) => {
    const peerId = _peer.toString();
    const raw = new Uint8Array(msg.data);
    const verdict = blockCheck.check(raw);
    if (verdict.result === 'accept') {
      // NET_INTERFACE → Inbound Processing → "A gossiped message is decoded
      // once" — the block the validator read is kept against the message
      // object for the listener.
      acceptedBlocks.set(msg, verdict.block);
      return TopicValidatorResult.Accept;
    }
    if (verdict.result === 'ignore') {
      // NET_INTERFACE → Stage 1 → "A fault of this node's is no peer's"
      // — a verdict that carries a fault names this receiver's fault for
      // the operator.
      if (verdict.fault !== undefined) console.error(`[net] ${verdict.fault}`);
      return TopicValidatorResult.Ignore;
    }
    if (verdict.penalty !== null) {
      peerMgr.recordPenaltyKind(verdict.penalty, peerId, verdict.detail);
    } else {
      // NET_INTERFACE → Stage 1 → "A refusal that rests on this node's
      // state records nothing" — the detail still reaches the operator.
      console.log(`[net] ${verdict.detail}`);
    }
    return TopicValidatorResult.Reject;
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
        peerMgr.recordPenaltyKind(PenaltyKind.Misbehavior, peerId, vr.error ?? 'invalid tx');
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
        peerMgr.recordPenaltyKind(PenaltyKind.Misbehavior, peerId,
          hasPost ? 'post without body' : 'body without post');
        return TopicValidatorResult.Reject;
      }
      if (hasPost && hasContent) {
        const bv = validators.verifyPostBody(content, tx.post!.contentHash);
        if (!bv.valid) {
          peerMgr.recordPenaltyKind(PenaltyKind.Misbehavior, peerId, bv.error ?? 'post body verification failed');
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
        const author = bytesToHex(tx.post.author);
        if (!karmaMembers.has(author)) {
          return TopicValidatorResult.Reject;
        }
      }
      // NET_INTERFACE → Stage 1 →
      // "A transaction's signatures are checked at Stage 1":
      // last, because it is the dearest — 1.1–1.7 ms per signature.
      if (!validators.verifyTxSignatures(tx)) {
        peerMgr.recordPenaltyKind(PenaltyKind.Misbehavior, peerId, 'tx signature invalid');
        return TopicValidatorResult.Reject;
      }
      // NET_INTERFACE → Inbound Processing → "A gossiped message is decoded
      // once" — the packet the validator read is kept against the message
      // object for the listener.
      acceptedTxPackets.set(msg, packet);
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

    const { msg } = detail;
    const { topic } = msg;

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
      // NET_INTERFACE → Inbound Processing → "A gossiped message is decoded
      // once" — the validator keeps the block against the message object,
      // and the listener reads it here. An accepted message with no value
      // kept against it is this node's bug: logged as one, delivered to no
      // handler, and it penalises no peer.
      const block = acceptedBlocks.get(msg);
      if (block === undefined) {
        console.error(
          `[net] BUG: '${topic}' message accepted but no value kept against it`,
        );
        return;
      }
      try {
        handlers.onOrderingBlock(block, relayPeerId);
      } catch (err) {
        console.error(`[net] handler for '${topic}' threw: ${String(err)}`);
      }
    } else if (topic === topics.tx) {
      // NET_INTERFACE → Inbound Processing → "A gossiped message is decoded
      // once" — the validator keeps the packet against the message object,
      // and the listener reads it here. An accepted message with no value
      // kept against it is this node's bug: logged as one, delivered to no
      // handler, reported Ignore, and it penalises no peer.
      const packet = acceptedTxPackets.get(msg);
      if (packet === undefined) {
        console.error(
          `[net] BUG: '${topic}' message accepted but no value kept against it`,
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
