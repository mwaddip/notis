# CONSENSUS Interface Contract

## Scope

`@dagsocial/consensus` is where the state-transition rules run: what a transaction may do, what a block's settlement
consumes and emits, how decay and the coinbase split are computed, and what a block's body does to state as a whole —
`applyBlock`. **It is the one implementation of them** — the node runs it, and a browser leaf that validates blocks
runs the same code (`ARCHITECTURE → Overview`; `ARCHITECTURE → Deferred to future protocol versions`, the validating
leaf). The rules themselves are stated in `NODE_INTERFACE` and
cited from the code as they are; this contract states where they run, what the package may depend on, and how state
reaches them.

## Place in the workspace

**Above `@dagsocial/types` and `@dagsocial/validation`, below `@dagsocial/node`.** Those two are its only workspace
dependencies. **It imports no Node built-in, reads no Node global, carries no WASM, performs no I/O, holds no
module-level state a result can depend on and reads no clock** — a rule that needs a number the network sets receives
it from its caller, and a rule that needs state reads it through the interface its caller injects. Its module-level
values are constants, the two `TextDecoder`s its username reads decode through (a decode without `stream` leaves no
state behind), and the two memos of `settlement.ts`' sizing probes, each a pure function of the era it is keyed by.
Every signature check it makes is `validation`'s — `verifyEd25519` one transaction at a time, `verifyEd25519Batch`
for a block's body (`VALIDATION_INTERFACE → Acceptance criterion`). The browser runs it as it is written
(`ARCHITECTURE → Package boundaries`), held there by two checks (→ Tests).

## What it holds

| Module | Exports the node calls | The rules it implements | State it reads |
|---|---|---|---|
| `apply-block` | `applyBlock` | `NODE_INTERFACE → "Apply funnel: validation and mutation phases"` — the mutation phase, whole | `StateView`, through the overlay |
| `overlay` | — (`HolderRecord`, the shape its holder mutations carry) | this contract's `The overlay` | `StateView` |
| `state-view` | — (`StateView`, `ApplyContext`) | this contract's `StateView` and `ApplyContext` | — |
| `utxo-engine` | `validateTx` · `applyTx` · `checkTxEnvelope` · `checkOutputShape` · `checkSettlementOutputShape` · `materializeOutput` · `ceilingOf` · `isMember` · `isRoot` | `NODE_INTERFACE → validateTx` · `→ Legal box transitions` · `→ Transaction envelope shape` · `→ Output shape` · `→ Spend timing` · `→ Validity ceiling` | `UtxoEngineDeps` |
| `settlement` | `buildBlockSettlement` · `buildSettlement` · `bondOutputOf` · `settlementMarginalBytes` | `NODE_INTERFACE → The settlement transaction` | `StateView` (the build) · `SettlementDeps` |
| `decay` | `deriveKarmaDecay` · `commitDecayClocks` | `NODE_INTERFACE → Karma decay` | `DecayDeps` |
| `coinbase-split` | `computeBlockReward` · `splitCoinbase` · `isCreditSideTx` | `MINING_INTERFACE → Emission Schedule` · `→ Coinbase Application` | none |
| `block-posts` | `postsOf` · `postIdsOf` | `NODE_INTERFACE → Post transactions` · `→ Withdrawal transactions` | none |
| `tree-session` | — (`TreeSession`, `TreeLookup`, `isSentinel`) | this contract's `The tree session` | — |
| `tree-view` | `treeStateView` (`TreeStateView`, `TreeInconsistencyError`) | this contract's `The tree view` | a `TreeSession` |
| `tree-index` | `indexEntriesOfBox` · `isLapsedMember` | this contract's `The index entries` | none |
| `tree-writes` | `treeWritesOf` · `seedTreeWrites` (`TreeWrite`) | this contract's `The tree writes` | the block's `TreeStateView` |

> ⚠ **AHEAD OF CODE (2026-09-27, N2 state layout, stage A)** — no node code calls the four `tree-*` modules: the
> node answers `StateView` from SQLite (`storeStateView`) and derives its AVL feed itself (`proverFeedFromEffects`,
> `applyBlockMutations`).

