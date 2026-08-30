# NET Interface Contract

**Component:** `@dagsocial/net`
**Protocol version:** 2
**Last updated:** 2026-08-24

## Scope

libp2p-based peer-to-peer networking for DAGsocial. Owns: wire framing,
handshake, historical sync of whole ordering blocks (fork choice scores header pages), peer discovery,
ordering block gossip, UTXO transaction relay, and peer penalty management.

Depends on `@dagsocial/wire` for ByteReader/ByteWriter/VLQ/frame encode-decode
stream framing, `@dagsocial/validation` for Stage 1 (stateless) validation,
and `@dagsocial/types` for wire types.

---

## Wire Framing

Every stream message is wrapped in a frame. Gossipsub messages are **not**
framed — each topic carries its payload's positional encoding bare (→ Gossip Topics).

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
| body | `length` bytes | Positional message body — layout per message code |

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
> The damage is **cross-network classification**. A devnet peer reaching a mainnet or
> testnet node fails the own-magic compare; found in the set it is closed as a
> wrong-network peer, missing from a stale set it is closed as not-a-frame. Both land in
> the Ban policy's frame tier — closed, no penalty — so a stale set costs no ban; what it
> costs is the diagnosis, and a wrong-network condition an operator could read from the
> log reports as garbage instead.
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
- **Minor version higher**: accept. A minor bump promises the envelope layout is
  unchanged; bodies carry no frame-version dependence — message-body changes ride
  the app `protocolVersion`.

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
- **Body is positional**: every body is an `encodeStruct` codec, run through the
  four-part boundary check on decode (`TYPES_INTERFACE` → The boundary check) —
  the dialect gossip and the chain responses already speak. One serialization
  format, the project's own; no third-party parser touches wire bytes.
- **Checksum via blake2b256**: matches the project's hash standard.

### Message Codes

| Code | Name | Direction | Description |
|------|------|-----------|-------------|
| 1 | `Handshake` | both | Exchange after libp2p identify |
| 2 | `SyncInfo` | both | Chain tip height |
| 3 | `Inv` | both | "I have these objects" — type + ID list |
| 4 | `ModifierRequest` | → | "Send me these objects" |
| 5 | `ModifierResponse` | ← | Serialized objects |
| 6 | — | | **Retired** (was `GetSubBlock`) — never reuse |
| 7 | — | | **Retired** (was `SubBlockResponse`) — never reuse |
| 8 | `GetPeers` | → | Request peer list |
| 9 | `Peers` | ← | Peer list response |
| 10 | — | | **Retired** (was `GetPosts`) — never reuse |
| 11 | — | | **Retired** (was `Posts`) — never reuse |
| 12 | — | | **Retired** (was `GetStumps`; P2-F F1) — never reuse |
| 13 | — | | **Retired** (was `Stumps`; P2-F F1) — never reuse |
| 14 | `GetHeaders` | → | Request headers by height range (fork resolution) |
| 15 | `Headers` | ← | Header list response |
| 16 | `GetBlocks` | → | Request whole ordering blocks by height range (reorg) |
| 17 | `Blocks` | ← | Ordering block list response |

Codes 6–7, 10–11 and 12–13 are holes: a post is a transaction and a block
carries its posts' commits in `utxoTxs`, so no post crosses the network as its own
message — its **body** crosses only as the trailing field of the transaction's packet on
`/dagsocial/tx/1` (→ Gossip Topics) and as a `MODIFIER_POST_BODY` modifier on codes 4/5
(→ ModifierRequest), keyed by the post id and checkable against the commit the requester
already holds; a post as an object in its own right (codes 10/11) is what cannot be verified
(TYPES_INTERFACE → What "verify a post" means now). Stumps are derived state — every node
projects its own `dag_stumps` rows from the PruneEntries in applied blocks (NODE_INTERFACE →
"Stumps are derived state"). A new message takes the lowest free code.

**This table is the code allocator; `net/src/types.ts` mirrors it.**
⚠ **Not every allocation is findable by grepping `MSG_`** —
`handshake.ts:72` frames its code as the literal `1` rather than through `MSG_HANDSHAKE`, so a
`MSG_`-keyed search misses allocations. The sweep that finds them all is
`grep -rn 'encodeFrame([A-Za-z_.]*, *[0-9]' packages/`, read together with this table.

Codes 14–17 carry fork resolution's two queries and `/dagsocial/headers/1` is deleted. Those queries
have **no expression in codes 2–5**: 2–5 are an id-addressed inventory conversation, offering ids
forward from a peer's height along the server's own best chain, while fork resolution asks for a
**height range on a chain the requester does not hold** so it can find a common ancestor and compare
cumulative work.

Every code in this table is carried by `/dagsocial/sync/1`. There is no second stream protocol for
chain data.

---

## Gossip Topics

**There is no sub-block topic.** A post is a transaction and propagates as one — its body
rides the same message, as the packet's trailing field, never as a message of its own.
The relay-path gate is a cached **membership** check — *does this author hold
karma at all* — replacing post PoW; see `NODE_INTERFACE` → Post transactions for
the rule and the measurement behind it.

| Topic | Payload | Priority | Description |
|-------|---------|----------|-------------|
| `/dagsocial/ordering-block/1` | OrderingBlock (positional) | Critical | Consensus anchors |
| `/dagsocial/tx/1` | Transaction **packet** — `encodeTxPacket(tx, content?)`: `encodeTx(tx)` ‖ `opt(lpUtf8(content))` (TYPES_INTERFACE → Layout — UtxoTransaction, the packet codec) | High | Posts (with their body), likes, invites, vouches, credit transfers |

**The packet rule: `tx.post` present ⟺ `content` present.** The topic validator checks it
in this order, and in the same order on every node: `decodeTxPacket` (undecodable →
`ProtocolViolation`, permanent ban) → `verifyTxStructure` → protocol version → the
biconditional (a post without a body, or a body without a post → misbehaviour penalty, Reject)
→ `verifyPostBody(content, tx.post.contentHash)` (VALIDATION_INTERFACE → verifyPostBody; a
failing body → misbehaviour penalty, Reject) → the karma-membership gate. A packet that passes
is delivered whole to `onTx(tx, content, fromPeerId)`; a post's transaction and its body are
never accepted apart. The body is outside every id, so a relay cannot re-point it without
failing the commitment check at the next hop.

**Tracked reservation (remnant-bounded — TYPES_INTERFACE → Tracked reservations, condition 3): the
topic string `/dagsocial/subblock/1`.** Held by its live guard — `gossip.test.ts` asserts
the topic has no validator — and it leaves with that guard.

`/dagsocial/stump/1` is retired (P2-F F1): a gossiped stump is unverifiable
by construction (no signature, no set to check against topology) and stumps are
derived locally from applied blocks, so the topic is neither subscribed nor
published. Prunes propagate as transactions — on the `tx` topic and inside
ordering blocks.

All gossip topics carry the object's own positional wire encoding directly — no framing.
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

