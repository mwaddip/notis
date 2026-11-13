// NET_INTERFACE → Readers → "A serving reader answers from what it holds" —
// the browser half of the serving reader: `answerPostTextsRequest` builds
// one `ModifierResponse` (5) frame from the texts the provider holds, and
// `postTextsHandler` answers a stream on `SYNC_PROTOCOL` under its
// deadlines. Browser-safe path: reached through `@dagsocial/net/browser`.

import { describe, it, expect, vi } from 'vitest';
import {
  MSG_MODIFIER_RESPONSE,
  MSG_SYNC_INFO,
  MODIFIER_POST_BODY,
  MAGIC_DEVNET,
  MAGIC_TESTNET,
  decodeFrame,
  decodeModifierResponse,
  encodeModifierRequest,
  modifierRequestCodec,
} from '../../src/index.js';
import { encodeFrame } from '../../src/frame.js';
import {
  answerPostTextsRequest,
  postTextsHandler,
} from '../../src/mesh/serve-post-texts.js';
import type { PostTextProvider } from '../../src/mesh/serve-post-texts.js';
import { decodePostBody, encodeStruct } from '@dagsocial/types';
import { makeFakeStream } from '../fake-stream.js';
import { MAX_MODIFIER_REQUEST_FRAME_BYTES, MAX_SERVE_BODY_BYTES } from '../../src/msg-guards.js';

// The devnet magic is this suite's — a serving reader's frames carry the
// network's own magic (NET_INTERFACE → Magic Bytes).
const MAGIC = MAGIC_DEVNET;

const H = (hex: string): string => hex.padStart(64, '0');

function mapOf(entries: ReadonlyArray<readonly [string, string]>): ReadonlyMap<string, string> {
  return new Map(entries);
}

function heldProvider(entries: ReadonlyArray<readonly [string, string]>): PostTextProvider {
  const held = mapOf(entries);
  return async (ids) => {
    const out = new Map<string, string>();
    for (const id of ids) {
      const text = held.get(id);
      if (text !== undefined) out.set(id, text);
    }
    return out;
  };
}

/** Try to decode a response frame; return null on any failure. */
function safeDecodeResp(bytes: Uint8Array | null | 'refuse'): {
  typeId: number;
  pairs: { id: string; text: string }[];
} | null {
  if (!(bytes instanceof Uint8Array)) return null;
  let framed: { code: number; body: Uint8Array };
  try { framed = decodeFrame(MAGIC, bytes); } catch { return null; }
  if (framed.code !== MSG_MODIFIER_RESPONSE) return null;
  const body = decodeModifierResponse(framed.body);
  if (body === null) return null;
  const pairs: { id: string; text: string }[] = [];
  for (const m of body.modifiers) {
    let text: string;
    try { text = decodePostBody(m.data); } catch { return null; }
    pairs.push({ id: m.id, text });
  }
  return { typeId: body.typeId, pairs };
}

