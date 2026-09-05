# WEB Interface Contract

**Component:** `@dagsocial/web`
**Status:** the **read surface**, the **write surface's first slice** — the identity machinery,
the composer for a root and a reply, and like — the **identity interface's first unit** — the
`@profile` window, create / import / export / forget / lock / unlock, encryption at rest with unlock per
tab, the reader's own posts marked, the faucet karma step — the **membership actions** — the
identity display with the vouch mark, the author window and the author-posts window, vouch and
unvouch, invite from the profile — and the **author's own controls' first unit** — withdraw from the
reader's own card — are implemented; prune is not built
**Protocol version:** read from the node, never held — see Invariants


> **The demo UI (`packages/node/public/index.html`) is not this contract's subject.** It is a debug
> interface. Do not write an interface contract for it, and do not treat it as a product surface.
>
> ⚠ **The demo UI outlives this client's first slices.** It withdraws through a builder of its own, the
> second implementation the web's vector is frozen against; `@dagsocial/web` posts, likes, vouches,
> unvouches, invites and withdraws, and neither surface prunes. Nothing about it is superseded by this
> contract.
>
> **One thing about the demo UI IS binding:** it hand-rolls `computeBoxId`, `computeTxId`,
> `postFieldBytes` and the positional writers under them, so it is a third implementation of
> consensus-critical encodings and **must stay byte-identical to `@dagsocial/types`**. That is pinned
> by `ui-crypto-mirror.test.ts`.
>
> ⚠ **The mirror is sound for what it extracts, and that is not everything.** It names its
> declarations by exact source string, so a consensus-critical function it does not name is unpinned
> and nothing signals the omission. Measured 2026-08-10: `solvePoW` was not extracted, and the
> browser's PoW nonce encoding had diverged from the verifier's with the full suite green. **Adding a
> hashing or encoding function to the demo UI means adding it to the loader list**, and a mirror's
> coverage is a claim about a list, never about a file.

> **RESOLVED 2026-09-02 — this file carried a banner asserting it was "100% original text … one of the
> few that was never wrong".** By 2026-09-02 it was wrong in two places: an invariant read *"PoW is
> solved client-side"* while the Client-Side Operations table in the same file said there is no client
> PoW and no challenge, and the API table named `POST /identity/import`, which no route in
> `packages/node/src` serves. Recorded rather than quietly deleted, because the banner is a second
> instance of the failure the banner itself was cited as evidence for: **a claim about the tree decays
> when the tree moves, and a disclaimer creates a region nobody re-reads.** The `Status:` line
> convention it argued for stands; the boast does not.

## Scope

Browser-based client for Notis. Depends on a running `@dagsocial/node` HTTP API.

**The package is built in slices, and the `Status:` line above says which are real.** A slice's
boundary is drawn so that the boundary itself is checkable, not so that it is convenient.

### The read surface — every call is a GET

**The read surface holds no key and signs nothing.** No key generation, no signing, no transaction
construction. It **does** hash — and it does so with `@dagsocial/types`, the shared implementation,
never a copy. That is what keeps it from being a further implementation of anything
consensus-critical, and it is why no mirror test applies to it.

Owns: the feed, threads, the tiling workspace of columns and regions, both themes, the identity
spine, and the client's preference rows — in the `@profile` window (→ The profile window). Reads posts,
threads and node status. Sends nothing — every write is the write surface's, through its own module.

**With no identity loaded it sends no `viewer` parameter**, because it has none to name, and every
`likedByViewer` it receives is `null` — the correct value for an anonymous reader rather than a
placeholder for one. **Once an identity is loaded, every read carries `viewer=<pubKeyHex>`** and
`likedByViewer` is the node's answer. A light client carries its identity on every request anyway,
and one rule is cleaner than a local record of likes kept beside the node's.

### The write surface — identity, post and like, the membership actions, and withdraw

Every section and invariant below marked *(write surface)* belongs to this slice; the read surface
is the rest.

**The slice is the identity machinery, the composer for a root and a reply, like, the membership
actions — vouch, unvouch and invite — and withdraw, the author's own controls' first unit** — on
transactions the browser builds and signs. Prune is **not built** and is named as such where it
appears. The identity interface — the `@profile` window, its six operations and
the faucet karma step — is stated below (→ The identity module, → The profile window, → The faucet
step).

**With no identity loaded, the client is the read surface exactly.** No `new post`, no `↩ reply`, no
`like`, no mark beside any identity (→ The identity display), no `viewer` parameter. The way in is `create` or `import` in the `@profile` window (→ The
profile window); nothing else in the interface creates an identity, and a production build exposes no
other door.

## The browser reaches `@dagsocial/types` through a build-time shim

`@dagsocial/types` and `@dagsocial/validation` are written against Node: `createHash('blake2b512')`
in five files, `generateKeyPairSync`, `createPublicKey` and `verify` in one, and `Buffer` as a
**global that is never imported**. A browser has none of them.

