# TEST_STATE Interface Contract

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
`packages/node/dist/index.js`, `tools/faucet/dist/index.js`, its own `dist/cli.js` for the miner, and the web client's
write scripts `packages/web/scripts/promote.mjs` and `packages/web/scripts/extension-check/claim-name.mjs`. **It
refuses a missing or stale `dist`** of any member such a process loads, its own included
(`ARCHITECTURE → Build and test resolution`).

**It holds the one stale-build check and the one clock preload.** `tools/e2e` imports both from here by package name:
the refusal and the lists of members each spawned entry loads, and the preload its fork case stamps block 1 with. The
member's build emits declarations under its `exports` entry for that import. Those lists are also the fingerprint's
input (→ The fingerprint), so one list says both what a process loads and what a state depends on.

**Its reader is the extension check** (`packages/web/scripts/extension-check/`), which loads a stack of its own for
each block it runs (`EXTENSION_CHECK_INTERFACE → The stack a block runs on`), takes the stack `up` answers and asks its
miner for the heights its steps need (`--miner-control`). A person bringing up a devnet stack by hand reads it through
the same loader.

## A state

### What a state holds

**A state is a stopped devnet stack, copied at rest** — the files a stack needs to start again where it stopped:

| File | What it is |
|---|---|
| `dagsocial.db` | node A's store (`DB_PATH`), copied after A has exited on `SIGTERM`, with no `-wal` or `-shm` file beside it |
| `dagsocial.key` | the node key, `DB_PATH` with its extension replaced by `.key` (`NODE_INTERFACE → Configuration`, `NODE_KEY_PATH`) — what fixes A's `notisId` and peer id across loads |
| `dagsocial.mesh` | the mesh state, `DB_PATH` with its extension replaced by `.mesh`, where A has one (`MESH_INTERFACE → Transports → "The WebRTC-direct certificate persists"`) |
| `<label>.key` | each identity's key, `{ pubKeyHex, privKeyBase64 }`, mode 600 — the form the extension check's `--r-key` and `--s-key` read |
| `manifest.json` | → The manifest |

**A state holds no secret of a run.** Each load draws its own mining secret. The faucet's key is devnet's public pair,
which the loader writes into the run after checking that its public half is the devnet profile's `faucetPublicKey`.

### The manifest

**The manifest is what a reader needs without starting the stack.** `manifest.json` holds:

- `name` and `fingerprint`;
- `tip` — the chain's tip: `height`, `hash` and `createdAt`;
- `notisId` — the hex of the public key `@dagsocial/net`'s `loadNodeKey` reads from the state's node key
  (`NET_INTERFACE → The node key`) — and `peerId`, read from the node's `[net] listening on:` line;
- `identities` — for each, `label`, `pubKeyHex`, `memberSinceBlock` and `postIds`, the posts it wrote;
- `claim` — for the identity holding a name, `name`, `boxId` and `claimedAtBlock`; `null` in a state with none.

**Every figure is read from A's HTTP API**, at the tip the state stopped at and after the generator's last write
landed. The generator computes none of them.

### The base state

**`base` is the state the extension check starts from** — what the check's setup builds at every run without one:

- a chain of 60 blocks before the first write, past `m + k + 14`, the height the check's verified-tip block requires
  of A (`m`, `k` — `CONSTANTS → Client defaults`);
- two members, `R` and `S`, each made by `promote.mjs` on the earned path (`ARCHITECTURE → Membership`): two threads,
  the faucet's vouch, and its likes on both. Each promotion also writes one faucet root thread. Every block of the
  check loads its own copy, so each reads `R` as `base` holds it;
- `S`'s name, `Sk5send`, claimed by `claim-name.mjs`.

### The suite's state

**`minimal` is the member's own suite's state**: a chain of 5 blocks and one member, `R`, with no name. It carries
every manifest field `base` carries.

**A state is added when a test needs one.** The new state is built by the same generator on the same stack, under a
name of its own.

## The fingerprint

**A state is used only under the build that made it.** The fingerprint is a 32-byte BLAKE2b digest
(`createHash('blake2b512')`, the first 32 bytes) over a fixed order of inputs, each one's repo-relative path and then
its bytes, each length-prefixed:

