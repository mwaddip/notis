# @dagsocial/faucet — Component Session Context

You are the **faucet component session** for **Notis** (repo dir `dagsocial`). This file is your
standing context — read it and the linked docs before touching code.

## Read first, in order
1. `~/projects/OVERRIDES.md` — mechanical overrides (root-cause only, forced verification, truncation
   suspicion, blockchain rules).
2. `~/.claude/RTK.md` — RTK proxy rules (`rtk proxy` for completeness-critical searches/diffs).
3. `../../CLAUDE.md` (repo root) — project overview + Design-by-Contract dispatch workflow.
4. `../../contracts/ARCHITECTURE.md` — architecture + invariants, and **`Invite System`** for the
   mechanism this service drives.
5. `../../contracts/NODE_INTERFACE.md` — **the contract this package CONSUMES**: `HTTP API`,
   `Invites`, `Credits`, and `Karma transition rules` for what the node will accept.
6. `../../contracts/SPECIAL.md` — S.P.E.C.I.A.L. attention weights. It carries a section per protocol
   package and none for this one; 5 is competent everywhere by default.

⛔ **There is no `FAUCET_INTERFACE.md`, and its absence is the point.** The five protocol packages have
contracts because they define consensus surface. This service has none: it is a client that signs
ordinary transactions with an ordinary key, and every rule it must satisfy is already stated in
`NODE_INTERFACE`. A contract naming this service would be a contract naming a *caller*.

## What Notis is
An invite-only decentralized social network on a **dual-ledger** design: a **Posts DAG** and a **UTXO
ledger** (karma + credits), bound by **stumps**. Consensus is PoW. TypeScript, pnpm workspaces, Node ≥ 22.

## This package (`@dagsocial/faucet`)
A small HTTP service that holds an Ed25519 owner key and does what any member can do — invite someone,
and send them credits. It runs on the VPS beside the node and nowhere else.

- `POST /faucet/karma` — builds `karma → karma + bond` and posts it to the node's `POST /invites`.
  The block's settlement grants the bond's own value to the named key.
- `POST /faucet/credits` — an ordinary owner-signed credit transfer.

- **Owns:** `src/*`, `test/*`, `scripts/dagsocial-faucet.service`.
- **Does NOT own:** anything in `packages/` and anything in `contracts/`. It lives under `tools/`
  because it is an operational tool, not a peer of `validation`.

## ⛔ Three properties a change here must not undo

**1. No privileged anything.** Its key is an ordinary owner key over ordinary boxes. No consensus rule
names it, no exemption exists for it, and if it were lost the only loss is this identity's balance on a
network that gets wiped. That property is what let the node delete its own faucet routes. **Never add a
node-side rule, exemption or config key that resolves against this service's identity.**

**2. No local transaction encoding.** `computeTxId`, `computeCandidateBoxId` and `selectBoxes` are
imported from `@dagsocial/types`. The encoding already exists twice — in that package and in the demo
UI's hand-rolled mirror, which a browser needs and this service does not. **A third copy would be the
first one signing value transfers unattended.** `txToJson` converts by a value's runtime type, never by
a list of field names, so it cannot drift from the node's `BINARY_BOX_FIELDS`.

**3. No grant ledger.** Once-per-identity is **consensus state**: the node refuses an invite naming a
key that already holds an `IdentityRecord`, so a repeat request is refused by the node and this service
relays the refusal. ⚠ **"Track who we funded" is the obvious instinct and it is wrong** — the answer
already exists on-chain, and a local table would be a second source of truth about it that can only
disagree. There is no database here and none may be added. The in-memory `PendingChain` is not an
exception: it holds one unconfirmed change box, it is never persisted, and a restart falls back to the
node's confirmed view.

## Component-session rules (Design by Contract)
- **Contracts lead, code follows.** Implement against `NODE_INTERFACE`; flag contract gaps to main.
- **You own this package only.** Never edit `../../packages/*` or `../../contracts/`. Cross-cutting
  changes — the workspace glob, `scripts/build-deb.sh` — are main's to route.
- **Forced verification before "done":** `pnpm --filter @dagsocial/faucet typecheck` **and**
  `pnpm --filter @dagsocial/faucet test`, both clean. ⛔ **`typecheck` is two configs**, and the test
  one is the config that catches an argument the runtime happens to accept — run
  `npx tsc --noEmit -p tools/faucet/tsconfig.test.json` explicitly and report it separately.
- ⛔ **`pnpm --filter`, never `pnpm -r`** — the tree is shared, and `-r` compiles a sibling's
  uncommitted work into `dist/`.
- **The secret key is never logged, never echoed, never written to the repo.** Not in an error message,
  not in a debug line. Errors name the key's *path*, never its bytes.
- ⚠ **No test may talk to a real node.** The node's HTTP surface is stubbed. This service's correctness
  is *what it builds and signs*; what the node accepts is the node's own suite.

## Quick commands
```bash
pnpm --filter @dagsocial/faucet typecheck
npx tsc --noEmit -p tools/faucet/tsconfig.test.json   # the second config, run explicitly
pnpm --filter @dagsocial/faucet test
pnpm --filter @dagsocial/faucet build
```
