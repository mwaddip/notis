// NET_INTERFACE → The browser entry — the half a browser runs, imports no
// Node built-in and reads no Node global; held equal by a build of it that
// refuses any Node built-in (WEB_INTERFACE → "A Node built-in fails every
// build"). The frame codec is parameterized in `./frame-codec.js`; the
// checksum this entry hands in is `hash32` (TYPES_INTERFACE → The protocol
// hash → "Truncated BLAKE2b-512, never BLAKE2b-256"), the same 32 bytes
// the Node entry's `createHash('blake2b512')` answers — so the two entries
// produce one frame on the wire.
import { hash32 } from '@dagsocial/types';
import {
  encodeFrame as encodeFrameWithHash,
  decodeFrame as decodeFrameWithHash,
} from './frame-codec.js';
import type { HashFn } from './frame-codec.js';
import { buildHandshakeFrameWithHash } from './handshake-codec.js';
import type { HandshakeMsg } from './handshake-codec.js';

// A fresh HashFn per call so this module holds no state; the cost of the
// closure is negligible against the hash it wraps.
function browserHashFn(): HashFn {
  return (data) => hash32(data);
}

/** Encode a message into a framed envelope for this node's network. */
export function encodeFrame(magic: number, code: number, body: Uint8Array): Uint8Array {
  return encodeFrameWithHash(magic, code, body, browserHashFn());
}

/** Decode a framed envelope. */
export function decodeFrame(magic: number, data: Uint8Array): { code: number; body: Uint8Array } {
  return decodeFrameWithHash(magic, data, browserHashFn());
}

/** Build a handshake frame for our node, using `hash32`. */
export function buildHandshakeFrame(magic: number, msg: HandshakeMsg): Uint8Array {
  return buildHandshakeFrameWithHash(magic, msg, browserHashFn());
}

// NET_INTERFACE → Frame Format — the magics.
export {
  MAGIC_MAINNET,
  MAGIC_TESTNET,
  MAGIC_DEVNET,
  KNOWN_FRAME_MAGICS,
} from './frame-codec.js';

// NET_INTERFACE → Handshake.
export {
  HANDSHAKE_PROTOCOL,
  handshakeCodec,
  decodeHandshakeBody,
  handshakePenalty,
  validateHandshake,
} from './handshake-codec.js';
export type {
  HandshakeMsg,
  HandshakeRejection,
  HandshakeResult,
} from './handshake-codec.js';

// NET_INTERFACE → Readers.
export {
  NODE_CAPABILITIES,
  READER_CAPABILITIES,
  SERVING_READER_CAPABILITIES,
  servesChain,
  declares,
} from './capabilities.js';

// NET_INTERFACE → Gossip Topics.
// MESH_INTERFACE → Block gossip — `GOSSIP_IP_COLOCATION_WEIGHT`, the weight
// `gossipsubOptions` carries for gossipsub's IP colocation factor.
export {
  GOSSIP_SEEN_WINDOW_MS,
  GOSSIP_IP_COLOCATION_WEIGHT,
  gossipTopics,
  gossipMessageId,
  gossipsubOptions,
} from './gossip-rules.js';
export type { GossipTopics, GossipsubOptions } from './gossip-rules.js';

// NET_INTERFACE → The browser entry — BlockCheck is the one copy of the
// ordering-block topic's checks of NET_INTERFACE → Stage 1.
export { BlockCheck } from './block-check.js';
export type {
  BlockVerdict,
  BlockValidators,
  BlockCheckContext,
} from './block-check.js';

// MESH_INTERFACE → Identity — "One key, two spellings". The browser
// reads these for a mesh URL and for `localAddrsFor`.
export {
  peerIdFromNotisId,
  notisIdFromPeerId,
  nodeKeyFromKeyPair,
  MeshKeyError,
  localAddrsFor,
} from './mesh/identity.js';
export type { NodeKey } from './mesh/identity.js';
// MESH_INTERFACE → The mesh URL — the browser builds and parses mesh URLs.
export { parseMeshUrl, meshBaseUrl, MeshUrlError, idOfMeshUrl } from './mesh/mesh-url.js';
// MESH_INTERFACE → The node endpoint — the reader's mesh fetch.
export {
  meshFetch,
  meshFetchOverConnection,
  MeshFetchError,
} from './mesh/mesh-fetch.js';
// NET_INTERFACE → Readers — the reader's dial-side handshake.
export { readerHandshake } from './mesh/reader-handshake.js';
export type { ReaderHandshakeOptions, ReaderHandshakeResult } from './mesh/reader-handshake.js';
// NET_INTERFACE → The browser entry — the reader's libp2p options.
export { readerLibp2pOptions } from './mesh/reader-options.js';
export type { ReaderLibp2pOptions } from './mesh/reader-options.js';
// MESH_INTERFACE → Discovery / NAT / The IP certificate — the numbers
// the client reads (its retry cadence, its STUN port, the certificate
// lifespan). The register's drift test keys off these; a new number
// added here is a `contracts/CONSTANTS.md` row (`CLAUDE.md →
// Platform constraint`).
export {
  WEBRTC_CERT_LIFESPAN_MS,
  STUN_PORT,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  RELAY_LISTEN_TIMEOUT_MS,
  CERT_RETRY_MS,
  dhtProtocol,
} from './mesh/constants.js';
export type { MeshNetworkName } from './mesh/constants.js';

// NET_INTERFACE → Message Codes, NET_INTERFACE → Handshake Body.
export {
  MSG_HANDSHAKE,
  MSG_SYNC_INFO,
  MSG_MODIFIER_REQUEST,
  MSG_MODIFIER_RESPONSE,
  MSG_GET_PEERS,
  MSG_PEERS,
  MSG_GET_HEADERS,
  MSG_HEADERS,
  MSG_GET_BLOCKS,
  MSG_BLOCKS,
  MODIFIER_POST_BODY,
} from './types.js';
export { MAX_HANDSHAKE_FRAME_BYTES, MAX_MODIFIER_REQUEST_FRAME_BYTES } from './msg-guards.js';
// NET_INTERFACE → Historical Sync — the one stream protocol every sync
// query and a serving reader's answer ride.
export { SYNC_PROTOCOL } from './sync-protocol.js';
// NET_INTERFACE → Readers — "A serving reader answers from what it holds".
export {
  answerPostTextsRequest,
  postTextsHandler,
} from './mesh/serve-post-texts.js';
export type {
  PostTextProvider,
  PostTextsHandlerOptions,
  PostTextsStream,
  PostTextsConnection,
} from './mesh/serve-post-texts.js';
