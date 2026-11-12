// The importable entry — re-exports only, no side effect at import time.
// Browser-safe exports only; anything that reads a file is kept out of this
// module's reach (`MESH_INTERFACE → Place in the workspace`).

// MESH_INTERFACE → Place in the workspace — the browser half is
// `@dagsocial/net/browser`, the one copy: identity, the mesh URL, the mesh
// fetch, BlockCheck and the gossip rules are read from it. This barrel
// carries the re-exports external callers reach.
export {
  MeshKeyError,
  nodeKeyFromKeyPair,
  peerIdFromNotisId,
  notisIdFromPeerId,
} from '@dagsocial/net/browser';
export type { NodeKey } from '@dagsocial/net/browser';

export { MeshUrlError, meshBaseUrl, parseMeshUrl } from '@dagsocial/net/browser';

export { MeshFetchError, meshFetch, meshFetchOverConnection } from '@dagsocial/net/browser';

export { BlockCheck } from '@dagsocial/net/browser';
export type {
  BlockVerdict,
  BlockValidators,
  BlockCheckContext,
} from '@dagsocial/net/browser';

export { MeshConfigError, assertNoDns } from './config.js';

export * from './tip-events.js';
export * from './agreement.js';
export * from './server-pick.js';
export * from './node-list.js';
export * from './header-json.js';
export * from './held-chain.js';
export * from './stun-list.js';
export * from './mesh-client.js';
export * from './memory.js';
export * from './memory-store.js';

export {
  dhtProtocol,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  CHECK_INTERVAL_MS,
  DIAL_TIMEOUT_MS,
  PEER_DIAL_MIN_MS,
  CERT_RETRY_MS,
  STUN_PORT,
  FAST_SET_FACTOR,
  FAST_SET_SLACK_MS,
  STUN_SERVERS_MAX,
  BLOCK_READ_BYTES,
  REMEMBERED_NODES_MAX,
  ANSWERED_FORKS_MAX,
} from './protocols.js';
export type { NetworkName } from './protocols.js';