**A handshake is a frame or it is nothing.** A payload that does not decode as a valid
frame — truncated, leading bytes that are no known magic, a failed checksum — is rejected
and the stream closed; there is **no unframed fallback**, so no handshake byte is ever
parsed except as the body of a checksum-verified frame. The
classification of each frame-decode failure is the Ban policy's first tier below.

### Handshake Body

```
lpUtf8(agentName) ‖ vlqU(protocolVersion) ‖ lpUtf8(nodeName) ‖ vlqU(chainHeight) ‖
opt(lpUtf8(declaredAddress)) ‖ arr(vlqU(capability)) ‖ vlqU(sessionMagic)
```

| Field | Rule |
|---|---|
| `agentName` | non-empty, ≤ `MAX_NAME_BYTES` (255) UTF-8 bytes — e.g. `"dagsocial/1.0.0"` |
| `protocolVersion` | ≤ `MAX_CAPABILITY_CODE`; the highest app protocol version the sender implements — its build's `PROTOCOL_VERSION` (`TYPES_INTERFACE → Version`) |
| `nodeName` | ≤ `MAX_NAME_BYTES` bytes; operator-configured, human-readable, may be empty |
| `chainHeight` | ≤ `MAX_ADVERTISED_HEIGHT`; tip height of this node's chain |
| `declaredAddress` | optional (`opt`), ≤ `MAX_ADDRESS_BYTES` (255) bytes; the multiaddr this node advertises — **its first listen address that is not loopback**, absent when every listen address is loopback. A loopback address advertised to a peer is one no peer can dial |
| `capabilities` | count ≤ `MAX_CAPABILITY_ENTRIES` (64), each ≤ `MAX_CAPABILITY_CODE`; message codes this node can handle. Always present — an empty list is a peer that declares nothing |
| `sessionMagic` | ≤ `MAX_UINT32`; random per-connection uint32 |

> ⚠ **AHEAD OF CODE — 2026-08-30.** `buildOurHandshake` declares `listenAddrs[0]`, which on a node listening on `0.0.0.0` is the
> loopback address. The testnet-bootstrap-default unit's net dispatch.

Every rule is enforced inside the codec's `read`: a violation is a `ReaderError`, and the decode
boundary collapses it to `null` → `malformed` (Ban policy below). The version-support check runs
**after** decode, on a structurally sound message only.

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

Every stream message body — the handshake and all sync messages (`SyncInfo`, `Inv`,
`ModifierRequest`, `ModifierResponse`, …) — decodes through its positional codec, and **the codec
is the whole structural boundary**: `decodeStruct` runs the four-part boundary check
(`TYPES_INTERFACE` → The boundary check), and every domain rule — heights, counts, byte caps —
throws inside `read` before any value escapes. A malformed or out-of-bounds message collapses to
`null`, is dropped, and the peer penalized — it must **never throw out of, or crash, the
handler**, and the sync event loop isolates a per-message failure so one bad message degrades
that message only, never the loop.

**Resource limits (untrusted counts and sizes).** Inbound array counts are capped **inside the
codecs, before the first element is read**: `ids` / `modifiers` at `MAX_INV_IDS` — and at least 1,
an empty `Inv`, `ModifierRequest` or `ModifierResponse` being malformed (no honest sender emits
one) — `peers` at `MAX_PEERS_ENTRIES`, `capabilities` at
`MAX_CAPABILITY_ENTRIES`. The cap applies to what a peer *sends us*, not only to what we send.
Raw stream reads are bounded by `MAX_STREAM_BYTES` (never buffer an unbounded
attacker-controlled stream). Per-request serve work is bounded: handling a request must not be
`O(ids × chainHeight)` — an unbounded id list must not each trigger a full-chain scan.

⛔ **Every arm that assembles more than one stored object into a response is bounded by BYTES, not by
item count alone.** A count bounds an array's length and says nothing about its weight, and both
`ModifierResponse` and `Blocks` assemble whole blocks. Each arm accumulates encoded bytes, stops
before exceeding `MAX_SERVE_BODY_BYTES`, and always emits its first item so an oversized object moves
rather than wedging sync.

**Three limits stand in a fixed order, and the relation is the rule:**

```
MAX_BLOCK_BODY_BYTES (2,000,000)  <  MAX_SERVE_BODY_BYTES (4 MiB)  <  MAX_STREAM_BYTES (8 MiB)
```

The lowest is `@dagsocial/types`' consensus bound (`TYPES_INTERFACE` → Size caps); the upper two are
this package's. A single legal block therefore always fits inside a response the requester will
accept, and a multi-block response truncates instead of overflowing. ⚠ **Raising the block bound above
this package's serve limit makes a block valid and unservable** — it propagates by gossip and no peer
syncing from history can ever fetch it, which is a consensus-visible split produced entirely by two
constants moving independently.

