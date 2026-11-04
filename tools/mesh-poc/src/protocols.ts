// The client's local cadences (`MESH_INTERFACE → The client's node list`);
// the rest come from `@dagsocial/net/browser` (`MESH_INTERFACE → Place in
// the workspace`).

export {
  dhtProtocol,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  RELAY_LISTEN_TIMEOUT_MS,
  CERT_RETRY_MS,
  STUN_PORT,
} from '@dagsocial/net/browser';
export type { MeshNetworkName as NetworkName } from '@dagsocial/net/browser';

export const CHECK_INTERVAL_MS: 30000 = 30000;
export const DIAL_TIMEOUT_MS: 3000 = 3000;
/**
 * MESH_INTERFACE → The client's node list — "`PEER_DIAL_MIN_MS` | `20_000` |
 * 20 s, the shortest deadline one node's dial gets — libp2p gives each
 * address 6 s of its own, and a relayed address dials the relay first".
 * The whole-peer dial deadline is `max(addrs.length · DIAL_TIMEOUT_MS,
 * PEER_DIAL_MIN_MS)`.
 */
export const PEER_DIAL_MIN_MS: 20000 = 20000;
/**
 * MESH_INTERFACE → The client's node list → "A routed read goes to a
 * node its need allows" — "the fast set is each node whose speed is
 * within `FAST_SET_FACTOR` times the fastest's plus `FAST_SET_SLACK_MS`".
 */
export const FAST_SET_FACTOR: 2 = 2;
export const FAST_SET_SLACK_MS: 50 = 50;
/**
 * MESH_INTERFACE → The client's node list — "the most STUN servers a
 * client's ICE configuration names", the `STUN_SERVERS_MAX` row of
 * the constants table.
 */
export const STUN_SERVERS_MAX: 3 = 3;
/**
 * MESH_INTERFACE → The client's node list — "`BLOCK_READ_BYTES`
 * | `8_388_608` | 8 MiB, the cap on a fill's `GET /blocks/:height`".
 * The fill reads a block's whole JSON for its header; the body carries
 * the ordering block's list entries beside it, so the cap is argued
 * from `MAX_BLOCK_BODY_BYTES` and not from the header's own size.
 */
export const BLOCK_READ_BYTES: 8_388_608 = 8_388_608;
