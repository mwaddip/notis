# MESH Interface Contract

## Scope

`@dagsocial/mesh-poc` is a proof of concept beside the protocol: a browser page reaches a Notis node's HTTP API by the
node's key over libp2p, with no DNS name and no hosted page. **It changes no consensus, wire, gossip or HTTP API
rule.** Every node it reaches is an unmodified `@dagsocial/node`, and every answer it checks is checked by code the
extension already runs. What it has to show is → Acceptance.

It carries Notis's own traffic and nothing else: no exit to the wider network, no IP tunnel.

## Place in the workspace

A member under `tools/`. It depends on `@dagsocial/types`, `@dagsocial/node-reads`, `@dagsocial/nipopow-client` and
libp2p 3.x, the line `@dagsocial/net` runs. `src/lib.ts` and everything it reaches runs in the browser as written;
`src/node/` runs on Node.js. No WASM. One native module, `node-datachannel` under `@libp2p/webrtc`, serves WebRTC on
Node.js: the WebRTC-direct listener and dials, and a private node's WebRTC.

## Identity

**One key, two spellings.** A mesh node's identity is an Ed25519 key in the form a Notis identity takes
(`TYPES_INTERFACE → Identity`):

- **the Notis spelling** — the 32-byte public key as 64 lowercase hex characters, the `UserId` spelling of the HTTP
  API. The client shows it and an anchor lists it.
- **the peer id** — libp2p's identity multihash over its protobuf key encoding: `00 24 08 01 12 20` followed by the 32
  bytes.

Each converts to the other. A peer id of any other key type, and any spelling but 64 lowercase hex, is refused.

**The key persists.** A node's key file holds `KeyPair.secretKey`, the seed's PKCS8 DER, 48 bytes. It is created on
first start with mode `0600` and never overwritten; a file of any other length is refused, never replaced. A node
that restarts keeps its peer id.

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

**The WebRTC-direct certificate persists** in the node's state directory. Its hash is part of the address an anchor
lists, so a new certificate at a restart would leave every anchor naming the node unreachable.

**A browser client dials public addresses only.** libp2p's default connection gater in a browser refuses every address
in a private or reserved range (`10.0.0.0/8`, `192.168.0.0/16`, the documentation ranges and the rest of its list),
so a page cannot be made to probe its own network. A node a browser reaches therefore has a public address, or is
reached through a relay that has one; a mesh node on the reader's LAN is out of a browser's reach.

**Plain `ws://` is no browser path**: a browser client's home is a secure context. **WebTransport is not used**:
js-libp2p's WebTransport does not listen on Node.js, and a Notis node is Node.js.

## NAT

