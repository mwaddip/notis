// The mesh service's key file is read by `net`'s `loadNodeKey`
// (`MESH_INTERFACE → Identity → "The key persists"`). The service wraps the
// `KeyPair` as a `NodeKey` for its two spellings
// (`MESH_INTERFACE → Identity → "One key, two spellings"`).

import { loadNodeKey } from '@dagsocial/net';
import { nodeKeyFromKeyPair } from '../identity.js';
import type { NodeKey } from '../identity.js';

export async function loadOrCreateNodeKey(path: string): Promise<NodeKey> {
  return nodeKeyFromKeyPair(await loadNodeKey(path));
}
