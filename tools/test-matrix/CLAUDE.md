# @dagsocial/test-matrix — Component Session Context

You are the **test-matrix component session** for **Notis** (repo dir `dagsocial`). This file is
your standing context — read it and the linked docs before touching code.

## Read first, in order
1. `../../contracts/TEST_MATRIX_INTERFACE.md` — **the contract this member implements.** Every
   section leads behaviour that lives in this directory.
2. `~/projects/OVERRIDES.md` — mechanical overrides (root-cause only, forced verification,
   truncation suspicion).
3. `~/.claude/RTK.md` — RTK proxy rules (`rtk proxy` for completeness-critical searches/diffs).
4. `../../CLAUDE.md` (repo root) — project overview + Design-by-Contract workflow.
5. `../../contracts/ARCHITECTURE.md → Build and test resolution` — rule 5, the per-member
   `tsconfig.test.json` wiring every member's suite extends.

## What Notis is
An invite-only decentralized notice board on a **dual-ledger** design: a **Posts DAG** and a **UTXO
ledger** (karma + credits); every post, like and withdrawal is a transaction on the UTXO ledger, and
withdrawal is the author's only act over a post. Consensus is PoW. TypeScript, pnpm workspaces,
Node ≥ 24.

## This member (`@dagsocial/test-matrix`)
`node tools/test-matrix/src/cli.ts` answers **which local runs a change warrants**: each workspace
member's typecheck and suite, node's slow tree, and the extension check. It reads the diff and the
workspace from the tree the diff ends at, places each changed path by the first rule that matches
it, and prints each selected run with the path and the rule that chose it. **It runs nothing**
(`TEST_MATRIX_INTERFACE → Scope`).

**It runs from its source, with no build**: a gate asks the matrix before it builds anything, and
a built copy older than its source would select by rows the tree lacks, with no sign
(`TEST_MATRIX_INTERFACE → Place in the workspace`). Node strips the types; the source uses only
erasable syntax, and relative imports name their `.ts` file.

- **Owns:** `src/*`, `test/*`.
- **Does NOT own** (`TEST_MATRIX_INTERFACE → Does NOT own`):
  - what a run checks — each member's suite, node's slow tree, the check
    (`EXTENSION_CHECK_INTERFACE`);
  - the builds before the runs;
  - CI, which runs every run on every pull request, whatever the matrix answers.

## The command

    node tools/test-matrix/src/cli.ts [--rev <rev>] [--base <rev>] [--members] [--json]

- `--rev <rev>` reads what the commits carry between the merge base of the base and `<rev>`
  (`TEST_MATRIX_INTERFACE → The diff`); without it the working tree is read — committed, staged
  and unstaged — beside every untracked, unignored file.
- `--base <rev>` names the base the diff reads from; `master` when absent.
- `--members` prints the selected members' names on one line, in the workspace's build order, for
  a gate script that takes member names (`TEST_MATRIX_INTERFACE → The output`).
- `--json` prints the same answer as one JSON object on one line.

The exit code is 0 for an answer, 2 for a refusal with one line on stderr naming why — an unknown
option, a `--rev` or `--base` that does not resolve, no merge base between them, or a tree with
no `pnpm-workspace.yaml`.

## How a row is added

**A row is an edge the declarations do not carry** — who reads what, and how
(`TEST_MATRIX_INTERFACE → The rows`). The suite's scan names an uncovered reference, naming its
file and line.

**Read the file at that line.** The kind of the new row is the use the file makes of the path:

- **`at run time`** when the reader runs what it reads — a change there reaches the reader;
- **`in a suite`** when a test reads it — a change there selects the reader's own run and
  reaches nothing;
- **`by no run`** when a file names the path and no run the matrix answers reads it through that
  name — a fixture name, a spawn line asserted on as text, a stage spawn. The row's reader is the
  file that holds the name.

**A row is never added to silence the scan without reading the file.** A reference the scan names
is either a real edge or prose; the kind decides which, and a wrong kind under-selects a run that
ought to fire.

**Each new row lands in `src/rows.ts` and is written into the contract by main** — the matrix's
own suite reads every member (`TEST_MATRIX_INTERFACE → Tests`), so a change to `src/rows.ts`
selects `test-matrix` through rule 5; a change to the contract selects nothing on its own.
