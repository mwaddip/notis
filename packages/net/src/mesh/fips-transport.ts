// MESH_INTERFACE → FIPS → "libp2p runs over a TCP/FIPS stream" — a libp2p
// 3.5.1 transport that carries libp2p connections over `@fips/tcp` streams
// on `FIPS_SERVICE_PORT`. Browser-safe: imports no Node built-in and reads
// no Node global.
//
// AHEAD OF CODE (2026-11-19): the shell exports are present; their
// behaviour is missing. The cases in `test/mesh/fips-transport.test.ts`
// run as `it.fails` against this file.

import { transportSymbol, TypedEventEmitter } from '@libp2p/interface';
import type {
  ComponentLogger,
  Connection,
  CreateListenerOptions,
  Listener,
  ListenerEvents,
  Transport,
} from '@libp2p/interface';
import type { Multiaddr } from '@multiformats/multiaddr';
import type { FipsNode } from '@fips/core';
import type { FipsDatagramEndpoint, FipsTcpEndpoint } from '@fips/tcp';
import { isFipsMultiaddr } from './fips-addr.js';

/**
 * MESH_INTERFACE → FIPS → "libp2p runs over a TCP/FIPS stream" — the dial
 * refusal class a caller catches. `name` is `'FipsTransportDialError'`.
 */
export class FipsTransportDialError extends Error {
  readonly name = 'FipsTransportDialError';
}

/**
 * MESH_INTERFACE → FIPS → "libp2p runs over a TCP/FIPS stream" — the shape
 * `fipsTransport` takes. `endpoint` and `localXOnly` are thunks the
 * caller sets once its FIPS stack is up; `dial` is true for a reader
 * and false for a node. `onActivity` wakes pending reads and accepts.
 */
export interface FipsTransportInit {
  readonly endpoint: () => FipsTcpEndpoint | null;
  readonly localXOnly: () => Uint8Array | null;
  readonly dial: boolean;
  readonly onActivity: (wake: () => void) => () => void;
}

/**
 * MESH_INTERFACE → FIPS → "libp2p runs over a TCP/FIPS stream" — the
 * `FipsDatagramEndpoint` an `FipsTcpEndpoint` is built over, delegating
 * to the `FipsNode`. Each `registerService` handler runs the endpoint's
 * handler and fires every `onActivity` subscriber after it returns.
 */
export function fipsDatagramEndpoint(node: FipsNode): {
  datagrams: FipsDatagramEndpoint;
  onActivity: (wake: () => void) => () => void;
} {
  const wakers = new Set<() => void>();
  const fireWakers = (): void => {
    for (const wake of [...wakers]) {
      try {
        wake();
      } catch {
        /* one listener does not degrade the others */
      }
    }
  };
  const datagrams: FipsDatagramEndpoint = {
    registerService(port, handler) {
      return node.registerService(port, async (ctx) => {
        await handler({
          src: ctx.src,
          srcPort: ctx.srcPort,
          dstPort: ctx.dstPort,
          payload: ctx.payload,
        });
        fireWakers();
      });
    },
    async sendDatagram(args) {
      await node.sendDatagram(args);
    },
  };
  const onActivity = (wake: () => void): (() => void) => {
    wakers.add(wake);
    return () => {
      wakers.delete(wake);
    };
  };
  return { datagrams, onActivity };
}

interface Components {
  readonly logger: ComponentLogger;
}

/**
 * MESH_INTERFACE → FIPS → "libp2p runs over a TCP/FIPS stream" — the
 * libp2p transport. A FIPS address never enters libp2p's announced set
 * (MESH_INTERFACE → FIPS → "A node's FIPS address is `/fips/<npub>/p2p/<peer id>`"
 * → "A FIPS address is never among the addresses libp2p announces"):
 * the listener's `getAddrs()` answers `[]`.
 */
export function fipsTransport(
  _init: FipsTransportInit,
): (components: unknown) => Transport {
  return (components) => new ShellFipsTransport(components as Components);
}

class ShellFipsTransport implements Transport {
  readonly [transportSymbol] = true as const;
  readonly [Symbol.toStringTag] = '@notis/fips' as const;

  constructor(private readonly components: Components) {
    void this.components;
  }

  listenFilter(mas: Multiaddr[]): Multiaddr[] {
    return mas.filter((ma) => isFipsMultiaddr(ma));
  }

  dialFilter(mas: Multiaddr[]): Multiaddr[] {
    return mas;
  }

  async dial(_ma: Multiaddr, _options: unknown): Promise<Connection> {
    throw new Error('fips transport dial is not implemented');
  }

  createListener(_opts: CreateListenerOptions): Listener {
    return new ShellFipsListener();
  }
}

class ShellFipsListener
  extends TypedEventEmitter<ListenerEvents>
  implements Listener
{
  private listening: Multiaddr | null = null;

  async listen(ma: Multiaddr): Promise<void> {
    this.listening = ma;
  }

  getAddrs(): Multiaddr[] {
    return this.listening === null ? [] : [this.listening];
  }

  async close(): Promise<void> {
    this.listening = null;
  }

  updateAnnounceAddrs(_addrs: Multiaddr[]): void {
    /* a FIPS listener never announces an address */
  }
}
