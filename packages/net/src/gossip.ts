import {
  decodeSubBlock,
  decodeOrderingBlock,
  decodeTx,
  encodeSubBlock,
  encodeOrderingBlock,
  encodeTx,
  postPowPreimage,
} from '@dagsocial/types';
import {
  verifyContentLimits,
  verifyContentCharacters,
  verifyParentRefsCount,
} from '@dagsocial/validation';
import type { SubBlock, OrderingBlock, UtxoTransaction } from '@dagsocial/types';
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

export const TOPICS = {
  subblock: '/dagsocial/subblock/1',
  orderingBlock: '/dagsocial/ordering-block/1',
  tx: '/dagsocial/tx/1',
} as const;

// ---------------------------------------------------------------------------
// Handlers registered by node
// ---------------------------------------------------------------------------

export interface GossipHandlers {
  onSubBlock: (sb: SubBlock) => void;
  /**
   * `fromPeerId` is the peer that **relayed** this block to us
   * (`propagationSource`), not the peer that published it. Fork resolution asks
   * that peer for the competing chain, because it provably holds one — see the
   * dispatch below for why `msg.from` is the wrong value.
   */
  onOrderingBlock: (block: OrderingBlock, fromPeerId: string) => void;
  onTx: (tx: UtxoTransaction) => void;
}

// ---------------------------------------------------------------------------
// Subscribe
// ---------------------------------------------------------------------------

export function subscribeTopics(
  libp2p: Libp2pGossip,
  validators: NetValidators,
  peerMgr: PeerManager,
  handlers: GossipHandlers,
  postPowTargetBits: number,
): void {
  const gs = libp2p.services.pubsub;

  // -------------------------------------------------------------------------
  // Topic validators — run BEFORE forwarding to mesh peers.  Invalid
  // messages are rejected at this layer and never propagated further.
  // -------------------------------------------------------------------------

  gs.topicValidators.set(TOPICS.subblock, (_peer, msg) => {
    try {
      const raw = new Uint8Array(msg.data);
      const sb = decodeSubBlock(raw);
      const vr = runStage1SubBlock(sb, validators, postPowTargetBits);
      if (!vr.valid) {
        // Bogus — well-formed message with invalid content.
        // Score accumulates toward temporal ban but is NOT an instant permanent ban.
        peerMgr.recordPenalty('misbehavior', _peer.toString(), 100, vr.error ?? 'invalid sub-block');
        return TopicValidatorResult.Reject;
      }
      return TopicValidatorResult.Accept;
    } catch (err) {
      // Malformed — cannot even decode. Permanent ban.
      peerMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, _peer.toString(), `malformed sub-block: ${String(err)}`);
      return TopicValidatorResult.Reject;
    }
  });

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
      return TopicValidatorResult.Accept;
    } catch (err) {
      // Malformed — cannot even decode. Permanent ban.
      peerMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, _peer.toString(), `malformed tx: ${String(err)}`);
      return TopicValidatorResult.Reject;
    }
  });

  // -------------------------------------------------------------------------
  // Event listener — dispatches accepted messages to app-layer handlers.
  // Topic validators (above) guarantee only structurally-valid, PoW-verified
  // messages reach this point.
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

    if (topic === TOPICS.subblock) {
      deliver(decodeSubBlock, (sb) => handlers.onSubBlock(sb));
    } else if (topic === TOPICS.orderingBlock) {
      deliver(decodeOrderingBlock, (block) => handlers.onOrderingBlock(block, relayPeerId));
    } else if (topic === TOPICS.tx) {
      deliver(decodeTx, (tx) => handlers.onTx(tx));
    }
  });

  // Subscribe to all three topics
  gs.subscribe(TOPICS.subblock);
  gs.subscribe(TOPICS.orderingBlock);
  gs.subscribe(TOPICS.tx);
}

// ---------------------------------------------------------------------------
// Stage 1 validation for sub-blocks
// ---------------------------------------------------------------------------

