// MESH_INTERFACE → Place in the workspace — the Node-side library entry
// a stage script imports to start a mesh node of its own (the hostile
// gossip publisher runs through this entry). The browser-safe shape
// stays in `../lib.ts`; this module re-exports the Node-only members
// `../lib.ts` does not carry.

export {
  startMeshNode,
  effectiveAnnounce,
  retryIntervalMs,
  MeshConfigError,
} from './mesh-node.js';
export type { MeshNodeOptions, MeshNode } from './mesh-node.js';

export { blockTopic, gossipsubOptions, GOSSIP_SEEN_WINDOW_MS } from '../gossip-rules.js';
export type { GossipsubOptionsShape } from '../gossip-rules.js';

export { loadOrCreateNodeKey } from './key-store.js';
export { nodeKeyFromKeyPair } from '../identity.js';
export type { NodeKey } from '../identity.js';
export type { NetworkName } from '../protocols.js';
