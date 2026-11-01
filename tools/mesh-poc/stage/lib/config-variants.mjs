// MESH_INTERFACE → Discovery / NAT — pure helpers that build scenario
// `config.json` variants from the stage's own config. Each scenario
// swaps the file atomically (write then rename), opens the page, and
// restores the original in `finally`.
//
// A circuit-relay multiaddr for a private node reached through a public
// node is the public node's full multiaddr + `/p2p-circuit/p2p/<private
// peer id>`. The public node's circuit-relay-v2 server is already up
// (every mesh node registers `circuitRelayServer()` in its libp2p
// config); the private node reserved on it at start.
//
// Scenarios import `peerIdStringOf` from `./config.mjs` to derive a peer
// id from a notisId — same function `buildPageConfig` already uses.

/**
 * Build a config variant whose single anchor is `<privHost>` reached
 * through `<viaPublicHost>`. The variant leaves `seeds` empty; the
 * client's STUN list is derived from the public nodes it holds
 * (MESH_INTERFACE → NAT → "A client's STUN list comes from the public
 * nodes it holds"), so no `stunServers` key is written.
 *
 * The relay address is built from the stage's own `config.json`
 * (`baseConfig.anchors.find(a => a.notisId === viaPublicNotisId).addrs[0]`
 * — the public node's WebRTC-direct multiaddr, with its certhash) and
 * `/p2p-circuit/p2p/<privPeerIdString>` appended.
 */
export function buildPrivateViaRelayVariant(baseConfig, {
  privNotisId,
  privPeerIdString,
  viaPublicNotisId,
}) {
  if (!baseConfig || !Array.isArray(baseConfig.anchors)) {
    throw new Error('base config must carry anchors[]');
  }
  const viaAnchor = baseConfig.anchors.find((a) => a?.notisId === viaPublicNotisId);
  if (!viaAnchor || !Array.isArray(viaAnchor.addrs) || viaAnchor.addrs.length === 0) {
    throw new Error(`base config does not name the public anchor ${viaPublicNotisId}`);
  }
  // Pick the first webrtc-direct address — a browser dials that first.
  const viaWebrtcDirect = viaAnchor.addrs.find((s) => s.includes('/webrtc-direct/'));
  if (!viaWebrtcDirect) {
    throw new Error(`public anchor ${viaPublicNotisId} has no /webrtc-direct/ multiaddr`);
  }
  const relayAddr = `${viaWebrtcDirect}/p2p-circuit/p2p/${privPeerIdString}`;
  return {
    network: baseConfig.network,
    anchors: [{ notisId: privNotisId, addrs: [relayAddr] }],
    seeds: [],
  };
}

/**
 * Build a config variant whose single anchor is a private node reached
 * through the relay the private node ACTUALLY reserved on, taken from
 * its own announced circuit multiaddr. A private node picks its relay
 * at run time; the stage cannot name the via-public node in advance.
 * The relay's WebRTC-direct address (not its TCP address — a browser
 * cannot dial that) is read from `identities[<relay-host>]`.
 *
 * Signature: `(baseConfig, { privRow, identities })` where `privRow`
 * is the private node's `stage/out/identities.json` row (holds
 * `notisId` and `multiaddrs`), and `identities` is the full map.
 *
 * Throws when the private node announces no `/p2p-circuit` address,
 * when the circuit's relay is missing from identities, or when the
 * relay has no WebRTC-direct address a browser can dial.
 */
