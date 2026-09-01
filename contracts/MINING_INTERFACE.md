# MINING Interface Contract

**Component:** `@dagsocial/node` (mining subsystem)
**Protocol version:** 2
**Last updated:** 2026-08-26

## Scope

Mining subsystem for ordering blocks. Owns: credit emission schedule, coinbase
structure, PoW verification for ordering blocks, difficulty adjustment, mining
API endpoints (template + submit). Depends on:

- `@dagsocial/types` — data structures, constants, hashing
- `@dagsocial/validation` — stateless PoW verification
- `@dagsocial/node` — store (block persistence, UTXO), block creator, config

## Emission Schedule

Ergo-style linear decay **that does not reach zero — there is no tail, and there is no last paying
height either**. At 60-second blocks:

| Parameter | Blocks | Duration |
|-----------|--------|----------|
| Fixed-rate period | 1,051,200 | ~2 years |
| Epoch (reduction interval) | 470,000 | ~326 days |
| Decay phase | 19,270,000 | 41 epochs, ~36.65 years |
| Curve's full span | 20,321,200 | ~38.65 years |
| **Minimum runway** | **15,591,163** | **~29.64 years** |

⛔ **THE TERMINUS IS A BALANCE, NOT A HEIGHT.** The emission box holds **less** than the curve's own
sum, so it empties while the curve is still paying — at a rate of **11**, with 4,730,037 blocks of
schedule left unpaid. The height above is therefore the **minimum** runway and not a terminus: an
unearned inclusion bonus returns to the box (→ "The slices"), and every credit returned extends the
runway. **Only the floor is a number.**

**The first block whose release the box cannot cover in full pays what remains**, and every block
above it pays nothing until a return arrives. ⛔ **Blocks stay producible at and above exhaustion** —
the coinbase then carries whatever the other income terms yield, fees and storage rent. A rule that
instead refused such a block would make the chain unproducible from that height, which is the failure
the derived total existed to prevent and which choosing a smaller box makes real.

⛔ **The emission box is never destroyed** (TYPES_INTERFACE → EmissionBox). Above exhaustion the
schedule may still owe a positive rate while the box is empty, and fees are never zero, so a forfeited
inclusion bonus is still produced and still has to land somewhere. **A box destroyed at exhaustion
would leave it with no destination.** The box therefore exists at every height whatever its value, and
a return can restart emission until it drains again.


⛔ **Storage rent is the perpetual term, and it is why emission needs no tail.** Emission
terminates; fees depend on demand; rent is charged on dormant `credit` boxes whatever the
transaction volume, so the security budget is never structurally zero. **It is recycled, never
minted** — supply stays bounded (ARCHITECTURE → Genesis). A producer's rent income is
`STORAGE_RENT_PER_BYTE × byteLength(boxRecordBytes(box))` per eligible box it takes, and which
boxes it takes is its own choice, and rent rides the body as an ordinary transaction rather than as a
settlement leg (NODE_INTERFACE → "Storage rent is a transition requiring no signature").

⛔ **Rent accumulates as its OWN term and never inside `fees`.** The treasury takes
`COINBASE_TREASURY_PCT` of emission and of fees and **none of rent**, so a charge folded into the fee
total would be taxed at 5% by arithmetic no rule states. The settlement therefore classifies each
body transaction and sums two totals, not one: `income = emission + fees + rent`, with the treasury
base computed over the first two alone.

⛔ **AND THE INCLUSION BONUS POOL IS OVER `emission + fees` TOO — the same reason, one step further
along.** The pool's **unearned** remainder stays in the `EmissionBox` (→ the slice table above), so a
pool computed over the full income diverts a share of rent there by a second path, and the rule two
paragraphs up is violated without any line saying so. ⛔ **Rent is recycled, never emitted** — routed
into the emission box it would be released again as coinbase under a schedule that never counted it.
**Rent reaches the miner floor entire, and both exclusions are required to make that true** — either
one alone leaks.

| Parameter | Value | Description |
|-----------|-------|-------------|
| `CREDIT_INITIAL_REWARD` | 42 | Credits per block in fixed-rate period. **Universal** — economics, never timescale |
| `CREDIT_REWARD_REDUCTION` | 1 | Credits reduced per epoch. **Universal**, so the decay runs 41 epochs on every network and only `creditEpochBlocks` compresses it |
| `CREDIT_MINER_REWARD_DELAY` | 1440 | Blocks before coinbase can be spent (24h at 60s) |
| `COINBASE_TREASURY_PCT` | 5 | Percent of emission and of fees to treasury — never of storage rent |
| `COINBASE_MINER_FLOOR_PCT` | 35 | Guaranteed miner share, and it takes every remainder |
| `COINBASE_BACKER_PCT` | 35 | Backer pool. **AHEAD OF CODE** — nothing stakes, so it falls to the miner floor |
| `COINBASE_BONUS_PCT` | 25 | The inclusion bonus pool |
| `INCLUSION_BONUS_K` | 5n | The bonus curve's knee — at `K` actors the miner earns half the pool. `bigint`, because the curve computes in base units |

**Reward function:**