The client supplies them **at build time and changes neither package**: `crypto` resolves to a shim
over pure-TS primitives, and `Buffer` is supplied to the bundle. Nothing in `types` or `validation`
knows the difference, and when those packages stop depending on Node the shim is deleted rather than
migrated.

**The shim carries only what the client's own module graph reaches, and nothing on speculation.**
`createPublicKey` and `verify` are `@dagsocial/validation`'s, and the client does not depend on that
package; they arrive with the code that calls them. An unreached primitive cannot be pinned by any
test that runs, and an unpinned consensus-critical primitive is a liability rather than a
convenience — which is the whole argument against a hand-rolled copy, applied to the shim itself.

⛔ **The shim's hashing must be byte-identical to `createHash('blake2b512')`, and that must be
pinned.** Every id in the protocol is a blake2b-512 digest truncated to 32 bytes; a shim that
differs by one byte produces ids the node rejects, and neither package's own tests would notice
because neither exercises the other's code. This is the same failure class the demo UI's mirror
exists for.

⛔ **A substituted module is pinned by absolute path, never by a bare specifier.** A bare specifier
resolves from **the module that imports it**, which for a substituted Node global is a file inside
`@dagsocial/types` — a package that declares no such dependency, so the specifier resolves to the Node
builtin and the browser build externalizes it to nothing. The failure is invisible in a populated
working tree, where the layout happens to make the package reachable, and appears only on a clean
install. **This is what the throwaway-worktree gate is for; a build that succeeds in the main tree is
not evidence.**

⚠ **A test running under Node does not prove the shim.** The shim is a build-time substitution, so
under Node the real `crypto` and the real `Buffer` are present and the substitution never happens —
a green Node suite is consistent with a bundle in which the shim was never wired at all. **The
binding check runs the built bundle in a browser** and recomputes, against live data, a value the
node independently produced.

⚠ **No WASM.** The substitutes are pure TS, per the preference order the project holds for every
package.

## The client is served from the node's own origin

⛔ **The node sends no CORS headers.** `packages/node/src` contains no `cors` middleware, no
`Access-Control` response header, and `cors` is not a dependency. A browser client served from any
other origin cannot read the API at all.

So the client is served **same-origin** with the API it reads — in development by the dev server's
proxy, in production by whatever fronts the node. **The client never hardcodes an absolute API
origin**; its default is same-origin, and a configured override to a foreign origin will fail until
the node gains CORS. The setting says so rather than failing silently.

⚠ **This is a constraint on deployment, not a property of the protocol.** A third-party client on its
own origin is impossible today, and that bears on the anti-lock-in property the project claims
elsewhere.

## Reading the feed and threads

| Client action | Endpoint | Query |
|---|---|---|
| Feed | `GET /posts` | `limit`, `after`, `author`, `viewer` |
| One post | `GET /posts/:id` | `viewer` |
| A thread | `GET /posts/:id/thread` | `limit`, `after`, `viewer` |
| Node status | `GET /status` | — |
| The tip | `GET /blocks/current` | — |

**Paging is keyset, never offset.** `after=<key>` goes in, `next` comes back — a formatted key, or
`null` at the end of the collection. A client that counts rows it rendered, rather than following
`next`, pages wrongly the moment anything is filtered out of a page.

**The author-posts window reads the same view with `author=<key>`** (→ The author window) — the one
place the client passes the filter; the feed never does.

**The feed carries four things**: `posts`, `next`, `pending` and `pendingCount`. A post sitting in the
mempool is part of the read surface, so a pending post renders before any composer exists to create
one.

### What the feed does not carry, and what the client does about it

- **No roots-only filter.** `GET /posts` returns roots and replies alike; there is no root column in
  the store. The feed shows both. **A reply renders with its parent as a one-line reference**, not
  with the parent's card pulled in beside it.
- **No descendant count on a feed row.** A card's reply count therefore reads `?`. The count is real
  on a thread (`descendantCount`), which is what a title bar shows; a feed card does not know it, and
  finding out would cost one thread fetch per card.
- **Stumps and pruned tombstones never appear.** The feed's rows are posts and withdrawn markers only.
  The client filters the withdrawn ones out, which costs it rows from a page and is the second reason
  paging follows `next`.

## The three absence states

Every one of these is on screen in ordinary use, and no other social interface has any of them.

| State | Where it appears | What it is |
|---|---|---|
| **withdrawn** | inside a thread; **never in the feed** | the content is gone and the replies survive |
| **stump** | as a thread's root | a pruned subtree's remains, carrying `replyCount`, `upvoteCount` and `compactedAtBlockHeight` |
| **pruned** | as a thread's root | a tombstone naming the `rootPostHash` it was pruned under |

**Withdrawn is never "deleted", and no rendering may imply that it is.** A withdrawn post keeps its
identity, its replies still hang off it, and hiding it inside a thread would orphan them. That is the
whole difference between withdrawal and deletion.

**A stump has no strip and neither has a tombstone** — there is nothing beneath either to open.

