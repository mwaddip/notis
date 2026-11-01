// MESH_INTERFACE → NAT — "A public node ... runs ... a STUN server on
// `STUN_PORT` (RFC 8489's port) at the IP of its first WebRTC-direct
// listen address, unless its operator names another or turns it off".
// Pure: it decides a public node's STUN setting from the environment
// alone, with no socket or filesystem reach. `env` is `MESH_STUN`'s
// value — `undefined` or empty, `'off'`, `<ip>:<port>`, or
// `[<ipv6>]:<port>`. A private node is refused for any set value, as
// `MESH_INTERFACE → NAT` has STUN serving from a public address.

import { isIPv4, isIPv6 } from 'node:net';
import { MeshConfigError } from '../config.js';
import { STUN_PORT } from '../protocols.js';

// A listen multiaddr of the form `/ip4/<ip>/udp/<port>/webrtc-direct`
// (optionally continuing). The IP capture is what the derived STUN
// setting binds to.
const WEBRTC_DIRECT_LISTEN_RE = /^\/ip4\/([0-9.]+)\/udp\/\d+\/webrtc-direct(?:\/|$)/;

export function stunSettingFor(
  role: 'public' | 'private',
  listen: readonly string[],
  env: string | undefined,
): { host: string; port: number } | undefined {
  if (role === 'private') {
    if (env === undefined || env === '' || env === 'off') return undefined;
    throw new MeshConfigError('MESH_STUN refused: a private node does not serve STUN');
  }
  // Public role.
  if (env === 'off') return undefined;
  if (env === undefined || env === '') {
    for (const a of listen) {
      const m = WEBRTC_DIRECT_LISTEN_RE.exec(a);
      if (m) return { host: m[1]!, port: STUN_PORT };
    }
    return undefined;
  }
  return parseExplicit(env);
}

function parseExplicit(v: string): { host: string; port: number } {
  let host: string;
  let portStr: string;
  if (v.startsWith('[')) {
    const idx = v.indexOf(']:');
    if (idx < 0) {
      throw new MeshConfigError(
        `MESH_STUN bracketed host must end with ]:<port>, not ${JSON.stringify(v)}`,
      );
    }
    host = v.substring(1, idx);
    portStr = v.substring(idx + 2);
    if (!isIPv6(host)) {
      throw new MeshConfigError(
        `MESH_STUN bracketed host must be an IPv6, not ${JSON.stringify(host)}`,
      );
    }
  } else {
    const idx = v.lastIndexOf(':');
    if (idx < 0) {
      throw new MeshConfigError(`MESH_STUN must be <ip>:<port>, not ${JSON.stringify(v)}`);
    }
    host = v.substring(0, idx);
    portStr = v.substring(idx + 1);
    if (!isIPv4(host)) {
      throw new MeshConfigError(
        `MESH_STUN host must be an IPv4 (or [IPv6]), not ${JSON.stringify(host)}`,
      );
    }
  }
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new MeshConfigError(
      `MESH_STUN port must be 0..65535, not ${JSON.stringify(portStr)}`,
    );
  }
  return { host, port };
}
