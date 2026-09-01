# @dagsocial/nipopow — Component Session Context

You are the **nipopow component session** for **Notis** (repo dir `dagsocial`). This file is your
standing context — read it and the linked docs before touching code.

## Read first, in order
1. `~/projects/OVERRIDES.md` — mechanical overrides (root-cause only, forced verification, exhaustive
   rename search, the blockchain rules — the confidence-escalation rule applies here: this package
   is a light client's whole basis for trusting a chain).
2. `~/.claude/RTK.md` — RTK proxy rules (`rtk proxy` for completeness-critical searches/diffs).
3. `../../CLAUDE.md` (repo root) — project overview + Design-by-Contract dispatch workflow.
4. `../../contracts/ARCHITECTURE.md` — architecture + invariants.
5. `../../contracts/SPECIAL.md` — S.P.E.C.I.A.L. attention weights. Internalize on session start.
6. `../../contracts/NIPOPOW_INTERFACE.md` — this package's contract. It does not restate the
   interlink vector (`TYPES_INTERFACE → Interlink vector`) or the level (`VALIDATION_INTERFACE →
   level`); read both.
7. Your task's spec in `../../docs/specs/` — `2026-08-27-nipopow-light-client.md` (§2 the salvage
   map from `@ergots/nipopow`, §4 this package, §8 its tests).

## What Notis is
An invite-only decentralized social network on a **dual-ledger** design: a **Posts DAG** (author-sovereign,
prunable) and a **UTXO ledger** (non-tradeable **karma** + tradeable **credits**); every post, like and
prune is a transaction on the UTXO ledger, and a pruned subtree leaves a **stump**.
Consensus is single-phase PoW over validator-produced ordering blocks. TypeScript, pnpm workspaces,
Node.js ≥ 22.

## This package (`@dagsocial/nipopow`)
Non-interactive proofs of proof-of-work over ordering-block headers (KMZ17 superblock proofs): the
`PoPowHeader` / `NipopowProof` objects and their positional codecs, `verifyProof`, `compareProofs`,
and `proveWithReader` behind a caller-supplied reader. **Pure functions only** — no I/O, no store, no
network, no module-level state. The node's route and the light client are its consumers.

- **Owns:** `src/*` and `test/*` of this package, its `package.json`, `tsconfig*.json`,
  `vitest.config.ts`, `tsup.config` if any.
- **Does NOT own:** the header and the interlink vector (`@dagsocial/types`), the level and every
  header check (`@dagsocial/validation`), the store and the route (`@dagsocial/node`), networking
  (`@dagsocial/net`), the wire codec (`@dagsocial/wire`). A consumer needs a change? It comes back
  through the main session. Depends on `@dagsocial/types` and `@dagsocial/validation` only.

## Component-session rules (Design by Contract)
- **Contracts lead, code follows.** Implement to `NIPOPOW_INTERFACE.md`; flag contract gaps to main.
- **You own this package only.** Never edit `../types`, `../validation`, `../node`, `../net`, `../wire`,
  `../../tools`, or `contracts/`.
- **Forced verification before "done":** `pnpm --filter @dagsocial/nipopow build`, then
  `pnpm --filter @dagsocial/nipopow typecheck` (zero errors, src AND test tree) **and**
  `pnpm --filter @dagsocial/nipopow test` (all pass). State results; never claim done unverified.
- **Phased execution:** ≤5 files per phase; verify between phases; wait for approval before the next.
- **Report back** via kitty `send-text` when a phase/task is complete.

## Nipopow-relevant invariants (full set in ARCHITECTURE.md)
- **Pure functions only** — same inputs, same output; a proof is bytes in, a verdict out.
- **No-panic on untrusted input** — `verifyProof` and `compareProofs` answer a verdict, never throw
  (M-5 in `VALIDATION_INTERFACE`); only `proveWithReader` throws, and only `ProofBuildError` on
  caller input.
- **Every bound is enforced before the first element it bounds** — a count is read, compared and
  refused before anything is allocated.
- **The level is integer arithmetic** on the PoW hit (`VALIDATION_INTERFACE → level`); nothing here
  computes a level of its own.
- **Hashing** — `blake2b512` truncated via `.subarray(0, 32)`, through `@dagsocial/types` and
  `@dagsocial/validation`; this package hashes nothing of its own.

## Quick commands
```bash
pnpm --filter @dagsocial/nipopow build
pnpm --filter @dagsocial/nipopow typecheck
pnpm --filter @dagsocial/nipopow test
```
