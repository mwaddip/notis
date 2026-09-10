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
ledger** (karma + credits); every post, like and withdrawal is a transaction on the UTXO ledger, and
withdrawal is the author's only act over a post. TypeScript, pnpm workspaces, Node ≥ 22.

## This package (`@dagsocial/web`)
The **browser client**. Built in slices: the **read surface** (the feed, threads, a tiling workspace of
columns, both themes, the identity spine), the **write surface's first slice** — the identity
machinery, the composer for a root and a reply, and like, on transactions the browser builds and signs —
the **identity interface's first unit**: the `@profile` window (identity, standing, karma, the
faucet step, the preferences), create / import / export / forget / lock / unlock as forms in place, the
identity encrypted at rest, the reader's own cards marked `· you` — and the **membership actions**: the
identity display standard (the prefix, `· you`) wherever an identity renders, the `@author:<key>` and
`@posts:<key>` windows, vouch and unvouch from the author window's `your vouch` row, invite from the profile's `invites` row with the standing bonds — and the
**author's own controls' first unit**: `withdraw` on the reader's own confirmed card inside a pane, after
its like count, two presses with a confirm row in place, the landing turning the card into the withdrawn
card at its depth and settling the post's own submission card — a root's leaves the feed, a reply's becomes
the withdrawn card beneath its parent — **content rendering**: the closed markdown grammar a card renders
(`WEB_INTERFACE → Content`), the composer's `link` and `image` types and its byte counter, the italic face —
and the **responsive workspace** (`WEB_INTERFACE → The workspace`): a column is one stack of windows; the
screen shows K columns of the strip, K from the width, the feed pinned at two or more and a member of the
strip below 955px, where a phone shows one screen at a time; the view moves to the column acted on by an
instant scroll; the header's `‹` `›`; the one-column bar `↻ ✕`; hit size follows `pointer: coarse` and every
hover rule sits under `hover: hover`. **On a phone the header's arrows take the strip's glyph and never
shrink, and its two controls are a person and a sun or moon** (`src/view/glyphs.ts`, faceted polygons in the
house technique, `HOUSE_STYLE → Illustration`) — the two icons the interface carries; iconography opens
nowhere else — and **the standalone thread** (`WEB_INTERFACE → The standalone thread`): `/p/<id>` boots the
same App on one never-persisted window with no feed, every card control an identity brings, the strip
re-rooting the page with a history entry; `add to workspace` hands the thread to the workspace tab that
holds the Web Lock `notis.workspace` — the one writer of the arrangement and the one receiver on the
BroadcastChannel `notis` — or switches this tab in place without a navigation, the identity staying
unlocked (`WEB_INTERFACE → The way into the workspace`); `link` in a card's meta row copies the post's
absolute URL (`WEB_INTERFACE → Links`). Behind nginx `/web/p/<id>` is answered by the node's
`GET /shell/:id` with the preview tags — the README's `### Web client` and `deploy/nginx.example.conf`
say how to serve it. **At one column the screens are history** (`WEB_INTERFACE → The workspace`): a tap that
changes the screen pushes an entry, a move back onto the previous screen consumes it by the arrow or by a swipe,
a swipe elsewhere is no entry. **A word control wears no box** (`HOUSE_STYLE → Interaction`): the word alone,
as the identity prefix renders; the composer's `post` and `cancel` are the one boxed pair; the copy glyph is
the interface's third icon. **The username surface** (`WEB_INTERFACE → The username row`): the `@profile`
window's `username` row claims a name and burns it, in place, with the flight in the row; **the handle `@Name`
stands where a row carries a name** — the who row, the bars, the header, the standalone title — in the page face
at 600, the same control the prefix is (`WEB_INTERFACE → The identity display`).

- **Owns:** `packages/web/*` — its own source, tests, build config and static assets.
- **Does NOT own:** any other package, `contracts/` or `prompts/`.

## The boundary that defines this slice

