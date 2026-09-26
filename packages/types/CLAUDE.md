# @dagsocial/types — Component Session Context

You are the **types component session** for **Notis** (repo dir `dagsocial`). This file is your standing
context — read it and the linked docs before touching code.

## Read first, in order
1. `~/projects/OVERRIDES.md` — mechanical overrides (root-cause only, forced verification, exhaustive rename
   search, blockchain rules). Apply throughout.
2. `~/.claude/RTK.md` — RTK proxy rules (`rtk proxy` for completeness-critical searches/diffs).
3. `../../CLAUDE.md` (repo root) — project overview + Design-by-Contract dispatch workflow.
4. `../../contracts/ARCHITECTURE.md` — architecture + invariants.
5. `../../contracts/SPECIAL.md` — S.P.E.C.I.A.L. attention weights. Internalize on session start; they
   bias where you spend *extra* scrutiny, and 5 is competent everywhere by default.
6. `../../contracts/TYPES_INTERFACE.md` — this package's contract.
7. Your task's spec in `../../docs/specs/`.

## What Notis is
An invite-only decentralized social network on a **dual-ledger** design: a **Posts DAG** (author-sovereign)
and a **UTXO ledger** (non-tradeable **karma** + tradeable **credits**); every post, like and withdrawal
is a transaction on the UTXO ledger, and withdrawal is the author's only act over a post. Consensus is PoW. TypeScript, pnpm workspaces, Node.js ≥ 22.

## This package (`@dagsocial/types`)
The shared data model and cryptographic/encoding primitives: posts, blocks, boxes, identity,
merkle, positional serialization, protocol constants, the hash/id helpers (`computePostId`,
`computeBoxId`, `computeTxId`), the identity record and the karma valuation
(`identityRecordBytes`, `identityRecordKey`, `effectiveKarma`). **Pure functions only** — no I/O, no state.

- **Owns:** `src/*` (post, post-withdraw, block, utxo, identity, codec, merkle, serialization, interlinks, membership, network, constants, identity-record, karma-valuation, index).
- **Does NOT own:** node logic, networking, stateless validation, wire codec. Depends on `@dagsocial/wire`,
  `@noble/hashes` and `@noble/curves`, and on nothing Node — no built-in, no global: the browser runs it as it is
  written (`ARCHITECTURE → Package boundaries`). A consumer needs a change? It comes back through the main session.

## Component-session rules (Design by Contract)
- **Contracts lead, code follows.** Implement to `TYPES_INTERFACE.md`; flag contract gaps to main.
- **You own this package only.** Never edit `../node`, `../net`, `../validation`, `../wire`, or `contracts/`.
- **Forced verification before "done":** `pnpm --filter @dagsocial/types typecheck` (zero errors — src, the test
  tree, and the browser pass over `tsconfig.browser.json`) **and**
  `pnpm --filter @dagsocial/types test` (all pass). State results; never claim done unverified.
- **Exhaustive rename search** — a hash/id/encoding change here ripples into node, validation, and the demo
  UI. Grep every consumer (code, types, strings, tests) before changing a primitive; report the blast radius.
- **Phased execution:** ≤5 files per phase; verify between phases. **Report back** via kitty when done.

## Types-relevant invariants (full set in ARCHITECTURE.md)
- **Pure functions only** — no filesystem, network, DB, or global state.
- **Hashing** — every 32-byte digest is `hash32` (`TYPES_INTERFACE → The protocol hash`): BLAKE2b-512 over
  `@noble/hashes`, truncated to 32 bytes, pinned in the tests to Node's `createHash('blake2b512')`.
- **Positional wire format** — TYPES_INTERFACE's layout tables are normative; field order is the
  specification, and box/tx/post ids must be reproducible byte-for-byte.
- **Canonical encoding** — a post/box/tx has exactly one id; distinct objects never collide.
  (`computePostId` reads no post fields — identity is provenance-derived from the creating
  transaction.)
- **No dependencies above this package's abstraction level.**

## Quick commands
```bash
pnpm --filter @dagsocial/types typecheck
pnpm --filter @dagsocial/types test
pnpm --filter @dagsocial/types build
```
