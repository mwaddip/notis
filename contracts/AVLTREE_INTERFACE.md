# AVLTREE Interface Contract

> ⚠ **AHEAD OF CODE (2026-10-07, the `@dagsocial/avltree` unit)** — the package does not exist yet. `consensus`, `node`
> and `nipopow-client` import `@ergots/avltree` 0.6.0 directly, which holds the neighbor lookups and the strict
> verifier itself. This contract states the package as it is to be built, against `@ergots/avltree` 0.7.0's extension
> surface.

## Scope

`@dagsocial/avltree` is the authenticated tree as Notis uses it: `@ergots/avltree` — a port of Ergo's AVL+ tree — and
the three things Notis needs that Ergo's tree does not have. **It is the one package of the workspace that imports
`@ergots/avltree`**; every other member imports the tree from here.

**It copies no engine code.** The descent, the rotations, the proof's encoding and decoding, a node's label and the
storage codec are `@ergots/avltree`'s and run as that package ships them. What this package adds, it adds through
that package's extension surface — the classes it exports for subclassing and the callbacks it passes to them. Where
an addition needs something of the engine that the surface lacks, the surface grows in `@ergots/avltree`; nothing is
re-implemented here.

## Place in the workspace

**Beside `@dagsocial/types`, below `@dagsocial/consensus`.** Its one dependency is `@ergots/avltree`, pinned to a
minor line (`~0.7.0`): the extension surface is that package's promise to this one, and a new minor is taken with
this package's suite run against it. It has no workspace dependency. **It imports no Node built-in, reads no Node
global, performs no I/O and holds no module-level state** — the node loader's rows reach it through a function its
caller supplies. The browser runs it as it is written (`ARCHITECTURE → Package boundaries`).

## What it holds

| Module | Exports | What it adds |
|---|---|---|
| `neighbors` | `NeighborLookup`, `NeighborLookupResult` | → Neighbor lookups |
| `prover` | `BatchAVLProver` — a subclass of `@ergots/avltree`'s | `performLookupWithNeighbors`, `unauthenticatedLookupWithNeighbors` |
| `verifier` | `BatchAVLVerifier` — the step-by-step verifier with the neighbor lookup | `performLookupWithNeighbors` |
| `strict-verifier` | `StrictBatchAVLVerifier` | → The strict verifier |
| `lazy-nodes` | `lazyRoot` (`NodeRow`, `LoadNode`) | → Nodes loaded on first access |
| the barrel | `PersistentBatchAVLProver`, `VersionedAVLStorage`, `AvlNode` and the node types, `AvlTreeConfig`, `Operation`, `label`, `newLeaf`, `newInternal`, `serializeNode`, `deserializeNode`, `verifyAvlLookup`, `AvlVerifyError` and its codes | nothing — `@ergots/avltree`'s own, passed through |

**The export list is what the workspace's source and suites call, not a promise** — a name nothing calls leaves the
barrel, and one a caller needs joins it with its caller.

## Neighbor lookups

A neighbor lookup is a `Lookup` that also answers the keys either side of the one asked:

```ts
NeighborLookup =
  | { found: true;  value: Uint8Array; nextKey: Uint8Array | null }
  | { found: false; prevKey: Uint8Array | null; nextKey: Uint8Array | null }
NeighborLookupResult = ({ success: true } & NeighborLookup) | { success: false }
```

`null` is a sentinel — no key below, or none above. Every buffer answered is a fresh copy.

**It is exactly the `Lookup` it wraps.** On the prover it records what `performOneOperation({ tag: 'Lookup', key })`
records and the proof carries the same bytes; on the verifier it consumes the same bytes and fails as that operation
fails. The report is read off the one leaf the engine resolves the lookup at, handed over by the engine's leaf
callback only after its leaf-position check has approved the leaf. **A successful lookup that observed other than
one leaf is an engine inconsistency**: it throws, and on the prover it sets the proof cycle's fail-stop mark.

`unauthenticatedLookupWithNeighbors` answers the same report from the prover's tree with nothing recorded.

The rules read state through these lookups alone (`CONSENSUS_INTERFACE → The tree session`); what a report proves
about an absent key and about a present key's `nextKey` is stated there.

## The strict verifier

`StrictBatchAVLVerifier` is the step-by-step verifier with one more answer: `isFullyConsumed()` — **whether the proof
it replayed is byte for byte the proof a prover writes for the operations performed.** It regenerates that proof from
what the replay visited and compares. A proof with bytes appended, a set padding bit, an unvisited node written in
full or a lookup recorded that the replay did not make replays to the right digest under the plain verifier and is
refused here.

**It is not Ergo's rule.** Ergo's verifiers accept proofs this check refuses. Notis' full nodes regenerate each
block's proof and compare it with the header's `adProofsRoot` (`NODE_INTERFACE → The block proof`), so a replay that
is to agree with them needs this answer (`CONSENSUS_INTERFACE → The tree session`).

## Nodes loaded on first access

```ts
LoadNode = (label: Uint8Array) => Uint8Array        // the stored bytes of the node with that label
lazyRoot(rootLabel: Uint8Array, load: LoadNode, config: AvlTreeConfig): AvlNode
```

`lazyRoot` answers a tree whose nodes are read through `load` the first time the engine reaches them: a node's label
is known from its parent's row, and its children resolve when the engine descends into it or labels it. **A prover
over such a root makes the proofs and digests a prover over the fully loaded tree makes, byte for byte** — for
lookups, neighbor lookups and writes — and loads only the nodes on the paths it walks and their siblings.

**This rests on a property `@ergots/avltree` states and tests** — its lazy-node access invariant: the engine reads a
node's children (`left`, `right`) by plain property access, and only when it descends into that node or labels it;
an unvisited sibling's children are not read. Every other field (`kind`, `key`, `balance`, `labelCache`) it reads of
any node it touches, an unvisited sibling among them — so a node's own row is loaded with its label preset, and only
its children wait. This package's suite holds the same property against the pinned version.

**`load` is total or it throws**: a label with no row is the caller's corruption, and the throw reaches the caller of
the operation. **A tree is never handed to the engine with `@ergots/avltree`'s label stubs in it** — a prover that
meets a stub fails the operation quietly and writes a proof of the root alone.

## Tests

- **Every suite `@ergots/avltree` 0.6.0 held for the neighbor lookups and the strict verifier**, moved as written,
  against the package's own classes.
- **The proof bytes do not move**: over the same tree and operations, this package's prover and verifiers answer the
  proofs, digests and reports `@ergots/avltree` 0.6.0's answered.
- **Lazy against loaded**: a single lookup, an absent key, a neighbor lookup, a page of lookups in key order and an
  insert with a remove — proof and digest equal to the fully loaded prover's, the loads counted and bounded.
- **The bundle**: the package builds for a browser with no Node built-in (`ARCHITECTURE → Package boundaries`).

## Does NOT own

The tree's keys and value codecs (`TYPES_INTERFACE → Layout — tree records`); what the rules read and write
(`CONSENSUS_INTERFACE → The tree layout`); the store and the kept roots (`NODE_INTERFACE → AVL+ State Root`); the
engine (`@ergots/avltree`).
