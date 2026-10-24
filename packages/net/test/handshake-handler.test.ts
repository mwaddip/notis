import { describe, it, expect, vi } from 'vitest';
import { encodeStruct } from '@dagsocial/types';
import { handshakeCodec } from '../src/handshake.js';
import { PROTOCOL_VERSION } from '@dagsocial/types';
import type { OrderingBlock, ProtocolEra } from '@dagsocial/types';
import {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyTxSignatures,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyHeaderFieldDomains,
  verifyValidatorSignature,
  verifyPostBody,
} from '@dagsocial/validation';
import { NetNode } from '../src/node.js';
import { buildHandshakeFrame, decodeHandshakeBody, parseHandshakeBody, validateHandshake } from '../src/handshake.js';
import type { HandshakeResult } from '../src/handshake.js';
import { decodeFrame } from '../src/frame.js';
import { PeerState, PenaltyKind } from '../src/types.js';
import type { NetConfig, NetValidators } from '../src/types.js';
import { makeConfig as makeBaseConfig } from './helpers.js';
import { makeFakeStream } from './fake-stream.js';
import type { PeerManager } from '../src/peer-mgr.js';
import { PeerDb } from '../src/peerdb.js';

// ---------------------------------------------------------------------------
// The inbound handshake handler — every failure gets a line
//
// One silent catch over this body would cover stream I/O, our own reply
// construction and node's store callback alike, leaving the peer with an empty
// frame and the operator with nothing. A peer that never connects and never
// explains why is indistinguishable from a peer that never dialled.
//
// The reply is unchanged in every case below. What these pin is that the class
// is now nameable, and that the two classes are not named the same thing.
// ---------------------------------------------------------------------------

const MAGIC = 0x54444147;

const validators: NetValidators = {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyTxSignatures,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyHeaderFieldDomains,
  verifyValidatorSignature,
  verifyPostBody,
};

function makeConfig(
  schedule: readonly ProtocolEra[] = [{ version: 1, fromHeight: 0 }],
): NetConfig {
  return makeBaseConfig({ protocolVersionSchedule: schedule });
}

type StreamHandler = (
  stream: unknown,
  connection: {
    id: string;
    remotePeer: { toString(): string };
    remoteAddr?: { toString(): string };
  },
) => Promise<void>;

interface HandleOptions {
  maxInboundStreams?: number;
}

/**
 * Register the real inbound handshake handler against a stub libp2p and return
 * a driver for it.
 *
 * Same concentration of private access, for the same reason, as
 * `sync-stream-handler.test.ts`'s harness: `registerHandshakeHandler` is
 * private with a single private caller (`start()`), and `start()` means real
 * libp2p — a TCP listener for what is a pure control-flow question.
 */
