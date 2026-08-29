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
| Value | **the value as JavaScript evaluates the code's expression**, in a code span — a decimal integer, `_` group separators allowed, `n` for a bigint, nothing else in the cell. `42n * 10n ** 8n` is written `4_200_000_000n` |
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
   values are `NETWORK_PROFILES.mainnet`, `.testnet`, `.devnet` in that order;
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
| `PROTOCOL_VERSION` | `1` | — | consensus | the one version; validation is an equality check against it | DOMAIN | `TYPES_INTERFACE → Version` |
| `MAX_CONTENT_BYTES` | `300` | 300 UTF-8 bytes | consensus | none stated | CHOSEN | `TYPES_INTERFACE → Content limits` |
| `MAX_PARENT_REFS` | `1` | one parent | consensus | user ruling, 2026-08-09 — subtrees stay disjoint, so pruning is well-defined | RULED | `TYPES_INTERFACE → Content limits` |
| `MAX_GENESIS_PROOF_PAYLOAD_BYTES` | `512` | 512 bytes | format | roughly Ergo's five-register no-premine payload plus headroom, derived from no measurement; the three profile payloads are ~35 bytes | PROVISIONAL | `TYPES_INTERFACE → Content limits` |
| `BOX_VALUE_BOUND` | `9_223_372_036_854_775_808n` | 2⁶³ | consensus | SQLite `INTEGER` is a signed 64-bit integer, so the accepted value domain stops where storage does | DERIVED | `TYPES_INTERFACE → Box value domain` |
| `AVL_KEY_LENGTH` | `32` | 32 bytes | consensus | the width of every 32-byte digest in the format | DOMAIN | `TYPES_INTERFACE → State format` |

### Size caps

Three limits stand in a fixed order — `MAX_BLOCK_BODY_BYTES < MAX_SERVE_BODY_BYTES < MAX_STREAM_BYTES`
— and the order is the rule; the base number is a choice.

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `MAX_BLOCK_BODY_BYTES` | `2_000_000` | 2 MB per block; 1.05 TB/yr at 60 s blocks | consensus | none stated for the number; the two net caps above it derive from it | CHOSEN | `TYPES_INTERFACE → Size caps` |
| `MAX_TX_BYTES` | `10_000` | ~148 credit inputs | consensus | argued for *existence* — a transaction may not be valid, poolable and unminable at once — not for the number | CHOSEN | `TYPES_INTERFACE → Size caps` |
| `MAX_SETTLEMENT_BYTES` | `100_000` | 5 % of the body; ≈ 2 700 like markers after the capped legs | consensus | two relations are the rule (fits a legal body; an empty-body settlement at every cap fits it — 70 + 3 × 64 × 70 = 13 510 at the escrow item's cost, the lapse item's to be measured); the number is provisional | PROVISIONAL | `TYPES_INTERFACE → Size caps` |

### Settlement caps

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `MAX_BOND_SETTLEMENTS_PER_BLOCK` | `64` | bonds settled per block | consensus | a backlog of `n` drains in ⌈n / 64⌉ blocks; 64 is provisional | PROVISIONAL | `TYPES_INTERFACE → Settlement caps` |
| `MAX_ESCROW_RETURNS_PER_BLOCK` | `64` | escrows returned per block | consensus | same | PROVISIONAL | `TYPES_INTERFACE → Settlement caps` |
| `MAX_LAPSE_WITHDRAWALS_PER_BLOCK` | `64` | vouches of lapsed members withdrawn per block | consensus | same; a cascade runs one generation per block on top | PROVISIONAL | `TYPES_INTERFACE → Settlement caps` |

### Karma

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `KARMA_POSTING_MINIMUM` | `1n` | 1 karma to post | consensus | none stated | CHOSEN | `TYPES_INTERFACE → Karma` |
| `KARMA_STALE_THRESHOLD_BLOCKS` | `40320` | 28 days at 60 s | consensus → profile | user ruling, 2026-08-19: 28 days | RULED | `TYPES_INTERFACE → Network profiles` |
| `KARMA_DECAY_INTERVAL_BLOCKS` | `1440` | 24 h at 60 s | consensus → profile | none stated for the duration; the unit is 60-second blocks | CHOSEN | `TYPES_INTERFACE → Karma` |
| `KARMA_DECAY_AMOUNT` | `5n` | 5 karma per period | consensus | none stated | CHOSEN | `ARCHITECTURE → Karma decay` |
| `KARMA_MINIMUM` | `10n` | the decay floor | consensus | none stated | CHOSEN | `ARCHITECTURE → Karma decay` |

