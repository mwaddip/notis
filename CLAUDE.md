# Notis

An invite-only decentralized social network on a **dual-ledger** design: a **Posts DAG**
(author-sovereign, prunable content) and a **UTXO ledger** (non-tradeable **karma** + tradeable
**credits**), bound together by **stumps**. Consensus is PoW — user sub-blocks plus validator ordering
blocks. TypeScript monorepo, pnpm workspaces, Node.js ≥ 22, SQLite storage.

Repo directory is `dagsocial`; the project is Notis.

> **Use the `notis-node-development` skill** if it is available to you. It carries the depth this file
> summarises — the dual-ledger architecture, the positional wire format, hashing and signature rules,
> totality (sentinels versus throws), the S.P.E.C.I.A.L. attention weights, the verification gate and
> the deploy gate.

## Quick commands

```bash
pnpm build                          # Build all five packages
pnpm test                           # Run all tests
pnpm typecheck                      # src AND test trees, both configs
node packages/node/dist/index.js    # Start a node on :3000
```

**`pnpm test` does not prove a package builds** — test code resolves `@dagsocial/*` to `src`, never
`dist`. The gate before any commit is:

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r test
```

Run the last two **per package**: `pnpm -r test` fails fast and hides everything after a red package.
See ARCHITECTURE → "Build and test resolution".

## Architecture

Five packages, in dependency order:

- `@dagsocial/types` — data structures, base58, CBOR, hashing, protocol constants. **Pure functions only.**
- `@dagsocial/wire` — stream framing (VLQ, blake2b checksums, magic bytes).
- `@dagsocial/validation` — pure stateless checks: PoW, signatures, block structure, Merkle roots.
- `@dagsocial/net` — libp2p + Gossipsub relay, header-first sync, peer management.
- `@dagsocial/node` — Express server, PoW, verifier, SQLite store, UTXO engine, AVL+ state root, block creator, demo UI.

Future: `@dagsocial/web` (React client).

## Design by Contract

`contracts/` is the source of truth for every interface. **Contracts lead; code follows** — update the
contract first, then implement against it, never the reverse.

- `contracts/ARCHITECTURE.md` — system overview, invariants, protocol versioning
- `contracts/TYPES_INTERFACE.md` — types package
- `contracts/VALIDATION_INTERFACE.md` — stateless checks
- `contracts/NODE_INTERFACE.md` — API, verifier, store interface
- `contracts/NET_INTERFACE.md` — libp2p, gossip, sync
- `contracts/MEMPOOL_INTERFACE.md` · `contracts/MINING_INTERFACE.md` · `contracts/SUBBLOCK_INTERFACE.md` · `contracts/JOURNAL_EVENTS.md`
- `contracts/WEB_INTERFACE.md` — web client (Phase 2)
- `contracts/HOUSE_STYLE.md` — colour, type, the mark, motion, interaction, spacing, voice
- `contracts/SPECIAL.md` — per-subsystem attention weights

**The contract change rides the same branch as the code that implements it** — not merged ahead of it.
One PR shows the rule and its implementation together, so a reviewer can check they agree instead of
taking it on trust.

## What we write down

**Everything we write describes reality as it is.** Code comments, commit bodies, PR bodies, titles —
all of it states the present tense of the current tree.

**Not backward-looking.** How it used to work, what was fixed, what went wrong before, why the change
is justified. None of that is a fact about the tree a reader is holding, and each such sentence is a
second claim that decays on its own schedule.

**Forward-looking only when it is a deliberate stub for planned work**, and marked as one — the
contracts' `AHEAD OF CODE`. That is the single exception, because a stub's whole purpose is to say the
code is not there yet.

Where reasoning genuinely has to survive, **it goes in `contracts/` as a rule** — somewhere a reader
can check it against the tree.

## Comment style

**Cite the CONTRACT.** A comment either states the rule as it stands now, or names the contract section
that states it — `TYPES_INTERFACE → Layout — Stump`.

⛔ **`contracts/` is the only citable directory.** A comment pointing anywhere else in this repo may be
pointing at nothing: `.gitignore` excludes whole directories of working material, so a citation that
resolves on the author's machine can resolve nowhere for everyone else. A measurement worth keeping
belongs in the contract, not behind a pointer.

**Never cite a phase.** A bare `Phase N` resolves to nothing anywhere.

**Cite a contract section by its PROSE NAME, never by a phase-tagged parenthetical.** Some headings
embed their own tags — `### Bond transition rules (P2-B phase 1)`. The prose name is what a reader
greps and what survives; the parenthetical is the half a reconciliation will rewrite.

