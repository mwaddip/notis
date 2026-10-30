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
 * through `<viaPublicHost>`. The variant preserves `stunServers` and
 * leaves `seeds` empty.
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
    stunServers: Array.isArray(baseConfig.stunServers) ? baseConfig.stunServers : [],
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
export function buildPrivateViaAnnouncedRelayVariant(_baseConfig, { privRow: _privRow, identities: _identities }) {
  throw new Error('buildPrivateViaAnnouncedRelayVariant: not implemented');
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
    stunServers: Array.isArray(baseConfig.stunServers) ? baseConfig.stunServers : [],
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
