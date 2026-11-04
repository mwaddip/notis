// NET_INTERFACE → The mesh — `MeshConfig` makes a `NetNode` a mesh node.
// This run builds the public role alone; a `role: 'private'` or a `wss`
// is refused at `start` with `MeshConfigError` naming what is not built
// yet.

import type { MeshNetworkName } from './constants.js';

/**
 * `NET_INTERFACE → The mesh` — every refusal here is `MeshConfigError`,
 * thrown by `start` before any socket opens.
 */
export class MeshConfigError extends Error {
  override readonly name = 'MeshConfigError';
}

/**
 * `MESH_INTERFACE → Transports → "The WebRTC-direct certificate persists"`
 * — a state directory whose certificate cannot be read stops the node
 * at start, naming the directory, and is left as it is.
 */
export class MeshStateError extends Error {
  override readonly name = 'MeshStateError';
}

/**
 * `NET_INTERFACE → The mesh` — the configuration a mesh node runs
 * with. The public role alone is built here; the private role and the
 * secure WebSocket land in later runs.
 */
export interface MeshConfig {
  /**
   * `MESH_INTERFACE → NAT → "A node's role is its operator's setting"`.
   * `'private'` is refused by this run with `MeshConfigError` naming
   * the later run's subject.
   */
  readonly role: 'public' | 'private';
  /** `MESH_INTERFACE → Discovery → "The DHT is Notis's own"`. */
  readonly network: MeshNetworkName;
  /**
   * The mesh's listen addresses — a public node's WebRTC-direct among
   * them. A `/dns4/`, `/dns6/` or `/dnsaddr/` component is refused
   * (`MESH_INTERFACE → Discovery → "An address is a hint"`).
   */
  readonly listen: readonly string[];
  readonly announce?: readonly string[];
  /**
   * `MESH_INTERFACE → Transports → "The WebRTC-direct certificate
   * persists"` — the datastore directory the WebRTC-direct certificate
   * and the keychain's keys live in. The directory is created if
   * absent; a stored certificate that cannot be read (truncated, or
   * belonging to another key) is `MeshStateError`.
   */
  readonly stateDir: string;
  /**
   * `MESH_INTERFACE → The node endpoint` — the node's own HTTP API, the
   * endpoint's upstream. Every mesh `GET` and `POST` is forwarded here.
   */
  readonly httpBase: string;
  /**
   * `MESH_INTERFACE → The node endpoint` — the deadline the endpoint's
   * upstream `fetch` runs under; the client learns of the abort at its
   * own deadline. Absent, `@dagsocial/node-reads`' `REQUEST_TIMEOUT_MS`.
   */
  readonly upstreamTimeoutMs?: number;
  /**
   * `MESH_INTERFACE → NAT → "A node's role is its operator's setting"`
   * — a public node runs a STUN server at the IP of its first
   * WebRTC-direct listen address on `STUN_PORT`, unless its operator
   * names another or turns it off. Explicit `null` turns the server
   * off.
   */
  readonly stun?: { host: string; port: number } | null;
  /**
   * `MESH_INTERFACE → The IP certificate` — the secure WebSocket
   * fallback. Not built by this run; a set value is refused with
   * `MeshConfigError` naming the later run's subject.
   */
  readonly wss?: unknown;
}

const DNS_RE = /\/dns4\/|\/dns6\/|\/dnsaddr\//;
const WEBRTC_DIRECT_RE = /\/webrtc-direct(?:\/|$)/;

/**
 * `MESH_INTERFACE → Discovery → "An address is a hint"` — refuse an
 * address with a DNS component. `label` names the setting the address
 * came from, so the message points at the operator's input.
 */
export function assertNoDns(label: string, addrs: readonly string[]): void {
  for (const a of addrs) {
    if (DNS_RE.test(a)) {
      throw new MeshConfigError(`${label} address refused: ${a} carries a DNS component`);
    }
  }
}

/**
 * `MESH_INTERFACE → Transports / NAT` — the start-time refusals this
 * run's public role meets, before any socket opens. Private role and
 * the secure WebSocket are later runs.
 */
export function assertMeshConfig(mesh: MeshConfig): void {
  if (mesh.role === 'private') {
    throw new MeshConfigError(
      "mesh.role 'private' refused: the private role is not built yet (NET_INTERFACE → The mesh)",
    );
  }
  if (mesh.role !== 'public') {
    throw new MeshConfigError(`mesh.role refused: ${JSON.stringify(mesh.role)} is not 'public'`);
  }
  if (mesh.wss !== undefined) {
    throw new MeshConfigError(
      'mesh.wss refused: the secure WebSocket is not built yet (MESH_INTERFACE → The IP certificate)',
    );
  }
  assertNoDns('mesh.listen', mesh.listen);
  if (mesh.announce) assertNoDns('mesh.announce', mesh.announce);
  // MESH_INTERFACE → NAT → "A public node announces its listen
  // addresses from the start" — a public node without a WebRTC-direct
  // listen is unreachable by any browser, which is what a public node
  // exists for; refused at start naming the setting.
  let hasWebrtcDirect = false;
  for (const a of mesh.listen) {
    if (WEBRTC_DIRECT_RE.test(a)) { hasWebrtcDirect = true; break; }
  }
  if (!hasWebrtcDirect) {
    throw new MeshConfigError(
      'mesh.listen refused: a public node has no /webrtc-direct listen address',
    );
  }
  if (mesh.stun !== undefined && mesh.stun !== null) {
    const host = mesh.stun.host;
    // Reuse the DNS regex's spirit: a host that is neither an IPv4 nor
    // an IPv6 literal is a hostname, and a STUN hostname is never
    // legitimate (`MESH_INTERFACE → NAT → "Every STUN server is a mesh
    // node named by IP"`).
    if (!isIpLiteral(host)) {
      throw new MeshConfigError(
        `mesh.stun.host refused: ${JSON.stringify(host)} is not an IP literal`,
      );
    }
    if (!Number.isInteger(mesh.stun.port) || mesh.stun.port < 0 || mesh.stun.port > 65535) {
      throw new MeshConfigError(
        `mesh.stun.port refused: ${mesh.stun.port} is not a 0..65535 integer`,
      );
    }
  }
}

function isIpLiteral(s: string): boolean {
  // One permissive regex for both families; the STUN server's own
  // `isIPv4`/`isIPv6` holds the strict check at bind time.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    for (const p of s.split('.')) {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 0 || n > 255) return false;
    }
    return true;
  }
  // IPv6: a `:` character and no path separators; strict parsing is
  // deferred to the STUN server.
  return s.includes(':') && !s.includes('/');
}