Beside them the barrel exports the types a caller builds their arguments and reads their answers with — `StateView`,
`ApplyContext`, `ApplyResult`, `BlockEffects`, `HolderRecord`, `UtxoEngineDeps`, `UtxoResult`, `SettlementDeps`,
`SettlementBody`, `DecayDeps`, `DecayPlan`, `EmbeddedTx`, `TreeSession`, `TreeLookup`, `TreeStateView`, `TreeWrite`,
and the two shapes the store shares (`StateView` below).
**The export list is what the node's source and its suites call, not a promise** — a helper nothing there calls leaves
the barrel, and one a leaf needs joins it with its caller.

## Applying a block

```ts
applyBlock(view: StateView, block: OrderingBlock, ctx: ApplyContext): ApplyResult
ApplyResult = { ok: true; effects: BlockEffects } | { ok: false; reason: string }
```

**`applyBlock` is the mutation phase** (`NODE_INTERFACE → "Apply funnel: validation and mutation phases"`), in its
order: the block's posts and their topology rows · the body decoded, every declared id proven, the settlement found by
position · every signature the body carries, checked as one batch · the pre-body captures (decay's projection and
plans, the releasable escrows, the lapsed vouches, the backer
pool) · the user transactions in committed order — inputs resolved, `validateTx`, the like binds, one invitee per
block, `applyTx`, the post's activity bump, the like record, the name claim or burn · the withdrawals · the settlement
(`checkSettlement`, then applied) · the grants · the like counters · the membership pass · the decay clocks. It runs at
`block.header.height` and reads no other header field but `validatorId`: the node has run the checks that need the
chain first (`NODE_INTERFACE → Ordering block apply-time authorization`), and the creator's speculative run passes a
candidate whose nonce, signature and `stateRoot` are placeholders (`NODE_INTERFACE → Post-block stateRoot`).

**A block's signatures are checked together, before any transaction applies.** Once every declared id is proven,
`applyBlock` gathers each entry of every embedded transaction's signature map — in body order, and within a
transaction in its map's decoded order — as the signature, the transaction id's 32 bytes and the key, and makes one
`verifyEd25519Batch` call (`VALIDATION_INTERFACE → verifyEd25519Batch`). `false` rejects the block: `Rejected block
height=H: a signature in the body does not verify`. **No transaction may carry more signatures than inputs, and that
is checked first:** each input requires at most one signer and a map key no input requires refuses its transaction, so
a map with more entries than its transaction has inputs is refused before the batch runs — `Rejected block height=H:
embedded UTXO tx <id> carries more signatures than inputs` — and the batch checks at most one entry per input.
`true` hands the loop the verified set, and the `validateTx` it runs answers each signature from it (→ The overlay);
an entry outside the set fails its transaction. **Checking every
entry keeps every verdict:** `validateTx` refuses a map key no input requires, so every entry of a valid transaction's
map verifies, and a body with a failing entry is a rejected block either way. **A missing signature is not an
entry**: the loop refuses it with its transaction's reason. The settlement carries no signature, and the header's is
the node's to check (`NODE_INTERFACE → Ordering block apply-time authorization`).

**A rule failure is a `reason`, never a throw.** Every rejection the phase makes answers `{ ok: false, reason }`, the
reason the text the node logs.

**A throw is not a verdict, and `applyBlock` catches none.** A view that finds its own storage corrupt throws the
node's `CorruptChainStateError`, and the node's fail-stop stays the node's; any other throw is a defect, which the
node's funnel answers as it answers every unexpected throw (`NODE_INTERFACE → "The funnel answers with a class"`).

**Deterministic.** No clock, no randomness — the body check's coefficients are a function of the body
(`VALIDATION_INTERFACE → verifyEd25519Batch`) — no module state, and no order that a `Map`'s or `Set`'s insertion
history decides unless the phase fixed that history. Two runs over the same view and the same block answer the same result,
byte for byte; a difference is a fork.

## ApplyContext

**The network profile's numbers the rules read, and nothing else:** `protocolVersionSchedule` · `vouchCooldownBlocks`
· `inviteBondMin` · `inviteBondMax` · `inviteProbationBlocks` · the decay configuration (`staleThresholdBlocks`,
`decayIntervalBlocks`, `decayAmount`, `karmaMinimum`) · `storageRentPeriodBlocks` · `membershipBarMultiplier` ·
`backerSupply` · `creditFixedRateBlocks` · `creditEpochBlocks` · `creditMinerRewardDelay`. A protocol constant the
network does not set (`MAX_ESCROW_RETURNS_PER_BLOCK` and its kin) is imported from `@dagsocial/types`, not carried.
The node builds it from its configuration (`applyContextFrom`).

