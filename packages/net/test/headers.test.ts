import { describe, it, expect, afterEach } from 'vitest';
import { encode } from 'cbor-x';
import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import {
  PROTOCOL_VERSION,
  ByteWriter,
  writeVlqU,
  encodeOrderingBlock,
  decodeStruct,
  ReaderError,
  CodecError,
} from '@dagsocial/types';
import {
  blockHash,
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyOrderingBlockStructure,
  verifyPostBody,
} from '@dagsocial/validation';
import { SYNC_PROTOCOL } from '../src/sync.js';
import { NetNode, serveBlocksResponse, serveHeadersResponse } from '../src/node.js';
import type {
  GetBlocksMsg, GetHeadersMsg, NetConfig, NetValidators,
} from '../src/types.js';
import { MSG_BLOCKS, MSG_GET_BLOCKS, MSG_GET_HEADERS, MSG_HEADERS } from '../src/types.js';
import {
  decodeBlocks,
  decodeGetBlocks,
  decodeGetHeaders,
  decodeHeaders,
  encodeBlocks,
  encodeGetBlocks,
  encodeGetHeaders,
  encodeHeaders,
  getHeadersCodec,
  getBlocksCodec,
} from '../src/sync-codec.js';
import { decodeFrame } from '../src/frame.js';
import { MAX_CHAIN_RESPONSE_ITEMS, MAX_SERVE_BODY_BYTES } from '../src/msg-guards.js';
import { mergeUint8Arrays } from '../src/util.js';

const MAGIC = 0x54444147;

/** The body of a framed message, with its code checked first. */
function bodyOf(frame: Uint8Array, expectedCode: number): Uint8Array {
  const decoded = decodeFrame(MAGIC, frame);
  expect(decoded.code).toBe(expectedCode);
  return decoded.body;
}

/** Response bodies, for the assertions that are about the codec rather than the frame. */
const headersBody = (headers: BlockHeader[]): Uint8Array =>
  bodyOf(encodeHeaders(MAGIC, headers), MSG_HEADERS);
/** `encodeBlocks` frames what the serve loop already encoded, so fixtures encode first. */
const blocksFrame = (blocks: OrderingBlock[]): Uint8Array =>
  encodeBlocks(MAGIC, blocks.map(encodeOrderingBlock));
const blocksBody = (blocks: OrderingBlock[]): Uint8Array =>
  bodyOf(blocksFrame(blocks), MSG_BLOCKS);

// ---------------------------------------------------------------------------
// Mock data helpers
// ---------------------------------------------------------------------------

/**
 * `blockHash` for fixtures that are inside the header domain by
 * construction.
 *
 * Every header this suite hashes is a `makeMockHeader` product or a round-trip
 * of one, so `blockHash`'s domain guard can never fire here. A bare `!` would
 * hide the
 * day that stops being true: it types `null` as `string`, and the `null` then
 * surfaces as a failed hash comparison several assertions later, blaming the
 * chain link rather than the fixture. Throwing at the fixture names the real
 * cause.
 *
 * The calls over *decoded* headers (the round-trip chain-link assertions) get
 * something extra for free: they now also prove the header survives the wire
 * still inside the encodable domain, since a `validatorId` that came back as
 * anything but 32 bytes would trip this instead of hashing.
 */
function mockBlockHash(header: BlockHeader): string {
  const hash = blockHash(header);
  if (hash === null) {
    throw new Error('fixture header is outside the encodable header domain');
  }
  return hash;
}

function makeMockHeader(
  height: number,
  prevBlockHash: string,
  // 1/256-bit units — VALIDATION_INTERFACE → orderingPowTarget. Nothing in this
  // suite asserts work or verifies PoW, so what the scale buys here is the
  // two-byte `writeVlqU` width a real header carries, not a different verdict.
  targetBits = 4 * 256,
): BlockHeader {
  return {
    protocolVersion: PROTOCOL_VERSION,
    height,
    prevBlockHash,
    utxoTxRoot: '00'.repeat(32),
    stateRoot: '00'.repeat(33),
    validatorId: new Uint8Array(32),
    powNonce: height * 100,
    powTargetBits: targetBits,
    createdAt: 1000000 + height * 10000,
  };
}

/** A block's settlement id — height-bearing, so a body identifies its block. */
function settlementId(height: number): string {
  return height.toString(16).padStart(64, '0');
}

