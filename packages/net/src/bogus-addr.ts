import { multiaddr } from '@multiformats/multiaddr';
import { MAGIC_MAINNET } from './frame.js';

/**
 * Bogus-address classification for peer discovery
 * (NET_INTERFACE → Bogus Address Classification).
 *
 * Addresses arriving in `Peers` messages are hearsay from untrusted peers; the
 * ones that can never be a dialable public peer are dropped before they reach
 * PeerDb — silently, because a NAT'd peer advertising its private address is
 * normal, not misbehavior.
 *
 * Two tiers: ranges that are bogus on any network, and ranges (RFC 1918,
 * CGN, documentation, unique-local) that are legitimate on a testnet/LAN and
 * bogus only when `magic` is mainnet's.
 */

// Multiaddr protocol codes for the IP transports (fixed by the multicodec
// table).
const CODE_IP4 = 4;
const CODE_IP6 = 41;

/**
 * Parse a dotted-quad IPv4 string into its 4 bytes, or null when the input is
 * not four 0–255 decimal octets separated by `.`. `multiaddr().getComponents()`
 * reports an ip4 component's `value` as the dotted-quad string, so classification
 * reconstructs the bytes `isBogusIp4` reads.
 */
function parseIp4Bytes(value: string): Uint8Array | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const p = parts[i]!;
    if (p.length === 0 || p.length > 3) return null;
    for (let j = 0; j < p.length; j++) {
      const c = p.charCodeAt(j);
      if (c < 48 || c > 57) return null;
    }
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    out[i] = n;
  }
  return out;
}

/**
 * Parse an IPv6 string into its 16 bytes, or null when the input is not a
 * well-formed address. Expands a single `::` to the zero groups that complete
 * the eight 16-bit groups, including a `::` at either end
 * (`::1`, `fe80::`) and no `::` at all (every group present).
 */
function parseIp6Bytes(value: string): Uint8Array | null {
  const dblIdx = value.indexOf('::');
  // At most one `::` may appear.
  if (dblIdx !== -1 && value.indexOf('::', dblIdx + 1) !== -1) return null;

  let head: string[];
  let tail: string[];
  if (dblIdx === -1) {
    head = value.split(':');
    tail = [];
  } else {
    const headPart = value.slice(0, dblIdx);
    const tailPart = value.slice(dblIdx + 2);
    head = headPart === '' ? [] : headPart.split(':');
    tail = tailPart === '' ? [] : tailPart.split(':');
  }

  // Each `::` fill-in produces at least one group; without `::` all eight must
  // be named.
  if (dblIdx === -1) {
    if (head.length !== 8) return null;
  } else {
    if (head.length + tail.length >= 8) return null;
  }

  const groups: number[] = [];
  for (const g of head) {
    const n = parseIp6Group(g);
    if (n === null) return null;
    groups.push(n);
  }
  const fill = 8 - head.length - tail.length;
  for (let i = 0; i < fill; i++) groups.push(0);
  for (const g of tail) {
    const n = parseIp6Group(g);
    if (n === null) return null;
    groups.push(n);
  }
  if (groups.length !== 8) return null;

  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    out[i * 2] = (groups[i]! >> 8) & 0xff;
    out[i * 2 + 1] = groups[i]! & 0xff;
  }
  return out;
}

function parseIp6Group(g: string): number | null {
  if (g.length === 0 || g.length > 4) return null;
  let n = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g.charCodeAt(i);
    let d: number;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (c >= 97 && c <= 102) d = c - 97 + 10;
    else if (c >= 65 && c <= 70) d = c - 65 + 10;
    else return null;
    n = (n << 4) | d;
  }
  return n;
}

function isBogusIp4(b: Uint8Array, mainnet: boolean): boolean {
  const o0 = b[0] ?? 0;
  const o1 = b[1] ?? 0;
  const o2 = b[2] ?? 0;
  const o3 = b[3] ?? 0;

  // Always bogus, any network.
  if (o0 === 127) return true; // loopback 127/8
  if (o0 === 169 && o1 === 254) return true; // link-local 169.254/16
  if (o0 >= 224 && o0 <= 239) return true; // multicast 224/4
  if (o0 >= 240) return true; // reserved Class E 240/4, incl. broadcast 255.255.255.255
  if (o0 === 0 && o1 === 0 && o2 === 0 && o3 === 0) return true; // unspecified 0.0.0.0
  if (o0 === 198 && (o1 === 18 || o1 === 19)) return true; // benchmark 198.18/15

  if (!mainnet) return false;

  // Mainnet-only bogus — valid on testnet/LAN.
  if (o0 === 10) return true; // RFC 1918 10/8
  if (o0 === 172 && o1 >= 16 && o1 <= 31) return true; // RFC 1918 172.16/12
  if (o0 === 192 && o1 === 168) return true; // RFC 1918 192.168/16
  if (o0 === 100 && o1 >= 64 && o1 <= 127) return true; // CGN 100.64/10
  if (o0 === 192 && o1 === 0 && o2 === 2) return true; // documentation 192.0.2/24
  if (o0 === 198 && o1 === 51 && o2 === 100) return true; // documentation 198.51.100/24
  if (o0 === 203 && o1 === 0 && o2 === 113) return true; // documentation 203.0.113/24

  return false;
}

