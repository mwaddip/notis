// NET_INTERFACE → The mesh — the libp2p options a mesh node adds to a
// plain `NetNode`'s. With `mesh`, `createLibp2p` gains the WebRTC-direct
// transport beside TCP, the keychain, the Notis DHT (`clientMode: false`
// for a public node, `true` for a private), AutoNAT v2 and the
// circuit-relay server on a public node, DCUtR and the circuit-relay
// transport on a private, and `@libp2p/http` serving the endpoint.
// Without `mesh`, nothing of these is added — the plain options stand
// byte-for-byte as they did (`NET_INTERFACE → The mesh`).

import { webRTC, webRTCDirect } from '@libp2p/webrtc';
import { autoNATv2 } from '@libp2p/autonat-v2';
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { dcutr } from '@libp2p/dcutr';
import { kadDHT } from '@libp2p/kad-dht';
import { keychain } from '@libp2p/keychain';
import { http as httpService, type HTTP } from '@libp2p/http';
import type { Datastore } from 'interface-datastore';
import type { Multiaddr } from '@multiformats/multiaddr';

import type { MeshConfig } from './config.js';
import { meshEndpoint } from './endpoint.js';
import {
  WEBRTC_CERT_LIFESPAN_MS,
  dhtProtocol,
  type MeshNetworkName,
} from './constants.js';

/**
 * The mesh's listen addresses, prepended with the plain listen address
 * the `NetNode` already carries. A private role adds a bare `/webrtc`
 * marker so each circuit reservation publishes
 * `<relay>/p2p-circuit/webrtc/p2p/<self>`
 * (`@libp2p/webrtc@7.0.2`'s `WebRTCPeerListener` encapsulates `/webrtc`
 * onto every circuit listener's addresses,
 * `private-to-private/listener.ts:41-52`). Any later de-duplication is
 * libp2p's.
 */
export function meshListenAddrs(
  plainListen: string,
  mesh: MeshConfig,
): string[] {
  const out = [plainListen, ...mesh.listen];
  if (mesh.role === 'private' && !out.includes('/webrtc')) {
    out.push('/webrtc');
  }
  return out;
}

/**
 * `MESH_INTERFACE → NAT → "A public node announces its listen addresses from the start"`
 * — the same paragraph's close names the private role: a private
 * node announces its relay reservations alone. libp2p 3.5's
 * `AddressManager` runs this filter over every address it would
 * otherwise announce (`libp2p/src/address-manager/index.js`
 * `getAddresses()`), and this filter keeps `/p2p-circuit`-bearing
 * addresses and drops the rest.
 */
export function privateAnnounceFilter(mas: Multiaddr[]): Multiaddr[] {
  return mas.filter((ma) => ma.toString().includes('/p2p-circuit'));
}

/**
 * `MESH_INTERFACE → NAT → "A public node announces its listen addresses from the start"`
 * — the public role's `addresses.announce`. With an explicit
 * `mesh.announce`, that list is announced verbatim; otherwise every
 * entry in `listen` with a concrete port is announced, so libp2p
 * 3.5's `AddressManager` returns the listen addresses as verified
 * from the start (`libp2p/src/address-manager/transport-addresses.ts`
 * would otherwise hold a public IP out until AutoNAT confirms). An
 * entry with `/tcp/0` or `/udp/0` is dropped: the kernel picks the
 * port at bind, so announcing it would be a lie; libp2p 3.5's
 * WebRTC-direct listener splices `/certhash/` onto every announced
 * WebRTC-direct address at read time
 * (`@libp2p/webrtc@7.0.2/src/private-to-public/listener.ts`
 * `updateAnnounceAddrs`, called by `AddressManager.getAddressesWithMetadata`).
 * A `private` role returns `undefined` — `privateAnnounceFilter`
 * carries the private rule, announcing its relay reservations alone.
 */
