import { encodeFrame } from './frame.js';
import type { SyncInfo, Inv, ModifierRequest, ModifierResponse } from './sync-types.js';
import {
  MSG_SYNC_INFO, MSG_INV, MSG_MODIFIER_REQUEST, MSG_MODIFIER_RESPONSE,
  MSG_GET_PEERS, MSG_PEERS,
  MSG_GET_HEADERS, MSG_HEADERS, MSG_GET_BLOCKS, MSG_BLOCKS,
} from './types.js';
import type {
  GetPeersMsg, PeersMsg, PeerEntryMsg,
  GetHeadersMsg, GetBlocksMsg,
} from './types.js';
import {
  ReaderError,
  decodeHeader,
  decodeOrderingBlock,
  decodeStruct,
  encodeHeader,
  encodeOrderingBlock,
  encodeStruct,
  readHexN,
  readLp,
  readU8,
  readVlqU,
  writeArr,
  writeHexNOrThrow,
  writeLp,
  writeLpUtf8,
  writeU8OrThrow,
  writeVlqU,
} from '@dagsocial/types';
import type { ByteReader, BlockHeader, OrderingBlock, StructCodec } from '@dagsocial/types';
import {
  isBoundedInt,
  isHeight,
  MAX_CAPABILITY_CODE,
  MAX_CHAIN_RESPONSE_ITEMS,
  MAX_PEERS_ENTRIES,
  MAX_INV_IDS,
  MAX_SYNC_ANCHORS,
  MAX_NAME_BYTES,
  MAX_ADDRESS_BYTES,
  MAX_CAPABILITY_ENTRIES,
} from './msg-guards.js';

// ---------------------------------------------------------------------------
// Shared read helpers — byte-capped lpUtf8 and count-checked arrays
// ---------------------------------------------------------------------------

export function readBoundedLpUtf8(r: ByteReader, maxBytes: number, name: string): string {
  const len = readVlqU(r);
  if (len > maxBytes) {
    throw new ReaderError(`${name}: ${len} bytes exceeds ${maxBytes}`, 'out-of-domain');
  }
  const bytes = r.readBytes(len);
  let str: string;
  try {
    str = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ReaderError(`${name}: invalid UTF-8`, 'out-of-domain');
  }
  return str;
}

export function readBoundedCapabilities(r: ByteReader, name: string): number[] {
  const count = readVlqU(r);
  if (count > MAX_CAPABILITY_ENTRIES) {
    throw new ReaderError(`${name}: ${count} capabilities exceeds ${MAX_CAPABILITY_ENTRIES}`, 'array-too-large');
  }
  const caps: number[] = [];
  for (let i = 0; i < count; i++) {
    const c = readVlqU(r);
    if (!isBoundedInt(c, MAX_CAPABILITY_CODE)) {
      throw new ReaderError(`${name}: capability ${c} out of domain`, 'out-of-domain');
    }
    caps.push(c);
  }
  return caps;
}

// ---------------------------------------------------------------------------
// SyncInfo (2) — NET_INTERFACE → SyncInfo
//
// vlqU(tipHeight) ‖ hexN(tipBlockId, 32) ‖ arr( vlqU(height) ‖ hexN(blockId, 32) )
// ---------------------------------------------------------------------------

export const syncInfoCodec: StructCodec<SyncInfo> = {
  name: 'syncInfo',
  write(w, msg) {
    writeVlqU(w, msg.tipHeight);
    writeHexNOrThrow(w, msg.tipBlockId, 32);
    writeArr(w, msg.anchors, (aw, a) => {
      writeVlqU(aw, a.height);
      writeHexNOrThrow(aw, a.blockId, 32);
    });
  },
  read(r) {
    const tipHeight = readVlqU(r);
    if (!isHeight(tipHeight)) {
      throw new ReaderError(`syncInfo: tipHeight ${tipHeight} out of domain`, 'out-of-domain');
    }
    const tipBlockId = readHexN(r, 32);
    const anchorCount = readVlqU(r);
    if (anchorCount > MAX_SYNC_ANCHORS) {
      throw new ReaderError(
        `syncInfo: ${anchorCount} anchors exceeds ${MAX_SYNC_ANCHORS}`,
        'array-too-large',
      );
    }
    const anchors: { height: number; blockId: string }[] = [];
    for (let i = 0; i < anchorCount; i++) {
      const height = readVlqU(r);
      if (!isHeight(height)) {
        throw new ReaderError(`syncInfo: anchor height ${height} out of domain`, 'out-of-domain');
      }
      anchors.push({ height, blockId: readHexN(r, 32) });
    }
    return { tipHeight, tipBlockId, anchors };
  },
};

