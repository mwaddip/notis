// NET_INTERFACE → "A mesh node runs a FIPS stack" — the pieces a
// mesh `NetNode` and a reader share: a fips-ts `FipsNode` whose one
// transport carries link packets on libp2p streams, a `FipsTcpEndpoint` on
// `FIPS_SERVICE_PORT` over its datagrams, and the libp2p transport that
// carries libp2p connections on TCP/FIPS streams. Browser-safe: imports
// no Node built-in and reads no Node global.

import { FipsNode, generateIdentity } from '@fips/core';
import type {
  FipsIdentity,
  PeerEvent,
} from '@fips/core';
import { FipsTcpEndpoint } from '@fips/tcp';
import type { Connection, Libp2p } from '@libp2p/interface';
import { LibP2pLinkTransport } from './fips-link.js';
import { fipsDatagramEndpoint, fipsTransport } from './fips-transport.js';
import { registerFipsProtocol } from './fips-addr.js';
// The concrete UDP transport is in a Node-only module
// (`fips-udp.ts` holds `import * as dgram from 'node:dgram'`); this
// file reaches the browser build through `src/browser.ts`' re-export
// of `createFipsStack`, so it declares the surface it reads as a local
// interface and names no type from `fips-udp.ts`. The Node caller
// (`node.ts`) constructs the concrete transport and passes it as
// `options.udp`; `FipsStack.udp` reads back that same instance.
import type { Transport } from '@fips/core';

/**
 * MESH_INTERFACE → FIPS → "A node peers with the public FIPS mesh
 * when its operator turns it on" — the public-peering transport
 * the stack carries beside the link transport: a fips-ts `Transport`
 * that `noteLink(addr, up)` drives, with `listenPort4` / `listenPort6`
 * for the caller's bound-address readback.
 */
export interface UdpFipsLikeTransport extends Transport {
  readonly type: 'udp';
  noteLink(addr: string, up: boolean): void;
  listenPort4(): number | null;
  listenPort6(): number | null;
}
import {
  FIPS_LINK_HINT_TIMEOUT_MS,
  FIPS_SERVICE_PORT,
  FIPS_TCP_CONNECTIONS_PER_PEER,
  FIPS_TCP_POLL_MS,
  FIPS_TCP_SEND_BUFFER_BYTES,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  type MeshNetworkName,
} from './constants.js';

/**
 * NET_INTERFACE → "A mesh node runs a FIPS stack" — the pieces
 * `createFipsStack` builds; `attach(libp2p)` wires them to libp2p and
 * `stop()` reverses every step.
 */
export interface FipsStack {
  readonly identity: FipsIdentity;
  readonly link: LibP2pLinkTransport;
  readonly endpoint: FipsTcpEndpoint;
  readonly transport: ReturnType<typeof fipsTransport>;
  /**
   * MESH_INTERFACE → FIPS → "A node peers with the public FIPS mesh
   * when its operator turns it on" — the public-peering UDP transport
   * when `createFipsStack` was given a `udp` option, `null` otherwise.
   */
  readonly udp: UdpFipsLikeTransport | null;
  attach(libp2p: Libp2p): Promise<void>;
  stop(): Promise<void>;
}

/**
 * NET_INTERFACE → "A mesh node runs a FIPS stack" — the options
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
  /**
   * MESH_INTERFACE → FIPS → "A node peers with the public FIPS mesh
   * when its operator turns it on" — public FIPS peering over UDP.
   * Set, the stack's `FipsNode` runs `[link, udp]` and reads each UDP
   * link's state off the node's `peer` events; absent, the stack runs
   * the link transport alone. The caller constructs the instance:
   * `fips-udp.ts` holds Node's `dgram`/`dns`, which `src/browser.ts`
   * cannot carry.
   */
  readonly udp?: UdpFipsLikeTransport;
}

/**
 * NET_INTERFACE → "A mesh node runs a FIPS stack" — build the
 * link transport, the `FipsNode` over it alone, the datagram endpoint
 * over the node, the TCP/FIPS endpoint on `FIPS_SERVICE_PORT`, and the
 * libp2p transport that carries libp2p connections over its streams.
 * `registerFipsProtocol()` runs first so `fipsMultiaddr` parses before
 * any `addresses.listen` entry names a FIPS address.
 */
