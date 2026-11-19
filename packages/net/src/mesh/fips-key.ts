// MESH_INTERFACE → FIPS → "A node's FIPS key persists" — the one reader
// and writer of a node's FIPS key file. The file holds the 32 raw bytes
// of fips-ts's `FipsIdentity.secretKey`. A file of any other length, a
// secret fips-ts refuses, or a path that cannot be read or written stops
// the node at start with `MeshStateError` naming the path, and the file
// is left as it is.
//
// Node-only: imports `node:fs`.

import type { FipsIdentity } from '@fips/core';

/**
 * MESH_INTERFACE → FIPS → "A node's FIPS key persists" — reads
 * `<stateDir>/fips.key` and answers the identity, writing a fresh one
 * at first start with mode `0600` opened exclusively.
 */
export async function loadFipsKey(_stateDir: string): Promise<FipsIdentity> {
  throw new Error('unimplemented');
}
