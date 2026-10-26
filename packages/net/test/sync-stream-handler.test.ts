import { describe, it, expect, vi } from 'vitest';
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
import {
  PROTOCOL_VERSION,
  computeUtxoTxRoot,
  decodePostBody,
} from '@dagsocial/types';
import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import { NetNode } from '../src/node.js';
import { decodeFrame, encodeFrame } from '../src/frame.js';
import {
  decodeBlocks,
  decodeHeaders,
  encodeGetBlocks,
  encodeGetHeaders,
  encodeModifierRequest,
  decodeModifierResponse,
} from '../src/sync-codec.js';
import {
  MSG_BLOCKS,
  MSG_GET_HEADERS,
  MSG_HEADERS,
  MSG_MODIFIER_RESPONSE,
  MSG_SYNC_INFO,
  MODIFIER_POST_BODY,
  PeerState,
} from '../src/types.js';
import type { NetValidators } from '../src/types.js';
import { makeConfig } from './helpers.js';
import { makeFakeStream } from './fake-stream.js';
import type { PeerManager } from '../src/peer-mgr.js';

// ---------------------------------------------------------------------------
// The sync stream handler — one span per failure owner
//
// The handler covers the stream read, the frame decode, the serve branches,
// every `sink` and the whole
// `syncMachine.handleMessage` dispatch. A single `try` over all of it would
// answer every one of them with an empty frame and no log, so each owner gets
// its own span and its own message: net's decode/guard layer and the app
// callback log at `error`, the outer stream-level span at `warn`.
//
// These tests drive the REAL handler.
// ---------------------------------------------------------------------------

const MAGIC = 0x54444147;

