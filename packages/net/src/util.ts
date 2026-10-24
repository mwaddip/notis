import { multiaddr } from '@multiformats/multiaddr';
import { MAX_STREAM_BYTES } from './msg-guards.js';

export function mergeUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * A chunk off a libp2p stream: raw bytes, or a `Uint8ArrayList` view of them.
 */
type StreamChunk = Uint8Array | { subarray(): Uint8Array };

/**
 * The write side of a libp2p stream — what `sinkWithDeadline` needs.
 *
 * NET_INTERFACE → Validation → "A stream write is bounded in time as well":
 * `send` returns `false` when the muxer's send window is full and the stream
 * cannot take more bytes without an `onDrain`; `onDrain` resolves when it can
 * again, and rejects when the stream closes or is aborted before that.
 * `close` half-closes the writable end — the stream stays readable — and
 * resolves once pending bytes are flushed.
 */
interface WritableStream {
  send: (data: Uint8Array) => boolean;
  onDrain: (options?: { signal?: AbortSignal }) => Promise<void>;
  abort: (err: Error) => void;
  close: (options?: { signal?: AbortSignal }) => Promise<void>;
}

/**
 * Thrown by `readStreamBounded` when its deadline elapses before the peer closes
 * its side. Distinct from the byte-cap outcome (a `null` return) and from a
 * decode failure, so a caller can tell a silent peer apart from an oversized or
 * a malformed one.
 */
export class StreamReadTimeout extends Error {
  constructor() {
    super('stream read deadline exceeded');
    this.name = 'StreamReadTimeout';
  }
}

/**
 * Race a stream write against a deadline — NET_INTERFACE → Validation (and
 * untrusted-input safety) → "A stream write is bounded in time as well".
 *
 * A write to a peer that does not read parks on the muxer's send window and
 * holds the stream for the life of the connection; the deadline here is the
 * one the reader on the other side runs under (`syncRequestTimeoutMs`, ×5 for
 * a `Blocks` answer), so a write that outlasts the read is aborted at the
 * same instant the read ends. On expiry the stream is aborted — the
 * caller's `close`/`finally` tears what remains down — with no penalty, for
 * the reason the read deadline is unpenalised: a slow link is a slow link.
 *
 * `send` returns `false` when the muxer's send buffer is full; the write then
 * waits on `onDrain` under the same deadline. Once the bytes are queued, the
 * writable end is half-closed with `close` under the same deadline so the
 * reader on the other side sees the end of this frame as EOF; the stream
 * stays readable (the Stream contract is half-closable), so a request/reply
 * protocol still receives the reply on the same stream.
 *
 * The deadline fires at most once: on expiry, the stream is aborted and the
 * pending drain or close rejects, which this function swallows. A send,
 * drain or close that throws before the deadline (the peer went away
 * mid-write) is re-thrown — the caller tells a slow link from a dropped one
 * by the log it makes. An error that lands after the abort — the abort's
 * own — is swallowed, since the caller already accepted the outcome.
 */
