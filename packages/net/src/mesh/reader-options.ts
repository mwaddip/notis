// NET_INTERFACE → The browser entry — `readerLibp2pOptions` is the
// libp2p options a reader hands to `createLibp2p`: the browser
// transports alone (WebRTC-direct, WebRTC signalled over a relay,
// the circuit-relay transport, the secure WebSocket), Noise, yamux,
// `identify`, `ping`, the Notis DHT in client mode and gossipsub
// with `net`'s options for the ordering-block topic. No TCP, no
// circuit-relay server, no http server
// (MESH_INTERFACE → Place in the workspace, and MESH_INTERFACE →
// Transports — the browser's four transports). Browser-safe: imports
// no Node built-in and reads no Node global.

import { webRTC, webRTCDirect } from '@libp2p/webrtc';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { kadDHT } from '@libp2p/kad-dht';
import { gossipsub } from '@libp2p/gossipsub';
import type { AddressSorter, PrivateKey } from '@libp2p/interface';
import type { Multiaddr } from '@multiformats/multiaddr';
import { gossipsubOptions, gossipTopics } from '../gossip-rules.js';
import { dhtProtocol, type MeshNetworkName } from './constants.js';

/**
 * NET_INTERFACE → The browser entry — `readerLibp2pOptions`'
 * options. `privateKey` is the reader's libp2p identity (an Ed25519
 * key, built from `nodeKeyFromKeyPair` or libp2p's own key
 * generators); `iceServers` is read on every dial so a changing STUN
 * list reaches the next peer connection
 * (MESH_INTERFACE → NAT → "A client's STUN list comes from the
 * public nodes it holds"); `denyDialMultiaddr` is the client's own
 * gater (MESH_INTERFACE → Transports → "A client dials a private
 * address only when its own configuration names it"); `addressSorter`
 * is libp2p's own `AddressSorter` for the dial queue
 * (MESH_INTERFACE → The client's node list → "The secure WebSocket
 * is the fallback").
 */
export interface ReaderLibp2pOptions {
  readonly privateKey: PrivateKey;
  readonly magic: number;
  readonly network: MeshNetworkName;
  readonly iceServers: () => RTCIceServer[];
  readonly denyDialMultiaddr: (ma: Multiaddr) => boolean;
  readonly addressSorter?: AddressSorter;
}

/**
 * NET_INTERFACE → The browser entry — build the libp2p options a
 * reader is created with. The returned object is passed to
 * `createLibp2p` as its config; a caller may spread more services
 * onto it (such as its own router or cache), but `net`'s four —
 * `identify`, `ping`, `dht`, `pubsub` — are the ones MESH_INTERFACE
 * pins.
 */
export function readerLibp2pOptions(
  o: ReaderLibp2pOptions,
): {
  privateKey: PrivateKey;
  transports: ReturnType<typeof webRTCDirect | typeof webRTC | typeof circuitRelayTransport | typeof webSockets>[];
  connectionEncrypters: ReturnType<typeof noise>[];
  streamMuxers: ReturnType<typeof yamux>[];
  connectionManager: { addressSorter?: AddressSorter };
  connectionGater: { denyDialMultiaddr: (ma: Multiaddr) => boolean };
  services: {
    identify: ReturnType<typeof identify>;
    ping: ReturnType<typeof ping>;
    dht: ReturnType<typeof kadDHT>;
    pubsub: ReturnType<typeof gossipsub>;
  };
} {
  const topics = gossipTopics(o.magic);
  // MESH_INTERFACE → NAT — "Only the relayed WebRTC path uses STUN;
  // WebRTC-direct to a public address needs none". `webRTCDirect` is
  // built with an empty iceServers list so js-libp2p does not fall
  // back to its DEFAULT_ICE_SERVERS; `webRTC`'s `rtcConfiguration` is
  // a function the transport reads on every dial, so a changing STUN
  // list flows into every new peer connection.
  const transports = [
    webRTCDirect({ rtcConfiguration: { iceServers: [] } }),
    webRTC({ rtcConfiguration: () => ({ iceServers: o.iceServers() }) }),
    circuitRelayTransport(),
    webSockets(),
  ];
  const connectionManager: { addressSorter?: AddressSorter } = {};
  if (o.addressSorter !== undefined) connectionManager.addressSorter = o.addressSorter;
  return {
    privateKey: o.privateKey,
    transports,
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionManager,
    connectionGater: { denyDialMultiaddr: o.denyDialMultiaddr },
    services: {
      identify: identify(),
      ping: ping(),
      // MESH_INTERFACE → Discovery → "The DHT is Notis's own" — the
      // reader runs the DHT in client mode: it does not answer the
      // server-side protocol. The protocol name is per-network, so a
      // reader and a node of the same network share one DHT.
      dht: kadDHT({ protocol: dhtProtocol(o.network), clientMode: true }),
      // MESH_INTERFACE → Block gossip → "One router, net's rules" —
      // the reader subscribes to the ordering-block topic alone and
      // reads nothing else off the router.
      pubsub: gossipsub(gossipsubOptions(o.magic, [topics.orderingBlock])),
    },
  };
}
