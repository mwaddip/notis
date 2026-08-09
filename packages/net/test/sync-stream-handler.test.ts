import { describe, it, expect, vi } from 'vitest';
import {
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
import { NetNode } from '../src/node.js';
import { encodeFrame } from '../src/frame.js';
import { encodeGetPosts } from '../src/sync-codec.js';
import { MSG_GET_POSTS, MSG_SYNC_INFO, PeerState } from '../src/types.js';
import type { NetConfig, NetValidators } from '../src/types.js';
import type { PeerManager } from '../src/peer-mgr.js';

// ---------------------------------------------------------------------------
// The sync stream handler — Phase 1f-3b, the third and widest swallow
//
// The handler's `try` spanned the stream read, the frame decode, all four
// serve branches, every `sink`, the app-layer `postsHandler` callback and the
// whole `syncMachine.handleMessage` dispatch. Its `catch` was bare — no error
// binding, no log — and replied with an empty frame. So a throw anywhere in
// sync dispatch was absorbed in complete silence and the peer simply got an
// empty answer.
//
// Three for three: every catch in this file had a span wider than the failure
// it was written for. These tests drive the REAL handler.
// ---------------------------------------------------------------------------

const MAGIC = 0x54444147;

const validators: NetValidators = {
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

function makeConfig(): NetConfig {
  return {
    magic: MAGIC,
    postPowTargetBits: 20,
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
 * Build a NetNode with the sync stream handler registered against a stub
 * libp2p, and return a function that feeds it one request.
 *
 * The reaching into privates is concentrated here, in one helper, rather than
 * spread across the tests: `registerSyncStreamHandler` is private with a single
 * private caller (`start()`), and `start()` means real libp2p — a TCP listener
 * and a 25s integration test for what is a pure control-flow question. The
 * alternative is extracting the 110-line handler body into a module-level
 * function, which is this file's stated idiom but a far larger change than the
 * logging fix under test. If these casts ever break, that extraction is the fix.
 *
 * `setPostsHandler` is public and goes in the front door.
 */
function makeHandlerHarness(opts: {
  postsHandler?: (postIds: string[]) => never;
  syncMachine?: { handleMessage: (p: string, c: number, b: Uint8Array) => void };
  active?: boolean;
} = {}) {
  const net = new NetNode(makeConfig(), validators);
  const peerId = 'peer-under-test';

  let captured: StreamHandler | null = null;
  const internals = net as unknown as {
    libp2p: unknown;
    peerMgr: PeerManager;
    syncMachine: unknown;
    registerSyncStreamHandler(): void;
  };
  internals.libp2p = {
    handle: (_protocol: string, cb: StreamHandler) => {
      captured = cb;
    },
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

  if (opts.postsHandler) net.setPostsHandler(opts.postsHandler);
  if (opts.syncMachine) internals.syncMachine = opts.syncMachine;

  internals.registerSyncStreamHandler();
  if (!captured) throw new Error('registerSyncStreamHandler registered no handler');

  /** Drive the handler with an arbitrary source; returns what was written back. */
  const drive = async (source: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> => {
    const written: Uint8Array[] = [];
    const stream = {
      source,
      sink: async (chunks: Iterable<Uint8Array>) => {
        for await (const c of chunks) written.push(c);
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

describe('sync stream handler — app-layer callback failures', () => {
  it('logs a throwing postsHandler instead of absorbing it', async () => {
    // Pre-fix: the throw unwound to the bare outer catch, which sank an empty
    // frame and said nothing. The peer saw "no posts" and the operator saw
    // no evidence that node's handler had failed at all.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { send } = makeHandlerHarness({
      postsHandler: () => {
        throw new Error('posts handler exploded');
      },
    });

    const body = encodeGetPosts(MAGIC, { postIds: ['ab'.repeat(32)] });
    const written = await send(body);

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('posts handler threw'),
    );
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('posts handler exploded'),
    );
    expect(isEmptyReply(written)).toBe(true);
    errSpy.mockRestore();
  });

  it('does not penalise the peer for our own handler throwing', async () => {
    // A failure in node's callback is not misbehaviour by the sender. The old
    // catch could not have penalised (it did nothing at all), and the new one
    // must not start.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { send, peerMgr, peerId } = makeHandlerHarness({
      postsHandler: () => {
        throw new Error('posts handler exploded');
      },
    });
    const before = peerMgr.getPeerMetadata(peerId)?.penaltyCount ?? 0;

    await send(encodeGetPosts(MAGIC, { postIds: ['ab'.repeat(32)] }));

    expect(peerMgr.getPeerMetadata(peerId)?.penaltyCount ?? 0).toBe(before);
    errSpy.mockRestore();
  });
});

describe('sync stream handler — sync dispatch failures', () => {
  it('logs a throwing handleMessage with the code and peer', async () => {
    // The worst instance of the pattern: `handleMessage` decodes the body and
    // applies the inbound caps, so a throw here is a bug in net's own guard
    // layer — and it produced an empty frame and total silence.
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

  it('still dispatches normally when handleMessage does not throw', async () => {
    // Positive control: the narrowed spans did not break routing.
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

describe('sync stream handler — the outer span', () => {
  it('logs a stream-level failure rather than replying empty in silence', async () => {
    // A source that dies mid-read stands in for the ordinary case: a peer that
    // drops the connection. `warn`, not `error` — this one is not necessarily
    // anyone's bug — but it is no longer nothing, which is what it was.
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
