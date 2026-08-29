// Denomination (TYPES_INTERFACE → Denomination): amount constants are bigint;
// count/block/threshold/percentage/bits constants stay number. Credit amounts are
// integer base units of 10^-8 credit (rescaled ×10^8); karma amounts are
// indivisible bigint literals.
//
// Constants marked "→ profile: <field>" are per-network and also live on
// NetworkProfile (network.ts). They stay exported from here until every consumer
// is re-pointed; deleting them now would break consumers.

// Protocol
export const PROTOCOL_VERSION = 1;

// Content limits
export const MAX_CONTENT_BYTES = 300;
/**
 * A post names at most **one** parent (user decision, 2026-08-09).
 *
 * Multi-parent has no use case here beyond spam, and raising this cap reopens an
 * authorization defect: `getSubtreePage` (node's `store/posts.ts`) is a recursive
 * CTE with `UNION` *because* a post could belong to several subtrees
 * at once, so a reply naming parents A and B in different threads is inside A's
 * subtree by that query — and A's author can prune it, deleting a reply that
 * also hangs off B's thread. A cap of 1 keeps subtrees disjoint, so pruning is
 * well-defined and author sovereignty stops at the author's own thread.
 *
 * The **type does not change**: `parentRefs` stays `PostId[]` and the wire
 * layout stays `arr(refs, b32)`, whose size is identical to `opt(b32)`. A
 * singular `parentRef?: PostId` refactor is a clarity change, not a format
 * break, so it is ordinary work available at any time and deliberately not
 * folded into the positional-format migration.
 */
export const MAX_PARENT_REFS = 1;
/**
 * How long a `genesis_proof` box's `payload` may be.
 *
 * **A decode rule, and only there** — the `genesis_proof` arm of
 * `readBoxContentFields` (`utxo.ts`) refuses a longer payload, so such bytes
 * have no decoding at all, the standing an unassigned box tag has. It is
 * per-type: `readLp` is shared by every length-prefixed field in the format
 * (`utxoTxs`, the block's nested sections) and a bound there would bind all of
 * them.
 *
 * It is a **domain** rule and not a memory-safety one. `ByteReader.readBytes`
 * refuses `remaining < n` and throws before allocating, so no length prefix can
 * provoke an allocation whatever this value is.
 *
 * ⚠ **Provisional.** 512 is roughly Ergo's five-register no-premine payload plus
 * headroom, and is derived from no measurement. The three profile payloads are
 * ~35 bytes, so nothing approaches it; `network.test.ts` is what checks them.
 */
export const MAX_GENESIS_PROOF_PAYLOAD_BYTES = 512;

// Size caps — consensus bounds on whole encoded structures. Distinct in kind
// from the content limits above, which are format bounds a codec enforces on one
// field; no codec consults these. TYPES_INTERFACE → Size caps
export const MAX_BLOCK_BODY_BYTES = 2_000_000;   // consensus — encoded UtxoTxTree
export const MAX_TX_BYTES = 10_000;              // consensus — encoded UtxoTransaction; every body element but the last
export const MAX_SETTLEMENT_BYTES = 100_000;     // consensus — the encoded settlement transaction, the body's last element

// Settlement caps — per-block ceilings on state-driven settlement legs.
// TYPES_INTERFACE → Settlement caps
export const MAX_BOND_SETTLEMENTS_PER_BLOCK = 64;
export const MAX_ESCROW_RETURNS_PER_BLOCK = 64;

