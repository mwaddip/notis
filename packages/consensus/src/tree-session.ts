/**
 * What one lookup answers (CONSENSUS_INTERFACE → The tree session): the leaf and
 * the next leaf's key, or — for an absent key — the keys either side of it. At
 * either end of the tree the neighbour is a sentinel (`isSentinel`).
 */
export type TreeLookup =
  | { found: true; value: Uint8Array; nextKey: Uint8Array }
  | { found: false; prevKey: Uint8Array; nextKey: Uint8Array };

/**
 * The one thing the tree view asks of a tree (CONSENSUS_INTERFACE → The tree
 * session): the node's prover, or a leaf's verifier over a block's proof. No
 * lookup is ever made of a sentinel.
 */
export interface TreeSession {
  lookup(key: Uint8Array): TreeLookup;
}

/** Whether `key` is a bound of the keyspace: every byte `0x00`, or every byte `0xff`. */
export function isSentinel(key: Uint8Array): boolean {
  return key.every((byte) => byte === 0x00) || key.every((byte) => byte === 0xff);
}