```
computeBlockReward(height):
  if height == 0: return 0
  if height <= CREDIT_FIXED_RATE_BLOCKS:
    return CREDIT_INITIAL_REWARD                    // 42
  epochs = floor((height - CREDIT_FIXED_RATE_BLOCKS - 1) / CREDIT_EPOCH_BLOCKS) + 1
  reward = CREDIT_INITIAL_REWARD - epochs × CREDIT_REWARD_REDUCTION
  return max(reward, 0)
```

**The curve's own sum is 448,820,400 credits** — the fixed-rate period (`1,051,200 × 42`) plus the
decay triangle (`470,000 × Σ(k=1..41)(42 − k)`). ⛔ **That is not the emission total.**

**Emission total: 422,640,000 credits — 94.2% of the curve, and a value the profile CARRIES.**
Genesis creates an `EmissionBox` holding exactly it (TYPES_INTERFACE → EmissionBox).

⛔ **THE TOTAL IS NO LONGER DERIVED FROM THE SCHEDULE, AND THE GUARD INVERTS.** A bound chosen below
the curve cannot be a function of `creditFixedRateBlocks`, `creditEpochBlocks`,
`CREDIT_INITIAL_REWARD` and `CREDIT_REWARD_REDUCTION`, so each profile carries its own. Deriving it
protected against two failures — a total too small starves the box before the terminus, a total too
large strands a residue no rule releases. **This schedule takes the first deliberately and closes it
by rule** (partial payment, above), which leaves the second as the only one a guard can still catch:
`emissionTotal` refuses a carried total that is not **strictly below** the curve's sum. Equal is the
stranding case, because the curve's unpaid tail is what a returned bonus drains through.

⚠ **The box's value is therefore not monotonically decreasing.** A block's release is reduced by the
unearned inclusion bonus (→ "The slices"), so a block with large fees and thin karma-side inclusion
returns more than it releases and the box **rises**. Supply stays bounded either way: what returns is
fee value already in supply and consumed by the same block that returns it, so the box defers that
value rather than minting it.

⚠ **It is not the total supply**, which `ARCHITECTURE → UTXO conservation` defines as
genesis credits plus ordering block rewards, less sinks. Emission bounds the second term
alone; genesis credits sit on top of it and sinks pull the other way.

**Coinbase split:** see "Coinbase Application → The slices" below. It is taken over
block **income**, not over the reward; the treasury's share is per income term; and
the miner floor absorbs every remainder. The treasury share accrues to the `TreasuryBox` and the
unearned bonus stays in the `EmissionBox`; neither reaches the miner, and neither is ever an output.

## Ordering Block (extended)

Additions to the existing `OrderingBlock` type:

| Field | Type | Description |
|-------|------|-------------|
| `powNonce` | `number` | PoW solution (nonce that satisfies target) |
| `powTargetBits` | `number` | Difficulty target for this block |
| ~~`coinbaseOutputs`~~ | — | ⚠ **REMOVED** — the block reward is paid by the settlement transaction's outputs (NODE_INTERFACE → the settlement transaction) |

### ~~CoinbaseOutput~~ — DELETED

> ⚠ **The struct is gone and so is the body field** (`isTreasury` and all — the struct it lived
> on stopped existing). Coinbase outputs are credit outputs of the block's settlement
> transaction.
>
> ⛔ **The `'coinbase'` Merkle leaf domain is retired; its string is a tracked
> reservation** (`TYPES_INTERFACE` → Tracked reservations).

### Block hash and PoW preimage (header model)

The block hash is `blockHash(header)` — the header alone commits to the whole
block transitively (`utxoTxRoot` / `stateRoot`), see
`TYPES_INTERFACE.md`. PoW is likewise header-only:

```
powPreimage = computePowHash(header)
            = blake2b512(encodeHeader({ ...header, powNonce: 0 }))[:32]
```

The miner iterates the nonce against this fixed 32-byte preimage — no
re-serialization per iteration, and the miner never touches CBOR.

## PoW Verification

```ts
verifyOrderingBlockPoW(header: BlockHeader): boolean
```

1. Guard: header is encodable, `powNonce`/`powTargetBits` are safe u64s
   (no-panic — returns `false`, never throws)
2. `preimage = computePowHash(header)` (as above)
3. `hash = blake2b512(preimage || encodeLE64(header.powNonce)).subarray(0, 32)`
4. `meetsPowTarget(hash, orderingPowTarget(header.powTargetBits))` — the shared admission rule
   (`VALIDATION_INTERFACE → meetsPowTarget`, `→ orderingPowTarget`), not a local bit count

## Difficulty Schedule

`powTargetBits` is a **deterministic function of the chain's own headers** — never of a clock. The
schedule reads the header's `createdAt` stamps, which the header timestamp rules below make a consensus
input; no node reads its own clock to compute a target, so every node computes the same target for the
same chain, for all time. It is **ASERT**, absolute and anchored at block 1, in log space over the
1/256-bit representation (`VALIDATION_INTERFACE → asertTargetBits` is the function; this section is the
rule):

