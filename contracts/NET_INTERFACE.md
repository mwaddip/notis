# NET Interface Contract

**Component:** `@dagsocial/net`
**Protocol version:** 2
**Last updated:** 2026-08-01

## Scope

libp2p-based peer-to-peer networking for DAGsocial. Owns: wire framing,
handshake, header-first historical sync, peer discovery, sub-block gossip,
ordering block gossip, UTXO transaction relay, and peer penalty management.

Depends on `@dagsocial/wire` for ByteReader/ByteWriter/VLQ/frame encode-decode
stream framing, `@dagsocial/validation` for Stage 1 (stateless) validation,
and `@dagsocial/types` for wire types.

---

## Wire Framing

Every stream message is wrapped in a frame. Gossipsub messages are **not**
framed — they carry raw CBOR directly on the wire as before.

### Frame Format

```
[magic:4][version:1][code:VLQ][length:VLQ][checksum:4][body:length]
```

| Field | Size | Description |
|-------|------|-------------|
| magic | 4 bytes | Network identifier |
| version | 1 byte | Framing version. Independent of app `protocolVersion`. Starts at `1`. |
| code | VLQ | Message type identifier |
| length | VLQ | Body length in bytes (0 = empty body) |
| checksum | 4 bytes | First 4 bytes of `blake2b256(body)` |
| body | `length` bytes | CBOR-encoded payload |

### Magic Bytes

| Network | Magic | Bytes |
|---------|-------|-------|
| mainnet | "MDAG" | `0x4D 0x44 0x41 0x47` |
| testnet | "TDAG" | `0x54 0x44 0x41 0x47` |
| devnet | "DDAG" | `0x44 0x44 0x41 0x47` |

**The magic is a field of the network profile** (`TYPES_INTERFACE §Network profiles`),
resolved once at startup from `NETWORK_TYPE`. It is never a per-call-site default.

> ✅ **RESOLVED — verified 2026-08-10, re-verified 2026-08-11 and the last two caveats closed
> with it.** All four links below were annotated ✅ as they closed; only this verdict line was
> never updated, so a skim read an open defect while a careful read showed it fully resolved.
> The two caveats that were still open in 2026-08-10 — the test-side typecheck hole and the
> "separation does not exist" conclusion — are **both closed as of this pass**; see below.
>
> **The record — this was VIOLATED, measured 2026-08-06, and is closed.** No `⚠`: every link
> below resolved, and a `⚠` here would read as open work. At the time the magic was not a
> fallback but the only path, and every node framed as mainnet on every network,
> unconditionally. Four links:
>
> 1. **This contract declares `magic: number`** (required). **The code declared it optional**
>    (`magic?` on `NetConfig` in `net/src/types.ts`) — a pre-existing contract/code drift.
>    ✅ **Closed by P2-A phase 3b** — the field is required.
> 2. **The only caller never passed it.** `node/src/index.ts` constructed `NetConfig` with
>    eleven fields; `magic` was not among them. ✅ **Closed by P2-A phase 2b** — node resolves
>    the profile and passes `config.profile.magic` at the single construction site.
> 3. Ten sites therefore always took `?? MAGIC_MAINNET` — nine in `node.ts`, one in
>    `sync-machine.ts`. ✅ **Closed by P2-A phase 3b** — all ten deleted; a missing `magic`
>    is now a compile error.
> 4. `NETWORK_MODE` fed none of them. ✅ **Closed by P2-A phase 2b** — `NETWORK_TYPE` selects
>    the profile, and the profile carries the magic.
>
> ✅ **RESOLVED — the test-side hole in link 3 is closed too. Verified 2026-08-11.** This note
> used to warn that link 3 covered production callers only, because `net`'s `typecheck` was
> `tsc --noEmit` over `"include": ["src"]`, leaving no test-side `NetConfig` literal statically
> enforced. **That is no longer so:** net's `typecheck` script is
> `tsc --noEmit && tsc --noEmit -p tsconfig.test.json`, and `tsconfig.test.json` declares
> `"include": ["src", "test"]`. The fix it asked for landed and was recorded in
> `ARCHITECTURE.md` §Build and test resolution — **but never propagated back to this note**,
> which went on describing the gap for as long as it took Phase 9 to read both.
>
> ✅ **RESOLVED — the transport separation now EXISTS, and this note's conclusion was inverted.
> Verified 2026-08-11.** It ended *"the transport separation this table describes does not exist
> at all; `MAGIC_TESTNET` has no production consumer … testnet and mainnet peers assemble each
> other's frames today."* All three clauses are false now. `MAGIC_TESTNET` is carried by the
> **testnet profile itself** (`types/src/network.ts`, `magic: MAGIC_TESTNET`) and re-exported
> through `net/src/frame.ts` and `net/src/index.ts`; node passes `config.profile.magic`, so a
> testnet node frames as testnet. The classifier in `bogus-addr.ts` is no longer its only
> reference.
>
> **`NetConfig.magic` becomes required, with no fallback.** A default is the wrong shape
> here — an unset network is not a mainnet node, it is a misconfigured one, and defaulting
> silently resolves it toward the network where being wrong costs the most. Making it
> required turns link 2 into a compile error at the single construction site.
>
> `node/src/index.ts:145-146` already carries a comment about exactly this failure mode for
> the peer parameters — *"their defaults as binding only when node supplies them — unset,
> net's internal fallbacks silently govern instead."* The observation was written down and
> `magic` was not fixed.

> ⚠ **The canonical magic set must be imported from `@dagsocial/types`, never re-declared.**
> It was a local literal `[MAGIC_MAINNET, MAGIC_TESTNET]` in `net/src/node.ts` until P2-A
> phase 3a.
>
> **The precise failure mode, because the obvious reading is wrong.** `KNOWN_FRAME_MAGICS` is
> consulted **only for frames that fail the own-magic compare** — it distinguishes *a frame
> from another network* from *a payload that is not a frame at all*. So a stale set does
> **not** break same-network peering: devnet↔devnet frames share `MAGIC_DEVNET`, match on the
> own-magic compare, and never reach the set.
>
> The damage is **cross-network**. A devnet peer reaching a mainnet or testnet node fails the
> own-magic compare, is not found in the stale set, is therefore classified as not-a-frame,
> falls through to the legacy raw-CBOR path, decodes as malformed, and is **permanently
> banned** — where the correct outcome is a polite wrong-network close. A stale set converts
> a routine misconfiguration into a ban.
>
> Note this is **latent until per-profile magics are actually supplied** (P2-A phase 3b).
> While every node frames as mainnet, no devnet magic ever reaches the wire.
>
> ⚠ **Both the magics and the canonical set come from `@dagsocial/types`, not
> `@dagsocial/wire`.** They move there in P2-A phase 5, beside `NetworkProfile` — wire's
> frame functions take `magic` as a parameter and never read the constants, and wire keeps
> its zero runtime dependencies, so the table cannot live there. Net's imports of
> `MAGIC_MAINNET` / `MAGIC_TESTNET` from `./frame.js` re-point to `@dagsocial/types`.
> **This reverses the pre-audit follow-up that said wire should own the canonical set** —
> that note predates the profile table.

### Version Negotiation

On receiving a frame with an unsupported version:
- **Major version higher**: close the stream. The peer is using a newer framing
  protocol. Not a penalty — the peer may support an older version on retry.