function makeMockOrderingBlock(
  height: number,
  prevBlockHash: string,
): OrderingBlock {
  return {
    header: makeMockHeader(height, prevBlockHash),
    utxoTxTree: {
      // Every block carries at least one transaction, because the settlement is
      // one (VALIDATION_INTERFACE → verifyOrderingBlockStructure;
      // NODE_INTERFACE → It is the LAST entry in `utxoTxIds`). An empty body is
      // refused at Stage 1, so it is not a block this suite could ever receive.
      //
      // Both the id and the payload carry the height, which is what lets a
      // round-trip assert that THIS block's body came back rather than merely
      // that a well-formed one did. The bytes stay opaque to every layer that
      // moves a block, so their content is a plausible weight and nothing more.
      utxoTxIds: [settlementId(height)],
      utxoTxs: [new Uint8Array(96).fill(height & 0xff)],
      pruneEntries: [],
    },
    validatorSignature: new Uint8Array(64),
  };
}

/** A store of contiguous blocks 1..n, each linked to the one below it. */
function makeChain(n: number): Map<number, OrderingBlock> {
  const store = new Map<number, OrderingBlock>();
  let prev = '00'.repeat(32);
  for (let h = 1; h <= n; h++) {
    const block = makeMockOrderingBlock(h, prev);
    store.set(h, block);
    prev = mockBlockHash(block.header);
  }
  return store;
}

/**
 * A block carrying `payloadBytes` of transaction body.
 *
 * Weight goes into `utxoTxs`, with the aligned `utxoTxIds` entry a transaction
 * also costs, because that is where a real block carries it: the elements are
 * opaque byte arrays to every layer that moves a block, so a serve loop weighing
 * one weighs exactly this.
 */
function makeHeavyBlock(
  height: number,
  prevBlockHash: string,
  payloadBytes: number,
): OrderingBlock {
  const block = makeMockOrderingBlock(height, prevBlockHash);
  block.utxoTxTree.utxoTxIds = ['ab'.repeat(32)];
  block.utxoTxTree.utxoTxs = [new Uint8Array(payloadBytes)];
  return block;
}

/** A chain 1..n whose blocks each carry `payloadBytes` of body. */
function makeHeavyChain(n: number, payloadBytes: number): Map<number, OrderingBlock> {
  const store = new Map<number, OrderingBlock>();
  let prev = '00'.repeat(32);
  for (let h = 1; h <= n; h++) {
    const block = makeHeavyBlock(h, prev, payloadBytes);
    store.set(h, block);
    prev = mockBlockHash(block.header);
  }
  return store;
}

/**
 * Our own tip as the serve arms receive it: what node hands over through
 * setChainHeightProvider, the store's maximum height
 * (NET_INTERFACE → Sync Handler Registration).
 */
function tipOf(store: Map<number, OrderingBlock>): number {
  let max = 0;
  for (const h of store.keys()) if (h > max) max = h;
  return max;
}

/**
 * Serve one request through the **production** serve path, request boundary
 * included.
 *
 * `serveHeadersResponse` / `serveBlocksResponse` are exported for exactly this,
 * and the request goes through the real encode/decode pair too, so the boundary
 * a peer actually hits is the boundary under test. A local re-implementation of
 * either serve loop would agree with the assertions written beside it while
 * neither one touched the encoder production runs — which is how the suite that
 * exists to police these queries stays green through a response wire-format
 * change.
 */
function serveHeaders(request: GetHeadersMsg, store: Map<number, OrderingBlock>): Uint8Array {
  const decoded = decodeGetHeaders(bodyOf(encodeGetHeaders(MAGIC, request), MSG_GET_HEADERS));
  if (!decoded) throw new Error('fixture request was rejected at the decode boundary');
  return serveHeadersResponse(MAGIC, decoded, tipOf(store), (h) => store.get(h) ?? null);
}

function serveBlocks(request: GetBlocksMsg, store: Map<number, OrderingBlock>): Uint8Array {
  const decoded = decodeGetBlocks(bodyOf(encodeGetBlocks(MAGIC, request), MSG_GET_BLOCKS));
  if (!decoded) throw new Error('fixture request was rejected at the decode boundary');
  return serveBlocksResponse(MAGIC, decoded, tipOf(store), (h) => store.get(h) ?? null);
}

/** What `requestHeaders` does with a served frame: cap = what it asked for. */
function receiveHeaders(frame: Uint8Array, maxCount: number): BlockHeader[] | null {
  return decodeHeaders(bodyOf(frame, MSG_HEADERS), maxCount);
}

/** What `requestBlocks` does with a served frame: cap = the range it asked for. */
function receiveBlocks(
  frame: Uint8Array,
  startHeight: number,
  endHeight: number,
): OrderingBlock[] | null {
  return decodeBlocks(bodyOf(frame, MSG_BLOCKS), endHeight - startHeight + 1);
}

