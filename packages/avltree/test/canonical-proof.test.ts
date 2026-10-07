import { describe, expect, it } from 'vitest'
import { matchesCanonicalProof } from '../src/canonical-proof.js'
import {
  label,
  newInternal,
  newLabel,
  newLeaf,
  type AvlNode,
} from '@ergots/avltree'
// parseProofPackedTree is not exported from @ergots/avltree — the deep-spine
// case uses BatchAVLVerifier's reconstructed root instead.
import { BatchAVLVerifier } from '../src/verifier.js'
import { SPINE_CONFIG, buildSpineDigest, buildSpineProof } from './helpers/deep-spine.js'

/** One-byte keys; the expected bytes below are written out by hand. */
const leaf = (key: number, value: number[], next: number) =>
  newLeaf(new Uint8Array([key]), new Uint8Array(value), new Uint8Array([next]))

/** `tree` bytes, then END_OF_TREE, then `directions`; the check with `bits` direction bits read. */
function check(
  root: AvlNode,
  visited: AvlNode[],
  valueLengthOpt: number | null,
  tree: number[],
  directions: number[] = [],
  bits = 0,
): boolean {
  const proof = new Uint8Array([...tree, 0x04, ...directions])
  const start = (tree.length + 1) * 8
  return matchesCanonicalProof(proof, root, new Set(visited), valueLengthOpt, start, start + bits)
}

describe('matchesCanonicalProof — the packed tree', () => {
  it('an unvisited root is one label, whatever its kind', () => {
    const stub = newLabel(new Uint8Array(32).fill(0x11))
    expect(check(stub, [], null, [0x03, ...new Uint8Array(32).fill(0x11)])).toBe(true)
    const l = leaf(0x10, [0xaa], 0x20)
    expect(check(l, [], null, [0x03, ...label(l)])).toBe(true)
    const n = newInternal(leaf(0x10, [1], 0x20), leaf(0x20, [2], 0x30), 0)
    expect(check(n, [], null, [0x03, ...label(n)])).toBe(true)
  })

  it('a visited leaf writes key, nextLeafKey, then the value — with a u32 length only when variable', () => {
    const l = leaf(0x10, [0xaa, 0xbb], 0x20)
    expect(check(l, [l], null, [0x02, 0x10, 0x20, 0, 0, 0, 2, 0xaa, 0xbb])).toBe(true)
    expect(check(l, [l], 2, [0x02, 0x10, 0x20, 0xaa, 0xbb])).toBe(true)
    // Each layout under the other config is a different proof.
    expect(check(l, [l], 2, [0x02, 0x10, 0x20, 0, 0, 0, 2, 0xaa, 0xbb])).toBe(false)
    expect(check(l, [l], null, [0x02, 0x10, 0x20, 0xaa, 0xbb])).toBe(false)
    const empty = leaf(0x10, [], 0x20)
    expect(check(empty, [empty], null, [0x02, 0x10, 0x20, 0, 0, 0, 0])).toBe(true)
    expect(check(empty, [empty], 0, [0x02, 0x10, 0x20])).toBe(true)
  })

  it('a leaf that follows a leaf omits its key, across an internal node balance byte too', () => {
    const l1 = leaf(0x10, [1], 0x20)
    const l2 = leaf(0x20, [2], 0x30)
    const l3 = leaf(0x30, [3], 0x40)
    const a = newInternal(l1, l2, 0)
    const root = newInternal(a, l3, -1)
    // l1 (key written), l2 (chained), a's balance, l3 (still chained), the root's balance -1 as 0xFF.
    const tree = [0x02, 0x10, 0x20, 1, 0x02, 0x30, 2, 0x00, 0x02, 0x40, 3, 0xff]
    expect(check(root, [root, a, l1, l2, l3], 1, tree)).toBe(true)
    // Writing l3's key where chaining applies is a different proof.
    const unchained = [0x02, 0x10, 0x20, 1, 0x02, 0x30, 2, 0x00, 0x02, 0x30, 0x40, 3, 0xff]
    expect(check(root, [root, a, l1, l2, l3], 1, unchained)).toBe(false)
  })

  it('a label resets key chaining', () => {
    const l1 = leaf(0x10, [1], 0x20)
    const l2 = leaf(0x20, [2], 0x30) // not visited: written as a label
    const l3 = leaf(0x30, [3], 0x40)
    const a = newInternal(l1, l2, 1)
    const root = newInternal(a, l3, 0)
    const tree = [0x02, 0x10, 0x20, 1, 0x03, ...label(l2), 0x01, 0x02, 0x30, 0x40, 3, 0x00]
    expect(check(root, [root, a, l1, l3], 1, tree)).toBe(true)
  })

  it('an unvisited subtree is one label and is not descended', () => {
    const inner = newInternal(leaf(0x20, [2], 0x30), leaf(0x30, [3], 0x40), 0)
    const l1 = leaf(0x10, [1], 0x20)
    const root = newInternal(l1, inner, 1)
    expect(check(root, [root, l1], 1, [0x02, 0x10, 0x20, 1, 0x03, ...label(inner), 0x01])).toBe(true)
    // The same subtree written in full, though unvisited, is not the canonical proof.
    const expanded = [0x02, 0x10, 0x20, 1, 0x03, ...label(inner.left), 0x03, ...label(inner.right), 0x00, 0x01]
    expect(check(root, [root, l1], 1, expanded)).toBe(false)
  })

  it('a difference anywhere in the tree, or at END_OF_TREE, is a mismatch', () => {
    const l = leaf(0x10, [0xaa], 0x20)
    const good = [0x02, 0x10, 0x20, 0xaa]
    expect(check(l, [l], 1, good)).toBe(true)
    for (let i = 0; i < good.length; i++) {
      const bad = [...good]
      bad[i] = bad[i]! ^ 1
      expect(check(l, [l], 1, bad), `byte ${i}`).toBe(false)
    }
    const start = (good.length + 1) * 8
    const noEnd = new Uint8Array([...good, 0x05])
    expect(matchesCanonicalProof(noEnd, l, new Set([l]), 1, start, start)).toBe(false)
    const truncated = new Uint8Array(good)
    expect(matchesCanonicalProof(truncated, l, new Set([l]), 1, start, start)).toBe(false)
    // The packed tree must end exactly where the caller says the directions start.
    const whole = new Uint8Array([...good, 0x04])
    expect(matchesCanonicalProof(whole, l, new Set([l]), 1, start, start)).toBe(true)
    expect(matchesCanonicalProof(whole, l, new Set([l]), 1, start + 8, start + 8)).toBe(false)
  })

  it('a visited label stub is an invariant violation', () => {
    const stub = newLabel(new Uint8Array(32).fill(0x11))
    expect(() => check(stub, [stub], null, [0x03, ...new Uint8Array(32).fill(0x11)])).toThrow(/label stub/)
  })

  it('a deep visited spine does not overflow the stack', () => {
    const depth = 100_000
    const proof = buildSpineProof(depth)
    // BatchAVLVerifier does the reconstruction `parseProofPackedTree` used to
    // do (ergots doesn't export it); reach into its core for root and the
    // post-END_OF_TREE direction-bit cursor.
    const v = new BatchAVLVerifier(buildSpineDigest(depth, 0xff), proof, SPINE_CONFIG)
    const core = (v as unknown as { core: { root: AvlNode | null; state: { directionsIndex: number } } }).core
    if (core.root === null) throw new Error('spine did not decode')
    const visited = new Set<AvlNode>()
    let node: AvlNode = core.root
    while (node.kind === 'internal') {
      visited.add(node)
      node = node.left
    }
    visited.add(node)
    const start = core.state.directionsIndex
    expect(matchesCanonicalProof(proof, core.root, visited, SPINE_CONFIG.valueLengthOpt, start, start)).toBe(true)
  })
})