- **Minor version higher**: accept. Forward-compat — unknown fields in the body
  are ignored.

Version 1 is the baseline. A frame version bump means an incompatible change
to the envelope structure (not the message bodies).

### Design Decisions

- **Version byte before VLQ fields**: the framing layer can evolve independently
  (e.g., switch to fixed-width lengths or a different checksum).
- **Checksum after length**: parser knows the body size before verifying — can
  allocate once.
- **VLQ for code**: message type namespace effectively unlimited.
- **VLQ for length**: handshake (~100 bytes) encodes in 1 byte; block response
  (~100KB) encodes in 3 bytes.
- **Body is CBOR**: consistent with existing gossip encoding. No second
  serialization format.
- **Checksum via blake2b256**: matches the project's hash standard.

### Message Codes

| Code | Name | Direction | Description |
|------|------|-----------|-------------|
| 1 | `Handshake` | both | Exchange after libp2p identify |
| 2 | `SyncInfo` | both | Chain tip + recent header anchors |
| 3 | `Inv` | both | "I have these objects" — type + ID list |
| 4 | `ModifierRequest` | → | "Send me these objects" |
| 5 | `ModifierResponse` | ← | Serialized objects |
| 6 | `GetSubBlock` | → | Request sub-block by ID (specific) |
| 7 | `SubBlockResponse` | ← | Sub-block or not-found |
| 8 | `GetPeers` | → | Request peer list |
| 9 | `Peers` | ← | Peer list response |
| 10 | `GetPosts` | → | Request posts by ID |
| 11 | `Posts` | ← | Posts response |
| 12 | — | | **Retired** (was `GetStumps`; P2-F F1) — never reuse |
| 13 | — | | **Retired** (was `Stumps`; P2-F F1) — never reuse |

