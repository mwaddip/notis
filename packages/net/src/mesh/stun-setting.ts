// MESH_INTERFACE → NAT → "A node's role is its operator's setting" —
// a public node runs a STUN server at the IP of its first
// WebRTC-direct listen address on `STUN_PORT`, unless its operator
// names another or turns it off. Pure: it decides the setting from
// the operator's input alone, with no socket or filesystem reach.

import { isIPv4, isIPv6 } from 'node:net';
import { MeshConfigError } from './config.js';
import { STUN_PORT } from './constants.js';

// A listen multiaddr of the form `/ip4/<ip>/udp/<port>/webrtc-direct`
// (optionally continuing). The IP capture is what the derived STUN
// setting binds to.
const WEBRTC_DIRECT_LISTEN_RE = /^\/ip4\/([0-9.]+)\/udp\/\d+\/webrtc-direct(?:\/|$)/;

/**
 * Decide a public node's STUN setting from its listen list and its
 * `MeshConfig.stun`. `stun === null` encodes "off"; `undefined` reads
 * the first `/ip4/<ip>/udp/<port>/webrtc-direct` on `STUN_PORT`. A
 * private role with `stun` set is refused.
 */
export function stunSettingFor(
  role: 'public' | 'private',
  listen: readonly string[],
  stun: { host: string; port: number } | null | undefined,
): { host: string; port: number } | undefined {
  if (role === 'private') {
    if (stun === undefined || stun === null) return undefined;
    throw new MeshConfigError('mesh.stun refused: a private node does not serve STUN');
  }
  if (stun === null) return undefined;
  if (stun === undefined) {
    for (const a of listen) {
      const m = WEBRTC_DIRECT_LISTEN_RE.exec(a);
      if (m) return { host: m[1]!, port: STUN_PORT };
    }
    return undefined;
  }
  if (!isIPv4(stun.host) && !isIPv6(stun.host)) {
    throw new MeshConfigError(
      `mesh.stun.host refused: ${JSON.stringify(stun.host)} is not an IP literal`,
    );
  }
  if (!Number.isInteger(stun.port) || stun.port < 0 || stun.port > 65535) {
    throw new MeshConfigError(
      `mesh.stun.port refused: ${stun.port} is not a 0..65535 integer`,
    );
  }
  return { host: stun.host, port: stun.port };
}