⚠ **A stump or a tombstone reaches the screen even though neither is ever in the feed.** A workspace
arrangement is persisted as post ids, so a thread left open in one session may have been pruned before
the next. A restored arrangement that resolves to one renders it; it does not drop the window and it
is not an error.

## Client-side operations — the write surface

### The identity module *(write surface)*

**One identity at a time, encrypted at rest.** Storage holds an **envelope** under `notis.identity`, and
the exported file is the same envelope — one codec, and importing an encrypted file is storing it:

```json
{ "version": 1, "pubKeyHex": "<64 hex>",
  "kdf":    { "name": "scrypt", "salt": "<16 bytes hex>", "N": 65536, "r": 8, "p": 1 },
  "cipher": { "name": "chacha20-poly1305", "nonce": "<12 bytes hex>" },
  "ciphertext": "<the 32-byte seed ‖ the 16-byte tag, hex>" }
```

| Operation | Algorithm | Notes |
|-----------|-----------|-------|
| Key generation | `generateKeyPair()` from `@dagsocial/types`, through the shim | the seed is the DER's last 32 bytes; the RFC 8410 wrapper `302e020100300506032b657004220420` is a constant the codec re-adds |
| Seal | scrypt (`@noble/hashes`) → a 32-byte key; ChaCha20-Poly1305 (`@noble/ciphers`) over the seed with `pubKeyHex` and `version` as associated data | a fresh salt and nonce per seal; a derived key is used once, which is what makes a random 12-byte nonce safe. The parameters travel in the envelope, so `N` can rise with no version bump |
| Open | scrypt with the envelope's own parameters; the tag verified; the public key recomputed from the seed **must equal** `pubKeyHex` | a wrong passphrase, an edited header and a flipped byte are each refused with a reason |
| Import | an envelope, stored verbatim after one successful open; **or** the demo UI's clear `{ pubKeyHex, privKeyBase64 }`, validated as before (48 bytes, the prefix, the recomputed key) and sealed under a passphrase the reader sets | the clear shape is a **file shape only** — a clear value found in storage reads as no identity and is left in place. Interop with the demo UI is one-way: its files import here; it cannot read this client's |
| Export | a **fresh** seal under a password the reader types, downloaded as `notis-identity-<prefix>.json` | needs the seed, so a locked identity unlocks first |
| Signing | `ed25519.sign` from `@noble/curves` over the 32 transaction-id bytes | 64 raw bytes, hex in JSON, keyed by the hex public key; **throws while locked** |
| Post ID | the node's `postId` from the `POST /posts` response | never derived client-side — the node is authoritative and the value is in the reply |

**No Web Crypto, still.** scrypt and ChaCha20 are pure TS in the family the shim carries, and the
randomness is `getRandomValues`, which no secure context gates. Both primitives are in Node's own
`crypto` (`scryptSync`, `createDecipheriv('chacha20-poly1305')`), so any Node tool opens the file with
the standard library — pinned by a test that decrypts a browser-sealed envelope under Node. ChaCha over
AES because a pure-JS AES leans on table lookups a pure-JS ChaCha does not need.

**The seed is decrypted on demand and lives for the tab.** A page load restores the envelope and the
public key only: `current()` answers `{ pubKeyHex, locked: true }`, reads carry `viewer`, the write
controls render. The first write — or the profile's own `unlock` — takes the passphrase, and the seed
then sits in JS memory until `lock`, a reload or the tab's end. No idle timeout. **Every write checks
`locked` before its flight**, because the unlock is a form and `sign` is synchronous: `post` shows the
unlock form in the composer's foot, `like` in a row under the card's meta row, downward and in response
to the press (`HOUSE_STYLE → Motion`), and success continues the flight.

**`sign` is the only path to the seed.** `current()` returns the public key and the lock state and
nothing else, and no DTO carries the seed. The module's surface:

```
current(): { pubKeyHex, locked } | null          draft(): Identity — a key held, not yet stored
create(passphrase): Promise<Identity> — seals and stores the draft      discardDraft(): void
inspectFile(text): { kind: 'clear' | 'encrypted', pubKeyHex }
importFile(text, passphrase): Promise<Identity>  exportFile(password): Promise<string>
unlock(passphrase): Promise<void>                lock(): void            forget(): void
sign(txIdHex): string                            backedUp(): boolean     onChange(listener): void
```

**The browser may remember the passphrase.** Every passphrase form is a real `<form>` with a read-only
`username` field carrying the key and `autocomplete` of `current-password` (unlock) or `new-password`
(create, import, export), so a password manager saves and fills. The export form's username is
`<pubKeyHex> · file`, so a file password that differs from the at-rest passphrase does not offer to
overwrite the identity's saved entry.

**An identity change takes effect at once.** `onChange` fires on create, import and forget; the App
builds the pending ledger for the new key, drops the old key's poll and optimistic likes, and re-reads
every open surface with the new `viewer`.

### The wallet *(write surface)*

