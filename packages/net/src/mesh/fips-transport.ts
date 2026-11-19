// MESH_INTERFACE → FIPS → "libp2p runs over a TCP/FIPS stream" — a libp2p
// 3.5.1 transport that carries libp2p connections over `@fips/tcp` streams
// on `FIPS_SERVICE_PORT`. Browser-safe: imports no Node built-in and reads
// no Node global.

import { transportSymbol, TypedEventEmitter } from '@libp2p/interface';
import type {
  AbortOptions,
  ComponentLogger,
  Connection,
  CreateListenerOptions,
  DialTransportOptions,
  Listener,
  ListenerEvents,
  Logger,
  MessageStreamDirection,
  Transport,
  Upgrader,
} from '@libp2p/interface';
import { AbstractMultiaddrConnection } from '@libp2p/utils';
import type { SendResult } from '@libp2p/utils';
import { multiaddr } from '@multiformats/multiaddr';
import type { Multiaddr } from '@multiformats/multiaddr';

// `@libp2p/utils` requires `sendData(data: Uint8ArrayList): SendResult`.
// `uint8arraylist` is a transitive module and not resolvable by tsc here;
// `Uint8ArrayListLike` names the two members `sendData` reads.
interface Uint8ArrayListLike {
  readonly byteLength: number;
  subarray(): Uint8Array;
}
import { encodeNpub, fromHex } from '@fips/core';
import type { FipsNode } from '@fips/core';
import { State } from '@fips/tcp';
import type {
  ConnectionId,
  FipsDatagramEndpoint,
  FipsTcpEndpoint,
} from '@fips/tcp';
import { FIPS_PROTOCOL_NAME, isFipsMultiaddr, parseFipsMultiaddr } from './fips-addr.js';
import { dialKeyHex } from './fips-identity.js';
import { FIPS_TCP_SEND_BUFFER_BYTES } from './constants.js';

/**
 * MESH_INTERFACE → FIPS → "libp2p runs over a TCP/FIPS stream" — the dial
 * refusal class a caller catches. `name` is `'FipsTransportDialError'`.
 */
export class FipsTransportDialError extends Error {
  readonly name = 'FipsTransportDialError';
}

/**
 * MESH_INTERFACE → FIPS → "libp2p runs over a TCP/FIPS stream" — the shape
 * `fipsTransport` takes. `endpoint` and `localXOnly` are thunks the caller
 * sets once its FIPS stack is up; `dial` is true for a reader and false
 * for a node (`MESH_INTERFACE → FIPS → "libp2p runs over a TCP/FIPS stream"
 * → "A reader dials over it; a node does not"`). `onActivity` wakes pending
 * reads and accepts; its subscriber receives the datagram's source as the
 * sender's 66-hex compressed FIPS key, so each connection wakes only for
 * its own peer and the work per inbound datagram does not scale with the
 * endpoint's connection count.
 */
export interface FipsTransportInit {
  readonly endpoint: () => FipsTcpEndpoint | null;
  readonly localXOnly: () => Uint8Array | null;
  readonly dial: boolean;
  readonly onActivity: (wake: (srcKeyHex: string) => void) => () => void;
}

/**
 * MESH_INTERFACE → FIPS → "libp2p runs over a TCP/FIPS stream" — the
 * `FipsDatagramEndpoint` an `FipsTcpEndpoint` is built over, delegating to
 * the `FipsNode`. Each `registerService` handler runs the endpoint's
 * handler and fires every `onActivity` subscriber after it returns, so a
 * pending read or accept wakes on the inbound datagram, not at the next
 * poll.
 */