const validators: NetValidators = {
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

type StreamHandler = (
  stream: unknown,
  connection: { remotePeer: { toString(): string }; remoteAddr?: { toString(): string } },
) => Promise<void>;

/**
 * Build a NetNode with the sync stream handler registered against a stub
 * libp2p, and return a function that feeds it one request.
 *
 * The reaching into privates is concentrated here, in one helper, rather than
 * spread across the tests: `registerSyncStreamHandler` is private with a single
 * private caller (`start()`), and `start()` means real libp2p — a TCP listener
 * and a 25s integration test for what is a pure control-flow question. The
 * alternative is extracting the 110-line handler body into a module-level
 * function, which is this file's stated idiom but a far larger change than the
 * logging spans under test. If these casts ever break, that extraction is the fix.
 */
function makeHandlerHarness(opts: {
  headersHandler?: (height: number) => OrderingBlock | null;
  chainHeight?: number;
  syncMachine?: { handleMessage: (p: string, c: number, b: Uint8Array) => void };
  postBodyProvider?: (id: string) => string | null;
  active?: boolean;
} = {}) {
  const net = new NetNode(makeConfig(), validators);
  const peerId = 'peer-under-test';

  let captured: StreamHandler | null = null;
  const internals = net as unknown as {
    libp2p: unknown;
    peerMgr: PeerManager;
    syncMachine: unknown;
    registerSyncStreamHandler(libp2p: unknown): void;
  };
  // The stub answers the handler and the two methods `disconnectPeer`
  // reaches when `recordPenaltyKind(ProtocolViolation, …)` fires: a bare
  // ban reaches `onBanned` → `disconnectPeer`, which reads `getConnections`
  // and `hangUp` on the live libp2p (NET_INTERFACE → "A ban ends the
  // connection").
  internals.libp2p = {
    handle: (_protocol: string, cb: StreamHandler) => {
      captured = cb;
    },
    getConnections: () => [],
    hangUp: async () => { /* nothing to hang up in a bare harness */ },
  };

  internals.peerMgr.addPeer({
    id: peerId,
    multiaddrs: [],
    protocols: [],
    connectedAt: Date.now(),
  });
  if (opts.active !== false) {
    internals.peerMgr.setPeerState(peerId, PeerState.Active);
  }

  if (opts.headersHandler) {
    net.setHeadersHandler(opts.headersHandler);
    // Derive a header provider from the block provider so pre-existing
    // tests that only set the block provider still answer `GetHeaders`
    // (NET_INTERFACE → Sync Handler Registration).
    const getBlock = opts.headersHandler;
    net.setHeaderProvider((h) => getBlock(h)?.header ?? null);
    // The height-by-id provider is derived too — a locator or an id in a
    // GetBlocks request resolves through this seam.
    net.setHeightByBlockIdProvider((id) => {
      for (let h = 1; h <= 1000; h++) {
        const block = getBlock(h);
        if (!block) return null;
        if (blockHash(block.header) === id) return h;
      }
      return null;
    });
  }
  if (opts.chainHeight !== undefined) {
    const h = opts.chainHeight;
    net.setChainHeightProvider(() => h);
  }
  if (opts.syncMachine) internals.syncMachine = opts.syncMachine;
  if (opts.postBodyProvider) net.setPostBodyProvider(opts.postBodyProvider);

  // The stub is passed in, not read off the instance: the registrars take the
  // libp2p node as a parameter. It is also assigned above, for the paths that
  // reach it through the instance at request time.
  internals.registerSyncStreamHandler(internals.libp2p);
  if (!captured) throw new Error('registerSyncStreamHandler registered no handler');

  /** Drive the handler with an arbitrary source; returns what was written back. */
  const drive = async (source: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> => {
    const stream = makeFakeStream(source);
    await captured!(stream, {
      remotePeer: { toString: () => peerId },
      remoteAddr: { toString: () => '/ip4/127.0.0.1/tcp/1234' },
    });
    return stream.written;
  };

  /** Feed one well-formed request. */
  const send = (request: Uint8Array): Promise<Uint8Array[]> =>
    drive((async function* () {
      yield request;
    })());

  /** Feed a stream that dies mid-read — an ordinary dropped connection. */
  const sendBrokenStream = (): Promise<Uint8Array[]> =>
    drive((async function* () {
      yield new Uint8Array([0x01]);
      throw new Error('connection reset');
    })());

  return { send, sendBrokenStream, peerMgr: internals.peerMgr, peerId };
}

/** A response that is exactly one empty frame — the "I have no answer" reply. */
function isEmptyReply(written: Uint8Array[]): boolean {
  return written.length === 1 && written[0]!.length === 0;
}

describe('sync stream handler — sync dispatch failures', () => {
  it('logs a throwing handleMessage with the code and peer', async () => {
    // The worst instance of the pattern: `handleMessage` decodes the body and
    // applies the inbound caps, so a throw here is a bug in net's own guard
    // layer — the handler logs it at `error` with the message code and replies
    // empty.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { send } = makeHandlerHarness({
      syncMachine: {
        handleMessage: () => {
          throw new Error('dispatch exploded');
        },
      },
    });

    const written = await send(encodeFrame(MAGIC, MSG_SYNC_INFO, new Uint8Array([1, 2, 3])));

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('sync dispatch failed'),
    );
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining(`code=${MSG_SYNC_INFO}`),
    );
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('dispatch exploded'));
    expect(isEmptyReply(written)).toBe(true);
    errSpy.mockRestore();
  });

  it('dispatches to handleMessage when it does not throw', async () => {
    // Positive control: the per-owner span structure does not interfere with
    // dispatch — `handleMessage` receives the code and body.
    const seen: Array<{ code: number; len: number }> = [];
    const { send } = makeHandlerHarness({
      syncMachine: {
        handleMessage: (_p, code, body) => {
          seen.push({ code, len: body.length });
        },
      },
    });

    await send(encodeFrame(MAGIC, MSG_SYNC_INFO, new Uint8Array([1, 2, 3])));

    expect(seen).toEqual([{ code: MSG_SYNC_INFO, len: 3 }]);
  });
});

// ---------------------------------------------------------------------------
// The chain-query serve arms — GetHeaders (14) and GetBlocks (16)
//
// On this stream "I do not serve that" is a timeout — a 5× one for blocks —
// unless the arm answers. So every path answers, the declining ones included,
// and that is what these tests pin (NET_INTERFACE → Sync Handler Registration).
// ---------------------------------------------------------------------------

