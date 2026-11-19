// MESH_INTERFACE → FIPS → "A link rides a libp2p connection the two ends already hold"
// — a fips-ts `Transport` that carries FIPS link packets on a libp2p protocol
// stream over a connection two Notis ends already hold. Browser-safe: imports
// no Node built-in and reads no Node global.
//
// The holding rules of MESH_INTERFACE → FIPS → "A key holds one link, and the
// libp2p peer that named it holds the key": one link per key; the same peer's
// later stream replaces the link where that peer opened it too; the lower
// key's stream kept on a simultaneous open; another peer's stream closed; a
// link not up within `hintTimeoutMs` of its key frames closed; an ended link
// reopened by its opener over a connection it still holds after
// `retryIntervalMs(failures, retryBaseMs, retryCapMs, random)`; `linkUp`
// resets the count.

import type {
  Transport,
  TransportAddress,
  TransportContext,
} from '@fips/core';
import type { Connection, Libp2p, Stream } from '@libp2p/interface';
import { FIPS_LINK_HINT_TIMEOUT_MS, FIPS_LINK_MTU } from './constants.js';
import type { MeshNetworkName } from './constants.js';

/**
 * MESH_INTERFACE → FIPS → "A link rides a libp2p connection the two ends
 * already hold" — the link protocol a libp2p stream carries FIPS packets on,
 * named for the network: `/notis/<network>/fips-link/1.0.0`.
 *
 * Stub ahead of code answers a placeholder that fails the shape assertion.
 */
export function fipsLinkProtocol(network: MeshNetworkName): string {
  return `/notis/${network}/fips-link/0.0.0`;
}

/**
 * MESH_INTERFACE → FIPS → "A key holds one link, and the libp2p peer that
 * named it holds the key" — the options every LibP2pLinkTransport takes;
 * every field required. The stack (a node's build of the transport) passes
 * `(addr) => fipsNode.connect(addr)`, `FIPS_LINK_HINT_TIMEOUT_MS`,
 * `RETRY_BASE_MS`, `RETRY_CAP_MS`, and `Math.random`. Tests pass their own.
 */
export interface LibP2pLinkTransportOptions {
  readonly network: MeshNetworkName;
  readonly connectPeer: (addr: TransportAddress) => Promise<void>;
  readonly hintTimeoutMs: number;
  readonly retryBaseMs: number;
  readonly retryCapMs: number;
  readonly random: () => number;
}

/**
 * MESH_INTERFACE → FIPS → "A link rides a libp2p connection the two ends
 * already hold" — a fips-ts Transport that carries FIPS packets on a libp2p
 * protocol stream.
 *
 * Methods are stubs ahead of code; see `MESH_INTERFACE → FIPS`.
 */
export class LibP2pLinkTransport implements Transport {
  readonly type = 'notis-libp2p';
  readonly mtu: number = FIPS_LINK_MTU;
  readonly maxFrameBytes: number = FIPS_LINK_MTU;

  readonly options: LibP2pLinkTransportOptions;
  context: TransportContext | null = null;

  constructor(options: LibP2pLinkTransportOptions) {
    // FIPS_LINK_HINT_TIMEOUT_MS is read here so the constant import is used
    // under the stub; the deadline the stub's hint timeout is handed stays
    // the caller's own value, as the constructor's contract says.
    void FIPS_LINK_HINT_TIMEOUT_MS;
    this.options = options;
  }

  async start(ctx: TransportContext): Promise<void> {
    this.context = ctx;
  }

  async stop(): Promise<void> {
    this.context = null;
  }

  async connect(_addr: TransportAddress): Promise<void> {
    // Stub ahead of code (MESH_INTERFACE → FIPS → "A key holds one link,
    // and the libp2p peer that named it holds the key") — connect answers
    // where a stream is held for the address, so the stub answers nothing.
  }

  async send(_addr: TransportAddress, _packet: Uint8Array): Promise<void> {
    // Stub ahead of code — the real send writes to the held stream.
  }

  async close(_addr: TransportAddress): Promise<void> {
    // Stub ahead of code.
  }

  /**
   * MESH_INTERFACE → FIPS → "Each side names its key first" — the handler
   * for the link protocol; the stack calls this after `createLibp2p`.
   */
  async attach(libp2p: Libp2p): Promise<void> {
    // The protocol is registered so an inbound stream negotiates; the
    // handler holds nothing yet (MESH_INTERFACE → FIPS → "A key holds one
    // link, and the libp2p peer that named it holds the key").
    await libp2p.handle(
      fipsLinkProtocol(this.options.network),
      () => {},
      { maxInboundStreams: 1 },
    );
  }

  /**
   * MESH_INTERFACE → FIPS → "A node opens a link over each connection it
   * dialled to a Notis peer" — opens a link stream on an existing libp2p
   * connection, exchanges keys, and answers the remote compressed key hex.
   */
  async openLink(_connection: Connection): Promise<string> {
    // Stub ahead of code — the real openLink opens the stream and runs the
    // key exchange.
    return '';
  }

  /**
   * MESH_INTERFACE → FIPS → "A link is up once FIPS's own handshake over it
   * completes" — the stack calls this on fips-ts's `peer` event with
   * `state: 'connected'`, which resets the opener's retry count.
   */
  linkUp(_remoteKeyHex: string): void {
    // Stub ahead of code.
  }

  /**
   * MESH_INTERFACE → FIPS → "A key holds one link, and the libp2p peer that
   * named it holds the key" — the keys whose links are up.
   */
  linkedKeys(): string[] {
    return [];
  }
}

// Reference the Stream type so an editor import resolves in both entries
// while the stub holds no logic that uses it.
export type FipsLinkStream = Stream;
