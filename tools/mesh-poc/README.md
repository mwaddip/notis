# mesh-poc — a tester's manual

A browser page reaches a Notis node's HTTP API **by the node's Ed25519 key**, over libp2p, from a
handful of anchors and **no DNS name**. The mesh runs inside each devnet `@dagsocial/node` — the
node answers the mesh endpoint from its own HTTP, byte for byte. The stage runs the whole
machinery inside Linux network namespaces on one host and the eight scenarios in
`MESH_INTERFACE → Acceptance` drive it from the browser's side.

## Threat model

The adversary can at best **stop a client reaching a node**; the client then moves on and runs
discovery again (`MESH_INTERFACE → The client's node list`). An address that answers with another
key is dropped against that key; a lie earns a permanent blacklist with its evidence; a timeout, a
dropped link or a non-2xx is `retry` on growing intervals — never permanent.

The one case the proof of concept **does not defend**: a client that has never seen the chain,
shown a fake network whose every answer checks out. Nothing in the client can tell it from the real
one. The defences for that case — the build's own anchors, a second-channel starter package, and
reaching the inviter by key — are later work; they are not here.

## What it claims

| # | Claim | Points at |
|---|---|---|
| 1 | A client reads a Notis node's API by key over libp2p with no DNS and no hosted page. | `MESH_INTERFACE → Scope` |
| 2 | A client refuses a first-contact address with a `/dns4/`, `/dns6/` or `/dnsaddr/` component. | `MESH_INTERFACE → Discovery → "First contact."` |
| 3 | A browser dials a public node over WebRTC-direct; the address carries the certificate's hash. | `MESH_INTERFACE → Transports` |
| 4 | A browser reaches a private node over WebRTC signalled through a circuit relay. | `MESH_INTERFACE → NAT` |
| 5 | A relay carries data — a node a client has no direct path to is reached through the relay, data relayed, with no limit. | `MESH_INTERFACE → NAT → "A relay carries data"` |
| 6 | Every link is authenticated by the key it was dialled for; a key mismatch is refused at the link. | `MESH_INTERFACE → Transports → "Every link is authenticated by the key it was dialled for."` |
| 7 | A page under UDP-blocked conditions moves to secure WebSocket on an opted-in node's bare-IP certificate. | `MESH_INTERFACE → The IP certificate` |
| 8 | Every STUN server is a mesh node named by IP, drawn from the public nodes the client holds. | `MESH_INTERFACE → NAT → "A client's STUN list comes from the public nodes it holds"` |
| 9 | When no reachable node continues the kept chain, the page keeps its own and says, in these words: `No node reached continues the chain you verified.` | `MESH_INTERFACE → What the client remembers → "When no node continues it"` |
| 10 | Malformed and invalid proofs blacklist with their evidence; a valid proof of a lighter chain reads `behind`. | `MESH_INTERFACE → The client's node list` |
| 11 | A node added by the reader by hand is dialled at its private address; a remote node offering a private address is refused. | `MESH_INTERFACE → Discovery → "A node added by hand"` |

**Non-goals** — these are out of scope: multi-hop routing, DMs, node identities on chain and
vouches, ranking by vouches, a remembered tip, any change to the node, the extension or the
protocol, and any deployment.

## Anti-goals

A build that satisfies the claims but does any of these has **failed**:

- A DNS lookup anywhere on the client's path — a STUN or relay server named by host included.
- A hosted service a client depends on. The one exception is an opted-in node's bare-IP
  certificate, on the UDP-blocked fallback (`MESH_INTERFACE → The IP certificate`).
- A protocol of our own where an established one exists.
- A WASM dependency.
- A client that silently moves off the chain it verified when no reachable node continues it
  (`MESH_INTERFACE → What the client remembers → "When no node continues it"`).
- A blacklist that writes a node off for not answering — a timeout stays `retry`
  (`MESH_INTERFACE → The client's node list`).

## The stage

Linux network namespaces named `notismesh-<host>`. One namespace per host, bridged into one
internet segment at `11.100.0.0/24`, with two NAT routers wrapping endpoint-independent and
symmetric sub-segments (`stage/topology.json`). **Each host runs one integrated
`@dagsocial/node`** — the `MESH_*` environment it answers is the role's settings, and the
mesh runs beside the node's own libp2p (`NODE_INTERFACE → Configuration`):

| Host | Role | Address |
|---|---|---|
| pub1 | integrated node, public mesh role, miner | `11.100.0.11` |
| pub2 | integrated node, public mesh role | `11.100.0.12` |
| pebble | ACME test server | `11.100.0.21` |
| dns-log | REFUSED resolver + DNS witness | `11.100.0.22` |
| hostile-malformed | integrated node with public mesh role; its Notis p2p port peers only with hostile-lagging from before start, on the pair's own chain from genesis; an `hostile-upstream` interposer sits in front of the node's mesh endpoint by an nft `nat output` redirect, forwarding a non-hex `proof` and a tip of its own | `11.100.0.31` |
| hostile-invalid | integrated node with public mesh role; an interposer redirects its mesh endpoint to a `verifyProof`-refusing proof and a tip of its own | `11.100.0.32` |
| hostile-lagging | integrated node with public mesh role; its Notis p2p port peers only with hostile-malformed from before start; a 100 % boot miner then a 1 % miner on its node grows the pair's own chain from genesis | `11.100.0.33` |
| hostile-publisher | integrated node with no `MESH_*` env; a `stage/hostile-gossip.mjs` libp2p host built from `@dagsocial/net`'s pieces publishes malformed ordering blocks on the gossip topic beside it | `11.100.0.34` |
| natA | endpoint-independent NAT router (public `11.100.0.101`, inside `10.101.0.0/24`) | — |
| priv1 | integrated node, private mesh role, behind natA | `10.101.0.11` |
| natB | symmetric NAT router (public `11.100.0.102`, inside `10.102.0.0/24`) | — |
| priv2 | integrated node, private mesh role, behind natB | `10.102.0.11` |
| natC | endpoint-independent NAT router (public `11.100.0.103`, inside `10.103.0.0/24`) | — |
| browser | Chromium under `--host-resolver-rules=MAP * ~NOTFOUND` behind natC | `10.103.0.11` |
| lan1 | integrated node, private mesh role, beside the browser on natC's inside bridge | `10.103.0.21` |

