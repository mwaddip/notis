import { encodeFrame } from './frame.js';
import type { SyncInfo, ModifierRequest, ModifierResponse } from './sync-types.js';
import {
  MSG_SYNC_INFO, MSG_MODIFIER_REQUEST, MSG_MODIFIER_RESPONSE,
  MSG_GET_PEERS, MSG_PEERS,
  MSG_GET_HEADERS, MSG_HEADERS, MSG_GET_BLOCKS, MSG_BLOCKS,
} from './types.js';
import type {
  GetPeersMsg, PeersMsg, PeerEntryMsg,
  GetHeadersMsg, GetBlocksMsg,
} from './types.js';
import {
  ByteReader,
  ByteWriter,
  ReaderError,
  decodeHeader,
  decodeOrderingBlock,
  encodeHeader,
  encodeStruct,
  readHexN,
  readVlqU,
  writeArr,
  writeHexNOrThrow,
  writeLp,
  writeLpUtf8,
  writeVlqU,
} from '@dagsocial/types';
import type { BlockHeader, OrderingBlock, StructCodec } from '@dagsocial/types';
import { MAX_HEADER_BYTES, MAX_ORDERING_BLOCK_BYTES } from '@dagsocial/types';
import {
  isBoundedInt,
  isHeight,
  MAX_CAPABILITY_CODE,
  MAX_CHAIN_RESPONSE_ITEMS,
  MAX_LOCATOR_HASHES,
  MAX_PEERS_ENTRIES,
  MAX_NAME_BYTES,
  MAX_ADDRESS_BYTES,
} from './msg-guards.js';
// NET_INTERFACE → ModifierRequest, NET_INTERFACE → ModifierResponse —
// the two codecs live in a browser-safe module and this file re-exports
// them beside its own frame wrappers.
export { modifierRequestCodec, modifierResponseCodec } from './modifier-codec.js';
import { modifierRequestCodec, modifierResponseCodec } from './modifier-codec.js';

// The byte-capped lpUtf8 and count-checked capability readers live in
// `./codec-helpers.js` (browser-safe) and are re-exported here so the
// stream codecs continue to pick them up at the one import site. The
// error-to-null decode wrapper `tryDecodeStruct` lives beside them.
export { readBoundedLpUtf8, readBoundedCapabilities } from './codec-helpers.js';
import {
  readBoundedLpUtf8,
  readBoundedCapabilities,
  tryDecodeStruct,
} from './codec-helpers.js';

// ---------------------------------------------------------------------------
// SyncInfo (2) — NET_INTERFACE → SyncInfo (code 2)
//
// vlqU(tipHeight) ‖ hexN(tipHash, 32)
// ---------------------------------------------------------------------------

export const syncInfoCodec: StructCodec<SyncInfo> = {
  name: 'syncInfo',
  write(w, msg) {
    writeVlqU(w, msg.tipHeight);
    writeHexNOrThrow(w, msg.tipHash, 32);
  },
  read(r) {
    const tipHeight = readVlqU(r);
    if (!isHeight(tipHeight)) {
      throw new ReaderError(`syncInfo: tipHeight ${tipHeight} out of domain`, 'out-of-domain');
    }
    const tipHash = readHexN(r, 32);
    return { tipHeight, tipHash };
  },
};

export function encodeSyncInfo(magic: number, info: SyncInfo): Uint8Array {
  return encodeFrame(magic, MSG_SYNC_INFO, encodeStruct(syncInfoCodec, info));
}

export function decodeSyncInfo(body: Uint8Array): SyncInfo | null {
  return tryDecodeStruct(syncInfoCodec, body);
}

// ---------------------------------------------------------------------------
// ModifierRequest (4) / ModifierResponse (5) — NET_INTERFACE → ModifierRequest,
// NET_INTERFACE → ModifierResponse.
//
// The two struct codecs live in `./modifier-codec.js` (browser-safe) and the
// frame wrappers below glue them to the Node frame codec.
// ---------------------------------------------------------------------------

export function encodeModifierRequest(magic: number, req: ModifierRequest): Uint8Array {
  return encodeFrame(magic, MSG_MODIFIER_REQUEST, encodeStruct(modifierRequestCodec, req));
}

export function decodeModifierRequest(body: Uint8Array): ModifierRequest | null {
  return tryDecodeStruct(modifierRequestCodec, body);
}

export function encodeModifierResponse(magic: number, resp: ModifierResponse): Uint8Array {
  return encodeFrame(magic, MSG_MODIFIER_RESPONSE, encodeStruct(modifierResponseCodec, resp));
}

export function decodeModifierResponse(body: Uint8Array): ModifierResponse | null {
  return tryDecodeStruct(modifierResponseCodec, body);
}

