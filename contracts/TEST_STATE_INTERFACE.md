# TEST_STATE Interface Contract

> ⚠ **AHEAD OF CODE (2026-11-16).** Every section below leads `tools/test-state`, which is not in the tree yet. →
> Place in the workspace also leads the move of `tools/e2e`'s clock preload and stale-build check into this member,
> and → Blocks during a run leads the extension check asking for its heights
> (`packages/web/scripts/extension-check/run.mjs`). Three things are settled by the code and written here when the
> unit closes: the cache's path, the names of the manifest's and `up`'s fields, and the miner control's routes.

## Scope

`@dagsocial/test-state` (`tools/test-state`) holds prepared devnet state for checks that need members, a name and
posts before their first step. **A state is made once and loaded in seconds.** A generator builds it on a fresh
devnet stack through the product's own write paths. A per-user cache keeps it under the fingerprint of the build that
made it. A loader brings up a stack on a copy of it: the node, the faucet and a miner, on one clock offset.

**It is a client of the contracts with no protocol of its own.** It reaches a node through its HTTP API, its
configuration and its files at rest. Every transaction in a state was built and submitted by a write path the product
ships, so a state holds nothing a devnet stack could not hold.

**Devnet only.** The generator and the loader refuse a node whose `/status` names another network. A state carries
devnet's public faucet key and throwaway identities, which are secret nowhere.

## Place in the workspace

**A member under `tools/`**, in `pnpm -r test` by the workspace glob. The processes it spawns run built code:
`packages/node/dist/index.js`, `tools/faucet/dist/index.js`, and the web client's write scripts
`packages/web/scripts/promote.mjs` and `packages/web/scripts/extension-check/claim-name.mjs`. **It refuses a missing or
stale `dist`** of any member such a process loads (`ARCHITECTURE → Build and test resolution`).

**It holds the one stale-build check and the one clock preload.** `tools/e2e` imports both from here: the refusal
and the lists of members each spawned entry loads, and the preload its fork case stamps block 1 with. Those lists are
also the fingerprint's input (→ The fingerprint), so one list says both what a process loads and what a state depends
on.

**Its reader is the extension check** (`packages/web/scripts/extension-check/`). A person bringing up a devnet stack
by hand reads it through the same loader.

## A state

### What a state holds

**A state is a stopped devnet stack, copied at rest** — the files a stack needs to start again where it stopped:

| File | What it is |
|---|---|
| the store | node A's `DB_PATH`, copied after A has exited on `SIGTERM`, with no `-wal` or `-shm` file beside it |
| the node key | `DB_PATH` with its extension replaced by `.key` (`NODE_INTERFACE → Configuration`, `NODE_KEY_PATH`) — what fixes A's `notisId` and peer id across loads |
| the mesh state | `DB_PATH` with its extension replaced by `.mesh`, where A has one (`MESH_INTERFACE → Transports → "The WebRTC-direct certificate persists"`) |
| the miner key | the key A's blocks pay, in the key file's form (`MINING_INTERFACE → Consolidation`) |
| each identity's key | `{ pubKeyHex, privKeyBase64 }`, mode 600 — the form the extension check's `--r-key` and `--s-key` read |
| the manifest | → The manifest |

**A state holds no secret of a run.** Each load draws its own mining secret. The faucet's key is devnet's public pair,
which the loader writes into the run.

### The manifest

**The manifest is what a reader needs without starting the stack.** It holds:

- the state's name and its fingerprint;
- the chain: its tip's height, hash and `createdAt`;
- A's `notisId` and peer id;
- for each identity, its label and public key, `memberSinceBlock`, and the ids of the posts it wrote;
- for an identity holding a name, the name, its box id and the height it was claimed at.

**Every figure is read from A's HTTP API**, at the tip the state stopped at and after the generator's last write
landed. The generator computes none of them.

### The base state

**`base` is the state the extension check starts from** — what the check's setup builds at every run without one:

- a chain of 60 blocks before the first write, past `m + k + 14`, the height the check's verified-tip block requires
  of A (`m`, `k` — `CONSTANTS → Client defaults`);
- four members, `R`, `S`, `R2` and `R3`, each made by `promote.mjs` on the earned path (`ARCHITECTURE → Membership`):
  two threads, the faucet's vouch, and its likes on both. Each promotion also writes one faucet root thread;
- `S`'s name, claimed by `claim-name.mjs`.

**A state is added when a test needs one.** The new state is built by the same generator on the same stack, under a
name of its own.

## The fingerprint

**A state is used only under the build that made it.** The fingerprint is a 32-byte BLAKE2b digest
(`createHash('blake2b512')`, the first 32 bytes) over a fixed order of inputs, each one's repo-relative path and then
its bytes:

1. the runtime `.js` files of `dist/` of every member on the lists the stale-build check reads for the node and the
   faucet — the node, each workspace member it loads, the faucet, and each member the faucet loads. The devnet profile
   and its genesis are inside `types`;
2. this member's own source, the preload included, and `promote.mjs` and `claim-name.mjs`;
3. `pnpm-lock.yaml`.

**The inputs are built bytes, and they are the node's whole runtime, not only the packages that compute state.** The
store has no schema version, and what the node writes beside consensus's effects (its tables, its journal and their
indexes) is node code. A fingerprint over a narrower set would let a build load a store it would not have written,
and nothing would say so. The cost is one generation per build of the node's runtime, shared by every worktree on
that build.

**The web client's source is not an input.** A state holds what the node accepted, and a node on the same build reads
it the same whichever client built the writes.

**Equal builds give equal fingerprints.** Two worktrees at one rev compute the same fingerprint: no input carries a
worktree path, a time or a host name.

**A stale state is never loaded.** A load whose fingerprint has no state in the cache generates one.

## The cache

**A per-user directory outside git and outside every worktree**, so every worktree on one build shares its states:
one directory per fingerprint, and one state per name inside it.

**A state appears whole or not at all.** The generator writes into a temporary directory beside the cache's and then
renames it into place. A second generator that loses the rename discards its own copy.

**Nothing runs on the cache.** A load copies the state into the run's directory before starting anything. The tool
removes nothing from the cache by itself.

## Generation

**The generator is the check's setup, run once.** On a fresh store in a scratch directory, it:

1. starts A with `NETWORK_TYPE=devnet`, `NODE_ROLE=miner` and no bootstrap peer, so the template is not held back for
   peers (`MINING_INTERFACE → The peer-readiness gate`);
2. starts the faucet against A, then the miner (→ Blocks during a run);
3. mines to the state's starting height;
4. runs the state's write scripts in order;
5. reads the manifest's figures from A;
6. stops the miner, the faucet and A by the pids it launched — A on `SIGTERM`, waited for until it exits;
7. writes the state into the cache.

**A write path that fails fails the generation**, naming the script and its last line. Nothing retries it. Every wait
a write script holds ends a block interval or two after its write lands, so a script that times out is a failure of
that path or of the stack, and a retry would hide which one.

**The generator runs on real time.** Its chain's stamps are the moments it ran, and → The clock offset places a load
after them.

## Loading a state

**`up` brings up a stack on a copy of a state.** Given the state's name, a run directory and the ports, it:

1. computes the fingerprint, and generates the state if the cache has none under it;
2. copies the state into the run directory;
3. computes the run's clock offset;
4. starts A on the copy, then the faucet, then the miner;
5. waits for A's `/status`;
6. prints what a caller reads (→ What a caller reads).

**`down` stops exactly the processes `up` started**, recorded by pid in the run directory: the miner, then the
faucet, then A. It never acts on a process found by its name; the laptop's testnet miner runs the same `miner.mjs`.

**A run directory belongs to one run.** The copy is written into it once and the stack runs on it. A second run on
the same state takes a directory of its own.

