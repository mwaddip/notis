// MESH_INTERFACE → The node endpoint — a node's mesh service answers HTTP
// over libp2p (`@libp2p/http`) by forwarding each `GET` to its own Notis
// node's HTTP base and answering with the upstream's status, `content-type`
// and body bytes as they came. Any other method answers 405.
//
// Node-only: it reads from an upstream HTTP server, which is a Node.js
// service (`MESH_INTERFACE → Place in the workspace`).

import type { Libp2p } from '@libp2p/interface';
import type { HTTP } from '@libp2p/http';

export function forwardNodeApi(
  _node: Libp2p<{ http: HTTP }>,
  _upstream: string,
): void {
  throw new Error('not implemented yet');
}