Codes 10–11 support content-sweep (placeholder fill) for posts the node
has headers for but not content. Codes 12–13 are retired: stumps are
derived state — every node projects its own `dag_stumps` rows from the
PruneEntries in applied blocks (NODE_INTERFACE → "Stumps are derived
state"), so no stump crosses the network in either direction. The numbers
stay reserved so a stale peer sending code 12 is an identifiable protocol
violation rather than a misparse of some future message.
Codes 6-7 replace the old ad-hoc `/dagsocial/sync/1` stream protocol.
Codes 2-5 replace the old `/dagsocial/headers/1` protocol. The old protocols
are deleted.

> ⚠ **VIOLATED — narrowed 2026-08-10. The verdict stands; both of its supporting claims have
> since gone stale.** "The old protocols are deleted" remains false: `/dagsocial/headers/1` is
> **live, and is the only path fork resolution uses.**
>
> Two corrections, both true when originally written. **Framed codes 6–7 do now carry bytes** —
> `net/src/node.ts` dispatches `MSG_GET_SUB_BLOCK` and answers `MSG_SUB_BLOCK_RESPONSE`. And the
> **bare-`decode()`-plus-a-cast gap is closed** (PR #33): both arms go through `lpItemsCodec`
> (`legacyBlocksResponse` and `legacyHeadersResponse` in `net/src/sync-codec.ts`) over the same
> positional codec as the rest of the package, so every element runs the four-part boundary check
> on its own byte span. What has *not* changed is the reason the verdict stays — anyone hardening
> "the sync path" from this document would still harden the wrong one.
>
> ⚠ **Re-verified 2026-08-11: the verdict holds and both line pins had rotted.**
> `/dagsocial/headers/1` is live — `HEADERS_PROTOCOL` is declared in `net/src/sync.ts`, served
> via `libp2p.handle(HEADERS_PROTOCOL, …)` and requested through `requestHeaders`, all in
> `net/src/node.ts`. The old pins `node.ts:956,961` now land on `let code: number;` and
> `body = framed.body;`, and `sync-codec.ts:358,362` on closing braces. **Symbols replace them.**
>
> ⚠ **This note used to say `ARCHITECTURE.md` also describes header-first sync as implemented.
> It does not — verified 2026-08-11, the phrase appears nowhere in that file.** The claim lives
> in `CLAUDE.md`, `README.md` (three places), and **this contract's own opening line**. Fix
> those together; `ARCHITECTURE.md` needs nothing.
>
> ⚠ **Second instance of one pattern:** a Phase 9 item also booked "`ARCHITECTURE.md` describes
> `@dagsocial/wire` as the stream-framing package", and that text is in `CLAUDE.md`/`README.md`
> too. **`ARCHITECTURE.md` is being cited as the home of root-level prose it does not contain** —
> when correcting a claim, re-derive where the claim actually lives rather than inheriting the
> pointer.

---

## Gossip Topics

Sub-block structure, lifecycle, and propagation semantics are defined in
`SUBBLOCK_INTERFACE.md`.

| Topic | Payload | Priority | Description |
|-------|---------|----------|-------------|
| `/dagsocial/subblock/1` | SubBlock (CBOR) | High | User posts + sidecar likes |
| `/dagsocial/ordering-block/1` | OrderingBlock (CBOR) | Critical | Consensus anchors |
| `/dagsocial/tx/1` | UtxoTransaction (CBOR) | High | Invites, claims, cancellations, credit transfers |

`/dagsocial/stump/1` is retired (P2-F F1): a gossiped stump is unverifiable
by construction (no author signature, no `subtreePostIds`) and stumps are
derived locally from applied blocks, so the topic is neither subscribed nor
published. Prunes propagate as PruneEntries inside ordering blocks.

All gossip topics carry CBOR-encoded messages directly — no framing.
The topic version (`/1`) matches the protocol version for topic naming but
is independent — if the wire format changes incompatibly, the topic version
increments.

---

## Handshake (code 1)

After libp2p identify completes, both sides open a stream on
`/dagsocial/handshake/1` and exchange a framed `Handshake` message:

```
outbound: connect → identify → open stream → send Handshake → receive Handshake → active
inbound:  accept → identify → receive stream → receive Handshake → send Handshake → active
```

### Handshake Body (CBOR)

```typescript
{
  agentName: string          // e.g. "dagsocial/1.0.0"
  protocolVersion: number    // app protocol version the node supports
  nodeName: string           // operator-configured, human-readable
  chainHeight: number        // tip height of this node's chain
  declaredAddress?: string   // optional multiaddr this node advertises
  capabilities: number[]     // message codes this node can handle
  sessionMagic: number       // random per-connection uint32
}
```

Session magic: each side generates a random `uint32`. The outbound side
sends its magic; the inbound side echoes it back. Both sides verify the
magic matches their own network's magic bytes in the frame. Anti-replay,
validates both sides agree on network.

> ⚠ **NOT IMPLEMENTED — the anti-replay check does not exist. Verified 2026-08-11.** Both sides
> generate a `sessionMagic` (`net/src/node.ts`, `Math.random()`-derived) and **neither ever
> echoes or compares it.** `net/src/handshake.ts` bounds-checks the field and copies it into the
> parsed result; that is the whole of its handling. The field is populated and discarded, so the
> handshake provides no replay protection whatsoever. Network agreement
> is established by the **frame magic** (`MAGIC_MAINNET`/`MAGIC_TESTNET`), which is a
> separate mechanism and does work — so the second half of this paragraph holds while the
> first does not.
>
> This is design worth building: the field is already on the wire, so implementing the
> echo-and-compare costs no format change.

### Validation (and untrusted-input safety)

Every decoded stream message — the handshake and all sync messages (`SyncInfo`, `Inv`,
`ModifierRequest`, `ModifierResponse`, …) — is **structurally validated before use**:
required fields present and correctly typed, arrays are arrays, and every height or
count is a `Number.isInteger` that is **non-negative and within a sane maximum**. A
malformed or out-of-bounds message is dropped and the peer penalized — it must **never
throw out of, or crash, the handler**, and the sync event loop isolates a per-message
failure so one bad message degrades that message only, never the loop.

**Resource limits (untrusted counts and sizes).** Inbound array lengths (`ids`, `anchors`,
`modifiers`) are capped at `MAX_INV_IDS` **on receipt** — the cap applies to what a peer
*sends us*, not only to what we send. Raw stream reads are bounded by `MAX_STREAM_BYTES`
(never buffer an unbounded attacker-controlled stream). Per-request serve work is bounded:
handling a request must not be `O(ids × chainHeight)` — an unbounded id list must not each
trigger a full-chain scan.

Handshake specifics:
- `protocolVersion` must be one this node supports
- `chainHeight` (and `SyncInfo.tipHeight`) must be a non-negative integer `<=
  MAX_ADVERTISED_HEIGHT` (= 100,000,000, ~190 years at 1 block/min) — they drive
  `servePeer`, so an unbounded or negative value must never reach the serve loop (it
  would otherwise scan ~10⁹ heights). The same bound applies to the legacy
  `/dagsocial/headers/1` request range, which is ungated (no handshake) and must clamp
  its serve loop to the local tip.
- `agentName` / `nodeName` are strings; `capabilities` is an array of numbers (unknown
  capabilities preserved, not rejected — forward compat)

**Ban policy** — distinguish adversarial input from a compatibility mismatch:
- Malformed / out-of-bounds input (missing or wrong-typed fields, negative or
  over-`MAX_ADVERTISED_HEIGHT` values) is adversarial → stream closed, peer **banned
  permanently**.
- `protocolVersion` unsupported is a compatibility mismatch, not an attack → stream closed
  with a **soft refusal; do not permanently ban** (a routine `PROTOCOL_VERSION` bump must not
  partition the network — the peer may upgrade). A short temporary cooldown at most.

### Post-Handshake Routing

| Condition | Action |
|-----------|--------|
| `theirHeight > ourHeight` | Initiate sync from that peer |
| `theirHeight < ourHeight` | Offer them headers (serve mode — send Inv) |
| `theirHeight == ourHeight` | Idle — only gossip flows |

---

## Historical Sync (Header-First)

Sync uses four framed messages multiplexed over `/dagsocial/sync/1`.
All messages are CBOR-encoded bodies wrapped in frames.

> ⚠ **PARTIAL — the section title itself is not accurate.** Sync is **not header-first**
> and has **no body-download phase**; the watermark and durability protocol described
> below is unimplemented. Two specific mechanisms documented here do not exist:
>
> - **Common-ancestor discovery.** `anchors` are built (`getAnchors` in `net/src/node.ts`), sent
>   (`net/src/sync-machine.ts`), decoded (`net/src/sync-codec.ts`) and capped — and **never
>   read** by the receiver: the cap check counts them, nothing consumes their values. There is
>   no ancestor search. **Verified 2026-08-11.**
> - **The framed protocol is not the live path.** `/dagsocial/headers/1` — described elsewhere
>   in this file as *removed* — is live and is the **only** path fork resolution uses.
>
>   ⚠ **This bullet used to end "Framed codes 6–7 have never carried a byte", and that is
>   FALSE — corrected 2026-08-11.** `net/src/node.ts` dispatches `MSG_GET_SUB_BLOCK` and answers
>   `MSG_SUB_BLOCK_RESPONSE`. The `⚠ VIOLATED` note ~150 lines above **already recorded this**
>   as one of its "two corrections". **Two markers in one file, on one subject, disagreeing** —
>   the same shape as the removed-protocols table below. The live-path claim is what survives;
>   the never-carried-a-byte claim does not.
>
> Per-mechanism status is marked below. Inventory: `prompts/audit-net.report.md`.

### SyncInfo (code 2)

```typescript
{
  tipHeight: number
  tipBlockId: string              // hex
  tipCumulativeWork: bigint       // total PoW accumulated (fork choice)
  anchors: { height: number, blockId: string }[]
}
```

Anchors at heights `[tipHeight, tipHeight - 16, tipHeight - 128, tipHeight - 512]`
(fewer if chain is shorter). They let the receiver find the best common point.

### Inv (code 3)

```typescript
{
  typeId: 101 | 102             // 101 = ordering block header, 102 = sub-block
  ids: string[]                  // hex IDs, max 400 per batch
}
```

### ModifierRequest (code 4)

```typescript
{
  typeId: 101 | 102
  ids: string[]
}
```

### ModifierResponse (code 5)

```typescript
{
  typeId: 101 | 102
  modifiers: { id: string, data: Uint8Array }[]
}
```

### Sync Flow

```
Late Node (height 0)                      Synced Peer (height 200)
     │                                            │
     │── Handshake ──────────────────────────────►│
     │◄── Handshake (height=200) ─────────────────│
     │                                            │
     │ peer ahead → pick as sync peer             │
     │── SyncInfo (height=0) ────────────────────►│
     │                                            │
     │ peer sees us behind → compute continuation │
     │◄── Inv (type=101, headers from h=1) ──────│
     │                                            │
     │── ModifierRequest (those ids) ────────────►│
     │◄── ModifierResponse (headers 1-200) ──────│
     │                                            │
     │ validate headers, build chain to h=200     │
     │── SyncInfo (height=200) ──────────────────►│
     │ peer sees equal → no Inv needed            │
     │                                            │
     │ sync complete → block body download        │
     │── ModifierRequest (type=102, missing       │
     │    sub-block ids from ordering blocks) ───►│
     │◄── ModifierResponse (sub-blocks) ─────────│
     │                                            │
     │ apply blocks to state, now at tip          │
```

### Serve Side (Peer Behind Us)

When receiving a SyncInfo showing the peer is behind or at genesis:
1. Compute continuation headers from their best known height + 1
2. Cap at 400 headers
3. Send Inv

An empty anchor list means a from-genesis peer — continuation starts at
height 1. This bidirectional pattern ensures nodes serve peers behind them,
not just consume.

### Sync State Machine

```
pick_sync_peer() → sync_from_peer() → synced()
       ↑                  │
       └── stall/disconnect ──┘
```

- **Pick:** handshake reveals peers ahead of us — pick the one with highest
  chain height
- **Sync:** send SyncInfo, process Inv → request headers, validate, append
  to chain, repeat
- **Stall:** 60s without **real progress** (see Sync Integrity below) →
  rotate to different peer, mark current as stalled. On progress, clear
  stall set.
- **Peer rotation:** `stalledPeers: Set<PeerId>` — peers that failed to
  produce progress. On stall, pick next outbound peer not in set. If all
  stalled, clear set and retry.
- **Synced:** periodic SyncInfo (30s) to detect new blocks. An Inv is
  acted on only while syncing and only from the current sync peer (see
  Sync Integrity — request provenance); an Inv from any other peer, or
  while not syncing, is dropped without penalty.

### Sync Integrity (audit M-10)

- **Response binding.** A `ModifierResponse` is processed only if it
  answers an outstanding `ModifierRequest` this node previously sent **to
  that same peer**: the machine tracks the requested modifier ids per
  request target; a response modifier whose id was not requested from its
  sender is dropped — dropped, not penalized, because a response can
  legitimately cross a peer rotation in flight. Requests are only ever
  sent to the current sync peer, so this implies: no other peer can push
  blocks into the store via the sync path.
- **Request provenance.** While syncing, only an Inv from the current sync
  peer may trigger a `ModifierRequest`. A third party's Inv must neither
  cause requests nor grow the outstanding set.
- **Outstanding-set lifecycle.** Ids are added when a request is sent,
  removed as matching response modifiers are accepted, bounded by a fixed
  cap (new requests must not grow the set past it), and cleared on peer
  rotation and on sync-peer disconnect. The framed sync path has no
  per-request timer — stall rotation IS the request timeout.
- **Stall progress = chain height.** The stall clock advances only when
  applying a response strictly increases `chainHeight` — never on mere
  receipt of bytes or non-advancing modifiers. A peer feeding junk
  therefore stalls out and is rotated away within one stall window; it
  cannot pin sync indefinitely.

### Watermarks

Three watermarks tracked:

| Watermark | Meaning |
|-----------|---------|
| `downloadedHeight` | Highest height with all headers stored |
| `stateAppliedHeight` | Highest height where ordering blocks applied to UTXO state |
| `chainHeight` | Best chain tip height |

During header sync, advance `downloadedHeight`. Once caught up, request
sub-blocks for ordering blocks referencing unknown sub-block IDs, advancing
`stateAppliedHeight`.

Invariant: `stateAppliedHeight <= downloadedHeight <= chainHeight`.

### Cross-DB Durability

Flush ordering on sync checkpoint:

1. `validator.flush()` — state DB fsync (`Durability::Immediate`)
2. `store.setValidatedHeight(height)` — modifiers DB chain_meta write
3. `store.flush()` — modifiers DB fsync

Order is load-bearing. Crash between (1) and (2): state ahead of recorded
height — startup reconciliation trusts state within a threshold window.
Crash between (2) and (3): modifiers DB already has validated_height
durably recorded.

### Block Body Download

After header sync: request sub-blocks for each ordering block whose
`subBlockIds` are not in the local store. Direct `ModifierRequest` (type 102)
to the sync peer.

---

## Peer Discovery

### PeerDb

In-memory registry backed by persistent storage (the `peers` table in the
store — see the persistence seam below). Entries sourced from:
1. Our own handshake with a peer (authoritative)
2. `Peers` messages from other peers (hearsay)

```typescript
interface PeerRecord {
  address: string         // multiaddr, deduplication key
  lastSeenMs: number      // Unix epoch ms
  agentName: string
  nodeName: string
  protocolVersion: number
  capabilities: number[]  // message codes, opaque forward-compat
}
```

Key behaviors:
- **Soft cap:** 1000 entries (`peerDbCap`). Evict oldest `lastSeenMs` on
  overflow.
- **Self-address filter:** entries matching our own listen addresses are
  silently dropped
- **Blacklist filter:** banned peers excluded from `recent()` lookups
- **Persistence:** write-through via `PeerStorage` trait. `put` failures
  logged and swallowed — in-memory state demotes to ephemeral.

#### Persistence seam

`PeerStorage` (`loadAll`/`put`/`delete`) is defined by `@dagsocial/net`
and **implemented by `@dagsocial/node`** over the `peers` table — net
must not depend on SQLite. The implementation is supplied to
`NetNode` at construction, alongside `NetValidators`, and handed to the
`PeerDb` constructor so `loadAll()` repopulates the table at startup.
Omitting it yields an ephemeral PeerDb (the current state); that is a
valid test/embedded configuration, not the production one.

#### Ban surfaces are unified

`PeerManager` bans by **peerId**; `PeerDb` bans by **address**. These
must not drift apart: a peer that `PeerManager` bans is otherwise still
served in `Peers` responses and re-dialed by the outbound fill phase.

- `PeerMetadata` carries the peer's declared `address`, recorded when the
  peer reaches `Active` (the handshake is the only place both identities
  are known).
- Every `PeerManager` ban — temporal or permanent — propagates to
  `PeerDb.ban(address)` for the peer's recorded address, so the address
  leaves `recent()` and is refused re-entry by `record()`.
- Expiry of a temporal ban calls `PeerDb.unban(address)`.

**Known limitation, deliberately not solved here:** a libp2p peerId is
freely regenerable and an address can be re-dialed from a new identity,
so peerId-keyed banning deters unsophisticated abuse only. Address-keyed
pressure is the stronger surface; treating it as authoritative is a
future design decision, not an implementation detail.

### GetPeers (code 8)

Body: empty. A peer receiving this queries PeerDb for up to 8 recently-seen
non-blacklisted, non-self peers (excluding the requester's address) and
responds with `Peers`.

Sent to each connected peer every `GET_PEERS_INTERVAL_MS` (120000, 2 min)
while connected. An inbound `GetPeers` is answered whatever our own sync
phase is — serving discovery does not depend on being synced.

### Peers (code 9)

```typescript
{
  peers: {
    address: string        // multiaddr
    agentName: string
    nodeName: string
    protocolVersion: number
    capabilities: number[]
  }[]
}
```

Max 64 entries per response. Cap is enforced on the receiver — bodies
declaring more trigger a permanent ban of the sender. Empty selection
produces `{ peers: [] }`.

**Encoding.** Both bodies are CBOR, like every other framed message
(`encodeFrame(magic, code, encode(body))`); there is no bespoke
byte-level codec. Decoding follows the `sync-codec.ts` pattern: a decoder
returns `null` for anything that is not well-formed CBOR **or** does not
match the declared shape — `peers` an array, and every entry an object
with a string `address`, string `agentName`, string `nodeName`, plus
`protocolVersion` and `capabilities` bounded **exactly as
`validateHandshake` bounds the same two fields** (`isBoundedInt` /
`isBoundedIntArray` against `MAX_CAPABILITY_CODE`). Pinning them to the
handshake's bounds rather than "any safe integer" is deliberate: the two
carry the same values, and a looser rule here would mean two
implementations disagreeing about which sender gets banned. `null` is a
`ProtocolViolation` (permanent ban); shape checking is not optional,
because each field reaches string and dial paths that a CBOR payload can
otherwise feed any type.

A single invalid entry rejects the **whole** body, banning the sender.
That is not collateral damage: a node serves `Peers` from its own PeerDb,
and **every PeerDb entry is bounded before it is admitted, by whichever route
it arrived** — the guarantee is a property of PeerDb's contents rather than of
any one way in. A well-behaved node cannot produce an invalid entry.

> ✅ **RESOLVED — the third intake now validates. `PeerDb`'s constructor holds every row
> `PeerStorage.loadAll()` returns to the same bounds, through the same predicates the wire
> intakes use (`isBoundedInt` / `isBoundedIntArray` against `MAX_CAPABILITY_CODE`), and drops
> what it cannot serve.**
>
> **The sentence above was reworded rather than corrected to "three".** It enumerated the
> intakes, and an enumeration is what a fourth intake would falsify again; it now states the
> property, which no new route can make false without also breaking it.
>
> **Kept because the reasoning is the record.** The defect was that the constructor loaded
> persisted rows straight into `entries`, filtered only for our own address, while `recent()`
> serves those entries verbatim into a `Peers` body. **The consequence ran the wrong way — it
> banned US, not them:** CBOR is total, so nothing threw locally, and a row out of domain was
> served through `recent()` → `servePeersBody` → `encodePeers`, where every peer we answered
> banned us permanently. The row was on disk, so it survived restarts. It was in domain only by
> write discipline, both writers happening to bound what they wrote.
>
> ⚠ **It was FIVE wire fields, not the two this note named.** `address`, `agentName` and
> `nodeName` reach `decodePeers` the same way and ban us the same way, and node's `loadAllPeers`
> casts SQLite rows with no runtime check — so a `NULL agent_name` arrives as `null`, encodes
> fine, and trips `typeof !== 'string'` at the receiver. **The two-field version came from this
> note and was carried into the dispatch brief; the executor derived the set from the type
> instead and refuted it.** A sixth field, `lastSeenMs`, is not a wire field and cannot ban
> anyone — it is bounded because it orders `recent()` and merges through `Math.max` in
> `record()`, and it arrives through the same unchecked load.
>
> **Dropped rather than clamped:** a capability code is an identity, not a magnitude, so a
> clamped one advertises a capability the peer never declared — and three of the five fields are
> strings, which have no clamp. The row stays in storage and the peer re-enters PeerDb through a
> handshake or a `Peers` intake the next time we meet it.
>
> **Ruling (2026-08-10): the check belongs in `PeerDb`'s constructor, not in
> node's `loadAllPeers`.** The guarantee this contract states is about *PeerDb
> entries*; `loadAllPeers` is one implementation of the `PeerStorage` interface,
> and a check placed there is bypassed by every other implementation — a test
> double today, a different backend later. Putting it at the interface boundary
> the guarantee is written about covers all of them by construction.

`Peers` is accepted **only as the response to a `GetPeers` this node
sent** on that stream. An unsolicited `Peers` frame is ignored — the same
posture as Sync Integrity's response binding, and for the same reason:
otherwise any peer could push addresses into our PeerDb unasked, which is
the cheapest possible table-poisoning primitive.

### Peers Intake

On receiving `Peers`: for each entry where the address is not blacklisted,
not bogus, and not self — record into PeerDb with `lastSeenMs = now`.
Malformed Peers (cap exceeded, truncated body, invalid strings) triggers
permanent ban of the source. Bogus addresses in a valid body do NOT
penalize the source — they are silently dropped.

### Bogus Address Classification

**Always bogus** (any network):
- IPv4: loopback (127/8), link-local (169.254/16), multicast (224/4),
  broadcast (255.255.255.255), unspecified (0.0.0.0), benchmark (198.18/15),
  reserved Class E (240/4)
- IPv6: loopback (::1), unspecified (::), multicast (ff00::/8),
  link-local (fe80::/10), IPv4-mapped (::ffff:0:0/96)

**Mainnet-only bogus** (valid on testnet/LAN):
- IPv4: RFC 1918 private (10/8, 172.16/12, 192.168/16), CGN (100.64/10),
  documentation (192.0.2/24, 198.51.100/24, 203.0.113/24)
- IPv6: unique-local (fc00::/7), documentation (2001:db8::/32)

### Outbound Manager

Two phases:

Both phases are driven by the count of **outbound** connections, never
by the total peer count. This is load-bearing: an attacker who fills
every inbound slot must not be able to stop us from dialing out, which
is how a node gets eclipsed. Inbound connections are counted toward
`maxPeers` capacity, but never toward the floor/fill thresholds.

**Floor phase** (outbound connections < `minPeers`):
- Dial bootstrap seeds aggressively with retry/backoff
- PeerDb not consulted — seeds are the bootstrap source

**Fill phase** (outbound connections >= `minPeers`, < `maxPeers`):
- Every `OUTBOUND_TICK_INTERVAL_MS` (30s, fixed — see below), query
  `PeerDb.recent(N, exclude)` where `N = maxPeers - connectedOutbound`
- `exclude` is the union of **currently-connected addresses** and
  addresses in redial cooldown. Excluding connected addresses is
  required, not an optimization — without it the manager re-dials peers
  it already holds and starves genuinely new candidates.
- Dial one candidate per tick (most recently seen first)
- Respect blacklist and redial cooldown (`outboundRedialCooldownMs`, 60s)
- If PeerDb exhausted, idle until new gossip arrives

The discovery-related knobs (`minPeers`, `peerDbCap`,
`outboundRedialCooldownMs`) are optional in
`NetConfig` and fall back to net-internal defaults. A node that leaves
them unset inherits those defaults rather than the values in this
document — `@dagsocial/node` MUST pass them for the documented behavior
to hold.

#### The tick is fixed, and two cadences are sized against it

`OUTBOUND_TICK_INTERVAL_MS` (30s, `net/src/node.ts`) is a constant rather than a `NetConfig`
field, because two other cadences derive from it and neither can observe a change to it:

- **`GET_PEERS_INTERVAL_MS` (120s) is a deadline this tick samples**, not a timer of its own. The
  realised peer-exchange cadence is `ceil(120s / tick) * tick`, so a tick above 120s replaces the
  documented interval with itself.
- **`DISCOVERY_WINDOW_MS` (45s) in `@dagsocial/node`'s peer-readiness service spans one tick with
  margin**, so a failed bootstrap dial gets a second attempt before the node concludes it is alone.
  A tick above 45s expires that window first and strands a node that had a peer available.

Making the tick configurable would put both failures behind a documented knob. If it is ever made
configurable, `DISCOVERY_WINDOW_MS` must derive from it rather than hardcode a value, and the
`GET_PEERS_INTERVAL_MS` sampling must be moved off this tick.

### Bootstrap Flow (New Node)

```
Node start
  │
  ├── Load peer records from store → populate PeerDb
  ├── Dial bootstrap seeds
  │     │
  │     ├── Handshake → add to PeerDb, transition to Active
  │     ├── Send GetPeers → receive Peers → feed PeerDb
  │     └── If peer ahead → initiate sync
  │
  └── Outbound manager fills from PeerDb
```

---

## Peer Penalty System

| Penalty type | Trigger | Score |
|-------------|---------|-------|
| MisbehaviorPenalty | Invalid message (fails Stage 1) | 100 |
| SpamPenalty | Duplicate sub-block within window | 50 |
| NonDeliveryPenalty | Missing sub-block request timeout | 75 |
| PermanentPenalty | Wrong magic bytes, incompatible version | 500 (instant ban) |

Accumulated score >= threshold → temporal ban for `temporalBanDuration`.

### Accrual and decay (audit L-13)

**Every penalty accrues.** A penalty is never discarded because another
one arrived recently — that made ban pressure independent of attack
rate, since a peer flooding invalid messages paid exactly what a peer
misbehaving once every safe interval paid, while each invalid message
still cost full Stage-1 work (which now includes PoW and signature
verification).

Instead the accumulated score **decays with time**: it is reduced by
`PENALTY_DECAY_PER_INTERVAL` (100 — one MisbehaviorPenalty) for every
`PENALTY_SAFE_INTERVAL_MS` of elapsed time since the peer's score was
last updated, floored at zero. Decay is applied lazily at penalty time,
before the new score is added — no timers.

The break-even point is therefore **one MisbehaviorPenalty per safe
interval**: a peer misbehaving faster than that accrues pressure and is
eventually banned, one misbehaving more slowly fades back to zero and is
never banned. A flooding peer crosses the threshold in five messages
rather than ten minutes.

Permanent penalties (`PenaltyKind.ProtocolViolation`, `'permanent'`)
bypass scoring entirely and ban instantly — decay never applies to them.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `PENALTY_SCORE_THRESHOLD` | `500` | Score to trigger ban |
| `TEMPORAL_BAN_DURATION_MS` | `3600000` | Ban duration (60 min) |
| `PENALTY_SAFE_INTERVAL_MS` | `120000` | Decay interval — `PENALTY_DECAY_PER_INTERVAL` points of accumulated score decay per interval (2 min) |

The parameter keeps its `SAFE_INTERVAL` name because it is set from the
environment by `@dagsocial/node`; renaming it is a cross-package change
tracked as a follow-up.

---

## Biased Event Loop

The sync/gossip event loop MUST prioritize:
1. Control events (reorg notification, peer disconnect, new peer) —
   unbounded channel, never dropped
2. Data events (post received, post acknowledged) — bounded channel, lossy
   above `MAX_DATA_QUEUE`
3. Timer ticks — fallback
4. **It MUST wait when all three are idle.** With both queues empty and no tick
   due, the loop blocks until an enqueue or the next tick. It does not re-poll.

**Yielding is not waiting.** `await new Promise(r => setImmediate(r))` returns to
the event loop and comes straight back, so a loop that "yields" every iteration
still consumes a core continuously while doing nothing. Clause 4 is a cost
obligation and is as binding as the three ordering rules above it.

> ⚠ **Clause 4 exists because it was absent, and the absence cost a core.**
> Clauses 1–3 were ported from `ergo-node-rust`'s `facts/sync.md`, which
> describes a Tokio `select! { biased; … }` loop. `select!` parks the task until
> a receiver or timer is ready, so **the source document never had to state
> clause 4 — the runtime guaranteed it.** Everything that document wrote down
> came across faithfully, `MAX_DATA_QUEUE = 64` included. Only the guarantee that
> was never text was lost, and JavaScript offers no equivalent: `.shift()` on an
> array has no readiness to await.
>
> Measured 2026-08-11: 100% of one core, permanently, on an idle node — and on
> every node since the loop landed. Invisible to 3029 passing tests, because no
> test suite measures cost.
>
> **The porting rule this yields, which applies to every contract taken from that
> template:** *a specification omits precisely what its source runtime provides
> for free, and the omission only becomes visible in a runtime that does not.*
> Before porting a design across languages, enumerate what the source language
> was doing unstated — for this loop the whole answer is one line: `select!`
> sleeps, `.shift()` does not.

## Local-Serve-Before-Relay

Incoming content requests MUST check local storage before relaying to
other peers. Serve and relay are mutually exclusive per request ID —
never both.

## Penalty Attribution

Every incoming message carries `sourcePeerId`. Validation failures are
attributed to the sending peer. Three penalty tiers:
- **Transient failure** (timeout, slow response): cooldown, not a ban
- **Protocol violation** (malformed message, invalid encoding): permanent
  ban, peer removed from PeerDb
- **Bogus addresses in valid gossip**: silently dropped, sender NOT
  penalized (NAT'd peers sending private addresses is normal)

## Peer State Machine

States: `Connecting → Handshaking → Active → Disconnected | Failed`

Invariant: No events leak from non-Active peers. Messages from peers not
in `Active` state are rejected before reaching the router.

## Stall Detection

Track peers that fail to deliver requested content within a timeout. On
stall: mark peer, rotate to next outbound peer not in stalled set. On
successful receipt from any peer: clear the stalled set. All peers stalled:
clear and retry.

---

## libp2p Stack

| Layer | Choice |
|-------|--------|
| Transport | TCP (with optional QUIC, deferred) |
| Stream multiplexing | yamux or mplex |
| Encryption | Noise (with libp2p-noise) |
| PubSub | Gossipsub 1.1 |
| Peer identity | libp2p peer ID (Ed25519 or secp256k1 keypair) |

The libp2p peer identity is separate from DAGsocial account identity. A
node operator may choose to link them (same keypair) or keep them separate.

---

## Stream Protocols

| Protocol | Framing | Purpose |
|----------|---------|---------|
| `/dagsocial/handshake/1` | Frame | Post-identify peer handshake |
| `/dagsocial/sync/1` | Frame | Historical sync + peer discovery (codes 2-9) |
| **`/dagsocial/headers/1`** | **Request raw CBOR, responses positional** | **LIVE — the only path fork resolution uses** |

All stream protocols multiplex over the sync stream. The frame `code`
byte disambiguates message types.

### `/dagsocial/headers/1` responses — positional, `arr(item, lp)`

**Landed 2026-08-10.** Both arms previously answered in a **second wire format** — `encode({ blocks })`
/ `encode(headers)` out, `decode(raw) as {…}` back — bare `cbor-x` plus a TypeScript cast, while every
other whole-block path in this package used `encode`/`decodeOrderingBlock`. A cast is not a check, and
the gap was **measured**: it was the sole delivery path for a remote fail-stop
(`prompts/node-fail-stop-reachability-measure-REPORT.md`). Shape-validating the CBOR would have been
the band-aid; the root cause was the second dialect, so the dialect is gone.

- **Blocks:** `arr(blocks, lp(encodeOrderingBlock))`. **Headers:** `arr(headers, lp(encodeHeader))`.
- **The per-element `lp` is load-bearing**: it gives each item its own byte span, so the four-part
  boundary check (spec §2.1) runs over exactly that span — exhaustion and re-encode compare included —
  and a malformed block is rejected at its own offset rather than as an outer mismatch.
- **The request stays raw CBOR.** It is a control message carrying no consensus bytes
  (`{ startHeight, maxCount, endHeight, mode }`) and is shape-checked by
  `decodeLegacyHeadersRequest`.
- ⚠ **Zero bytes and `vlqU(0)` are DISTINCT and consumers depend on it.** Zero bytes is the handler's
  *"I cannot answer"*; `vlqU(0)` is *"no items"*. Collapsing them is a live defect — see below.
- **`MAX_LEGACY_RESPONSE_ITEMS = 400`, enforced on BOTH sides**, and the receive cap is
  `min(requested, 400)` **checked before the first element is read**. A peer answering a 40-header
  request with 18,900 headers is not answering the question, and the count is a `vlqU` the peer
  chooses. ⚠ **`readArr` is the wrong primitive here** — it bounds only at `MAX_ARRAY_LENGTH` (2²⁴),
  three orders of magnitude above the 400 this path allows, and it cannot enforce a caller's cap
  *before* the first element is read.

  > ✅ **The allocation half of this argument is dead — corrected 2026-08-10.** It used to read "and
  > pre-sizes the array, so four peer-chosen bytes buy a sixteen-million-slot allocation." PR #34
  > closed that: `readArray` now rejects a length exceeding the bytes actually remaining
  > (`wire/src/reader.ts:155`) *before* it allocates at `:161`. **The conclusion stands on the two
  > grounds left to it** — the 400-item cap and the per-item boundary check the length-prefixed
  > nesting allows. Kept because a reader hardening this path from the old text would defend against
  > a hazard that is gone and might weaken the bound that is not.
- **A response that does not decode THROWS; it must never resolve to `[]`.** `requestBlocks`' result
  goes straight to `reorg(forkHeight, newBlocks)`, which reverts above the fork point and applies what
  it is given — so an empty array *truncates our own chain* instead of failing to extend it.

Removed protocols:
- Old `/dagsocial/sync/1` (individual sub-block request/response) —
  replaced by framed GetSubBlock/SubBlockResponse (codes 6-7)
- **`/dagsocial/headers/1` — NOT removed. Still live, and still the path fork resolution uses.**

  > ⚠ **FALSE — this row claimed a removal that never happened, and it was false when written.
  > Verified 2026-08-11.** The strikethrough is deleted rather than kept: struck text is skipped
  > by every reader, so a live warning parked inside it is invisible — and this row is the one
  > entry in a "Removed protocols" list that describes a protocol still carrying production
  > traffic. The framed codes 2-5 exist; nothing routes fork resolution through them.
  > `HEADERS_PROTOCOL` is declared in `net/src/sync.ts` and served from `net/src/node.ts`.
  >
  > **The contract contradicted itself in two places** — a `⚠` note ~600 lines above said the
  > protocol was live while this table said it was removed, and only the note was ever corrected.
  > Retiring it in favour of codes 2-5 is a real question and is **still open**; until then this
  > table describes what runs.

---

## Validation Architecture

Two-stage validation, modeled after Ergo's modifier processing:

### Stage 1 (net package, stateless)

Runs inside the gossipsub topic validators — i.e. **before** a message is
forwarded to mesh peers. A message that fails Stage 1 is Rejected (never
forwarded) and penalized: undecodable → `ProtocolViolation` (permanent
ban); well-formed but invalid → misbehavior penalty (100). Uses
`@dagsocial/validation`. Per topic:

| Topic | Checks before Accept |
|-------|----------------------|
| sub-block | `verifySubBlockStructure`; content limits (1–300 UTF-8 bytes) + character rules; parent-refs count; protocol version; post PoW (`verifyPoW` over `postPowPreimage` at `POST_POW_TARGET_BITS`); post signature (`verifyPostSignature` — the post's own `author` key) |
| ordering-block | `verifyOrderingBlockStructure`; protocol version; `header.height` is a safe integer (NaN/float/±Infinity → Reject); ordering-block PoW (`verifyOrderingBlockPoW`) — the solution must satisfy the header's own `powTargetBits` (bounded ≥ `ORDERING_BLOCK_POW_TARGET_FLOOR` by structure), and a non-safe-integer `powNonce`/`powTargetBits` never verifies (audit M-6, M-9) |
| tx | `verifyTxStructure`; protocol version |

Stage 1 is stateless. It does **not** check the difficulty schedule
(`powTargetBits === expectedTarget(height)`), chain linkage, validator
signatures, or state roots — those are apply-time checks in
`@dagsocial/node`, enforced for every entry path (gossip, sync, reorg) by
the block-apply funnel. The relay PoW gate exists to make mesh propagation
cost-bearing: no zero-work ordering block may be re-gossiped (audit M-9).

### Stage 2 (node package, stateful)

Runs after Stage 1 passes, via registered `on*` callbacks:

- Parent refs exist (live post or stump)
- Author has sufficient karma
- UTXO inputs unspent, guard scripts satisfied
- Challenge check skipped for relayed posts (challenge was local to origin node)

### Forwarding Rule

Forward to mesh peers only after Stage 1 passes — for ordering blocks this
includes PoW verification, so a bogus-PoW or NaN-nonce block is dropped at
the first hop instead of amplified mesh-wide. If Stage 2 fails later,
penalize the source peer. This keeps propagation fast while gatekeeping on
structure, PoW, and signatures.

---

## API

### Node Lifecycle

| Function | Signature | Description |
|----------|-----------|-------------|
| `start(config)` | `(NetConfig) => Promise<void>` | Create libp2p node, connect to bootstrap peers, subscribe to topics |
| `stop()` | `() => Promise<void>` | Graceful shutdown |
| `peerId()` | `() => string` | This node's libp2p peer ID |
| `peers()` | `() => Peer[]` | Connected peers with metadata |
| `getConnectedPeers()` | `() => string[]` | Peer IDs of currently connected peers |

### Gossip

| Function | Signature | Description |
|----------|-----------|-------------|
| `broadcastSubBlock(sb)` | `(SubBlock) => Promise<void>` | Gossip a newly assembled sub-block |
| `broadcastOrderingBlock(b)` | `(OrderingBlock) => Promise<void>` | Gossip a newly created ordering block |
| `broadcastTx(tx)` | `(UtxoTransaction) => Promise<void>` | Gossip a UTXO transaction |

### Inbound Processing

| Function | Signature | Description |
|----------|-----------|-------------|
| `onSubBlock(callback)` | `((SubBlock) => void) => void` | Register handler for inbound sub-blocks |
| `onOrderingBlock(callback)` | `((OrderingBlock) => void) => void` | Register handler for inbound ordering blocks |
| `onTx(callback)` | `((UtxoTransaction) => void) => void` | Register handler for inbound UTXO transactions |

### Pull Requests (Peer-to-Peer)

| Function | Signature | Description |
|----------|-----------|-------------|
| `requestHeaders(start, max, peerId)` | `(number, number, string) => Promise<BlockHeader[]>` | Request block headers for fork resolution |
| `requestBlocks(start, end, peerId)` | `(number, number, string) => Promise<OrderingBlock[]>` | Request full blocks for reorg |
| `requestPosts(peerId, postIds)` | `(string, string[]) => Promise<PostsMsg>` | Request posts by ID (content-sweep) |

### Sync Handler Registration

| Function | Signature | Description |
|----------|-----------|-------------|
| `setSyncHandler(cb)` | `((id: string) => SubBlock \| null) => void` | Provider for sub-block content (placeholder fill) |
| `setBlocksHandler(cb)` | `((block: OrderingBlock) => void) => void` | Handler for blocks received during sync |
| `setHeadersHandler(cb)` | `((height: number) => OrderingBlock \| null) => void` | Provider for `/dagsocial/headers/1`. Returns the whole block, not the header: one provider serves both response modes — headers mode reads `.header`, blocks mode returns the block |
| `setPostsHandler(cb)` | `((ids: string[]) => PostsEntry[]) => void` | Provider for posts by ID |
| `onSyncComplete(cb)` | `(() => void) => void` | Fired when sync finishes |
| `onPeerActive(cb)` | `((peerId: string) => void) => void` | Fired when a peer becomes active |

**Handler setters are order-independent.** Every setter above stores a delegate and has no libp2p side
effect, so it is valid before or after `start()`, and a later call replaces the delegate. Registering a
libp2p protocol is `start()`'s responsibility alone. A setter that also registers makes its own call
order load-bearing with nothing to signal it: the registration reads a libp2p instance that `start()`
has not created yet, the guard falls through, and every layer beneath keeps passing — the protocol is
simply absent for the life of the process, which a peer sees as `protocol selection failed` and reads
as the peer's fault rather than ours.

**A node that has registered no headers provider answers zero bytes** on `/dagsocial/headers/1`, rather
than declining the protocol. Zero bytes is this protocol's "I cannot answer", and it is distinct from an
empty header *list* — one byte, `vlqU(0)` — which means "I consulted my chain and have nothing at that
height". A node holding no provider has no chain to consult, so it cannot honestly send the second. Both
reach the caller as an empty array, and fork resolution treats that as "no reorg" like any other
non-match, so nothing downstream needs a new case.

Declining the protocol is **not** equivalent to either. `requestHeaders` wraps its dial in `try`/`finally`
with no `catch`, so an unregistered protocol reaches the caller as a **rejected promise** rather than an
empty result. "This peer has nothing to serve" and "this peer does not speak the protocol" are therefore
different events at the call site, and collapsing them costs the caller the only signal that distinguishes
a peer's state from its capability.

---

## Config

```typescript
interface NetConfig {
  // Transport
  bootstrapPeers: string[]
  listenAddrs: string
  maxPeers: number

  // Network — both REQUIRED, both supplied by the node from its resolved profile.
  // No defaults; see §Magic Bytes and §Consensus parameters net enforces.
  magic: number                    // mainnet 0x4D444147 · testnet 0x54444147 · devnet 0x44444147
  postPowTargetBits: number        // gossip verifies post PoW against this before relay

  // Peer discovery
  minPeers: number                 // floor for fill phase (default 3)
  peerDbCap: number                // soft cap on PeerDb entries (default 1000)
  outboundRedialCooldownMs: number // redial cooldown (default 60000)

  // Syncing
  syncRequestTimeoutMs: number

  // Penalties
  penaltyScoreThreshold: number
  temporalBanDurationMs: number
  penaltySafeIntervalMs: number
}
```

### Consensus parameters net enforces

Stage-1 relay validation checks proof-of-work before forwarding, so **net enforces a
consensus parameter** and must be told which network it is on. It receives values; it does
not resolve them, does not import `NetworkProfile`, and reads no environment variable for
them.

| Value | Why net needs it | Today |
|---|---|---|
| `magic` | Frame assembly and the frame-magic check | ✅ Supplied by the node from its resolved profile — see §Magic Bytes |
| `postPowTargetBits` | `gossip.ts:255` verifies post PoW before relay | ✅ Supplied by the node; `net/src` imports no PoW constant |

> ✅ **RESOLVED — closed by P2-A, re-verified 2026-08-11.** `net/src/gossip.ts` calls
> `v.verifyPoW(powInput, post.powNonce, postPowTargetBits)` with the parameter threaded from
> `this.config.postPowTargetBits` in `net/src/node.ts`, and `POST_POW_TARGET_BITS` occurs
> **0 times across every package's `src`**.
>
> ⚠ **It occurs 10 times in `net/test`.** The production path is clean; the test tree still
> asserts against the compile-time constant rather than the profile field. That passes only
> because the suite runs on the profile where the two are equal by construction — carried
> register #23, and this is a net-side instance of it. *Historical:* it checked against the compile-time constant, making post difficulty
> network-invariant at the relay boundary even though it is a profile field — **a devnet node
> would have rejected its own network's posts**, mined at devnet's target and checked against
> mainnet's, before they ever reached the node.

> ✅ **RESOLVED — verified 2026-08-10, re-verified 2026-08-11 by count. The resolution stated at
> the foot of this note was carried out:** `net/src/config.ts` no longer exists, `loadNetConfig`
> occurs 0 times in any `src`, and `NETWORK_MAGIC` occurs 0 times in any `src` in any package.
> Net receives configuration; it does not resolve it.
>
> **The record — this was VIOLATED: `NETWORK_MAGIC`, an undocumented `network-identity`
> environment read.** No `⚠`: it is closed, and the code below is quoted from a file that has
> since been deleted. **A pin into a file that no longer exists is correct here** — being gone
> is the resolution, not rot. It read, in the former `net/src/config.ts`:
> ```ts
> magic: parseInt(process.env['NETWORK_MAGIC'] ?? '0x54444147', 16), // default testnet
> ```
> Found 2026-08-06 by an exhaustive `process.env` sweep across all five packages. It appears
> in **no contract** — not here, not in `NODE_INTERFACE §Configuration` — and the ten-unit
> audit did not surface it. Three problems, in ascending order:
>
> 1. **It is a second network selector.** `NETWORK_TYPE` is supposed to be the only
>    environment variable that can change a consensus parameter.
> 2. **Its default contradicts the live path.** This says testnet (`0x54444147`); the ten
>    `?? MAGIC_MAINNET` sites say mainnet. The two disagree about which network an
>    unconfigured node joins.
> 3. **It is dead, which is why nobody noticed.** `loadNetConfig` has no production caller
>    and is not exported from net's barrel — only its own test file calls it. The node builds
>    its `NetConfig` literal by hand instead. Dead code carrying a live escape hatch is worse
>    than live code carrying one: it reads as the intended path and invites being wired up.
>
> **Resolution: delete `loadNetConfig` and its test.** Net does not resolve configuration —
> it receives it.

---

## Preconditions

- Node.js >= 22
- `@dagsocial/wire`, `@dagsocial/types`, `@dagsocial/validation`, and
  `@dagsocial/node` packages built and importable
- libp2p dependencies installed (`@libp2p/tcp`, `@chainsafe/libp2p-noise`,
  `@chainsafe/libp2p-yamux`, `@chainsafe/libp2p-gossipsub`, `@libp2p/identify`,
  `@libp2p/ping`)
- Bootstrap peer(s) reachable
- Port available for libp2p listen address

## Postconditions

- libp2p node running with configured transports and protocols
- Connected to bootstrap peers, handshake exchanged, and meshed on all
  subscribed gossip topics
- Handshake validated — wrong-network peers rejected at magic byte level
- Sync initiated with peers ahead of us; sync served to peers behind us
- Sub-blocks received from peers are validated and forwarded to local node
  for storage
- Ordering blocks received from peers are validated and applied
- Locally-produced sub-blocks and ordering blocks are gossiped to peers
- PeerDb populated from handshakes and Peers gossip; outbound manager
  maintaining peer count between minPeers and maxPeers

## Invariants

- Frame magic bytes reject wrong-network connections at the transport layer
- Frame checksum catches corruption before body parsing
- Stream protocols carry framed messages; Gossipsub topics carry raw CBOR
- Sync is bidirectional — nodes serve peers behind them, not just consume
- Watermark invariant: `stateAppliedHeight <= downloadedHeight <= chainHeight`
- Flush ordering: state → validated_height → modifiers (same order every time)
- Unknown message codes and peer capabilities are preserved, not rejected
- PeerDb self-address filter prevents self-dial loops
- Bogus addresses filtered silently; malformed Peers trigger permanent ban
- Sub-block gossip is stateless — verification depends only on the post's
  PoW target, not on challenge provenance
- Ordering blocks are verified before application — a block extending an
  unknown chain may be buffered but never applied
- UTXO transactions are verified against the local UTXO view — conflicting
  transactions (double-spends) are rejected at gossip time
- Peer identity (libp2p) is independent of account identity (Ed25519 keypair)
- Topic names include protocol version — incompatible wire format changes
  get a new topic
- Inbound messages are re-verified before forwarding and storing
