// The mesh service's key file is a node key file, read by `net`'s
// `loadNodeKey` under its rule (`MESH_INTERFACE → Identity → "The key
// persists"`, `NET_INTERFACE → The node key → "`net` runs under the key its
// caller hands it"`): created mode `0600` on first start with 48 bytes
// (the RFC 8410 PKCS8 prefix ‖ a 32-byte Ed25519 seed), never overwritten,
// a file of any other form refused with `NodeKeyError` naming the path and
// left as it is. The mesh service wraps the `KeyPair` as a `NodeKey` for
// its two spellings (`MESH_INTERFACE → Identity → "One key, two
// spellings"`).

import { loadNodeKey } from '@dagsocial/net';
import { nodeKeyFromKeyPair } from '../identity.js';
import type { NodeKey } from '../identity.js';

export async function loadOrCreateNodeKey(path: string): Promise<NodeKey> {
  return nodeKeyFromKeyPair(await loadNodeKey(path));
}
