import { label, newInternal, newLabel, newLeaf, type AvlNode, type AvlTreeConfig } from '@ergots/avltree'

/**
 * Mirrors the exposed consensus path (`@ergots/ergoscript`'s `savltree.ts`):
 * no `maxNumOperations`, so the node-count DoS bound (`computeMaxNodes`) is
 * inactive and reconstruction size is limited only by the proof bytes.
 */
export const SPINE_CONFIG: AvlTreeConfig = { keyLength: 1, valueLengthOpt: 1 }

export const LEAF_KEY = 0x10
export const LEAF_NEXT = 0x20
export const LEAF_VALUE = 0xaa
export const LABEL_FILL = 0x11

/**
 * Packed proof for a left spine of `depth` internal nodes over one leaf:
 * `LEAF`, then depth × (`LABEL`, `INTERNAL` balance 0), then END_OF_TREE.
 * Each INTERNAL token pops right = the just-pushed LABEL and left = the
 * subtree so far (proof-decode.ts::parseProofPackedTree's INTERNAL-token pop,
 * right then left), so the spine grows down the LEFT — the side `label()`
 * walks first (via `labelSubtree`; pre-fix, via direct recursion).
 * `directionBytes` (default 0) appends that many 0xFF bytes after
 * END_OF_TREE: all-left directions (a set bit means left,
 * tree-traversal.ts::nextDirectionIsLeft), so an operation can descend the
 * spine to its leaf. 4 + 34·depth + 1 + directionBytes bytes.
 */
export function buildSpineProof(depth: number, directionBytes = 0): Uint8Array {
  const out = new Uint8Array(4 + 34 * depth + 1 + directionBytes)
  let i = 0
  out[i++] = 0x02 // LEAF token
  out[i++] = LEAF_KEY
  out[i++] = LEAF_NEXT
  out[i++] = LEAF_VALUE
  for (let d = 0; d < depth; d += 1) {
    out[i++] = 0x03 // LABEL token
    out.fill(LABEL_FILL, i, i + 32)
    i += 32
    out[i++] = 0x00 // INTERNAL token — the byte IS the balance (0)
  }
  out[i++] = 0x04 // END_OF_TREE
  out.fill(0xff, i) // all-left directions
  return out
}

/**
 * Correct 33-byte starting digest for the same spine, built through the
 * public node constructors. Construction is iterative, and so is the final
 * `label()` call (the iterative `labelSubtree` port): it costs no native
 * stack frame per level, so any depth works here. Operations that descend
 * the spine still recurse, one frame per level (the recursion residual).
 * The height byte is unread on this config path: the digest check compares
 * only the first 32 bytes (proof-decode.ts::parseProofPackedTree's
 * digest-check comparison loop (first 32 bytes)), and without
 * `maxNumOperations` no node bound consults the height.
 */
export function buildSpineDigest(depth: number, heightByte: number): Uint8Array {
  let subtree: AvlNode = newLeaf(
    new Uint8Array([LEAF_KEY]),
    new Uint8Array([LEAF_VALUE]),
    new Uint8Array([LEAF_NEXT]),
  )
  for (let d = 0; d < depth; d += 1) {
    subtree = newInternal(subtree, newLabel(new Uint8Array(32).fill(LABEL_FILL)), 0)
  }
  const digest = new Uint8Array(33)
  digest.set(label(subtree), 0)
  digest[32] = heightByte
  return digest
}