// ---------------------------------------------------------------------------
// GetPeers (8) — NET_INTERFACE → GetPeers
//
// Zero-byte body. Evolution is a version bump, not an extension of this body.
// ---------------------------------------------------------------------------

export function encodeGetPeers(magic: number): Uint8Array {
  return encodeFrame(magic, MSG_GET_PEERS, new Uint8Array(0));
}

export function decodeGetPeers(body: Uint8Array): GetPeersMsg | null {
  return body.length === 0 ? {} : null;
}

// ---------------------------------------------------------------------------
// Peers (9) — NET_INTERFACE → Peers
//
// arr( lpUtf8(address) ‖ lpUtf8(agentName) ‖ lpUtf8(nodeName)
//      ‖ vlqU(protocolVersion) ‖ arr(vlqU(capability)) )
//
// 0–MAX_PEERS_ENTRIES peers; empty is legal (NET_INTERFACE → Peers).
// ---------------------------------------------------------------------------

export const peersCodec: StructCodec<PeersMsg> = {
  name: 'peers',
  write(w, msg) {
    writeArr(w, msg.peers, (pw, p) => {
      writeLpUtf8(pw, p.address);
      writeLpUtf8(pw, p.agentName);
      writeLpUtf8(pw, p.nodeName);
      writeVlqU(pw, p.protocolVersion);
      writeArr(pw, p.capabilities, (cw, c) => writeVlqU(cw, c));
    });
  },
  read(r) {
    const count = readVlqU(r);
    if (count > MAX_PEERS_ENTRIES) {
      throw new ReaderError(
        `peers: ${count} entries exceeds ${MAX_PEERS_ENTRIES}`,
        'array-too-large',
      );
    }
    const peers: PeerEntryMsg[] = [];
    for (let i = 0; i < count; i++) {
      const address = readBoundedLpUtf8(r, MAX_ADDRESS_BYTES, 'peers.address');
      const agentName = readBoundedLpUtf8(r, MAX_NAME_BYTES, 'peers.agentName');
      if (agentName.length === 0) {
        throw new ReaderError('peers: empty agentName', 'out-of-domain');
      }
      const nodeName = readBoundedLpUtf8(r, MAX_NAME_BYTES, 'peers.nodeName');
      const protocolVersion = readVlqU(r);
      if (!isBoundedInt(protocolVersion, MAX_CAPABILITY_CODE)) {
        throw new ReaderError(`peers: protocolVersion ${protocolVersion} out of domain`, 'out-of-domain');
      }
      const capabilities = readBoundedCapabilities(r, 'peers');
      peers.push({ address, agentName, nodeName, protocolVersion, capabilities });
    }
    return { peers };
  },
};

export function encodePeers(magic: number, msg: PeersMsg): Uint8Array {
  return encodeFrame(magic, MSG_PEERS, encodeStruct(peersCodec, msg));
}

export function decodePeers(body: Uint8Array): PeersMsg | null {
  return tryDecodeStruct(peersCodec, body);
}

// ---------------------------------------------------------------------------
// GetHeaders (14) / GetBlocks (16) requests — positional
//
// `arr( hexN(hash, 32) )` for both, with the frame's code the discriminator:
// 14 carries the locator (1–`MAX_LOCATOR_HASHES`), 16 the ids (1–
// `MAX_CHAIN_RESPONSE_ITEMS`); the count is read and refused before the first
// element, and an empty list is malformed (NET_INTERFACE →
// `GetHeaders` / `GetBlocks` responses).
//
// `decodeStruct` supplies the rest of the boundary check — exhaustion and the
// re-encode compare, which is what refuses a non-minimal VLQ (TYPES_INTERFACE →
// The boundary check).
// ---------------------------------------------------------------------------

/** A nonEmpty hash list, bounded by `maxCount` and refused before the first element. */
function hashListRequestCodec<T>(
  name: string,
  field: keyof T & string,
  maxCount: number,
): StructCodec<T> {
  return {
    name,
    write(w, value) {
      const list = value[field] as unknown as string[];
      writeVlqU(w, list.length);
      for (const h of list) writeHexNOrThrow(w, h, 32);
    },
    read(r) {
      const count = readVlqU(r);
      if (count < 1) {
        throw new ReaderError(`${name}: empty hash list`, 'out-of-domain');
      }
      if (count > maxCount) {
        throw new ReaderError(
          `${name}: ${count} entries exceeds ${maxCount}`,
          'array-too-large',
        );
      }
      const list: string[] = [];
      for (let i = 0; i < count; i++) list.push(readHexN(r, 32));
      return { [field]: list } as T;
    },
  };
}