⛔ **The read client (`src/api/client.ts`) issues `GET` requests and nothing else.** No `POST`, no
`DELETE` for a read. The writes live next door in `src/api/write.ts` — `POST /posts`, `POST /likes`,
`POST /vouches`, `DELETE /vouches/:targetId` (the one non-`POST` write), `POST /invites` and
`POST /posts/:id/withdraw`, `POST /usernames` and `POST /usernames/:name/burn`, and no more. A `viewer` parameter is a query on a `GET`, so it stays in the read client; the four membership
reads (`GET /vouches` by target, by voucher, the cooldown arm; `GET /invites/:userId`) and the name read
(`GET /usernames?owner=`) are `GET`s in it.

**It hashes only through `@dagsocial/types`**, reached by the build-time shim — the wallet builders type
their box candidates and compute every id through the shared implementation, never a copy, which is why
no mirror test applies. **If you find yourself hand-writing an encoder or a hash, you have left the
slice — stop and report, do not implement it.**

**With no identity loaded the client is the read surface exactly** — no `new post`, no `↩ reply`, no
`like`, no `viewer` parameter, and `render-region.test.ts` stays green by node identity. **Once an
identity is loaded, every read carries `viewer=<pubKeyHex>`** and `likedByViewer` is the node's answer.

**The identity is encrypted at rest and unlocked per tab** (`WEB_INTERFACE → The identity module`).
Storage holds an envelope — scrypt and ChaCha20-Poly1305 over the seed, `identity/envelope.ts` — never
the seed in the clear; a page load restores the envelope and the public key only, so `current()` reads
`{ pubKeyHex, locked: true }` until an unlock, and `sign(txIdHex)` — the only path to the seed — throws
while locked. **Every write checks `locked` before its flight** and mounts the unlock form in place: the
composer's foot for `post`, a row under the card's meta for `like`, the confirm row's place for
`withdraw`. The way in is the `@profile`
window's `create` and `import`; a production build has no other door. `draft()` makes the key before
the passphrase is typed so the browser's saved entry names the key it later unlocks. An identity change
takes effect at once through `onChange`: the App rebuilds the pending ledger for the new key, drops the
old poll, and re-reads every open surface with the new `viewer`.

## Web-relevant invariants

**From `WEB_INTERFACE.md`:**
- **Same origin, always.** The node sends no CORS headers. Never hardcode an absolute API origin; the
  default is same-origin and a configured foreign origin will fail until the node gains CORS.
- **Paging is keyset.** `after=<key>` in, `next` out. **Follow `next`; never page on a count of rows
  you rendered** — rows get filtered out of a page and the count lies.
- **Withdrawn is never "deleted."** It keeps its identity and its replies hang off it. Hiding it inside
  a thread orphans them.
- **A withdrawn post reaches the screen as a thread's root without ever being in the feed**, because an
  arrangement is persisted as post ids and a thread open last session may have been withdrawn since.
  Render it; it is not an error.
- **The client contacts no third party on its own** (`WEB_INTERFACE → Content`). Nothing in content is fetched
  on render; an image loads on the reader's press, the host shown first. The grammar is the client's own
  scanner emitting DOM nodes — never an HTML string, never a markdown library — and one URL gate, `http` and
  `https` only, serves the renderer and the composer.

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
- **Every page reserves inert space** — the gutter is `clamp(16px, (100vw − 1184px) / 2, 48px)`, the full
  48px where the feed at its cap and one 500px column fit inside it, 16px below; at one column a member's
  content is capped at 660 and centred, its gutter the leftover and never under 16px. The empty space is a
  control surface, not waste.
- **Hit size follows the pointer and hover applies where hover exists** — `pointer: coarse` grows every
  control's hit box (36px tall, 44 wide for a bar or header control), glyphs and words unchanged; every
  `:hover` rule lives in the one `hover: hover` block, and `style.test.ts` pins that none sits outside it.
  Never a user agent string: the media features are the browser's own report of its input.
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

**No local devnet for the write surface — it iterates against notis.fun testnet.** Two variables point
the vite proxy there — the node, and the faucet, which is a separate service under its own prefix
(`NODE_INTERFACE → Faucet`):

