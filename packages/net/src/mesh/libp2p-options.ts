// NET_INTERFACE → The mesh — the libp2p options a mesh node adds to a
// plain `NetNode`'s. With `mesh`, `createLibp2p` gains the WebRTC-direct
// transport beside TCP, the keychain, the Notis DHT (`clientMode: false`
// for a public node), AutoNAT v2, the circuit-relay server (with no
// default reservation limit), and `@libp2p/http` serving the endpoint.
// Without `mesh`, nothing of these is added — the plain options stand
// byte-for-byte as they did (`NET_INTERFACE → The mesh`).

import { webRTCDirect } from '@libp2p/webrtc';
import { autoNATv2 } from '@libp2p/autonat-v2';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { kadDHT } from '@libp2p/kad-dht';
import { keychain } from '@libp2p/keychain';
import { http as httpService, type HTTP } from '@libp2p/http';
import type { Datastore } from 'interface-datastore';

import type { MeshConfig } from './config.js';
import { meshEndpoint } from './endpoint.js';
import {
  WEBRTC_CERT_LIFESPAN_MS,
  dhtProtocol,
  type MeshNetworkName,
} from './constants.js';

/**
 * The mesh's listen addresses, prepended with the plain listen address
 * the `NetNode` already carries. Any later de-duplication is libp2p's.
 */
export function meshListenAddrs(
  plainListen: string,
  mesh: MeshConfig,
): string[] {
  return [plainListen, ...mesh.listen];
}

/**
 * The mesh's service map addition. The caller spreads this beside its
 * `pubsub`, `identify`, `ping` entries at `createLibp2p`.
 */
export function meshServices(mesh: MeshConfig, _datastore: Datastore): {
  http: ReturnType<typeof httpService>;
  keychain: ReturnType<typeof keychain>;
  dht: ReturnType<typeof kadDHT>;
  autoNAT: ReturnType<typeof autoNATv2>;
  circuitRelay: ReturnType<typeof circuitRelayServer>;
} {
  // `MESH_INTERFACE → NAT → "A relay carries data"` — a public node
  // relays with no circuit limit; `applyDefaultLimit: false` drops
  // libp2p's default 128 KiB / 2-minute reservation limit.
  return {
    http: httpService({
      server: meshEndpoint(mesh.httpBase, { upstreamTimeoutMs: mesh.upstreamTimeoutMs }),
    }),
    keychain: keychain(),
    dht: kadDHT({
      protocol: dhtProtocol(mesh.network as MeshNetworkName),
      clientMode: false,
    }),
    autoNAT: autoNATv2(),
    circuitRelay: circuitRelayServer({ reservations: { applyDefaultLimit: false } }),
  };
}

/**
 * The mesh's transports — WebRTC-direct beside TCP. The empty
 * `iceServers` list disables libp2p's `DEFAULT_ICE_SERVERS` fallback
 * (`@libp2p/webrtc@7.0.2/src/constants.ts:12`); WebRTC-direct to a
 * public address needs none (`MESH_INTERFACE → NAT → "Every STUN
 * server is a mesh node named by IP"`). The lifespan is pinned past
 * any operator horizon, holding the certhash an anchor lists steady
 * across restarts (`MESH_INTERFACE → Transports → "The WebRTC-direct
 * certificate persists"`).
 */
export function meshWebRTCDirectTransport(): ReturnType<typeof webRTCDirect> {
  return webRTCDirect({
    rtcConfiguration: { iceServers: [] },
    certificateLifespan: WEBRTC_CERT_LIFESPAN_MS,
  });
}

export type { HTTP };