export const getHeadersCodec = hashListRequestCodec<GetHeadersMsg>(
  'getHeaders',
  'locator',
  MAX_LOCATOR_HASHES,
);

export const getBlocksCodec = hashListRequestCodec<GetBlocksMsg>(
  'getBlocks',
  'ids',
  MAX_CHAIN_RESPONSE_ITEMS,
);

export function encodeGetHeaders(magic: number, msg: GetHeadersMsg): Uint8Array {
  return encodeFrame(magic, MSG_GET_HEADERS, encodeStruct(getHeadersCodec, msg));
}

export function decodeGetHeaders(body: Uint8Array): GetHeadersMsg | null {
  return tryDecodeStruct(getHeadersCodec, body);
}

export function encodeGetBlocks(magic: number, msg: GetBlocksMsg): Uint8Array {
  return encodeFrame(magic, MSG_GET_BLOCKS, encodeStruct(getBlocksCodec, msg));
}

export function decodeGetBlocks(body: Uint8Array): GetBlocksMsg | null {
  return tryDecodeStruct(getBlocksCodec, body);
}

// ---------------------------------------------------------------------------
// Headers (15) / Blocks (17) responses
//
// Both responses are `arr(item, lp)` over the same positional codec the rest of
// this package speaks. Each item runs the four-part boundary check
// (TYPES_INTERFACE → The boundary check) on its own byte span, through
// `decodeHeader` / `decodeOrderingBlock`; the response's own level checks its
// count, each length prefix and its end, and re-encodes nothing
// (NET_INTERFACE → `GetHeaders` / `GetBlocks` responses).
//
// Why a positional codec and not a shape check over `cbor-x`: a `decode(raw) as
// T` cast is not a check, and the gap it leaves is measured rather than
// theorised — without this codec this path is the sole delivery route for a
// remote fail-stop. The two sentinel bytes a total writer emits for an
// out-of-domain field — `enum8`'s `0xff` for a `boxType` outside its table,
// `writeLp`'s sentinel *length* for a non-byte-view `utxoTxs` element — are
// refused by our own decoder, so gossip drops both at decode. Handed to the
// node undecoded they survive apply instead (`utxoTxRoot` honestly commits the
// malformed leaf, and the validator signature covers only the header), and the
// store writes a row our own reader then refuses:
// `UnreadableStoredBlockError` → `failStopIfCorruptChain` → `process.exit(1)`,
// re-triggered by the next arriving gossip block and persistent across
// restarts. `utxoTxRoot` commits every transaction's id and every
// transaction's bytes (TYPES_INTERFACE → Ordering block). Under a positional
// codec those sentinels are unrepresentable at this boundary rather than
// merely unlikely to be sent, which is what keeps the door shut for the
// *next* unpinned field.
//
// ⚠ Both sides of this framing live in this package and must move in one commit
// (rule 13): a producer on one framing with a consumer on the other is a sync
// path that silently returns nothing.
// ---------------------------------------------------------------------------

/**
 * `arr(items, lp)` write side — `vlqU(count) ‖ (vlqU(len) ‖ itemBytes)…`. The
 * response's read side is `decodeLpItemsResponse` below (NET_INTERFACE →
 * `GetHeaders` / `GetBlocks` responses).
 */
function writeLpItems<T>(
  w: ByteWriter,
  items: T[],
  encodeItem: (item: T) => Uint8Array,
): void {
  writeArr(w, items, (itemWriter, item) => writeLp(itemWriter, encodeItem(item)));
}

/**
 * The response's own level checks its count, each length prefix and its end,
 * and re-encodes nothing (NET_INTERFACE → `GetHeaders` / `GetBlocks`
 * responses). The count's `vlqU` and each item's `vlqU` length prefix are the
 * two prefixes the response adds around the items, and this reader refuses a
 * non-minimal one — the width `writeVlqU` writes for the same value compared
 * with the bytes `readVlqU` consumed. Each item's canonicity is its own
 * decoder's — `decodeHeader`, `decodeOrderingBlock` — run over the item's own
 * byte span, exhaustion and re-encode compare included
 * (TYPES_INTERFACE → The boundary check).
 *
 * `maxItems` is the caller's own request size clamped to
 * `MAX_CHAIN_RESPONSE_ITEMS` (`responseCap`) — a peer answering a 40-header
 * request with 18,900 headers is not answering the question. The count is
 * refused before the first element is read.
 *
 * Each item length is refused against `maxItemBytes` before the item's bytes
 * are consumed (NET_INTERFACE → Validation (and untrusted-input safety) →
 * "A peer's bytes are weighed before they are decoded").
 */
