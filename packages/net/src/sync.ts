import { decodeSubBlock } from '@dagsocial/types';
import type { SubBlock, BlockHeader, OrderingBlock } from '@dagsocial/types';
import { encode } from 'cbor-x';
import type { Libp2p } from 'libp2p';
import type { Stream } from '@libp2p/interface';
import type { NetConfig } from './types.js';
import { readStreamBounded } from './util.js';
import { decodeLegacyBlocksResponse, decodeLegacyHeadersResponse } from './sync-codec.js';
import { MAX_STREAM_BYTES } from './msg-guards.js';

export const SYNC_PROTOCOL = '/dagsocial/sync/1';
export const HEADERS_PROTOCOL = '/dagsocial/headers/1';

// ---------------------------------------------------------------------------
// Sub-block requests (legacy text-based protocol — kept for backward compat)
// ---------------------------------------------------------------------------

/**
 * Request a specific sub-block from a peer via a direct stream.
 *
 * Protocol:
 *   Request:  subBlockId as hex string (64 chars)
 *   Response: CBOR-encoded SubBlock, or single byte 0x00 (not found)
 *
 * Throws on timeout, not-found, or decode failure.
 */
export async function requestSubBlock(
  libp2p: Libp2p,
  subBlockId: string,
  peerId: string,
  config: NetConfig,
): Promise<SubBlock> {
  const peer = libp2p.getPeers().find((p) => p.toString() === peerId);
  if (!peer) {
    throw new Error(`Peer ${peerId} not connected`);
  }

  let stream: Stream | undefined;
  try {
    stream = await libp2p.dialProtocol(peer, SYNC_PROTOCOL, {
      signal: AbortSignal.timeout(config.syncRequestTimeoutMs),
    });

    // Send request
    const encoder = new TextEncoder();
    await stream.sink([encoder.encode(subBlockId)]);

    // Read response
    const response = await readStreamBounded(stream.source);
    if (response === null) {
      throw new Error(`Sub-block response from peer ${peerId} exceeds ${MAX_STREAM_BYTES} bytes`);
    }

    if (response.length === 0) {
      throw new Error('Empty response from peer');
    }

    // Check for not-found marker
    if (response.length === 1 && response[0] === 0x00) {
      throw new Error(`Sub-block ${subBlockId} not found on peer ${peerId}`);
    }

    return decodeSubBlock(response);
  } finally {
    if (stream) {
      await stream.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Header/block requests (legacy /dagsocial/headers/1 protocol)
//
// The **request** is still raw CBOR — a `{ startHeight, maxCount, endHeight,
// mode }` control message with no consensus bytes in it, shape-checked at the
// far end by `decodeLegacyHeadersRequest`. The **responses** carry whole blocks
// and headers and are positional: see `sync-codec.ts` →
// "Legacy /dagsocial/headers/1 responses" for what that closed and why a shape
// check on the cbor path would have been the wrong fix.
//
// An unparseable response **throws** rather than resolving to `[]`. The two are
// not interchangeable here: `index.ts`'s fork resolution feeds `requestBlocks`'
// result straight to `reorg(forkHeight, newBlocks)`, so an empty array would
// roll our chain back to the fork point and apply nothing — a peer sending
// junk would truncate our chain instead of failing to extend it. The throw
// lands in that function's existing catch and abandons the reorg.
// ---------------------------------------------------------------------------

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
  const peer = libp2p.getPeers().find(p => p.toString() === peerId);
  if (!peer) throw new Error(`Peer ${peerId} not connected`);

  let stream: Stream | undefined;
  try {
    stream = await libp2p.dialProtocol(peer, HEADERS_PROTOCOL, {
      signal: AbortSignal.timeout(config.syncRequestTimeoutMs),
    });

    const request = { startHeight, maxCount };
    await stream.sink([Buffer.from(encode(request))] as any);

    const response = await readStreamBounded(stream.source);
    if (response === null) {
      throw new Error(`Headers response from peer ${peerId} exceeds ${MAX_STREAM_BYTES} bytes`);
    }

    // Zero bytes is the handler's "I cannot answer" signal (an over-cap
    // request, an undecodable one, or a local failure), and it is distinct from
    // an empty response — an empty header list encodes as `vlqU(0)`, one byte.
    if (response.length === 0) return [];

    const headers = decodeLegacyHeadersResponse(response, maxCount);
    if (headers === null) {
      throw new Error(`Headers response from peer ${peerId} is not a well-formed headers response`);
    }
    return headers;
  } finally {
    if (stream) await stream.close();
  }
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
  const peer = libp2p.getPeers().find(p => p.toString() === peerId);
  if (!peer) throw new Error(`Peer ${peerId} not connected`);

  let stream: Stream | undefined;
  try {
    stream = await libp2p.dialProtocol(peer, HEADERS_PROTOCOL, {
      signal: AbortSignal.timeout(config.syncRequestTimeoutMs * 5), // blocks are bigger
    });

    const request = { startHeight, endHeight, mode: 'blocks' };
    await stream.sink([Buffer.from(encode(request))] as any);

    const raw = await readStreamBounded(stream.source);
    if (raw === null) {
      throw new Error(`Blocks response from peer ${peerId} exceeds ${MAX_STREAM_BYTES} bytes`);
    }

    // See `requestHeaders` — zero bytes is "no answer", `vlqU(0)` is "no blocks".
    if (raw.length === 0) return [];

    const blocks = decodeLegacyBlocksResponse(raw, endHeight - startHeight + 1);
    if (blocks === null) {
      throw new Error(`Blocks response from peer ${peerId} is not a well-formed blocks response`);
    }
    return blocks;
  } finally {
    if (stream) await stream.close();
  }
}