## StateView

**Read-only, and the whole of what the rules read. Every read is a lookup under the state root** — one key, or a
walk of one key range — answered by the tree view (→ The tree view): the node's over its prover, a leaf's over the
proof it was handed, the same code on both. The node's SQLite store answers none of them.

| Read | Answers | Order · limit | Under the root (`TYPES_INTERFACE → The tree keys`) |
|---|---|---|---|
| a box by id | the box, if live | — | `box ‖ boxId` |
| a box's provenance | `{ txId, index }` for a live box | — | the box's own record bytes |
| an identity record | the record, or none | — | `identity ‖ id` |
| the network record | the member count | — | `network` |
| a name record | the name's row, or none | — | `name ‖ nameLower`, then the box it names |
| a holder record | the owner's name row, or none | — | `holder ‖ owner`, then the box it names |
| the emission · treasury · karma pool · backer pool box | the live box of that type, or none | `id`, the first | the `type ‖ boxType` range's first entry |
| an owner's karma boxes | every live karma box of the owner | `value DESC, id` | the whole `karmaOf ‖ owner` range, then each box, sorted |
| a voucher's escrows | every live escrow the voucher owns | `id` | the `escrowOf ‖ voucher` range |
| a pair's vouch boxes | the pair's live vouch box — one at most (`NODE_INTERFACE → Vouch transition rules`) | — | `vouchPair ‖ voucher ‖ target`, then the box |
| an author's like accrual boxes | every live `like_accrual` box naming the author | `id` | the `accrualOf ‖ author` range |
| the bonds invited by a height | live bonds whose invitee's record holds `0 < invitedAtBlock ≤ h` | `(invitedAtBlock, id)`, a limit | the `bondDue` range while the key's height `≤ h` |
| the escrows releasable at a height | live escrows with `releaseAtBlock ≤ h` | `(releaseAtBlock, id)`, a limit | the `escrowDue` range while the key's height `≤ h` |
| the lapsed vouches | live vouch boxes whose voucher fails `member()` | `(voucher, target)`, a limit | the `lapsed` range — the lapsed members holding a live vouch — and for each its `vouchPair ‖ voucher` range |
| a post's author | the author, or none | — | `post ‖ postId` |
| a post's confirmation height | the height, or none | — | `post ‖ postId` |
| a post's standing | `'live'` · `'withdrawn'` · `'none'` | — | `post ‖ postId` — absent is `'none'` |
| a like record | whether `(target, liker)` exists | — | `like ‖ postId ‖ liker` |

**The lapses run voucher by voucher.** One global order over every lapsed vouch would need every lapsed voucher's
whole range read at every block, which the leg's limit exists to prevent; voucher by voucher, the walk stops at the
limit. An owner's karma boxes are read whole — the read has no limit — and sorted.

> ⚠ **AHEAD OF CODE (2026-09-27, N2 state layout, stage A)** — the node answers every read from SQLite
> (`storeStateView`): a box's provenance for any box it holds or held, a pair's boxes as a list, the lapsed vouches in
> one ascending box-id order, a post's reads from `block_topology` and `dag_posts`, a like from `like_records`.

The members share their names with the node's store reads (`getBox`, `getKarmaBoxes`, `getBondsInvitedAt`, …), which
answer the node's API. The shapes the rules share with the node's store — `NetworkRecord` and `UsernameRow` — live in
the package, and the store imports them.

`NetworkRecord` and `HolderRecord` are `@dagsocial/types`' (`TYPES_INTERFACE → Layout — tree records`, beside their
codecs), and this package re-exports them; `UsernameRow` is this package's.

## The tree layout

**Everything the rules read is under the state root, and this package owns what the tree holds**: the entities, the
index entries derived from them, how a read walks them, and the order a block's writes reach the tree. The keys and the
value codecs are `types`' (`TYPES_INTERFACE → The tree keys`, `→ Layout — tree records`); the AVL+ prover and its
storage are the node's.