function makeHandshakeHarness(opts: {
  headersHandler?: (height: number) => OrderingBlock | null;
  chainHeight?: number;
  chainHeightProvider?: () => number;
  sinkThrows?: boolean;
  schedule?: readonly ProtocolEra[];
  multiaddrs?: string[];
  /** The stream's `connection.remotePeer` — defaults to an ordinary remote id. */
  remotePeerId?: string;
  /** The default connection id for every `send` on this harness. */
  connectionId?: string;
} = {}) {
  const net = new NetNode(makeConfig(opts.schedule), validators);
  const peerId = opts.remotePeerId ?? 'peer-under-test';

  let captured: StreamHandler | null = null;
  let registrationOptions: HandleOptions | undefined;
  const internals = net as unknown as {
    libp2p: unknown;
    peerMgr: PeerManager;
    peerDb: PeerDb;
    registerHandshakeHandler(libp2p: unknown): void;
  };
  // start() is never called (real libp2p is a TCP listener), so peerDb is null
  // and the handler's record write is a no-op. Inject an ephemeral one so the
  // record the inbound handshake writes is observable.
  const peerDb = new PeerDb(null, 1000, []);
  internals.peerDb = peerDb;
  internals.libp2p = {
    handle: (protocol: string, cb: StreamHandler, options?: HandleOptions) => {
      if (protocol === '/dagsocial/handshake/1') {
        captured = cb;
        registrationOptions = options;
      }
    },
    getMultiaddrs: () => (opts.multiaddrs ?? []).map((s) => ({ toString: () => s })),
    getConnections: () => [],
    hangUp: () => Promise.resolve(),
    peerId: { toString: () => 'self-peer-id' },
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  internals.peerMgr.addPeer({
    id: peerId,
    multiaddrs: [],
    protocols: [],
    connectedAt: Date.now(),
  });

  if (opts.headersHandler) net.setHeadersHandler(opts.headersHandler);
  if (opts.chainHeightProvider) net.setChainHeightProvider(opts.chainHeightProvider);
  else if (opts.chainHeight !== undefined) {
    const h = opts.chainHeight;
    net.setChainHeightProvider(() => h);
  }

  // The stub is passed in, not read off the instance: the registrars take the
  // libp2p node as a parameter. It is also assigned above, for the paths that
  // reach it through the instance at request time (`buildOurHandshake`).
  internals.registerHandshakeHandler(internals.libp2p);
  if (!captured) throw new Error('registerHandshakeHandler registered no handler');

  // Counts how many times the handler closed the stub connection, keyed by
  // its id, so a case can assert on the connection whose handshake ran.
  const connectionCloses = new Map<string, number>();
  const drive = async (
    source: AsyncIterable<Uint8Array>,
    connectionId: string,
  ): Promise<Uint8Array[]> => {
    const base = makeFakeStream(source);
    // The 1.x harness threw out of `sink` when a non-empty chunk arrived — the
    // peer going away mid-write. The 3.x write path throws out of `send`, so
    // the throw rides the synchronous call this helper wraps.
    const stream: typeof base = {
      ...base,
      get written() { return base.written; },
      get closed() { return base.closed; },
      get aborted() { return base.aborted; },
      [Symbol.asyncIterator]: () => base[Symbol.asyncIterator](),
      send: (data: Uint8Array): boolean => {
        if (opts.sinkThrows && data.length > 0) throw new Error('peer went away');
        return base.send(data);
      },
    };
    const connection = {
      id: connectionId,
      remotePeer: { toString: () => peerId },
      remoteAddr: { toString: () => '/ip4/127.0.0.1/tcp/1234' },
      close: async () => {
        connectionCloses.set(connectionId, (connectionCloses.get(connectionId) ?? 0) + 1);
      },
    };
    await captured!(stream, connection);
    return stream.written;
  };

  const defaultConnId = opts.connectionId ?? 'conn-default';

  const send = (
    request: Uint8Array,
    sendOpts: { connectionId?: string } = {},
  ): Promise<Uint8Array[]> =>
    drive((async function* () {
      yield request;
    })(), sendOpts.connectionId ?? defaultConnId);

  const sendBrokenStream = (): Promise<Uint8Array[]> =>
    drive((async function* () {
      yield new Uint8Array([0x01]);
      throw new Error('connection reset');
    })(), defaultConnId);

  return {
    net,
    send,
    sendBrokenStream,
    peerMgr: internals.peerMgr,
    peerId,
    peerDb,
    registrationOptions: () => registrationOptions,
    connectionCloses: () => connectionCloses,
  };
}

function validHandshakeFrame(): Uint8Array {
  return buildHandshakeFrame(MAGIC, {
    agentName: 'dagsocial/1.0.0',
    protocolVersion: PROTOCOL_VERSION,
    nodeName: 'peer',
    chainHeight: 7,
    capabilities: [],
  });
}

function isEmptyReply(written: Uint8Array[]): boolean {
  return written.length === 1 && written[0]!.length === 0;
}

/**
 * Drive the real outbound handshake against a stub libp2p whose stream close
 * can be made to reject.
 */
function makeOutboundHarness(opts: { closeRejects?: boolean } = {}) {
  const net = new NetNode(makeConfig(), validators);
  const peerId = 'remote-peer';
  const internals = net as unknown as {
    libp2p: unknown;
    peerMgr: PeerManager;
    runOutboundHandshake(conn: unknown): Promise<HandshakeResult>;
  };
  internals.libp2p = {
    getPeers: () => [{ toString: () => peerId }],
    getMultiaddrs: () => [],
    getConnections: () => [],
    hangUp: () => Promise.resolve(),
    peerId: { toString: () => 'self-peer-id' },
  };
  internals.peerMgr.addPeer({
    id: peerId,
    multiaddrs: [],
    protocols: [],
    connectedAt: Date.now(),
  });
  const conn = {
    id: 'outbound-conn',
    direction: 'outbound' as const,
    remotePeer: { toString: () => peerId },
    newStream: async () => {
      const base = makeFakeStream([validHandshakeFrame()]);
      // `oneRoundTrip` closes the stream in a `finally`, after the half-close
      // the write helper already ran — so this harness is wired to reject
      // only that outer close, where the swallow is what keeps a completed
      // round trip's result (NET_INTERFACE → Pull Requests → "A request is
      // one round trip, and closing its stream never changes its answer").
      let closeCalls = 0;
      return {
        ...base,
        get written() { return base.written; },
        get closed() { return base.closed; },
        get aborted() { return base.aborted; },
        [Symbol.asyncIterator]: () => base[Symbol.asyncIterator](),
        close: async (opts2?: { signal?: AbortSignal }) => {
          closeCalls++;
          if (opts.closeRejects && closeCalls > 1) throw new Error('close failed');
          return base.close(opts2);
        },
      };
    },
  };
  return () => internals.runOutboundHandshake(conn);
}

describe('outbound handshake — the finally', () => {
  it('keeps the handshake result when the stream close rejects', async () => {
    // A `finally` that awaits a rejecting close replaces whatever the function
    // determined — here, a completed handshake becomes a thrown close error,
    // and the caller logs the wrong failure for a peer that is in fact fine.
    const result = await makeOutboundHarness({ closeRejects: true })();

    expect(result.ok).toBe(true);
    expect(result.peerHeight).toBe(7);
  });

  it('returns the same result when the close is ordinary', async () => {
    const result = await makeOutboundHarness()();

    expect(result.ok).toBe(true);
    expect(result.peerHeight).toBe(7);
  });
});

describe('inbound handshake handler — the outer span', () => {
  it('names a stream-level failure instead of closing in silence', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sendBrokenStream } = makeHandshakeHarness();

    const written = await sendBrokenStream();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('inbound handshake handler failed'),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('connection reset'));
    expect(isEmptyReply(written)).toBe(true);
    warnSpy.mockRestore();
  });

  it('does not penalise the peer for a dropped connection', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sendBrokenStream, peerMgr, peerId } = makeHandshakeHarness();
    const before = peerMgr.getPeerMetadata(peerId)?.penaltyCount ?? 0;

    await sendBrokenStream();

    expect(peerMgr.getPeerMetadata(peerId)?.penaltyCount ?? 0).toBe(before);
    warnSpy.mockRestore();
  });

  it('stays silent on the paths that already state their own verdict', async () => {
    // The control that keeps the test above honest: an empty request and a
    // rejected handshake both answer empty *by decision*, and neither is a
    // handler failure. Only the first of those is silent — a rejected
    // handshake logs its own reason, which is not this catch's line.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send } = makeHandshakeHarness();

    expect(isEmptyReply(await send(new Uint8Array(0)))).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('inbound handshake handler — our own reply', () => {
  it('attributes a throwing store callback to the store, not to the handshake', async () => {
    // Reading our era goes through `chainHeight()`, the first store read on the
    // path. Folded into the outer catch it would read as a handshake failure,
    // sending whoever read the log to the wrong subsystem.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send } = makeHandshakeHarness({
      chainHeightProvider: () => {
        throw new Error('store exploded');
      },
    });

    const written = await send(validHandshakeFrame());

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('cannot read our era'),
    );
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('store exploded'));
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('inbound handshake handler failed'),
    );
    expect(isEmptyReply(written)).toBe(true);
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('answers a good handshake with our own frame, and marks the peer Active', async () => {
    const { send, peerMgr, peerId } = makeHandshakeHarness({ chainHeight: 0 });

    const written = await send(validHandshakeFrame());

    expect(written).toHaveLength(1);
    expect(written[0]!.length).toBeGreaterThan(0);
    expect(peerMgr.getPeerMetadata(peerId)?.state).toBe(PeerState.Active);
  });

  // NET_INTERFACE → "A banned peer's handshake is refused unread"
  it('refuses a banned peer\'s handshake unread — no reply, not marked Active', async () => {
    const { send, peerMgr, peerId } = makeHandshakeHarness({ chainHeight: 0 });
    peerMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, peerId, 'earlier violation');
    expect(peerMgr.isBanned(peerId)).toBe(true);

    const written = await send(validHandshakeFrame());

    // The guard closes the stream before reading: not even the empty-frame
    // rejection is sent, and the peer never reaches Active.
    expect(written).toHaveLength(0);
    expect(peerMgr.getPeerMetadata(peerId)?.state).not.toBe(PeerState.Active);
  });

  it('names a sink failure on the reply as a handler failure, not a store one', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { send } = makeHandshakeHarness({ chainHeight: 0, sinkThrows: true });

    await send(validHandshakeFrame());

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('inbound handshake handler failed'),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('peer went away'));
    expect(errSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('carries the height provider value in the reply chainHeight field', async () => {
    const { send } = makeHandshakeHarness({ chainHeight: 55 });

    const written = await send(validHandshakeFrame());

    expect(written).toHaveLength(1);
    const frame = decodeFrame(MAGIC, written[0]!);
    const raw = parseHandshakeBody(frame.body);
    // Our reply declares PROTOCOL_VERSION, which covers era PROTOCOL_VERSION.
    const result = validateHandshake(raw, PROTOCOL_VERSION);
    expect(result.ok).toBe(true);
    expect(result.peerHeight).toBe(55);
  });
});

