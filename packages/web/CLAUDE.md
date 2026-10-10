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
the **identity interface's first unit**: the `@profile` window (the key's own rows — the username, the key as a
copy control, rep as a number with the faucet step, invites), create / import / export / forget / lock / unlock as forms in place, the
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
shrink, and its three window controls are a person, a wallet and a gear** (`src/view/glyphs.ts`, faceted polygons
and `M`/`L`/`Z` paths in the house technique, `HOUSE_STYLE → Illustration`) — no theme control there, since the
theme is the settings window's first row, and under 372px the wordmark yields to the mark alone
(`WEB_INTERFACE → The workspace`); with the standalone page's sun or moon and the card's copy glyph they are the
five icons the interface carries, and iconography opens nowhere else — and **the standalone thread** (`WEB_INTERFACE → The standalone thread`): `/p/<id>` boots the
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
as the identity prefix renders; a box marks a commit pair and a surface's primary action — the composer's `post` and `cancel`, the extension prompt's `sign` and `cancel`, the feed's `new post`, the wallet's `send`, the username row's `claim` (`HOUSE_STYLE → Interaction`). **The three windows**
(`WEB_INTERFACE → The profile window`, `→ The wallet window`, `→ The settings window`): the header opens
`@profile`, `@wallet` and `@settings` — words at tiling, glyphs on a phone; the profile holds the key's own rows,
the wallet everything `$NOTIS`, the settings window theme, the identity tint with its two sample bars, node and
the extension's policy row; no window renders standing; the faucet's base is the build's value and no
preference. **The username surface** (`WEB_INTERFACE → The username row`): the `@profile`
window's `username` row claims a name and burns it, in place, with the flight in the row; **the handle `@Name`
stands where a row carries a name** — the who row, the bars, the header, the standalone title — in the page face
at 600, the same control the prefix is (`WEB_INTERFACE → The identity display`). **The extension**
(`WEB_INTERFACE → The extension`): the same client built as a browser extension for Chrome and Firefox — the
App as the extension's own page, the identity held by the background (the envelope in `storage.local`, the
unlocked seed in `storage.session`, never a worker global), every write signed there through the
`Signer` seam's proxy; credits always prompted in the prompt window, rep silent while unlocked unless the
*sign each rep action* row says ask; the `notSigned` arm and the fourth ending — the composer still open;
the shell's `notis-nodes` seed list and `notis-public` link origin; one manifest template → two zips; **the
chain it reads checked by NiPoPoW proofs from the seed list's nodes, the verdict folded into the status corner**
(`WEB_INTERFACE → The extension → "The verified tip"`), **and the wallet's balance and the profile's rep judged against
everything the key holds on that chain, each ledger's range read whole, a line beneath a figure only when something is
not whole** (`→ "The verified figures"`), **and
every handle it shows and sends to proven through its name's box — clay where the node's answer does not verify, a send
going to the proven key** (`→ "The verified names"`). **Links into
the extension** (`WEB_INTERFACE → The extension → "Links into the extension"`, `→ The way into the workspace`): a
post's link stays the website's, and a reader who runs the extension follows it into the extension's workspace. **The
bridge** (`src/extension/bridge.ts`, built as `bridge.js`) is the extension's one content script, declared for
`<notis-public>p/*` with the port dropped; it holds nothing and sends the background two messages. `arrived { id }`
leaves when a Notis link opened a tab of its own — `history.length === 1`, a `navigate` entry, outside a private
window — and the preference *a Notis link opens* reads `here` (the default; `notis.links` in `storage.local`, the
settings window's row, read from storage by the page and by the bridge, never from `state`). `offered { id }` leaves
when the hosted page's `add to workspace` offers the thread: `Tabs.offer` dispatches a cancelable `notis:open` event on
`document`, synchronously in the press and before any `await`, and the bridge cancels it under the browser's user
activation — a reader without the extension sees no difference. Both end in the background's `openInWorkspace`: a
pending record `notis.open.<id>` in `storage.session`, the arriving tab closed when a page tab is open and pointed
at the page when none is; the page's lock holder takes the waiting ids through `takeOpen`
(`src/extension/handover.ts` wraps the injected `Tabs`) and opens each by the placement rule from the feed. **The
background takes every message but `arrived` and `offered` from the extension's own pages alone**, checked first —
the bridge runs in a web page's process. **The credits
send** (`WEB_INTERFACE → The wallet window`, `→ The wallet`, `→ The faucet step`): the `@wallet` window's `balance`
and `send` rows — the balance in gold, a send to a key or an `@handle` resolved at the press, the confirm row, the
flight in the row, the row standing while a send's own line stands — on a `buildSend` frozen like the others, the ledger's two views split by kind; the faucet's `$NOTIS` step
beside the rep step; a credits amount is $NOTIS on the face and base units on the wire, through one module the
extension's prompt reads too.

- **Owns:** `packages/web/*` — its own source, tests, build config and static assets.
- **Does NOT own:** any other package, `contracts/` or `prompts/`.

## The boundary that defines this slice

⛔ **The read client (`src/api/client.ts`) issues `GET` requests and nothing else.** No `POST`, no
`DELETE` for a read. The writes live next door in `src/api/write.ts` — `POST /posts`, `POST /likes`,
`POST /vouches`, `DELETE /vouches/:targetId` (the one non-`POST` write), `POST /invites` and
`POST /posts/:id/withdraw`, `POST /usernames`, `POST /usernames/:name/burn` and `POST /credits/transfer`, and no more. A `viewer` parameter is a query on a `GET`, so it stays in the read client; the four membership
reads (`GET /vouches` by target, by voucher, the cooldown arm; `GET /invites/:userId`) and the name read
(`GET /usernames?owner=`), a handle's holder (`GET /usernames/:name`) and the balance (`GET /credits/:userId`) are `GET`s in it.

**It hashes only through `@dagsocial/types`** — and, in the extension's tip verifier, `@dagsocial/validation`'s
header hash and PoW check, through `@dagsocial/nipopow-client` — built as they are written, substituting nothing for Node — the wallet builders type
their box candidates and compute every id through the shared implementation, never a copy, which is why
no mirror test applies. **If you find yourself hand-writing an encoder or a hash, you have left the
slice — stop and report, do not implement it.**

**With no identity loaded the client is the read surface exactly** — no `new post`, no `↩ reply`, no
`like`, no `viewer` parameter, and `render-region.test.ts` stays green by node identity. **Once an
identity is loaded, every read carries `viewer=<pubKeyHex>`** and `likedByViewer` is the node's answer.

**The identity is encrypted at rest and unlocked per tab on the web, per browser in the extension**
(`WEB_INTERFACE → The identity module`, `→ The extension`).
Storage holds an envelope — scrypt and ChaCha20-Poly1305 over the seed, `identity/envelope.ts` — never
the seed in the clear; a page load restores the envelope and the public key only, so `current()` reads
`{ pubKeyHex, locked: true }` until an unlock, and `sign(txBytes, txIdHex, hint?)` — the only path to the seed —
answers `locked` while locked (`WEB_INTERFACE → The wallet`). **Every write checks `locked` before its flight** and mounts the unlock form in place: the
composer's foot for `post`, a row under the card's meta for `like`, the confirm row's place for
`withdraw`. **A row the reader opened under a card outlasts a redraw of its list**
(`WEB_INTERFACE → What the feed reads, and what a card shows for it → "A row the reader opened under a card
outlasts a redraw of its list"`): the unlock form, the withdraw question and the link held as text are built by
`src/view/card-rows.ts` and held by the App (`cardRows`, keyed by list, post and place — `ask` for the unlock form
or the question, `link` beside it), as a composer is. A card's `like`, `withdraw` and refused copy reach the App as
`pressLike` / `pressWithdraw` / `linkRefused` with the list, the post and the control pressed; **the App reads the
lock then** — `CardOpts` carries no `locked` — and `mountRow` (`src/view/card.ts`) puts the row under the card that
control stands in, replacing no node. Every draw of a card passes `ctx.rowsUnder(list, postId)` and the card stands
a row only where it draws the control the row was opened from (`standRows`). Every draw that replaces a card or attaches a
window's body runs in `redraw`: an unlock form found unlocked ends before it — the extension's proxy takes an unlock
made in another page into `current()` and notifies no one — a row left under no card ends after it, all but one whose
list another window of its column covers, which is held off the document until its list is drawn again and ends with
its window's close; and the focus goes back into the composer, or to the element of a row or of a moved body that held
it. `endCardRow` is the one ending of a row: out of the document, its fields emptied (`endForm`, `src/dom.ts`), no
longer held. **A window's body stands while the window is open** (`WEB_INTERFACE → The workspace → "A window's body
stands while the window is open"`): the App holds the body of `@profile`, `@wallet`, `@settings` and each author
window by window id (`bodies`) — `profileBody`, `walletBody`, `settingsBody` and `authorBody` answer `{ el, update }`
over a reader of the state — built at the window's first draw, held off the document while its window is covered, and
ended by the draw that follows its close (`endBody`) and by a change of the identity or of the node read.
`ctx.windowBody(id)` runs the body's `update` and hands the panes the same node. Each row's update leaves alone a form
open in it and a field with text in it, and adds or ends a form only where the state changed whether the row offers
it; **a control reads the state through its reader when pressed**, never from the draw that built it. **A draw that
leaves a window in front of its column never takes its body off the document**: `renderRegionOver`
(`src/view/panes.ts`) draws the bars and the report around it, and `renderPanesInto` keeps every column that stays.
⚠ A browser fires `blur` and `change` on a focused field the moment it is detached — the settings window's `node`
field commits on `change` — and happy-dom fires neither, so the cases hold the rule by a `MutationObserver` over the
panes (`inFront`, `test/app-pane-forms.test.ts`); a new draw path is checked the same way. Every unlock in the App
goes through `unlockIdentity`; it and the profile's `lock` end in `lockChanged`, which draws every held body where it
stands and ends every unlock form — in a body, under a card, owed by a send, in a composer's foot
(`ComposerController.endUnlock`). A send's press belongs to the node, the key and the wallet window it was made under
(`sendPress`, `endSendPress`). An Esc a passphrase form takes stops at the form (`wire`, `src/view/passphrase.ts`);
the extension's prompt page reads its Esc first, in the capture phase, and declines. The way in is the `@profile`
window's `create` and `import`; a production build has no other door. `draft()` makes the key before
the passphrase is typed so the browser's saved entry names the key it later unlocks. An identity change
takes effect at once through `onChange`: the App rebuilds the pending ledger for the new key, drops the
old poll, and re-reads every open surface with the new `viewer`.

## Web-relevant invariants

**From `WEB_INTERFACE.md`:**
- **Same origin by default, any origin by preference.** The node answers every origin
  (`NODE_INTERFACE → Cross-origin requests`); the faucet answers its own only. Never hardcode an absolute
  API origin: the default is same-origin, and the `node` preference names any other.
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
- **Nothing leaves its place that the reader did not ask to move** — literally: no injected banner, no
  card arriving or shifting, no infinite scroll (it is a variable-ratio lever). **A number is not motion: it
  can and should update whenever what it counts changes**, in its fixed slot, never animated.
  **Refresh is a button and it reports what it did** — `4 new posts` or `no new posts`.
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

The client's default API base is same-origin, so the dev server proxies the bare API paths for the default
to hold. `API_PATHS` in `vite.config.ts` proxies
`/posts`, `/status`, `/blocks`, `/karma`, `/credits`, `/likes`, `/vouches`, `/invites`, `/usernames` — a path the
client calls that is not in the table returns the HTML shell, not the API. `/faucet` is proxied to
`NOTIS_FAUCET` only when it is set, with the `/faucet` prefix stripped (http-proxy prepends the target's
own path). The client's faucet base is `/faucet` in development and the shell's `notis-faucet` meta on a deploy, written from `VITE_FAUCET_BASE`;
empty means no faucet and no button, and no preference overrides it. In the extension the `ask the faucet` press asks
the browser for that origin first, inside the press and before any other asynchronous work
(`WEB_INTERFACE → The faucet step`). **The faucet must relay `expiresAtHeight`** — the client refuses a
202 without it — so a faucet that does not relay it answers the honest refusal, not a grant.

**Every transaction spends real testnet karma:** a thread 5, a reply 3, a like 1, a vouch 1 staked, an
invite its bond; a withdrawal and a claim cost nothing but spend and return one karma box, so a key with none
can sign neither; a burn `USERNAME_BURN_PRICE` (10); a send spends real testnet $NOTIS — the faucet's credits step
funds a key, repeatably. There is no automated test that posts — an automated writer would drain the key and
litter testnet; the wallet builders are pinned offline against frozen vectors an independent
implementation computed instead.
Iterate deliberately.

**A vouch cannot be exercised on testnet.** Only a member casts, and testnet's one member is the
faucet root, which neither vouches nor likes. The membership actions are proven on a local devnet stack:
`node packages/web/scripts/promote.mjs` (devnet-only; it refuses any other network) has the public
devnet faucet key promote a throwaway to member the earned way, and the client is then driven against
that stack. On testnet the reader is a resident: the marks are absent and the author window and the
invites row say why.

**A withdrawal is exercisable on testnet once the deployed node carries `parentRefs` on the withdrawn view**
(`NODE_INTERFACE → Withdrawal`). Its 2xx is recorded whether or not it carries `expiresAtHeight`: the entry's
expiry is the ledger's own — the build height plus `MEMPOOL_EXPIRY_BLOCKS`, sooner only by the node's answer
(`WEB_INTERFACE → The wallet`).

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

## The binding check — the bundle's hashing against the node's

The client's builds substitute nothing for Node (`WEB_INTERFACE → The client's builds substitute nothing`):
`@dagsocial/types` hashes over `@noble/hashes` in the browser as it does under Node. **No committed test proves the
bundle's hashing is the node's** — under Node the suite never runs the built bundle. Only the built bundle, run in a
browser over live data, does:

```bash
# against a local dev node (default http://localhost:3000):
node packages/web/scripts/binding-check/run.mjs
# or against a live network:
node packages/web/scripts/binding-check/run.mjs https://notis.fun/testnet/api
```

It builds the harness through the same `refuseNodeBuiltins` plugin the app builds use, evaluates the
bundle in headless Chromium (no Node `process`, `Buffer` or Web Crypto in the
page), and asserts each live post's recomputed `computeContentHash` equals the
`contentHash` the node served. Exit 0 = all matched. Needs a Chromium binary
(`CHROME=…`, else Playwright's cached one). Not in `pnpm test` by design — it
needs a browser and a node.

## Building for a deployment — seven values, written by the build and editable after

**The deployment is seven values in the shell's head** (`WEB_INTERFACE → The client is served from the
node's own origin`): `<base href>` — the path the client's own files are served under, opening and
closing with `/`; `notis-api` — the API's path on the same origin, no trailing slash; `notis-faucet` —
the faucet's path, empty for no faucet and no `ask the faucet for karma` button; `notis-nodes` — a JSON
array of API bases tried in order when no node preference is stored, `[]` on the web; `notis-public` — the
origin and base a copied link carries, empty for the page's own; `notis-network` — the network the build is
for, `testnet` · `devnet` · `mainnet`, empty on the web: the extension's tip verifier takes its proof-of-work
profile from it and **never from a node's `/status`**, and empty (or a name no profile answers to) is a build
with no verifier; the `og:image` content — the picture's absolute URL, `<origin><base>og.png`. The build writes
them from `VITE_WEB_BASE`, `VITE_API_BASE`, `VITE_FAUCET_BASE`, `VITE_NODES`, `VITE_PUBLIC`, `VITE_NETWORK` and
`VITE_PUBLIC_ORIGIN` — `/`, empty, empty, `[]`, empty, empty and empty under `pnpm dev`, where the dev server
proxies the bare API paths — and the client reads them from the DOM at load (`readBase`, `readMeta`,
`readNodesMeta`, `readPublicMeta` and `readNetworkMeta` in `src/prefs.ts`). Vite's `base` is `./` for a build,
so every reference in the built shell is relative and the `<base>` alone decides where the files resolve;
`public/fonts/fonts.css` names its files beside itself for the same reason. A host with another layout
edits the seven values in `web/index.html` after unzipping.

```bash
bash packages/web/scripts/build-release.sh   # notis.fun's values → notis-web-<ver>.zip in the repo root
cd packages/web && VITE_PUBLIC_ORIGIN=<origin> VITE_WEB_BASE=<client path>/ VITE_API_BASE=<api path> VITE_FAUCET_BASE=<faucet path> npx vite build
```

Run vite directly rather than through `pnpm --filter`, so no variable has to survive pnpm's argument
passing. ⚠ **Getting `<base href>` wrong yields a blank page, not an error.** The HTML loads, every asset
404s, and nothing in the console names the cause. Check the built `index.html`: the seven values carry the
intended values and every `href` and `src` is relative — `build-release.sh` checks exactly that.

## The extension — the second build target

```bash
bash packages/web/scripts/build-extension.sh          # notis-extension-<ver>-chrome.zip and -firefox.zip in the repo root
VITE_NETWORK=devnet VITE_NODES='["http://127.0.0.1:19740","http://127.0.0.1:19770"]' VITE_FAUCET_BASE='http://127.0.0.1:19750/faucet' VITE_PUBLIC='http://localhost:19760/web/' VITE_PUBLIC_ORIGIN='' bash packages/web/scripts/build-extension.sh   # devnet values, for the proof
```

`VITE_PUBLIC` falls back to `https://notis.fun/web/` only when it is **unset**; an explicit `VITE_PUBLIC=''` builds
an extension with no bridge, no `content_scripts` and no links row. `VITE_FAUCET_BASE` behaves the same way: unset
takes testnet's faucet, an explicit `VITE_FAUCET_BASE=''` builds a faucet-less extension whose manifests declare no
optional host. `VITE_NETWORK` too: unset is `testnet`, an explicit `VITE_NETWORK=''` builds an extension with no tip
verifier, and a name no network profile answers to refuses the build. ⚠ **A build for a devnet stack needs
`VITE_NETWORK=devnet`** — left unset it verifies devnet's proofs against testnet's profile and every one reads
*this node's proof did not verify*. `VITE_NODES` defaults to testnet's two nodes, `notis.fun` first.

**The verified tip** (`WEB_INTERFACE → The extension → "The verified tip"`, `→ The status corner`): the extension
checks the chain it reads. `src/extension/tip-verifier.ts` (`createTipVerifier`) asks the reading node first and then
every other base of the seed list for `GET /nipopow/proof/24/20` through `resolveTip` of `@dagsocial/nipopow-client` —
the code the command-line light client runs, never a second implementation — with the profile of the build's
`notis-network`, **never a node's `/status`**; `src/model/tip-verdict.ts` (`tipVerdict`, pure) reads the result into
`verified` · `thin` · `refused`, deciding for itself (an unverified reading node never reads `verified`, whatever
code stands beside it; a `behind` that is not a non-negative integer is `null`); the App runs it at start, on a press
of the corner and every ten minutes while visible, one run at a time, a generation dropping a run made for the node
before; the corner is green only while blocks progress **and** the verdict is `verified`. **A reading node that lost
the comparison is outworked only when the winner's suffix does not carry its tip** (the tool's `behind` is `null`) —
the nodes answer one after another, so a follower one block behind loses the fold at every block it lags. `main.ts`
hands the verifier to the App in the extension build alone, and only under a non-empty `notis-network`; the web
build is handed none and `build-release.sh` refuses `nipopow/proof` in its assets. `@dagsocial/validation` verifies
Ed25519 through `@noble/curves` and hashes through `@dagsocial/types`' `hash32`, importing nothing Node
(`WEB_INTERFACE → The client's builds substitute nothing`); **what a build does to those bytes `pnpm test` cannot see**
— the binding check and the proof's write steps are its only proof.

