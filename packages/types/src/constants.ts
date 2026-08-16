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
 * authorization defect: `getSubtree` (node's `store/posts.ts`) is a recursive
 * CTE with `UNION`/`DISTINCT` *because* a post could belong to several subtrees
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
 * (`tx.preimages`, `utxoTxs`, the block's three sections) and a bound there
 * would bind all of them.
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
// field; no codec consults these. TYPES_INTERFACE → Size caps carries the byte
// denomination and why neither constant moves when the positional transaction
// form lands.
//
// ⚠ AHEAD OF CODE — nothing enforces either bound yet. The contract assigns the
// body check to `verifyOrderingBlockStructure` and the transaction check to
// `verifyTxStructure`, both in `@dagsocial/validation`.
export const MAX_BLOCK_BODY_BYTES = 2_000_000;   // consensus — encoded UtxoTxTree
export const MAX_TX_BYTES = 10_000;              // consensus — encoded UtxoTransaction

// State format
export const AVL_KEY_LENGTH = 32; // bytes — AVL+ key width; sets the shape of every stateRoot

// PoW
//
// Reserved, never to be reused: `POST_POW_TARGET_BITS`, the profile field
// `postPowTargetBits`, and `CHALLENGE_WINDOW_BLOCKS`. Post PoW and its challenge
// handshake are gone — a post is admitted by the stateful karma lock. Ordering
// -block PoW is unaffected: it is the consensus PoW and always was, and
// consensus is now honestly single-phase.

// Karma decay (periodic burn model)
export const KARMA_POSTING_MINIMUM = 1n;
export const KARMA_STALE_THRESHOLD_BLOCKS = 40320; // 28 days at 60s blocks (duration itself under review — constants-pinning) → profile: karmaStaleThresholdBlocks
export const KARMA_DECAY_INTERVAL_BLOCKS = 1440;   // 24 hours at 60s blocks → profile: karmaDecayIntervalBlocks
export const KARMA_DECAY_AMOUNT = 5n;              // karma burned per interval
export const KARMA_MINIMUM = 10n;                  // floor — decay never reduces below this

// Post lock
export const POST_LOCK_THREAD_COST = 5n;  // Karma locked for new threads
export const POST_LOCK_REPLY_COST = 3n;   // Karma locked for replies
export const POST_LOCK_UNLOCK_PER_LIKES = 10;  // Every N likes unlocks 1 karma

// Likes — one-way burns settled per block (ARCHITECTURE → Per-block accrual and settlement)
export const LIKE_KARMA_COST = 1n;        // Karma burned by the liker per like (bigint)
export const LIKES_PER_KARMA_PAYOUT = 5;  // x: per x likes an author accrues x−1; 1 is burned

// Vouch
export const VOUCH_KARMA_AMOUNT = 1n;         // Karma locked per vouch
export const VOUCH_MIN_BALANCE = 11n;          // Must have >= this to vouch
export const VOUCH_COOLDOWN_BLOCKS = 60;       // Blocks before karma returned → profile: vouchCooldownBlocks

// Invites
//
// `MAX_PENDING_INVITES` and `INVITE_KARMA_THRESHOLD` are **retired — names
// reserved, never reuse** (TYPES_INTERFACE → Invites). The concurrent-invite cap
// needs no successor: an inviter locks `INVITE_BOND_KARMA` out of their own karma
// per invite, so `K / INVITE_BOND_KARMA` bounds them without a rule. The
// threshold went with the early-unlock leg it served — a bond settles once, at
// `IdentityRecord.invitedAtBlock + INVITE_PROBATION_BLOCKS`, and no karma balance
// decides it.
export const INVITE_MIN_KARMA = KARMA_POSTING_MINIMUM;
export const INVITE_KARMA_AMOUNT = 25n;       // Karma MINTED to the invitee at claim
export const INVITE_BOND_KARMA = 25n;          // Karma the inviter locks at creation
export const INVITE_PROBATION_BLOCKS = 43200;  // 30 days at 60s → profile: inviteProbationBlocks
/**
 * Likes the invitee must receive per karma of bond returned — the bond vests
 * `min(floor(IdentityRecord.lifetimeLikesReceived / INVITE_BOND_VEST_PER_LIKES),
 * value)` at the probation deadline and burns the rest (ARCHITECTURE → Bond
 * outcomes).
 *
 * Kept separate from `LIKES_PER_KARMA_PAYOUT` deliberately: the two share a
 * value and nothing else, so collapsing them would make a change to the like
 * dial silently move every bond's vesting.
 */
export const INVITE_BOND_VEST_PER_LIKES = 5;

// Genesis
export const GENESIS_COMMITTEE_KEYS: string[] = []; // → profile: genesisCommitteeKeys
export const GENESIS_KARMA_PER_MEMBER = 1000n; // → profile: genesisKarmaPerMember
export const GENESIS_CREDITS_PER_MEMBER = 10000n * 10n ** 8n;  // 10000 credits in base units → profile: genesisCreditsPerMember
export const BOOTSTRAP_PERIOD_BLOCKS = 10000;  // Blocks before committee dissolution → profile: bootstrapPeriodBlocks

// Credit emission (Ergo-style linear decay) — amounts in base units of 10^-8 credit
export const CREDIT_FIXED_RATE_BLOCKS = 1_051_200;    // ~2 years at 60s blocks → profile: creditFixedRateBlocks
export const CREDIT_INITIAL_REWARD = 100n * 10n ** 8n; // 100 credits per block in fixed-rate period
export const CREDIT_EPOCH_BLOCKS = 129_600;            // ~90 days — reward reduction interval → profile: creditEpochBlocks
export const CREDIT_REWARD_REDUCTION = 2n * 10n ** 8n; // 2 credits reduced per epoch
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
 * `sum(coinbaseOutputs) === income` is exact at apply. The suite asserts the
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

// Ordering block PoW — difficulty in units of 1/256 of a bit, domain [0, 65536]
// (VALIDATION_INTERFACE → orderingPowTarget). Post PoW is not in these units.
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
 * **One number doing three jobs in `@dagsocial/node`, with nothing requiring
 * them to stay equal.** It bounds the fork walk (`findForkPoint` searches at
 * most this many blocks back from our own tip), it sizes the header request
 * fork resolution makes of the competing peer (`MAX_REORG_DEPTH * 2`), and it
 * sets the block-journal retention window
 * (`purgeOldJournals(height - MAX_REORG_DEPTH)`). **Journal retention is the
 * hard bound on how deep a reorg can physically go; the fork walk is policy** —
 * past the retention window the journals are gone and no fork-walk bound
 * reaches them.
 *
 * It is universal rather than per-network for the reason every other constant
 * outside `NetworkProfile` is (TYPES_INTERFACE → Network profiles): a network
 * that compressed it would be a place devnet behaves unlike mainnet.
 *
 * **It lives in this package rather than in node because node's `config.ts`
 * cannot reach a constant declared in `services/fork-resolution.ts`** — that
 * module imports `config` itself, so the edge would close a cycle and drag the
 * store, state and apply graph into config load. A load-time rule keyed on this
 * value, such as refusing a `MAX_PROOF_HISTORY` beneath it, is only expressible
 * with the constant here.
 */
export const MAX_REORG_DEPTH = 20;

// Crypto
/** DER-encoded SPKI prefix for raw Ed25519 32-byte public keys (RFC 8410). */
export const ED25519_SPKI_PREFIX = '302a300506032b6570032100';
