# Constants — the register

**Every number a launch decides or a second implementation must agree on, in one place, each with
what argues it.** The rule behind a number lives in the contract that states it and is cited here;
the number's *standing* — ruled, derived, provisional, or simply chosen — is stated here and nowhere
else. `ARCHITECTURE → What each network is` is the frame: a mainnet number in this repo is not a
decision, and this register says which numbers are.

## Scope

In: consensus constants, economics, format bounds, relay and codec bounds, every numeric
`NetworkProfile` field on all three networks, and the light client's defaults. Out, and listed
under → Excluded so the test can tell the two apart: wire tags and message codes, identity fields,
local cadences, and the operator's environment config (`NODE_INTERFACE → Configuration` tabulates
that set with its defaults).

## Reading a row

| Column | Holds |
|---|---|
| Name | the identifier as its definition site spells it — `SCREAMING_CASE` is a `constants.ts` (or another package's) export, `camelCase` is a `NetworkProfile` field |
| Value | **the value as JavaScript evaluates the code's expression**, in a code span — a decimal integer, `_` group separators allowed, `n` for a bigint, nothing else in the cell. `42n * 10n ** 8n` is written `4_200_000_000n`. The one list-valued field, `protocolVersionSchedule`, writes its eras as `version@fromHeight` pairs, comma-separated, in order — `1@0`, `1@0, 2@43200` |
| Reads as | the human quantity — hours, credits, bytes |
| Kind | `consensus` (block validity), `policy` (a producer's or relay's choice that consensus does not check), `format` (a codec bound), `local`; `→ profile` after it marks a constant a `NetworkProfile` field reads |
| Argument | what produces the number: a formula, a dated measurement, a dated ruling — or *none stated* |
| Status | one of the six below |
| Rule | the contract section that states the rule the number serves |

| Status | Meaning |
|---|---|
| **RULED** | set by a user ruling, dated |
| **DECIDED** | set by a recorded design decision, dated |
| **DERIVED** | a stated formula or measurement produces it from other numbers |
| **PROVISIONAL** | marked provisional or placeholder where it is defined — testnet's input, not a decision |
| **CHOSEN** | no derivation, ruling or marker on record — the class this register exists to make visible |
| **DOMAIN** | a fact of the format or the arithmetic, not a tunable |

**Per-network rows carry three value cells — mainnet · testnet · devnet — in that order.** The
argument column on those rows is devnet's, because devnet is the only network whose values are
derived rather than carried; mainnet's are the universal constants, and testnet's differ from
mainnet's on exactly the cells that say so.

## The drift test

A value copied into a table is a second source of truth. `packages/node/test/constants-register.test.ts`
reads this file and pins it to the code:

1. every row whose first cell is exactly a backticked `SCREAMING_CASE` name is exported by exactly
   one of `@dagsocial/types`, `@dagsocial/net`, `@dagsocial/nipopow`, with the value the cell states;
2. every row whose first cell is a backticked `camelCase` name is a `NetworkProfile` field whose three
   values are `NETWORK_PROFILES.mainnet`, `.testnet`, `.devnet` in that order — `protocolVersionSchedule`'s
   cells as the `version@fromHeight` list the field holds;
3. the converse — every `number` or `bigint` export of those three barrels, and every numeric field of
   every profile, is either such a row or a name listed under → Excluded. A constant added without a
   register row fails here, and so does a row whose constant is renamed away.

A first cell with anything after the backticked name — `(wire)`, `(literal)`, `(default)` — is
outside the test, and the section it sits in says what pins it instead. `@dagsocial/wire` is the
one package the test does not reach: `@dagsocial/node` declares no dependency on it, so its rows are
marked.

The test is the first in the repo to read `contracts/`, and the grammar above is what it parses:
a row's value cell is the code span and nothing else, so a cell that carries anything beside the
value is a grammar failure rather than a skip.

## Universal constants

`@dagsocial/types` → `constants.ts`. Universal means every network carries the same value
(`ARCHITECTURE → What varies per network`); the ones a profile field reads carry **→ profile**
in their Kind cell and appear again under → Per-network values with all three cells.

### Format and domain

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `PROTOCOL_VERSION` | `1` | — | consensus | the highest version this build implements: the handshake declares it and every schedule's last version is bounded by it; no check compares an object against it | DOMAIN | `TYPES_INTERFACE → Version` |
| `MAX_CONTENT_BYTES` | `300` | 300 UTF-8 bytes | consensus | none stated | CHOSEN | `TYPES_INTERFACE → Content limits` |
| `MAX_PARENT_REFS` | `1` | one parent | consensus | user ruling, 2026-08-09 — one parent keeps every thread a tree, so a post belongs to one thread and a subtree's page and count are well-defined | RULED | `TYPES_INTERFACE → Content limits` |
| `MAX_GENESIS_PROOF_PAYLOAD_BYTES` | `512` | 512 bytes | format | roughly Ergo's five-register no-premine payload plus headroom, derived from no measurement; the three profile payloads are ~35 bytes | PROVISIONAL | `TYPES_INTERFACE → Content limits` |
| `USERNAME_MAX_BYTES` | `24` | 24 bytes of `[A-Za-z0-9_]` | consensus | user ruling, 2026-09-09; the alphabet and the lowercase canonical form are ruled with it | RULED | `TYPES_INTERFACE → Content limits` |
| `BOX_VALUE_BOUND` | `9_223_372_036_854_775_808n` | 2⁶³ | consensus | SQLite `INTEGER` is a signed 64-bit integer, so the accepted value domain stops where storage does | DERIVED | `TYPES_INTERFACE → Box value domain` |
| `TREE_KEY_LENGTH` | `65` | 65 bytes | consensus | a one-byte tag and two 32-byte fields, the longest key the tree layout writes (`TYPES_INTERFACE → The tree keys`) | DERIVED | `TYPES_INTERFACE → State format` |

### Size caps

Four limits stand in a fixed order — `MAX_BLOCK_BODY_BYTES < MAX_ORDERING_BLOCK_BYTES < MAX_SERVE_BODY_BYTES <
MAX_STREAM_BYTES` — and the order is the rule; the base number is a choice. The three encoded bounds are derived
from the layout and the consensus bounds, and a peer's bytes are weighed against them before a decode
(`NET_INTERFACE → Validation (and untrusted-input safety)`).

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `MAX_BLOCK_BODY_BYTES` | `2_000_000` | 2 MB per block; 1.05 TB/yr at 60 s blocks | consensus | none stated for the number; the two net caps above it derive from it | CHOSEN | `TYPES_INTERFACE → Size caps` |
| `MAX_TX_BYTES` | `10_000` | ~148 credit inputs | consensus | argued for *existence* — a transaction may not be valid, poolable and unminable at once — not for the number | CHOSEN | `TYPES_INTERFACE → Size caps` |
| `MAX_SETTLEMENT_BYTES` | `100_000` | 5 % of the body; ≈ 2 700 like markers after the capped legs | consensus | two relations are the rule (fits a legal body; an empty-body settlement at every cap fits it — 17 395 bytes measured with the three capped legs at 64 and every paid owner a distinct identity holding an income box, `consensus`' `settlement-bound.test.ts`); the number is provisional | PROVISIONAL | `TYPES_INTERFACE → Size caps` |
| `MAX_HEADER_BYTES` | `233` | the longest encoded header; a realistic one is 208 | policy | 193 fixed bytes and five `vlqU` fields at 8 bytes, the longest a reader accepts — held by encoding the ceiling header | DERIVED | `TYPES_INTERFACE → Size caps` |
| `MAX_ORDERING_BLOCK_BYTES` | `2_000_302` | the longest encoded block whose body is within `MAX_BLOCK_BODY_BYTES` | policy | `lp(header)` + `lp(body)` + the 64-byte signature, each at its ceiling — held by encoding that block | DERIVED | `TYPES_INTERFACE → Size caps` |
| `MAX_TX_PACKET_BYTES` | `10_303` | the longest gossiped transaction packet | policy | `MAX_TX_BYTES` + `opt(lpUtf8)` of `MAX_CONTENT_BYTES`, 303 — held by encoding that packet | DERIVED | `TYPES_INTERFACE → Size caps` |

### Settlement caps

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `MAX_BOND_SETTLEMENTS_PER_BLOCK` | `64` | bonds settled per block | consensus | a backlog of `n` drains in ⌈n / 64⌉ blocks; 64 is provisional | PROVISIONAL | `TYPES_INTERFACE → Settlement caps` |
| `MAX_ESCROW_RETURNS_PER_BLOCK` | `64` | escrows returned per block | consensus | same | PROVISIONAL | `TYPES_INTERFACE → Settlement caps` |
| `MAX_LAPSE_WITHDRAWALS_PER_BLOCK` | `64` | vouches of lapsed members withdrawn per block | consensus | same; a cascade runs one generation per block on top | PROVISIONAL | `TYPES_INTERFACE → Settlement caps` |

### The block's cost

The three numbers of a block's cost (`TYPES_INTERFACE → The block's cost`): a signature's weight, a tree operation's,
and the budget. **The ruling they serve** (user, 2026-09-27): a full block verifies in about 6 s in Waterfox 140 — the
extension's Firefox floor — with about 6 000 signatures and a proof of at most about 6 MB. A signature checked in the
body's batch costs 0.85 ms there (`CONSENSUS_INTERFACE → Cost`), so 6 000 of them are about 5.1 s before any tree
operation. **Each measurement in the table below is over the bench's own small tree.** Over a tree of 10⁶ leaves the
one-signer body proves in 8.28 MB, and its replay's tree operations alone take 3.1 s on Node 22
(`CONSENSUS_INTERFACE → Cost`) — past the ruling's 6 MB, and unmeasured in a browser; no client waits on it while
none replays a block (`CONSENSUS_INTERFACE → The tree session`).

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `W_SIG` | `100` | a signature's weight | consensus | measured 2026-10-27 in Waterfox 140: a signature ~1.1 ms of the batch, an operation 36–47 µs (`CONSENSUS_INTERFACE → Cost`) | PROVISIONAL | `TYPES_INTERFACE → The block's cost` |
| `W_OP` | `10` | a tree operation's weight — a lookup or a write | consensus | above time and size, kept at 10 by the user's ruling 2026-10-27: by time an operation is ~1/24–1/30 of a signature (~3–4), by the proof's size (~73 bytes an operation of the wide consolidations, a proof near 6 MB at the budget) ~7; at 10 the largest proof of the bodies the rules admit measured over the bench's own tree is 4.34 MB (4.14 MiB), and over a 10⁶-leaf tree an operation is 291 bytes of proof | PROVISIONAL | `TYPES_INTERFACE → The block's cost` |
| `MAX_BLOCK_COST` | `600_000` | 6 000 signatures' worth; a valid body ~4 600 signatures packed or 3 156 one-signer sends; ≤ 60 000 tree operations | consensus | measured 2026-10-27 at the budget in Waterfox 140: 5.25 s for the one-signer body, 3.68 s and 4.34 MB for the wide consolidations, 3.49 s for the rent collections — within the ruling's about 6 s | PROVISIONAL | `TYPES_INTERFACE → The block's cost` |

### Karma

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `KARMA_STALE_THRESHOLD_BLOCKS` | `40320` | 28 days at 60 s | consensus → profile | user ruling, 2026-08-19: 28 days | RULED | `TYPES_INTERFACE → Network profiles` |
| `KARMA_DECAY_INTERVAL_BLOCKS` | `1440` | 24 h at 60 s | consensus → profile | none stated for the duration; the unit is 60-second blocks | CHOSEN | `TYPES_INTERFACE → Karma` |
| `KARMA_DECAY_AMOUNT` | `5n` | 5 karma per period | consensus | none stated | CHOSEN | `ARCHITECTURE → Karma decay` |
| `KARMA_MINIMUM` | `10n` | the decay floor, and the karma only a post spends | consensus | none stated for the number; its use for posting alone is the user's ruling, 2026-10-11 | CHOSEN | `ARCHITECTURE → Karma decay` |

### Post price and likes

`ARCHITECTURE → Like parameters` marks the like rows as placeholders; the price rows are ruled.

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `POST_PRICE_THREAD` | `5n` | karma a thread pays to the pool | consensus | user ruling, 2026-08-29 | RULED | `ARCHITECTURE → The post price` |
| `POST_PRICE_REPLY` | `3n` | karma a reply pays | consensus | user ruling, 2026-08-29 | RULED | `ARCHITECTURE → The post price` |
| `REPLY_AUTHOR_SHARE` | `1n` | the part of a reply's price the parent's author accrues | consensus | user ruling, 2026-08-29 — a 33 % channel to the parent, below the like's 80 %, so no arbitrage | RULED | `ARCHITECTURE → The post price` |
| `LIKE_KARMA_COST` | `1n` | 1 karma per like | consensus | the indivisible unit — no smaller like is expressible; the `B · (1 − V/L)` supply arithmetic holds under exactly this value | PROVISIONAL | `ARCHITECTURE → Like parameters` |
| `LIKES_PER_KARMA_PAYOUT` | `5` | `x`: an author accrues `x − 1` per `x` likes, 1 burns | consensus | `1/x` = 20 % burn is the deflation dial; placeholder | PROVISIONAL | `ARCHITECTURE → Like parameters` |

### Usernames

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `USERNAME_BURN_PRICE` | `10n` | karma a burn pays to the pool | consensus | user, 2026-09-09 — a placeholder, marked so where it is defined | PROVISIONAL | `ARCHITECTURE → Usernames` |

### Vouch

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `VOUCH_KARMA_AMOUNT` | `1n` | one vote stakes 1 karma | consensus | user ruling, 2026-08-07 | RULED | `NODE_INTERFACE → Vouch transition rules` |
| `VOUCH_MIN_BALANCE` | `11n` | summed karma balance to cast | consensus | `KARMA_MINIMUM + VOUCH_KARMA_AMOUNT` — the floor every spend but a post leaves, and the stake | DERIVED | `NODE_INTERFACE → Vouch transition rules` |
| `VOUCH_COOLDOWN_BLOCKS` | `60` | 1 h at 60 s | consensus → profile | none stated | CHOSEN | `ARCHITECTURE → Vouch boxes` |
| `VOUCH_CAST_HEIGHT_WINDOW` | `5` | a vouch output's `createdAtBlock` may lag its carrying block by at most 5 | consensus | protocol-level, the same on every network — never a profile field; none stated for the number | CHOSEN | `NODE_INTERFACE → Vouch transition rules` |

### Membership

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `MEMBER_LIKES_MULTIPLIER` | `2` | `Y = 2 · D` — likes from members a newcomer needs beside the vouches | consensus | none stated for the number; testnet's to tune | PROVISIONAL | `ARCHITECTURE → Membership` |

### Invites

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `INVITE_BOND_MIN` | `100n` | the cheapest bond, and the smallest grant | consensus → profile | accepted 2026-08-29 as provisional, tuned on testnet; `G = B` keeps every ratio | PROVISIONAL | `TYPES_INTERFACE → Invites` |
| `INVITE_BOND_MAX` | `250n` | the largest bond | consensus → profile | placeholder weight | PROVISIONAL | `TYPES_INTERFACE → Invites` |
| `INVITE_PROBATION_BLOCKS` | `43200` | 30 days at 60 s | consensus → profile | decided 2026-08-14: an absolute one-month clock from the invite, so an inviter's exposure is time-bounded | DECIDED | `ARCHITECTURE → Bond outcomes` |
| `INVITE_BOND_VEST_PER_LIKES` | `3` | `V`: likes received per karma of bond vested | consensus | decided 2026-08-18 as the supply dial: with `L = 5` a completed invite moves `0.4 · B` into circulation. ⚠ The cost-gated-emission floor (burn-to-vest ≥ grant) is met at `V = 5`, where that figure is zero; 3 sits below it by choice | DECIDED | `ARCHITECTURE → Invite System` |

### Genesis

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `GENESIS_KARMA_PER_MEMBER` | `1000n` | karma per committee key, out of the pool | consensus → profile | none stated | CHOSEN | `ARCHITECTURE → Genesis` |
| `SYSTEM_KARMA_INITIAL` | `1_000_000n` | the faucet identity's karma at genesis, on the networks whose profile names a `faucetPublicKey` | consensus | capacity is this divided by the bond it chooses — 1 000 invites at testnet's ceiling, 10 000 at the floor; it does not replenish | CHOSEN | `NODE_INTERFACE → Faucet` |
| `FAUCET_CREDITS_INITIAL` | `10_000_000_000_000n` | 100 000 credits, seeded beside the karma | consensus | none stated | CHOSEN | `NODE_INTERFACE → Faucet` |

### Credit emission

Amounts are base units of 10⁻⁸ credit (`TYPES_INTERFACE → Denomination`).

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `CREDIT_FIXED_RATE_BLOCKS` | `1_051_200` | 2 years at 60 s | consensus → profile | decided 2026-08-25: two years at `R` before the decay begins | DECIDED | `MINING_INTERFACE → Emission Schedule` |
| `CREDIT_INITIAL_REWARD` | `4_200_000_000n` | 42 credits per block | consensus | decided 2026-08-25: a ~30-year minimum runway at a fixed total — 422 640 000 ÷ 15 778 800 blocks ≈ 26.8 credits/block average — with a positive rate at exhaustion; `R` is what gives | DECIDED | `MINING_INTERFACE → Emission Schedule` |
| `CREDIT_EPOCH_BLOCKS` | `470_000` | ~326 days | consensus → profile | decided 2026-08-25, with `R` | DECIDED | `MINING_INTERFACE → Emission Schedule` |
| `CREDIT_REWARD_REDUCTION` | `100_000_000n` | 1 credit per epoch; 41 epochs on every network | consensus | decided 2026-08-25, with `R` | DECIDED | `MINING_INTERFACE → Emission Schedule` |
| `CREDIT_EMISSION_TOTAL` | `42_264_000_000_000_000n` | 422 640 000 credits — 94.2 % of the curve's 448 820 400 | consensus → profile | carried, never derived; the rule is *strictly below the curve's sum*, so a returned bonus has a paying tail to drain through; exhaustion at block 15 591 163 (~29.6 y) at rate 11 | DECIDED | `MINING_INTERFACE → Emission Schedule` |
| `CREDIT_MINER_REWARD_DELAY` | `1440` | 24 h before a coinbase output spends | consensus → profile | none stated for the duration | CHOSEN | `MINING_INTERFACE → Emission Schedule` |
| `MEMPOOL_EXPIRY_BLOCKS` | `720` | ~12 h | local | none stated | CHOSEN | `TYPES_INTERFACE → Mempool and encoding` |

### Coinbase and the pool

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `COINBASE_TREASURY_PCT` | `5` | of emission and of fees, never of rent | consensus | provisional; the four slices sum to 100, asserted in the types suite | PROVISIONAL | `MINING_INTERFACE → Coinbase Application` |
| `COINBASE_MINER_FLOOR_PCT` | `35` | guaranteed, takes every remainder | consensus | provisional | PROVISIONAL | `MINING_INTERFACE → Coinbase Application` |
| `COINBASE_BACKER_PCT` | `35` | the cap on the aggregate backer claim, of emission and of fees | consensus | provisional; may be tuned down between the snapshot and go-live if little supply locks (user, 2026-09-12) | PROVISIONAL | `MINING_INTERFACE → The backer pool` |
| `BACKER_UNSTAKE_MIN_PCT` | `1` | a partial unstake retires at least 1 % of its stake — the spam bound on a fee-less transaction | consensus | proposed 2026-09-12 with the unit; no ruling | PROVISIONAL | `NODE_INTERFACE → Backer transition rules` |
| `COINBASE_BONUS_PCT` | `25` | the inclusion bonus pool | consensus | provisional | PROVISIONAL | `MINING_INTERFACE → Coinbase Application` |
| `INCLUSION_BONUS_K` | `5n` | the curve's knee: half the pool at 5 actors | consensus | provisional; uncapped and hyperbolic by design, only the knee is a number | PROVISIONAL | `MINING_INTERFACE → Coinbase Application` |
| `MEMPOOL_CREDIT_SHARE_PCT` | `50` | credit entries' share of the pool | policy | provisional; mirrors no ceiling — an idle pool slot costs nothing, so no measurement forces it | PROVISIONAL | `MEMPOOL_INTERFACE → Eviction` |
| `MIN_FEE_RATE_PER_BYTE` | `0n` | the relay floor, per in-block byte | policy | zero is the decision: eviction displaces a non-paying entry the moment a paying one arrives, so a nonzero default refuses traffic the pool can absorb | DECIDED | `MEMPOOL_INTERFACE → Fee floor` |

### Credit floor and storage rent

Both are Ergo's, scaled by the supply ratio 422 640 000 / 97 739 924, so Ergo's 3 889× ratio between
them is preserved rather than chosen twice. Both move if `CREDIT_EMISSION_TOTAL` moves.

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `MIN_BOX_VALUE_PER_BYTE` | `156n` | a 100-byte credit box holds ≥ 0.000156 credits | consensus | Ergo's 360 nanoERG per byte = 3.68 × 10⁻¹⁵ of its max supply, × 422 640 000 credits = 155.7 → 156 | DERIVED | `TYPES_INTERFACE → Box value domain` |
| `STORAGE_RENT_PER_BYTE` | `605_378n` | a 100-byte box pays 0.605 credits per period | consensus | Ergo's ~0.14 ERG per period on a ~100-byte box = 1.43 × 10⁻¹¹ of max supply per byte, × 422 640 000 credits | DERIVED | `MINING_INTERFACE → Emission Schedule` |

### Ordering-block PoW

Units of 1/256 of a bit (`VALIDATION_INTERFACE → orderingPowTarget`).

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `ORDERING_BLOCK_POW_TARGET_BITS` | `5984` | **the anchor's bits** — 23.375 bits, a 60 s solve at 181 262 H/s; the schedule moves from here | consensus → profile | measured: 60 s × 181 262 H/s = 10 875 720 hashes, log₂ = 23.3746 bits, × 256 = 5983.9 → 5984. One machine, one thread, standing in for the network's total | PROVISIONAL | `TYPES_INTERFACE → Ordering block PoW` |
| `ORDERING_BLOCK_POW_TARGET_FLOOR` | `2304` | 9 whole bits — the resolution floor every profile floor must clear | consensus | the first whole bit above 2180, beneath which a 1/256-bit step buys zero work and difficulty moves while `cumulativeWork` does not | DERIVED | `VALIDATION_INTERFACE → blockWork / cumulativeWork` |
| `RETARGET_HALFLIFE_BLOCKS` | `288` | the ASERT halflife in ideal intervals — 4.8 h at 60 s | consensus | the reference's ratio of halflife to block time (BCH: 172 800 s / 600 s); the response time constant is ≈ 1.44 halflives, ~7 h to a halving of hashrate | PROVISIONAL | `MINING_INTERFACE → Difficulty Schedule` |
| `MAX_FUTURE_DRIFT_MS` | `600_000` | 10 min — the future bound on `createdAt` | policy | an absolute schedule caps what a lying or fast clock buys at `skew / ideal` = 10 blocks ever; a slow honest clock bounces blocks for at most that long | PROVISIONAL | `MINING_INTERFACE → Header timestamp rules` |
| `POW_TARGET_BITS_MAX` | `65_536` | 256 bits — the top of `powTargetBits`' domain | consensus | 256 × 256: a target of 256 bits is the whole digest space | DOMAIN | `TYPES_INTERFACE → Ordering block PoW` |

### Interlinks

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `LEVEL_CAP` | `256` | the level of a zero PoW hit | consensus | a non-zero hit's level is below the target's bit length, at most 256 | DOMAIN | `TYPES_INTERFACE → Interlinks` |
| `MAX_INTERLINKS` | `257` | the vector's longest form | consensus | `LEVEL_CAP + 1` — one entry per level plus genesis | DERIVED | `TYPES_INTERFACE → Interlinks` |

### Chain reorganisation

No universal constant: the reorg horizon is the profile field `maxReorgDepth` (→ Per-network values).

## Per-network values

`@dagsocial/types` → `network.ts`. Mainnet's cells are the universal constants above; testnet and
devnet differ where a cell says so. The identity fields — `magic`, `genesisCommitteeKeys`,
`faucetPublicKey`, `genesisProofPayload`, `genesisStateRoot`, `genesisId` — are not register rows
(→ Excluded): they name a network rather than tune one.

| Field | mainnet | testnet | devnet | Axis | Argument (devnet's cell) | Status | Rule |
|---|---|---|---|---|---|---|---|
| `orderingBlockPowTargetBits` | `5984` | `5984` | `3072` | difficulty — **the anchor's bits** | the node suite mines real PoW against the profile it resolves: 5984 costs it ~141 minutes per run, 3072 is ~4K hashes a solve; and ≥ 2180 so the schedule is exercised above the dead zone | DERIVED | `TYPES_INTERFACE → Ordering block PoW` |
| `orderingBlockIdealMs` | `60_000` | `60_000` | `60_000` | timescale | the interval every "at 60 s" row in this register assumes; the schedule aims at it and the halflife is `RETARGET_HALFLIFE_BLOCKS` of it | DERIVED | `MINING_INTERFACE → Difficulty Schedule` |
| `orderingBlockPowTargetFloorBits` | `5120` | `5120` | `2304` | cap | devnet sits at the resolution floor so its tests stay near-free; 20 bits on testnet and mainnet prices a paused chain's owed catch-up block at ~1.4 s of one core, and 8× easier than the anchor is the most a hashrate collapse can ask; also the relay floor — the ordering-block topic validator forwards nothing below it (`NET_INTERFACE → Consensus parameters net enforces`) | PROVISIONAL | `MINING_INTERFACE → Difficulty Schedule` |
| `orderingBlockPowTargetCeilingBits` | `65536` | `65536` | `4096` | cap | devnet's 16 whole bits (~65 K hashes a solve at worst) is the test-cost cap that lets it run the same mechanic; 65536 is the domain's top, "unbound", where hashrate may grow | PROVISIONAL | `MINING_INTERFACE → Difficulty Schedule` |
| `karmaDecayIntervalBlocks` | `1440` | `1440` | `3` | timescale | a short-run value that makes decay fire inside a devnet run | CHOSEN | `TYPES_INTERFACE → Network profiles` |
| `karmaStaleThresholdBlocks` | `40320` | `40320` | `500` | timescale | keeps staleness reachable inside a suite | CHOSEN | `TYPES_INTERFACE → Network profiles` |
| `vouchCooldownBlocks` | `60` | `60` | `3` | timescale | the shortest wait that still spans block boundaries | DERIVED | `TYPES_INTERFACE → Network profiles` |
| `inviteProbationBlocks` | `43200` | `43200` | `540` | timescale | above `karmaStaleThresholdBlocks`, so decay fires during probation on devnet as it does on mainnet — the property, not a ratio | DERIVED | `TYPES_INTERFACE → Network profiles` |
| `creditMinerRewardDelay` | `1440` | `1440` | `10` | timescale | small enough to spend, large enough to observe immaturity | CHOSEN | `TYPES_INTERFACE → Network profiles` |
| `minimumChainWork` | `0n` | `0n` | `0n` | cap | the least work a best chain's tip carries before a block is fetched along it; a fresh chain carries none, and a release cut on a running chain sets it to the live tip's work (user, 2026-10-16) | RULED | `TYPES_INTERFACE → Network profiles` |
| `maxReorgDepth` | `60` | `240` | `40` | timescale | the reorg horizon — how far below the tip a fork may be followed; it prices journals, AVL versions and a reorg's memory against how long a partition may last before it is permanent. Testnet's four hours is the user's "a few hours, not days" (2026-08-29); mainnet's is a placeholder until testnet argues one; devnet's lets the e2e fork chapter converge at ~30 deep and strand at ~45 | PROVISIONAL | `TYPES_INTERFACE → Chain reorganisation` |
| `creditFixedRateBlocks` | `1_051_200` | `1_051_200` | `1000` | timescale | ~÷1000 so the fixed-rate → decay transition is reachable | CHOSEN | `TYPES_INTERFACE → Network profiles` |
| `creditEpochBlocks` | `470_000` | `470_000` | `400` | timescale | fixed-rate ≈ 2.5 × epoch, preserving mainnet's ordering (epoch < fixed-rate period) | CHOSEN | `TYPES_INTERFACE → Network profiles` |
| `creditEmissionTotal` | `42_264_000_000_000_000n` | `42_264_000_000_000_000n` | `36_200_000_000_000n` | timescale | strictly below devnet's own curve sum of 386 400 credits — the rule every profile's total obeys | DERIVED | `TYPES_INTERFACE → EmissionBox` |
| `storageRentPeriodBlocks` | `2_102_400` | `2_102_400` | `100` | timescale | mainnet: 4 years, exactly `2 × creditFixedRateBlocks`, Ergo's wall clock. Devnet: above the deepest height any e2e scenario reaches — 51, the fork chapter's strand case, measured — with headroom | DERIVED | `ARCHITECTURE → What varies per network` |
| `genesisKarmaPerMember` | `1000n` | `1000n` | `1000n` | genesis | carried from the constant on all three | CHOSEN | `ARCHITECTURE → Genesis` |
| `backerSupply` | `0n` | `100n` | `100n` | genesis | the backer snapshot's total supply — mainnet's is the fill tool's and empty until the snapshot; the test networks' small integers make the leg's vectors hand-checkable, with the cap binding at genesis (40 % and 50 % staked) | CHOSEN | `TYPES_INTERFACE → Network profiles` |
| `inviteBondMin` | `100n` | `100n` | `5n` | cap | a bond of `B` vests in `V · B` likes, so the floor decides whether a fixture can drive one to the end: 5 costs 15 likes | DERIVED | `TYPES_INTERFACE → Invites` |
| `inviteBondMax` | `250n` | `1000n` | `250n` | cap | testnet's is relaxed so a tester arrives with enough karma to post and like freely — a cap, not a mechanic; devnet keeps mainnet's so the range check has both ends to fail against | DECIDED | `TYPES_INTERFACE → Invites` |
| `membershipBarMultiplier` | `10` | `1` | `1` | cap | testnet's and devnet's `1` keep the vouch bar at one while `N` is small — `D(1) = 1`, where `10` gives `D(1) = 2` — so the first earned members need one counted vouch and two member likes; on a chain whose only root is the faucet the first members are conferred, not set, since the faucet neither vouches nor likes (`NODE_INTERFACE → Faucet`); mainnet's `10` is fixed by the user's two anchors (2026-08-28): `D = 10` at 100 members, `100` at 100 000 | DERIVED | `ARCHITECTURE → Membership` |
| `protocolVersionSchedule` | `1@0` | `1@0` | `1@0` | consensus — the era table | one era on every network (user, 2026-08-30); a second row is a ruling, set an upgrade window ahead on the network it lands on, and mainnet's may lag testnet's under one build | DECIDED | `TYPES_INTERFACE → Version` |

## Bounds outside types

### wire

`@dagsocial/wire` — outside the drift test's reach (→ The drift test).

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `MAX_VLQ_BYTES` (wire) | `10` | the longest VLQ | format | ⌈64 / 7⌉; wire's own suite pins it | DERIVED | `WIRE_INTERFACE → Constants` |
| `MAX_ARRAY_LENGTH` (wire) | `16_777_216` | 2²⁴ elements | format | a count cap, not a resource bound — the bytes remaining bound the memory; none stated for the number | CHOSEN | `WIRE_INTERFACE → Constants` |
| `FRAME_VERSION` (wire) | `1` | the framing version | format | the one version | DOMAIN | `WIRE_INTERFACE → Constants` |

### nipopow

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `MAX_NIPOPOW_PARAM` | `128` | the largest `m` and the largest `k` a proof or a request may carry | format | provisional; at `m = k = 6` a million-block proof is 124 PoPowHeaders, 109 KB (219 KB as the route's answer), at the caps 1 718 and 1.5 MB (3.1 MB) — measured 2026-10-15 at the anchor's target — and the prover's work per call grows with `m` | PROVISIONAL | `NIPOPOW_INTERFACE → Constants` |
| `MAX_NIPOPOW_PREFIX` | `16_384` | 2¹⁴ prefix entries | format | ~2m headers per level over ≤ 39 levels is 9 984 at the `m` cap, and the level-0 sweep adds about `21m` at testnet's floor, 2 650: 12 634; 2¹⁴ sits above it with headroom, and moves with `MAX_NIPOPOW_PARAM` | PROVISIONAL | `NIPOPOW_INTERFACE → Constants` |

### validation

`@dagsocial/validation` → `verify.ts` and `ed25519-batch.ts`. The scale of the ordering-target expansion is an implementation
choice, not consensus (`VALIDATION_INTERFACE → What is not consensus`): any expansion satisfying the
predicate agrees with every other on every input, and under-precision is one-sided. Module-private, so
the row is marked; `scripts/miner.mjs` carries a mirror of the declaration that `miner-mirror.test.ts`
holds byte-identical across the whole domain.

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `ORDERING_TARGET_PRECISION` (literal) | `320n` | the scale the fractional-bit factor table is written at | local | the factors' fixed-point precision; under-precision is safe and one-sided. `validation/src/verify.ts` | CHOSEN | `VALIDATION_INTERFACE → What is not consensus` |
| `BATCH_COEFFICIENT_BYTES` (literal) | `16` | 128-bit coefficients | consensus | a batch holding a failing entry passes with probability at most 2⁻¹²⁸, the margin an Ed25519 key already rests on; module-private to `validation/src/ed25519-batch.ts` | CHOSEN | `VALIDATION_INTERFACE → verifyEd25519Batch` |

### net

Relay and codec bounds a peer's messages must respect; a body over one is refused before its first
element is read. `MAX_SERVE_BODY_BYTES` and `MAX_STREAM_BYTES` are the upper two of the size-cap order
under → Size caps.

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `MAX_INV_IDS` | `400` | post-body ids per `ModifierRequest`, bodies per `ModifierResponse` | format | the send-side batch cap, enforced on receipt as well; none stated for the number | CHOSEN | `NET_INTERFACE → ModifierRequest` |
| `MAX_CHAIN_RESPONSE_ITEMS` | `400` | headers per `Headers` page, ids per `GetBlocks` request and blocks per answer | format | the same batch cap as `MAX_INV_IDS`; none stated for the number | CHOSEN | `NET_INTERFACE → Pull Requests` |
| `MAX_LOCATOR_HASHES` | `28` | hashes per `GetHeaders` locator | format | a locator is at most `⌊log₂ tip⌋ + 2` hashes, and a tip is below `MAX_ADVERTISED_HEIGHT` (10⁸ < 2²⁷): `26 + 2` | DERIVED | `NET_INTERFACE → GetHeaders / GetBlocks responses` |
| `MAX_SERVE_BODY_BYTES` | `4_194_304` | 4 MiB per served response | policy | half of `MAX_STREAM_BYTES`, so a response fits the read cap at the other end; above `MAX_ORDERING_BLOCK_BYTES`, so one legal block always fits | DERIVED | `NET_INTERFACE → Validation` |
| `MAX_STREAM_BYTES` | `8_388_608` | 8 MiB buffered per inbound stream | format | twice the largest legitimate message; the base number is none stated | CHOSEN | `NET_INTERFACE → Validation` |
| `MAX_PEERS_ENTRIES` | `64` | entries per `Peers` response | format | none stated; 8 are served | CHOSEN | `NET_INTERFACE → Peers` |
| `MAX_CAPABILITY_ENTRIES` | `64` | capability codes per handshake or entry | format | against a 17-row code table | CHOSEN | `NET_INTERFACE → Handshake` |
| `MAX_CAPABILITY_CODE` | `65_535` | the largest capability code | format | 2¹⁶ − 1 | DOMAIN | `NET_INTERFACE → Handshake` |
| `MAX_NAME_BYTES` | `255` | `agentName` / `nodeName` | format | none stated | CHOSEN | `NET_INTERFACE → Handshake` |
| `MAX_ADDRESS_BYTES` | `255` | a multiaddr | format | none stated | CHOSEN | `NET_INTERFACE → Handshake` |
| `MAX_ADVERTISED_HEIGHT` | `100_000_000` | ~190 years at one block a minute | format | a horizon no honest chain reaches | DERIVED | `NET_INTERFACE → Validation` |
| `GET_PEERS_RESPONSE_LIMIT` | `8` | peers served per `GetPeers` | policy | none stated | CHOSEN | `NET_INTERFACE → Peers` |
| `SYNC_INFO_MIN_INTERVAL_MS` | `100` | 100 ms between the `SyncInfo`s acted on from one peer | policy | user ruling, 2026-10-15 — Ergo's `PerPeerSyncLockTime`; an honest peer sends one at peer-active, one per poll and a reply to each of ours it acts on | RULED | `NET_INTERFACE → Serve Side` |
| `MAX_INBOUND_SYNC_STREAMS` | `16` | sync streams of one connection open at once | policy | decided 2026-10-15 — over three times the five an honest peer holds open toward this node — a `SyncInfo` and four queries (headers, blocks, post bodies, peers), each kind one at a time; a waiting stream is unread and costs at most the muxer's 256 KiB initial window, so 16 cost 4 MiB a connection | DECIDED | `NET_INTERFACE → Stream Protocols` |
| `STALL_MARK_EXPIRY_MS` | `1_800_000` | 30 minutes a stall mark stands | policy | decided 2026-10-17: with each of `maxPeers` (50) outbound peers returning as its mark expires, each return holds the gate at most one header deadline (`SYNC_REQUEST_TIMEOUT_MS`, 10 s) — 50 × 10 s = 500 s, under 1 800 s, so the gate still holds; a stream of fresh peer ids is bounded by the outbound manager's dial cadence | DECIDED | `NET_INTERFACE → Stall Detection` |
| `MAX_STALL_MARKS` | `1_024` | stall marks kept by peer id | policy | decided 2026-10-17: about 100 B an entry, so about 100 KB; dropping the oldest lets a peer back early only behind 1 024 newer stallers | DECIDED | `NET_INTERFACE → Stall Detection` |
| `MAX_HANDSHAKE_FRAME_BYTES` | `984` | bytes of the longest handshake frame | format | a 972-byte body at every field's bound — `agentName` and `nodeName` at 255 bytes behind two-byte lengths, `declaredAddress` the same behind its `opt` byte, 64 capabilities at 65 535 behind a one-byte count, `protocolVersion` at 65 535 and `chainHeight` at `MAX_ADVERTISED_HEIGHT` — in a frame 12 bytes longer | DERIVED | `NET_INTERFACE → Handshake Body` |
| `MAX_INBOUND_HANDSHAKE_STREAMS` | `1` | handshake streams of one connection open at once | policy | an honest dialler opens one on each connection it dials and none on one it accepted | DERIVED | `NET_INTERFACE → Handshake` |
| `HANDSHAKE_DEADLINE_FACTOR` | `3` | a connection's handshake deadline, in `syncRequestTimeoutMs` — 30 s at `SYNC_REQUEST_TIMEOUT_MS`' default | policy | the dialler's round trip at its longest: the stream's open, the write and the read, each under `syncRequestTimeoutMs` | DERIVED | `NET_INTERFACE → Handshake` |
| `MAX_TRACKED_SCORES` | `1_024` | penalty scores kept by peer id | policy | decided 2026-10-19: about 100 B an entry, so about 100 KB, as `MAX_STALL_MARKS`; a fresh peer id starts at zero whatever the map keeps, so a dropped entry grants nothing a new id could not take | DECIDED | `NET_INTERFACE → Accrual and decay` |
| `MAX_TRACKED_BANS` | `10_000` | banned peer ids kept | policy | none stated for the number; a ban keys on a peer id, which regenerates freely, so the set is a bounded hint | CHOSEN | `NET_INTERFACE → Ban surfaces are unified` |
| `MAX_BANNED_ADDRS` | `10_000` | banned addresses kept | policy | none stated for the number; the address surface of the same bounded hint | CHOSEN | `NET_INTERFACE → Ban surfaces are unified` |
| `GOSSIP_SEEN_WINDOW_MS` | `120_000` | two minutes a gossip message's id stays seen | policy | gossipsub's default, kept; above the five heartbeats — five seconds — a message stays in a peer's gossip cache; none stated for the number | CHOSEN | `NET_INTERFACE → Gossip Topics` |
| `MISBEHAVIOR_SCORE` | `100` | the score one `Misbehavior` penalty accrues — five at one instant ban, one more for each decay interval they spread across | policy | one fifth of the ban threshold, and the decay a peer sheds per `PENALTY_DECAY_INTERVAL_MS`, pro rata, so the break-even is one invalid message per interval; none stated for the number | CHOSEN | `NET_INTERFACE → Peer Penalty System` |
| `TRANSIENT_SCORE` | `50` | the score one `Transient` penalty accrues — half a misbehavior | policy | a compatibility mismatch or a refuted claim weighs half an invalid message; none stated for the number | CHOSEN | `NET_INTERFACE → Peer Penalty System` |

### node

`packages/node` — its literals, outside the drift test (→ The drift test).

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `BLOCK_FETCH_WINDOW` (literal) | `400` | blocks the pipeline wants above the applied tip when extending | policy | decided 2026-10-17: one block request's ids (`MAX_CHAIN_RESPONSE_ITEMS`), so what extension stages is at most 400 × `MAX_ORDERING_BLOCK_BYTES` — about 800 MB at the cap, kilobytes a block in practice; a switch's prefix is bounded by work instead (`NODE_INTERFACE → Fork choice decides on verified headers`) | DECIDED | `NODE_INTERFACE → Fork choice decides on verified headers` |
| `SIGNATURE_MEMO_ENTRIES` (literal) | `65_536` | signatures the node remembers as accepted, about 11 MB | policy | user ruling 2026-10-23: 171 B an entry measured (Node 22, the 128-byte key as a one-byte string in a `Set`); ten full blocks' signatures (`MAX_BLOCK_COST`, 6 000 each) rounded up to 2¹⁶, so a pooled transaction's signatures are still held when a block within ten of its admission carries it, in a chain whose blocks run full; a miss costs one check and never another verdict. `node/src/services/signature-memo.ts` | RULED | `NODE_INTERFACE → The signature memo` |

## Producer policy

`packages/node` — a producer's choices on legs consensus does not check. Literals in the creator, so
the drift test's converse does not reach them and the rows are marked.

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `MAX_RENT_TXS_PER_BLOCK` (literal) | `32` | rent collections a producer selects per block | policy | none stated; creator policy on a body-driven leg. `node/src/services/block-creator.ts` | CHOSEN | `NODE_INTERFACE → The settlement transaction` |
| `PACKING_COST_MARGIN` (literal) | `5` | percent of the budget the fill leaves unused against estimates that miss | policy | none stated; chosen so the speculation of the fill, and of the refill under the budget, typically fits. `node/src/services/block-creator.ts` | CHOSEN | `MINING_INTERFACE → Template and submit → "Packing to the budget"` |

## HTTP view bounds

`@dagsocial/types`, served by `packages/node` — the page every list a view returns is cut to (`NODE_INTERFACE →
"Every list a view returns is a page"`), the batch read's ids and the range route's page. Interface numbers, not
consensus: the node serves within them and every client asks within them, one definition both read
(`WEB_INTERFACE → Reading a node's answer`). And what the proof route keeps — `packages/node`'s own, module-private,
so the drift test's converse does not reach it and its row is marked.

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `PAGE_LIMIT_DEFAULT` | `50` | rows a view returns when no `limit` is named | policy | none stated | CHOSEN | `NODE_INTERFACE → "Every list a view returns is a page"` |
| `PAGE_LIMIT_MAX` | `100` | the most rows one page carries, whatever `limit` names — and the `limit` a client's whole-list read asks | policy | none stated | CHOSEN | `NODE_INTERFACE → "Every list a view returns is a page"` |
| `BATCH_READ_MAX` | `100` | the most post ids one `POST /posts/batch` takes; the extension's resolver cuts its requests to it | policy | ruled 2026-10-08: `PAGE_LIMIT_MAX`'s number, so a request reads at most what a page reads — 100 rows in 100 distinct full blocks, 142 ms with `tx=1` (`NODE_INTERFACE → Posts`) | RULED | `NODE_INTERFACE → Posts → "The batch read answers posts by id"` |
| `RANGE_PAGE_MAX` | `256` | the most entries one page of `GET /api/v1/range` carries, the page served when no `limit` is named, and the `limit` the light client asks | policy | provisional: a page looks up at most `1 + 2 · 256` keys — about 110 KB of proof and 17–20 ms over a tree of 1.4·10⁶ leaves (`NODE_INTERFACE → AVL+ State Root`) | PROVISIONAL | `NODE_INTERFACE → AVL+ State Root` |
| `NIPOPOW_PROOF_CACHE_ENTRIES` (literal) | `4` | the `(m, k)` proofs `GET /nipopow/proof` keeps at one tip | policy | provisional: one entry serves every client asking the client defaults at one tip, and the most the cache holds is four of the largest proof the route builds, at the caps — about 7 MB on a million-block chain at testnet's floor, so about 28 MB (`NODE_INTERFACE → Nipopow prover`). `node/src/routes/nipopow.ts` | PROVISIONAL | `NODE_INTERFACE → Nipopow prover` |

## HTTP server bounds

`@dagsocial/types`, read by the node's public server and the faucet's — the deadlines and the connection bound both
set (`NODE_INTERFACE → The public server`, `→ Faucet`) — and beside them the node's own literals and the faucet's,
outside the drift test (→ The drift test), each held by its package's suite on the server its function returns.
Interface numbers, not consensus. The memory figures were measured on Node 22.19 against a node at `15eccb7e`;
testnet's two boxes hold 961 MB each, the node 210–355 MB of it.

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `HTTP_HEADERS_TIMEOUT_MS` | `20_000` | 20 s for a request's headers to arrive | local | user ruling 2026-10-23: a header block is one TCP segment, and four lost sends back off for 1 + 2 + 4 + 8 = 15 s, so a lossy link's request arrives and a trickle ends | RULED | `NODE_INTERFACE → The public server` |
| `HTTP_REQUEST_TIMEOUT_MS` | `30_000` | 30 s for the whole request | local | user ruling 2026-10-23: the headers' 20 s and 10 s for a body of at most `HTTP_BODY_MAX_BYTES` — 64 KiB at about 6.5 kB/s; a proxy that buffers the body (nginx's default) hands it to the node at loopback speed. Node refuses one below the headers' | RULED | `NODE_INTERFACE → The public server` |
| `HTTP_KEEP_ALIVE_TIMEOUT_MS` | `5_000` | 5 s a kept connection waits for its next request | local | user ruling 2026-10-23: Node's default, stated so that a Node release which moves its default moves nothing here | RULED | `NODE_INTERFACE → The public server` |
| `HTTP_CHECK_INTERVAL_MS` | `1_000` | how often the header and request deadlines, and the node's answer budget, are read | local | user ruling 2026-10-23: at Node's 30 s a 60 s header deadline closed its connection at 71 s; at 1 s each deadline closes within a second of its time, one walk over at most `HTTP_CONNECTIONS_MAX` connections a second | RULED | `NODE_INTERFACE → The public server` |
| `HTTP_CONNECTIONS_MAX` | `1_024` | connections a server holds open at once | local | user ruling 2026-10-23: 1 024 connections each stalled just under 64 KiB of body pinned 94.7 MB on the node, an idle one about 1 kB, and nothing bounds the count where Node is left alone — 3 000 idle connections were all held | RULED | `NODE_INTERFACE → The public server` |
| `HTTP_IDLE_TIMEOUT_MS` (literal) | `30_000` | 30 s with no byte moving on a node connection | local | user ruling 2026-10-23: no route holds a request open, so 30 s with nothing moving is a reader that stopped or a stall of the node's own; under Node's default of none, 50 readers that never took a 3 MB answer held 152 MB past 75 s. `node/src/server.ts` | RULED | `NODE_INTERFACE → The public server` |
| `HTTP_UNREAD_ANSWER_BYTES` (literal) | `67_108_864` | 64 MiB of answers written and not yet taken | local | user ruling 2026-10-23: an unread answer pins its own size, so the budget is ten range pages at their ceiling (6.4 MB, `RANGE_PAGE_READ_BYTES`' argument) or twenty proofs at the caps on a million-block chain (3.1 MB). `node/src/server.ts` | RULED | `NODE_INTERFACE → The public server` |
| `HTTP_BODY_MAX_BYTES` (literal) | `65_536` | 64 KiB of JSON body on the node's routes | local | ≤ 52 132 bytes: a `{ tx }` whose transaction encodes to `MAX_TX_BYTES` filled with the output whose JSON is longest for its encoded bytes — a `karma_price` box, 89 B for 18 — every field at its widest, with a post commit and `MAX_CONTENT_BYTES` of content each byte escaped to six characters, as `JSON.stringify` writes them; which outputs a transaction may carry left aside, so a bound (measured 2026-10-23). A batch read's ids are 6.7 KB, a mined nonce's submit tens of bytes. A body stalled at the bound pins about 95 kB. `node/src/server.ts` | DERIVED | `NODE_INTERFACE → "A body the parser refuses is the client's error"` |
| `FAUCET_BODY_MAX_BYTES` (faucet) | `128` | 128 bytes of JSON body on the faucet's routes | local | `{ pubkey }` is 77 bytes as `JSON.stringify` writes it, rounded up to a power of two. `tools/faucet/src/server.ts` | DERIVED | `NODE_INTERFACE → Faucet` |

## Client defaults

`tools/nipopow-client` — what the light client asks for when no flag says otherwise. The library exports the pair as
`DEFAULT_M` and `DEFAULT_K`, and the extension's verifier asks the same pair, imported, never a copy
(`WEB_INTERFACE → The extension → "The verified tip"`).

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `m` (default) | `24` | the security parameter | policy | ruled 2026-09-30, to be tuned on testnet's behaviour, on `packages/nipopow/scripts/bench-proof-m.mjs`: at 24 a chain of three quarters of the honest work wins about 4% of comparisons (6: about 18%), and a 100 000-block chain's proof is 219 KB, 438 KB as the route's hex, which Waterfox 140 decodes, verifies and compares in 0.16 s (measured 2026-10-15) | RULED | `NIPOPOW_INTERFACE → Constants` |
| `k` (default) | `20` | the suffix — the client's own settlement depth; a block count, read in work under a moving target | policy | provisional; not a full node's reorg horizon, which is per network and larger (`maxReorgDepth`) | PROVISIONAL | `NIPOPOW_INTERFACE → Constants` |

`@dagsocial/web` — pinned by the package's own suite, outside the drift test: the post cache and the resolve are the
extension build's, the envelope's scrypt cost both builds'.

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `POST_CACHE_BYTES` (web) | `50_000_000` | the post cache's size, over its entries' sizes | policy | provisional and unmeasured — a round figure, argued by nothing yet | PROVISIONAL | `WEB_INTERFACE → The extension → "The post cache"` |
| `BATCH_RESOLVE_MS` (web) | `10_000` | how long one resolve of the posts a list lacks runs, over all its nodes and requests | policy | provisional: `REQUEST_TIMEOUT_MS`' figure for one request, taken as the whole budget — argued by nothing else | PROVISIONAL | `WEB_INTERFACE → The extension → "The resolve"` |
| `SCRYPT_N` (web) | `65_536` | the scrypt cost every seal uses — 2¹⁶, 64 MiB | policy | decided with the identity envelope (2026-09-04): 64 MiB, paid once per unlock and once per export; 185 ms in Node on the i9 (measured 2026-10-20) | DECIDED | `WEB_INTERFACE → The identity module` |
| `SCRYPT_R` (web) | `8` | scrypt's block size, every seal's and every envelope's | format | decided with the identity envelope (2026-09-04); an envelope naming another is refused | DECIDED | `WEB_INTERFACE → The identity module → "An envelope's scrypt cost is bounded"` |
| `SCRYPT_P` (web) | `1` | scrypt's parallelism, every seal's and every envelope's | format | decided with the identity envelope (2026-09-04); an envelope naming another is refused — a large `p` beside a small `N` stays under scrypt's own memory limit (`p` = 2¹⁶ took 3.2 s, measured 2026-10-20) | DECIDED | `WEB_INTERFACE → The identity module → "An envelope's scrypt cost is bounded"` |
| `SCRYPT_N_MAX` (web) | `262_144` | the most an envelope's `N` may name — 2¹⁸, 256 MiB | format | ruled 2026-10-20: four times the seal's `SCRYPT_N`, the room left for the seal's cost to rise; 0.72 s in Node on the i9 against the seal's 185 ms (measured 2026-10-20) | RULED | `WEB_INTERFACE → The identity module → "An envelope's scrypt cost is bounded"` |

## Client reads

`packages/node-reads` — what every client of the node's HTTP API reads under (`WEB_INTERFACE → Reading a node's
answer`): the byte cap each route's answer is read under, the one request deadline, and the most rows one whole-list
read takes in; the NiPoPoW proof route's cap is `tools/nipopow-client`'s, computed from the `m` and `k` it asks.
Pinned by the package's own suite and the light client's, outside the drift test: the reader's cases read a body at
its cap and refuse one a byte longer, each route's case refuses a body one byte over that route's cap, and where the
longest honest answer can be built — every route but the two tree proofs and the NiPoPoW proof — a case builds it
with the real encoders and reads it under the cap; the bound's cases run each reader at its default. Each cap is the
longest honest answer, argued below, rounded up to a binary unit; the NiPoPoW proof's is computed for the `m` and `k`
asked. JSON is Express's `res.json`: hex doubles a byte, base64 is `4 · ⌈n / 3⌉`, and a post's text is at most
`2 · MAX_CONTENT_BYTES`, `"`, `\` and `\n` each serialised as two bytes.

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `nipopowProofReadBytes` (nipopow-client) | `7_225_530` | the cap on `GET /nipopow/proof/:m/:k`, a function of the `m` and `k` asked — the value is at the client defaults, 24 and 20 (38 534 946 at 128 and 128) | local | `2 · (P · 1 518 + 1 518 + 235 · (k − 1) + 8) + 12`: a prefix of `P = 99m` PoPowHeaders, at most `MAX_NIPOPOW_PREFIX` (`NIPOPOW_INTERFACE → Constants`, the prefix bound's arithmetic: 2m a level over ≤ 39 levels, and the sweep's 21m at testnet's floor); a PoPowHeader at most 1 518 bytes — `lp(header)` 235 (`MAX_HEADER_BYTES` 233 and its prefix) and `lp(interlinks)` 1 283 at 40 entries, the highest level plus one under the same premise (`TYPES_INTERFACE → Interlink vector`); the suffix head one more; `k − 1` tail headers of 235; 8 bytes of counts; hex, and 12 of JSON. Measured honest: 438 KB at `m = 24` on a 100 000-block chain (`NIPOPOW_INTERFACE → Constants`) | PROVISIONAL — rests on the prefix bound's premise | `WEB_INTERFACE → Reading a node's answer` |
| `LOOKUP_READ_BYTES` (node-reads) | `32_768` | the cap on `GET /api/v1/proof/:key` | local | ≤ 30 144 bytes: a lookup proof under a digest declaring at most 255 levels (`AVLTREE_INTERFACE → The depth guard`) is at most two root-to-leaf paths of 34 bytes a level (an internal node's balance byte and a sibling label's 33), a leaf of 135 bytes plus its value, and the directions — 18 810 bytes, the longest tree value a `genesis_proof` box at `MAX_GENESIS_PROOF_PAYLOAD_BYTES`, 568 bytes (measured 2026-10-19); 25 080 in base64; the answer's other fields ≤ 5 064, that box's decoded `value` the longest (measured 2026-10-19) | DERIVED | `WEB_INTERFACE → Reading a node's answer` |
| `RANGE_PAGE_READ_BYTES` (node-reads) | `8_388_608` | the cap on one page of `GET /api/v1/range/:kind/:owner` | local | ≤ 6 433 420 bytes: a page's proof serves `1 + 2 · RANGE_PAGE_MAX` lookups (`CONSENSUS_INTERFACE → The holdings page`), each at most one path of `LOOKUP_READ_BYTES`' argument, 9 405 bytes — 4 824 765, 6 433 020 in base64, and ≤ 400 of other fields. Measured honest: about 110 KB of proof over a tree of 1.4 · 10⁶ leaves (`RANGE_PAGE_MAX`, → HTTP view bounds) | DERIVED | `WEB_INTERFACE → Reading a node's answer` |
| `LISTING_PAGE_READ_BYTES` (node-reads) | `16_384` | the cap on one page of `GET /karma/:userId` or `GET /credits/:userId` — the reader's own listings, the reads before a write, a send's landing read, the command line's listing and the faucet's `pending=1` listings | local | ≤ 14 527 bytes, the credit page the longer (the karma page 12 756): `PAGE_LIMIT_MAX` rows of a 64-hex id, a decimal value below `2⁶³` and its lock or income mark, the page's totals, `next` and, on the karma page, the identity record's fields, every height and count at `Number.MAX_SAFE_INTEGER`'s width (measured 2026-10-19) | DERIVED | `WEB_INTERFACE → Reading a node's answer` |
| `POST_READ_BYTES` (node-reads) | `32_768` | the cap on `GET /posts/:id`, with `tx=1` or without — the single post read and the command line's `post` | local | ≤ 21 598 bytes: a `PostJson` with its text at `2 · MAX_CONTENT_BYTES`, `tx` at `2 · MAX_TX_BYTES` hex, one parent, a name at `USERNAME_MAX_BYTES`, and `confirmedAuthor` (measured 2026-10-19, `confirmedAuthor` counted wider than its 64 hex) | DERIVED | `WEB_INTERFACE → Reading a node's answer` |
| `POST_BATCH_READ_BYTES` (node-reads) | `4_194_304` | the cap on one `POST /posts/batch?tx=1` answer — the extension's resolve | local | ≤ 2 130 111 bytes: `BATCH_READ_MAX` rows of `POST_READ_BYTES`' row less `confirmedAuthor`, which the batch read leaves out (measured 2026-10-19) | DERIVED | `WEB_INTERFACE → Reading a node's answer` |
| `NAME_READ_BYTES` (node-reads) | `1_024` | the cap on `GET /usernames/:name` and `GET /usernames?owner=` | local | ≤ 219 bytes: a name at `USERNAME_MAX_BYTES`, two 64-hex ids, one height (measured 2026-10-19) | DERIVED | `WEB_INTERFACE → Reading a node's answer` |
| `HEIGHT_READ_BYTES` (node-reads) | `1_024` | the cap on `GET /blocks/current` | local | ≤ 101 bytes: one height and one 64-hex hash (measured 2026-10-19) | DERIVED | `WEB_INTERFACE → Reading a node's answer` |
| `REQUEST_TIMEOUT_MS` (node-reads) | `10_000` | how long a client waits for one request's answer — every read, write and faucet request | local | provisional: the light client's figure since its first unit, argued by nothing else; a request it ends reads as a transport failure, and a write's flight ends as one does | PROVISIONAL | `WEB_INTERFACE → Reading a node's answer` |
| `FEED_PAGE_READ_BYTES` (node-reads) | `262_144` | the cap on one page of `GET /posts` — the feed, an author's list — full or light | local | ≤ 258 898 bytes: `PAGE_LIMIT_MAX` rows in `posts` and as many in `pending`, each a full `PostJson` without `tx` of 1 293 bytes — four 64-hex ids, one parent, its text at `2 · MAX_CONTENT_BYTES`, a name at `USERNAME_MAX_BYTES`, its `type`, `status` and `likedByViewer`, every height and count at `Number.MAX_SAFE_INTEGER`'s width — a withdrawn and a light row narrower; `pendingCount` and a post-key `next` (measured 2026-10-20) | DERIVED | `WEB_INTERFACE → Reading a node's answer` |
| `THREAD_READ_BYTES` (node-reads) | `524_288` | the cap on one `GET /posts/:id/thread` answer | local | ≤ 389 687 bytes: the subject and three lists of `PAGE_LIMIT_MAX` rows — `ancestors`, `descendants`, `pending` — each `FEED_PAGE_READ_BYTES`' row, the three counts and a post-key `next` (measured 2026-10-20) | DERIVED | `WEB_INTERFACE → Reading a node's answer` |
| `STATUS_READ_BYTES` (node-reads) | `1_024` | the cap on `GET /status` | local | ≤ 558 bytes: the network's name; `blockHeight`, `protocolVersion`, `postCount`, `pendingPosts`, `usernameCount`, `inviteProbationBlocks`, `vouchCooldownBlocks` and the membership object's three at `Number.MAX_SAFE_INTEGER`'s width; `totalKarma` and `liquidKarma` below the box value bound, the karma supply being `BOX_VALUE_BOUND − 1` (`TYPES_INTERFACE → KarmaPoolBox`), `totalCredits` held there too though `creditEmissionTotal` bounds it lower; the bond bounds in the box value domain (measured 2026-10-20) | DERIVED | `WEB_INTERFACE → Reading a node's answer` |
| `VOUCH_PAGE_READ_BYTES` (node-reads) | `65_536` | the cap on one page of `GET /vouches` — the target arm, the voucher arm, the cooldowns | local | ≤ 38 012 bytes: `PAGE_LIMIT_MAX` rows of the widest arm, the voucher arm's — a box id, a value below `2⁶³`, a height, two keys and two names at `USERNAME_MAX_BYTES` — `count`, and a 64-hex box id as `next` (measured 2026-10-20) | DERIVED | `WEB_INTERFACE → Reading a node's answer` |
| `BOND_PAGE_READ_BYTES` (node-reads) | `65_536` | the cap on one page of `GET /invites/:userId` | local | ≤ 38 614 bytes: `PAGE_LIMIT_MAX` rows of a bond id, a value below `2⁶³`, two keys, two names at `USERNAME_MAX_BYTES` and a height; `bondCount`, and a 64-hex box id as `next` (measured 2026-10-20) | DERIVED | `WEB_INTERFACE → Reading a node's answer` |
| `WRITE_ANSWER_READ_BYTES` (node-reads) | `1_024` | the cap on any write route's answer, the node's and the faucet's, a 2xx's or a rejection's | local | ≤ 640 bytes: the widest 2xx is under 200 bytes; the widest rejection is an envelope refusal naming a key and a value as `describeValue` shows it — 64 code units at most, through `JSON.stringify`, six bytes a control character — after the widest opening words, `Invalid postWithdraw transaction: `, in `{ error, reason }`; every value a write route's or the faucet's reason names is bounded (measured 2026-10-20) | DERIVED | `WEB_INTERFACE → Reading a node's answer` |
| `KARMA_LISTING_MAX` (node-reads) | `2` | the most boxes a `/karma` listing carries — the bound every client's whole-list read of it holds | local | an identity holds its own karma box and at most one income box (`NODE_INTERFACE → Karma transition rules → "An identity holds at most two karma boxes"`) | DOMAIN | `WEB_INTERFACE → Reading a node's answer → "A whole-list read is bounded"` |
| `LEDGER_READ_MAX` (node-reads) | `10_000` | the most rows one whole-list read takes in where no protocol maximum bounds the list — credit boxes, vouches, cooldowns, standing bonds — and the most boxes a range at one height takes in; a `/karma` listing is bounded by its maximum, two boxes (`NODE_INTERFACE → Karma transition rules → "An identity holds at most two karma boxes"`) | local | provisional: a kept key stays far inside it — at height 48 592 on testnet every key but the miner's held 5 boxes or fewer of a ledger, the miner's coinbase key 48 585 credit boxes, one a block, never consolidated (measured 2026-10-19); the holder pays for many small boxes, one rent each and about 300 inputs a transaction. 40 range pages at `RANGE_PAGE_MAX`, 100 list pages at `PAGE_LIMIT_MAX`; a listing past it is refused, never read in part | PROVISIONAL | `WEB_INTERFACE → Reading a node's answer → "A whole-list read is bounded"` |

## Excluded

Numeric exports and profile fields that are not register rows, listed so the drift test's converse
check can tell an omission from an exclusion.

| Name | Why |
|---|---|
| `MAGIC_MAINNET`, `MAGIC_TESTNET`, `MAGIC_DEVNET`, `magic` | network identity, not a tunable — `ARCHITECTURE → Network Identity` |
| `VLQ_SENTINEL` | the all-ones sentinel a total writer emits out of domain — `TYPES_INTERFACE → Serialization` |
| `MSG_HANDSHAKE`, `MSG_SYNC_INFO`, `MSG_MODIFIER_REQUEST`, `MSG_MODIFIER_RESPONSE`, `MSG_GET_PEERS`, `MSG_PEERS`, `MSG_GET_HEADERS`, `MSG_HEADERS`, `MSG_GET_BLOCKS`, `MSG_BLOCKS` | message codes — `NET_INTERFACE → Frame Format` |
| `MODIFIER_POST_BODY` | the modifier type id — `NET_INTERFACE → ModifierRequest` |
| `IDENTITY_RECORD_TAG`, `NETWORK_RECORD_TAG`, `NAME_RECORD_TAG`, `HOLDER_RECORD_TAG`, `POST_RECORD_TAG`, `LIKE_MARKER_TAG`, `INDEX_MARKER_TAG`, `VOUCH_PAIR_TAG`, `CAST_COUNT_TAG` | the first byte of each tree value that is not a box, `0x80`–`0x88` — layout discriminators, not tunables — `TYPES_INTERFACE → Layout — tree records`, the identity record's `TYPES_INTERFACE → Layout — IdentityRecord`; the tree's key tags are `TREE_TAG`'s (`TYPES_INTERFACE → The tree keys`) |
| `GET_PEERS_INTERVAL_MS`, `OUTBOUND_TICK_INTERVAL_MS` | local cadences — `NET_INTERFACE → Outbound Manager` |
| `genesisCommitteeKeys`, `faucetPublicKey`, `genesisProofPayload`, `genesisStateRoot`, `genesisId`, `bootstrapPeers`, `backerTable` | identity fields — non-numeric, listed for completeness |

## What the register makes visible

- **CHOSEN is the largest class after the derived and decided ones**, and it is the class no marker
  in the tree names: `MAX_CONTENT_BYTES`, `MAX_BLOCK_BODY_BYTES`, `MAX_TX_BYTES`, the karma decay
  pair and floors, `VOUCH_COOLDOWN_BLOCKS`, `GENESIS_KARMA_PER_MEMBER`,
  `CREDIT_MINER_REWARD_DELAY`, and most of net's bounds. None is marked
  provisional, and none has an argument on record. Marking or arguing them is a decision for their
  owner, not for this register.
- **`INVITE_BOND_VEST_PER_LIKES` sits below the value at which the cost-gated-emission floor is met
  with zero inflation** — 3 against 5 — and the choice is recorded as a supply decision, not an
  oversight.
