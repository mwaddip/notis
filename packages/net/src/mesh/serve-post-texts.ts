// NET_INTERFACE → Readers → "A serving reader answers from what it holds" —
// the browser half. `answerPostTextsRequest` builds one `ModifierResponse`
// (5) frame from the texts the provider holds; `postTextsHandler` answers
// a stream on `SYNC_PROTOCOL` under its deadlines, at most one request a
// connection at a time.
//
// Browser-safe: imports no Node built-in. The frame codec is handed
// `@dagsocial/types`' `hash32` (NET_INTERFACE → The browser entry →
// "The frame codec is one code with its checksum handed in").

import { encodePostBody, encodeStruct, hash32 } from '@dagsocial/types';
import {
  encodeFrame as encodeFrameWithHash,
  decodeFrame as decodeFrameWithHash,
} from '../frame-codec.js';
import type { HashFn } from '../frame-codec.js';
import {
  modifierRequestCodec,
  modifierResponseCodec,
} from '../modifier-codec.js';
import { tryDecodeStruct } from '../codec-helpers.js';
import {
  MSG_MODIFIER_REQUEST,
  MSG_MODIFIER_RESPONSE,
  MODIFIER_POST_BODY,
} from '../types.js';
import { MAX_MODIFIER_REQUEST_FRAME_BYTES, MAX_SERVE_BODY_BYTES } from '../msg-guards.js';
import {
  readStreamBounded,
  sinkWithDeadline,
} from '../util.js';

/**
 * NET_INTERFACE → Readers → "A serving reader answers from what it holds":
 * the texts the serving reader holds, keyed by post id. The caller answers
 * what it has for the ids the request names — ids it lacks are left out.
 */
export type PostTextProvider = (
  ids: readonly string[],
) => Promise<ReadonlyMap<string, string>>;

// A fresh HashFn per call so this module holds no state. The browser
// frame codec is parameterized through `../frame-codec.js`
// (NET_INTERFACE → The browser entry → "The frame codec is one code
// with its checksum handed in").
function browserHashFn(): HashFn {
  return (data) => hash32(data);
}

/**
 * NET_INTERFACE → Readers → "A serving reader answers from what it holds":
 * build one `ModifierResponse` (5) frame from the texts the provider holds.
 *
 * Returns the frame bytes, `null` to answer the stream with zero bytes (the
 * "no body I hold" signal), or `'refuse'` to close the stream unanswered.
 *
 * Refuses on another code, another typeId, another network's magic, or a
 * frame that does not decode; answers zero bytes when the provider holds
 * none of the asked ids or when the provider rejects.
 */
export async function answerPostTextsRequest(
  raw: Uint8Array,
  magic: number,
  texts: PostTextProvider,
): Promise<Uint8Array | null | 'refuse'> {
  let framed: { code: number; body: Uint8Array };
  try {
    framed = decodeFrameWithHash(magic, raw, browserHashFn());
  } catch {
    return 'refuse';
  }
  if (framed.code !== MSG_MODIFIER_REQUEST) return 'refuse';

  const req = tryDecodeStruct(modifierRequestCodec, framed.body);
  if (req === null) return 'refuse';
  if (req.typeId !== MODIFIER_POST_BODY) return 'refuse';

  let held: ReadonlyMap<string, string>;
  try {
    held = await texts(req.ids);
  } catch {
    // NET_INTERFACE → Readers → "A serving reader answers from what it
    // holds" — a provider that rejects answers zero bytes.
    return null;
  }

  const modifiers: { id: string; data: Uint8Array }[] = [];
  let bodyBytes = 0;
  for (const id of req.ids) {
    const text = held.get(id);
    if (text === undefined) continue;
    const data = encodePostBody(text);
    if (modifiers.length > 0 && bodyBytes + data.length > MAX_SERVE_BODY_BYTES) break;
    bodyBytes += data.length;
    modifiers.push({ id, data });
  }

  if (modifiers.length === 0) return null;

  const body = encodeStruct(modifierResponseCodec, {
    typeId: MODIFIER_POST_BODY,
    modifiers,
  });
  return encodeFrameWithHash(magic, MSG_MODIFIER_RESPONSE, body, browserHashFn());
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
  onDrain(opts?: { signal?: AbortSignal }): Promise<void>;
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
 * the handler the browser build registers on `SYNC_PROTOCOL`. One request
 * a connection at a time — a stream that opens while another on the same
 * connection is being answered is closed unanswered.
 */
export function postTextsHandler(
  o: PostTextsHandlerOptions,
): (stream: PostTextsStream, connection: PostTextsConnection) => Promise<void> {
  const inFlight = new Set<string>();

  const closeQuietly = async (stream: PostTextsStream): Promise<void> => {
    try { await stream.close(); } catch { /* already gone */ }
  };

  return async (stream: PostTextsStream, connection: PostTextsConnection): Promise<void> => {
    if (!o.accept(connection.id)) {
      await closeQuietly(stream);
      return;
    }
    if (inFlight.has(connection.id)) {
      // NET_INTERFACE → Readers → "A serving reader answers from what it
      // holds" — "One stream at a time per connection".
      await closeQuietly(stream);
      return;
    }
    inFlight.add(connection.id);
    try {
      let raw: Uint8Array | null;
      try {
        raw = await readStreamBounded(
          stream,
          MAX_MODIFIER_REQUEST_FRAME_BYTES,
          AbortSignal.timeout(o.timeoutMs),
        );
      } catch {
        // A read that times out or fails ends the stream unanswered —
        // `answerPostTextsRequest` does not run on bytes the peer never sent.
        return;
      }
      if (raw === null) return;      // over the request-frame bound.

      const answer = await answerPostTextsRequest(raw, o.magic, o.texts);
      if (answer === 'refuse') return;

      const bytes = answer ?? new Uint8Array(0);
      try {
        await sinkWithDeadline(stream, bytes, o.timeoutMs);
      } catch { /* the write ended by itself; the finally will close */ }
    } finally {
      inFlight.delete(connection.id);
      await closeQuietly(stream);
    }
  };
}
