# @dagsocial/consensus — Component Session Context

You are the **consensus component session** for **Notis** (repo dir `dagsocial`). This file is your standing
context — read it and the linked docs before touching code.

## Read first, in order
1. `~/projects/OVERRIDES.md` — mechanical overrides (root-cause only, forced verification, the blockchain rules).
2. `~/.claude/RTK.md` — RTK proxy rules (`rtk proxy` for completeness-critical searches and diffs).
3. `../../CLAUDE.md` (repo root) — project overview and the Design-by-Contract dispatch workflow.
4. `../../contracts/ARCHITECTURE.md` — architecture and invariants.
5. `../../contracts/SPECIAL.md` — S.P.E.C.I.A.L. attention weights: `@dagsocial/consensus`'s default and its
   `src/utxo-engine.ts`, `src/apply-block.ts` and `src/overlay.ts` overrides. Internalize on session start.
6. `../../contracts/CONSENSUS_INTERFACE.md` — this package's contract: where the rules run, what the package may
   depend on, how state reaches them.
7. `../../contracts/NODE_INTERFACE.md` — **the rules themselves**: `validateTx`, `Legal box transitions`, `The
   settlement transaction`, `Karma decay`, `Membership pass`. The code cites them; a rule change starts there.
8. `../../contracts/VALIDATION_INTERFACE.md → Acceptance criterion` and `→ verifyEd25519Batch` — every signature check
   is one rule, one transaction at a time or a block's body as one batch.
9. Your task's spec in `../../docs/specs/`.

## What Notis is
An invite-only decentralized social network on a **dual-ledger** design: a **Posts DAG** (author-sovereign) and a
**UTXO ledger** (non-tradeable **karma** + tradeable **credits**); every post, like and withdrawal is a transaction on
the UTXO ledger, and withdrawal is the author's only act over a post. Consensus is PoW. TypeScript, pnpm workspaces,
Node.js ≥ 22.

## This package (`@dagsocial/consensus`)
**The state-transition rules** — what a block's body does to state as one function (`applyBlock`, the mutation
phase, answering the block's effects or a reason), what a transaction may do (`validateTx`, `applyTx`, the envelope,
the output shape, the transitions), what a block's settlement consumes and emits (`buildSettlement`, the producer's
`buildBlockSettlement`, `checkSettlement`), decay, the coinbase split and the reward, the block's post and withdrawal
readers. **The one implementation**: the node runs it over a `StateView` of its store, and a browser leaf that
validates blocks will run the same code.

- **Owns:** `src/*`, `test/*`.
- **Does NOT own:** persistence — the store, the journal, the AVL prover (`@dagsocial/node`); the header checks
  that need the chain (link, PoW, difficulty, interlinks — `@dagsocial/node` over `@dagsocial/validation`);
  stateless checks and signatures (`@dagsocial/validation`); data structures, codecs, constants
  (`@dagsocial/types`); mempool policy, block production, fork resolution, networking, routes, configuration.

## The boundary that defines this package
- **No Node built-in import, no Node global, no WASM, no I/O, no module-level state a result can depend on, no clock**
  (`CONSENSUS_INTERFACE → Place in the workspace`); two checks hold it (`CONSENSUS_INTERFACE → Tests`) — the browser
  typecheck, and the bundle test that runs `applyBlock` built for a browser in a context whose clock and randomness
  throw. A rule that needs a number the network sets takes it from its caller (`ApplyContext`); a rule that
  needs state reads it through `StateView` — `applyBlock` through its overlay, which builds `UtxoEngineDeps`,
  `SettlementDeps` and `DecayDeps` over it (`CONSENSUS_INTERFACE → The overlay`). A rule that reaches past them is a
  rule the leaf cannot run.
- **Workspace dependencies: `@dagsocial/types` and `@dagsocial/validation`, and nothing else — never `node`.**
- **Every signature check is `validation`'s** — `verifyEd25519` for admission's `validateTx`, one `verifyEd25519Batch`
  over every signature a block's body carries in `applyBlock`, strict RFC 8032 through `@noble/curves`
  (`VALIDATION_INTERFACE → Acceptance criterion`; `CONSENSUS_INTERFACE → Applying a block`).
- **A verdict is a function of its inputs and the injected state.** Two runs over the same block and the same state
  answer the same, byte for byte; a difference is a fork.

## Component-session rules (Design by Contract)
- **Contracts lead, code follows.** Implement to `CONSENSUS_INTERFACE.md` and the rules in `NODE_INTERFACE.md`;
  flag contract gaps to main.
- **You own this package only.** Never edit `../node`, `../validation`, `../types`, or `contracts/`.
- **Forced verification before "done":** `pnpm --filter @dagsocial/consensus typecheck` (zero errors — src, the test
  tree, and the browser pass) **and** `pnpm --filter @dagsocial/consensus test` (the bundle test among it), **and**
  `pnpm --filter @dagsocial/node typecheck && pnpm --filter @dagsocial/node test` — the node's suite drives these rules
  over a real store. State the results; never claim done unverified. Main proves a rule-code change on the chain
  itself: a node built from the change syncs testnet from genesis with the state-root check on and must reach the
  live tip.
- **Phased execution:** ≤5 files per phase; verify between phases. **Report back** via kitty when done.

## Consensus-relevant invariants (full set in ARCHITECTURE.md)
- **Value conservation** — every user transaction conserves, unconditionally (`NODE_INTERFACE → validateTx` step 7);
  every mint and burn is a block-application path's.
- **On-chain time is block height**, never wall clock.
- **Values are `bigint`** end to end (`NODE_INTERFACE → Values are BigInt`).
- **No method panics on untrusted input** — a malformed transaction is a verdict, never an exception.
