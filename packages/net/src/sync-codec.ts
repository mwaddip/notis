import { encode, decode } from 'cbor-x';
import { encodeFrame } from './frame.js';
import type { SyncInfo, Inv, ModifierRequest, ModifierResponse } from './sync-types.js';
import { MSG_SYNC_INFO, MSG_INV, MSG_MODIFIER_REQUEST, MSG_MODIFIER_RESPONSE, MSG_GET_PEERS, MSG_PEERS, MSG_GET_POSTS, MSG_POSTS } from './types.js';
import type { GetPeersMsg, PeersMsg, PeerEntryMsg, GetPostsMsg, PostsMsg, PostsEntry } from './types.js';
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
} from '@dagsocial/types';
import type { BlockHeader, OrderingBlock, Post, StructCodec } from '@dagsocial/types';
import {
  isRecord,
  isBoundedInt,
  isBoundedIntArray,
  isHeight,
  isStringArray,
  isBytes,
  isWorkString,
  MAX_TYPE_ID,
  MAX_CAPABILITY_CODE,
  MAX_LEGACY_RESPONSE_ITEMS,
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
  if (!isWorkString(v.tipCumulativeWork)) return null;
  if (!Array.isArray(v.anchors)) return null;

  const anchors: { height: number; blockId: string }[] = [];
  for (const a of v.anchors) {
    if (!isRecord(a) || !isHeight(a.height) || typeof a.blockId !== 'string') return null;
    anchors.push({ height: a.height, blockId: a.blockId });
  }

  return {
    tipHeight: v.tipHeight,
    tipBlockId: v.tipBlockId,
    tipCumulativeWork: v.tipCumulativeWork,
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

export function encodeGetPosts(magic: number, msg: GetPostsMsg): Uint8Array {
  // GetPostsMsg is a simple object — CBOR handles it natively
  return frameMessage(magic, MSG_GET_POSTS, msg);
}

export function decodeGetPosts(body: Uint8Array): GetPostsMsg | null {
  const v = tryDecode(body);
  if (!isRecord(v)) return null;
  if (!isStringArray(v.postIds)) return null;
  return { postIds: [...v.postIds] };
}

export function encodePosts(magic: number, msg: PostsMsg): Uint8Array {
  return frameMessage(magic, MSG_POSTS, msg);
}

export function decodePosts(body: Uint8Array): PostsMsg | null {
  const v = tryDecode(body);
  if (!isRecord(v)) return null;
  if (!Array.isArray(v.entries)) return null;

  const entries: PostsEntry[] = [];
  for (const e of v.entries) {
    if (!isRecord(e) || typeof e.postId !== 'string') return null;
    if (!isRecord(e.post)) return null;
    // The Post interior is not inspected here — content validation is
    // Stage 1's job (`@dagsocial/validation`). This boundary only guarantees
    // the envelope can be walked without throwing.
    entries.push({
      postId: e.postId,
      post: e.post as unknown as Post,
    });
  }

  return { entries };
}

// ---------------------------------------------------------------------------
// Legacy /dagsocial/headers/1 request
// ---------------------------------------------------------------------------

/**
 * Body of the legacy headers-protocol request. Raw CBOR, no frame — the
 * protocol predates framing and is kept only for backward compatibility.
 */
export interface LegacyHeadersRequest {
  startHeight: number;
  maxCount?: number;
  endHeight?: number;
  mode?: string;
}

/**
 * Decode and validate a legacy headers request.
 *
 * Both heights drive serve loops that read the store once per height, so both
 * are bounded here exactly like an advertised chain height.
 */
export function decodeLegacyHeadersRequest(body: Uint8Array): LegacyHeadersRequest | null {
  const v = tryDecode(body);
  if (!isRecord(v)) return null;
  if (!isHeight(v.startHeight)) return null;
  if (v.maxCount !== undefined && !isHeight(v.maxCount)) return null;
  if (v.endHeight !== undefined && !isHeight(v.endHeight)) return null;
  if (v.mode !== undefined && typeof v.mode !== 'string') return null;

  const req: LegacyHeadersRequest = { startHeight: v.startHeight };
  if (v.maxCount !== undefined) req.maxCount = v.maxCount;
  if (v.endHeight !== undefined) req.endHeight = v.endHeight;
  if (v.mode !== undefined) req.mode = v.mode;
  return req;
}

// ---------------------------------------------------------------------------
// Legacy /dagsocial/headers/1 responses
//
// Both responses are `arr(item, lp)` over the same positional codec the rest of
// this package speaks, and every element runs the four-part boundary check
// (TYPES_INTERFACE → The boundary check) on its own byte span.
//
// Why a positional codec and not a shape check over `cbor-x`: a `decode(raw) as
// T` cast is not a check, and the gap it leaves is measured rather than
// theorised — without this codec this path is the sole delivery route for a
// remote fail-stop. The two sentinel bytes a total writer emits for an
// out-of-domain field — `writeBool`'s `0xff` for a non-boolean `isTreasury`,
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
 * `MAX_LEGACY_RESPONSE_ITEMS` (`responseCap`) — a peer answering a 40-header
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
 * Decode a legacy response body, converting every `ReaderError` into `null`.
 *
 * TYPES_INTERFACE → The boundary check, step 4 — "callers convert `ReaderError`
 * into a verdict" — discharged in the shape the rest of this file uses:
 * decoders at net's boundary never throw, they return `null`, and the caller
 * decides what a `null` means for the peer that sent it.
 */
function decodeLegacyResponse<T>(codec: StructCodec<T[]>, bytes: Uint8Array): T[] | null {
  try {
    return decodeStruct(codec, bytes);
  } catch {
    return null;
  }
}

function blocksResponseCodec(maxBlocks: number): StructCodec<OrderingBlock[]> {
  return lpItemsCodec('legacyBlocksResponse', encodeOrderingBlock, decodeOrderingBlock, maxBlocks);
}

function headersResponseCodec(maxHeaders: number): StructCodec<BlockHeader[]> {
  return lpItemsCodec('legacyHeadersResponse', encodeHeader, decodeHeader, maxHeaders);
}

/**
 * Serialize a blocks-mode response.
 *
 * Throws only for a block *we* hold that has no encoding — a corrupt local
 * store, not a peer's doing. The handler's own `catch` turns that into an empty
 * response, which is the same answer it gives for every other local failure.
 */
export function encodeLegacyBlocksResponse(blocks: OrderingBlock[]): Uint8Array {
  return encodeStruct(blocksResponseCodec(MAX_LEGACY_RESPONSE_ITEMS), blocks);
}

/**
 * Parse a blocks-mode response. `null` for anything that is not a well-formed,
 * canonical response of at most `maxBlocks` blocks.
 *
 * `maxBlocks` is the caller's own request size — the peer is answering a
 * question only the caller knows.
 */
export function decodeLegacyBlocksResponse(
  bytes: Uint8Array,
  maxBlocks: number,
): OrderingBlock[] | null {
  return decodeLegacyResponse(blocksResponseCodec(responseCap(maxBlocks)), bytes);
}

/** Serialize a headers-mode response. See `encodeLegacyBlocksResponse`. */
export function encodeLegacyHeadersResponse(headers: BlockHeader[]): Uint8Array {
  return encodeStruct(headersResponseCodec(MAX_LEGACY_RESPONSE_ITEMS), headers);
}

/** Parse a headers-mode response. See `decodeLegacyBlocksResponse`. */
export function decodeLegacyHeadersResponse(
  bytes: Uint8Array,
  maxHeaders: number,
): BlockHeader[] | null {
  return decodeLegacyResponse(headersResponseCodec(responseCap(maxHeaders)), bytes);
}

/**
 * How many items a response to a request of this size may carry.
 *
 * Clamped to `MAX_LEGACY_RESPONSE_ITEMS` because the requested size is derived
 * from peer-supplied heights (`requestBlocks` spans `forkHeight + 1` to a tip
 * height that came off the wire), so it is not by itself a bound. A nonsensical
 * request size accepts an empty response and nothing else, rather than
 * falling back to a permissive default.
 */
function responseCap(requested: number): number {
  if (!Number.isSafeInteger(requested) || requested < 0) return 0;
  return Math.min(requested, MAX_LEGACY_RESPONSE_ITEMS);
}
