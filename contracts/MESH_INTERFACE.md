# MESH Interface Contract

## Scope

The mesh is how a browser reaches a Notis node's HTTP API by the node's key over libp2p, with no DNS name and no hosted
page. **A Notis node run with a mesh role is a mesh node** — one process under its node key (`NET_INTERFACE → The node
key`), `@dagsocial/net` carrying the transports, the roles, the DHT and the endpoint (→ Place in the workspace).
**It changes no consensus, wire or HTTP API rule.** Every answer a client checks is checked by the code the extension
runs. The client is a reader in the nodes' own block gossip, under `net`'s rules (→ Block gossip). **The client is
`@dagsocial/web`'s** — its reasoning about nodes is the extension's first path (`WEB_INTERFACE → The extension → "The
mesh is the extension's first path"`) — and `@dagsocial/mesh-poc` holds the page, the stage and the client's cases on
Node.js (→ Place in the workspace); what the stage has to show is → Acceptance.

It carries Notis's own traffic and nothing else: no exit to the wider network, no IP tunnel.

## Place in the workspace

**The node half is `@dagsocial/net`'s**, under `NetConfig.mesh` (`NET_INTERFACE → The mesh`), configured by the node's
`MESH_*` settings (`NODE_INTERFACE → Configuration`). **The browser half is `@dagsocial/net/browser`**: the reader's
handshake, the gossip rules, the block check, the reader's libp2p options and the mesh fetch, importing no Node
built-in and reading no Node global. **The client is `@dagsocial/web`'s `src/mesh/`**, exported as
`@dagsocial/web/mesh`: the node list, the client's chain, the server pick, the STUN list, the check and the client over
them, which run in the browser as written, held to it by the member's browser typecheck. `tools/mesh-poc` is a member
under `tools/`: it depends on `@dagsocial/web` and on the members its stage and cases reach, and holds the page, the
stage and the client's cases that start a WebRTC transport — node-datachannel's binding takes one live
`RTCPeerConnection` per process, so each such file runs in a process of its own. No WASM. One native module, `node-datachannel` under
`@libp2p/webrtc`, serves WebRTC on Node.js: the WebRTC-direct listener and dials, and a private node's WebRTC.

**libp2p is pinned.** `libp2p` and every `@libp2p/*` dependency of `net`, of `@dagsocial/web` and of `tools/mesh-poc`
are at an exact version, one version per package across the three.
They reach places libp2p does not promise to keep — its `components` object, for a listener added after start (the
secure WebSocket, a private node's relay listens) and for the listener addresses a private node prints; the dial
queue's `dial-queue:calculated-addresses` progress event and its `AggregateError` order, for per-address attribution
— and each is held by a case against the real libp2p, so an upgrade that moves one fails its case. **Four pinned
packages carry local patches** (pnpm's `patchedDependencies`, the diffs under `patches/`), each held by a case against
the patched package: `@libp2p/webrtc`, whose certificate renewal timer re-arms past Node's timer limit (→ Transports →
"The WebRTC-direct certificate persists"); `@libp2p/http-utils`, whose `readHeaders` hands a request's body back to its
stream and whose Node-side server adapter is kept out of the browser's import path; `@libp2p/http-fetch`, whose
request line carries the URL's query, whose string and bytes bodies keep the `content-type` the caller set, and whose
string body is counted in UTF-8 bytes for its `content-length` — so a mesh read keeps its query and a mesh write its
JSON body, as over HTTP (→ The node endpoint); and `@libp2p/gossipsub`, whose router moves its stream to a peer onto
the newer connection the peer's own stream arrives on, and keeps a peer whose replaced stream fails (→ Block gossip →
"A peer's gossip follows its newest connection"). A pin that moves carries its patch to the new version, the cases
deciding that it still applies and still holds.

## Identity

**One key, two spellings.** A mesh node's identity is an Ed25519 key in the form a Notis identity takes
(`TYPES_INTERFACE → Identity`):

- **the Notis spelling** — the 32-byte public key as 64 lowercase hex characters, the `UserId` spelling of the HTTP
  API. The client shows it and a node list names it.
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
`notAfter` less libp2p's renewal threshold. Its hash is part of the address a node list carries, so a certificate that
changed — at a restart or at a renewal — would leave every list naming the node unreachable. **A state directory
whose certificate cannot be read stops the node at start**, naming the directory, and is left as it is, as a key file
of another form is.