⛔ **There is no client proof of work and no challenge.** Posting is a karma-priced UTXO transaction:
karma boxes in, change out, a `KarmaPriceBox` carrying the price, and for a reply a `LikeAccrualBox`
carrying the parent author's share. The post rides inside that transaction — `postFieldBytes` is in
the `computeTxId` preimage — so the signature covers the post and a relay can no more rewrite it than
it can re-point a like.

**Reads before a write, in this order: `GET /karma/:key` following `next`, then `GET /status`.**
Every output declares `createdAtBlock`, which may not be below any input's
(`TYPES_INTERFACE → Monotonic creation height`), and a `/karma` row carries no `createdAtBlock` — so
the client declares the `/status` height, and reading it *after* the boxes is what guarantees no
selected box is newer than the height declared.

**The spendable view** is the confirmed boxes, minus the inputs of the client's own pending
transactions, plus their predicted change — `computeCandidateBoxId(change, txId, 0)`, exact because
ids are provenance-derived. **The pending ledger is persisted, per identity** —
`notis.pending.<pubKeyHex>`, constructed for the loaded identity at start, so a key never sees another
key's entries and cannot try to spend its predicted change; a reload that forgot the ledger would
re-spend a box the node holds pending and receive a 409 for a failure the reader never saw. **An
identity change rebuilds the ledger for the new key at once** (→ The identity module, `onChange`).

**Builders exist for a post, a like, a vouch, an unvouch, an invite and a withdrawal, and nothing else.** A root
post: change and a `karma_price` of `POST_PRICE_THREAD`. A reply: change, a `karma_price` of
`POST_PRICE_REPLY − REPLY_AUTHOR_SHARE`, and a `like_accrual` of `REPLY_AUTHOR_SHARE` to the parent's
**`confirmedAuthor`** from `GET /posts/:id` — never the row's `author`, which is a claim rather than the
topology. A like: change and a `like_accrual` of `LIKE_KARMA_COST` to the target's confirmed author,
`likeTarget` set, exactly one signature. A vouch: change and a `vouch` box of exactly
`VOUCH_KARMA_AMOUNT`, `voucherId` the reader's key, `targetId` the identity. An unvouch: one input — the
reader's live `vouch` box naming that identity, resolved from `GET /vouches?voucher=` **at the press**,
never from a cached set, since a box can be spent between a render and a click — and one
`vouch_escrow` output of the same value, `owner` the reader's key, `releaseAtBlock` the vouch's
`createdAtBlock` plus `vouchCooldownBlocks` from `/status` (`NODE_INTERFACE → Vouch transition rules`:
the cooldown runs from the cast); no karma input and no change. An invite: change and a `bond` box of
the amount the reader chose inside `/status`'s `inviteBondMin`–`inviteBondMax`, `inviterId` the reader's
key, `inviteePublicKey` the pasted key. A withdrawal: one karma input — the smallest spendable box, so a
pending withdrawal ties up the least — and one karma output of its value to the reader's key,
`postWithdraw` naming the post; the returned box is the entry's `change` (→ The withdraw control). Zero
change is no box (`TYPES_INTERFACE → Box value domain`).
Every builder is frozen against the demo UI's own, the second implementation (`builders.test.ts`).

**Nothing retries.** A rejection is one `Rejection { status, message }`, normalised from both body
shapes the node uses — `{ error: <status>, reason }` and `{ error: <message> }`; a 409 drops the entry
and re-reads the spendable view, and the reader sees the rejection.

**Reconcile runs on the reader's own refresh and on the bounded poll below.** A pending post is landed
when `GET /posts/:postId` answers `confirmed`, expired on a 404 or once the tip passes
`expiresAtHeight`; a pending like is landed when `likedByViewer` turns `true`. That field reflects
store records only, so **the client overlays its own pending likes** onto it until they land or expire.
A pending vouch is landed when `GET /vouches?voucher=<key>` lists the pair; a pending unvouch when the
pair is absent — the escrow it creates is no signal, since one born past its release height is returned
by the next block's settlement and its cooldown row can stand for a single block the poll never sees
(`NODE_INTERFACE → Vouch transition rules`); a pending invite when `GET /invites/<key>` lists a bond
naming the invitee; a pending withdrawal when `GET /posts/:id` answers a tombstone — the withdrawn
marker, or a stump or pruned tombstone when the thread went first (`NODE_INTERFACE → The prune and
withdrawal phase`), and expired at once on a 404 — each expired once the tip passes its `expiresAtHeight`.

**The reader's vouch set is client state read from the node, never stored:** `GET /vouches?voucher=<key>`
to the end of `next` at identity load, again on every vouch or unvouch landing, and the cooldown arm
beside it. The set, with the ledger's pending vouches overlaid, is what the mark reads (→ The identity
display). The cooldown arm is the escrow gate — after any unvouch, no cast until `releaseAtBlock`
(`NODE_INTERFACE → Vouch transition rules`) — which the client withholds as a courtesy, like the vouch
floor `VOUCH_MIN_BALANCE`; the node's refusal stays the truth for every other rule.

