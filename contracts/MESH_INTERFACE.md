# MESH Interface Contract

## Scope

The mesh is how a browser reaches a Notis node's HTTP API by the node's key over libp2p, with no DNS name and no hosted
page. **A Notis node run with a mesh role is a mesh node** — one process under its node key (`NET_INTERFACE → The node
key`), `@dagsocial/net` carrying the transports, the roles, the DHT and the endpoint (→ Place in the workspace).
**It changes no consensus, wire or HTTP API rule.** Every answer a client checks is checked by code the extension
already runs. The client is a reader in the nodes' own block gossip, under `net`'s rules (→ Block gossip).
`@dagsocial/mesh-poc` holds the client's reasoning about nodes, the page and the stage; what the stage has to show is →
Acceptance.

It carries Notis's own traffic and nothing else: no exit to the wider network, no IP tunnel.

## Place in the workspace

**The node half is `@dagsocial/net`'s**, under `NetConfig.mesh` (`NET_INTERFACE → The mesh`), configured by the node's
`MESH_*` settings (`NODE_INTERFACE → Configuration`). **The browser half is `@dagsocial/net/browser`**: the reader's
handshake, the gossip rules, the block check, the reader's libp2p options and the mesh fetch, importing no Node
built-in and reading no Node global. `tools/mesh-poc` is a member under `tools/`: it depends on `@dagsocial/types`,
`@dagsocial/validation`, `@dagsocial/node-reads`, `@dagsocial/nipopow`, `@dagsocial/nipopow-client` and `@dagsocial/net`, and `src/lib.ts`
and everything it reaches runs in the browser as written. No WASM. One native module, `node-datachannel` under
`@libp2p/webrtc`, serves WebRTC on Node.js: the WebRTC-direct listener and dials, and a private node's WebRTC.