```
anchor:   block 1 — B_a = profile.orderingBlockPowTargetBits, t_a = createdAt(1)
block 1:  powTargetBits === B_a
block N ≥ 2, parent P = block N−1:
   Δ    = (createdAt(P) − t_a) − ideal · (N − 2)                  // ms actual − ms expected, anchor → parent
   B_N  = clamp( B_a − floorDiv(Δ · 256, halflife), floorBits, ceilingBits )
```

All arithmetic is BigInt; `floorDiv` rounds toward −∞ — a fast chain's negative quotient rounds
*harder*, a slow chain's positive quotient rounds to *no easing yet*, so the schedule is never easier
than exact. `ideal` is `profile.orderingBlockIdealMs`; `halflife` is `RETARGET_HALFLIFE_BLOCKS · ideal`;
the bounds are `profile.orderingBlockPowTargetFloorBits` and `…CeilingBits`, absolute and clamped after
the computation, never a per-step clamp (`TYPES_INTERFACE → Network profiles`; the numbers and their
standing in `CONSTANTS → Ordering-block PoW`). The schedule reads the **parent's** stamp, not the block's
own — the reference's shape (`aserti3-2d` evaluates on the parent), so a check against it is exact: our
block 1 plays the reference's anchor-parent and our block 2 its anchor, and `N − 2` is its
`height_delta + 1`.

**The schedule is absolute, so a paused chain owes every missed block.** Height never drifts from time
— the property every "at 60 s" duration in this repo rests on — and its other face is that a chain idle
for days walks to the floor and, on resumption, mines the owed blocks at floor difficulty, coinbase
included. The per-network floor prices that catch-up (20 bits on testnet and mainnet — about 1.4 s of
one core per owed block); the floor is the lever, not a different estimator (ruled 2026-08-29).

**There is no wall-clock retargeting**, and there never was a sound one: the previous scheme
(`prevTarget × actualDuration / expectedDuration` per credit epoch) measured `actualDuration` on each
node's local clock, so two honest nodes could compute different targets. ASERT reads the chain's own
stamps and nothing outside it. The one place a local clock enters is the future bound below, which is
an acceptance rule and not a target input.

**Enforcement (apply — all paths: gossip, sync, reorg):** a block whose `header.powTargetBits` differs
from the schedule evaluated over the **stored parent** is rejected — a consensus check, not a sanity
floor. A height-1 block's bits must equal `B_a`. Fork choice recomputes every competing header's target
from that branch's own headers and never trusts a declared one (`VALIDATION_INTERFACE → verifyHeaderChain`,
reason `'target'`).

### Header timestamp rules

`createdAt` is a consensus input. Two rules, both header-level, both in the apply funnel and in
`verifyHeaderChain` (`VALIDATION_INTERFACE → verifyCreatedAtOrder`, `→ verifyCreatedAtBound`):

| Rule | Statement | Class |
|---|---|---|
| **Order** | `createdAt(N) > createdAt(N−1)` for N ≥ 2 — strict, Ergo's header rule 205 | **consensus** — a violation is a bad chain: refuse; in a fork segment refuse-whole and penalise `misbehavior` (reason `'time'`) |
| **Future bound** | `createdAt(N) ≤ now + MAX_FUTURE_DRIFT_MS`, `now` the receiving node's clock | **acceptance**, not consensus — the block may be valid a minute later: refuse, **no penalty, no `refused_headers` mark** (`NODE_INTERFACE → Fork choice decides on verified headers`, what is remembered); in a fork segment reason `'clock'`, the one refusal that is not a verdict on the chain |

Block 1 has no parent and no order check; the future bound applies to it as to every block.

**Why the bound is an acceptance rule.** The target a chain implies is deterministic; whether this node
accepts a block *now* depends on its clock, and two honest nodes can disagree now and agree a minute
later. No hashrate-tracking retarget avoids the touchpoint: a chain-only rule bounding each stamp's
increment over its parent limits how *fast* chain time can run ahead of real time, not how *far*, and
an attacker who keeps pushing walks difficulty to the floor. A future-refused block is recovered by the
sync path — the producer's next `SyncInfo` shows a taller tip, the receiver's `heightByBlockId` lacks
the id, and the `Inv → ModifierRequest` round re-delivers it inside the bound (`NET_INTERFACE → Sync
State Machine`). Replay never trips it: a stored block is in the past by the time it is re-applied on
restart or in a reorg.

**What the bound buys an attacker, and no more.** Every honest receiver holds chain time at
`real + skew`, and under an absolute schedule the chain can be at most `skew / ideal` = 10 blocks ahead
of schedule *ever* — a total, not a rate; those blocks enjoy a target eased by `2^(skew / halflife)`,
about 1.024. Strict order carries an inflated stamp forward but cannot compound it, because the bound is
against real time. Stamping `parent + 1` to stall chain time lasts until the next honest block stamps
real time; timewarp needs epoch boundaries, and ASERT has none. An honest node ahead by more than the
drift has its blocks delayed to sync latency; one behind refuses fresh blocks only when it lags by more
than the drift plus a block's age — a stamp is at least one solve old on arrival — and converges through
the sync path.

