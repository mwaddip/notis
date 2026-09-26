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

Beside them the barrel exports the types a caller builds their arguments and reads their answers with — `StateView`,
`ApplyContext`, `ApplyResult`, `BlockEffects`, `HolderRecord`, `UtxoEngineDeps`, `UtxoResult`, `SettlementDeps`,
`SettlementBody`, `DecayDeps`, `DecayPlan`, `EmbeddedTx`, and the two shapes the store shares (`StateView` below).
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

**Read-only, and the whole of what the rules read.** The node answers each read with its store's own query for it,
order and limit included; a leaf will answer from proofs. **Every read is marked for N2**: a query or a read outside the
state root becomes a keyed record under the root there — never here, where no committed byte moves.

| Read | Answers | Order · limit | For N2 |
|---|---|---|---|
| a box by id | the box, if live | — | keyed |
| a box's provenance | `{ txId, index }` for any box the state holds or held, live or spent | — | keyed (the box's own record bytes) |
| an identity record | the record, or none | — | keyed |
| the network record | the member count | — | keyed |
| a name record | the name's row, or none | — | keyed |
| a holder record | the owner's name row, or none | — | keyed |
| the emission · treasury · karma pool · backer pool box | the live box of that type, or none | `ORDER BY id LIMIT 1` | found by type |
| an owner's karma boxes | every live karma box of the owner | `value DESC, id` | query |
| a voucher's escrows | every live escrow the voucher owns | `id` | query |
| a pair's vouch boxes | every live vouch box for the (voucher, target) pair | `id` | query |
| an author's like accrual boxes | every live `like_accrual` box naming the author | `id` | query |
| the bonds invited by a height | live bonds whose invitee's record holds `0 < invitedAtBlock ≤ h` | `(invitedAtBlock, id)`, a limit | query |
| the escrows releasable at a height | live escrows with `releaseAtBlock ≤ h` | `(releaseAtBlock, id)`, a limit | query |
| the lapsed vouches | live vouch boxes whose voucher's record fails `member()` | `id`, a limit | query |
| a post's author | the `block_topology` author, or none | — | outside the root |
| a post's confirmation height | the `block_topology` height, or none | — | outside the root |
| a post's standing | `'live'` · `'withdrawn'` · `'none'` (`dag_posts`) | — | outside the root |
| a like record | whether `(target, liker)` exists | — | outside the root |

The members are named for the store reads that answer them (`getBox`, `getKarmaBoxes`, `getBondsInvitedAt`, …). The
shapes the rules share with the node's store — `NetworkRecord` and `UsernameRow` — live in the package, and the store
imports them.

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

**The store's backstops stay.** An insert of a box id the state holds or held, live or spent, throws `BoxIdTakenError`;
a spend of a box that is not live throws `SpendOfNonLiveBoxError` (`NODE_INTERFACE → Store Interface`). Unreachable
under provenance-derived ids and the phase's own checks; the overlay keeps them because the store's own fire only when
the effects are written, and the speculative run writes none.

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
