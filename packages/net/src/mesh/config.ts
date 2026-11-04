// NET_INTERFACE → The mesh — `MeshConfig` makes a `NetNode` a mesh node.
// A `wss` is refused at `start` with `MeshConfigError` naming what is
// not built yet.

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
 * with. The secure WebSocket lands in a later run.
 */
export interface MeshConfig {
  /**
   * `MESH_INTERFACE → NAT → "A node's role is its operator's setting"`.
   * A `public` node runs a circuit relay v2 server, AutoNAT v2 and a
   * STUN server; a `private` node takes a relay reservation on each of
   * its bootstrap peers and is reached through them.
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
   * off. A private node with `stun` set is refused.
   */
  readonly stun?: { host: string; port: number } | null;
  /**
   * `MESH_INTERFACE → NAT → "Every STUN server is a mesh node named by
   * IP"` — the `stun:<ip>:<port>` list a private node's WebRTC
   * transport gathers ICE candidates against. Each entry is held to
   * the same rule as the client's; a hostname entry is refused.
   */
  readonly stunServers?: readonly string[];
  /**
   * `MESH_INTERFACE → NAT → "A relay that does not answer never stops a private node"`
   * — the retry's exponential schedule: `RETRY_BASE_MS` doubled to a
   * cap at `RETRY_CAP_MS`. Absent, the contract's constants stand.
   * Tests inject small values to land reservations inside the suite
   * timeout.
   */
  readonly relayRetryBaseMs?: number;
  readonly relayRetryCapMs?: number;
  /**
   * `MESH_INTERFACE → NAT → "A relay that does not answer never stops a private node"`
   * — the deadline one `transportManager.listen([<relay>/p2p-circuit])`
   * attempt runs under, past which the attempt is a failure. Absent,
   * the contract's `RELAY_LISTEN_TIMEOUT_MS` stands. Tests inject
   * small values to land the timeout path inside the suite timeout.
   */
  readonly relayListenTimeoutMs?: number;
  /**
   * `MESH_INTERFACE → The IP certificate` — a public node's secure
   * WebSocket fallback: a TLS WebSocket listener for the node's bare
   * IP, obtained over ACME on the `http-01` challenge of
   * `challengePort`, renewed at half the lifetime, stopped at
   * `notAfter`. A private node with `wss` set, or `wss.ip` that is
   * not an IP literal, is refused at start.
   */
  readonly wss?: WssConfig;
}

/**
 * `MESH_INTERFACE → The IP certificate` — the operator-named fields
 * of the secure WebSocket fallback. The certificate source is built
 * at start from `acmeDirectory`, `ip`, `stateDir` and `challengePort`
 * (`src/mesh/wss.ts` / `src/mesh/acme.ts`).
 */
export interface WssConfig {
  readonly ip: string;
  readonly port: number;
  readonly acmeDirectory: string;
  readonly challengePort: number;
}

const DNS_RE = /\/dns4\/|\/dns6\/|\/dnsaddr\//;
const WEBRTC_DIRECT_RE = /\/webrtc-direct(?:\/|$)/;
// `MESH_INTERFACE → NAT → "Every STUN server is a mesh node named by
// IP"` — `stun:<ipv4>:<port>` or `stun:[<ipv6>]:<port>`. The port is
// a 1..5-digit integer; the strict 0..65535 check lands below.
const STUN_URL_RE = /^stun:(?:(\d{1,3}(?:\.\d{1,3}){3})|\[([0-9a-fA-F:]+)\]):(\d+)$/;

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
 * `MESH_INTERFACE → Transports / NAT` — the start-time refusals a
 * `MeshConfig` meets, before any socket opens. The secure WebSocket
 * lands in a later run.
 */
export function assertMeshConfig(mesh: MeshConfig): void {
  if (mesh.role !== 'public' && mesh.role !== 'private') {
    throw new MeshConfigError(`mesh.role refused: ${JSON.stringify(mesh.role)} is not 'public' or 'private'`);
  }
  // `MESH_INTERFACE → The IP certificate` — a public node opts in to
  // the secure WebSocket fallback by naming an IP certificate; a
  // private node has no public address worth a certificate, and a
  // non-IP `wss.ip` is a hostname (the IP certificate is for a bare
  // IP alone).
  if (mesh.wss !== undefined) {
    if (mesh.role === 'private') {
      throw new MeshConfigError('mesh.wss refused: a private node does not serve WSS');
    }
    if (!isIpLiteral(mesh.wss.ip)) {
      throw new MeshConfigError(
        `mesh.wss.ip refused: ${JSON.stringify(mesh.wss.ip)} is not an IP literal`,
      );
    }
  }
  assertNoDns('mesh.listen', mesh.listen);
  if (mesh.announce) assertNoDns('mesh.announce', mesh.announce);
  // MESH_INTERFACE → NAT → "A public node announces its listen
  // addresses from the start" — a public node without a WebRTC-direct
  // listen is unreachable by any browser, which is what a public node
  // exists for; refused at start naming the setting.
  if (mesh.role === 'public') {
    let hasWebrtcDirect = false;
    for (const a of mesh.listen) {
      if (WEBRTC_DIRECT_RE.test(a)) { hasWebrtcDirect = true; break; }
    }
    if (!hasWebrtcDirect) {
      throw new MeshConfigError(
        'mesh.listen refused: a public node has no /webrtc-direct listen address',
      );
    }
  }
  // MESH_INTERFACE → NAT — "STUN serves from a public address". A
  // private node with `stun` set is a config error at start, named
  // here; `stunSettingFor` catches it at its seam too.
  if (mesh.role === 'private' && mesh.stun !== undefined && mesh.stun !== null) {
    throw new MeshConfigError('mesh.stun refused: a private node does not serve STUN');
  }
  if (mesh.stun !== undefined && mesh.stun !== null) {
    const host = mesh.stun.host;
    // `MESH_INTERFACE → NAT → "Every STUN server is a mesh node named
    // by IP"` — a host that is neither IPv4 nor IPv6 is a hostname.
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
  // `MESH_INTERFACE → NAT → "Every STUN server is a mesh node named
  // by IP"` — each `stunServers` entry is `stun:<ip>:<port>`, port
  // in 0..65535. A hostname entry is refused.
  if (mesh.stunServers) {
    for (const url of mesh.stunServers) {
      const m = STUN_URL_RE.exec(url);
      if (!m) {
        throw new MeshConfigError(
          `mesh.stunServers refused: ${JSON.stringify(url)} is not stun:<ip>:<port>`,
        );
      }
      const port = Number(m[3]);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new MeshConfigError(
          `mesh.stunServers refused: ${JSON.stringify(url)}: port ${port} is not a 0..65535 integer`,
        );
      }
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