> ⚠ **AHEAD OF CODE (2026-09-27, N2 state layout, stage A)** — the node's tree is not this layout: it holds boxes and
> the four record kinds under hashed 32-byte keys, and nothing the rules read from a query or outside the root is in
> it.

### The tree session

```ts
TreeLookup =
  | { found: true;  value: Uint8Array; nextKey: Uint8Array }   // the key is a leaf; nextKey the next leaf's key
  | { found: false; prevKey: Uint8Array; nextKey: Uint8Array } // the key is absent; the keys either side of it
interface TreeSession { lookup(key: Uint8Array): TreeLookup }
```

**The one thing the tree view asks of a tree.** The node's session is its prover; a leaf's is the step-by-step
verifier over a block's proof. **Every neighbour key is authenticated** — it is part of its leaf's label — so a reader
that walks by `nextKey` sees every key between two it was shown. At the ends of the tree the neighbour is a sentinel:
all `0x00` below the first key, all `0xff` past the last (`isSentinel`). **No lookup is ever made of a sentinel**: the
library refuses a key at either bound, and a refusal poisons a verifier. **A session's answers are the view's to
keep**: the view memoises them for the block, so a session never reuses or mutates an array it has returned.

### The tree view

**`treeStateView(session)` is the `StateView`** (→ StateView, its table), and the one implementation of it the rules
see. It looks each key up at most once — the first read memoises it — so a block's reads of the tree are the distinct
keys it asked, in the order it first asked them.

**A range read walks.** It looks up the range's start (`TYPES_INTERFACE → The tree keys`, `rangeStart`), yields that
key if it is a leaf, and follows `nextKey` for as long as the next key is in the range, is no sentinel and the read's
limit is not reached, looking each next key up in turn. A next key the tree names and a lookup of it answers absent is
a tree that contradicts itself: `TreeInconsistencyError`, a throw, never a verdict. An index entry yields a box id; the
box itself is then a `box` lookup. **The due queues stop at a height**: the `bondDue` and `escrowDue` walks end at the
first key whose height (`keyHeight`) is above the read's. **The lapses share one limit** across the `lapsed` walk and
each voucher's `vouchPair` walk.

**The name and holder reads rebuild the row from the tree**: `claimedAtBlock` from the name record, `name` and
`owner` from the box it names — never the box's `createdAtBlock`, which its creator declares.

### The index entries

**An index entry is a function of committed state** — an entity's own fields; for a bond, its invitee's
`invitedAtBlock`; for a voucher, the number of their live vouch boxes — and `indexEntriesOfBox`, `isLapsedMember` and
the cast count are the only derivations. The tree writes (→ The tree
writes) place and remove them with their entity; no rule writes one.

| From | Entries |
|---|---|
| a karma box | `karmaOf ‖ owner ‖ boxId` |
| a credit box | `creditOf ‖ owner ‖ boxId` — no rule reads it; a leaf proves its whole holdings from it |
| a vouch escrow | `escrowOf ‖ owner ‖ boxId` and `escrowDue ‖ releaseAtBlock ‖ boxId` |
| a bond | `bondDue ‖ invitedAtBlock ‖ boxId` — its invitee's `invitedAtBlock`, the height of the block that created it |
| a vouch | `vouchPair ‖ voucherId ‖ targetId`, its value the box id |
| a like accrual | `accrualOf ‖ author ‖ boxId` |
| an emission, treasury, karma-pool or backer-pool box | `type ‖ boxType ‖ boxId` |
| any other box | none |
| a voucher's live vouch boxes | `castCount ‖ voucherId`, its value their number — no entry at `0` |
| an identity record with `memberSinceBlock > 0 ∧ memberVouches < memberBar`, whose identity holds a cast count (`isLapsedMember`) | `lapsed ‖ identityId` |

**A bond's due height is its invitee's `invitedAtBlock`**: the grant writes it, once, in the block whose body created
the bond (`NODE_INTERFACE → Identity Records`), so the probation clock starts at the grant. The bond's own
`createdAtBlock` is its creator's declaration — a client builds at the tip — and nothing reads it here. **The lapse
queue is the lapsed members holding a live vouch**: only a member casts (`NODE_INTERFACE → Vouch transition rules`),
`memberSinceBlock`, once set, is never reset, and the cast count is a voucher's live vouch boxes — so a voucher
leaves the queue when its last vouch is withdrawn or its record re-qualifies, every entry the leg visits yields a
vouch, and the leg reads no more of the tree than its limit takes.

