// MESH_INTERFACE → Block gossip — "A mesh service is a gossip peer of its own
// node". The dialler of its node's libp2p TCP address (named with no `/p2p/`
// component), running net's handshake as the dialler and holding that
// connection open as a gossip peer of its node. A node it cannot reach, or
// one that restarts, is dialled again. Node-only: imports `@dagsocial/net`,
// which carries TCP.

import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import type { Connection, Libp2p } from '@libp2p/interface';
import {
  HANDSHAKE_PROTOCOL,
  buildHandshakeFrame,
  decodeFrame,
  decodeHandshakeBody,
  MAX_HANDSHAKE_FRAME_BYTES,
} from '@dagsocial/net';

export interface StartNodePeerOptions {
  /**
   * The node's libp2p TCP address. MESH_INTERFACE → Block gossip —
   * "named with no `/p2p/` component". An address carrying a `/p2p/`,
   * `/dns4/`, `/dns6/` or `/dnsaddr/` component is refused at the call.
   */
  readonly nodeP2p: string;
  readonly magic: number;
  readonly protocolVersion: number;
  readonly nodeName: string;
  /**
   * The redial cadence used when a failed dial, a handshake that did
   * not complete, or the held connection's close schedules a retry.
   * Defaults to one second.
   */
  readonly retryMs?: number;
}

export interface NodePeer {
  stop(): Promise<void>;
  connected(): boolean;
}

const DEFAULT_RETRY_MS = 1_000;
const HANDSHAKE_DEADLINE_MS = 10_000;

/**
 * Dial the node's libp2p TCP address, run net's handshake as the dialler,
 * and hold the one connection open; redial on failure or close.
 * MESH_INTERFACE → Block gossip.
 */
