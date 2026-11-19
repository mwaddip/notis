// MESH_INTERFACE → FIPS → "A mesh node runs a FIPS stack" — the pieces a
// mesh `NetNode` and a reader share: a fips-ts `FipsNode` whose one
// transport carries link packets on libp2p streams, a `FipsTcpEndpoint` on
// `FIPS_SERVICE_PORT` over its datagrams, and the libp2p transport that
// carries libp2p connections on TCP/FIPS streams. Browser-safe: imports
// no Node built-in and reads no Node global.

import type { FipsIdentity } from '@fips/core';
import type { FipsTcpEndpoint } from '@fips/tcp';
import type { Libp2p } from '@libp2p/interface';
import type { LibP2pLinkTransport } from './fips-link.js';
import type { fipsTransport } from './fips-transport.js';
import type { MeshNetworkName } from './constants.js';

/**
 * MESH_INTERFACE → FIPS → "A mesh node runs a FIPS stack" — the pieces
 * `createFipsStack` builds; `attach(libp2p)` wires them to libp2p and
 * `stop()` reverses every step.
 */
export interface FipsStack {
  readonly identity: FipsIdentity;
  readonly link: LibP2pLinkTransport;
  readonly endpoint: FipsTcpEndpoint;
  readonly transport: ReturnType<typeof fipsTransport>;
  attach(libp2p: Libp2p): Promise<void>;
  stop(): Promise<void>;
}

/**
 * MESH_INTERFACE → FIPS → "A mesh node runs a FIPS stack" — the options
 * `createFipsStack` takes. Every field required but `maxConnections`;
 * `linkOutbound` opens a link over each connection libp2p dials outbound
 * (MESH_INTERFACE → FIPS → "A node opens a link over each connection it
 * dialled to a Notis peer").
 */
export interface CreateFipsStackOptions {
  readonly identity: FipsIdentity;
  readonly forwarding: boolean;
  readonly network: MeshNetworkName;
  readonly dial: boolean;
  readonly linkOutbound: boolean;
  readonly maxConnections?: number;
}

/**
 * MESH_INTERFACE → FIPS → "A mesh node runs a FIPS stack" — build the
 * link transport, the `FipsNode` over it alone, the datagram endpoint
 * over the node, the TCP/FIPS endpoint on `FIPS_SERVICE_PORT`, and the
 * libp2p transport that carries libp2p connections over its streams.
 */
export function createFipsStack(_options: CreateFipsStackOptions): FipsStack {
  throw new Error('createFipsStack not implemented');
}