function makeQueryHeader(height: number): BlockHeader {
  return {
    protocolVersion: PROTOCOL_VERSION,
    height,
    prevBlockHash: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32),
    stateRoot: '00'.repeat(33),
    validatorId: new Uint8Array(32),
    powNonce: height,
    powTargetBits: 4 * 256,
    createdAt: 1_000_000 + height,
    interlinkRoot: '00'.repeat(32),
    adProofsRoot: '00'.repeat(32),
  };
}

function makeQueryBlock(height: number): OrderingBlock {
  // Every block carries at least one transaction, because the settlement is
  // one (VALIDATION_INTERFACE → verifyOrderingBlockStructure;
  // NODE_INTERFACE → It is the LAST entry in `utxoTxIds`). The serve arms
  // gate on structure, so an empty body answers nothing. The header carries
  // the root of its body (TYPES_INTERFACE → Ordering block).
  const utxoTxTree = {
    utxoTxIds: [height.toString(16).padStart(64, '0')],
    utxoTxs: [new Uint8Array(96).fill(height & 0xff)],
  };
  return {
    header: { ...makeQueryHeader(height), utxoTxRoot: computeUtxoTxRoot(utxoTxTree) },
    utxoTxTree,
    validatorSignature: new Uint8Array(64),
  };
}

/** A contiguous chain 1..n behind a provider, as `setHeadersHandler` takes one. */
function chainProvider(n: number): (height: number) => OrderingBlock | null {
  return (height) => (height >= 1 && height <= n ? makeQueryBlock(height) : null);
}

describe('sync stream handler — the chain query arms', () => {
  it('serves GetHeaders as a framed Headers response', async () => {
    const { send } = makeHandlerHarness({ headersHandler: chainProvider(3), chainHeight: 3 });

    // A locator the chain holds no entry of — the arm answers from height 1.
    const written = await send(encodeGetHeaders(MAGIC, { locator: ['ff'.repeat(32)] }));

    expect(written).toHaveLength(1);
    const reply = decodeFrame(MAGIC, written[0]!);
    expect(reply.code).toBe(MSG_HEADERS);
    expect(decodeHeaders(reply.body)!.map((h) => h.height)).toEqual([1, 2, 3]);
  });

  it('serves GetBlocks as a framed Blocks response', async () => {
    const { send } = makeHandlerHarness({ headersHandler: chainProvider(3), chainHeight: 3 });

    const ids = [1, 2].map((h) => blockHash(makeQueryBlock(h).header)!);
    const written = await send(encodeGetBlocks(MAGIC, { ids }));

    expect(written).toHaveLength(1);
    const reply = decodeFrame(MAGIC, written[0]!);
    expect(reply.code).toBe(MSG_BLOCKS);
    expect(decodeBlocks(reply.body, 2)!.map((b) => b.header.height)).toEqual([1, 2]);
  });

  it('answers zero bytes on both arms when no provider was registered', async () => {
    // Zero bytes is "I cannot answer", and it is NOT the framed `vlqU(0)` an
    // empty chain range produces: a node holding no provider has no chain to
    // consult, so it cannot honestly send the second. Silence would be a third
    // thing, and the only one the caller cannot tell from a hung peer.
    const headers = await makeHandlerHarness()
      .send(encodeGetHeaders(MAGIC, { locator: ['ff'.repeat(32)] }));
    const blocks = await makeHandlerHarness()
      .send(encodeGetBlocks(MAGIC, { ids: ['aa'.repeat(32), 'bb'.repeat(32)] }));

    expect(isEmptyReply(headers)).toBe(true);
    expect(isEmptyReply(blocks)).toBe(true);
  });

  it('answers and permanently bans on a malformed chain query body', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send, peerMgr, peerId } = makeHandlerHarness({ headersHandler: chainProvider(3), chainHeight: 3 });

    // A body that is not two heights — `0xff` opens a VLQ that never closes.
    // Unlike our own store failing, this is the peer's doing, and the arm
    // attributes it: the request arrived over a stream that knows who sent it,
    // so the sender is a peer that can be penalized.
    const written = await send(encodeFrame(MAGIC, MSG_GET_HEADERS, new Uint8Array([0xff])));

    expect(isEmptyReply(written)).toBe(true);
    // `PenaltyKind.ProtocolViolation` is a permanent ban, which removes the peer
    // outright rather than accruing a score against it.
    expect(peerMgr.getPeerMetadata(peerId)).toBeNull();
    expect(peerMgr.isPeerActive(peerId)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('malformed chain query'));
    warnSpy.mockRestore();
  });

  it('leaves a well-formed query unpenalised', async () => {
    // The control against an arm that bans everyone: the ban above must be the
    // malformed body's doing, not the code's.
    const { send, peerMgr, peerId } = makeHandlerHarness({ headersHandler: chainProvider(3), chainHeight: 3 });

    await send(encodeGetHeaders(MAGIC, { locator: ['ff'.repeat(32)] }));

    expect(peerMgr.isPeerActive(peerId)).toBe(true);
  });

  it('refuses a non-Active peer on both arms without consulting the provider', async () => {
    // The Active gate precedes the arm, so a declined request never reads our
    // chain. That is what "without consulting the provider" pins: an arm
    // reached and only then declining would have consulted it already.
    let providerCalls = 0;
    const counting = (height: number): OrderingBlock | null => {
      providerCalls++;
      return chainProvider(3)(height);
    };

    const headers = await makeHandlerHarness({ headersHandler: counting, active: false })
      .send(encodeGetHeaders(MAGIC, { locator: ['ff'.repeat(32)] }));
    const blocks = await makeHandlerHarness({ headersHandler: counting, active: false })
      .send(encodeGetBlocks(MAGIC, { ids: ['aa'.repeat(32), 'bb'.repeat(32)] }));

    expect(isEmptyReply(headers)).toBe(true);
    expect(isEmptyReply(blocks)).toBe(true);
    expect(providerCalls).toBe(0);
  });

  it('answers rather than falling through to a sync machine that would not', async () => {
    // The failure mode being designed against: an arm that returned without
    // sinking would reach `handleMessage`, whose switch answers nothing, and the
    // caller would block for its whole timeout. This asserts the arms are
    // reached and the dispatch is not.
    const dispatched: number[] = [];
    const harness = makeHandlerHarness({
      headersHandler: chainProvider(3),
      chainHeight: 3,
      syncMachine: { handleMessage: (_p, code) => { dispatched.push(code); } },
    });

    expect((await harness.send(encodeGetHeaders(MAGIC, { locator: ['ff'.repeat(32)] })))).toHaveLength(1);
    expect((await harness.send(encodeGetBlocks(MAGIC, { ids: ['aa'.repeat(32)] })))).toHaveLength(1);
    expect(dispatched).toEqual([]);
  });
});