**A node's role is its operator's setting**, `public` or `private`. A **public** node runs a circuit relay v2 server
and AutoNAT v2 — the dial-back that tells other nodes which of their addresses answer — and, where its operator names
an IP and UDP port for one, a STUN server there (`STUN_PORT` is RFC 8489's port). A **private** node, one run with no public address, takes a relay reservation on each public
node it is told of — by address and id, never by searching — and is reached through them; between nodes, DCUtR
upgrades a relayed connection to a direct one where the NATs allow it. A browser reaches a private node over WebRTC
signalled through the relay, gathering ICE candidates against public nodes' STUN servers alone.

**A relay carries signalling, not data.** Public nodes keep libp2p's circuit relay limits, and a client opens no API
stream on a limited connection. Any relay a client reaches is itself a node it can read from, so data relayed on to a
private node would add no reach, and a relay without limits would carry any traffic at all for whoever holds a
reservation on it. A private node with no direct path to a client — the usual case for a node behind a symmetric NAT
and a client behind a NAT of its own — reads `retry` for that client, and the client stays on a node it does reach.

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
hostname. Only the relayed WebRTC path uses STUN; WebRTC-direct to a public address needs none.

## Discovery

**Anchors.** A client starts from a list of anchors, each `(notisId, addrs)`: a key it trusts and the addresses that
key was last reached at — IP multiaddrs ending in the key's `/p2p/` peer id, a browser's carrying the WebRTC-direct
certificate's hash. **An address is a hint; the key is the identity.** A client refuses an anchor address with a
`/dns4/`, `/dns6/` or `/dnsaddr/` component. Two anchors with one key are one anchor; the client's own key is none.

**Seeds.** A client may also start from seeds — `(notisId, addrs)` contacts it holds without trusting them, such as a
peer list it was handed or the nodes it knew before. A seed is a candidate like any node the DHT finds: it is not an
anchor, and no answer from it makes `anchorReached` true. The same refusals hold for a seed's addresses as for an
anchor's.

**The DHT is Notis's own.** Kademlia runs on the protocol `/notis/<network>/kad/1.0.0`, `<network>` one of `devnet`,
`testnet`, `mainnet` — never on libp2p's default, which is the public IPFS DHT. Public nodes serve it, each listening
on WebRTC-direct so a browser can walk it; private nodes and browsers run it as clients. It finds further nodes, and a
known key's current addresses.

## The node endpoint

A node's mesh service answers HTTP over libp2p (`@libp2p/http`) by forwarding each `GET` to its own Notis node's HTTP
base and answering with the upstream's status, `content-type` and body bytes as they came. Any other method answers
`405`.

The client's side is an `HttpFetch` over the mesh URL: `GET` only, ending at `REQUEST_TIMEOUT_MS` as every read does
(`CONSTANTS → Client reads`). Every cap a reader holds an answer to over HTTP holds over the mesh the same.

**The client checks what it can with the extension's verifier**: `resolveTip` over its candidates' mesh URLs, each
proof held to the client's network profile (`NIPOPOW_INTERFACE → The trust model`). There is no second verifier.

## The client's node list

The client keeps one entry per node key and moves it by what a failure is evidence of — the split
`NET_INTERFACE → Handshake → "Ban policy"` draws between nodes:

| What happened | Evidence of | The entry |
|---|---|---|
| a timeout, a refused connection, a dropped link, another transport failure, a non-2xx answer | nothing | `retry`, at growing intervals, never permanent |
| a proof refused by the client's clock check alone — a header stamped later than the client's own clock allows | the client's clock, which may be behind | `retry`, as above; never a lie |
| a valid proof that is not the winner's, or a chain too short to prove | being behind | `behind`, ranked below `ok` |
| an address answers with a key other than the one dialled | the address | that address dropped for that key when the dial's failure names it; the entry otherwise unchanged |
| a malformed answer, or a proof that fails verification, over a link authenticated to the key | a lie | `blacklisted` for good, the evidence kept |

**A valid proof of a lighter chain is not a lie**: an honest node that was itself cut off serves one. **Nor is a header
stamped ahead of the client's clock**: the verifier holds a header to the client's own time, and a client whose clock
runs behind would otherwise blacklist every honest node for good.

**A node's addresses are dialled as one operation.** libp2p joins every dial to a peer into the one already in flight, so
the client hands it all of a node's addresses at once, under one deadline. When another address connects first, an
address that answered with another key is not reported and stays listed; its next dial is refused again, at no cost to
the key. When every address fails, each one's failure is recorded against it.

**Two clocks.** The verifier reads the wall clock — a header's stamp is wall-clock time. The list's retry timers read a
monotonic clock, so a clock that steps never holds a node out or retries it at once. Neither stands in for the other.

**An entry keeps its last failure's kind and message**, for the page to show why a node is in `retry`; the message is
shown, never acted on.

**Retry.** After the `n`th failure in a row, a node is next tried `min(RETRY_CAP_MS, RETRY_BASE_MS · 2^(n−1))` later,
on a monotonic clock. A success ends the run.

**Candidates** are tried in this order: `ok`, `behind`, nodes not yet tried, then `retry` nodes whose time has come. A
`blacklisted` node is never one.

**A check** — `resolveTip` over the candidates — runs at start, every `CHECK_INTERVAL_MS`, and at once after a failed
fetch to the node in use. The node in use is the first candidate after it.

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

These are a proof of concept's local cadences, chosen 2026-10-29 and argued by nothing yet; local cadences are outside
the constants register (`CONSTANTS → Scope`).

## No anchor reached

`anchorReached` is true while at least one anchor's latest event is an answer it could check — a success, or a valid
proof that is behind — and false otherwise: at start, and whenever every anchor's latest event is a failure or a lie.
An anchor that is behind was still reached. While it is false the client treats every node it reaches
as unverified, and the page says, in these words: `No anchor reached. Nothing shown here is verified.`

## The IP certificate

**A public node's operator may opt in to the secure WebSocket fallback.** The node then obtains a certificate for its
own bare IP over ACME — the `http-01` challenge on port 80 of that IP — with no step by the operator after opting in,
and renews it at half its lifetime, `notBefore + (notAfter − notBefore) / 2`. A failed renewal is retried every
`CERT_RETRY_MS` while the current certificate serves. At `notAfter` the WebSocket listener stops, and every other
transport carries on. A renewed certificate replaces the old one without a restart, and open connections stay up.

**The certificate is the browser's admission ticket alone.** The link inside it is authenticated by the node's key
like every other (→ Transports). Let's Encrypt has issued IP certificates since 2026-01-15, valid 160 hours; a node
behind NAT cannot hold one.

## Acceptance

A stage on one machine runs the proof of concept end to end: public nodes, a node behind an endpoint-independent NAT
and one behind a symmetric NAT, a browser behind NAT, an ACME test server, and hostile nodes — each mesh node beside an
unmodified devnet `@dagsocial/node`. The proof of concept holds when every step of the six scenarios passes on what it
measured; a step that did not run reads `skipped`, never a pass.

1. **No name, no hosted page.** The client reads a node's API by key from anchors alone, with the browser's own
   resolver set to resolve no name at all; the mesh's answers equal the node's direct HTTP answers byte for byte; the
   browser host's DNS log holds no query — anything there went around the browser's resolver; and every ICE server the
   page's peer connections are built with is named by IP. The browser's own services resolve names whatever page is
   open, so a resolver that answers nothing is what separates them from the client; and a name the browser's resolver
   answers never reaches the log, so the page's own ICE configuration is read where it is made.
2. **Behind NAT.** The browser reaches the node behind the endpoint-independent NAT over WebRTC signalled through a
   relay, its data direct. The node behind the symmetric NAT has no direct path to the browser behind its NAT: it
   reads `retry`, never `blacklisted`, and the client stays on a node it reaches.
3. **A node goes away.** Killed, then firewalled: the client moves to another node within two checks, the node reads
   `retry`, never `blacklisted`, and reads `ok` again once it is back.
4. **A transport is cut.** UDP to one public node: the client stays connected, through another node or over that
   node's secure WebSocket — whichever ranks first. UDP to all: the client gets in through the secure WebSocket; a
   renewal replaces the certificate with no request dropped.
5. **Impersonation.** A node with its own key and a copy of an anchor's certificate, at the anchor's address: refused
   at the link, that address dropped, the anchor not blacklisted.
6. **Hostile nodes.** With every anchor out of reach, `anchorReached` is false and the page says so. A node answering
   malformed proofs and one answering failing proofs are blacklisted with their evidence; a node serving a valid proof
   of a lighter chain is `behind`.

**Browsers.** Chromium and Firefox on default settings; Safari cannot run on the stage's machine and is recorded as
untested. The proof of concept holds only where WebRTC-direct connects on defaults in both.
