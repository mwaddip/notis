// NET_INTERFACE → Readers → "A serving reader answers from what it holds" —
// the browser half. `answerPostTextsRequest` builds one `ModifierResponse`
// (5) frame from the texts the provider holds; `postTextsHandler` answers
// a stream on `SYNC_PROTOCOL` under its deadlines, at most one request a
// connection at a time.
//
// Browser-safe: imports no Node built-in.

/**
 * NET_INTERFACE → Readers → "A serving reader answers from what it holds":
 * the texts the serving reader holds, keyed by post id. The caller answers
 * what it has for the ids the request names — ids it lacks are left out.
 */
export type PostTextProvider = (
  ids: readonly string[],
) => Promise<ReadonlyMap<string, string>>;

/**
 * NET_INTERFACE → Readers → "A serving reader answers from what it holds":
 * build one `ModifierResponse` (5) frame from the texts the provider holds.
 *
 * Returns the frame bytes, `null` to answer the stream with zero bytes (the
 * "no body I hold" signal), or `'refuse'` to close the stream unanswered.
 */
export async function answerPostTextsRequest(
  _raw: Uint8Array,
  _magic: number,
  _texts: PostTextProvider,
): Promise<Uint8Array | null | 'refuse'> {
  // Stub — the rule lands with the serving reader's implementation.
  throw new Error('answerPostTextsRequest is not implemented');
}

/**
 * NET_INTERFACE → Readers — `postTextsHandler`'s options.
 */
export interface PostTextsHandlerOptions {
  readonly magic: number;
  readonly texts: PostTextProvider;
  readonly timeoutMs: number;
  readonly accept: (connectionId: string) => boolean;
}

/**
 * The write side of a libp2p 3.x stream — the shape `postTextsHandler`
 * writes through.
 */
interface WritableStreamApi {
  send(data: Uint8Array): boolean;
  onDrain?(opts?: { signal?: AbortSignal }): Promise<void>;
  close(opts?: { signal?: AbortSignal }): Promise<void>;
  abort(err: Error): void;
}

/** The shape libp2p 3.x hands a `handle` callback. */
export type PostTextsStream =
  AsyncIterable<Uint8Array | { subarray(): Uint8Array }> & WritableStreamApi;

/** The connection the callback is handed. Reads `.id` through `accept`. */
export interface PostTextsConnection {
  readonly id: string;
  readonly remotePeer: { toString(): string };
}

/**
 * NET_INTERFACE → Readers → "A serving reader answers from what it holds":
 * the handler the browser build registers on `SYNC_PROTOCOL`.
 */
export function postTextsHandler(
  _o: PostTextsHandlerOptions,
): (stream: PostTextsStream, connection: PostTextsConnection) => Promise<void> {
  // Stub — the serving reader's implementation registers the rule.
  return async (stream: PostTextsStream, _connection: PostTextsConnection): Promise<void> => {
    try { stream.send(new Uint8Array([0xff])); } catch { /* already gone */ }
    try { await stream.close(); } catch { /* already gone */ }
  };
}