export function startNodePeer(
  libp2p: Libp2p,
  opts: StartNodePeerOptions,
): NodePeer {
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  // The connection the dialler holds, if any — set only after the
  // handshake completes, cleared on its close or on stop.
  let currentConn: Connection | null = null;
  // The in-flight `connectOnce`, if any — one dial at a time.
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  let redialTimer: ReturnType<typeof setTimeout> | null = null;

  // Resolve the dial target once. MESH_INTERFACE → Block gossip —
  // "named with no `/p2p/` component": a `/p2p/`, `/dns4/`, `/dns6/`
  // or `/dnsaddr/` component is refused here, so the one rule holds
  // in one place.
  const raw = opts.nodeP2p;
  for (const forbidden of ['/p2p/', '/dns4/', '/dns6/', '/dnsaddr/']) {
    if (raw.includes(forbidden)) {
      throw new Error(
        `startNodePeer: nodeP2p ${JSON.stringify(raw)} carries a ${forbidden} component`,
      );
    }
  }
  let target: Multiaddr;
  try {
    target = multiaddr(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`startNodePeer: invalid nodeP2p ${JSON.stringify(raw)}: ${message}`);
  }

  const scheduleRedial = (): void => {
    if (stopped) return;
    if (redialTimer !== null) return;
    redialTimer = setTimeout(() => {
      redialTimer = null;
      void connectOnce();
    }, retryMs);
    // Node-only timer; never hold the process open on account of this.
    redialTimer.unref?.();
  };

  const onDisconnect = (conn: Connection): void => {
    // Redial only when the closed connection is the one the peer holds —
    // the close of a sibling connection on the same host is not this
    // peer's business.
    if (currentConn !== null && currentConn === conn) {
      currentConn = null;
      scheduleRedial();
    }
  };

  const connectOnce = async (): Promise<void> => {
    if (stopped) return;
    // One dial at a time: a redial that fires while this one is still
    // in flight returns here, so libp2p never joins a second dial to
    // the first and the handshake runs on this connection alone.
    if (inFlight !== null) return;
    if (currentConn !== null) return;
    const run = (async (): Promise<void> => {
      let conn: Connection;
      try {
        conn = await libp2p.dial(target);
      } catch {
        scheduleRedial();
        return;
      }

      // NET_INTERFACE → Handshake — "The side that dialled a connection
      // opens a stream on `/dagsocial/handshake/1` on it".
      let completed = false;
      try {
        const stream = await conn.newStream(HANDSHAKE_PROTOCOL, {
          signal: AbortSignal.timeout(HANDSHAKE_DEADLINE_MS),
        });
        try {
          const msg = {
            agentName: 'dagsocial-mesh',
            protocolVersion: opts.protocolVersion,
            nodeName: opts.nodeName,
            // MESH_INTERFACE → Block gossip — "a body ... declaring no
            // address and no capability". The declared height carries
            // no claim at net's scheduler (NET_INTERFACE → Sync State
            // Machine → "A claim is the peer's applied tip, height and
            // hash."), so 0 opens no header request.
            chainHeight: 0,
            capabilities: [],
          };
          const frame = buildHandshakeFrame(opts.magic, msg);
          // libp2p 3.x streams carry `send(data) → boolean` and
          // `onDrain()` for the write side; a false return parks on
          // the muxer's send window. Half-close the writable end
          // afterwards so the reader on the other side sees EOF of
          // our frame.
          const writable = stream as unknown as {
            send: (b: Uint8Array) => boolean;
            onDrain: (o?: { signal?: AbortSignal }) => Promise<void>;
            close: (o?: { signal?: AbortSignal }) => Promise<void>;
          };
          const writeDeadline = AbortSignal.timeout(HANDSHAKE_DEADLINE_MS);
          if (!writable.send(frame)) {
            await writable.onDrain({ signal: writeDeadline });
          }
          await writable.close({ signal: writeDeadline });
          // Read the node's answer under its own deadline, the same
          // the open carries. Past it the connection is closed and a
          // redial scheduled.
          const readDeadline = AbortSignal.timeout(HANDSHAKE_DEADLINE_MS);
          const chunks: Uint8Array[] = [];
          let total = 0;
          const iterable = stream as unknown as AsyncIterable<
            Uint8Array | { subarray(): Uint8Array }
          >;
          const iterator = iterable[Symbol.asyncIterator]();
          const onAbort = (): void => {
            try { void iterator.return?.(); } catch { /* already gone */ }
          };
          readDeadline.addEventListener('abort', onAbort, { once: true });
          try {
            while (true) {
              const { value, done } = await iterator.next();
              if (done) break;
              if (readDeadline.aborted) break;
              const bytes =
                value instanceof Uint8Array ? value : value.subarray();
              chunks.push(bytes);
              total += bytes.length;
              if (total > MAX_HANDSHAKE_FRAME_BYTES) break;
            }
          } finally {
            readDeadline.removeEventListener('abort', onAbort);
          }
          if (
            !readDeadline.aborted
            && total > 0
            && total <= MAX_HANDSHAKE_FRAME_BYTES
          ) {
            const data = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) { data.set(c, off); off += c.length; }
            try {
              const framed = decodeFrame(opts.magic, data);
              const body = decodeHandshakeBody(framed.body);
              if (body !== null) completed = true;
            } catch { /* malformed answer — net closes the connection */ }
          }
        } finally {
          try { await stream.close(); } catch { /* already gone */ }
        }
      } catch {
        try { await conn.close(); } catch { /* already gone */ }
        scheduleRedial();
        return;
      }

      if (!completed) {
        try { await conn.close(); } catch { /* already gone */ }
        scheduleRedial();
        return;
      }

      // The handshake completed — this connection is the peer's.
      currentConn = conn;
    })();
    inFlight = run.finally(() => { inFlight = null; });
    await inFlight;
  };

  // libp2p raises `connection:close` for every connection it holds.
  // The dialler reacts only to the close of the connection it holds.
  const closeListener = (
    ev: CustomEvent<Connection>,
  ): void => {
    const conn = ev.detail;
    if (!conn) return;
    onDisconnect(conn);
  };
  libp2p.addEventListener('connection:close', closeListener);

  // Start the first dial.
  void connectOnce();

  return {
    stop: async () => {
      stopped = true;
      libp2p.removeEventListener('connection:close', closeListener);
      if (redialTimer !== null) {
        clearTimeout(redialTimer);
        redialTimer = null;
      }
      if (currentConn !== null) {
        const c = currentConn;
        currentConn = null;
        try { await c.close(); } catch { /* already gone */ }
      }
    },
    connected: () => currentConn !== null,
  };
}