export function effectiveAnnounce(
  listen: readonly string[],
  mesh: MeshConfig,
): string[] | undefined {
  if (mesh.announce !== undefined && mesh.announce.length > 0) {
    return [...mesh.announce];
  }
  if (mesh.role !== 'public') return undefined;
  const concrete = listen.filter((a) => !/\/(tcp|udp)\/0(?:\/|$)/.test(a));
  if (concrete.length === 0) return undefined;
  return concrete;
}

/**
 * A public mesh node's service map addition. The caller spreads this
 * beside its `pubsub`, `identify`, `ping` entries at `createLibp2p`.
 */
export function meshPublicServices(mesh: MeshConfig, _datastore: Datastore): {
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
 * A private mesh node's service map addition. The DHT runs in client
 * mode so the private node does not answer the server-side protocol;
 * DCUtR upgrades a relayed connection to a direct one where NATs
 * allow (`MESH_INTERFACE → NAT`). A private node runs no AutoNAT and
 * no circuit-relay server.
 */
export function meshPrivateServices(mesh: MeshConfig, _datastore: Datastore): {
  http: ReturnType<typeof httpService>;
  keychain: ReturnType<typeof keychain>;
  dht: ReturnType<typeof kadDHT>;
  dcutr: ReturnType<typeof dcutr>;
} {
  return {
    http: httpService({
      server: meshEndpoint(mesh.httpBase, { upstreamTimeoutMs: mesh.upstreamTimeoutMs }),
    }),
    keychain: keychain(),
    dht: kadDHT({
      protocol: dhtProtocol(mesh.network as MeshNetworkName),
      clientMode: true,
    }),
    dcutr: dcutr(),
  };
}

/**
 * The mesh's WebRTC-direct transport — public and private alike. The
 * empty `iceServers` list disables libp2p's `DEFAULT_ICE_SERVERS`
 * fallback (`@libp2p/webrtc@7.0.2/src/constants.ts:12`); WebRTC-direct
 * to a public address needs none, since STUN carries the relayed
 * WebRTC path alone (`MESH_INTERFACE → NAT → "Every STUN server is a mesh node named by IP"`).
 * The lifespan is pinned past any operator horizon, holding the
 * certhash an anchor lists steady across restarts
 * (`MESH_INTERFACE → Transports → "The WebRTC-direct certificate persists"`).
 */
export function meshWebRTCDirectTransport(): ReturnType<typeof webRTCDirect> {
  return webRTCDirect({
    rtcConfiguration: { iceServers: [] },
    certificateLifespan: WEBRTC_CERT_LIFESPAN_MS,
  });
}

/**
 * A private mesh node's WebRTC transport, signalled through a relay.
 * The configured `stunServers` reach every new peer connection —
 * `@libp2p/webrtc@7.0.2/src/private-to-private/transport.js:100,143`
 * reads `rtcConfiguration` at each dial — so a changing STUN list
 * does not need a restart. `MESH_INTERFACE → NAT → "Every STUN server
 * is a mesh node named by IP"`.
 */
export function meshPrivateWebRTCTransport(
  stunServers: readonly string[],
): ReturnType<typeof webRTC> {
  const servers = [...stunServers];
  return webRTC({
    rtcConfiguration: () => ({
      iceServers: servers.map((url) => ({ urls: url })),
    }),
  });
}

/**
 * A private mesh node's circuit-relay transport. Each configured
 * relay takes its reservation in parallel; the PeerQueue of
 * `DEFAULT_RESERVATION_CONCURRENCY = 1` would otherwise serialize
 * them and a stall on one would block every other
 * (`@libp2p/circuit-relay-v2@4.2.17/src/transport/reservation-store.ts`).
 */
export function meshPrivateCircuitTransport(
  relayCount: number,
): ReturnType<typeof circuitRelayTransport> {
  return circuitRelayTransport({
    reservationConcurrency: Math.max(1, relayCount),
  });
}

export type { HTTP };
