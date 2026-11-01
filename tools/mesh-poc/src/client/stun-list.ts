// MESH_INTERFACE → NAT — "A client's STUN list comes from the public
// nodes it holds, never a fixed list: from each node not `blacklisted`,
// each address's first `/ip4/<ip>/udp/<port>/webrtc-direct` component
// on an IP the gater's list does not hold — a relayed address's relay
// hop included — as `stun:<ip>:3478`, one per IP; verified nodes
// (`ok`, `trailing`, `behind`) first, the fastest first; at most
// `STUN_SERVERS_MAX`. With no public node held the list is empty, and
// the ICE configuration names no server."
// Pure, browser-safe (MESH_INTERFACE → Place in the workspace).

import type { NodeEntry } from './node-list.js';

export function stunServersFor(_entries: readonly NodeEntry[], _max: number): string[] {
  // STUB — a case against the fully-implemented function reads red here
  // (feat(mesh-poc) replaces this body with the real derivation).
  throw new Error('stunServersFor not yet implemented');
}
