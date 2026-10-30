// MESH_INTERFACE → Discovery / Identity / No anchor reached — the page's
// `config.json`, built by a pure function of the topology, the public mesh
// nodes' notisIds, and (optional) the mesh nodes' printed multiaddrs. Every
// anchor's `addrs` carries a WebRTC-direct multiaddr; `pub1`'s also carries
// a WSS address (`/tls/ws` over its bare IP). Seeds default to none (a
// scenario writes its own); stun servers are the public nodes' STUN by IP.
//
// A notisId converts to a libp2p peer id by `peerIdFromNotisId`'s rule
// (`MESH_INTERFACE → Identity`): identity multihash of `08 01 12 20 ‖ key`,
// `/p2p/<peer-id>` the string form. Exec mode passes `realMultiaddrs` so
// the WebRTC-direct address carries the certhash the mesh node printed;
// dry-run omits it, so no placeholder lands in a written file.

import { publicKeyFromRaw } from '@libp2p/crypto/keys';
import { peerIdFromPublicKey } from '@libp2p/peer-id';
import { publicMeshHosts } from './topology.mjs';

export function buildPageConfig(topology, nodeIdentities, realMultiaddrs) {
  const anchors = [];
  const stunServers = [];
  for (const { name, host } of publicMeshHosts(topology)) {
    const id = nodeIdentities[name];
    if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) {
      throw new Error(`missing or malformed notisId for ${name}: ${JSON.stringify(id)}`);
    }
    const peerIdStr = peerIdStringOf(id);
    const addrs = [];
    const realList = realMultiaddrs?.[name];
    if (Array.isArray(realList) && realList.length > 0) {
      // Exec mode — the mesh node printed its own listening multiaddrs with
      // the real certhash of the WebRTC-direct cert. Filter to the two
      // transports a browser dials: WebRTC-direct and WSS.
      for (const addr of realList) {
        if (addr.includes('/webrtc-direct/') || addr.includes('/tls/ws')) {
          addrs.push(addr);
        }
      }
    } else {
      // Dry-run / no mesh-node output yet — use the IP, port and peer id
      // the topology fixes; the WebRTC-direct address carries no certhash
      // (the mesh node's cert does not exist yet).
      addrs.push(`/ip4/${host.addr}/udp/${host.mesh.webrtcPort}/webrtc-direct/p2p/${peerIdStr}`);
      if (host.mesh.wss !== undefined) {
        addrs.push(`/ip4/${host.addr}/tcp/${host.mesh.wss.port}/tls/ws/p2p/${peerIdStr}`);
      }
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

export function peerIdStringOf(notisId) {
  const pub = publicKeyFromRaw(hexToBytes(notisId));
  return peerIdFromPublicKey(pub).toString();
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}
