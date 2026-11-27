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
 * MESH_INTERFACE → The client's node list → "Retry" — after the n-th
 * failure in a row the wait is drawn uniformly between half and the
 * whole of `min(RETRY_CAP_MS, RETRY_BASE_MS · 2^(n−1))`. A private
 * node's relay retry draws its wait the same way
 * (MESH_INTERFACE → NAT → "A relay that does not answer never stops a
 * private node").
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
 * MESH_INTERFACE → FIPS → "A node's FIPS address is `/fips/<npub>/p2p/<peer id>`"
 * — the `fips` multiaddr protocol's code, in multicodec's private-use range.
 */
export const FIPS_MULTIADDR_CODE: 0x300f15 = 0x300f15;

/**
 * MESH_INTERFACE → FIPS → "Each side names its key first" — bytes in one
 * FIPS packet on a link, and the length-prefixed frame's cap.
 */
export const FIPS_LINK_MTU: 1357 = 1357;

/**
 * MESH_INTERFACE → FIPS → "A key holds one link, and the libp2p peer that
 * named it holds the key" — 5 s for a link stream's first frame, and 5 s
 * more for its link to come up.
 */
export const FIPS_LINK_HINT_TIMEOUT_MS: 5000 = 5000;

/**
 * MESH_INTERFACE → FIPS → "libp2p runs over a TCP/FIPS stream" — the FIPS
 * service port the TCP/FIPS endpoint carries its datagrams on.
 */
export const FIPS_SERVICE_PORT: 9733 = 9733;

/**
 * MESH_INTERFACE → FIPS → "libp2p runs over a TCP/FIPS stream" — a TCP/FIPS
 * endpoint is polled this often for its timers; its reads and accepts wake
 * on each inbound datagram, not on the poll.
 */
export const FIPS_TCP_POLL_MS: 50 = 50;

/**
 * MESH_INTERFACE → FIPS → "libp2p runs over a TCP/FIPS stream" — a TCP/FIPS
 * stream's unsent-data high-water mark; past it the libp2p connection
 * reports it cannot send more until its send buffer drains below the mark.
 */
export const FIPS_TCP_SEND_BUFFER_BYTES: 65536 = 65536;

/**
 * MESH_INTERFACE → FIPS → "libp2p runs over a TCP/FIPS stream" — a peer
 * holds at most this many TCP/FIPS connections to a node at once.
 */
export const FIPS_TCP_CONNECTIONS_PER_PEER: 2 = 2;

/**
 * MESH_INTERFACE → FIPS → "A reader links when a node's every other
 * address failed" — the links a reader holds; one, so the node a FIPS
 * connection was routed through is the node its link rides.
 */
export const FIPS_READER_LINKS_MAX: 1 = 1;

/**
 * MESH_INTERFACE → FIPS → "A FIPS link that carries nothing for
 * `FIPS_LINK_DEAD_MS` ends" — 30 s with nothing received ends a FIPS link
 * over libp2p and over UDP alike, as the original FIPS daemon ends one:
 * its `node.link_dead_timeout_secs` is 30 s by default and never less.
 * Anything authenticated the far end sends on the link resets the stamp.
 * The `@fips/core` patch holds the same value as a literal since a patch
 * cannot import a workspace package.
 */
export const FIPS_LINK_DEAD_MS: 30000 = 30000;

/**
 * MESH_INTERFACE → FIPS → "A FIPS session that carries no application data
 * for `FIPS_SESSION_IDLE_MS` ends" — 90 s with no application data ends a
 * FIPS session, as the original FIPS daemon ends one, so a session with one
 * ends at both ends together and the next datagram opens a fresh session.
 * The `@fips/core` patch holds the same value as a literal since a patch
 * cannot import a workspace package.
 */
export const FIPS_SESSION_IDLE_MS: 90000 = 90000;

/**
 * MESH_INTERFACE → FIPS → "A public peer is an npub at a `host:port`" —
 * the port a `FIPS_PUBLIC_PEERS` entry that names none takes, and the
 * port of every built-in peer; FIPS's own UDP port.
 */
export const FIPS_UDP_DEFAULT_PORT: 2121 = 2121;

/**
 * MESH_INTERFACE → FIPS → "A node peers with the public FIPS mesh when
 * its operator turns it on" — the most public peers a node dials,
 * built-in or the operator's; room to double the built-in list's seven.
 */
export const FIPS_PUBLIC_PEERS_MAX: 16 = 16;

/**
 * MESH_INTERFACE → FIPS → "A node may accept public links" — the public
 * links a node holds that it did not dial; a datagram from a new
 * address past the cap is dropped, and a held link is never closed to
 * make room.
 */
export const FIPS_PUBLIC_INBOUND_MAX: 256 = 256;

/**
 * MESH_INTERFACE → FIPS → "A public peer is an npub at a `host:port`" —
 * one row of the FIPS public mesh's built-in peer list.
 */
export interface PublicFipsPeer {
  readonly name: string;
  readonly npub: string;
  readonly host: string;
  readonly port: number;
}

/**
 * MESH_INTERFACE → FIPS → "The built-in list is the public test nodes" —
 * the seven public test nodes the FIPS project keeps for new nodes and
 * integration testing, in the contract's order. Each accepts a link
 * from any npub.
 */
export const PUBLIC_FIPS_PEERS: readonly PublicFipsPeer[] = [
  { name: 'test-us01', npub: 'npub1qmc3cvfz0yu2hx96nq3gp55zdan2qclealn7xshgr448d3nh6lks7zel98', host: 'test-us01.fips.network', port: FIPS_UDP_DEFAULT_PORT },
  { name: 'test-us02', npub: 'npub10yffd020a4ag8zcy75f9pruq3rnghvvhd5hphl9s62zgp35s560qrksp9u', host: 'test-us02.fips.network', port: FIPS_UDP_DEFAULT_PORT },
  { name: 'test-us03', npub: 'npub136yqae6na688fs75g95ppps3lxe07fvxefj77938zf47uhm6074sxw8ctm', host: 'test-us03.fips.network', port: FIPS_UDP_DEFAULT_PORT },
  { name: 'test-us04', npub: 'npub1gd7ye2qp2lphhzx75fynnjzaxx4dqanddecet0wtt5ss5ek8h9ps62wdkf', host: 'test-us04.fips.network', port: FIPS_UDP_DEFAULT_PORT },
  { name: 'test-de01', npub: 'npub1260n42s06vzc7796w0fh3ny7zcpw6tlk4gq3940gmfrzl5c9pv2s3657q8', host: 'test-de01.fips.network', port: FIPS_UDP_DEFAULT_PORT },
  { name: 'test-es01', npub: 'npub17lpmzulpc98d8ff727k6e98atxn3phzupzsqqwe54ytduym747ws4tw5zm', host: 'test-es01.fips.network', port: FIPS_UDP_DEFAULT_PORT },
  { name: 'test-uk01', npub: 'npub1u0z26dc4qeneu5rvwvmpfhtwh3522ed6rlgxr9jarrfnjrc6ew4qxjysrs', host: 'test-uk01.fips.network', port: FIPS_UDP_DEFAULT_PORT },
];

/**
 * MESH_INTERFACE → Discovery → "The DHT is Notis's own" — Kademlia runs
 * on `/notis/<network>/kad/1.0.0`, never on libp2p's default. Pure.
 */
export type MeshNetworkName = 'devnet' | 'testnet' | 'mainnet';

export function dhtProtocol(network: MeshNetworkName): string {
  return `/notis/${network}/kad/1.0.0`;
}