**Producer side.** The template stamps `createdAt = max(now, createdAt(tip) + 1)` (`NODE_INTERFACE →
Block creation`), so a node whose clock lags its peers still produces valid blocks; stamps stay
node-set and `POST /mining/submit` is unchanged.

## Mining API

**Exposure (audit M-7):** the `/mining` routes are mounted **only** when
`nodeRole === 'miner'`. **A miner node is by definition one that serves
templates** — the node holds no solver, so there is no configuration in which
it mines without exposing this surface. On a server-role node the paths simply
do not exist (404 from the server).

**Authentication (audit M-7):** a miner node REQUIRES a configured, non-empty
`MINING_SECRET` — `NODE_ROLE=miner` with an empty secret **fails at startup**
with a configuration error; there is no unauthenticated passthrough mode. Every `/mining/*` request must carry
`Authorization: Bearer <MINING_SECRET>`; the comparison is constant-time
(`crypto.timingSafeEqual` over length-guarded buffers). Missing or wrong
credentials → 401, before any handler logic (including `?miner=`).

### GET /mining/template

Returns the current block template. The block creator assembles one at startup
and rebuilds it whenever the tip moves.

`?miner=<hex(32)>` (authenticated, optional): sets the coinbase payout pubkey
used for subsequently assembled templates. Invalid hex → 400. Because auth
precedes it, only a holder of the mining secret can redirect the coinbase.

**Response (200):**
```json
{
  "header": {
    "protocolVersion": 1,
    "height": 123,
    "prevBlockHash": "hex(32)",
    "utxoTxRoot": "hex(32)",
    "stateRoot": "hex(32)",
    "validatorId": "hex(32)",
    "powTargetBits": 20,
    "createdAt": 1234567890000,
    "interlinkRoot": "hex(32)"
  },
  "utxoTxIds": ["hex(32)", ...],
  "postIds": ["hex(32)", ...],
  "powPreimage": "hex(32)"
}
```

`powPreimage` is `computePowHash(header)` (see "Block hash and PoW preimage") —
the fixed 32-byte preimage the miner hashes with the nonce. The miner never
touches CBOR.

`header.protocolVersion` is the era at `header.height` — `protocolVersionAt(schedule, height)`
(`ARCHITECTURE → Protocol Versioning`): the creator stamps it and the miner copies it, so the template
for the first block of a new era carries the new version.

`interlinkRoot` is the node's — `interlinkRoot(updateInterlinks(I(tip), tipHash, level(tip)))` from
the tip the template builds on (`TYPES_INTERFACE` → Interlink vector); the miner supplies a nonce and
a height, never a header field.

#### Template and submit

**A miner node holds a template, or has declined to build one and said why.** It builds one at
startup and rebuilds it whenever the tip moves — its own block finalizing, a peer's block applying,
or a reorg committing. **A transaction arriving does not rebuild it**: what goes into a block and
when one is produced are separate questions, and a rebuild mid-solve would void every miner's
in-flight work.

**A build whose body the mutation phase rejects is repeated, not abandoned.** The creator evicts
every pool row the rejected body carried — transaction and prune rows alike, the cleanup a rejected
finalize runs — and fills again from what the pool still holds, until it holds a template or a body
carrying **no pool row** is rejected. Every repetition strictly shrinks the pool, which is what bounds
the loop. A rejected body that carried nothing is terminal: the chain state cannot back even the
empty body, or a defect is throwing, and no repetition changes either — the creator logs it once
(`Not producing block at height N: …`) and holds no template until the tip moves. A settlement this
chain cannot build at all (no emission box at a height that releases, no karma pool at a height that
draws on it) is terminal on the first attempt for the same reason. The loop runs only inside a build
that holds no template, so the stability rule below is untouched.

**A body's size is never the cause.** The fill measures the assembled tree against the body budget
and the rebuilt settlement against `MAX_SETTLEMENT_BYTES` before the template exists
(`MEMPOOL_INTERFACE` → The fill budget is bytes; `getPendingEntries` is a count), so the block
`verifyOrderingBlockStructure` weighs at submit is one the fill already fitted; the rejected-body
loop above is for a body the **mutation phase** refuses.

**Holding one and serving one are separate**, and 404 is routine again for the second: a node that has
not yet met its peers withholds the template it holds. See *The peer-readiness gate* below. **A 404
from a miner node is one of two things** — that gate, or a terminal decline, which is on the node's
log. Any other 404 is a defect.

⚠ **The template is stable for a height, and that is a load-bearing property, not an implementation
detail.** `POST /mining/submit` reconstructs the header from *the node's current template* plus the
submitted nonce, so any rebuild — even one whose body is byte-identical, since `createdAt` is stamped
at build — invalidates a nonce found against the previous preimage. Stability is what lets a miner
treat `header.height` as the whole staleness key.

#### The peer-readiness gate

**A miner node withholds the template until it has met its peers.** The condition is:

> at least one **Active** peer, **or** the discovery window has elapsed, **or** the node has no
> bootstrap address to dial.

The answer is `404 { error: 'No block template available' }` — **the same response the absent-template
case gives, deliberately.** `scripts/miner.mjs` keys its retry on that status alone and has no give-up
count, so a node that has not met its peers is polled until the gate opens. The gate sits behind the
`?miner=` validation: a malformed payout key earns its 400 whatever the node's readiness is.

