// MESH_INTERFACE → FIPS → "A node peers with the public FIPS mesh when
// its operator turns it on" — the UDP transport's types and stubs,
// opened first for the cases in `test/mesh/fips-udp.test.ts` to run
// red. The next commit replaces the stubs with the real implementation.

import type {
  DiscoveredPeer,
  Transport,
  TransportAddress,
  TransportContext,
} from '@fips/core';

import { FIPS_LINK_MTU, type PublicFipsPeer } from './constants.js';

/**
 * MESH_INTERFACE → FIPS → "A node peers with the public FIPS mesh when
 * its operator turns it on" — thrown by `send` when its caller
 * addresses a UDP address the transport did not dial and has not taken
 * as an inbound link.
 */
export class UdpFipsSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UdpFipsSendError';
  }
}

/**
 * MESH_INTERFACE → FIPS → "A node peers with the public FIPS mesh when
 * its operator turns it on" — options the `UdpFipsTransport`
 * constructor takes.
 */
export interface UdpFipsTransportOptions {
  readonly listen: { host: string; port: number } | null;
  readonly peers: readonly PublicFipsPeer[];
  readonly inboundMax: number;
  readonly resolve?: (host: string) => Promise<string[]>;
  readonly random?: () => number;
  readonly logger?: unknown;
}

/**
 * MESH_INTERFACE → FIPS → "A node peers with the public FIPS mesh when
 * its operator turns it on" — a fips-ts `Transport` that carries one
 * FIPS packet per UDP datagram. This stub answers to every method with
 * a throw so the cases under `test/mesh/fips-udp.test.ts` run red
 * before the real implementation lands in the next commit.
 */
export class UdpFipsTransport implements Transport {
  readonly type = 'udp';
  readonly mtu: number = FIPS_LINK_MTU;
  readonly maxFrameBytes: number = FIPS_LINK_MTU;

  constructor(_options: UdpFipsTransportOptions) {
    // Stub — the next commit holds the implementation.
    throw new Error('UdpFipsTransport: not yet implemented');
  }

  async start(_ctx: TransportContext): Promise<void> {
    throw new Error('UdpFipsTransport.start: not yet implemented');
  }

  async stop(): Promise<void> {
    throw new Error('UdpFipsTransport.stop: not yet implemented');
  }

  async connect(_addr: TransportAddress): Promise<void> {
    throw new Error('UdpFipsTransport.connect: not yet implemented');
  }

  async send(_addr: TransportAddress, _packet: Uint8Array): Promise<void> {
    throw new UdpFipsSendError('UdpFipsTransport.send: not yet implemented');
  }

  // eslint-disable-next-line require-yield
  async *discover(): AsyncIterable<DiscoveredPeer> {
    throw new Error('UdpFipsTransport.discover: not yet implemented');
  }

  noteLink(_addr: string, _up: boolean): void {
    throw new Error('UdpFipsTransport.noteLink: not yet implemented');
  }

  listenPort4(): number | null {
    return null;
  }
  listenPort6(): number | null {
    return null;
  }
  yieldsForAddr(_addr: string): number {
    return 0;
  }
}