**Landing is the one unsolicited update, and it is bounded.** While the ledger holds an entry the
client reads `GET /blocks/current` every 15 seconds, and when the height moves it reconciles the
ledger's entries. It runs only while the client's own submissions are pending and stops at zero; it
refreshes no feed, no thread and no count; a landed card changes colour and nothing else
(`HOUSE_STYLE → Motion`) — with one exception: a landed withdrawal turns the reader's own card into the
withdrawn card, the shape they asked for (→ The withdraw control).

### The profile window *(identity interface)*

**One header control, at the right of the app bar beside the theme toggle.** With no identity it reads
`profile`; with one, the key prefix in mono — `shortHex(pubKeyHex, 16)`, the card's own rule, so an
identity reads the same way in the header and on a card. No avatar and no identity colour: nothing may
invite a reader to check identity by colour (`HOUSE_STYLE → Identity colour`). It opens `@profile` in the
workspace by the placement rule every window follows, and a second press raises the open window.
`@settings` is retired: a stored arrangement naming it parses to `@profile`, so a saved workspace
survives the rename.

**The window is rows, label and field, in two states.** With no identity: one line — *"no identity in
this browser. create one, or import a file."* — then `create` and `import`. With one:

```
key          the whole 64 hex, mono, selectable
standing     resident · member · root — the node's word
karma        the balance that spends, or the faucet step
invites      K available · the invite form · the reader's standing bonds
passphrase   locked · unlock  /  unlocked · lock
export · forget — each a form in place (import is offered only with no identity loaded)
────
theme · identity tint · node · faucet · arrangement — the preferences
```

The window's `↻` is live — the first window with something to refresh — and re-reads `/karma/:key`.

**The six operations are forms in place, and each is a real `<form>`** the browser's password manager
can save from (→ The identity module). Enter submits, Esc cancels and returns focus to the button that
opened it, and a refusal is one sentence in the voice register under the fields.

- **Create** and **import** are offered only with no identity loaded — switching keys is `forget`, then
  one of them, so a loaded key is never silently replaced. Create drafts a key through the shim first and
  shows it as the form's username — the key exists before the passphrase is typed, so the browser's
  saved entry names the key it will later unlock, as the unlock form's username does — takes two `new-password` fields (matching,
  non-empty, **no minimum length** — the manager makes the strong ones and a rule only nags), seals and
  stores the draft, and leaves one standing line under `key` until the first export: *"this key lives in this browser only. export it to keep it."* Import is a native file picker:
  a clear file gets a set-passphrase form, an encrypted one a `current-password` form whose successful
  open admits it.
- **Export** unlocks first if locked, takes two `new-password` fields under the username
  `<pubKeyHex> · file`, seals fresh and downloads `notis-identity-<prefix>.json`; the backup line clears.
- **Forget** asks in place — *"forget this key on this browser? without an exported file it cannot be
  recovered."*, the never-exported fact first when it applies — `forget` and `keep`, focus on `keep`.
  It clears the envelope, the seed and the backup flag, leaves the key's pending ledger, and returns the
  window to its empty state.
- **Lock** drops the seed; **unlock** takes the passphrase — *"that passphrase does not open this
  key."* when it does not.

**Standing is a word the node chose, and the client derives none of it.** `member` is the node's
predicate and `invitesAvailable: null` is the node saying root (`NODE_INTERFACE → UTXO queries`). Under
the word, one muted line with its numbers in mono, never the headline (`HOUSE_STYLE → Voice`): a
resident — *"members are made by other members' vouches and likes. this key has N and M."*, the bars
from `/status` `membership` since a resident's own `memberBar` is still zero; a member — *"since block
H · K invites available."*; a root — nothing more.

**The `invites` row** *(membership actions)*: the line — `K invites available` for a member, *"as many
as your karma covers"* for a root, *"invites come with membership"* for a resident; the form, a real
`<form>` in place shown only when an invite is available and the spendable view covers the minimum
bond — the invitee's key, 64 hex pasted out of band, and the bond, a number inside `/status`'s
`inviteBondMin`–`inviteBondMax`, **default the minimum** — with what happens under it: *"they receive the
bond's karma from the pool. your bond comes back as they receive likes, one karma per three, and the
rest goes to the pool after N blocks."* (`INVITE_BOND_VEST_PER_LIKES` from `@dagsocial/types`,
`inviteProbationBlocks` from `/status`); the flight in the row, the deferred unlock in the row when
locked; and beneath, **the reader's standing bonds** from `GET /invites/<key>`, one row per bond —
the invitee's identity (→ The identity display, so the reader can vouch for their own invitee here)
and the bond's value — following `next`. No settle height: no view serves it, and the client invents
no number. The available count drops when the bond lands, in place, never animated.

**Karma is `effective`**, the value every sufficiency check on the node reads — `E effective · T held`
when decay has opened a gap, because the face `total` would promise karma the next spend does not have.
This is the one place a balance rests on the reading surface. **No credits row** while the client spends
no credits. **A card by the loaded key reads `· you`** after the prefix, muted ink, text only.

