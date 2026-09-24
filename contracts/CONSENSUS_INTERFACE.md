# CONSENSUS Interface Contract

## Scope

`@dagsocial/consensus` is where the state-transition rules run: what a transaction may do, what a block's settlement
consumes and emits, how decay and the coinbase split are computed. **It is the one implementation of them** — the node
runs it, and a browser leaf that validates blocks runs the same code (`ARCHITECTURE → Overview`; board X2). The rules
themselves are stated in `NODE_INTERFACE` and cited from the code as they are; this contract states where they run,
what the package may depend on, and how state reaches them.

> ⚠ **AHEAD OF CODE (2026-09-25, the consensus package, stage 1)** — no package exists; every module this contract
> names lives in `packages/node/src/services/`, and the node imports each from there.

## Place in the workspace

**Above `@dagsocial/types` and `@dagsocial/validation`, below `@dagsocial/node`.** Those two are its only workspace
dependencies. **It imports no Node built-in, carries no WASM, performs no I/O, holds no module-level state and reads no
clock** — a rule that needs a number the network sets receives it from its caller, and a rule that needs state reads
it through the interface its caller injects. Every signature check it makes is `validation`'s `verifyEd25519`
(`VALIDATION_INTERFACE → Acceptance criterion`).

## What it holds

| Module | Exports the node calls | The rules it implements | State it reads |
|---|---|---|---|
| `utxo-engine` | `validateTx` · `applyTx` · `checkTxEnvelope` · `checkOutputShape` · `checkSettlementOutputShape` · `materializeOutput` · `ceilingOf` · `isMember` · `isRoot` | `NODE_INTERFACE → validateTx` · `→ Legal box transitions` · `→ Transaction envelope shape` · `→ Output shape` · `→ Spend timing` · `→ Validity ceiling` | `UtxoEngineDeps` |
| `settlement` | `buildSettlement` · `checkSettlement` · `contributeToBody` · `emptyBody` · `bondOutputOf` | `NODE_INTERFACE → The settlement transaction` | `SettlementDeps` |
| `decay` | `deriveKarmaDecay` · `commitDecayClocks` | `NODE_INTERFACE → Karma decay` | `DecayDeps` |
| `coinbase-split` | `splitCoinbase` · `backerLeg` · `countKarmaActors` · `isCreditSideTx` | `MINING_INTERFACE → Coinbase Application` | none |
| `block-posts` | `postsOf` · `postIdsOf` · `withdrawalsOf` | `NODE_INTERFACE → Post transactions` · `→ Withdrawal transactions` | none |

**The export list is the node's present call graph, not a promise** — a helper the node stops calling leaves the
barrel, and one a leaf needs joins it with its caller.

## State reaches the rules through injected interfaces

**`UtxoEngineDeps`, `SettlementDeps` and `DecayDeps` are the whole of what the rules read.** The node builds each over
its SQLite store; nothing in the package reaches storage any other way. Their reads, by kind:

| Kind | Reads |
|---|---|
| keyed | a box by id · an identity record · the network record · a name record · a holder record · a record's lifetime likes · a box's provenance |
| the four protocol boxes | the emission, treasury, karma pool and backer pool boxes, found by type |
| queries | an owner's karma boxes and their sum · an unspent escrow by voucher · a vouch box by pair · an author's like carry box · the bonds settling at a height · the escrows releasable at a height · the lapsed vouches · the decay plans |
| outside the state root | a confirmed post's author (`block_topology`) · a like record · a post pending at admission |

A type the rules share with the node's store — the network record's shape — lives in the package, and the store
imports it.

## Tests

**The moved modules' tests move with them**, to `packages/consensus/test/`; the count across `node` and `consensus` is
conserved, and a test that stays in `node` because it drives the node's store is named in the move's commit.

## Does NOT own

Persistence (the store, the journal, the AVL prover) · the header checks that need the chain (link, PoW, difficulty,
interlinks) · mempool admission policy (it calls `validateTx`) · block production and fork resolution (they call the
package) · networking, routes, configuration.