### Post price and likes

`ARCHITECTURE → Like parameters` marks the like rows as placeholders; the price rows are ruled.

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `POST_PRICE_THREAD` | `5n` | karma a thread pays to the pool | consensus | user ruling, 2026-08-29 | RULED | `ARCHITECTURE → The post price` |
| `POST_PRICE_REPLY` | `3n` | karma a reply pays | consensus | user ruling, 2026-08-29 | RULED | `ARCHITECTURE → The post price` |
| `REPLY_AUTHOR_SHARE` | `1n` | the part of a reply's price the parent's author accrues | consensus | user ruling, 2026-08-29 — a 33 % channel to the parent, below the like's 80 %, so no arbitrage | RULED | `ARCHITECTURE → The post price` |
| `LIKE_KARMA_COST` | `1n` | 1 karma per like | consensus | the indivisible unit — no smaller like is expressible; the `B · (1 − V/L)` supply arithmetic holds under exactly this value | PROVISIONAL | `ARCHITECTURE → Like parameters` |
| `LIKES_PER_KARMA_PAYOUT` | `5` | `x`: an author accrues `x − 1` per `x` likes, 1 burns | consensus | `1/x` = 20 % burn is the deflation dial; placeholder | PROVISIONAL | `ARCHITECTURE → Like parameters` |

### Vouch

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `VOUCH_KARMA_AMOUNT` | `1n` | one vote stakes 1 karma | consensus | user ruling, 2026-08-07 | RULED | `NODE_INTERFACE → Vouch transition rules` |
| `VOUCH_MIN_BALANCE` | `11n` | summed karma balance to cast | consensus | none stated | CHOSEN | `ARCHITECTURE → Vouch boxes` |
| `VOUCH_COOLDOWN_BLOCKS` | `60` | 1 h at 60 s | consensus → profile | none stated | CHOSEN | `ARCHITECTURE → Vouch boxes` |
| `VOUCH_CAST_HEIGHT_WINDOW` | `5` | a vouch output's `createdAtBlock` may lag its carrying block by at most 5 | consensus | protocol-level, the same on every network — never a profile field; none stated for the number | CHOSEN | `NODE_INTERFACE → Vouch transition rules` |

### Membership

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `MEMBER_LIKES_MULTIPLIER` | `2` | `Y = 2 · D` — likes from members a newcomer needs beside the vouches | consensus | none stated for the number; testnet's to tune | PROVISIONAL | `ARCHITECTURE → Membership` |

### Invites

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `INVITE_MIN_KARMA` | `1n` | = `KARMA_POSTING_MINIMUM` | consensus | an alias | DERIVED | `TYPES_INTERFACE → Invites` |
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
| `COINBASE_BACKER_PCT` | `35` | nothing stakes, so it falls to the floor | consensus | provisional | PROVISIONAL | `MINING_INTERFACE → Coinbase Application` |
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
| `ORDERING_BLOCK_POW_TARGET_BITS` | `5984` | 23.375 bits — a 60 s solve at 181 262 H/s | consensus → profile | measured: 60 s × 181 262 H/s = 10 875 720 hashes, log₂ = 23.3746 bits, × 256 = 5983.9 → 5984. One machine, one thread, standing in for the network's total | PROVISIONAL | `TYPES_INTERFACE → Ordering block PoW` |
| `ORDERING_BLOCK_POW_TARGET_FLOOR` | `2304` | 9 whole bits | consensus | the first whole bit above 2180, beneath which a 1/256-bit step buys zero work and difficulty moves while `cumulativeWork` does not | DERIVED | `VALIDATION_INTERFACE → blockWork / cumulativeWork` |

### Interlinks

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `LEVEL_CAP` | `256` | the level of a zero PoW hit | consensus | a non-zero hit's level is below the target's bit length, at most 256 | DOMAIN | `TYPES_INTERFACE → Interlinks` |
| `MAX_INTERLINKS` | `257` | the vector's longest form | consensus | `LEVEL_CAP + 1` — one entry per level plus genesis | DERIVED | `TYPES_INTERFACE → Interlinks` |

