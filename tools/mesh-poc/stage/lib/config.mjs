// MESH_INTERFACE → Discovery / No anchor reached — the page's `config.json`,
// built by a pure function of the topology and the public mesh nodes' printed
// notis ids. Each anchor's `addrs` names the public node's WebRTC-direct
// multiaddr; `pub1`'s also carries its WSS address (`/tls/ws` over its bare
// IP, the IP certificate's SAN). Seeds default to none (a scenario writes its
// own); stun servers are the public nodes' STUN by IP, as `MESH_INTERFACE →
// NAT` requires ("Every STUN server is a mesh node named by IP").
//
// `anchors` carries no `/dns4/`, `/dns6/` or `/dnsaddr/` component by
// construction — every host carries IP literals, verified by
// `assertTopologyWhole`. The output passes `assertClientConfig` for that
// reason.

import { publicMeshHosts } from './topology.mjs';

export function buildPageConfig(topology, nodeIdentities) {
  const anchors = [];
  const stunServers = [];
  for (const { name, host } of publicMeshHosts(topology)) {
    const id = nodeIdentities[name];
    if (typeof id !== 'string' || id.length !== 64 || !/^[0-9a-f]+$/.test(id)) {
      throw new Error(`missing or malformed notisId for ${name}: ${JSON.stringify(id)}`);
    }
    const addrs = [];
    // MESH_INTERFACE → Transports — WebRTC-direct is the one path with no CA
    // on the browser's side. The address an anchor lists carries the
    // certificate's hash (`/certhash/<multibase>`), which the stage writes in
    // place of this placeholder when it reads the mesh node's actual
    // multiaddrs. The pure function here fills in the IP, port and peer id
    // the stage knows up front.
    addrs.push(`/ip4/${host.addr}/udp/${host.mesh.webrtcPort}/webrtc-direct/p2p/${idToPeerIdPlaceholder(id)}`);
    if (host.mesh.wss !== undefined) {
      // MESH_INTERFACE → The IP certificate — a WSS address on the node's
      // bare IP, taken by a browser only when its default path is blocked.
      addrs.push(`/ip4/${host.addr}/tcp/${host.mesh.wss.port}/tls/ws/p2p/${idToPeerIdPlaceholder(id)}`);
    }
    anchors.push({ notisId: id, addrs });
    stunServers.push(`stun:${host.addr}:${host.mesh.stunPort}`);
  }
  return {
    network: topology.network,
    anchors,
    stunServers,
    seeds: [],
  };
}

// A placeholder peer id — the stage replaces it with the mesh node's own peer
// id string after `up` reads the printed identity line. The pure function has
// no libp2p dependency; its output is the shape, not the identity.
function idToPeerIdPlaceholder(notisId) {
  return `__PEER_ID_${notisId.slice(0, 8)}__`;
}