**A client dials a private address only when its own configuration names it.** libp2p's default connection gater in a
browser refuses every address in a private or reserved range (`10.0.0.0/8`, `100.64.0.0/10`, `192.168.0.0/16`, the
documentation ranges and the rest of its list). The client runs its own gater, the same in every runtime: it refuses
every private address but those its own configuration names for a key — a first-contact node's, or your node's
(→ Discovery → "A node added by hand") — each for that key alone. A remote node cannot know what is on the reader's
network, so a private address it offers — through the DHT, a peer list or a known node's addresses — is never dialled, and a page cannot
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
`nodeName`, its held chain's tip height (0 before it holds one) and the reader's capabilities — none, or
`ModifierRequest` alone while the reader serves posts' text (→ "A client that serves answers the nodes it reads";
`NET_INTERFACE → Readers`). A node whose handshake fails is `retry`, the handshake named, never a lie; a node whose
handshake declares no chain service is not read. The client subscribes to the ordering-block topic alone and publishes
nothing of its own.

**A client that serves answers the nodes it reads.** A client its reader has set to serve declares `ModifierRequest` and
answers it from the posts it holds, on the connections it holds to nodes, by `net`'s rule (`NET_INTERFACE → Readers →
"A serving reader answers from what it holds"`) — the extension from its post cache (`WEB_INTERFACE → The settings
window → "The serve row"`). A node it reads may then learn which of the ids it asks this client holds, with the
connection's address; the client announces nothing it holds, and only a node it dialled can ask. A change of the setting
waits for a check in flight to end, then closes every connection the client holds and dials again at once, so each new
handshake declares the new set; the client's chain and its node list are kept, as across any lost connection, and the
last change made is the one that stands. A client handed no way to serve never declares `ModifierRequest`.

**One router, `net`'s rules.** A node and a client each run gossipsub with `net`'s options (`gossipsubOptions`), a client
on the ordering-block topic alone, with `net`'s envelope, message id and seen window (`NET_INTERFACE → Gossip Topics`):
unsigned, named by `hash32(lpUtf8(topic) ‖ data)`, heard once in `GOSSIP_SEEN_WINDOW_MS`. The code the extension's page
and the stage's page run is `net/browser`'s, the one copy. A node's router holds its node peers and its readers; a client's, every node it holds a
connection to; nothing dials for gossip's sake.

**A block is checked before it is forwarded, and never applied.** A receiver runs the ordering-block topic's checks of
`NET_INTERFACE → Stage 1`, in their order, through `net`'s `BlockCheck`, and forwards a block that passes them
(`NET_INTERFACE → Forwarding Rule`). The client checks the schedule where its chain holds the parent (→ The client's
node list → "The client's chain"). A client applies no block and forwards no transaction. A receiver decodes a block
once: what its delivery reads is the block the check's verdict carries (`NET_INTERFACE → Inbound Processing → "A
gossiped message is decoded once"`).

> ⚠ **AHEAD OF CODE (2026-11-14).** The client's `gossipsub:message` listener decodes each accepted block a second
> time, whole, for its header, and discards a failure of that decode unlogged.