**libp2p is pinned.** `libp2p` and every `@libp2p/*` dependency of `net` and of the member are at an exact version.
They reach places libp2p does not promise to keep — its `components` object, for a listener added after start (the
secure WebSocket, a private node's relay listens) and for the listener addresses a private node prints; the dial
queue's `dial-queue:calculated-addresses` progress event and its `AggregateError` order, for per-address attribution
— and each is held by a case against the real libp2p, so an upgrade that moves one fails its case. **Two pinned
packages carry local patches** (pnpm's `patchedDependencies`, the diffs under `patches/`), each held by a case against
the patched package: `@libp2p/webrtc`, whose certificate renewal timer re-arms past Node's timer limit (→ Transports →
"The WebRTC-direct certificate persists"), and `@libp2p/http-utils`, whose `readHeaders` hands a request's body back to
its stream and whose Node-side server adapter is kept out of the browser's import path. A pin that moves carries its
patch to the new version, the cases deciding that it still applies and still holds.

## Identity

**One key, two spellings.** A mesh node's identity is an Ed25519 key in the form a Notis identity takes
(`TYPES_INTERFACE → Identity`):

- **the Notis spelling** — the 32-byte public key as 64 lowercase hex characters, the `UserId` spelling of the HTTP
  API. The client shows it and an anchor lists it.
- **the peer id** — libp2p's identity multihash over its protobuf key encoding: `00 24 08 01 12 20` followed by the 32
  bytes.

Each converts to the other. A peer id of any other key type, and any spelling but 64 lowercase hex, is refused.

**The key persists.** A mesh node's key is its node key, read by `net`'s `loadNodeKey` from `NODE_KEY_PATH` under its
rule (`NET_INTERFACE → The node key`): created on first start, never overwritten, a file of any other form refused and
left as it is. A node that restarts keeps its peer id. A client's key is its own, made for the session.

Nothing about a mesh key touches the chain.

## The mesh URL

`notis-mesh://<notisId><path>` names a path on a node's HTTP API by the node's key —
`notis-mesh://<64 hex>/nipopow/proof/24/20`. The path keeps its query. Any other scheme, a key that is not 64
lowercase hex, or an empty path is refused.

It is the `url` an `HttpFetch` over the mesh takes, so every reader that takes an `HttpFetch` — `@dagsocial/node-reads`'
readers, `@dagsocial/nipopow-client`'s `resolveTip` — runs over the mesh unchanged.

## Transports

| Between | Transport | |
|---|---|---|
| node and node | TCP; WebRTC-direct | |
| browser to a public node | **WebRTC-direct** | the one path with no domain and no certificate authority: the address carries the certificate's hash |
| browser to a node behind NAT | WebRTC, signalled over a circuit relay | → NAT |
| browser to an opted-in public node, UDP blocked | secure WebSocket, with a certificate for the node's bare IP | → The IP certificate |

**Every link is authenticated by the key it was dialled for.** libp2p's Noise handshake runs inside every transport
here — over WebRTC it binds the DTLS certificates to the two keys — and a node whose key is not the one dialled is
refused, whatever certificate it holds.

**The WebRTC-direct certificate persists** in the node's mesh state directory, and lives as long as the node's key:
created at first start with a lifespan of `WEBRTC_CERT_LIFESPAN_MS`, never replaced while it is valid, its renewal
timer re-arming in steps under Node's 2 147 483 647 ms limit, so a lifespan past that limit renews only at
`notAfter` less libp2p's renewal threshold. Its hash is part of the address an anchor lists, so a certificate that
changed — at a restart or at a renewal — would leave every anchor naming the node unreachable. **A state directory
whose certificate cannot be read stops the node at start**, naming the directory, and is left as it is, as a key file
of another form is.

**A client dials a private address only when its own configuration names it.** libp2p's default connection gater in a
browser refuses every address in a private or reserved range (`10.0.0.0/8`, `100.64.0.0/10`, `192.168.0.0/16`, the
documentation ranges and the rest of its list). The client runs its own gater, the same in every runtime: it refuses
every private address but those its own configuration names for a key — an anchor's, or one the reader entered by hand
(→ Discovery → "A node added by hand") — each for that key alone. A remote node cannot know what is on the reader's
network, so a private address it offers — through the DHT, a peer list or a seed — is never dialled, and a page cannot
be made to probe its own network.

**Plain `ws://` is no browser path**: a browser client's home is a secure context. **WebTransport is not used**:
js-libp2p's WebTransport does not listen on Node.js, and a Notis node is Node.js.

## NAT

**A node's role is its operator's setting**, `public` or `private` — `MESH_ROLE`; a node run with none runs no mesh.
A **public** node runs a circuit relay v2 server and
AutoNAT v2 — the dial-back that tells other nodes which of their addresses answer — and a STUN server on `STUN_PORT`
(RFC 8489's port) at the IP of its first WebRTC-direct listen address, unless its operator names another or turns it
off. A **private** node, one run with no public address, takes a relay reservation on each public node it is told of —
its bootstrap peers, by address and id, over the connection `net` holds to each, never by searching — and is reached
through them; between nodes, DCUtR upgrades a relayed connection
to a direct one where the NATs allow it. A browser reaches a private node over WebRTC signalled through the relay,
gathering ICE candidates against public nodes' STUN servers alone — or, where no direct path opens, over the relay
itself.

**A relay carries data.** Reaching a node — any node — comes first. A public node relays with no data or duration limit
on a circuit, keeping libp2p's default reservation count, so a relayed connection is not a limited one. A node a client
has no direct path to — a node behind a symmetric NAT, for a client behind a NAT of its own — is reached through a
relay, its data relayed; where the NATs allow a direct path, that path is dialled first and read first. A relayed link
is authenticated end to end by the key it was dialled for (→ Transports): the relay can block what it carries, never
read or forge it. Limits against abuse of a relay wait for an abuse that is measured.

**A relay that does not answer never stops a private node.** The node starts on its own addresses alone and asks each
relay for its reservation afterwards, every attempt under `RELAY_LISTEN_TIMEOUT_MS`. A relay that is down, that goes
away, or that never completes a reservation is tried again on the node list's retry cadence (`RETRY_BASE_MS` doubling
to `RETRY_CAP_MS`), and the node reserves on it once it answers; meanwhile it serves through whichever relays it holds.

**A public node announces its listen addresses from the start.** libp2p holds back a listen address on a public IP
until a peer confirms it, but an operator who declares a node `public` has said the address is reachable, and a node
that announced nothing could be found by no one. So a `public` node announces every listen address with a concrete
port — the WebRTC-direct ones carrying their certificate hash — and prints its identity only once they are announced.
A `private` node announces its relay reservations alone.

**Every STUN server is a mesh node named by IP** — `stun:<ip>:<port>`; a client refuses an ICE server named by a
hostname. Only the relayed WebRTC path uses STUN; WebRTC-direct to a public address needs none. **A client's STUN list
comes from the public nodes it holds**, never a fixed list: from each node not `blacklisted`, each address's first
`/ip4/<ip>/udp/<port>/webrtc-direct` component on an IP the gater's list does not hold — a relayed address's relay hop
included — as `stun:<ip>:3478`, one per IP; verified nodes (`ok`, `trailing`, `behind`) first, the fastest first; at
most `STUN_SERVERS_MAX`. With no public node held the list is empty, and the ICE configuration names no server.

## Block gossip

**A client is a reader of every node it holds a connection to.** On each connection it opens, before any read, it runs
`net`'s handshake as the dialler (`NET_INTERFACE → Handshake`) with a reader's body: no `declaredAddress`, an empty
`nodeName`, its held chain's tip height (0 before it holds one) and the reader's capabilities, none
(`NET_INTERFACE → Readers`). A node whose handshake fails is `retry`, the handshake named, never a lie; a node whose
handshake declares no chain service is not read. The client subscribes to the ordering-block topic alone and publishes
nothing of its own.

**One router, `net`'s rules.** A node and a client each run gossipsub with `net`'s options (`gossipsubOptions`), a client
on the ordering-block topic alone, with `net`'s envelope, message id and seen window (`NET_INTERFACE → Gossip Topics`):
unsigned, named by `hash32(lpUtf8(topic) ‖ data)`, heard once in `GOSSIP_SEEN_WINDOW_MS`. The code the page runs is
`net/browser`'s, the one copy. A node's router holds its node peers and its readers; a client's, every node it holds a
connection to; nothing dials for gossip's sake.

**A block is checked before it is forwarded, and never applied.** A receiver runs the ordering-block topic's checks of
`NET_INTERFACE → Stage 1`, in their order, through `net`'s `BlockCheck`, and forwards a block that passes them
(`NET_INTERFACE → Forwarding Rule`). The client checks the schedule where its chain holds the parent (→ The client's
node list → "The client's chain"). A client applies no block and forwards no transaction.

**A refused block is evidence as `net` weighs it.** A block over its bound or undecodable, or well-formed and failing
its field domains, the network's floor, its work, its validator signature, its structure or its body's root, is a lie of
the key that sent it: the client blacklists that key, the evidence kept. A version mismatch, a scheduled-target mismatch
and a header the receiver knows record nothing. A node weighs the sender by `net`'s ban policy (`NET_INTERFACE →
Handshake → "Ban policy"`), and each penalty it records reaches its journal as a `peer_penalised` event naming the
sender's peer id.

**A router scores its peers by gossipsub's defaults.** A node's router and a client's keep libp2p
gossipsub's default peer scores, its IP colocation penalty among them: past ten peers a router has seen from one IP
address, each of them scores −5 × (n − 10)², a score a peer keeps for an hour after it leaves. From twelve such peers a
router forwards them nothing, from fourteen it publishes nothing to them, and from fifteen it ignores what they send
(gossipsub's gossip, publish and graylist thresholds: −10, −50, −80). Browsers behind one NAT share an address, and so
does a node on their network: past that count they follow the chain by checks alone.

## Discovery

**Anchors.** A client starts from a list of anchors, each `(notisId, addrs)`: a key it trusts and the addresses that
key was last reached at — IP multiaddrs ending in the key's `/p2p/` peer id, a browser's carrying the WebRTC-direct
certificate's hash. **An address is a hint; the key is the identity.** A client refuses an anchor address with a
`/dns4/`, `/dns6/` or `/dnsaddr/` component. Two anchors with one key are one anchor; the client's own key is none.

**Seeds.** A client may also start from seeds — `(notisId, addrs)` contacts it holds without trusting them, such as a
peer list it was handed or the nodes it knew before. A seed is a candidate like any node the DHT finds: it is not an
anchor, and no answer from it makes `anchorReached` true. The same refusals hold for a seed's addresses as for an
anchor's.

**A node added by hand.** The reader may add a node by its key and an address, a private one included. It is an anchor
unless the reader adds it as an ordinary candidate; its address passes the client's gater for that key alone (→
Transports → "A client dials a private address only when its own configuration names it"). A key that is not 64
lowercase hex, an address with a `/dns4/`, `/dns6/` or `/dnsaddr/` component, or one without `/webrtc-direct/` is
refused. A private node prints its local WebRTC-direct address with its key, for its operator to hand over, and
announces it to no one (→ NAT).

**The DHT is Notis's own.** Kademlia runs on the protocol `/notis/<network>/kad/1.0.0`, `<network>` one of `devnet`,
`testnet`, `mainnet` — never on libp2p's default, which is the public IPFS DHT. Public nodes serve it, each listening
on WebRTC-direct so a browser can walk it; private nodes and browsers run it as clients. It finds further nodes, and a
known key's current addresses.

## The node endpoint

A mesh node answers HTTP over libp2p (`@libp2p/http`) by forwarding each `GET` and `POST` to its own public HTTP API on
loopback — never its admin port — a `POST`'s body and `content-type` as sent, and answering with the upstream's status,
`content-type` and body bytes as they came. Any other method answers `405`. Every cap the node holds a request to over
HTTP holds over the mesh the same, `HTTP_BODY_MAX_BYTES` among them.

The client's side is an `HttpFetch` over the mesh URL: `GET` and `POST`, ending at `REQUEST_TIMEOUT_MS` as every read
does (`CONSTANTS → Client reads`). Every cap a reader holds an answer to over HTTP holds over the mesh the same.

**The client checks what it can with the extension's verifier**: `resolveTip` over the mesh URLs of the nodes a check
reads proofs from (→ The client's node list → "A check"), each proof held to the client's network profile
(`NIPOPOW_INTERFACE → The trust model`). There is no second verifier.

## The client's node list

The client keeps one entry per node key and moves it by what a failure is evidence of — the split
`NET_INTERFACE → Handshake → "Ban policy"` draws between nodes:

| What happened | Evidence of | The entry |
|---|---|---|
| a timeout, a refused connection, a dropped link, another transport failure, a non-2xx answer | nothing | `retry`, at growing intervals, never permanent |
| a proof refused by the client's clock check alone — a header stamped later than the client's own clock allows | the client's clock, which may be behind | `retry`, as above; never a lie |
| the tip it names is the client's tip | being at the tip | `ok` |
| the tip it names is one block below the client's tip | being one block behind | `trailing`, ranked below `ok` |
| the tip it names is further down the client's chain; a valid proof that loses, or a chain too short to prove; a tip answered with no hash | being behind | `behind`, ranked below `trailing` |
| an address answers with a key other than the one dialled | the address | that address dropped for that key when the dial's failure names it; the entry otherwise unchanged |
| a malformed answer, a proof that fails verification, or a gossiped block refused as a lie (→ Block gossip), over a link authenticated to the key | a lie | `blacklisted` for good, the evidence kept |

**The client's chain.** The client holds its chain's last `k` headers and block 1's. A check's proofs settle it — the
winner's suffix and its first header — and a switch to another winner replaces it the same way; a winner whose tip the
client's chain already holds is no switch, and the chain stands. A gossiped block whose parent is the client's tip
extends it; one whose parent is held below the tip, or not held at all, runs a check at once. A fill — a check's reading
of a tip above the client's — reads that node's headers by height, `GET /blocks/:height`, from its tip down to the
client's, each held to its work, its schedule and its link, and no more than `k` of them; a fill that fails, or would
pass `k`, leaves that tip to a proof. **The tip moves only by a header carrying its work on the client's chain**, never
by a node's word. Before the first check settles a chain, a block adds nothing to it.

**A valid proof of a lighter chain is not a lie**: an honest node that was itself cut off serves one. **Nor is a header
stamped ahead of the client's clock**: the verifier holds a header to the client's own time, and a client whose clock
runs behind would otherwise blacklist every honest node for good.

**A node's addresses are dialled as one operation.** libp2p joins every dial to a peer into the one already in flight, so
the client hands it all of a node's addresses at once, under one deadline. When another address connects first, an
address that answered with another key is not reported and stays listed; its next dial is refused again, at no cost to
the key. When every address fails, each address libp2p reports it dialled has its failure recorded against it, matched
in the order libp2p dialled them; an address no browser transport carries is passed over by libp2p and takes none. When
the addresses libp2p reports do not account for every failure — a dial joined to one already in flight hears only what
is dialled after it joins — the failure is recorded against the node alone.

**The secure WebSocket is the fallback.** The client gives libp2p its own order for a node's addresses: WebRTC-direct,
then WebRTC signalled over a relay, then the secure WebSocket, then any other address, a plain circuit among them — the
one transport that leans on a certificate authority (→ The IP certificate) is dialled only after every WebRTC path has
failed. Addresses of one transport keep libp2p's order among them.

**A read opens no connection.** Every read the client makes over a mesh URL — a check's tips, headers and proofs, a
fill's headers, each routed read, each `fetch` the page makes — opens its stream on a connection the client already
holds to that key: an open one, a direct one first, a relayed one when that is all there is, never a limited one (→
NAT). With none, the read fails as a transport failure, and a failed routed read runs a check at once, which dials from
the list. So the client dials only what the list holds for a key — in its order, without the addresses it dropped —
never an address libp2p keeps for the key from elsewhere.

**Two clocks.** The verifier reads the wall clock — a header's stamp is wall-clock time. The list's retry timers read a
monotonic clock, so a clock that steps never holds a node out or retries it at once. Neither stands in for the other.

**An entry keeps its last failure's kind and message**, for the page to show why a node is in `retry`; the message is
shown, never acted on.

**Retry.** After the `n`th failure in a row, a node is next tried `min(RETRY_CAP_MS, RETRY_BASE_MS · 2^(n−1))` later,
on a monotonic clock. A success ends the run.

**Candidates** are tried in this order: `ok`, `trailing`, `behind`, nodes not yet tried, then `retry` nodes whose time
has come. A `blacklisted` node is never one.

**A check** runs at start, every `CHECK_INTERVAL_MS`, and at once after a failed routed read or a gossiped block that
does not extend the client's tip (→ "The client's chain"). It dials the candidates it holds no connection to; reads
every candidate's tip, `GET /blocks/current`, timed from the request to the end of the body — that time is the node's
speed until the next check; and places each tip on the client's chain by hash: the tip, one below, further down, or
above — filled (→ "The client's chain"), the client's tip moving when the fill links — or, below the held headers, held
to the client's own header at that height, read from a node at its tip. **It reads proofs only for what that cannot
place**: at the first check every tip, and after it a tip no rule places — one proof per distinct tip, from the node the
list ranks first among those naming it, the next asked in the same check when that proof is refused; and, while the
client holds a chain, its own tip's proof from a node at its tip, handed to `resolveTip` first so a tie keeps the chain,
as does a proof that shares no block with it — `incomparable`, which only a network pinning no `genesisId` reaches
(`NIPOPOW_INTERFACE → compareProofs`). Every node naming a tip takes that tip's verdict. **A tip whose proof verified and lost keeps its verdict** while the
client's chain stands: a node naming it again is placed off the chain with no proof read, until it names another tip or
the chain switches. A check that places every tip reads no proof.

**A routed read goes to a node its need allows.** A routed read is one the client sends to a node it picks, not to a key
the caller names. One that needs the tip goes to an `ok` node; a read of content older than the newest block goes to an
`ok` or a `trailing` node; a `behind` node serves no read. Freshness is the last check's: between checks the client
knows nothing finer. Among the nodes a read may go to and the client holds a connection to, the fast set is each node
whose speed is within `FAST_SET_FACTOR` times the fastest's plus `FAST_SET_SLACK_MS` — every one of them while none has
a speed — and the read goes to one of the fast set at random. With none, it fails as a transport failure. The client's
state names the node and path the latest routed read went to; how many checks it has completed, so a reader can tell
one check's state from the next; and, after a check, a node that was `ok` or `trailing` before it and is neither after
it, with its latest event.

| Name | Value | Reads as |
|---|---|---|
| `RETRY_BASE_MS` | `5_000` | 5 s, the first retry's wait |
| `RETRY_CAP_MS` | `600_000` | 10 min, the longest wait |
| `CHECK_INTERVAL_MS` | `30_000` | 30 s between checks |
| `DIAL_TIMEOUT_MS` | `3_000` | 3 s per address in one node's dial; the dial's deadline is this times its addresses, or `PEER_DIAL_MIN_MS`, whichever is longer |
| `PEER_DIAL_MIN_MS` | `20_000` | 20 s, the shortest deadline one node's dial gets — libp2p gives each address 6 s of its own, and a relayed address dials the relay first |
| `RELAY_LISTEN_TIMEOUT_MS` | `10_000` | 10 s for one attempt at a relay reservation; past it the attempt is a failure and the relay is tried again on the retry cadence |
| `CERT_RETRY_MS` | `3_600_000` | 1 h between attempts at a failed renewal |
| `STUN_PORT` | `3478` | the STUN port of RFC 8489 |
| `FAST_SET_FACTOR` | `2` | a node is in the fast set within twice the fastest's speed … |
| `FAST_SET_SLACK_MS` | `50` | … plus 50 ms |
| `STUN_SERVERS_MAX` | `3` | the most STUN servers a client's ICE configuration names |
| `BLOCK_READ_BYTES` | `8_388_608` | 8 MiB, the cap on a fill's `GET /blocks/:height` — the header and two 67-byte list entries, a transaction's id and a post's, for every 32 bytes of a body at `MAX_BLOCK_BODY_BYTES` (`TYPES_INTERFACE → Size caps`) stay within it; a block's whole JSON is read for its header, so a fill of full blocks costs more than a proof — `net`'s header sync carries headers alone |

These are a proof of concept's local cadences, chosen 2026-10-29 and argued by nothing yet; local cadences are outside
the constants register (`CONSTANTS → Scope`).

## No anchor reached

`anchorReached` is true while at least one anchor's latest event leaves it `ok`, `trailing` or `behind` — a tip placed
on the client's chain, or a valid proof that is behind — and false otherwise: at start, and whenever every anchor's
latest event is a failure or a lie. An anchor that is behind was still reached. While it is false the client treats
every node it reaches as unverified, and the page says, in these words: `No anchor reached. Nothing shown here is
verified.`

**The agreement counts.** After each check the page shows how many nodes name a tip on the client's chain within its
last `k` headers — `On this chain` — how many of those are anchors, and how many name one off those headers — `Not on
this chain's last 20 blocks`: on another chain, or further back than they reach, which the client cannot tell apart. The
counts say what the nodes name, never that each verified: a node counts without serving a proof of its own, since a
proof carries no challenge and any node can serve one it copied. A node that answered no tip is in no count.

## The IP certificate

**A public node's operator may opt in to the secure WebSocket fallback.** The node then obtains a certificate for its
own bare IP over ACME — the `http-01` challenge on port 80 of that IP, answered by the node itself or, where the
operator's own server holds port 80, on `MESH_ACME_CHALLENGE_PORT` behind it — with no step by the operator after opting in,
and renews it at half its lifetime, `notBefore + (notAfter − notBefore) / 2`. A failed renewal is retried every
`CERT_RETRY_MS` while the current certificate serves. At `notAfter` the WebSocket listener stops, and every other
transport carries on. A renewed certificate replaces the old one without a restart, and open connections stay up.

**The certificate is the browser's admission ticket alone.** The link inside it is authenticated by the node's key
like every other (→ Transports). Let's Encrypt has issued IP certificates since 2026-01-15, valid 160 hours; a node
behind NAT cannot hold one.

## Acceptance

A stage on one machine runs the proof of concept end to end: public nodes, a node behind an endpoint-independent NAT and
one behind a symmetric NAT, a browser behind NAT, a node on the browser's own network, an ACME test server, and hostile
nodes — each host one devnet `@dagsocial/node` run with a mesh role, a hostile host's lie outside the node it runs.
The mesh holds when every step of the eight scenarios passes on what it measured; a step that did not run reads
`skipped`, never a pass.

1. **No name, no hosted page.** The client reads a node's API by key from anchors alone, over WebRTC-direct, with the
   browser's own resolver set to resolve no name at all; the mesh's answers equal the node's direct HTTP answers byte
   for byte; the browser host's DNS log holds no query — anything there went around the browser's resolver; and every
   ICE server the page's peer connections are built with is named by IP. The browser's own services resolve names
   whatever page is open, so a resolver that answers nothing is what separates them from the client; and a name the
   browser's resolver answers never reaches the log, so the page's own ICE configuration is read where it is made.
2. **Behind NAT.** The browser reaches the node behind the endpoint-independent NAT over WebRTC signalled through a
   relay, its data direct, its ICE servers drawn from the public nodes it holds. It reaches the node behind the
   symmetric NAT through a relay, its data relayed: that node reads `ok` or `trailing`, never `retry` for want of a
   direct path, never `blacklisted`.
3. **A node goes away.** Killed, then firewalled: the client's reads move to other nodes within two checks, the node
   reads `retry`, never `blacklisted`; once it is back and within a block of the tip, the next check reads it by its
   tip — `ok` at the tip, `trailing` one block short.
4. **A transport is cut.** UDP to one public node: the client stays connected, through another node or over that
   node's secure WebSocket — whichever ranks first. UDP to all: the client gets in through the secure WebSocket; a
   renewal replaces the certificate with no request dropped.
5. **Impersonation.** A node with its own key and a copy of an anchor's certificate, at the anchor's address: refused
   at the link, that address dropped, the anchor not blacklisted.
6. **Hostile nodes.** With every anchor out of reach, `anchorReached` is false and the page says so. A node naming a tip
   of its own that answers malformed proofs, and one that answers failing proofs, are blacklisted with their evidence; a
   node naming the chain's tip is placed there and its proof is never read; a node on a lighter chain is `behind`. A
   mesh node publishing a block that fails its checks is blacklisted with its evidence, and the client does not forward
   it.
7. **Reach and load.** Reads that may go to several nodes spread across them; a read that needs the tip goes to an
   `ok` node alone; a node slowed well past the others serves no read. A node on the browser's own network, named only
   by a seed, is never dialled; added by hand, it is reached at its private address, and `anchorReached` reads true from
   it alone when the reader trusts it and false when the reader does not. The page shows the agreement counts.
8. **Prove once, follow by gossip.** After the first check, no proof is read across five checks while every node names a
   tip on the client's chain; a block mined on a node reaches the browser by gossip and moves the
   client's tip before its next check; a node on another chain — on the stage, a chain mined from its own genesis — has
   its proof read when its tip moves, with the client's own, and the client's tip stays the honest chain's; the
   browser's gossip cut for three blocks and restored, its tip catches up by headers with no proof read.

**Browsers.** Chromium and Firefox on default settings; Safari cannot run on the stage's machine and is recorded as
untested. The mesh holds only where WebRTC-direct connects on defaults in both.
