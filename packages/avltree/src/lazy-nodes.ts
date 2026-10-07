/**
 * Nodes loaded on first access. `lazyRoot(rootLabel, load, config)` answers a
 * tree whose nodes are read through `load` the first time the engine reaches
 * them: a node's label is known from its parent's row, and its children
 * resolve when the engine descends into it or labels it.
 *
 * This rests on the engine's lazy-node access invariant: the prover and the
 * verifier engine read a node's children (`left`, `right`) through plain
 * property access, and only when descending into or labeling that node — an
 * unvisited sibling's `left` / `right` is not read. Other fields (`kind`,
 * `key`, `balance`, `labelCache`) the engine does read of any node it
 * touches, an unvisited sibling that gets labeled among them, which is why a
 * node's own row is loaded with `labelCache` preset and only `left` / `right`
 * wait behind getters.
 *
 * See AVLTREE_INTERFACE → Nodes loaded on first access.
 */

import {
  deserializeNode,
  label,
  type AvlNode,
  type AvlTreeConfig,
  type InternalNode,
} from '@ergots/avltree'

/** The stored bytes of the node with the given label. */
export type LoadNode = (label: Uint8Array) => Uint8Array

/**
 * The tree rooted at `rootLabel`, where each node is deserialized from
 * `load(label)` on first access and its internal children are themselves
 * `lazyRoot` subtrees. For a leaf, `labelCache` is preset so the engine
 * labels it without a hash call. For an internal node, `labelCache` is
 * preset and `left` / `right` are getters that materialize their subtree
 * the first time they are read. Each subtree is loaded at most once.
 *
 * `load` is total or it throws: a label with no row is the caller's
 * corruption, and the throw reaches the caller of the operation. A
 * `LabelNode` is never handed to the engine from here — every row loaded
 * is a leaf or an internal.
 */
export function lazyRoot(
  rootLabel: Uint8Array,
  load: LoadNode,
  config: AvlTreeConfig,
): AvlNode {
  return makeLazy(rootLabel, load, config)
}

function makeLazy(
  nodeLabel: Uint8Array,
  load: LoadNode,
  config: AvlTreeConfig,
): AvlNode {
  const bytes = load(nodeLabel)
  const decoded = deserializeNode(bytes, config)
  if (decoded.kind === 'leaf') {
    decoded.labelCache = new Uint8Array(nodeLabel)
    return decoded
  }
  if (decoded.kind !== 'internal') {
    // A LabelNode row is a storage-level invariant violation: storage holds
    // only leaves and internals.
    throw new Error(
      `lazyRoot: a label-only row was stored for ${hex(nodeLabel)} — storage holds only leaves and internals`,
    )
  }
  // deserializeNode of an internal returns LabelNode stubs for left and
  // right; read their labels now (`label()` on a LabelNode is a plain field
  // read, no hashing), then replace with getters that materialize the real
  // subtree on first access.
  const leftLabel = label(decoded.left)
  const rightLabel = label(decoded.right)
  let L: AvlNode | null = null
  let R: AvlNode | null = null
  const lazy: InternalNode = {
    kind: 'internal',
    key: decoded.key,
    balance: decoded.balance,
    labelCache: new Uint8Array(nodeLabel),
    get left(): AvlNode {
      return (L ??= makeLazy(leftLabel, load, config))
    },
    get right(): AvlNode {
      return (R ??= makeLazy(rightLabel, load, config))
    },
  } as InternalNode
  return lazy
}

function hex(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}
