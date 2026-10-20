# @dagsocial/node-reads — Component Session Context

You are the **node-reads component session** for **Notis** (repo dir `dagsocial`). This file is your standing
context — read it and the linked docs before touching code.

## Read first, in order
1. `~/projects/OVERRIDES.md` — mechanical overrides (root-cause only, forced verification, truncation suspicion,
   enumeration is a claim).
2. `~/.claude/RTK.md` — RTK proxy rules (`rtk proxy` for completeness-critical searches/diffs).
3. `../../CLAUDE.md` (repo root) — project overview + Design-by-Contract dispatch workflow.
4. `../../contracts/WEB_INTERFACE.md → Reading a node's answer` — **the rules this package holds**: every answer
   rebuilt from its own fields or refused, the page rule, the whole-list read and its bound, every answer under its
   route's cap, one request deadline.
5. `../../contracts/CONSTANTS.md → Client reads` — every cap, the deadline and `LEDGER_READ_MAX`, each with the
   argument that sets it, and how the suites pin them.
6. `../../contracts/NODE_INTERFACE.md → HTTP API` — the routes whose answers it reads, `"Every list a view returns is a
   page"` and `"Hex is lowercase"` among them; `../../contracts/TYPES_INTERFACE.md → Box value domain`, `→ Content
   limits`, `→ HTTP view bounds`.

⛔ **There is no `NODE_READS_INTERFACE.md`, and its absence is the point** — as with `@dagsocial/nipopow-client`. This
package is the client side of the node's HTTP API; the rules it implements are stated where reading that API is
stated. **If the node answers what its contract says it does not, that is a FINDING to report to main — never a
tolerance written in here.**

## What Notis is
An invite-only decentralized social network on a **dual-ledger** design: a **Posts DAG** and a **UTXO ledger** (karma
+ credits); every post, like and withdrawal is a transaction on the UTXO ledger. TypeScript, pnpm workspaces,
Node ≥ 22.

## This package (`@dagsocial/node-reads`)
**What every client of the node's HTTP API reads through** — the web client in both its builds and the light client
(`@dagsocial/nipopow-client`), one implementation of each rule:

- **The capped reader** (`src/http.ts`): `fetchJson(fetch, url, cap)` asks under `REQUEST_TIMEOUT_MS`, and
  `readCappedJson(res, cap)` reads a body as a stream, cancels it once more than the cap has arrived and answers as a
  body that will not parse does; a transport failure, a timeout, a body cut off, an unparseable body and a non-2xx are
  each a non-ok `NodeResult`, never a throw. `capped` is how a node's string is shown to a person — every C0 control,
  DEL and C1 control as its `\u` escape, cut at 120 characters with `…`, never inside a surrogate pair or an escape —
  and the reader applies it to an unparseable body. `isRecord` is the one object check.
- **The caps** (`src/caps.ts`): each route's byte cap and `LEDGER_READ_MAX`, the values `CONSTANTS → Client reads`
  argues. The NiPoPoW proof route's cap is the light client's, computed from the `m` and `k` it asks.
- **The field checks** (`src/fields.ts`): total predicates for an answer's fields — 64 lowercase hex, a non-negative
  safe integer and the same or `null`, a box value (a canonical decimal below `2⁶³`), a sum (a canonical decimal), a
  name (`null` or what `isValidUsernameBytes` accepts).
- **The page rule and the whole-list read** (`src/pages.ts`): `parsePage` holds a parsed body to the page the node
  serves — an object whose list is an array of at most the `limit` asked, whose `next` is `null` or a non-empty string
  with no lone surrogate, and which carries exactly the `limit` asked when it names a `next`; `wholeListRead` follows
  `next` over a `fetchPage` seam, refuses a cursor or a row key named twice, fails past its bound, never throws on the
  node's answer and lets a throw from `fetchPage` pass, the node's text in its refusals through `capped`.
  `KARMA_LISTING_MAX` (2) is the one place a client holds the protocol's two-box karma maximum.

**It runs in the browser as written**: no Node built-in import, no Node global — held by the browser pass of
`typecheck` (`tsconfig.browser.json`, `ARCHITECTURE → Package boundaries`). **No route path string in its source** —
the web build's `scripts/build-release.sh` refuses a bundle carrying `nipopow/proof`, `api/v1/proof`, `api/v1/range`
or `posts/batch`, and this package is in the web bundle. **It depends on `@dagsocial/types` alone.**

- **Owns:** `src/*`, `test/*`, this package's `package.json` and configs.
- **Does NOT own:** what a client does with an answer — the web's readers of each route and its App, the light
  client's verifiers and verdicts — and anything in `contracts/`.

## Component-session rules (Design by Contract)
- **Contracts lead, code follows.** Implement against `WEB_INTERFACE → Reading a node's answer` and
  `CONSTANTS → Client reads`; flag a gap to main.
- **You own this package only.** Never edit another package or `contracts/`.
- **Forced verification before "done":** `pnpm --filter @dagsocial/node-reads build`,
  `pnpm --filter @dagsocial/node-reads typecheck` (three passes — src, the test tree, the browser) and
  `pnpm --filter @dagsocial/node-reads test`, all clean, the counts stated. Its clients — `nipopow-client` and `web` —
  are main's to gate.
- ⛔ **`pnpm --filter`, never `pnpm -r`** — the tree is shared.

## Quick commands
```bash
pnpm --filter @dagsocial/node-reads build
pnpm --filter @dagsocial/node-reads typecheck
pnpm --filter @dagsocial/node-reads test
```
