// Protocol constants
export {
  PROTOCOL_VERSION,
  MAX_CONTENT_BYTES,
  MAX_PARENT_REFS,
  MAX_GENESIS_PROOF_PAYLOAD_BYTES,
  MAX_BLOCK_BODY_BYTES,
  MAX_TX_BYTES,
  MAX_SETTLEMENT_BYTES,
  MAX_BOND_SETTLEMENTS_PER_BLOCK,
  MAX_ESCROW_RETURNS_PER_BLOCK,
  MAX_LAPSE_WITHDRAWALS_PER_BLOCK,
  BOX_VALUE_BOUND,
  AVL_KEY_LENGTH,
  KARMA_POSTING_MINIMUM,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  POST_PRICE_THREAD,
  POST_PRICE_REPLY,
  REPLY_AUTHOR_SHARE,
  LIKE_KARMA_COST,
  LIKES_PER_KARMA_PAYOUT,
  MEMBER_LIKES_MULTIPLIER,
  VOUCH_KARMA_AMOUNT,
  VOUCH_MIN_BALANCE,
  VOUCH_COOLDOWN_BLOCKS,
  VOUCH_CAST_HEIGHT_WINDOW,
  INVITE_MIN_KARMA,
  INVITE_BOND_MIN,
  INVITE_BOND_MAX,
  INVITE_PROBATION_BLOCKS,
  INVITE_BOND_VEST_PER_LIKES,
  GENESIS_KARMA_PER_MEMBER,
  SYSTEM_KARMA_INITIAL,
  FAUCET_CREDITS_INITIAL,
  CREDIT_FIXED_RATE_BLOCKS,
  CREDIT_INITIAL_REWARD,
  CREDIT_EPOCH_BLOCKS,
  CREDIT_REWARD_REDUCTION,
  CREDIT_EMISSION_TOTAL,
  CREDIT_MINER_REWARD_DELAY,
  MEMPOOL_EXPIRY_BLOCKS,
  COINBASE_TREASURY_PCT,
  COINBASE_MINER_FLOOR_PCT,
  COINBASE_BACKER_PCT,
  COINBASE_BONUS_PCT,
  INCLUSION_BONUS_K,
  MEMPOOL_CREDIT_SHARE_PCT,
  MIN_FEE_RATE_PER_BYTE,
  MIN_BOX_VALUE_PER_BYTE,
  STORAGE_RENT_PER_BYTE,
  ORDERING_BLOCK_POW_TARGET_BITS,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  RETARGET_HALFLIFE_BLOCKS,
  MAX_FUTURE_DRIFT_MS,
  GENESIS_PREV_BLOCK_HASH,
  ED25519_SPKI_PREFIX,
  LEVEL_CAP,
  MAX_INTERLINKS,
} from './constants.js';

// Network profiles
export {
  NETWORK_PROFILES,
  profileFor,
  protocolVersionAt,
  MAGIC_MAINNET,
  MAGIC_TESTNET,
  MAGIC_DEVNET,
  KNOWN_FRAME_MAGICS,
} from './network.js';
export type { NetworkType, NetworkProfile, ProtocolEra } from './network.js';

// Identity
export { generateKeyPair } from './identity.js';
export type { KeyPair, UserId } from './identity.js';

// Base58
export { base58Encode, base58Decode } from './base58.js';

// Merkle tree
export { leafHash, nodeHash, buildMerkleRoot, hexToBuf } from './merkle.js';

// Posts
//
// `postFieldBytes` is a preimage layout other packages build against, and a
// second statement of it is free to drift.
export { postFieldBytes, computePostId, computeContentHash, POST_TYPE, POST_ID_DOMAIN, POST_CONTENT_DOMAIN } from './post.js';
export type { PostCommit, Post, PostId, PostType } from './post.js';

