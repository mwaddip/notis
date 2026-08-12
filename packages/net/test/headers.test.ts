import { describe, it, expect, afterEach } from 'vitest';
import { encode } from 'cbor-x';
import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import {
  PROTOCOL_VERSION,
  CREDIT_MINER_REWARD_DELAY,
  ByteWriter,
  writeVlqU,
  encodeOrderingBlock,
  encodeUtxoTxTree,
} from '@dagsocial/types';
import {
  blockHash,
  verifyPoW,
  verifyOrderingBlockPoW,
  verifyPostSignature,
  verifyProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifySubBlockStructure,
  verifyTxStructure,
  verifyOrderingBlockStructure,
} from '@dagsocial/validation';
import { HEADERS_PROTOCOL } from '../src/sync.js';
import { NetNode, serveLegacyHeadersBody } from '../src/node.js';
import type { NetConfig, NetValidators } from '../src/types.js';
import {
  decodeLegacyHeadersRequest,
  decodeLegacyBlocksResponse,
  decodeLegacyHeadersResponse,
  encodeLegacyBlocksResponse,
  encodeLegacyHeadersResponse,
} from '../src/sync-codec.js';
import { MAX_LEGACY_RESPONSE_ITEMS } from '../src/msg-guards.js';
import { mergeUint8Arrays } from '../src/util.js';

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
    subBlockRoot: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32),
    stateRoot: '00'.repeat(33),
    validatorId: new Uint8Array(32),
    powNonce: height * 100,
    powTargetBits: targetBits,
    createdAt: 1000000 + height * 10000,
  };
}

