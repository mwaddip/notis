// MESH_INTERFACE → Acceptance — "a step that did not run — or ran and
// recorded nothing — reads `skipped`, never `PASS`". One verdict function
// per step, each a pure function of the step's recorded measurement. A
// measurement of `null` or `undefined` reads as `skipped`; the step has
// to supply every field the pass condition names, and every condition in
// the function has to hold for `PASS`. One pass condition deleted alone
// turns the step's own case red (CLAUDE.md → Comment style — Mutation
// round on the verdict functions).
//
// Shape of a verdict:
//   verdict(measurement) → 'PASS' | 'FAIL' | 'skipped'

/**
 * A step that did not record a measurement — the scenario did not reach
 * it, or exec was skipped (dry-run) — reads `skipped`. The measurement
 * is `null`, `undefined`, or an empty object literal. Any other shape
 * is a real measurement whose fields are read below.
 */
function missing(m) {
  if (m === null || m === undefined) return true;
  if (typeof m !== 'object') return false;
  for (const _ of Object.keys(m)) return false;
  return true;
}

// MESH_INTERFACE → Acceptance 1 — "the client reads a node's API by key
// from anchors alone, over WebRTC-direct". Scenario 1 step 1: within
// 60 s the client's state has an `anchor` node in use, reached over
// WebRTC-direct with a direct path.
// Measurement:
//   `{ nodeId: string|null, isAnchor: boolean, timeMs: number,
//      transport: string, path: string }`.
export function verdictS1Node(m) {
  if (missing(m)) return 'skipped';
  if (typeof m.nodeId !== 'string') return 'FAIL';
  if (m.isAnchor !== true) return 'FAIL';
  if (typeof m.timeMs !== 'number' || m.timeMs > 60_000) return 'FAIL';
  if (m.transport !== 'webrtc-direct') return 'FAIL';
  if (m.path !== 'direct') return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 1 — "the mesh's answers equal the node's
// direct HTTP answers byte for byte". Scenario 1 step 2: for each probed
// path, the SHA-256 and byte length the page recorded equal the node's
// own HTTP answer. `/blocks/current` moves between reads at mining
// speed, so the probe is bracketed between a pre-probe direct read
// and a post-probe direct read; the probe is valid if it equals
// EITHER (the chain moved after the first read, or the probe caught
// an older tip the second direct read sees past). Legacy
// `{ direct, retryDirect }` is accepted for the proof route whose
// shape stays "direct, then one retry".
export function verdictS1Probe(m) {
  if (missing(m)) return 'skipped';
  const probe = m.probe;
  if (probe === null || probe === undefined) return 'FAIL';
  if (typeof probe.sha256 !== 'string' || typeof probe.bytes !== 'number') return 'FAIL';
  const matches = (d) =>
    d !== null && d !== undefined &&
    typeof d.sha256 === 'string' && typeof d.bytes === 'number' &&
    d.sha256 === probe.sha256 && d.bytes === probe.bytes;
  // Preferred shape: `{ directBefore, directAfter }` — the probe is
  // valid if it equals either bracket.
  if (m.directBefore !== undefined || m.directAfter !== undefined) {
    if (matches(m.directBefore)) return 'PASS';
    if (matches(m.directAfter)) return 'PASS';
    return 'FAIL';
  }
  // Legacy shape: `{ direct, retryDirect? }`.
  const direct = m.direct;
  if (direct === null || direct === undefined) return 'FAIL';
  if (matches(direct)) return 'PASS';
  if (matches(m.retryDirect)) return 'PASS';
  return 'FAIL';
}

// MESH_INTERFACE → Acceptance 1 — "the browser host's DNS log holds no
// query ... anything there went around the browser's resolver". The
// clean scenario-1 run leaves `stage/out/dns.log` with no new line and
// the browser namespace's nft DNS counter unmoved — AND the page did
// reach a node inside the window: a page that never connected has no
// DNS traffic vacuously, which is not evidence of the property.
// Measurement:
//   `{ dnsLines: number, nftCounterPackets: number, connected: boolean }`.
export function verdictS1DnsSilent(m) {
  if (missing(m)) return 'skipped';
  if (m.connected !== true) return 'FAIL';
  if (typeof m.dnsLines !== 'number' || m.dnsLines !== 0) return 'FAIL';
  if (typeof m.nftCounterPackets !== 'number' || m.nftCounterPackets !== 0) return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → NAT — "every STUN server is a mesh node named by
// IP"; a client refuses a hostname. The record is a list of
// `{ urls: string[] }`, one entry per `RTCPeerConnection` the page
// built. The verdict:
//   `PASS` when at least one PC was recorded AND every URL matches
//        `stun:<IPv4>:<port>` or `stun:[<IPv6>]:<port>` (a PC built
//        with no URL is one empty bucket — still a record, and reads
//        PASS since every URL of an empty set is vacuously an IP STUN
//        URL);
//   `FAIL` on any other URL;
//   `skipped` when nothing was recorded.
const STUN_IPV4_RE = /^stun:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5})$/;
const STUN_IPV6_RE = /^stun:\[([0-9a-fA-F:]+)\]:(\d{1,5})$/;

