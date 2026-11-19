export {
  NetNode,
  GET_PEERS_INTERVAL_MS,
  GET_PEERS_RESPONSE_LIMIT,
  decodeHandshakePayload,
} from './node.js';
export type { HandshakePayload, MeshIdentity } from './node.js';
// NET_INTERFACE → The mesh — the two refusal classes a caller catches,
// and the config shape its options take.
export { MeshConfigError, MeshStateError } from './mesh/config.js';
export type { MeshConfig } from './mesh/config.js';
export { PeerManager, MAX_TRACKED_BANS, MAX_TRACKED_SCORES } from './peer-mgr.js';
export type { PeerBanHooks } from './peer-mgr.js';
export { loadNodeKey, NodeKeyError } from './node-key.js';
// MESH_INTERFACE → FIPS → "A node's FIPS key persists".
export { loadFipsKey } from './mesh/fips-key.js';
// MESH_INTERFACE → FIPS → "A node's FIPS address is `/fips/<npub>/p2p/<peer id>`".
export { npubOf, dialKeyHex } from './mesh/fips-identity.js';
export {
  FIPS_PROTOCOL_NAME,
  registerFipsProtocol,
  fipsMultiaddr,
  parseFipsMultiaddr,
  isFipsMultiaddr,
} from './mesh/fips-addr.js';
// MESH_INTERFACE → FIPS → "A link rides a libp2p connection the two ends already hold".
export { fipsLinkProtocol, LibP2pLinkTransport } from './mesh/fips-link.js';
export type { LibP2pLinkTransportOptions } from './mesh/fips-link.js';
// MESH_INTERFACE → FIPS → "libp2p runs over a TCP/FIPS stream".
export {
  fipsDatagramEndpoint,
  fipsTransport,
  FipsTransportDialError,
} from './mesh/fips-transport.js';
export type { FipsTransportInit } from './mesh/fips-transport.js';
// NET_INTERFACE → "A mesh node runs a FIPS stack".
export { createFipsStack, createReaderFips } from './mesh/fips-stack.js';
export type { FipsStack, CreateFipsStackOptions } from './mesh/fips-stack.js';
export { HANDSHAKE_PROTOCOL, SYNC_PROTOCOL } from './sync.js';
export {
  gossipTopics,
  gossipMessageId,
  GOSSIP_SEEN_WINDOW_MS,
  GOSSIP_IP_COLOCATION_WEIGHT,
} from './gossip.js';
export type { GossipTopics } from './gossip.js';
export {
  encodeFrame,
  decodeFrame,
  createBlake2b256Hash,
  MAGIC_MAINNET,
  MAGIC_TESTNET,
  MAGIC_DEVNET,
  KNOWN_FRAME_MAGICS,
} from './frame.js';
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
export {
  buildHandshakeFrame,
  decodeHandshakeBody,
  handshakeCodec,
  handshakePenalty,
  validateHandshake,
} from './handshake.js';
export {
  NODE_CAPABILITIES,
  READER_CAPABILITIES,
  SERVING_READER_CAPABILITIES,
  servesChain,
  declares,
} from './capabilities.js';
export type { HandshakeMsg, HandshakeRejection, HandshakeResult } from './handshake.js';
export {
  isRecord,
  isBoundedInt,
  isHeight,
  isBoundedIntArray,
  MAX_ADVERTISED_HEIGHT,
  MAX_CAPABILITY_CODE,
  MAX_INV_IDS,
  MAX_CHAIN_RESPONSE_ITEMS,
  MAX_LOCATOR_HASHES,
  MAX_PEERS_ENTRIES,
  MAX_STREAM_BYTES,
  MAX_SERVE_BODY_BYTES,
  MAX_CAPABILITY_ENTRIES,
  MAX_NAME_BYTES,
  MAX_ADDRESS_BYTES,
  MAX_HANDSHAKE_FRAME_BYTES,
  MAX_MODIFIER_REQUEST_FRAME_BYTES,
  MAX_INBOUND_HANDSHAKE_STREAMS,
  HANDSHAKE_DEADLINE_FACTOR,
  MAX_INBOUND_SYNC_STREAMS,
  SYNC_INFO_MIN_INTERVAL_MS,
  STALL_MARK_EXPIRY_MS,
  MAX_STALL_MARKS,
  INBOUND_UPGRADE_TIMEOUT_MS,
  PENDING_UPGRADES_PER_ADDRESS,
} from './msg-guards.js';
export { isBogusAddress } from './bogus-addr.js';
export { PeerDb, MAX_BANNED_ADDRS } from './peerdb.js';
export { OutboundManager } from './outbound-mgr.js';
export type { ConnectionLike, OutboundTickPlan } from './outbound-mgr.js';
export type { PeerStorage } from './peerdb.js';
export {
  PeerState,
  PenaltyKind,
  MISBEHAVIOR_SCORE,
  TRANSIENT_SCORE,
} from './types.js';
export type {
  NetConfig,
  NetValidators,
  Peer,
  PeerRecord,
  PeerMetadata,
  GetPeersMsg,
  PeerEntryMsg,
  PeersMsg,
  GetHeadersMsg,
  GetBlocksMsg,
} from './types.js';
export type {
  SyncInfo, ModifierRequest, ModifierResponse, SyncState,
  PipelineIntake, ChainView,
} from './sync-types.js';
export {
  syncInfoCodec, encodeSyncInfo, decodeSyncInfo,
  modifierRequestCodec,
  encodeModifierRequest, decodeModifierRequest,
  modifierResponseCodec, encodeModifierResponse, decodeModifierResponse,
  encodeGetPeers, decodeGetPeers,
  peersCodec, encodePeers, decodePeers,
  encodeGetHeaders, decodeGetHeaders,
  encodeHeaders, decodeHeaders,
  encodeGetBlocks, decodeGetBlocks,
  encodeBlocks, decodeBlocks,
} from './sync-codec.js';
export { SyncMachine } from './sync-machine.js';
export type { SyncStore } from './sync-machine.js';