function makeMockOrderingBlock(
  height: number,
  prevBlockHash: string,
): OrderingBlock {
  return {
    header: makeMockHeader(height, prevBlockHash),
    subBlockTree: { subBlockEntries: [], pruneEntries: [] },
    utxoTxTree: {
      utxoTxIds: [],
      utxoTxs: [],
      coinbaseOutputs: [
        // The coinbase is inert payload for this suite — every assertion is
        // about heights, hashes and counts, and the block hash covers the
        // header only. Kept type-correct regardless: nothing here would fail if
        // it were not, which is exactly how a fixture drifts out of its type.
        {
          value: 100n,
          owner: new Uint8Array(32),
          lockedUntilBlock: height + CREDIT_MINER_REWARD_DELAY,
          isTreasury: false,
        },
      ],
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
 * Serve one legacy request through the **production** serve path.
 *
 * `serveLegacyHeadersBody` is exported for exactly this, and the request goes
 * through the real `decodeLegacyHeadersRequest` too, so the boundary a peer
 * actually hits is the boundary under test. A local re-implementation of the
 * two serve loops would agree with the assertions written beside it while
 * neither one touched the encoder production runs — which is how the suite
 * that exists to police this protocol stays green through a response
 * wire-format change.
 */
function serve(
  request: Record<string, unknown>,
  store: Map<number, OrderingBlock>,
): Uint8Array {
  const decoded = decodeLegacyHeadersRequest(new Uint8Array(encode(request)));
  if (!decoded) throw new Error('fixture request was rejected at the decode boundary');

  // The handler clamps both serve loops to our own tip; `chainHeight()` walks up
  // from 1 until it finds a gap, so a store with a hole reports the height below
  // it — mirrored here rather than assumed.
  let ourHeight = 0;
  while (store.has(ourHeight + 1)) ourHeight++;

  return serveLegacyHeadersBody(decoded, ourHeight, (h) => store.get(h) ?? null);
}

/** What `requestHeaders` does with a served body: cap = what it asked for. */
function receiveHeaders(body: Uint8Array, maxCount: number): BlockHeader[] | null {
  return decodeLegacyHeadersResponse(body, maxCount);
}

/** What `requestBlocks` does with a served body: cap = the range it asked for. */
function receiveBlocks(
  body: Uint8Array,
  startHeight: number,
  endHeight: number,
): OrderingBlock[] | null {
  return decodeLegacyBlocksResponse(body, endHeight - startHeight + 1);
}

// ---------------------------------------------------------------------------
// Tests — protocol constants
// ---------------------------------------------------------------------------

describe('HEADERS_PROTOCOL', () => {
  it('is the expected protocol string', () => {
    expect(HEADERS_PROTOCOL).toBe('/dagsocial/headers/1');
  });
});

// ---------------------------------------------------------------------------
// Tests — the request is still CBOR, and still shape-checked
// ---------------------------------------------------------------------------

describe('headers request encode/decode', () => {
  it('encodes and decodes a headers request', () => {
    const decoded = decodeLegacyHeadersRequest(
      new Uint8Array(encode({ startHeight: 10, maxCount: 5 })),
    );
    expect(decoded).toEqual({ startHeight: 10, maxCount: 5 });
  });

  it('encodes and decodes a blocks request', () => {
    const decoded = decodeLegacyHeadersRequest(
      new Uint8Array(encode({ startHeight: 1, endHeight: 3, mode: 'blocks' })),
    );
    expect(decoded).toEqual({ startHeight: 1, endHeight: 3, mode: 'blocks' });
  });

  it('rejects a request whose heights are not heights', () => {
    expect(decodeLegacyHeadersRequest(new Uint8Array(encode({ startHeight: -1 })))).toBeNull();
    expect(
      decodeLegacyHeadersRequest(new Uint8Array(encode({ startHeight: 1, endHeight: 'x' }))),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — response framing round-trip
//
// The responses are `arr(item, lp)` over the same positional codec gossip and
// the store use, not a second `cbor-x` dialect. See `sync-codec.ts` →
// "Legacy /dagsocial/headers/1 responses".
// ---------------------------------------------------------------------------

describe('legacy response framing', () => {
  it('round-trips a multi-block response', () => {
    const store = makeChain(3);
    const blocks = [store.get(1)!, store.get(2)!, store.get(3)!];

    const decoded = decodeLegacyBlocksResponse(encodeLegacyBlocksResponse(blocks), 3);

    expect(decoded).not.toBeNull();
    expect(decoded).toHaveLength(3);
    expect(decoded!.map((b) => b.header.height)).toEqual([1, 2, 3]);
    // The whole block survives, not just the header — this is the payload the
    // ordering store writes.
    expect(decoded![0]!.utxoTxTree.coinbaseOutputs[0]!.value).toBe(100n);
    expect(decoded![0]!.utxoTxTree.coinbaseOutputs[0]!.isTreasury).toBe(false);
    expect(decoded![0]!.validatorSignature).toBeInstanceOf(Uint8Array);
    expect(decoded![0]!.validatorSignature.length).toBe(64);
    expect(decoded![2]!.header.prevBlockHash).toBe(mockBlockHash(decoded![1]!.header));
  });

  it('round-trips an EMPTY block list, distinctly from no answer at all', () => {
    const empty = encodeLegacyBlocksResponse([]);

    // `vlqU(0)` — one byte, not zero bytes. The handler answers zero bytes when
    // it cannot answer at all (over-cap request, undecodable request, local
    // failure), and `requestBlocks` returns `[]` for that without decoding. The
    // two must not collapse into each other: one says "I have no blocks in that
    // range", the other says "I did not process your request".
    expect(empty).toEqual(new Uint8Array([0]));
    expect(decodeLegacyBlocksResponse(empty, 10)).toEqual([]);

    // ...and zero bytes is not a valid encoding of the empty list.
    expect(decodeLegacyBlocksResponse(new Uint8Array(0), 10)).toBeNull();
  });

  it('round-trips a multi-header response and an empty one', () => {
    const headers = [
      makeMockHeader(5, 'aa'.repeat(32)),
      makeMockHeader(4, 'bb'.repeat(32)),
      makeMockHeader(3, 'cc'.repeat(32)),
    ];

    const decoded = decodeLegacyHeadersResponse(encodeLegacyHeadersResponse(headers), 3);
    expect(decoded).not.toBeNull();
    expect(decoded!.map((h) => h.height)).toEqual([5, 4, 3]);
    expect(decoded![0]!.prevBlockHash).toBe('aa'.repeat(32));
    expect(decoded![0]!.validatorId).toBeInstanceOf(Uint8Array);

    expect(encodeLegacyHeadersResponse([])).toEqual(new Uint8Array([0]));
    expect(decodeLegacyHeadersResponse(new Uint8Array([0]), 20)).toEqual([]);
  });

  it('rejects trailing bytes after a well-formed response', () => {
    const body = encodeLegacyBlocksResponse([makeMockOrderingBlock(1, '00'.repeat(32))]);
    const padded = mergeUint8Arrays([body, new Uint8Array([0x00])]);

    expect(decodeLegacyBlocksResponse(body, 1)).not.toBeNull();
    expect(decodeLegacyBlocksResponse(padded, 1)).toBeNull();
  });

  it('rejects a non-minimal VLQ count', () => {
    // `0x81 0x00` decodes to 1 exactly as `0x01` does — wire accepts non-minimal
    // VLQ deliberately, and canonicity is enforced by the re-encode compare.
    const canonical = encodeLegacyHeadersResponse([makeMockHeader(1, '00'.repeat(32))]);
    expect(canonical[0]).toBe(0x01);

    const padded = mergeUint8Arrays([
      new Uint8Array([0x81, 0x00]),
      canonical.subarray(1),
    ]);
    expect(decodeLegacyHeadersResponse(padded, 5)).toBeNull();
  });

  it('rejects a truncated response', () => {
    const body = encodeLegacyBlocksResponse([makeMockOrderingBlock(1, '00'.repeat(32))]);
    expect(decodeLegacyBlocksResponse(body.subarray(0, body.length - 1), 1)).toBeNull();
  });

  it('rejects the old cbor-x dialect outright', () => {
    // The format this replaced. A peer still speaking it is not "mostly right":
    // there is no shared prefix to misinterpret, so it is refused whole.
    const blocks = [makeMockOrderingBlock(1, '00'.repeat(32))];
    expect(decodeLegacyBlocksResponse(new Uint8Array(encode({ blocks })), 5)).toBeNull();
    expect(
      decodeLegacyHeadersResponse(new Uint8Array(encode([makeMockHeader(1, '00'.repeat(32))])), 5),
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
// The assertion that matters is WHERE they die: `decodeLegacy*Response` returns
// `null`, so `requestBlocks` throws and no object reaches the node. Refusal
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

  it('refuses a non-boolean isTreasury', () => {
    const block = poison((b) => {
      (b.utxoTxTree.coinbaseOutputs[0] as unknown as Record<string, unknown>)['isTreasury'] =
        'yes';
    });

    // `writeBool` is total by sentinel: an out-of-domain value writes `0xff`,
    // which `readBool` refuses. That is the sentinel discipline working, not a
    // bug in the writer — the defect it exposes is a path where these bytes
    // never meet a decoder.
    //
    // `isTreasury` is the last field of the last coinbase output, so it is the
    // final byte of the `utxo_tx_tree` column — the byte the fail-stop
    // measurement recovers from the store, asserted directly below.
    const column = encodeUtxoTxTree(block.utxoTxTree);
    expect(column[column.length - 1]).toBe(0xff);

    expect(decodeLegacyBlocksResponse(encodeLegacyBlocksResponse([block]), 1)).toBeNull();
  });

  it('refuses a non-byte-view utxoTxs element', () => {
    const block = poison((b) => {
      b.utxoTxTree.utxoTxIds = ['ab'.repeat(32)];
      (b.utxoTxTree.utxoTxs as unknown as unknown[])[0] = 'not-bytes';
    });

    // `writeLp` sentinels the *length prefix*, so the malformed element is
    // undecodable rather than silently truncated. This is the cheaper of the
    // two payloads: `utxoTxRoot` never commits `utxoTxs` and the validator
    // signature covers only the header, so a relaying node can swap it into an
    // otherwise honest block with no PoW and no re-signing.
    expect(decodeLegacyBlocksResponse(encodeLegacyBlocksResponse([block]), 1)).toBeNull();
  });

  it('refuses the whole response, not just the poisoned block', () => {
    // A response is one message. Accepting the honest blocks around a malformed
    // one would hand the node a chain with a hole in it and let the peer choose
    // where the hole is.
    const honest = makeMockOrderingBlock(1, '00'.repeat(32));
    const bad = poison((b) => {
      (b.utxoTxTree.coinbaseOutputs[0] as unknown as Record<string, unknown>)['isTreasury'] =
        null;
    });

    expect(
      decodeLegacyBlocksResponse(encodeLegacyBlocksResponse([honest, bad, honest]), 3),
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
    expect(decodeLegacyHeadersResponse(encodeLegacyHeadersResponse([header]), 5)).toBeNull();
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

    const body = encodeLegacyHeadersResponse(headers);

    // A peer answering a 3-header request with 10 headers is not answering the
    // question. The caller is the only party that knows what it asked.
    expect(receiveHeaders(body, 3)).toBeNull();
    expect(receiveHeaders(body, 10)).toHaveLength(10);
  });

  it('refuses more blocks than the requested range', () => {
    const store = makeChain(5);
    const blocks = [1, 2, 3, 4, 5].map((h) => store.get(h)!);
    const body = encodeLegacyBlocksResponse(blocks);

    expect(receiveBlocks(body, 1, 3)).toBeNull();
    expect(receiveBlocks(body, 1, 5)).toHaveLength(5);
  });

  it('caps at MAX_LEGACY_RESPONSE_ITEMS however large the request', () => {
    // The requested size is derived from peer-supplied heights, so it is not a
    // bound by itself: `requestBlocks` spans `forkHeight + 1` to a tip height
    // that came off the wire. A real over-cap body, one header past the line.
    const headers = Array.from({ length: MAX_LEGACY_RESPONSE_ITEMS + 1 }, (_, i) =>
      makeMockHeader(i + 1, '00'.repeat(32)),
    );
    const body = encodeLegacyHeadersResponse(headers);

    expect(decodeLegacyHeadersResponse(body, Number.MAX_SAFE_INTEGER)).toBeNull();
    // One fewer is fine — the cap is where it says it is.
    expect(
      decodeLegacyHeadersResponse(
        encodeLegacyHeadersResponse(headers.slice(0, MAX_LEGACY_RESPONSE_ITEMS)),
        Number.MAX_SAFE_INTEGER,
      ),
    ).toHaveLength(MAX_LEGACY_RESPONSE_ITEMS);
  });

  it('accepts nothing but an empty response for a nonsensical request size', () => {
    const one = encodeLegacyBlocksResponse([makeMockOrderingBlock(1, '00'.repeat(32))]);

    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(decodeLegacyBlocksResponse(one, bad)).toBeNull();
      expect(decodeLegacyBlocksResponse(encodeLegacyBlocksResponse([]), bad)).toEqual([]);
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
    expect(decodeLegacyBlocksResponse(body, Number.MAX_SAFE_INTEGER)).toBeNull();
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

describe('serve: headers mode', () => {
  it('returns headers newest-first from startHeight', () => {
    const body = serve({ startHeight: 5, maxCount: 3 }, makeChain(5));
    const headers = receiveHeaders(body, 3);

    expect(headers).not.toBeNull();
    expect(headers!.map((h) => h.height)).toEqual([5, 4, 3]);
  });

  it('respects maxCount', () => {
    const headers = receiveHeaders(serve({ startHeight: 10, maxCount: 2 }, makeChain(10)), 2);
    expect(headers!.map((h) => h.height)).toEqual([10, 9]);
  });

  it('returns empty when no blocks at start height', () => {
    // Clamped to our own tip (2), so the walk starts there and returns 2, 1.
    const headers = receiveHeaders(serve({ startHeight: 99, maxCount: 20 }, makeChain(2)), 20);
    expect(headers!.map((h) => h.height)).toEqual([2, 1]);

    // An empty store has nothing to clamp to and answers with nothing.
    expect(
      receiveHeaders(serve({ startHeight: 99, maxCount: 20 }, new Map()), 20),
    ).toEqual([]);
  });

  it('stops at first gap in the chain', () => {
    const store = makeChain(2);
    // Heights 4 and 5 exist above a gap at 3. `chainHeight()` walks up from 1
    // and stops below the gap, so the serve loop never sees them.
    store.set(4, makeMockOrderingBlock(4, 'ff'.repeat(32)));
    store.set(5, makeMockOrderingBlock(5, 'ff'.repeat(32)));

    const headers = receiveHeaders(serve({ startHeight: 5, maxCount: 5 }, store), 5);
    expect(headers!.map((h) => h.height)).toEqual([2, 1]);
  });

  it('defaults maxCount to 20 when not specified', () => {
    const headers = receiveHeaders(serve({ startHeight: 25 }, makeChain(25)), 20);
    expect(headers).toHaveLength(20);
    expect(headers![0]!.height).toBe(25);
    expect(headers![19]!.height).toBe(6);
  });

  it('serves no more than MAX_LEGACY_RESPONSE_ITEMS however many are asked for', () => {
    const store = makeChain(MAX_LEGACY_RESPONSE_ITEMS + 5);
    const body = serve(
      { startHeight: MAX_LEGACY_RESPONSE_ITEMS + 5, maxCount: 100_000_000 },
      store,
    );

    // Without the serve-side cap this is a peer-controlled knob over our whole
    // chain: one request, one array holding every block we hold.
    expect(receiveHeaders(body, MAX_LEGACY_RESPONSE_ITEMS)).toHaveLength(
      MAX_LEGACY_RESPONSE_ITEMS,
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — serve side: requestBlocks
// ---------------------------------------------------------------------------

describe('serve: blocks mode', () => {
  it('returns full blocks for a height range', () => {
    const body = serve({ startHeight: 2, endHeight: 4, mode: 'blocks' }, makeChain(5));
    const blocks = receiveBlocks(body, 2, 4);

    expect(blocks).not.toBeNull();
    expect(blocks!.map((b) => b.header.height)).toEqual([2, 3, 4]);
  });

  it('skips missing blocks in the range', () => {
    const store = makeChain(1);
    store.set(3, makeMockOrderingBlock(3, 'ff'.repeat(32)));
    store.set(5, makeMockOrderingBlock(5, 'ff'.repeat(32)));

    // `chainHeight()` is 1 (the gap at 2 stops the walk), and the serve loop is
    // clamped to it — we do not serve blocks above a hole in our own chain.
    const blocks = receiveBlocks(serve({ startHeight: 1, endHeight: 5, mode: 'blocks' }, store), 1, 5);
    expect(blocks!.map((b) => b.header.height)).toEqual([1]);
  });

  it('returns an empty list when no blocks are in range', () => {
    const body = serve({ startHeight: 10, endHeight: 20, mode: 'blocks' }, new Map());
    expect(body).toEqual(new Uint8Array([0]));
    expect(receiveBlocks(body, 10, 20)).toEqual([]);
  });

  it('returns blocks with their bodies intact', () => {
    const store = makeChain(1);
    const blocks = receiveBlocks(
      serve({ startHeight: 1, endHeight: 1, mode: 'blocks' }, store),
      1,
      1,
    );

    expect(blocks).toHaveLength(1);
    const returned = blocks![0]!;
    expect(returned.header.height).toBe(1);
    expect(returned.header.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(returned.subBlockTree.subBlockEntries).toEqual([]);
    expect(returned.subBlockTree.pruneEntries).toEqual([]);
    expect(returned.utxoTxTree.coinbaseOutputs.length).toBe(1);
    expect(returned.utxoTxTree.coinbaseOutputs[0]!.value).toBe(100n);
    expect(returned.validatorSignature).toBeInstanceOf(Uint8Array);
    expect(returned.validatorSignature.length).toBe(64);
    // Byte-identical to what the ordering store holds for the same block: one
    // encoder, not a serve-side re-rendering of it.
    expect(encodeOrderingBlock(returned)).toEqual(encodeOrderingBlock(store.get(1)!));
  });

  it('serves no more than MAX_LEGACY_RESPONSE_ITEMS blocks', () => {
    const store = makeChain(MAX_LEGACY_RESPONSE_ITEMS + 5);
    const body = serve(
      { startHeight: 1, endHeight: MAX_LEGACY_RESPONSE_ITEMS + 5, mode: 'blocks' },
      store,
    );

    expect(receiveBlocks(body, 1, MAX_LEGACY_RESPONSE_ITEMS)).toHaveLength(
      MAX_LEGACY_RESPONSE_ITEMS,
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — serve + receive, end to end
// ---------------------------------------------------------------------------

describe('handler round-trip', () => {
  it('headers: request, serve, receive, chain links hold', () => {
    const headers = receiveHeaders(serve({ startHeight: 3, maxCount: 3 }, makeChain(3)), 3);

    expect(headers).toHaveLength(3);
    expect(headers!.map((h) => h.height)).toEqual([3, 2, 1]);
    expect(headers![2]!.prevBlockHash).toBe('00'.repeat(32));
    expect(headers![1]!.prevBlockHash).toBe(mockBlockHash(headers![2]!));
    expect(headers![0]!.prevBlockHash).toBe(mockBlockHash(headers![1]!));
  });

  it('blocks: request, serve, receive, full bodies', () => {
    const blocks = receiveBlocks(
      serve({ startHeight: 1, endHeight: 2, mode: 'blocks' }, makeChain(2)),
      1,
      2,
    );

    expect(blocks!.map((b) => b.header.height)).toEqual([1, 2]);
    expect(blocks![0]!.validatorSignature.length).toBe(64);
    expect(blocks![1]!.utxoTxTree.coinbaseOutputs.length).toBe(1);
    expect(blocks![1]!.header.prevBlockHash).toBe(mockBlockHash(blocks![0]!.header));
  });

  it('headers: no matching blocks yields an empty list, not a rejection', () => {
    const body = serve({ startHeight: 100, maxCount: 5 }, new Map());
    expect(body).toEqual(new Uint8Array([0]));
    expect(receiveHeaders(body, 5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests — the protocol is registered with libp2p
//
// Everything above this line exercises the codec and the serve loops directly.
// None of it can see whether `/dagsocial/headers/1` is registered with libp2p
// at all, which is the one property the whole protocol rests on: an unregistered
// protocol answers `protocol selection failed` to every dial, and each layer
// below keeps passing.
//
// NET_INTERFACE → Sync Handler Registration: setters are order-independent and
// registration belongs to start(). Both orders are asserted because a
// registration conditional on the provider already existing would satisfy the
// first and fail the second.
// ---------------------------------------------------------------------------

const registrationConfig: NetConfig = {
  magic: 0x54444147,
  postPowTargetBits: 20,
  bootstrapPeers: [],
  listenAddrs: '/ip4/0.0.0.0/tcp/0',
  maxPeers: 10,
  penaltyScoreThreshold: 500,
  temporalBanDurationMs: 3600000,
  penaltySafeIntervalMs: 120000,
  syncRequestTimeoutMs: 10000,
};

const registrationValidators: NetValidators = {
  verifyPoW,
  verifyOrderingBlockPoW,
  verifyPostSignature,
  verifyProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifySubBlockStructure,
  verifyTxStructure,
  verifyOrderingBlockStructure,
};

describe('HEADERS_PROTOCOL registration', () => {
  let net: NetNode | undefined;

  afterEach(async () => {
    await net?.stop();
    net = undefined;
  });

  it('is registered when the provider was set before start()', async () => {
    net = new NetNode(registrationConfig, registrationValidators);
    net.setHeadersHandler(() => null);
    await net.start();

    expect(net.libp2pNode?.getProtocols()).toContain(HEADERS_PROTOCOL);
  }, 25000);

  it('is registered when the provider is set after start()', async () => {
    net = new NetNode(registrationConfig, registrationValidators);
    await net.start();
    net.setHeadersHandler(() => null);

    expect(net.libp2pNode?.getProtocols()).toContain(HEADERS_PROTOCOL);
  }, 25000);

  it('is registered when no provider is ever set', async () => {
    net = new NetNode(registrationConfig, registrationValidators);
    await net.start();

    expect(net.libp2pNode?.getProtocols()).toContain(HEADERS_PROTOCOL);
  }, 25000);
});