### The tree writes

**`treeWritesOf(effects, height, view)` is a block's writes to the tree, and the node and a leaf apply them through
it.** `view` is the block's own tree view: **what a write needs from before the block — a spent box's fields, a spent
bond's invitee's `invitedAtBlock`, an identity record's pre-block value, an earlier post's record, a voucher's cast
count — it reads there.** All but the cast count are reads the block's rules already made, so the view answers them
from its memo. **The cast count is the writes' own read**, and only where a write needs it: for each voucher whose
vouch boxes the block inserts or spends, and for each identity whose record the block writes where that record is a
lapsed member before the block or after it — no other. The proof carries it like any other read. From the effects (→ BlockEffects):

- **boxes** — a box the block both inserted and spent nets out, its index entries with it; every other box is an
  `Insert` or a `Remove` of `box ‖ boxId`, its value `boxRecordBytes`, beside the same op on each of its index entries;
- **cast counts** — for each voucher whose vouch boxes the block inserted or spent, the count before the block plus
  the block's net change: nothing where the net change is `0`, an `Insert` where there was none, a `Remove` where it
  falls to `0`, an `Update` otherwise;
- **identity records** — the last write to each key, an `InsertOrUpdate` of `identity ‖ id`; and **its `lapsed`
  entry moves only where its condition flips** — the lapsed-member predicate over the record, and a cast count held —
  between the block's start and its end: an `InsertOrUpdate` where it now holds, a `Remove` where it held and no
  longer does;
- **the network record** — an `Update` of `network`;
- **name and holder records** — as the netting leaves them (→ BlockEffects, `heldBefore`): an `InsertOrUpdate`, a
  `Remove`, or nothing;
