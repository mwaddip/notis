# DAGsocial

Read and apply `~/projects/OVERRIDES.md` before anything else.

Decentralized social network. Phase 1: local HTTP node with identity, two-phase PoW, DAG post storage in SQLite. TypeScript monorepo, pnpm workspaces, Node.js ≥ 22.

## Quick commands

```bash
pnpm build                # Build all five packages
pnpm test                 # Run all tests across the five packages
pnpm typecheck            # Type-check all packages — src AND test trees, both configs
node packages/node/dist/index.js   # Start node on :3000
```

`pnpm test` does **not** prove a package builds (test code resolves
`@dagsocial/*` to `src`, never `dist`), so
`pnpm -r build && pnpm -r typecheck && pnpm -r test` is the gate before any
commit — see ARCHITECTURE → "Build and test resolution".

## Architecture

Five packages:
- `@dagsocial/types` — data structures, base58, CBOR, hashing, protocol constants. Pure functions only.
- `@dagsocial/validation` — pure stateless checks: PoW, signatures, block structure, Merkle roots.
- `@dagsocial/wire` — stream framing (VLQ, blake2b checksums, magic bytes).
- `@dagsocial/net` — libp2p + Gossipsub relay, header-first sync, peer management.
- `@dagsocial/node` — Express server, PoW, verifier, SQLite store, UTXO engine, AVL+ state root, block creator, demo UI.

Future: `@dagsocial/web` (React client).

## Design by Contract

This project uses Design by Contract for multi-session workflow. The `contracts/` directory is the source of truth for interfaces. Contracts lead; code follows.

- `contracts/ARCHITECTURE.md` — system overview, invariants, protocol versioning
- `contracts/TYPES_INTERFACE.md` — types package contract
- `contracts/VALIDATION_INTERFACE.md` — validation package contract (pure stateless checks)
- `contracts/NODE_INTERFACE.md` — node package contract (API, verifier, store interface)
- `contracts/NET_INTERFACE.md` — networking contract (libp2p, gossip, sync)
- `contracts/WEB_INTERFACE.md` — web client contract (Phase 2)
- `contracts/HOUSE_STYLE.md` — colour, type, the mark, motion, interaction, spacing, voice (specified, nothing conforms yet)

### Workflow

1. Update the contract first in `contracts/`
2. Write a dispatch prompt in `prompts/<component>-<task>.md` with required boilerplate (see below)
3. Dispatch via kitty:

```bash
# Capture main window id
MAIN_WINDOW=$KITTY_WINDOW_ID

# Spawn new window with cwd INSIDE the target package, so packages/<component>/CLAUDE.md
# auto-loads (along with the repo-root CLAUDE.md) as the session's standing context.
NEW_WIN=$(kitty @ launch --type=window --cwd=/home/mwaddip/projects/dagsocial/packages/<component>)

# Launch dclaude
kitty @ send-text --match=id:$NEW_WIN 'ac'
kitty @ send-text --match=id:$NEW_WIN $'\r'

# Wait ~10s for Claude to come up, then inject prompt instruction.
# EVERY cross-session message is prefixed [sender->recipient] (user, 2026-08-11) — several
# windows are live at once, and an unprefixed line says nothing about where it came from.
kitty @ send-text --match=id:$NEW_WIN '[notismain-><component>] use the receiving-prompts skill to execute the work in /home/mwaddip/projects/dagsocial/prompts/<name>.md'

# Delay, submit, and VERIFY (see the warning below). No approval gate — main
# dispatches autonomously (user, 2026-08-09). The verification below is NOT the
# gate and is not waived: it guards the swallowed-Enter trap, which is a
# mechanical failure, not an approval question.
sleep 1; kitty @ send-text --match=id:$NEW_WIN $'\r'
sleep 3; kitty @ get-text --match=id:$NEW_WIN | tail -5   # prompt line must be EMPTY
```

> ⚠ **A long `send-text` swallows the Enter, silently.** Anything long enough
> arrives as a **bracketed paste**, and a `\r` chained in the same command
> (`send-text '<long msg>' && send-text $'\r'`) lands *inside* the paste instead
> of submitting it. The window then sits at `❯ [Pasted text #1 +N lines]`
> forever while every `kitty @` call exits 0 — nothing reports failure. Measured
> 2026-08-08; it cost ~18 minutes of executor idle time before anyone looked.
> **Always put a delay between the text and the Enter, and always verify with
> `kitty @ get-text` that the prompt line came back empty.** "The command
> succeeded" is not evidence the message landed.
>
> `kitty @ get-text --match=id:N` is also the general way to see what a
> component window is actually doing. Note that `kitty @ ls` **tab** titles
> reflect the most recently active window in that tab — read the per-window
> `title` before concluding you dispatched to the wrong session.

