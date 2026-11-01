# mesh-poc — a tester's manual

A browser page reaches a Notis node's HTTP API **by the node's Ed25519 key**, over libp2p, from a
handful of anchors and **no DNS name**, with mesh nodes sitting beside unmodified devnet
`@dagsocial/node`s — the client's answer is the node's own, byte for byte. The stage runs the whole
machinery inside Linux network namespaces on one host and the seven scenarios in
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
| 2 | A client refuses an anchor address with a `/dns4/`, `/dns6/` or `/dnsaddr/` component. | `MESH_INTERFACE → Discovery → "Anchors."` |
| 3 | A browser dials a public node over WebRTC-direct; the address carries the certificate's hash. | `MESH_INTERFACE → Transports` |
| 4 | A browser reaches a private node over WebRTC signalled through a circuit relay. | `MESH_INTERFACE → NAT` |
| 5 | A relay carries data — a node a client has no direct path to is reached through the relay, data relayed, with no limit. | `MESH_INTERFACE → NAT → "A relay carries data"` |
| 6 | Every link is authenticated by the key it was dialled for; a key mismatch is refused at the link. | `MESH_INTERFACE → Transports → "Every link is authenticated by the key it was dialled for."` |
| 7 | A page under UDP-blocked conditions moves to secure WebSocket on an opted-in node's bare-IP certificate. | `MESH_INTERFACE → The IP certificate` |
| 8 | Every STUN server is a mesh node named by IP, drawn from the public nodes the client holds. | `MESH_INTERFACE → NAT → "A client's STUN list comes from the public nodes it holds"` |
| 9 | With no anchor reached, the page says, in these words: `No anchor reached. Nothing shown here is verified.` | `MESH_INTERFACE → No anchor reached` |
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
- A client that carries on silently when it reached no anchor
  (`MESH_INTERFACE → No anchor reached`).
- A blacklist that writes a node off for not answering — a timeout stays `retry`
  (`MESH_INTERFACE → The client's node list`).

## The stage

Linux network namespaces named `notismesh-<host>`. One namespace per host, bridged into one
internet segment at `11.100.0.0/24`, with two NAT routers wrapping endpoint-independent and
symmetric sub-segments (`stage/topology.json`):

| Host | Role | Address |
|---|---|---|
| pub1 | public mesh node + Notis node (miner) | `11.100.0.11` |
| pub2 | public mesh node + Notis node | `11.100.0.12` |
| pebble | ACME test server | `11.100.0.21` |
| dns-log | REFUSED resolver + DNS witness | `11.100.0.22` |
| hostile-malformed | mesh node forwarding a non-hex `proof` | `11.100.0.31` |
| hostile-invalid | mesh node forwarding a `verifyProof`-refusing proof | `11.100.0.32` |
| hostile-lagging | mesh node whose Notis p2p port is cut post-sync | `11.100.0.33` |
| natA | endpoint-independent NAT router (public `11.100.0.101`, inside `10.101.0.0/24`) | — |
| priv1 | private mesh node + Notis node behind natA | `10.101.0.11` |
| natB | symmetric NAT router (public `11.100.0.102`, inside `10.102.0.0/24`) | — |
| priv2 | private mesh node + Notis node behind natB | `10.102.0.11` |
| natC | endpoint-independent NAT router (public `11.100.0.103`, inside `10.103.0.0/24`) | — |
| browser | Chromium under `--host-resolver-rules=MAP * ~NOTFOUND` behind natC | `10.103.0.11` |
| lan1 | private mesh node + Notis node beside the browser, on natC's inside bridge | `10.103.0.21` |

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
timeout  2h  pnpm --filter @dagsocial/mesh-poc stage:run       # or stage:run s1 s2 ... s7
timeout  1m  pnpm --filter @dagsocial/mesh-poc stage:report
timeout  5m  pnpm --filter @dagsocial/mesh-poc stage:down
```

- `pnpm -r build` builds every workspace member; the mesh-poc node binaries land at
  `tools/mesh-poc/dist/node/{main,mesh-key-tool}.js`.
- `pnpm --filter @dagsocial/mesh-poc page:build` writes the browser page to
  `tools/mesh-poc/dist-page/` (vite). `stage/page-server.mjs` serves this directory and splices
  `stage/out/browser/config.json` at `/config.json`.
- **`stage:up`** rotates `stage/out/` to `stage/out.prev/` (replacing any older `.prev`), creates
  every namespace and NAT rule, lifts `net.ipv4.ip_unprivileged_port_start=0` in the browser,
  dns-log and pub1 namespaces, writes `/etc/netns/notismesh-browser/resolv.conf` with the dns-log
  address, creates each mesh node's `mesh.key` (PKCS8 Ed25519 seed, 48 bytes, mode `0600`),
  downloads Pebble and generates a stage CA + Pebble server cert, starts the dns-log server, each
  Notis node, each mesh node (public first; private second — their relay reservations land on the
  publics that are up), the miner inside pub1 at `MINER_PCT=100` until every honest node reads
  `/blocks/current.height >= 50`, then the steady miner at `MINER_PCT=10`, cuts hostile-lagging's
  Notis p2p port from the rest, writes `stage/out/browser/config.json` and
  `stage/out/browser/config.default.json` from the mesh nodes' printed multiaddrs, writes
  `stage/out/identities.json`, installs Pebble's root into Chromium's NSS db under
  `stage/out/browser/home/.pki/nssdb` with trust flag `C,,`, starts the page server on
  `http://localhost:80/` inside the browser namespace, launches Chromium headless with
  `--remote-debugging-port=9222` and `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost ,
  EXCLUDE 11.100.0.*`, confirms every recorded PID is alive, and prints
  `stage up: <N> processes, <M> namespaces`. On failure it rolls back exactly what it created
  (SIGTERMs each recorded PID, deletes each namespace in reverse order, removes
  `/etc/netns/notismesh-*`).