// ---------------------------------------------------------------------------
// Tests — the requests are positional, and the code pair is the discriminator
// ---------------------------------------------------------------------------

describe('chain query request encode/decode', () => {
  it('round-trips a GetHeaders request under its own code', () => {
    const frame = encodeGetHeaders(MAGIC, { startHeight: 10, maxCount: 5 });
    expect(decodeGetHeaders(bodyOf(frame, MSG_GET_HEADERS)))
      .toEqual({ startHeight: 10, maxCount: 5 });
  });

  it('round-trips a GetBlocks request under its own code', () => {
    const frame = encodeGetBlocks(MAGIC, { startHeight: 1, endHeight: 3 });
    expect(decodeGetBlocks(bodyOf(frame, MSG_GET_BLOCKS)))
      .toEqual({ startHeight: 1, endHeight: 3 });
  });

  it('carries no discriminator, so the two bodies are interchangeable bytes', () => {
    // Nothing inside the body says which query this is — the same two vlqU
    // fields decode under either codec. What tells the serve arms apart is the
    // frame code, which is why an arm never trusts the body to say which query
    // it is.
    const body = bodyOf(encodeGetHeaders(MAGIC, { startHeight: 7, maxCount: 2 }), MSG_GET_HEADERS);
    expect(decodeGetBlocks(body)).toEqual({ startHeight: 7, endHeight: 2 });
  });

  it('rejects heights outside the advertisable range', () => {
    const w = new ByteWriter();
    writeVlqU(w, 1);
    writeVlqU(w, 200_000_000); // > MAX_ADVERTISED_HEIGHT
    expect(decodeGetHeaders(w.toBytes())).toBeNull();
    expect(decodeGetBlocks(w.toBytes())).toBeNull();

    // The refusal is `out-of-domain`, not a `CodecError` — the heights are
    // well formed; the domain rule is net's, not the boundary check's.
    const bytes = w.toBytes();
    let caught: unknown;
    try { decodeStruct(getHeadersCodec, bytes); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ReaderError);
    expect(caught).not.toBeInstanceOf(CodecError);
    expect((caught as ReaderError).code).toBe('out-of-domain');

    caught = undefined;
    try { decodeStruct(getBlocksCodec, bytes); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ReaderError);
    expect(caught).not.toBeInstanceOf(CodecError);
    expect((caught as ReaderError).code).toBe('out-of-domain');
  });

  it('rejects a truncated, over-long or non-minimal body', () => {
    const body = bodyOf(encodeGetBlocks(MAGIC, { startHeight: 1, endHeight: 3 }), MSG_GET_BLOCKS);

    expect(decodeGetBlocks(body.subarray(0, body.length - 1))).toBeNull();
    expect(decodeGetBlocks(mergeUint8Arrays([body, new Uint8Array([0x00])]))).toBeNull();
    // `0x81 0x00` decodes to 1 exactly as `0x01` does; the re-encode compare is
    // what refuses it (TYPES_INTERFACE → The boundary check, step 3).
    expect(decodeGetBlocks(new Uint8Array([0x81, 0x00, 0x03]))).toBeNull();
  });

  it('rejects a cbor-x map body under either code', () => {
    expect(decodeGetHeaders(new Uint8Array(encode({ startHeight: 10, maxCount: 5 })))).toBeNull();
    expect(
      decodeGetBlocks(new Uint8Array(encode({ startHeight: 1, endHeight: 3, mode: 'blocks' }))),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — response framing round-trip
//
// The responses are `arr(item, lp)` over the same positional codec gossip and
// the store use, not a second `cbor-x` dialect. See `sync-codec.ts` →
// "Headers (15) / Blocks (17) responses".
// ---------------------------------------------------------------------------

describe('chain response framing', () => {
  it('round-trips a multi-block response', () => {
    const store = makeChain(3);
    const blocks = [store.get(1)!, store.get(2)!, store.get(3)!];

    const decoded = decodeBlocks(blocksBody(blocks), 3);

    expect(decoded).not.toBeNull();
    expect(decoded).toHaveLength(3);
    expect(decoded!.map((b) => b.header.height)).toEqual([1, 2, 3]);
    // The whole block survives, not just the header — this is the payload the
    // ordering store writes. Both body arrays are asserted against block 1's
    // own height-bearing values, so a decoder that returned some other block's
    // body, or a shared one, would fail here rather than pass on shape.
    expect(decoded![0]!.utxoTxTree.utxoTxIds).toEqual([settlementId(1)]);
    expect(decoded![0]!.utxoTxTree.utxoTxs[0]).toEqual(new Uint8Array(96).fill(1));
    expect(decoded![0]!.validatorSignature).toBeInstanceOf(Uint8Array);
    expect(decoded![0]!.validatorSignature.length).toBe(64);
    expect(decoded![2]!.header.prevBlockHash).toBe(mockBlockHash(decoded![1]!.header));
  });

  it('round-trips an EMPTY block list, distinctly from no answer at all', () => {
    const empty = blocksBody([]);

    // `vlqU(0)` — one byte, not zero bytes. A serve arm answers zero bytes, and
    // no frame at all, when it cannot answer (no provider, undecodable request,
    // local failure), and `requestBlocks` returns `[]` for that without
    // decoding. The two must not collapse into each other: one says "I have no
    // blocks in that range", the other says "I did not process your request".
    expect(empty).toEqual(new Uint8Array([0]));
    expect(decodeBlocks(empty, 10)).toEqual([]);

    // ...and zero bytes is not a valid encoding of the empty list.
    expect(decodeBlocks(new Uint8Array(0), 10)).toBeNull();
  });

  it('round-trips a multi-header response and an empty one', () => {
    const headers = [
      makeMockHeader(5, 'aa'.repeat(32)),
      makeMockHeader(4, 'bb'.repeat(32)),
      makeMockHeader(3, 'cc'.repeat(32)),
    ];

    const decoded = decodeHeaders(headersBody(headers), 3);
    expect(decoded).not.toBeNull();
    expect(decoded!.map((h) => h.height)).toEqual([5, 4, 3]);
    expect(decoded![0]!.prevBlockHash).toBe('aa'.repeat(32));
    expect(decoded![0]!.validatorId).toBeInstanceOf(Uint8Array);

    expect(headersBody([])).toEqual(new Uint8Array([0]));
    expect(decodeHeaders(new Uint8Array([0]), 20)).toEqual([]);
  });

  it('rejects trailing bytes after a well-formed response', () => {
    const body = blocksBody([makeMockOrderingBlock(1, '00'.repeat(32))]);
    const padded = mergeUint8Arrays([body, new Uint8Array([0x00])]);

    expect(decodeBlocks(body, 1)).not.toBeNull();
    expect(decodeBlocks(padded, 1)).toBeNull();
  });

  it('rejects a non-minimal VLQ count', () => {
    // `0x81 0x00` decodes to 1 exactly as `0x01` does — wire accepts non-minimal
    // VLQ deliberately, and canonicity is enforced by the re-encode compare.
    const canonical = headersBody([makeMockHeader(1, '00'.repeat(32))]);
    expect(canonical[0]).toBe(0x01);

    const padded = mergeUint8Arrays([
      new Uint8Array([0x81, 0x00]),
      canonical.subarray(1),
    ]);
    expect(decodeHeaders(padded, 5)).toBeNull();
  });

  it('rejects a truncated response', () => {
    const body = blocksBody([makeMockOrderingBlock(1, '00'.repeat(32))]);
    expect(decodeBlocks(body.subarray(0, body.length - 1), 1)).toBeNull();
  });

  it('rejects a cbor-x body outright', () => {
    // No shared prefix with the positional layout to misinterpret: a cbor-x
    // body is refused whole.
    const blocks = [makeMockOrderingBlock(1, '00'.repeat(32))];
    expect(decodeBlocks(new Uint8Array(encode({ blocks })), 5)).toBeNull();
    expect(
      decodeHeaders(new Uint8Array(encode([makeMockHeader(1, '00'.repeat(32))])), 5),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — the poisoned payloads, refused AT THE SYNC BOUNDARY
//
// Measured, not theorised. Without a decoder on this path these two fields
// reach `applyOrderingBlock` undecoded, the funnel accepts the block, and the
// ordering store writes a row our own reader then refuses —
// `UnreadableStoredBlockError` → `failStopIfCorruptChain` → `process.exit(1)`,
// fired by the next arriving gossip block and persistent across restarts.
// Gossip refuses both at decode, which leaves this path as the only delivery
// route.
//
// The assertion that matters is WHERE they die: `decodeBlocks` / `decodeHeaders`
// return `null`, so `requestBlocks` throws and no object reaches the node. Refusal
// somewhere later — at the store, at read-back — is the failure being measured,
// not a fix for it.
// ---------------------------------------------------------------------------

describe('poisoned block payloads are refused at the sync boundary', () => {
  /** A block with one field outside its type, as a hostile peer would build it. */
  function poison(mutate: (block: OrderingBlock) => void): OrderingBlock {
    const block = makeMockOrderingBlock(1, '00'.repeat(32));
    mutate(block);
    return block;
  }

  it('refuses a non-byte-view utxoTxs element', () => {
    const block = poison((b) => {
      (b.utxoTxTree.utxoTxs as unknown as unknown[])[0] = 'not-bytes';
    });

    // `writeLp` sentinels the *length prefix*, so the malformed element is
    // undecodable rather than silently truncated. This is the cheaper of the
    // two payloads: `utxoTxRoot` never commits `utxoTxs` and the validator
    // signature covers only the header, so a relaying node can swap it into an
    // otherwise honest block with no PoW and no re-signing.
    expect(decodeBlocks(blocksBody([block]), 1)).toBeNull();
  });

  it('refuses the whole response, not just the poisoned block', () => {
    // A response is one message. Accepting the honest blocks around a malformed
    // one would hand the node a chain with a hole in it and let the peer choose
    // where the hole is.
    const honest = makeMockOrderingBlock(1, '00'.repeat(32));
    const bad = poison((b) => {
      (b.utxoTxTree.utxoTxs as unknown as unknown[])[0] = null;
    });

    expect(
      decodeBlocks(blocksBody([honest, bad, honest]), 3),
    ).toBeNull();
  });

  it('refuses a header outside the encodable domain', () => {
    // The headers arm reaches `findForkPoint` rather than the store, so its
    // consequence differs from the blocks arm — but `createdAt: NaN` and
    // friends collide onto one `blockHash` under a positional encoder, so
    // serving or accepting them is advertising a colliding anchor. `blockHash`
    // returning `null` is the guard one layer in; this is the same value
    // refused at the wire.
    const header = makeMockHeader(1, '00'.repeat(32));
    (header as unknown as Record<string, unknown>)['createdAt'] = Number.NaN;

    expect(blockHash(header)).toBeNull();
    expect(decodeHeaders(headersBody([header]), 5)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — response size is bounded on receipt
// ---------------------------------------------------------------------------

describe('response item caps', () => {
  it('refuses more headers than the caller asked for', () => {
    const store = makeChain(10);
    const headers: BlockHeader[] = [];
    for (let h = 10; h >= 1; h--) headers.push(store.get(h)!.header);

    const frame = encodeHeaders(MAGIC, headers);

    // A peer answering a 3-header request with 10 headers is not answering the
    // question. The caller is the only party that knows what it asked.
    expect(receiveHeaders(frame, 3)).toBeNull();
    expect(receiveHeaders(frame, 10)).toHaveLength(10);
  });

  it('refuses more blocks than the requested range', () => {
    const store = makeChain(5);
    const blocks = [1, 2, 3, 4, 5].map((h) => store.get(h)!);
    const frame = blocksFrame(blocks);

    expect(receiveBlocks(frame, 1, 3)).toBeNull();
    expect(receiveBlocks(frame, 1, 5)).toHaveLength(5);
  });

  it('caps at MAX_CHAIN_RESPONSE_ITEMS however large the request', () => {
    // The requested size is derived from peer-supplied heights, so it is not a
    // bound by itself: `requestBlocks` spans `forkHeight + 1` to a tip height
    // that came off the wire. A real over-cap body, one header past the line.
    const headers = Array.from({ length: MAX_CHAIN_RESPONSE_ITEMS + 1 }, (_, i) =>
      makeMockHeader(i + 1, '00'.repeat(32)),
    );

    expect(decodeHeaders(headersBody(headers), Number.MAX_SAFE_INTEGER)).toBeNull();
    // One fewer is fine — the cap is where it says it is.
    expect(
      decodeHeaders(
        headersBody(headers.slice(0, MAX_CHAIN_RESPONSE_ITEMS)),
        Number.MAX_SAFE_INTEGER,
      ),
    ).toHaveLength(MAX_CHAIN_RESPONSE_ITEMS);
  });

  it('accepts nothing but an empty response for a nonsensical request size', () => {
    const one = blocksBody([makeMockOrderingBlock(1, '00'.repeat(32))]);

    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(decodeBlocks(one, bad)).toBeNull();
      expect(decodeBlocks(blocksBody([]), bad)).toEqual([]);
    }
  });

  it('rejects a four-byte count claiming millions of items', () => {
    // ⚠ What this pins is the rejection, not the *cost* of it. Measured against
    // a mutant with the cap removed: still rejected, because the first `readLp`
    // hits the end of the buffer. What `maxItems` buys over any byte-derived
    // bound is a cap set by the caller's request size, and that is pinned by
    // the over-cap tests above, not here.
    const w = new ByteWriter();
    writeVlqU(w, (1 << 24) - 1);
    const body = w.toBytes();

    expect(body.length).toBe(4);
    expect(decodeBlocks(body, Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — mergeUint8Arrays
// ---------------------------------------------------------------------------

describe('mergeUint8Arrays', () => {
  it('merges multiple chunks into a single array', () => {
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]),
      new Uint8Array([6, 7, 8, 9]),
    ];
    const merged = mergeUint8Arrays(chunks);
    expect(merged).toEqual(
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    );
  });

  it('handles empty array', () => {
    const merged = mergeUint8Arrays([]);
    expect(merged.length).toBe(0);
  });

  it('handles single chunk', () => {
    const chunk = new Uint8Array([42]);
    const merged = mergeUint8Arrays([chunk]);
    expect(merged).toEqual(chunk);
  });
});

// ---------------------------------------------------------------------------
// Tests — serve side: requestHeaders
// ---------------------------------------------------------------------------

describe('serve: GetHeaders', () => {
  it('returns headers newest-first from startHeight', () => {
    const frame = serveHeaders({ startHeight: 5, maxCount: 3 }, makeChain(5));
    const headers = receiveHeaders(frame, 3);

    expect(headers).not.toBeNull();
    expect(headers!.map((h) => h.height)).toEqual([5, 4, 3]);
  });

  it('respects maxCount', () => {
    const headers = receiveHeaders(serveHeaders({ startHeight: 10, maxCount: 2 }, makeChain(10)), 2);
    expect(headers!.map((h) => h.height)).toEqual([10, 9]);
  });

  it('returns empty when no blocks at start height', () => {
    // Clamped to our own tip (2), so the walk starts there and returns 2, 1.
    const headers = receiveHeaders(serveHeaders({ startHeight: 99, maxCount: 20 }, makeChain(2)), 20);
    expect(headers!.map((h) => h.height)).toEqual([2, 1]);

    // An empty store has nothing to clamp to and answers with nothing.
    expect(
      receiveHeaders(serveHeaders({ startHeight: 99, maxCount: 20 }, new Map()), 20),
    ).toEqual([]);
  });

  it('breaks at a hole below the tip', () => {
    const store = makeChain(2);
    // Heights 4 and 5 exist above a gap at 3. Tip is MAX(height)=5;
    // `serveHeadersResponse` walks down from 5 and breaks at the gap.
    store.set(4, makeMockOrderingBlock(4, 'ff'.repeat(32)));
    store.set(5, makeMockOrderingBlock(5, 'ff'.repeat(32)));

    const headers = receiveHeaders(serveHeaders({ startHeight: 5, maxCount: 5 }, store), 5);
    expect(headers!.map((h) => h.height)).toEqual([5, 4]);
  });

  it('serves nothing for a maxCount of zero', () => {
    // A positional request carries `maxCount` always — there is no absent field
    // for a serve-side default to fill in, so zero is a requested count like any
    // other and the arm serves nothing.
    const frame = serveHeaders({ startHeight: 25, maxCount: 0 }, makeChain(25));
    expect(bodyOf(frame, MSG_HEADERS)).toEqual(new Uint8Array([0]));
    expect(receiveHeaders(frame, 0)).toEqual([]);
  });

  it('serves no more than MAX_CHAIN_RESPONSE_ITEMS however many are asked for', () => {
    const store = makeChain(MAX_CHAIN_RESPONSE_ITEMS + 5);
    const frame = serveHeaders(
      { startHeight: MAX_CHAIN_RESPONSE_ITEMS + 5, maxCount: 100_000_000 },
      store,
    );

    // Without the serve-side cap this is a peer-controlled knob over our whole
    // chain: one request, one array holding every block we hold.
    expect(receiveHeaders(frame, MAX_CHAIN_RESPONSE_ITEMS)).toHaveLength(
      MAX_CHAIN_RESPONSE_ITEMS,
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — serve side: requestBlocks
// ---------------------------------------------------------------------------

describe('serve: GetBlocks', () => {
  it('returns full blocks for a height range', () => {
    const frame = serveBlocks({ startHeight: 2, endHeight: 4 }, makeChain(5));
    const blocks = receiveBlocks(frame, 2, 4);

    expect(blocks).not.toBeNull();
    expect(blocks!.map((b) => b.header.height)).toEqual([2, 3, 4]);
  });

  it('skips missing blocks in the range', () => {
    const store = makeChain(1);
    store.set(3, makeMockOrderingBlock(3, 'ff'.repeat(32)));
    store.set(5, makeMockOrderingBlock(5, 'ff'.repeat(32)));

    // Tip is MAX(height)=5; the serve loop skips absent heights (continue).
    const blocks = receiveBlocks(serveBlocks({ startHeight: 1, endHeight: 5 }, store), 1, 5);
    expect(blocks!.map((b) => b.header.height)).toEqual([1, 3, 5]);
  });

  it('returns an empty list when no blocks are in range', () => {
    const frame = serveBlocks({ startHeight: 10, endHeight: 20 }, new Map());
    expect(bodyOf(frame, MSG_BLOCKS)).toEqual(new Uint8Array([0]));
    expect(receiveBlocks(frame, 10, 20)).toEqual([]);
  });

  it('returns blocks with their bodies intact', () => {
    const store = makeChain(1);
    const blocks = receiveBlocks(
      serveBlocks({ startHeight: 1, endHeight: 1 }, store),
      1,
      1,
    );

    expect(blocks).toHaveLength(1);
    const returned = blocks![0]!;
    expect(returned.header.height).toBe(1);
    expect(returned.header.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(returned.utxoTxTree.pruneEntries).toEqual([]);
    expect(returned.utxoTxTree.utxoTxIds).toEqual([settlementId(1)]);
    expect(returned.utxoTxTree.utxoTxs[0]).toEqual(new Uint8Array(96).fill(1));
    expect(returned.validatorSignature).toBeInstanceOf(Uint8Array);
    expect(returned.validatorSignature.length).toBe(64);
    // Byte-identical to what the ordering store holds for the same block: one
    // encoder, not a serve-side re-rendering of it.
    expect(encodeOrderingBlock(returned)).toEqual(encodeOrderingBlock(store.get(1)!));
  });

  it('serves no more than MAX_CHAIN_RESPONSE_ITEMS blocks', () => {
    const store = makeChain(MAX_CHAIN_RESPONSE_ITEMS + 5);
    const frame = serveBlocks(
      { startHeight: 1, endHeight: MAX_CHAIN_RESPONSE_ITEMS + 5 },
      store,
    );

    expect(receiveBlocks(frame, 1, MAX_CHAIN_RESPONSE_ITEMS)).toHaveLength(
      MAX_CHAIN_RESPONSE_ITEMS,
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — the blocks response is bounded by bytes as well as by count
//
// The two bounds answer different questions and neither replaces the other:
// `MAX_CHAIN_RESPONSE_ITEMS` bounds how many blocks we assemble, and says
// nothing about their weight. Blocks are bounded individually by
// `MAX_BLOCK_BODY_BYTES`, so a count-only response reaches far past what the
// requester will read off a stream — and only when blocks are full, which is
// why no assertion above this one can see it.
// ---------------------------------------------------------------------------

describe('serve: GetBlocks byte bound', () => {
  it('stops before the response exceeds MAX_SERVE_BODY_BYTES', () => {
    // Three of these fit in the store and two in a response: the third would
    // carry the total past 4 MiB, so the loop stops before adding it.
    const store = makeHeavyChain(3, 1_500_000);

    const frame = serveBlocks({ startHeight: 1, endHeight: 3 }, store);
    const blocks = receiveBlocks(frame, 1, 3);

    expect(blocks!.map((b) => b.header.height)).toEqual([1, 2]);
    expect(bodyOf(frame, MSG_BLOCKS).length).toBeLessThan(MAX_SERVE_BODY_BYTES);
  });

  it('serves the whole range when the response stays under the bound', () => {
    // The truncation above has to be attributable to the byte bound and to
    // nothing else. Same fixture shape, same block count, weight below the line:
    // if some other limit were doing the work, this would truncate too.
    const store = makeHeavyChain(3, 1_000_000);

    const blocks = receiveBlocks(serveBlocks({ startHeight: 1, endHeight: 3 }, store), 1, 3);
    expect(blocks!.map((b) => b.header.height)).toEqual([1, 2, 3]);
  });

  it('always includes the first block, however heavy it is', () => {
    // `MAX_BLOCK_BODY_BYTES` sits below `MAX_SERVE_BODY_BYTES`, so a legal block
    // can never be this large and the clause is defensive. What it decides is
    // whether an out-of-domain block still moves or wedges sync behind it: a
    // loop that dropped it would re-serve the same truncated answer forever.
    const store = new Map<number, OrderingBlock>();
    const first = makeHeavyBlock(1, '00'.repeat(32), MAX_SERVE_BODY_BYTES + 1);
    store.set(1, first);
    store.set(2, makeMockOrderingBlock(2, mockBlockHash(first.header)));

    const blocks = receiveBlocks(serveBlocks({ startHeight: 1, endHeight: 2 }, store), 1, 2);
    expect(blocks!.map((b) => b.header.height)).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// Tests — serve + receive, end to end
// ---------------------------------------------------------------------------

describe('chain query round-trip', () => {
  it('headers: request, serve, receive, chain links hold', () => {
    const headers = receiveHeaders(serveHeaders({ startHeight: 3, maxCount: 3 }, makeChain(3)), 3);

    expect(headers).toHaveLength(3);
    expect(headers!.map((h) => h.height)).toEqual([3, 2, 1]);
    expect(headers![2]!.prevBlockHash).toBe('00'.repeat(32));
    expect(headers![1]!.prevBlockHash).toBe(mockBlockHash(headers![2]!));
    expect(headers![0]!.prevBlockHash).toBe(mockBlockHash(headers![1]!));
  });

  it('blocks: request, serve, receive, full bodies', () => {
    const blocks = receiveBlocks(
      serveBlocks({ startHeight: 1, endHeight: 2 }, makeChain(2)),
      1,
      2,
    );

    expect(blocks!.map((b) => b.header.height)).toEqual([1, 2]);
    expect(blocks![0]!.validatorSignature.length).toBe(64);
    expect(blocks![1]!.utxoTxTree.utxoTxIds).toEqual([settlementId(2)]);
    expect(blocks![1]!.header.prevBlockHash).toBe(mockBlockHash(blocks![0]!.header));
  });

  it('headers: no matching blocks yields an empty list, not a rejection', () => {
    const frame = serveHeaders({ startHeight: 100, maxCount: 5 }, new Map());
    expect(bodyOf(frame, MSG_HEADERS)).toEqual(new Uint8Array([0]));
    expect(receiveHeaders(frame, 5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests — the queries' protocol is registered with libp2p, and it is the only one
//
// Everything above this line exercises the codecs and the serve loops directly.
// None of it can see which protocols libp2p is holding, which is the property
// the whole path rests on: an unregistered protocol answers `protocol selection
// failed` to every dial, and each layer below keeps passing.
//
// A chain query reaches a serve arm only through this one handshaken,
// penalty-bearing stream, so the absence of any second chain-data protocol is
// half that property. Asserting the absence alone would also pass on a node
// that registered nothing at all, which is why both assertions run together.
//
// NET_INTERFACE → Sync Handler Registration: setters are order-independent and
// registration belongs to start(). All three orders are asserted because a
// registration conditional on the provider already existing would satisfy the
// first and fail the other two.
// ---------------------------------------------------------------------------

const registrationConfig: NetConfig = {
  magic: MAGIC,
  bootstrapPeers: [],
  listenAddrs: '/ip4/0.0.0.0/tcp/0',
  maxPeers: 10,
  penaltyScoreThreshold: 500,
  temporalBanDurationMs: 3600000,
  penaltySafeIntervalMs: 120000,
  syncRequestTimeoutMs: 10000,
};

const registrationValidators: NetValidators = {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyOrderingBlockStructure,
  verifyPostBody,
};

describe('chain query protocol registration', () => {
  let net: NetNode | undefined;

  /** The sync stream is registered; `/dagsocial/headers/1` is not. */
  function expectOnlySyncProtocol(node: NetNode): void {
    const protocols = node.libp2pNode?.getProtocols() ?? [];
    expect(protocols).toContain(SYNC_PROTOCOL);
    expect(protocols).not.toContain('/dagsocial/headers/1');
  }

  afterEach(async () => {
    await net?.stop();
    net = undefined;
  });

  it('is registered when the provider was set before start()', async () => {
    net = new NetNode(registrationConfig, registrationValidators);
    net.setHeadersHandler(() => null);
    await net.start();

    expectOnlySyncProtocol(net);
  }, 25000);

  it('is registered when the provider is set after start()', async () => {
    net = new NetNode(registrationConfig, registrationValidators);
    await net.start();
    net.setHeadersHandler(() => null);

    expectOnlySyncProtocol(net);
  }, 25000);

  it('is registered when no provider is ever set', async () => {
    net = new NetNode(registrationConfig, registrationValidators);
    await net.start();

    expectOnlySyncProtocol(net);
  }, 25000);
});