describe('sync stream handler — the outer span', () => {
  it('logs a stream-level failure rather than replying empty in silence', async () => {
    // A source that dies mid-read stands in for the ordinary case: a peer that
    // drops the connection. `warn`, not `error` — this one is not necessarily
    // anyone's bug — but it is logged, not swallowed.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sendBrokenStream } = makeHandlerHarness();

    const written = await sendBrokenStream();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('sync stream handler failed'),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('connection reset'));
    expect(isEmptyReply(written)).toBe(true);
    warnSpy.mockRestore();
  });

  it('answers an empty request with an empty frame and no warning', async () => {
    // The control that keeps the test above honest: the outer log must fire on
    // a genuine failure, not on every request that happens to answer empty.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send } = makeHandlerHarness();

    const written = await send(new Uint8Array(0));

    expect(isEmptyReply(written)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('answers a non-Active peer with an empty frame and no log', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send } = makeHandlerHarness({ active: false });

    const written = await send(encodeFrame(MAGIC, MSG_SYNC_INFO, new Uint8Array([1])));

    expect(isEmptyReply(written)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// MODIFIER_POST_BODY (103) — served on the request's own stream
//
// A ModifierRequest of type 103 is answered on the stream it arrived on
// (NET_INTERFACE → ModifierRequest; Local-Serve-Before-Relay).
// ---------------------------------------------------------------------------

describe('sync stream handler — post body serve (code 103)', () => {
  const POST_ID = 'aa'.repeat(32);
  const CONTENT = 'test post body';

  it('serves bodies on the request stream and the requester reads them', async () => {
    const { send } = makeHandlerHarness({
      postBodyProvider: (id) => id === POST_ID ? CONTENT : null,
    });

    const req = encodeModifierRequest(MAGIC, { typeId: MODIFIER_POST_BODY, ids: [POST_ID] });
    const written = await send(req);

    expect(written).toHaveLength(1);
    expect(written[0]!.length).toBeGreaterThan(0);
    const frame = decodeFrame(MAGIC, written[0]!);
    expect(frame.code).toBe(MSG_MODIFIER_RESPONSE);
    const resp = decodeModifierResponse(frame.body)!;
    expect(resp.typeId).toBe(MODIFIER_POST_BODY);
    expect(resp.modifiers).toHaveLength(1);
    expect(resp.modifiers[0]!.id).toBe(POST_ID);
    expect(decodePostBody(resp.modifiers[0]!.data)).toBe(CONTENT);
  });

  it('omits ids the provider does not hold — zero-byte reply', async () => {
    const { send } = makeHandlerHarness({
      postBodyProvider: () => null,
    });

    const req = encodeModifierRequest(MAGIC, { typeId: MODIFIER_POST_BODY, ids: [POST_ID] });
    const written = await send(req);

    expect(written).toHaveLength(1);
    expect(written[0]!.length).toBe(0);
  });

  it('answers empty when no provider is registered', async () => {
    const { send } = makeHandlerHarness();

    const req = encodeModifierRequest(MAGIC, { typeId: MODIFIER_POST_BODY, ids: [POST_ID] });
    const written = await send(req);

    expect(isEmptyReply(written)).toBe(true);
  });

  it('drops a type-101 ModifierRequest unpenalised, with an empty answer', async () => {
    // NET_INTERFACE → ModifierRequest (code 4) — type id 101 is retired;
    // the handler decodes the frame and drops it as an unknown type id,
    // answering an empty frame and recording no penalty.
    const dispatched: number[] = [];
    const { send } = makeHandlerHarness({
      syncMachine: { handleMessage: (_p, code) => { dispatched.push(code); } },
    });

    const req = encodeModifierRequest(MAGIC, { typeId: 101, ids: [POST_ID] });
    const written = await send(req);

    expect(dispatched).toEqual([]);
    expect(isEmptyReply(written)).toBe(true);
  });

  it('bans the sender on a truncated ModifierRequest body', async () => {
    // NET_INTERFACE → ModifierRequest — the body's count is read before
    // the first element; a truncated / malformed body is a permanent ban.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send, peerMgr, peerId } = makeHandlerHarness({
      postBodyProvider: () => null,
    });
    // `0xff` opens a VLQ that never closes — the decoder refuses the body.
    const written = await send(encodeFrame(MAGIC, 4 /* MSG_MODIFIER_REQUEST */, new Uint8Array([0xff])));
    expect(isEmptyReply(written)).toBe(true);
    expect(peerMgr.getPeerMetadata(peerId)).toBeNull();
    expect(peerMgr.isPeerActive(peerId)).toBe(false);
    warnSpy.mockRestore();
  });

  it('bans the sender on a ModifierRequest whose id count exceeds the cap', async () => {
    // NET_INTERFACE → ModifierRequest — "1–MAX_INV_IDS (400) ids, the
    // count read and refused BEFORE the first element": an over-cap body
    // is malformed and the sender is permanently banned.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send, peerMgr, peerId } = makeHandlerHarness({
      postBodyProvider: () => null,
    });
    // Build a body declaring 401 ids — the codec will refuse the count.
    // Using encodeModifierRequest with 401 ids would already throw on the
    // send side; build the body by hand.
    const body = new Uint8Array(1 + 2);
    body[0] = MODIFIER_POST_BODY;
    // vlqU(401) = [0x91, 0x03]
    body[1] = 0x91;
    body[2] = 0x03;
    const written = await send(encodeFrame(MAGIC, 4 /* MSG_MODIFIER_REQUEST */, body));
    expect(isEmptyReply(written)).toBe(true);
    expect(peerMgr.getPeerMetadata(peerId)).toBeNull();
    warnSpy.mockRestore();
  });

});