### The faucet step *(identity interface)*

**In the karma row, one ghost button — `ask the faucet for karma` — while three things hold:** an
identity is loaded, its `/karma` `boxCount` is 0, and a faucet base is configured. Not a header control:
a grant is once per key for ever (`NODE_INTERFACE → Faucet`), so a standing button would sit dead before
its one press and after it. The request carries only the public key, so a **locked** identity can ask.

**A faucet is a fact of the deployment, not of the network**, so the client reaches it as it reaches the
node: `VITE_FAUCET_BASE` baked at build time — empty means no faucet and no button — and a `faucet`
preference row that overrides it. In development the proxy takes a second target from `NOTIS_FAUCET`.
The call, `POST <faucet>/karma { pubkey }`, lives in its own module beside the write client — the read
client stays GET-only and the write client stays the node's edge — and the faucet's `{ error }` bodies
normalise to the same `Rejection { status, message }`. In the register: a relayed 400 → *"this key
already had its faucet grant."*; 429 → *"the faucet is busy right now. try again in a while."*; 503 →
*"the faucet is empty right now."*; anything else → *"the faucet said:"* and the message, lowercased.

**The wait rides the bounded poll, as a `grant` entry in the pending ledger.** A 202 adds
`{ kind: 'grant', txId, expiresAtHeight, submittedAtHeight }`, so the tip poll runs while it stands and
stops at zero (→ The wallet). Reconcile is `GET /karma/:key`: `boxCount` risen → landed, and the row's
fixed line box reads the balance; past `expiresAtHeight` and still zero → expired — *"no block took the
faucet's invite by height N."* with `ask again`. Colour and text in a fixed box: the geometry price the
motion contract asks of pending state (`HOUSE_STYLE → Motion`).

⛔ **A 202 without `expiresAtHeight` is refused** — *"the faucet did not say when its invite expires."*
— never bounded by a guess: a grant with no expiry would run the poll for ever, which the motion
contract forbids. The faucet relays the field (`NODE_INTERFACE → Faucet`).

### The identity display *(membership actions)*

**Wherever an identity is shown it is the key prefix in mono, then the mark, then `· you` on the
reader's own** — cards in the feed and in panes, a reply's parent reference, a title bar, an endorser
row and a bond row, the author window's subject line. The prefix is `shortHex(key, 16)` on a card and
the whole key in a window.

**The mark is one character, a control wherever it renders but on a title bar (below), and never a
word:** `✓` in ink when the reader's live vouch names this identity; `+` in muted ink when the reader may vouch and has not; `✓` in muted ink while the
reader's vouch is pending; **absent** with no identity loaded, for a reader who is not a member, and on
the reader's own identity; **present but disabled** while the reader's stake from an unvouch is held or
the spendable view is below `VOUCH_MIN_BALANCE`. Its state is glyph and ink weight and nothing else — no
hue (`HOUSE_STYLE → Identity colour`: nothing may invite a reader to read identity by colour) and no
word. `✓` U+2713 and `+` are typographic, like the workspace's arrows, not iconography
(`HOUSE_STYLE → Deliberately not decided`); if the self-hosted faces lack U+2713 the check is a
two-stroke SVG in `currentColor` at x-height, never a fallback font.

**A press on `+` vouches at once — no confirmation, the feed included.** A press on `✓` opens the author
window, where unvouch lives one step further on purpose. The visible glyph is small; the click target
is the meta row's button height with the ghost outline (`HOUSE_STYLE → Accessibility contract`: a
control's sole boundary), reachable by keyboard and touch. A locked identity mounts the unlock form in a
row under the meta, as a like does (→ The identity module).

**The mark's `title` is the count and nothing else** — `3 vouches`, from `GET /vouches?target=<key>`'s
`count`, read once per distinct author on a rendered page, cached for the session, re-read on the
region's `↻` and on the reader's own vouch or unvouch landing for that identity. The mark renders before
its count arrives, and a failed read leaves the `title` empty, never wrong. A disabled mark's `title` is
the reason instead, and the author window carries the same sentence in text, so hover is never the only
route (`HOUSE_STYLE → Interaction`). ⚠ **The per-author read is the price of the count on today's
node**; a count on the post view retires it.

**The prefix on a card is the way into the author window** — a ghost button in the meta row beside
`↩ reply` and `like`; the strip stays the card's only control for opening a thread and the card body
stays selectable text (`HOUSE_STYLE → Interaction`). On a title bar and a reply reference the prefix
stays text: the bar is the tightest space in the design. Opening a window spends nothing, so the
panes-only rule that governs like and reply does not bind it.

**On a title bar the mark is display only** — `✓` in ink when the reader's live vouch names the
author, muted while it is pending, absent otherwise, and never `+`: the bar's label is itself the focus
control, a control cannot nest inside a control, and the bar carries no action but focus. The cards
inside the pane carry the control. A reply reference's mark is the full control; only its prefix is
text.

### The author window *(membership actions)*

