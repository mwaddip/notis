# @dagsocial/test-state — Component Session Context

You are the **test-state component session** for **Notis** (repo dir `dagsocial`). This file is your
standing context — read it and the linked docs before touching code.

## Read first, in order
1. `../../contracts/TEST_STATE_INTERFACE.md` — **the contract this member implements.** Every
   section leads behaviour that lives in this directory.
2. `~/projects/OVERRIDES.md` — mechanical overrides (root-cause only, forced verification,
   truncation suspicion).
3. `~/.claude/RTK.md` — RTK proxy rules (`rtk proxy` for completeness-critical searches/diffs).
4. `../../CLAUDE.md` (repo root) — project overview + Design-by-Contract workflow.
5. `../../contracts/ARCHITECTURE.md → Build and test resolution` — rule 4 (the stale-`dist`
   refusal and its lists live here) and rule 5 (the per-member `tsconfig.test.json` wiring).
6. `../../contracts/MINING_INTERFACE.md` — `Mining API`, `Difficulty Schedule`, `Header timestamp
   rules`, `Consolidation`. The miner this member spawns is a client of these rules.
7. `../../contracts/NODE_INTERFACE.md → Configuration` — `DB_PATH`, `NODE_KEY_PATH`, `PORT`,
   `ADMIN_PORT`, `LISTEN_ADDRS`, `BOOTSTRAP_PEERS`, `NODE_ROLE`, `MINING_SECRET` — the environment
   this member's loader writes for each spawned node.

## What Notis is
An invite-only decentralized notice board on a **dual-ledger** design: a **Posts DAG** and a **UTXO
ledger** (karma + credits); every post, like and withdrawal is a transaction on the UTXO ledger, and
withdrawal is the author's only act over a post. Consensus is PoW. TypeScript, pnpm workspaces,
Node ≥ 24.

## This member (`@dagsocial/test-state`)
Prepared devnet state for checks that need members, a name and posts before their first write. A
generator builds a state once on a fresh devnet stack through the product's own write paths; a
per-user cache keeps it under the fingerprint of the build that made it; a loader brings up a stack
on a copy of it. The one stale-`dist` check and the one clock preload for every member that spawns
a node or the faucet live here, imported from here by `tools/e2e` (`ARCHITECTURE → Build and test
resolution`).

- **Owns:** `src/*`, `test/*`.
- **Does NOT own** (`TEST_STATE_INTERFACE → Does NOT own`):
  - the extension check's own flow and relays (`packages/web/scripts/extension-check/`);
  - the write paths the generator drives (`promote.mjs` and `claim-name.mjs`, which are web's);
  - the mesh suite's meshes, which `tools/e2e` brings up from genesis per file;
  - any protocol rule — a defect here is reported, never fixed in `packages/`.

## Three properties a change here must not undo

**1. Devnet only.** The generator and the loader refuse a node whose `/status` names another
network. Every identity a state carries is devnet-only and secret nowhere.

**2. A state belongs to its build.** The fingerprint covers every byte that decides what a stack
writes or accepts: every runtime `.js` on the stale-`dist` lists for the node and the faucet, this
member's source, the generator's write scripts, and `pnpm-lock.yaml`. A narrower input set would let
one build load a store another build would not have written, and nothing would say so
(`TEST_STATE_INTERFACE → The fingerprint`).

**3. The clock offset covers every node-side process of a run.** `Date.now()` is shifted through the
preload loaded with `--import`. The web client reads real time, so the offset is always behind real
time and every stamp a run makes passes the future bound on every reader
(`TEST_STATE_INTERFACE → The clock offset`).