1. the runtime `.js` and `.mjs` files of `dist/` of every member on the lists the stale-build check reads for the node
   and the faucet — the node, each workspace member it loads, the faucet, and each member the faucet loads. The devnet
   profile and its genesis are inside `types`;
2. this member's own source, the preload included, and the scripts the generator runs — `promote.mjs` and
   `claim-name.mjs` — without the client code those scripts bundle;
3. `pnpm-lock.yaml`.

**The inputs are built bytes, and they are the node's whole runtime, not only the packages that compute state.** The
store has no schema version, and what the node writes beside consensus's effects (its tables, its journal and their
indexes) is node code. A fingerprint over a narrower set would let a build load a store it would not have written,
and nothing would say so. The cost is one generation per build of the node's runtime, shared by every worktree on
that build.

**Client code is not an input** — the web client's source, and the transaction builders a write script bundles. A
state holds what the node accepted, and a node on the same build reads it the same whichever client built the writes.
The scripts are inputs because they decide what a state holds: which identities, which posts, which name.

**Equal builds give equal fingerprints.** Two worktrees at one rev compute the same fingerprint: no input carries a
worktree path, a time or a host name, and the inputs are read in lexicographic order by path, whatever order the
file system lists them in.

**A stale state is never loaded.** A load whose fingerprint has no state in the cache generates one.

## The cache

**`$XDG_CACHE_HOME/dagsocial/test-state/`**, or `~/.cache/dagsocial/test-state/` where the variable is unset — a
per-user directory outside git and outside every worktree, so every worktree on one build shares its states: one
directory per fingerprint, and one state per name inside it. A caller may name another directory (`--cache`).

**A state appears whole or not at all.** The generator writes into a temporary directory beside the cache's and then
renames it into place. A second generator that loses the rename discards its own copy and reads the winner's; any
other failure of the rename is an error. A directory under a state's name whose manifest does not parse, or names
another fingerprint or another state, is no state.

**Nothing runs on the cache.** A load copies the state into the run's directory before starting anything. The tool
removes nothing from the cache by itself.

## Generation

**The generator is the check's setup, run once.** On a fresh store in a work directory of its own, it:

1. starts A with `NETWORK_TYPE=devnet`, `NODE_ROLE=miner` and no bootstrap peer, so the template is not held back for
   peers (`MINING_INTERFACE → The peer-readiness gate`);
2. starts the faucet against A, then the miner (→ Blocks during a run) at an interval of its own — 1.5 s, and 0.5 s
   when a load generates the state;
3. mines to the state's starting height;
4. runs the state's write scripts in order;
5. moves the faucet's credits into one box (→ "The faucet's credits stand in one box made by the state's last write");
6. reads the manifest's figures from A;
7. stops the miner, the faucet and A by the processes it launched — A on `SIGTERM`, waited for until it exits;
8. writes the state into the cache.

**The faucet's credits stand in one box made by the state's last write.** That write is one faucet grant
(`/faucet/credits`) to a throwaway key no block reads, waited for until it lands, so the faucet's one box is the grant's
change, made a block or a few below the state's tip. Devnet's rent (`NODE_INTERFACE → Storage rent is a transition
requiring no signature`) reaches that box `storageRentPeriodBlocks` after it is made — past every height a block of the
check asks the faucet at, since each block starts from the state's tip. A grant pooled after the template that collects
its box is lost to that block (`NODE_INTERFACE → "This node's producer collects at its template, from the boxes no
pooled transaction spends"`), so a faucet box falling due inside a block would drop that block's grant. **The
generator reads the faucet's holdings with the manifest's figures and fails the generation unless they are that one
box.**

> ⚠ **AHEAD OF CODE (2026-11-27).** The generator runs no grant: a state's faucet holds devnet's genesis credit box,
> made at block 1 and falling due at block 102 — inside a block of the check when the state's tip is near 88.

**A write path that fails fails the generation**, naming the script and its last line. Nothing retries it. Every wait
a write script holds ends a block interval or two after its write lands, so a script that times out is a failure of
that path or of the stack, and a retry would hide which one. **So does a store left unfinished**: a missing store or
node key, or a `-wal` or `-shm` file beside the store after A's clean exit, fails the generation, naming the file.

