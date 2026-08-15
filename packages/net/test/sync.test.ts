import { describe, it, expect } from 'vitest';
import type { Libp2p } from 'libp2p';
import { SYNC_PROTOCOL, requestBlocks, requestHeaders } from '../src/sync.js';
import { encodeFrame } from '../src/frame.js';
import { encodePeers } from '../src/sync-codec.js';
import { MSG_BLOCKS, MSG_HEADERS } from '../src/types.js';
import type { NetConfig } from '../src/types.js';

const MAGIC = 0x54444147;
const PEER = 'peer-under-test';

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

/**
 * A libp2p that answers one dial with `response`, and records what was asked.
 *
 * The two request functions are exported module-level for the same reason the
 * serve loops are: driving them needs a stream, not a TCP listener.
 */
function makeDialStub(response: Uint8Array) {
  const dialled: string[] = [];
  const sent: Uint8Array[] = [];

  const libp2p = {
    getPeers: () => [{ toString: () => PEER }],
    dialProtocol: async (_peer: unknown, protocol: string) => {
      dialled.push(protocol);
      return {
        sink: async (chunks: Iterable<Uint8Array>) => {
          for await (const c of chunks) sent.push(c);
        },
        source: (async function* () {
          yield response;
        })(),
        close: async () => {},
      };
    },
  } as unknown as Libp2p;

  return { libp2p, dialled, sent };
}

describe('sync protocol', () => {
  it('has the correct protocol string', () => {
    expect(SYNC_PROTOCOL).toBe('/dagsocial/sync/1');
  });

  it('dials the sync stream for both chain queries', async () => {
    const headers = makeDialStub(encodeFrame(MAGIC, MSG_HEADERS, new Uint8Array([0])));
    await requestHeaders(headers.libp2p, 3, 2, PEER, makeConfig());
    expect(headers.dialled).toEqual([SYNC_PROTOCOL]);

    const blocks = makeDialStub(encodeFrame(MAGIC, MSG_BLOCKS, new Uint8Array([0])));
    await requestBlocks(blocks.libp2p, 1, 2, PEER, makeConfig());
    expect(blocks.dialled).toEqual([SYNC_PROTOCOL]);
  });
});

// ---------------------------------------------------------------------------
// The error contract these two do NOT share with requestPosts
//
// `requestPosts` answers an unexpected frame code or a malformed body with
// `{ entries: [] }`. These two must reject: `requestBlocks`' result goes
// straight to `reorg(forkHeight, newBlocks)`, which reverts above the fork point
// and applies what it is given, so an empty array truncates our own chain
// instead of failing to extend it (NET_INTERFACE → Pull Requests). Same
// transport, same shape, different error contract — and that difference is only
// visible in a test that sends the wrong code.
// ---------------------------------------------------------------------------

describe('chain queries reject a frame bearing another code', () => {
  it('throws on a response bearing another code', async () => {
    // A `Peers` frame is the sharpest case available: it is a legitimate message
    // on this very stream, so nothing but the code check separates it from an
    // answer. (It replaced a `Posts` frame, which no longer exists — the
    // posts-fetch message pair is deleted and codes 10/11 are reserved.)
    const wrongCode = () => makeDialStub(encodePeers(MAGIC, { peers: [] })).libp2p;

    await expect(requestHeaders(wrongCode(), 3, 2, PEER, makeConfig()))
      .rejects.toThrow(/bears code/);
    await expect(requestBlocks(wrongCode(), 1, 2, PEER, makeConfig()))
      .rejects.toThrow(/bears code/);
  });

  it('throws on a right-coded frame whose body is not a well-formed response', async () => {
    const junk = new Uint8Array([0xff, 0xff, 0xff, 0xff]);

    await expect(
      requestHeaders(makeDialStub(encodeFrame(MAGIC, MSG_HEADERS, junk)).libp2p, 3, 2, PEER, makeConfig()),
    ).rejects.toThrow(/well-formed/);
    await expect(
      requestBlocks(makeDialStub(encodeFrame(MAGIC, MSG_BLOCKS, junk)).libp2p, 1, 2, PEER, makeConfig()),
    ).rejects.toThrow(/well-formed/);
  });

  it('throws on bytes that are no frame at all', async () => {
    const notAFrame = () => makeDialStub(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])).libp2p;

    await expect(requestHeaders(notAFrame(), 3, 2, PEER, makeConfig())).rejects.toThrow();
    await expect(requestBlocks(notAFrame(), 1, 2, PEER, makeConfig())).rejects.toThrow();
  });

  it('returns empty for zero bytes — the one answer that is not a rejection', async () => {
    // The serve arm's "I cannot answer". Distinct from `vlqU(0)`, and the only
    // shape of no-answer these two accept, because it is the one the arm sends
    // deliberately rather than the one a broken peer produces.
    await expect(requestHeaders(makeDialStub(new Uint8Array(0)).libp2p, 3, 2, PEER, makeConfig()))
      .resolves.toEqual([]);
    await expect(requestBlocks(makeDialStub(new Uint8Array(0)).libp2p, 1, 2, PEER, makeConfig()))
      .resolves.toEqual([]);
  });
});
