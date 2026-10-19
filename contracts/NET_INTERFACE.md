# NET Interface Contract

**Component:** `@dagsocial/net`
**Protocol version:** 2
**Last updated:** 2026-08-24

## Scope

libp2p-based peer-to-peer networking for DAGsocial. Owns: wire framing,
handshake, headers-first sync scheduled for the node's pipeline (headers by locator, blocks by id), peer discovery,
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
| 2 | `SyncInfo` | both | The sender's claim — its applied tip's height and hash |
| 3 | — | | **Retired** (was `Inv`) — never reuse |
| 4 | `ModifierRequest` | → | "Send me these post bodies" — type 103, ids |
| 5 | `ModifierResponse` | ← | Serialized post bodies |
| 6 | — | | **Retired** (was `GetSubBlock`) — never reuse |
| 7 | — | | **Retired** (was `SubBlockResponse`) — never reuse |
| 8 | `GetPeers` | → | Request peer list |
| 9 | `Peers` | ← | Peer list response |
| 10 | — | | **Retired** (was `GetPosts`) — never reuse |
| 11 | — | | **Retired** (was `Posts`) — never reuse |
| 12 | — | | **Retired** (was `GetStumps`; P2-F F1) — never reuse |
| 13 | — | | **Retired** (was `Stumps`; P2-F F1) — never reuse |
| 14 | `GetHeaders` | → | Request headers above a locator |
| 15 | `Headers` | ← | Header list response, ascending |
| 16 | `GetBlocks` | → | Request whole ordering blocks by id |
| 17 | `Blocks` | ← | Ordering block list response |

Codes 6–7, 10–11 and 12–13 are holes: a post is a transaction and a block
carries its posts' commits in `utxoTxs`, so no post crosses the network as its own
message — its **body** crosses only as the trailing field of the transaction's packet on
the `tx` topic (→ Gossip Topics) and as a `MODIFIER_POST_BODY` modifier on codes 4/5
(→ ModifierRequest), keyed by the post id and checkable against the commit the requester
already holds; a post as an object in its own right (codes 10/11) is what cannot be verified
(TYPES_INTERFACE → What "verify a post" means now). A new message takes the lowest free code.

**This table is the code allocator; `net/src/types.ts` mirrors it.**
⚠ **Not every allocation is findable by grepping `MSG_`** —
`handshake.ts:72` frames its code as the literal `1` rather than through `MSG_HANDSHAKE`, so a
`MSG_`-keyed search misses allocations. The sweep that finds them all is
`grep -rn 'encodeFrame([A-Za-z_.]*, *[0-9]' packages/`, read together with this table.

Codes 14–17 carry the scheduler's two queries (→ Historical Sync): headers above a **locator** — this
node's best chain named by hashes, so the server finds the fork point on its own applied chain in one round
trip — and blocks by **id**, the ids the node's pipeline wants. Codes 4/5 carry post bodies by id
(→ ModifierRequest), and code 2 a peer's claim.

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
| `/dagsocial/<magic>/ordering-block/1` | OrderingBlock (positional) | Critical | Consensus anchors |
| `/dagsocial/<magic>/tx/1` | Transaction **packet** — `encodeTxPacket(tx, content?)`: `encodeTx(tx)` ‖ `opt(lpUtf8(content))` (TYPES_INTERFACE → Layout — UtxoTransaction, the packet codec) | High | Posts (with their body), likes, invites, vouches, credit transfers |