**A failed generation keeps its work directory and names it** — A's log, the pool and the scripts' logs are there to
read. A successful one removes it.

**The generator runs on real time.** Its chain's stamps are the moments it ran, and → The clock offset places a load
after them.

## Loading a state

**`up` brings up a stack on a copy of a state, and returns with the stack running.** Given the state's name, a run
directory and the ports, it:

1. refuses a run directory that exists and is not empty;
2. computes the fingerprint, and generates the state if the cache has none under it;
3. copies the state into the run directory;
4. computes the run's clock offset;
5. starts A on the copy, then the faucet, then the miner (its own `cli.js miner` process), each detached, with its
   output on a log file in the run directory, and each recorded in the run directory's `processes.log` — pid and full
   argv — as it starts;
6. reads each process's readiness from its log: A's `api_listening` event, its admin listener's line
   (`NODE_INTERFACE → Admin Listener`) and its `[net] listening on:` line; the faucet's `faucet listening on` line;
   the miner's `miner_ready` line. A process that exits before its line fails `up`, naming its exit and its log;
7. refuses a node whose `/status` names another network;
8. prints what a caller reads (→ What a caller reads) and exits.

**A port given as 0 is bound by the process and read back from its line.** The faucet refuses a zero port by its own
configuration rule, so for a faucet port of 0 `up` asks the system for a free one and passes it.

**An `up` that fails partway stops every process it started** before it reports the failure.

**`down` stops exactly the processes `up` started**, read from `processes.log` by any process: the miner, then the
faucet, then A, each signalled only while `/proc/<pid>/cmdline` still reads its recorded argv — `SIGTERM`, then
`SIGKILL` after 10 s. It never acts on a process found by its name; the laptop's testnet miner runs the same
`miner.mjs`.

**A run directory belongs to one run.** The copy is written into it once and the stack runs on it. A second run on
the same state takes a directory of its own.

## The clock offset

**Every node-side process of a run reads one shifted clock.** The offset is the state's tip `createdAt`, plus 1 000
ms, minus the real time at the load. `up` computes it once and gives it to A, the faucet, the miner and every node the
caller spawns for the run. Each process takes it through the preload, loaded with `--import` in `NODE_OPTIONS`, and
the offset in `DAGSOCIAL_CLOCK_OFFSET_MS`.

**Why a run reads a shifted clock.** The difficulty schedule reads the chain's stamps against its height
(`MINING_INTERFACE → Difficulty Schedule`). A chain that has paused since its state was made therefore eases toward
the floor by the length of the pause. Under the offset, a load on any day resumes the chain one second after its tip,
and the schedule, and the proofs it shapes, read as they did when the state was made.

**The offset keeps every rule a stamp meets.**

- **Order:** the next stamp is `max(now, createdAt(tip) + 1)` (`MINING_INTERFACE → Header timestamp rules →
  "Producer side"`), and the shifted `now` starts after the tip.
- **Future bound:** a state more than a second old puts the shifted clock behind real time, so every stamp the run
  makes is in the past for a reader on real time, the browser included. A state loaded within a second of its tip
  puts it less than a second ahead, inside the bound's ten minutes (`MINING_INTERFACE → Header timestamp rules`).
  Readers on the same offset share the clock.

**Chromium runs on real time.** The web client compares a chain stamp with its own clock only for the future bound.
It judges the status corner by local times alone (`WEB_INTERFACE → The status corner`).

**The preload shifts `Date.now()`.** Every read the processes make through it, libp2p's included, sees the same
offset, so an interval measured inside one process is unmoved. Monotonic reads (`performance.now()`,
`process.hrtime`) measure intervals and are not shifted. The node's journal lines stamp `new Date()`, which stays on
real time; nothing compares a journal stamp with a chain stamp.

## Blocks during a run