## The clock offset

**Every node-side process of a run reads one shifted clock.** The offset is the state's tip `createdAt`, plus 1 000
ms, minus the real time at the load. `up` computes it once and gives it to A, the faucet, the miner and every node the
caller spawns for the run. Each process takes it through the preload, loaded with `--import`.

**Why a run reads a shifted clock.** The difficulty schedule reads the chain's stamps against its height
(`MINING_INTERFACE → Difficulty Schedule`). A chain that has paused since its state was made therefore eases toward
the floor by the length of the pause. Under the offset, a load on any day resumes the chain one second after its tip,
and the schedule, and the proofs it shapes, read as they did when the state was made.

**The offset keeps every rule a stamp meets.**

- **Order:** the next stamp is `max(now, createdAt(tip) + 1)` (`MINING_INTERFACE → Header timestamp rules →
  "Producer side"`), and the shifted `now` starts after the tip.
- **Future bound:** a shifted clock is behind real time, so every stamp the run makes is in the past for every reader
  on real time, the browser included, and for every reader on the same offset.

**Chromium runs on real time.** The web client compares a chain stamp with its own clock only for the future bound,
which a past stamp passes. It judges the status corner by local times alone (`WEB_INTERFACE → The status corner`).

**The preload shifts `Date.now()`.** Every read the processes make through it, libp2p's included, sees the same
offset, so an interval measured inside one process is unmoved.

## Blocks during a run

**One miner per stack, started by the loader.** It mines A through `GET /mining/template` and `POST /mining/submit`
(`MINING_INTERFACE → Mining API`), under the run's mining secret, paying the state's miner key. It makes blocks in two
ways:

1. **The steady cadence.** It mines one block every interval: 6 s by default, the caller's to set, each block mined
   when its interval comes and never in bursts. The cadence is what a run needs:
   - **Decay on devnet counts blocks** (`karmaDecayIntervalBlocks` 3, `karmaStaleThresholdBlocks` 500), so the
     interval sets how fast a run's identities age, and 6 s is the rate the check's steps are written against.
   - **A write waits at most one interval to land.**
   - **The chain rises while nothing writes.** The status corner reads `fresh` only after a rise within ten minutes
     (`WEB_INTERFACE → The status corner`), and the check's steps that observe a moving chain — 17b, 22's stale
     anchor, M5 — read a chain that keeps moving.
2. **Mining to a height.** A caller asks for a height. The miner mines block after block until A's tip reaches it,
   answers with the height reached, and goes back to the cadence. A step that needs a height asks for it rather than
   waiting for the cadence to reach it.

**One loop serves both**, so the two never mine the same height at once. The generator runs the same miner, at an
interval of its own.

**The miner does not mine on a write's arrival.** The next block follows at most one interval later.

## What a caller reads

**`up` prints one JSON object on stdout**:

- the state's name and fingerprint, and the run directory;
- the clock offset in milliseconds and the preload's path, for the processes the caller spawns;
- A's HTTP and admin origins, its p2p multiaddr, its `notisId` and its peer id;
- the faucet's origin;
- the miner control's origin and the miner's public key;
- for each identity, its label, its key file's path and the manifest's figures;
- the tip.

## Tests

- **The fingerprint**: equal for two worktrees at one rev; different when any one input's byte changes; unmoved by a
  change to a path that is not an input (the web client's source, `contracts/`).
- **A load**: a state generated and then loaded, a write landing within one interval, a height asked for reached, and
  `down` leaving no process it started.
- **The refusals**: a node that is not devnet, and a missing or stale `dist`.

## Does NOT own

- the extension check's steps and relays (`packages/web/scripts/extension-check/`);
- the write paths it drives (`promote.mjs` and `claim-name.mjs`, which are web's);
- the mesh suite's meshes, which `tools/e2e` brings up from genesis per file;
- any protocol rule.
