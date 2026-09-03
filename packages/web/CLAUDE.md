# @dagsocial/web — Component Session Context

You are the **web component session** for **Notis** (repo dir `dagsocial`). This file is your standing
context — read it and the linked docs before touching code.

## Read first, in order
1. `~/projects/OVERRIDES.md` — mechanical overrides (root-cause only, forced verification, enumeration is a claim).
2. `~/.claude/RTK.md` — RTK proxy rules (`rtk proxy` for completeness-critical searches/diffs).
3. `../../CLAUDE.md` (repo root) — project overview + Design-by-Contract dispatch workflow.
4. `../../contracts/WEB_INTERFACE.md` — **this package's contract.**
5. `../../contracts/HOUSE_STYLE.md` — **the design contract, and it is binding.** Colour, type, motion,
   interaction, spacing, voice. Every rule in it carries its reason; read the reasons, because a rule
   whose justification has been stripped gets overridden by whoever finds it inconvenient.
6. `../../contracts/ARCHITECTURE.md` — architecture + invariants (skim; you touch no consensus code).
7. Your task's spec in `../../docs/specs/`.

⚠ **`contracts/SPECIAL.md` has no profile for this package.** Do not go looking for one and do not
infer weights from a neighbouring package's.

## What Notis is
An invite-only decentralized social network on a **dual-ledger** design: a **Posts DAG** and a **UTXO
ledger** (karma + credits); every post, like and prune is a transaction on the UTXO ledger, and a
pruned subtree leaves a **stump**. TypeScript, pnpm workspaces, Node ≥ 22.

## This package (`@dagsocial/web`)
The **browser client**. Built in slices: the **read surface** (the feed, threads, a tiling workspace of
columns and regions, both themes, the identity spine, a `@settings` window) and the **write surface's
first slice** — the identity machinery, the composer for a root and a reply, and like, on transactions
the browser builds and signs.

- **Owns:** `packages/web/*` — its own source, tests, build config and static assets.
- **Does NOT own:** any other package, `contracts/`, `prompts/`, or `packages/node/public/index.html`
  (the demo UI, which is a separate surface and stays exactly as it is).

## The boundary that defines this slice

⛔ **The read client (`src/api/client.ts`) issues `GET` requests and nothing else.** No `POST`, no
`DELETE`. The writes live next door in `src/api/write.ts` — `POST /posts` and `POST /likes`, and no
more. A `viewer` parameter is a query on a `GET`, so it stays in the read client.

**It hashes only through `@dagsocial/types`**, reached by the build-time shim — the wallet builders type
their box candidates and compute every id through the shared implementation, never a copy, which is why
no mirror test applies. **If you find yourself hand-writing an encoder or a hash, you have left the
slice — stop and report, do not implement it.**

**With no identity loaded the client is the read surface exactly** — no `new post`, no `↩ reply`, no
`like`, no `viewer` parameter, and `render-region.test.ts` stays green by node identity. **Once an
identity is loaded, every read carries `viewer=<pubKeyHex>`** and `likedByViewer` is the node's answer.

**The identity machinery ships; the identity interface does not.** A key is generated, imported,
exported and signed with — but nothing in the interface creates one. In a development build only, the
module hangs off `globalThis.notis.identity`; a production build exposes nothing. `sign(txIdHex)` is the
only path to the seed, and `current()` never returns it.

## Web-relevant invariants

**From `WEB_INTERFACE.md`:**
- **Same origin, always.** The node sends no CORS headers. Never hardcode an absolute API origin; the
  default is same-origin and a configured foreign origin will fail until the node gains CORS.
- **Paging is keyset.** `after=<key>` in, `next` out. **Follow `next`; never page on a count of rows
  you rendered** — rows get filtered out of a page and the count lies.
- **Withdrawn is never "deleted."** It keeps its identity and its replies hang off it. Hiding it inside
  a thread orphans them.
- **A stump and a tombstone reach the screen without ever being in the feed**, because an arrangement
  is persisted as post ids and a thread open last session may have been pruned since. Render it; it is
  not an error.

**From `HOUSE_STYLE.md` — the ones this surface will collide with:**
- **Nothing moves that the reader did not ask to move.** No polling, no live counts, no injected
  banner, no infinite scroll (it is a variable-ratio lever). **Refresh is a button and it reports what
  it did** — `4 new posts` or `no new posts`.
- **Numbers never animate.** **150ms ceiling, ease-out. `prefers-reduced-motion` means none, not less.**
- **A restored preference is painted, not transitioned.** Suppress transitions until after first paint,
  or a stored dark theme paints light and flips.
- **The control is the click target, never the container.** A post card is not a button. Text stays
  selectable and the pointer can be parked on it.
- **Hover may change appearance; it may never reveal content or move layout**, and it is suppressed
  while scrolling and for ~100ms after.
- **Every page reserves inert space** — ≥48px gutters each side on desktop, relaxed below the
  breakpoint. The empty space is a control surface, not waste.
- **4.5:1 for text against whichever of `ground`/`surface` is worse** — `ground` on Sand, `surface` on
  Bistre. **3:1 for a border only when it is a control's sole boundary.**