/**
 * The accepted domain of a box `value` — TYPES_INTERFACE → Box value domain.
 *
 * A box value is a `bigint` in `[0, BOX_VALUE_BOUND)`. The contract makes this
 * the **single statement of that number**: every other package and document
 * cites this constant rather than restating `2⁶³`.
 *
 * ⛔ **The encodable domain and the accepted domain are different, and this
 * package owns only the wider one.**
 *
 *   | encodable — what `vlqU64` and `canonicalBoxBytes` write | `[0, 2⁶⁴)` |
 *   | accepted  — what consensus admits as a box value        | `[0, 2⁶³)` |
 *
 * ⚠ **Nothing here enforces it, and no encoder may.** `writeVlqU64OrThrow` keeps
 * its `[0, 2⁶⁴)` domain, and the golden corpus deliberately carries values above
 * this bound — a vector proving a value encodes is not a claim that consensus
 * accepts it. Enforcement belongs to `@dagsocial/node` and
 * `@dagsocial/validation`, the standing the size caps above already have.
 *
 * **Why the accepted domain is narrower: the ledger is SQLite, and `INTEGER` is
 * a SIGNED 64-bit integer.** A value in `[2⁶³, 2⁶⁴)` encodes cleanly, derives a
 * box id, passes a `u64` check — and cannot be stored: `better-sqlite3` refuses
 * the bind, and `SUM()` over the signed ceiling raises `integer overflow`. A
 * validation domain wider than its storage domain means a validly-encoded box
 * crashes block application instead of being rejected.
 *
 * ✅ **Narrowing is a validation tightening, not a format break.** `vlqU64`
 * writes identical bytes for every value that was ever storable, so no box id
 * and no `stateRoot` moves.
 *
 * ⚠ **Not an economic constraint, and must not be described as one.** `2⁶³ − 1`
 * is 9.2 × 10¹⁸ against supplies measured in thousands.
 */
export const BOX_VALUE_BOUND = 1n << 63n;

// State format
export const AVL_KEY_LENGTH = 32; // bytes — AVL+ key width; sets the shape of every stateRoot

// Karma decay (virtual — ARCHITECTURE → Karma decay)
export const KARMA_POSTING_MINIMUM = 1n;
export const KARMA_STALE_THRESHOLD_BLOCKS = 40320; // 28 days at 60s blocks → profile: karmaStaleThresholdBlocks
export const KARMA_DECAY_INTERVAL_BLOCKS = 1440;   // 24 hours at 60s blocks → profile: karmaDecayIntervalBlocks
export const KARMA_DECAY_AMOUNT = 5n;              // karma burned per interval
export const KARMA_MINIMUM = 10n;                  // floor — decay never reduces below this

// Post price — a post pays a price rather than locking a bond
// (ARCHITECTURE → The post price; CONSTANTS → Post price and likes)
export const POST_PRICE_THREAD = 5n;        // consensus — karma a thread pays to the pool
export const POST_PRICE_REPLY = 3n;         // consensus — karma a reply pays
export const REPLY_AUTHOR_SHARE = 1n;       // consensus — the part of a reply's price the parent's author accrues

// Likes — one-way burns settled per block (ARCHITECTURE → Per-block accrual and settlement)
export const LIKE_KARMA_COST = 1n;        // Karma burned by the liker per like (bigint)
export const LIKES_PER_KARMA_PAYOUT = 5;  // x: per x likes an author accrues x−1; 1 is burned

// Vouch
export const VOUCH_KARMA_AMOUNT = 1n;         // Karma locked per vouch
export const VOUCH_MIN_BALANCE = 11n;          // Must have >= this to vouch
export const VOUCH_COOLDOWN_BLOCKS = 60;       // Blocks before karma returned → profile: vouchCooldownBlocks
// NODE_INTERFACE → Vouch transition rules: a cast's createdAtBlock may lag its
// carrying block by at most this many blocks.
export const VOUCH_CAST_HEIGHT_WINDOW = 5;