describe('inbound handshake handler — the declared address', () => {
  // NET_INTERFACE → Handshake Body, the `declaredAddress` row: our reply
  // declares the first listen address that is not loopback, and declares
  // nothing when every listen address is loopback.
  async function replyDeclaredAddress(
    multiaddrs: string[],
  ): Promise<string | undefined> {
    const { send } = makeHandshakeHarness({ chainHeight: 0, multiaddrs });
    const written = await send(validHandshakeFrame());
    const reply = decodeHandshakeBody(decodeFrame(MAGIC, written[0]!).body);
    return reply?.declaredAddress;
  }

  it('declares the first non-loopback address, skipping the loopback libp2p lists first', async () => {
    expect(
      await replyDeclaredAddress(['/ip4/127.0.0.1/tcp/9733', '/ip4/10.0.0.5/tcp/9733']),
    ).toBe('/ip4/10.0.0.5/tcp/9733');
  });

  it('declares nothing when every listen address is loopback', async () => {
    expect(
      await replyDeclaredAddress(['/ip4/127.0.0.1/tcp/9733', '/ip6/::1/tcp/9733']),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Frame-tier rejection — NET_INTERFACE → "Ban policy"
//
// A payload that does not decode as a valid frame is rejected with no
// penalty. These drive the real inbound handler so the assertion can fail
// if the handler ever calls recordPenaltyKind on a frame-tier reject.
// ---------------------------------------------------------------------------

describe('inbound handshake handler — frame-tier rejection', () => {
  it('does not ban a peer that sends unframed positional bytes', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send, peerMgr, peerId } = makeHandshakeHarness({ chainHeight: 0 });

    const raw = encodeStruct(handshakeCodec, {
      agentName: 'dagsocial/1.0.0',
      protocolVersion: PROTOCOL_VERSION,
      nodeName: 'peer',
      chainHeight: 7,
      capabilities: [],
    });
    const written = await send(raw);

    expect(isEmptyReply(written)).toBe(true);
    expect(peerMgr.isBanned(peerId)).toBe(false);
    expect(peerMgr.getPeerMetadata(peerId)?.penaltyCount ?? 0).toBe(0);
    warnSpy.mockRestore();
  });

  it('does not ban a peer that sends a truncated frame', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send, peerMgr, peerId } = makeHandshakeHarness({ chainHeight: 0 });

    const frame = validHandshakeFrame();
    const cut = frame.subarray(0, 6);
    const written = await send(cut);

    expect(isEmptyReply(written)).toBe(true);
    expect(peerMgr.isBanned(peerId)).toBe(false);
    expect(peerMgr.getPeerMetadata(peerId)?.penaltyCount ?? 0).toBe(0);
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// The era gate flips through the tip — NET_INTERFACE → Handshake
//
// The handler reads its era from chainHeight() + 1, so the accept/refuse of one
// fixed peer flips as the tip crosses the boundary — driven through the height
// provider, not the era argument. `validHandshakeFrame()` declares
// PROTOCOL_VERSION = 1, and the schedule bumps to era 2 at height H.
// ---------------------------------------------------------------------------

function peerHandshakeFrame(version: number, declaredAddress?: string): Uint8Array {
  return buildHandshakeFrame(MAGIC, {
    agentName: 'dagsocial/1.0.0',
    protocolVersion: version,
    nodeName: 'peer',
    chainHeight: 7,
    ...(declaredAddress ? { declaredAddress } : {}),
    capabilities: [],
  });
}

describe('inbound handshake handler — the era gate flips through the tip', () => {
  const H = 5;
  const twoEra: readonly ProtocolEra[] = [
    { version: 1, fromHeight: 0 },
    { version: 2, fromHeight: H },
  ];

  it('accepts a v1 peer while the tip is below the boundary', async () => {
    // chainHeight H-2 → era at (H-2)+1 = H-1 = 1; 1 >= 1 accepts.
    const { send, peerMgr, peerId } = makeHandshakeHarness({ schedule: twoEra, chainHeight: H - 2 });

    const written = await send(validHandshakeFrame());

    expect(written).toHaveLength(1);
    expect(written[0]!.length).toBeGreaterThan(0);
    expect(peerMgr.getPeerMetadata(peerId)?.state).toBe(PeerState.Active);
  });

  it('refuses the same v1 peer once the tip crosses the boundary', async () => {
    // chainHeight H-1 → era at (H-1)+1 = H = 2; 1 < 2 refuses, softly.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send, peerMgr, peerId } = makeHandshakeHarness({ schedule: twoEra, chainHeight: H - 1 });

    const written = await send(validHandshakeFrame());

    expect(isEmptyReply(written)).toBe(true);
    expect(peerMgr.getPeerMetadata(peerId)?.state).not.toBe(PeerState.Active);
    // Soft: a version mismatch is Transient, never a ban.
    expect(peerMgr.isBanned(peerId)).toBe(false);
    expect(peerMgr.getPeerMetadata(peerId)?.penaltyCount ?? 0).toBe(1);
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// The record and metadata keep the peer's declared version — NET_INTERFACE →
// PeerDb; → Post-Handshake Routing. This build declares PROTOCOL_VERSION = 1;
// the peer declares 2, and both the PeerDb record and the peer's metadata hold
// 2, not our constant.
// ---------------------------------------------------------------------------

describe('inbound handshake handler — the record keeps the declared version', () => {
  it('records the peer\'s declared version at lastSeenMs 0 and stamps it on the metadata', async () => {
    const peerId = '12D3KooWKze1ug3uVs8EkynoWPGFY7GQKgT67VKMzvHVe3v6UhwV';
    const addr = `/ip4/9.9.9.9/tcp/9000/p2p/${peerId}`;
    const { send, peerMgr, peerDb } = makeHandshakeHarness({ chainHeight: 0, remotePeerId: peerId });

    await send(peerHandshakeFrame(2, addr));

    expect(peerDb.get(addr)?.protocolVersion).toBe(2);
    expect(peerDb.get(addr)?.lastSeenMs).toBe(0);
    expect(peerMgr.getPeerMetadata(peerId)?.protocolVersion).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// A stream from our own peer id — NET_INTERFACE → "A connection whose remote
// peer id is this node's own is never a peer": refused the way any other
// handshake stream is, an empty frame, with no penalty, there being nobody to
// penalise.
// ---------------------------------------------------------------------------

describe('inbound handshake handler — a stream from our own peer id', () => {
  it('answers the empty frame, does not mark it Active, writes no PeerDb record, and does not penalise it', async () => {
    const { send, peerMgr, peerDb } = makeHandshakeHarness({
      chainHeight: 0,
      remotePeerId: 'self-peer-id',
    });
    const before = peerMgr.getPeerMetadata('self-peer-id')?.penaltyCount ?? 0;

    const written = await send(validHandshakeFrame());

    expect(isEmptyReply(written)).toBe(true);
    expect(peerMgr.getPeerMetadata('self-peer-id')?.state).not.toBe(PeerState.Active);
    // The handshake's self check runs before any PeerDb write, and
    // nothing landing under the handshake's remoteAddr is itself the
    // rule for every handshake declaring no address
    // (NET_INTERFACE → Handshake →
    // "A declared address is hearsay until a dial names it").
    expect(peerDb.get('/ip4/127.0.0.1/tcp/1234')).toBeNull();
    expect(peerMgr.getPeerMetadata('self-peer-id')?.penaltyCount ?? 0).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// NET_INTERFACE → Handshake → "A connection carries one handshake, opened by
// the side that dialled it" — the read bound and the stream limit per
// connection; a second handshake stream on a connection that has carried one
// closes unread, with no penalty.
// ---------------------------------------------------------------------------

describe('inbound handshake handler — one handshake stream a connection', () => {
  it('bans a peer whose handshake stream carries bytes past the frame cap', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send, peerMgr, peerId } = makeHandshakeHarness({ chainHeight: 0 });

    // Two mebibytes of zeros — far above the 984-byte frame cap, far below
    // the stream byte cap. The read bounded by the frame cap refuses it as
    // a protocol violation.
    const twoMiB = new Uint8Array(2 * 1024 * 1024);
    await send(twoMiB);

    expect(peerMgr.isBanned(peerId)).toBe(true);
    warnSpy.mockRestore();
  });

  it('registers the handshake handler with maxInboundStreams of 1', () => {
    const { registrationOptions } = makeHandshakeHarness();
    expect(registrationOptions()?.maxInboundStreams).toBe(1);
  });

  it('closes a second handshake stream on the same connection unread', async () => {
    const { send, peerMgr, peerId, net } = makeHandshakeHarness({ chainHeight: 0 });
    let activeCount = 0;
    net.onPeerActive((id) => { if (id === peerId) activeCount++; });

    const first = await send(validHandshakeFrame(), { connectionId: 'conn-A' });
    // control: first handshake is answered and the peer becomes Active
    expect(first).toHaveLength(1);
    expect(first[0]!.length).toBeGreaterThan(0);
    expect(peerMgr.getPeerMetadata(peerId)?.state).toBe(PeerState.Active);

    const second = await send(validHandshakeFrame(), { connectionId: 'conn-A' });

    expect(second).toHaveLength(0);
    expect(activeCount).toBe(1);
    expect(peerMgr.getPeerMetadata(peerId)?.penaltyCount ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// NET_INTERFACE → Handshake → "A peer becomes Active once" — a handshake
// that completes for a peer already Active, on a second connection, is
// validated and answered when this node is the listener, and records and
// raises nothing.
// ---------------------------------------------------------------------------

describe('inbound handshake handler — a peer becomes Active once', () => {
  it('a valid handshake from a peer already Active records and raises nothing', async () => {
    const peerId = '12D3KooWKze1ug3uVs8EkynoWPGFY7GQKgT67VKMzvHVe3v6UhwV';
    const firstAddr = `/ip4/9.9.9.9/tcp/9000/p2p/${peerId}`;
    const secondAddr = `/ip4/8.8.8.8/tcp/8000/p2p/${peerId}`;
    const { send, peerMgr, peerDb, net } = makeHandshakeHarness({ chainHeight: 0, remotePeerId: peerId });
    let activeCount = 0;
    net.onPeerActive((id) => { if (id === peerId) activeCount++; });

    const first = await send(peerHandshakeFrame(1, firstAddr), { connectionId: 'conn-A' });
    // controls: first handshake is answered, the peer is Active, the record is written at lastSeenMs 0
    expect(first).toHaveLength(1);
    expect(peerMgr.getPeerMetadata(peerId)?.state).toBe(PeerState.Active);
    expect(peerDb.get(firstAddr)?.protocolVersion).toBe(1);
    expect(peerDb.get(firstAddr)?.lastSeenMs).toBe(0);

    const second = await send(peerHandshakeFrame(1, secondAddr), { connectionId: 'conn-B' });

    // control: this node is the listener on the second connection, so its reply
    // is a handshake frame
    expect(second).toHaveLength(1);
    expect(decodeHandshakeBody(decodeFrame(MAGIC, second[0]!).body)).not.toBeNull();

    expect(activeCount).toBe(1);
    expect(peerDb.get(firstAddr)?.protocolVersion).toBe(1);
    expect(peerDb.get(secondAddr)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NET_INTERFACE → Handshake → "A handshake that does not complete ends its
// connection" — every return path that does not complete the handshake closes
// the connection it ran on, including a fault of this node's own.
// ---------------------------------------------------------------------------

describe('inbound handshake handler — every return path closes the connection', () => {
  // NET_INTERFACE → Handshake → "A handshake that does not complete ends
  // its connection". The harness tests the handler's own close on paths a
  // real dialler would also close from — otherwise a removal of the
  // handler's close leaves the file green on the strength of the dialler's
  // close alone.
  it('a frame-tier reject closes the connection', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send, connectionCloses } = makeHandshakeHarness({ chainHeight: 0 });

    const raw = encodeStruct(handshakeCodec, {
      agentName: 'dagsocial/1.0.0',
      protocolVersion: PROTOCOL_VERSION,
      nodeName: 'peer',
      chainHeight: 7,
      capabilities: [],
    });
    await send(raw, { connectionId: 'conn-frame' });

    expect(connectionCloses().get('conn-frame') ?? 0).toBeGreaterThanOrEqual(1);
    warnSpy.mockRestore();
  });

  it('a body-tier reject closes the connection', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const twoEra: readonly ProtocolEra[] = [
      { version: 1, fromHeight: 0 },
      { version: 2, fromHeight: 5 },
    ];
    const { send, connectionCloses } = makeHandshakeHarness({ schedule: twoEra, chainHeight: 4 });

    await send(validHandshakeFrame(), { connectionId: 'conn-version' });

    expect(connectionCloses().get('conn-version') ?? 0).toBeGreaterThanOrEqual(1);
    warnSpy.mockRestore();
  });

  // NET_INTERFACE → Handshake → "A handshake that does not complete ends its
  // connection" — a fault of this node's own, from the handler's view, is a
  // return path the handshake can reach only through the harness. The era
  // read reaches the store through `chainHeight()`; a throw there is local,
  // not a peer's doing, the handshake does not complete, and the connection
  // closes with it.
  it('the era read throwing closes the connection', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { send, connectionCloses } = makeHandshakeHarness({
      chainHeightProvider: () => {
        throw new Error('store exploded');
      },
    });

    await send(validHandshakeFrame(), { connectionId: 'conn-era' });

    expect(connectionCloses().get('conn-era') ?? 0).toBeGreaterThanOrEqual(1);
    errSpy.mockRestore();
  });

  // NET_INTERFACE → Handshake → "A handshake that does not complete ends its
  // connection" — the reply-build fault: `currentEra()` reads `chainHeight()`
  // first and succeeds; `buildOurHandshake()` reads it again and throws, so
  // `buildHandshakeFrame(magic, this.buildOurHandshake())` is the throw site
  // the handler's own catch owns.
  it('the reply build throwing closes the connection', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    const { send, connectionCloses } = makeHandshakeHarness({
      chainHeightProvider: () => {
        calls++;
        if (calls === 1) return 0;
        throw new Error('store exploded on the second call');
      },
    });

    await send(validHandshakeFrame(), { connectionId: 'conn-build' });

    // control: both calls fired — era read, then reply build
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(connectionCloses().get('conn-build') ?? 0).toBeGreaterThanOrEqual(1);
    errSpy.mockRestore();
  });

  it('a banned peer\'s handshake refused unread closes the connection', async () => {
    const { send, peerMgr, peerId, connectionCloses } = makeHandshakeHarness({ chainHeight: 0 });
    peerMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, peerId, 'earlier violation');
    expect(peerMgr.isBanned(peerId)).toBe(true);

    await send(validHandshakeFrame(), { connectionId: 'conn-banned' });

    expect(connectionCloses().get('conn-banned') ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('an own-peer-id stream closes the connection', async () => {
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { send, connectionCloses } = makeHandshakeHarness({
      chainHeight: 0,
      remotePeerId: 'self-peer-id',
    });

    await send(validHandshakeFrame(), { connectionId: 'conn-self' });

    expect(connectionCloses().get('conn-self') ?? 0).toBeGreaterThanOrEqual(1);
    warnSpy.mockRestore();
  });

  it('bytes past the frame cap close the connection', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send, connectionCloses } = makeHandshakeHarness({ chainHeight: 0 });

    // Two mebibytes of zeros — far above the 984-byte frame cap. The read
    // bounded by the cap refuses it as a protocol violation.
    const twoMiB = new Uint8Array(2 * 1024 * 1024);
    await send(twoMiB, { connectionId: 'conn-oversize' });

    expect(connectionCloses().get('conn-oversize') ?? 0).toBeGreaterThanOrEqual(1);
    warnSpy.mockRestore();
  });

  it('an empty read closes the connection', async () => {
    const { send, connectionCloses } = makeHandshakeHarness({ chainHeight: 0 });

    await send(new Uint8Array(0), { connectionId: 'conn-empty' });

    expect(connectionCloses().get('conn-empty') ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('a sink that throws on the reply closes the connection', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send, connectionCloses } = makeHandshakeHarness({ chainHeight: 0, sinkThrows: true });

    await send(validHandshakeFrame(), { connectionId: 'conn-sink' });

    expect(connectionCloses().get('conn-sink') ?? 0).toBeGreaterThanOrEqual(1);
    warnSpy.mockRestore();
  });

  it('a completed handshake does not close the connection', async () => {
    const { send, connectionCloses } = makeHandshakeHarness({ chainHeight: 0 });

    const written = await send(validHandshakeFrame(), { connectionId: 'conn-ok' });

    // control: the reply is a handshake frame
    expect(written).toHaveLength(1);
    expect(written[0]!.length).toBeGreaterThan(0);
    expect(connectionCloses().get('conn-ok') ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// NET_INTERFACE → Handshake → "A declared address is hearsay until a dial
// names it" — the listener records the dialler's declared address only when
// it is no bogus address and its /p2p/ component names the peer id the
// connection proved, at lastSeenMs 0; a handshake that declares no address
// records none.
// ---------------------------------------------------------------------------

const LISTENER_PEER = '12D3KooWKze1ug3uVs8EkynoWPGFY7GQKgT67VKMzvHVe3v6UhwV';

describe('inbound handshake handler — a declared address is hearsay', () => {
  it('a routable declared address naming the peer id lands at lastSeenMs 0', async () => {
    const declared = `/ip4/9.9.9.9/tcp/9000/p2p/${LISTENER_PEER}`;
    const { send, peerDb } = makeHandshakeHarness({ chainHeight: 0, remotePeerId: LISTENER_PEER });

    const written = await send(peerHandshakeFrame(1, declared));

    // control: the reply is a handshake frame
    expect(written).toHaveLength(1);
    expect(written[0]!.length).toBeGreaterThan(0);
    expect(peerDb.get(declared)?.lastSeenMs).toBe(0);
  });

  it('a declared address naming another peer id leaves PeerDb empty', async () => {
    const otherId = '12D3KooWFCoqrsf1g1oMg3SNFXfSAfxA3iT5KGwi9cXeDi5BtvNz';
    const declared = `/ip4/9.9.9.9/tcp/9000/p2p/${otherId}`;
    const { send, peerDb } = makeHandshakeHarness({ chainHeight: 0, remotePeerId: LISTENER_PEER });

    const written = await send(peerHandshakeFrame(1, declared));

    // control: the handshake is accepted
    expect(written).toHaveLength(1);
    expect(peerDb.get(declared)).toBeNull();
  });

  it('a bogus (loopback) declared address leaves PeerDb empty, under testnet magic', async () => {
    const declared = `/ip4/127.0.0.1/tcp/9000/p2p/${LISTENER_PEER}`;
    const { send, peerDb } = makeHandshakeHarness({ chainHeight: 0, remotePeerId: LISTENER_PEER });

    const written = await send(peerHandshakeFrame(1, declared));

    // control: the handshake is accepted
    expect(written).toHaveLength(1);
    expect(peerDb.get(declared)).toBeNull();
  });

  it('a handshake declaring no address leaves PeerDb empty', async () => {
    const { send, peerDb } = makeHandshakeHarness({ chainHeight: 0, remotePeerId: LISTENER_PEER });

    const written = await send(validHandshakeFrame());

    // control: the handshake is accepted
    expect(written).toHaveLength(1);
    expect(peerDb.all()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// NET_INTERFACE → Handshake → "A declared address is hearsay until a dial
// names it" — "No address a handshake declares reaches a ban: a peer that
// dialled this node is banned with no address".
// ---------------------------------------------------------------------------

describe('inbound handshake handler — the declared address never reaches a ban', () => {
  it('a banned peer that dialled this node leaves its declared address a hint in PeerDb, isBanned false', async () => {
    const declared = `/ip4/9.9.9.9/tcp/9000/p2p/${LISTENER_PEER}`;
    const { send, peerDb, peerMgr } = makeHandshakeHarness({ chainHeight: 0, remotePeerId: LISTENER_PEER });

    const written = await send(peerHandshakeFrame(1, declared));
    // control: the handshake is accepted
    expect(written).toHaveLength(1);

    peerMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, LISTENER_PEER, 'test');
    // control: the peer id is banned
    expect(peerMgr.isBanned(LISTENER_PEER)).toBe(true);

    expect(peerDb.isBanned(declared)).toBe(false);
  });
});
