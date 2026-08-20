import { encode, decode } from 'cbor-x';
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
  readLp,
  readVlqU,
  writeArr,
  writeLp,
  writeVlqU,
} from '@dagsocial/types';
import type { BlockHeader, OrderingBlock, StructCodec } from '@dagsocial/types';
import {
  isRecord,
  isBoundedInt,
  isBoundedIntArray,
  isHeight,
  isStringArray,
  isBytes,
  MAX_TYPE_ID,
  MAX_CAPABILITY_CODE,
  MAX_CHAIN_RESPONSE_ITEMS,
  MAX_PEERS_ENTRIES,
} from './msg-guards.js';

function frameMessage(magic: number, code: number, body: unknown): Uint8Array {
  return encodeFrame(magic, code, new Uint8Array(encode(body)));
}

export function encodeSyncInfo(magic: number, info: SyncInfo): Uint8Array {
  return frameMessage(magic, MSG_SYNC_INFO, info);
}

export function encodeInv(magic: number, inv: Inv): Uint8Array {
  return frameMessage(magic, MSG_INV, inv);
}

export function encodeModifierRequest(magic: number, req: ModifierRequest): Uint8Array {
  return frameMessage(magic, MSG_MODIFIER_REQUEST, req);
}

export function encodeModifierResponse(magic: number, resp: ModifierResponse): Uint8Array {
  // CBOR encodes Uint8Array as binary
  return frameMessage(magic, MSG_MODIFIER_RESPONSE, resp);
}

// ---------------------------------------------------------------------------
// Decode boundary
//
// Every decoder below takes raw bytes from an unauthenticated peer and returns
// either a fully shape-checked message or `null`. They never throw: malformed
// CBOR, a wrong-typed field, a missing field, or an out-of-range height all
// collapse to `null`, and the caller drops the message and penalizes the peer.
//
// The returned object is rebuilt from the checked fields, so unknown extras in
// the body are ignored (forward compat) and nothing unvalidated leaks inward.
// ---------------------------------------------------------------------------

/** CBOR-decode a body. Returns null when the bytes are not well-formed CBOR. */
function tryDecode(body: Uint8Array): unknown {
  try {
    return decode(body);
  } catch {
    return null;
  }
}

export function decodeSyncInfo(body: Uint8Array): SyncInfo | null {
  const v = tryDecode(body);
  if (!isRecord(v)) return null;
  if (!isHeight(v.tipHeight)) return null;
  if (typeof v.tipBlockId !== 'string') return null;
  if (!Array.isArray(v.anchors)) return null;

  const anchors: { height: number; blockId: string }[] = [];
  for (const a of v.anchors) {
    if (!isRecord(a) || !isHeight(a.height) || typeof a.blockId !== 'string') return null;
    anchors.push({ height: a.height, blockId: a.blockId });
  }

  return {
    tipHeight: v.tipHeight,
    tipBlockId: v.tipBlockId,
    anchors,
  };
}

/** Inv and ModifierRequest share the `{ typeId, ids }` shape. */
function decodeIdList(body: Uint8Array): { typeId: number; ids: string[] } | null {
  const v = tryDecode(body);
  if (!isRecord(v)) return null;
  if (!isBoundedInt(v.typeId, MAX_TYPE_ID)) return null;
  if (!isStringArray(v.ids)) return null;
  return { typeId: v.typeId, ids: [...v.ids] };
}

export function decodeInv(body: Uint8Array): Inv | null {
  return decodeIdList(body);
}

export function decodeModifierRequest(body: Uint8Array): ModifierRequest | null {
  return decodeIdList(body);
}

export function decodeModifierResponse(body: Uint8Array): ModifierResponse | null {
  const v = tryDecode(body);
  if (!isRecord(v)) return null;
  if (!isBoundedInt(v.typeId, MAX_TYPE_ID)) return null;
  if (!Array.isArray(v.modifiers)) return null;

  const modifiers: { id: string; data: Uint8Array }[] = [];
  for (const m of v.modifiers) {
    if (!isRecord(m) || typeof m.id !== 'string' || !isBytes(m.data)) return null;
    modifiers.push({ id: m.id, data: m.data });
  }

  return { typeId: v.typeId, modifiers };
}

export function encodeGetPeers(magic: number): Uint8Array {
  // Empty CBOR map rather than zero bytes, so a future version can add fields
  // without a framing change.
  return frameMessage(magic, MSG_GET_PEERS, {});
}

/**
 * A GetPeers body carries no information, so nothing about its content can be
 * wrong: an empty body and a body with fields we do not know are both accepted
 * (forward compat — a future version may add fields). The only rejection is
 * bytes that are not well-formed CBOR at all, which violates the framing
 * convention shared by every stream message.
 */
export function decodeGetPeers(body: Uint8Array): GetPeersMsg | null {
  if (body.length === 0) return {};
  if (tryDecode(body) === null) return null;
  return {};
}

export function encodePeers(magic: number, msg: PeersMsg): Uint8Array {
  return frameMessage(magic, MSG_PEERS, msg);
}

/**
 * Every field of every entry is checked before use: `address` reaches dial
 * paths, the rest reach PeerDb and are re-served to other peers, so nothing
 * may pass through unvalidated. `protocolVersion` and `capabilities` get the
 * same treatment the handshake gives the same fields (`validateHandshake`).
 *
 * A body declaring more than MAX_PEERS_ENTRIES collapses to `null` like every
 * other malformed body — the contract makes both a permanent ban, so the
 * caller has no need to tell them apart.
 */
export function decodePeers(body: Uint8Array): PeersMsg | null {
  const v = tryDecode(body);
  if (!isRecord(v)) return null;
  if (!Array.isArray(v.peers)) return null;
  if (v.peers.length > MAX_PEERS_ENTRIES) return null;

  const peers: PeerEntryMsg[] = [];
  for (const e of v.peers) {
    if (!isRecord(e)) return null;
    if (typeof e.address !== 'string') return null;
    if (typeof e.agentName !== 'string') return null;
    if (typeof e.nodeName !== 'string') return null;
    if (!isBoundedInt(e.protocolVersion, MAX_CAPABILITY_CODE)) return null;
    if (!isBoundedIntArray(e.capabilities, MAX_CAPABILITY_CODE)) return null;
    peers.push({
      address: e.address,
      agentName: e.agentName,
      nodeName: e.nodeName,
      protocolVersion: e.protocolVersion,
      capabilities: [...e.capabilities],
    });
  }

  return { peers };
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
        // `'invalid-tag'` for the reason `CodecError` gives it (types →
        // CodecError): `ReaderErrorCode` has no member for "well-formed but out
        // of range", and this is the one of the eight that carries no fallback
        // semantics elsewhere in this package.
        throw new ReaderError(
          `${name}: ${a}/${b} is outside the advertisable height range`,
          'invalid-tag',
        );
      }
      return { [first]: a, [second]: b } as T;
    },
  };
}

const getHeadersCodec = heightPairCodec<GetHeadersMsg>('getHeaders', [
  'startHeight',
  'maxCount',
]);

const getBlocksCodec = heightPairCodec<GetBlocksMsg>('getBlocks', [
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
// out-of-domain field — `writeBool`'s `0xff` for a non-boolean `nonActivity`,
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