describe('matchesCanonicalProof — the directions', () => {
  const l = leaf(0x10, [0xaa], 0x20)
  const tree = [0x02, 0x10, 0x20, 0xaa]

  it('needs exactly ceil(bits / 8) bytes after END_OF_TREE', () => {
    expect(check(l, [l], 1, tree, [], 0)).toBe(true)
    expect(check(l, [l], 1, tree, [0x00], 0)).toBe(false) // a trailing byte
    expect(check(l, [l], 1, tree, [0x05], 3)).toBe(true)
    expect(check(l, [l], 1, tree, [], 3)).toBe(false) // a missing byte
    expect(check(l, [l], 1, tree, [0xff], 8)).toBe(true)
    expect(check(l, [l], 1, tree, [0xff, 0x00], 8)).toBe(false)
    expect(check(l, [l], 1, tree, [0xff, 0x01], 9)).toBe(true)
    expect(check(l, [l], 1, tree, [0xff], 9)).toBe(false)
  })

  it('needs the unused high bits of a partial last byte to be zero', () => {
    // 3 bits read: 0b101. Bits 3..7 are padding.
    expect(check(l, [l], 1, tree, [0b0000_0101], 3)).toBe(true)
    for (let bit = 3; bit < 8; bit++) {
      expect(check(l, [l], 1, tree, [0b0000_0101 | (1 << bit)], 3), `padding bit ${bit}`).toBe(false)
    }
    // The bits that were read are the proof's own: any value matches.
    for (let v = 0; v < 8; v++) expect(check(l, [l], 1, tree, [v], 3)).toBe(true)
  })

  it('a range that ends before it starts is an invariant violation, never an answer', () => {
    // The caller's cursor only advances, so this cannot happen in a replay.
    const proof = new Uint8Array([...tree, 0x04])
    const start = (tree.length + 1) * 8
    for (let back = 1; back <= 8; back++) {
      expect(() => matchesCanonicalProof(proof, l, new Set([l]), 1, start, start - back), `${back} bits back`).toThrow(
        /end before they start/,
      )
    }
  })
})
