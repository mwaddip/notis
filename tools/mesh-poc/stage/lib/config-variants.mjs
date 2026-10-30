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
 * Build the seeds list for s6 from the stage's own identities + topology:
 * one `{ notisId, addrs: ['/ip4/<addr>/tcp/<meshTcp>/p2p/<peerId>'] }` per
 * hostile mesh node. The hostile mesh nodes serve the mesh over TCP (same
 * libp2p 3.x TCP transport the stage uses between nodes), so a seed's
 * `addrs` carries one `/ip4/.../tcp/<port>` — no WebRTC-direct hash for a
 * seed (the browser dials it through the DHT, which walks).
 */
export function buildHostileSeeds(identities, topology, { peerIdStringOf }) {
  if (!identities || typeof identities !== 'object') return [];
  if (!topology || typeof topology.hosts !== 'object') return [];
  const seeds = [];
  for (const [host, hostConfig] of Object.entries(topology.hosts)) {
    if (hostConfig?.role !== 'hostile') continue;
    const id = identities[host]?.notisId;
    if (typeof id !== 'string') continue;
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
