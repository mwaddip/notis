# AVLTREE Interface Contract

## Scope

`@dagsocial/avltree` is the authenticated tree as Notis uses it: `@ergots/avltree` — a port of Ergo's AVL+ tree — and
the four things Notis needs that Ergo's tree does not have. **It is the one package of the workspace that imports
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
| `verifier` | `BatchAVLVerifier` — the step-by-step verifier with the neighbor lookup | `performLookupWithNeighbors`; → The depth guard |
| `strict-verifier` | `StrictBatchAVLVerifier` | → The strict verifier |
| `lazy-nodes` | `lazyRoot` (`LoadNode`) | → Nodes loaded on first access |
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

## The depth guard

**A proof is never deeper than the tree its digest declares.** A starting digest is the root's 32-byte label and, in
its last byte, the tree's height. Every path in a proof's decoded tree is a path in the tree that digest commits to,
so an honest proof is never deeper than the height it declares. Both step-by-step verifiers — `BatchAVLVerifier` and
`StrictBatchAVLVerifier`, through the core they share — refuse at construction a proof whose decoded tree is deeper:
the depth is measured over the decoded nodes, a label stub counting as a leaf, by a walk that does not recurse, and a
refusal poisons the verifier as a proof that fails to decode does — `digest()` is null, `getLastFailReason()` answers
`'proof-malformed'`, and every operation fails.

**What it holds the engine to**: `@ergots/avltree`'s per-operation descent recurses once a level, and a proof built
deep enough overflows the stack and escapes as a `RangeError` — measured in Node 22 at a depth between 2 000 and
5 000, on a lookup under a digest declaring 255. Under the guard a descent starts at most 255 levels deep, whatever a
node sends. Ergo's verifiers bound a proof's node count from the operations it serves (`maxNumOperations`,
`maxDeletes`) and check no depth, so the guard is this package's (→ Scope).

**`verifyAvlLookup`, passed through, is not guarded; its caller bounds it by the engine's own count**:
`maxNumOperations: 1, maxDeletes: 0`, at most 512 nodes under the largest height a digest declares, a proof over
that refused by the engine's decode before any descent — so a descent there is at most 255 levels deep. An honest
lookup proof carries at most `2h + 1` nodes over a tree of height `h`.

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

- **The neighbor lookups and the strict verifier**: the reports on present and absent keys and at both sentinels,
  the fail-stop on an inconsistent engine, and the strict answer in both directions — a prover's own proof is fully
  consumed, and each altered proof that replays to the right digest is refused.
- **The depth guard**: at both verifiers, a proof one level deeper than its digest declares is refused and one at
  the declared height is not; a prover's own proof passes under its own digest; a proof thousands of levels deep under
  a digest declaring 255 is refused with no throw. A lookup through `verifyAvlLookup` with the engine's count refuses
  the same deep proof with no throw.
- **Lazy against loaded**: a single lookup, an absent key, a neighbor lookup, a page of lookups in key order and an
  insert with a remove — proof and digest equal to the fully loaded prover's, the loads counted and bounded.
- **The bundle**: the package builds for a browser with no Node built-in (`ARCHITECTURE → Package boundaries`).

## Does NOT own

The tree's keys and value codecs (`TYPES_INTERFACE → Layout — tree records`); what the rules read and write
(`CONSENSUS_INTERFACE → The tree layout`); the store and the kept roots (`NODE_INTERFACE → AVL+ State Root`); the
engine (`@ergots/avltree`).