**The verified figures** (`WEB_INTERFACE → The extension → "The verified figures"`, `→ The profile window`, `→ The
wallet window`): the extension proves the reader's rep and balance against the verified chain. A tip run answers
`{ verdict, anchor }` — the reading node's own verified `tip` and `suffixHead`, under `verified` alone —
and `src/extension/figures-verifier.ts` (`createFiguresVerifier`) runs `proveFigures` of `@dagsocial/nipopow-client`
over the listings the rows show: the identity record at `suffixHead` under `identityKey`, each ledger's range at
`suffixHead` and again at `tip` — `GET /api/v1/range/:kind/:owner`, page by page, each page replayed by
`consensus`' `holdingsPage` over the node's proof — then `/blocks/current`; **a listed box is `proven` only when the
key holds it at both heights, in the ledger it was listed under, with the listing's value and lock** — the range
fixes its owner and its type — **a box the key holds that the listing lacks is `unlisted`** where no block landed
since the anchor **and `undecided` where one did**, a tip the node has since replaced makes the ledger's read
`stale`, and each ledger carries the status of its own read (`holdings`); rep is valued by
`effectiveKarma` of `@dagsocial/types` — the node's own function — at the listing's height, taken only from the
anchor's tip to `heightAfter`. **A run proves a listing
read after its anchor and never one read before it**: every read of the reader's own listing is stamped at its start
with the anchor sequence, a verified tip reads `/karma` (and `/credits` with the wallet open) before it proves, and a
listing not read after the current anchor goes to the run as not read (`null`, never empty), its row reading *not
checked yet*. **The reader's own
state is re-read, never predicted**: a landing of the reader's own transaction re-reads the listing it changed, a node
or identity change drops the reader's state and reads it again (`dropReaderState` / `rereadReaderState`), and **no
answer overwrites a newer one** — `readerGen` drops a read across a node or identity change, `readsBegun` /
`newerRead` keep the answer of the latest-begun read per piece, every continuation page continues the page it was
asked for, a refresh lands on the rows standing as it lands, and `withdrawnSeen` — a withdrawal is final — keeps a
withdrawn post out of every write of rows. `src/model/figures-line.ts` (`figuresLine`, pure) turns a result into the
row's line: nothing when every box proved (silence is the green), muted for what could not be proven yet, **clay with
the figure clay** when a proof did not verify, the node lists what the chain does not hold, or the chain holds what
the node did not list; **muted *not checked yet* where the run cannot decide** — an `undecided` box, a `stale`
read — never silence; **an empty listing takes the same lines**, beneath the faucet step or the words standing
there, since that the key holds nothing is a claim the range decides. The numbers update in
their slots whenever a read brings a new one (`HOUSE_STYLE → Motion`). The web build is handed no figures verifier, and
`build-release.sh` refuses `api/v1/proof` and `api/v1/range` in its assets beside `nipopow/proof`. **The run is total**: a node's answer of
any shape ends in a status, never a thrown run — and `NodeClient`'s paged reads refuse a page whose list is not an
array or whose `next` is neither `null` nor a non-empty string with no lone surrogate (`PageError`, taken where a
non-2xx's `ApiError` is), so no read loops on a malformed cursor. **A run ends**: `createFiguresVerifier` hands
`proveFigures` a `fetch` that rejects a request asked more than 60 seconds after the run began (`RUN_DEADLINE_MS`;
the clock is an option beside `prove`), which the tool reads as not served — the row reads *the node served no proof
for …*, never no line.

**The light read and the resolve** (`WEB_INTERFACE → The extension → "The light read"`, `→ "The resolve"`): the
extension reads every list of posts — the feed, an author window's list, a thread — as ids with the node's word.
With a post resolver held (`src/extension/post-resolver.ts`, handed by `main.ts` in the extension build alone, beside
the posts verifier — the App refuses one without the other) the nine list reads ask `light=1` and pass their rows
through `intake`: a row whose post the cache holds with its text is a card at once, composed by `withNodeWord`
(`src/model/light.ts`) from the entry's post under the listing's figures; a withdrawn row is the withdrawn card and
empties a held entry's text; any other row stands as a **slot** (`LightJson`; `div.card.slot`, muted, no text and no
control) — in a thread at the depth its `parentRefs` gives. A light page not held to its shape is `PageError`
(`src/api/light-page.ts`) and reads as a failed listing. After each read writes state, `resolveSlots` claims every
slot standing — the feed's, each author window's, each thread's subject and descendants — reads the cache once more,
and asks the resolver for the rest: `POST <base>/posts/batch?tx=1`, at most `BATCH_READ_MAX` ids a request, no
`viewer`, to the reading node and then each other base of the seed list in turn, a pointer walking the nodes across
resolves, one limit of `BATCH_RESOLVE_MS` over all of a resolve's requests and every request it beats aborted
(`src/model/post-resolve.ts`, pure, over seams). Each answer's rows pass the post check as one batch; a `bound`,
well-formed row with text enters the cache and `fillSlots` turns its slot into its card — in the feed by replacing
that one node, nothing else redrawn. `endSlots` takes out a slot no node served, with no line, and counts one some
node answered `unbound` and none bound in the clay line at its list's head (`view/withheld-line.ts`); a thread whose
subject ends so shows that line and no row, one whose subject no node served the muted *no node can serve this post
yet.* **A row a `↻` or a `load older` counted comes off its line as its slot leaves** (`→ "A report counts the posts
that stand"`): the feed's two lines and an author window's `↻` keep the slot ids they counted beside the text they
wrote (`FeedState.reportCount`, `olderReportCount`; `newPostsLine` / `olderPostsLine` in
`src/model/feed-reconcile.ts` form the words at the write and at the recount), a line anything else has written
since is left, and a thread's `↻` reports the node's own reply count. An answer that returns after a node or identity
change lands nowhere (`readerGen`). **A thread's `ancestors` and
`pending` give ids and are not resolved.** The web build is handed neither seam, asks no `light`, draws no slot, and
`build-release.sh` refuses `posts/batch` in its bundle.

