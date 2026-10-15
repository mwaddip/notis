import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import type { Libp2p } from 'libp2p';
import type { PeerId } from '@libp2p/interface';
import type { NetConfig } from './types.js';
import { MSG_HEADERS, MSG_BLOCKS } from './types.js';
import { readStreamBounded, sinkWithDeadline } from './util.js';
import {
  decodeBlocks,
  decodeHeaders,
  encodeGetBlocks,
  encodeGetHeaders,
} from './sync-codec.js';
import { decodeFrame } from './frame.js';
import { MAX_STREAM_BYTES } from './msg-guards.js';

export const SYNC_PROTOCOL = '/dagsocial/sync/1';

// ---------------------------------------------------------------------------
// Fork resolution's two chain queries — GetHeaders (14) and GetBlocks (16)
//
// Both ride `SYNC_PROTOCOL` and both sides of the exchange are positional and
// framed: `vlqU(startHeight) vlqU(maxCount)` out, `arr(item, lp)` back. See
// `lpItemsCodec` in `sync-codec.ts` for what a positional response closes and
// why a shape check over `cbor-x` is the wrong instrument here.
//
// The response is identified by its own frame code rather than by the question
// we asked, so an answer bearing the wrong code is refused instead of decoded
// against the wrong codec.
//
// Both THROW on an unexpected frame code or a malformed body (NET_INTERFACE →
// Pull Requests). Fork resolution feeds `requestBlocks`' result straight to
// `reorg(forkHeight, newBlocks)`, so an empty array rolls our chain back to the
// fork point and applies nothing — a peer sending junk would truncate our chain
// instead of failing to extend it. The throw lands in that function's existing
// catch and abandons the reorg.
// ---------------------------------------------------------------------------

/**
 * The connected libp2p peer with this id. Throws if the id is not in
 * `libp2p.getPeers()`. The six request paths that reach a peer by id read
 * this one function rather than each lifting the same `find` call.
 */
export function connectedPeer(libp2p: Libp2p, peerId: string): PeerId {
  const peer = libp2p.getPeers().find((p) => p.toString() === peerId);
  if (!peer) throw new Error(`Peer ${peerId} not connected`);
  return peer;
}

/**
 * One round trip on any framed protocol: open under the deadline, write one
 * frame under the write deadline, read one bounded answer under the read
 * deadline, close with any rejection caught — the answer stands, and so
 * does an error that ended the read (NET_INTERFACE → Pull Requests →
 * "A request is one round trip, and closing its stream never changes its
 * answer").
 *
 * The caller frames the request and decodes the answer; this function owns
 * the dial, the write, the read and the close. `readMultiplier` is 1 for
 * every arm but the `Blocks` read, which the contract bounds at ×5.
 */
export async function oneRoundTrip(
  libp2p: Libp2p,
  peer: PeerId,
  protocol: string,
  request: Uint8Array,
  config: NetConfig,
  readMultiplier: number = 1,
): Promise<Uint8Array | null> {
  const deadlineMs = config.syncRequestTimeoutMs * readMultiplier;
  const stream = await libp2p.dialProtocol(peer, protocol, {
    signal: AbortSignal.timeout(deadlineMs),
  });
  try {
    await sinkWithDeadline(stream, request, deadlineMs);
    const data = await readStreamBounded(
      stream.source,
      MAX_STREAM_BYTES,
      AbortSignal.timeout(deadlineMs),
    );
    return data;
  } finally {
    // A rejecting close must not replace the answer this function read —
    // NET_INTERFACE → Pull Requests → "A request is one round trip, and closing its stream never changes its answer".
    await stream.close().catch(() => { /* already gone */ });
  }
}

/**
 * Request headers from a peer, starting at startHeight and going down.
 * Returns newest-first.
 */
export async function requestHeaders(
  libp2p: Libp2p,
  startHeight: number,
  maxCount: number,
  peerId: string,
  config: NetConfig,
): Promise<BlockHeader[]> {
  const peer = connectedPeer(libp2p, peerId);
  const magic = config.magic;

  const response = await oneRoundTrip(
    libp2p,
    peer,
    SYNC_PROTOCOL,
    encodeGetHeaders(magic, { startHeight, maxCount }),
    config,
  );
  if (response === null) {
    throw new Error(`Headers response from peer ${peerId} exceeds ${MAX_STREAM_BYTES} bytes`);
  }

  // Zero bytes is the serve arm's "I cannot answer" signal (no provider, an
  // undecodable request, or a local failure), and it is distinct from an empty
  // answer — an empty header list is a frame whose body is `vlqU(0)`.
  if (response.length === 0) return [];

  const frame = decodeFrame(magic, response);
  if (frame.code !== MSG_HEADERS) {
    throw new Error(`Headers response from peer ${peerId} bears code ${frame.code}`);
  }

  const headers = decodeHeaders(frame.body, maxCount);
  if (headers === null) {
    throw new Error(`Headers response from peer ${peerId} is not a well-formed headers response`);
  }
  return headers;
}

/**
 * Request full ordering blocks from startHeight to endHeight (inclusive).
 */
export async function requestBlocks(
  libp2p: Libp2p,
  startHeight: number,
  endHeight: number,
  peerId: string,
  config: NetConfig,
): Promise<OrderingBlock[]> {
  const peer = connectedPeer(libp2p, peerId);
  const magic = config.magic;

  const raw = await oneRoundTrip(
    libp2p,
    peer,
    SYNC_PROTOCOL,
    encodeGetBlocks(magic, { startHeight, endHeight }),
    config,
    5,
  );
  if (raw === null) {
    throw new Error(`Blocks response from peer ${peerId} exceeds ${MAX_STREAM_BYTES} bytes`);
  }

  // See `requestHeaders` — zero bytes is "no answer", `vlqU(0)` is "no blocks".
  if (raw.length === 0) return [];

  const frame = decodeFrame(magic, raw);
  if (frame.code !== MSG_BLOCKS) {
    throw new Error(`Blocks response from peer ${peerId} bears code ${frame.code}`);
  }

  const blocks = decodeBlocks(frame.body, endHeight - startHeight + 1);
  if (blocks === null) {
    throw new Error(`Blocks response from peer ${peerId} is not a well-formed blocks response`);
  }
  return blocks;
}
