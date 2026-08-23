# @dagsocial/e2e — Component Session Context

You are the **e2e component session** for **Notis** (repo dir `dagsocial`). This file is your
standing context — read it and the linked docs before touching code.

## Read first, in order
1. `~/projects/OVERRIDES.md` — mechanical overrides (root-cause only, forced verification, truncation
   suspicion, enumeration-is-a-claim, the blockchain rules).
2. `~/.claude/RTK.md` — RTK proxy rules (`rtk proxy` for completeness-critical searches/diffs).
3. `../../CLAUDE.md` (repo root) — project overview + Design-by-Contract dispatch workflow.
4. `../../contracts/ARCHITECTURE.md` — **`Build and test resolution`** (rule 4 names this suite),
   `Invariants`, `Invite System`, `Likes`, `Deploy gate`.
5. `../../contracts/NODE_INTERFACE.md` — **the contract this package CONSUMES**: `HTTP API` (every
   route table), the transition rules (karma, bond, vouch, credit), `Post transactions`,
   `Per-block like settlement`, `Stumps`, `Fork resolution`.
6. `../../contracts/MINING_INTERFACE.md` — `Template and submit`, `The peer-readiness gate`,
   `POST /mining/submit`, `Miner Script` (the solve loop this suite mirrors by importing the predicate).
7. `../../contracts/NET_INTERFACE.md` — `Gossip Topics`, `Sync Flow`, `Bootstrap Flow (New Node)`,
   `Outbound Manager` (the 30 s tick).
8. `../../contracts/SPECIAL.md` — S.P.E.C.I.A.L. attention weights. It carries a section per protocol
   package and none for this one; 5 is competent everywhere by default.
9. Your task's spec in `../../docs/specs/` — `2026-08-21-e2e-mesh-suite.md` for J-1.

⛔ **There is no `E2E_INTERFACE.md`, and its absence is the point.** The five protocol packages have
contracts because they define consensus surface. This suite has none: it is a client that signs
ordinary transactions with ordinary keys and asserts what `NODE_INTERFACE`, `MINING_INTERFACE` and
`NET_INTERFACE` already state. A contract naming this suite would be a contract naming a *caller*.
**If the node refuses what a contract says it accepts, or accepts what it says it refuses, that is a
FINDING to report to main — never a workaround written into a test.**

## What Notis is
An invite-only decentralized social network on a **dual-ledger** design: a **Posts DAG** and a **UTXO
ledger** (karma + credits), bound by **stumps**. Consensus is PoW. TypeScript, pnpm workspaces, Node ≥ 22.

## This package (`@dagsocial/e2e`)
The end-to-end suite: it spawns a **mesh of real, built nodes** (`packages/node/dist/index.js`, real
libp2p, real HTTP), drives them as a client would — invites, posts, likes, vouches, prunes, credit
transfers, mining on demand — and asserts the protocol's behaviour **on every node** of the mesh. It
lives under `tools/` because it is a tool, not a peer of `validation`, and it is in the gate because
`pnpm-workspace.yaml` globs `tools/*` — nothing has to remember to run it.

- **Owns:** `src/*` (the harness), `test/*` (the chapters), `package.json`, `vitest.config.ts`,
  `tsconfig.json`, `tsconfig.test.json`.
- **Does NOT own:** anything in `packages/` (including `packages/node/scripts/dev.mjs`, whose spawn
  recipe this harness mirrors and does not import), anything in `contracts/`, the workspace glob.

## ⛔ Seven properties a change here must not undo

**1. It spawns `dist`, never imports the node — and a stale `dist` is a refusal.** The node's config
is a module-scope singleton, so two nodes cannot share a process; every node is a child process
running the built artefact, which loads `types`, `wire`, `validation` and `net` from *their* `dist`.
Setup stats each of the five `packages/<p>/dist/index.js` against the newest file under that
package's `src/` and fails the run naming the stale package and the command (`pnpm -r build`). A
`git checkout` that touches `src` makes `dist` read stale by mtime even when the content is
identical; the refusal is loud and the remedy is the build. A false-fresh is impossible.

**2. It paces on block height, never wall clock.** `mine(node, n)` is the clock. `confirm(...)` mines
one block at a time until the observing node reads the effect — **bounded in blocks** (the template is
rebuilt on tip movement only, so a submission rides the block *after* next). The one time-bounded wait
is `waitHeight(nodes, h, windowMs)` — gossip arrival — and it fails with every node's log tail.
Journal lines on stdout are evidence in failure reports, never wait conditions.

**3. Assertions that fail.** A chapter that logs its headline claim is not coverage. Every assertion
is made on **every node** of the mesh unless the chapter states otherwise, and the first act of every
chapter file is the mesh proof: mine 1 on node 1, height 1 everywhere, `/blocks/1` identical.