- **`stage:run [s1 ... s7]`** runs the named scenarios in the order given (default: all seven).
  Writes `stage/out/scenarios/<name>.json` per scenario: `{ scenario, startedAt, endedAt, steps,
  faults }`, each step `{ name, verdict, measurement, timeMs }`. **A step that times out or throws
  is `FAIL`; the scenario's faults are removed and the run goes on. A step that did not run reads
  `skipped`, never a pass.** Each scenario writes its own `config.json` variant at start, so the
  previous scenario's variant does not leak; the scenario's `finally` restores
  `config.default.json`. Non-zero exit when any step is `FAIL`.
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
stage/out/<host>/mesh.key         each mesh node's PKCS8 Ed25519 seed, mode 0600
stage/out/<host>/<tag>.log        per-host, per-process log (notis, mesh, miner-steady, …)
stage/out/scenarios/<s>.json      one per scenario stage:run touched
stage/out/summary.md              stage:report's build
```

`stage/cache/` holds the pinned Pebble tarball and the extracted binary. **`stage:down` removes
only `stage/out/pids.json`** — every other file under `stage/out/` stays, for a reader to pick
over after a run; the next `stage:up` rotates the whole `stage/out/` directory to
`stage/out.prev/` (replacing any older `.prev`) at its start.

## The seven scenarios

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

Four sub-steps against pub1's mesh node, driving the client's `CHECK_INTERVAL_MS` (30 000 ms) and
the retry cadence by hand.

| # | Step | Pass condition | What breaks it |
|---|---|---|---|
| 1 | `pub1 stopped: client moves to another node within 2 checks, pub1 retry` | pub1's entry reads `retry`; the latest routed read (`state.nodeId`) is not pub1 and not null; movement within `2 · CHECK_INTERVAL_MS`. | pub1 `blacklisted`; routed reads stuck on pub1; no movement past two checks. |
| 2 | `pub1 restarted: pub1 reads at or one block short of the tip at the next completed check` | After waiting until pub1's own `/blocks/current` is within one block of pub2's, the next completed check reads pub1 as `ok` with `behindBy === 0`, or `trailing` with `behindBy === 1`; `recoveryTimeMs` is recorded. | pub1 `retry` or `blacklisted` at the check; `ok` with a non-zero `behindBy`; `trailing` with any other distance. |
| 3 | `pub1 firewalled: client moves to another node within 2 checks, pub1 retry` | Same as step 1, with nft rules dropping UDP/TCP to pub1's mesh listener in pub1's namespace. | As step 1. |
| 4 | `pub1 unfirewalled: pub1 reads at or one block short of the tip at the next completed check` | Same as step 2. | As step 2. |

**What a tester reports even on PASS:** pub1 reaching `blacklisted` at any point — a timeout, a
refused connection, a dropped link or a non-2xx is `retry`, never permanent
(`MESH_INTERFACE → The client's node list`).

### s4 — A transport is cut (`MESH_INTERFACE → Acceptance 4`)

Four sub-steps against UDP from the browser namespace, then TCP between the Notis nodes.

| # | Step | Pass condition | What breaks it |
|---|---|---|---|
| 1 | `UDP to pub1 cut: client gets in through another public mesh node` | `connected === true`; either `nodeId !== pub1` or `nodeId === pub1 && transport === 'wss'`. | Neither path. |
| 2 | `UDP to every public node cut: client connects over WSS to pub1 with the Pebble-issued cert` | `transport === 'wss'`, `nodeId === pub1`, the TLS issuer name read from `openssl s_client` inside the browser namespace contains `Pebble`. | A non-WSS transport; a different issuer. |
| 3 | `across one renewal the probes keep succeeding, no lastLeft names a failure` | Pebble log shows at least one renewal across the 240 000 ms window; the client was connected over WSS at the window boundary and at its end; no `state.lastLeft.reason` named `timeout`/`refused`/`dropped`/`transport`/`lie`/`malformed`/`proof-invalid` in the window. **Positive evidence required**: `connectedBeforeWindow === true` and `connectedAfterWindow === true`. | A dropped request named by `lastLeft.reason`; no renewal in the Pebble log; a window boundary with no connection. |
| 4 | `TCP between the Notis nodes p2p port cut: record what still answers` | After one `CHECK_INTERVAL_MS` the page's `state.transport` and `state.nodeId` are both non-null. | Neither field settled. |

