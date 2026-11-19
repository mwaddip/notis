// MESH_INTERFACE → FIPS — a node's FIPS key is a secp256k1 key, its npub the
// bech32 spelling of its 32-byte x-only form. A dial addresses it as `02‖x`,
// which reaches a key of either parity (MESH_INTERFACE → FIPS → "A node's
// FIPS address is `/fips/<npub>/p2p/<peer id>`").
//
// Browser-safe: imports no Node built-in.

import type { FipsIdentity } from '@fips/core';

/**
 * MESH_INTERFACE → FIPS → "A node's FIPS address is `/fips/<npub>/p2p/<peer id>`"
 * — the FIPS key's x-only form, bech32-spelled as a NIP-19 npub.
 */
export function npubOf(_id: FipsIdentity): string {
  throw new Error('unimplemented');
}

/**
 * MESH_INTERFACE → FIPS → "A node's FIPS address is `/fips/<npub>/p2p/<peer id>`"
 * — `02‖x`, the even-parity compressed form of an x-only key; a dial
 * addresses the key by it and reaches a key of either parity.
 */
export function dialKeyHex(_xOnly: Uint8Array): string {
  throw new Error('unimplemented');
}
