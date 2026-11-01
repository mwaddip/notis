// MESH_INTERFACE → Discovery / Identity / No anchor reached — the page's
// `config.json`, built by a pure function of the topology, the public mesh
// nodes' notisIds, and (optional) the mesh nodes' printed multiaddrs. Every
// anchor's `addrs` carries a WebRTC-direct multiaddr; `pub1`'s also carries
// a WSS address (`/tls/ws` over its bare IP). Seeds default to none (a
// scenario writes its own); the client takes its STUN servers from the
// public nodes it holds (MESH_INTERFACE → NAT → "A client's STUN list
// comes from the public nodes it holds"), so the built config carries
// none, and the page refuses the field in words.
//
// A notisId converts to a libp2p peer id by `peerIdFromNotisId`'s rule
// (`MESH_INTERFACE → Identity`): identity multihash of `08 01 12 20 ‖ key`,
// `/p2p/<peer-id>` the string form. Exec mode passes `realMultiaddrs` so
// the WebRTC-direct address carries the certhash the mesh node printed;
// dry-run omits it, so no placeholder lands in a written file.

import { publicKeyFromRaw } from '@libp2p/crypto/keys';
import { peerIdFromPublicKey } from '@libp2p/peer-id';
import { publicMeshHosts } from './topology.mjs';

export function buildPageConfig(topology, nodeIdentities, realMultiaddrs, opts) {
  const dryRun = opts !== undefined && opts !== null && opts.dryRun === true;
  const anchors = [];
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
      // transports a browser dials: WebRTC-direct and WSS. A /webrtc-direct/
      // multiaddr without a /certhash/ is refused — the browser's gater
      // reads one without a certhash as InvalidParametersError, and the
      // scenario would then wait for a connection that cannot happen.
      let hasWebrtcWithCerthash = false;
      for (const addr of realList) {
        if (addr.includes('/webrtc-direct/')) {
          if (!addr.includes('/certhash/')) {
            throw new Error(`${name}: WebRTC-direct multiaddr has no /certhash/: ${addr}`);
          }
          addrs.push(addr);
          hasWebrtcWithCerthash = true;
        } else if (addr.includes('/tls/ws')) {
          addrs.push(addr);
        }
      }
      if (!hasWebrtcWithCerthash) {
        throw new Error(`${name}: realMultiaddrs carries no /webrtc-direct/certhash/ multiaddr`);
      }
    } else if (dryRun) {
      // Dry-run opt-in only — the mesh node's cert does not exist yet,
      // so the WebRTC-direct address carries a /certhash/ PLACEHOLDER.
      // A placeholder in a REAL `config.json` leaks into the browser as
      // `SyntaxError: Unexpected end of data` on dial; the caller MUST
      // pass `{ dryRun: true }` to opt in.
      addrs.push(`/ip4/${host.addr}/udp/${host.mesh.webrtcPort}/webrtc-direct/certhash/uEiA_DRYRUN_PLACEHOLDER_CERTHASH_______________/p2p/${peerIdStr}`);
      if (host.mesh.wss !== undefined) {
        addrs.push(`/ip4/${host.addr}/tcp/${host.mesh.wss.port}/tls/ws/p2p/${peerIdStr}`);
      }
    } else {
      // Exec mode without a mesh node's identity line for this host is
      // a bug — the stage brings the mesh nodes up before writing
      // config.json, so a missing identity means an earlier step
      // silently failed. Fail loudly here instead of writing a
      // placeholder that the browser cannot dial.
      throw new Error(`${name}: no realMultiaddrs supplied in exec mode (pass { dryRun: true } to opt into the placeholder)`);
    }
    anchors.push({ notisId: id, addrs });
  }
  return {
    network: topology.network,
    anchors,
    seeds: [],
  };
}

/**
 * MESH_INTERFACE → Acceptance — the stage's `identities.json`: a row
 * per host up started a mesh node for, keyed by host name, each
 * row carrying `{ notisId, meshRole, addr, httpPort, multiaddrs,
 * localAddrs }`. `multiaddrs` carries the identity line's
 * `multiaddrs` (what the mesh node announces, including a private
 * node's `/p2p-circuit/webrtc/`); `localAddrs` carries the identity
 * line's `localAddrs` (a private node's own WebRTC-direct listen,
 * for an operator to hand over — `MESH_INTERFACE → Discovery →
 * "A node added by hand"`). A host up has no notisId for is left
 * out. Pure.
 */
export function buildIdentitiesOut(topology, notisIds, meshIdentities) {
  const out = {};
  for (const [host, hostConfig] of Object.entries(topology.hosts)) {
    const id = notisIds[host];
    if (typeof id !== 'string') continue;
    out[host] = {
      notisId: id,
      meshRole: hostConfig.mesh?.role ?? null,
      addr: hostConfig.addr ?? null,
      httpPort: hostConfig.node?.httpPort ?? null,
      multiaddrs: meshIdentities[host]?.multiaddrs ?? [],
      localAddrs: meshIdentities[host]?.localAddrs ?? [],
    };
  }
  return out;
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
