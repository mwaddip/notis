# Notis

A decentralized social network where your words stay yours and your reputation
can't be bought.

No corporate servers, no ads, no token sale. Content lives in a prunable DAG
that each author controls. Karma and credits live in a Bitcoin-style UTXO
ledger secured by Ed25519 signatures. Proof-of-Work orders it all — no stake,
no committee. Deleting your thread is a first-class, cryptographically
verifiable operation, not a favor from a moderation team.

*Notis is the network; the code ships under the working scope `@dagsocial/*`.*

**Status:** a single-binary node with HTTP API, libp2p networking, PoW
consensus, and a demo UI, running a public testnet. Pre-network: consensus
formats still change freely between versions, and a change to any committed
byte starts the chain again from genesis. Node.js ≥ 22, TypeScript, pnpm.
MIT licensed.

---

## The idea

Content and value have different requirements. A threaded reply chain shouldn't
be an immutable ledger entry, and your karma balance shouldn't vanish when
someone deletes a post. So Notis runs two ledgers, each doing what it's good
at, bound by verifiable settlement:

| | Posts DAG | UTXO ledger |
|---|---|---|
| **What it tracks** | Content, replies, who said what | Karma, credits, who has how much |
| **Who controls it** | Each author controls their own subtree | Box owners control their boxes via signatures |
| **Can it be deleted?** | Yes — authors can prune their content | No — box history is immutable |
| **What it's good at** | Threaded conversation, author sovereignty | Value accounting with cryptographic lineage |

Three properties fall out of this split:

- **Author sovereignty.** Every post is the root of its own subtree. Replying
  to someone is consent: they can prune the whole tree later, replies included.
  That cascade is the privacy model — replies leak what the root said, so
  deletion that leaves them behind isn't deletion.
- **Reputation you can't buy.** Karma only moves through protocol actions —
  likes, invites, rewards, decay, burns. There is no transfer. A rich account
  cannot buy social weight.
- **Deletion that settles.** Pruning a subtree is consensus-verified: every
  node — including nodes that never stored the content — independently checks
  who authorized it and settles the karma locked inside it.

---

## How it works

### Posting

**A post is a transaction.** It rides an ordering block's transaction list like
every other one, locking a little karma as skin in the game and paying a fee at
the network's rate. There is one kind of block: a miner solves an ordering block
roughly every 60 seconds, carrying that block's transactions, its prune entries,
and the settlement that pays every party the block owes.

Posts link via `parentRefs` (one parent — a forest of threads, still a DAG).
Content is 1–300 UTF-8 bytes. The lock releases back to the author as the post
accumulates likes.

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

Credits are the tradeable counterpart, earned by miners through coinbase
emission with an Ergo-style linear decay schedule (fixed rate, then stepwise
reduction, then a flat tail — ~31 years of emission). A treasury split is
optional. Credits transfer freely between identities; future protocol versions
spend them (ads, boosts, tips).

### Invites

The network is invite-only, and inviting has skin in the game. **The bond is the
request.** Alice locks a bond out of her own karma, choosing an amount within
the network's range, and the block's settlement grants Bob that same amount out
of the supply pool. One bond, one grant — no secret, no separate claim, and
nothing for Bob to do: his account exists the moment his first box does.

Because a newcomer holds nothing and a transaction needs an input, **the invite
is the only way a fresh identity gets its first karma** — on every network.

The bond then sits through a probation window and vests against what Bob earns:
every `INVITE_BOND_VEST_PER_LIKES` likes he receives returns one karma of it,
capped at the bond. At the deadline the vested part goes back to Alice and the
remainder returns to the supply pool.

So a careless invite costs real reputation and a good one costs only time. The
bond is the network's only sybil price, and because the grant equals it, naming
32 bytes nobody holds costs exactly what it strands.

### Deletion that settles (stumps)

Pruning is where the two ledgers meet, and it's consensus-critical: the karma
locked in a subtree (post locks, pending likes) must be settled identically on
every node, even nodes that never had the content.

A **PruneEntry** in the ordering block carries the pruned post-id set, a Merkle
root over it, and the root author's Ed25519 signature. At block application
every node verifies:

1. **Authorship** — the entry's author *is* the consensus-recorded author of
   the root, read from the chain's own `block_topology` rather than from the
   post. "Who owns this subtree" is therefore chain data, not content data — a
   miner cannot prune someone else's thread