export function encodeSyncInfo(magic: number, info: SyncInfo): Uint8Array {
  return encodeFrame(magic, MSG_SYNC_INFO, encodeStruct(syncInfoCodec, info));
}

export function decodeSyncInfo(body: Uint8Array): SyncInfo | null {
  return tryDecodeStruct(syncInfoCodec, body);
}

// ---------------------------------------------------------------------------
// Inv (3) / ModifierRequest (4) — NET_INTERFACE → Inv / ModifierRequest
//
// u8(typeId) ‖ arr( hexN(id, 32) )
//
// typeId is u8 — the byte is the domain; unknown values decode and are dropped
// by the handler (the sync machine's typeId filter; node.ts filters
// ModifierRequest by typeId before dispatch). 1–MAX_INV_IDS ids; empty is
// malformed (nonEmpty — no honest sender announces or requests nothing).
// ---------------------------------------------------------------------------

function idListCodec(name: string): StructCodec<{ typeId: number; ids: string[] }> {
  return {
    name,
    write(w, msg) {
      writeU8OrThrow(w, msg.typeId);
      writeArr(w, msg.ids, (iw, id) => writeHexNOrThrow(iw, id, 32));
    },
    read(r) {
      const typeId = readU8(r);
      const count = readVlqU(r);
      if (count < 1) {
        throw new ReaderError(`${name}: empty id list`, 'out-of-domain');
      }
      if (count > MAX_INV_IDS) {
        throw new ReaderError(
          `${name}: ${count} ids exceeds ${MAX_INV_IDS}`,
          'array-too-large',
        );
      }
      const ids: string[] = [];
      for (let i = 0; i < count; i++) ids.push(readHexN(r, 32));
      return { typeId, ids };
    },
  };
}

export const invCodec = idListCodec('inv');
export const modifierRequestCodec = idListCodec('modifierRequest');

export function encodeInv(magic: number, inv: Inv): Uint8Array {
  return encodeFrame(magic, MSG_INV, encodeStruct(invCodec, inv));
}

export function decodeInv(body: Uint8Array): Inv | null {
  return tryDecodeStruct(invCodec, body);
}

export function encodeModifierRequest(magic: number, req: ModifierRequest): Uint8Array {
  return encodeFrame(magic, MSG_MODIFIER_REQUEST, encodeStruct(modifierRequestCodec, req));
}

export function decodeModifierRequest(body: Uint8Array): ModifierRequest | null {
  return tryDecodeStruct(modifierRequestCodec, body);
}

// ---------------------------------------------------------------------------
// ModifierResponse (5) — NET_INTERFACE → ModifierResponse
//
// u8(typeId) ‖ arr( hexN(id, 32) ‖ lp(data) )
//
// 1–MAX_INV_IDS modifiers; empty is malformed — a peer with none of the
// requested modifiers answers zero bytes, never an empty list.
// ---------------------------------------------------------------------------

