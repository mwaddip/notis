// NET_INTERFACE → The browser entry — the gossip rules the browser entry
// shares with the Node. `gossipTopics`, `gossipMessageId`,
// `GOSSIP_SEEN_WINDOW_MS` and the options object `node.ts` builds its
// gossipsub from; all imports are `@dagsocial/types`.
import { ByteWriter, hash32, writeLpUtf8 } from '@dagsocial/types';

export interface GossipTopics {
  readonly orderingBlock: string;
  readonly tx: string;
}

/**
 * NET_INTERFACE → Gossip Topics → "A topic is named for its network".
 *
 * The pair a node of this magic hears: the ordering-block topic and the tx
 * topic, each carrying the magic as eight lowercase hex digits. Throws when
 * `magic` is not an unsigned 32-bit integer — a node with no network does
 * not start on a topic of its own (`NET_INTERFACE → Config`).
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
 * NET_INTERFACE → Gossip Topics → "A message is heard once in a seen
 * window". Two minutes; `CONSTANTS → net`.
 */
export const GOSSIP_SEEN_WINDOW_MS = 120_000;

/**
 * MESH_INTERFACE → Block gossip → "A router scores its peers by gossipsub's
 * defaults, and a shared address costs a peer nothing". The weight
 * `gossipsubOptions` hands gossipsub for its IP colocation factor;
 * `CONSTANTS → net`.
 */
export const GOSSIP_IP_COLOCATION_WEIGHT = 0;

/**
 * NET_INTERFACE → Gossip Topics → "A message is named by its bytes" —
 * `hash32(lpUtf8(topic) ‖ data)` for a message this node publishes as for
 * one it receives.
 */
export function gossipMessageId(topic: string, data: Uint8Array): Uint8Array {
  const w = new ByteWriter();
  writeLpUtf8(w, topic);
  return hash32(w.toBytes(), data);
}

/**
 * NET_INTERFACE → Gossip Topics, → Forwarding Rule — the one options object
 * `node.ts` builds its gossipsub from. Each field is the rule it cites:
 *
 *  - `globalSignaturePolicy: 'StrictNoSign'` — "A message is its topic and
 *    its data".
 *  - `msgIdFn` — "A message is named by its bytes".
 *  - `seenTTL` — "A message is heard once in a seen window".
 *  - `ignoreDuplicatePublishError: true` — "A broadcast that sends nothing
 *    still resolves".
 *  - `allowedTopics` — the topic names the router hears.
 *  - `allowPublishToZeroTopicPeers: true` — the broadcast rule's second half.
 *  - `asyncValidation: true` — "An ordering block is forwarded once Stage 1
 *    passes; a transaction once this node admits it".
 *  - `fallbackToFloodsub: false` — NET_INTERFACE → libp2p Stack.
 *  - `scoreParams: { IPColocationFactorWeight: GOSSIP_IP_COLOCATION_WEIGHT }`
 *    — MESH_INTERFACE → Block gossip → "A router scores its peers by
 *    gossipsub's defaults, and a shared address costs a peer nothing".
 *    gossipsub's `createPeerScoreParams` merges this partial over its
 *    defaults, so every other score parameter stands; the options name no
 *    `scoreThresholds`, so `createPeerScoreThresholds` keeps every default.
 */
export interface GossipsubOptions {
  globalSignaturePolicy: 'StrictNoSign';
  msgIdFn: (msg: { topic: string; data: Uint8Array }) => Uint8Array;
  seenTTL: number;
  ignoreDuplicatePublishError: boolean;
  allowedTopics: string[];
  allowPublishToZeroTopicPeers: boolean;
  asyncValidation: boolean;
  fallbackToFloodsub: boolean;
  scoreParams: { IPColocationFactorWeight: number };
}

export function gossipsubOptions(
  _magic: number,
  topics: readonly string[],
): GossipsubOptions {
  return {
    globalSignaturePolicy: 'StrictNoSign',
    msgIdFn: (m) => gossipMessageId(m.topic, m.data),
    seenTTL: GOSSIP_SEEN_WINDOW_MS,
    ignoreDuplicatePublishError: true,
    allowedTopics: [...topics],
    allowPublishToZeroTopicPeers: true,
    asyncValidation: true,
    fallbackToFloodsub: false,
    scoreParams: { IPColocationFactorWeight: GOSSIP_IP_COLOCATION_WEIGHT },
  };
}
