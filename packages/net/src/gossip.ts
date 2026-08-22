import {
  decodeOrderingBlock,
  decodeTx,
  encodeOrderingBlock,
  encodeTx,
} from '@dagsocial/types';
import type { OrderingBlock, UtxoTransaction } from '@dagsocial/types';
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
// Topic constants
// ---------------------------------------------------------------------------

// Tracked reservation: '/dagsocial/subblock/1' (NET_INTERFACE → Gossip Topics).
export const TOPICS = {
  orderingBlock: '/dagsocial/ordering-block/1',
  tx: '/dagsocial/tx/1',
} as const;

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
   * dispatch below for why `msg.from` is the wrong value.
   */
  onOrderingBlock: (block: OrderingBlock, fromPeerId: string) => void;
  onTx: (tx: UtxoTransaction, fromPeerId: string) => void;
}

// ---------------------------------------------------------------------------
// Subscribe
// ---------------------------------------------------------------------------

export function subscribeTopics(
  libp2p: Libp2pGossip,
  validators: NetValidators,
  peerMgr: PeerManager,
  handlers: GossipHandlers,
  karmaMembers: KarmaMembers,
): void {
  const gs = libp2p.services.pubsub;

  // -------------------------------------------------------------------------
  // Topic validators — run BEFORE forwarding to mesh peers.  Invalid
  // messages are rejected at this layer and never propagated further.
  // -------------------------------------------------------------------------

  gs.topicValidators.set(TOPICS.orderingBlock, (_peer, msg) => {
    try {
      const raw = new Uint8Array(msg.data);
      const block = decodeOrderingBlock(raw);
      const vr = validators.verifyOrderingBlockStructure(block);
      if (!vr.valid) {
        // Bogus — well-formed message with invalid content.
        peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, vr.error ?? 'invalid ordering block');
        return TopicValidatorResult.Reject;
      }
      if (!validators.verifyProtocolVersion(block.header.protocolVersion)) {
        // Bogus — well-formed message with unsupported version.
        peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, 'unsupported protocol version');
        return TopicValidatorResult.Reject;
      }
      // No explicit height guard here, and adding one would be dead code:
      // `verifyOrderingBlockStructure` above covers the header's whole
      // encodable domain, and its `height` rule is `isU64Safe` (audit M-6), so
      // NaN and floats are already rejected one gate earlier — for every input,
      // not merely the NaN/1.5 cases the test below pins.
      if (!validators.verifyOrderingBlockPoW(block.header)) {
        // Bogus — a zero-work block must die at the first hop, not be
        // re-gossiped mesh-wide (audit M-9). Stage 1 checks the header's own
        // floor-bounded target only; the difficulty schedule is apply-time
        // node policy.
        peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, 'ordering block PoW invalid');
        return TopicValidatorResult.Reject;
      }
      return TopicValidatorResult.Accept;
    } catch (err) {
      // Malformed — cannot even decode. Permanent ban.
      peerMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, _peer.toString(), `malformed ordering block: ${String(err)}`);
      return TopicValidatorResult.Reject;
    }
  });

  gs.topicValidators.set(TOPICS.tx, (_peer, msg) => {
    try {
      const raw = new Uint8Array(msg.data);
      const tx = decodeTx(raw);
      const vr = validators.verifyTxStructure(tx);
      if (!vr.valid) {
        // Bogus — well-formed message with invalid content.
        peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, vr.error ?? 'invalid tx');
        return TopicValidatorResult.Reject;
      }
      if (!validators.verifyProtocolVersion(tx.protocolVersion)) {
        // Bogus — well-formed message with unsupported version.
        peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, 'unsupported protocol version');
        return TopicValidatorResult.Reject;
      }
      // The post relay gate — see `KarmaMembers`. It runs only for a
      // post-bearing transaction and only after `verifyTxStructure`.
      //
      // ⚠ What makes the hex-encode safe on THIS path is the decoder, not that
      // check. `author` is `b32`, read as `readBytesN(r, 32)`, so `decodeTx`
      // above cannot produce any other width — and it is the only producer of
      // the object this closure sees. `verifyTxStructure`'s own 32-byte pin is
      // depth rather than enforcement here; it is left in place because it is
      // what a caller reaching this gate without a decode would land on, and
      // that failure would otherwise be silent.
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
      // Malformed — cannot even decode. Permanent ban.
      peerMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, _peer.toString(), `malformed tx: ${String(err)}`);
      return TopicValidatorResult.Reject;
    }
  });

  // -------------------------------------------------------------------------
  // Event listener — dispatches accepted messages to app-layer handlers.
  // Topic validators (above) guarantee only structurally-valid messages reach
  // this point — PoW-verified for ordering blocks, membership-gated for posts.
  // -------------------------------------------------------------------------

  gs.addEventListener('gossipsub:message', (evt) => {
    const { detail } = evt;
    if (!detail?.msg) return;

    // Drop messages from peers that are not in Active state
    const sourcePeerId = (detail.msg as { from?: { toString(): string } }).from?.toString();
    if (sourcePeerId && !peerMgr.isPeerActive(sourcePeerId)) {
      return;
    }

    const { topic } = detail.msg;
    const raw = new Uint8Array(detail.msg.data);

    // The peer that sent this message to *us*, which is not the peer above:
    // `msg.from` is the message's original publisher and need not be connected
    // to us at all, while `propagationSource` is by construction the peer we
    // received it from — so it is the one that provably holds the chain a
    // competing block belongs to (NET_INTERFACE → Pull Requests).
    //
    // Read the same defensive way `msg.from` is: the field is required by
    // gossipsub's own type, so an event without it is a broken event rather than
    // a peer's doing, and no method here panics on one. The empty string is not
    // a peer id, so a consumer testing membership in its connected set falls
    // back exactly as it does for a source that has since disconnected.
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

    if (topic === TOPICS.orderingBlock) {
      deliver(decodeOrderingBlock, (block) => handlers.onOrderingBlock(block, relayPeerId));
    } else if (topic === TOPICS.tx) {
      deliver(decodeTx, (tx) => handlers.onTx(tx, relayPeerId));
    }
  });

  // Subscribe to both topics
  gs.subscribe(TOPICS.orderingBlock);
  gs.subscribe(TOPICS.tx);
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

export async function broadcastOrderingBlock(libp2p: Libp2pGossip, block: OrderingBlock): Promise<void> {
  const data = encodeOrderingBlock(block);
  await libp2p.services.pubsub.publish(TOPICS.orderingBlock, data);
}

export async function broadcastTx(libp2p: Libp2pGossip, tx: UtxoTransaction): Promise<void> {
  const data = encodeTx(tx);
  await libp2p.services.pubsub.publish(TOPICS.tx, data);
}