**`@author:<64hex>`** — an `@`-window like `@profile`, opened from an identity's prefix by the placement
rule every window follows, raised rather than duplicated, persisted in the arrangement (`isWindowId`
accepts the prefix with 64 hex). The bar reads `author · <prefix>` and carries no spine. `↻` is live and
re-reads `/karma/:key` and the endorsers page. Rows:

```
key          the whole key, mono, and the mark
standing     root · member since block N · resident, with the progress line the profile shows
endorsers    N vouches, then one row per voucher — their identity, following next
your vouch   + vouch · ✓ vouched since block N · unvouch — or the one-line reason the reader cannot
posts        a word that opens the author-posts window beside this one
```

**Standing is the node's word**, as in the profile (`member`; `invitesAvailable: null` for root); a
resident's line reads the counts against the bars from `/status` — the only place a bar is read for
another identity. **`unvouch`** resolves the vouch box at the press (→ The wallet); a pair already gone
re-renders the row to `+ vouch` and says so — *"that vouch was already withdrawn."* Its copy states what
happens: the stake is held until block N and no new vouch until then. The reasons the reader cannot
vouch, one line each: *"vouching comes with membership"*, *"your stake from an unvouch is held until
block N"*, *"this is you"*. With no identity loaded the window is the
read surface exactly — key, standing, endorsers, no marks and no `your vouch` row.

**The author-posts window — `@posts:<64hex>`** — opened from `posts`, placed by the same rule (from the
feed, the author window takes the first column and the posts the next), raised when open, persisted.
Its body is `GET /posts?author=<key>` — the author's committed posts, newest first, following `next` —
as feed cards: the strip, the prefix and the mark, `· you`, and no like and no reply, which live in the
pane the strip opens. `↻` reports what it did — `4 new posts` / `no new posts`. The bar reads
`posts · <prefix>`, no spine.

### The withdraw control *(author's own controls)*

**Withdraw is the author's first own control, and it lives in the card's meta row inside a pane.** On the
reader's own confirmed live post — the pane's root included — the meta row's first slot — where `like`
sits on another's card, and the read-only like count on the reader's own — gains a `withdraw` button
after that count, beside `↩ reply`; the count stays. `· you` in the who row stays text. The control
appears nowhere else: not on a feed card (write controls live inside a pane), not on a pending card or the
client's own submission, not on a withdrawn card, a stump or a tombstone (a post withdraws once, and a
tombstone has nothing to withdraw), not in the `@posts:` window's read-only cards, never with no identity
loaded.

**Two presses, the second in a confirm row.** The first press mounts a confirm row after the meta row —
where the unlock row mounts, one row at a time — reading *"withdraw this post? the content goes; the
replies stay."* with two actions, `withdraw` and `keep`, focus on `keep`; `keep` and Esc remove it. The
second press, on the row's `withdraw`, signs: a locked identity gets the unlock form in that row's place
first, and success continues the flight (→ The identity module). The copy never says "deleted" (→ The
three absence states).

**The client withholds one gate: a key with no karma box cannot sign a withdrawal.** The transaction
spends and returns one karma box, so with an empty spendable view the button renders disabled with the
reason as its `title` — *"needs one karma box to sign with; this key has none"* (`HOUSE_STYLE →
Interaction`). The maturity bind, liveness and authorship are the node's to refuse.

**The flight runs in the slot.** The second press replaces the `withdraw` button with the stage line —
`submitting…`, then `submitted`, the like count staying beside it — and the ledger holds a `withdraw` entry:
its subject the post, its one input the spent
box, its `change` the returned box under its predicted id, its `expiresAtHeight` the body's. A reload
renders `submitted` from the entry. **Landed:** the entry's `GET /posts/:id` answered a tombstone, and the
client replaces the row in place with what it fetched — in every open thread the post becomes the
withdrawn card at its depth (the tombstone's `parentRefs`, `NODE_INTERFACE → Pruning`), the feed and any
`@posts:` window drop the row, the live-post index forgets it — and re-renders only the regions holding
it; no thread and no feed is refreshed. This is the one landing that changes a card's shape (→ The wallet,
`HOUSE_STYLE → Motion`). **Expired:** the stage line reads *"no block took this by height N."* with `try
again`, which rebuilds from the current view and submits anew; the entry is removed and the box returns to
the spendable view. **Rejected:** the region's report line reads *"withdraw rejected: …"* with the node's
refusal in the voice register — its known refusals mapped to sentences, as the like's and the vouch's
are (`HOUSE_STYLE → Voice`) — and the control returns; a transport failure reads *"withdraw rejected:
can't reach the node right now."* and leaves nothing pending. A 2xx whose body carries no `expiresAtHeight` is a client
rejection — *"the node answered without an expiry height"* — the way a txId that differs from the built
one is: the client records no entry it cannot track.

## Writes

