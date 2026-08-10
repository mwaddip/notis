// Protocol constants
export {
  PROTOCOL_VERSION,
  MAX_CONTENT_BYTES,
  MAX_PARENT_REFS,
  AVL_KEY_LENGTH,
  POST_POW_TARGET_BITS,
  CHALLENGE_WINDOW_BLOCKS,
  KARMA_POSTING_MINIMUM,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  POST_LOCK_THREAD_COST,
  POST_LOCK_REPLY_COST,
  POST_LOCK_UNLOCK_PER_LIKES,
  LIKE_KARMA_COST,
  LIKES_PER_KARMA_PAYOUT,
  VOUCH_KARMA_AMOUNT,
  VOUCH_MIN_BALANCE,
  VOUCH_COOLDOWN_BLOCKS,
  MAX_PENDING_INVITES,
  INVITE_MIN_KARMA,
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
  INVITE_PROBATION_BLOCKS,
  INVITE_KARMA_THRESHOLD,
  GENESIS_COMMITTEE_KEYS,
  GENESIS_KARMA_PER_MEMBER,
  GENESIS_CREDITS_PER_MEMBER,
  BOOTSTRAP_PERIOD_BLOCKS,
  CREDIT_FIXED_RATE_BLOCKS,
  CREDIT_INITIAL_REWARD,
  CREDIT_EPOCH_BLOCKS,
  CREDIT_REWARD_REDUCTION,
  CREDIT_TAIL_REWARD,
  CREDIT_MINER_REWARD_DELAY,
  MEMPOOL_EXPIRY_BLOCKS,
  CREDIT_TREASURY_PCT,
  ORDERING_BLOCK_POW_TARGET_BITS,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  ED25519_SPKI_PREFIX,
} from './constants.js';

// Network profiles (P2-A)
export {
  NETWORK_PROFILES,
  profileFor,
  MAGIC_MAINNET,
  MAGIC_TESTNET,
  MAGIC_DEVNET,
  KNOWN_FRAME_MAGICS,
} from './network.js';
export type { NetworkType, NetworkProfile } from './network.js';

// Identity
export { generateKeyPair } from './identity.js';
export type { KeyPair, UserId } from './identity.js';

// Base58
export { base58Encode, base58Decode } from './base58.js';

// Merkle tree
export { leafHash, nodeHash, buildMerkleRoot, hexToBuf } from './merkle.js';

// Posts
export { signingHash, computePostId, verifyPostId, getPostDiscriminator, buildProfileContent, postPowPreimage } from './post.js';
export type { Post, PostId } from './post.js';

// UTXO
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
} from './utxo.js';
export type {
  BoxId,
  BoxCandidate,
  BoxRecord,
  DecodedBoxCandidate,
  CandidateOf,
  AnyBoxCandidate,
  BoxBase,
  BoxGuard,
  MintReason,
  KarmaBox,
  CreditBox,
  InviteBox,
  BondBox,
  PostLockBox,
  VouchBox,
  AnyBox,
  UtxoTransaction,
  TxId,
} from './utxo.js';

// Stumps
export { computePruneEntryId, serializePruneEntry } from './stump.js';
export type { PruneIntent, KarmaDelta, Stump, StumpId, PruneEntry, PruneTrigger } from './stump.js';

// Blocks
export {
  EMPTY_STATE_ROOT,
  MAX_SATISFIABLE_TARGET_BITS,
  cumulativeWork,
  subBlockFromPost,
} from './block.js';
export type {
  SubBlock,
  SubBlockEntry,
  OrderingBlock,
  BlockHeader,
  SubBlockTree,
  UtxoTxTree,
  CoinbaseOutput,
} from './block.js';

// The positional codec layer (`codec.ts`)
//
// The field primitives, `enum8` and the four-part boundary check. Exported
// because every consensus preimage in the repo is written in this notation and
// `types` is not the only package that writes one: node's `serialize-box.ts`
// holds the AVL values, and an AVL box value **IS `boxRecordBytes` exactly** —
// no wrapper, no second tag. Its first byte is already the `boxType` `enum8`
// from the layout above, so a node-side box-type numbering would have been a
// second numbering of one thing, which is the collision Phase 5 found and
// removed. See `NODE_INTERFACE` → Two entity kinds.
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
//     converts `ReaderError` into a verdict" (spec §2.1) — the step that
//     discharges the no-panic invariant at each boundary rather than inside the
//     codec. A caller cannot write that `instanceof` without the class in
//     scope, so withholding it would leave every consumer outside this package
//     structurally unable to perform the one step the spec assigns to callers.
//     Found by Phase 5, from the other direction.
//
// One import path for the whole codec surface.
export {
  VLQ_SENTINEL,
  CodecError,
  writeU8OrThrow,
  readU8,
  writeBool,
  readBool,
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
  encodePost,
  decodePost,
  encodeStump,
  decodeStump,
  encodeSubBlock,
  decodeSubBlock,
  encodeHeader,
  decodeHeader,
  encodeSubBlockTree,
  decodeSubBlockTree,
  encodeUtxoTxTree,
  decodeUtxoTxTree,
  encodeOrderingBlock,
  decodeOrderingBlock,
  encodeTx,
  decodeTx,
} from './serialization.js';
