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

export function stunSettingFor(
  role: 'public' | 'private',
  listen: readonly string[],
  env: string | undefined,
): { host: string; port: number } | undefined {
  // Stub — the real derivation lands in Task 8's feat commit.
  void role; void listen; void env; void STUN_PORT; void MeshConfigError;
  void isIPv4; void isIPv6;
  return undefined;
}
