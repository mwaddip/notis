// MESH_INTERFACE → Block gossip → "One router, net's rules" — the browser-safe
// code the client and the mesh service run holds its own copy of the topic
// name, the message id and the seen window, held equal to net's by
// `test/gossip-rules.test.ts`. A change to either here or in net fails those
// cases. `@dagsocial/net` is a Node-only package (TCP transport in its own
// index), so the page cannot import it; the mesh service imports those three
// through `@dagsocial/net` and the equality case keeps them aligned.

import { ByteWriter, hash32, writeLpUtf8 } from '@dagsocial/types';

/**
 * NET_INTERFACE → Gossip Topics → "A topic is named for its network" — the
 * ordering-block topic, carrying the magic as eight lowercase hex digits.
 * The mesh service and the client subscribe to this one topic alone
 * (MESH_INTERFACE → Block gossip). Throws when `magic` is not an unsigned
 * 32-bit integer, the same refusal net's own `gossipTopics` makes.
 */
export function blockTopic(magic: number): string {
  if (!Number.isInteger(magic) || magic < 0 || magic > 0xffffffff) {
    throw new Error(`blockTopic: magic must be an unsigned 32-bit integer, got ${magic}`);
  }
  const hex = magic.toString(16).padStart(8, '0');
  return `/dagsocial/${hex}/ordering-block/1`;
}

/**
 * NET_INTERFACE → Gossip Topics → "A message is named by its bytes" —
 * `hash32(lpUtf8(topic) ‖ data)`, the protocol hash over the topic string,
 * length-prefixed, and the payload. The topic is in the preimage because the
 * router records an id before the topic's validator runs.
 */
export function gossipMessageId(topic: string, data: Uint8Array): Uint8Array {
  const w = new ByteWriter();
  writeLpUtf8(w, topic);
  return hash32(w.toBytes(), data);
}

/**
 * NET_INTERFACE → Gossip Topics → "A message is heard once in a seen window" —
 * two minutes. The router keeps every id it has named for this long and
 * records it before the topic validator runs; a second copy inside the window
 * is not validated, not delivered and not forwarded.
 */
export const GOSSIP_SEEN_WINDOW_MS = 120_000;

/**
 * NET_INTERFACE → Gossip Topics / Forwarding Rule — the fields that decide
 * what a message is and whether it is forwarded. The mesh service and the
 * client pass this object to `gossipsub()`; every option here is one net
 * sets on its own router, and the three equality fields
 * (`msgIdFn`, `seenTTL`, `allowedTopics`) are held equal to net's by the
 * rules cases.
 */
export interface GossipsubOptionsShape {
  globalSignaturePolicy: 'StrictNoSign';
  msgIdFn: (m: { topic: string; data: Uint8Array }) => Uint8Array;
  seenTTL: number;
  ignoreDuplicatePublishError: boolean;
  allowedTopics: string[];
  allowPublishToZeroTopicPeers: boolean;
  asyncValidation: boolean;
  fallbackToFloodsub: boolean;
}

export function gossipsubOptions(magic: number): GossipsubOptionsShape {
  const topic = blockTopic(magic);
  return {
    // NET_INTERFACE → Gossip Topics → "A message is its topic and its data" —
    // the router refuses a signed envelope and emits none.
    globalSignaturePolicy: 'StrictNoSign',
    // NET_INTERFACE → Gossip Topics → "A message is named by its bytes".
    msgIdFn: (m) => gossipMessageId(m.topic, m.data),
    // NET_INTERFACE → Gossip Topics → "A message is heard once in a seen
    // window".
    seenTTL: GOSSIP_SEEN_WINDOW_MS,
    // NET_INTERFACE → Gossip → "A broadcast that sends nothing still
    // resolves" — a publish of bytes this host has seen inside the window
    // sends nothing and resolves.
    ignoreDuplicatePublishError: true,
    // NET_INTERFACE → Gossip Topics → "A topic is named for its network" —
    // the ordering-block topic alone is the whole of what the mesh service
    // and the client hear (MESH_INTERFACE → Block gossip).
    allowedTopics: [topic],
    allowPublishToZeroTopicPeers: true,
    // NET_INTERFACE → Forwarding Rule — the router holds a message that
    // passed its topic validator in the message cache until the listener
    // reports Accept, Ignore or Reject.
    asyncValidation: true,
    // NET_INTERFACE → libp2p Stack — gossipsub alone; the library's
    // default pushes `/floodsub/1.0.0` onto the registered protocols.
    fallbackToFloodsub: false,
  };
}
