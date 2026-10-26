import type { OrderingBlock, UtxoTransaction, BlockHeader, ProtocolEra } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Message codes
// ---------------------------------------------------------------------------

export const MSG_HANDSHAKE = 1;
export const MSG_SYNC_INFO = 2;
// code 3 retired (was Inv) — never reuse
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

// 101 retired (was ordering block), never reuse
// 102 retired (was sub-block), never reuse
export const MODIFIER_POST_BODY = 103;

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
// Peer state machine
// ---------------------------------------------------------------------------

// NET_INTERFACE → Peer State Machine
export enum PeerState {
  Connecting = 'connecting',
  Active = 'active',
}

// ---------------------------------------------------------------------------
// Penalty attribution tiers
// (NET_INTERFACE → Peer Penalty System)
// ---------------------------------------------------------------------------

export enum PenaltyKind {
  /** An invalid message — a Stage-1 failure (NET_INTERFACE → Peer Penalty System). */
  Misbehavior = 'misbehavior',
  /** A compatibility mismatch — a cooldown, not a ban. */
  Transient = 'transient',
  /** A protocol violation — a permanent ban. */
  ProtocolViolation = 'protocol_violation',
}

/**
 * The score a `Misbehavior` penalty accrues. Named once beside the tier
 * (NET_INTERFACE → Peer Penalty System → "A scored tier's score is named
 * once, beside the tiers").
 */
export const MISBEHAVIOR_SCORE = 100;

/**
 * The score a `Transient` penalty accrues. Named once beside the tier
 * (NET_INTERFACE → Peer Penalty System → "A scored tier's score is named
 * once, beside the tiers").
 */
export const TRANSIENT_SCORE = 50;

// ---------------------------------------------------------------------------
// PeerMetadata — runtime peer state tracked by PeerManager
// ---------------------------------------------------------------------------

export interface PeerMetadata {
  peerId: string;
  state: PeerState;
  penaltyCount: number;
  lastSeenMs: number;
  /**
   * The address this node dialled — recorded when the peer's handshake makes
   * it Active; a peer that dialled this node has none
   * (NET_INTERFACE → Ban surfaces are unified). This is the join key between the two ban
   * surfaces: PeerManager bans by peerId, PeerDb bans by address. A ban's
   * address set opens with this field, when there is one, and grows through
   * `extendBan` as further addresses are tied to the same peer id.
   */
  address: string | null;
  /**
   * The address the peer declared on its handshake, kept apart from
   * `address` (NET_INTERFACE → Handshake →
   * "A declared address is hearsay until a dial names it"). Serves one
   * purpose: leaving the requester's own address out of a `Peers` answer
   * (NET_INTERFACE → GetPeers). It never reaches a ban.
   */
  declaredAddress: string | null;
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
  // All three supplied by the node from its resolved network profile. Net
  // receives these values, it never resolves them — no NetworkProfile import,
  // no env read, no default (NET_INTERFACE → Consensus parameters net enforces).
  magic: number;
  // The profile's era table (TYPES_INTERFACE → Version). The handshake, the tx
  // validator and the boundary sweep read the era at chainHeight() + 1 from it;
  // the block validator reads it at each header's height (NET_INTERFACE → Config).
  protocolVersionSchedule: readonly ProtocolEra[];
  // The profile's difficulty floor: the ordering-block topic validator refuses
  // a header below it (NET_INTERFACE → Consensus parameters net enforces). Node
  // refuses a profile floor below ORDERING_BLOCK_POW_TARGET_FLOOR (2304) and a
  // NaN at load time; a NaN here would compare false and silently disable the
  // check, so the bound lives at the source, not at every consumer.
  orderingBlockPowTargetFloorBits: number;
  bootstrapPeers: string[];
  listenAddrs: string;
  maxPeers: number;
  // All three required — net holds no default (NET_INTERFACE → Outbound Manager).
  minPeers: number;
  peerDbCap: number;
  outboundRedialCooldownMs: number;
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
  // Every entry of the signature map verifies over the transaction's id
  // (VALIDATION_INTERFACE → verifyTxSignatures). The tx topic validator reads
  // it last, behind the karma gate (NET_INTERFACE → Stage 1 → "A transaction's
  // signatures are checked at Stage 1").
  verifyTxSignatures: (tx: UtxoTransaction) => boolean;
  // The header is inside the encodable domain
  // (VALIDATION_INTERFACE → verifyHeaderFieldDomains). The ordering-block
  // topic validator reads it on the header alone, before the body is decoded
  // (NET_INTERFACE → Stage 1 → "A header is read before its body").
  verifyHeaderFieldDomains: (header: unknown) => { valid: boolean; error?: string };
  verifyOrderingBlockStructure: (block: OrderingBlock) => { valid: boolean; error?: string };
  // The 64-byte Ed25519 signature over `blockHash(header)` by the key the
  // header declares in `validatorId` (VALIDATION_INTERFACE →
  // verifyValidatorSignature). The ordering-block topic validator reads it
  // behind the standing check (NET_INTERFACE → Stage 1 → "A header is read
  // before its body").
  verifyValidatorSignature: (header: BlockHeader, signature: Uint8Array) => boolean;
  // The body is the one the header's `utxoTxRoot` commits
  // (VALIDATION_INTERFACE → verifyUtxoTxRoot). Called from the ordering-block
  // topic validator after the PoW check (NET_INTERFACE → Stage 1 →
  // "A worked header is forwarded with the body its root commits").
  verifyUtxoTxRoot: (block: OrderingBlock) => boolean;
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
// Positional `arr(hexN(32))` for both (NET_INTERFACE → `GetHeaders` /
// `GetBlocks` responses). The two bodies share the layout; the frame's code
// pair is what tells them apart.
// ---------------------------------------------------------------------------

export interface GetHeadersMsg {
  locator: string[];
}

export interface GetBlocksMsg {
  ids: string[];
}
