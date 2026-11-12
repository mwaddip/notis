// MESH_INTERFACE → Acceptance — a step that did not run reads
// `skipped`, never a pass. One verdict function per step, each a pure
// function of the step's recorded measurement. A measurement of `null`
// or `undefined` reads as `skipped`; the step has to supply every
// field the pass condition names, and every condition in the function
// has to hold for `PASS`. One pass condition deleted alone turns the
// step's own case red.
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

// MESH_INTERFACE → Acceptance 1 — "The client reads a node's API by
// key from its first-contact nodes alone, over WebRTC-direct".
// Scenario 1 step 1: within 60 s the latest routed read went to a
// first-contact node, reached over WebRTC-direct with a direct path.
// Measurement:
//   `{ nodeId: string|null, isFirstContact: boolean, timeMs: number,
//      transport: string, path: string }`.
export function verdictS1Node(m) {
  if (missing(m)) return 'skipped';
  if (typeof m.nodeId !== 'string') return 'FAIL';
  if (m.isFirstContact !== true) return 'FAIL';
  if (typeof m.timeMs !== 'number' || m.timeMs > 60_000) return 'FAIL';
  if (m.transport !== 'webrtc-direct') return 'FAIL';
  if (m.path !== 'direct') return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 1 — "the mesh's answers equal the node's
// direct HTTP answers byte for byte". Scenario 1 step 2: for each
// probed path, the SHA-256 and byte length the page recorded equal the
// node's own HTTP answer. `/blocks/current` moves between reads at
// mining speed, so the probe is bracketed between a pre-probe direct
// read and a post-probe direct read; the probe is valid if it equals
// EITHER (the chain moved after the first read, or the probe caught
// an older tip the second direct read sees past). Legacy
// `{ direct, retryDirect }` is accepted for the proof route whose
// shape is a direct read followed by one retry.
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

// MESH_INTERFACE → NAT — "Every STUN server is a mesh node named by
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

// MESH_INTERFACE → Acceptance 2 / NAT — "The browser reaches the node
// behind the endpoint-independent NAT over WebRTC signalled through a
// relay, its data direct, its ICE servers drawn from the public nodes
// it holds". priv1's step writes a variant whose first-contact entry
// is priv1 reached through a public node's `/p2p-circuit/webrtc`
// address, polls the page for priv1's entry answering (`status` ok,
// trailing or behind — all three say a checked answer came back;
// `trailing` and `behind` are ranking, not reach) with a non-null
// entry transport. The reach criterion: priv1's status is ok,
// trailing or behind, the entry's transport is webrtc with path
// direct, the relayed address holds `/p2p-circuit/webrtc`, and the
// ICE record passes the IP-only rule. `nodeIdInUse` and `priv1Failures`
// are recorded for the reader, not conditions — priv1 may rank below
// pub1 and still be reached.
// Measurement:
//   `{ expectedNodeId, priv1Status, priv1Failures,
//      transport, path, relayedAddr,
//      connectMs: number, iceServers: Array<{ urls: string[] }>,
//      nodeIdInUse: string | null }`.
export function verdictS2Priv1(m) {
  if (missing(m)) return 'skipped';
  if (typeof m.expectedNodeId !== 'string') return 'FAIL';
  if (m.priv1Status !== 'ok' && m.priv1Status !== 'trailing' && m.priv1Status !== 'behind') return 'FAIL';
  if (m.transport !== 'webrtc') return 'FAIL';
  if (m.path !== 'direct') return 'FAIL';
  const relayed = typeof m.relayedAddr === 'string' ? m.relayedAddr : m.firstContactAddrRelayed;
  if (typeof relayed !== 'string') return 'FAIL';
  if (!relayed.includes('/p2p-circuit/webrtc')) return 'FAIL';
  if (typeof m.connectMs !== 'number') return 'FAIL';
  if (verdictIceServers(m.iceServers) !== 'PASS') return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 2 / NAT → "A relay carries data" — the
// node behind the symmetric NAT has no direct path to the browser
// behind its NAT, so it is reached through the relay with its data
// relayed; the entry reads `ok` or `trailing`, never `retry` for want
// of a direct path, never `blacklisted`, and a routed read lands on
// it. The scenario waits for a routed read to land on priv2 and reads
// the entry's path and status.
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

// MESH_INTERFACE → Acceptance 3 — the client's reads move to other
// nodes within two checks, and the stopped node reads `retry`, never
// `blacklisted`. The step names pub1: pub1 is the node it stops (or
// firewalls), so the subject of the verdict is pub1's status and
// whether the latest
// routed read landed on another node. `verdictS3Moved` reads
// pub1's status (`stoppedStatus`) and the latest routed read's node
// (`latestReadNodeId`) separately: under the spread the latest read
// can sit on pub2 throughout, and the rule holds once pub1 reads
// `retry` and that read is not on pub1.
// Measurement:
//   `{ stoppedNodeId: string, stoppedStatus: 'retry'|'blacklisted'|...,
//      latestReadNodeId: string, movedWithinChecks: number }`.
export function verdictS3Moved(m) {
  if (missing(m)) return 'skipped';
  if (typeof m.stoppedNodeId !== 'string') return 'FAIL';
  if (m.stoppedStatus !== 'retry') return 'FAIL';
  if (typeof m.latestReadNodeId !== 'string' || m.latestReadNodeId === m.stoppedNodeId) return 'FAIL';
  if (typeof m.movedWithinChecks !== 'number' || m.movedWithinChecks > 2) return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 3 — "once it is back and within a block
// of the tip, the next check reads it by its tip — `ok` at the tip,
// `trailing` one block short." `ok` requires `behindBy === 0`;
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

// MESH_INTERFACE → Acceptance 3 — "With every first-contact node out
// of reach, a page that has connected before reaches the network
// through the nodes it remembers and reads its chain from them." Two
// sessions on the same browser profile:
//   (i)  session 1 (`?clearMemory=1`): first-contact reaches; the
//        page's memory record ends with at least one honest non-
//        first-contact node listed — the client's `onChecked` wrote
//        it after a check that read the node `ok`/`trailing`.
//   (ii) session 2 (no clear): every first-contact address is
//        dropped by an nft rule in the browser namespace; the client
//        reaches a remembered honest node and reads its chain —
//        `state.tip` non-null, a remembered node reads `ok` or
//        `trailing`, every first-contact entry reads `retry`, and
//        `notContinued` is false (the client's chain stands on the
//        remembered node's work).
// Measurement:
//   `{ firstContactIds: string[],
//      rememberedHonestIds: string[],              // session 1 memory
//      rememberedEntries: Array<{ notisId, status }>,
//      firstContactEntries: Array<{ notisId, status }>,
//      tipHeight: number | null,
//      tipHash: string | null,
//      notContinued: boolean }`.
export function verdictS3KnownNodes(m) {
  if (missing(m)) return 'skipped';
  if (!Array.isArray(m.firstContactIds) || m.firstContactIds.length < 1) return 'FAIL';
  if (!Array.isArray(m.rememberedHonestIds) || m.rememberedHonestIds.length < 1) return 'FAIL';
  if (!Array.isArray(m.rememberedEntries)) return 'FAIL';
  const anyReached = m.rememberedEntries.some(
    (e) => e !== null && typeof e === 'object' && (e.status === 'ok' || e.status === 'trailing'),
  );
  if (!anyReached) return 'FAIL';
  if (typeof m.tipHeight !== 'number' || m.tipHeight <= 0) return 'FAIL';
  if (typeof m.tipHash !== 'string' || !/^[0-9a-f]{64}$/.test(m.tipHash)) return 'FAIL';
  if (!Array.isArray(m.firstContactEntries) || m.firstContactEntries.length < 1) return 'FAIL';
  const allRetry = m.firstContactEntries.every(
    (e) => e !== null && typeof e === 'object' && e.status === 'retry',
  );
  if (!allRetry) return 'FAIL';
  if (m.notContinued !== false) return 'FAIL';
  return 'PASS';
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

// MESH_INTERFACE → Acceptance 4 — "UDP to all: the client gets in
// through the secure WebSocket; a renewal replaces the certificate
// with no request dropped." Measurement:
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

// MESH_INTERFACE → Acceptance 5 — "Impersonation. A node with its own
// key and a copy of a first-contact node's certificate, at that
// node's address: refused at the link, that address dropped, the node
// not blacklisted". The honest first-contact node's status may be
// `ok`, `trailing`, `retry` or `behind` — never `blacklisted`.
// Measurement:
//   `{ pub1Status: 'ok'|'trailing'|'retry'|'behind', droppedAddrs: string[], blockedAddr: string }`.
export function verdictS5(m) {
  if (missing(m)) return 'skipped';
  const status = m.pub1Status;
  if (status === 'blacklisted') return 'FAIL';
  if (typeof status !== 'string') return 'FAIL';
  if (!Array.isArray(m.droppedAddrs)) return 'FAIL';
  if (typeof m.blockedAddr !== 'string') return 'FAIL';
  if (!m.droppedAddrs.includes(m.blockedAddr)) return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 6 — "A page with an honest kept chain
// whose reachable nodes all serve the hostile chain keeps its own and
// says no node continues it." The step runs across two sessions on
// the same browser profile: a first page session on the honest nodes
// seats the kept proof in localStorage; a second session with every
// honest node out of reach and a hostile-fork node reachable as a
// known node reads `notContinued: true`, the page's banner words
// byte for byte, the chain the kept one, and the hostile-fork node
// `behind` and off the chain. Positive evidence: the hostile-fork
// node answered the second session (its status is `behind` and its
// tip hash differs from the kept tip).
// Measurement:
//   `{ firstSession: { keptChainHash: string },
//      secondSession: {
//        notContinued: boolean,
//        bannerText: string | null,
//        chainName: string,
//        forkEntry: { status: string, tipHash: string | null } | null,
//      } }`.
export function verdictS6NotContinued(m) {
  if (missing(m)) return 'skipped';
  const first = m.firstSession;
  const second = m.secondSession;
  if (first === null || typeof first !== 'object') return 'FAIL';
  if (second === null || typeof second !== 'object') return 'FAIL';
  if (second.notContinued !== true) return 'FAIL';
  if (second.bannerText !== 'No node reached continues the chain you verified.') return 'FAIL';
  if (typeof second.chainName !== 'string') return 'FAIL';
  // `second.chainName !== first.keptChainHash` catches a non-string
  // `first.keptChainHash` too: `second.chainName` is a string by the
  // guard above, and `'aaaa...' !== undefined` fires. A separate
  // typeof-string guard on `first.keptChainHash` is redundant to this
  // pair (mutation shows no case red).
  if (second.chainName !== first.keptChainHash) return 'FAIL';
  const fork = second.forkEntry;
  if (fork === null || typeof fork !== 'object') return 'FAIL';
  if (fork.status !== 'behind') return 'FAIL';
  // The fork tip is `null` when the fork node never answered a tip —
  // the step reports the second session's own view, so `null` is a
  // FAIL (no positive evidence the hostile node answered).
  if (typeof fork.tipHash !== 'string') return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 6 — a node naming a tip of its own that
// answers malformed proofs, and one that answers failing proofs, are
// blacklisted with their evidence; a node on a lighter chain is
// `behind`.
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

// MESH_INTERFACE → Acceptance 6 — "A mesh node publishing a block that
// fails its checks is blacklisted with its evidence, and the client
// does not forward it." PASS when the publisher's entry is
// `blacklisted` with evidence `gossip-block` AND every honest mesh
// node's log holds no `[mesh] ordering block rejected from <X>` line
// where X is not the publisher's peer id (the client forwarded nothing
// it refused, so the only source an honest mesh sees for the rejected
// block is the publisher itself).
// Measurement:
//   `{ publisher: { status, evidenceKind },
//      publisherPeerIdString: string,
//      otherRejectSources: Array<{ host: string, peerIdString: string }> }`.
export function verdictS6Publisher(m) {
  if (missing(m)) return 'skipped';
  if (m.publisher?.status !== 'blacklisted') return 'FAIL';
  if (m.publisher?.evidenceKind !== 'gossip-block') return 'FAIL';
  if (typeof m.publisherPeerIdString !== 'string' || m.publisherPeerIdString.length === 0) return 'FAIL';
  if (!Array.isArray(m.otherRejectSources)) return 'FAIL';
  // Every honest mesh log's rejection sources are the publisher's peer
  // id alone — any other source means the browser forwarded the bad
  // block, which the contract refuses.
  if (m.otherRejectSources.length !== 0) return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 4 — "A transport is cut" step 4 records
// what still answers after the inter-node Notis-p2p TCP is cut. The
// browser's state is read after a check cycle fires on the cut, and
// the verdict is PASS when the record carries a `nodeId` and a
// `transport` — never on an empty read.
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
// recorded reads AND the step read at least one — a run where every
// read came back with a null `nodeId` (every read threw) proves
// nothing about the slow node, so it reads FAIL, not a vacuous PASS.
// Measurement: `{ delayedNodeId: string, served: Array<{ nodeId: string | null }> }`.
export function verdictS7Fastest(m) {
  if (missing(m)) return 'skipped';
  if (typeof m.delayedNodeId !== 'string') return 'FAIL';
  if (!Array.isArray(m.served)) return 'FAIL';
  if (m.served.length === 0) return 'FAIL';
  let anyServed = false;
  for (const e of m.served) {
    if (e === null || typeof e !== 'object') return 'FAIL';
    if (e.nodeId === m.delayedNodeId) return 'FAIL';
    if (typeof e.nodeId === 'string') anyServed = true;
  }
  if (!anyServed) return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 7 — "A node on the browser's own
// network, named only by a seed, is never dialled; added by hand, it
// is reached at its private address, and takes precedence." Three
// measurements combined:
//   seedPhase: lan1 never holds a connection (`transport === null` at
//     every poll) AND the mesh log shows no inbound connection from
//     `10.103.0.11` (the browser's address).
//   trustedPhase: lan1 reads `ok` or `trailing` over `webrtc-direct`,
//     `path: direct`, its entry's `yours` flag is `true`.
//   untrustedPhase: lan1 reads `ok` or `trailing` over `webrtc-direct`,
//     `path: direct`, its entry's `yours` flag is `false`.
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
  if (trusted.yours !== true) return 'FAIL';
  const untrusted = m.untrustedPhase;
  if (untrusted === null || typeof untrusted !== 'object') return 'FAIL';
  if (!okOrTrailing(untrusted.lan1Status)) return 'FAIL';
  if (untrusted.transport !== 'webrtc-direct') return 'FAIL';
  if (untrusted.path !== 'direct') return 'FAIL';
  if (untrusted.yours !== false) return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 7 — "a hostile node serving a heavier
// chain that continues the page's memory raises the question, and
// each answer does what it says." Three phases combined, each a fresh
// browser profile on the same lan1 identity:
//   (a) lan1 trusted as the reader's node, on the page's chain: the
//       page seats its chain from the kept proof and lan1's entry is
//       `yours: true`, `status` ok or trailing. Positive evidence:
//       `agreement.onChain >= 1`.
//   (b) lan1 cut from the honest nodes and mining a fork of its own
//       while the honest chain grows heavier. The page raises
//       `which: 'heavier'`; `state.chain` and `state.tip` do not move
//       while the disagreement stands; the two buttons stand under
//       `[data-role="disagreement-buttons"]`. Pressing *disable it*
//       calls `client.answer('disable')` once; at the next check
//       lan1's entry has `yours: false`, the disagreement is cleared,
//       and the client's chain seats on the honest side.
//   (c) the same arrangement, pressed *continue on this node* instead:
//       the client's chain settles on lan1's, the disagreement is
//       cleared, and the growing branch raises no new disagreement
//       on the next check (the fork is in `answeredForks`).
// Measurement:
//   `{
//      onChainPhase: {
//        lan1Yours: boolean, lan1Status: string, onChain: number,
//      } | null,
//      heavierPhase: {
//        disagreementWhich: 'memory' | 'heavier' | null,
//        chainStillHeld: boolean,
//        tipStillHeld: boolean,
//        buttonsShown: boolean,
//        lan1HeightAtStop: number,
//        lan1ForkTipHash: string,
//        …  // diagnostics: lan1PreCutHeight, forkBlocksPastCut, pub1HeightAfterLead, …
//      } | null,
//      disablePhase: {
//        answerCalls: number,
//        lan1YoursAfter: boolean,
//        disagreementAfter: boolean,
//        chainOnHonest: boolean,
//        checksAtClick: number,
//        checksAtSample: number,       // > checksAtClick: a check completed past the click
//        sampledTipHeight: number,
//        sampledTipHash: string,
//      } | null,
//      continuePhase: {
//        answerCalls: number,
//        chainOnLan1: boolean,
//        disagreementAfter: boolean,
//        disagreementOnNextCheck: boolean,
//        disagreementWhichD: 'memory' | 'heavier' | null,  // the question phase d waited for
//        checksAtClick: number,
//        checksAtSample: number,       // > checksAtClick: a check completed past the click
//        sampledTipHeight: number,
//        sampledTipHash: string,
//      } | null,
//      lastSeenC: { … } | null,   // evidence: the state phase c last read at a wait that ran out, or at the phase's sample
//      lastSeenD: { … } | null,   // evidence: the state phase d last read at a wait that ran out, or at the phase's sample
//   }`.
export function verdictS7Question(m) {
  if (missing(m)) return 'skipped';
  const onChain = m.onChainPhase;
  if (onChain === null || typeof onChain !== 'object') return 'FAIL';
  if (onChain.lan1Yours !== true) return 'FAIL';
  if (onChain.lan1Status !== 'ok' && onChain.lan1Status !== 'trailing') return 'FAIL';
  if (typeof onChain.onChain !== 'number' || onChain.onChain < 1) return 'FAIL';

  const heavier = m.heavierPhase;
  if (heavier === null || typeof heavier !== 'object') return 'FAIL';
  if (heavier.disagreementWhich !== 'heavier') return 'FAIL';
  if (heavier.chainStillHeld !== true) return 'FAIL';
  if (heavier.tipStillHeld !== true) return 'FAIL';
  if (heavier.buttonsShown !== true) return 'FAIL';

  const dis = m.disablePhase;
  if (dis === null || typeof dis !== 'object') return 'FAIL';
  if (dis.answerCalls !== 1) return 'FAIL';
  if (dis.lan1YoursAfter !== false) return 'FAIL';
  if (dis.disagreementAfter !== false) return 'FAIL';
  if (dis.chainOnHonest !== true) return 'FAIL';
  if (typeof dis.checksAtClick !== 'number') return 'FAIL';
  if (typeof dis.checksAtSample !== 'number') return 'FAIL';
  if (dis.checksAtSample <= dis.checksAtClick) return 'FAIL';
  if (typeof dis.sampledTipHeight !== 'number') return 'FAIL';
  if (typeof dis.sampledTipHash !== 'string') return 'FAIL';

  const cont = m.continuePhase;
  if (cont === null || typeof cont !== 'object') return 'FAIL';
  if (cont.answerCalls !== 1) return 'FAIL';
  if (cont.chainOnLan1 !== true) return 'FAIL';
  if (cont.disagreementAfter !== false) return 'FAIL';
  if (cont.disagreementOnNextCheck !== false) return 'FAIL';
  // MESH_INTERFACE → Discovery → "Your node takes precedence" — "It
  // disagrees ... when its own proof does not continue the kept
  // proof". After phase c's `disable` the kept proof is the honest
  // chain's; phase d restores lan1 as yours, and lan1's fork does
  // not continue the kept proof — the question is `memory`.
  if (cont.disagreementWhichD !== 'memory') return 'FAIL';
  if (typeof cont.checksAtClick !== 'number') return 'FAIL';
  if (typeof cont.checksAtSample !== 'number') return 'FAIL';
  if (cont.checksAtSample <= cont.checksAtClick) return 'FAIL';
  if (typeof cont.sampledTipHeight !== 'number') return 'FAIL';
  if (typeof cont.sampledTipHash !== 'string') return 'FAIL';
  // MESH_INTERFACE → Discovery → "Your node takes precedence" —
  // "its chain is the client's chain, and a routed read goes to it
  // first among the nodes the read's need allows". After *continue*
  // lan1 names the client's tip: its entry reads `ok`, and a routed
  // tip read on the page picks it over every other node. The
  // measurement carries `lan1NotisId` so the raw read answer lands
  // in the measurement beside the id it is held to.
  if (cont.lan1StatusAfter !== 'ok') return 'FAIL';
  if (typeof cont.tipReadNodeAfter !== 'string') return 'FAIL';
  if (cont.tipReadNodeAfter !== cont.lan1NotisId) return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 7 / What the client remembers → "The
// agreement counts" — "The page shows the agreement counts." PASS
// when `onChain >= 2` after a completed check: the counts the
// client's `agreementCounts` writes to `state.agreement`.
// Measurement: `{ onChain, offChain }`.
export function verdictS7Counts(m) {
  if (missing(m)) return 'skipped';
  if (typeof m.onChain !== 'number' || m.onChain < 2) return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 8 — "After the first check, no proof is
// read across five checks while every node names a tip on the
// client's chain". PASS when `proofReadsFinal === proofReadsBaseline`
// across at least five completed checks and at least two honest nodes
// the client's list holds all read `ok`, `trailing` or `behind` at the
// final state (the chain is settled, no held node is in `retry` or
// `blacklisted`). An `absent` entry is a node the list never held; it
// names no tip and is not judged.
// Measurement:
//   `{ proofReadsBaseline, proofReadsFinal, checksBaseline, checksFinal,
//      honestNodeStatuses: Array<{ notisId, status }> }`.
export function verdictS8NoProofs(m) {
  if (missing(m)) return 'skipped';
  if (typeof m.proofReadsBaseline !== 'number' || typeof m.proofReadsFinal !== 'number') return 'FAIL';
  if (m.proofReadsFinal !== m.proofReadsBaseline) return 'FAIL';
  if (typeof m.checksBaseline !== 'number' || typeof m.checksFinal !== 'number') return 'FAIL';
  if (m.checksFinal - m.checksBaseline < 5) return 'FAIL';
  if (!Array.isArray(m.honestNodeStatuses) || m.honestNodeStatuses.length === 0) return 'FAIL';
  let held = 0;
  for (const e of m.honestNodeStatuses) {
    if (e === null || typeof e !== 'object') return 'FAIL';
    if (e.status === 'absent') continue;
    if (e.status !== 'ok' && e.status !== 'trailing' && e.status !== 'behind') return 'FAIL';
    held += 1;
  }
  if (held < 2) return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 8 — "a block mined on a node reaches
// the browser by gossip and moves the client's tip before its next
// check". PASS when at least two of the three
// consecutive new blocks reached the client within 5 s with the check
// counter unchanged over the delivery window (a check every 30 s
// cannot carry a block that short; one delivery that coincides with a
// check says nothing either way, so the two-of-three threshold holds).
// Measurement:
//   `{ deliveries: Array<{ height, delayMs, checksMoved }> }`.
export function verdictS8Gossip(m) {
  if (missing(m)) return 'skipped';
  if (!Array.isArray(m.deliveries) || m.deliveries.length !== 3) return 'FAIL';
  let within = 0;
  for (const d of m.deliveries) {
    if (d === null || typeof d !== 'object') return 'FAIL';
    if (typeof d.delayMs !== 'number') return 'FAIL';
    if (typeof d.checksMoved !== 'boolean') return 'FAIL';
    if (d.delayMs <= 5_000 && d.checksMoved === false) within += 1;
  }
  if (within < 2) return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 8 — a node on another chain has its
// proof read when its tip moves, with the client's own, and the
// client's tip stays the honest chain's. PASS when the lagging node
// reads `behind` (never blacklisted); the client's tip hash equals
// pub1's node's block hash at that height; and the check that read
// the lagging node's tip raised `proofReads` by exactly two (the
// lagging node's proof plus the client's own tip proof — the one
// check in which the lagging node's tip was the one tip not on the
// chain).
// Measurement:
//   `{ laggingStatus, clientTipHash, pub1BlockHashAtClientHeight,
//      proofReadsDeltaAtCheck }`.
export function verdictS8Fork(m) {
  if (missing(m)) return 'skipped';
  if (m.laggingStatus !== 'behind') return 'FAIL';
  if (typeof m.clientTipHash !== 'string' || typeof m.pub1BlockHashAtClientHeight !== 'string') return 'FAIL';
  if (m.clientTipHash !== m.pub1BlockHashAtClientHeight) return 'FAIL';
  if (typeof m.proofReadsDeltaAtCheck !== 'number' || m.proofReadsDeltaAtCheck !== 2) return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 8 — "the browser's gossip cut for three
// blocks and restored, its tip catches up by headers with no proof
// read, and gossip extends it after: a block whose parent is the
// client's tip reaches it by gossip with no check between". The
// verdict reads what acceptance 8 says, from records after `liftAtMs`:
// PASS when `proofReads` did not move across the step, the final tip
// is within two of pub1's read, AND a record in tipHist whose atMs is
// at or after `liftAtMs` rises with `checks` equal to the record
// before it — a tip that moved with no check between, which is a
// gossip extension (MESH_INTERFACE → The client's node list). A
// record before the lift never satisfies the gossip clause. The
// baseline is the record before `tipHist[0]`: a first tip change
// after the lift at the base's `checks` fires the clause against
// the base's `height`. A missing field FAILs the step with its name.
// Measurement:
//   `{ liftAtMs, baseline: {height, checks}, tipHist: [{height, atMs,
//      checks, proofReads, gossipBytes}, …], proofReadsBaseline,
//      proofReadsFinal, tipHeightFinal, pub1HeightFinal }`.
export function verdictS8Gap(m) {
  if (missing(m)) return 'skipped';
  if (typeof m.liftAtMs !== 'number') return 'FAIL';
  if (!Array.isArray(m.tipHist)) return 'FAIL';
  if (m.baseline === null || typeof m.baseline !== 'object') return 'FAIL';
  if (typeof m.baseline.height !== 'number' || typeof m.baseline.checks !== 'number') return 'FAIL';
  if (typeof m.proofReadsBaseline !== 'number') return 'FAIL';
  if (typeof m.proofReadsFinal !== 'number') return 'FAIL';
  if (typeof m.tipHeightFinal !== 'number') return 'FAIL';
  if (typeof m.pub1HeightFinal !== 'number') return 'FAIL';
  if (m.proofReadsFinal !== m.proofReadsBaseline) return 'FAIL';
  if (Math.abs(m.pub1HeightFinal - m.tipHeightFinal) > 2) return 'FAIL';
  let gossipFound = false;
  for (let i = 0; i < m.tipHist.length; i += 1) {
    const curr = m.tipHist[i];
    if (curr === null || typeof curr !== 'object') return 'FAIL';
    if (typeof curr.atMs !== 'number' || typeof curr.checks !== 'number' || typeof curr.height !== 'number') return 'FAIL';
    if (curr.atMs < m.liftAtMs) continue;
    const prev = i === 0
      ? { height: m.baseline.height, checks: m.baseline.checks }
      : m.tipHist[i - 1];
    if (prev === null || typeof prev !== 'object') return 'FAIL';
    if (typeof prev.checks !== 'number' || typeof prev.height !== 'number') return 'FAIL';
    if (curr.checks === prev.checks && curr.height > prev.height) {
      gossipFound = true;
      break;
    }
  }
  if (!gossipFound) return 'FAIL';
  return 'PASS';
}