**A refused block is evidence as `net` weighs it.** A block over its bound or undecodable, or well-formed and failing
its field domains, the network's floor, its work, its validator signature, its structure or its body's root, is a lie of
the key that sent it: the client blacklists that key, the evidence kept. A version mismatch, a scheduled-target mismatch
and a header the receiver knows record nothing. A node weighs the sender by `net`'s ban policy (`NET_INTERFACE →
Handshake → "Ban policy"`), and each penalty it records reaches its journal as a `peer_penalised` event naming the
sender's peer id.

**A router scores its peers by gossipsub's defaults, and a shared address costs a peer nothing.** A node's router and a
client's keep libp2p gossipsub's default peer scores and thresholds but one: the IP colocation factor weighs 0
(`GOSSIP_IP_COLOCATION_WEIGHT`, `CONSTANTS → net`), so the count of peers a router has seen from one IP address moves
no peer's score. Gossipsub's default weight, −5, scores each peer past ten from one address −5 × (n − 10)² and keeps
that score an hour after the peer leaves; from the twelfth such peer, below the gossip threshold (−10), a router
forwards them nothing. Each page load is a libp2p key of its own and readers behind one NAT share an address, so at the
default a reader reloading a dozen times an hour, or the twelfth reader behind one NAT, would follow the chain by checks
alone. An address count guards nothing the rules leave open: every block meets the ordering-block topic's checks before
it is forwarded, whatever its sender's score (→ "A block is checked before it is forwarded, and never applied"); a node
chooses its chain by work, from what its sync asks of its peers as well as from what gossip brings (`NET_INTERFACE →
Sync State Machine`); and a client's tip is its own check's (→ The client's node list).

**A peer's gossip follows its newest connection.** A peer can hold two connections to a router at once: a reader
redials when its connection falls silent, and a router that has heard no close still holds the silent one. A router
reads a peer's newest gossip stream and closes the one before; when that stream arrives on a connection that opened
later than the one the router's own stream to the peer runs on, the router opens its stream on the newer connection and
closes the old one. It never moves its stream to an older connection or to the same one, so two routers holding two
connections between them settle, and a new connection alone moves nothing — the peer's stream on it does. A failure on
a stream the router has replaced closes that stream alone: the peer stays the router's peer while a connection to it
stands. So a reader whose connection was cut and restored is forwarded blocks on the connection it holds. Unpatched,
gossipsub 17.2.1 keeps its stream on the first connection and takes a replaced stream's failure for the peer leaving —
a WebRTC stream's close over a silent connection fails at its 10 s FIN_ACK wait — so that reader would follow the
chain by checks alone until it held no connection to the router (→ Place in the workspace → "libp2p is pinned").

## Discovery

**First contact.** A client starts from a list of first-contact nodes, each `(notisId, addrs)`: a key and the addresses
that key was last reached at — IP multiaddrs ending in the key's `/p2p/` peer id, a browser's carrying the WebRTC-direct
certificate's hash — and, where the list gives one, the API base the node answers at over HTTPS, `(notisId, addrs,
api)` (→ The client's node list → "An entry may carry an API base"). The extension's are its build's seed list
(`WEB_INTERFACE → The extension → "The seed list, the faucet's base and the network's name"`). For a client that has
never connected, the list is the way in and the distribution channel its one trust point; **after the first check a
first-contact node is a node like any other** — no count, row, weight or word names it. **An address is a hint;
the key is the identity.** A client refuses a first-contact address with a
`/dns4/`, `/dns6/` or `/dnsaddr/` component. Two entries with one key are one entry; the client's own key is none.

**Known nodes.** A client also starts from known nodes — `(notisId, addrs)` contacts it holds without trusting them: the
nodes it remembers (→ What the client remembers), or a peer list it was handed. A known node is a candidate like any
node the DHT finds. The same refusals hold for a known node's addresses as for a first-contact node's.

**A node added by hand.** The reader may add a node by its key and an address, a private one included: **your node**,
the reader's trust assertion, unless the reader adds it as an ordinary candidate. Its address passes the client's gater
for that key alone (→ Transports → "A client dials a private address only when its own configuration names it"). A key
that is not 64 lowercase hex, an address with a `/dns4/`, `/dns6/` or `/dnsaddr/` component, or one without
`/webrtc-direct/` is refused. A private node prints its local WebRTC-direct address with its key, for its operator to
hand over, and announces it to no one (→ NAT). The extension's settings window takes the address alone, the key read
from its `/p2p/` id (`WEB_INTERFACE → The settings window`).

**Your node takes precedence** while it agrees with the evidence: once its proof has verified, its chain is the
client's chain, and a routed read goes to it first among the nodes the read's need allows. **It
disagrees** when another node's tip lies off its chain and that node's proof beats its own and continues the kept proof,
or when its own proof does not continue the kept proof (→ What the client remembers); a node behind on the same chain
does not. **A disagreement is the reader's question, never the client's choice.** Until the reader answers, the client's
chain does not move — no switch, no extension by gossip, and where no chain is seated yet none is seated — and its state
names what disagreed, the two tips and their fork, the highest header `compareProofs` finds in both. The answers: *continue on this node* — the client takes its
chain, the kept proof becomes its proof, and the competing chain's proof is recorded as answered — the other node's
for *heavier*, the kept proof your node did not continue for *memory* — at most `ANSWERED_FORKS_MAX`, the oldest
dropped; *disable it* — the reader switches it off until switching it on, and the client takes the best chain by the
rules every other node is held to. **An answered branch growing asks nothing more**: a competing proof is that branch
when the highest header `compareProofs` finds in it and an answered proof is that answered proof's tip, or when it is
that proof — and the answered proof is then replaced by it, so the record follows the branch as it grows. A competing
chain that does not reach an answered proof's tip that way is a new disagreement, and asks again. While a question
stands, a gossiped block runs no check: the chain is held, and the checks on the client's cadence read the question
again.

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

**The client checks what it can with the extension's verifier**: `resolveTip` over the mesh URLs — or the API bases —
of the nodes a check reads proofs from (→ The client's node list → "A check"), each proof held to the client's network profile
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
| the same at an entry's API base | the host, not the key — HTTPS authenticates a name, never a node key | `retry`, as a transport failure; never `blacklisted` |

**An entry may carry an API base.** A first-contact entry the list gives one is read there, over HTTPS, wherever the
client holds no connection to its key — always, for one the list gives no address: a check's tip, header and proof reads, and a routed read no node serves over the mesh (→ "A
routed read goes to a node its need allows"). It is one entry whichever way it answers — one witness in every count —
and the pairing of a base with a key is the list's word. A read at an API base holds no connection and dials nothing.

**The client's chain.** The client holds its chain's last `k` headers and block 1's — from the start when it remembers a
chain, seated from the kept proof as a check's winner seats one (→ What the client remembers). A check's proofs settle it — the
winner's suffix and its first header — and a switch to another winner replaces it the same way; a winner whose tip the
client's chain already holds is no switch, and the chain stands. A gossiped block whose parent is the client's tip
extends it; one whose parent is held below the tip, or not held at all, runs a check at once — unless a question stands
(→ Discovery → "An answered branch growing asks nothing more"). A fill — a check's reading
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
has come. A `blacklisted` node is never one. An entry the client holds no connection to is a candidate at its API base
where it has one.

**A check** runs at start, every `CHECK_INTERVAL_MS`, and at once after a failed routed read or a gossiped block that
does not extend the client's tip (→ "The client's chain"). It dials the candidates it holds no connection to; reads
every candidate's tip — at its API base where its dial failed and it has one — `GET /blocks/current`, timed from the request to the end of the body — that time is the node's
speed until the next check; and places each tip on the client's chain by hash: the tip, one below, further down, or
above — filled (→ "The client's chain"), the client's tip moving when the fill links — or, below the held headers, held
to the client's own header at that height, read from a node at its tip. **It reads proofs only for what that cannot
place**: at the first check every tip, and after it a tip no rule places — one proof per distinct tip, from the node the
list ranks first among those naming it, the next asked in the same check when that proof is refused; and, while the
client holds a chain, its own tip's proof from a node at its tip, handed to `resolveTip` first so a tie keeps the chain,
as does a proof that shares no block with it — `incomparable`, which only a network pinning no `genesisId` reaches
(`NIPOPOW_INTERFACE → compareProofs`). Every node naming a tip takes that tip's verdict. **A tip whose proof verified and lost keeps its verdict** while the
client's chain stands: a node naming it again is placed off the chain with no proof read, until it names another tip or
the chain switches. A check that places every tip reads no proof. **The kept proof is a contestant in every check that
reads proofs**: a node's verified proof that does not continue it is placed off the chain and keeps that verdict, and the
chain settles to the best of the rest (→ What the client remembers).

**A tip the check has outrun is read again.** A node answers a proof read, and a fill's header reads, from its chain as
it stands at that read, which may run past the tip it named earlier in the same check. So where a check moves the
client's tip — a proof settling the chain, or a fill linking — each node whose tip read then places below the client's
tip is read again, `GET /blocks/current`, once in that check, after its proofs and fills, and that answer places it as
any tip read is placed: at the tip, one below, further down, or above and filled. The first read's time stays the
node's speed. A re-read that fails is a failure as any read's is. A re-read that names a tip no placement holds is left
to the next check, the node keeping its first read's placement. A check that does not move the tip reads no tip twice.

**A node is judged against the chain the check leaves.** Its event, its distance below the tip and its count in the
agreement are read against the client's chain as the check ends — its tip placed on that chain by hash, at the height
the chain holds that hash whatever height the read names, or, where its
verified proof's tip lies off it, `behind` and off the chain — never against the winner of a contest the client did not
take: a fork the reader answered, a question standing, the kept proof's settle (→ What the client remembers). A tip
whose verified proof lost is kept as lost only when it lies off that chain. A lie and a failure land as they were read:
the entry's status is theirs — `blacklisted` or `retry` — while its count in the agreement and its distance follow its
tip read's placement as any node's do, since the counts say what the nodes name (→ What the client remembers → "The
agreement counts").

**A routed read goes to a node its need allows.** A routed read is one the client sends to a node it picks, not to a key
the caller names. One that needs the tip goes to an `ok` node; a read of content older than the newest block goes to an
`ok` or a `trailing` node; a `behind` node serves no read. Freshness is the last check's: between checks the client
knows nothing finer. Among the nodes a read may go to and the client holds a connection to, the fast set is each node
whose speed is within `FAST_SET_FACTOR` times the fastest's plus `FAST_SET_SLACK_MS` — every one of them while none has
a speed — and the read goes to one of the fast set at random; your node, while it takes precedence, before the fast set
(→ Discovery → "A node added by hand"). **Over the mesh first**: a read goes to an API base only
when no node its need allows is reached over the mesh, and among the API bases by the same need and speed. **Before the
first check ends a node the client started from serves any need** — first contact, its known nodes and your node —
over its connection or at its API base, since a verdict never blocks a
read. With none, it fails as a transport failure. The client's
state names the node and path the latest routed read went to; how many checks it has completed, so a reader can tell
one check's state from the next; and, after a check, a node that was `ok` or `trailing` before it and is neither after
it, with its latest event.

**The client's order for a need** is every node the need allows reached over the mesh, the fast set first, then the API
bases of the entries it allows, in the same order — before the first check ends, every node the client started from,
your node first. **A write goes to one
node at a time**: a `POST` the caller hands the client goes to the first node of the order for the tip and, when it ends
with no answer — a transport failure or `REQUEST_TIMEOUT_MS` — the same bytes go to the next; the first answer of any
status is the write's (`WEB_INTERFACE → The extension → "The mesh is the extension's first path"`).

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
| `REMEMBERED_NODES_MAX` | `16` | the most known nodes a client remembers — provisional: about 10 KB of memory, and the start-up dial set a check opens |
| `ANSWERED_FORKS_MAX` | `16` | the most answered branches a client remembers, each by its competing proof |
| `BLOCK_READ_BYTES` | `8_388_608` | 8 MiB, the cap on a fill's `GET /blocks/:height` — the header and two 67-byte list entries, a transaction's id and a post's, for every 32 bytes of a body at `MAX_BLOCK_BODY_BYTES` (`TYPES_INTERFACE → Size caps`) stay within it; a block's whole JSON is read for its header, so a fill of full blocks costs more than a proof — `net`'s header sync carries headers alone |

These are local cadences, chosen 2026-10-29 and argued by nothing yet; local cadences are outside
the constants register (`CONSTANTS → Scope`).

## What the client remembers

**A client remembers, per network, the nodes it found, the proof of the chain it verified, and the branches the reader
answered** (→ Discovery → "A node added by hand") — keyed by the genesis the network's profile pins, or by the network's
name where it pins none. After each check it records every node naming a tip on its chain, `ok` or `trailing`, with
the addresses it would dial — no private address, never its own key — the most recently seen first, at most
`REMEMBERED_NODES_MAX`; a node blacklisted in the session leaves the list. At its next start they are its known nodes
(→ Discovery → "Known nodes").

**The kept proof** is the last proof the client verified of the chain it holds — a check's winner, a switch, its own
tip's proof. **It moves forward only**: a proof is kept only where it does not lose to the one kept, under
`compareProofs` at the client's own `m` and `k` (`NIPOPOW_INTERFACE → compareProofs`); the reader's *continue* is the one
exception. At start the kept proof is verified again, and one that no longer verifies is dropped. **A node's chain
continues the kept one** when `compareProofs(kept, node's)` does not answer the kept proof — the node's wins, or they
tie: work, not height, so a heavier fork from below the kept tip is a deep reorg, and proof of work takes it. **When
every verified proof shares no block with the kept one** — which only a network pinning no `genesisId` reaches — the
kept proof is dropped and the client starts as a first-time client. **When no node continues it** — no node names a tip
on the client's chain and one or more name one off it — the client keeps its own chain and says so: the stage's page in
these words, `No node reached continues the chain you verified.`, and the extension's verdict `thin` · *not-continued*
(`WEB_INTERFACE → The extension → "The verified tip"`).

**What memory cannot stop**: an adversary holding every node a client reaches can extend the kept tip at its own
hashrate; a client with no memory takes the best chain among what first contact reaches (`NIPOPOW_INTERFACE → The
trust model`).

**The agreement counts.** After each check the stage's page shows, and the extension's verdict reads, how many nodes name a tip on the client's chain within its
last `k` headers — `On this chain` — and how many name one off those headers — `Not on
this chain's last 20 blocks`: on another chain, or further back than they reach, which the client cannot tell apart. The
counts say what the nodes name, never that each verified: a node counts without serving a proof of its own, since a
proof carries no challenge and any node can serve one it copied. A node that answered no tip is in no count. **Memory is
no witness**: the kept proof names an old tip, and is in no count.

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

A stage on one machine runs the mesh end to end, its page on the client `@dagsocial/web` holds: public nodes, a node behind an endpoint-independent NAT and
one behind a symmetric NAT, a browser behind NAT, a node on the browser's own network, an ACME test server, and hostile
nodes — each host one devnet `@dagsocial/node` run with a mesh role, a hostile host's lie outside the node it runs.
The mesh holds when every step of the eight scenarios passes on what it measured; a step that did not run reads
`skipped`, never a pass.

1. **No name, no hosted page.** The client reads a node's API by key from its first-contact nodes alone, over WebRTC-direct, with the
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
   tip — `ok` at the tip, `trailing` one block short. With every first-contact node out of reach, a page that has
   connected before reaches the network through the nodes it remembers and reads its chain from them.
4. **A transport is cut.** UDP to one public node: the client stays connected, through another node or over that
   node's secure WebSocket — whichever ranks first. UDP to all: the client gets in through the secure WebSocket; a
   renewal replaces the certificate with no request dropped.
5. **Impersonation.** A node with its own key and a copy of a first-contact node's certificate, at that node's address:
   refused at the link, that address dropped, the node not blacklisted.
6. **Hostile nodes.** A page with an honest kept chain whose reachable nodes all serve the hostile chain keeps its own and says
   no node continues it. A node naming a tip
   of its own that answers malformed proofs, and one that answers failing proofs, are blacklisted with their evidence; a
   node naming the chain's tip is placed there and its proof is never read; a node on a lighter chain is `behind`. A
   mesh node publishing a block that fails its checks is blacklisted with its evidence, and the client does not forward
   it.
7. **Reach and load.** Reads that may go to several nodes spread across them; a read that needs the tip goes to an
   `ok` node alone; a node slowed well past the others serves no read. A node on the browser's own network, named only
   by a seed, is never dialled; added by hand, it is reached at its private address and takes precedence; a hostile node serving a heavier chain
   that continues the page's memory raises the question, and each answer does what it says. The page shows the agreement counts.
8. **Prove once, follow by gossip.** After the first check, no proof is read across five checks while every node names a
   tip on the client's chain; a block mined on a node reaches the browser by gossip and moves the
   client's tip before its next check; a node on another chain — on the stage, a chain mined from its own genesis — has
   its proof read when its tip moves, with the client's own, and the client's tip stays the honest chain's; the
   browser cut off from every mesh node for three blocks and let back on new connections alone — every flow it held at
   the cut stays dropped both ways, as for a reader whose network changed, which the nodes never hear close — its tip
   catches up by headers with no proof read, and gossip extends it after: a block whose parent is the client's tip
   reaches it by gossip with no check between (→ Block gossip → "A peer's gossip follows its newest connection").

**Browsers.** Chromium and Firefox on default settings; Safari cannot run on the stage's machine and is recorded as
untested. The mesh holds only where WebRTC-direct connects on defaults in both.
