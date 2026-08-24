import type { OrderingBlock, UtxoTransaction, BlockHeader } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Message codes
// ---------------------------------------------------------------------------

export const MSG_HANDSHAKE = 1;
export const MSG_SYNC_INFO = 2;
export const MSG_INV = 3;
export const MSG_MODIFIER_REQUEST = 4;
export const MSG_MODIFIER_RESPONSE = 5;
export const MSG_GET_PEERS = 8;
export const MSG_PEERS = 9;
export const MSG_GET_HEADERS = 14;
export const MSG_HEADERS = 15;
export const MSG_GET_BLOCKS = 16;
export const MSG_BLOCKS = 17;

// ---------------------------------------------------------------------------
// Modifier type IDs
// ---------------------------------------------------------------------------

export const MODIFIER_ORDERING_BLOCK = 101;
// 102 retired (was sub-block), never reuse
export const MODIFIER_POST_BODY = 103;

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

export const BACKFILL_BATCH_IDS = 100;

// ---------------------------------------------------------------------------
// Peer
// ---------------------------------------------------------------------------

export interface Peer {
  id: string;
  multiaddrs: string[];
  protocols: string[];
  connectedAt: number;
}

// ---------------------------------------------------------------------------
// Penalty
// ---------------------------------------------------------------------------

export type PenaltyType = 'misbehavior' | 'permanent';

export interface PenaltyRecord {
  type: PenaltyType;
  score: number;
  timestamp: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// Peer state machine
// ---------------------------------------------------------------------------

export enum PeerState {
  Connecting = 'connecting',
  Handshaking = 'handshaking',
  Active = 'active',
  Disconnected = 'disconnected',
  Failed = 'failed',
  Banned = 'banned',
}

// ---------------------------------------------------------------------------
// Penalty attribution tiers (additive to existing PenaltyType)
// ---------------------------------------------------------------------------

export enum PenaltyKind {
  /** Transient failure — cooldown, not a ban. */
  Transient = 'transient',
  /** Protocol violation — permanent ban. */
  ProtocolViolation = 'protocol_violation',
}

// ---------------------------------------------------------------------------
// PeerMetadata — runtime peer state tracked by PeerManager
// ---------------------------------------------------------------------------

export interface PeerMetadata {
  peerId: string;
  state: PeerState;
  penaltyCount: number;
  bannedUntil: number | null; // null = not banned, timestamp = ban expiration
  stalled: boolean;
  lastSeenMs: number;
  /**
   * The peer's declared multiaddr, or null until the handshake reveals it.
   * This is the join key between the two ban surfaces: PeerManager bans by
   * peerId, PeerDb bans by address, and every PeerManager ban propagates to
   * PeerDb through this field (contract: "Ban surfaces are unified").
   */
  address: string | null;
}

// ---------------------------------------------------------------------------
// Event types for the biased event loop
// ---------------------------------------------------------------------------

export interface ControlEvent {
  kind: 'reorg' | 'peer_disconnect' | 'new_peer' | 'shutdown';
  peerId?: string;
  data?: unknown;
}

export interface DataEvent {
  kind: 'post_received' | 'post_acknowledged' | 'message';
  peerId: string;
  data: Uint8Array;
}

// ---------------------------------------------------------------------------
// PeerRecord — persisted peer metadata
// ---------------------------------------------------------------------------

export interface PeerRecord {
  address: string;
  lastSeenMs: number;
  agentName: string;
  nodeName: string;
  protocolVersion: number;
  capabilities: number[];
}

// ---------------------------------------------------------------------------
// NetConfig
// ---------------------------------------------------------------------------

export interface NetConfig {
  // Both supplied by the node from its resolved network profile. Net receives
  // these values, it never resolves them — no NetworkProfile import, no env
  // read, no default (NET_INTERFACE → Consensus parameters net enforces).
  magic: number;
  bootstrapPeers: string[];
  listenAddrs: string;
  maxPeers: number;
  minPeers?: number;
  peerDbCap?: number;
  outboundRedialCooldownMs?: number;
  penaltyScoreThreshold: number;
  temporalBanDurationMs: number;
  penaltySafeIntervalMs: number;
  syncRequestTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// NetValidators — passed at construction, provided by @dagsocial/validation
// ---------------------------------------------------------------------------

export interface NetValidators {
  verifyOrderingBlockPoW: (header: BlockHeader) => boolean;
  verifyProtocolVersion: (version: number) => boolean;
  verifyContentLimits: (content: string) => { valid: boolean; error?: string };
  verifyParentRefsCount: (refs: string[]) => { valid: boolean; error?: string };
  verifyTxStructure: (tx: UtxoTransaction) => { valid: boolean; error?: string };
  verifyOrderingBlockStructure: (block: OrderingBlock) => { valid: boolean; error?: string };
  verifyPostBody: (content: unknown, contentHash: Uint8Array) => { valid: boolean; error?: string };
}

// ---------------------------------------------------------------------------
// GetPeers / Peers message types
// ---------------------------------------------------------------------------

/**
 * Body of a GetPeers request (code 8). Zero-byte body — the request carries
 * no parameters. Evolution is a protocol version bump.
 */
export interface GetPeersMsg {}

/**
 * One advertised peer inside a Peers response. This is the wire shape: unlike
 * `PeerRecord` it carries no `lastSeenMs` — a peer's claim about when it last
 * saw someone is worthless hearsay, so the receiver stamps its own clock at
 * intake time.
 */
export interface PeerEntryMsg {
  address: string;
  agentName: string;
  nodeName: string;
  protocolVersion: number;
  capabilities: number[];
}

export interface PeersMsg {
  peers: PeerEntryMsg[];
}

// ---------------------------------------------------------------------------
// GetHeaders / GetBlocks request types
//
// Positional bodies, not CBOR maps: `vlqU(startHeight) vlqU(maxCount)` for code
// 14 and `vlqU(startHeight) vlqU(endHeight)` for code 16 (NET_INTERFACE →
// `GetHeaders` / `GetBlocks` responses). Neither field is optional — the code
// pair is what discriminates the two queries, so there is no shared shape for a
// missing field to select within.
// ---------------------------------------------------------------------------

export interface GetHeadersMsg {
  startHeight: number;
  maxCount: number;
}

export interface GetBlocksMsg {
  startHeight: number;
  endHeight: number;
}