**What the gate protects.** Journal retention is the floor under revert depth — `block-apply.ts`
purges journals below `height − maxReorgDepth` (the profile's reorg horizon, `TYPES_INTERFACE → Chain
reorganisation`), so a node that mines past that depth alone has no journal to revert with and can never
rejoin a mesh it later meets. Fork resolution bottoming out at the genesis state (`NODE_INTERFACE` →
"Fork resolution bottoms out at the genesis state") makes height 0 a valid ancestor; this keeps a node
inside the horizon where that ancestor is still reachable. It works **within** the horizon and does not
widen it — and it holds a node back only until its discovery window elapses, so a node partitioned after
that keeps mining, and a partition longer than the horizon is a permanent split.

**Active peers, not known ones.** `net`'s `getConnectedPeers()` filters on peer state; `peers()` lists
every peer holding an open libp2p connection, including ones that have not completed — or have
failed — the DAGsocial handshake. A peer that failed it is on another network, and must not answer
"have I met peers on mine".

**The window is a timer and is named as one.** It stands for *"I have finished looking"*, not for
*"something is ready"*. Its duration is **derived from `net`'s bootstrap re-dial cadence, not chosen**:
a failed initial dial gets its next attempt on net's 30 s outbound tick, so a shorter window gives up
before making a second attempt. It is a **node-local constant**, not a profile field — `ARCHITECTURE.md`
scopes profiles to the timescale, difficulty and genesis axes, and on a live network the window never
fires at all, because peers exist and the peer clause answers first.

⚠ **`net.start()`'s return is already a bootstrap-completion signal** — it awaits every bootstrap dial
and handshake in sequence, so a reachable peer is Active before it returns. That signal is **not
sufficient as the gate**: it fires with zero peers both for a node whose dial failed and for a node
with no bootstrap address, and those two need opposite answers. The window covers the first; the
third clause answers the second.

**No bootstrap address means ready at once.** Such a node never dials: the floor phase iterates an
empty list, and the fill phase requires outbound connections at or above `minPeers`, which it
permanently is below — inbound connections do not count toward that floor. It is the origin of its
network by configuration. Waiting out a window would stand in for an event that cannot occur.

**`POST /mining/submit` is NOT gated.** By the time a nonce arrives the hashes are spent, and the node
handed out the preimage while it was ready. Readiness is also **not latched** — a node whose only peer
drops before the window elapses withholds again, which is correct: it is alone again.

**This endpoint also returns 500**, with `{ error: 'Block template header is not
encodable' }`. `computePowHash` returns `Buffer | null`, `null` for a header outside the encodable
domain (`VALIDATION_INTERFACE` → `computePowHash`). The template header is built locally by
`block-creator.ts`, so `null` means this node built a header it cannot itself encode — a bug in the
creator, not a client error.

**500, not 404.** They are different claims: 404 says no template exists yet and the miner should
retry, which is routine. 500 says a template exists and is malformed, which is not. A miner that
retried a 404 forever against a broken creator would never learn anything — and silently omitting
`powPreimage` would be worse still, because the miner would mine against `undefined` and submit
nonces that can never verify.

### POST /mining/submit

Submits a solved nonce. The node rebuilds the block from its own stored
template — the request carries **only** `{ height, powNonce }`, so an external
miner cannot substitute entries, coinbase outputs, or any body content.

**Request:**
```json
{
  "height": 123,
  "powNonce": 456789
}
```

**Response (201):**
```json
{
  "blockHash": "hex(32)",
  "height": 123
}
```

**Errors:**
- 401: missing/wrong bearer token
- 400: missing fields
- 422: PoW invalid or template stale (height no longer matches the current template)

On success, the node assembles the final block (inserts `powNonce`, signs with
validator key), stores it, broadcasts it, and applies it — the settlement
transaction's credit outputs are the reward.

## Coinbase Application

The coinbase carries the block's **income**, not a fixed reward: the emission this block
**releases**, plus the value of the `FeeBox` outputs the block's transactions carry
(TYPES_INTERFACE → FeeBox). Storage rent becomes a third term, and nothing in this rule is
revisited when it arrives — that is the point of stating it income-shaped.

⛔ **INCOME'S EMISSION TERM IS THE RELEASE, NEVER THE SCHEDULE.** It is
`min(computeBlockReward(height), value)` for the box this block spends, and the two differ on
every block from exhaustion onward (→ Emission Schedule). **A split taken over the scheduled
figure pays out credits the box never released**, and the whole difference is minted from
nothing — `ARCHITECTURE` → UTXO conservation, and the bound this schedule rests on. The box has
to be read **before** the slices are computed, not after: the release is an input to the split,
not a correction applied to its result.

⛔ **`fees` is a sum over boxes, and resolves no inputs.** Every fee in the block is written
down in it, so the total is a property of the body's own bytes. **Block application consumes
the fee boxes in the block that created them**; the pair nets out of the prover feed, so they
never reach the AVL tree and `stateRoot` is unaffected (NODE_INTERFACE → Block Journal → "One log,
not parallel arrays").

### On block creation (miner):
1. Fill the body **first** — the fees and the actor count are properties of what was
   included, and the settlement is derived from the body, so it is built **last**. It is
   itself part of the body, which the producer's byte budget must absorb: the settlement
   grows with what was selected, so it is **rebuilt on each trim iteration**, never measured
   once (trimming shrinks it monotonically)
2. `income = computeBlockReward(height) + fees`, `fees = Σ FeeBox.value` over the body
3. Split per the slice table below. **Only the miner's slice becomes settlement credit
   outputs**; the treasury's accrues to the `TreasuryBox` (TYPES_INTERFACE → TreasuryBox)
4. The miner's slice rides as **credit outputs of the settlement transaction** — the body
   has no `coinbaseOutputs` field, and the credits are **spent from the `EmissionBox`** (and
   the consumed fee boxes) by the same transaction that emits them: source and destination
   named in one operation, nothing minted

The fee-box pairing note above is the same shape one level down: a `FeeBox` is a marker
consumed by the settlement in the block that created it.

### The slices

| Slice | Share | Destination |
|---|---|---|
| Treasury | `COINBASE_TREASURY_PCT` | Per **term** — of emission and of fees, never of storage rent |
| Miner floor | `COINBASE_MINER_FLOOR_PCT` | Guaranteed, plus every remainder |
| Backer pool | `COINBASE_BACKER_PCT` | **AHEAD OF CODE** — nothing stakes and nothing links, so this share falls to the miner floor |
| Inclusion bonus | `COINBASE_BONUS_PCT` | `pool × actors ÷ (actors + INCLUSION_BONUS_K)` to the miner; the unearned remainder is **not minted** — it returns to the `EmissionBox`, which is why that successor is `value − release + unearned` and can exceed its predecessor. The pool is a share of income, so it is computed over the **release** like every other slice |
| Storage rent | — | A third income **term**, not a slice: the treasury takes `COINBASE_TREASURY_PCT` of emission and of fees and **none of rent**, so rent reaches the miner floor entire |

`actors` is the count of **distinct owners of the karma boxes** spent by the block's
karma-side transactions, excluding the block's own validator.

⛔ **Never derived from `tx.signatures`.** Producing a signature is free, so a
signature-keyed count is inflated by appending keys that hold nothing. Every karma-side
operation spends a box that names its actor, and creating any of those boxes cost karma.

**The miner floor takes the remainder**, so the outputs sum to exactly the income: four
percentages of one income do not sum back to it under truncation. That routes both the
rounding and storage rent's treasury exemption to miners, which is where rent belongs
(ARCHITECTURE → UTXO conservation).

⛔ **Neither the treasury slice nor the unearned bonus may fall to the miner.** A miner
who recovered their own forfeit would face a delay rather than a cost, and the bonus
would price nothing.

⛔ **THE PROPERTY IS THAT NO MINER RECOVERS THEIR OWN FORFEIT, not that the forfeit is locked away.**
A share returned to the `EmissionBox` is paid out only once the box reaches exhaustion, to whichever
miners exist then and in hashrate proportion. The forfeiting miner's expected recovery is their share
of a payout at the far end of a thirty-year schedule, which prices as approximately zero. **The bonus
is a cost and not a delay**, and the cost is paid to future miners rather than withheld from everyone.
✅ **A returned share is neither a lock nor a burn** — it extends the runway, so a chain with thin
karma inclusion emits more slowly and lives longer.

**The treasury slice accrues to the `TreasuryBox` on every network**, which is why no profile carries a
treasury key and no coinbase output is flagged as the treasury's. ARCHITECTURE → Treasury
requires unspendability **by absent rule** rather than by a withheld key; a box block
application has no release path for is that rule, while a key nobody admits to holding is
the shape it rejects.

⚠ **Emission and the treasury slice come from opposite directions.** The miner's slice is
paid out of released emission plus recreated fees, so it is a settlement credit output; the
treasury's is never released at all, so it is a value the successor box carries. Both are
derived from the same `splitCoinbase` result and neither is the producer's choice.

### On block receipt (relay node):
1. Verify PoW
2. Verify the settlement's credit outputs sum to the **miner's slice** the slice table yields for this height, fee sum and actor count — `income` less the treasury share and the unearned bonus; the first accrues to the `TreasuryBox` and the second is never minted, so neither is a credit output
3. Verify the two box transitions, both **exactly**: the emission box's successor holds `value − min(computeBlockReward(height), value) + unearned` and the treasury box's holds `value + treasury`. ⛔ **`min` is the release cap and `unearned` is the return.** The release is what the schedule owes bounded by what the box holds, and the forfeited bonus is added straight back — which is why this successor, alone among the two, can exceed its predecessor. This is where the split is enforced — emission and treasury successors are inputs and outputs of the same transaction, so a block paying the whole income to its miner is refused by **conservation itself**
4. Verify no output carries `value === 0` — otherwise `[]` and `[{value: 0}]` are two valid encodings of one block, with different `utxoTxRoot` and different block hashes. **Not made redundant by conservation**, which a zero-value output satisfies
5. Settlement credit outputs with `lockedUntilBlock > currentHeight` are stored but not spendable — `SPEND_TIMING`'s `credit` entry refuses a locked input at `validateTx` step 3

**Both transitions ride in the block**, as parts of a transaction committed under
`utxoTxRoot` — the producer's result is committed, so a disagreement is a rejected block
rather than a silent divergence — and both are covered by `stateRoot` besides: an unbacked
successor forks its author out at the next header.

> ⚠ **The mechanism's risk is determinism of the VERDICT, not of the bytes.** ⛔ **The verifier
> CANNOT reconstruct a byte-identical settlement**: `?miner=` makes the coinbase payout key
> producer-chosen, so it reaches the verifier only as an output of the settlement it is checking.
> What every verifier must reach identically is the **same verdict** — each **derived** quantity
> recomputed and compared, each **producer-chosen** one read and constrained by a stated rule,
> and no field neither. Every ordering the derivation depends on must be one the block already
> fixes — NODE_INTERFACE → the settlement transaction admits exactly three sources and no fourth.

## Config

| Variable | Class | Default | Purpose |
|----------|-------|---------|---------|
| `MINING_SECRET` | operational | — | Bearer token for the mining API. **Required non-empty when `NODE_ROLE=miner` — startup fails otherwise.** Unused on a server-role node, whose `/mining` routes are unmounted. There is no unauthenticated mode. |
| `NETWORK_TYPE` | network-identity | `testnet` | Selects the network profile — and with it every value in the table below. The **only** environment variable that may change a consensus parameter |

Classes are defined in `NODE_INTERFACE.md → Configuration`. A `consensus` variable
**MUST NOT be readable from the environment** — two nodes differing on one of these
partition permanently.

**The four `consensus` rows that were here are no longer configuration.** They and two
further values this contract depends on resolve as follows — the first four are fields of
the network profile (`TYPES_INTERFACE §Network profiles`), selected together by
`NETWORK_TYPE`:

| Value | Source | Per-network? | Purpose |
|---|---|---|---|
| `orderingBlockPowTargetBits` | profile | **yes** | Ordering block PoW difficulty |
| `creditFixedRateBlocks` / `creditEpochBlocks` | profile | **yes** | Emission schedule shape, and the `EmissionBox`'s genesis value |
| `creditMinerRewardDelay` | profile | **yes** | Blocks before a coinbase output is spendable |
| `CREDIT_INITIAL_REWARD` | constant | no | Credits per block in the fixed-rate period, base units of 10⁻⁸ |
| `COINBASE_TREASURY_PCT` | constant | no | Percent of emission and of fees to treasury |
| `COINBASE_MINER_FLOOR_PCT`, `COINBASE_BACKER_PCT`, `COINBASE_BONUS_PCT`, `INCLUSION_BONUS_K` | constant | no | The rest of the coinbase split |

> ✅ **RESOLVED — the bypass is closed. All four are profile-sourced. Verified 2026-08-11.**
> This read `PARTLY IMPLEMENTED` until Phase 9.
>
> `orderingBlockPowTargetBits` was already profile-sourced. **The other
> three now are too:** `node/src/config.ts` reads `creditFixedRateBlocks`, `creditEpochBlocks`
> and `creditMinerRewardDelay` from the profile, `computeBlockReward` uses
> `nodeConfig.creditFixedRateBlocks` / `nodeConfig.creditEpochBlocks` rather than the module
> constants, and **`CREDIT_FIXED_RATE_BLOCKS` and `CREDIT_EPOCH_BLOCKS` occur zero times in
> `packages/node/src`**.
>
> **Devnet's compressed values are now read.** `types/src/network.ts` sets `1000` and `100` on
> the devnet profile against mainnet's constants, and those are the numbers a devnet node uses.
> The consequence this marker recorded — *"a devnet node runs mainnet emission and maturity
> timing"* — no longer holds.
>
> ⚠ **The record of what it was, because the fix crossed a consensus boundary.**
> `block-apply.ts`'s maturity check is apply-time, so re-pointing it at the profile was a
> **consensus change rather than a refactor** — noted here so the change is visible to anyone
> reconstructing why devnet and mainnet emission diverged.
>
> ⚠ **The bypass class is wider than this table.** This table holds mining values, so an
> enumeration run from it finds three. Enumerating `NetworkProfile` itself finds **five** — the
> two extra are `vouchCooldownBlocks` and `inviteProbationBlocks`, which are not mining values
> and so cannot appear here. See `ARCHITECTURE §Network identity` for the full set. **Do not
> re-derive the count from this section.**
>
> **Note which two did *not* become per-network.** `CREDIT_INITIAL_REWARD` and
> `COINBASE_TREASURY_PCT` are *economics*, and the split in `ARCHITECTURE §Network Identity`
> is normative: compress time, never economics. Devnet mines fast; it does not mine rich.
> A test chain that pays a different reward is a test chain that cannot catch a reward bug.

> ⚠ **This section previously told operators to change the difficulty.** The removed
> sentence read *"Production would use 30+"* — an operator following it while the network
> ran the default would have forked themselves off at the first block. The default of 12 is
> intentionally low for development (~2K hashes, sub-second on a modern CPU); raising it for
> production is a **network-wide coordinated change**, and under the profile model it is not
> even expressible as a deployment setting. See invariant 7.

## Invariants

1. Coinbase value per block matches the **miner's slice** exactly — stated once at
   "On block receipt" step 2, and not restated here, because this file has already
   carried two copies of this rule that disagreed. **No coinbase output carries
   `value === 0`** at any height
2. The coinbase's split matches the slice table above. The **miner's** half is the
   coinbase's sum; the **treasury's** half is enforced as the `TreasuryBox` successor's
   value, and the emission box's successor pins the release net of the forfeit. A
   total-only check on the coinbase alone would accept a block that forfeited nothing
3. Coinbase outputs cannot be spent before `lockedUntilBlock`, and every coinbase
   output's `lockedUntilBlock` **equals `height + CREDIT_MINER_REWARD_DELAY`** —
   enforced at apply on all paths (gossip, sync, reorg), not only in the gossip
   validator. A block with any other coinbase lock is rejected.
4. `powTargetBits` **equals the schedule evaluated over the stored parent** (→ Difficulty
   Schedule), enforced at apply on all paths — not a self-declared value with a sanity floor.
   A mismatch rejects the block; a height-1 block's bits equal the anchor's.
5. Difficulty is a function of the chain's own headers; no node reads a clock to compute a
   target. The future bound is an acceptance rule, not a target input (→ Header timestamp rules).
6. Block hash covers PoW fields — changing `powNonce`, `powTargetBits` or `createdAt` invalidates the block
7. Old blocks verify against the schedule their own chain implies; since the schedule is a pure
   function of the headers below a block, that is the same value on every node and for all time.

> ⛔ **SUPERSEDED — 2026-08-29, the ASERT unit.** Under P2-A's profile-sourced constant,
> `expectedTarget(_height)` discarded its argument, so invariant 7 held only within one chain's life
> — the constant's move from 3072 to 5984 (2026-08-12) re-targeted history and a fresh chain absorbed
> it. The schedule above makes invariant 7 true as written: a target is a function of the headers
> below the block. The reorg guard that note named as expiring "with ASERT" had already been replaced
> by a work comparison over verified headers (`NODE_INTERFACE → Fork choice decides on verified
> headers`, step 7).

8. The mining API is never served unauthenticated: external mode requires a
   configured `MINING_SECRET` (enforced at startup, not per-request), every
   request is bearer-authenticated with a constant-time comparison, and the
   coinbase payout override (`?miner=`) is reachable only behind that auth.
   Internal mode mounts no mining routes. (audit M-7)
9. A miner node **serves no template before it is peer-ready**, and gating happens at
   serve rather than at creation — the node holds a template throughout, or has declined
   terminally (*Template and submit*), so the gate never weakens the holding rule. See *The
   peer-readiness gate*.

## Miner Script

`packages/node/scripts/miner.mjs` — standalone Node.js process (the only miner
script; deployed via `scripts/dagsocial-miner.service`):

1. `GET /mining/template` (Bearer `MINING_SECRET`; `?miner=MINER_PUBKEY` when
   set) → reads `powPreimage`, `header.powTargetBits`, `header.height`.
   **A 404 logs `No template available, waiting 5s...` and retries, with no give-up
   count** — that unboundedness is what lets the node withhold for as long as *The
   peer-readiness gate* requires without any miner-side change
2. Loop: `nonce++`, `hash = blake2b512(hex2buf(powPreimage) || encodeLE64(nonce))`,
   test with its **own mirrored copy** of `meetsPowTarget` against an `orderingPowTarget` hoisted
   out of the loop. The script stays standalone — `node:crypto` only, no build step, because
   the machine that mines is not required to build the workspace — so agreement with
   `@dagsocial/validation` is enforced by a mirror test that extracts both declarations by
   name, not by an import
3. **At each duty-cycle yield, re-read the template and abandon the search if `header.height` has
   moved.** This is a **requirement on the script**, not an optimisation: the solve time *is* the block
   interval, so a miner that grinds on past a tip move spends a full expected solve on an answer the
   node will reject. Checking once per work window caps that waste at one window per lost race, at any
   difficulty. ⚠ **`header.height` suffices only because the template is stable** — see
   *GET /mining/template*. If same-height rebuilds are ever reintroduced, height stops discriminating
   and the miner needs a real template identity
4. `POST /mining/submit` (Bearer) with `{ height, powNonce }`
5. Repeat

⚠ **The duty cycle sleeps *between* work windows, so `MINER_PCT` throttles hashing within a solve and
does not pace the interval between blocks.** Where a solve finishes inside one window — devnet, at
~4,096 expected hashes — the sleep never runs and block production is bounded by how fast the node
rebuilds a template. **`MINER_PCT` is not a cadence control.**

Config via env: `NODE_URL` (default `http://localhost:3000`), `MINING_SECRET`
(required — the node refuses unauthenticated mining), `MINER_PUBKEY` (optional
coinbase payout override), `MINER_PCT` (duty-cycle CPU throttle, default 25).