Each host's node reads its role from `MESH_ROLE`, its listens from `MESH_LISTEN`, its STUN
server (public only) from `MESH_STUN`, its WSS opt-in (pub1 only) from `MESH_WSS` and
`MESH_ACME_*`, and its STUN list (private only) from `MESH_STUN_SERVERS`. Private nodes
derive their relay listens from `BOOTSTRAP_PEERS`'s public entries over the TCP connection
to each seed — no `/p2p-circuit` entry appears in `MESH_LISTEN`. A hostile host carries no
setting for its lie: the node runs honest and an interposer binds the host's `:7000`;
`sudo ip netns exec <ns> nft` installs a `nat output` rule that redirects every outgoing
packet to `127.0.0.1:3100` to `:7000`, so the node's own mesh-endpoint forward hits the
interposer. The interposer reaches the node at the namespace's own address (daddr-127.0.0.1
match fails there), and forwards the body it wants to.

### What the stage needs

- **Linux** with the per-namespace `net.ipv4.ip_unprivileged_port_start` sysctl (kernel ≥ 4.11).
- **Root through `sudo`.** `stage/up.mjs` wraps each privileged step as
  `sudo ip netns exec <ns> sudo -u "$USER" --` so every long-lived process runs as the invoking
  user. `USER` must be set — `stage/up.mjs` refuses to start without it.
- **`ip`** and **`nft`** from iproute2 and nftables — called by their names, resolved on `PATH`.
- **`certutil`** from `libnss3-tools` — `stage/up.mjs` runs `which certutil >/dev/null` as a step
  and exits with a readable error if absent.
- **Node 24** — `stage/up.mjs` uses `process.execPath` for every spawn, so **run `stage:up` under
  Node 24** (`node --version` reads `v24.x`). Node 24 is also required by the repo's `engines`.
