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
  verifyOrderingBlockStructure,
  verifyPostBody,
} from '@dagsocial/validation';
import { NetNode } from '../src/node.js';
import { buildHandshakeFrame, decodeHandshakeBody, parseHandshakeBody, validateHandshake } from '../src/handshake.js';
import type { HandshakeResult } from '../src/handshake.js';
import { decodeFrame } from '../src/frame.js';
import { PeerState, PenaltyKind } from '../src/types.js';
import type { NetConfig, NetValidators } from '../src/types.js';
import { makeConfig as makeBaseConfig } from './helpers.js';
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
  verifyOrderingBlockStructure,
  verifyPostBody,
};

function makeConfig(
  schedule: readonly ProtocolEra[] = [{ version: 1, fromHeight: 0 }],
): NetConfig {
  return makeBaseConfig({ protocolVersionSchedule: schedule });
}

type StreamHandler = (arg: {
  stream: unknown;
  connection: { remotePeer: { toString(): string }; remoteAddr?: { toString(): string } };
}) => Promise<void>;

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
} = {}) {
  const net = new NetNode(makeConfig(opts.schedule), validators);
  const peerId = 'peer-under-test';

  let captured: StreamHandler | null = null;
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
    handle: (protocol: string, cb: StreamHandler) => {
      if (protocol === '/dagsocial/handshake/1') captured = cb;
    },
    getMultiaddrs: () => (opts.multiaddrs ?? []).map((s) => ({ toString: () => s })),
    peerId: { toString: () => 'self-peer-id' },
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

  const drive = async (source: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> => {
    const written: Uint8Array[] = [];
    const stream = {
      source,
      sink: async (chunks: Iterable<Uint8Array>) => {
        for await (const c of chunks) {
          if (opts.sinkThrows && c.length > 0) throw new Error('peer went away');
          written.push(c);
        }
      },
      close: async () => {},
    };
    await captured!({
      stream,
      connection: {
        remotePeer: { toString: () => peerId },
        remoteAddr: { toString: () => '/ip4/127.0.0.1/tcp/1234' },
      },
    });
    return written;
  };

  const send = (request: Uint8Array): Promise<Uint8Array[]> =>
    drive((async function* () {
      yield request;
    })());

  const sendBrokenStream = (): Promise<Uint8Array[]> =>
    drive((async function* () {
      yield new Uint8Array([0x01]);
      throw new Error('connection reset');
    })());

  return { send, sendBrokenStream, peerMgr: internals.peerMgr, peerId, peerDb };
}

function validHandshakeFrame(): Uint8Array {
  return buildHandshakeFrame(MAGIC, {
    agentName: 'dagsocial/1.0.0',
    protocolVersion: PROTOCOL_VERSION,
    nodeName: 'peer',
    chainHeight: 7,
    capabilities: [],
    sessionMagic: 1234,
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
    runOutboundHandshake(id: string): Promise<HandshakeResult>;
  };
  internals.libp2p = {
    getPeers: () => [{ toString: () => peerId }],
    getMultiaddrs: () => [],
    peerId: { toString: () => 'self-peer-id' },
    dialProtocol: async () => ({
      sink: async (chunks: Iterable<Uint8Array>) => {
        for await (const _c of chunks) { /* written */ }
      },
      source: (async function* () {
        yield validHandshakeFrame();
      })(),
      close: async () => {
        if (opts.closeRejects) throw new Error('close failed');
      },
    }),
  };
  internals.peerMgr.addPeer({
    id: peerId,
    multiaddrs: [],
    protocols: [],
    connectedAt: Date.now(),
  });
  return () => internals.runOutboundHandshake(peerId);
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
      sessionMagic: 1234,
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
    sessionMagic: 1234,
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
  it('records the peer\'s declared version and stamps it on the metadata', async () => {
    const addr = '/ip4/9.9.9.9/tcp/9000';
    const { send, peerMgr, peerId, peerDb } = makeHandshakeHarness({ chainHeight: 0 });

    await send(peerHandshakeFrame(2, addr));

    expect(peerDb.get(addr)?.protocolVersion).toBe(2);
    expect(peerMgr.getPeerMetadata(peerId)?.protocolVersion).toBe(2);
  });
});