// Invites
//
// ⛔ **THE INVITE IS ONE TRANSACTION** (TYPES_INTERFACE → InviteBox;
// `ARCHITECTURE` → Invite System). There is no claim and no cancel: the
// transaction creates a `BondBox`, the block's settlement transaction spends that
// bond's own value out of the karma pool to its `inviteePublicKey`, and
// `IdentityRecord.invitedAtBlock` is the invite's own height.
export const INVITE_MIN_KARMA = KARMA_POSTING_MINIMUM;
/**
 * The bond an inviter locks and — at 1:1 — the karma the invitee is granted out
 * of the pool. The inviter picks any value in `[INVITE_BOND_MIN,
 * INVITE_BOND_MAX]`, and both bounds are per-network.
 *
 * ⛔ **SPENT FROM THE KARMA POOL, and at INVITE CREATION** — the settlement
 * transaction of the block carrying the invite emits the bond's own value to the
 * bond's `inviteePublicKey`.
 *
 * ⚠ **"Minted" is a DIRECTION, not an event** (`ARCHITECTURE` → The conservation
 * axiom, the fixed vocabulary): it means *spent out of the supply pool*, and
 * nothing is created. Under that definition a mint has to name a source, which is
 * why the grant comes out of a `KarmaPoolBox` rather than from nowhere.
 *
 * ⛔ **The grant EQUALS the bond, and that is what makes the bound unbreakable.**
 * An inviter may name 32 bytes nobody holds, stranding the grant in an
 * unspendable box; equality makes that cost exactly what it strands, with no
 * second number free to drift below the first.
 */
export const INVITE_BOND_MIN = 25n;            // → profile: inviteBondMin
export const INVITE_BOND_MAX = 250n;           // → profile: inviteBondMax
/** Blocks from the invite's own creation height to bond settlement. */
export const INVITE_PROBATION_BLOCKS = 43200;  // 30 days at 60s → profile: inviteProbationBlocks
/**
 * Likes the invitee must receive per karma of bond returned — the bond vests
 * `min(floor(IdentityRecord.lifetimeLikesReceived / INVITE_BOND_VEST_PER_LIKES),
 * value)` at the probation deadline and burns the rest (ARCHITECTURE → Bond
 * outcomes).
 *
 * Kept separate from `LIKES_PER_KARMA_PAYOUT` deliberately: the two are
 * independent dials, so collapsing them would make a change to the like dial
 * silently move every bond's vesting.
 *
 * ⛔ **Read against `LIKES_PER_KARMA_PAYOUT` this is the SUPPLY DIAL.** Vesting a
 * bond `B` takes `V·B` likes, and the like settlement returns `1/L` of every
 * karma spent on likes to the pool, so a completed invite moves `B · (1 − V/L)`
 * into circulation. At `V == L` that is exactly zero and the network cannot
 * inflate at all. It is neutral between honest growth and a sybil circle, so it
 * is a supply dial and never a sybil defence.
 */
export const INVITE_BOND_VEST_PER_LIKES = 3;

// Genesis
export const GENESIS_KARMA_PER_MEMBER = 1000n; // → profile: genesisKarmaPerMember
// TYPES_INTERFACE → Genesis: universal, not profile fields — the boxes are
// byte-identical everywhere they are seeded (NODE_INTERFACE → Faucet).
export const SYSTEM_KARMA_INITIAL = 1_000_000n;
export const FAUCET_CREDITS_INITIAL = 100_000n * 10n ** 8n;
// Credit emission (Ergo-style linear decay) — amounts in base units of 10^-8 credit
export const CREDIT_FIXED_RATE_BLOCKS = 1_051_200;    // ~2 years at 60s blocks → profile: creditFixedRateBlocks
export const CREDIT_INITIAL_REWARD = 42n * 10n ** 8n;  // 42 credits per block in fixed-rate period
export const CREDIT_EPOCH_BLOCKS = 470_000;            // ~326 days at 60s blocks — reward reduction interval → profile: creditEpochBlocks
export const CREDIT_REWARD_REDUCTION = 1n * 10n ** 8n; // 1 credit reduced per epoch
/**
 * The `EmissionBox`'s genesis value for mainnet and testnet — CARRIED, never
 * derived (TYPES_INTERFACE → EmissionBox; MINING_INTERFACE → Emission Schedule).
 *
 * Strictly below the curve's own sum (448,820,400 at R=42, d=1, F=1,051,200,
 * E=470,000), so the box empties while the rate is still positive and a
 * returned inclusion bonus always has a draining tail to pass through.
 */