4. **No dispatch gate** — main dispatches autonomously (user, 2026-08-09; previously waived
   per-session at Phase 1d, now standing). The post-submit `get-text` verification is separate
   and still required.
5. Component session reads contracts, implements, tests, reports back via kitty `send-text` to main window. **Component sessions commit their own work; they never push.** Main reviews, pushes, and opens the PR.
6. **The contract change rides the same branch as the code that implements it** (user, 2026-08-11).
   Not merged ahead of it — one PR shows the rule and its implementation together, so a reviewer can
   check they agree instead of taking it on trust. It also means the executor's tree already holds the
   contract they are building against.

### Prompt boilerplate

The session launches with its cwd inside the target package (step 3), so that package's `CLAUDE.md`
auto-loads and supplies the read-first list (OVERRIDES, RTK, root CLAUDE.md, ARCHITECTURE, the
interface contract). A dispatch prompt therefore doesn't repeat those reads — it opens with a
one-line reminder and the task:

```
Read ./CLAUDE.md and follow its read-first list before starting.

## <task title>
...

## Coordination
When done, send a brief completion summary back to the main session window. **Keep the
`[<component>->notismain]` prefix** — main has several windows reporting into it, and an
unprefixed line does not identify itself as a reply:
    kitty @ send-text --match=id:<MAIN_WINDOW_ID> '[<component>->notismain] one-line summary of what was done'
    kitty @ send-text --match=id:<MAIN_WINDOW_ID> $'\r'
```

### Main session vs component sessions

The main session owns contracts and prompts. It never edits component source code. Component sessions own one component each, read contracts, implement against them, and **commit** their own work. **Pushing is main's, always** — a component session that pushes has published work nobody reviewed.

## Comment style

**Cite the CONTRACT, not the spec.** `docs/specs/` is gitignored and holds **zero tracked files**, so
`(Phase 3b; spec §1.2)` in a committed comment points at a document nobody who clones this repo can
open, and a bare `Phase N` resolves to nothing anywhere. A comment either states the rule as it stands
now, or names the contract section that states it — `TYPES_INTERFACE → Layout — Stump`, never `Phase 2`.

**Cite a contract section by its PROSE NAME, never by a phase-tagged parenthetical.** Several headings
embed their own tags — `### Bond transition rules (P2-B phase 1)`, `### Per-block like settlement
(P2-D — replaced the epoch tally)`. The prose name is what a reader greps and what survives; the
parenthetical is the half the reconciliation will rewrite.

**Never narrate replaced code.** How a function used to behave is not a fact about the current tree.
No reader has to reason about code that is gone, and a narrated history is a second claim that decays
independently of the one beside it. This is the retroactive half of *comments point, don't narrate*.

⚠ **This binds code comments. `contracts/` is deliberately exempt for now** — it carries 8
`docs/specs/` citations and 110 lines with a `Phase N` tag, and some are load-bearing while the
contract-vs-code reconciliation is unwritten (user, 2026-08-11). **Do not sweep `contracts/` under
this rule.** The exemption ends with that reconciliation spec, not with this cleanup.

## Key invariants

- Post content: 1–300 UTF-8 bytes (`MAX_CONTENT_BYTES`)
- Parent refs: 0–1 per post (`MAX_PARENT_REFS`)
- Slot validity: measured in block height, not wall clock
- Signatures: raw Ed25519 (64 bytes), base64 on wire. Verified with `crypto.verify(null, ...)` using a KeyObject.
- Hashing: `blake2b512` with `.subarray(0, 32)` for all 32-byte outputs (Node.js v22 lacks blake2b256)
- Wire format: CBOR (`cbor-x`). HTTP API: JSON.
- Secret keys never in API responses or DTOs crossing component boundaries.
- Protocol version on every post and block (`PROTOCOL_VERSION = 1`).

## Protocol versioning

All posts and blocks carry a `protocolVersion` field. Validation rules are keyed to this version. Old posts are validated against their declared version forever. A node rejects posts with an unsupported version.

> ⚠ **NOT IMPLEMENTED — this describes the intended design, not the running code.**
> There is no version-keyed rule table. Validation is a **strict equality check against
> `PROTOCOL_VERSION`**, so nothing is "validated against its declared version forever" and
> the first version bump makes existing history un-resyncable. The design stands (it is
> stated on docs.notis.fun as how the protocol evolves) — the mechanism is Phase 2 work.
> **Do not write code or contract text that assumes version-keyed dispatch exists.**

## Platform constraint

Node.js v22 does not support `createHash('blake2b256')`. All hashing uses `createHash('blake2b512')` with `.subarray(0, 32)`. The demo UI uses `blakejs` from CDN (`blake2b(data, null, 64).slice(0, 32)`). These must produce identical output — both are standard BLAKE2b-512.
