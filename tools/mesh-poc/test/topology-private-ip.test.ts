// MESH_INTERFACE → Transports → "A client dials a private address only
// when its own configuration names it" — the client's own connection
// gater refuses every address `isPrivateIp` matches but those its
// configuration names for a key. The stage's internet segment has to
// be outside the private-IP list; NAT-inside segments stay inside it,
// and a page reaches them only when the reader hands them to it. The
// whole class of DEFECT (a page that cannot dial any public anchor
// because every anchor's address matches a private range) rested on
// this.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// `@libp2p/utils`'s `isPrivateIp` is not exposed as a subpath export, so
// the test holds the same list (as of @libp2p/utils 7.4.5 —
// `src/private-ip.ts`). The client's own connection gater refuses every
// address that lies in any of these, unless the client's configuration
// names it for a key.
const PRIVATE_IP_RANGES = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
  '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.0.0.0/29', '192.0.0.8/32', '192.0.0.9/32',
  '192.0.0.10/32', '192.0.0.170/32', '192.0.0.171/32',
  '192.0.2.0/24', '192.31.196.0/24', '192.52.193.0/24',
  '192.88.99.0/24', '192.168.0.0/16', '192.175.48.0/24',
  '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
  '240.0.0.0/4', '255.255.255.255/32',
];

function ipv4ToUint(ip: string): number {
  const parts = ip.split('.').map((s) => parseInt(s, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return -1;
  }
  // The bitwise OR coerces the result into a 32-bit signed int. The
  // unsigned shape is `n >>> 0`.
  return (((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0);
}
function cidrMatches(ip: string, cidr: string): boolean {
  const [netAddr, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr!, 10);
  const n = ipv4ToUint(ip);
  const base = ipv4ToUint(netAddr!);
  if (n < 0 || base < 0) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffff_ffff : (0xffff_ffff << (32 - bits)) >>> 0;
  return ((n & mask) >>> 0) === ((base & mask) >>> 0);
}
function isPrivateIp(ip: string): boolean {
  for (const range of PRIVATE_IP_RANGES) {
    if (cidrMatches(ip, range)) return true;
  }
  return false;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const TOPOLOGY_PATH = join(HERE, '..', 'stage', 'topology.json');

interface Host {
  role: string;
  addr?: string;
  outsideAddr?: string;
  insideSubnet?: string;
  parent?: string;
}
interface Topology { hosts: Record<string, Host>; internet: { subnet: string; gateway: string } }

describe("topology.json: every public host's address sits outside the gater's private list, every NAT-inside segment inside it", () => {
  const topology = JSON.parse(readFileSync(TOPOLOGY_PATH, 'utf8')) as Topology;

  it("every public host's address is outside @libp2p/utils's private-ip list", () => {
    const bad: string[] = [];
    for (const [name, host] of Object.entries(topology.hosts)) {
      if (host.role !== 'public') continue;
      if (typeof host.addr !== 'string') continue;
      if (isPrivateIp(host.addr) === true) {
        bad.push(`${name}:${host.addr}`);
      }
    }
    expect(bad, `public hosts in a private range: ${bad.join(', ')}`).toEqual([]);
  });

  it('every NAT router\'s outside address is outside the private list', () => {
    const bad: string[] = [];
    for (const [name, host] of Object.entries(topology.hosts)) {
      if (host.role !== 'nat') continue;
      if (typeof host.outsideAddr !== 'string') continue;
      if (isPrivateIp(host.outsideAddr) === true) {
        bad.push(`${name}:${host.outsideAddr}`);
      }
    }
    expect(bad, `nat outside in private range: ${bad.join(', ')}`).toEqual([]);
  });

  it('every NAT-inside host\'s address IS inside the private list', () => {
    const bad: string[] = [];
    for (const [name, host] of Object.entries(topology.hosts)) {
      if (host.parent === undefined) continue;
      if (typeof host.addr !== 'string') continue;
      if (isPrivateIp(host.addr) === false) {
        bad.push(`${name}:${host.addr}`);
      }
    }
    expect(bad, `NAT-inside in public range: ${bad.join(', ')}`).toEqual([]);
  });

  it('the internet segment\'s gateway is outside the private list', () => {
    const gw = topology.internet.gateway;
    expect(isPrivateIp(gw), `internet gateway ${gw}`).toBe(false);
  });

  it('every hostile host\'s address is outside the private list (hostiles live on the internet segment)', () => {
    const bad: string[] = [];
    for (const [name, host] of Object.entries(topology.hosts)) {
      if (host.role !== 'hostile') continue;
      if (typeof host.addr !== 'string') continue;
      if (isPrivateIp(host.addr) === true) {
        bad.push(`${name}:${host.addr}`);
      }
    }
    expect(bad, `hostiles in private range: ${bad.join(', ')}`).toEqual([]);
  });
});