- **No red anywhere. Gold means credits and nothing else. Clay is warning and error.**
- **Self-hosted fonts, always.** Plus Jakarta Sans for anything a human reads, JetBrains Mono for
  machine data — hashes, keys, heights, amounts — and nothing else.
- **Say what happens, not what went wrong**, and never at the reader's expense.

**From `OVERRIDES.md`:**
- **No WASM.** Pure TS only.
- **Root-cause only.** No `setTimeout` to wait for readiness, no try/catch that swallows, no retry loop
  around something flaky. (The bounded landing poll is a designed interval, not a wait; and a `catch`
  that turns a transport failure into one of the flight's three endings surfaces it, it does not
  swallow it.)

## The write surface — the testnet dev loop and the identity file

**No local devnet for the write surface — it iterates against notis.fun testnet.** One variable points
the vite proxy there:

```bash
NOTIS_NODE=https://notis.fun/testnet/api pnpm --filter @dagsocial/web dev
```

The node and nginx send no CORS, so the proxy is the only route. `API_PATHS` in `vite.config.ts` proxies
`/posts`, `/status`, `/blocks`, `/karma`, `/credits`, `/likes`, `/vouches`, `/invites` — a path the
client calls that is not in the table returns the HTML shell, not the API.

**Every transaction spends real testnet karma:** a thread 5, a reply 3, a like 1. There is no automated
test that posts — an automated writer would drain the key and litter testnet; the wallet builders are
pinned offline against the demo UI's frozen vectors instead. Iterate deliberately.

**The pending ledger is per identity** — `notis.pending.<pubKeyHex>`. A change of identity takes effect
on the next reload, when a fresh App builds a ledger for the new key; a second key never sees the
first's predicted change.

⛔ **The reader's identity file — kept outside the repo — never enters the repo, a test, a commit, a
log or a report:** not the file, not its path in code, not any value from it. It is loaded through the
dev door in the browser console (`notis.identity.importJson(<text>)`) and nowhere else. It holds
`{ pubKeyHex, privKeyBase64 }` in the demo UI's export shape, so one key moves between the demo UI and
this client both ways.

## Component-session rules (Design by Contract)
- **Contracts lead, code follows.** Implement to `WEB_INTERFACE.md` and `HOUSE_STYLE.md`; **flag
  contract gaps to main rather than deciding them.**
- **You own this package only.** Never edit another package, and never `contracts/`.
- **Forced verification before "done":** `pnpm --filter @dagsocial/web typecheck` (zero errors) **and**
  `pnpm --filter @dagsocial/web test` (all pass). State the counts; never claim done unverified.
  ⚠ **`build` is not a typecheck** — vite erases types exactly as tsup does.
- **Phased execution:** verify between phases. **Report back** via kitty after each.

## Quick commands
```bash
pnpm --filter @dagsocial/web typecheck
pnpm --filter @dagsocial/web test
pnpm --filter @dagsocial/web dev        # vite dev server, proxying the API

# a live node with blocks to read, in one command (throwaway devnet, dies with the process):
pnpm -r build && node packages/node/scripts/dev.mjs --nodes 1 --miners 1
```

## The binding check — the only proof the crypto shim is wired

`@dagsocial/types` reaches the browser through a build-time `crypto` shim
(`WEB_INTERFACE → The browser reaches @dagsocial/types through a build-time shim`).
Under Node the real `crypto` is present and the substitution never happens, so
**no committed test proves the shim** — each would pass against a bundle where the
alias was never wired. Only the built bundle, run in a browser over live data,
does:

```bash
# against a local dev node (default http://localhost:3000):
node packages/web/scripts/binding-check/run.mjs
# or against a live network:
node packages/web/scripts/binding-check/run.mjs https://notis.fun/testnet/api
```

It builds the shim's path through the real alias + Buffer inject, evaluates the
bundle in headless Chromium (no Node `process`, `Buffer` or Web Crypto in the
page), and asserts each live post's recomputed `computeContentHash` equals the
`contentHash` the node served. Exit 0 = all matched. Needs a Chromium binary
(`CHROME=…`, else Playwright's cached one). Not in `pnpm test` by design — it
needs a browser and a node.

## Building for a deployment — two bases, and both are required

**They are different things and neither implies the other:**

- **`--base`** is where the client's *own* files live. It rewrites the asset URLs in `index.html`.
  Omitted, they are root-absolute (`/assets/…`, `/fonts/…`, `/favicon.svg`), which resolve only if the
  client is served from the site root.
- **`VITE_API_BASE`** is where the *node's API* lives, relative to the same origin. Omitted, it is
  empty, which is right for `pnpm dev` because the dev server proxies the bare API paths.

A client served from a subpath, reading an API mounted on a different subpath, needs both. Run vite
directly rather than through `pnpm --filter`, so no flag has to survive pnpm's argument passing:

```bash
cd packages/web && VITE_API_BASE=<api path> npx vite build --base=<client path>/
```

⚠ **Getting `--base` wrong yields a blank page, not an error.** The HTML loads, every asset 404s, and
nothing in the console names the cause. Check `dist/index.html` after building: every `href` and `src`
must begin with the client path.