export const CREDIT_EMISSION_TOTAL = 422_640_000n * 10n ** 8n;
export const CREDIT_MINER_REWARD_DELAY = 1440;         // consensus — blocks before coinbase spendable (24h at 60s blocks) → profile: creditMinerRewardDelay
export const MEMPOOL_EXPIRY_BLOCKS = 720;               // Blocks before mempool entries expire (~12h)

/**
 * The coinbase's four slices, as percentages of the block's **income** —
 * `computeBlockReward(height)` plus the deficits its credit transactions left
 * (MINING_INTERFACE → Coinbase Application). Storage rent becomes a third
 * income term without any of these moving.
 *
 * They sum to 100, and nothing in the type system says so: four independent
 * `number`s carry no arithmetic relationship a compiler can check, while
 * the sum of the settlement transaction's coinbase outputs must equal income
 * exactly at apply. The suite asserts the
 * sum, so a retune that moves one and forgets another fails there rather than
 * at the first height no coinbase can satisfy.
 *
 * ⚠ Provisional, all four. TYPES_INTERFACE → Protocol Constants holds the
 * values a live network sets; these are what the reference implementation
 * ships with.
 */
export const COINBASE_TREASURY_PCT = 5;      // Taken per income TERM — of emission and of fees, never of rent
export const COINBASE_MINER_FLOOR_PCT = 35;  // Guaranteed, and takes every remainder the divisions leave
export const COINBASE_BACKER_PCT = 35;       // Scaled by the migrated fraction — nothing stakes, so it falls to the floor
export const COINBASE_BONUS_PCT = 25;        // Earned by including karma-side work; the rest locks in the treasury

/**
 * The inclusion bonus curve's knee: `pool × actors / (actors + K)`, where
 * `actors` counts the distinct owners of the karma boxes a block's karma-side
 * transactions spend (MINING_INTERFACE → Coinbase Application).
 *
 * At `K` actors the miner earns half the pool; the curve is uncapped, so the
 * marginal actor never stops paying and no count is worth zero. A `K` of 0
 * would make it a step instead — 0 at no actors and the whole pool at one.
 *
 * Bigint because it divides a bigint pool. ⚠ Provisional.
 */
export const INCLUSION_BONUS_K = 5n;

/**
 * The share of `maxMempoolEntries` credit entries may occupy; karma-side
 * entries hold the remainder (MEMPOOL_INTERFACE → Eviction, inside the credit
 * class only).
 *
 * The classes are what keep the bonus reachable: every karma-side operation
 * bids zero, so fee-ordered eviction over one pool would displace all of them
 * and leave the coinbase paying for work that can no longer reach the pool.
 * Neither 0 nor 100 is a class boundary — one starves the fee market of a
 * venue, the other is the all-credit pool the boundary exists to prevent.
 *
 * ⚠ Provisional, and unlike the block's byte budget it mirrors no ceiling: an
 * idle pool slot costs nothing, so no measurement forces this number.
 */
export const MEMPOOL_CREDIT_SHARE_PCT = 50;

/**
 * Relay policy: the fee rate beneath which a node refuses a credit transaction
 * (MEMPOOL_INTERFACE → Fee floor).
 *
 * ⚠ **Base units per IN-BLOCK byte, not per encoded byte.** The denominator is
 * what the transaction occupies inside a block body — its `utxoTxIds` entry and
 * its length-prefixed body, which is ~34 bytes more than the bare encoding —
 * because the block budget is the resource a fee competes for. An operator
 * setting this from an encoded size lands stricter than they intended.
 *
 * **Not consensus.** A zero-fee transaction is valid and a miner may mine one
 * (NODE_INTERFACE → `validateTx`). Zero is the shipped default and a decision
 * rather than an omission — eviction already displaces a non-paying entry the
 * moment a paying one arrives, so a nonzero default would refuse traffic the
 * pool can absorb. What ships is the seam, so an operator can raise it under
 * load without a code change and without reorg re-insertion inheriting it.
 */
