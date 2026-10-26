import { describe, it, expect, afterEach } from 'vitest';
import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import {
  PROTOCOL_VERSION,
  ByteWriter,
  writeHexNOrThrow,
  writeLp,
  writeVlqU,
  computeUtxoTxRoot,
  encodeOrderingBlock,
  ByteReader,
  decodeStruct,
  ReaderError,
  CodecError,
} from '@dagsocial/types';
import {
  blockHash,
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyTxStructure,
  verifyTxSignatures,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyHeaderFieldDomains,
  verifyValidatorSignature,
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
    interlinkRoot: '00'.repeat(32),
    adProofsRoot: '00'.repeat(32),
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
  // Every block carries at least one transaction, because the settlement is
  // one (VALIDATION_INTERFACE → verifyOrderingBlockStructure;
  // NODE_INTERFACE → It is the LAST entry in `utxoTxIds`). An empty body is
  // refused at Stage 1, so it is not a block this suite could ever receive.
  //
  // Both the id and the payload carry the height, which is what lets a
  // round-trip assert that THIS block's body came back rather than merely
  // that a well-formed one did. The bytes stay opaque to every layer that
  // moves a block, so their content is a plausible weight and nothing more.
  // The header carries the root of its body (TYPES_INTERFACE → Ordering
  // block).
  const utxoTxTree = {
    utxoTxIds: [settlementId(height)],
    utxoTxs: [new Uint8Array(96).fill(height & 0xff)],
  };
  return {
    header: { ...makeMockHeader(height, prevBlockHash), utxoTxRoot: computeUtxoTxRoot(utxoTxTree) },
    utxoTxTree,
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
  // The header carries the root of its body (TYPES_INTERFACE → Ordering
  // block); fix it here, after the heavy payload replaces the settlement
  // placeholder, so the fixture is its header's.
  const utxoTxTree = {
    utxoTxIds: ['ab'.repeat(32)],
    utxoTxs: [new Uint8Array(payloadBytes)],
  };
  return {
    header: { ...makeMockHeader(height, prevBlockHash), utxoTxRoot: computeUtxoTxRoot(utxoTxTree) },
    utxoTxTree,
    validatorSignature: new Uint8Array(64),
  };
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
  const byHash = new Map<string, number>();
  for (const [h, block] of store) byHash.set(mockBlockHash(block.header), h);
  return serveHeadersResponse(
    MAGIC, decoded, tipOf(store),
    (id) => byHash.get(id) ?? null,
    (h) => store.get(h)?.header ?? null,
  );
}

function serveBlocks(request: GetBlocksMsg, store: Map<number, OrderingBlock>): Uint8Array {
  const decoded = decodeGetBlocks(bodyOf(encodeGetBlocks(MAGIC, request), MSG_GET_BLOCKS));
  if (!decoded) throw new Error('fixture request was rejected at the decode boundary');
  const byHash = new Map<string, number>();
  for (const [h, block] of store) byHash.set(mockBlockHash(block.header), h);
  return serveBlocksResponse(
    MAGIC, decoded, tipOf(store),
    (id) => byHash.get(id) ?? null,
    (h) => store.get(h) ?? null,
  );
}

/** The ids of a chain `startH..endH` of blocks, in the order asked. */
function idsOfRange(store: Map<number, OrderingBlock>, startH: number, endH: number): string[] {
  const ids: string[] = [];
  for (let h = startH; h <= endH; h++) {
    const block = store.get(h);
    if (block) ids.push(mockBlockHash(block.header));
  }
  return ids;
}

/** What `requestHeaders` does with a served frame — cap at MAX_CHAIN_RESPONSE_ITEMS. */
function receiveHeaders(frame: Uint8Array): BlockHeader[] | null {
  return decodeHeaders(bodyOf(frame, MSG_HEADERS));
}

/** What `requestBlocks` does with a served frame: cap = the ids it asked for. */
function receiveBlocks(frame: Uint8Array, idsAsked: number): OrderingBlock[] | null {
  return decodeBlocks(bodyOf(frame, MSG_BLOCKS), idsAsked);
}

// ---------------------------------------------------------------------------
// Tests — the requests are positional, and the code pair is the discriminator
// ---------------------------------------------------------------------------

describe('chain query request encode/decode', () => {
  it('round-trips a GetHeaders request under its own code', () => {
    const locator = ['aa'.repeat(32), 'bb'.repeat(32), 'cc'.repeat(32)];
    const frame = encodeGetHeaders(MAGIC, { locator });
    expect(decodeGetHeaders(bodyOf(frame, MSG_GET_HEADERS)))
      .toEqual({ locator });
  });

  it('round-trips a GetBlocks request under its own code', () => {
    const ids = ['aa'.repeat(32), 'bb'.repeat(32), 'cc'.repeat(32)];
    const frame = encodeGetBlocks(MAGIC, { ids });
    expect(decodeGetBlocks(bodyOf(frame, MSG_GET_BLOCKS)))
      .toEqual({ ids });
  });

  it('rejects an empty locator and one past MAX_LOCATOR_HASHES', () => {
    const w0 = new ByteWriter();
    writeVlqU(w0, 0);
    expect(decodeGetHeaders(w0.toBytes())).toBeNull();

    const w29 = new ByteWriter();
    writeVlqU(w29, 29);
    for (let i = 0; i < 29; i++) {
      writeHexNOrThrow(w29, '00'.repeat(32), 32);
    }
    expect(decodeGetHeaders(w29.toBytes())).toBeNull();

    const bytes = w0.toBytes();
    let caught: unknown;
    try { decodeStruct(getHeadersCodec, bytes); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ReaderError);
    expect(caught).not.toBeInstanceOf(CodecError);
    expect((caught as ReaderError).code).toBe('out-of-domain');
  });

  it('GetBlocks rejects an empty id list and one past MAX_CHAIN_RESPONSE_ITEMS', () => {
    const w0 = new ByteWriter();
    writeVlqU(w0, 0);
    expect(decodeGetBlocks(w0.toBytes())).toBeNull();

    const wOver = new ByteWriter();
    writeVlqU(wOver, MAX_CHAIN_RESPONSE_ITEMS + 1);
    for (let i = 0; i < MAX_CHAIN_RESPONSE_ITEMS + 1; i++) {
      writeHexNOrThrow(wOver, '00'.repeat(32), 32);
    }
    expect(decodeGetBlocks(wOver.toBytes())).toBeNull();

    const bytes = w0.toBytes();
    let caught: unknown;
    try { decodeStruct(getBlocksCodec, bytes); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ReaderError);
    expect(caught).not.toBeInstanceOf(CodecError);
    expect((caught as ReaderError).code).toBe('out-of-domain');
  });

  it('rejects a truncated, over-long or non-minimal GetBlocks body', () => {
    const body = bodyOf(encodeGetBlocks(MAGIC, { ids: ['aa'.repeat(32)] }), MSG_GET_BLOCKS);

    expect(decodeGetBlocks(body.subarray(0, body.length - 1))).toBeNull();
    expect(decodeGetBlocks(mergeUint8Arrays([body, new Uint8Array([0x00])]))).toBeNull();
    // `0x81 0x00` decodes to 1 exactly as `0x01` does; the re-encode compare is
    // what refuses it (TYPES_INTERFACE → The boundary check, step 3).
    expect(decodeGetBlocks(
      mergeUint8Arrays([new Uint8Array([0x81, 0x00]), body.subarray(1)]),
    )).toBeNull();
  });

  it('rejects arbitrary non-positional bytes', () => {
    expect(decodeGetHeaders(new Uint8Array([0xa2, 0x64, 0x73, 0x74, 0x61, 0x72]))).toBeNull();
    expect(decodeGetBlocks(new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]))).toBeNull();
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

    const decoded = decodeHeaders(headersBody(headers));
    expect(decoded).not.toBeNull();
    expect(decoded!.map((h) => h.height)).toEqual([5, 4, 3]);
    expect(decoded![0]!.prevBlockHash).toBe('aa'.repeat(32));
    expect(decoded![0]!.validatorId).toBeInstanceOf(Uint8Array);

    expect(headersBody([])).toEqual(new Uint8Array([0]));
    expect(decodeHeaders(new Uint8Array([0]))).toEqual([]);
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
    expect(decodeHeaders(padded)).toBeNull();
  });

  it('rejects a truncated response', () => {
    const body = blocksBody([makeMockOrderingBlock(1, '00'.repeat(32))]);
    expect(decodeBlocks(body.subarray(0, body.length - 1), 1)).toBeNull();
  });

  it('rejects arbitrary non-positional bytes', () => {
    expect(decodeBlocks(new Uint8Array([0xa1, 0x66, 0x62, 0x6c, 0x6f, 0x63, 0x6b, 0x73]), 5)).toBeNull();
    expect(decodeHeaders(new Uint8Array([0x9f, 0xa5, 0x68, 0x65]))).toBeNull();
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
    expect(decodeHeaders(headersBody([header]))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — response size is bounded on receipt
// ---------------------------------------------------------------------------

describe('response item caps', () => {
  it('a Headers answer at the cap decodes; one past it is refused', () => {
    const over = Array.from({ length: MAX_CHAIN_RESPONSE_ITEMS + 1 }, (_, i) =>
      makeMockHeader(i + 1, '00'.repeat(32)),
    );
    expect(decodeHeaders(headersBody(over))).toBeNull();
    expect(
      decodeHeaders(headersBody(over.slice(0, MAX_CHAIN_RESPONSE_ITEMS))),
    ).toHaveLength(MAX_CHAIN_RESPONSE_ITEMS);
  });

  it('refuses a Blocks body of 401 blocks even when the ids asked exceed 400', () => {
    // The decode cap stands at MAX_CHAIN_RESPONSE_ITEMS whatever the caller
    // asks for; a caller handing a nonsensical asked-count must not raise
    // the cap. One encoded block reused 401 times is a well-formed body of
    // the count: the array check fires before the first element is read.
    const encoded = encodeOrderingBlock(makeMockOrderingBlock(1, '00'.repeat(32)));
    const w = new ByteWriter();
    writeVlqU(w, MAX_CHAIN_RESPONSE_ITEMS + 1);
    for (let i = 0; i <= MAX_CHAIN_RESPONSE_ITEMS; i++) writeLp(w, encoded);
    expect(decodeBlocks(w.toBytes(), MAX_CHAIN_RESPONSE_ITEMS * 2)).toBeNull();
  });

  it('refuses more blocks than the ids asked', () => {
    const store = makeChain(5);
    const blocks = [1, 2, 3, 4, 5].map((h) => store.get(h)!);
    const frame = blocksFrame(blocks);

    expect(receiveBlocks(frame, 3)).toBeNull();
    expect(receiveBlocks(frame, 5)).toHaveLength(5);
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
  it('answers ascending above the first locator entry its chain holds', () => {
    const store = makeChain(5);
    const hashAt2 = mockBlockHash(store.get(2)!.header);
    const frame = serveHeaders({ locator: [hashAt2] }, store);
    const headers = receiveHeaders(frame);

    expect(headers).not.toBeNull();
    expect(headers!.map((h) => h.height)).toEqual([3, 4, 5]);
  });

  it('answers from height 1 when the locator holds no entry on this chain', () => {
    const store = makeChain(3);
    const foreign = 'ff'.repeat(32);
    const headers = receiveHeaders(serveHeaders({ locator: [foreign] }, store));
    expect(headers!.map((h) => h.height)).toEqual([1, 2, 3]);

    // An empty store has nothing above height 0, so the page is empty.
    expect(receiveHeaders(serveHeaders({ locator: [foreign] }, new Map()))).toEqual([]);
  });

  it('answers an empty list when the locator holds the tip', () => {
    const store = makeChain(5);
    const tipHash = mockBlockHash(store.get(5)!.header);
    const frame = serveHeaders({ locator: [tipHash] }, store);
    expect(bodyOf(frame, MSG_HEADERS)).toEqual(new Uint8Array([0]));
    expect(receiveHeaders(frame)).toEqual([]);
  });

  it('takes the highest held entry when a lower one precedes an unheld one', () => {
    const store = makeChain(5);
    const foreign = 'ff'.repeat(32);
    const hashAt3 = mockBlockHash(store.get(3)!.header);
    // Running tip → root, a locator may hold at 3 while an entry above it does
    // not match our chain; the arm takes the first entry it holds.
    const headers = receiveHeaders(serveHeaders({ locator: [foreign, hashAt3] }, store));
    expect(headers!.map((h) => h.height)).toEqual([4, 5]);
  });

  it('takes the first held entry when a later entry is also held lower down', () => {
    // NET_INTERFACE → `GetHeaders` / `GetBlocks` responses →
    // "A `Headers` page has one shape, and a requester holds a page to it":
    // the serve arm takes the FIRST entry it holds, running tip → root. Two
    // held entries, the higher first — the answer is the heights above the
    // higher one, not the lower one.
    const store = makeChain(5);
    const hashAt4 = mockBlockHash(store.get(4)!.header);
    const hashAt2 = mockBlockHash(store.get(2)!.header);
    const headers = receiveHeaders(serveHeaders({ locator: [hashAt4, hashAt2] }, store));
    expect(headers!.map((h) => h.height)).toEqual([5]);
  });

  it('ends at a gap above the locator match', () => {
    const store = makeChain(2);
    // Heights 4 and 5 exist above a gap at 3; the arm walks up from the
    // locator's match at height 2 and ends at the gap.
    store.set(4, makeMockOrderingBlock(4, 'ff'.repeat(32)));
    store.set(5, makeMockOrderingBlock(5, 'ff'.repeat(32)));

    const hashAt2 = mockBlockHash(store.get(2)!.header);
    const headers = receiveHeaders(serveHeaders({ locator: [hashAt2] }, store));
    expect(headers!.map((h) => h.height)).toEqual([]);
  });

  it('serves no more than MAX_CHAIN_RESPONSE_ITEMS headers', () => {
    const store = makeChain(MAX_CHAIN_RESPONSE_ITEMS + 5);
    const foreign = 'ff'.repeat(32);
    const frame = serveHeaders({ locator: [foreign] }, store);

    expect(receiveHeaders(frame)).toHaveLength(MAX_CHAIN_RESPONSE_ITEMS);
  });
});

// ---------------------------------------------------------------------------
// Tests — serve side: requestBlocks
// ---------------------------------------------------------------------------

describe('serve: GetBlocks', () => {
  it('returns the blocks of the ids asked, in the order asked', () => {
    const store = makeChain(5);
    const ids = idsOfRange(store, 2, 4);
    const frame = serveBlocks({ ids }, store);
    const blocks = receiveBlocks(frame, ids.length);

    expect(blocks).not.toBeNull();
    expect(blocks!.map((b) => b.header.height)).toEqual([2, 3, 4]);
  });

  it('omits ids this chain does not hold', () => {
    const store = makeChain(1);
    store.set(3, makeMockOrderingBlock(3, 'ff'.repeat(32)));
    store.set(5, makeMockOrderingBlock(5, 'ff'.repeat(32)));

    const ids = [
      mockBlockHash(store.get(1)!.header),
      'ab'.repeat(32), // not on chain
      mockBlockHash(store.get(3)!.header),
      'cd'.repeat(32), // not on chain
      mockBlockHash(store.get(5)!.header),
    ];
    const blocks = receiveBlocks(serveBlocks({ ids }, store), ids.length);
    expect(blocks!.map((b) => b.header.height)).toEqual([1, 3, 5]);
  });

  it('returns an empty list when no asked id is on this chain', () => {
    const ids = ['aa'.repeat(32), 'bb'.repeat(32)];
    const frame = serveBlocks({ ids }, new Map());
    expect(bodyOf(frame, MSG_BLOCKS)).toEqual(new Uint8Array([0]));
    expect(receiveBlocks(frame, ids.length)).toEqual([]);
  });

  it('returns blocks with their bodies intact', () => {
    const store = makeChain(1);
    const ids = [mockBlockHash(store.get(1)!.header)];
    const blocks = receiveBlocks(serveBlocks({ ids }, store), ids.length);

    expect(blocks).toHaveLength(1);
    const returned = blocks![0]!;
    expect(returned.header.height).toBe(1);
    expect(returned.header.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(returned.utxoTxTree.utxoTxIds).toEqual([settlementId(1)]);
    expect(returned.utxoTxTree.utxoTxs[0]).toEqual(new Uint8Array(96).fill(1));
    expect(returned.validatorSignature).toBeInstanceOf(Uint8Array);
    expect(returned.validatorSignature.length).toBe(64);
    // Byte-identical to what the ordering store holds for the same block: one
    // encoder, not a serve-side re-rendering of it.
    expect(encodeOrderingBlock(returned)).toEqual(encodeOrderingBlock(store.get(1)!));
  });

  it('serves an id asked twice twice, in the order asked', () => {
    const store = makeChain(1);
    const id = mockBlockHash(store.get(1)!.header);
    const ids = [id, id];
    const blocks = receiveBlocks(serveBlocks({ ids }, store), ids.length);
    expect(blocks!.map((b) => b.header.height)).toEqual([1, 1]);
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
    const ids = idsOfRange(store, 1, 3);

    const frame = serveBlocks({ ids }, store);
    const blocks = receiveBlocks(frame, ids.length);

    expect(blocks!.map((b) => b.header.height)).toEqual([1, 2]);
    expect(bodyOf(frame, MSG_BLOCKS).length).toBeLessThan(MAX_SERVE_BODY_BYTES);
  });

  it('serves the whole range when the response stays under the bound', () => {
    // The truncation above has to be attributable to the byte bound and to
    // nothing else. Same fixture shape, same block count, weight below the line:
    // if some other limit were doing the work, this would truncate too.
    const store = makeHeavyChain(3, 1_000_000);
    const ids = idsOfRange(store, 1, 3);

    const blocks = receiveBlocks(serveBlocks({ ids }, store), ids.length);
    expect(blocks!.map((b) => b.header.height)).toEqual([1, 2, 3]);
  });

  it('serves a first block heavier than the budget as the response\'s one item', () => {
    // NET_INTERFACE → `GetHeaders` / `GetBlocks` responses →
    // "always include the first block": a request is never answered with
    // nothing while the server holds the block asked for. No legal block
    // reaches the budget alone, so only a block over MAX_ORDERING_BLOCK_BYTES
    // gets here, and it is served: the serve loop reads the frame, the
    // reader refuses the item. The first assertion therefore reads the served
    // body with the wire primitives, not through `decodeBlocks`.
    const store = new Map<number, OrderingBlock>();
    const first = makeHeavyBlock(1, '00'.repeat(32), MAX_SERVE_BODY_BYTES + 1);
    store.set(1, first);
    store.set(2, makeMockOrderingBlock(2, mockBlockHash(first.header)));

    const ids = [mockBlockHash(first.header), mockBlockHash(store.get(2)!.header)];
    const frame = serveBlocks({ ids }, store);

    const r = new ByteReader(bodyOf(frame, MSG_BLOCKS));
    expect(r.readVlqU()).toBe(1);
    const item = r.readBytes(r.readVlqU());
    expect(item).toEqual(encodeOrderingBlock(first));

    expect(receiveBlocks(frame, ids.length)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — serve + receive, end to end
// ---------------------------------------------------------------------------

describe('chain query round-trip', () => {
  it('headers: locator from root, serve ascending, chain links hold', () => {
    const foreign = 'ff'.repeat(32);
    const headers = receiveHeaders(serveHeaders({ locator: [foreign] }, makeChain(3)));

    expect(headers).toHaveLength(3);
    expect(headers!.map((h) => h.height)).toEqual([1, 2, 3]);
    expect(headers![0]!.prevBlockHash).toBe('00'.repeat(32));
    expect(headers![1]!.prevBlockHash).toBe(mockBlockHash(headers![0]!));
    expect(headers![2]!.prevBlockHash).toBe(mockBlockHash(headers![1]!));
  });

  it('blocks: request, serve, receive, full bodies', () => {
    const chain = makeChain(2);
    const ids = idsOfRange(chain, 1, 2);
    const blocks = receiveBlocks(serveBlocks({ ids }, chain), ids.length);

    expect(blocks!.map((b) => b.header.height)).toEqual([1, 2]);
    expect(blocks![0]!.validatorSignature.length).toBe(64);
    expect(blocks![1]!.utxoTxTree.utxoTxIds).toEqual([settlementId(2)]);
    expect(blocks![1]!.header.prevBlockHash).toBe(mockBlockHash(blocks![0]!.header));
  });

  it('headers: no matching blocks yields an empty list, not a rejection', () => {
    const foreign = 'ff'.repeat(32);
    const frame = serveHeaders({ locator: [foreign] }, new Map());
    expect(bodyOf(frame, MSG_HEADERS)).toEqual(new Uint8Array([0]));
    expect(receiveHeaders(frame)).toEqual([]);
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
  protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
  orderingBlockPowTargetFloorBits: 2304,
  bootstrapPeers: [],
  listenAddrs: '/ip4/0.0.0.0/tcp/0',
  maxPeers: 10,
  minPeers: 3,
  peerDbCap: 100,
  outboundRedialCooldownMs: 60_000,
  penaltyScoreThreshold: 500,
  temporalBanDurationMs: 3600000,
  penaltySafeIntervalMs: 120000,
  syncRequestTimeoutMs: 10000,
};

const registrationValidators: NetValidators = {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyTxStructure,
  verifyTxSignatures,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyHeaderFieldDomains,
  verifyValidatorSignature,
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
