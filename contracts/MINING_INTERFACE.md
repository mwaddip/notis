# MINING Interface Contract

**Component:** `@dagsocial/node` (mining subsystem)
**Protocol version:** 2
**Last updated:** 2026-08-13

## Scope

Mining subsystem for ordering blocks. Owns: credit emission schedule, coinbase
structure, PoW verification for ordering blocks, difficulty adjustment, mining
API endpoints (template + submit). Depends on:

- `@dagsocial/types` — data structures, constants, hashing
- `@dagsocial/validation` — stateless PoW verification
- `@dagsocial/node` — store (block persistence, UTXO), block creator, config

## Emission Schedule

Ergo-style linear decay **to zero — there is no tail**. At 60-second blocks:

| Parameter | Blocks | Duration |
|-----------|--------|----------|
| Fixed-rate period | 1,051,200 | ~2 years |
| Epoch (reduction interval) | 129,600 | ~90 days |
| Decay phase | 6,350,400 | 49 epochs, ~12.07 years |
| **Total** | **7,401,600** | **~14.07 years** |

Block 7,401,600 is the last that pays. Above it the reward is 0 and the coinbase carries
whatever the other income terms yield — fees, and storage rent when it arrives.

| Parameter | Value | Description |
|-----------|-------|-------------|
| `CREDIT_INITIAL_REWARD` | 100 | Credits per block in fixed-rate period |
| `CREDIT_REWARD_REDUCTION` | 2 | Credits reduced per epoch |
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
    return CREDIT_INITIAL_REWARD                    // 100
  epochs = floor((height - CREDIT_FIXED_RATE_BLOCKS - 1) / CREDIT_EPOCH_BLOCKS) + 1
  reward = CREDIT_INITIAL_REWARD - epochs × CREDIT_REWARD_REDUCTION
  return max(reward, 0)
```

**Emission total: 422,640,000 credits** — the fixed-rate period (`1,051,200 × 100`) plus
the decay triangle (`129,600 × Σ(k=1..49)(100 − 2k)`).

**It is also a value in state.** Genesis creates an `EmissionBox` holding exactly this
total, and each block spends it to a successor `computeBlockReward(height)` smaller
(TYPES_INTERFACE → EmissionBox). The total is therefore both the schedule's sum and the
box's genesis value, and the box **derives** it from the parameters above rather than
carrying its own copy — a second copy that disagreed would starve the box before the
terminus or strand a residue no rule releases. Every network derives its own from its own
`creditFixedRateBlocks` and `creditEpochBlocks`.

⚠ **It is not the total supply**, which `ARCHITECTURE → UTXO conservation` defines as
genesis credits plus ordering block rewards, less sinks. Emission bounds the second term
alone; genesis credits sit on top of it and sinks pull the other way.

**Coinbase split:** see "Coinbase Application → The slices" below. It is taken over
block **income**, not over the reward; the treasury's share is per income term; and
the miner floor absorbs every remainder. The treasury share and the unearned bonus accrue
to the `TreasuryBox`, never to the miner and never to an output.

## Ordering Block (extended)

Additions to the existing `OrderingBlock` type:

| Field | Type | Description |
|-------|------|-------------|
| `powNonce` | `number` | PoW solution (nonce that satisfies target) |
| `powTargetBits` | `number` | Difficulty target for this block |
| `coinbaseOutputs` | `CoinbaseOutput[]` | Block reward distribution |

### CoinbaseOutput

| Field | Type | Description |
|-------|------|-------------|
| `owner` | `Uint8Array` (32 bytes) | Recipient public key |
| `value` | `number` | Credits minted |
| `lockedUntilBlock` | `number` | Height at which credits become spendable |
| `isTreasury` | `boolean` | **Always `false`** — no output is the treasury's. Scheduled for deletion; see TYPES_INTERFACE → Coinbase output |

### Block hash and PoW preimage (header model)

The block hash is `blockHash(header)` — the header alone commits to the whole
block transitively (`subBlockRoot` / `utxoTxRoot` / `stateRoot`), see
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
4. `meetsPowTarget(hash, powTarget(header.powTargetBits))` — the shared admission rule
   (`VALIDATION_INTERFACE § powTarget / meetsPowTarget`), not a local bit count

## Difficulty Schedule

`powTargetBits` is a **deterministic function of block height** — never of wall
clock. On-chain time is block height (ARCHITECTURE invariant), so the difficulty
target may not depend on `Date.now()` or a header timestamp, and every node must
compute the same expected target for a given height, for all time.

Phase 1 uses a **fixed target**, sourced from the network profile:

```ts
expectedTarget(height) = profile.orderingBlockPowTargetBits   // constant in height, Phase 1
```

> ✅ **RESOLVED — the `NOT IMPLEMENTED` marker here was stale, corrected 2026-08-10,
> re-verified 2026-08-11.** It
> read "the profile does not exist yet"; it does (`TYPES_INTERFACE §Network profiles`), and
> `node/src/config.ts` sources `orderingBlockPowTargetBits` from it, so the value is no longer a
> per-process environment read. ⚠ **The `VIOLATED` note under invariants 4/5/7 still describes
> the environment-read world and has not been re-ruled** — do not read the two as agreeing.
>
> **Precision about what the defect was, because the obvious reading sends you the wrong
> way.** A constant *is* a function of height — a valid one. The defect was never that
> `expectedTarget` ignores its argument; it was that the value it returned came from the
> environment, which made it a function of *the operator* as well. Profile-sourcing closes
> invariants 4, 5 and 7 **without introducing any height schedule.** Do not build a retarget
> here. The unused `height` parameter stays as the seam a real schedule will need, and it
> stays unused until that schedule is designed.

There is no wall-clock retargeting. Rationale: the previous scheme
(`prevTarget × actualDuration / expectedDuration`, clamped ±50%) fired only every
`CREDIT_EPOCH_BLOCKS` (~90 days) and made the target a function of local wall
time, so two honest nodes could compute different targets and a miner could
self-declare a floor target for near-free blocks. A real hashrate-tracking
retarget needs a deterministic on-chain time source (e.g. median-of-header-
timestamps with future bounds); that is deferred, and ordering-block difficulty
is expected to evolve (possibly karma-proportional) in a later phase. Until then
the target is fixed by schedule and enforced.

**Enforcement (apply — all paths: gossip, sync, reorg):** a block whose
`header.powTargetBits !== expectedTarget(height)` is rejected. This is a consensus
check, not a sanity floor — the target is fixed by schedule, not miner-chosen.

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

Returns the current block template. The block creator assembles this on a timer
(60s default) and whenever a sub-block arrives.

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
    "subBlockRoot": "hex(32)",
    "utxoTxRoot": "hex(32)",
    "stateRoot": "hex(32)",
    "validatorId": "hex(32)",
    "powTargetBits": 20,
    "createdAt": 1234567890000
  },
  "subBlockRefs": ["hex(32)", ...],
  "subBlockEntries": [{ "postId": "hex(32)", "parentRefs": ["hex(32)"], "author": "hex(32)" }, ...],
  "pruneEntries": [...],
  "utxoTxIds": [],
  "coinbaseOutputs": [
    { "owner": "hex(32)", "value": 90, "lockedUntilBlock": 843, "isTreasury": false }
  ],
  "powPreimage": "hex(32)"
}
```