export function verdictIceServers(record) {
  if (record === null || record === undefined) return 'skipped';
  if (!Array.isArray(record)) return 'FAIL';
  if (record.length === 0) return 'skipped';
  for (const entry of record) {
    if (entry === null || typeof entry !== 'object') return 'FAIL';
    const urls = entry.urls;
    if (!Array.isArray(urls)) return 'FAIL';
    for (const u of urls) {
      if (typeof u !== 'string') return 'FAIL';
      const ipv4 = STUN_IPV4_RE.exec(u);
      if (ipv4) {
        const port = Number(ipv4[2]);
        if (port >= 0 && port <= 65_535) continue;
        return 'FAIL';
      }
      const ipv6 = STUN_IPV6_RE.exec(u);
      if (ipv6) {
        const port = Number(ipv6[2]);
        if (port >= 0 && port <= 65_535) continue;
        return 'FAIL';
      }
      return 'FAIL';
    }
  }
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 2 / NAT — "A browser reaches the node
// behind the endpoint-independent NAT over WebRTC signalled through a
// relay, its data direct, its ICE servers drawn from the public nodes
// it holds". priv1's step writes a variant whose anchor is priv1
// reached through a public node's `/p2p-circuit/webrtc` address,
// polls the page for priv1's entry answering (`status` ok, trailing
// or behind — all three say a checked answer came back; `trailing`
// and `behind` are ranking, not reach) with a non-null entry
// transport. The reach criterion: priv1's status is ok, trailing or
// behind, the entry's transport is webrtc with path direct, the
// anchor address holds `/p2p-circuit/webrtc`, and the ICE record
// passes the IP-only rule. `nodeIdInUse` and `priv1Failures` are
// recorded for the reader, not conditions — priv1 may rank below pub1
// and still be reached.
// Measurement:
//   `{ expectedNodeId, priv1Status, priv1Failures,
//      transport, path, anchorAddrRelayed,
//      connectMs: number, iceServers: Array<{ urls: string[] }>,
//      nodeIdInUse: string | null }`.
export function verdictS2Priv1(m) {
  if (missing(m)) return 'skipped';
  if (typeof m.expectedNodeId !== 'string') return 'FAIL';
  if (m.priv1Status !== 'ok' && m.priv1Status !== 'trailing' && m.priv1Status !== 'behind') return 'FAIL';
  if (m.transport !== 'webrtc') return 'FAIL';
  if (m.path !== 'direct') return 'FAIL';
  if (typeof m.anchorAddrRelayed !== 'string') return 'FAIL';
  if (!m.anchorAddrRelayed.includes('/p2p-circuit/webrtc')) return 'FAIL';
  if (typeof m.connectMs !== 'number') return 'FAIL';
  if (verdictIceServers(m.iceServers) !== 'PASS') return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 2 / NAT → "A relay carries data" — "The
// node behind the symmetric NAT has no direct path to the browser
// behind its NAT: it is reached through the relay, its data relayed;
// it reads `ok` or `trailing`, never `blacklisted`, and a routed
// read lands on it." The scenario waits for a routed read to land on
// priv2 and reads the entry's path and status.
// Measurement:
//   `{ expectedNodeId, priv2Status, priv2Path, latestReadNodeId,
//      blacklistedAtAnyPoll }`.
export function verdictS2Priv2(m) {
  if (missing(m)) return 'skipped';
  if (typeof m.expectedNodeId !== 'string') return 'FAIL';
  if (m.priv2Status !== 'ok' && m.priv2Status !== 'trailing') return 'FAIL';
  if (m.priv2Path !== 'relay') return 'FAIL';
  if (m.latestReadNodeId !== m.expectedNodeId) return 'FAIL';
  if (m.blacklistedAtAnyPoll !== false) return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 3 — "The client moves to another node
// within two checks, the node reads `retry`, never `blacklisted`".
// Scenario 3's four sub-steps share a verdict for `moved + status`.
// Measurement:
//   `{ newNodeId: string, oldNodeId: string, oldStatus: 'retry'|'ok'|'blacklisted'|...,
//      movedWithinChecks: number, checkIntervalMs: number }`.
export function verdictS3Moved(m) {
  if (missing(m)) return 'skipped';
  if (typeof m.newNodeId !== 'string') return 'FAIL';
  if (typeof m.oldNodeId !== 'string' || m.newNodeId === m.oldNodeId) return 'FAIL';
  if (m.oldStatus !== 'retry') return 'FAIL';
  if (typeof m.movedWithinChecks !== 'number' || m.movedWithinChecks > 2) return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 3 — "once it is back and within a block
// of the tip, the next check reads it by its tip — `ok` at the tip,
// `trailing` one block short". `ok` requires `behindBy === 0`;
// `trailing` requires `behindBy === 1`; any other pair, `retry` or
// `blacklisted` fails.
// Measurement: `{ nodeId, status, behindBy, recoveryTimeMs }`.
export function verdictS3Recovered(m) {
  if (missing(m)) return 'skipped';
  if (typeof m.nodeId !== 'string') return 'FAIL';
  if (typeof m.recoveryTimeMs !== 'number') return 'FAIL';
  if (m.status === 'ok' && m.behindBy === 0) return 'PASS';
  if (m.status === 'trailing' && m.behindBy === 1) return 'PASS';
  return 'FAIL';
}

// MESH_INTERFACE → Acceptance 4 — "UDP to one public node: the client
// stays connected, through another node or over that node's secure
// WebSocket — whichever ranks first". PASS when the client is
// connected AND the connection to the blocked node (if any) is not
// over UDP. Measurement:
//   `{ connected: boolean, nodeId: string, blockedNodeId: string, transport: string }`.
export function verdictS4Pub1UdpDrop(m) {
  if (missing(m)) return 'skipped';
  if (m.connected !== true) return 'FAIL';
  if (typeof m.nodeId !== 'string' || typeof m.blockedNodeId !== 'string') return 'FAIL';
  if (m.nodeId !== m.blockedNodeId) return 'PASS';
  // The client stayed on the blocked node — PASS only if the link is
  // the WSS one (TCP), FAIL if it is still webrtc-direct / webrtc.
  if (m.transport === 'wss') return 'PASS';
  return 'FAIL';
}

// MESH_INTERFACE → Acceptance 4 — "UDP to all: through the secure
// WebSocket; a renewal replaces the certificate with no request
// dropped". Measurement:
//   `{ transport: 'wss', nodeId: string, expectedNodeId: string,
//      certIssuerName: string, expectedIssuerName: string }`.
export function verdictS4AllUdpDrop(m) {
  if (missing(m)) return 'skipped';
  if (m.transport !== 'wss') return 'FAIL';
  if (typeof m.nodeId !== 'string' || m.nodeId !== m.expectedNodeId) return 'FAIL';
  if (typeof m.certIssuerName !== 'string' || m.certIssuerName !== m.expectedIssuerName) return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → The IP certificate — "a renewal replaces the
// certificate with no request dropped": across one renewal the page's
// probes keep succeeding and `lastLeft` does not name a failure. A page
// that never connected has no `lastLeft` to name a failure (vacuously
// true), so this verdict requires positive evidence: a node was in use
// BEFORE the renewal window AND after.
// Measurement:
//   `{ renewalSeen: boolean, probeSuccessAcrossRenewal: boolean,
//      lastLeftFailure: boolean,
//      connectedBeforeWindow: boolean, connectedAfterWindow: boolean }`.
export function verdictS4Renewal(m) {
  if (missing(m)) return 'skipped';
  if (m.renewalSeen !== true) return 'FAIL';
  if (m.probeSuccessAcrossRenewal !== true) return 'FAIL';
  if (m.lastLeftFailure !== false) return 'FAIL';
  if (m.connectedBeforeWindow !== true) return 'FAIL';
  if (m.connectedAfterWindow !== true) return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 5 — "A node with its own key and a copy of
// an anchor's certificate, at the anchor's address: refused at the
// link, that address dropped, the anchor not blacklisted". The honest
// anchor's status may be `ok`, `trailing`, `retry` or `behind` — never
// `blacklisted`.
// Measurement:
//   `{ anchorStatus: 'ok'|'trailing'|'retry'|'behind', droppedAddrs: string[], blockedAddr: string }`.
export function verdictS5(m) {
  if (missing(m)) return 'skipped';
  if (m.anchorStatus === 'blacklisted') return 'FAIL';
  if (!Array.isArray(m.droppedAddrs)) return 'FAIL';
  if (typeof m.blockedAddr !== 'string') return 'FAIL';
  if (!m.droppedAddrs.includes(m.blockedAddr)) return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 6 — "With every anchor out of reach,
// `anchorReached` is false and the page says so". The property is "a
// client talking to hostile nodes alone says no anchor was reached", so
// PASS requires positive evidence that at least one seed answered
// inside the window (its entry left `new` for `ok`, `behind` or
// `blacklisted`). A page that reached NOTHING — anchors blocked and
// seeds never dialled, which the stage's broken page would also show —
// would otherwise read PASS vacuously.
// Measurement:
//   `{ anchorReached: boolean, bannerText: string|null,
//      seedAnswered: boolean, seedId: string|null, seedStatus: string|null }`.
export function verdictS6NoAnchor(m) {
  if (missing(m)) return 'skipped';
  if (m.anchorReached !== false) return 'FAIL';
  if (m.bannerText !== 'No anchor reached. Nothing shown here is verified.') return 'FAIL';
  if (m.seedAnswered !== true) return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 6 — "A node answering malformed proofs
// and one answering failing proofs are blacklisted with their evidence;
// a node serving a valid proof of a lighter chain is `behind`".
// Measurement:
//   `{ malformed: { status, evidenceKind }, invalid: { status, evidenceKind },
//      lagging: { status, blacklisted } }`.
export function verdictS6Hostile(m) {
  if (missing(m)) return 'skipped';
  if (m.malformed?.status !== 'blacklisted') return 'FAIL';
  if (m.malformed?.evidenceKind !== 'malformed') return 'FAIL';
  if (m.invalid?.status !== 'blacklisted') return 'FAIL';
  if (m.invalid?.evidenceKind !== 'proof-invalid') return 'FAIL';
  if (m.lagging?.status !== 'behind') return 'FAIL';
  if (m.lagging?.blacklisted !== false) return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 4 — "A transport is cut" step 4: "record
// what still answers" after the inter-node Notis-p2p TCP is cut. The
// browser's state is read after a check cycle fires on the cut, and the
// verdict is PASS when the record carries a `nodeId` and a `transport`
// — never on an empty read.
// Measurement: `{ transport, nodeId, tip }`.
export function verdictS4InterNodeTcp(m) {
  if (missing(m)) return 'skipped';
  if (typeof m.nodeId !== 'string') return 'FAIL';
  if (typeof m.transport !== 'string') return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 7 — "Reads that may go to several nodes
// spread across them; a read that needs the tip goes to an `ok` node
// alone". PASS when the older reads name ≥ 2 distinct nodes and
// every tip read's serving node was `ok` at that read.
// Measurement:
//   `{ olderServed: Array<{ nodeId: string | null }>,
//      tipServed: Array<{ nodeId: string | null, statusAtRead: string | null }> }`.
export function verdictS7Spread(m) {
  if (missing(m)) return 'skipped';
  if (!Array.isArray(m.olderServed)) return 'FAIL';
  if (!Array.isArray(m.tipServed)) return 'FAIL';
  const olderIds = new Set();
  for (const e of m.olderServed) {
    if (e !== null && typeof e === 'object' && typeof e.nodeId === 'string') olderIds.add(e.nodeId);
  }
  if (olderIds.size < 2) return 'FAIL';
  for (const e of m.tipServed) {
    if (e === null || typeof e !== 'object') return 'FAIL';
    if (typeof e.nodeId !== 'string') return 'FAIL';
    if (e.statusAtRead !== 'ok') return 'FAIL';
  }
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 7 — "a node slowed well past the others
// serves no read". PASS when the `delayedNodeId` serves none of the
// recorded reads.
// Measurement: `{ delayedNodeId: string, served: Array<{ nodeId: string | null }> }`.
export function verdictS7Fastest(m) {
  if (missing(m)) return 'skipped';
  if (typeof m.delayedNodeId !== 'string') return 'FAIL';
  if (!Array.isArray(m.served)) return 'FAIL';
  if (m.served.length === 0) return 'FAIL';
  for (const e of m.served) {
    if (e === null || typeof e !== 'object') return 'FAIL';
    if (e.nodeId === m.delayedNodeId) return 'FAIL';
  }
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 7 — "A node on the browser's own
// network, named only by a seed, is never dialled; added by hand, it
// is reached at its private address, and `anchorReached` reads true
// from it alone when the reader trusts it and false when the reader
// does not." Three measurements combined:
//   seedPhase: lan1 never holds a connection (`transport === null` at
//     every poll) AND the mesh log shows no inbound connection from
//     `10.103.0.11` (the browser's address).
//   trustedPhase: lan1 reads `ok` or `trailing` over `webrtc-direct`,
//     `path: direct`, `anchorReached: true`.
//   untrustedPhase: lan1 reads `ok` or `trailing` over `webrtc-direct`,
//     `path: direct`, `anchorReached: false`.
// Measurement: `{ seedPhase, trustedPhase, untrustedPhase }`.
export function verdictS7Lan(m) {
  if (missing(m)) return 'skipped';
  const seed = m.seedPhase;
  if (seed === null || typeof seed !== 'object') return 'FAIL';
  if (seed.lan1EverConnected !== false) return 'FAIL';
  if (seed.lan1InboundLogged !== false) return 'FAIL';
  const okOrTrailing = (s) => s === 'ok' || s === 'trailing';
  const trusted = m.trustedPhase;
  if (trusted === null || typeof trusted !== 'object') return 'FAIL';
  if (!okOrTrailing(trusted.lan1Status)) return 'FAIL';
  if (trusted.transport !== 'webrtc-direct') return 'FAIL';
  if (trusted.path !== 'direct') return 'FAIL';
  if (trusted.anchorReached !== true) return 'FAIL';
  const untrusted = m.untrustedPhase;
  if (untrusted === null || typeof untrusted !== 'object') return 'FAIL';
  if (!okOrTrailing(untrusted.lan1Status)) return 'FAIL';
  if (untrusted.transport !== 'webrtc-direct') return 'FAIL';
  if (untrusted.path !== 'direct') return 'FAIL';
  if (untrusted.anchorReached !== false) return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 7 / No anchor reached → "The agreement
// counts" — "The page shows the agreement counts." PASS when
// `agreeing >= 2` and `agreeingAnchors >= 1` after a completed
// check.
// Measurement: `{ agreeing, agreeingAnchors, notAgreeing }`.
export function verdictS7Counts(m) {
  if (missing(m)) return 'skipped';
  if (typeof m.agreeing !== 'number' || m.agreeing < 2) return 'FAIL';
  if (typeof m.agreeingAnchors !== 'number' || m.agreeingAnchors < 1) return 'FAIL';
  return 'PASS';
}