export const modifierResponseCodec: StructCodec<ModifierResponse> = {
  name: 'modifierResponse',
  write(w, msg) {
    writeU8OrThrow(w, msg.typeId);
    writeArr(w, msg.modifiers, (mw, m) => {
      writeHexNOrThrow(mw, m.id, 32);
      writeLp(mw, m.data);
    });
  },
  read(r) {
    const typeId = readU8(r);
    const count = readVlqU(r);
    if (count < 1) {
      throw new ReaderError('modifierResponse: empty modifier list', 'out-of-domain');
    }
    if (count > MAX_INV_IDS) {
      throw new ReaderError(
        `modifierResponse: ${count} modifiers exceeds ${MAX_INV_IDS}`,
        'array-too-large',
      );
    }
    const modifiers: { id: string; data: Uint8Array }[] = [];
    for (let i = 0; i < count; i++) {
      modifiers.push({ id: readHexN(r, 32), data: readLp(r) });
    }
    return { typeId, modifiers };
  },
};

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
// Two `vlqU` fields each, in declared order, with no discriminator inside the
// body: the frame's code is what says which query this is (NET_INTERFACE →
// `GetHeaders` / `GetBlocks` responses). Both fields of both requests drive a
// serve loop that reads the store once per height, so both are bounded here
// exactly like an advertised chain height.
//
// `decodeStruct` supplies the rest of the boundary check — exhaustion and the
// re-encode compare, which is what refuses a non-minimal VLQ (TYPES_INTERFACE →
// The boundary check).
// ---------------------------------------------------------------------------

/** A two-field positional request whose fields are both heights. */
function heightPairCodec<T>(
  name: string,
  fields: [keyof T & string, keyof T & string],
): StructCodec<T> {
  const [first, second] = fields;
  return {
    name,
    write(w, value) {
      writeVlqU(w, value[first] as number);
      writeVlqU(w, value[second] as number);
    },
    read(r) {
      const a = readVlqU(r);
      const b = readVlqU(r);
      if (!isHeight(a) || !isHeight(b)) {
        // Well-formed VLQ heights outside the advertisable range —
        // WIRE_INTERFACE → ReaderError codes, `out-of-domain`; the bound
        // and its ban policy: NET_INTERFACE → Validation (and untrusted-input safety).
        throw new ReaderError(
          `${name}: ${a}/${b} is outside the advertisable height range`,
          'out-of-domain',
        );
      }
      return { [first]: a, [second]: b } as T;
    },
  };
}

export const getHeadersCodec = heightPairCodec<GetHeadersMsg>('getHeaders', [
  'startHeight',
  'maxCount',
]);

export const getBlocksCodec = heightPairCodec<GetBlocksMsg>('getBlocks', [
  'startHeight',
  'endHeight',
]);

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
// this package speaks, and every element runs the four-part boundary check
// (TYPES_INTERFACE → The boundary check) on its own byte span.
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
// restarts. The `utxoTxs` half costs no PoW at all — `utxoTxRoot` never commits
// `utxoTxs`, so a *relaying* node can swap an honest block's payload. Under a
// positional codec those sentinels are unrepresentable at this boundary rather
// than merely unlikely to be sent, which is what keeps the door shut for the
// *next* unpinned field.
//
// ⚠ Both sides of this framing live in this package and must move in one commit
// (rule 13): a producer on one framing with a consumer on the other is a sync
// path that silently returns nothing.
// ---------------------------------------------------------------------------

/**
 * `arr(items, lp)` — `vlqU(count) ‖ (vlqU(len) ‖ itemBytes)…`.
 *
 * The `lp` per element is not decoration. It gives each item its own byte span,
 * so `decodeItem` can run the whole boundary check over exactly that span —
 * exhaustion and the re-encode compare included — and a malformed block is
 * rejected at its own offset instead of as an outer mismatch somewhere in a
 * multi-kilobyte blob. It is the same nesting `ORDERING_BLOCK` uses for its own
 * three sections.
 *
 * `maxItems` is checked **before the first element is read**, and that is what
 * `readArr` cannot express here: its bounds are `MAX_ARRAY_LENGTH` and the bytes
 * remaining, neither of which is the number of items *this* response may carry.
 * That number is the caller's own request size clamped to
 * `MAX_CHAIN_RESPONSE_ITEMS` (`responseCap`) — a peer answering a 40-header
 * request with 18,900 headers is not answering the question, and the caller is
 * the only party that knows the question. The byte layout is identical to
 * `arr`'s, so the re-encode compare below still uses `writeArr`.
 */