function decodeLpItemsResponse<T>(
  body: Uint8Array,
  decodeItem: (bytes: Uint8Array) => T,
  maxItems: number,
  maxItemBytes: number,
): T[] | null {
  try {
    const r = new ByteReader(body);
    const countStart = r.position;
    const count = readVlqU(r);
    if (r.position - countStart !== minimalVlqULength(count)) return null;
    if (count > maxItems) return null;
    const items: T[] = [];
    for (let i = 0; i < count; i++) {
      const lenStart = r.position;
      const itemLen = readVlqU(r);
      if (r.position - lenStart !== minimalVlqULength(itemLen)) return null;
      if (itemLen > maxItemBytes) return null;
      const span = r.readBytes(itemLen);
      items.push(decodeItem(new Uint8Array(span)));
    }
    if (!r.isExhausted) return null;
    return items;
  } catch {
    return null;
  }
}

/**
 * The byte width `writeVlqU` writes for `value` — a `vlqU` the reader
 * consumed is minimal exactly when the bytes it consumed match this width.
 * `types` keeps `vlqUByteLength` out of its barrel, so this helper takes the
 * answer from the writer that produces the canonical bytes.
 */
function minimalVlqULength(value: number): number {
  const w = new ByteWriter();
  writeVlqU(w, value);
  return w.toBytes().length;
}

/** The write side alone — `headersResponseCodec` as `encodeHeaders` uses it. */
function writeHeadersResponse(w: ByteWriter, headers: BlockHeader[]): void {
  writeLpItems(w, headers, encodeHeader);
}

/**
 * The write side alone — `encodedBlocksResponseCodec` as `encodeBlocks` uses
 * it. An already-encoded item is its own encoding on the wire.
 */
function writeEncodedBlocksResponse(w: ByteWriter, blocks: Uint8Array[]): void {
  writeLpItems(w, blocks, (bytes) => bytes);
}

/**
 * Frame a `Blocks` (17) response from blocks the serve loop has already encoded.
 *
 * It takes bytes because `serveBlocksResponse` must weigh each block against
 * `MAX_SERVE_BODY_BYTES` as it assembles the response, and a block's weight is
 * its encoding — so encoding here as well would spend that work twice over a
 * body of up to `MAX_SERVE_BODY_BYTES` (NET_INTERFACE → `GetHeaders` /
 * `GetBlocks` responses). The serve loop owns the encode and the throw a corrupt
 * local row produces; this function frames what it is given.
 */
export function encodeBlocks(magic: number, blocks: Uint8Array[]): Uint8Array {
  const w = new ByteWriter();
  writeEncodedBlocksResponse(w, blocks);
  return encodeFrame(magic, MSG_BLOCKS, w.toBytes());
}

/**
 * Parse a `Blocks` response body. `null` for anything that is not a
 * well-formed, canonical response of at most `maxBlocks` blocks.
 *
 * `maxBlocks` is the caller's own request size — the peer is answering a
 * question only the caller knows.
 */
export function decodeBlocks(
  body: Uint8Array,
  maxBlocks: number,
): OrderingBlock[] | null {
  return decodeLpItemsResponse(
    body,
    decodeOrderingBlock,
    responseCap(maxBlocks),
    MAX_ORDERING_BLOCK_BYTES,
  );
}

/** Frame a `Headers` (15) response. See `encodeBlocks`. */
export function encodeHeaders(magic: number, headers: BlockHeader[]): Uint8Array {
  const w = new ByteWriter();
  writeHeadersResponse(w, headers);
  return encodeFrame(magic, MSG_HEADERS, w.toBytes());
}

/** Parse a `Headers` response body. Cap: `MAX_CHAIN_RESPONSE_ITEMS` (400),
 *  the one shape and bound a `Headers` page has (NET_INTERFACE →
 *  `GetHeaders` / `GetBlocks` responses). */
export function decodeHeaders(body: Uint8Array): BlockHeader[] | null {
  return decodeLpItemsResponse(
    body,
    decodeHeader,
    MAX_CHAIN_RESPONSE_ITEMS,
    MAX_HEADER_BYTES,
  );
}

/**
 * How many items a response to a request of this size may carry.
 *
 * Clamped to `MAX_CHAIN_RESPONSE_ITEMS` because the requested size is the
 * number of ids the caller asked for, and a caller's count is not by itself
 * a bound (NET_INTERFACE → `GetHeaders` / `GetBlocks` responses). A
 * nonsensical requested size accepts an empty response and nothing else,
 * rather than falling back to a permissive default.
 */
function responseCap(requested: number): number {
  if (!Number.isSafeInteger(requested) || requested < 0) return 0;
  return Math.min(requested, MAX_CHAIN_RESPONSE_ITEMS);
}
