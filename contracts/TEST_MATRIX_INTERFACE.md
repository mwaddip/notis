# TEST_MATRIX Interface Contract

> ⚠ **AHEAD OF CODE (2026-11-16).** Every section below leads `tools/test-matrix`, which is not in the tree yet. Three
> things are settled by the code and written here when the unit closes: the output's lines and its JSON fields, and
> any row the member's scan finds beyond → The rows' table.

## Scope

`@dagsocial/test-matrix` (`tools/test-matrix`) answers **which local runs a change warrants**: each workspace member's
typecheck and suite, node's slow tree, and the extension check. It reads a diff and the workspace, and prints each run
with the path and the rule that selected it. **It runs nothing.**

**It errs toward running more.** A path no rule places selects every run, and a rule leaves a run out only where what
the run reads has not changed.

**CI runs every run on every pull request**, whatever the matrix answers (`.github/workflows/ci.yml`). The matrix
answers for this side of a pull request: a gate while iterating, and the gate that closes a branch.

## Place in the workspace

**A member under `tools/`**, in `pnpm -r test` by the workspace glob. It declares no workspace dependency.

**It runs from its source, with no build**: `node tools/test-matrix/src/cli.ts`. A gate asks the matrix before it
builds anything, and a built copy older than its source would select by rows the tree no longer holds, with no sign.
Node strips the types; the source uses only erasable syntax. The member has no `build` script.

## What it reads

### The diff

| Option | The paths it reads |
|---|---|
| `--rev <rev>` | those changed between the merge base of the base and `<rev>`, and `<rev>` — what the commits carry |
| none | those changed between the merge base of the base and `HEAD`, and the working tree — committed, staged and unstaged — and every untracked file inside a member |
| `--base <rev>` | the base both forms diff from; `master` when absent |

**A rename counts both its paths; a deletion counts its path.** **An untracked file outside every member is named and
not counted**; committed, it is read under `--rev`.

### The workspace

**The members are the workspace's own**: every directory a glob of `pnpm-workspace.yaml` matches that holds a
`package.json`, read from the tree the diff ends at. A member added there is placed with no edit to the matrix.

**A member reads another when it declares it** — `dependencies`, `devDependencies` or `peerDependencies` naming the
other's `@dagsocial/*` name — **or when a row says so** (→ The rows).

## The runs

| Run | What runs |
|---|---|
| `<member>` | the member's `typecheck` and its `test`, by the member's name without `@dagsocial/` |
| `node:slow` | node's `test:slow` |
| `check` | the extension check, every block (`EXTENSION_CHECK_INTERFACE → The command`) |

**Every member is built before any run**, whatever the matrix answers: the mesh suite, test-state and the check run
built code (`ARCHITECTURE → Build and test resolution`). The matrix answers what runs after the builds.

**The check is selected whole or not at all.** Its blocks run side by side, so a check lasts as long as its slowest
block, and a block left out saves little, while iterating only: the full check is the record
(`EXTENSION_CHECK_INTERFACE → The command → "The full run is the record"`).

## How a path is placed

**Each changed path is placed by the first rule that matches it:**

