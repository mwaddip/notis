// The importable entry — re-exports only, no side effect at import time.
// Browser-safe exports only; anything that reads a file is kept out of this
// module's reach (`MESH_INTERFACE → Place in the workspace`).

export { MeshKeyError, nodeKeyFromKeyPair, peerIdFromNotisId, notisIdFromPeerId } from './identity.js';
export type { NodeKey } from './identity.js';

export { MeshUrlError, meshBaseUrl, parseMeshUrl } from './mesh-url.js';

export { MeshFetchError, meshFetch } from './http-fetch.js';

export { MeshConfigError, assertNoDns } from './config.js';

export { tipEvents } from './client/tip-events.js';
export type { TipEvent } from './client/tip-events.js';

export { startMeshClient } from './client/mesh-client.js';
export type { MeshClient, ClientState } from './client/mesh-client.js';

export { NodeList } from './client/node-list.js';
export type {
  Anchor,
  FailureKind,
  LieEvidence,
  NodeStatus,
  NodeEntry,
} from './client/node-list.js';

export {
  dhtProtocol,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  CHECK_INTERVAL_MS,
  DIAL_TIMEOUT_MS,
  CERT_RETRY_MS,
  STUN_PORT,
} from './protocols.js';
export type { NetworkName } from './protocols.js';