export function buildPrivateViaAnnouncedRelayVariant(baseConfig, { privRow, identities }) {
  if (!baseConfig || !Array.isArray(baseConfig.anchors)) {
    throw new Error('base config must carry anchors[]');
  }
  if (!privRow || typeof privRow.notisId !== 'string') {
    throw new Error('privRow must carry a notisId');
  }
  if (!identities || typeof identities !== 'object') {
    throw new Error('identities must be an object');
  }
  const announced = Array.isArray(privRow.multiaddrs) ? privRow.multiaddrs : [];
  // MESH_INTERFACE → NAT — pick the WebRTC form of the private
  // node's announced circuit address. A circuit-relay v2 connection
  // is limited (relay caps bytes and time), so an application stream
  // over the raw `/p2p-circuit/p2p/<priv>` is refused by libp2p's
  // own guard; the browser's path to a private node is a direct
  // WebRTC connection signalled through the relay — the private
  // announces `<relay-prefix>/p2p/<relay-peer>/p2p-circuit/webrtc/p2p/<priv>`.
  const circuit = announced.find((a) =>
    typeof a === 'string' && a.includes('/p2p-circuit/webrtc/p2p/'),
  );
  if (circuit === undefined) {
    throw new Error(`priv ${privRow.notisId}: announces no /p2p-circuit/webrtc address a browser can reach`);
  }
  const m = /^(.+)\/p2p\/([^/]+)\/p2p-circuit\/webrtc\/p2p\/([^/]+)$/.exec(circuit);
  if (!m) {
    throw new Error(`priv ${privRow.notisId}: unexpected /p2p-circuit/webrtc shape: ${circuit}`);
  }
  const relayPeerIdString = m[2];
  const privPeerIdString = m[3];
  // Find the identity row whose own listen addresses end in
  // `/p2p/<relayPeerIdString>` — that is the relay host itself, not a
  // private node whose /p2p-circuit address happens to reference the
  // relay in a middle component. The private node here already
  // references `relayPeerIdString` in its own circuit entry, so a
  // broader `includes('/p2p/<relay-peer>')` match would pick itself.
  let relayRow = null;
  const nonCircuitRe = new RegExp(`/p2p/${relayPeerIdString}$`);
  for (const row of Object.values(identities)) {
    const addrs = Array.isArray(row?.multiaddrs) ? row.multiaddrs : [];
    if (addrs.some((a) => typeof a === 'string' && !a.includes('/p2p-circuit') && nonCircuitRe.test(a))) {
      relayRow = row;
      break;
    }
  }
  if (relayRow === null) {
    throw new Error(`priv ${privRow.notisId}: no identity row for relay peer ${relayPeerIdString}`);
  }
  // A browser dials the relay over WebRTC-direct (with certhash), not
  // TCP. The relay's own identity line carries both; keep only the
  // first `/webrtc-direct/` with a `/certhash/` component.
  const relayAddrs = Array.isArray(relayRow.multiaddrs) ? relayRow.multiaddrs : [];
  const relayWebrtc = relayAddrs.find((a) => typeof a === 'string'
    && a.includes('/webrtc-direct/')
    && a.includes('/certhash/'));
  if (relayWebrtc === undefined) {
    throw new Error(`relay ${relayPeerIdString}: no /webrtc-direct/certhash/ address a browser can dial`);
  }
  // `relayWebrtc` ends in `/p2p/<relay-peer>`. Compose by appending
  // `/p2p-circuit/webrtc/p2p/<priv-peer>` so the browser dials the
  // relay over WebRTC-direct, signals SDP across the limited
  // relayed stream, and establishes a direct WebRTC connection to
  // the private.
  const relayAnchor = `${relayWebrtc}/p2p-circuit/webrtc/p2p/${privPeerIdString}`;
  return {
    network: baseConfig.network,
    anchors: [{ notisId: privRow.notisId, addrs: [relayAnchor] }],
    seeds: [],
  };
}

/**
 * MESH_INTERFACE → NAT → "A relay carries data" — a variant whose
 * single anchor is a private node reached through the relay it
 * reserved on, with BOTH its `/p2p-circuit/webrtc` and plain
 * `/p2p-circuit` addresses. The signalled WebRTC path over the
 * circuit's webrtc form fails when the private is behind a symmetric
 * NAT and the browser is behind one of its own; the plain
 * `/p2p-circuit` form then carries the API stream over the relay as
 * data. The expected outcome: the routed read lands on the private
 * over the relay.
 */
