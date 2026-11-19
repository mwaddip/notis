// MESH_INTERFACE → FIPS → "A node's FIPS address is `/fips/<npub>/p2p/<peer id>`"
// — the `fips` multiaddr protocol is Notis's, numbered `FIPS_MULTIADDR_CODE`
// from multicodec's private-use range: its value is the npub as text and
// the 32-byte x-only key as bytes.
//
// Browser-safe: imports no Node built-in.

import type { Multiaddr } from '@multiformats/multiaddr';

export const FIPS_PROTOCOL_NAME = 'fips';

/**
 * MESH_INTERFACE → FIPS → "A node's FIPS address is `/fips/<npub>/p2p/<peer id>`"
 * — register the `fips` multiaddr protocol with `@multiformats/multiaddr`'s
 * `registry`. Idempotent: a second call does not throw.
 */
export function registerFipsProtocol(): void {
  throw new Error('unimplemented');
}

/**
 * MESH_INTERFACE → FIPS → "A node's FIPS address is `/fips/<npub>/p2p/<peer id>`"
 * — build the multiaddr `/fips/<npub>/p2p/<peerId>` from the key's x-only
 * form and the libp2p peer id.
 */
export function fipsMultiaddr(_xOnly: Uint8Array, _peerId: string): Multiaddr {
  throw new Error('unimplemented');
}

/**
 * MESH_INTERFACE → FIPS → "A node's FIPS address is `/fips/<npub>/p2p/<peer id>`"
 * — read the x-only key and the peer id from a `/fips/<npub>/p2p/<peerId>`
 * multiaddr, or answer null when the address is not exactly that shape.
 */
export function parseFipsMultiaddr(
  _ma: Multiaddr,
): { xOnly: Uint8Array; peerId: string } | null {
  throw new Error('unimplemented');
}

/**
 * MESH_INTERFACE → FIPS → "A node's FIPS address is `/fips/<npub>/p2p/<peer id>`"
 * — true when the first component of `ma` is the `fips` protocol.
 */
export function isFipsMultiaddr(_ma: Multiaddr): boolean {
  throw new Error('unimplemented');
}