function lpItemsCodec<T>(
  name: string,
  encodeItem: (item: T) => Uint8Array,
  decodeItem: (bytes: Uint8Array) => T,
  maxItems: number,
): StructCodec<T[]> {
  return {
    name,
    write(w, items) {
      writeArr(w, items, (itemWriter, item) => writeLp(itemWriter, encodeItem(item)));
    },
    read(r) {
      const count = readVlqU(r);
      if (count > maxItems) {
        throw new ReaderError(
          `${name}: response declares ${count} items, at most ${maxItems} accepted`,
          'array-too-large',
        );
      }
      const items: T[] = [];
      for (let i = 0; i < count; i++) items.push(decodeItem(readLp(r)));
      return items;
    },
  };
}

/**
 * Decode a positional body, converting every `ReaderError` into `null`.
 *
 * TYPES_INTERFACE → The boundary check, step 4 — "callers convert `ReaderError`
 * into a verdict" — discharged in the shape the rest of this file uses:
 * decoders at net's boundary never throw, they return `null`, and the caller
 * decides what a `null` means for the peer that sent it.
 */
function tryDecodeStruct<T>(codec: StructCodec<T>, bytes: Uint8Array): T | null {
  try {
    return decodeStruct(codec, bytes);
  } catch {
    return null;
  }
}

function blocksResponseCodec(maxBlocks: number): StructCodec<OrderingBlock[]> {
  return lpItemsCodec('blocksResponse', encodeOrderingBlock, decodeOrderingBlock, maxBlocks);
}

function headersResponseCodec(maxHeaders: number): StructCodec<BlockHeader[]> {
  return lpItemsCodec('headersResponse', encodeHeader, decodeHeader, maxHeaders);
}

/** An already-encoded item is its own encoding: `lpItemsCodec`'s identity pairing. */
const identityBytes = (bytes: Uint8Array): Uint8Array => bytes;

/**
 * `blocksResponseCodec`'s wire form over items the caller has already encoded.
 *
 * The same `lpItemsCodec` with the per-item encode spent, so it writes the byte
 * sequence `blocksResponseCodec` writes and `decodeBlocks` reads — `arr(blocks,
 * lp)`, one length-prefixed span per block. Identity is a codec here rather than
 * a write-only special case: `arr(bytes, lp)` reads back as the same
 * `Uint8Array[]` it wrote.
 */
function encodedBlocksResponseCodec(maxBlocks: number): StructCodec<Uint8Array[]> {
  return lpItemsCodec('blocksResponse', identityBytes, identityBytes, maxBlocks);
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
  return encodeFrame(
    magic,
    MSG_BLOCKS,
    encodeStruct(encodedBlocksResponseCodec(MAX_CHAIN_RESPONSE_ITEMS), blocks),
  );
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
  return tryDecodeStruct(blocksResponseCodec(responseCap(maxBlocks)), body);
}

/** Frame a `Headers` (15) response. See `encodeBlocks`. */
export function encodeHeaders(magic: number, headers: BlockHeader[]): Uint8Array {
  return encodeFrame(
    magic,
    MSG_HEADERS,
    encodeStruct(headersResponseCodec(MAX_CHAIN_RESPONSE_ITEMS), headers),
  );
}

/** Parse a `Headers` response body. See `decodeBlocks`. */
export function decodeHeaders(
  body: Uint8Array,
  maxHeaders: number,
): BlockHeader[] | null {
  return tryDecodeStruct(headersResponseCodec(responseCap(maxHeaders)), body);
}

/**
 * How many items a response to a request of this size may carry.
 *
 * Clamped to `MAX_CHAIN_RESPONSE_ITEMS` because the requested size is derived
 * from peer-supplied heights (`requestBlocks` spans `forkHeight + 1` to a tip
 * height that came off the wire), so it is not by itself a bound. A nonsensical
 * request size accepts an empty response and nothing else, rather than
 * falling back to a permissive default.
 */
function responseCap(requested: number): number {
  if (!Number.isSafeInteger(requested) || requested < 0) return 0;
  return Math.min(requested, MAX_CHAIN_RESPONSE_ITEMS);
}