Handshake specifics:
- `protocolVersion` must cover the receiver's era: `protocolVersion ≥ protocolVersionAt(schedule,
  chainHeight() + 1)`, the era of the next block this node would apply (`ARCHITECTURE → Protocol
  Versioning`). A peer from a newer build passes — it validates our era; a peer whose build ends before
  our era is refused. Evaluated at handshake time, in both directions, and held for live connections
  by the boundary sweep (→ Post-Handshake Routing)
- `chainHeight` (and `SyncInfo.tipHeight`) must be a non-negative integer `<=
  MAX_ADVERTISED_HEIGHT` (= 100,000,000, ~190 years at 1 block/min) — they drive
  `servePeer`, so an unbounded or negative value must never reach the serve loop (it
  would otherwise scan ~10⁹ heights). The same bound applies to the `GetHeaders` / `GetBlocks`
  request range (codes 14, 16), which must clamp its serve loop to the local tip. That range
  arrives over `/dagsocial/sync/1`, so it reaches the serve loop only from a peer in **Active**
  state and a malformed body is attributable to a peer that can be penalized.
- `agentName` / `nodeName` / `declaredAddress` are byte-capped strings (`MAX_NAME_BYTES` /
  `MAX_ADDRESS_BYTES`); `capabilities` is a count-capped list of bounded codes (unknown
  capabilities preserved, not rejected — forward compat)

**Ban policy** — two tiers, split by what a failure is evidence of:

*Frame tier — the payload never decoded as a frame, or the frame refused itself.* Close the
stream, **no penalty**, for every code: a recognized foreign magic is a wrong-network
misconfiguration; an unsupported frame version is a newer peer; a checksum mismatch is a
corrupt link or a forgery, indistinguishable from here; truncated bytes or no known magic at
all are a link that died mid-write or garbage, equally indistinguishable. None of these is
*evidence* of misbehaviour, so none earns ban pressure — and none reaches a parser, so none
can be misclassified by one.

*Body tier — the frame decoded, its checksum held, and the body inside is wrong.* A
valid checksum proves the sender meant exactly these bytes, which is what licenses treating
body defects as deliberate:
- Malformed / out-of-bounds input (short or trailing bytes, non-canonical encodings,
  out-of-domain values such as an over-`MAX_ADVERTISED_HEIGHT` height) is adversarial →
  stream closed, peer **banned permanently**.
- `protocolVersion` below the receiver's era is a compatibility mismatch, not an attack → stream
  closed with a **soft refusal (`Transient`); never a permanent ban** — a routine bump must not
  partition the network, and the peer may upgrade. The same tier applies to every version mismatch
  after the handshake (→ Peer Penalty System).

### Post-Handshake Routing

| Condition | Action |
|-----------|--------|
| `theirHeight > ourHeight` | Initiate sync from that peer |
| `theirHeight < ourHeight` | Offer them headers (serve mode — send Inv) |
| `theirHeight == ourHeight` | Idle — only gossip flows |

**At an era boundary, every Active peer below the new era is dropped.** When `tipApplied(height)`
(→ API) reports a tip whose `protocolVersionAt(schedule, height + 1)` is above the era last in force,
the node disconnects each Active peer whose declared `protocolVersion` — the handshake's, kept on the
peer's metadata — is below the new era: the handshake rule, held for live connections, so every Active
peer implements the era this node is applying. A tip move inside an era drops no one.

---

## Historical Sync

Sync moves **whole ordering blocks**: four framed messages multiplexed over `/dagsocial/sync/1` — a
peer's tip height, an announcement of the block ids it holds above ours, a request for those ids, and
the blocks themselves, byte-bounded. Every block a peer serves passes the node's apply funnel exactly
as a gossiped one does (→ Sync Integrity). **Headers are read on one path only — fork choice**, which
pages a competing peer's headers to find the fork point and to score the branch by verified work
before a single block of it is fetched (NODE_INTERFACE → Fork choice decides on verified headers;
→ Pull Requests). There is no header store and no headers-first download: a node holds headers for
the blocks it applied and for nothing else.

All messages are positional bodies wrapped in frames; layouts below.

### SyncInfo (code 2)

```
vlqU(tipHeight)
```

`tipHeight` is ≤ `MAX_ADVERTISED_HEIGHT`. A node with no blocks at all sends `0`.

The receiver reads `tipHeight` — the whole of the message and the whole of the sync decision. No
cumulative-work field is carried and no block id: the sync decision is `tipHeight`'s alone, and fork
choice compares work over the header pages it verifies itself (`NODE_INTERFACE → Fork choice decides
on verified headers`), never over a peer's claim about its own chain.

### Inv (code 3)

```
u8(typeId) ‖ arr( hexN(id, 32) )
```

`typeId` 101 = ordering block header; 102 (sub-block) is retired, never reused. The byte is the
type id's whole domain: unknown values decode and are dropped by the handler — unknown codes
preserved, not rejected. 1–`MAX_INV_IDS` (400) ids: the count is read and refused **before the
first element**, and an empty list is malformed — no honest sender announces nothing.

### ModifierRequest (code 4)

```
u8(typeId) ‖ arr( hexN(id, 32) )
```

Same layout and bounds as `Inv` — 1–`MAX_INV_IDS` ids, count refused before the first element,
empty malformed. `typeId` 101 = ordering block, 103 = post body (`MODIFIER_POST_BODY`); 102
retired, never reused. Ids are block hashes for 101, post ids for 103 — 32 bytes either way.

### ModifierResponse (code 5)

```
u8(typeId) ‖ arr( hexN(id, 32) ‖ lp(data) )
```

1–`MAX_INV_IDS` modifiers, count refused before the first element, empty malformed — a peer with
none of the requested modifiers answers **zero bytes** (the stream's "cannot answer"), never an
empty list. `data` is `encodeOrderingBlock` bytes for 101, `encodePostBody` — `lpUtf8(content)` —
for 103.

**`MODIFIER_POST_BODY` (103) is answered from the local store only — never relayed.** A peer
that lacks a body omits the id from its response and the requester rotates peers. No modifier
request is relayed in the tree (`handleModifierRequestMsg` serves blocks from the local store and
omits what it lacks); the rule is stated for bodies because a relay, should one ever be added for
blocks, must not extend to them — it would fan a request for a pruned or withheld body across the
network with nothing to stop it (→ Local-Serve-Before-Relay). Responses are byte-bounded by the same
accumulate-and-stop rule as blocks (`MAX_SERVE_BODY_BYTES`). Each returned body is verified
by the requester against the commitment of the transaction it already holds
(`verifyPostBody`) before it is stored; a mismatch is a misbehaviour penalty.

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
     │ peer replies, then serves continuation     │
     │◄── SyncInfo (height=200) ─────────────────│
     │◄── Inv (type=101, headers from h=1) ──────│
     │                                            │
     │── ModifierRequest (those ids) ────────────►│
     │◄── ModifierResponse (whole ordering       │
     │    blocks 1-200, byte-bounded) ───────────│
     │                                            │
     │ validate + apply; each advancing batch     │
     │ sends the next SyncInfo at once            │
     │── SyncInfo (height=200) ──────────────────►│
     │◄── SyncInfo (height=200) ─────────────────│
     │ equal, inbound → backfill begins           │
     │                                            │
     │ at tip → backfill: rows with no body       │
     │── ModifierRequest (type=103, ≤100 ids,     │
     │    newest first) ─────────────────────────►│
     │◄── ModifierResponse (bodies, byte-bounded; │
     │    ids the peer lacks are omitted) ────────│
     │ verify each against its commit, store,     │
     │ repeat until no row lacks a body           │
     │                                            │
     │ now synced                                 │
```

### Serve Side (Peer Behind Us)

When receiving a SyncInfo:
1. **Reply with our own SyncInfo, addressed to the sender** — whether the sender is behind,
   equal or ahead, and whatever our own phase is: a node at tip that is not syncing from the
   requester still answers. The reply is the only caught-up signal a peer syncing from us
   receives — when it holds our whole chain the continuation below is empty and no Inv is
   sent, so its `syncing → backfill` transition rides entirely on an inbound SyncInfo showing
   equal height. ⛔ **Addressed to the sender, never to our own sync peer** — misaddressed,
   the requester sits at our tip until its stall clock fires.
2. If the sender is behind: compute continuation headers from their best known height + 1,
   cap at 400 headers, send Inv.

**The reply is movement-gated, so replying to replies terminates.** Beside each retained
peer height the machine keeps the tip it last sent that peer and the tip that peer last
reported. An inbound SyncInfo that shows movement — the sender's reported tip differs from
their previous report, or our tip differs from what we last sent them — earns its reply
immediately: this is what lets a two-second sync take its equal-height reply at once instead
of waiting out a poll period. An inbound that shows **no** movement earns a reply at most
once per `MIN_SYNCINFO_INTERVAL_MS` (= 15 000 ms, half the synced-phase poll); the suppressed
reply is dropped, not queued. Two equal-height peers echoing each other therefore settle after
one exchange and stay at one exchange per poll period — never an unbounded ping-pong. The
send on *entering* `syncing` and the progress send (Sync bullet below) are not replies and
are bounded by their own triggers: one per phase transition, one per advancing batch.

A peer reporting height 0 gets a continuation from height 1. This bidirectional pattern ensures
nodes serve peers behind them, not just consume.

### Sync State Machine

```
pick_sync_peer() → sync_from_peer() → backfill() → synced()
       ↑                  │               │
       └── stall/disconnect ──┴───────────────┘
```