// UTXO
//
// `BOX_TYPE_TAGS` is the box-type mapping, exported for the reason
// `postFieldBytes` above is: other packages need it and a second statement of it
// is free to drift. It is the numbering inside every box's id preimage, which
// the demo UI mirrors and cannot import. See TYPES_INTERFACE → Layout — Boxes.
export {
  computeBoxId,
  computeCandidateBoxId,
  computeMintTxId,
  computeTxId,
  boxRecordBytes,
  boxRecordFromBytes,
  canonicalBoxBytes,
  u32BE,
  selectBoxes,
  BOX_ID_DOMAIN,
  TX_ID_DOMAIN,
  MINT_ID_DOMAIN,
  IDENTITY_KEY_DOMAIN,
  NETWORK_KEY_DOMAIN,
  BOX_TYPE_TAGS,
} from './utxo.js';
export type {
  BoxId,
  BoxCandidate,
  BoxRecord,
  DecodedBoxCandidate,
  CandidateOf,
  AnyBoxCandidate,
  BoxBase,
  MintReason,
  KarmaBox,
  CreditBox,
  GenesisProofBox,
  BondBox,
  VouchBox,
  VouchEscrowBox,
  LikeAccrualBox,
  EmissionBox,
  TreasuryBox,
  FeeBox,
  KarmaPriceBox,
  KarmaPoolBox,
  AnyBox,
  UtxoTransaction,
  TxId,
} from './utxo.js';

// Membership — TYPES_INTERFACE → Membership; ARCHITECTURE → Membership
export { icbrt, membershipBar, memberLikesBar } from './membership.js';

// Stumps / prune / post-withdrawal
export { postWithdrawFieldBytes, pruneFieldBytes } from './stump.js';
export type { PostWithdrawCommit, PruneCommit, Stump, StumpId } from './stump.js';

// Interlinks — TYPES_INTERFACE → Interlink vector
export {
  INTERLINK_DOMAIN,
  encodeInterlinks,
  decodeInterlinks,
  interlinkRoot,
  updateInterlinks,
} from './interlinks.js';

// Blocks
export {
  EMPTY_STATE_ROOT,
} from './block.js';
export type {
  OrderingBlock,
  BlockHeader,
  UtxoTxTree,
} from './block.js';

// The positional codec layer (`codec.ts`)
//
// The field primitives, `enum8` and the four-part boundary check. Exported
// because every consensus preimage in the repo is written in this notation and
// `types` is not the only package that writes one: node's `serialize-box.ts`
// holds the AVL values, and an AVL box value **IS `boxRecordBytes` exactly** —
// no wrapper, no second tag. Its first byte is already the `boxType` `enum8`
// from the layout above, so a node-side box-type numbering would be a second
// numbering of one thing. See `NODE_INTERFACE` → Three entity kinds.
//
// `ByteReader` / `ByteWriter` / `ReaderError` come with it, re-exported from
// `@dagsocial/wire`, which `@dagsocial/node` does not depend on. Two reasons,
// and the second is the load-bearing one:
//
//  1. They appear in the signature of every writer and reader here. Without
//     them a consumer can still call `encodeStruct`/`decodeStruct` — the
//     `ByteWriter` is internal to those — but cannot name the type of a
//     `StructCodec`'s own `write` parameter, so a codec it exports has an
//     inferred type it cannot write down. A convenience.
//  2. **`ReaderError` is required to USE the format correctly, not merely to
//     describe it.** Step 4 of the four-part boundary check is "every caller
//     converts `ReaderError` into a verdict" (TYPES_INTERFACE → The boundary
//     check) — the step that discharges the no-panic invariant at each boundary
//     rather than inside the codec. A caller cannot write that `instanceof`
//     without the class in scope, so withholding it would leave every consumer
//     outside this package structurally unable to perform the one step the
//     contract assigns to callers.
//
// One import path for the whole codec surface.
export {
  VLQ_SENTINEL,
  CodecError,
  writeU8OrThrow,
  readU8,
  writeVlqU,
  readVlqU,
  writeVlqS,
  readVlqS,
  writeVlqU64OrThrow,
  readVlqU64,
  writeHexNOrThrow,
  readHexN,
  writeBytesNOrThrow,
  readBytesN,
  writeLp,
  readLp,
  writeLpUtf8,
  readLpUtf8,
  writeArr,
  readArr,
  writeOpt,
  readOpt,
  enum8,
  encodeStruct,
  decodeStruct,
  firstDifference,
} from './codec.js';
export type { CodecFailure, Enum8, StructCodec } from './codec.js';
export { ByteReader, ByteWriter, ReaderError } from '@dagsocial/wire';

// Serialization
export {
  encodePostCommit,
  decodePostCommit,
  encodePostBody,
  decodePostBody,
  encodeTxPacket,
  decodeTxPacket,
  encodeHeader,
  decodeHeader,
  encodeUtxoTxTree,
  decodeUtxoTxTree,
  utxoTxTreeByteLength,
  encodeOrderingBlock,
  decodeOrderingBlock,
  encodeTx,
  decodeTx,
} from './serialization.js';
export type { TxPacket } from './serialization.js';
