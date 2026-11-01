// MESH_INTERFACE → Discovery → "A node added by hand" — "A private node
// prints its local WebRTC-direct address with its key, for its operator
// to hand over, and announces it to no one". Pure: the identity line a
// mesh node prints at start and on every address change.
//
// `listenerAddrs` is the flat list of every transport listener's own
// `getAddrs()`, so a private node's WebRTC-direct listen address — with
// the certificate hash the listener splices on at `getAddrs` time
// (`@libp2p/webrtc` `private-to-public/listener.ts` `getAddrs()`:
// `ma.encapsulate(/webrtc-direct/certhash/<hash>)`) — reaches
// `localAddrsFor` with its `/certhash/` component. The identity line's
// `localAddrs` is empty for a public node, which announces its
// WebRTC-direct listen addresses already (`MESH_INTERFACE → NAT →
// "A public node announces its listen addresses from the start"`).

const WEBRTC_DIRECT_WITH_CERTHASH_RE = /\/webrtc-direct\/certhash\//;
const CIRCUIT_RE = /\/p2p-circuit(?:\/|$)/;

/**
 * Build the identity line's `localAddrs` from a node's listener
 * addresses: WebRTC-direct ones with a `/certhash/` component, each
 * ending in `/p2p/<peerId>`. Pure.
 *
 * MESH_INTERFACE → Discovery → "A node added by hand" — "A private
 * node prints its local WebRTC-direct address with its key, for its
 * operator to hand over, and announces it to no one". `localAddrs`
 * is the node's own WebRTC-direct listen addresses alone, so an
 * address whose first `/webrtc-direct/certhash/` is a relay hop
 * before `/p2p-circuit/` (a listener a browser cannot reach the
 * private node at) is dropped.
 */
export function localAddrsFor(
  role: 'public' | 'private',
  listenerAddrs: readonly string[],
  peerId: string,
): string[] {
  if (role !== 'private') return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of listenerAddrs) {
    if (!WEBRTC_DIRECT_WITH_CERTHASH_RE.test(a)) continue;
    if (CIRCUIT_RE.test(a)) continue;
    const withPeer = a.endsWith(`/p2p/${peerId}`) ? a : `${a}/p2p/${peerId}`;
    if (seen.has(withPeer)) continue;
    seen.add(withPeer);
    out.push(withPeer);
  }
  return out;
}

export interface IdentityLine {
  readonly notisId: string;
  readonly peerId: string;
  readonly multiaddrs: readonly string[];
  readonly localAddrs: readonly string[];
}

/**
 * The whole identity line, serialised by `main.ts` as one JSON
 * object. `multiaddrs` is `getMultiaddrs()` as it stands; `localAddrs`
 * carries a private node's own WebRTC-direct listen with the certhash
 * and the peer id, so an operator can hand it over to a reader
 * (`MESH_INTERFACE → Discovery → "A node added by hand"`).
 */
export function buildIdentityLine(opts: {
  notisId: string;
  peerId: string;
  role: 'public' | 'private';
  multiaddrs: readonly string[];
  listenerAddrs: readonly string[];
}): IdentityLine {
  return {
    notisId: opts.notisId,
    peerId: opts.peerId,
    multiaddrs: [...opts.multiaddrs],
    localAddrs: localAddrsFor(opts.role, opts.listenerAddrs, opts.peerId),
  };
}
