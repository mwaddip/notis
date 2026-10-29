// The importable entry — re-exports only, no side effect at import time.

// Browser-safe exports only. `loadOrCreateNodeKey` reads a file and lives in
// `src/node/` (`MESH_INTERFACE → Place in the workspace`).
export { MeshKeyError, nodeKeyFromKeyPair, peerIdFromNotisId, notisIdFromPeerId } from './identity.js';
export type { NodeKey } from './identity.js';

export { MeshUrlError, meshBaseUrl, parseMeshUrl } from './mesh-url.js';

export {
  dhtProtocol,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  CHECK_INTERVAL_MS,
  CERT_RETRY_MS,
  STUN_PORT,
} from './protocols.js';
export type { NetworkName } from './protocols.js';
