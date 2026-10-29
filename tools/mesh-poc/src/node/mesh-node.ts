// MESH_INTERFACE → Place in the workspace / Transports / NAT / Discovery /
// The node endpoint — a mesh node is a libp2p host that forwards HTTP over
// libp2p to its own Notis node and runs the Notis Kademlia protocol alone.
// Node-only: TCP, the file-backed datastore and the WebRTC-direct listener's
// native binding keep it out of the browser (`MESH_INTERFACE → Place in the
// workspace`).

import type { Libp2p } from '@libp2p/interface';
import type { HTTP } from '@libp2p/http';
import type { NodeKey } from '../identity.js';
import type { NetworkName } from '../protocols.js';

/**
 * MESH_INTERFACE → Transports / Discovery — a start-time refusal: a
 * `/dns4/`, `/dns6/` or `/dnsaddr/` component in a `listen`, `announce` or
 * `bootstrap` address, or a `bootstrap` address without a `/p2p/` component.
 */
export class MeshConfigError extends Error {
  override readonly name = 'MeshConfigError';
}

export interface MeshNodeOptions {
  readonly key: NodeKey;
  readonly network: NetworkName;
  readonly role: 'public' | 'private';
  readonly listen: string[];
  readonly announce?: string[];
  readonly bootstrap: string[];
  readonly stateDir: string;
  readonly upstream: string;
}

export interface MeshNode {
  readonly libp2p: Libp2p<{ http: HTTP }>;
  multiaddrs(): string[];
  stop(): Promise<void>;
}

export async function startMeshNode(_opts: MeshNodeOptions): Promise<MeshNode> {
  throw new Error('not implemented yet');
}
