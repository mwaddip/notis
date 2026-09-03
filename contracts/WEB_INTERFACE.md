# WEB Interface Contract

**Component:** `@dagsocial/web`
**Status:** the **read surface** is implemented; identity, signing and every write are not built
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

**It sends no `viewer` parameter**, because it has no identity to name. Every `likedByViewer` it
receives is therefore `null`, and that is the correct value for an anonymous reader rather than a
placeholder for one.

### The write surface — not built

Identity, signing, the composer, likes, vouches, invites, the profile window and export are named in
this contract's later sections and **none of them exists**. Each is marked where it appears.

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

## Client-side operations — the write surface, not built

| Operation | Algorithm | Notes |
|-----------|-----------|-------|
| Key generation | Web Crypto `crypto.subtle.generateKey('Ed25519')` | Public key exported as raw 32 bytes |
| Signing | Web Crypto `crypto.subtle.sign('Ed25519')` | Raw 64-byte signature over the transaction's `TxId` |
| Post ID | `computePostId(txId, index)` — the algorithm `@dagsocial/types` implements | The client MAY derive it for optimistic display; the node is authoritative |

⛔ **There is no client proof of work and no challenge.** Posting is a karma-priced UTXO transaction:
karma boxes in, change out, a `KarmaPriceBox` carrying the price, and for a reply a `LikeAccrualBox`
carrying the parent author's share. The post rides inside that transaction — `postFieldBytes` is in
the `computeTxId` preimage — so the signature covers the post and a relay can no more rewrite it than
it can re-point a like.

## Writes — not built

| Client action | Endpoint |
|---------------|----------|
| Submit a post | `POST /posts` — `{ tx, content }` |
| Like | `POST /likes` |
| Withdraw content | `POST /posts/:id/withdraw` |
| Prune a subtree | `POST /posts/:id/prune` |
| Vouch, unvouch | `POST /vouches`, `DELETE /vouches/:targetId` |
| Invite | `POST /invites` |
| Standing and balance | `GET /karma/:userId`, `GET /credits/:userId` |
| Invites available | `GET /invites/:userId` |

**There is no identity registration endpoint.** A key is created in the browser and becomes known to
the node by appearing as the author of a transaction the node accepts. No route registers one, and a
client that expects to announce itself first is built against an endpoint that does not exist.

## Dependencies

- **No WASM.** Pure-TS only, per the preference order the project holds for every package.
- No server-side rendering — a static bundle served same-origin with the API.
- Modern browser. Web Crypto `Ed25519` is a **write-surface** requirement and gates nothing that reads.

## Preconditions

- `@dagsocial/node` HTTP API reachable **on the origin serving the client**
- Static assets served, fonts among them — self-hosted, never fetched from a third party

## Invariants

- **A private key never leaves the browser.** *(write surface)*
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
