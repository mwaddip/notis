// MESH_INTERFACE → NAT — "A client's STUN list comes from the public
// nodes it holds, never a fixed list: from each node not `blacklisted`,
// each address's first `/ip4/<ip>/udp/<port>/webrtc-direct` component
// on an IP the gater's list does not hold — a relayed address's relay
// hop included — as `stun:<ip>:3478`, one per IP; verified nodes
// (`ok`, `trailing`, `behind`) first, the fastest first; at most
// `STUN_SERVERS_MAX`. With no public node held the list is empty, and
// the ICE configuration names no server."
// Pure, browser-safe (MESH_INTERFACE → Place in the workspace).

import { multiaddr } from '@multiformats/multiaddr';
import { isPrivate } from '@libp2p/utils';
import type { NodeEntry, NodeStatus } from './node-list.js';
import { STUN_PORT } from '../protocols.js';

export function stunServersFor(entries: readonly NodeEntry[], max: number): string[] {
  // Preserve input order as a tiebreak via the entry's index. The
  // sort runs within each group so a verified set of ties on readMs
  // keeps its list order; the groups themselves are concatenated.
  const kept = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.status !== 'blacklisted');
  const verifiedFirst: Array<{ e: NodeEntry; i: number }> = [];
  const rest: Array<{ e: NodeEntry; i: number }> = [];
  for (const row of kept) {
    (isVerified(row.e.status) ? verifiedFirst : rest).push(row);
  }
  const bySpeedThenIndex = (
    a: { e: NodeEntry; i: number },
    b: { e: NodeEntry; i: number },
  ): number => {
    const ar = a.e.readMs;
    const br = b.e.readMs;
    if (ar === null && br === null) return a.i - b.i;
    if (ar === null) return 1;
    if (br === null) return -1;
    if (ar !== br) return ar - br;
    return a.i - b.i;
  };
  verifiedFirst.sort(bySpeedThenIndex);
  rest.sort(bySpeedThenIndex);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const { e } of [...verifiedFirst, ...rest]) {
    for (const addr of e.addrs) {
      const ip = firstPublicIp4Webrtc(addr);
      if (ip === null) continue;
      if (seen.has(ip)) continue;
      seen.add(ip);
      out.push(`stun:${ip}:${STUN_PORT}`);
      if (out.length >= max) return out;
    }
  }
  return out;
}

function isVerified(s: NodeStatus): boolean {
  return s === 'ok' || s === 'trailing' || s === 'behind';
}

/**
 * The FIRST `/ip4/<ip>/udp/<n>/webrtc-direct` triple in the multiaddr
 * whose IP `isPrivate` does not refuse. A relayed address
 * `.../ip4/<relay>/udp/<n>/webrtc-direct/.../p2p-circuit/.../p2p/<x>`
 * carries the relay's hop FIRST (parsed by @multiformats/multiaddr),
 * so a relayed public-node address contributes the relay's IP.
 */
function firstPublicIp4Webrtc(addr: string): string | null {
  let components;
  try {
    components = multiaddr(addr).getComponents();
  } catch {
    return null;
  }
  for (let i = 0; i + 2 < components.length; i += 1) {
    if (components[i]!.name !== 'ip4') continue;
    if (components[i + 1]!.name !== 'udp') continue;
    if (components[i + 2]!.name !== 'webrtc-direct') continue;
    const ip = components[i]!.value;
    if (ip === undefined) continue;
    let ipMa;
    try {
      ipMa = multiaddr(`/ip4/${ip}`);
    } catch {
      continue;
    }
    if (isPrivate(ipMa)) continue;
    return ip;
  }
  return null;
}