- **Pick:** the machine retains each Active peer's last advertised height — the handshake
  `chainHeight` at peer-active, refreshed by every inbound `SyncInfo.tipHeight`, dropped at
  disconnect — and picks the retained-highest peer above our own height, stalled peers
  excluded. The pick runs at peer-active, at every inbound SyncInfo, and at every entry into
  `idle` or `synced` (stall rotation, sync-peer disconnect, backfill's exits), so a taller
  peer learned mid-sync is adopted the moment the current conversation ends — a bridging node
  that syncs the shorter chain first takes the longer one when it finishes, with no new event.
  While `syncing`, only the Switch rule below changes the sync peer; while `backfill`, only
  backfill's own rotation does. Among candidates the pick prefers outbound peers, falling back
  to inbound-only when no outbound candidate exists — eclipse resistance prefers the
  connections we chose; the fallback keeps a node nobody dials syncing. A candidate is only
  ever above our own height, switch targets included.
  ⚠ **Height is the pick's measure, and it is a liveness heuristic, not chain choice.** Under the
  absolute schedule (`MINING_INTERFACE → Difficulty Schedule`) a branch's height at time *t* is
  `schedule(t) + RETARGET_HALFLIFE_BLOCKS · log₂(h / H_a)` — its lag is fixed by its hashrate `h`
  against the anchor's — so of two branches sharing an anchor the taller is the heavier in steady
  state; height and work disagree only in a transient (a chain resuming after a pause mines its owed
  blocks at the floor and is taller hours before it is heavier). **A pick is never final inside the
  horizon**: whichever chain a joiner syncs first, the first non-extending block it is handed from the
  other opens fork choice, which scores that branch to its tip and reorgs to it when it is heavier
  (`NODE_INTERFACE → Fork choice decides on verified headers`), down to `maxReorgDepth` below the tip
  (`TYPES_INTERFACE → Chain reorganisation`). Past the horizon a wrong pick is permanent, and the
  operator remedy is a fresh database and a bootstrap to a known-good peer
- **Sync:** send SyncInfo, process Inv → request headers, validate, append
  to chain, repeat. A batch that strictly advanced the chain sends the next SyncInfo to the
  sync peer immediately (it bypasses the per-peer floor; its bound is the advance itself), so
  a chain longer than one Inv (`MAX_INV_IDS` = 400) syncs batch-on-batch instead of one batch
  per poll interval
- **Switch:** while `syncing`, if the retained-highest peer's height exceeds the current sync
  peer's retained height by more than 1, the machine switches to it. A switch is a rotation
  without a stall: outstanding cleared, progress clock reset, the old peer not marked stalled
- **Backfill:** entered by an inbound equal-height SyncInfo **from the current sync peer** —
  equality reported by any other peer is not a caught-up signal for a conversation it is not
  part of (the provenance stance Invs already have). Ask the node for the
  post ids whose rows hold no body (`setMissingBodiesProvider`), **newest first**, and request
  them from the sync peer in batches of **`BACKFILL_BATCH_IDS` = 100** (`ModifierRequest`,
  type 103). Every returned body is verified against its commitment and handed to the node
  (`onPostBody`); a stored body is **real progress**. Ids the peer omitted are re-asked of the
  next peer on rotation. **The phase ends** when the provider answers empty, **or when the
  remaining ids have been asked of every connected peer without a stored body** — those
  placeholders are left to the synced-phase pulls (the node's block-height schedule), so a body
  nobody serves never keeps a node out of `synced`. Either exit → `synced`.
- **Stall:** 60s without **real progress** (see Sync Integrity below) →
  rotate to different peer, mark current as stalled. On progress, clear
  stall set. The same rule, the same clock, in `backfill`.
- **Peer rotation:** `stalledPeers: Set<PeerId>` — peers that failed to
  produce progress. On stall the pick runs again with the stalled set excluded (the Pick
  bullet's preference applies). A stall mark clears when that peer completes a new handshake
  or reports a tip above ours, and the whole set clears at every entry into `synced`; with
  every candidate stalled the machine sits `idle` until one of those clears fires.
- **Synced:** periodic SyncInfo (30s) to the sync peer; the reply it earns (Serve Side, rule 1)
  is how new blocks are detected — a reply showing a taller tip re-enters `syncing` through
  the pick. An Inv is acted on only while syncing and only from the current sync peer (see
  Sync Integrity — request provenance); an Inv from any other peer, or
  while not syncing, is dropped without penalty. Placeholder rows created
  after `synced` — a gossiped block whose packet this node missed — are the
  node's to pull: it calls `requestPostBodies(wanted, peerId)` — the ids with
  their commitments — from its block-applied hook, the relaying peer first,
  then other connected peers, on a per-id schedule in block height
  (NODE_INTERFACE → Store Interface → Posts DAG, "Backfill after sync"); net
  serves the request and returns the verified bodies to the caller, it runs no
  timer of its own for it.

### Sync Integrity (audit M-10)

- **Response binding — sender and label, never content.** A `ModifierResponse` is
  processed only if it answers an outstanding `ModifierRequest` this node previously
  sent **to that same peer**: the machine tracks the requested modifier ids per
  request target; a response modifier whose id was not requested from its sender is
  dropped — dropped, not penalized, because a response can legitimately cross a peer
  rotation in flight. Requests are only ever sent to the current sync peer, so no
  *other* peer can feed this path. **The id is a label: `data` is never hashed and
  never compared against `id`**, so the sync peer itself can answer a request for
  block X with any bytes whatsoever. What protects the store is the node's apply
  funnel — structure gate, chain linkage, PoW — which every sync-delivered block
  passes through exactly as a gossiped one does; a mislabelled response costs this
  node one outstanding slot until the block is re-announced, never a stored block.
  Net owns the sender-and-label check; the funnel owns content validity.
- **Request provenance.** While syncing, only an Inv from the current sync
  peer may trigger a `ModifierRequest`. A third party's Inv must neither
  cause requests nor grow the outstanding set.
- **Outstanding-set lifecycle.** Ids are added when a request is sent,
  removed as matching response modifiers are accepted, bounded by a fixed
  cap (new requests must not grow the set past it), and cleared on peer
  rotation, on a mid-sync switch, and on sync-peer disconnect. The framed sync path has no
  per-request timer — stall rotation IS the request timeout.
- **Stall progress = chain height.** The stall clock advances only when
  applying a response strictly increases `chainHeight` — never on mere
  receipt of bytes or non-advancing modifiers. A peer feeding junk
  therefore stalls out and is rotated away within one stall window; it
  cannot pin sync indefinitely.

### Block Body Download

There is no separate body download: a block carries its whole body, and the
modifier conversation moves whole serialized ordering blocks, byte-bounded at
`MAX_SERVE_BODY_BYTES`. **Post bodies are the one thing a block does not carry** — it carries
their commits — so they are the one thing fetched by id after the chain: `MODIFIER_POST_BODY`
in the `backfill` phase and, once synced, for any placeholder row the node creates
(→ Sync State Machine; NODE_INTERFACE → Store Interface → Posts DAG).

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
  protocolVersion: number // the version the peer declared — its build's highest
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

Body: **zero bytes** — the decoder refuses any non-empty body. A peer receiving this queries
PeerDb for up to 8 recently-seen
non-blacklisted, non-self peers (excluding the requester's address) and
responds with `Peers`.

Sent to each connected peer every `GET_PEERS_INTERVAL_MS` (120000, 2 min)
while connected. An inbound `GetPeers` is answered whatever our own sync
phase is — serving discovery does not depend on being synced.

### Peers (code 9)

```
arr( lpUtf8(address) ‖ lpUtf8(agentName) ‖ lpUtf8(nodeName) ‖
     vlqU(protocolVersion) ‖ arr(vlqU(capability)) )
```

0–`MAX_PEERS_ENTRIES` (64) entries; the count is refused **before the first entry is read**, and
a body declaring more is a permanent ban of the sender. Empty selection produces an empty list.
`address` ≤ `MAX_ADDRESS_BYTES` bytes (multiaddr); `agentName` / `nodeName` ≤ `MAX_NAME_BYTES`.

**Encoding.** Both bodies are positional codecs like every other framed message; there is no
second dialect. Decoding is `decodeStruct`'s boundary check (`sync-codec.ts`), and every entry
field carries **exactly the handshake codec's rules for the same field**. Pinning them to the
handshake's bounds rather than restating them is deliberate: the two carry the same values, and
a looser rule here would mean two implementations disagreeing about which sender gets banned.
`null` is a `ProtocolViolation` (permanent ban); field enforcement is not optional, because each
field reaches string and dial paths.

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
- Dial each bootstrap seed **whose peer is not already connected**, with retry/backoff. A seed that
  holds a live connection is skipped: a network with fewer seeds than `minPeers` stays below the
  floor by construction, and re-dialing a connected seed every tick would open a fresh connection
  and run a fresh handshake against it each time
- PeerDb not consulted — seeds are the bootstrap source

> ⚠ **AHEAD OF CODE — 2026-08-30.** The floor re-dials every seed each tick while below `minPeers`, connected or not. The
> testnet-bootstrap-default unit's net dispatch.

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

| Penalty | Trigger | Score |
|---------|---------|-------|
| `misbehavior` | Invalid message — fails Stage 1: structure, ordering-block PoW, the packet rule (a post without a body or a body without a post), a body that fails `verifyPostBody`, or the karma-membership gate (`gossip.ts` call sites); a pulled body that fails its commitment (the `MODIFIER_POST_BODY` receive arm) | 100 |
| `ProtocolViolation` | Undecodable/malformed frame or message; wrong-network handshake | permanent ban |
| `Transient` | Transient handshake failure / timeout (`handshake.ts`) | 50 |
| `Transient` | A version mismatch — a gossiped block or transaction whose declared version is not its era (`gossip.ts` call sites), or a header segment `verifyHeaderChain` refuses with reason `'version'` in fork resolution (via `NetNode.penalizePeer`): compatibility, never a violation | 50 |
| `misbehavior` | Fork resolution, via `NetNode.penalizePeer` from node's `resolveFork` (NODE_INTERFACE → Fork choice decides on verified headers): a header segment that fails `verifyHeaderChain` other than the window-miss case and the `'version'` reason; a segment containing a refused header; a delivered block whose hash is not the verified header's; a verified-header chain rejected by the apply funnel | 100 |
| `Transient` | Fork resolution, via `NetNode.penalizePeer`: a block answer shorter than the verified segment (non-delivery) | 50 |

**`NetNode.penalizePeer(peerId, kind: 'misbehavior' | 'transient', reason)`** is node's one call
into this system: it records the named tier against the peer with the reason string and nothing
else — accrual, decay and the ban threshold below apply unchanged, and a peer the manager does not
know is a no-op (the counterparty comes off the Active list; an unknown one is a disconnect race,
not a target). It is the producing call site of the two fork-resolution rows.

The table is the whole system: every `PenaltyType` and `PenaltyKind` member has
a producing call site.

Accumulated score >= threshold → temporal ban for `temporalBanDuration`.

### Accrual and decay (audit L-13)

**Every penalty accrues.** A penalty is never discarded because another
one arrived recently — that made ban pressure independent of attack
rate, since a peer flooding invalid messages paid exactly what a peer
misbehaving once every safe interval paid, while each invalid message
still cost full Stage-1 work (ordering-block PoW verification included).

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

> ⚠ **QUALIFIED — verified 2026-08-22.** The tree relays no request at all:
> `handleModifierRequestMsg` (`sync-machine.ts`) serves blocks from the local store and omits the
> ids it lacks, and no serve-or-relay helper exists in the package. The rule binds any relay that
> is ever added; until one is, the serve half is the whole of it.

**One modifier type never relays: `MODIFIER_POST_BODY` (103) is served locally or omitted.**
A body request names a post id; a peer that holds the body answers, a peer that does not
leaves the id out, and the requester asks another peer. Relaying a body request would carry a
query for a pruned or never-published body to every peer with nothing to terminate it, and
the answer a relay could bring back is one the requester can just as well fetch itself from
the peer that has it (→ ModifierRequest).

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
| `/dagsocial/sync/1` | Frame | Historical sync, peer discovery, content sweep, fork resolution (codes 2–11, 14–17) |

**These two are the whole set.** Every chain-data query multiplexes over the sync stream and the
frame `code` byte disambiguates it. A second stream protocol for chain data is what codes exist to
avoid: it duplicates the framing, the caps and the serve loop, and — because protocol handlers are
registered per protocol — it acquires its own admission policy by omission rather than by decision.

### `GetHeaders` / `GetBlocks` responses — positional, `arr(item, lp)`

**Landed 2026-08-10.** Both arms previously answered in a **second wire format** — `encode({ blocks })`
/ `encode(headers)` out, `decode(raw) as {…}` back — bare `cbor-x` plus a TypeScript cast, while every
other whole-block path in this package used `encode`/`decodeOrderingBlock`. A cast is not a check, and
the gap was **measured**: it was the sole delivery path for a remote fail-stop. Shape-validating
the CBOR would have been the band-aid; the root cause was the second dialect, so the dialect is gone.

- **Blocks:** `arr(blocks, lp(encodeOrderingBlock))`. **Headers:** `arr(headers, lp(encodeHeader))`.
- **The per-element `lp` is load-bearing**: it gives each item its own byte span, so the four-part
  boundary check (spec §2.1) runs over exactly that span — exhaustion and re-encode compare included —
  and a malformed block is rejected at its own offset rather than as an outer mismatch.
- **The requests are positional too**, and carry no `mode` field — the code pair is the
  discriminator:

  ```
  GetHeaders (14):  vlqU(startHeight) vlqU(maxCount)
  GetBlocks  (16):  vlqU(startHeight) vlqU(endHeight)
  ```

  A response is identified by its own frame code, so a caller checks `MSG_HEADERS` / `MSG_BLOCKS`
  rather than trusting that the answer matches the question it asked.
- ⚠ **Zero bytes and `vlqU(0)` are DISTINCT and consumers depend on it.** Zero bytes is the handler's
  *"I cannot answer"*; `vlqU(0)` is *"no items"*. Collapsing them is a live defect — see below.
- **`MAX_CHAIN_RESPONSE_ITEMS = 400`, enforced on BOTH sides**, and the receive cap is
  `min(requested, 400)` **checked before the first element is read**. A peer answering a 400-header
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
- ⛔ **The `Blocks` serve arm is byte-bounded as well as count-bounded**, and the two bounds answer
  different questions. `MAX_CHAIN_RESPONSE_ITEMS` bounds how many blocks we assemble; it says nothing
  about their weight, and blocks are bounded individually by `MAX_BLOCK_BODY_BYTES` (`TYPES_INTERFACE`
  → Size caps) at up to 2 MB each. 400 × 2 MB is far past the requester's `MAX_STREAM_BYTES`, so a
  count-only bound produces a response no peer can read — a stall that appears exactly when blocks
  are full and never before.

  The rule is `handleModifierRequestMsg`'s, applied here: accumulate encoded bytes, stop before
  exceeding `MAX_SERVE_BODY_BYTES`, and **always include the first block** so an oversized one moves
  rather than wedging sync. A truncated response costs the requester one round trip — it re-asks for
  what is still missing on the next `SyncInfo` round — and never costs it the chain.

  **Each block is encoded once.** The bytes the bound weighs are the bytes the response carries, so
  blocks reach the framing already encoded rather than being encoded to measure and again to send.
  ⚠ **This package's `A9` means no gate here measures cost**, so a doubling on a serve path would
  pass the whole suite; it is a decision, not an optimisation.
- **The `Headers` arm stays count-bounded, and that is a measurement rather than an oversight.** A
  header encodes to **at most 169 B** — 129 fixed (three 32-byte hex roots, a 33-byte `stateRoot`
  carrying the AVL height byte, a 32-byte `validatorId`) plus five `vlqU` fields at 8 bytes each when
  every one sits at `Number.MAX_SAFE_INTEGER`. At the 400-item cap that is **~66.8 KiB, about 1.6 %**
  of `MAX_SERVE_BODY_BYTES`. A byte bound there would be a rule with no subject.

  ⚠ **169 B is the ceiling, not a typical header** — a realistic one measures 145 B. The distinction
  is the point: a bound must be argued from the ceiling, and an instance measured and reported as a
  ceiling is how a limit ends up justified by a number nothing enforces.
- **A response that does not decode THROWS; it must never resolve to `[]`.** `requestBlocks`' result
  goes straight to `reorg(forkHeight, newBlocks)`, which reverts above the fork point and applies what
  it is given — so an empty array *truncates our own chain* instead of failing to extend it.

Removed protocols:
- The old text-based `/dagsocial/sync/1` (individual sub-block request/response) —
  its framed successors, codes 6–7, are themselves retired with sub-blocks
- `/dagsocial/headers/1` — replaced by GetHeaders/Headers and GetBlocks/Blocks (codes 14–17).
  Its two queries kept their signatures; what changed is the stream they ride, the encoding of the
  request, and the admission policy that reaches them.

---

## Validation Architecture

Two-stage validation, modeled after Ergo's modifier processing:

### Stage 1 (net package, stateless)

Runs inside the gossipsub topic validators — i.e. **before** a message is
forwarded to mesh peers. A message that fails Stage 1 is Rejected (never
forwarded) and penalized: undecodable → `ProtocolViolation` (permanent
ban); well-formed but invalid → misbehavior penalty (100), except a version mismatch, which is
`Transient` (→ Peer Penalty System). Uses `@dagsocial/validation`. Per topic:

| Topic | Checks before Accept |
|-------|----------------------|
| ordering-block | `verifyOrderingBlockStructure`; protocol version — `verifyProtocolVersion(header.protocolVersion, header.height, schedule)`, a mismatch Rejected with `Transient`; `header.height` is a safe integer (NaN/float/±Infinity → Reject); ordering-block PoW (`verifyOrderingBlockPoW`) — the solution must satisfy the header's own `powTargetBits` (bounded ≥ `ORDERING_BLOCK_POW_TARGET_FLOOR` by structure), and a non-safe-integer `powNonce`/`powTargetBits` never verifies (audit M-6, M-9) |
| tx | `decodeTxPacket`; `verifyTxStructure`; protocol version — `verifyTxProtocolVersion(tx, chainHeight() + 1, schedule)`, the envelope's and the commit's against the next block's era, a mismatch Rejected with `Transient`; the packet rule (`tx.post` present ⟺ `content` present); `verifyPostBody(content, tx.post.contentHash)` for a post-bearing tx; then the cached karma-membership gate — the author holds karma at all (`NODE_INTERFACE` → Post transactions). Order as under Gossip Topics |

Stage 1 is stateless. It does **not** check the difficulty schedule
(`powTargetBits` against the schedule over the stored parent, `MINING_INTERFACE → Difficulty
Schedule`), the header timestamp rules, chain linkage, validator signatures, or state roots — those are apply-time checks in
`@dagsocial/node`, enforced for every entry path (gossip, sync, reorg) by
the block-apply funnel. The relay PoW gate exists to make mesh propagation
cost-bearing: no zero-work ordering block may be re-gossiped (audit M-9).

### Stage 2 (node package, stateful)

Runs after Stage 1 passes, via registered `on*` callbacks:

- Parent refs exist (live post or stump)
- Author has sufficient karma
- UTXO inputs unspent, each transition's authorization satisfied
- A post packet that passes is admitted as one: the transaction into the mempool and the body
  into the DAG as a pending row, together or not at all (`NODE_INTERFACE` → Post transactions)

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
| `tipApplied(height)` | `(number) => void` | The node reports each applied tip — every successful apply and the tip a reorg leaves, at the seam where it stamps `dag_tip_height`. When `protocolVersionAt(schedule, height + 1)` is above the era last in force, the boundary sweep runs (→ Post-Handshake Routing); inside an era it does nothing |
| `syncPhase()` | `() => 'idle' \| 'syncing' \| 'backfill' \| 'synced'` | The sync machine's phase (Sync State Machine). `'idle'` means no sync has been needed: before `start()`, after `stop()`, and on a node that never met a peer ahead of it — a co-started mesh follows gossip at `'idle'` and never enters `'synced'`; only a node that fell behind passes through `'syncing'` → `'backfill'` → `'synced'`. A reader wanting "not behind" tests for `'syncing'`/`'backfill'` absent, not for `'synced'` present |

### Gossip

| Function | Signature | Description |
|----------|-----------|-------------|
| `broadcastOrderingBlock(b)` | `(OrderingBlock) => Promise<void>` | Gossip a newly created ordering block |
| `broadcastTx(tx, content?)` | `(UtxoTransaction, string?) => Promise<void>` | Gossip a transaction **packet** — `encodeTxPacket(tx, content)`; a post's body travels in the same message (→ Gossip Topics). The caller passes `content` ⟺ `tx.post` is set. |

### Inbound Processing

| Function | Signature | Description |
|----------|-----------|-------------|
| `onOrderingBlock(callback)` | `((OrderingBlock, fromPeerId: string) => void) => void` | Register handler for inbound ordering blocks. `fromPeerId` is the peer that **relayed** the block to us, or `''` — see below |
| `onTx(callback)` | `((UtxoTransaction, content: string \| undefined, fromPeerId: string) => void) => void` | Register handler for inbound transaction packets. `content` is the verified body when the transaction carries a post (the validator has already checked it against `tx.post.contentHash`), `undefined` otherwise; `fromPeerId` carries the same relayed-peer semantics as `onOrderingBlock`'s. |

⚠ **`fromPeerId` is not guaranteed to be a peer id.** It is read defensively from the gossip event's
`propagationSource`, which the gossipsub type declares required — and *required by the type* is not
*present at runtime*, while net's invariant is that one bad message degrades one message rather than
the subsystem. A source-less event therefore delivers **`''`**, which is not a peer id and matches no
entry in `getConnectedPeers()`.

**A consumer must treat `fromPeerId` as a hint to be checked, never as an identity to be trusted.**
Reading this field as always-a-peer is what makes a membership test look decorative, and the
membership test is the thing standing between a relayed hint and a counterparty choice.

### Pull Requests (Peer-to-Peer)

| Function | Signature | Description |
|----------|-----------|-------------|
| `requestHeaders(start, max, peerId)` | `(number, number, string) => Promise<BlockHeader[]>` | Request block headers for fork resolution (codes 14/15) |
| `requestBlocks(start, end, peerId)` | `(number, number, string) => Promise<OrderingBlock[]>` | Request full blocks for reorg (codes 16/17) |
| `requestPostBodies(wanted, peerId)` | `({ id: string; contentHash: Uint8Array }[], string) => Promise<{ id: string; content: string }[]>` | Request post bodies by id from one peer (`ModifierRequest` type 103 on the sync stream, codes 4/5); the caller supplies each id's commitment. Answers carry only the ids the peer holds; each body is decoded and verified against its commitment before it is returned — a mismatch or an undecodable body is a misbehaviour penalty and is dropped — and **the verified bodies are returned to the caller, which stores them** (the node's placeholder pulls after `synced`); `onPostBody` is the `backfill` phase's delivery path, not this call's |
| `peerTipHeight(peerId)` | `(string) => number \| null` | The height the sync machine retains for an Active peer — the handshake `chainHeight`, refreshed by every inbound `SyncInfo` (→ Sync State Machine, Pick); `null` for a peer it does not retain. Fork resolution's re-score memo reads it (NODE_INTERFACE → Fork choice decides on verified headers): a branch scored lighter is not walked again until this number moves. A read of retained state, no message |

⚠ **Both chain queries THROW rather than return empty** on an unexpected frame
code or a malformed body — a decoded-but-empty answer is a statement ("no blocks"),
a throw is not, and the caller must be able to tell them apart. `requestBlocks`'
result reaches `reorg(forkHeight, newBlocks)` only after node has checked every page of it
against the verified hashes — heights consecutive from the first still missing, each block
hashing to the verified hash at its height (NODE_INTERFACE → Fork choice decides on verified
headers); a page adding nothing or a substituted block is refused there and penalised through
`penalizePeer` (Peer Penalty System).

**Fork resolution pages, and asks for nothing it has not verified.** The fork point is found by
paging the peer's headers **down from our own tip** — `requestHeaders(ourTip, MAX_CHAIN_RESPONSE_ITEMS)`,
then from the lowest height seen − 1 — over at most `⌈maxReorgDepth / 400⌉` pages; the competing
branch is then scored **upward** in pages of the same query, each verified against the anchor the
previous page returned, until it is heavier than ours above the fork or it ends (NODE_INTERFACE → Fork
choice decides on verified headers). The block range then requested is `forkHeight + 1 … forkHeight +
n` for the `n` headers verified, fetched in pages of `requestBlocks`, each page checked for identity as
it lands — never a height the peer claimed. The descending serve arm and its clamp to the peer's tip
(→ `GetHeaders` / `GetBlocks` responses) are what the upward walk relies on: a request above the tip
answers from the tip down, so the trimmed page is the next 400 or the remainder.

**The gossip source is what fork resolution asks.** `resolveFork` takes the peer that relayed the
competing block and uses it as the counterparty when it is still in `getConnectedPeers()`, falling back
to that list otherwise. That peer provably holds the fork chain; an arbitrary connected peer does not,
and asking one that does not is indistinguishable at the call site from a peer that has no reorg to
offer.

### Sync Handler Registration

| Function | Signature | Description |
|----------|-----------|-------------|
| `setBlocksHandler(cb)` | `((block: OrderingBlock, fromPeerId: string) => boolean) => void` | Handler for blocks received during sync. `fromPeerId` is the peer whose response carried the block. The return is the batch's **continue** signal — `true` for a block the handler applied or already held, `false` for one it rejected or one that extends nothing (node then resolves the fork with `fromPeerId` as counterparty) — and `appendBlocks` **stops the batch at the first `false`**: the blocks after it are chained to the one that did not apply. Progress is still measured by chain height (audit M-10), never by this return |
| `setHeadersHandler(cb)` | `((height: number) => OrderingBlock \| null) => void` | Provider for `GetHeaders` / `GetBlocks` (codes 14, 16) and for the blocks a `ModifierResponse` serves (`serializeOrderingBlock` re-encodes the provider's block). Returns the whole block, not the header: one provider serves both query responses — `Headers` reads `.header`, `Blocks` returns the block. **Never the tip height, never a block id** — those are the rows below |
| `setChainHeightProvider(cb)` | `(() => number) => void` | Provider for the chain tip height — the one number behind the handshake `chainHeight`, `SyncInfo.tipHeight`, every `peerHeight > ourHeight` comparison, the stall-progress measure and the served chain query's tip. **One read is one provider call**: `SyncStore.chainHeight()` returns the provider's value and never walks the chain through the headers provider (ARCHITECTURE → Correct and cheap are separate obligations). Unset → `0`, as a node with no chain. The node hands over its store's `MAX(height)` — the same tip its block creator and fork resolution read — so the height `net` advertises is the height the node mines on |
| `setBlockIdProvider(cb)` | `((height: number) => string \| null) => void` | Provider for the block id at a height — behind the ids an Inv continuation announces to a peer behind us. The id is the store's own, written at block application; `net` never computes an id from a header. **One id is one provider call**, a point read that decodes no block (ARCHITECTURE → Correct and cheap are separate obligations). Unset → `null` — nothing to announce |
| `setHeightByBlockIdProvider(cb)` | `((id: string) => number \| null) => void` | Provider for the height holding a block id, or `null` for an id not on our chain — the read that filters an inbound `Inv` (an id we hold or already requested is not re-requested) and resolves a `ModifierRequest`'s ids to the heights it serves from. **One id is one provider call, never a chain walk**: a message of k ids costs k point lookups, and no message rebuilds an id index of the whole chain (ARCHITECTURE → Correct and cheap are separate obligations). Unset → `null` — every id unknown, nothing served |
| `onSyncComplete(cb)` | `(() => void) => void` | Fired on every entry into the `synced` phase |
| `setPostBodyProvider(cb)` | `((postId: string) => string \| null) => void` | Provider for the `MODIFIER_POST_BODY` serve arm: the body this node holds for the id, or `null` — served locally or omitted, never relayed (→ Local-Serve-Before-Relay). |
| `setMissingBodiesProvider(cb)` | `((limit: number) => { id: string; contentHash: Uint8Array }[]) => void` | Provider the `backfill` phase reads: up to `limit` post ids whose rows hold no body, newest first, each with the commitment the body must hash to. An empty answer ends the phase. |
| `onPostBody(cb)` | `((postId: string, content: string, fromPeerId: string) => boolean) => void` | Delivery of a pulled body that verified against its commitment. The handler stores it and returns `true` (real progress for the stall clock) or `false` (row gone or already filled — no progress, no penalty). |
| `onPeerActive(cb)` | `((peerId: string, direction: 'inbound' \| 'outbound') => void) => void` | Fired when a peer completes the handshake and becomes Active; `direction` is the connection's. |
| `onPeerDisconnected(cb)` | `((peerId: string, reason: string) => void) => void` | Fired after a peer's disconnect is processed (`PeerManager.removePeer`). `reason` is always `''` — libp2p's `peer:disconnect` carries none; the parameter is the shape JOURNAL_EVENTS → peer_disconnected names. |
| `onPeerPenalised(cb)` | `((peerId: string, kind: string, detail: string \| null) => void) => void` | Fired by `PeerManager` itself at its two penalty entries, `recordPenalty` and `recordPenaltyKind` — so every path that records a penalty reaches it, `gossip.ts`'s and `penalizePeer`'s included; `kind` is the `PenaltyType` / `PenaltyKind` string as recorded, `detail` the reason. |

**These four are what JOURNAL_EVENTS → Peer Events / Sync Events and NODE_INTERFACE → Admin Listener read** —
`peer_connected` from `onPeerActive`, `peer_disconnected`, `peer_penalised`, `sync_complete` from `onSyncComplete`;
`syncing` from `syncPhase()`.

**Handler setters are order-independent.** Every setter above stores a delegate and has no libp2p side
effect, so it is valid before or after `start()`, and a later call replaces the delegate. Registering a
libp2p protocol is `start()`'s responsibility alone. A setter that also registers makes its own call
order load-bearing with nothing to signal it: the registration reads a libp2p instance that `start()`
has not created yet, the guard falls through, and every layer beneath keeps passing — the protocol is
simply absent for the life of the process, which a peer sees as `protocol selection failed` and reads
as the peer's fault rather than ours.

**A node that has registered no headers provider answers zero bytes** to `GetHeaders` / `GetBlocks`,
rather than leaving the stream unanswered. Zero bytes is "I cannot answer", and it is distinct from an
empty header *list* — one byte, `vlqU(0)` — which means "I consulted my chain and have nothing at that
height". A node holding no provider has no chain to consult, so it cannot honestly send the second. Both
reach the caller as an empty array, and fork resolution treats that as "no reorg" like any other
non-match, so nothing downstream needs a new case.

**Silence is not equivalent to either, and it is now the failure mode to design against.** An
unrecognized code falls through the serve arms to `SyncMachine.handleMessage`, which answers nothing —
so a peer that speaks `/dagsocial/sync/1` but does not know code 14 leaves the requester blocked for its
full timeout, and `requestBlocks` runs a **5× timeout** because blocks are bigger. Both serve arms must
therefore answer on every path, including the ones that decline to serve.

⚠ **This is the one semantic the migration does not preserve.** A separate protocol failed *fast*: an
unregistered `/dagsocial/headers/1` reached the caller as a rejected promise from libp2p's protocol
selection, so "this peer has nothing to serve" and "this peer does not speak the query" were different
events at the call site. On a shared stream the second becomes a timeout. The trade is deliberate — the
gain is that a single registered protocol carries one admission policy (Active-only, penalty-bearing)
instead of two, and a query on the shared stream is unreachable by a peer that never handshook.

---

## Config

```typescript
interface NetConfig {
  // Transport
  bootstrapPeers: string[]
  listenAddrs: string
  maxPeers: number

  // Network — REQUIRED, supplied by the node from its resolved profile.
  // No default; see §Magic Bytes and §Consensus parameters net enforces.
  magic: number                    // mainnet 0x4D444147 · testnet 0x54444147 · devnet 0x44444147
  protocolVersionSchedule: readonly ProtocolEra[]   // the profile's era table (TYPES_INTERFACE → Version):
                                   // the handshake, the tx validator and the boundary sweep read the
                                   // era at chainHeight() + 1 from it; the block validator each header's

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

Stage-1 relay validation checks ordering-block proof-of-work before forwarding
(`verifyOrderingBlockStructure` + `verifyOrderingBlockPoW`), but that check needs no
per-network parameter: a block is checked against its own header's `powTargetBits` and the
`ORDERING_BLOCK_POW_TARGET_FLOOR` constant from `@dagsocial/types`. The one per-network
value net receives is `magic`. Net receives values; it does not resolve them, does not
import `NetworkProfile`, and reads no environment variable for them.

| Value | Why net needs it | Today |
|---|---|---|
| `magic` | Frame assembly and the frame-magic check | ✅ Supplied by the node from its resolved profile — see §Magic Bytes |

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
- UTXO transactions received from peers are validated and forwarded to the
  local node's mempool
- Ordering blocks received from peers are validated and applied
- Locally-produced ordering blocks and locally-submitted transactions are
  gossiped to peers — a post's transaction and its body as one packet
- Post bodies are served by id from the local store to peers that ask, backfilled for every
  placeholder row in the `backfill` phase, and delivered to the node only after verifying
  against their commitment
- PeerDb populated from handshakes and Peers gossip; outbound manager
  maintaining peer count between minPeers and maxPeers

## Invariants

- Frame magic bytes reject wrong-network connections at the transport layer
- Frame checksum catches corruption before body parsing
- Stream protocols carry framed messages; Gossipsub topics carry the object's
  own positional wire encoding, unframed
- Sync is bidirectional — nodes serve peers behind them, not just consume
- Unknown message codes and peer capabilities are preserved, not rejected
- PeerDb self-address filter prevents self-dial loops
- Bogus addresses filtered silently; malformed Peers trigger permanent ban
- Stage 1 reads no store — its one stateful input is the cached
  karma-membership set (`NODE_INTERFACE` → Post transactions); the body check reads only
  the packet's own transaction for its commitment
- A post body crosses the network only inside its transaction's packet or as a
  `MODIFIER_POST_BODY` answer — never as a message of its own, never hashed into an id
- A body request is served locally or omitted — never relayed
- Ordering blocks are verified before application — a block extending an
  unknown chain may be buffered but never applied
- UTXO transactions are verified against the local UTXO view — conflicting
  transactions (double-spends) are rejected at gossip time
- Peer identity (libp2p) is independent of account identity (Ed25519 keypair)
- Topic names include protocol version — incompatible wire format changes
  get a new topic
- Inbound messages are re-verified before forwarding and storing
