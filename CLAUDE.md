# Notis

An invite-only decentralized social network on a **dual-ledger** design: a **Posts DAG**
(author-sovereign, prunable content) and a **UTXO ledger** (non-tradeable **karma** + tradeable
**credits**); every post, like and prune is a transaction on the UTXO ledger, and a pruned subtree
leaves a **stump**. Consensus is single-phase PoW — validator-produced ordering blocks; posts and
likes ride them as ordinary transactions. TypeScript monorepo, pnpm
workspaces, Node.js ≥ 22, SQLite storage.

Repo directory is `dagsocial`; the project is Notis.

> **Use the `notis-node-development` skill** if it is available to you. It carries the depth this file
> summarises — the dual-ledger architecture, the positional wire format, hashing and signature rules,
> totality (sentinels versus throws), the S.P.E.C.I.A.L. attention weights, the verification gate and
> the deploy gate.

## Quick commands

```bash
pnpm build                          # Build all six packages
pnpm test                           # Run all tests — includes tools/e2e, which spawns BUILT nodes: build first
pnpm typecheck                      # src AND test trees, both configs
node packages/node/dist/index.js    # Start a node on :3000
```

**`pnpm test` does not prove a package builds** — test code resolves `@dagsocial/*` to `src`, never
`dist`. The gate before any commit is:

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r test
```

Run the last two **per package**: `pnpm -r test` fails fast and hides everything after a red package.
**The build step is load-bearing, not advisory:** `tools/e2e` spawns `packages/node/dist/index.js` and
refuses to run against a missing or stale `dist`. See ARCHITECTURE → "Build and test resolution".

## Architecture

Seven packages, in dependency order:

- `@dagsocial/types` — data structures, base58, positional codecs, hashing, protocol constants. **Pure functions only.**
- `@dagsocial/wire` — stream framing (VLQ, blake2b checksums, magic bytes).
- `@dagsocial/validation` — pure stateless checks: PoW, signatures, block structure, Merkle roots.
- `@dagsocial/nipopow` — NiPoPoW proofs over ordering-block headers: the proof codecs, `verifyProof`, `compareProofs`, `proveWithReader`. **Pure functions only.**
- `@dagsocial/net` — libp2p + Gossipsub relay, whole-block sync, peer management.
- `@dagsocial/node` — Express server, PoW, verifier, SQLite store, UTXO engine, AVL+ state root, block creator, demo UI.
- `@dagsocial/web` — the browser client, built with vite. The **read surface** — feed, threads, a
  tiling workspace, both themes — and the **write surface's first slice**: an identity held in the
  browser, the composer for a root and a reply, and like, on transactions the client builds and signs
  itself. It hashes only through `@dagsocial/types`, reached by a build-time `crypto` shim, and signs
  with `@noble/curves`; with no identity loaded it is the read surface exactly.

Three tools live under `tools/` — in the workspace by the `tools/*` glob, so in `pnpm -r test`:

- `@dagsocial/faucet` — an ordinary-key service that invites and sends credits through the node's HTTP API.
- `@dagsocial/e2e` — the mesh suite: spawns a mesh of built nodes and asserts the protocol across them over
  HTTP; mines on demand, paces on block height. A client of the contracts, with none of its own.
- `@dagsocial/nipopow-client` — the light client: verifies and compares NiPoPoW proofs from N≥2 nodes,
  then proves a key's boxes against the verified `stateRoot`.

## Design by Contract

`contracts/` is the source of truth for every interface. **Contracts lead; code follows** — update the
contract first, then implement against it, never the reverse.

- `contracts/ARCHITECTURE.md` — system overview, invariants, protocol versioning
- `contracts/TYPES_INTERFACE.md` — types package
- `contracts/WIRE_INTERFACE.md` — stream framing codec
- `contracts/VALIDATION_INTERFACE.md` — stateless checks
- `contracts/NODE_INTERFACE.md` — API, verifier, store interface
- `contracts/NET_INTERFACE.md` — libp2p, gossip, sync
- `contracts/NIPOPOW_INTERFACE.md` — the proof package: objects, codecs, verifier, comparator, prover
- `contracts/MEMPOOL_INTERFACE.md` · `contracts/MINING_INTERFACE.md` · `contracts/JOURNAL_EVENTS.md`
- `contracts/WEB_INTERFACE.md` — web client
- `contracts/HOUSE_STYLE.md` — colour, type, the mark, motion, interaction, spacing, voice
- `contracts/SPECIAL.md` — per-subsystem attention weights
- `contracts/CONSTANTS.md` — every protocol number in one place, with what argues it and its standing

**The contract change rides the same branch as the code that implements it** — not merged ahead of it.
One PR shows the rule and its implementation together, so a reviewer can check they agree instead of
taking it on trust. **The contract pass closes the branch, before its PR opens:** once the gate is
green, the unit's dated `AHEAD OF CODE` markers are retired and every marker whose subject the unit
touched is re-read against the code — a branch merges with no marker dated to its own unit.

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
that states it — `TYPES_INTERFACE → Layout — PruneCommit`.

⛔ **`contracts/` is the only citable directory.** A comment pointing anywhere else in this repo may be
pointing at nothing: `.gitignore` excludes whole directories of working material, so a citation that
resolves on the author's machine can resolve nowhere for everyone else. A measurement worth keeping
belongs in the contract, not behind a pointer.

**A citation is `<CONTRACT> → <name>`, and the name is one of exactly two things:**

1. **A heading's prose name** — the heading text up to its first ` — `, `, `, `: `, `; ` or ` (`, any
   leading ⛔ / ⚠ / ✅ mark dropped. Case is free; the words and their spacing are not. So
   `### Bond transition rules (P2-B phase 1)` is cited as `Bond transition rules` (never the
   phase-tagged parenthetical — that is the half a reconciliation rewrites), `### Box value domain —
   [0, 2⁶³), stated here and cited everywhere else` as `Box value domain`, and `### Ordering block` as
   `Ordering block`, never as the type name `OrderingBlock`. The whole heading is always an acceptable
   name; **the prose name must be unique in its contract**, and where it is not (`Layout` heads seven
   `### Layout — …` headings) the whole heading is required — `TYPES_INTERFACE → Layout — Boxes`. Never
   a heading's tail, never a truncation of it.
2. **A bold lead, in quotes** — the `**bold sentence**` that opens a rule inside a section, cited as
   `NODE_INTERFACE → "Reach is the live argument, not the halt"`, or after its heading:
   `NET_INTERFACE → Handshake → "Ban policy"`. Quotes say *a lead*; a bare name says *a heading*.

⛔ **Never cite a marker** — `AHEAD OF CODE`, `RESOLVED`, `SUPERSEDED`, or anything carrying a date,
heading or lead. Markers are retired by design, so a citation to one expires with it; cite the rule the
marker is about, under the name it will keep. **Never cite a phase** — a bare `Phase N` resolves to
nothing anywhere.

**Grep before citing, paste what you find** — `grep -n '^#\|\*\*' contracts/<FILE>.md`. A
plausible-sounding name is the defect this rule exists for: a citation is a pin, and a pin that matches
no heading and no lead points at nothing.

**Never narrate replaced code.** How a function used to behave is not a fact about the current tree. No
reader has to reason about code that is gone, and a narrated history is a second claim that decays
independently of the one beside it.

⚠ **This binds `contracts/` as well as code comments.** A contract states the rule as it stands, and
prose describing what the text used to say is narration there exactly as it is in a comment. **A
marker is the exception, and only for its own subject** — recording a change is what a marker is for,
so `RESOLVED`, `SUPERSEDED` and a dated record may state what they replaced, and a passage marked as
a given date's state keeps its reasoning. Prose outside one describes the present tree.

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
- **On-chain time is block height**, never wall clock — one named exemption: the ordering-block
  difficulty schedule reads header `createdAt` stamps (`MINING_INTERFACE` → Difficulty Schedule)
- Signatures: raw Ed25519 — 64 raw bytes on the positional wire, hex at the HTTP JSON edge. Verified with
  `crypto.verify(null, …)` and a KeyObject
- Hashing: `blake2b512` with `.subarray(0, 32)` for every 32-byte output
- Wire format: positional binary. HTTP API: JSON
- **Value conservation** — every user transaction conserves, unconditionally: each cost lands in a
  box the transaction itself outputs (`NODE_INTERFACE` → `validateTx` step 7). All mints and burns
  happen in block-application paths, never inside a user transaction
- Secret keys never appear in API responses or in DTOs crossing component boundaries
- Protocol version on every post commit, block, transaction and stump, equal to the era scheduled at its height
- Single-transaction atomic writes for any multi-table mutation

## Protocol versioning

Every post commit, block, transaction and stump carries a `protocolVersion`. The version in force is
scheduled by height, per network (`NetworkProfile.protocolVersionSchedule`); a declared version must equal
the era at the object's height — a block's own, a transaction's the block that carries it (`tip + 1` at
admission) — so an old object validates under its era's rules because its height fixes them, and a new one
cannot pose as old. A bump adds an era row an upgrade window ahead; peering is by era coverage, and a
version mismatch is never a ban. `PROTOCOL_VERSION` is the highest version a build implements. A rule that
differs between versions branches on the era as passed in, never on a module constant
(`ARCHITECTURE → Protocol Versioning`).

## Platform constraint

Node.js v22 does not support `createHash('blake2b256')`. All hashing uses `createHash('blake2b512')`
with `.subarray(0, 32)`. The demo UI uses `blakejs` from CDN — `blake2b(data, null, 64).slice(0, 32)`.
**These must produce identical output**; both are standard BLAKE2b-512.