### Chain reorganisation

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `MAX_REORG_DEPTH` | `20` | the fork walk, the journal retention window, the headers a fork asks for (× 2) | policy | none stated; journal retention is the hard bound and the fork walk is policy | CHOSEN | `TYPES_INTERFACE → Chain reorganisation` |

## Per-network values

`@dagsocial/types` → `network.ts`. Mainnet's cells are the universal constants above; testnet and
devnet differ where a cell says so. The identity fields — `magic`, `genesisCommitteeKeys`,
`faucetPublicKey`, `genesisProofPayload`, `genesisStateRoot`, `genesisId` — are not register rows
(→ Excluded): they name a network rather than tune one.

| Field | mainnet | testnet | devnet | Axis | Argument (devnet's cell) | Status | Rule |
|---|---|---|---|---|---|---|---|
| `orderingBlockPowTargetBits` | `5984` | `5984` | `3072` | difficulty | the node suite mines real PoW against the profile it resolves: 5984 costs it ~141 minutes per run, 3072 is ~4K hashes a solve; and ≥ 2180 so the retarget is exercised above the dead zone | DERIVED | `TYPES_INTERFACE → Ordering block PoW` |
| `karmaDecayIntervalBlocks` | `1440` | `1440` | `3` | timescale | a short-run value that makes decay fire inside a devnet run | CHOSEN | `TYPES_INTERFACE → Network profiles` |
| `karmaStaleThresholdBlocks` | `40320` | `40320` | `500` | timescale | keeps staleness reachable inside a suite | CHOSEN | `TYPES_INTERFACE → Network profiles` |
| `vouchCooldownBlocks` | `60` | `60` | `3` | timescale | the shortest wait that still spans block boundaries | DERIVED | `TYPES_INTERFACE → Network profiles` |
| `inviteProbationBlocks` | `43200` | `43200` | `540` | timescale | above `karmaStaleThresholdBlocks`, so decay fires during probation on devnet as it does on mainnet — the property, not a ratio | DERIVED | `TYPES_INTERFACE → Network profiles` |
| `creditMinerRewardDelay` | `1440` | `1440` | `10` | timescale | small enough to spend, large enough to observe immaturity | CHOSEN | `TYPES_INTERFACE → Network profiles` |
| `creditFixedRateBlocks` | `1_051_200` | `1_051_200` | `1000` | timescale | ~÷1000 so the fixed-rate → decay transition is reachable | CHOSEN | `TYPES_INTERFACE → Network profiles` |
| `creditEpochBlocks` | `470_000` | `470_000` | `400` | timescale | fixed-rate ≈ 2.5 × epoch, preserving mainnet's ordering (epoch < fixed-rate period) | CHOSEN | `TYPES_INTERFACE → Network profiles` |
| `creditEmissionTotal` | `42_264_000_000_000_000n` | `42_264_000_000_000_000n` | `36_200_000_000_000n` | timescale | strictly below devnet's own curve sum of 386 400 credits — the rule every profile's total obeys | DERIVED | `TYPES_INTERFACE → EmissionBox` |
| `storageRentPeriodBlocks` | `2_102_400` | `2_102_400` | `40` | timescale | mainnet: 4 years, exactly `2 × creditFixedRateBlocks`, Ergo's wall clock. Devnet: above the deepest height any e2e scenario reaches (27), with thirteen blocks of headroom | DERIVED | `ARCHITECTURE → What varies per network` |
| `genesisKarmaPerMember` | `1000n` | `1000n` | `1000n` | genesis | carried from the constant on all three | CHOSEN | `ARCHITECTURE → Genesis` |
| `inviteBondMin` | `100n` | `100n` | `5n` | cap | a bond of `B` vests in `V · B` likes, so the floor decides whether a fixture can drive one to the end: 5 costs 15 likes | DERIVED | `TYPES_INTERFACE → Invites` |
| `inviteBondMax` | `250n` | `1000n` | `250n` | cap | testnet's is relaxed so a tester arrives with enough karma to post and like freely — a cap, not a mechanic; devnet keeps mainnet's so the range check has both ends to fail against | DECIDED | `TYPES_INTERFACE → Invites` |
| `membershipBarMultiplier` | `10` | `1` | `1` | cap | devnet's `1` lets a chain whose only root is the faucet flag its first member on one vouch — `D(1) = 1`, where `10` gives `D(1) = 2` and a lone root could never flag anyone; mainnet's `10` is fixed by the user's two anchors (2026-08-28): `D = 10` at 100 members, `100` at 100 000 | DERIVED | `ARCHITECTURE → Membership` |

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
| `MAX_NIPOPOW_PARAM` | `128` | the largest `m` and the largest `k` a proof or a request may carry | format | provisional; at `m = k = 6` a million-block proof is ~240 PoPowHeaders, ~200 KB, and the prover's work per call grows with `m` | PROVISIONAL | `NIPOPOW_INTERFACE → Constants` |
| `MAX_NIPOPOW_PREFIX` | `16_384` | 2¹⁴ prefix entries | format | ~2m headers per level over ≤ 33 levels is 8 448 at the `m` cap; 2¹⁴ sits above it with headroom, and moves with `MAX_NIPOPOW_PARAM` | PROVISIONAL | `NIPOPOW_INTERFACE → Constants` |

### validation

`@dagsocial/validation` → `verify.ts`. The scale of the ordering-target expansion is an implementation
choice, not consensus (`VALIDATION_INTERFACE → What is not consensus`): any expansion satisfying the
predicate agrees with every other on every input, and under-precision is one-sided. Module-private, so
the row is marked; `scripts/miner.mjs` carries a mirror of the declaration that `miner-mirror.test.ts`
holds byte-identical across the whole domain.

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `ORDERING_TARGET_PRECISION` (literal) | `320n` | the scale the fractional-bit factor table is written at | local | the factors' fixed-point precision; under-precision is safe and one-sided. `validation/src/verify.ts` | CHOSEN | `VALIDATION_INTERFACE → What is not consensus` |

### net

Relay and codec bounds a peer's messages must respect; a body over one is refused before its first
element is read. `MAX_SERVE_BODY_BYTES` and `MAX_STREAM_BYTES` are the upper two of the size-cap order
under → Size caps.

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `MAX_INV_IDS` | `400` | ids per `Inv`, modifiers per response | format | the send-side batch cap, enforced on receipt as well; none stated for the number | CHOSEN | `NET_INTERFACE → Inv` |
| `MAX_CHAIN_RESPONSE_ITEMS` | `400` | headers or blocks per response | format | the same batch cap; fork resolution asks for at most `MAX_REORG_DEPTH × 2` headers, an order of magnitude below it | DERIVED | `NET_INTERFACE → Sync State Machine` |
| `MAX_SERVE_BODY_BYTES` | `4_194_304` | 4 MiB per served response | policy | half of `MAX_STREAM_BYTES`, so a response fits the read cap at the other end; above `MAX_BLOCK_BODY_BYTES`, so one legal block always fits | DERIVED | `NET_INTERFACE → Validation` |
| `MAX_STREAM_BYTES` | `8_388_608` | 8 MiB buffered per inbound stream | format | twice the largest legitimate message; the base number is none stated | CHOSEN | `NET_INTERFACE → Validation` |
| `MAX_PEERS_ENTRIES` | `64` | entries per `Peers` response | format | none stated; 8 are served | CHOSEN | `NET_INTERFACE → Peers` |
| `MAX_CAPABILITY_ENTRIES` | `64` | capability codes per handshake or entry | format | against a 17-row code table | CHOSEN | `NET_INTERFACE → Handshake` |
| `MAX_CAPABILITY_CODE` | `65_535` | the largest capability code | format | 2¹⁶ − 1 | DOMAIN | `NET_INTERFACE → Handshake` |
| `MAX_NAME_BYTES` | `255` | `agentName` / `nodeName` | format | none stated | CHOSEN | `NET_INTERFACE → Handshake` |
| `MAX_ADDRESS_BYTES` | `255` | a multiaddr | format | none stated | CHOSEN | `NET_INTERFACE → Handshake` |
| `MAX_SYNC_ANCHORS` | `4` | anchors per `SyncInfo` | format | the locator is `[tip, tip−16, tip−128, tip−512]` | DERIVED | `NET_INTERFACE → Validation` |
| `MAX_ADVERTISED_HEIGHT` | `100_000_000` | ~190 years at one block a minute | format | a horizon no honest chain reaches | DERIVED | `NET_INTERFACE → Validation` |
| `GET_PEERS_RESPONSE_LIMIT` | `8` | peers served per `GetPeers` | policy | none stated | CHOSEN | `NET_INTERFACE → Peers` |
| `BACKFILL_BATCH_IDS` | `100` | post bodies requested per batch | policy | none stated | CHOSEN | `NET_INTERFACE → Sync State Machine` |

## Producer policy

`packages/node` — a producer's choices on legs consensus does not check. Literals in the creator, so
the drift test's converse does not reach them and the rows are marked.

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `MAX_RENT_TXS_PER_BLOCK` (literal) | `32` | rent collections a producer selects per block | policy | none stated; creator policy on a body-driven leg. `node/src/services/block-creator.ts` | CHOSEN | `NODE_INTERFACE → The settlement transaction` |

## HTTP view bounds

`packages/node` — the page every list a view returns is cut to (`NODE_INTERFACE → "Every list a view
returns is a page"`). Interface numbers a client depends on, not consensus; module-private, so the
drift test's converse does not reach them and the rows are marked.

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `PAGE_LIMIT_DEFAULT` (literal) | `50` | rows a view returns when no `limit` is named | policy | none stated. `node/src/routes/page.ts` | CHOSEN | `NODE_INTERFACE → "Every list a view returns is a page"` |
| `PAGE_LIMIT_MAX` (literal) | `100` | the most rows one page carries, whatever `limit` names | policy | none stated. `node/src/routes/page.ts` | CHOSEN | `NODE_INTERFACE → "Every list a view returns is a page"` |

## Client defaults

`tools/nipopow-client` — what the light client asks for when no flag says otherwise.

| Name | Value | Reads as | Kind | Argument | Status | Rule |
|---|---|---|---|---|---|---|
| `m` (default) | `6` | the security parameter | policy | provisional | PROVISIONAL | `NIPOPOW_INTERFACE → Constants` |
| `k` (default) | `20` | the suffix — "k-deep" means past a full node's reorg horizon | policy | = `MAX_REORG_DEPTH`; provisional | PROVISIONAL | `NIPOPOW_INTERFACE → Constants` |

## Excluded

Numeric exports and profile fields that are not register rows, listed so the drift test's converse
check can tell an omission from an exclusion.

| Name | Why |
|---|---|
| `MAGIC_MAINNET`, `MAGIC_TESTNET`, `MAGIC_DEVNET`, `magic` | network identity, not a tunable — `ARCHITECTURE → Network Identity` |
| `VLQ_SENTINEL` | the all-ones sentinel a total writer emits out of domain — `TYPES_INTERFACE → Serialization` |
| `MAX_UINT32` | the domain bound of a `u32` field |
| `MSG_HANDSHAKE`, `MSG_SYNC_INFO`, `MSG_INV`, `MSG_MODIFIER_REQUEST`, `MSG_MODIFIER_RESPONSE`, `MSG_GET_PEERS`, `MSG_PEERS`, `MSG_GET_HEADERS`, `MSG_HEADERS`, `MSG_GET_BLOCKS`, `MSG_BLOCKS` | message codes — `NET_INTERFACE → Frame Format` |
| `MODIFIER_ORDERING_BLOCK`, `MODIFIER_POST_BODY` | modifier type ids — `NET_INTERFACE → ModifierRequest` |
| `GET_PEERS_INTERVAL_MS`, `OUTBOUND_TICK_INTERVAL_MS` | local cadences — `NET_INTERFACE → Outbound Manager` |
| `genesisCommitteeKeys`, `faucetPublicKey`, `genesisProofPayload`, `genesisStateRoot`, `genesisId` | identity fields — non-numeric, listed for completeness |

## What the register makes visible

- **CHOSEN is the largest class after the derived and decided ones**, and it is the class no marker
  in the tree names: `MAX_CONTENT_BYTES`, `MAX_BLOCK_BODY_BYTES`, `MAX_TX_BYTES`, the karma decay
  pair and floors, `VOUCH_MIN_BALANCE`, `VOUCH_COOLDOWN_BLOCKS`, `GENESIS_KARMA_PER_MEMBER`,
  `CREDIT_MINER_REWARD_DELAY`, `MAX_REORG_DEPTH`, and most of net's bounds. None is marked
  provisional, and none has an argument on record. Marking or arguing them is a decision for their
  owner, not for this register.
- **`INVITE_BOND_VEST_PER_LIKES` sits below the value at which the cost-gated-emission floor is met
  with zero inflation** — 3 against 5 — and the choice is recorded as a supply decision, not an
  oversight.