**One miner per stack, started by the loader.** It mines A through `GET /mining/template` and `POST /mining/submit`
(`MINING_INTERFACE → Mining API`), under the run's mining secret, every call to A under a 10 s deadline. It names no
payout key, so every block pays A's own key, as a template does without `?miner=`
(`MINING_INTERFACE → GET /mining/template`). It makes blocks in two ways:

1. **The steady cadence.** It mines one block every interval: 6 s by default, the caller's to set, each block mined
   when its interval comes and never in bursts. The cadence is what a run needs:
   - **Decay on devnet counts blocks** (`karmaDecayIntervalBlocks` 3, `karmaStaleThresholdBlocks` 500), so the
     interval sets how fast a run's identities age, and 6 s is the rate the check's steps are written against.
   - **A write waits at most one interval to land.**
   - **The chain rises while nothing writes.** The status corner reads `fresh` only after a rise within ten minutes
     (`WEB_INTERFACE → The status corner`), and the check's steps that observe a moving chain — 17b, 28b's stale
     anchor, M5 — read a chain that keeps moving.
2. **Mining to a height.** A caller asks for a height: `POST /mine-to` with `{ "height": <n> }` on the miner's
   loopback control. The miner mines block after block toward the highest height any caller has asked, answers each
   request with `{ "height": <reached> }` once A's tip reaches its own height, and goes back to the cadence one
   interval after the last answer. A step that needs a height asks for it rather than waiting for the cadence to reach
   it.

**One loop serves both**, so the two never mine the same height at once. The generator runs the same loop inside its
own process, at an interval of its own.

**The control refuses what it cannot serve.** A height that is not a safe integer ≥ 1, or a body that is not JSON,
answers 400. A miner whose node refused a template or a submission, or did not answer a call within its deadline,
stops, naming the call and the answer, and answers every request still waiting 500 with that reason. A stop on
`SIGTERM` ends the miner with exit 0.

**The miner does not mine on a write's arrival.** The next block follows at most one interval later.

## What a caller reads

**`up` prints one JSON object on stdout**, and nothing else:

- `name`, `fingerprint` and `runDir`;
- `clockOffsetMs` and `preloadPath`, for the processes the caller spawns;
- `nodeHttp` and `nodeAdmin`, A's HTTP and admin origins; `nodeP2p`, its p2p multiaddr with `/p2p/<peerId>`;
  `notisId` and `peerId`;
- `faucetOrigin`, the faucet's origin — its routes sit under `/faucet`;
- `minerControlOrigin`, the miner control's origin;
- `identities` — for each, `label`, `keyFilePath`, `pubKeyHex`, `memberSinceBlock` and `postIds`;
- `tip`, the state's tip as the manifest holds it.

## The command line

`dist/cli.js`, run from the member's built `dist/`:

| Command | What it does |
|---|---|
| `fingerprint [--list] [<repo root>]` | prints the fingerprint, or its inputs' paths in the order the digest reads them |
| `generate <state> [--cache <dir>]` | generates a state into the cache |
| `up <state> --dir <run dir> --http-port <n> --admin-port <n> --p2p-port <n> --faucet-port <n> --miner-port <n> [--interval-ms <n>] [--cache <dir>]` | → Loading a state |
| `down --dir <run dir>` | stops the processes `up` recorded in that run directory |
| `miner --node-api <origin> --mining-secret-path <path> [--interval-ms <n>] [--control-port <n>]` | the run's miner; prints `{ "event": "miner_ready", "controlPort": <port> }` once its control listens |

## Tests

- **The fingerprint**: equal for two worktrees at one rev; different when any one input's byte changes; unmoved by a
  change to a path that is not an input (the web client's source, `contracts/`, `tools/e2e/src`).
- **A load**: a state generated and then loaded, a write landing within one interval, a height asked for reached, two
  loads side by side each answering its own tip, and `down` from another process leaving no process `up` started.
- **The refusals**: a node that is not devnet, a missing or stale `dist`, a non-empty run directory, a control request
  it cannot serve.

## Does NOT own

- the extension check's steps and relays (`packages/web/scripts/extension-check/`);
- the write paths it drives (`promote.mjs` and `claim-name.mjs`, which are web's);
- the mesh suite's meshes, which `tools/e2e` brings up from genesis per file;
- any protocol rule.
