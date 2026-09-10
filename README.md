# Notis

A decentralized social network where your words stay yours and your reputation
can't be bought.

No corporate servers, no ads, no token sale. Content lives in a DAG where
every post is its author's. Karma and credits live in a Bitcoin-style UTXO
ledger secured by Ed25519 signatures. Proof-of-Work orders it all — no stake,
no committee. Withdrawing your words is a first-class, cryptographically
verifiable operation, not a favor from a moderation team.

*Notis is the network; the code ships under the working scope `@dagsocial/*`.*

**Status:** a node with an HTTP API, libp2p networking and PoW consensus; a browser client that is
a product of its own; a light client; and a public testnet at [notis.fun](https://notis.fun).
Pre-mainnet: consensus formats change freely, and a change to any committed byte starts the
testnet chain again from genesis — an additive change deploys onto the running chain. Node.js ≥ 22,
TypeScript, pnpm. MIT licensed.

---

## The idea

Content and value have different requirements. A threaded reply chain shouldn't
be an immutable ledger entry, and your karma balance shouldn't vanish when
someone deletes a post. So Notis runs two ledgers, each doing what it's good
at, bound by verifiable settlement:

| | Posts DAG | UTXO ledger |
|---|---|---|
| **What it tracks** | Content, replies, who said what | Karma, credits, usernames, who has how much |
| **Who controls it** | Each author controls their own posts | Box owners control their boxes via signatures |
| **Can it be taken back?** | Yes — an author can withdraw a post's content; its place and its replies stay | No — box history is immutable |
| **What it's good at** | Threaded conversation, author sovereignty | Value accounting with cryptographic lineage |

Three properties fall out of this split:

- **Author sovereignty.** Every post is its author's: you decide what you say
  and whether it stays said. A reply belongs to whoever wrote it, and no act —
  not the answered author's — reaches it.
- **Reputation you can't buy.** Karma only moves through protocol actions —
  posts, likes, invites, vouches, burns, decay, rewards. There is no transfer. A
  rich account cannot buy social weight.
- **Withdrawal that settles.** Withdrawing a post is consensus-verified: every
  node — including nodes that never stored the content — independently checks
  who authorized it, from the chain's own record of who wrote the post.

---

## How it works

### Posting

**A post is a transaction, and it pays.** It rides an ordering block's transaction list like every
other one. A thread pays `POST_PRICE_THREAD` karma and a reply `POST_PRICE_REPLY`, of which
`REPLY_AUTHOR_SHARE` goes to the author of the post it answers; the rest returns to the supply pool
in the block's settlement. The price is a resource price, never a judgement: a post people liked has
paid it, and a post nobody saw has paid the same. Nothing returns — withdrawing refunds nothing, and
post → withdraw → repost pays every time.

There is one kind of block: a miner solves an ordering block roughly every 60 seconds, carrying that
block's transactions and the settlement that pays every party the block owes.

Posts link via `parentRefs` (one parent — a forest of threads, still a DAG). Content is 1–300 UTF-8
bytes; what the bytes mean — a link, an image, a quote — is a client's convention, never the node's.

### Likes and karma

Karma is the non-tradeable social currency. **A like is a one-way spend.**
Liking moves `LIKE_KARMA_COST` karma out of your box in an ordinary UTXO
transaction — there is no unlike and no free tier. One like per `(liker, post)`
pair, forever.

The cost never leaves the ledger: it lands in a `LikeAccrualBox` naming the
author, and the block's settlement pays out of it. For every
`LIKES_PER_KARMA_PAYOUT` likes, an author receives all but one as karma — `x`
likes spent mint `x−1` — and the remainder rides an accrual box into the next
block. Every like is therefore slightly deflationary by construction, without a
threshold to reach or a tally to wait for.

**Karma comes from a fixed supply, and nothing creates it.** Every grant draws
on a supply pool and every burn returns to it, so `pool + circulating` is the
same number at every height, forever. Karma is not scarce by policy — it is
non-inflatable by construction. Inactivity decay bleeds dormant accounts down to
a floor and returns what it takes to the pool; any protocol action resets the
clock.

You cannot buy, sell, or transfer karma. That's the point.

### Credits

Credits are the tradeable counterpart, minted to miners by each block's coinbase on an Ergo-style
schedule: a fixed reward for the first two years of blocks, then a stepwise reduction every ~326-day
epoch over 41 epochs. The emission box holds less than the curve's own sum, so it empties while the
curve is still paying — after roughly thirty years at the earliest — and blocks stay producible
beyond that on fees and storage rent alone.

Every coinbase splits by rule: a treasury slice (`COINBASE_TREASURY_PCT` of emission and of fees,
never of rent), the miner's floor, and an inclusion bonus that grows with the number of distinct
actors whose transactions the block carries. The treasury is a box no key can spend and no protocol
rule releases; a future protocol version puts its spending to a karma vote.

Credits transfer freely between identities, pay transaction fees (the relay floor is zero today) and
storage rent; future protocol versions spend them on more — ads, boosts, tips, a username market.

### Membership

Every identity is a **resident**, a **member** or a **root**. A resident — invited, not yet
endorsed — posts, likes and holds karma. A member does everything a resident does and also
**vouches**, staking one karma to stand behind another identity, and **invites**. A root is a
genesis committee key, or the faucet identity on a network that seeds one.

Membership is earned. An identity becomes a member the first time it holds `D` standing vouches
from older members and `Y = 2·D` likes from members, where `D` grows as the cube root of the member
count (`D = max(1, ⌊∛(k·N)⌋)`, with `k` per network — 10 on mainnet, 1 on testnet). A vouch counts
toward newer members only, so every chain of endorsement rests on the roots, and a cell of fake
accounts cannot outlive the real people who backed it. Membership is derived from committed vouches
and likes at every read, never stored as a flag; it lapses only when the vouches counted toward it are
withdrawn, and a lapsed member is a resident again. A root's invitee is a member from its grant, for
life — which is how a chain whose only root is a faucet starts at all.

### Invites

The network is invite-only, and inviting has skin in the game. **The bond is the
request.** Alice locks a bond out of her own karma, choosing an amount within
the network's range, and the block's settlement grants Bob that same amount out
of the supply pool. One bond, one grant — no secret, no separate claim, and
nothing for Bob to do: his account exists the moment his first box does.

Because a newcomer holds nothing and a transaction needs an input, **the invite
is the only way a fresh identity gets its first karma** — on every network.

Only members and roots invite. A member's invites are a budget backed by the endorsements they
hold: the `k`-th invite needs `k·D` standing vouches from older members at the moment it is made,
and a spent invite is never revoked. A root's invites are bounded by its karma alone.

The bond then sits through a probation window and vests against what Bob earns:
every `INVITE_BOND_VEST_PER_LIKES` likes he receives returns one karma of it,
capped at the bond. At the deadline the vested part goes back to Alice and the
remainder returns to the supply pool.

So a careless invite costs real reputation and a good one costs only time, and
because the grant equals the bond, naming 32 bytes nobody holds costs exactly
what it strands.

### Usernames

A username is a soulbound box on the UTXO ledger: 1–24 characters of `[A-Za-z0-9_]`, unique
case-insensitively, shown as typed. Every identity that holds karma has one free claim; a burn
costs `USERNAME_BURN_PRICE` karma and restores the claim. No user transaction moves a name to another
owner — a marketplace paid in credits is a later protocol version. Wherever the API takes an
identity, `@handle` is accepted as an alias for the key.

### Withdrawal that settles

A **withdrawal** is a transaction the author signs, naming the post. At block
application every node verifies that the signer is the consensus-recorded author
of that post — read from the chain's own `block_topology`, never from the post —
so a miner cannot withdraw someone else's words, and a node that never held the
content reaches the same verdict. The content is dropped; the post's identity,
its place in the thread and every reply beneath it stay, and nothing is refunded:
withdrawal is free because the post paid its price when it was posted.

That is the whole of an author's power over a post. No act reaches other
people's replies.

### Consensus and networking

Ordering blocks are mined with PoW at a difficulty the chain retargets itself — an ASERT schedule
read from the chain's own header stamps, no node clock — and on-chain time is block height, never
wall clock. Fork choice scores a competing branch by verified headers up to the network's reorg
horizon; past the horizon a chain does not reorganise. Every block, transaction and post commit
carries a protocol version scheduled by height, so an old object validates under its era's rules and
a new one cannot pose as old.

`@dagsocial/net` runs libp2p with Gossipsub for ordering blocks and UTXO transactions, plus a sync
protocol that moves whole ordering blocks: a fresh node downloads the blocks — which carry every
post's commit and content hash, and enough topology and authorship to verify every settlement — and
fetches post bodies by id afterwards. Peers accrue penalties for misbehaviour and are banned for a
while past a threshold.

Every value movement a block owes — like payouts, the post price's return, invite grants, vested
bonds, decay, a lapsed member's withdrawn vouches — is paid by a single **settlement transaction**
the block carries, derived from the block's own contents. No signer authorizes it; every node
recomputes the same verdict from the same body.

Every block header commits an AVL+ **state root** over the whole UTXO set, so a light client can
verify any box against a chain of headers — and a NiPoPoW proof lets it verify the headers without
downloading them all.

Every protocol number — prices, thresholds, emission, decay, caps — is in one place,
[contracts/CONSTANTS.md](contracts/CONSTANTS.md), with what argues it and its standing.

---

## Security model

What consensus enforces at block application, on every path (gossip, sync,
reorg):

- **Validator signatures** — PoW proves work was spent, the Ed25519 validator
  signature proves who spent it; blocks forging another validator's identity
  are rejected
- **The state root** — every header's committed `stateRoot` is recomputed at
  apply; a body that does not produce it is rejected
- **Withdrawal authorship** — binding a withdrawal to the consensus-recorded
  author (see above); censorship-by-miner is rejected structurally
- **Invite eligibility** — an invite may only name a key that holds no identity
  record, and only a root or a member within its budget may create one; the
  grant equals the bond, so a grant cannot be stranded for free
- **Membership** — derived from committed vouches and likes at every read; the
  settlement withdraws a lapsed member's vouches
- **Coinbase discipline** — reward value, the split and maturity locks are pure
  functions of height and of the block's own contents; deviation rejects the block
- **Embedded transactions** — fully re-validated at apply (signatures, guards,
  conservation); a block producer is untrusted by construction
- **Atomicity** — a rejected block rolls back to a no-op via journaling, and a
  stored row that will not decode stops the node rather than being blamed on a peer

Validation posture: no panics on untrusted input (adversarial bytes get a
`false`, not a crash), and every self-reported claim — hashes, PoW, signatures
— is independently recomputed. Nodes that hold content additionally verify the
chain's committed content hashes against it.

The consensus model — the block architecture, the settlement, validators, the
invariants — is [contracts/ARCHITECTURE.md](contracts/ARCHITECTURE.md). This is
testnet software: don't run it with anything at stake.

---

## Running a node

### From a release

Each [GitHub release](https://github.com/mwaddip/notis/releases) carries four artifacts, every one
preconfigured for testnet:

| Artifact | What it is |
|---|---|
| `notis-node-<ver>-linux-x64.tar.gz` | the node with a bundled Node runtime — unpack, then `./run.sh` for a server node or `./run-miner.sh` for a node that mines; no system Node needed |
| `dagsocial-node_<ver>_amd64.deb` | the node and the faucet service as systemd units for a Debian host with Node ≥ 22; configuration in `/etc/dagsocial/node.env` and `faucet.env` |
| `notis-node-<ver>-win-x64-setup.exe` | a per-user Windows installer with **Notis Node** and **Notis Node (Miner)** shortcuts |
| `notis-web-<ver>.zip` | the browser client, a static bundle configured after download (→ Web client) |

The Windows installer is unsigned, so SmartScreen warns on first run.

### Build

```bash
pnpm install
pnpm build
pnpm typecheck
```

### Local dev loop

```bash
pnpm dev                       # one devnet node + one miner
pnpm dev --nodes 3             # three meshed nodes, a miner each
pnpm dev --miners 3            # three miners racing on one node
```

Generates a throwaway mining secret, spawns everything, and tears it all down
on Ctrl-C. Databases go to a temporary directory and are not reused.

### Running a node

```bash
pnpm -r build
node packages/node/dist/index.js
```

That is the whole of it: the defaults are testnet, a `server` role, port 3000 and `dagsocial.db` in the
current directory, and the testnet profile names the network's bootstrap node (`notis.fun`), so the
node dials it, syncs the chain and follows new blocks. The node serves no UI: it is an HTTP API, and
the browser client is a separate product served beside it (→ Web client below). Karma for a fresh
identity comes from the public faucet through that client at `https://notis.fun/web/` — use the same
key there; the grant is on-chain, so your node sees it once the block that carries it syncs.

To mine as well:

```bash
NETWORK_TYPE=testnet NODE_ROLE=miner MINING_SECRET=<secret> node packages/node/dist/index.js
```

**A miner node serves templates and solves nothing itself.** There is no
in-process solver, so `NODE_ROLE=miner` requires a `MINING_SECRET` — the node
refuses to start without one, and the mining API has no unauthenticated mode.
A node started as `server` applies blocks from peers and exposes no `/mining`
routes at all.

Blocks appear when a miner solves one. Difficulty sets the pace, so the
interval is a property of the network's total hashrate rather than a setting.

### Split mining (separate miner machine)

The point of the split is running a node on a VPS without burning its CPU (or
its ToS): the node builds templates, another machine solves them.

**VPS node:**

```bash
NODE_ROLE=miner MINING_SECRET=<secret> node packages/node/dist/index.js
```

**Miner machine:**

```bash
NODE_URL=https://your-node.example.com/testnet/api MINER_PCT=25 MINING_SECRET=<secret> node packages/node/scripts/miner.mjs
```

`MINER_PCT` throttles CPU within a solve (0–100, default 25); it does not
pace the interval between blocks, since a solve that finishes inside one work
window never reaches the sleep. `MINER_PUBKEY` names the key the coinbase pays;
unset, the reward goes to the node's own validator key. The miner is a single zero-dependency
script — no repo checkout needed, just Node.js ≥ 22. A reference systemd unit
is at `packages/node/scripts/dagsocial-miner.service`.

It re-reads the template as it works and abandons a solve once the tip moves,
so a lost race costs one work window rather than a whole block.

### Environment variables

**Consensus parameters are not configurable.** PoW targets, emission, decay,
karma constants and AVL key length come from the **network profile** selected by
`NETWORK_TYPE` — they are properties of the network, not of the operator, and
two nodes that disagreed on them would partition permanently. Setting them by
environment is not merely discouraged, it has no effect.

| Variable | Default | Description |
|---|---|---|
| `NETWORK_TYPE` | `testnet` | `mainnet`, `testnet` or `devnet`. Selects the consensus profile. **An unrecognised value throws at startup** rather than defaulting. |
| `PORT` | `3000` | HTTP API port |
| `ADMIN_PORT` | `3001` | The admin listener (`/health`, `/stats`). **Unauthenticated** — keep it on loopback |
| `ADMIN_BIND_ADDRESS` | `127.0.0.1` | Admin listener bind address |
| `DB_PATH` | `dagsocial.db` | SQLite database path |
| `NODE_ROLE` | `server` | `server` (applies peer blocks) or `miner` (produces blocks) |
| `MINING_SECRET` | — | Bearer token for the mining API. Required non-empty when `NODE_ROLE=miner` — startup fails without it. Unused on a server node |
| `BOOTSTRAP_PEERS` | the profile's (testnet: `/dns4/notis.fun/tcp/9733`) | Comma-separated libp2p multiaddrs; when set, replaces the profile's list |
| `LISTEN_ADDRS` | `/ip4/0.0.0.0/tcp/0` | libp2p listen addresses |
| `WEB_SHELL_PATH` | — | Path of the web client's `index.html`; empty means `GET /shell/:id` answers 404 |
| `VERIFY_STATE_ROOT` | `true` | Verify each block's committed `stateRoot` at apply. `false` removes the sole backstop against a body that differs from its header's |
| `BLOCK_BODY_BUDGET_BYTES` | the protocol cap | Body bytes this node fills the blocks **it produces** to; clamped to the cap |
| `MAX_MEMPOOL_ENTRIES` | `10000` | Mempool capacity; submissions beyond it are refused |
| `MIN_FEE_RATE_PER_BYTE` | `0` | Relay fee floor per in-block byte — admission policy, not consensus |
| `MAX_PEERS` | `50` | Connected peer ceiling |
| `MIN_PEERS` | `3` | Outbound fill floor |
| `PEER_DB_CAP` | `1000` | Soft cap on remembered peers |
| `OUTBOUND_REDIAL_COOLDOWN_MS` | `60000` | Redial cooldown per failed outbound target |
| `PENALTY_SCORE_THRESHOLD` | `500` | Accrued penalty that trips a temporal ban |
| `TEMPORAL_BAN_DURATION_MS` | `3600000` | Temporal ban length |
| `PENALTY_SAFE_INTERVAL_MS` | `120000` | Quiet interval after which accrued penalty decays |
| `SYNC_REQUEST_TIMEOUT_MS` | `10000` | Abort timeout on one sync request |
| `MAX_PROOF_HISTORY` | `1440` | AVL+ versions retained for proof serving; never below the profile's reorg horizon |

> An environment variable the table above does not name is ignored — the table
> is the whole read surface (`NODE_INTERFACE` → Configuration).

### The faucet

`tools/faucet` is the service that invites on testnet and devnet. It holds an ordinary Ed25519 key
and does what any member can do: `POST /faucet/karma` invites a key with a bond, `POST /faucet/credits`
sends credits, both rate-limited per IP. No consensus rule names it, and the node serves no faucet
route of its own. It reads `NODE_URL`, `NETWORK_TYPE`, `FAUCET_KEY_PATH`, `FAUCET_PUBLIC_KEY`,
`FAUCET_BOND_AMOUNT`, `FAUCET_CREDIT_AMOUNT`, `PORT` and `RATE_LIMIT_PER_HOUR`; the `.deb` installs it
as `dagsocial-faucet`, stopped until its key is in place.

### Web client

`packages/web` is the browser client — the feed, threads, a tiling workspace, and the write
surface on transactions the browser builds and signs: posts and replies, likes, vouches, invites,
withdrawals, a username claimed or burned. It is a product of its own: the node serves no client,
and this one is an implementation of the API's client side that another may be written against.
It is a static bundle that must be served **from the same origin as the node's API**: the node
sends no CORS headers, so a client on any other origin cannot read it. On notis.fun nginx fronts
both, the API under `/testnet/api/` and the client under `/web/`; a node run on its own has no UI
until something serves the client beside it.

**Get it from a release** — `notis-web-<ver>.zip` — or build the same zip yourself with
`bash packages/web/scripts/build-release.sh`. Inside, `web/` is the bundle, `nginx.example.conf` a
complete vhost excerpt, and `README.txt` the serving note.

**The deployment is four values in the head of `web/index.html`**, and the release ships them set
for notis.fun's layout:

```html
<base href="/web/">
<meta name="notis-api" content="/testnet/api">
<meta name="notis-faucet" content="/testnet/faucet">
<meta property="og:image" content="https://notis.fun/web/og.png">
```

They name the path the client is served under (opening and closing with `/`), the API's path on the
same origin, the faucet's — empty for no faucet and no faucet button — and the preview picture's
absolute URL (`<origin><base>og.png`). A host with another layout edits those four values and nothing
else: every reference in the bundle is relative to the base. A reader can still point their own
browser at another node or faucet from the profile window's preferences.

Serve `web/` as static files with no SPA fallback — a path that is not a file is a 404. The one path
the client owns beyond its files is a post's standalone page, `<base>p/<post id>`, which opens that
thread alone. Two ways to serve it:

- **With a link preview.** Set `WEB_SHELL_PATH` in the node's environment to the bundle's
  `index.html`, and have nginx proxy `<base>p/<id>` to the node's `GET /shell/<id>`, sending
  `X-Original-URI`. The node answers the client's own shell with that post's Open Graph tags
  injected, so a chat app previews the link and the client boots from the same response.
- **Without one.** Serve the shell plain for the same path (`try_files /web/index.html`). The thread
  opens; the link carries no preview.

`packages/web/deploy/nginx.example.conf` is the vhost excerpt with both variants, the API and
faucet proxies included. Building by hand, the same four values are written by `VITE_PUBLIC_ORIGIN`,
`VITE_WEB_BASE`, `VITE_API_BASE` and `VITE_FAUCET_BASE` at `npx vite build` in `packages/web`. In development none
of this is needed: `pnpm --filter @dagsocial/web dev` proxies the API and serves the shell for
`/p/<id>` on its own (`NOTIS_NODE` and `NOTIS_FAUCET` point the proxy at a node and a faucet).

A fresh identity needs an invite from an existing member; on testnet the faucet grants one through
the client's profile window.

### Light client

`tools/nipopow-client` trusts a chain without holding it: it fetches NiPoPoW proofs from two or more
nodes (`NODE_URLS`), verifies and compares them, and proves a key's boxes against the winning
proof's `stateRoot`. The trust model it embodies is `contracts/NIPOPOW_INTERFACE.md`.

---

## API

Everything is JSON over HTTP, hex for byte-valued fields: posts and threads, withdrawal, likes,
vouches, invites, usernames, the karma, credit and invite views of an identity, credit transfer,
blocks and status, AVL+ box proofs (`GET /api/v1/proof/:boxId`), NiPoPoW proofs
(`GET /nipopow/proof/:m/:k`), link previews (`GET /shell/:id`), the authenticated mining endpoints
of a miner node, and `/health` and `/stats` on the admin port. Wherever a route takes an identity,
`@handle` is accepted for the key.

**The node serves no faucet and no client.** It holds no key it could sign a grant with, no
consensus rule names a privileged signer, and `GET /` answers 404 — the faucet is an ordinary
account in a service outside the node, and the client is a static bundle served beside it.

The authoritative route reference is [contracts/NODE_INTERFACE.md](contracts/NODE_INTERFACE.md) —
request and response shapes, error codes, and preconditions for every endpoint.

---

## Development

```bash
pnpm build          # Build every workspace member
pnpm test           # Every member's suite — includes the e2e mesh, which spawns BUILT nodes: build first
pnpm typecheck      # Type-check every member, src and test trees
```

The gate before a commit is `pnpm -r build && pnpm -r typecheck && pnpm -r test`: tests resolve
`@dagsocial/*` to `src`, so a green suite does not prove a package builds.

**Ten workspace members** (`packages/*` and `tools/*`), in dependency order:

- **`@dagsocial/wire`** — stream framing: VLQ, blake2b checksums, magic bytes.
- **`@dagsocial/types`** — data structures, base58, the positional codecs, hashing, protocol
  constants, box selection. Pure functions only.
- **`@dagsocial/validation`** — pure stateless checks: PoW, signatures, block structure, Merkle
  roots. No panics on untrusted input.
- **`@dagsocial/nipopow`** — NiPoPoW proofs over the header chain: the proof codecs, the verifier,
  the comparator, the prover a node serves.
- **`@dagsocial/net`** — libp2p + Gossipsub relay, whole-block sync, peer discovery and penalties.
- **`@dagsocial/node`** — Express server, UTXO engine, SQLite store, AVL+ state root, block creator,
  the per-block settlement transaction, decay.
- **`@dagsocial/web`** — the browser client, built with vite.
- **`@dagsocial/faucet`** (`tools/faucet`) — the invite service.
- **`@dagsocial/e2e`** (`tools/e2e`) — the mesh suite: spawns built nodes and asserts the protocol
  across them over HTTP.
- **`@dagsocial/nipopow-client`** (`tools/nipopow-client`) — the light client.

### Contracts

Design-by-Contract workflow: the `contracts/` directory is the source of truth
for every interface, and contracts are updated **before** implementation code.

| Document | Covers |
|---|---|
| `contracts/ARCHITECTURE.md` | System architecture, invariants, protocol versioning, the deploy gate |
| `contracts/CONSTANTS.md` | Every protocol number, with what argues it and its standing |
| `contracts/TYPES_INTERFACE.md` | Data structures, hashing, serialization, network profiles |
| `contracts/VALIDATION_INTERFACE.md` | Stateless validation functions |
| `contracts/NODE_INTERFACE.md` | HTTP API, verifier, store, block application |
| `contracts/MEMPOOL_INTERFACE.md` | Mempool semantics |
| `contracts/MINING_INTERFACE.md` | Emission, PoW, the difficulty schedule, the mining API |
| `contracts/NIPOPOW_INTERFACE.md` | NiPoPoW proofs: codecs, verifier, comparator, prover, the trust model |
| `contracts/NET_INTERFACE.md` | Gossip, sync, peer management |
| `contracts/WIRE_INTERFACE.md` | Frame and message codec |
| `contracts/JOURNAL_EVENTS.md` | Block journal events |
| `contracts/WEB_INTERFACE.md` | The browser client |
| `contracts/HOUSE_STYLE.md` | Colour, type, the mark, motion, spacing, voice |
| `contracts/SPECIAL.md` | Per-subsystem attention weights for review |

---

## Roadmap

Built: the dual ledger; ordering-block consensus with a derived per-block settlement; the post
price; likes as one-way karma spends with per-block accrual; invites with bonds and a budget;
membership earned by vouches and likes; usernames; verifiable withdrawal; karma decay against a
fixed supply pool; credit emission with the coinbase split, fees and storage rent; an AVL+ state
root with box proofs, NiPoPoW proofs and a light client; the ASERT difficulty schedule; the reorg
horizon; the protocol version schedule; libp2p networking with whole-block sync and header-scored
fork choice; split mining; a browser client with its write surface; release packaging.

Deferred to future protocol versions: credit sinks (ads, boosts, tips); reply earning;
karma-proportional PoW; storage pruning for lean nodes; view keys; parameter governance and treasury
spending by karma vote; replacement of a pooled transaction by a higher-paying one; the username
marketplace; username proofs in the light client; release of a name whose holder's karma is gone; a
live fee market (the mechanism ships; the rate is 0).