`powPreimage` is `computePowHash(header)` (see "Block hash and PoW preimage") —
the fixed 32-byte preimage the miner hashes with the nonce. The miner never
touches CBOR.

**A miner node always holds a template.** It builds one at startup and rebuilds it whenever the tip
moves — its own block finalizing, a peer's block applying, or a reorg committing. **Sub-block arrival
does not rebuild it**: what goes into a block and when one is produced are separate questions, and a
rebuild mid-solve would void every miner's in-flight work.

**Holding one and serving one are separate**, and 404 is routine again for the second: a node that has
not yet met its peers withholds the template it holds. See *The peer-readiness gate* below — that is
the only condition under which a 404 from a miner node is expected, and any other 404 is a defect.

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
purges journals below `height - MAX_REORG_DEPTH`, so a node that mines past that depth alone has no
journal to revert with and can never rejoin a mesh it later meets. Fork resolution bottoming out at
the genesis state (`NODE_INTERFACE` → "Fork resolution bottoms out at the genesis state") makes height
0 a valid ancestor; this keeps a node inside the window where that ancestor is still reachable. It
works **within** `MAX_REORG_DEPTH` and does not widen it.

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

**This endpoint also returns 500** (Phase 1f), with `{ error: 'Block template header is not
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
validator key), stores it, broadcasts it, and applies coinbase mints.

## Coinbase Application

The coinbase carries the block's **income**, not a fixed reward: `emission(height)` plus the
value of the `FeeBox` outputs the block's transactions carry (TYPES_INTERFACE → FeeBox).
Storage rent becomes a third term, and nothing in this rule is revisited when it arrives —
that is the point of stating it income-shaped.

⛔ **`fees` is a sum over boxes, and resolves no inputs.** Every fee in the block is written
down in it, so the total is a property of the body's own bytes. **Block application consumes
the fee boxes in the block that created them**; the pair nets out of the prover feed, so they
never reach the AVL tree and `stateRoot` is unaffected (NODE_INTERFACE → the prover feed
derivation).

### On block creation (miner):
1. Fill the body **first** — the fees and the actor count are properties of what was included
2. `income = computeBlockReward(height) + fees`, `fees = Σ FeeBox.value` over the body
3. Split per the slice table below. **Only the miner's slice becomes a `CoinbaseOutput`**; the
   treasury's accrues to the `TreasuryBox` (TYPES_INTERFACE → TreasuryBox)
4. Include `CoinbaseOutput[]` in block
5. After block storage: for each output, mint credits via `mintCredits(owner, value, lockedUntilBlock)` — creates or increases a `CreditBox` in the UTXO set

### The slices

| Slice | Share | Destination |
|---|---|---|
| Treasury | `COINBASE_TREASURY_PCT` | Per **term** — of emission and of fees, never of storage rent |
| Miner floor | `COINBASE_MINER_FLOOR_PCT` | Guaranteed, plus every remainder |
| Backer pool | `COINBASE_BACKER_PCT` | **AHEAD OF CODE** — nothing stakes and nothing links, so this share falls to the miner floor |
| Inclusion bonus | `COINBASE_BONUS_PCT` | `pool × actors ÷ (actors + INCLUSION_BONUS_K)` to the miner; the unearned remainder to the treasury |

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

**Both accrue to the `TreasuryBox` on every network**, which is why no profile carries a
treasury key and no coinbase output is flagged as the treasury's. ARCHITECTURE → Treasury
requires unspendability **by absent rule** rather than by a withheld key; a box block
application has no release path for is that rule, while a key nobody admits to holding is
the shape it rejects. The forfeit is a lock rather than a burn, on every network equally.

⚠ **Emission and the treasury slice come from opposite directions.** The miner's slice is
paid out of released emission plus recreated fees, so it is a `CoinbaseOutput`; the
treasury's is never released at all, so it is a value the successor box carries. Both are
derived from the same `splitCoinbase` result and neither is the producer's choice.

### On block receipt (relay node):
1. Verify PoW
2. Verify `sum(coinbaseOutputs.map(o => o.value))` equals the **miner's slice** the slice table yields for this height, fee sum and actor count — `income` less the treasury share and the unearned bonus, both of which go to the `TreasuryBox` rather than to any output
3. Verify the two box transitions: the emission box's successor holds `value − emission(height)` and the treasury box's holds `value + treasury`, both **exactly**. This is where the split is enforced — a block paying the whole income to its miner sums correctly against nothing, and it is the successors that refuse it
4. Verify no output carries `value === 0` — otherwise `[]` and `[{value: 0}]` are two valid encodings of one block, with different `utxoTxRoot` and different block hashes
4b. Verify no output carries `isTreasury === true`. Nothing is paid to the treasury through the coinbase, so the flag has one legal value and a block claiming otherwise is rejected rather than reinterpreted
5. For each output, mint credits
6. Coinbase outputs with `lockedUntilBlock > currentHeight` are stored but not spendable — the UTXO engine enforces this during transaction validation

**Neither transition rides in the block.** Both are derived from the body the way per-block
like settlement is, so producer and verifier cannot disagree, and both are committed through
`stateRoot` — an unbacked successor forks its author out at the next header.

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
   value, and the emission box's successor pins what was released. A total-only check
   on the coinbase alone would accept a block that forfeited nothing
3. Coinbase outputs cannot be spent before `lockedUntilBlock`, and every coinbase
   output's `lockedUntilBlock` **equals `height + CREDIT_MINER_REWARD_DELAY`** —
   enforced at apply on all paths (gossip, sync, reorg), not only in the gossip
   validator. A block with any other coinbase lock is rejected.
4. `powTargetBits` **equals `expectedTarget(height)`** (a deterministic function of
   height), enforced at apply on all paths — not a self-declared value with a
   sanity floor. A mismatch rejects the block.
5. Difficulty is height-deterministic; there is no wall-clock adjustment.
6. Block hash covers PoW fields — changing `powNonce` or `powTargetBits` invalidates the block
7. Old blocks verify against the scheduled difficulty for their height; since the
   schedule is a pure function of height, that is the same value on every node and
   for all time.

> ✅ **RESOLVED — closed by P2-A, re-verified 2026-08-11.** `node/src/config.ts` sources
> `orderingBlockPowTargetBits` from the network profile, so it is no longer a per-process
> environment value and both consequences below are closed: there is no per-process
> `ORDERING_BLOCK_POW_TARGET_BITS` for two nodes to diverge on, and changing the value now
> means changing `NETWORK_TYPE`, which is a different network by definition. `expectedTarget`
> still discards its height argument — that is intended and is not the defect; see §Difficulty.
>
> *Historical, kept because the reasoning is the record:*
>
> ⚠ **VIOLATED — invariants 4, 5 and 7. The rules are correct; the implementation is not.
> Re-verified 2026-08-11: the core violation stands, and one of its two consequences has
> closed.** `expectedTarget(_height)` in `node/src/services/difficulty.ts` **discards its
> height argument** and returns `config.orderingBlockPowTargetBits` — three lines, no schedule.
>
> 1. ✅ **Cross-node — CLOSED.** This said *"two nodes with different
>    `ORDERING_BLOCK_POW_TARGET_BITS` reject each other's blocks on every block."* That
>    environment variable no longer exists: P2-A removed it, and the value is now
>    **profile-sourced** (`node/src/config.ts` takes it from `profile.orderingBlockPowTargetBits`).
>    Two nodes on the same network agree by construction, and two on different networks carry
>    different frame magic and never peer. **The per-process divergence this described is gone.**
> 2. ⚠ **Retroactive — STILL OPEN, and it is the worse one.** Because height is ignored,
>    changing the value re-targets *history*: on the next resync, reorg, or
>    restart-and-revalidate, every previously-accepted block is re-checked against the new
>    value and rejected. Invariant 7's "the same value on every node and for all time" is
>    precisely what does not hold. Profile-sourcing narrowed the blast radius from
>    per-process to per-release; **it did not make the check height-keyed.** A schedule keyed
>    to height would have that property; a single constant, wherever it is read from, cannot.
>
> ⚠ **`expectedTarget` being constant is load-bearing elsewhere.** The reorg guard checks
> **height** as a proxy for the **work** criterion, and the two coincide *only* because this
> function returns a network constant. Whoever lands retargeting owns both — carried register
> #5, and `NODE_INTERFACE` states the same expiry on its reorg bullet.
>
> These invariants are **kept as written** — they state the intended rule, and Phase 2
> makes them true. Do not weaken them to match the code.
>
> **Resolution (P2-A):** sourcing the target from the network profile closes all three.
> Consequence 1 goes because the value is no longer per-operator; consequence 2 goes
> because it is fixed for the life of the chain. **No height schedule is required or
> wanted** — see the note under §Difficulty Schedule.

⚠ **The block above holds both answers, and the reader has to be told which is current.**
Consequence 2 is marked `STILL OPEN` in item 2 and `goes` in the Resolution paragraph four lines
later. **Item 2 is the true one**, and the retarget track is now exercising it deliberately:

- **`ORDERING_BLOCK_POW_TARGET_BITS` moves from 3072 to 5983**, so every block stored under the old
  value fails `applyOrderingBlock`'s scheduled-target check on resync, reorg or
  restart-and-revalidate. **The mitigation is a fresh chain, not a mechanism** — the value change and
  the wipe are one operation. Consequence 2 is realised rather than resolved.
- **"No height schedule is required or wanted" is superseded.** One is wanted: `expectedTarget` becomes
  a real function of height under the ASERT unit, and that is what actually closes invariant 7. Until
  then invariant 7's *"the same value on every node and for all time"* holds only within one chain's
  life, which is what the wipe re-establishes.
- **Devnet no longer follows the constant** — its `orderingBlockPowTargetBits` stays trivially solvable
  because the node test suite mines real PoW against whatever profile it resolves, and
  `expectedTarget` reads the config singleton where an injected `Config` cannot reach.
  `TYPES_INTERFACE → Ordering block PoW`.

⚠ **The reorg-guard expiry in the note above is NOT discharged here.** `expectedTarget` is still a
constant in height after this unit, so the height-for-work proxy still coincides. **It breaks with
ASERT**, and carried register #5 still owns it.
8. The mining API is never served unauthenticated: external mode requires a
   configured `MINING_SECRET` (enforced at startup, not per-request), every
   request is bearer-authenticated with a constant-time comparison, and the
   coinbase payout override (`?miner=`) is reachable only behind that auth.
   Internal mode mounts no mining routes. (audit M-7)
9. A miner node **serves no template before it is peer-ready**, and gating happens at
   serve rather than at creation — the node holds a template throughout, so invariant
   9 never weakens "a miner node always holds a template". See *The peer-readiness gate*.

## Miner Script

`packages/node/scripts/miner.mjs` — standalone Node.js process (the only miner
script; deployed via `scripts/dagsocial-miner.service`):

1. `GET /mining/template` (Bearer `MINING_SECRET`; `?miner=MINER_PUBKEY` when
   set) → reads `powPreimage`, `header.powTargetBits`, `header.height`.
   **A 404 logs `No template available, waiting 5s...` and retries, with no give-up
   count** — that unboundedness is what lets the node withhold for as long as *The
   peer-readiness gate* requires without any miner-side change
2. Loop: `nonce++`, `hash = blake2b512(hex2buf(powPreimage) || encodeLE64(nonce))`,
   test with its **own mirrored copy** of `meetsPowTarget` against a `powTarget` hoisted
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