**A topic is named for its network.** `<magic>` is the profile's wire magic (→ Magic Bytes) as eight
lowercase hex digits — `4d444147` on mainnet, `54444147` on testnet, `44444147` on devnet. A node builds
its two topic strings from `NetConfig.magic` at `start()` — a magic that is not an unsigned 32-bit
integer refuses the start — and they are the whole of what its router hears: it subscribes to both, and
a subscription or a message on any other topic is passed over before the router names, caches or
forwards anything (gossipsub's `allowedTopics`). A node of another network therefore shares no topic
with this one. The name keeps apart nodes that follow the protocol and does no more than that: a peer
may publish on any topic, and what it publishes on one of ours meets Stage 1 like any message
(→ Validation Architecture).

**A message is its topic and its data.** Gossip is unsigned (gossipsub's `StrictNoSign`): a published
message carries no publisher, no sequence number, no signature and no key, so nothing in it names the
node it came from, and the router refuses a message that carries a signature, a sequence number or a
key before any topic validator runs. What authenticates a payload is the payload — an ordering block's
proof of work at Stage 1, a transaction's signatures at Stage 2 — and the one peer a message is
attributed to is the hop that sent it (→ Penalty Attribution).

**A message is named by its bytes.** The message id is `hash32(lpUtf8(topic) ‖ data)` — the protocol
hash (`TYPES_INTERFACE → The protocol hash`) over the topic string, length-prefixed, and the payload's
bytes — for a message this node publishes as for one it receives. The same bytes on one topic are one
message, whichever peer sends them and however often; the same bytes on the two topics are two. The
topic is in the preimage because the router records an id before the topic's validator runs: under an
id over the data alone, a block's bytes sent on the `tx` topic would be refused there and leave the
block itself unheard for the seen window. The id is the router's alone — its seen set and its `IHAVE`
and `IWANT` exchange — and enters no commitment, no store and no signature, so its preimage carries no
domain tag.

**A message is heard once in a seen window.** The router keeps every id it has named for
`GOSSIP_SEEN_WINDOW_MS` — 120 000, two minutes — and records it before the topic's validator runs. A
second copy inside the window, from any peer, is not validated, not delivered and not forwarded. That
holds for a message Stage 1 refused as for one it accepted, so a refusal stands for the window. A
publish of bytes this node has seen on the topic inside the window sends nothing and resolves
(→ Gossip). Past the window the same bytes are a message again: the name bounds a replay to one hearing
a window at each node. What ends a replay at the first hop is what the node knows of the object: an
ordering block whose header it holds, has refused, or accepted inside the window is Ignored at Stage 1
(→ Stage 1 → "A header this node knows is Ignored"), and a transaction it already holds is not admitted,
so not forwarded (→ Forwarding Rule).

**The envelope, the id and the topic names are one per network.** A node that signs and one that does
not refuse each other's messages, two nodes that name a topic differently share none of it, and two
that name a message differently cannot ask each other for one. A change to any of the three therefore
reaches every node of a network in one restart; it moves no committed byte and owes no reset
(`ARCHITECTURE → Deploy gate`).

**The packet rule: `tx.post` present ⟺ `content` present.** The topic validator checks it
in this order, and in the same order on every node: `decodeTxPacket` (undecodable →
`ProtocolViolation`, permanent ban) → `verifyTxStructure` → protocol version (a mismatch Rejected,
no penalty) → the biconditional (a post without a body, or a body without a post → misbehaviour
penalty, Reject) → `verifyPostBody(content, tx.post.contentHash)` (VALIDATION_INTERFACE →
verifyPostBody; a failing body → misbehaviour penalty, Reject) → the karma-membership gate (a miss
Rejected, no penalty) → `verifyTxSignatures(tx)` (VALIDATION_INTERFACE → verifyTxSignatures; a
signature that does not verify → misbehaviour penalty, Reject). A packet that passes
is delivered whole to `onTx(tx, content, fromPeerId)`; a post's transaction and its body are
never accepted apart. The body is outside every id, so a relay cannot re-point it without
failing the commitment check at the next hop.

**Tracked reservation (remnant-bounded — TYPES_INTERFACE → Tracked reservations, condition 3): the
topic name `subblock`.** Held by its live guard — `gossip.test.ts` asserts the node's
`/dagsocial/<magic>/subblock/1` has no validator — and it leaves with that guard.

The topic name `stump` is retired (P2-F F1) and never reused: the topic is neither subscribed nor
published. An author's withdrawal propagates as a transaction — on the `tx` topic and inside
ordering blocks.

All gossip topics carry the object's own positional wire encoding directly — no framing.
The topic version (`/1`) matches the protocol version for topic naming but
is independent — if the wire format changes incompatibly, the topic version
increments.

---

## Handshake (code 1)

The side that dialled a connection opens a stream on `/dagsocial/handshake/1` on it, and the two
sides exchange a framed `Handshake` message:

```
outbound: dial → open stream → send Handshake → receive Handshake → active
inbound:  accept → receive stream → receive Handshake → send Handshake → active
```

**A handshake is a frame or it is nothing.** A payload that does not decode as a valid
frame — truncated, leading bytes that are no known magic, a failed checksum — is rejected
and the stream closed; there is **no unframed fallback**, so no handshake byte is ever
parsed except as the body of a checksum-verified frame. The
classification of each frame-decode failure is the Ban policy's first tier below.

**A connection whose remote peer id is this node's own is never a peer.** libp2p refuses a dial
that names its own peer id, and a bare seed names none — so a seed that resolves to this node
(the seed host dialling its own profile entry) connects to it, in both directions. The dial closes
such a connection the moment it resolves, before any handshake and before any record; the inbound
handler refuses a handshake stream from this node's own id the way it refuses any other — an empty
frame — with no penalty, there being nobody to penalise. A seed that resolved to this node leaves
the floor for the life of the process (→ Outbound Manager); a PeerDb address that did is forgotten
and filtered thereafter (→ PeerDb). `peers()` and `getConnectedPeers()` never contain `peerId()`.

> ⚠ **AHEAD OF CODE (2026-10-19).** The six paragraphs below lead the handshake handler and the dial funnel, which
> read a handshake stream under `MAX_STREAM_BYTES` on any of libp2p's default 32 per connection, run every handshake
> whatever its peer's state and open the dialler's stream on whichever connection libp2p picks, leave a connection
> standing when its handshake fails, set it no deadline, and record a listener's view of the declared address stamped
> with the time and tied to the peer's ban.

**A connection carries one handshake, opened by the side that dialled it.** The dialler opens one handshake stream
on the connection its dial returned — on that connection, never on another to the same peer — and the listener
answers on it; a node opens none on a connection it accepted. The registration's `maxInboundStreams` is
`MAX_INBOUND_HANDSHAKE_STREAMS` (1), and a connection that has already carried a handshake stream closes every later
one unread, with no penalty. The read is bounded by `MAX_HANDSHAKE_FRAME_BYTES`, the longest frame the body admits
(→ Handshake Body), and bytes over it are a `ProtocolViolation` — no handshake is longer. A peer that has not
handshaken therefore holds one read of under 1 KiB of this node's memory per connection, for one read deadline.

**The dial funnel handshakes only a connection it opened.** A dial can return a connection that already stands —
libp2p answers a dial naming a connected peer id with a connection it holds. When the returned connection is one the
peer opened, or one that has carried a handshake, the funnel opens no handshake stream on it: the peer's handshake on
it, or the one already run, is that connection's. The funnel counts such a dial connected when its peer is `Active`,
and otherwise leaves the connection to its deadline.

**A peer becomes Active once.** The first handshake that completes for a peer, in either direction, makes it
`Active` — its PeerDb record, its version and addresses on the metadata, `onPeerActive`, the `SyncInfo` that follows
(→ Post-Handshake Routing). A handshake that completes for a peer already `Active` — on a second connection, in
either direction — is read, decoded and validated as any handshake is, and a body-tier failure is penalised as any
is (→ Ban policy); a valid one is answered when this node is the listener, completes its connection's handshake, and
records and raises nothing. A refusal in its place would end, for an honest dialler that raced the peer's own dial,
in a failed handshake and a redial cooldown on a peer it holds (→ "A handshake that does not complete ends its
connection").

**A handshake that does not complete ends its connection.** Every way a connection's handshake can end without
completing — on either side: a frame-tier or body-tier reject, an empty or absent answer, a read or write past its
deadline, a banned peer's stream refused unread, a fault of this node's own — closes the connection it ran on, after
whatever the Ban policy records for it. The connection, not the peer: the peer may hold another whose handshake
completed. A dialler whose handshake did not complete also puts the address it dialled into the redial cooldown, as a
failed dial does (→ Outbound Manager). A connection left standing keeps its slot against `maxPeers` and its place in
the gossip mesh, where a message it carries that passes Stage 1 is delivered (→ Inbound Processing).

**A connection handshakes within its deadline, or is closed.** A connection whose handshake has not completed
`HANDSHAKE_DEADLINE_FACTOR` (3) × `syncRequestTimeoutMs` after it opened is closed, with no penalty — a link too slow
to handshake is not evidence of misbehaviour (→ Validation → "A stream read is bounded in time as well as in bytes").
The factor is the dialler's round trip at its longest: the stream's open, the write and the read, each under
`syncRequestTimeoutMs` (→ Pull Requests). The deadline is the connection's, not the peer's: an `Active` peer's second
connection that completes no handshake is closed at its own.

**A declared address is hearsay until a dial names it.** The listener records the dialler's `declaredAddress` into
PeerDb only when it is no bogus address (→ Bogus Address Classification) and its `/p2p/` component names the peer id
the connection proved, and records it as a gossiped address is recorded — `lastSeenMs = 0` (→ Peers Intake → "A
gossiped address is a hint below a seen peer"); a handshake that declares no address records none. The dialler
records the address it dialled, stamped with the time: its dial is what verified it. No address a handshake declares
reaches a ban: a peer that dialled this node is banned with no address, and each spelling a later dial resolves to its
peer id joins the ban (→ "A ban carries every address its peer has been tied to"). The declared address is kept on the
peer's metadata apart from that address, for the one use it has — leaving the requester's own address out of a
`Peers` answer (→ GetPeers).

### Handshake Body

> ⚠ **AHEAD OF CODE (2026-10-19).** The layout, its table and the two paragraphs after the codec's rule lead the
> handshake codec, which writes and reads a seventh field, `vlqU(sessionMagic)` (≤ `MAX_UINT32`), after the
> capabilities — so its longest frame is 989 bytes.

```
lpUtf8(agentName) ‖ vlqU(protocolVersion) ‖ lpUtf8(nodeName) ‖ vlqU(chainHeight) ‖
opt(lpUtf8(declaredAddress)) ‖ arr(vlqU(capability))
```

| Field | Rule |
|---|---|
| `agentName` | non-empty, ≤ `MAX_NAME_BYTES` (255) UTF-8 bytes — e.g. `"dagsocial/1.0.0"` |
| `protocolVersion` | ≤ `MAX_CAPABILITY_CODE`; the highest app protocol version the sender implements — its build's `PROTOCOL_VERSION` (`TYPES_INTERFACE → Version`) |
| `nodeName` | ≤ `MAX_NAME_BYTES` bytes; operator-configured, human-readable, may be empty |
| `chainHeight` | ≤ `MAX_ADVERTISED_HEIGHT`; tip height of this node's chain |
| `declaredAddress` | optional (`opt`), ≤ `MAX_ADDRESS_BYTES` (255) bytes; the multiaddr this node advertises — **its first listen address that is not loopback**, absent when every listen address is loopback. A loopback address advertised to a peer is one no peer can dial |
| `capabilities` | count ≤ `MAX_CAPABILITY_ENTRIES` (64), each ≤ `MAX_CAPABILITY_CODE`; message codes this node can handle. Always present — an empty list is a peer that declares nothing |

Every rule is enforced inside the codec's `read`: a violation is a `ReaderError`, and the decode
boundary collapses it to `null` → `malformed` (Ban policy below). The version-support check runs
**after** decode, on a structurally sound message only.

**The longest frame the body admits is `MAX_HANDSHAKE_FRAME_BYTES` (984).** Every field at its bound: `agentName`
and `nodeName` at 255 bytes behind two-byte lengths (514), `declaredAddress` the same behind its `opt` byte (258),
64 capabilities at 65 535 behind a one-byte count (193), `protocolVersion` at 65 535 (3) and `chainHeight` at
`MAX_ADVERTISED_HEIGHT` (4) — a 972-byte body, in a frame 12 bytes longer (→ Frame Format). It bounds the handshake
read (→ "A connection carries one handshake, opened by the side that dialled it").

**The body carries no session field.** Noise gives every connection keys of its own, so a handshake cannot be
replayed into another connection; inside one, the connection carries one handshake; and which network a peer is on
is the frame's magic (→ Magic Bytes).

### Validation (and untrusted-input safety)

Every stream message body — the handshake and all sync messages (`SyncInfo`, `GetHeaders`, `Headers`,
`GetBlocks`, `Blocks`, `ModifierRequest`, `ModifierResponse`, …) — decodes through its positional codec, and **the codec
is the whole structural boundary**: `decodeStruct` runs the four-part boundary check
(`TYPES_INTERFACE` → The boundary check), and every domain rule — heights, counts, byte caps —
throws inside `read` before any value escapes. A malformed or out-of-bounds message collapses to
`null`, is dropped, and the peer penalized — it must **never throw out of, or crash, the
handler**, and the sync event loop isolates a per-message failure so one bad message degrades
that message only, never the loop.

**Resource limits (untrusted counts and sizes).** Inbound array counts are capped **inside the
codecs, before the first element is read**: a `ModifierRequest`'s `ids` and a `ModifierResponse`'s
`modifiers` at `MAX_INV_IDS`, a `GetHeaders` locator at `MAX_LOCATOR_HASHES`, a `GetBlocks` id list at
`MAX_CHAIN_RESPONSE_ITEMS` — each at least 1, an empty one being malformed (no honest sender emits
one) — `peers` at `MAX_PEERS_ENTRIES`, `capabilities` at
`MAX_CAPABILITY_ENTRIES`. The cap applies to what a peer *sends us*, not only to what we send.
Raw stream reads are bounded by `MAX_STREAM_BYTES` (never buffer an unbounded
attacker-controlled stream). Per-request serve work is bounded: handling a request must not be
`O(ids × chainHeight)` — an unbounded id list must not each trigger a full-chain scan.

**A peer's bytes are weighed before they are decoded.** Every decode of an ordering block, a header or a
transaction packet a peer sent is preceded by a length check against the longest encoding of what may
arrive there, and bytes over it are refused undecoded — as that site refuses bytes that do not decode:

| Where | Weighed against |
|---|---|
| a gossiped ordering block — Stage 1, before `decodeOrderingBlock` | `MAX_ORDERING_BLOCK_BYTES` |
| a gossiped transaction packet — Stage 1, before `decodeTxPacket` | `MAX_TX_PACKET_BYTES` |
| each block of a `Blocks` response | `MAX_ORDERING_BLOCK_BYTES` |
| each header of a `Headers` response | `MAX_HEADER_BYTES` |

Each bound is `@dagsocial/types`' and the longest encoding of something Stage 1 accepts
(`TYPES_INTERFACE → Size caps`), so the check refuses nothing an honest node sends. With it, and with the
decoder refusing a body whose element count is not its id count (`TYPES_INTERFACE → Ordering block`), a
decode costs what its bytes cost (`WIRE_INTERFACE → ByteWriter`). Measured 2026-10-14 on the i9 laptop: a
3.81 MiB block whose body is 4 000 000 empty elements beside no id is refused at the count in 2 ms; a block at
the bound whose body is 60 605 aligned minimal elements decodes in about 0.2 s, and a `Blocks` response of four
such blocks, 7.63 MiB, in about 1 s. Stage 1 decodes a gossiped block's body before it checks the header's work
(→ Stage 1), so that 0.2 s is what a block no one worked costs its first hop.

**A stream read is bounded in time as well as in bytes.** Every `readStreamBounded` carries a
deadline — the `syncRequestTimeoutMs` its dial uses at that site (×5 for the block read, whose payload
is larger) — because the byte cap bounds a read's *volume*, not its *duration*: a peer that opens the
stream and then trickles bytes under the cap, or sends nothing at all, otherwise parks the reader — and
with it fork choice — for as long as it likes. The deadline holds in **both** directions: an outbound
request's read of the response, and an inbound serve handler's read of the request. On expiry the read
aborts, the stream closes, and the caller treats it as an absent response — **no ban**, because a slow
or silent link is indistinguishable from a dead one (the frame tier's reasoning below) and is not
evidence of misbehaviour.

**A stream write is bounded in time as well.** Every frame this node writes on either protocol — an answer on a
peer's stream, a one-way message on a stream it opens, a request — must be taken by the peer within the deadline the
peer's read of it runs under: `syncRequestTimeoutMs`, ×5 for a `Blocks` answer, the one read that runs under ×5. A
write that does not finish in time is aborted — the stream reset — with **no penalty**, for the read deadline's
reason: a peer that does not read is a slow link as far as this node can tell. Without the deadline a peer that asks
and never reads holds the answer, up to `MAX_SERVE_BODY_BYTES`, for the life of the connection; with it, and with a
peer's streams served one at a time (→ Stream Protocols → "A peer's sync streams are served one at a time"), what a
peer holds is bounded in size and in time.

⛔ **Every arm that assembles more than one stored object into a response is bounded by BYTES, not by
item count alone.** A count bounds an array's length and says nothing about its weight: `Blocks`
assembles whole blocks and `ModifierResponse` post bodies. Each arm accumulates encoded bytes, stops
before exceeding `MAX_SERVE_BODY_BYTES`, and always emits its first item, so the serve loop never answers
a request with nothing while it holds what was asked. No legal block reaches the budget alone (→ "Four
limits stand in a fixed order, and the relation is the rule"); one over `MAX_ORDERING_BLOCK_BYTES` is
served and its reader refuses it (→ "A peer's bytes are weighed before they are decoded").

**Four limits stand in a fixed order, and the relation is the rule:**

```
MAX_BLOCK_BODY_BYTES (2,000,000)  <  MAX_ORDERING_BLOCK_BYTES (2,000,302)  <  MAX_SERVE_BODY_BYTES (4 MiB)  <  MAX_STREAM_BYTES (8 MiB)
```

The lower two are `@dagsocial/types`' — the consensus bound and the block it encodes to
(`TYPES_INTERFACE` → Size caps); the upper two are this package's. A single legal block therefore always fits inside a response the requester will
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
  MAX_ADVERTISED_HEIGHT` (= 100,000,000, ~190 years at 1 block/min) — a claim's height says where a
  peer's answers must reach (→ Sync State Machine → "How a header sync ends"), so an out-of-domain value
  must never reach the scheduler. The `GetHeaders` locator and the `GetBlocks` ids carry no height: each
  serve arm resolves a hash by point lookup and walks only its own applied chain from there
  (→ `GetHeaders` / `GetBlocks` responses). Both arrive over `/dagsocial/sync/1`, so they reach a serve
  arm only from a peer in **Active** state and a malformed body is attributable to a peer that can be
  penalized.
- `agentName` / `nodeName` / `declaredAddress` are byte-capped strings (`MAX_NAME_BYTES` /
  `MAX_ADDRESS_BYTES`); `capabilities` is a count-capped list of bounded codes (unknown
  capabilities preserved, not rejected — forward compat)

**A banned peer's handshake is refused unread.** Inbound, the handshake handler checks `isBanned(peerId)`
before it reads: a banned peer's stream is closed with no decode, no reply, and no `Active` transition.
Outbound, the dial funnel checks the same predicate against the peer id the dial resolved to — after the
own-peer check, before the handshake stream opens: the connection is closed, no handshake runs, nothing
is recorded, and the dialled address joins the peer's ban (→ "Ban surfaces are unified"). Reading and
validating either would spend work on, and possibly re-admit, a peer whose ban is the whole point — the
byte cap and read deadline bound that work but do not decline it. The check is by peer id in both
directions because that is the identity the transport proves; an address is tied to a peer only by a
dial, so an address ban can cover no more spellings than dials have named.

**A banned peer's inbound connection is refused at the transport.** The libp2p connection gater's
`denyInboundEncryptedConnection` answers `isBanned` on the peer id the security handshake has just
proven — after Noise, before the muxer, the earliest point that has an identity to ask about. A banned
peer's inbound connection is aborted inside the upgrade: it never becomes a connection, holds no slot
against `maxPeers`, raises no `peer:connect`, and never reaches the handshake handler. The handler's own
check (above) is the same predicate one layer up and stays: a peer can be banned after its connection
upgraded and before its handshake ran — a gossip topic validator penalises a carrier in any state — and
the hang-up a ban raises (below) completes asynchronously. Outbound is not gated: the outbound hooks
fire inside the dial, before the funnel sees the connection, and the gater sees the resolved address,
never the spelling the funnel dialled, so gating there would refuse the dial every tick and never tie
the spelling to the ban. The funnel's close-and-learn is the outbound refusal, and `denyDialPeer` is
consulted only for a dial that names a peer id, which seeds and PeerDb records do not.

**A ban ends the connection.** When `PeerManager` imposes a ban — permanent or temporal, from whichever
entry recorded the penalty — it fires `onBanned(peerId)` after its own bookkeeping (the row and the
metadata removed, the addresses propagated), and `NetNode` binds it to the close it already owns: every
connection to the peer is hung up and the scheduler is told as for a disconnect, synchronously — the
peer's claim and its open requests leave with it, so it is asked nothing more, and a block request it held
moves to another peer at once rather than at its deadline. The `peer:disconnect` event the
hang-up raises repeats both idempotently, and `onPeerDisconnected` fires from it as for any close. Until
the close completes the peer's sync frames are refused at the Active gate like any non-Active peer's,
and a gossip message it carries stands or falls by Stage 1 alone (→ Inbound Processing). A ban that
leaves the connection standing is one the scheduler cannot see — the banned peer stays a request target,
its requests go unanswered, and each costs a deadline.

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
| The peer becomes Active | Send it our `SyncInfo` (→ Sync State Machine) |
| Its claim is a hash our header tree lacks | Ask it for headers (→ Sync State Machine → "A claim the tree lacks is a header request") |
| Its claim is one we hold | Nothing — the claim is settled; gossip flows, and the peer asks us for what it lacks |

**At an era boundary, every Active peer below the new era is dropped.** When `tipApplied(height)`
(→ API) reports a tip whose `protocolVersionAt(schedule, height + 1)` is above the era last in force,
the node disconnects each Active peer whose declared `protocolVersion` — the handshake's, kept on the
peer's metadata — is below the new era: the handshake rule, held for live connections, so every Active
peer implements the era this node is applying. A tip move inside an era drops no one.

---

## Historical Sync

Sync is **headers first**. Net's **scheduler** asks peers for headers by locator and for blocks by id, and hands
every header and every block an answer carries to the node's **pipeline**, which admits headers into its header
tree, keeps the best chain by verified work, and applies blocks along it and every block in hand that extends its
applied tip (NODE_INTERFACE → Fork choice decides on verified headers). **The scheduler decides whom to ask for
what and when, and nothing else**: it keeps no view of the chain beyond what the node's chain view answers (→ Sync
Handler Registration), and it never chooses a chain. A peer's claim — the tip of the chain it applied — is a reason
to ask that peer, never a measure of a chain.

Four messages carry it over `/dagsocial/sync/1`: a peer's claim (`SyncInfo`), a header query and its answer
(`GetHeaders` / `Headers`, codes 14/15), and a block query and its answer (`GetBlocks` / `Blocks`, codes
16/17). Post bodies ride `ModifierRequest` / `ModifierResponse` (codes 4/5, type 103) — the one modifier the
protocol carries (→ Block Body Download). **A node serves its applied chain only**, headers and blocks alike —
never a header it holds ahead of its blocks — so what it claims and what it serves describe one chain.

All messages are positional bodies wrapped in frames; layouts below.

### SyncInfo (code 2)

```
vlqU(tipHeight) ‖ hexN(tipHash, 32)
```

`tipHeight` is ≤ `MAX_ADVERTISED_HEIGHT`; `tipHash` is the id of the block the sender applied at `tipHeight`.
A node with no blocks sends `0` and `GENESIS_PREV_BLOCK_HASH` — the virtual root every header tree holds
(NODE_INTERFACE → Fork choice decides on verified headers), so a height-0 claim is settled on arrival.

The pair is the sender's **claim**. The receiver acts on the hash: one its header tree does not hold is a
reason to ask that peer for headers (→ Sync State Machine). The height says where the answers must reach
(→ Sync State Machine → "How a header sync ends"). No cumulative work is carried: work is the pipeline's to
verify over headers, never a peer's to claim.

### ModifierRequest (code 4)

```
u8(typeId) ‖ arr( hexN(id, 32) )
```

1–`MAX_INV_IDS` (400) ids, the count read and refused **before the first element**; an empty list is
malformed — no honest sender asks for nothing. `typeId` 103 = post body (`MODIFIER_POST_BODY`), its ids post
ids. 101 (ordering block) and 102 (sub-block) are retired type ids, never reused: blocks move by `GetBlocks`
(→ `GetHeaders` / `GetBlocks` responses).

### ModifierResponse (code 5)

```
u8(typeId) ‖ arr( hexN(id, 32) ‖ lp(data) )
```

1–`MAX_INV_IDS` modifiers, count refused before the first element, empty malformed — a peer with none of the
requested bodies answers **zero bytes** (the stream's "cannot answer"), never an empty list. `data` is
`encodePostBody` — `lpUtf8(content)`.

**`MODIFIER_POST_BODY` (103) is answered from the local store only — never relayed.** A peer
that lacks a body omits the id from its response and the requester asks another peer. No request is relayed
in the tree; the rule is stated for bodies because a relay, should one ever be added for any query, must not
extend to them — it would fan a request for a withdrawn or withheld body across the network with nothing to
stop it (→ Local-Serve-Before-Relay). Responses are byte-bounded by the same accumulate-and-stop rule as
blocks (`MAX_SERVE_BODY_BYTES`). Each returned body is verified by the requester against the commitment of
the transaction it already holds (`verifyPostBody`) before it is stored; a mismatch is a misbehaviour
penalty.

### Sync Flow

```
Joiner (applied 0)                            Peer (applied 200)
     │                                            │
     │── Handshake ──────────────────────────────►│
     │◄── Handshake ──────────────────────────────│
     │── SyncInfo (0, root) ─────────────────────►│
     │◄── SyncInfo (200, H200) ───────────────────│
     │                                            │
     │ H200 not in the tree → ask for headers     │
     │── GetHeaders (locator: root) ─────────────►│
     │◄── Headers (1 … 200, ascending) ───────────│
     │ the pipeline admits them: best chain 1…200 │
     │                                            │
     │ every claim settled → the gate holds;      │
     │ the pipeline names the blocks it wants     │
     │── GetBlocks (ids of 1 … 200) ─────────────►│
     │◄── Blocks (byte-bounded, in order asked) ──│
     │ bound to their headers, staged, applied;   │
     │ the ids still wanted are asked again       │
     │                                            │
     │ best chain applied, every claim settled    │
     │   → synced                                 │
     │                                            │
     │ the posts of each applied block arrive     │
     │ with no body; the node pulls them by id,   │
     │ one request at a time (→ Block Body        │
     │ Download)                                  │
     │── ModifierRequest (type=103, ≤400 ids) ───►│
     │◄── ModifierResponse (bodies, byte-bounded; │
     │    ids the peer lacks are omitted) ────────│
     │ verify each against its commit, store      │
```

### Serve Side (Peer Behind Us)

A node answers three queries from its applied chain, each on the stream it arrives on — `GetHeaders`,
`GetBlocks` (→ `GetHeaders` / `GetBlocks` responses) and `ModifierRequest` for post bodies (→ ModifierRequest)
— and replies to every `SyncInfo` it acts on.

When a SyncInfo is acted on (→ "A peer's `SyncInfo` is acted on at most once per `SYNC_INFO_MIN_INTERVAL_MS`"),
the node **replies with its own SyncInfo, addressed to the sender** — whether the sender is behind, equal or
ahead, and whatever this node is doing. The reply is how the sender learns our claim, and with it whether it
has anything to ask us for (→ Sync State Machine). ⛔ **Addressed to the sender, never to a peer this node is
asking** — misaddressed, the requester never learns our claim and never asks.

**The reply is movement-gated, so replying to replies terminates.** Beside each peer the machine keeps the
tip it last sent that peer and the tip that peer last reported. An inbound SyncInfo that shows movement — the
sender's reported tip differs from their previous report, or our tip differs from what we last sent them —
earns its reply immediately. An inbound that shows **no** movement earns a reply at most once per
`MIN_SYNCINFO_INTERVAL_MS` (= 15 000 ms, half the poll); the suppressed reply is dropped, not queued. Two
equal-height peers echoing each other therefore settle after one exchange and stay at one exchange per poll
period — never an unbounded ping-pong. The sends at peer-active and on the poll (→ Sync State Machine → "A
claim is the peer's applied tip, height and hash") are not replies and are bounded by their own triggers.

**A peer's `SyncInfo` is acted on at most once per `SYNC_INFO_MIN_INTERVAL_MS`.** One that arrives sooner from the
same peer is held as that peer's pending `SyncInfo` — a later one replaces it — and acted on at the first timer tick
after the interval has passed; nothing is penalised, and no report is lost but one a later report replaced.
Each `SyncInfo` acted on earns at most the reply above and, when its hash is one the header tree lacks, one header
request (→ Sync State Machine), so the interval is what bounds the work one peer's reports buy. An honest peer
sends one at peer-active, one per poll and a reply to each of ours it acts on, so the interval holds back almost
none, and a held report is acted on within a tick rather than lost.

**A peer is served one block answer at a time.** A `GetBlocks` answer is written on the request's own stream, and
a peer's sync streams are served one at a time (→ Stream Protocols → "A peer's sync streams are served one at a
time"), so at most one block answer of this node's memory — up to `MAX_SERVE_BODY_BYTES` — is held for a peer, for
no longer than the write's deadline (→ Validation (and untrusted-input safety) → "A stream write is bounded in time
as well"). Without the rule a peer that sends requests and reads nothing would hold one answer of this node's memory
per request it sent.

A locator that matches nothing on the server's applied chain is answered from height 1 — a joiner's, or a peer's on a
fork from the root. This bidirectional pattern ensures nodes serve peers behind them, not just consume.

### Sync State Machine

**The scheduler holds peers' claims, this node's open requests and its stall marks — nothing about the chain.**
Every question about the chain goes to the node's chain view (→ Sync Handler Registration), and every answer goes
to the node's pipeline whole.

**A claim is the peer's applied tip, height and hash.** It is retained per Active peer from the latest `SyncInfo`
acted on (→ Serve Side) and dropped at disconnect or ban (→ Handshake, "A ban ends the connection"); the handshake's
`chainHeight` alone is no claim. This node sends its own `SyncInfo` to every Active peer at peer-active and every
`SYNCED_POLL_INTERVAL_MS` (30 s), each carrying its applied tip as it stands; a moving tip sends nothing of its
own — a new block reaches peers by gossip, and a peer that missed it reads the tip in the next poll.

**An event for a peer no longer connected is ignored.** A `SyncInfo`, a peer-active or an answer whose peer is not
in the connected set when the scheduler processes it plants nothing — no claim, no request, no per-peer entry — and
is dropped.

**A claim the tree lacks is a header request.** A claimed hash for which the chain view's `knowsTip(peerId, hash)`
answers `false` — the tree does not hold it, and the pipeline has not scored that peer lighter at it — opens that
peer's **header sync**; any other claim is **settled** on arrival. A marked peer's claim opens nothing (→ Stall
Detection).

**One header request per peer, every peer at once.** A header sync is a run of `GetHeaders` requests to one peer,
each carrying the chain view's `locatorFor(peerId)` (→ `GetHeaders` / `GetBlocks` responses), one open at a time;
every peer's runs at once. Each `Headers` page, held to its shape, goes to the pipeline (`deliverHeaders`), whose
answer is one of three: **`'refused'`** ends the run (below); **`'again'`** — the pipeline is re-fetching a branch it
scored heavier (NODE_INTERFACE → Fork choice decides on verified headers → "A side branch is stored only once it is
heavier.") — sends the next request at once, whatever the page's length, and refutes nothing; **`'taken'`** leaves the
run to the claim: the next request follows a full page while the claim is still unsettled.

**How a header sync ends.** One of three ways:
1. **Its claim is reached** — `knowsTip(peerId, hash)` answers `true`: the pipeline admitted the claimed header, or
   scored the peer's branch lighter at it. The claim is settled.
2. **An answer refutes its claim** — a page of fewer than `MAX_CHAIN_RESPONSE_ITEMS` headers ending below the claimed
   height, or a page whose header at the claimed height is not the claimed hash. The peer is **marked** and
   penalised `transient`: an honest tip can drop, or move to another branch, under a reorg between claim and answer.
   A tip that rose meanwhile refutes nothing — the claimed hash still stands at its height.
3. **A request ends without a well-formed answer** — its deadline passes (`syncRequestTimeoutMs`, the read's, →
   Validation (and untrusted-input safety) → "A stream read is bounded in time as well as in bytes"), its stream fails,
   or what it reads is not an answer (another frame code, a body that does not decode, a read past
   `MAX_STREAM_BYTES`). The peer is **marked**.

A page the pipeline refuses (`'refused'`) ends the run as well, and the peer is not marked: the pipeline has penalised
the peer where the refusal is the peer's, and left it unpenalised where it is not — a verdict of this node's clock, a
branch past the reach floor (NODE_INTERFACE → Fork choice decides on verified headers). Every answer either moves a full page or reaches the
peer's tip, so a claim of 10⁸ without the headers to back it is refuted on its first answer.

**Blocks are asked by id, from a peer that has them.** The chain view's `wantedBlocks()` names the blocks the
pipeline wants next, each id with its height; the scheduler asks them in `GetBlocks` requests of at most
`MAX_CHAIN_RESPONSE_ITEMS` ids, one block request open per peer, of an unmarked Active peer whose settled claim's
height is at or above the request's highest — and hands every block of the answer to the pipeline
(`deliverBlocks`). **An id a peer's answer omits is not asked of that peer again until its claim changes** — and an
id it answered with a block the pipeline did not take (still wanted once the delivery is taken) counts as omitted; it, a
deadline (`syncRequestTimeoutMs × 5`, the `Blocks` read's), or a mark moves the id to another such peer, and an id no
such peer is left to ask waits for the next claim. Nothing is asked that the chain view has not named: the
scheduler never asks for a height range, or for a block a peer claimed.

**The gate bounds how far blocks apply.** The gate **holds** when no unmarked, Active **outbound** peer has a header
sync open and every configured **bootstrap** peer's dial has settled — Active, or failed. The scheduler reports each
hold to the chain view (`gateHeld()`); the pipeline applies blocks by extension only while `appliedTip < S +
maxReorgDepth`, `S` the best chain's height at the last hold (NODE_INTERFACE → Fork choice decides on verified
headers → "The window"). With no outbound peer and no bootstrap peer the gate holds vacuously — a lone node. **The
gate counts the connections this node chose**: an inbound peer's headers enter the tree and compete for the best
chain like any other, but its open header sync never holds the gate, so no peer that dialled in — sybils
included — can stall a node by keeping a header sync open. This is the eclipse stance the outbound manager takes
(→ Outbound Manager).

**A stall mark keeps a peer out of every request** (→ Stall Detection).

**The phases.** `syncing` — a header sync or a block request is open, or the chain view's `fullyApplied()` answers
`false`. Otherwise `idle` — no claim settled yet: before `start()`, after `stop()`, and on a node that has met no peer.
**`synced` — the best chain is fully applied and every unmarked Active peer's claim is settled.** Entering `synced`
clears every stall mark and fires `onSyncComplete`.

### Sync Integrity (audit M-10)

- **An answer is bound to its request by its stream.** Every header and block this node receives on the sync
  protocol arrives as the answer on a stream this node opened for the request — one round trip (→ Pull Requests →
  "A request is one round trip, and closing its stream never changes its answer"). No answer arrives unasked, so
  the stream is the whole binding: what a stream carries back answers what was written on it.
- **Net owns the shape; the pipeline owns the content.** Net holds a `Headers` page to its one shape (→ `GetHeaders`
  / `GetBlocks` responses → "A `Headers` page has one shape, and a requester holds a page to it") and a `Blocks`
  answer to its count and its bytes. It hashes nothing against an id it asked for: the pipeline binds each delivered
  block to the header its tree holds — the header's hash, then the block's structure, root and validator signature
  — before it is staged (NODE_INTERFACE → Fork choice decides on verified headers → "A served block is bound to its
  header before it is kept").
- **A request ends by its answer, or without one, and nothing else judges a peer.** A request that ends without a
  well-formed answer marks its peer (→ Stall Detection); a well-formed answer whose content the pipeline refuses is
  penalised by the pipeline where the refusal is the peer's.

### Block Body Download

There is no separate body download: a block carries its whole body, and `GetBlocks` moves whole serialized ordering
blocks, byte-bounded at `MAX_SERVE_BODY_BYTES`. **Post bodies are the one thing a block does not carry** — it carries
their commits — so they are the one thing fetched by id after the chain: `MODIFIER_POST_BODY`,
asked by the node for every placeholder row its store holds, one request at a time, on a schedule
in block height (NODE_INTERFACE → Store Interface → Posts DAG, "Backfill after sync"). Net answers
each `requestPostBodies` call with the verified bodies (→ Pull Requests) and runs no pull of its
own, in any phase.

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

> ⚠ **AHEAD OF CODE (2026-10-19).** The *Merge* and *Persistence* items below lead `PeerDb`, whose `record` lays
> every record's fields over the entry's and keeps only the later `lastSeenMs`, and whose storage calls in `record`,
> `forget` and `ban` throw out to their callers.

Key behaviors:
- **Soft cap:** 1000 entries (`peerDbCap`). Evict oldest `lastSeenMs` on
  overflow.
- **Merge — a record never rewrites a more recent one.** `record` replaces an entry's fields — agent, name,
  version, capabilities, `lastSeenMs` — only with a record at least as recent by `lastSeenMs`; an older record changes
  nothing. A gossiped or declared address (recorded at 0, → Peers Intake) therefore never rewrites what this node's
  own dial learned.
- **Self-address filter:** entries matching our own listen addresses (compared without their
  `/p2p/` component, as the fill phase compares) are silently dropped, and an
  address whose dial resolved to this node's own peer id is forgotten and dropped thereafter — a DNS
  name or a NAT-mapped address for this node matches no listen address, and the dial is the one test
  that names it (→ Handshake)
- **Blacklist filter:** banned addresses are excluded from `recent()` and `get()` and refused by
  `record()`. The ban set holds and compares addresses without their `/p2p/` component, as the self
  filter and the fill phase compare, and `ban(address)` removes every entry that matches that way — a
  declared address carries the component, a seed or a gossiped entry for the same host may not
- **Persistence:** write-through via `PeerStorage` trait. Every storage call `PeerDb` makes — `put` and
  `delete`, from `record`, `forget` and `ban` — is logged and swallowed when it throws, and the in-memory table stands
  ahead of the store. A throw out of `ban` would leave the ban short of its hang-up (→ Handshake → "A ban ends the
  connection").

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

> ⚠ **AHEAD OF CODE (2026-10-19).** The first item below leads the handshake handler, which records on the metadata
> the address a peer that dialled this node declared.

- `PeerMetadata` carries the peer's `address` — the address this node dialled, recorded when its handshake makes
  the peer `Active`; a peer that dialled this node has none (→ Handshake → "A declared address is hearsay until a
  dial names it").
- **A ban carries every address its peer has been tied to.** The ban entry opens with the recorded
  address, when there is one, and grows by one each time an outbound dial resolves to the banned
  peer id under another spelling (→ Handshake, "A banned peer's handshake is refused unread"). Every
  address in the set propagates to `PeerDb.ban(address)` as it is learned, so it leaves `recent()`
  and is refused re-entry by `record()`; expiry of a temporal ban calls `PeerDb.unban(address)` for
  each. A peer is held in PeerDb under as many spellings as there were ways to learn it — a seed's
  bare string, its declared address, a gossiped one — and a `PeerRecord` names no peer id, so the
  dial is the one test that ties a spelling to the ban. The set grows by at most one address per
  outbound tick, and the address surface it feeds is capped at `MAX_BANNED_ADDRS`.
- A spelling no dial has named yet stays served in `Peers` and stays dialable until one does; the
  peer-id check at the funnel refuses that dial, so an unlearned spelling costs one dial and never a
  handshake.

**Ban tracking is a bounded hint, not a ledger.** Both surfaces cap what they hold — `MAX_TRACKED_BANS`
peer ids in `PeerManager`, `MAX_BANNED_ADDRS` addresses in `PeerDb` — and drop the oldest past the cap.
A permanent ban keys on a peer id or an address, both of which regenerate freely, so it deters a
lazy repeat rather than guaranteeing exclusion; an unbounded set of such hints is instead a memory leak
an attacker mints by misbehaving under fresh ids. Eviction lapses a hint — it is not the propagated
unban that keeps the two surfaces in step (above), and it grants nothing a regenerated identity could
not already take.

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
not bogus, and not self — record into PeerDb. Malformed Peers (cap exceeded,
truncated body, invalid strings) triggers permanent ban of the source. Bogus
addresses in a valid body do NOT penalize the source — they are silently
dropped.

**A gossiped address is a hint below a seen peer.** A `Peers` entry is a third party's claim about a
peer this node may never have met, so it is recorded with `lastSeenMs = 0` — below any peer we have
actually connected to. It fills only cold capacity and is the first evicted (PeerDb's soft cap drops the
oldest `lastSeenMs`), so a flood of junk addresses cannot displace a peer we have seen; and because
`record` merges by the newer `lastSeenMs`, a gossiped entry never advances an existing entry's recency.
This is the churn defence, and it dials nothing: liveness is verified on use, where a dead entry simply
fails its dial.

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
- A seed whose dial resolved to this node's own peer id is retired from the floor for the life of the
  process — dialled once, closed, never listed again, connections or none (→ Handshake, "A connection
  whose remote peer id is this node's own is never a peer"); a restart re-learns it
- A seed whose dial resolved to a banned peer id is closed at the funnel like any other dial to that
  peer (→ Handshake); the floor keeps listing it while the ban stands, at the tick's cadence — the same
  cost as an unreachable seed
- PeerDb not consulted — seeds are the bootstrap source

> ⚠ **AHEAD OF CODE (2026-10-19).** The fill phase's funnel and cooldown items and the paragraph after the list lead
> the dial funnel, which runs its handshake on whatever connection the dial returned and puts an address into the
> cooldown only when its dial fails, and `NetConfig`, whose three discovery settings are optional with net's own
> defaults behind them.

**Fill phase** (outbound connections >= `minPeers`, < `maxPeers`):
- Every `OUTBOUND_TICK_INTERVAL_MS` (30s, fixed — see below), query
  `PeerDb.recent(N, exclude)` where `N = maxPeers - connectedOutbound`
- `exclude` is the union of **currently-connected addresses** and
  addresses in redial cooldown. Excluding connected addresses is
  required, not an optimization — without it the manager re-dials peers
  it already holds and starves genuinely new candidates. **Addresses compare without their
  `/p2p/` component**: libp2p stamps the remote peer id onto a connection's address once the
  upgrade identifies it, while a PeerDb key carries the id or not by where it was learned — a
  seed is bare, a declared address carries it — so a raw string comparison misses a connected
  peer held under a bare key and re-dials it every tick
- Dial one candidate per tick (most recently seen first), through the same funnel as a seed: the
  dial, the own-peer check, the ban check, then the outbound handshake on the connection the dial opened
  (→ Handshake → "The dial funnel handshakes only a connection it opened") — a dial that does not
  handshake yields no Active peer. A candidate that resolved to this node is forgotten (→ PeerDb); one
  that resolved to a banned peer id is closed and its spelling joins the ban (→ Handshake, "A banned
  peer's handshake is refused unread")
- Respect blacklist and redial cooldown (`outboundRedialCooldownMs`, 60s). An address enters the cooldown when its
  dial fails and when its handshake does not complete (→ Handshake → "A handshake that does not complete ends its
  connection")
- If PeerDb exhausted, idle until new gossip arrives

The discovery-related knobs (`minPeers`, `peerDbCap`, `outboundRedialCooldownMs`) are required in `NetConfig`, as
`magic` is: net holds no default for them, so the values a node runs on are the ones `@dagsocial/node` read from its
configuration (NODE_INTERFACE → Configuration).

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
  └── Outbound manager fills from PeerDb — dial, own-peer check, handshake, Active, as a seed
```

---

## Peer Penalty System

| Penalty | Trigger | Score |
|---------|---------|-------|
| `misbehavior` | Invalid message — fails Stage 1: structure, an ordering-block header below the network's floor, ordering-block PoW, the packet rule (a post without a body or a body without a post), a body that fails `verifyPostBody`, an ordering block's validator signature, or a transaction signature that does not verify (`gossip.ts` call sites); a pulled body that fails its commitment (the `MODIFIER_POST_BODY` receive arm) | 100 |
| `ProtocolViolation` | Undecodable/malformed frame or message; wrong-network handshake | permanent ban |
| `Transient` | A handshake whose `protocolVersion` is below the receiver's era (`handshakePenalty`, → Handshake → "Ban policy") | 50 |
| `Transient` | A version mismatch — a gossiped block whose declared version is not the era at its own height (`gossip.ts`), or a header `verifyHeaderChain` refuses with reason `'version'` at the pipeline's admission (via `NetNode.penalizePeer`): compatibility, never a violation | 50 |
| `misbehavior` | The pipeline, via `NetNode.penalizePeer` from node (NODE_INTERFACE → Fork choice decides on verified headers): a header admission refuses other than for the clock, the version or the age rule — an unhashable header, a marked hash, a `Headers` page whose first header's parent the tree does not hold, a `verifyHeaderChain` refusal; a delivered block that is not its header's (its structure, its root, its validator signature) or whose header the tree does not hold; a block the funnel refuses on bytes its header's hash commits | 100 |
| `misbehavior` | The scheduler: a `Headers` page that is not an answer to its locator — heights not consecutive and ascending, or a first header whose parent is neither a locator hash nor, at height 1, the root (→ `GetHeaders` / `GetBlocks` responses) | 100 |
| `Transient` | The scheduler: an answer that refutes its peer's claim (→ Sync State Machine → "How a header sync ends"); the pipeline, via `NetNode.penalizePeer`: a presync's second pass that ends off a hash its first recorded (NODE_INTERFACE → Fork choice decides on verified headers) | 50 |

**Refusals that record nothing** (→ Penalty Attribution → "A penalty rests on what the sender could
know"): at Stage 1, a scheduled-target mismatch, a transaction whose declared version is not the era of
the block after this node's tip and a post whose author is outside this node's karma set (→ Stage 1 →
"A refusal that rests on this node's state records nothing"), a header this node knows (→ Stage 1 → "A
header this node knows is Ignored") and a fault of this node's own (→ Stage 1 → "A fault of this node's
is no peer's"); and every Stage 2 refusal of a gossiped message (→ Stage 2 → "A Stage 2 refusal records
nothing"). `onPeerPenalised` fires for none of them.

> ⚠ **AHEAD OF CODE (2026-10-19).** The paragraph below leads the handshake handler and `NetNode`, which close no
> handshake stream unread and no connection at a deadline.

**A handshake's deadline and its extra streams record nothing.** A connection closed at its handshake deadline
(→ Handshake → "A connection handshakes within its deadline, or is closed") and a second handshake stream closed
unread (→ Handshake → "A connection carries one handshake, opened by the side that dialled it") are no penalty: the
first is a link too slow to tell from a dead one, and the second costs this node a stream it never reads.

**`NetNode.penalizePeer(peerId, kind: 'misbehavior' | 'transient', reason)`** is node's one call
into this system: it records the named tier against the peer with the reason string and nothing
else — accrual, decay and the ban threshold below apply unchanged, and a peer the manager does not
know is a no-op (the deliverer comes off the Active list; an unknown one is a disconnect race,
not a target). It is the producing call site of the pipeline's rows.

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

> ⚠ **AHEAD OF CODE (2026-10-19).** The paragraph below leads `PeerManager`, which keeps a score on the peer's
> connection entry: a disconnect deletes it and a reconnect starts the peer at zero.

**A score is kept by peer id, and outlives its connection.** A peer's accumulated score and the time of its last
penalty are kept by peer id, apart from its connection, in a map of at most `MAX_TRACKED_SCORES` entries, the least
recently penalised dropped first. A disconnect leaves the score, and a reconnect resumes it, decayed for the time
between; a penalty against a peer not connected still records nothing, as `NetNode.penalizePeer`'s against a peer
the manager does not know records nothing (above). Dropping the oldest is the bounded hint the ban set is (→ "Ban tracking is a
bounded hint, not a ledger"): a fresh peer id starts at zero whatever the map keeps, so an entry dropped grants
nothing a new id could not take.

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
1. Control events (peer active, peer disconnect, a `SyncInfo` acted on, the pipeline's `needHeaders` and
   `chainMoved`, a bootstrap dial settling) — unbounded channel, never dropped
2. **Answers are awaited by the request that asked them, and queued nowhere.** Every header and block this node
   receives on the sync protocol is the answer to one of its own round trips (→ Sync Integrity), and the
   scheduler keeps at most one header request and one block request open per peer (→ Sync State Machine) — so
   what one peer's answers hold of this node is bounded by the requests this node made, and no peer's answer can
   push out another's
3. Timer ticks — fallback
4. **It MUST wait when the queue is empty and no tick is due.** The loop blocks until an enqueue or the next
   tick. It does not re-poll.

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

> ⚠ **QUALIFIED — verified 2026-10-17.** The tree relays no request at all: the sync stream's serve arms
> (`node.ts` — `serveHeadersResponse`, `serveBlocksResponse`, `servePostBodiesResponse`) answer from the
> local store and omit what it lacks, and no serve-or-relay helper exists in the package. The rule binds
> any relay that is ever added; until one is, the serve half is the whole of it.

**One modifier type never relays: `MODIFIER_POST_BODY` (103) is served locally or omitted.**
A body request names a post id; a peer that holds the body answers, a peer that does not
leaves the id out, and the requester asks another peer. Relaying a body request would carry a
query for a withdrawn or never-published body to every peer with nothing to terminate it, and
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

**A penalty rests on what the sender could know.** A node forwards only what passed its own checks, so
a refusal the sender — running the same rules over the same bytes — must also have reached is the
sender's doing: Stage 1's checks over the message alone — its weight and decode, its structure, a
block's version, floor, work, validator signature and root, a packet's body, a transaction's
signatures. A refusal that rests on this node's state — its tip, its stored parent, its karma set,
what it holds, its pool — is one the sender may have answered otherwise, honestly, and records nothing
(→ Peer Penalty System → "Refusals that record nothing").

## Peer State Machine

> ⚠ **AHEAD OF CODE (2026-10-19).** The paragraph's last sentence leads `NetNode`, which leaves a peer `Connecting`
> while a connection whose handshake failed or never ran stands.

States: `Connecting → Active`. A peer's row opens `Connecting` when its connection upgrades
(`peer:connect`) and becomes `Active` when its handshake completes in either direction (→ Handshake).
There is no state after `Active`: a disconnect or a ban **removes the row** (`PeerManager.removePeer`;
→ Handshake, "A ban ends the connection"), and a ban is recorded in the ban set, never in the row it
removes (→ Ban surfaces are unified). A peer is `Connecting` for no longer than its connection's handshake runs: a
connection whose handshake does not complete is closed at the failure, or at its deadline (→ Handshake → "A
connection handshakes within its deadline, or is closed").

Invariant: a peer that is not `Active` is asked nothing and answered nothing. A sync stream it opens
is answered with an empty frame and left unread, and it is no entry of `getConnectedPeers()`, the set
the scheduler asks. A gossip message is not such an event: it is judged by Stage 1 and
delivered whichever peer carried it (→ Inbound Processing).

## Stall Detection

**A peer is marked when a request to it ends without a well-formed answer, or when its answer refutes its claim**
(→ Sync State Machine → "How a header sync ends"). **A marked peer is asked nothing** — no header request,
no block request — and its claim opens no header sync, until its mark clears.

**A mark clears only when this node enters `synced`, or `STALL_MARK_EXPIRY_MS` after it was set.** A `SyncInfo`,
a re-handshake and a reconnect clear nothing: marks are kept by peer id and survive a reconnect, in a map of at
most `MAX_STALL_MARKS` entries, the oldest dropped first. A peer that claims a tip it cannot serve is therefore
asked once an expiry, and the expiry is argued against the most peers that can do it together
(`CONSTANTS → net`).

---

## libp2p Stack

> ⚠ **AHEAD OF CODE (2026-10-19).** The PubSub row's last clause leads `NetNode`, which leaves gossipsub's
> `fallbackToFloodsub` at the library's default, `true`.

| Layer | Choice |
|-------|--------|
| Transport | TCP (with optional QUIC, deferred) |
| Stream multiplexing | yamux or mplex |
| Encryption | Noise (with libp2p-noise) |
| PubSub | Gossipsub 1.1 — unsigned messages named by their bytes, the node's two topics alone (→ Gossip Topics), each message's forward reported by the node (`asyncValidation`, → Forwarding Rule); gossipsub alone — no floodsub fallback (`fallbackToFloodsub: false`), so a peer speaks to the topics under gossipsub's rules or not at all |
| Peer identity | libp2p peer ID (Ed25519 or secp256k1 keypair) |

The libp2p peer identity is separate from DAGsocial account identity. A
node operator may choose to link them (same keypair) or keep them separate.

---

## Stream Protocols

| Protocol | Framing | Purpose |
|----------|---------|---------|
| `/dagsocial/handshake/1` | Frame | The peer handshake (→ Handshake) |
| `/dagsocial/sync/1` | Frame | Headers-first sync, post bodies, peer discovery (codes 2, 4, 5, 8, 9, 14–17) |

**These two are the whole set.** Every chain-data query multiplexes over the sync stream and the
frame `code` byte disambiguates it. A second stream protocol for chain data is what codes exist to
avoid: it duplicates the framing, the caps and the serve loop, and — because protocol handlers are
registered per protocol — it acquires its own admission policy by omission rather than by decision.

**Every inbound stream ends.** A stream that carries a one-way message — a `SyncInfo` — is closed once its message
is read; one that carries a query is ended by its
answer, zero bytes included; one whose frame does not decode, or whose code no arm serves, is closed unanswered. A
stream left open holds one of libp2p's inbound streams for its protocol on that connection for the life of the
connection, and once they are all held every query on the connection fails.

**A peer's sync streams are served one at a time.** The sync handler reads and serves a peer's stream before it reads
that peer's next; streams that arrive meanwhile wait unread, in order of arrival, and each one's read deadline runs
from its turn. At most `MAX_INBOUND_SYNC_STREAMS` sync streams of one connection are open at once — the
registration's `maxInboundStreams` — and libp2p refuses one more before the handler runs. A waiting stream is
unread, so it costs at most the muxer's initial stream window (256 KiB). Through its sync streams a peer therefore
holds at most one read (`MAX_STREAM_BYTES`), one answer (→ Serve Side → "A peer is served one block answer at a
time", up to `MAX_SERVE_BODY_BYTES`) and the windows of the streams waiting — about 16 MiB at the bound — of this
node's memory, for no longer than the deadlines on those reads and writes.

**A stream handler never rejects.** libp2p does not catch the promise a protocol handler returns, so a rejection is an
unhandled one — logged by the node's backstop as a fault of its own (NODE_INTERFACE → "An unhandled rejection is
logged, and the node keeps running"). Every failure on a stream is the handler's to end: a write to a peer that has
gone, the empty answer of a failure path included, ends the stream with nothing more to say and nothing to log beyond
the failure that led there.

### `GetHeaders` / `GetBlocks` responses — positional, `arr(item, lp)`

**Landed 2026-08-10.** Both arms previously answered in a **second wire format** — `encode({ blocks })`
/ `encode(headers)` out, `decode(raw) as {…}` back — bare `cbor-x` plus a TypeScript cast, while every
other whole-block path in this package used `encode`/`decodeOrderingBlock`. A cast is not a check, and
the gap was **measured**: it was the sole delivery path for a remote fail-stop. Shape-validating
the CBOR would have been the band-aid; the root cause was the second dialect, so the dialect is gone.

- **Blocks:** `arr(blocks, lp(encodeOrderingBlock))`. **Headers:** `arr(headers, lp(encodeHeader))`.
- **The per-element `lp` is load-bearing**: it gives each item its own byte span, so the four-part
  boundary check (TYPES_INTERFACE → The boundary check) runs over exactly that span — exhaustion and re-encode compare included —
  and a malformed block is rejected at its own offset rather than as an outer mismatch.
- **The requests are positional too**, and carry no `mode` field — the code pair is the
  discriminator:

  ```
  GetHeaders (14):  arr( hexN(hash, 32) )   // the locator — 1–MAX_LOCATOR_HASHES entries
  GetBlocks  (16):  arr( hexN(id, 32) )     // block ids — 1–MAX_CHAIN_RESPONSE_ITEMS entries
  ```

  Each count is read and refused **before the first element**, and an empty list is malformed.
  **The locator is the requester's best chain named by hashes** — the chain view's (→ Sync Handler
  Registration): the hashes at heights `h₀ = tip`, `hᵢ₊₁ = hᵢ − 2ⁱ` for as long as `hᵢ₊₁ ≥ 1`, and height 1
  when the sequence did not end on it; at most `⌊log₂ tip⌋ + 2` entries, 28 for any tip below
  `MAX_ADVERTISED_HEIGHT` (< 2²⁷). A node with no chain sends `GENESIS_PREV_BLOCK_HASH` alone. The highest
  common entry lies under twice a fork's depth, so a fork `d` deep costs the requester at most `d` headers
  it already holds, which its pipeline takes as no-ops. A requester continuing a branch it is scoring puts
  that branch's last scored hash first, and one re-fetching a branch it scored heavier puts that branch's last
  stored header first — its base, before any is stored (NODE_INTERFACE → Fork choice decides on verified headers);
  past `MAX_LOCATOR_HASHES` the lowest entry is dropped. The root, `GENESIS_PREV_BLOCK_HASH`, names no block a
  server holds, so a locator led by it is answered from its next entry the server holds.

  A response is identified by its own frame code, so a caller checks `MSG_HEADERS` / `MSG_BLOCKS`
  rather than trusting that the answer matches the question it asked.
- ⚠ **Zero bytes and `vlqU(0)` are DISTINCT and consumers depend on it.** Zero bytes is the handler's
  *"I cannot answer"*; `vlqU(0)` is *"no items"*. Collapsing them is a live defect — see below.
- **`MAX_CHAIN_RESPONSE_ITEMS = 400`, enforced on BOTH sides**, and the receive cap — 400 headers for a
  `Headers` answer, the ids asked for a `Blocks` answer — is **checked before the first element is read**.
  A peer answering a header request with 18,900 headers is not answering the question, and the count is a
  `vlqU` the peer chooses. ⚠ **`readArr` is the wrong primitive here** — it bounds only at `MAX_ARRAY_LENGTH` (2²⁴),
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

  The rule: accumulate encoded bytes, stop before
  exceeding `MAX_SERVE_BODY_BYTES`, and **always include the first block**, so a request is never answered
  with nothing while the server holds the block asked for — whatever its reader then does with one over
  `MAX_ORDERING_BLOCK_BYTES` (→ Validation (and untrusted-input safety)). A truncated response costs the requester one round trip — it asks for
  the ids still missing in its next request — and never costs it the chain.

  **The `Blocks` arm answers the ids asked that its applied chain holds**, in the order asked, each id
  resolved by point lookup (`setHeightByBlockIdProvider`) and its block read once; an id it does not hold
  is omitted — "not held", never a refusal. **An id asked twice is answered twice**, in its places: the arm
  keeps no state across ids, and the byte bound caps the answer whatever the ids repeat.

  **Each block is encoded once.** The bytes the bound weighs are the bytes the response carries, so
  blocks reach the framing already encoded rather than being encoded to measure and again to send.
  ⚠ **This package's `A9` means no gate here measures cost**, so a doubling on a serve path would
  pass the whole suite; it is a decision, not an optimisation.
- **The `Headers` arm stays count-bounded, and that is a measurement rather than an oversight.** A
  header encodes to **at most `MAX_HEADER_BYTES`, 233 B** — 193 fixed (four 32-byte hex roots, a 33-byte
  `stateRoot` carrying the AVL height byte, a 32-byte `validatorId`) plus five `vlqU` fields at 8 bytes
  each when every one sits at `Number.MAX_SAFE_INTEGER` (`TYPES_INTERFACE → Size caps`). At the 400-item
  cap that is **~91 KiB, about 2.2 %** of `MAX_SERVE_BODY_BYTES`. A byte bound there would be a rule with
  no subject; each item is still weighed against `MAX_HEADER_BYTES` before it is decoded (→ Validation
  (and untrusted-input safety) → "A peer's bytes are weighed before they are decoded").

  ⚠ **233 B is the ceiling, not a typical header** — a realistic one measures 208 B. The distinction
  is the point: a bound must be argued from the ceiling, and an instance measured and reported as a
  ceiling is how a limit ends up justified by a number nothing enforces.
- **A response that does not decode THROWS; it must never resolve to `[]`.** An empty list is a statement —
  "nothing above your locator", "none of these held" — and the scheduler acts on it: an empty `Headers` page
  below a claim refutes the claim (→ Sync State Machine → "How a header sync ends"). A throw is not a
  statement, and must never be read as one.
- **A `Headers` page has one shape, and a requester holds a page to it.** The serve arm takes the first
  locator entry its applied chain holds — the highest, the locator running from the tip down — and answers
  the headers above it, ascending, for `MAX_CHAIN_RESPONSE_ITEMS` headers or up to its tip; a locator it
  holds no entry of is answered from height 1, and one whose highest held entry is its tip with an empty
  list. Nothing else is an answer: heights consecutive and ascending, the first header's parent a locator
  hash or — at height 1 — `GENESIS_PREV_BLOCK_HASH`. A page of any other shape is a served chain that is not
  one (`misbehavior`, → Peer Penalty System). A page shorter than `MAX_CHAIN_RESPONSE_ITEMS` ends at the
  server's tip, and one that ends below the server's claim refutes the claim (→ Sync State Machine → "How a
  header sync ends"). The scheduler is the requester that enforces it.

Removed protocols:
- The old text-based `/dagsocial/sync/1` (individual sub-block request/response) —
  its framed successors, codes 6–7, are themselves retired with sub-blocks
- `/dagsocial/headers/1` — its two queries ride codes 14–17 on the sync stream, under that stream's
  admission policy.

---

## Validation Architecture

Two-stage validation, modeled after Ergo's modifier processing:

### Stage 1 (net package, stateless)

Runs inside the gossipsub topic validators — i.e. **before** a message is
forwarded to mesh peers. A message that fails Stage 1 is Rejected (never
forwarded) and penalized: over its bound or undecodable → `ProtocolViolation` (permanent
ban — → Validation (and untrusted-input safety) → "A peer's bytes are weighed before they are decoded"); well-formed but invalid → misbehavior penalty (100), except a block's version mismatch, which is
`Transient` (→ Peer Penalty System), and a refusal that rests on this node's state, which records
nothing (→ Stage 1 → "A refusal that rests on this node's state records nothing"). Uses
`@dagsocial/validation`. Per topic:

| Topic | Checks before Accept |
|-------|----------------------|
| ordering-block | the message's length, at most `MAX_ORDERING_BLOCK_BYTES`; **the header first** — `readOrderingBlockSections` (TYPES_INTERFACE → Layout — Block), the header decoded and the body's bytes and the validator signature taken as they stand, a block that does not read → `ProtocolViolation` (→ Stage 1 → "A header is read before its body"); `verifyHeaderFieldDomains(header)`; protocol version — `verifyProtocolVersion(header.protocolVersion, header.height, schedule)`, a mismatch Rejected with `Transient`; `header.height` is a safe integer (NaN/float/±Infinity → Reject); **the network's floor** — `header.powTargetBits < NetConfig.orderingBlockPowTargetFloorBits` is Rejected with `misbehavior` (→ Consensus parameters net enforces); ordering-block PoW (`verifyOrderingBlockPoW`) — the solution must satisfy the header's own `powTargetBits`, and a non-safe-integer `powNonce`/`powTargetBits` never verifies (audit M-6, M-9); **the schedule, when this node holds the parent** — the scheduled-target provider's answer for the header, `null` when the parent is not held; a number that differs from `header.powTargetBits` is **Rejected with no penalty** (→ Stage 1 → "A scheduled-target mismatch is refused, never forwarded, and never penalised"); **the header's standing** — a header this node holds, has refused, or accepted inside the seen window is **Ignored with no penalty** (→ Stage 1 → "A header this node knows is Ignored"); **the validator signature** — `verifyValidatorSignature(header, validatorSignature)`, one that does not verify Rejected with `misbehavior`; **the body** — `decodeUtxoTxTree` over the body's bytes (undecodable → `ProtocolViolation`) and `verifyOrderingBlockStructure` over the block; **the body's root** — `verifyUtxoTxRoot(block)`, last: a body that is not the one the header's `utxoTxRoot` commits is Rejected with `misbehavior` (→ Stage 1 → "A worked header is forwarded with the body its root commits") |
| tx | the message's length, at most `MAX_TX_PACKET_BYTES`; `decodeTxPacket`; `verifyTxStructure`; protocol version — `verifyTxProtocolVersion(tx, chainHeight() + 1, schedule)`, the envelope's and the commit's against the next block's era, a mismatch **Rejected with no penalty** (→ Stage 1 → "A refusal that rests on this node's state records nothing"); the packet rule (`tx.post` present ⟺ `content` present); `verifyPostBody(content, tx.post.contentHash)` for a post-bearing tx; the cached karma-membership gate — the author holds karma at all (`NODE_INTERFACE` → Post transactions), a miss **Rejected with no penalty**; then `verifyTxSignatures(tx)` — every entry of the signature map over the transaction's id, one that does not verify Rejected with `misbehavior` (→ Stage 1 → "A transaction's signatures are checked at Stage 1"). Order as under Gossip Topics; the forward waits for Stage 2 (→ Forwarding Rule) |

Stage 1 reads chain state through two providers and the karma set, and through nothing else. It does
**not** check the header timestamp rules, chain linkage, or state roots — those are apply-time checks in
`@dagsocial/node`, enforced for every entry path (gossip, sync, reorg) by the block-apply funnel.
The difficulty schedule (`powTargetBits` against the schedule over the stored parent,
`MINING_INTERFACE → Difficulty Schedule`) is apply-time too, and stage 1 asks it once, through the
scheduled-target provider, for the one case it can answer without trusting anything: a header whose parent this node's header tree
holds. The header-standing provider answers whether this node holds a header or has
refused it (→ Sync Handler Registration). The validator signature is checked twice: at Stage 1 over the
header and the signature alone, and in the funnel on every entry path. The relay PoW gate exists to
make mesh propagation cost-bearing: no zero-work ordering block may be re-gossiped (audit M-9), and the
network's floor puts the price of a forwarded header at the network's own minimum rather than the
resolution floor's nine bits.

**A worked header is forwarded with the body its root commits.** `verifyUtxoTxRoot`
(`VALIDATION_INTERFACE → verifyUtxoTxRoot`) holds a block's body to its header's `utxoTxRoot` — every
transaction id and every transaction's bytes — so a block that passed the PoW check is forwarded
with the body its producer hashed, or not at all. A message is named by its bytes (→ Gossip Topics →
"A message is named by its bytes"), so each altered body under one worked header is a message the
seen window has never named; this check is what ends it at the first hop. **The sender is
penalised**: a node forwards only what passed its own Stage 1, so a body that is not its header's
was altered or made by the peer that sent it. **It runs after the PoW check** because it hashes the
whole body (`VALIDATION_INTERFACE → verifyUtxoTxRoot`, its cost), and nothing ahead of that check
has proven work. Reaching net as a `NetValidators` member, it is `validation`'s function and no
other.

**A scheduled-target mismatch is refused, never forwarded, and never penalised.** The verdict is
deterministic given the parent — ASERT over the parent's stamp and the anchor, no clock — so it is
a consensus verdict: a header carrying the wrong target for its parent applies on no node that holds
that parent. The penalty is withheld because the previous hop may not hold the parent — a peer still
syncing forwards on the floor and the PoW alone, honestly — and the refusal's whole value is that
the first hop holding the parent stops the forward. The originator pays the hashes and nothing else;
a direct flood is bounded by the floor's cost per message, and nothing it sends reaches the funnel.

**A header is read before its body.** The block topic's validator reads the block's sections first
(`readOrderingBlockSections`, TYPES_INTERFACE → Layout — Block): the header decoded, the body's bytes
and the validator signature taken as they stand. Every check that needs only the header — its domains,
version, floor, work, schedule and standing, and the validator signature — runs before the body is
decoded, so a block no one worked, or one whose header this node knows, costs a receiver one header
decode, under a millisecond, where decoding a body at `MAX_BLOCK_BODY_BYTES` takes up to ~0.2 s
(measured 2026-10-14 on an i9). The body is decoded, its structure checked and its root recomputed only
for a header that passed them all.

**A header this node knows is Ignored.** After its work and its schedule, a header whose hash is the
block this node holds at its height, one marked refused (`NODE_INTERFACE → Refused headers`), or one
this validator accepted inside the seen window — `GOSSIP_SEEN_WINDOW_MS` from its acceptance — is
Ignored: not delivered, not forwarded, no penalty. The first two are the header-standing provider's
answer (→ Sync Handler Registration); the third is net's own memory of the headers it accepted. **The
memory bounds a block's variants.** The validator signature lies outside the block hash, and the key's
holder can sign one header again under another nonce as often as it likes (VALIDATION_INTERFACE →
Acceptance criterion), so each signing is bytes the router has never named — without the memory, one
block forwarded mesh-wide again and again; under it, a header is forwarded once a window, as one
message's bytes are. The memory holds an entry only for a block message the router's seen set holds
for the same window, so it never outgrows that set. **No penalty:** a peer that has not applied the
block — behind this node, or syncing — forwards it honestly.

**A transaction's signatures are checked at Stage 1.** `verifyTxSignatures` (VALIDATION_INTERFACE →
verifyTxSignatures) holds every entry of the signature map to the transaction's id. A valid
transaction's map carries no key its transitions do not require, and each required key's signature
verifies (NODE_INTERFACE → Legal box transitions → "The signature map carries no key a transition does
not require."), so an entry that does not verify makes the transaction invalid on every chain: a
refusal the sender could have reached, penalised `misbehavior`. It runs last of the tx topic's checks,
behind the karma gate, because it is the dearest — 1.1–1.7 ms a signature (NODE_INTERFACE → Post
transactions, measured). Node's admission answers each required signature from this check rather than
verifying it again (→ Inbound Processing).

**A refusal that rests on this node's state records nothing.** A scheduled-target mismatch (above), a
transaction whose declared version is not the era of the block after this node's tip, and a post whose
author is outside this node's karma set are Rejected — not delivered, not forwarded — and penalise
nobody. Each verdict reads this node's tip: a node behind holds neither a recently funded author nor
the next era, a node ahead has applied the block that spent an author's last karma, and the hop that
sent the message may stand on either side of it (→ Penalty Attribution → "A penalty rests on what the
sender could know").

**A fault of this node's is no peer's.** The decode is the one step whose throw is the sender's
(`ProtocolViolation`). A throw anywhere else in a validator — a provider's read, the chain height — is
this node's: it is logged, the message is Ignored, and no penalty is recorded. A corrupt chain never
reaches net as a throw: node's providers stop the node on it themselves (NODE_INTERFACE → Sync
handlers).

### Stage 2 (node package, stateful)

Runs after Stage 1 passes, via registered `on*` callbacks:

- Parent refs exist (a stored post, live or withdrawn)
- Author has sufficient karma
- UTXO inputs unspent, each transition's authorization satisfied
- A post packet that passes is admitted as one: the transaction into the mempool and the body
  into the DAG as a pending row, together or not at all (`NODE_INTERFACE` → Post transactions)

**A Stage 2 refusal records nothing.** Stage 2 judges a message against this node's state — its UTXO
view, its pool, its karma record — which the hop that forwarded it held at another moment or on another
tip: a transaction it admitted may spend a box this node has not yet seen, or has seen spent. A
transaction Stage 2 refuses is Ignored — never forwarded (→ Forwarding Rule) — and penalises nobody.

### Forwarding Rule

**An ordering block is forwarded once Stage 1 passes; a transaction once this node admits it.** A
block's forward is bought by its work: Stage 1 holds it to the floor and its own PoW, its validator
signature and the body its root commits, so a bogus-PoW or NaN-nonce block is dropped at the first hop,
and a valid one is forwarded before it is applied — its propagation costs a hop no apply time. Net
reports the block's forward, then hands it on, so the apply runs behind the forward. A transaction
carries no work, so its forward is bought by its admission: the router holds a transaction that passed
Stage 1 unforwarded (gossipsub's `asyncValidation`), node's Stage 2 answers whether it admitted it
(→ Inbound Processing), and only an admitted transaction is forwarded; a refused one is Ignored and
penalises nobody (→ Stage 2 → "A Stage 2 refusal records nothing"). What no node admits — a transaction
spending a box its signer does not own, one already spent, one the pool already holds — dies at the
first hop.

---

## API

### Node Lifecycle

| Function | Signature | Description |
|----------|-----------|-------------|
| `start(config)` | `(NetConfig) => Promise<void>` | Create libp2p node, register both stream protocols, connect to bootstrap peers, subscribe to topics. **A start that throws stops what it started** — the libp2p node and the scheduler — before the error leaves it, so a caller that continues without networking runs none of it |
| `stop()` | `() => Promise<void>` | Graceful shutdown. **A stopped node starts again whole**: the next `start()` registers both protocols on the libp2p node it creates |
| `peerId()` | `() => string` | This node's libp2p peer ID |
| `peers()` | `() => Peer[]` | Connected peers with metadata, at any peer state; never this node itself (→ Handshake) |
| `getConnectedPeers()` | `() => string[]` | Peer IDs of the Active peers — the DAGsocial handshake completed; never this node's own (→ Handshake) |
| `tipApplied(height)` | `(number) => void` | The node reports each applied tip — every successful apply and the tip a reorg leaves, at the seam where it stamps `dag_tip_height`. When `protocolVersionAt(schedule, height + 1)` is above the era last in force, the boundary sweep runs (→ Post-Handshake Routing); inside an era it does nothing |
| `syncPhase()` | `() => 'idle' \| 'syncing' \| 'synced'` | The scheduler's phase (Sync State Machine → "The phases"): `'idle'` before the first claim this node settles — before `start()`, after `stop()`, and on a node that has met no peer; `'syncing'` while a header sync or a block request is open or the best chain is not fully applied; `'synced'` once the best chain is fully applied and every unmarked Active peer's claim is settled — a co-started mesh enters it at its first settled claims, a miner with followers included. A reader wanting "not behind" tests for `'syncing'` absent |

### Gossip

| Function | Signature | Description |
|----------|-----------|-------------|
| `broadcastOrderingBlock(b)` | `(OrderingBlock) => Promise<void>` | Gossip a newly created ordering block |
| `broadcastTx(tx, content?)` | `(UtxoTransaction, string?) => Promise<void>` | Gossip a transaction **packet** — `encodeTxPacket(tx, content)`; a post's body travels in the same message (→ Gossip Topics). The caller passes `content` ⟺ `tx.post` is set. |

**A broadcast that sends nothing still resolves.** Each publishes on the node's own topic for its
payload. Before `start()`, with no peer on the topic, or with the bytes already seen on the topic inside
the seen window (→ Gossip Topics → "A message is heard once in a seen window"), nothing is sent and the
promise resolves as it does for a message that went out.

### Inbound Processing

| Function | Signature | Description |
|----------|-----------|-------------|
| `onOrderingBlock(callback)` | `((OrderingBlock, fromPeerId: string) => void) => void` | Register handler for inbound ordering blocks. `fromPeerId` is the peer that **relayed** the block to us, or `''` — see below |
| `onTx(callback)` | `((UtxoTransaction, content: string \| undefined, fromPeerId: string) => boolean) => void` | Register handler for inbound transaction packets. `content` is the verified body when the transaction carries a post (the validator has already checked it against `tx.post.contentHash`), `undefined` otherwise; every entry of `tx.signatures` has verified over the transaction's id (→ Stage 1 → "A transaction's signatures are checked at Stage 1"); `fromPeerId` carries the same relayed-peer semantics as `onOrderingBlock`'s. The return is whether the handler admitted the transaction (→ Inbound Processing → "A transaction is forwarded when a handler admits it"). |

**A gossip message that passes Stage 1 is delivered, whichever peer carried it.** No gate stands
between the topic validator's Accept and the handler. The router hands a message on once and never a
second copy (→ Gossip Topics → "A message is heard once in a seen window"), so a delivery withheld for
its first carrier's sake — a peer whose handshake has not completed, or one whose ban has not yet closed
its connection — would be a valid block or transaction this node does not hear for the window, however
many `Active` peers send it after. The carrier reaches the handler as `fromPeerId`, a hint and nothing
more, and it need not be `Active`.

**A transaction is forwarded when a handler admits it.** Net reports the router's verdict on a
transaction message once its handlers have answered: Accept — the message is forwarded — when any
handler returned `true`, Ignore otherwise (→ Forwarding Rule). A handler that throws answers for itself
nothing but the throw, which is logged. An ordering-block message is reported Accept before its
handlers run.

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
| `requestHeaders(locator, peerId)` | `(string[], string) => Promise<BlockHeader[]>` | The scheduler's header query (codes 14/15): the headers above the highest locator hash the peer's applied chain holds, ascending (→ `GetHeaders` / `GetBlocks` responses) |
| `requestBlocks(ids, peerId)` | `(string[], string) => Promise<OrderingBlock[]>` | The scheduler's block query (codes 16/17): the blocks among `ids` the peer's applied chain holds, in the order asked |
| `requestPostBodies(wanted, peerId)` | `({ id: string; contentHash: Uint8Array }[], string) => Promise<{ id: string; content: string }[]>` | Request post bodies by id from one peer (`ModifierRequest` type 103 on the sync stream, codes 4/5); the caller supplies each id's commitment. **Any number of ids, asked in requests of at most `MAX_INV_IDS`, one after another, the answers merged; a request that fails fails the call, as one request does** — a request over the cap is one the peer's decoder refuses as malformed, and bans the sender for (→ ModifierRequest). Answers carry only the ids the peer holds; each body is decoded and verified against its commitment before it is returned — a mismatch or an undecodable body is a misbehaviour penalty and is dropped — and **the verified bodies are returned to the caller, which stores them** (the node's body pulls) |

**A request is one round trip, and closing its stream never changes its answer.** Every request this node makes —
the handshake, `GetHeaders`, `GetBlocks`, `GetPeers`, a body request — opens the protocol under
`syncRequestTimeoutMs` (×5 for `GetBlocks`), writes one frame, reads one bounded answer (→ Validation (and
untrusted-input safety)) and closes the stream. A close that fails is the stream already ending; the answer read
stands, and so does the error that ended the read.

⚠ **Both chain queries THROW rather than return empty** on an unexpected frame
code or a malformed body — a decoded-but-empty answer is a statement ("nothing above your locator",
"none of these held"), a throw is not, and the caller must be able to tell them apart. Whatever either
query returns reaches the node only through the pipeline (→ Sync Handler Registration), which binds every
block to the header its tree holds before staging it (NODE_INTERFACE → Fork choice decides on verified
headers → "A served block is bound to its header before it is kept").

**The scheduler asks for nothing the pipeline has not named.** A header request carries the chain view's
locator for that peer; a block request carries ids the chain view names (`wantedBlocks`), never a height
range and never a block a peer claimed (→ Sync State Machine). Node calls neither query: the pipeline says
what it lacks, and the scheduler decides whom to ask.

**A gossiped block's relayer is asked for the headers the tree lacks.** The pipeline's `needHeaders(peerId)`
(→ Pipeline events) names the peer that relayed a block whose parent the header tree does not hold; the
scheduler opens that peer's header sync when it is Active and unmarked — that peer provably holds the
chain, an arbitrary one does not. A relayer that is neither, or a `fromPeerId` of `''`, is asked nothing:
the block waits as its relayer's pending block (NODE_INTERFACE → Fork choice decides on verified headers →
"One intake, one at a time"), and the headers it lacks arrive with the claims of the peers that hold them.

### Pipeline events

| Function | Signature | Description |
|----------|-----------|-------------|
| `needHeaders(peerId)` | `(string) => void` | The pipeline lacks the headers below a block `peerId` relayed (→ Pull Requests → "A gossiped block's relayer is asked for the headers the tree lacks") |
| `chainMoved()` | `() => void` | The best chain or the applied tip moved: the scheduler asks the chain view again for the blocks wanted and for its claims' standing |

`tipApplied(height)` (→ Node Lifecycle) stays the era sweep's seam; `chainMoved()` is the scheduler's.

### Sync Handler Registration

| Function | Signature | Description |
|----------|-----------|-------------|
| `setPipeline(intake)` | `(PipelineIntake) => void` | The node's pipeline intake — every answer's way in (NODE_INTERFACE → Fork choice decides on verified headers). `deliverHeaders(peerId, claimHash, headers): Promise<'taken' \| 'again' \| 'refused'>` hands it a `Headers` page held to its shape, with the peer's claim as the page is delivered — the refute test reads the claim the page was asked under (→ Sync State Machine → "How a header sync ends") — `''` for a run `needHeaders` opened on a peer with no claim, whose branch ends at the peer's tip, the first page shorter than `MAX_CHAIN_RESPONSE_ITEMS`; it resolves `'taken'` when the pipeline took the page whole — stored, scored, or held already — `'again'` when it took the page and is re-fetching a branch it scored heavier, so the peer is asked again at once, and `'refused'` when it took none of it (penalised where the refusal is the peer's), which ends that peer's header sync unmarked (→ Sync State Machine → "One header request per peer, every peer at once."). `deliverBlocks(peerId, blocks): Promise<void>` hands it a `Blocks` answer's blocks. Both resolve once the intake has taken the delivery; neither throws for a peer's bytes |
| `setChainView(view)` | `(ChainView) => void` | The node's header tree as the scheduler reads it, and the one place it learns anything about the chain: `locatorFor(peerId): string[]` — the locator a header request to that peer carries (→ `GetHeaders` / `GetBlocks` responses); `knowsTip(peerId, hash): boolean` — the tree holds `hash`, or the pipeline scored that peer's branch lighter at it; `wantedBlocks(): { id: string; height: number }[]` — the blocks the pipeline wants next, each id with its height, in height order (NODE_INTERFACE → Fork choice decides on verified headers → "The pipeline names the blocks it wants"); `fullyApplied(): boolean` — the best chain's tip is applied; `gateHeld(): void` — the scheduler's report that the gate holds now (→ Sync State Machine → "The gate bounds how far blocks apply"). **One question is one call**, a point read or an in-memory answer — no call walks the chain (ARCHITECTURE → Correct and cheap are separate obligations). Unset → the scheduler asks no peer anything |
| `setHeadersHandler(cb)` | `((height: number) => OrderingBlock \| null) => void` | Provider for the `GetBlocks` (code 16) serve arm: the block stored at a height, read for each requested id the height-by-id provider places on the applied chain. Returns the whole block. **Never a header for `GetHeaders`, never the tip height, never a block id** — those are the rows below |
| `setHeaderProvider(cb)` | `((height: number) => BlockHeader \| null) => void` | Provider for `GetHeaders` (code 14): the header stored at a height of the applied chain, read without its block's body. **One height is one header read**: the arm serves up to `MAX_CHAIN_RESPONSE_ITEMS` headers, and a whole-block read there decodes up to 400 bodies of up to `MAX_BLOCK_BODY_BYTES` for a request of a few hashes. Unset → `GetHeaders` is answered zero bytes |
| `setChainHeightProvider(cb)` | `(() => number) => void` | Provider for the chain tip height — the one number behind the handshake `chainHeight`, `SyncInfo.tipHeight` and the serve arms' tip. **One read is one provider call**: `SyncStore.chainHeight()` returns the provider's value and never walks the chain through the headers provider (ARCHITECTURE → Correct and cheap are separate obligations). Unset → `0`, as a node with no chain. The node hands over its store's `MAX(height)` — the same tip its block creator and its pipeline read — so the height `net` claims is the height the node mines on |
| `setBlockIdProvider(cb)` | `((height: number) => string \| null) => void` | Provider for the block id at a height — behind `SyncInfo.tipHash`, the id at our tip height. The id is the store's own, written at block application; `net` computes no id it claims from a header — the one id it computes, `blockHash` over a gossiped header for the standing check, it never claims (→ Stage 1 → "A header this node knows is Ignored"). **One id is one provider call**, a point read that decodes no block (ARCHITECTURE → Correct and cheap are separate obligations). Unset → `null` — the tip hash of a node with no chain, `GENESIS_PREV_BLOCK_HASH`, is claimed in its place |
| `setHeightByBlockIdProvider(cb)` | `((id: string) => number \| null) => void` | Provider for the height holding a block id, or `null` for an id not on our chain — the read that finds a `GetHeaders` locator's highest entry on our chain and resolves a `GetBlocks` request's ids to the heights it serves from. **One id is one provider call, never a chain walk**: a message of k ids costs k point lookups, and no message rebuilds an id index of the whole chain (ARCHITECTURE → Correct and cheap are separate obligations). Unset → `null` — every id unknown, nothing served |
| `setScheduledTargetProvider(cb)` | `((header: BlockHeader) => number \| null) => void` | Provider for the ordering-block topic validator's schedule check: the `powTargetBits` the schedule requires of `header`, or `null` when this node's header tree does not hold `header`'s parent — a header at height 1 answers the anchor's bits; otherwise the tree's header `header.prevBlockHash` at `header.height − 1`, evaluated as the apply funnel evaluates it over its own path's anchor stamp (`MINING_INTERFACE → Difficulty Schedule`). **One header is one provider call.** Unset → `null` — every header passes on the floor and its own PoW alone (→ Stage 1) |
| `setHeaderStandingProvider(cb)` | `((hash: string, height: number) => 'held' \| 'refused' \| null) => void` | Provider for the ordering-block topic validator's standing check: `'held'` when the block this node stores at `height` has the id `hash`, `'refused'` when `hash` is marked in `refused_headers` (NODE_INTERFACE → Refused headers), `null` otherwise. **One header is one provider call.** Unset → `null` — every header is judged as one this node does not know (→ Stage 1 → "A header this node knows is Ignored"); net's own memory of accepted headers stands either way |
| `onSyncComplete(cb)` | `(() => void) => void` | Fired on every entry into the `synced` phase |
| `setPostBodyProvider(cb)` | `((postId: string) => string \| null) => void` | Provider for the `MODIFIER_POST_BODY` serve arm: the body this node holds for the id, or `null` — served locally or omitted, never relayed (→ Local-Serve-Before-Relay). |
| `onPeerActive(cb)` | `((peerId: string, direction: 'inbound' \| 'outbound') => void) => void` | Fired when a peer completes the handshake and becomes Active; `direction` is the connection's. |
| `onPeerDisconnected(cb)` | `((peerId: string, reason: string) => void) => void` | Fired after a peer's disconnect is processed (`PeerManager.removePeer`), the disconnect a ban's hang-up raises included (→ Handshake, "A ban ends the connection"). `reason` is always `''` — libp2p's `peer:disconnect` carries none; the parameter is the shape JOURNAL_EVENTS → peer_disconnected names. |
| `onPeerPenalised(cb)` | `((peerId: string, kind: string, detail: string \| null) => void) => void` | Fired by `PeerManager` itself at its two penalty entries, `recordPenalty` and `recordPenaltyKind` — so every path that records a penalty reaches it, `gossip.ts`'s and `penalizePeer`'s included; `kind` is the `PenaltyType` / `PenaltyKind` string as recorded, `detail` the reason. |

**These four are what JOURNAL_EVENTS → Peer Events / Sync Events and NODE_INTERFACE → Admin Listener read** —
`peer_connected` from `onPeerActive`, `peer_disconnected`, `peer_penalised`, `sync_complete` from `onSyncComplete`;
`syncing` from `syncPhase()`. The node reads `onPeerDisconnected` once more, for its pipeline:
a peer that has gone takes its pending block, its presync and its memo entry with it
(NODE_INTERFACE → Fork choice decides on verified headers → "One intake, one at a time").

**Handler setters are order-independent.** Every setter above stores a delegate and has no libp2p side
effect, so it is valid before or after `start()`, and a later call replaces the delegate. Registering a
libp2p protocol is `start()`'s responsibility alone. A setter that also registers makes its own call
order load-bearing with nothing to signal it: the registration reads a libp2p instance that `start()`
has not created yet, the guard falls through, and every layer beneath keeps passing — the protocol is
simply absent for the life of the process, which a peer sees as `protocol selection failed` and reads
as the peer's fault rather than ours.

**A node that has registered no provider for a query answers it zero bytes** — `GetHeaders` with no header
provider, `GetBlocks` with no headers provider — rather than leaving the stream unanswered. Zero bytes is "I cannot
answer", and it is distinct from an empty header *list* — one byte, `vlqU(0)` — which means "I consulted my chain and
have nothing above your locator". A node holding no provider has no chain to consult, so it cannot honestly send the
second. Both reach the caller as an empty array, and the scheduler reads it as an answer that holds nothing: a
header sync it leaves short of its claim ends refuted (→ Sync State Machine → "How a header sync ends").

**A code no arm serves is closed unanswered, so it reads as "I cannot answer".** A peer that speaks
`/dagsocial/sync/1` but does not know a query's code reads the frame and closes the stream (→ Stream Protocols →
"Every inbound stream ends"): the requester's read ends at once with zero bytes, as from a node with no provider,
never at its deadline — `requestBlocks`' runs ×5. Both serve arms answer on every path they own, declining included.

⚠ **On the shared stream, "this peer does not speak the query" and "this peer has nothing to serve" are one
event.** A protocol of its own per query would tell them apart — an unregistered protocol fails at libp2p's protocol
selection. The trade is deliberate: a single registered protocol carries one admission policy (Active-only,
penalty-bearing) instead of two, and a query on the shared stream is unreachable by a peer that never handshook.

---

## Config

> ⚠ **AHEAD OF CODE (2026-10-19).** The block below leads `NetConfig`, whose three peer-discovery fields are optional
> and fall back to net's own 3, 1000 and 60000.

Every field is required; net holds a default for none of them (→ Outbound Manager).

```typescript
interface NetConfig {
  // Transport
  bootstrapPeers: string[]
  listenAddrs: string
  maxPeers: number

  // Network — REQUIRED, supplied by the node from its resolved profile.
  // No default; see §Magic Bytes and §Consensus parameters net enforces.
  magic: number                    // mainnet 0x4D444147 · testnet 0x54444147 · devnet 0x44444147 —
                                   // every frame's magic and both gossip topics' names (→ Gossip Topics)
  protocolVersionSchedule: readonly ProtocolEra[]   // the profile's era table (TYPES_INTERFACE → Version):
                                   // the handshake, the tx validator and the boundary sweep read the
                                   // era at chainHeight() + 1 from it; the block validator each header's
  orderingBlockPowTargetFloorBits: number   // the profile's difficulty floor (TYPES_INTERFACE → Network
                                   // profiles): the ordering-block topic validator refuses a header
                                   // below it (→ Consensus parameters net enforces)

  // Peer discovery
  minPeers: number                 // floor for the fill phase (→ Outbound Manager)
  peerDbCap: number                // soft cap on PeerDb entries (→ PeerDb)
  outboundRedialCooldownMs: number // redial cooldown (→ Outbound Manager)

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
(`verifyHeaderFieldDomains` + `verifyOrderingBlockPoW`): a block is checked against its own
header's `powTargetBits`, bounded **by the network's own floor**, `orderingBlockPowTargetFloorBits` —
every profile's at or above the `ORDERING_BLOCK_POW_TARGET_FLOOR` constant from `@dagsocial/types`,
which the structure check holds again in the funnel — which reaches the topic validator as a `NetConfig` value
(→ Stage 1). The scheduled target reaches it as a **provider**, never a parameter: node answers
`setScheduledTargetProvider` for a header whose parent it holds and `null` otherwise (→ Sync
Handler Registration). Net receives values; it does not resolve them, does not import
`NetworkProfile`, and reads no environment variable for them.

| Value | Why net needs it | Today |
|---|---|---|
| `magic` | Frame assembly and the frame-magic check | ✅ Supplied by the node from its resolved profile — see §Magic Bytes |
| `protocolVersionSchedule` | The era at a height — the handshake, both topic validators, the boundary sweep | ✅ Supplied by the node from its resolved profile — see §Config |
| `orderingBlockPowTargetFloorBits` | The ordering-block topic validator refuses a header whose `powTargetBits` is below it — `misbehavior`, the tier PoW-invalid carries: no honest producer on this network mines below its floor, and the schedule's clamp never asks for it (`MINING_INTERFACE → Difficulty Schedule`) | ✅ Supplied by the node from its resolved profile — required, no default |

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
- Headers asked of every peer whose claim the node's header tree lacks, blocks fetched along the node's best
  chain, and the applied chain served to every peer that asks
- UTXO transactions received from peers are validated and forwarded to the
  local node's mempool
- Ordering blocks received from peers are validated and applied
- Locally-produced ordering blocks and locally-submitted transactions are
  gossiped to peers — a post's transaction and its body as one packet
- Post bodies are served by id from the local store to peers that ask, pulled by id for the
  node in requests of at most `MAX_INV_IDS`, and delivered to the node only after verifying
  against their commitment
- PeerDb populated from handshakes and Peers gossip; outbound manager
  maintaining peer count between minPeers and maxPeers

## Invariants

- Frame magic bytes reject wrong-network connections at the transport layer
- Frame checksum catches corruption before body parsing
- Stream protocols carry framed messages; Gossipsub topics carry the object's
  own positional wire encoding, unframed
- Sync is bidirectional — nodes serve peers behind them, not just consume
- A peer's claim is a reason to ask it, never a measure of a chain: the chain is chosen by the node's
  pipeline over verified headers, and net's scheduler chooses only whom to ask (→ Historical Sync)
- Unknown message codes and peer capabilities are preserved, not rejected
- A node is never its own peer: a connection to its own peer id is closed at the dial and refused
  at the handshake, and the PeerDb self-address filter keeps its own addresses out of the fill phase
- A banned peer is never handshaken: its inbound connection is refused at the transport and its
  handshake stream unread, the dial is closed outbound, and every address a dial ties to it leaves
  PeerDb; a ban ends the connection it lands on, and the scheduler drops the peer at once
- Bogus addresses filtered silently; malformed Peers trigger permanent ban
- Stage 1 reads chain state through the cached karma-membership set (`NODE_INTERFACE` → Post
  transactions) and two providers — the scheduled target and a header's standing — and a refusal
  that rests on one penalises nobody; the body check reads only the packet's own transaction for its
  commitment
- A post body crosses the network only inside its transaction's packet or as a
  `MODIFIER_POST_BODY` answer — never as a message of its own, never hashed into an id
- A body request is served locally or omitted — never relayed
- Ordering blocks are verified before application — a block extending an
  unknown chain may be buffered but never applied
- A transaction is forwarded only once the local UTXO view admits it — a conflicting
  transaction (a double-spend) is neither admitted nor forwarded
- Peer identity (libp2p) is independent of account identity (Ed25519 keypair)
- A topic name carries its network's magic and a format version — another network shares no
  topic, and an incompatible wire format gets a new one
- A gossip message carries no publisher and no signature, and its id is a function of its topic
  and its bytes
- Inbound messages are re-verified before forwarding and storing