```bash
NOTIS_NODE=https://notis.fun/testnet/api NOTIS_FAUCET=https://notis.fun/testnet/faucet pnpm --filter @dagsocial/web dev
```

The node and nginx send no CORS, so the proxy is the only route. `API_PATHS` in `vite.config.ts` proxies
`/posts`, `/status`, `/blocks`, `/karma`, `/credits`, `/likes`, `/vouches`, `/invites`, `/usernames` — a path the
client calls that is not in the table returns the HTML shell, not the API. `/faucet` is proxied to
`NOTIS_FAUCET` only when it is set, with the `/faucet` prefix stripped (http-proxy prepends the target's
own path). The client's faucet base is `/faucet` in development and `VITE_FAUCET_BASE` on a deploy;
empty means no faucet and no button. **The faucet must relay `expiresAtHeight`** — the client refuses a
202 without it — so a faucet that does not relay it answers the honest refusal, not a grant.

**Every transaction spends real testnet karma:** a thread 5, a reply 3, a like 1, a vouch 1 staked, an
invite its bond; a withdrawal and a claim cost nothing but spend and return one karma box, so a key with none
can sign neither; a burn `USERNAME_BURN_PRICE` (10). There is no automated test that posts — an automated writer would drain the key and
litter testnet; the wallet builders are pinned offline against frozen vectors an independent
implementation computed instead.
Iterate deliberately.

**A vouch cannot be exercised on testnet.** Only a member casts, and testnet's one member is the
faucet root, which neither vouches nor likes. The membership actions are proven on a local devnet stack:
`node packages/web/scripts/promote.mjs` (devnet-only; it refuses any other network) has the public
devnet faucet key promote a throwaway to member the earned way, and the client is then driven against
that stack. On testnet the reader is a resident: the marks are absent and the author window and the
invites row say why.

**A withdrawal is exercisable on testnet once the deployed node answers `expiresAtHeight` on
`POST /posts/:id/withdraw`** and carries `parentRefs` on the withdrawn view (`NODE_INTERFACE → Withdrawal`).
Against an older node the client ends the flight in the client rejection *"the node answered without an
expiry height"* and records no entry — it tracks nothing it cannot expire.

**The pending ledger is per identity** — `notis.pending.<pubKeyHex>`, rebuilt at once on an identity
change; a second key never sees the first's predicted change. A faucet grant rides it as a `grant` entry
so the bounded poll runs while it stands.

⛔ **The reader's identity file — kept outside the repo — never enters the repo, a test, a commit, a
log or a report:** not the file, not its path in code, not its passphrase, not any value from it. It is
imported through the `@profile` window's file picker and nowhere else. A clear
`{ pubKeyHex, privKeyBase64 }` key file imports here and is sealed under a passphrase the reader sets; this
client exports the encrypted envelope only. A proof run
uses a fresh throwaway key; its public key may appear in a report, nothing else may.

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
pnpm --filter @dagsocial/web dev        # vite dev server, proxying the API (NOTIS_NODE, NOTIS_FAUCET)
node packages/web/scripts/promote.mjs   # devnet only: a throwaway becomes a member, for the membership proof

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
- **`VITE_FAUCET_BASE`** is where the *faucet* lives, the same way — `/testnet/faucet` on notis.fun.
  Omitted, it is empty, which means no faucet and no `ask the faucet for karma` button.

A client served from a subpath, reading an API mounted on a different subpath, needs both. Run vite
directly rather than through `pnpm --filter`, so no flag has to survive pnpm's argument passing:

```bash
cd packages/web && VITE_API_BASE=<api path> VITE_FAUCET_BASE=<faucet path> npx vite build --base=<client path>/
```

⚠ **Getting `--base` wrong yields a blank page, not an error.** The HTML loads, every asset 404s, and
nothing in the console names the cause. Check `dist/index.html` after building: every `href` and `src`
must begin with the client path.