function runStage1SubBlock(
  sb: SubBlock,
  v: NetValidators,
  postPowTargetBits: number,
): { valid: boolean; error?: string } {
  const struct = v.verifySubBlockStructure(sb);
  if (!struct.valid) return struct;

  const post = sb.post;

  const content = verifyContentLimits(post.content);
  if (!content.valid) return content;

  const chars = verifyContentCharacters(post.content);
  if (!chars.valid) return chars;

  const refs = verifyParentRefsCount(post.parentRefs);
  if (!refs.valid) return refs;

  if (!v.verifyProtocolVersion(post.protocolVersion)) {
    return { valid: false, error: 'Unsupported protocol version' };
  }

  // Target from config, never the compile-time constant — post difficulty is
  // per-network (NET_INTERFACE §Consensus parameters net enforces); the
  // constant would make a devnet relay reject its own network's posts.
  const powInput = postPowPreimage(post);
  if (!v.verifyPoW(powInput, post.powNonce, postPowTargetBits)) {
    return { valid: false, error: 'Proof of Work invalid' };
  }

  // PoW first (anti-spam gate), then the ~50µs signature check.
  // `post.author` IS the 32-byte Ed25519 key — the same derivation Stage 2
  // uses in the node's verifyPostForRelay; any drift here splits the relay.
  if (!v.verifyPostSignature(post, post.author)) {
    return { valid: false, error: 'Signature invalid' };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

export async function broadcastSubBlock(libp2p: Libp2pGossip, sb: SubBlock): Promise<void> {
  const data = encodeSubBlock(sb);
  await libp2p.services.pubsub.publish(TOPICS.subblock, data);
}

export async function broadcastOrderingBlock(libp2p: Libp2pGossip, block: OrderingBlock): Promise<void> {
  const data = encodeOrderingBlock(block);
  await libp2p.services.pubsub.publish(TOPICS.orderingBlock, data);
}

export async function broadcastTx(libp2p: Libp2pGossip, tx: UtxoTransaction): Promise<void> {
  const data = encodeTx(tx);
  await libp2p.services.pubsub.publish(TOPICS.tx, data);
}

// ---------------------------------------------------------------------------
// Serve-before-relay — incoming content request handler
// ---------------------------------------------------------------------------

/**
 * Dependencies for the serve-before-relay handler.
 *
 * The caller (node layer) provides concrete implementations of each callback
 * so gossip.ts stays decoupled from storage and peer management.
 */
export interface GossipDeps {
  /** Check if a modifier is available locally. Returns the serialized data
   *  if found, or null if not present. Called before relaying. */
  localServe: (typeId: number, id: Uint8Array) => Uint8Array | null;
  /** Relay a modifier request to connected peers (excluding the requester). */
  relay: (typeId: number, id: Uint8Array, excludePeer: string) => void;
  /** Send a response directly to a peer. */
  sendTo: (peerId: string, message: Uint8Array) => void;
}

/**
 * Handle an incoming modifier request from a peer.
 *
 * **Invariant:** local store is checked BEFORE relaying. Serve and relay are
 * mutually exclusive per request ID — a request is either served locally
 * OR relayed, never both.
 *
 * @param deps - Callbacks for local lookup, relaying, and direct sending.
 * @param requesterId - The peer that sent the modifier request.
 * @param typeId - Modifier type ID (e.g. MODIFIER_ORDERING_BLOCK).
 * @param id - The modifier identifier to look up.
 */
export function handleModifierRequest(
  deps: GossipDeps,
  requesterId: string,
  typeId: number,
  id: Uint8Array,
): void {
  // Check local store FIRST
  const localData = deps.localServe(typeId, id);
  if (localData) {
    // Serve from local store — do NOT relay
    deps.sendTo(requesterId, localData);
    return;
  }

  // Only relay if not available locally
  deps.relay(typeId, id, requesterId);
}
