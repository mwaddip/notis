import type { OrderingBlock, UtxoTransaction, BlockHeader, ProtocolEra } from '@dagsocial/types';

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
  lastSeenMs: number;
  /**
   * The address this node dialled, or the address the peer declared —
   * recorded when the peer reaches Active, the handshake being the only
   * place both identities are known. Null until then. This is the join key
   * between the two ban surfaces: PeerManager bans by peerId, PeerDb bans by
   * address. A ban's address set opens with this field, when there is one,
   * and grows through `extendBan` as further addresses are tied to the same
   * peer id (NET_INTERFACE → Ban surfaces are unified).
   */
  address: string | null;
  /**
   * The peer's declared `protocolVersion` (the handshake's), or null until the
   * handshake reveals it. This is the version the boundary sweep reads
   * (NET_INTERFACE → Post-Handshake Routing): a peer whose version is null has
   * not handshaken and is not Active, so it is never the sweep's.
   */
  protocolVersion: number | null;
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
  // The profile's era table (TYPES_INTERFACE → Version). The handshake, the tx
  // validator and the boundary sweep read the era at chainHeight() + 1 from it;
  // the block validator reads it at each header's height (NET_INTERFACE → Config).
  protocolVersionSchedule: readonly ProtocolEra[];
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
  // The declared version equals the era scheduled at the object's height
  // (VALIDATION_INTERFACE → Protocol Version). Node passes validation's
  // functions through; net calls them, it does not implement them.
  verifyProtocolVersion: (declared: number, height: number, schedule: readonly ProtocolEra[]) => boolean;
  verifyTxProtocolVersion: (tx: UtxoTransaction, height: number, schedule: readonly ProtocolEra[]) => boolean;
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
