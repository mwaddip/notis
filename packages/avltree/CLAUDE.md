# @dagsocial/avltree — Component Session Context

You are the **avltree component session** for **Notis** (repo dir `dagsocial`). This file is your
standing context — read it and the linked docs before touching code.

## Read first, in order
1. `~/projects/OVERRIDES.md` — mechanical overrides (root-cause only, forced verification, exhaustive
   rename search).
2. `~/.claude/RTK.md` — RTK proxy rules (`rtk proxy` for completeness-critical searches/diffs).
3. `../../CLAUDE.md` (repo root) — project overview + Design-by-Contract dispatch workflow.
4. `../../contracts/ARCHITECTURE.md` — architecture + invariants.
5. `../../contracts/SPECIAL.md` — S.P.E.C.I.A.L. attention weights.
6. `../../contracts/AVLTREE_INTERFACE.md` — this package's contract.

## What Notis is
An invite-only decentralized social network on a **dual-ledger** design: a **Posts DAG** (author-sovereign)
and a **UTXO ledger** (non-tradeable **karma** + tradeable **credits**); every post, like and withdrawal
is a transaction on the UTXO ledger, and withdrawal is the author's only act over a post. Consensus is
single-phase PoW over validator-produced ordering blocks. TypeScript, pnpm workspaces, Node.js ≥ 22.

## This package (`@dagsocial/avltree`)
The authenticated AVL+ tree as Notis uses it: `@ergots/avltree` — a port of Ergo's AVL+ tree — plus the
three things Notis needs that Ergo's tree does not have: the neighbor-reporting lookups, the strict
verifier, and nodes loaded on first access. **It is the one package of the workspace that imports
`@ergots/avltree`**; every other member imports the tree from here.

It copies no engine code. Everything it adds, it adds through `@ergots/avltree`'s extension surface.
Where an addition needs something of the engine that the surface lacks, the surface grows in
`@ergots/avltree`; nothing is re-implemented here.

- **Owns:** `src/*` and `test/*` of this package, its `package.json`, `tsconfig*.json`,
  `vitest.config.ts`.
- **Does NOT own:** the engine (`@ergots/avltree`); the tree's keys and value codecs
  (`@dagsocial/types`); what the rules read and write (`@dagsocial/consensus`); the store and the kept
  roots (`@dagsocial/node`).

## Component-session rules (Design by Contract)
- **Contracts lead, code follows.** Implement to `AVLTREE_INTERFACE.md`; flag contract gaps to main.
- **You own this package only.** Never edit `../types`, `../validation`, `../consensus`, `../node`,
  `../net`, `../nipopow`, `../web`, `../wire`, `../../tools`, or `contracts/`.
- **No engine code is copied.** If something you need is not exported by `@ergots/avltree`, stop and report
  it — the fix is an export in `@ergots/avltree`, never a copy here.
- **Forced verification before "done":** `pnpm --filter @dagsocial/avltree build`, then
  `pnpm --filter @dagsocial/avltree typecheck` (zero errors, src AND test tree) **and**
  `pnpm --filter @dagsocial/avltree test` (all pass). State results; never claim done unverified.

## Quick commands
```bash
pnpm --filter @dagsocial/avltree build
pnpm --filter @dagsocial/avltree typecheck
pnpm --filter @dagsocial/avltree test
```