2. **Signature** — the root author signed this exact prune
3. **Topology** — the post-id set matches the confirmed reply tree
4. **Merkle root** — the set is exactly what was signed
5. **Settlement** — locked boxes are consumed and refunds minted,
   deterministically from UTXO state

What remains is a **stump**: a compact record that the subtree existed and
what it earned. The content itself is gone network-wide — nodes propagate
stumps, not archives.

### Consensus and networking

Ordering blocks are mined with PoW at a height-scheduled difficulty (on-chain
time is block height, never wall clock). Fork choice is cumulative work. The
`@dagsocial/net` package runs libp2p with Gossipsub for ordering blocks and
UTXO transactions, plus a sync protocol that moves whole ordering blocks: a fresh node downloads
ordering blocks only — block entries carry enough topology and authorship to
verify all settlement without any post content.

Every value movement a block owes — like payouts, invite grants, vested bonds,
decay, prune refunds — is paid by a single **settlement transaction** the block
carries, derived from the block's own contents. No signer authorizes it; every
node recomputes the same verdict from the same body.

Exact parameters (lock amounts, thresholds, emission, decay) are protocol
constants documented in [contracts/ARCHITECTURE.md](contracts/ARCHITECTURE.md).

---

## Security model

What consensus enforces at block application, on every path (gossip, sync,
reorg):

- **Validator signatures** — PoW proves work was spent, the Ed25519 validator
  signature proves who spent it; blocks forging another validator's identity
  are rejected
- **Prune authorship** — binding a prune to the consensus-recorded root author
  (see above); censorship-by-miner is rejected structurally
- **Invite eligibility** — an invite may only name a key that is not already an
  account, tested against consensus state rather than a local ledger; and the
  bond must cover the grant it creates, so a grant cannot be stranded for free
- **Coinbase discipline** — reward value, treasury split, and maturity locks
  are pure functions of height; deviation rejects the block
- **Embedded transactions** — fully re-validated at apply (signatures, guards,
  conservation); a block producer is untrusted by construction
- **Atomicity** — a rejected block rolls back to a no-op via journaling

Validation posture: no panics on untrusted input (adversarial bytes get a
`false`, not a crash), and every self-reported claim — hashes, PoW, signatures
— is independently recomputed. Nodes that hold content additionally verify the
chain's claims against it, keeping dishonest blocks out of the canonical chain
for everyone else.

The consensus model, including the trust story for nodes that sync without
content, is documented in [docs/CONSENSUS.md](docs/CONSENSUS.md). The commit
history carries an ongoing, audit-driven hardening pass over the consensus
surface — this is devnet software under active adversarial review, not a
finished protocol. Don't run it with anything at stake yet.

---

## Running a node

### Build

```bash
pnpm install
pnpm build
pnpm typecheck
```

### Local dev loop

```bash
pnpm dev                          # one devnet node + one miner
pnpm dev -- --nodes 3             # three meshed nodes, a miner each
pnpm dev -- --miners 3            # three miners racing on one node
```

Generates a throwaway mining secret, spawns everything, and tears it all down
on Ctrl-C. Databases go to a temporary directory and are not reused.

### Running a node

```bash
NETWORK_TYPE=testnet NODE_ROLE=miner MINING_SECRET=<secret> node packages/node/dist/index.js
```

Starts a node on `http://localhost:3000` with the demo UI at the same address.

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
window never reaches the sleep. The miner is a single zero-dependency script —
no repo checkout needed, just Node.js ≥ 22. A reference systemd unit is at
`packages/node/scripts/dagsocial-miner.service`.

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
| `PORT` | 3000 | HTTP API port |
| `DB_PATH` | `dagsocial.db` | SQLite database path |
| `NODE_ROLE` | `server` | `server` or `miner` |
| `BOOTSTRAP_PEERS` | (empty) | Comma-separated libp2p multiaddrs |
| `LISTEN_ADDRS` | `/ip4/0.0.0.0/tcp/0` | libp2p listen address |
| `MAX_PEERS` | — | Peer connection ceiling |
| `MAX_MEMPOOL_ENTRIES` | — | Mempool capacity; submissions beyond it are refused |
| `MAX_PROOF_HISTORY` | — | Retained AVL+ proof history depth |
| `VERIFY_STATE_ROOT` | on | Verify each block's committed `stateRoot` at apply |
| `MINING_SECRET` | — | Bearer token for the mining API. Required non-empty when `NODE_ROLE=miner` — startup fails without it. Unused on a server node. |
| `ADMIN_PORT` / `ADMIN_BIND_ADDRESS` | — | Separate bind for admin endpoints |
| `PUBLIC_URL` | `/` | Base path for the demo UI (e.g. `/testnet/` behind nginx) |