export function fipsDatagramEndpoint(node: FipsNode): {
  datagrams: FipsDatagramEndpoint;
  onActivity: (wake: (srcKeyHex: string) => void) => () => void;
} {
  const wakers = new Set<(srcKeyHex: string) => void>();
  const fireWakers = (srcKeyHex: string): void => {
    for (const wake of [...wakers]) {
      try {
        wake(srcKeyHex);
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
        fireWakers(ctx.src);
      });
    },
    async sendDatagram(args) {
      await node.sendDatagram(args);
    },
  };
  const onActivity = (wake: (srcKeyHex: string) => void): (() => void) => {
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
 * (`MESH_INTERFACE → FIPS → "A node's FIPS address is
 * `/fips/<npub>/p2p/<peer id>`"` → "A FIPS address is never among the
 * addresses libp2p announces"): the listener's `getAddrs()` answers `[]`.
 */
export function fipsTransport(
  init: FipsTransportInit,
): (components: unknown) => Transport {
  return (components) => new FipsTransport(init, components as Components);
}

class FipsTransport implements Transport {
  readonly [transportSymbol] = true as const;
  readonly [Symbol.toStringTag] = '@notis/fips' as const;

  constructor(
    private readonly init: FipsTransportInit,
    private readonly components: Components,
  ) {}

  listenFilter(mas: Multiaddr[]): Multiaddr[] {
    return mas.filter((ma) => isFipsMultiaddr(ma));
  }

  dialFilter(mas: Multiaddr[]): Multiaddr[] {
    if (!this.init.dial) return [];
    return mas.filter((ma) => isFipsMultiaddr(ma));
  }

  async dial(ma: Multiaddr, options: DialTransportOptions): Promise<Connection> {
    const endpoint = this.init.endpoint();
    if (endpoint === null) {
      throw new FipsTransportDialError('fips endpoint not available');
    }
    const parsed = parseFipsMultiaddr(ma);
    if (parsed === null) {
      throw new FipsTransportDialError(`not a fips multiaddr: ${ma.toString()}`);
    }
    const dialKey = dialKeyHex(parsed.xOnly);
    let id: ConnectionId;
    try {
      id = await endpoint.connect(dialKey);
    } catch (err) {
      throw new FipsTransportDialError(
        `fips connect to ${ma.toString()} failed: ${(err as Error).message}`,
      );
    }
    const log = this.components.logger.forComponent('libp2p:fips:connection');
    // `dialKey` is `02||x` hex (66 chars); the remote key's parity may be
    // odd — a dial addresses either parity — so the match is on the x-only
    // suffix (`MESH_INTERFACE → FIPS → "A node's FIPS address is
    // `/fips/<npub>/p2p/<peer id>`"` → "a dial addresses the key as
    // `02‖x`, which reaches a key of either parity").
    const peerXOnlyHex = dialKey.slice(2);
    const maConn = new FipsMultiaddrConnection({
      endpoint,
      id,
      remoteAddr: ma,
      direction: 'outbound',
      log,
      onActivity: this.init.onActivity,
      peerXOnlyHex,
    });
    try {
      return await options.upgrader.upgradeOutbound(maConn, options);
    } catch (err) {
      maConn.abort(err as Error);
      throw err;
    }
  }

  createListener(opts: CreateListenerOptions): Listener {
    return new FipsListener({
      init: this.init,
      upgrader: opts.upgrader,
      log: this.components.logger.forComponent('libp2p:fips:listener'),
      logConn: this.components.logger.forComponent('libp2p:fips:connection'),
    });
  }
}

interface ListenerCtx {
  readonly init: FipsTransportInit;
  readonly upgrader: Upgrader;
  readonly log: Logger;
  readonly logConn: Logger;
}

class FipsListener
  extends TypedEventEmitter<ListenerEvents>
  implements Listener
{
  private status: 'inactive' | 'active' | 'closed' = 'inactive';
  private unsubActivity: (() => void) | null = null;
  private accepting = false;
  private pendingWake: Promise<void> = Promise.resolve();
  private resolveWake: () => void = () => { /* re-armed by armWake */ };
  private readonly ctx: ListenerCtx;
  private readonly openConns = new Set<FipsMultiaddrConnection>();
  private readonly shutdown = new AbortController();

  constructor(ctx: ListenerCtx) {
    super();
    this.ctx = ctx;
    this.armWake();
  }

  async listen(ma: Multiaddr): Promise<void> {
    if (!isFipsMultiaddr(ma)) {
      throw new Error(`fips listener refuses non-fips address: ${ma.toString()}`);
    }
    if (this.status === 'closed') {
      throw new Error('fips listener is closed');
    }
    this.status = 'active';
    // The accept loop wakes on every inbound datagram: a new peer's first
    // SYN is from a key no live connection holds.
    this.unsubActivity = this.ctx.init.onActivity(() => this.fireWake());
    this.safeDispatchEvent('listening');
    this.pokeAccept();
  }

  getAddrs(): Multiaddr[] {
    // `MESH_INTERFACE → FIPS → "A node's FIPS address is
    // `/fips/<npub>/p2p/<peer id>`"` → "A FIPS address is never among the
    // addresses libp2p announces".
    return [];
  }

  async close(): Promise<void> {
    if (this.status === 'closed') return;
    this.status = 'closed';
    this.shutdown.abort();
    if (this.unsubActivity !== null) {
      this.unsubActivity();
      this.unsubActivity = null;
    }
    this.fireWake();
    for (const conn of [...this.openConns]) {
      try { conn.abort(new Error('fips listener closed')); } catch { /* already */ }
    }
    this.openConns.clear();
    this.safeDispatchEvent('close');
  }

  updateAnnounceAddrs(_addrs: Multiaddr[]): void {
    /* FIPS addresses never enter the announced set. */
  }

  private armWake(): void {
    this.pendingWake = new Promise<void>((resolve) => {
      this.resolveWake = resolve;
    });
  }

  private fireWake(): void {
    const resolve = this.resolveWake;
    this.armWake();
    resolve();
  }

  private pokeAccept(): void {
    if (this.accepting) return;
    this.accepting = true;
    void this.acceptLoop();
  }

  private async acceptLoop(): Promise<void> {
    try {
      while (this.status === 'active') {
        const endpoint = this.ctx.init.endpoint();
        if (endpoint === null) {
          await this.pendingWake;
          continue;
        }
        const waitP = this.pendingWake;
        let id: ConnectionId | undefined;
        try {
          id = await endpoint.accept();
        } catch (err) {
          this.ctx.log.error('fips accept threw - %e', err);
          id = undefined;
        }
        if (id === undefined) {
          await waitP;
          continue;
        }
        void this.handleInbound(endpoint, id);
      }
    } finally {
      this.accepting = false;
    }
  }

  private async handleInbound(endpoint: FipsTcpEndpoint, id: ConnectionId): Promise<void> {
    let peerHex: string | undefined;
    try {
      peerHex = await endpoint.peer(id);
    } catch {
      peerHex = undefined;
    }
    if (peerHex === undefined || peerHex.length !== 66) {
      try { await endpoint.abort(id); } catch { /* already */ }
      return;
    }
    let xOnly: Uint8Array;
    try {
      const bytes = fromHex(peerHex);
      xOnly = bytes.subarray(1);
    } catch {
      try { await endpoint.abort(id); } catch { /* already */ }
      return;
    }
    const remoteAddr = multiaddr(`/${FIPS_PROTOCOL_NAME}/${encodeNpub(xOnly)}`);
    const maConn = new FipsMultiaddrConnection({
      endpoint,
      id,
      remoteAddr,
      direction: 'inbound',
      log: this.ctx.logConn,
      onActivity: this.ctx.init.onActivity,
      peerXOnlyHex: peerHex.slice(2),
    });
    this.openConns.add(maConn);
    maConn.addEventListener('close', () => {
      this.openConns.delete(maConn);
    });
    try {
      await this.ctx.upgrader.upgradeInbound(maConn, { signal: this.shutdown.signal });
    } catch (err) {
      this.ctx.log.error('fips upgrade inbound failed - %e', err);
      try { maConn.abort(err as Error); } catch { /* already */ }
    }
  }
}

interface FipsMultiaddrConnectionInit {
  readonly endpoint: FipsTcpEndpoint;
  readonly id: ConnectionId;
  readonly remoteAddr: Multiaddr;
  readonly direction: MessageStreamDirection;
  readonly log: Logger;
  readonly onActivity: (wake: (srcKeyHex: string) => void) => () => void;
  readonly peerXOnlyHex: string;
}

class FipsMultiaddrConnection extends AbstractMultiaddrConnection {
  private readonly endpoint: FipsTcpEndpoint;
  private readonly id: ConnectionId;
  private readonly unsubActivity: () => void;
  private readonly peerXOnlyHex: string;
  private readonly writeQueue: Uint8Array[] = [];
  private pendingBytes = 0;
  private writerRunning = false;
  private readStopped = false;
  private readPaused = false;
  private pendingWake: Promise<void> = Promise.resolve();
  private resolveWake: () => void = () => { /* re-armed by armWake */ };
  private resumeP: Promise<void> = Promise.resolve();
  private resumeResolve: () => void = () => { /* re-armed by armResume */ };
  // Idle promise for `writeQueue`: resolved once the queue drains to zero.
  // `sendClose` waits on it so the bytes written before the close reach
  // the endpoint before the FIN.
  private writeQueueIdle: Promise<void> = Promise.resolve();
  private resolveWriteQueueIdle: () => void = () => { /* nothing waiting */ };

  constructor(init: FipsMultiaddrConnectionInit) {
    super({
      remoteAddr: init.remoteAddr,
      direction: init.direction,
      log: init.log,
    });
    this.endpoint = init.endpoint;
    this.id = init.id;
    this.peerXOnlyHex = init.peerXOnlyHex;
    this.armWake();
    this.armResume();
    // The sender's 66-hex compressed key `02||x` or `03||x`: the x-only
    // suffix is the match.
    this.unsubActivity = init.onActivity((srcKeyHex) => {
      if (srcKeyHex.length === 66 && srcKeyHex.slice(2) === this.peerXOnlyHex) {
        this.fireWake();
      }
    });
    void this.readLoop();
  }

  sendData(data: Uint8ArrayListLike): SendResult {
    const chunk = data.subarray();
    const copy = new Uint8Array(chunk.byteLength);
    copy.set(chunk);
    const wasEmpty = this.writeQueue.length === 0;
    this.writeQueue.push(copy);
    this.pendingBytes += copy.byteLength;
    if (wasEmpty) this.armWriteQueueIdle();
    void this.pumpWriter();
    return {
      sentBytes: copy.byteLength,
      canSendMore: this.pendingBytes < FIPS_TCP_SEND_BUFFER_BYTES,
    };
  }

  sendReset(_err: Error): void {
    this.readStopped = true;
    this.fireWake();
    this.fireResume();
    void this.endpoint.abort(this.id).catch(() => { /* already */ });
    this.unsubActivity();
  }

  sendPause(): void {
    this.readPaused = true;
  }

  sendResume(): void {
    if (!this.readPaused) return;
    this.readPaused = false;
    this.fireResume();
  }

  async sendClose(options?: AbortOptions): Promise<void> {
    // `destroySoon`'s shape: flush what the writer queued before the close
    // reaches the endpoint ahead of the FIN. `options.signal` bounds the
    // wait; if the writer is stopped the queue will not drain either.
    if (this.writeQueue.length > 0 && !this.readStopped) {
      const idle = this.writeQueueIdle;
      const signal = options?.signal;
      await new Promise<void>((resolve) => {
        let done = false;
        const settle = (): void => {
          if (done) return;
          done = true;
          if (signal !== undefined) {
            signal.removeEventListener('abort', settle);
          }
          resolve();
        };
        if (signal !== undefined) {
          if (signal.aborted) { settle(); return; }
          signal.addEventListener('abort', settle, { once: true });
        }
        void idle.then(settle, settle);
      });
    }
    this.readStopped = true;
    this.fireWake();
    this.fireResume();
    // Hand the FIN to the endpoint without awaiting its delivery over the
    // mesh: `endpoint.close` enqueues `@fips/tcp`'s flush, whose
    // `FipsNode.sendDatagram` may wait on
    // `FspSessionManager.waitForSessionSetup` where the FIPS link is gone.
    void this.endpoint.close(this.id).catch((err) => {
      this.log.trace('fips close threw - %e', err as Error);
    });
    this.unsubActivity();
  }

  // MESH_INTERFACE → FIPS → "libp2p runs over a TCP/FIPS stream" — a TCP/FIPS
  // endpoint answers reads with what is ready and has no data event; a
  // pending read wakes on each inbound datagram, not at the next poll.
  private async readLoop(): Promise<void> {
    try {
      while (!this.readStopped) {
        if (this.readPaused) {
          await this.resumeP;
          continue;
        }
        const waitP = this.pendingWake;
        let bytes: Uint8Array;
        try {
          bytes = await this.endpoint.read(this.id, 0x10000);
        } catch (err) {
          this.log.trace('fips read threw - %e', err as Error);
          this.onTransportClosed();
          this.readStopped = true;
          return;
        }
        if (bytes.byteLength > 0) {
          this.onData(bytes);
          continue;
        }
        let closed = false;
        try {
          closed = await this.endpoint.isReadClosed(this.id);
        } catch {
          closed = true;
        }
        if (closed) {
          this.onTransportClosed();
          this.readStopped = true;
          return;
        }
        await waitP;
      }
    } finally {
      this.unsubActivity();
    }
  }

  private async pumpWriter(): Promise<void> {
    if (this.writerRunning) return;
    this.writerRunning = true;
    try {
      while (!this.readStopped && this.writeQueue.length > 0) {
        const waitP = this.pendingWake;
        const state = await this.endpoint.state(this.id);
        if (state === undefined) {
          this.onTransportClosed();
          this.readStopped = true;
          return;
        }
        // `@fips/tcp` refuses `write` outside Established and CloseWait;
        // the handshake, poll and RTO advance state on inbound datagrams.
        if (state !== State.Established && state !== State.CloseWait) {
          await waitP;
          continue;
        }
        const head = this.writeQueue[0]!;
        let accepted = 0;
        try {
          accepted = await this.endpoint.write(this.id, head);
        } catch (err) {
          this.log.trace('fips write threw - %e', err as Error);
          this.onTransportClosed();
          this.readStopped = true;
          return;
        }
        if (accepted <= 0) {
          await waitP;
          continue;
        }
        this.pendingBytes -= accepted;
        if (accepted >= head.byteLength) {
          this.writeQueue.shift();
        } else {
          this.writeQueue[0] = head.subarray(accepted);
        }
        if (this.writeQueue.length === 0) {
          const resolve = this.resolveWriteQueueIdle;
          this.resolveWriteQueueIdle = () => { /* re-armed on next push */ };
          resolve();
        }
        if (
          this.pendingBytes < FIPS_TCP_SEND_BUFFER_BYTES
          && this.writeBufferLength === 0
        ) {
          this.safeDispatchEvent('drain');
        }
      }
    } finally {
      this.writerRunning = false;
    }
  }

  private armWriteQueueIdle(): void {
    this.writeQueueIdle = new Promise<void>((resolve) => {
      this.resolveWriteQueueIdle = resolve;
    });
  }

  private armWake(): void {
    this.pendingWake = new Promise<void>((resolve) => {
      this.resolveWake = resolve;
    });
  }

  private fireWake(): void {
    const resolve = this.resolveWake;
    this.armWake();
    resolve();
  }

  private armResume(): void {
    this.resumeP = new Promise<void>((resolve) => {
      this.resumeResolve = resolve;
    });
  }

  private fireResume(): void {
    const resolve = this.resumeResolve;
    this.armResume();
    resolve();
  }
}
