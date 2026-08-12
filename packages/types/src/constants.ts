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

// State format
export const AVL_KEY_LENGTH = 32; // bytes — AVL+ key width; sets the shape of every stateRoot

// PoW
export const POST_POW_TARGET_BITS = 20; // → profile: postPowTargetBits
export const CHALLENGE_WINDOW_BLOCKS = 10;

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
export const MAX_PENDING_INVITES = 5;
export const INVITE_MIN_KARMA = KARMA_POSTING_MINIMUM;
export const INVITE_KARMA_AMOUNT = 25n;       // Karma transferred in InviteBox
export const INVITE_BOND_KARMA = 25n;          // was 10
export const INVITE_PROBATION_BLOCKS = 1000;   // → profile: inviteProbationBlocks
export const INVITE_KARMA_THRESHOLD = 20n;

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
export const CREDIT_TAIL_REWARD = 2n * 10n ** 8n;      // 2 credits flat reward after emission ends
export const CREDIT_MINER_REWARD_DELAY = 720;          // Blocks before coinbase is spendable (~12h) → profile: creditMinerRewardDelay
export const MEMPOOL_EXPIRY_BLOCKS = 720;               // Blocks before mempool entries expire (~12h)
export const CREDIT_TREASURY_PCT = 10;                 // Percent of each reward to treasury

// Ordering block PoW — difficulty in units of 1/256 of a bit, domain [0, 65536]
// (VALIDATION_INTERFACE → orderingPowTarget). Post PoW is not in these units.
//
// 5983/256 = 23.37 bits ≈ 10.8M hashes, a ~60s solve at one core's measured rate.
// No whole bit expresses that interval — 23 is 46s and 24 is 93s — so the value
// is not a multiple of 256, and the fractional units are what carry it.
// ⚠ Provisional: one machine, one thread, standing in for a quantity the
// network's total hashrate sets.
//
// Mainnet's and testnet's only. Devnet sets its own and deliberately lower —
// TYPES_INTERFACE → Ordering block PoW, and the reason is in network.ts.
export const ORDERING_BLOCK_POW_TARGET_BITS = 5983;     // → profile: orderingBlockPowTargetBits
// 9 bits — the first whole bit above 2180, below which a 1/256-bit step can buy zero
// work, so a chain beneath it retargets without moving the quantity fork choice selects
// on. This bounds the reachable range rather than the whole admitted one: work stops
// resolving above 63358 as well. VALIDATION_INTERFACE → blockWork / cumulativeWork.
export const ORDERING_BLOCK_POW_TARGET_FLOOR = 2304;

// Crypto
/** DER-encoded SPKI prefix for raw Ed25519 32-byte public keys (RFC 8410). */
export const ED25519_SPKI_PREFIX = '302a300506032b6570032100';