describe("NET_INTERFACE → Readers — a serving reader answers from what it holds", () => {
  const id1 = H('11');
  const id2 = H('22');
  const id3 = H('33');
  const idX = H('ee');

  it('answers the held texts, zero bytes for none', async () => {
    const provider = heldProvider([[id1, 'first text'], [id3, 'third text']]);
    const req = encodeModifierRequest(MAGIC, { typeId: MODIFIER_POST_BODY, ids: [id1, id2, id3] });
    const resp = await answerPostTextsRequest(req, MAGIC, provider).catch(() => null);
    const decoded = safeDecodeResp(resp);

    const reqNone = encodeModifierRequest(MAGIC, { typeId: MODIFIER_POST_BODY, ids: [idX] });
    const respNone = await answerPostTextsRequest(reqNone, MAGIC, provider).catch(() => 'threw' as const);

    expect({
      typeId: decoded?.typeId,
      pairs: decoded?.pairs,
      none: respNone,
    }).toEqual({
      typeId: MODIFIER_POST_BODY,
      pairs: [{ id: id1, text: 'first text' }, { id: id3, text: 'third text' }],
      none: null,
    });
  });

  it('answers only the asked ids, in request order', async () => {
    // The provider's map carries an id the request did not name, and the
    // asked ids in a different order from the request's.
    const provider: PostTextProvider = async () => new Map([
      [idX, 'uninvited'],
      [id2, 'two'],
      [id1, 'one'],
    ]);
    const req = encodeModifierRequest(MAGIC, { typeId: MODIFIER_POST_BODY, ids: [id1, id2] });
    const resp = await answerPostTextsRequest(req, MAGIC, provider).catch(() => null);
    const decoded = safeDecodeResp(resp);
    expect(decoded?.pairs).toEqual([
      { id: id1, text: 'one' },
      { id: id2, text: 'two' },
    ]);
  });

  it('stops at MAX_SERVE_BODY_BYTES, the first body always sent', async () => {
    // Three held texts whose `encodePostBody` is 1.5 MiB each — two fit under
    // `MAX_SERVE_BODY_BYTES` (4 MiB), the third would push the total past it.
    // No legal post is this long; the provider is the case's own. The size
    // sits below `MAX_ORDERING_BLOCK_BYTES` (2 MiB) so the response reads
    // back through `decodeModifierResponse`'s per-data bound.
    const chunk = 1_500_000;
    const text = 'x'.repeat(chunk);
    const provider: PostTextProvider = async () => new Map([
      [id1, text], [id2, text], [id3, text],
    ]);
    const req = encodeModifierRequest(MAGIC, {
      typeId: MODIFIER_POST_BODY,
      ids: [id1, id2, id3],
    });
    const resp = await answerPostTextsRequest(req, MAGIC, provider).catch(() => null);
    const decoded = safeDecodeResp(resp);

    // The first body alone — above the cap, so no legal post in this range
    // and so past `decodeModifierResponse`'s per-data bound as well. The
    // check is on the raw bytes: the response frame carries the oversized
    // body and its length is at least `MAX_SERVE_BODY_BYTES`.
    const soloText = 'y'.repeat(MAX_SERVE_BODY_BYTES);
    const soloProvider: PostTextProvider = async () => new Map([[id1, soloText]]);
    const soloReq = encodeModifierRequest(MAGIC, {
      typeId: MODIFIER_POST_BODY,
      ids: [id1],
    });
    const soloResp = await answerPostTextsRequest(soloReq, MAGIC, soloProvider)
      .catch(() => 'threw' as const);
    const soloBytes = soloResp instanceof Uint8Array ? soloResp.length : 0;

    expect({
      twoReqIds: decoded?.pairs.map((p) => p.id) ?? null,
      soloCarries: soloBytes > MAX_SERVE_BODY_BYTES,
    }).toEqual({
      twoReqIds: [id1, id2],
      soloCarries: true,
    });
  });

  it('refuses another code, typeId, magic or an undecodable frame', async () => {
    const provider = heldProvider([[id1, 'one']]);

    // (1) A well-formed `modifierRequestCodec` body for a held id, framed
    // under `MSG_SYNC_INFO` — the body would answer, but the code is not
    // `MSG_MODIFIER_REQUEST`.
    const wellFormedRequestBody = encodeStruct(modifierRequestCodec, {
      typeId: MODIFIER_POST_BODY,
      ids: [id1],
    });
    const wrongCode = encodeFrame(MAGIC, MSG_SYNC_INFO, wellFormedRequestBody);
    const r1 = await answerPostTextsRequest(wrongCode, MAGIC, provider).catch(() => 'threw' as const);

    // (2) A ModifierRequest with a typeId that is not MODIFIER_POST_BODY.
    const badTypeId = encodeModifierRequest(MAGIC, { typeId: 101, ids: [id1] });
    const r2 = await answerPostTextsRequest(badTypeId, MAGIC, provider).catch(() => 'threw' as const);

    // (3) A ModifierRequest framed under another network's magic.
    const wrongMagic = encodeModifierRequest(MAGIC_TESTNET, { typeId: MODIFIER_POST_BODY, ids: [id1] });
    const r3 = await answerPostTextsRequest(wrongMagic, MAGIC, provider).catch(() => 'threw' as const);

    // (4) Seven bytes that cannot be a frame.
    const r4 = await answerPostTextsRequest(new Uint8Array([1, 2, 3, 4, 5, 6, 7]), MAGIC, provider)
      .catch(() => 'threw' as const);

    expect([r1, r2, r3, r4]).toEqual(['refuse', 'refuse', 'refuse', 'refuse']);
  });

  it('a provider that rejects answers zero bytes', async () => {
    const provider: PostTextProvider = async () => { throw new Error('store is down'); };
    const req = encodeModifierRequest(MAGIC, { typeId: MODIFIER_POST_BODY, ids: [id1] });
    const resp = await answerPostTextsRequest(req, MAGIC, provider).catch(() => 'threw' as const);
    expect(resp).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// The handler shape the browser build registers against the pinned libp2p's
// `handle`. One stream carries one request; a connection serves at most one
// request at a time.
// ---------------------------------------------------------------------------

type HandlerConnection = {
  readonly id: string;
  readonly remotePeer: { toString(): string };
};

type Handler = (
  stream: ReturnType<typeof makeFakeStream>,
  connection: HandlerConnection,
) => Promise<void>;

function makeConnection(id: string): HandlerConnection {
  return { id, remotePeer: { toString: () => `peer-${id}` } };
}

describe('NET_INTERFACE → Readers — the serving reader handler', () => {
  const id1 = H('11');

  it('the handler answers a stream on an accepted connection', async () => {
    const provider = heldProvider([[id1, 'the one']]);
    const handler: Handler = postTextsHandler({
      magic: MAGIC,
      texts: provider,
      timeoutMs: 1_000,
      accept: () => true,
    }) as unknown as Handler;

    const req = encodeModifierRequest(MAGIC, { typeId: MODIFIER_POST_BODY, ids: [id1] });
    const stream = makeFakeStream([req]);
    await handler(stream, makeConnection('c1')).catch(() => { /* a handler never rejects */ });

    const written = stream.written;
    const bytes = written.length === 1 ? written[0]! : new Uint8Array(0);
    const decoded = safeDecodeResp(bytes);
    expect({
      pairs: decoded?.pairs,
      closed: stream.closed,
    }).toEqual({
      pairs: [{ id: id1, text: 'the one' }],
      closed: true,
    });
  });

  it('the handler ends a stream on a connection it does not accept, unanswered', async () => {
    const provider = heldProvider([[id1, 'the one']]);
    const handler: Handler = postTextsHandler({
      magic: MAGIC,
      texts: provider,
      timeoutMs: 1_000,
      accept: () => false,
    }) as unknown as Handler;

    const req = encodeModifierRequest(MAGIC, { typeId: MODIFIER_POST_BODY, ids: [id1] });
    const stream = makeFakeStream([req]);
    await handler(stream, makeConnection('c-refused')).catch(() => { /* never rejects */ });

    const bytesWritten = stream.written.reduce((s, b) => s + b.length, 0);
    expect({ closed: stream.closed, bytesWritten }).toEqual({ closed: true, bytesWritten: 0 });
  });

  it('one request at a time per connection', async () => {
    const id1 = H('11');
    const id2 = H('22');
    // The first stream's provider parks on `firstGate` the case releases;
    // the second stream opens on the same connection while the first is
    // still being answered.
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstEntered = false;
    const firstProvider: PostTextProvider = async () => {
      firstEntered = true;
      await firstGate;
      return new Map([[id1, 'first']]);
    };

    const handler: Handler = postTextsHandler({
      magic: MAGIC,
      texts: firstProvider,
      timeoutMs: 5_000,
      accept: () => true,
    }) as unknown as Handler;

    const conn = makeConnection('cx');
    const req1 = encodeModifierRequest(MAGIC, { typeId: MODIFIER_POST_BODY, ids: [id1] });
    const req2 = encodeModifierRequest(MAGIC, { typeId: MODIFIER_POST_BODY, ids: [id2] });
    const s1 = makeFakeStream([req1]);
    const s2 = makeFakeStream([req2]);

    const p1 = handler(s1, conn).catch(() => { /* never rejects */ });
    // Wait on the first handler entering the provider — the connection's
    // id is already in the in-flight set at this point.
    await vi.waitFor(() => expect(firstEntered).toBe(true));
    const p2 = handler(s2, conn).catch(() => { /* never rejects */ });
    // Wait on the second stream being closed — its unanswered end-of-life
    // is what "one request at a time" means.
    await vi.waitFor(() => expect(s2.closed).toBe(true));

    const s2WrittenBeforeRelease = s2.written.reduce((s, b) => s + b.length, 0);
    const s2ClosedBeforeRelease = s2.closed;

    releaseFirst();
    await p1;
    await p2;

    const decoded1 = safeDecodeResp(s1.written.length === 1 ? s1.written[0]! : new Uint8Array(0));
    expect({
      s1Pairs: decoded1?.pairs,
      s2WrittenBeforeRelease,
      s2ClosedBeforeRelease,
      s2Closed: s2.closed,
    }).toEqual({
      s1Pairs: [{ id: id1, text: 'first' }],
      s2WrittenBeforeRelease: 0,
      s2ClosedBeforeRelease: true,
      s2Closed: true,
    });
  });

  it('the handler ends a stream that sends nothing within timeoutMs, unanswered', async () => {
    const provider = heldProvider([[id1, 'one']]);
    const handler: Handler = postTextsHandler({
      magic: MAGIC,
      texts: provider,
      timeoutMs: 20,
      accept: () => true,
    }) as unknown as Handler;

    // A source that never yields — the handler's read must hit the deadline.
    const neverSource: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<Uint8Array>> {
            return new Promise<IteratorResult<Uint8Array>>(() => { /* never resolves */ });
          },
          return(): Promise<IteratorResult<Uint8Array>> {
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
    const stream = makeFakeStream(neverSource);
    await handler(stream, makeConnection('c-silent')).catch(() => { /* never rejects */ });

    const bytesWritten = stream.written.reduce((s, b) => s + b.length, 0);
    expect({ closed: stream.closed, bytesWritten }).toEqual({ closed: true, bytesWritten: 0 });
  });

  it('the handler ends a stream past MAX_MODIFIER_REQUEST_FRAME_BYTES, unanswered', async () => {
    const provider = heldProvider([[id1, 'one']]);
    const handler: Handler = postTextsHandler({
      magic: MAGIC,
      texts: provider,
      timeoutMs: 1_000,
      accept: () => true,
    }) as unknown as Handler;

    // A well-formed request for a held id, followed by zero-byte padding
    // until the whole input is past `MAX_MODIFIER_REQUEST_FRAME_BYTES`. The
    // wire's `decodeFrame` ignores bytes after the body, so the request
    // would answer `encodePostBody('one')` — only the handler's byte cap
    // stands between the input and that answer.
    const req = encodeModifierRequest(MAGIC, { typeId: MODIFIER_POST_BODY, ids: [id1] });
    const padding = new Uint8Array(MAX_MODIFIER_REQUEST_FRAME_BYTES - req.length + 1);
    const stream = makeFakeStream([req, padding]);
    await handler(stream, makeConnection('c-oversize')).catch(() => { /* never rejects */ });

    const bytesWritten = stream.written.reduce((s, b) => s + b.length, 0);
    expect({ closed: stream.closed, bytesWritten }).toEqual({ closed: true, bytesWritten: 0 });
  });
});