function isBogusIp6(b: Uint8Array, mainnet: boolean): boolean {
  const o0 = b[0] ?? 0;
  const o1 = b[1] ?? 0;

  // Always bogus, any network.
  if (o0 === 0xff) return true; // multicast ff00::/8
  if (o0 === 0xfe && (o1 & 0xc0) === 0x80) return true; // link-local fe80::/10

  let leadingZero = 0;
  while (leadingZero < 16 && b[leadingZero] === 0) leadingZero++;
  // loopback ::1 and unspecified :: — 15 zero bytes then 0x00 or 0x01
  if (leadingZero >= 15 && (b[15] === 0 || b[15] === 1)) return true;
  // IPv4-mapped ::ffff:0:0/96 — 10 zero bytes then 0xffff
  if (leadingZero >= 10 && b[10] === 0xff && b[11] === 0xff) return true;

  if (!mainnet) return false;

  // Mainnet-only bogus — valid on testnet/LAN.
  if ((o0 & 0xfe) === 0xfc) return true; // unique-local fc00::/7
  if (o0 === 0x20 && o1 === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // documentation 2001:db8::/32

  return false;
}

/**
 * True when `addr` can never name a dialable peer on the network identified by
 * `magic`.
 *
 * `addr` is a multiaddr string; classification runs on the raw bytes of its
 * first `ip4`/`ip6` component — the dial target. Fails closed: a string that
 * does not parse as a multiaddr, or parses to one with no IP component, is
 * bogus. Never throws.
 */
export function isBogusAddress(addr: string, magic: number): boolean {
  const mainnet = magic === MAGIC_MAINNET;

  let components: ReturnType<ReturnType<typeof multiaddr>['getComponents']>;
  try {
    components = multiaddr(addr).getComponents();
  } catch {
    return true;
  }

  for (const { code, value } of components) {
    if (code === CODE_IP4 && value !== undefined) {
      const bytes = parseIp4Bytes(value);
      if (bytes === null) return true;
      return isBogusIp4(bytes, mainnet);
    }
    if (code === CODE_IP6 && value !== undefined) {
      const bytes = parseIp6Bytes(value);
      if (bytes === null) return true;
      return isBogusIp6(bytes, mainnet);
    }
  }

  return true;
}

/**
 * True when `addr`'s dial target is a loopback address — 127/8 or ::1.
 *
 * Same parse as `isBogusAddress` — the first `ip4`/`ip6` component's raw bytes.
 * Chooses the handshake's advertised address (NET_INTERFACE → Handshake Body,
 * the `declaredAddress` row): a node declares its first listen address that is
 * not loopback, so a node listening on `0.0.0.0` does not declare the loopback
 * entry libp2p lists first. A string that does not parse, or names no IP
 * component (a `/dns4/…` name), is not loopback — it is dialable. Never throws.
 */
export function isLoopbackAddress(addr: string): boolean {
  let components: ReturnType<ReturnType<typeof multiaddr>['getComponents']>;
  try {
    components = multiaddr(addr).getComponents();
  } catch {
    return false;
  }

  for (const { code, value } of components) {
    if (code === CODE_IP4 && value !== undefined) {
      const bytes = parseIp4Bytes(value);
      if (bytes === null) return false;
      return bytes[0] === 127; // loopback 127/8
    }
    if (code === CODE_IP6 && value !== undefined) {
      const bytes = parseIp6Bytes(value);
      if (bytes === null) return false;
      let leadingZero = 0;
      while (leadingZero < 16 && bytes[leadingZero] === 0) leadingZero++;
      return leadingZero >= 15 && bytes[15] === 1; // loopback ::1
    }
  }

  return false;
}