export async function sinkWithDeadline(
  stream: WritableStream,
  data: Uint8Array,
  deadlineMs: number,
): Promise<void> {
  let deadlineFired = false;
  const deadlineController = new AbortController();
  const timer = setTimeout(() => {
    deadlineFired = true;
    try { stream.abort(new Error('write deadline exceeded')); } catch { /* already gone */ }
    deadlineController.abort();
  }, deadlineMs);
  try {
    // `send` is synchronous — a throw lands here and is attributed to the
    // write. On a false return the muxer's send window is full; wait on
    // `onDrain` under the same deadline so a peer that stops reading cannot
    // park the write past it.
    if (!stream.send(data)) {
      await stream.onDrain({ signal: deadlineController.signal });
    }
    // Half-close the writable end — the paired reader needs EOF to end its
    // iteration on this frame. `close` resolves once pending bytes are
    // flushed; the readable end stays open, so the reply still rides this
    // stream. The caller's own `stream.close()` after this is idempotent
    // and remains in place.
    await stream.close({ signal: deadlineController.signal });
  } catch (err) {
    if (deadlineFired) return;
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The read side of a libp2p stream — what `readStreamBounded` iterates.
 *
 * NET_INTERFACE → Validation → "A stream read is bounded in time as well as in
 * bytes": in libp2p 3.x a stream is itself `AsyncIterable<Uint8Array |
 * Uint8ArrayList>`, so a caller passes the stream directly. Iterating a stream
 * immediately drains it, which rules out the 3.x buffering-reset: a reader that
 * never attaches a `message` listener and never iterates buffers up to a cap
 * and then resets, but this helper iterates on the next tick.
 */
type ReadableStream = AsyncIterable<StreamChunk>;

/**
 * Read a stream into a single buffer, refusing to hold more than `maxBytes` or
 * to wait past `signal`'s deadline.
 *
 * A stream keeps yielding until the peer closes its side, so draining one
 * into an array hands the peer both our heap and our time: a connection that
 * never stops writing is an out-of-memory kill, and one that writes slowly or
 * not at all parks the read forever (NET_INTERFACE → "A stream read is bounded
 * in time as well as in bytes"). The byte cap answers the first — reads stop at
 * the ceiling, the chunks are released and the source closed. `signal` answers
 * the second — an aborted read throws `StreamReadTimeout`; the caller closes the
 * stream, so neither an over-cap nor a silent peer can keep us reading.
 *
 * Returns `null` when the cap is exceeded; callers treat that as a protocol
 * violation. A stream that simply carries nothing returns an empty array, which
 * is a different (and legitimate) outcome.
 */
export async function readStreamBounded(
  source: ReadableStream,
  maxBytes: number = MAX_STREAM_BYTES,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const it = source[Symbol.asyncIterator]();

  for (;;) {
    let result: IteratorResult<StreamChunk>;
    try {
      result = await nextWithin(it, signal);
    } catch (err) {
      // The deadline fired (or the source itself threw). Signal teardown but do
      // NOT await it: a source parked mid-read need not settle its `return()`
      // until bytes arrive, which is the wait the deadline exists to end. The
      // caller's `stream.close()` tears the source down.
      closeQuietly(it);
      throw err;
    }
    if (result.done === true) break;
    const chunk = result.value;
    const bytes = chunk instanceof Uint8Array ? chunk : chunk.subarray();
    total += bytes.length;
    if (total > maxBytes) {
      chunks.length = 0;
      // Between yields — the source can be closed and awaited without risk.
      await closeAwaited(it);
      return null;
    }
    chunks.push(bytes);
  }

  await closeAwaited(it);
  return mergeUint8Arrays(chunks);
}

/**
 * `it.next()`, rejecting with `StreamReadTimeout` the moment `signal` aborts.
 * The abort listener is one-shot and is removed when the read settles, so
 * neither it nor the timer behind an `AbortSignal.timeout` outlives the read.
 */
function nextWithin<T>(
  it: AsyncIterator<T>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<T>> {
  if (!signal) return it.next();
  if (signal.aborted) return Promise.reject(new StreamReadTimeout());
  return new Promise<IteratorResult<T>>((resolve, reject) => {
    const onAbort = (): void => reject(new StreamReadTimeout());
    signal.addEventListener('abort', onAbort, { once: true });
    it.next().then(
      (r) => { signal.removeEventListener('abort', onAbort); resolve(r); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/** Close the source and wait — used only between yields, where it cannot block. */
async function closeAwaited(it: AsyncIterator<unknown>): Promise<void> {
  try { await it.return?.(); } catch { /* the source is already torn down */ }
}

/** Signal teardown without waiting — used when the source may be parked mid-read. */
function closeQuietly(it: AsyncIterator<unknown>): void {
  void Promise.resolve(it.return?.()).catch(() => { /* the source is already torn down */ });
}

/**
 * An address with any `/p2p/<peerId>` component removed — the comparison the
 * fill phase and PeerDb's self filter both use instead of a raw string match
 * (NET_INTERFACE → Outbound Manager → "Addresses compare without their
 * `/p2p/` component"). libp2p stamps the remote peer id onto a connection's
 * address once the upgrade identifies it, while a PeerDb key carries it or
 * not by where it was learned — a seed is bare, a declared address carries
 * it. `421` is the `p2p` multicodec. A string that fails to parse as a
 * multiaddr is returned unchanged — a malformed key must not fail the tick
 * it is compared in.
 */
export function addressWithoutPeerId(addr: string): string {
  try {
    return multiaddr(addr).decapsulateCode(421).toString();
  } catch {
    return addr;
  }
}

// The multicodec for a `/p2p/<peerId>` component — multiaddr 13 reports it as
// `{ code: 421, name: 'p2p', value: '<peerId>' }` in `getComponents()`.
const CODE_P2P = 421;

/**
 * The peer id named by the last `/p2p/<peerId>` component of `addr`, or
 * `null` when the address names none or does not parse (NET_INTERFACE →
 * Handshake → "A declared address is hearsay until a dial names it"). An
 * unparseable or malformed id string behaves the same: no match, no throw.
 */
export function peerIdOfAddress(addr: string): string | null {
  let components: ReturnType<ReturnType<typeof multiaddr>['getComponents']>;
  try {
    components = multiaddr(addr).getComponents();
  } catch {
    return null;
  }
  for (let i = components.length - 1; i >= 0; i--) {
    const c = components[i]!;
    if (c.code === CODE_P2P && c.value !== undefined && c.value.length > 0) {
      return c.value;
    }
  }
  return null;
}