**4. No casts.** `as never`, `as unknown as`, `as any` are forbidden in this tree and
`test/no-casts.test.ts` fails on a hit. Real types from `@dagsocial/types` end to end, through the
JSON edge (`txToJson` converts by a value's **runtime type**, never by a list of field names). A field
the node drops or renames fails typecheck or the run — never neither. This is the rot the last suite
died of: 45 tests typechecked clean behind casts and tested a protocol that no longer existed.

**5. No second copy of consensus.** `computeTxId`, `computeCandidateBoxId`, `selectBoxes`,
`leafHash`, `buildMerkleRoot`, the constants and the profiles come from `@dagsocial/types`;
`orderingPowTarget` and `meetsPowTarget` from `@dagsocial/validation`. The solve loop imports the
predicate `scripts/miner.mjs` has to mirror. Every change-box id is re-read from the node after
confirmation and asserted equal to the derived candidate id, so the JSON edge is checked every time
it is used.

**6. The devnet faucet is a fixture identity, and it is public by design.** Karma reaches any
identity only through an invite, and genesis seeds karma only for `profile.faucetPublicKey`. Devnet's
keypair — public key `NETWORK_PROFILES.devnet.faucetPublicKey`, PKCS8 DER from
`git show 79dec5f:packages/node/src/store/system.ts` (`SYSTEM_PKCS8_HEX`) — lives in `src/identities.ts`;
`test/fixture-key.test.ts` pins that the secret derives the profile's key. It is used on
**devnet only**; testnet's faucet key guards a balance testers depend on and is never in this tree.

**7. One mesh per chapter file, and it always comes down.** `fileParallelism: false`; a fixed port
table (`src/ports.ts`: file k → base `11000 + 100·k`; node i → http `base + 10·i`, admin `+1`, p2p
`+2`); `NODE_ROLE=miner` on every node with one random `MINING_SECRET` per mesh; `DB_PATH` under a
`mkdtemp` dir (the AVL store rides the same SQLite file); bootstrap-first start, each node awaited on
`/status` (which answers only after its bootstrap dial has finished). Teardown SIGTERMs, awaits exit
and removes the dir — on failure too.

## Cost, measured

The full suite — nine chapter files, meshes of 1–4 spawned nodes each — runs in **19–28 s** on the
machine it was written on (2026-08-23; every run of the unit's per-commit gate fell in that range).
A chapter that pushes the suite well past that needs a reason stated in its commit: this number is
what every `pnpm -r test` in the gate pays.

## Component-session rules (Design by Contract)
- **Contracts lead, code follows.** Implement against `NODE_INTERFACE` / `MINING_INTERFACE` /
  `NET_INTERFACE`; every disagreement between a contract and the node is a finding for the REPORT.
- **You own this package only.** Never edit `../../packages/*` or `../../contracts/`. Cross-cutting
  changes — the workspace glob, the lockfile beyond this package's entry — are main's to route.
- **Forced verification before "done":** the five `dist`s fresh (`pnpm --filter @dagsocial/<p> build`
  for `wire`, `types`, `validation`, `net`, `node`, in that order — `types` imports `wire`), then
  `pnpm --filter @dagsocial/e2e typecheck` **and** `pnpm --filter @dagsocial/e2e test`, both clean,
  with the suite's wall-clock stated. ⛔ **`typecheck` is two configs**, and the test one is the config
  that catches an argument the runtime happens to accept — run
  `npx tsc --noEmit -p tools/e2e/tsconfig.test.json` explicitly and report it separately.
- ⛔ **`pnpm --filter`, never `pnpm -r`** — the tree is shared, and `-r` compiles a sibling's
  uncommitted work into `dist/`. ⚠ **`git status --short packages/` before building**, and say what
  the tree held: a sibling's uncommitted edit rides into the `dist` this suite spawns.
- **Comments cite `contracts/` only, by prose heading** — grep `^#` in the contract before citing;
  never a phase tag, never this file, never the spec. Present tense; no narration of what code used to do.
- **Commits:** `git add <explicit paths>` and `git commit -m "…" -- <the same paths>` (pathspec LAST);
  `git show --stat HEAD` after each; `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer;
  title `type(scope): plain summary` naming the subject; body ≤ ~800 chars describing what the change
  does. **Never push** — main pushes.
- **Phased execution:** ≤5 files per phase; verify; report; wait for main's go.
- **Report back** to the main session via kitty `send-text` when a phase/task is complete.

## Quick commands
```bash
for p in wire types validation net node; do pnpm --filter @dagsocial/$p build; done   # fresh dists, in order
pnpm --filter @dagsocial/e2e typecheck
npx tsc --noEmit -p tools/e2e/tsconfig.test.json    # the second config, run explicitly
time pnpm --filter @dagsocial/e2e test              # the mesh; state the wall-clock
```