**The post check** (`WEB_INTERFACE → The extension → "The post check"`): the extension shows a post only when the
transaction that created it binds it. Every row that carries a post's bytes passes `checkPosts` of
`@dagsocial/nipopow-client` (`src/extension/posts-verifier.ts`) before it enters state or the cache: each row of a
batch answer, the pending ledger's single post read — the one read that asks `tx=1` — through `ingestOne`, and the
reader's own post at its submit. **A list read brings no bytes and is not checked.** **A checked row is taken field
by field** — `readBoundRow` and `readWithdrawnRow` (`src/api/post-row.ts`, the field rules shared with the light
page's in `src/api/row-fields.ts`): a `bound` row is rebuilt as its sixteen `PostJson` fields, the text held to 1 to
`MAX_CONTENT_BYTES` bytes, no `tx` and no key beyond; one that is not well-formed is one the node did not serve, and
to the single post read a withheld answer. **A withheld answer to the single post read decides nothing** —
`reconcilePost`, `reconcileLike` and `reconcileWithdraw` take a `withheld` flag and keep the entry pending until its
expiry height, never expired as on a 404 — and the rebuilt row, not the node's, is what the reconciles and the
landings read. The web build is handed no verifier, sends no `tx` and shows every row the node serves.

**The post cache** (`WEB_INTERFACE → The extension → "The post cache"`): `src/extension/post-cache.ts`, IndexedDB at the
extension page's origin, the database `notis.posts.<chain>` — `chain` the tip run's (`TipRun.chain`, the reading
node's `genesisHash`), the last name remembered in `localStorage` under `notis.posts.chain`. An entry holds the
transaction's bytes, the row as the node last gave it, the author and the parent as the transaction states them, its
last-seen time, its size and `own`; the running total is a record in a second store, written in the same transaction as
every put, withdrawal and eviction. `POST_CACHE_BYTES` caps it: least recently seen evicted first, the reader's own
never, the entry being put never. **Only `bound` rows enter** — from `offerBoundToCache`, at a resolve's landing and at
the single post read — and the reader's own post at its submit, composed from the signed transaction and passed
through the same check. **A list is read against it first**: `getMany` answers the entries a page's ids name, an
entry without text — a placeholder's, or one a withdrawal emptied — is not held, and `refresh` writes each held
entry's row and last-seen from the listing. **A thread the cache holds is read from it when its read from the node
throws** (`thread`), its rows written through `putThreadRows` beneath the pane's error line; the feed and an author
window's list have no such fallback. A put is started and never awaited by a render; the module absorbs two
failures — a write the browser aborts, and no IndexedDB — and rejects on anything else. `build-release.sh` refuses
`notis.posts.` in the web bundle. Tests run the real adapter over `fake-indexeddb`.

**The verified names** (`WEB_INTERFACE → The extension → "The verified names"`, `→ The identity display`, `→ The author
window`, `→ The wallet window`): the extension proves every handle it shows, and every handle it sends to, through
`proveName` of `@dagsocial/nipopow-client` — the lookup (`/usernames?owner=` for a label, `/usernames/:name` for a typed
handle), the name's box at `suffixHead` then `tip`, the proven owner and name held to the claim. `src/extension/
names-verifier.ts` (`createNamesVerifier`) is handed to the App in the extension build alone; the App keeps one result
per `(key, name)` pair (`model/name-verdict.ts` — `namePair`, `nameIsClay`), checks every pair on screen after each
verified tip run and the undecided ones after each render that draws a handle, one batch at a time, and a check ending
`unchecked` asks for one tip run. **A result lands in place**: each handle carries its pair (`view/name-handle.ts`,
`data-name-pair`) and a result that changes its clay toggles the class alone — an ink result touches no DOM; the
author window's clay line is drawn only by the window's render. Results drop on a node change and outlast an identity
change and an unverified run. **The send's press is the App's** (`pressSend`): *checking @bob…* in the flight's place
while the check runs (`sendCheck`), a press during it doing nothing; the answer (`sendAnswer` — a refusal, or the key
the proven box names, with the unlock a locked identity owes) held by the App and drawn on whichever form stands; the
key the flow receives is `recipientVerdict`'s, the proven owner, never the node's word; a node or identity change
(`readerGen`) ends a press with nothing landing. The web build takes the node's answer at the press, with its confirm
row.

Three Vite builds — the pages (`index.html`, `prompt.html`) through `vite.extension.config.ts`, the background
as one IIFE file through `vite.background.config.ts`, and, when `VITE_PUBLIC` is not empty, the bridge as one IIFE
file through `vite.bridge.config.ts` — then `extension/emit-manifests.mjs <version> <chrome-outdir>
<firefox-outdir> <public-base> <faucet-base>` writes each browser's `manifest.json` from
`extension/manifest.template.json`, the bridge's one `content_scripts` entry among it and **the one optional host,
the faucet's origin** — both patterns from `extension/match-pattern.mjs` (`matchPatternFor`, `originPatternFor`), the
port dropped, since Firefox silently drops a match that carries one — and Firefox's `browser_specific_settings`: the
id, a minimum of 140, the `update_url`, the two required data categories, and an Android floor of 142
(`WEB_INTERFACE → The extension → "The manifest"`). The icons under `extension/icons/` are
copied in, the checks run (no inline `<script>`, `<base href="/">`, the metas at the build's values, no
`import` in `background.js` or `bridge.js`, the literal `notis-public` in `bridge.js`, the manifests parse, their
one content-script match equal to the pattern the same module derives — and neither file nor key under an empty
`VITE_PUBLIC` — Firefox's `browser_specific_settings` deep-equal to the object the script states literally, none in
Chrome's manifest, both manifests' `optional_host_permissions` equal to the pattern the module derives from the
faucet base and absent under an empty one, every reference relative, `web-ext@10 lint --self-hosted` clean on the
Firefox stage — without the flag the `update_url` is a lint error; its two warnings are the static inline mark's
two `innerHTML`), and the two zips are made from a fresh stage — their contents are reproducible file for file,
the zips themselves differ by their entries' timestamps. `test/emit-manifests.test.ts` spawns the emitter and reads
both manifests, so the gate sees them too. The Chrome manifest's `key` is the tracked RSA public key in the
emitter, so the extension id is stable
(`kafmnekclgkjnkhnbafdoefnlllboddm`); `NOTIS_EXTENSION_KEY` overrides it. `main.ts` takes
the identity implementation from `VITE_IDENTITY` (`page` | `extension`) and wraps the `Tabs` it hands the App in the
extension build alone, and `build-release.sh` checks the web bundle
carries no `chrome.` reference. **The extension's source lives in `src/extension/`** — `background.ts`,
`bridge.ts`, `handover.ts`, `links.ts`, `proxy.ts`, `protocol.ts`, `policy.ts`, `prompt.ts`, `prompt-summary.ts`,
`chrome.d.ts` (the `chrome.*` surface used, no `@types/chrome`) — with `test/fake-chrome.ts` and `test/fake-tabs.ts`
for the Node tests.

**The signed Firefox build** (`WEB_INTERFACE → "The Firefox build ships signed as well"`): after the release
workflow has attached the zips, `scripts/sign-extension.sh` publishes the Firefox one. `submit <ver>` takes the
release's own `notis-extension-<ver>-firefox.zip`, rebuilds it from `git archive v<ver>` by the two commands
`extension/REVIEWERS.md` names (build-time variables unset), refuses unless the contents are equal file for file,
and sends them with the source archive to addons.mozilla.org's unlisted channel through `web-ext sign`, pinned at an
exact version because that process holds the credentials; `--dry-run` runs everything short of the submission, and
only there are `--rev` and `--zip` accepted. **A version is signed once**: the moment a signed file comes back,
`submit` copies it to `notis-extension-<ver>-firefox.unverified.xpi` in the repo root, before any check of it can
refuse, and removes that copy only after `cmp` proves the verified file landed; a refusal keeps it and names it, and
a leftover of that name refuses the next `submit` of the version. The verify step runs in a subshell with errexit
armed and never as a condition operand — a condition context switches `set -e` off in everything it calls.
`entry <ver> <xpi>` checks a signed xpi against the zip — every file outside `META-INF/` equal, `manifest.json` by
its parsed content (`extension/manifest-content.mjs`, `sameManifestContent`: Mozilla's signing re-serialises it and
the closing newline goes), every other file byte for byte — lands it in the repo root and prints the
update-manifest entry, `--into <updates.json>` appending it;
`published <ver>` reads the live update manifest, the link and the hash back. Exit 3 means no signed file came
back: the version waits for a review, the signed file comes from the developer hub later and `entry` finishes —
never a second `submit` of one number. All JSON work is `extension/update-manifest.mjs` (`compareVersions`,
`repoFromUpdateUrl`, `entryFor`, `checkManifest`, `appendEntry`), pure and tested, every fact read from the signed
build's own `manifest.json`. The update manifest is `firefox/updates.json` on the branch `updates` — deployment
state, never part of this tree. ⛔ **The signing credentials live in a mode-600 file outside the repo
(`$NOTIS_AMO_ENV`, default `~/.config/dagsocial/amo.env`) and never enter the repo, a test, a commit, a log, a
report or a brief**; a proof uses a scratch file with fake values. `extension/REVIEWERS.md` is what Mozilla's
reviewer builds from: when the pnpm this machine builds with moves, that file moves with it — `submit` refuses
otherwise.

**The proof** is `scripts/extension-check/run.mjs`: headless Chromium over raw CDP (the cached Chrome for
Testing; no Playwright) loading the unpacked Chrome build, driving the twelve steps of the extension section
through the real UI — the composer, the like word, the profile and wallet rows, the prompt window — the eleventh
the wallet's faucet press asking the browser for the origin and refused, the twelfth in four measured parts (the
same press granted and the faucet's `$NOTIS` step, a send approved at the prompt, a send declined, a send after a
lock pressed in the profile) — **and, with `--public <origin+base>` and `--web-dist <dir>`, the four steps of links
into the extension**: the harness serves a web build made for that base itself (`<base>p/<64 hex>` answering the
shell, a plain page with a same-tab and a `target="_blank"` link), refuses a shell whose `notis-public` or a manifest
whose one match differs from `--public`, sets the preference through the settings row, and presses with
`Input.dispatchMouseEvent` — the bridge takes an offer only under the browser's user activation. 13 the button
under `on the site`; 14 the takeover with a workspace tab open, three runs, one after a ≥ 32 s idle — the arriving
tab destroyed (the event index taken **before** `Target.createTarget`: the tab is gone in tens of milliseconds),
exactly one extension page left, the static server's request log as the outside measure of how far the hosted page
got; 15 the takeover with none open, the tab becoming the workspace; 16 left alone — a same-tab link, a reload, back
from the tab that became the workspace (two backs at one column: the workspace's own screen entry first), and a
`target="_blank"` link as the control, found by its `openerId`; last, the bridge-less arm in a
`Target.createBrowserContext` context, where the press switches the hosted page in place. Without the two flags
13–16 read `NOT RUN`. **With `--verified-tip` (and `--node-dist`, `--miner`, `--scratch`, `--node-p2p`) the
verified-tip block**, for which the harness owns every node but A — a peer **B** of A, an in-process **relay** that
serves A's reads and flips one byte of its proof, a node **C** that syncs from A and is then restarted cut off
(`MAX_PEERS=0`, an empty bootstrap, a new listen port) to mine three blocks of its own, and a fresh isolated **D**
— each step asserting the rendered corner (the dot's class, the tip span's classes, the `title`, the tip in it
being the reading node's own) and counting `/nipopow/proof/` requests from CDP: **17a** the `node` row on D at
height 0 — *the chain is too short to check yet · tip 0*; **17** *verified across 2 nodes*, one proof request per
node per press, none unasked in twenty seconds; **17b** thirty presses reading A and thirty reading B under A's
live miner, every one green; **18** B stopped — *only one node could be checked* — and green again once it
rejoins; **19a** the row on the relay — *this node's proof did not verify*, the height clay, the feed still
rendering; **19b** the row on C once A's proof out-scores C's fork — `resolveTip` over `[C, A]` read until C verifies,
A wins and C's `behind` is `null`, since a fork a few blocks deep can tie A on the score and a tie keeps the reading
node — *127.0.0.1:19740 holds more work than this node*; **19c**
the row on D mined past `m + k + 4` (48) — *the nodes share no block to compare*; **20** the hosted web build — the first
paragraph's title and no `/nipopow/` request. In a full run the block runs after step 16 on a session opened on
the extension page live at that moment (step 15 closes the first one), and the browser-context arm runs last. The
extension for it is built with `VITE_NETWORK=devnet` and `VITE_NODES` naming A then B; the harness refuses
otherwise. **With `--verified-figures` as well (it needs `--r-key` and the lifecycle arguments `bringUpNodeB` reads)
the verified-figures block** runs next, owning a B of its own (a verified tip needs a second verified node) and a
**figures relay** on its own port that passes every `/nipopow/proof/` answer through — so the corner stays green —
and lies in one mode at a time: `credits-fake` (a fabricated box on R's first `/credits` page), `credits-foreign` (the
devnet faucet's largest credit box listed under R), `credits-drop` and `karma-drop` (one box withheld from R's first
`/credits` or `/karma` page), `credits-drop-tipplus1` (the credits drop, and `/blocks/current` answered one above the
node's own), `avl-flip` (one byte flipped in every `/api/v1/proof/` and `/api/v1/range/` proof): **21** a
send's young change reads *… landed since* after a press and silence after K + 1 blocks; **24** R's post — the rep
number the node's new `effective` with no press (the landing's run reads the bare *not checked yet*: its anchor
predates the post, so the box the post spent is `undecided`), *… landed since* after a press, silence after K + 1; **22a** clay *the node lists … the chain does not hold*, the
figure clay; **22b** the same line with the foreign box's own amount — the range R's boxes are read from does not
hold another key's; **22c** clay *the chain holds … $NOTIS the node does not list*, beneath the empty state where the
drop emptied the listing; **22d** clay *the chain holds … rep the node does not list*; **22e** the node that
withholds and answers another height — the balance row muted *not checked yet* after the change and after each of
two presses, never silent and never clay; **23** both rows clay, *this node's proof of … did not verify*; each arm
compares the amount its line names with the box the relay lied about, presses again while a block landed between
the anchor and the run's `/blocks/current` — the lying row reading *not checked yet* there, and any silent or
honest-looking reading of it failing the arm — and is switched back to A and silent again; **25** the hosted web
build — no line and
no `/api/v1/proof/` or `/api/v1/range/` request. A figures run asks the record, each ledger's range at the two
heights, and `/blocks/current` — ten requests with the wallet open. ⚠ **The figures block needs a throwaway that has
not run steps 11–12**: on a key already granted `$NOTIS` the faucet step is not on screen and step 11 times out.
**With `--verified-names` as well (it needs `--s-key` beside what the figures block needs) the verified-names block**
runs on a B of its own, a second identity **S** holding a name — S promoted as R is and its name claimed by
`scripts/extension-check/claim-name.mjs` through the web's own `submitClaimFlow` (⚠ a second `promote.mjs` is refused
once by the faucet, whose in-memory chain names a change `promote.mjs` spent outside it — run it again) — and the
figures relay's five **name modes** (`label-rename`, `owner-404`, `owner-fakebox`, `name-owner`, `name-fakebox`, every
proof passed through verbatim so the corner stays green): **26** R claims a name through the `username` row — the
header, R's cards, a thread, R's author window and the row read it in ink, the checks in the log; **29** a send typed
to S's handle — *checking @S…*, S's key beneath the field and on the prompt's `to:`, declined; **27a** a renamed label
clay; **27b** a withheld name — R's cards clay, the header R's key prefix (the own-name read falls to the same 404: the
omission the rule leaves uncaught); **27c** a made-up box clay, each check's heights and each tip run's cause in the
relay's log; **27d** the author window's name row turning clay in place with no line and the rows unmoved, its `↻`
drawing the line; **28a** Eve's key over S's box and **28b** a made-up box refused at the press with no prompt — 28b
pressed once A has mined past the anchor, so its first check reads `unchecked`, asks one tip run and the retry reads
`absent`; **30** the hosted web build — no clay and no `/api/v1/proof/`. Each lie arm switched back to A and ink again.
**With `--light` (it needs `--r-key`, `--node-dist`, `--miner`, `--scratch`, `--node-p2p`; `--public` and `--web-dist`
for its last step; it takes no other verified flag) the light block**, L1–L14, runs alone after steps 1–16. **Every
base the extension knows is a relay of the harness's own**: `RA` on `:19810` in front of node A and `RB` on `:19815`
in front of a second node B, started before the browser, so the extension for it is built with `VITE_NODES` naming
those two and the harness refuses any other seed list. Each relay passes every request through — every
`/nipopow/proof/` among them — logs it as it arrives, and lies over `POST /posts/batch` in one mode at a time: `text`
(one row's text swapped), `drop` (no row answered), `hold` (answered at `release()`), `hang` (never answered), and
beside them `list-down` (the list reads answer 503), `list-replay` (a recorded light page), `down` (every connection
destroyed), with a switchable upstream. The steps: **L1** a cold feed under `hold` — slots with no text and no control
in `inkMute`, one light list read and one batch of exactly those ids at `RA`, the cards in the same order at the
release; **L2** a reload — one light list read, no batch; **L3** the reader's own new post named in no batch, and one
deleted entry asked for in one batch of one id; **L4** the pointer — the feed's batch at `RA`, a thread's at `RB`;
**L5** `drop` on `RA` — `RB` asked the same ids; **L6** `text` on `RA` — `RB` binds it, no clay; **L7** `text` on `RA`
with `RB` `down` — that slot gone and *1 post withheld — it does not match its signature*; **L8** `drop` with `RB`
`down` — no slot, no card, no line; **L9** `hang` with `RB` `down` — the slots standing at nine seconds, gone at
twelve, the client's close of the batch at `BATCH_RESOLVE_MS`; **L10** a cold thread under `hold` on both relays —
each reply's slot at the depth its card takes; **L11** `list-down` on a held thread — the error line over the held
rows; **L12** a withdrawal — the withdrawn card, the entry's text gone, no batch after a reload; **L13** both relays
in front of an isolated node **D** on another chain — a second database beside the first, a replayed listing drawing
nothing from the first chain's entries; **L14** the hosted web build — no `light`, no `tx`, no batch, no database.
⚠ **The workspace restores its open windows on every reload, and each restored thread is a resolve of its own**: a
step that reads the feed alone closes every pane first. ⚠ **The pointer walks**: a page session's second resolve
starts at the other relay, so a step that holds or hangs it sets both. ⚠ **A request's `close` fires when its body
has been read** (Node 22): a relay reads the client's going away from the response's `close` while it is not ended.
⚠ **A `//` comment inside a template passed to `cx.eval` carries no backtick** — one ends the string, and
`node --check` passes it. ⚠ **A thread is opened the product's two ways and no other**: from a feed card's strip, or
by id through the pending record `notis.open.<id>` written from the background's context — the page has no post-id
hash route. ⚠ **Opening a thread that is already open reads nothing**: a step that needs a read presses the pane's
`↻`. ⚠ **`GET /blocks/:height` carries no hash** — the harness recomputes block 1's through `blockHash`.
⚠ **A second `promote.mjs` on one stack is refused once** (`No karma box input found in transaction`) and passes on
the next try; each run of the block needs a member that has not run steps 11–12.
**The ten-minute timer and the visibility rule are the unit tests'**, not the proof's. ⚠ **17b guards a
race that is wide only for a follower under a fast miner**: reading B at about three blocks a second, a build
whose verdict read every lost comparison as *outworked* showed the alarm on 24 of 30 presses; under the paced
miner of a full run the two fetches mostly see one height. The web build for it: `VITE_WEB_BASE=/web/ VITE_API_BASE=<the devnet node's origin>
VITE_FAUCET_BASE='' VITE_NODES='[]' VITE_PUBLIC='' VITE_PUBLIC_ORIGIN='' npx vite build --outDir <scratch>`; the
extension with `VITE_PUBLIC=<--public>`. All of it against a local
devnet **started by hand on ports above 19000** — `packages/node/dist/index.js` with `NETWORK_TYPE=devnet
NODE_ROLE=miner BOOTSTRAP_PEERS=""` and its own `miner.mjs`; ⚠ `packages/node/scripts/dev.mjs` cannot serve a proof:
it binds node 1 to port 3000 and stops every child when one exits — `tools/faucet/dist` with the devnet faucet key
(`tools/e2e/src/identities.ts`, devnet-only and public by design; `FAUCET_KEY_PATH` is a mode-600 file holding the
PKCS8 DER as hex), `promote.mjs` for a throwaway member (`--r-key` is a file `{ pubKeyHex, privKeyBase64 }`, the
base64 of the 48-byte PKCS8 DER `promote.mjs` prints as hex),
the extension built with devnet values, the faucet's base among them — the harness refuses to run when the built
shell's `notis-faucet` differs from `--faucet`. Step 8 lets the worker die by a ≥ 30 s idle wait — `chrome.runtime.reload`
clears `storage.session` and proves nothing — and the worker target is the one whose URL ends in
`/background.js` (Chrome ships a built-in Hangouts worker first). Ports above 19000. The throwaway's key file
and the faucet's live under a scratch path, never in the repo, a log or a report. The faucet runs from the
tree's `tools/faucet` with `FAUCET_CREDIT_AMOUNT` set, and `--faucet` names its origin with the `/faucet` prefix
the service routes under. At start the harness adds the two loopback origins to the unpacked manifest's
`host_permissions`, since CDP cannot drive the browser's permission dialog — the tracked template and the packed
manifest are untouched, and the granted path is the hand pass. Devnet's decay outruns the harness at full mining
speed, so the miner is paced from outside — a stop-and-continue loop around its PID, a few blocks a minute
(`kill -STOP`, forty seconds, `kill -CONT`, three seconds measured about three a minute here), **started before
`promote.mjs` and kept to the end** — for the throwaway's rep to last the run: unpaced at about four blocks a second
the throwaway fell from 240 rep to 4 before its second post. The loop has a pidfile of its own, and ⚠ **a
`SIGSTOP`-ed miner does not die on `SIGTERM` until it is continued** — stop the loop, `kill -CONT`, then `kill`. The
miner at `MINER_PCT=3` on a fresh chain paces a full run's blocks (about twenty a minute falling to five as ASERT
hardens); at `MINER_PCT=1` windows yield nothing and a grant's wait runs out. ⚠ **Launch the miner and the pacer with
`setsid`, from a script** (`bash stack-up.sh`): under `nohup … & disown` a stopped miner stays in the launching shell's
process group, and when that shell exits the kernel's SIGCONT to the orphaned group runs the miner unpaced until the
pacer's next stop; in a shell with job control on, `setsid` forks and `$!` names the exited parent. ⚠ **`promote.mjs`
under the pacer needs retries** — its waits lose to windows that yield nothing, and the faucet refuses once after a
promote spent its boxes outside the service (`No karma box input found in transaction`); run it again after a pacer
cycle.

⛔ **A proof stack is stopped by PID, never by name.** This machine's `dagsocial-miner` user unit runs the same
`packages/node/scripts/miner.mjs` against testnet, and `pkill -f miner.mjs` kills it — it did, twice on 2026-09-17,
stalling the chain for an hour and three quarters and then for forty minutes. Start each process of the stack with
`nohup … < /dev/null & echo $! > <name>.pid; disown %+`, check the pidfile names the process you mean
(`tr '\0' ' ' < /proc/<pid>/cmdline`) and `kill` from the pidfiles; a listener left on a port the recipe owns is
resolved with `ss -ltnp`. Never `pkill`, never `pgrep -f`, never a grep over `/proc/*/environ`. After the last run,
`systemctl --user is-active dagsocial-miner` must print `active`, **and no headless Chromium of the run may be left**
(`rtk proxy ps -eo pid,args`, read for the cached Chrome's path — a smoke run once left one verifying testnet every ten
minutes for two hours; ⛔ **never a bare `ps`**: the rtk hook rewrites a top-level `ps` to a 32-line `rtk ps`, which
read 0 Chromium processes while 16 were up). ⚠ Devnet's storage rent period is a hundred blocks: a box that sits through it is charged
`STORAGE_RENT_PER_BYTE` per record byte at the producer's next collection, so a long run at a fast pace shows a
throwaway's grant shrunk — keep a run short, and start the faucet with `FAUCET_CREDIT_AMOUNT=10000000000` (100
$NOTIS, what step 12a reads) and `FAUCET_BOND_AMOUNT=250`. ⚠ **`TMPDIR` under the scratchpad breaks the harness's
Chromium launch**: the harness names Chromium's user data directory under `TMPDIR` and its `SingletonSocket` path
runs past the 108-byte UNIX socket limit — the process is spawned, DevTools never appears, the run dies before any
step. Keep `TMPDIR` on a short path (unset, or `/tmp`). ⚠ **The extension build moves its zips into the repo
root**, where the user's release zips may already sit — a proof build in the main tree would overwrite them, and a
run's cleanup would then delete them. Build the extension in a throwaway detached worktree (`git worktree add
--detach <scratch path> HEAD`; remove with `git worktree remove --force <path>`), which takes the built zips with
it and leaves the release ones untouched. ⚠ **The `MINER_PCT` and pace numbers this machine measures** — an
unpaced `MINER_PCT=25` miner runs at about 35 blocks a second on a fresh chain (about 9× the older 4-blocks-a-second
figure), and `MINER_PCT=3` under the standard 40 s stop / 3 s continue pacer at about 10 blocks a minute — so a
"fast start" burns through height fast, and a run's B/C/D still spawn with plenty of head-room.

⚠ **A `<base>` element resolves fragment references against itself**, so the client carries none: the mark
is inline markup (`src/view/mark.ts`), never a sprite referenced by `<use>`, and every URL composed from
the base is path-absolute.
