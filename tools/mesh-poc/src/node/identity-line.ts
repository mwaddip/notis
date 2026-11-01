// MESH_INTERFACE → Discovery → "A node added by hand" — "A private node
// prints its local WebRTC-direct address with its key, for its operator
// to hand over, and announces it to no one". Pure: the identity line a
// mesh node prints at start and on every address change.

/**
 * Build the identity line's `localAddrs` from a node's listener
 * addresses: WebRTC-direct ones with a `/certhash/` component, each
 * ending in `/p2p/<peerId>`. Pure.
 */
export function localAddrsFor(
  role: 'public' | 'private',
  listenerAddrs: readonly string[],
  peerId: string,
): string[] {
  // Stub — the real derivation lands in Task 8's feat commit.
  void role; void listenerAddrs; void peerId;
  return [];
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
