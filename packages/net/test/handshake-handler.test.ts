import { describe, it, expect, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@dagsocial/types';
import type { OrderingBlock } from '@dagsocial/types';
import {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyOrderingBlockStructure,
} from '@dagsocial/validation';
import { NetNode } from '../src/node.js';
import { buildHandshakeFrame } from '../src/handshake.js';
import type { HandshakeResult } from '../src/handshake.js';
import { PeerState } from '../src/types.js';
import type { NetConfig, NetValidators } from '../src/types.js';
import type { PeerManager } from '../src/peer-mgr.js';

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
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyOrderingBlockStructure,
};

function makeConfig(): NetConfig {
  return {
    magic: MAGIC,
    bootstrapPeers: [],
    listenAddrs: '/ip4/0.0.0.0/tcp/0',
    maxPeers: 10,
    penaltyScoreThreshold: 500,
    temporalBanDurationMs: 3_600_000,
    penaltySafeIntervalMs: 120_000,
    syncRequestTimeoutMs: 10_000,
  };
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
  sinkThrows?: boolean;
} = {}) {
  const net = new NetNode(makeConfig(), validators);
  const peerId = 'peer-under-test';

  let captured: StreamHandler | null = null;
  const internals = net as unknown as {
    libp2p: unknown;
    peerMgr: PeerManager;
    registerHandshakeHandler(libp2p: unknown): void;
  };
  internals.libp2p = {
    handle: (protocol: string, cb: StreamHandler) => {
      if (protocol === '/dagsocial/handshake/1') captured = cb;
    },
    getMultiaddrs: () => [],
    peerId: { toString: () => 'self-peer-id' },
  };

  internals.peerMgr.addPeer({
    id: peerId,
    multiaddrs: [],
    protocols: [],
    connectedAt: Date.now(),
  });

  // Public door. Sets the block provider, and — the point of the option —
  // wires `chainHeight()` to node's callback through it.
  if (opts.headersHandler) net.setHeadersHandler(opts.headersHandler);

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

  return { send, sendBrokenStream, peerMgr: internals.peerMgr, peerId };
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
    // `buildOurHandshake` reads `chainHeight()`, which walks node's registered
    // block callback. Folded into the outer catch it would read as a handshake
    // failure, sending whoever read the log to the wrong subsystem.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send } = makeHandshakeHarness({
      headersHandler: () => {
        throw new Error('store exploded');
      },
    });

    const written = await send(validHandshakeFrame());

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('cannot build our handshake'),
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
    // Positive control: the extra span did not break the reply.
    const { send, peerMgr, peerId } = makeHandshakeHarness({ headersHandler: () => null });

    const written = await send(validHandshakeFrame());

    expect(written).toHaveLength(1);
    expect(written[0]!.length).toBeGreaterThan(0);
    expect(peerMgr.getPeerMetadata(peerId)?.state).toBe(PeerState.Active);
  });

  it('names a sink failure on the reply as a handler failure, not a store one', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { send } = makeHandshakeHarness({ headersHandler: () => null, sinkThrows: true });

    await send(validHandshakeFrame());

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('inbound handshake handler failed'),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('peer went away'));
    expect(errSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });
});