**Never narrate replaced code.** How a function used to behave is not a fact about the current tree. No
reader has to reason about code that is gone, and a narrated history is a second claim that decays
independently of the one beside it.

⚠ **This binds code comments. `contracts/` is deliberately exempt for now** — some phase citations
there are load-bearing while the contract-vs-code reconciliation is unwritten (user, 2026-08-11). **Do
not sweep `contracts/` under this rule.** The exemption ends with that reconciliation, not with a
cleanup.

## Commit and PR bodies

Same principle one level up: **describe what the change does, not the road to it.**

**The what, not the why.** *"Fixes an issue where `x` became `y`"* is a complete description.
*"…because `x` is not `y`, and the last time `a` became `b` it went unnoticed for months"* is a
justification nobody asked for. **A fix needs no excuse.**

**No anecdotes, no history.** A body recounting a past incident is telling a story rather than
describing a diff, and stories drift. If an incident genuinely bears on the change, it belongs in the
contract as a rule.

**Caps: ~800 characters for a commit body, ~2000 for a PR.** Over the cap, cut a whole section rather
than trimming sentences.

**Titles are `type(scope): plain summary`, and the summary names the SUBJECT, not the class of
change.** *"correct five service-test claims that time had made false"* describes a category and could
head twenty different commits; *"karma, decay and credits stop citing the removed `sortKeys` pass"*
names what was wrong and where. **The test: if swapping in a different subject leaves the title still
true, it is too abstract.** Plain means concrete, not vague — naming a function, file or claim is what
makes a title plain.

## Key invariants

- Post content: 1–300 UTF-8 bytes (`MAX_CONTENT_BYTES`)
- Parent refs: 0–1 per post (`MAX_PARENT_REFS`)
- **On-chain time is block height**, never wall clock
- Signatures: raw Ed25519 (64 bytes), base64 on wire. Verified with `crypto.verify(null, …)` and a KeyObject
- Hashing: `blake2b512` with `.subarray(0, 32)` for every 32-byte output
- Wire format: positional binary, with CBOR survivals. HTTP API: JSON
- **Value conservation** — user transactions conserve, with a closed set of stated exceptions;
  `NODE_INTERFACE` → `validateTx` step 5 is the authoritative enumeration. All other mints and burns
  happen in block-application paths, never inside a user transaction
- Secret keys never appear in API responses or in DTOs crossing component boundaries
- Protocol version on every post and block (`PROTOCOL_VERSION = 1`)
- Single-transaction atomic writes for any multi-table mutation

## Protocol versioning

All posts and blocks carry a `protocolVersion`. Validation rules are keyed to this version; old posts
are validated against their declared version forever, and a node rejects an unsupported one.

> ⚠ **NOT IMPLEMENTED — this describes the intended design, not the running code.**
> There is no version-keyed rule table. Validation is a **strict equality check against
> `PROTOCOL_VERSION`**, so nothing is "validated against its declared version forever" and the first
> version bump makes existing history un-resyncable. The design stands — the mechanism is Phase 2 work.
> **Do not write code or contract text that assumes version-keyed dispatch exists.**

## Platform constraint

Node.js v22 does not support `createHash('blake2b256')`. All hashing uses `createHash('blake2b512')`
with `.subarray(0, 32)`. The demo UI uses `blakejs` from CDN — `blake2b(data, null, 64).slice(0, 32)`.
**These must produce identical output**; both are standard BLAKE2b-512.