- **The Chromium build `stage/up.mjs` looks for.** The path is read from `stage/up.mjs`
  (Playwright's Chromium 1228 under `~/.cache/ms-playwright/`); the live-check after Chromium
  launches catches a missing binary with the tail of its log.
- **Network access once**, for Pebble `v2.8.0`. `stage/up.mjs` downloads the pinned archive, checks
  `sha256sum --check` against `34595d915bbc2fc827affb3f58593034824df57e95353b031c8d5185724485ce`,
  caches it under `stage/cache/`, and refuses on mismatch. Further runs read the cache.
- **The X server on `DISPLAY=:0`** for Firefox by hand. Chromium runs `--headless=new` and needs
  no X server; `stage/up.mjs` passes `DISPLAY` through to Chromium anyway, so a Firefox launched
  inside `notismesh-browser` reaches the same X socket at `/tmp/.X11-unix/X0` (the host's
  `/tmp` is visible inside the namespace).
- **No stale `notismesh-*` namespace.** `stage/up.mjs` reads `ip netns list` and exits with code 2
  if any `notismesh-*` is already present — `stage:down` first.

### The commands, in order

Run each under `timeout`. The names are the `scripts` entries in `tools/mesh-poc/package.json`.

```bash
export PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH"

timeout 10m  pnpm -r build
timeout  5m  pnpm --filter @dagsocial/mesh-poc page:build

timeout 20m  pnpm --filter @dagsocial/mesh-poc stage:up
timeout  2h  pnpm --filter @dagsocial/mesh-poc stage:run       # default order: s6 s1 s2 s3 s4 s5 s7 s8
timeout  1m  pnpm --filter @dagsocial/mesh-poc stage:report
timeout  5m  pnpm --filter @dagsocial/mesh-poc stage:down
```

- `pnpm -r build` builds every workspace member; the integrated node the stage spawns lands
  at `packages/node/dist/index.js`.
- `pnpm --filter @dagsocial/mesh-poc page:build` writes the browser page to
  `tools/mesh-poc/dist-page/` (vite). `stage/page-server.mjs` serves this directory and splices
  `stage/out/browser/config.json` at `/config.json`.
- **`stage:up`** rotates `stage/out/` to `stage/out.prev/` (replacing any older `.prev`), creates
  every namespace and NAT rule, lifts `net.ipv4.ip_unprivileged_port_start=0` in the browser,
  dns-log and pub1 namespaces, writes `/etc/netns/notismesh-browser/resolv.conf` with the dns-log
  address, creates each host's `node.key` (PKCS8 Ed25519 seed, 48 bytes, mode `0600`),
  downloads Pebble and generates a stage CA + Pebble server cert, starts the dns-log server, cuts
  hostile-lagging's and hostile-malformed's Notis p2p port from everything but each other BEFORE
  starting their Notis nodes (so the pair grows its own chain from genesis, each pair host naming
  the partner alone in `BOOTSTRAP_PEERS`), installs each hostile-upstream host's
  nft `nat output` redirect rule and starts its interposer on `:7000`, starts each integrated
  Notis node (public mesh roles first; private second — their relay reservations land on the
  publics that are up), starts the hostile-publisher's `stage/hostile-gossip.mjs` host beside
  its node, the miner inside pub1 at `MINER_PCT=100` alongside the miner-lagging-boot inside
  hostile-lagging at `MINER_PCT=100`, waits until every honest node AND the pair's node
  (hostile-lagging) reads `/blocks/current.height >= 50`, swaps the honest miner to
  `MINER_PCT=2` and the pair's miner to `MINER_PCT=1`, writes `stage/out/browser/config.json`
  and `stage/out/browser/config.default.json` from the mesh addresses the nodes printed in
  their identity lines, writes `stage/out/identities.json`, installs Pebble's root into
  Chromium's NSS db under `stage/out/browser/home/.pki/nssdb` with trust flag `C,,`, starts the
  page server on `http://localhost:80/` inside the browser namespace, launches Chromium
  headless with `--remote-debugging-port=9222` and
  `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE 11.100.0.*`, confirms
  every recorded PID is alive, and prints `stage up: <N> processes, <M> namespaces`. On
  failure it rolls back exactly what it created (SIGTERMs each recorded PID, deletes each
  namespace in reverse order, removes `/etc/netns/notismesh-*`).
- **`stage:run [<name>...]`** runs the named scenarios in the order given (default: all eight,
  `s6 s1 s2 s3 s4 s5 s7 s8` — `MESH_INTERFACE → Block gossip → "A router scores its peers by
  gossipsub's defaults"` kicks in past ten peers from one NAT address and keeps the penalty an
  hour, so s6's publisher reads the client's score as zero when the client has to be the only
  browser peer at that address). Writes `stage/out/scenarios/<name>.json` per scenario:
  `{ scenario, startedAt, endedAt, steps, faults }`, each step `{ name, verdict, measurement,
  timeMs }`. **A step that times out or throws is `FAIL`; the scenario's faults are removed and
  the run goes on. A step that did not run reads `skipped`, never a pass.** Each scenario writes
  its own `config.json` variant at start, so the previous scenario's variant does not leak; the
  scenario's `finally` restores `config.default.json`. Non-zero exit when any step is `FAIL`.
- **`stage:report`** reads `stage/out/scenarios/*.json` and writes `stage/out/summary.md`: one
  section per scenario, every step's verdict, time and measurement; a Firefox block is left for the
  hand pass, marked as such.
- **`stage:down`** reads `stage/out/pids.json`, SIGTERMs each recorded PID (SIGKILL after 10 s),
  then deletes each `notismesh-*` namespace and `/etc/netns/notismesh-*/` beside it. When
  `pids.json` is absent it falls back to `ip netns list` + `ip netns pids <ns>` per namespace, so a
  half-started stage still cleans up.

**`--dry-run`** on every script prints every command it would run (privileged ones marked
`[privileged]`), creates no namespace, writes no file, starts no process. `stage/up.mjs`'s dry-run
also accepts `--simulate-failure-after=<N>` to show the teardown path.

### What `stage:up` writes outside the namespaces

Only `/etc/netns/notismesh-browser/resolv.conf`. Every other state file lives under
`stage/out/`:

```
stage/out/pids.json               recorded PIDs + namespaces, rewritten after every spawn
stage/out/identities.json         host → { notisId, meshRole, addr, httpPort, multiaddrs }
stage/out/dns.log                 one line per DNS query the browser-namespace resolver saw
stage/out/browser/config.json     the active page config (a scenario may replace it)
stage/out/browser/config.default.json   the canonical copy a scenario can restore from
stage/out/browser/home/.pki/nssdb/      Chromium's NSS db (holds Pebble's root)
stage/out/browser/profile/              Chromium's user-data-dir
stage/out/pebble-root.pem         Pebble's issuing root, fetched from its management API
stage/out/pebble-config.json      Pebble's launch config
stage/out/stage-ca{,-key}.pem     the stage CA that signs Pebble's own TLS
stage/out/pebble-server-{cert,key}.pem  Pebble's TLS cert (SAN=ip:11.100.0.21)
stage/out/<host>/node.key         each integrated node's PKCS8 Ed25519 seed, mode 0600
stage/out/<host>/notis.db         each integrated node's SQLite store
stage/out/<host>/notis.mesh/      each integrated node's mesh state directory (libp2p
                                  datastore holding the WebRTC-direct certificate's keychain)
stage/out/<host>/notis.log        each host's node log — one JSON line per journal event,
                                  plus a `{ notisId, peerId, multiaddrs, ... }` identity line
                                  reprinted on every `self:peer:update`
stage/out/<host>/<tag>.log        per-host, per-process log (miner-steady, hostile-gossip,
                                  hostile-upstream, …)
stage/out/scenarios/<s>.json      one per scenario stage:run touched
stage/out/summary.md              stage:report's build
```

`stage/cache/` holds the pinned Pebble tarball and the extracted binary. **`stage:down` removes
only `stage/out/pids.json`** — every other file under `stage/out/` stays, for a reader to pick
over after a run; the next `stage:up` rotates the whole `stage/out/` directory to
`stage/out.prev/` (replacing any older `.prev`) at its start.

## The eight scenarios

Each scenario's step list is `verdicts.mjs`'s rules in order. A `PASS` requires **positive
evidence**: a vacuous read (no connection, no measurement) is never a pass. A step reads `skipped`
only when its measurement is absent — never because the stage decided it was easy.

### s1 — No name, no hosted page (`MESH_INTERFACE → Acceptance 1`)

Chromium under `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE 11.100.0.*`
loads the page from `http://localhost:80/`; the page fetches `config.json` beside it. The browser
namespace points at the dns-log server (`11.100.0.22:53`), which answers RCODE 5 (REFUSED) for
every query and appends one line to `stage/out/dns.log`. The nft `dns_witness` table in the browser
namespace counts every packet to UDP/TCP ports 53 and 853 (so a DNS-over-TLS fallback is also
caught). The probe window pauses `miner-steady` (`SIGSTOP` on its leaf PIDs — `sudo` does not relay
the signal to its child; the pause reaches the inner Node process) and resumes it in `finally`.

| # | Step | Pass condition | What breaks it |
|---|---|---|---|
| 1 | `nodeId is an anchor within 60 s, reached over WebRTC-direct` | `state.nodeId` is a key the page's `config.json` lists in `anchors`, read within 60 s, and the same `#state` reads `transport === 'webrtc-direct'` with `path === 'direct'`. | A `nodeId` that is not an anchor; a `nodeId` of `null` past 60 s; `transport` is `wss` or `webrtc`; `path` is `relay`. |
| 2 | `probe /blocks/current matches the node direct` | `?probe=/blocks/current` writes `{ sha256, bytes }` equal to one of the brackets `curl -s http://127.0.0.1:3100/blocks/current` read from the anchor's own namespace before and after. | Different `sha256`, different `bytes`, no probe element. |
| 3 | `probe /nipopow/proof/24/20 matches the node direct` | Same, over `/nipopow/proof/24/20`. | As above. |
| 4 | `the DNS log holds no line and the nft 53/853 counter did not move` | `dnsLines === 0` and `nftCounterPackets === 0` across the scenario window **and** `connected === true` (a page that never connected is not evidence). | A line appended to `stage/out/dns.log`; a counter that moved. |
| 5 | `every RTCPeerConnection the page builds names a STUN by IP, or no STUN at all` | Every `urls[]` matches `stun:<IPv4>:<port>` or `stun:[<IPv6>]:<port>`; an empty URL set is also a pass. | A `urls[]` entry that is not of those shapes (a hostname is the test's point). |

**What a tester reports even on PASS:** **any** `stage/out/dns.log` line, whatever name it
carries. Chromium's `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE
11.100.0.*` answers every name inside the browser, so a packet reaching the dns-log server went
around Chromium's resolver — a path the proof of concept does not have (`MESH_INTERFACE → Scope`).

### s2 — Behind NAT (`MESH_INTERFACE → Acceptance 2`)

Two sub-steps, each with its own `config.json` variant written at start.

| # | Step | Pass condition | What breaks it |
|---|---|---|---|
| 1 | `priv1 (endpoint-independent NAT) answers over relayed WebRTC` | priv1's `nodes[]` entry reads `status` ok, trailing or behind (all three say a checked answer came back; `trailing` and `behind` are ranking, not reach), its entry `transport === 'webrtc'` and `path === 'direct'`, the single anchor address names `/p2p-circuit/webrtc`, and every ICE server is `stun:<ip>:<port>` drawn from the public nodes the client holds (the relay hop among them, since the config carries no `stunServers` key). `nodeIdInUse` is recorded alongside, not a condition. | priv1 at `retry`, `blacklisted` or `new`; entry `transport` not `webrtc`; entry `path` not `direct`; a STUN URL naming a host. |
| 2 | `priv2 (symmetric NAT) is reached through a relay that carries its data` | priv2's entry reads `status` ok or trailing, its entry `path === 'relay'`, and the latest routed read landed on priv2 (`latestReadNodeId === expectedNodeId`); priv2 is never `blacklisted` at any poll. | priv2 at `retry`, `blacklisted` or `behind`; path `direct`; the latest routed read landed on another node. |

**A relay carries data** (`MESH_INTERFACE → NAT → "A relay carries data"`): a node with no direct
path to a client — a node behind a symmetric NAT, for a client behind a NAT of its own — is
reached through a relay, data relayed, with no byte or duration limit on the circuit. A relayed
link is authenticated end to end by the key it was dialled for (`MESH_INTERFACE → Transports →
"Every link is authenticated by the key it was dialled for."`), so the relay can block what it
carries, never read or forge it.

**What a tester reports even on PASS:** the entry's `path` on priv2 — a `direct` reading there
means the symmetric NAT happened to be punched (worth knowing, since a different NAT or a kernel
update could change that), but the acceptance line names a relayed path.

### s3 — A node goes away (`MESH_INTERFACE → Acceptance 3`)

Five sub-steps against pub1's integrated node (four) and the browser profile's memory (one),
driving the client's `CHECK_INTERVAL_MS` (30 000 ms) and the retry cadence by hand.

| # | Step | Pass condition | What breaks it |
|---|---|---|---|
| 1 | `pub1 stopped: client moves to another node within 2 checks, pub1 retry` | pub1's entry reads `retry`; the latest routed read (`state.nodeId`) is not pub1 and not null; movement within `2 · CHECK_INTERVAL_MS`. | pub1 `blacklisted`; routed reads stuck on pub1; no movement past two checks. |
| 2 | `pub1 restarted: pub1 reads at or one block short of the tip at the next completed check` | After waiting until pub1's own `/blocks/current` is within one block of pub2's, the next completed check reads pub1 as `ok` with `behindBy === 0`, or `trailing` with `behindBy === 1`; `recoveryTimeMs` is recorded. | pub1 `retry` or `blacklisted` at the check; `ok` with a non-zero `behindBy`; `trailing` with any other distance. |
| 3 | `pub1 firewalled: client moves to another node within 2 checks, pub1 retry` | Same as step 1, with nft rules dropping UDP/TCP to pub1's mesh listener in pub1's namespace. | As step 1. |
| 4 | `pub1 unfirewalled: pub1 reads at or one block short of the tip at the next completed check` | Same as step 2. | As step 2. |
| 5 | `with first contact out of reach, the page reaches the network through the nodes it remembers` | Two sessions on the same browser profile. Session 1 (`?clearMemory=1`) reaches the first-contact nodes; the page polls `localStorage['notis.mesh.memory.<network>']` until the record's `nodes` list carries at least one honest non-first-contact id (priv1 or priv2 — the browser discovers them through the relay). An nft `s3_known` table in the browser namespace drops every first-contact address. Session 2 (no clear) opens; the client takes memory's `seeds` at start, dials them, and reads its chain: `state.tip` non-null (64-hex `hash`, positive `height`), at least one remembered id reads `ok` or `trailing`, every first-contact id reads `retry`, `notContinued` is false. | A session 1 memory with no honest non-first-contact id; a session 2 tip missing; every remembered entry stuck at `retry`; a first-contact id not at `retry`; `notContinued` true. |

**What a tester reports even on PASS:** pub1 reaching `blacklisted` at any point — a timeout, a
refused connection, a dropped link or a non-2xx is `retry`, never permanent
(`MESH_INTERFACE → The client's node list`).

### s4 — A transport is cut (`MESH_INTERFACE → Acceptance 4`)

Four sub-steps against UDP from the browser namespace, then TCP between the Notis nodes.

| # | Step | Pass condition | What breaks it |
|---|---|---|---|
| 1 | `UDP to pub1 cut: client gets in through another public node` | `connected === true`; either `nodeId !== pub1` or `nodeId === pub1 && transport === 'wss'`. | Neither path. |
| 2 | `UDP to every public node cut: client connects over WSS to pub1 with the Pebble-issued cert` | `transport === 'wss'`, `nodeId === pub1`, the TLS issuer name read from `openssl s_client` inside the browser namespace contains `Pebble`. | A non-WSS transport; a different issuer. |
| 3 | `across one renewal the probes keep succeeding, no lastLeft names a failure` | Pebble log shows at least one renewal across the 240 000 ms window; the client was connected over WSS at the window boundary and at its end; no `state.lastLeft.reason` named `timeout`/`refused`/`dropped`/`transport`/`lie`/`malformed`/`proof-invalid` in the window. **Positive evidence required**: `connectedBeforeWindow === true` and `connectedAfterWindow === true`. | A dropped request named by `lastLeft.reason`; no renewal in the Pebble log; a window boundary with no connection. |
| 4 | `TCP between the Notis nodes p2p port cut: record what still answers` | After one `CHECK_INTERVAL_MS` the page's `state.transport` and `state.nodeId` are both non-null. | Neither field settled. |

**What a tester reports:** a renewal step whose window held no renewal, or a
`connectedBeforeWindow` or `connectedAfterWindow` that is not `true`, reads FAIL — report the
step's measurement from `stage/out/scenarios/s4.json` when it does, so the next run's window can
be widened.

### s5 — Impersonation (`MESH_INTERFACE → Acceptance 5`)

One step with four measurements. Stop pub1's integrated node; spawn an impostor whose state is a
byte-for-byte copy of pub1's `.mesh` directory — same WebRTC-direct certificate — **with a fresh
`node.key`** beside it. Bind pub1's address.

| # | Step | Pass condition | What breaks it |
|---|---|---|---|
| 1 | `impostor on pub1 address: refused at the link, address dropped, anchor not blacklisted` | pub1's entry carries pub1's own address in `droppedAddrs`; `status !== 'blacklisted'`. | pub1 `blacklisted`; pub1's address not in `droppedAddrs`. |

**What this holds** (`MESH_INTERFACE → Transports → "Every link is authenticated by the key it was
dialled for."`): libp2p's Noise handshake over WebRTC binds the DTLS certificates to the two keys,
so a node whose key is not the one dialled is refused at the link whatever certificate it holds.
The anchor's address is dropped for that key; the anchor keeps its status.

### s6 — Hostile nodes (`MESH_INTERFACE → Acceptance 6`)

Three sub-steps.

| # | Step | Pass condition | What breaks it |
|---|---|---|---|
| 1 | `a kept honest chain stands when every reachable node serves a hostile fork of it` | A first page session on the honest nodes seats the kept proof in `localStorage` (one record per network, keyed by the genesis the profile pins or the network's name — `MESH_INTERFACE → What the client remembers`). A second session on a fresh page, with every honest node blocked at the browser's nft table and a `hostile-fork` node reachable as a known node, reads `state.notContinued === true`; the page's `[data-role="banner"]` reads `No node reached continues the chain you verified.` byte for byte; `state.chain` is the first session's kept chain; the `hostile-fork` entry reads `behind` with a real tip hash (positive evidence the hostile node answered). | A different banner text; `notContinued: false`; the chain name moved (the kept proof was dropped); the hostile-fork entry never answered. |
| 2 | `hostile seeds kept: malformed and invalid blacklisted; lagging behind, not blacklisted` | `hostile-malformed` → `blacklisted`, evidence `malformed`; `hostile-invalid` → `blacklisted`, evidence `proof-invalid`; `hostile-lagging` → `behind`, never `blacklisted` — the pair runs its own chain from genesis, no block shared with the honest one; devnet pins no `genesisId`, so `compareProofs` answers `incomparable / no-common-ancestor` (`NIPOPOW_INTERFACE → compareProofs`), `resolveTip` keeps the client's own tip's proof handed to it first (`MESH_INTERFACE → The client's node list → "A check"`), and the pair's tip, not on the winner's suffix, reads `behind: null` which `tipEvent` turns into `behind`. | Any of those three not landing. |
| 3 | `the publisher is blacklisted for gossip-block; the client forwarded nothing` | `hostile-publisher` → `blacklisted`, evidence `gossip-block`; every honest node's `notis.log` holds no `peer_penalised` event whose `detail` names an ordering-block reject sourced from a peer other than the publisher (the client refused the bad block, so no honest node ever sourced it from the browser). | Publisher not blacklisted or evidence of a different kind; one honest node's log named a reject source other than the publisher. |

**The hostile-fork host** (step 1): a host that syncs the honest chain from the honest nodes
through pub1, then has its Notis p2p port cut by an nft `fork_cut` table in its namespace. After
the cut a `miner.mjs` process runs inside the host's namespace at `MINER_PCT=1`, pointed at the
host's own HTTP port — no `NODE_ROLE` change is needed, the mining endpoints answer under a
`role: 'server'` node. The cut's own nft rules carry no accept exception (there is no partner),
so every TCP packet on the p2p port is dropped in either direction. `stage/lib/hostile-fork-single.mjs`
is the builder; the browser profile from the first session persists across sessions by its
`stage/out/browser/profile` directory (Chromium's `--user-data-dir`), so the second page reads
the first's `localStorage`.

**What a tester reports even on PASS:** the hostile-lagging node at `blacklisted` at any point —
a timeout, a refused connection, a dropped link or a non-2xx is `retry`, and a valid proof of a
lighter chain is `behind`; neither is `blacklisted` (`MESH_INTERFACE → The client's node list`).

**The traffic the page shows.** Every page carries a `[data-role="traffic"]` section with the
counts the client keeps per check: `Proofs read`, the byte counts for `tip`, `header`, `proof`
and `gossip`, and `forwarded` (how many blocks the client's gossipsub handler delivered — a
rejected block never increments this). A tester reads `forwarded` during s6 step 3 to see at a
glance that the browser dropped the publisher's bad block (`MESH_INTERFACE → Block gossip`).

### s7 — Reach and load (`MESH_INTERFACE → Acceptance 7`)

Five sub-steps that drive routed reads, a slowed node, a node on the browser's own network, the
heavier question and the agreement counts.

| # | Step | Pass condition | What breaks it |
|---|---|---|---|
| 1 | `older reads spread across ≥ 2 nodes; tip reads only on ok nodes` | `?reads=20&need=older` names at least two distinct serving nodes; every tip read from `?reads=10&need=tip` was served by a node reading `ok` at that read. | Older reads all on one node; a tip read served by a node not `ok` at that read. |
| 2 | `pub2 delayed 200ms serves no read` | A `tc qdisc add dev <pub2 outside peer> root netem delay 200ms` is applied inside `notismesh-pub2`; after one completed check `?reads=20&need=older` names no read served by pub2. | Any read served by pub2 after the delay lands. |
| 3 | `lan1 is never dialled from a seed; by hand it is reached, yours follows the trusted flag` | Three phases: (a) with lan1 named only as a seed, over two completed checks lan1 never holds a connection AND lan1's `notis.log` holds no `[net] connection:close ... addr=/ip4/10.103.0.11/... dir=inbound` line; (b) with no first-contact nodes and `byHand: [lan1, trusted:true]`, lan1 reads `ok` or `trailing` over `webrtc-direct`, `path: direct`, its entry carries `yours: true`; (c) the same with `trusted: false` → the entry carries `yours: false`. | A connection to lan1 in the seed phase; a dial from the browser logged on lan1's node; a hand-added entry whose `yours` reads other than the trusted flag's value. |
| 4 | `the heavier question: lan1 cut and forking lighter raises it; each answer does what it says` | Four phases on the same lan1 identity. (a) lan1 trusted as the reader's node, on the page's chain: the page seats its chain from the kept proof, lan1's entry is `yours: true`, `agreement.onChain ≥ 1`. (b) lan1's p2p port is cut from the honest nodes and `miner.mjs` runs inside lan1's namespace at `MINER_PCT=1` while the honest chain grows heavier: `state.disagreement.which === 'heavier'`; `state.chain` and `state.tip` do not move; `[data-role="disagreement-buttons"]` carries two buttons. (c) *disable it* is pressed once: `client.answer` is called once, the disagreement clears, lan1's entry reads `yours: false` and the client's chain seats on the honest side at the next check. (d) the same arrangement, *continue on this node* instead: `client.answer` is called once, the chain seats on lan1's side, the fork joins `answeredForks`, and the same branch growing raises no new disagreement on the next check. | The wrong `which`; the chain or tip moved while the disagreement stood; the buttons did not appear; `client.answer` was called zero or more than once per press; the state after `disable` or `continue` is not what the rule says. |
| 5 | `the agreement counts hold onChain ≥ 2` | After a completed check on the stage default: `state.agreement.onChain ≥ 2`. | A count below the threshold; a check that never completed (`agreement: null`). |

**A node on the browser's own network comes in by the reader's hand**
(`MESH_INTERFACE → Discovery → "A node added by hand"`): the client dials a private address only
when its own configuration names it — an anchor's address or one the reader entered by hand, each
for its key; a private address a remote node offers through the DHT, a peer list or a seed is
refused.

**STUN by default** (`MESH_INTERFACE → NAT → "A node's role is its operator's setting"`): a
public node runs a STUN server on `STUN_PORT` at the IP of its first WebRTC-direct listen
address unless its operator names another or turns it off; the client's ICE list is derived
from the public nodes it holds.

### s8 — Prove once, follow by gossip (`MESH_INTERFACE → Acceptance 8`)

Four sub-steps that drive the "After the first check, no proof is read" rule across settled
checks, gossip delivery, a lighter fork from a hostile neighbour, and recovery after a gossip
cut.

| # | Step | Pass condition | What breaks it |
|---|---|---|---|
| 1 | `no proof read across five completed checks on the stage default` | A step-scoped firewall drops the browser's output to every hostile host for the step's duration (a `FaultLog` fault, removed in a `finally` inside the step), so the stage-default's DHT walk never reaches a hostile node whose tip-of-its-own would be read on the first check. The baseline is the first state with the chain settled (`checks >= 1`, `proofReads >= 1`) where every honest node the list HOLDS reads `ok`, `trailing` or `behind` and both anchors are held — a honest node absent from the list is not asserted, so a node the browser reaches only by DHT does not stall the baseline. Across the five completed checks past it, `state.traffic.proofReads` is unchanged, both anchors are still held, and every held honest node still reads `ok`, `trailing` or `behind`. | A `proofReads` that moved; an anchor dropped from the list; a held honest node at `retry` or `blacklisted`; fewer than five checks past the baseline. |
| 2 | `three new blocks reach the browser by gossip within 5 s each` | One page kept open across the three deliveries, so the client's gossip subscription survives. The page's tracker pushes `{height, atMs, checks}` on each tip change; the scenario polls pub1's `/blocks/current` every 250 ms inside pub1's namespace and keeps the first `atMs` it sees each height. For the first three client tip changes past the baseline, `delayMs` is the client's `atMs` for that change minus pub1's first `atMs` at or above that height (a negative delay says gossip beat the 250 ms poll — a delivery within the bound), and `checksMoved` is whether the client's `checks` advanced in that window. At least two of three carry `delayMs ≤ 5000` and `checksMoved === false`. | A delivery delayed past 5 s; a delivery whose `checks` moved in the window (a check ran meanwhile — carried the block by proof, not gossip). |
| 3 | `the lagging fork reads behind, client tip stays on pub1's chain, exactly two proofs that check` | Hostile-seeds variant with `hostile-lagging` and `hostile-malformed` on the pair's own chain from genesis, each pair host peered only with the partner since `up`'s pre-spawn cut; `miner-lagging` grows the pair's chain at `MINER_PCT=1` against the honest chain's `MINER_PCT=2`. The pair's chain shares no block with the honest one; devnet pins no `genesisId`, so the lagging node's proof verifies and `compareProofs` answers `incomparable / no-common-ancestor` (`NIPOPOW_INTERFACE → compareProofs`); `resolveTip` keeps the client's own tip's proof handed to it first (`MESH_INTERFACE → The client's node list → "A check"`), and the lagging tip, not on the winner's suffix, reads `behind: null` which `tipEvent` turns into `behind`. The step waits for a completed check cycle in which `traffic.proofReads` rose by exactly two — the new lagging tip's proof plus the client's own tip proof, the one shape "one per distinct tip, and the client's own" takes when every other node names the chain's tip (hostile-malformed's interposer redirects its mesh endpoint to `LIE_HASH` and non-hex proofs, so it is `blacklisted`, no proof read after the first evidence). PASS: `hostile-lagging.status === 'behind'`, `state.tip.hash` equals pub1's node's block hash at that height, and the delta is exactly two. | Lagging `blacklisted` or any status other than `behind`; the client's tip hash differs from pub1's at that height (the pair's chain won); a check whose delta was 1 (lagging never read) or 3 (another off-chain tip too). |
| 4 | `the browser's gossip cut for three blocks and restored: tip catches up by headers, no proof read` | On the stage default: a page kept open across the window. The scenario firewalls the browser from every mesh host, waits until pub1 has advanced three blocks past the moment the firewall landed, removes the firewall, and awaits the tracker (3-min deadline). The cut is short — gossip moves the tip one block at a time, so no check sees it. The tracker ends at the first one-block tip change AFTER its first jump of three or more (the fill, then gossip extending the tip past it — the client is at the head), recording `proofReads` and the tip at that one-block-after point; the scenario then reads pub1. PASS: `proofReadsAfter === proofReadsBefore`, `jump >= 3` (fill size), and the tip is within two of pub1's read. | A `proofReads` that moved during the window; a fill jump smaller than three (gossip-paced, not a header fill); a tip at the head that landed more than two off pub1's read. |

**No proof after the first** (`MESH_INTERFACE → The client's node list → "A check"`): a check that
places every tip on the client's chain reads no proof. After the first check settles the chain,
further checks name the same tips in the same place; the client stays with its chain and does not
re-read anybody's proof.

**One page across the window** (step 2 and step 4): a fresh page runs its initial check at startup,
which reads the latest tip by proof — if step 2 opened a fresh page for each delivery the
measurement would be of the first-check latency, not the gossip latency; if step 4 did, the fresh
page's first-check proof would mask the "no proof read" conclusion. Both steps spawn `cdp.mjs poll`
non-blocking so the scenario can run its own work beside the tracker — step 2 reads pub1's height
on 250 ms cadence to build the pub1-side timeline, step 4 applies and removes the nftables rules.

**The traffic the page shows during s8.** The `[data-role="traffic"]` section (`Proofs read`, byte
counts for `tip`/`header`/`proof`/`gossip`, and `forwarded`) is what step 1 and step 4 both
measure through `state.traffic.proofReads`: `Proofs read` is the field a tester reads at a glance
to confirm the "no proof read" claim.

## Firefox by hand

The scenarios drive Chromium through CDP. The contract holds only where WebRTC-direct connects on
defaults in **both** Chromium and Firefox (`MESH_INTERFACE → Acceptance → "Browsers."`), so Firefox
is checked by hand on the live stage.

Firefox 157 is installed at `/usr/bin/firefox` on the stage's machine; the session is X11 with
`DISPLAY=:0` and `XAUTHORITY=$HOME/.Xauthority`. Launch Firefox **inside** `notismesh-browser` as
the invoking user, with a throwaway profile under `stage/out/`:

```bash
PROFILE="$PWD/tools/mesh-poc/stage/out/firefox-profile"
mkdir -p "$PROFILE"

# 1. Create an NSS database and install Pebble's issuing root with "C,," trust.
certutil -N -d sql:"$PROFILE" --empty-password
certutil -A -d sql:"$PROFILE" -t C,, -n pebble-root \
         -i "$PWD/tools/mesh-poc/stage/out/pebble-root.pem"

# 2. Check the trust is C,, — never anything else; the LIST form prints the row.
certutil -L -d sql:"$PROFILE" | grep -E '^pebble-root[[:space:]]+C,,'

# 3. Launch Firefox inside the browser namespace, as the invoking user.
sudo ip netns exec notismesh-browser \
  sudo -u "$USER" -- \
  env DISPLAY="$DISPLAY" XAUTHORITY="$XAUTHORITY" \
      /usr/bin/firefox --no-remote --profile "$PROFILE" \
                       http://localhost:80/
```

Firefox's own services resolve names whatever page is open — update, telemetry, captive-portal
and the like. The browser-namespace resolver answers RCODE 5 (REFUSED) for every query and logs
it, so Firefox's own names landing in `stage/out/dns.log` are **the browser's own**, not the
page's. A line naming a STUN host, a relay host, or any name that is not one of Firefox's own
services is a failure.

### What to check, in order

1. **The page connected over WebRTC-direct.** Read `#state` from the DevTools console:
   `document.getElementById('state').textContent`. The parsed JSON holds
   `{ nodeId, transport: 'webrtc-direct', path: 'direct', ... }` and `nodeId` matches one of
   `anchors[].notisId` in `stage/out/browser/config.json` (a public anchor dialled over
   WebRTC-direct; `'webrtc'` is the relayed-WebRTC path to a private node, not what either
   anchor should read). **Fails** if `nodeId` is `null`, if `transport` is not `'webrtc-direct'`,
   or if the client lands on a non-anchor.

2. **The probe matches the node byte for byte.** Open
   `http://localhost:80/?probe=/blocks/current`, read `#probe` from the console
   (`document.getElementById('probe').textContent`). From inside the anchor's own namespace, read
   the same path and compare `sha256` and `bytes` (replace `<host>` with the host whose `notisId`
   matched `#state.nodeId` — look it up in `stage/out/identities.json`):

   ```bash
   sudo ip netns exec notismesh-<host> \
     curl -sf http://127.0.0.1:3100/blocks/current | sha256sum
   ```

   **Pause the miner first** so the tip does not move between reads
   (`stage/out/pids.json` → `miner-steady` entry; `SIGSTOP` the leaf PIDs under it, `SIGCONT` to
   resume). **Fails** if the two hashes differ.

3. **Every UDP path cut moves the page to `wss` on pub1.** pub1 is the one node opted in to the
   WSS fallback (`stage/topology.json` names `mesh.wss` on pub1 alone), so a UDP drop that covers
   every public anchor forces WSS. Drop every UDP packet from the browser namespace to the
   internet segment except DNS, read the state, remove the rule:

   ```bash
   sudo ip netns exec notismesh-browser nft add table ip s4_fx
   sudo ip netns exec notismesh-browser \
     nft 'add chain ip s4_fx out { type filter hook output priority 0 ; }'
   sudo ip netns exec notismesh-browser \
     nft add rule ip s4_fx out ip daddr 11.100.0.0/24 udp dport != 53 drop

   # Wait one CHECK_INTERVAL_MS (30 000 ms), then read #state.
   # Expected: state.transport === 'wss' and state.nodeId identifies pub1
   # (the one node with mesh.wss in stage/topology.json).

   # Remove.
   sudo ip netns exec notismesh-browser nft delete table ip s4_fx
   ```

   **Fails** if `state.transport` is not `'wss'`, if `state.nodeId` is not pub1's, or if
   `state.nodeId` stays `null` for longer than two checks.

4. **The DNS log and Firefox's own resolver list hold no names the page could have asked for.**
   First-contact nodes carry IP multiaddrs only (`MESH_INTERFACE → Discovery → "First contact."` refuses `/dns4/`,
   `/dns6/` and `/dnsaddr/`), so the only hostnames the page could have asked for are a STUN
   host, a relay host, or a name a probe path carried. `tail stage/out/dns.log` through the whole
   Firefox run. **Fails** on any line whose `name` is a STUN host, a relay host, or any name
   that is not one of Firefox's own services — the browser's own lookups seen live on the stage
   in a Firefox 157 run are `services.addons.mozilla.org`, `aus5.mozilla.org`,
   `ciscobinary.openh264.org` and `update.googleapis.com` (the last two are its video-codec
   plugin updater). Firefox may resolve over DNS-over-HTTPS in the tester's region, in which
   case its lookups never reach `dns.log` — also open `about:networking#dns` in the same
   Firefox window and read the DNS entries list. **Fails** if that list carries any STUN or
   relay host.

### What to report

A note per check with the measurement that fired the verdict (the `#state` payload, the two
sha256s, the `dns.log` tail), and the Firefox version string
(`sudo ip netns exec notismesh-browser sudo -u "$USER" /usr/bin/firefox --version`). An
unexpected failure gets its full `#state` and the browser's console tab's text.

## Safari

Not run. Safari does not run on the stage's machine; it is recorded as untested.
