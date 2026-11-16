# EXTENSION_CHECK Interface Contract

> ⚠ **AHEAD OF CODE (2026-11-16).** No `check.mjs` exists; a check is a recipe kept outside the repo. Only `light`,
> `mesh` and `waiting` run alone (`--light`, `--mesh`, `--waiting-only`); one relays run carries `writes` through
> `waiting` in one browser, and every block of a check shares one stack. The harness's addresses are fixed ports in
> 19740–19863, Chromium's DevTools port drawn at random from 19200–19699. Each of the three runs takes its own extension
> build with its addresses baked in, the zips moved into the repo root. `figures` reads R's `$NOTIS` from `writes`'
> step 12, and `base` holds R2 and R3 for the light and mesh runs.

## Scope

**The extension check is the extension's proof in a browser.** `packages/web/scripts/extension-check/` drives the built
extension in headless Chromium over raw CDP, through the App's real UI, against devnet stacks it brings up, and reads
what each step's rule asks. This contract states the check as a tool: its blocks, the state and the stack each block
runs on, the addresses it owns, the builds it runs, and the one command that runs it. **What a step asserts is the rule
it cites** — `WEB_INTERFACE`, `MESH_INTERFACE`, `NODE_INTERFACE` — and the steps live in `run.mjs`.

**Devnet only, on the machine's loopback.** Every node, relay and page the check reaches is one it started.

## Blocks

**A block is a set of steps that runs alone.** Each starts from the `base` state (`TEST_STATE_INTERFACE → The base
state`) with steps 1 and 2 — the seed-list check and R's import — and owns everything after them. No block reads what
another block did, so a focused run is one block and a full run is every block.

| Block | Steps |
|---|---|
| `writes` | 1–12 |
| `links` | 13–16 and `13-uncancelled` |
| `tip` | 17a–20 |
| `figures` | 21–25 |
| `names` | 26–30 |
| `waiting` | W1–W5 |
| `light` | L1–L14 |
| `mesh` | M1–M5 |

**A block prepares what it reads beyond `base`, itself.** `figures` reads R holding `$NOTIS`: the block's own
preparation has the faucet grant R credits, landed before step 21. `writes` reads R holding none — steps 11 and 12 are
the faucet's step. A value a block reads comes from `base` or from its own preparation, never from another block's
step.

**A block waits for what it reads, never on the time steps before it took.** A node synced, a grant landed, a mesh
node standing at A's tip: each is a wait on that event, in the block.

**A run records every step by name.** A step outside the run's block reads `NOT RUN`, naming its block.

## The stack a block runs on

**Each block runs on a stack of its own**: `up base` into a run directory of the block's own, and `down` at its end
(`TEST_STATE_INTERFACE → Loading a state`). A block observes the chain it writes to — its feed, its landings, its
heights — and a node shared with another block would carry that block's writes and its mining to a height.

**The stack's miner is the block's chain clock**: its steady cadence, and the heights the harness asks it for
(`TEST_STATE_INTERFACE → Blocks during a run`). The nodes the harness spawns beside it — B, C, D, A′, B′, M5's node —
are the block's: started by the harness and stopped by the processes it launched.

**The state is made before any block loads it.** A check whose fingerprint has no `base` in the cache generates it
once, before the first `up`, so blocks never generate it side by side.

## Addresses

**Every address the check owns is bound by the operating system and read back**, never taken from a table: each
stack's ports (`up` with 0), each node the harness spawns (its `api_listening` event, its admin line, its
`[net] listening on:` line, a mesh node's identity line), each relay, the hosted page's server, and Chromium's DevTools
port (`--remote-debugging-port=0`, read from the profile's `DevToolsActivePort`). Blocks and checks run side by side,
and beside the mesh suite, with no port of one meeting another's.

**A node restarted behind the seed-list entry it answers for takes back the ports its first start was given** — the
entry names them: `mesh`'s A′ and B′ across M2–M4, whose WebRTC-direct address no relay can stand in front of. A port
another process took in between fails the restart, and the block names it. A node behind a relay — B behind RLB —
restarts on any port, the relay's upstream moved to it.

**One address is the build's: the hosted page's public origin.** The extension's background and bridge carry
`VITE_PUBLIC` as built, and the background reads a tab as a Notis link by that origin, its port included
(`WEB_INTERFACE → The extension → "Links into the extension"`). `links` serves the hosted page there. A block whose
steps read the hosted web build alone — 20, 25, 30, L14 — serves it on an address of its own.

## Builds

**A check builds once**: the workspace (`pnpm -r build`, for the node, the faucet and `tools/test-state` its stacks
run), one web build for the hosted page, and one extension build — `VITE_NETWORK=devnet`, its public origin the
check's. The extension's zips go to the check's own directory, never the repo root (`NOTIS_EXTENSION_OUT`,
`WEB_INTERFACE → The client is served from the node's own origin → "A zip holds one build"`).

**Each block writes its own values into its own copy of each build**, before Chromium loads it: the extension shell's
`notis-nodes` — the block's relays, or for `mesh` its nodes with their WebRTC-direct addresses — and `notis-faucet`,
the block's faucet; the web shell's `notis-api`, the block's A; and the unpacked manifest's `host_permissions`, the
loopback origins. These are deployment values the client reads at load (`WEB_INTERFACE → The client is served from
the node's own origin → "The deployment is six tags in the shell's head, and nothing in the bundle's bytes"`); no
script carries them, `VITE_PUBLIC` excepted (→ Addresses). **What the check does not see** is the build's `VITE_*`
values reaching the metas, which `build-extension.sh` and `build-release.sh` refuse a build without.

## The command

**One command runs a check**: `node packages/web/scripts/extension-check/check.mjs`.

| Option | What it does |
|---|---|
| `--blocks <name>,…` | the blocks to run, by the names above; every block when absent |
| `--serial` | one block at a time, in the table's order; side by side when absent |
| `--rev <rev>` | builds a detached worktree of `<rev>` inside the check's directory, removed at the end; the working tree when absent |
| `--out <dir>` | the check's directory — the builds, each block's run directory and log; a new directory under the system's temporary directory when absent |

**The harness runs one block per process** — `run.mjs --block <name>` — on the stack, the build copies and the
addresses it is handed or binds; the check starts one harness per block.

**It prints a line per block as the block ends** — its name, its steps passed, failed and not run, its wall — and the
summary last. Each block's log stamps every harness line as it arrives. **The exit code**: 0 when every step of every
block it ran passed, 1 when any failed, 2 when the check refused before a block ran.

**Whatever ends a check stops everything it started** — a pass, a failure, a refusal or a signal: each harness its
own nodes, relays and Chromium; each stack by `down`. Every process is stopped by the process the check or the harness
launched, never found by its name: this machine's testnet miner runs the same `miner.mjs`.

**The full run is the record**: every block, `mesh` included. A run of named blocks is for iterating.

## Does NOT own

- what a step asserts — the rule the step cites;
- the states, the stacks and their miner (`TEST_STATE_INTERFACE`);
- the build scripts' own checks (`build-extension.sh`, `build-release.sh`).
