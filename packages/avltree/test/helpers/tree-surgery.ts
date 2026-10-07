/**
 * Test-only surgery producing invariant-violating prover trees (installed via
 * restoreRoot): a label stub, or a key-less internal node, as some internal
 * node's right child. A lookup whose search reaches the pivot descends into
 * that child when its key is at least the pivot's: in found mode for the
 * pivot's own key (after the equality step), in search mode above it.
 */
import { BatchAVLProver } from '../../src/prover.js'
import { compareBytes, label, newInternal, newLabel, type AvlNode, type InternalNode } from '@ergots/avltree'

export const SEVEN_KEYS = [10, 20, 30, 40, 50, 60, 70] as const

export function keyOf(b: number, keyLength = 32): Uint8Array {
  const k = new Uint8Array(keyLength)
  k[0] = b
  k[keyLength - 1] = b
  return k
}

/** A prover over SEVEN_KEYS (value = [b]), rebased to a clean proof cycle. */
export function sevenKeyProver(keyLength = 32): BatchAVLProver {
  const p = new BatchAVLProver(keyLength, null)
  for (const b of SEVEN_KEYS) {
    if (!p.performOneOperation({ tag: 'Insert', key: keyOf(b, keyLength), value: new Uint8Array([b]) }).success) {
      throw new Error('sevenKeyProver: insert failed')
    }
  }
  p.generateProof()
  return p
}

/** First internal node (pre-order) with an internal right child and a key above `above`. */
export function pivot(root: AvlNode, above: Uint8Array): InternalNode {
  const stack: AvlNode[] = [root]
  while (stack.length > 0) {
    const n = stack.pop()!
    if (n.kind !== 'internal') continue
    if (n.right.kind === 'internal' && n.key !== undefined && compareBytes(n.key, above) > 0) return n
    stack.push(n.right, n.left)
  }
  throw new Error('pivot: no internal node with an internal right child above the bound')
}

function withRightChild(root: AvlNode, target: InternalNode, replacement: AvlNode): AvlNode {
  let replaced = false
  const rebuild = (n: AvlNode): AvlNode => {
    if (n === target) {
      replaced = true
      return newInternal(target.left, replacement, target.balance, target.key)
    }
    if (n.kind !== 'internal') return n
    return newInternal(rebuild(n.left), rebuild(n.right), n.balance, n.key)
  }
  const out = rebuild(root)
  if (!replaced) throw new Error('withRightChild: target is not in the tree')
  return out
}

/** `target`'s right child replaced by a label stub carrying the same label. */
export function stubRight(root: AvlNode, target: InternalNode): AvlNode {
  return withRightChild(root, target, newLabel(label(target.right)))
}

/** `target`'s right child replaced by a key-less copy (same label: keys are not hashed). */
export function keylessRight(root: AvlNode, target: InternalNode): AvlNode {
  const r = target.right
  if (r.kind !== 'internal') throw new Error('keylessRight: right child is not internal')
  return withRightChild(root, target, newInternal(r.left, r.right, r.balance))
}
