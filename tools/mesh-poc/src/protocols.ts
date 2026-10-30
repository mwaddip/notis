// The contract's numbers in one place (`MESH_INTERFACE → Discovery`,
// `MESH_INTERFACE → The client's node list`, `MESH_INTERFACE → NAT`,
// `MESH_INTERFACE → The IP certificate`).

export type NetworkName = 'devnet' | 'testnet' | 'mainnet';

export function dhtProtocol(network: NetworkName): string {
  return `/notis/${network}/kad/1.0.0`;
}

export const RETRY_BASE_MS: 5000 = 5000;
export const RETRY_CAP_MS: 600000 = 600000;
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
 * MESH_INTERFACE → The client's node list — "`RELAY_LISTEN_TIMEOUT_MS`
 * | `10_000` | 10 s for one attempt at a relay reservation; past it
 * the attempt is a failure and the relay is tried again on the retry
 * cadence". A `transportManager.listen([<circuit>])` whose
 * reservation does not complete inside this deadline rejects, and
 * `startRelayRetry` schedules the next attempt per `retryIntervalMs`.
 */
export const RELAY_LISTEN_TIMEOUT_MS: 10000 = 10000;
export const CERT_RETRY_MS: 3600000 = 3600000;
export const STUN_PORT: 3478 = 3478;