- **posts** — an `Insert` of `post ‖ postId`, standing `live`, for each post the block confirmed; an `Update` to
  `withdrawn` for each post the block withdrew, which is always an earlier block's (`NODE_INTERFACE → Withdrawal
  transactions`);
- **likes** — an `Insert` of `like ‖ postId ‖ liker` for each like record.

**The order is a consensus rule, because an AVL+ digest depends on the order of its operations:** every `Remove` in
ascending key order, then every `Insert`, then every `Update`, then every `InsertOrUpdate`, keys compared bytewise.
**No key takes two writes in one block**: boxes net, records collapse to their last write, the name and holder
records net, and one live vouch per pair with its escrow's lock leaves a pair no way to be withdrawn and recast in one
block.

**`seedTreeWrites(boxes, records, network)` is genesis**: every box with its index entries — a bond's due height from
its invitee's record among `records` — each voucher's cast count, every identity record with its `lapsed` entry where
it holds, the network record — all `Insert`s, in ascending key order.

## The overlay

**`applyBlock` reads through a block-local layer of its own writes, and the view underneath is never written.** A box
inserted or spent, a record written, a post confirmed or withdrawn, a like recorded, a name claimed or burned — each is
visible to every later read in the block, and to no read outside it.

**Every read answers over the state as the block has left it at that point.** A keyed read answers from the overlay's
own entry first — except a post's topology, where the view's row answers first, because a post's first confirmation
stands. A query composes the view's answer with the block's writes under the query's own order — the block's spent
boxes out, its live inserts in. **A read whose answer the block's writes could change, and which the view cannot
answer fully enough to recompute, throws `LimitedQueryAfterWriteError` rather than answering** — a limited query after
a write that touches its set is the case: a tripwire for the day a change makes the argument false, never a verdict.
The pre-body captures are read before the block writes any box or record, and read the view.

**A read of what the block wrote answers a copy, shaped as the store's reads are** — every byte field a plain
`Uint8Array` — so no read aliases the effects, and no answer depends on how the block's bytes were carried.

**The store's backstops stay.** An insert of a box id a live box holds throws `BoxIdTakenError`; a spend of a box
that is not live throws `SpendOfNonLiveBoxError` (`NODE_INTERFACE → Store Interface`). Unreachable under
provenance-derived ids and the phase's own checks; the overlay keeps them because the store's own fire only when the
effects are written, and the speculative run writes none. **A spent box's id cannot recur, and the tree does not hold
spent boxes**: every user transaction spends an input (`NODE_INTERFACE → validateTx` step 1) and a synthetic mint's id
commits to its height, so no transaction id — and no box id derived from one — is ever made twice.

**The rules keep their parameters.** `applyBlock` builds `UtxoEngineDeps`, `SettlementDeps` and `DecayDeps` over its
overlay, so `validateTx`, `applyTx`, `checkSettlement`, `deriveKarmaDecay` and `commitDecayClocks` run unchanged; the
node builds `UtxoEngineDeps` over its store for admission, where `validateTx` is the pool's check, and runs no
`applyTx` of its own. **`UtxoEngineDeps.verifySignature` is the one parameter the two builds set apart:**
`applyBlock`'s answers from the set its body check verified (→ Applying a block); admission's is absent, and
`validateTx` then calls `verifyEd25519` for each signer. Who must sign, and the refusal of a map key no input
requires, are `validateTx`'s on both paths.

## BlockEffects

**What the block did, returned instead of written:**

- **`mutations`** — every write to committed state, in the order the phase made it: a box inserted (`op: 'insert'`, the
  box as the transaction built it, its final id), a box spent (`op: 'remove'`, its id), an identity record written (the
  id, the record), the network record written, a name record written or removed (`row`, or `null`), a holder record
  written or removed (`record`, or `null`). **The holder record is the phase's own rule**: a claim writes
  `HolderRecord { claimAvailable: false, boxId }` for its owner, a burn removes it (`NODE_INTERFACE → Username
  records`). **Each name and holder mutation carries `heldBefore`** — whether the state held its key just before it,
  which the overlay knows from its own read of the key — so the feed can net out a key the block both creates and
  removes (`NODE_INTERFACE → "A removable record the block creates and removes nets out, as a box does"`).
- **`posts`** — the block's posts in body order (`postsOf`).
- **`likeRecords`** — each like record written, `{ targetPostId, likerId }`, in apply order.
- **`withdrawals`** — each withdrawn post id, in body order.
- **`appliedTxs`** — the user transactions in applied order, `{ txId, txBytes }`; the settlement is not among them.

**No karma supply figure.** Nothing reads one: the pool's successor is `checkSettlement`'s own derivation
(`NODE_INTERFACE → The settlement transaction`).

**The node builds its block journal from the effects** (`NODE_INTERFACE → Block Journal`) and writes its store from
the same list — one list, so the store, the journal and the AVL feed cannot disagree about what a block did.

**N3's hook, stated now:** a view that records the keys it answered, beside the effects' writes, is the whole list a
block's proof covers. Nothing here builds it.

## The settlement build

**`buildBlockSettlement(view, txBytes, height, validatorId, minerOwner, ctx)` is the producer's settlement** for a body
of user transactions (`MINING_INTERFACE → Template and submit`): read through `StateView` over pre-body state, the
body's own outputs resolved from the body. **It shares every derivation with `applyBlock`** — decay's projection
(`collectPostBodyKarma`), the settlement's read wiring (`settlementDepsWith`), the reward (`computeBlockReward`) — so
producer and applier derive from one implementation, and a settlement the build gets wrong is the speculative run's
`body-rejected` (`NODE_INTERFACE → Post-block stateRoot`), never a mined block.

## Cost

**Signature verification is the dominant term of `applyBlock`, and it is the one this contract bounds.** Measured
2026-09-26 over honest signatures with distinct keys, per signature — `verifyEd25519` one at a time, and the batch over a
full body:

| Runtime | One at a time | The batch |
|---|---|---|
| one core of an Intel i9-14900HX, Node 22 | 1.3–1.4 ms | 0.27–0.30 ms |
| a testnet box's one Cascade Lake core, Node 22 | 2.6 ms | 0.59 ms |
| Chromium 149 | 0.52 ms | 0.12 ms |
| Firefox 156 | 1.1 ms | 0.23 ms |
| Waterfox 140 (Firefox 140's engine) | 4.1 ms | 0.85 ms |

OpenSSL on the same two machines takes 0.13–0.15 ms a signature with the key's import, which a key new to it needs.

**A transaction checks each signer once.** The signature map holds one signature per required key, over the
transaction's id, so a signer whose boxes are several of a transaction's inputs is one check, not one per input. The
worst case is then one check per 128 bytes of body — an extra signer costs 32 bytes of input and 96 of key and
signature — and `MAX_TX_BYTES` holds at most 77 signers in one transaction (9 903 bytes), so a body at
`MAX_BLOCK_BODY_BYTES` carries at most **about 15 500 signatures in 202 transactions** (15 496–15 499 as the height
moves the widths of the values). An ordinary full body — one signer a transaction — holds 5 800 to about 8 100. **A body
the rules refuse costs about what the valid worst case does:** the batch checks at most one entry per input (→ Applying
a block), so every entry still costs 128 bytes of body — a refused body spares the bytes a valid one spends on its
outputs, and fits at most about 0.4% more entries.

**`applyBlock` over those bodies**, measured 2026-09-26 with `packages/consensus/scripts/bench-apply-block.mjs`
(testnet's numbers, height 1 000) — each signature checked on its own, then the body checked as one batch:

| Body | i9-14900HX core, Node 22 | a testnet box's Cascade Lake core, Node 22 |
|---|---|---|
| ordinary: 8 031 one-signer credit sends | 10.7–11.0 s → 2.9 s | 30.6–31.8 s → 9.3–9.7 s |
| packed: 15 497 signers in 202 transactions | 20.0–20.2 s → 4.5 s | 53.8–55.7 s → 13.8–14.3 s |
| the packed body, one signature corrupted — refused | 19.9–20.1 s → 4.3 s | 52.2–52.8 s → 12.4–13.5 s |
| 20 598 entries no input requires — refused | 0.09 s → 0.09 s | 0.25–0.37 s → 0.28–0.36 s |

**The protocol hash over `@noble/hashes`** (`TYPES_INTERFACE → The protocol hash`) costs, measured 2026-09-26 on the
same i9 core against the tree before it, interleaved (medians of nine runs each; both ran 10–25% above the table's
times on a busier machine): the ordinary body **+0.46 s (+12%)** — the most hashing, 56 221 digests over 6.2 MB —
the packed body +0.33 s (+6%), the corrupted packed body +0.28 s, the refused one +0.01 s. Of the packed body's, the
hashing itself is about 0.05 s (1 014 digests); the rest is unattributed. The testnet box is not measured.

No other term may grow faster than the reads the body makes: each overlay read is a map lookup or one composition over
the view's answer to it.

## Tests

**A suite whose subject is one of these modules and which drives it through stubs lives in
`packages/consensus/test/`**, with the fixture helpers it needs in `test/helpers.ts` — `applyBlock` over a stub view
among them. A suite that drives the node's store or block application — `utxo-engine.test.ts` among them, over an
in-memory database — stays in `packages/node/test/` and imports from the package.

**Two checks hold the package to the browser** (`ARCHITECTURE → Package boundaries`):

- **The browser typecheck.** `typecheck` compiles `src` a second time against the DOM library with no Node types
  (`tsconfig.browser.json`); a Node built-in or a Node global is a compile error at its line.
- **The bundle test** (`test/bundle.test.ts`). It builds `applyBlock` from source for a browser with vite — every Node
  built-in a module imports failing the build, which two throwaway entries hold — and runs the bundle in a `vm` context
  holding the ECMAScript built-ins and the context's own `TextEncoder` and `TextDecoder` alone: V8's `console` and
  `WebAssembly` deleted, the global set asserted exactly. **The context holds the determinism rule itself**
  (→ Applying a block): it has no `crypto`, and its `Date`, `Math.random` and `Intl.DateTimeFormat` throw. Inside it a
  chain of signed blocks — one of them refused for a corrupted signature — is applied over a stub view, both built
  there from primitives, and the results come back as canonical text that must equal, byte for byte, what the same
  entry answers from source under Node. Only strings cross the context's boundary: a `Uint8Array` made outside it
  fails `instanceof` inside, and so would the output of Node's own codecs.

## Does NOT own

Persistence (the store, the journal, the AVL prover) · the header checks that need the chain (link, PoW, difficulty,
interlinks) · mempool admission policy (it calls `validateTx`) · block production and fork resolution (they call the
package — the creator `buildBlockSettlement` and `applyBlock`) · networking, routes, configuration.
