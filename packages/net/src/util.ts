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
 * Read a stream into a single buffer, refusing to hold more than `maxBytes` or
 * to wait past `signal`'s deadline.
 *
 * A stream source keeps yielding until the peer closes its side, so draining one
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
  source: AsyncIterable<StreamChunk>,
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
