# @dagsocial/nipopow-client — Component Session Context

You are the **nipopow-client component session** for **Notis** (repo dir `dagsocial`). This file is
your standing context — read it and the linked docs before touching code.

## Read first, in order
1. `~/projects/OVERRIDES.md` — mechanical overrides (root-cause only, forced verification, truncation
   suspicion, the blockchain rules — the confidence-escalation rule applies: this tool is the first
   thing that trusts a chain without holding it).
2. `~/.claude/RTK.md` — RTK proxy rules (`rtk proxy` for completeness-critical searches/diffs).
3. `../../CLAUDE.md` (repo root) — project overview + Design-by-Contract dispatch workflow.
4. `../../contracts/NIPOPOW_INTERFACE.md` — **the contract this tool CONSUMES first**: `verifyProof`,
   `compareProofs`, and **The trust model** (the three rules this tool embodies).
5. `../../contracts/NODE_INTERFACE.md` — the routes it reads: `Nipopow` (HTTP API), `Nipopow prover`,
   the `/api/v1/proof/:boxId` endpoint (the "avl-endpoint" bullet and "The AVL value carries
   provenance"), `/karma/:userId` and `/credits/:userId` in `HTTP API`.
6. `../../contracts/TYPES_INTERFACE.md` — `Box and transaction identity` / `Layout — Boxes`
   (`boxRecordFromBytes`, `computeCandidateBoxId`), `Network profiles`.
7. `../../contracts/SPECIAL.md` — S.P.E.C.I.A.L. attention weights. It carries a section per protocol
   package and none for this one; 5 is competent everywhere by default.
8. Your task's spec in `../../docs/specs/` — `2026-08-27-nipopow-light-client.md` §6 and §8 (U4).

⛔ **There is no `NIPOPOW_CLIENT_INTERFACE.md`, and its absence is the point.** The six protocol
packages have contracts because they define consensus surface. This tool has none: it is a client
that reads proofs and verifies them with rules `NIPOPOW_INTERFACE` and `NODE_INTERFACE` already state.
A contract naming this tool would be a contract naming a *caller*. **If a node refuses what a contract
says it accepts, or accepts what it says it refuses, that is a FINDING to report to main — never a
workaround written into this tool.**

## What Notis is
An invite-only decentralized social network on a **dual-ledger** design: a **Posts DAG** and a **UTXO
ledger** (karma + credits), bound by **stumps**. Consensus is PoW. TypeScript, pnpm workspaces, Node ≥ 22.

## This package (`@dagsocial/nipopow-client`)
A headless light client — a CLI, no server. Given N node URLs and a network profile it fetches a
NiPoPoW proof from each, verifies every one with nothing but the profile, picks the best by
comparison, and then — for a public key — proves that key's karma and credit boxes against the
`stateRoot` of the proof's `suffixHead`, a header under its own verified PoW. Bytes in, verdict out,
exit.

- **Owns:** `src/*`, `test/*`, this package's `package.json` and configs.
- **Does NOT own:** anything in `packages/`, `contracts/`, or `tools/e2e` (the acceptance case that
  runs this tool against a real mesh lives there and is a separate dispatch). Cross-cutting changes —
  the workspace glob, the gate scripts — are main's to route.

## ⛔ Three properties a change here must not undo

**1. It trusts nothing it did not verify.** The PoW target comes from the profile the tool was built
with, never from a header; a proof is accepted only by `verifyProof`; a box only by `verifyAvlLookup`
against a `stateRoot` the tool verified under PoW, and only when `computeCandidateBoxId` of the value
reproduces the key. A node's listing of box ids is used as a *list to prove*, never as a fact.

**2. No local encoding, no local consensus.** `boxRecordFromBytes`, `computeCandidateBoxId`,
`profileFor` come from `@dagsocial/types`; `verifyProof`, `compareProofs`, `decodeNipopowProof`
from `@dagsocial/nipopow`; `blockHash` from `@dagsocial/validation`; `verifyAvlLookup` from
`@ergots/avltree`. This tool hashes nothing and
decodes nothing of its own — a third implementation of any of these would be the first one a user
trusts with a balance.

**3. No state, no keys, no following.** It stores nothing, signs nothing, follows no tip, retries
nothing. Asking two or more independent nodes is its whole defence against an eclipsing node, and it
says so when asked to run with one.

## Component-session rules (Design by Contract)
- **Contracts lead, code follows.** Implement against `NIPOPOW_INTERFACE` and `NODE_INTERFACE`; flag
  contract gaps to main.
- **You own this package only.** Never edit `../../packages/*`, `../../contracts/`, or `../e2e`.
- **Forced verification before "done":** `pnpm --filter @dagsocial/nipopow-client build`,
  `pnpm --filter @dagsocial/nipopow-client typecheck` (two configs — run
  `npx tsc --noEmit -p tools/nipopow-client/tsconfig.test.json` explicitly and report it separately)
  **and** `pnpm --filter @dagsocial/nipopow-client test`, all clean.
- ⛔ **`pnpm --filter`, never `pnpm -r`** — the tree is shared.
- ⚠ **No test may talk to a real node.** The node's HTTP surface is stubbed; proofs and AVL proofs
  are built in the test. What a real node serves is `tools/e2e`'s acceptance case, not this suite's.

## Quick commands
```bash
pnpm --filter @dagsocial/nipopow-client build
pnpm --filter @dagsocial/nipopow-client typecheck
npx tsc --noEmit -p tools/nipopow-client/tsconfig.test.json   # the second config, run explicitly
pnpm --filter @dagsocial/nipopow-client test
```