export const MIN_FEE_RATE_PER_BYTE = 0n;

// Credit floor and storage rent — TYPES_INTERFACE → Box value domain. Both are
// CONSENSUS and both are per byte of the box's own record. Derived from Ergo's,
// scaled by the supply ratio (Ergo's 97,739,924 ERG max against this network's
// 422,640,000 credit emission total), so Ergo's ratio between the two is
// preserved rather than chosen twice. The PERIOD is a profile field
// (`storageRentPeriodBlocks`), not a constant.
export const MIN_BOX_VALUE_PER_BYTE = 156n;        // consensus — credit outputs only
export const STORAGE_RENT_PER_BYTE = 605_378n;     // consensus — charged once per period

// Ordering block PoW — difficulty in units of 1/256 of a bit, domain [0, 65536]
// (VALIDATION_INTERFACE → orderingPowTarget).
//
// 5984/256 = 23.375 bits — 23 + 3/8, which these units carry exactly — or ≈10.88M
// hashes, a 60s solve at one core's measured rate. No whole bit expresses that
// interval: 23 is 46s and 24 is 93s. TYPES_INTERFACE → Ordering block PoW carries
// the derivation.
// ⚠ Provisional: one machine, one thread, standing in for a quantity the
// network's total hashrate sets.
//
// Mainnet's and testnet's only. Devnet sets its own and deliberately lower —
// the reason is in network.ts.
export const ORDERING_BLOCK_POW_TARGET_BITS = 5984;     // → profile: orderingBlockPowTargetBits
// 9 bits — the first whole bit above 2180, below which a 1/256-bit step can buy zero
// work, so a chain beneath it retargets without moving the quantity fork choice selects
// on. This bounds the reachable range rather than the whole admitted one: work stops
// resolving above 63358 as well. VALIDATION_INTERFACE → blockWork / cumulativeWork.
export const ORDERING_BLOCK_POW_TARGET_FLOOR = 2304;

// Chain reorganisation
/**
 * How far back a reorg reaches.
 *
 * TYPES_INTERFACE → Chain reorganisation lists the load-bearing consumers and
 * their roles. **Journal retention is the hard bound on how deep a reorg can
 * physically go; the fork walk is policy** — past the retention window the
 * journals are gone and no fork-walk bound reaches them.
 *
 * It lives in this package rather than in node because node's `config.ts`
 * cannot reach a constant declared in `services/fork-resolution.ts` — that
 * module imports `config` itself, so the edge would close a cycle.
 */
export const MAX_REORG_DEPTH = 20;

/**
 * The `prevBlockHash` a height-1 block carries: 32 zero bytes as 64 hex
 * characters. Heights start at 1, so no header is ever hashed to this value;
 * it is a sentinel by construction, not a digest.
 *
 * TYPES_INTERFACE → Genesis parent hash.
 *
 * ⚠ `store/mempool.ts`'s `PROBE_TX_ID` is the same bytes with a different
 * meaning and is **not** this constant.
 */
export const GENESIS_PREV_BLOCK_HASH = '00'.repeat(32);

// NiPoPoW interlinks — TYPES_INTERFACE → Interlink vector
/** The largest level a block can have (VALIDATION_INTERFACE → level). */
export const LEVEL_CAP = 256;
/** The interlink vector's maximum length: LEVEL_CAP + 1 (the genesis entry). */
export const MAX_INTERLINKS = 257;

// Crypto
/** DER-encoded SPKI prefix for raw Ed25519 32-byte public keys (RFC 8410). */
export const ED25519_SPKI_PREFIX = '302a300506032b6570032100';
