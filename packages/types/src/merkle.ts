import { hash32 } from './hash.js';
import { bytesToHex, hexToBytes } from './codec.js';
import type { UtxoTxTree } from './block.js';

/**
 * Domain-separated leaf hash for Merkle trees.
 * Prevents cross-tree collision (two different domains hash the same
 * underlying bytes to different leaves).
 */
export function leafHash(domain: string, data: Uint8Array): Uint8Array {
  const domainBytes = new TextEncoder().encode(domain + '\0');
  return hash32(domainBytes, data);
}

/**
 * Domain tag prefixed to every internal Merkle node (TYPES_INTERFACE → Merkle primitives).
 *
 * `leafHash` prefixes its input with `utf8(domain + "\0")`, so every leaf
 * preimage begins with the first byte of a domain string. The **two** live
 * domains are `utxotx` and `utxotx-bytes` — both non-empty printable ASCII,
 * so NUL can never start a leaf preimage, which makes 0x00 a safe reserved
 * tag for internal nodes. Any future leaf domain must likewise be a
 * non-empty printable string.
 *
 * ⚠ **There is ONE list and it is TYPES_INTERFACE → Merkle primitives.** This
 * comment mirrors it and must be re-derived against it rather than edited from
 * memory — a live/retired list restated in two places is the drift class the
 * contract names, and it has already had one instance.
 *
 * Without the tag, `nodeHash(left, right)` is a bare hash of 64 concatenated
 * bytes, so a 64-byte leaf preimage could be re-presented as an internal node
 * to forge an inclusion proof (second-preimage).
 */
const NODE_TAG = Uint8Array.of(0x00);

/**
 * Hash of two child nodes in the Merkle tree: `blake2b512(NODE_TAG ‖ left ‖ right)[:32]`.
 *
 * Protocol-breaking relative to the untagged form — it changes every
 * `utxoTxRoot`. `PROTOCOL_VERSION` is unchanged; devnet DBs
 * are wiped on deploy. Producer (block-creator) and verifier (block-apply)
 * both derive roots through this function, so they stay in agreement.
 */
export function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return hash32(NODE_TAG, left, right);
}

/**
 * Build a standard binary Merkle root from an ordered list of leaf hashes.
 * Empty tree → 32 zero bytes. Single leaf → that leaf IS the root.
 */
export function buildMerkleRoot(leafHashes: Uint8Array[]): Uint8Array {
  if (leafHashes.length === 0) {
    return new Uint8Array(32);
  }
  if (leafHashes.length === 1) {
    return leafHashes[0]!;
  }
  let level = leafHashes;
  while (level.length > 1) {
    const nextLevel: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        nextLevel.push(nodeHash(level[i]!, level[i + 1]!));
      } else {
        nextLevel.push(level[i]!);
      }
    }
    level = nextLevel;
  }
  return level[0]!;
}

/**
 * The block's one committed root — 64 lowercase hex (TYPES_INTERFACE →
 * Merkle primitives, → Ordering block).
 *
 * The leaves are laid in `UtxoTxTree`'s field order: every `utxoTxIds` entry
 * under `'utxotx'`, then every `utxoTxs` element under `'utxotx-bytes'`. An
 * id leaf's preimage is the id's 32 bytes; a bytes leaf's preimage is the
 * element as it stands in the body — this function decodes nothing. A body
 * of `n` transactions is `2n` leaves, so a Merkle path proves one leaf and
 * pairing an id with its bytes needs the leaf count.
 *
 * Throws where `hexToBytes` throws — an id that is not even-length lowercase
 * hex. The domain is the caller's (VALIDATION_INTERFACE → verifyUtxoTxRoot).
 */
export function computeUtxoTxRoot(tree: UtxoTxTree): string {
  const leaves: Uint8Array[] = [];
  for (const id of tree.utxoTxIds) leaves.push(leafHash('utxotx', hexToBytes(id)));
  for (const bytes of tree.utxoTxs) leaves.push(leafHash('utxotx-bytes', bytes));
  return bytesToHex(buildMerkleRoot(leaves));
}