| Client action | Endpoint | Standing |
|---------------|----------|----------|
| Ask the faucet for karma | `POST <faucet>/karma` — `{ pubkey }` → `{ txId, status, expiresAtHeight }` | *(identity interface)* — the faucet's edge, not the node's (`NODE_INTERFACE → Faucet`) |
| Submit a post | `POST /posts` — `{ tx, content }` → `{ postId, status, expiresAtHeight, txId }` | *(write surface)* |
| Like | `POST /likes` — `{ tx }` → `{ status, txId, expiresAtHeight }` | *(write surface)* |
| Standing and balance | `GET /karma/:userId`, `GET /credits/:userId` | *(write surface)* — the spendable view |
| Vouch | `POST /vouches` — `{ tx }` → `{ status, txId, expiresAtHeight }` | *(membership actions)* |
| Unvouch | `DELETE /vouches/:targetId` — `{ tx }` → `{ status, txId, expiresAtHeight, karmaReturnsAtBlock }` — the one non-`POST` write; the client reads the release from the cooldown arm, not the last field | *(membership actions)* |
| Invite | `POST /invites` — `{ tx }` → `{ status, txId, expiresAtHeight, bondBoxId }` | *(membership actions)* |
| The reader's vouches, cooldowns and standing bonds; an identity's endorsers and count | `GET /vouches?voucher=`, `GET /vouches?voucher=&cooldowns=1`, `GET /invites/:userId`, `GET /vouches?target=` | *(membership actions)* — reads, in the read client |
| Withdraw | `POST /posts/:id/withdraw` — `{ tx }` → `{ status, txId, postId, expiresAtHeight }` | *(author's own controls)* |
| Prune a subtree | `POST /posts/:id/prune` | not built |

**The write client is its own module beside the read client.** The read client issues `GET` requests
and nothing else, and that stays literally checkable; the writes live next door, and a `viewer`
parameter is a query on a `GET`, not a write.

**There is no identity registration endpoint.** A key is created in the browser and becomes known to
the node by appearing as the author of a transaction the node accepts. No route registers one, and a
client that expects to announce itself first is built against an endpoint that does not exist.

## Dependencies

- **No WASM.** Pure-TS only, per the preference order the project holds for every package.
- No server-side rendering — a static bundle served same-origin with the API.
- Modern browser. **No Web Crypto.** Keys and signatures are pure TS through `@noble/curves`, the
  family the shim already carries, so the write surface needs no secure context and adds no
  primitive the read surface lacks. The identity envelope's scrypt and ChaCha20-Poly1305 are the same
  family — `@noble/hashes` and `@noble/ciphers` — and its randomness is `getRandomValues`, which no
  secure context gates (→ The identity module).

## Preconditions

- `@dagsocial/node` HTTP API reachable **on the origin serving the client**
- Static assets served, fonts among them — self-hosted, never fetched from a third party

## Invariants

- **A private key never travels to any server.** It is stored, used and exported in the browser, and
  an export is the reader's own file (→ The identity module). *(write surface)*
- **Storage never holds the seed in the clear.** The stored identity is an encrypted envelope, the seed
  is decrypted into memory on demand and for the tab only, and a clear value in storage reads as no
  identity (→ The identity module). *(identity interface)*
- **Every read carries the viewer's key once an identity is loaded, and none does before.** *(write
  surface)*
- **The mark is never a word and never carries a colour** — its state is glyph and ink weight, and its
  `title` is a count or a reason (→ The identity display). *(membership actions)*
- **A consensus constant is imported; a per-network number is read.** `POST_PRICE_THREAD`,
  `POST_PRICE_REPLY`, `REPLY_AUTHOR_SHARE` and `LIKE_KARMA_COST` are consensus and ruled
  (`CONSTANTS → Post price and likes`) and come from `@dagsocial/types`; what `/status` serves
  differs per network and is never held. *(write surface)*
- **Affordability is known before the attempt.** Opening a composer reads the spendable view once; a
  price it cannot cover disables `post` and says so, so the reader never spends a rejection to learn
  what the client already knew. *(write surface)*
- **The client reads the protocol era; it never holds one.** `GET /status` → `protocolVersion` is the
  era at `blockHeight + 1`, and the field is in every id preimage, so a client learns the era before
  it signs. A build constant would agree with one network and be refused by another
  (`ARCHITECTURE → Protocol Versioning`). *(write surface)*
- **A per-network number is read, never assumed.** `vouchCooldownBlocks`, `inviteBondMin`,
  `inviteBondMax` and `inviteProbationBlocks` are served by `GET /status` for the same reason: an
  unvouch's `VouchEscrowBox.releaseAtBlock` is pinned as `vouch.createdAtBlock + vouchCooldownBlocks`,
  so a client holding a constant builds a transaction the node rejects. *(write surface)*
- **Content length is enforced in UTF-8 bytes before submission** — `MAX_CONTENT_BYTES` is 300 bytes,
  and one emoji is four of them. *(write surface)*
- **All hashing is client-side; the node verifies, it does not assist.** *(write surface)*
- **The read surface holds no key and signs nothing.** Its boundary is checkable: it issues `GET`
  requests and nothing else, and it constructs no transaction.
