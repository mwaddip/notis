// NET_INTERFACE → The browser entry — `readerHandshake` is the
// dialler's handshake over an open libp2p connection: `net`'s
// `HANDSHAKE_PROTOCOL` with `READER_CAPABILITIES`, no
// `declaredAddress`, an empty `nodeName` (MESH_INTERFACE → Block
// gossip → "A client is a reader of every node it holds a connection
// to"). The function never throws for a peer's answer: a reject
// frame, a closed stream, or a malformed reply all answer `{ ok:
// false, reason }`. Browser-safe: imports only
// `./handshake-codec.js` and `./capabilities.js`
// (MESH_INTERFACE → Place in the workspace).

import type { Connection, Stream } from '@libp2p/interface';
import { hash32 } from '@dagsocial/types';
import {
  HANDSHAKE_PROTOCOL,
  buildHandshakeFrameWithHash,
  decodeHandshakeBody,
} from '../handshake-codec.js';
import { decodeFrame as decodeFrameWithHash } from '../frame-codec.js';
import type { HashFn } from '../frame-codec.js';
import { READER_CAPABILITIES } from '../capabilities.js';
import { MAX_HANDSHAKE_FRAME_BYTES } from '../msg-guards.js';

/**
 * NET_INTERFACE → The browser entry — `readerHandshake`'s options.
 * `agentName` names the client in the node's peer list; `chainHeight`
 * is the reader's held chain's tip (0 before it holds one —
 * MESH_INTERFACE → Block gossip); `timeoutMs` bounds each of the
 * stream open, the write and the read.
 */
export interface ReaderHandshakeOptions {
  readonly magic: number;
  readonly protocolVersion: number;
  readonly agentName: string;
  readonly chainHeight: number;
  readonly timeoutMs: number;
  /**
   * NET_INTERFACE → Readers — "A peer's capabilities say what it serves":
   * the capability set the reader's handshake declares.
   * `READER_CAPABILITIES` (the empty set) when omitted;
   * `SERVING_READER_CAPABILITIES` while the reader serves posts' text.
   */
  readonly capabilities?: readonly number[];
}

/**
 * NET_INTERFACE → The browser entry — `readerHandshake`'s answer.
 * `ok: true` carries the node's declared capabilities and tip height;
 * `ok: false` carries the reason the handshake did not complete. A
 * reader does not translate a peer answer into a thrown error
 * (MESH_INTERFACE → The client's node list).
 */
export type ReaderHandshakeResult =
  | { readonly ok: true; readonly capabilities: readonly number[]; readonly height: number }
  | { readonly ok: false; readonly reason: string };

// A fresh HashFn per call so this module holds no state. The frame
// codec is parameterized in `./frame-codec.js`, so this reader runs in
// a browser (MESH_INTERFACE → Place in the workspace).
function browserHashFn(): HashFn {
  return (data) => hash32(data);
}

/**
 * NET_INTERFACE → The browser entry — open a stream on
 * `HANDSHAKE_PROTOCOL`, write the reader's handshake frame and read
 * the node's answer. Each step runs under `timeoutMs`; on a read
 * deadline the stream is aborted so a pending read rejects
 * (NET_INTERFACE → Handshake → "A connection handshakes within its
 * deadline, or is closed").
 */
export async function readerHandshake(
  conn: Connection,
  o: ReaderHandshakeOptions,
): Promise<ReaderHandshakeResult> {
  let stream: Stream;
  try {
    stream = await conn.newStream(HANDSHAKE_PROTOCOL, {
      signal: AbortSignal.timeout(o.timeoutMs),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: msg };
  }

  const frame = buildHandshakeFrameWithHash(
    o.magic,
    {
      agentName: o.agentName,
      protocolVersion: o.protocolVersion,
      nodeName: '',
      chainHeight: o.chainHeight,
      capabilities: [...(o.capabilities ?? READER_CAPABILITIES)],
    },
    browserHashFn(),
  );
  // libp2p 3.x streams carry `send(data) → boolean` and `onDrain` for
  // the write side; a false return parks on the muxer's send window.
  // Half-close the writable end so the reader on the other side sees
  // EOF of our frame.
  const api = stream as unknown as {
    send: (b: Uint8Array) => boolean;
    onDrain: (ops?: { signal?: AbortSignal }) => Promise<void>;
    close: (ops?: { signal?: AbortSignal }) => Promise<void>;
    abort: (err: Error) => void;
  };
  const writeDeadline = AbortSignal.timeout(o.timeoutMs);
  try {
    if (!api.send(frame)) await api.onDrain({ signal: writeDeadline });
    await api.close({ signal: writeDeadline });
  } catch (e) {
    try { api.abort(new Error('handshake write')); } catch { /* already gone */ }
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: msg };
  }

  // Read the node's answer under its own deadline. Past it the stream
  // is aborted so a pending read rejects.
  const readDeadline = AbortSignal.timeout(o.timeoutMs);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = (): void => {
    try { api.abort(new Error('handshake read deadline')); } catch { /* already gone */ }
  };
  readDeadline.addEventListener('abort', onAbort, { once: true });
  try {
    const iterable = stream as unknown as AsyncIterable<
      Uint8Array | { subarray(): Uint8Array }
    >;
    for await (const value of iterable) {
      const bytes = value instanceof Uint8Array ? value : value.subarray();
      chunks.push(bytes);
      total += bytes.length;
      if (total > MAX_HANDSHAKE_FRAME_BYTES) break;
    }
  } catch { /* abort or reset — a defined outcome; fall through */ }
  finally {
    readDeadline.removeEventListener('abort', onAbort);
    try { await stream.close(); } catch { /* already gone */ }
  }

  if (readDeadline.aborted) {
    return { ok: false, reason: 'handshake read deadline' };
  }
  if (total === 0) {
    return { ok: false, reason: 'handshake stream closed with no answer' };
  }
  if (total > MAX_HANDSHAKE_FRAME_BYTES) {
    return { ok: false, reason: `handshake frame over ${MAX_HANDSHAKE_FRAME_BYTES} bytes` };
  }
  const data = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { data.set(c, off); off += c.length; }
  let decoded: { code: number; body: Uint8Array };
  try {
    decoded = decodeFrameWithHash(o.magic, data, browserHashFn());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: msg };
  }
  const body = decodeHandshakeBody(decoded.body);
  if (body === null) {
    return { ok: false, reason: 'handshake body did not decode' };
  }
  return {
    ok: true,
    capabilities: [...body.capabilities],
    height: body.chainHeight,
  };
}