export function buildPrivateViaAnnouncedRelayPairVariant(baseConfig, { privRow, identities }) {
  if (!baseConfig || !Array.isArray(baseConfig.anchors)) {
    throw new Error('base config must carry anchors[]');
  }
  if (!privRow || typeof privRow.notisId !== 'string') {
    throw new Error('privRow must carry a notisId');
  }
  if (!identities || typeof identities !== 'object') {
    throw new Error('identities must be an object');
  }
  const announced = Array.isArray(privRow.multiaddrs) ? privRow.multiaddrs : [];
  const circuitWebrtc = announced.find((a) =>
    typeof a === 'string' && a.includes('/p2p-circuit/webrtc/p2p/'),
  );
  if (circuitWebrtc === undefined) {
    throw new Error(`priv ${privRow.notisId}: announces no /p2p-circuit/webrtc address`);
  }
  const m = /^(.+)\/p2p\/([^/]+)\/p2p-circuit\/webrtc\/p2p\/([^/]+)$/.exec(circuitWebrtc);
  if (!m) {
    throw new Error(`priv ${privRow.notisId}: unexpected /p2p-circuit/webrtc shape: ${circuitWebrtc}`);
  }
  const relayPeerIdString = m[2];
  const privPeerIdString = m[3];
  let relayRow = null;
  const nonCircuitRe = new RegExp(`/p2p/${relayPeerIdString}$`);
  for (const row of Object.values(identities)) {
    const addrs = Array.isArray(row?.multiaddrs) ? row.multiaddrs : [];
    if (addrs.some((a) => typeof a === 'string' && !a.includes('/p2p-circuit') && nonCircuitRe.test(a))) {
      relayRow = row;
      break;
    }
  }
  if (relayRow === null) {
    throw new Error(`priv ${privRow.notisId}: no identity row for relay peer ${relayPeerIdString}`);
  }
  const relayAddrs = Array.isArray(relayRow.multiaddrs) ? relayRow.multiaddrs : [];
  const relayWebrtc = relayAddrs.find((a) => typeof a === 'string'
    && a.includes('/webrtc-direct/')
    && a.includes('/certhash/'));
  if (relayWebrtc === undefined) {
    throw new Error(`relay ${relayPeerIdString}: no /webrtc-direct/certhash/ address`);
  }
  // Both the `/p2p-circuit/webrtc/p2p/<priv>` form (signalling + direct
  // WebRTC data) and the plain `/p2p-circuit/p2p/<priv>` form (an API
  // stream over the relay, MESH_INTERFACE → NAT → "A relay carries
  // data"). The public node's relay keeps no circuit limits, so a
  // read rides the relayed link whole.
  const relayedWebrtc = `${relayWebrtc}/p2p-circuit/webrtc/p2p/${privPeerIdString}`;
  const relayedPlain = `${relayWebrtc}/p2p-circuit/p2p/${privPeerIdString}`;
  return {
    network: baseConfig.network,
    anchors: [{ notisId: privRow.notisId, addrs: [relayedWebrtc, relayedPlain] }],
    seeds: [],
  };
}

/**
 * Build a config variant that keeps the stage's own anchors AND adds a
 * list of hostile seed anchors. The seeds are refused by
 * `assertClientConfig` under the same rules anchors are, so each seed's
 * `addrs` has to be IP-only.
 */
export function buildWithHostileSeedsVariant(baseConfig, seeds) {
  if (!baseConfig || !Array.isArray(baseConfig.anchors)) {
    throw new Error('base config must carry anchors[]');
  }
  return {
    network: baseConfig.network,
    anchors: baseConfig.anchors,
    seeds: Array.isArray(seeds) ? seeds : [],
  };
}

/**
 * Build the seeds list for s6 from the stage's own identities + topology.
 * When a host's `identities[host].multiaddrs` is non-empty (the stage
 * recorded what the mesh node printed on its identity line), those
 * addresses are used — they are the real addresses the mesh node
 * listens on, so a dial reaches it. Otherwise the fallback is one
 * `/ip4/<addr>/tcp/<meshTcp>/p2p/<peerId>` built from the topology.
 */
export function buildHostileSeeds(identities, topology, { peerIdStringOf }) {
  if (!identities || typeof identities !== 'object') return [];
  if (!topology || typeof topology.hosts !== 'object') return [];
  const seeds = [];
  for (const [host, hostConfig] of Object.entries(topology.hosts)) {
    if (hostConfig?.role !== 'hostile') continue;
    const row = identities[host];
    const id = row?.notisId;
    if (typeof id !== 'string') continue;
    // Prefer the printed multiaddrs when the stage recorded them —
    // those are the addresses the mesh node is actually listening on
    // (with the right ports, cert hashes, etc).
    const printed = Array.isArray(row?.multiaddrs) ? row.multiaddrs : [];
    if (printed.length > 0) {
      // The identity line's multiaddrs already end in `/p2p/<peerId>`.
      seeds.push({ notisId: id, addrs: printed });
      continue;
    }
    // Fallback: build one TCP mesh address from the topology.
    const addr = hostConfig?.addr;
    const tcpPort = hostConfig?.mesh?.tcpPort ?? hostConfig?.node?.p2pPort;
    if (typeof addr !== 'string' || typeof tcpPort !== 'number') continue;
    const peerIdString = peerIdStringOf(id);
    seeds.push({
      notisId: id,
      addrs: [`/ip4/${addr}/tcp/${tcpPort}/p2p/${peerIdString}`],
    });
  }
  return seeds;
}
