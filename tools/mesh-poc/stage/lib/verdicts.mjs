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

// MESH_INTERFACE → Acceptance 1 — "No name, no hosted page". Scenario 1
// step 1: within 60 s the client's state has an `anchor` node in use.
// Measurement: `{ nodeId: string|null, isAnchor: boolean, timeMs: number }`.
export function verdictS1Node(m) {
  if (missing(m)) return 'skipped';
  if (typeof m.nodeId !== 'string') return 'FAIL';
  if (m.isAnchor !== true) return 'FAIL';
  if (typeof m.timeMs !== 'number' || m.timeMs > 60_000) return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 1 — "the mesh's answers equal the node's
// direct HTTP answers byte for byte". Scenario 1 step 2: for each probed
// path, the SHA-256 and byte length the page recorded equal the node's
// own HTTP answer read inside the node's namespace at the same moment.
// Measurement: `{ probe: { sha256, bytes }, direct: { sha256, bytes } }`;
// a tip that moved between the two reads is retried, and if the retry
// still disagrees the retry's own measurement sits beside the first
// (`{ ..., retryDirect: { sha256, bytes } }`) — this verdict passes if
// either direct read matches the probe.
export function verdictS1Probe(m) {
  if (missing(m)) return 'skipped';
  const probe = m.probe;
  const direct = m.direct;
  if (probe === null || probe === undefined) return 'FAIL';
  if (direct === null || direct === undefined) return 'FAIL';
  if (typeof probe.sha256 !== 'string' || typeof probe.bytes !== 'number') return 'FAIL';
  const matches = (d) =>
    d !== null && d !== undefined &&
    typeof d.sha256 === 'string' && typeof d.bytes === 'number' &&
    d.sha256 === probe.sha256 && d.bytes === probe.bytes;
  if (matches(direct)) return 'PASS';
  if (matches(m.retryDirect)) return 'PASS';
  return 'FAIL';
}

// MESH_INTERFACE → Acceptance 1 — "the browser host's DNS log holds no
// query ... anything there went around the browser's resolver". The
// clean scenario-1 run leaves `stage/out/dns.log` with no new line and
// the browser namespace's nft DNS counter unmoved.
// Measurement: `{ dnsLines: number, nftCounterPackets: number }`.
export function verdictS1DnsSilent(m) {
  if (missing(m)) return 'skipped';
  if (typeof m.dnsLines !== 'number' || m.dnsLines !== 0) return 'FAIL';
  if (typeof m.nftCounterPackets !== 'number' || m.nftCounterPackets !== 0) return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 2 — "A node behind the endpoint-independent
// NAT answers through a relay, then directly". priv1's anchor becomes
// the node in use, the client's state reads `path: 'relay'` first, then
// `path: 'direct'` once DCUtR or the WebRTC upgrade lands.
// Measurement: `{ nodeId: string, relayedTimeMs: number, directTimeMs: number }`.
export function verdictS2Priv1(m) {
  if (missing(m)) return 'skipped';
  if (typeof m.nodeId !== 'string' || m.nodeId !== m.expectedNodeId) return 'FAIL';
  if (typeof m.relayedTimeMs !== 'number') return 'FAIL';
  if (typeof m.directTimeMs !== 'number') return 'FAIL';
  if (m.directTimeMs < m.relayedTimeMs) return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 2 — "one behind the symmetric NAT answers
// through the relay". priv2's path reaches `relay` and stays there (the
// scenario records whether it ever goes direct, but the pass condition
// is only `relay`).
// Measurement: `{ nodeId, relayedTimeMs: number, everDirect: boolean }`.
export function verdictS2Priv2(m) {
  if (missing(m)) return 'skipped';
  if (typeof m.nodeId !== 'string' || m.nodeId !== m.expectedNodeId) return 'FAIL';
  if (typeof m.relayedTimeMs !== 'number') return 'FAIL';
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

// MESH_INTERFACE → Acceptance 3 — "reads `ok` again once it is back".
// Measurement: `{ nodeId: string, status: 'ok', recoveryTimeMs: number }`.
export function verdictS3Recovered(m) {
  if (missing(m)) return 'skipped';
  if (typeof m.nodeId !== 'string') return 'FAIL';
  if (m.status !== 'ok') return 'FAIL';
  if (typeof m.recoveryTimeMs !== 'number') return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 4 — "UDP to one public node: the client
// gets in through another node". Measurement:
//   `{ connected: boolean, nodeId: string, blockedNodeId: string }`.
export function verdictS4Pub1UdpDrop(m) {
  if (missing(m)) return 'skipped';
  if (m.connected !== true) return 'FAIL';
  if (typeof m.nodeId !== 'string' || typeof m.blockedNodeId !== 'string') return 'FAIL';
  if (m.nodeId === m.blockedNodeId) return 'FAIL';
  return 'PASS';
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
// certificate with no request dropped": across one `[wait] renewal` the
// page's probes keep succeeding and `lastLeft` does not name a failure.
// Measurement: `{ renewalSeen: boolean, probeSuccessAcrossRenewal: boolean, lastLeftFailure: boolean }`.
export function verdictS4Renewal(m) {
  if (missing(m)) return 'skipped';
  if (m.renewalSeen !== true) return 'FAIL';
  if (m.probeSuccessAcrossRenewal !== true) return 'FAIL';
  if (m.lastLeftFailure !== false) return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 5 — "A node with its own key and a copy of
// an anchor's certificate, at the anchor's address: refused at the
// link, that address dropped, the anchor not blacklisted".
// Measurement:
//   `{ anchorStatus: 'ok'|'retry'|'behind', droppedAddrs: string[], blockedAddr: string }`.
export function verdictS5(m) {
  if (missing(m)) return 'skipped';
  if (m.anchorStatus === 'blacklisted') return 'FAIL';
  if (!Array.isArray(m.droppedAddrs)) return 'FAIL';
  if (typeof m.blockedAddr !== 'string') return 'FAIL';
  if (!m.droppedAddrs.includes(m.blockedAddr)) return 'FAIL';
  return 'PASS';
}

// MESH_INTERFACE → Acceptance 6 — "With every anchor out of reach,
// `anchorReached` is false and the page says so". The banner words
// are the contract's byte for byte (MESH_INTERFACE → No anchor
// reached).
// Measurement: `{ anchorReached: boolean, bannerText: string|null }`.
export function verdictS6NoAnchor(m) {
  if (missing(m)) return 'skipped';
  if (m.anchorReached !== false) return 'FAIL';
  if (m.bannerText !== 'No anchor reached. Nothing shown here is verified.') return 'FAIL';
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
