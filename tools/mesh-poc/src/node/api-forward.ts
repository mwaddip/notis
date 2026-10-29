// MESH_INTERFACE → The node endpoint — a node's mesh service answers HTTP
// over libp2p (`@libp2p/http`) by forwarding each `GET` to its own Notis
// node's HTTP base and answering with the upstream's status, `content-type`
// and body bytes as they came. Any other method answers 405. The server is
// built by passing this factory's `WebServer` to `http({ server })` at
// libp2p construction.
//
// Node-only: it reads from an upstream HTTP server, which is a Node.js
// service (`MESH_INTERFACE → Place in the workspace`).

import type { WebServer } from '@libp2p/http';

export function nodeApiServer(
  _upstream: string,
  _opts?: { upstreamTimeoutMs?: number },
): WebServer {
  throw new Error('not implemented yet');
}
