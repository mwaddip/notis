// MESH_INTERFACE → Transports → "The WebRTC-direct certificate persists" —
// the WebRTC-direct certificate lives as long as the node's key. The
// certhash rides in the address an anchor lists, so a renewal leaves every
// anchor naming the node unreachable until it is reissued. A state
// directory whose certificate cannot be read stops the node at start
// (`MESH_INTERFACE → Transports → "The WebRTC-direct certificate
// persists"`), so the lifespan is pinned past any operator horizon and
// the renewal path stays cold.
//
// Pinned to 100 years (100 × 365.25 × 86_400_000 ms): comfortably inside
// X.509 GeneralizedTime (year 9999 max) and ECMAScript Date, and far past
// Node's 2^31 − 1 ms `setTimeout` limit — which is why `@libp2p/webrtc@7.0.2`
// carries a patch that re-arms its renewal timer in bounded steps
// (MESH_INTERFACE → Place in the workspace → "libp2p is pinned").
export const WEBRTC_CERT_LIFESPAN_MS = 3_155_760_000_000;

/**
 * MESH_INTERFACE → NAT — "Every STUN server is a mesh node named by IP";
 * a public node runs a STUN server on `STUN_PORT` (RFC 8489's port) at
 * the IP of its first WebRTC-direct listen address, unless its operator
 * names another or turns it off.
 */
export const STUN_PORT: 3478 = 3478;

/**
 * MESH_INTERFACE → NAT — "A relay that does not answer never stops a
 * private node ... is tried again on the node list's retry cadence
 * (`RETRY_BASE_MS` doubling to `RETRY_CAP_MS`)".
 */
export const RETRY_BASE_MS: 5000 = 5000;
export const RETRY_CAP_MS: 600000 = 600000;

/**
 * MESH_INTERFACE → NAT — "every attempt under `RELAY_LISTEN_TIMEOUT_MS`".
 * A `transportManager.listen([<circuit>])` whose reservation does not
 * complete inside this deadline rejects.
 */
export const RELAY_LISTEN_TIMEOUT_MS: 10000 = 10000;

/**
 * MESH_INTERFACE → The IP certificate — the cadence a public node retries
 * `obtain()` at when no certificate has arrived yet.
 */
export const CERT_RETRY_MS: 3600000 = 3600000;

/**
 * MESH_INTERFACE → Discovery → "The DHT is Notis's own" — Kademlia runs
 * on `/notis/<network>/kad/1.0.0`, never on libp2p's default. Pure.
 */
export type MeshNetworkName = 'devnet' | 'testnet' | 'mainnet';

export function dhtProtocol(network: MeshNetworkName): string {
  return `/notis/${network}/kad/1.0.0`;
}
