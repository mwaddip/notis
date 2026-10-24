/**
 * A fake libp2p 3.x stream, built around the EventTarget shape the production
 * code drives. One shape in one place: every harness that drives one of net's
 * registered handlers — or a fake dial reply the sync module reads — builds
 * its stream through `makeFakeStream`.
 *
 * The model (NET_INTERFACE → Validation → "A stream read is bounded in time
 * as well as in bytes"; → "A stream write is bounded in time as well"):
 *
 *   - The stream is `AsyncIterable<Uint8Array>`. A reader iterates it to read
 *     the frame the case feeds; once the iterable ends, the reader sees `done`
 *     as it would on a real stream whose remote closed its write side.
 *   - `send(data)` records the chunk into `written` and returns `true` by
 *     default; `setSendReturn('once-false')` makes the very next `send` return
 *     `false` so a case can exercise the backpressure path.
 *   - `onDrain(opts?)` resolves immediately by default; `holdDrain()` makes it
 *     park on a promise the case releases with `releaseDrain()` (or rejects
 *     through the passed `AbortSignal`).
 *   - `close(opts?)` records that the writable end closed; `holdClose()`
 *     makes it park the same way `onDrain` can be made to park.
 *   - `abort(err)` records the error; subsequent `send` is a no-op, and a
 *     pending drain / close rejects with that error.
 */

export interface FakeStream extends AsyncIterable<Uint8Array> {
  /** The chunks `send` has been called with, in order. */
  readonly written: Uint8Array[];
  /** True after `close` has resolved. */
  readonly closed: boolean;
  /** The error passed to `abort`, or `null`. */
  readonly aborted: Error | null;

  /** The write-side API the production code drives. */
  send: (data: Uint8Array) => boolean;
  onDrain: (opts?: { signal?: AbortSignal }) => Promise<void>;
  close: (opts?: { signal?: AbortSignal }) => Promise<void>;
  abort: (err: Error) => void;

  /** Make the next `send` call return `false` once — then `true` again. */
  setSendReturnOnceFalse: () => void;
  /** Hold `onDrain` until `releaseDrain()` or the signal aborts. */
  holdDrain: () => void;
  /** Release a held `onDrain`. */
  releaseDrain: () => void;
  /** Hold `close` until `releaseClose()` or the signal aborts. */
  holdClose: () => void;
  /** Release a held `close`. */
  releaseClose: () => void;
}

/**
 * The input shape a case feeds. `AsyncIterable<Uint8Array>` is the general
 * form; an array of frames is accepted for the common case where the case
 * knows every chunk up front. An array is iterated once and then the stream
 * ends — same shape a real remote presents when it has closed its write side.
 */
export type FakeStreamInput = AsyncIterable<Uint8Array> | Uint8Array[];

function toAsyncIterable(input: FakeStreamInput): AsyncIterable<Uint8Array> {
  if (Array.isArray(input)) {
    return (async function* () {
      for (const chunk of input) yield chunk;
    })();
  }
  return input;
}

export function makeFakeStream(input: FakeStreamInput = []): FakeStream {
  const written: Uint8Array[] = [];
  let closed = false;
  let aborted: Error | null = null;
  let sendOnceFalse = false;

  let drainHeld = false;
  let drainResolver: (() => void) | null = null;
  let drainRejecter: ((err: Error) => void) | null = null;

  let closeHeld = false;
  let closeResolver: (() => void) | null = null;
  let closeRejecter: ((err: Error) => void) | null = null;

  const source = toAsyncIterable(input);

  const stream: FakeStream = {
    [Symbol.asyncIterator]() {
      return source[Symbol.asyncIterator]();
    },
    get written() { return written; },
    get closed() { return closed; },
    get aborted() { return aborted; },

    send(data: Uint8Array): boolean {
      if (aborted !== null) return false;
      written.push(data);
      if (sendOnceFalse) {
        sendOnceFalse = false;
        return false;
      }
      return true;
    },

    async onDrain(opts?: { signal?: AbortSignal }): Promise<void> {
      if (!drainHeld) return;
      return new Promise<void>((resolve, reject) => {
        drainResolver = () => { drainResolver = null; drainRejecter = null; resolve(); };
        drainRejecter = (err) => { drainResolver = null; drainRejecter = null; reject(err); };
        if (opts?.signal) {
          if (opts.signal.aborted) {
            drainRejecter(new Error('aborted'));
            return;
          }
          opts.signal.addEventListener('abort', () => {
            if (drainRejecter) drainRejecter(new Error('aborted'));
          }, { once: true });
        }
      });
    },

    async close(opts?: { signal?: AbortSignal }): Promise<void> {
      if (!closeHeld) {
        closed = true;
        return;
      }
      return new Promise<void>((resolve, reject) => {
        closeResolver = () => { closeResolver = null; closeRejecter = null; closed = true; resolve(); };
        closeRejecter = (err) => { closeResolver = null; closeRejecter = null; reject(err); };
        if (opts?.signal) {
          if (opts.signal.aborted) {
            closeRejecter(new Error('aborted'));
            return;
          }
          opts.signal.addEventListener('abort', () => {
            if (closeRejecter) closeRejecter(new Error('aborted'));
          }, { once: true });
        }
      });
    },

    abort(err: Error): void {
      aborted = err;
      if (drainRejecter) drainRejecter(err);
      if (closeRejecter) closeRejecter(err);
    },

    setSendReturnOnceFalse() { sendOnceFalse = true; },
    holdDrain() { drainHeld = true; },
    releaseDrain() {
      drainHeld = false;
      if (drainResolver) drainResolver();
    },
    holdClose() { closeHeld = true; },
    releaseClose() {
      closeHeld = false;
      if (closeResolver) closeResolver();
    },
  };

  return stream;
}