> An environment variable the table above does not name is ignored — the table
> is the whole read surface (`NODE_INTERFACE` → Configuration).

### Demo UI

Open `http://localhost:3000` (behind nginx with path isolation: UI at
`/testnet/`, API at `/testnet/api/`). Single HTML page, vanilla JS, no build
step. Create an identity, post, like, invite, transfer credits. Click a post's
timestamp for thread view — full ancestor chain and reply tree — and copy a
shareable link with OG metadata for rich previews in chat apps.

A fresh identity needs an invite from an existing member; on testnet and devnet
that is what the faucet service is for, and it runs outside the node.

---

## API

Everything is JSON over HTTP: identities, posts, threads, likes, invites,
vouches, credits, block queries, AVL+ UTXO proofs (`/api/v1/proof/:boxId`), OG
link previews, and the authenticated mining endpoints. The demo UI exercises the
whole surface.

**The node serves no faucet.** It holds no key it could sign one with, and no
consensus rule names a privileged signer — a faucet is an ordinary account whose
key lives in a service outside the node.

The authoritative route reference lives in
[contracts/NODE_INTERFACE.md](contracts/NODE_INTERFACE.md) — request/response
shapes, error codes, and preconditions for every endpoint. (This README used
to duplicate it; the duplicate drifted, the contract doesn't.)

---

## Development

```bash
pnpm build          # Build all 5 packages
pnpm test           # Every package's suite
pnpm typecheck      # Type-check all packages, src and test trees
```

**Six packages:**

- **`@dagsocial/types`** — data structures, hashing, base58, CBOR, protocol
  constants, UTXO selection. Pure functions only.
- **`@dagsocial/validation`** — pure stateless checks: PoW, signatures, block
  structure, Merkle roots. No panics on untrusted input.
- **`@dagsocial/nipopow`** — NiPoPoW proofs over the header chain: the proof
  codecs, the verifier, the comparator, the prover a node serves.
- **`@dagsocial/wire`** — stream framing (VLQ, blake2b checksums, magic
  bytes), shared by net and node.
- **`@dagsocial/net`** — libp2p + Gossipsub relay with two-stage validation,
  whole-block sync, peer discovery and scoring.
- **`@dagsocial/node`** — Express server, UTXO engine, SQLite store, AVL+ state
  root, block creator, the per-block settlement transaction, decay, demo UI.

### Contracts

Design-by-Contract workflow: the `contracts/` directory is the source of truth
for every interface, and contracts are updated **before** implementation code.

| Document | Covers |
|---|---|
| `contracts/ARCHITECTURE.md` | System architecture, invariants, protocol parameters |
| `contracts/TYPES_INTERFACE.md` | Data structures, hashing, serialization |
| `contracts/VALIDATION_INTERFACE.md` | Stateless validation functions |
| `contracts/NODE_INTERFACE.md` | HTTP API, verifier, store, block application |
| `contracts/MEMPOOL_INTERFACE.md` | Mempool semantics |
| `contracts/MINING_INTERFACE.md` | Emission, PoW, difficulty, mining API |
| `contracts/NET_INTERFACE.md` | Gossip, sync, peer management |
| `contracts/WIRE_INTERFACE.md` | Frame and message codec |
| `contracts/JOURNAL_EVENTS.md` | Block journal events |
| `contracts/HOUSE_STYLE.md` | Colour, type, the mark, motion, spacing, voice |
| `contracts/SPECIAL.md` | Per-subsystem attention weights for review |
| `contracts/WEB_INTERFACE.md` | Web client, ahead of the code |

---

## Roadmap

Built: the dual ledger, ordering-block consensus with a derived per-block
settlement, verifiable pruning, likes as per-block karma spends, invites with
bonds, vouches, karma decay against a fixed supply pool, credit emission,
transaction fees, AVL+ state root with light-client proofs, libp2p networking
with whole-block sync and header-scored fork choice, split mining, demo UI.

Deferred to future protocol versions: credit sinks (ads, boosts, tips), reply
earning, karma-proportional PoW, storage pruning for lean nodes, view keys,
parameter governance, a live fee market (the mechanism ships; the rate is 0).