1. **Every run** — `pnpm-lock.yaml`, `pnpm-workspace.yaml`, the root `package.json` (its overrides and patched
   dependencies reach every member's install), `tsconfig.base.json` (every member's configuration extends it),
   `vitest.shared.ts` (every member's suite merges it), and anything under `patches/` or `.github/`.
2. **No run** — anything under `contracts/` or `docs/`, a `*.md` file anywhere, and anything under the root
   `scripts/`, the packaging scripts no suite runs. The output names each such path.
3. **The check's harness** — a path under `packages/web/scripts/extension-check/` is placed by its rows alone
   (→ The rows).
4. **A member's test trees** — a path under a member's `test/`, `slow/`, `shadow/` or `bench/` selects that member's
   run alone, and a path under node's `slow/` selects `node:slow` beside it.
5. **Any other path inside a member** — the member is reached (→ Reach).
6. **Any other path** — every run.

**Every row that names a path adds its selection**, whichever rule placed the path: `contracts/CONSTANTS.md` is under
no run by rule 2 and selects node's run by its row.

**The matrix's own suite reads every member**: its scan reads each member's tracked files, and its cases each
member's `package.json` (→ Tests). So a path rule 3, 4 or 5 places also selects `test-matrix`.

### Reach

**A reached member selects its own run and reaches every member that reads it**, by a declaration or by a row read at
run time, until nothing new is reached. **Node reached selects `node:slow` as well**: the slow tree walks the header
pipeline and fork resolution, which read most of the node.

**The check is selected when a member it reads is reached** (→ The rows).

## The rows

**A row is an edge the declarations do not carry**, read off the tree: who reads what, and how. **A row is read at
run time, in a suite, or by no run:**

- **at run time** — the reader runs what it reads, so a change there reaches the reader;
- **in a suite** — a test reads it, so a change there selects the reader's own run and reaches nothing;
- **by no run** — a file names the path and no run the matrix answers reads it through that name: a file name a
  fixture writes into a directory of its own, a spawn line a test asserts on as text, a spawn in the mesh stage. It
  selects nothing; it is a row so that → Tests' scan passes the name. **Its reader is the file that holds the name**,
  and it covers that file's names alone — a name in another file of the same member is read by the scan anew.

| Reader | Reads | How | Read |
|---|---|---|---|
| `e2e` | node | spawns `packages/node/dist/index.js` for each node of its mesh | at run time |
| `test-state` | node, faucet | spawns `packages/node/dist/index.js` and `tools/faucet/dist/index.js` for a stack | at run time |
| `test-state` | wire, node-reads, avltree, nipopow, consensus | `up` fingerprints the `dist` of every member node and the faucet load | at run time |
| `test-state` | `packages/web/scripts/promote.mjs`, `packages/web/scripts/promote/` | runs `promote.mjs` in a generation — its suite's `up` of the minimal state among them — which bundles `promote/entry.ts` | at run time |
| `test-state` | e2e | `promote.mjs`'s bundle runs `tools/e2e/src/`'s identity and transaction builders | at run time |
| `test-state` | `packages/web/scripts/extension-check/claim-name.mjs` | `up` fingerprints its bytes; the state its suite generates makes no claim, so the suite never runs it | in a suite |
| `test-state` | nipopow-client | `test/dist-freshness.test.ts` holds the list e2e's runs check to nipopow-client's dependency closure, read from the `package.json` files | in a suite |
| `net` | `packages/web/scripts/refuse-node-builtins.mjs` | `test/browser-entry.test.ts` imports it | in a suite |
| `node` | `contracts/CONSTANTS.md` | `test/constants-register.test.ts` makes a case of each row | in a suite |
| `check` | node | spawns `packages/node/dist/index.js` beside each block's stack, and runs `packages/node/scripts/miner.mjs` | at run time |
| `check` | test-state | brings up each block's stack through its loader — node, faucet and miner | at run time |
| `check` | web | builds its hosted page and its extension | at run time |
| `check` | `packages/web/scripts/extension-check/` | its harness, and `claim-name.mjs`, which base's generation runs and which bundles web's `src/` when it runs | at run time |

**The check's harness is not web's code.** No file under web's `src/` or `test/` reads
`packages/web/scripts/extension-check/`, so a path under it selects what its rows name — the check, and test-state's
run for `claim-name.mjs` — and does not reach web.

## The output

**A line per selected run**, naming the first path that selected it and the rule; then each path placed under no run,
with its rule; then each member whose run is not selected. `--json` prints the same answer as one JSON object.

**`--members` prints the selected members' names on one line**, without `@dagsocial/`, in the workspace's build
order, for a gate script that takes member names. `node:slow` and `check` are not on it.

**The exit code**: 0 for an answer, 2 when the matrix refuses — a rev that does not resolve, or a tree with no
`pnpm-workspace.yaml` — naming why.

## Tests

**The member's suite holds the rows to the tree.**

- **Every cross-member reference is covered.** The suite scans every tracked file of every member but its own —
  comments and `*.md` files aside — for a reference into another member or to a path at the repo root, in the shapes
  the rows were found by: a literal path naming a member's directory or `contracts/`, bare or with a path after it,
  wherever it stands — after a relative climb (`../../../packages/web/…`, `../../../contracts/…`) or inside an
  absolute path included; a relative path climbing out of its member to a member by name (`../../net/…`); and a path
  joined from segments that names a member's directory. **Each file is read with its whitespace flattened**, so a
  path whose segments stand on separate lines is read whole. A reference that neither a declaration nor a row covers
  fails the suite, naming its file and line. A path built any other way is outside the scan. **A file a row reads at
  run time is read by that row's reader as well**: a reference in it is covered by its own member's declarations and
  rows or by the reader's — `promote/entry.ts`'s names under `tools/e2e/` are test-state's, the harness's names the
  check's. **The matrix's own
  files are not scanned**: the paths they name are its data, and its own reads are → How a path is placed's.
- **Every row's reader and what it reads exist** in the tree; a row naming a member or a path the tree lacks fails.
- **The check's harness stays unread by web**: a reference to `scripts/extension-check/` from a file under web's
  `src/` or `test/` fails.
- **Each rule is held by a case**: a diff for each rule of → How a path is placed, the order between them, each kind of
  row, reach through a row, and each of the three dependency fields. A case asserts the rule that placed each of its
  paths, not only the runs, so two rules that select the same runs are told apart.

## Does NOT own

- what a run checks — each member's suite, node's slow tree, the check (`EXTENSION_CHECK_INTERFACE`);
- the builds before the runs;
- the mesh stage (`tools/mesh-poc/stage/`), run by hand as root: its scenarios run node's built code and the mesh
  client, which nearly every change to the product reaches;
- CI, which runs every run.