export function createFipsStack(options: CreateFipsStackOptions): FipsStack {
  registerFipsProtocol();

  let nodeRef: FipsNode | null = null;
  const link = new LibP2pLinkTransport({
    network: options.network,
    connectPeer: async (addr) => {
      if (nodeRef === null) throw new Error('fips stack not started');
      await nodeRef.connect(addr);
    },
    hintTimeoutMs: FIPS_LINK_HINT_TIMEOUT_MS,
    retryBaseMs: RETRY_BASE_MS,
    retryCapMs: RETRY_CAP_MS,
    random: Math.random,
  });
  // MESH_INTERFACE → FIPS → "A node peers with the public FIPS mesh
  // when its operator turns it on" — the UDP transport runs beside the
  // link transport when the caller hands one in.
  const udp: UdpFipsLikeTransport | null = options.udp ?? null;
  const transports = udp !== null ? [link, udp] : [link];
  const node = new FipsNode({
    identity: options.identity,
    transports,
    forwarding: options.forwarding,
  });
  nodeRef = node;

  const { datagrams, onActivity } = fipsDatagramEndpoint(node);
  // `FipsTcpEndpoint` reads `Partial<Config>` — the sendBuffer, the
  // per-peer connection cap and (where given) a total connection ceiling
  // held against the whole endpoint.
  const endpointConfig: Record<string, number> = {
    sendBuffer: FIPS_TCP_SEND_BUFFER_BYTES,
    maxConnectionsPerPeer: FIPS_TCP_CONNECTIONS_PER_PEER,
  };
  if (options.maxConnections !== undefined) {
    endpointConfig.maxConnections = options.maxConnections;
  }
  const endpoint = new FipsTcpEndpoint(datagrams, FIPS_SERVICE_PORT, endpointConfig);
  let endpointAlive = true;
  const transport = fipsTransport({
    endpoint: () => (endpointAlive ? endpoint : null),
    localXOnly: () => options.identity.xOnlyPubkey,
    dial: options.dial,
    onActivity,
  });

  let libp2pRef: Libp2p | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let peerUnsub: (() => void) | null = null;
  let connectionOpenListener: ((evt: unknown) => void) | null = null;
  let stopped = false;

  const attach = async (libp2p: Libp2p): Promise<void> => {
    if (stopped) throw new Error('fips stack stopped');
    libp2pRef = libp2p;
    await link.attach(libp2p);
    // MESH_INTERFACE → FIPS → "A link is up once FIPS's own handshake
    // over it completes" — the stack resets the opener's retry count on
    // every connected peer.
    peerUnsub = node.on('peer', (data) => {
      const ev = data as PeerEvent;
      if (ev.state === 'connected') link.linkUp(ev.remotePubkey);
      // MESH_INTERFACE → FIPS → "A public peer is an npub at a
      // `host:port`" — the UDP transport reads each link's state
      // off the node's own peer events, so the configured peer's
      // retry count ends when its link comes up.
      if (udp !== null && ev.remoteAddr.transport === 'udp') {
        udp.noteLink(ev.remoteAddr.addr, ev.state === 'connected');
      }
    });
    await node.start();
    pollTimer = setInterval(() => {
      void endpoint.poll().catch(() => { /* a stopped endpoint rejects */ });
    }, FIPS_TCP_POLL_MS);
    if (options.linkOutbound) {
      // MESH_INTERFACE → FIPS → "A node opens a link over each connection
      // it dialled to a Notis peer" — every outbound libp2p connection
      // gets a link stream; an inbound one is answered by the handler
      // `link.attach` registered.
      connectionOpenListener = (evt: unknown): void => {
        const conn = (evt as { detail?: Connection }).detail;
        if (conn === undefined) return;
        if (conn.direction !== 'outbound') return;
        void link.openLink(conn).catch(() => { /* retry drives next */ });
      };
      libp2p.addEventListener('connection:open', connectionOpenListener as EventListener);
    }
  };

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (connectionOpenListener !== null && libp2pRef !== null) {
      try { libp2pRef.removeEventListener('connection:open', connectionOpenListener as EventListener); } catch { /* already */ }
      connectionOpenListener = null;
    }
    if (peerUnsub !== null) {
      try { peerUnsub(); } catch { /* already */ }
      peerUnsub = null;
    }
    try { await link.stop(); } catch { /* already */ }
    try { await node.stop(); } catch { /* already */ }
    endpointAlive = false;
    try { await endpoint.dispose(); } catch { /* already */ }
    libp2pRef = null;
  };

  return {
    identity: options.identity,
    link,
    endpoint,
    transport,
    udp,
    attach,
    stop,
  };
}

/**
 * NET_INTERFACE → "A mesh node runs a FIPS stack" — a reader's FIPS
 * stack. MESH_INTERFACE → FIPS → "Every mesh node is a FIPS node":
 * a reader runs a FIPS node with forwarding off and the default
 * routing mode — carrying nothing for anyone. MESH_INTERFACE → FIPS →
 * "A reader dials over it; a node does not": `dial: true` lets the
 * libp2p transport dial `/fips` addresses; the reader opens no listen
 * address. MESH_INTERFACE → FIPS → "A node opens a link over each
 * connection it dialled to a Notis peer": `linkOutbound: false` holds
 * for a reader, which links by `stack.link.openLink(connection)` over
 * a connection it chooses.
 */
export async function createReaderFips(o: { network: MeshNetworkName }): Promise<FipsStack> {
  const identity = await generateIdentity();
  return createFipsStack({
    identity,
    forwarding: false,
    network: o.network,
    dial: true,
    linkOutbound: false,
  });
}