**What a tester reports:** a renewal step whose window held no renewal, or a
`connectedBeforeWindow` or `connectedAfterWindow` that is not `true`, reads FAIL — report the
step's measurement from `stage/out/scenarios/s4.json` when it does, so the next run's window can
be widened.

### s5 — Impersonation (`MESH_INTERFACE → Acceptance 5`)

One step with four measurements. Stop pub1's mesh node; spawn an impostor whose state dir is a
byte-for-byte copy of pub1's **except for a fresh `mesh.key`** — same WebRTC-direct certificate,
different Ed25519 identity. Bind pub1's address.

| # | Step | Pass condition | What breaks it |
|---|---|---|---|
| 1 | `impostor on pub1 address: refused at the link, address dropped, anchor not blacklisted` | pub1's entry carries pub1's own address in `droppedAddrs`; `status !== 'blacklisted'`. | pub1 `blacklisted`; pub1's address not in `droppedAddrs`. |

**What this holds** (`MESH_INTERFACE → Transports → "Every link is authenticated by the key it was
dialled for."`): libp2p's Noise handshake over WebRTC binds the DTLS certificates to the two keys,
so a node whose key is not the one dialled is refused at the link whatever certificate it holds.
The anchor's address is dropped for that key; the anchor keeps its status.

### s6 — Hostile nodes (`MESH_INTERFACE → Acceptance 6`)

Two sub-steps.

| # | Step | Pass condition | What breaks it |
|---|---|---|---|
| 1 | `anchors unreachable: anchorReached is false, page shows the contract words` | nft rules in the browser namespace drop every anchor address; `state.anchorReached === false`; the page's `[data-role="banner"]` reads `No anchor reached. Nothing shown here is verified.` byte for byte; **at least one hostile seed** reached a terminal status (`ok` / `behind` / `blacklisted`) — positive evidence the page connected to something. | A different banner text; `anchorReached: true`; no seed left `new`. |
| 2 | `anchors reachable, hostile seeds kept: malformed and invalid blacklisted; lagging behind, not blacklisted` | `hostile-malformed` → `blacklisted`, evidence `malformed`; `hostile-invalid` → `blacklisted`, evidence `proof-invalid`; `hostile-lagging` → `behind`, never `blacklisted`. | Any of those three not landing. |

**What a tester reports even on PASS:** the hostile-lagging node at `blacklisted` at any point —
a timeout, a refused connection, a dropped link or a non-2xx is `retry`, and a valid proof of a
lighter chain is `behind`; neither is `blacklisted` (`MESH_INTERFACE → The client's node list`).

### s7 — Reach and load (`MESH_INTERFACE → Acceptance 7`)

Four sub-steps that drive routed reads, a slowed node, a node on the browser's own network and
the agreement counts.

| # | Step | Pass condition | What breaks it |
|---|---|---|---|
| 1 | `older reads spread across ≥ 2 nodes; tip reads only on ok nodes` | `?reads=20&need=older` names at least two distinct serving nodes; every tip read from `?reads=10&need=tip` was served by a node reading `ok` at that read. | Older reads all on one node; a tip read served by a node not `ok` at that read. |
| 2 | `pub2 delayed 200ms serves no read` | A `tc qdisc add dev <pub2 outside peer> root netem delay 200ms` is applied inside `notismesh-pub2`; after one completed check `?reads=20&need=older` names no read served by pub2. | Any read served by pub2 after the delay lands. |
| 3 | `lan1 is never dialled from a seed; by hand it is reached, anchorReached follows the trusted flag` | Three phases: (a) with lan1 named only as a seed, over two completed checks lan1 never holds a connection AND lan1's mesh log holds no inbound from `10.103.0.11`; (b) with no anchors and `byHand: [lan1, trusted:true]`, lan1 reads `ok` or `trailing` over `webrtc-direct`, `path: direct`, `anchorReached: true`; (c) the same with `trusted: false` → `anchorReached: false`. | A connection to lan1 in the seed phase; a dial from the browser logged on lan1's mesh node; a hand-added `anchorReached` reading other than the trusted flag's value. |
| 4 | `the agreement counts hold agreeing ≥ 2 and agreeingAnchors ≥ 1` | After a completed check on the stage default: `state.agreement.agreeing ≥ 2` AND `state.agreement.agreeingAnchors ≥ 1`. | A count below either threshold; a check that never completed (`agreement: null`). |

**A node on the browser's own network comes in by the reader's hand**
(`MESH_INTERFACE → Discovery → "A node added by hand"`): the client dials a private address only
when its own configuration names it — an anchor's address or one the reader entered by hand, each
for its key; a private address a remote node offers through the DHT, a peer list or a seed is
refused.

**STUN by default** (`MESH_INTERFACE → NAT → "A node's role is its operator's setting"`): a
public node runs a STUN server on `STUN_PORT` at the IP of its first WebRTC-direct listen
address unless its operator names another or turns it off; the client's ICE list is derived
from the public nodes it holds.

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
   Anchors carry IP multiaddrs only (`MESH_INTERFACE → Discovery → "Anchors."` refuses `/dns4/`,
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
