// MESH_INTERFACE → Block gossip — "A mesh service is a gossip peer of its own
// node". The mesh service dials its node's libp2p TCP address — named with no
// `/p2p/` component, the node's peer id learnt at the link — runs net's
// handshake as the dialler, and holds that connection open as a gossip peer
// of its node. A node it cannot reach, or one that restarts, is dialled
// again. Node-only: imports `@dagsocial/net`, which carries TCP.

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
   * MESH_INTERFACE → Block gossip — "a TCP multiaddr with no `/p2p/`
   * component". The node's peer id is learnt at the Noise step; a dialled
   * address that carries its own `/p2p/` is accepted (libp2p's own form)
   * and the `/p2p/` component is kept as the dialler built it.
   */
  readonly nodeP2p: string;
  readonly magic: number;
  readonly protocolVersion: number;
  readonly nodeName: string;
  /**
   * The redial cadence after any close. Defaults to one second — the
   * mesh service's own retry; the brief leaves this to the builder.
   */
  readonly retryMs?: number;
}

export interface NodePeer {
  stop(): Promise<void>;
  connected(): boolean;
}

const DEFAULT_RETRY_MS = 1_000;

/**
 * The dialler's half of MESH_INTERFACE → Block gossip. The returned peer
 * holds one connection to the node at a time; a close is followed by a
 * redial on the retry cadence.
 */
export function startNodePeer(
  libp2p: Libp2p,
  opts: StartNodePeerOptions,
): NodePeer {
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  // The last connection the dialler holds. Cleared at close or stop.
  let currentConn: Connection | null = null;
  let stopped = false;
  let redialTimer: ReturnType<typeof setTimeout> | null = null;

  // Resolve the dial target once. A `/p2p/` component is accepted; a bare
  // TCP address is accepted. Either way libp2p learns the peer id at
  // Noise and surfaces it on the returned connection.
  let target: Multiaddr;
  try {
    target = multiaddr(opts.nodeP2p);
  } catch (err) {
    // A refusal here is a static misconfiguration; the peer never comes up.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`startNodePeer: invalid nodeP2p ${JSON.stringify(opts.nodeP2p)}: ${message}`);
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
    if (currentConn !== null && currentConn === conn) {
      currentConn = null;
    }
    scheduleRedial();
  };

  const connectOnce = async (): Promise<void> => {
    if (stopped) return;
    if (currentConn !== null) return;

    let conn: Connection;
    try {
      conn = await libp2p.dial(target);
    } catch {
      scheduleRedial();
      return;
    }

    // NET_INTERFACE → Handshake — "The side that dialled a connection opens
    // a stream on `/dagsocial/handshake/1` on it". A dial can return a
    // connection the peer opened or one that has already carried a
    // handshake; here the dialler opens the handshake stream unconditionally
    // on its own dial's connection — net's listener closes a second
    // handshake stream unread with no penalty, so the extra open costs
    // nothing but a stream in that case.
    let completed = false;
    try {
      const stream = await conn.newStream(HANDSHAKE_PROTOCOL, {
        signal: AbortSignal.timeout(10_000),
      });
      try {
        const msg = {
          agentName: 'dagsocial-mesh',
          protocolVersion: opts.protocolVersion,
          nodeName: opts.nodeName,
          // MESH_INTERFACE → Block gossip — "a body ... declaring no
          // address and no capability". The declared height carries no
          // claim at net's scheduler (NET_INTERFACE → Sync State Machine
          // → "the handshake's `chainHeight` alone is no claim"); 0 says
          // what a node with no chain says.
          chainHeight: 0,
          capabilities: [],
        };
        const frame = buildHandshakeFrame(opts.magic, msg);
        // libp2p 3.x streams carry `send(data) → boolean` and `onDrain()`
        // for the write side; a false return parks on the muxer's send
        // window. Half-close the writable end afterwards so the reader
        // on the other side sees EOF of our frame.
        const writable = stream as unknown as {
          send: (b: Uint8Array) => boolean;
          onDrain: (o?: { signal?: AbortSignal }) => Promise<void>;
          close: (o?: { signal?: AbortSignal }) => Promise<void>;
        };
        const writeDeadline = AbortSignal.timeout(10_000);
        if (!writable.send(frame)) {
          await writable.onDrain({ signal: writeDeadline });
        }
        await writable.close({ signal: writeDeadline });
        // Read the node's answer. A libp2p 3.x stream is itself an
        // async iterable of chunks; a chunk may be a `Uint8Array` or a
        // `Uint8ArrayList` view of one.
        const chunks: Uint8Array[] = [];
        let total = 0;
        for await (const chunk of stream as unknown as AsyncIterable<
          Uint8Array | { subarray(): Uint8Array }
        >) {
          const bytes =
            chunk instanceof Uint8Array ? chunk : chunk.subarray();
          chunks.push(bytes);
          total += bytes.length;
          if (total > MAX_HANDSHAKE_FRAME_BYTES) break;
        }
        if (total > 0 && total <= MAX_HANDSHAKE_FRAME_BYTES) {
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
      // The handshake stream could not be opened — net may have closed the
      // connection (banned peer, deadline), or it may not have registered
      // the protocol yet. Either way the dial's close event drives the
      // redial; close the connection here so a stuck one does not hold
      // the slot.
      try { await conn.close(); } catch { /* already gone */ }
      scheduleRedial();
      return;
    }

    if (!completed) {
      try { await conn.close(); } catch { /* already gone */ }
      scheduleRedial();
      return;
    }

    // The dialler's handshake completed — the connection is active.
    currentConn = conn;
  };

  // libp2p raises `connection:close` for every connection, inbound or
  // outbound. The dialler listens for the one it holds and schedules a
  // redial as soon as it closes.
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
