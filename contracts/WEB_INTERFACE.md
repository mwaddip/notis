# WEB Interface Contract

**Component:** `@dagsocial/web`
**Status:** the **read surface** is implemented; the **write surface's first slice** — the identity
machinery, the composer for a root and a reply, and like — is contracted below and **ahead of the
code** (the dated marker under Scope); vouch, invite, the faucet call, withdraw, prune, the profile
window and every identity interface are not built
**Protocol version:** read from the node, never held — see Invariants

> **The demo UI (`packages/node/public/index.html`) is not this contract's subject.** It is a debug
> interface. Do not write an interface contract for it, and do not treat it as a product surface.
>
> ⚠ **The demo UI outlives the read surface.** It is the only browser surface that can *write* — it
> builds, signs and submits post, like, withdraw, invite, vouch and unvouch transactions, and
> `@dagsocial/web` does none of that yet. Nothing about it is superseded by this contract's read
> surface.
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
spine, and a `@settings` window. Reads posts, threads and node status. Sends nothing.

**With no identity loaded it sends no `viewer` parameter**, because it has none to name, and every
`likedByViewer` it receives is `null` — the correct value for an anonymous reader rather than a
placeholder for one. **Once an identity is loaded, every read carries `viewer=<pubKeyHex>`** and
`likedByViewer` is the node's answer. A light client carries its identity on every request anyway,
and one rule is cleaner than a local record of likes kept beside the node's.

### The write surface — the first slice: identity, post and like

> ⚠ **AHEAD OF CODE (2026-09-03) — the write surface's first slice.** Every section and invariant
> below marked *(write surface)* states the rule the slice implements and is ahead of the tree; the
> marker retires in the unit's contract pass.

**The slice is the identity machinery, the composer for a root and a reply, and like**, on
transactions the browser builds and signs. Vouch, invite, the faucet call, withdraw, prune, the profile
window and every interface for generating, exporting or importing an identity are **not built**; each
is named as such where it appears.

**With no identity loaded, the client is the read surface exactly.** No `new post`, no `↩ reply`, no
`like`, no `viewer` parameter — and nothing in the interface creates an identity. The machinery is
reached in a development build only, through `globalThis.notis.identity`; a production build exposes
nothing.

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

**One identity at a time**, stored under `notis.identity` in `localStorage` in the demo UI's export
shape — `{ pubKeyHex, privKeyBase64 }`, the private half the 48-byte PKCS8 DER of the Ed25519 seed —
so one key moves between the demo UI and this client in both directions. No encryption at rest; a
passphrase is interface, and the identity interface is not this slice's.

| Operation | Algorithm | Notes |
|-----------|-----------|-------|
| Key generation | `generateKeyPair()` from `@dagsocial/types`, through the shim | its `secretKey` is already the PKCS8 DER the stored shape carries |
| Import | base64 → 48 bytes; the RFC 8410 prefix `302e020100300506032b657004220420`; the public key recomputed from the seed **must equal** `pubKeyHex` | a file that names one key and carries another is refused with a reason |
| Signing | `ed25519.sign` from `@noble/curves` over the 32 transaction-id bytes | 64 raw bytes, hex in JSON, keyed by the hex public key; no Web Crypto, no secure-context requirement |
| Post ID | the node's `postId` from the `POST /posts` response | never derived client-side — the node is authoritative and the value is in the reply |

**`sign` is the only path to the seed.** `current()` returns the public key and nothing else, and no
DTO carries the seed.

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
identity loaded through the dev door takes effect on reload.**

**Builders exist for a post and a like, and nothing else.** A root post: change and a `karma_price` of
`POST_PRICE_THREAD`. A reply: change, a `karma_price` of `POST_PRICE_REPLY − REPLY_AUTHOR_SHARE`, and a
`like_accrual` of `REPLY_AUTHOR_SHARE` to the parent's **`confirmedAuthor`** from `GET /posts/:id` —
never the row's `author`, which is a claim rather than the topology. A like: change and a
`like_accrual` of `LIKE_KARMA_COST` to the target's confirmed author, `likeTarget` set, exactly one
signature. Zero change is no box (`TYPES_INTERFACE → Box value domain`).

**Nothing retries.** A rejection is one `Rejection { status, message }`, normalised from both body
shapes the node uses — `{ error: <status>, reason }` and `{ error: <message> }`; a 409 drops the entry
and re-reads the spendable view, and the reader sees the rejection.

**Reconcile runs on the reader's own refresh and on the bounded poll below.** A pending post is landed
when `GET /posts/:postId` answers `confirmed`, expired on a 404 or once the tip passes
`expiresAtHeight`; a pending like is landed when `likedByViewer` turns `true`. That field reflects
store records only, so **the client overlays its own pending likes** onto it until they land or expire.

**Landing is the one unsolicited update, and it is bounded.** While the ledger holds an entry the
client reads `GET /blocks/current` every 15 seconds, and when the height moves it reconciles the
ledger's entries. It runs only while the client's own submissions are pending and stops at zero; it
refreshes no feed, no thread and no count; a landed card changes colour and nothing else
(`HOUSE_STYLE → Motion`).

## Writes

| Client action | Endpoint | Standing |
|---------------|----------|----------|
| Submit a post | `POST /posts` — `{ tx, content }` → `{ postId, status, expiresAtHeight, txId }` | *(write surface)* |
| Like | `POST /likes` — `{ tx }` → `{ status, txId, expiresAtHeight }` | *(write surface)* |
| Standing and balance | `GET /karma/:userId`, `GET /credits/:userId` | *(write surface)* — the spendable view |
| Withdraw content | `POST /posts/:id/withdraw` | not built |
| Prune a subtree | `POST /posts/:id/prune` | not built |
| Vouch, unvouch | `POST /vouches`, `DELETE /vouches/:targetId` | not built |
| Invite | `POST /invites` | not built |
| Invites available | `GET /invites/:userId` | not built |

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
  primitive the read surface lacks.

## Preconditions

- `@dagsocial/node` HTTP API reachable **on the origin serving the client**
- Static assets served, fonts among them — self-hosted, never fetched from a third party

## Invariants

- **A private key never travels to any server.** It is stored, used and exported in the browser, and
  an export is the reader's own file in the shape the demo UI reads. *(write surface)*
- **Every read carries the viewer's key once an identity is loaded, and none does before.** *(write
  surface)*
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
