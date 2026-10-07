/**
 * The one condition this node stops for, and the one place that decides it.
 *
 * Everything else in the apply path is a *rejection*: a peer sent something
 * invalid, the node says no and stays up. That is the funnel's totality
 * property, and it is a property about **untrusted input** — no block a peer can
 * construct may take the node down.
 *
 * "Our own stored header cannot be hashed" is not in that class and cannot be
 * put in it. The ordering store's provenance is stated on `store/ordering.ts`'s
 * `createOrderingBlock`; the half this argument needs is the header-domain
 * gate, so every stored header cleared `verifyHeaderFieldDomains`. No peer can
 * cause this: it means local corruption or a bug in us, and the honest response
 * is to stop.
 *
 * The alternative is worse than stopping. A stored `prevBlock` that cannot be
 * hashed makes every subsequent block fail its chain-link check, forever, logged
 * as an unexpected failure — a node that rejects everything while staying up is
 * indistinguishable from a quiet network until somebody reads the logs.
 */

import { TREE_TAG } from '@dagsocial/types';
import type { TreeWrite } from '@dagsocial/consensus';
import { TreeInconsistencyError } from '@dagsocial/consensus';

/**
 * The ordering store is not what this node put there.
 *
 * A distinct type rather than a message, because the boundary has to *act*
 * differently on it, and a boundary that told it apart by matching on
 * `err.message` would be one rewording away from limping past a corrupt chain in
 * silence. `site` and `height` are fields for the same reason: the diagnostic
 * should not be parsed back out of prose. Each subclass supplies the sentence
 * that says *what* is wrong; the boundary supplies the policy.
 */
export abstract class CorruptChainStateError extends Error {
  constructor(readonly site: string, readonly height: number, detail: string) {
    super(`${site}: ${detail}`);
    this.name = new.target.name;
  }
}

/** A stored header that has no hash. */
export class UnhashableStoredHeaderError extends CorruptChainStateError {
  constructor(site: string, height: number) {
    super(
      site,
      height,
      `our stored header at height ${height} is outside the encodable domain — ` +
      `the ordering store disagrees with the apply gate ` +
      `(store/ordering.ts → createOrderingBlock)`,
    );
  }
}

/**
 * A stored block whose bytes do not decode.
 *
 * The positional format makes this the shape local corruption actually arrives
 * in: `writeVlqU` sentinels an out-of-domain value so the row is still
 * *written*, and `readVlqU` refuses the ten bytes past `MAX_SAFE_INTEGER` that
 * sentinel decodes to. The store read throws first, and `blockHash` is never
 * reached.
 *
 * **Why this is corrupt state and not a rejection, stated as provenance rather
 * than as a guess about the error class.** The decode that raises it reads a
 * row of `ordering_blocks`, and what that table holds is our own re-encoding of
 * a block that already cleared the apply gate — one INSERT, one `src` caller,
 * stated on `store/ordering.ts`'s `createOrderingBlock`. So there is no input a
 * peer can choose that reaches this decoder: a row that will not decode means
 * the row changed after we wrote it, or our writer and our reader disagree.
 * Corruption, or a bug in us. Both are what fail-stop is for.
 *
 * ⚠ **The distinction this type exists to keep is the one between those bytes
 * and the block's own**, and it is why the naming happens at the read rather
 * than at the apply funnel's catch. `decodeTx` over `utxoTxTree.utxoTxs[i]`
 * raises the same `ReaderError` class from bytes the *producer* chose. That
 * call has its own local catch and skips the entry, so recognising corruption
 * by error class at the funnel would not be exploitable today — but it would
 * make the funnel's totality-vs-untrusted-input property rest on that local
 * catch and on every future one, with a remote node-kill as the failure mode
 * and no test that would notice the day one is missing. Measured, not reasoned:
 * that arm was built and run, and the test pinning the producer-bytes direction
 * passed under it.
 *
 * The live reason, as opposed to that latent one, is reach. The store frame
 * names the fault so every reader raises one class, and every outer frame —
 * both registrations, the launched `resolveFork` promise, `finalizeBlock`,
 * the block creator, and the guarded provider and routes — is a boundary
 * (NODE_INTERFACE → "Reach is the live argument, not the halt").
 */
export class UnreadableStoredBlockError extends CorruptChainStateError {
  constructor(site: string, height: number, cause: unknown) {
    super(
      site,
      height,
      `our stored block at height ${height} does not decode ` +
      `(store/ordering.ts → createOrderingBlock) — ` +
      `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    // The reader's own diagnosis, kept whole. Which field of which struct
    // refused is the only thing that says *what* is corrupt, and re-deriving it
    // from the message is the prose-parsing this family refuses to do.
    this.cause = cause;
  }
}

/**
 * A height that should hold a block and does not.
 *
 * `ordering_blocks` holds exactly heights 1..MAX with no holes. Two facts hold
 * it, and they sit in different files.
 *
 * The **gate** is `applyBlockBody`'s chain-link check —
 * `block.header.height !== currentHeight + 1` is a rejection there, above the
 * insert. The store's writer has no height check of its own: it is exported and
 * takes whatever block it is handed, so the contiguity of the table is a
 * property of the path, never of the INSERT.
 *
 * The **single writer** is what makes that gate cover every row, and it is
 * stated on `store/ordering.ts`'s `createOrderingBlock`: one INSERT, one `src`
 * caller, which is the gated one. Both halves are needed — a gate on one of two
 * writers guarantees nothing.
 *
 * The one delete is reached only from `revertBlock` inside `reorg`'s strictly
 * top-down loop and inside its transaction. Nothing prunes blocks.
 * `getCurrentHeight()` is `MAX(height)`, so a hole does not lower the tip and
 * nothing else would notice it either.
 *
 * A missing block below a tip we do hold is therefore not "no block yet" — it is
 * the contiguity invariant broken.
 */
export class MissingStoredBlockError extends CorruptChainStateError {
  constructor(site: string, height: number) {
    super(
      site,
      height,
      `no block at height ${height}, below a tip we do hold — the ordering ` +
      `store is not contiguous (store/ordering.ts → createOrderingBlock)`,
    );
  }
}

/**
 * The AVL+ tree refuses one of its writes (NODE_INTERFACE → AVL+ State Root →
 * "The rules read the tree, and nothing else").
 *
 * `performOneOperation` answers `{ success: false }` for a `Remove` or an
 * `Update` of a key the tree lacks and an `Insert` of a key it holds;
 * `InsertOrUpdate` is total. A block's writes are `treeWritesOf` over the
 * block's own view of this tree (CONSENSUS_INTERFACE → The tree writes) and
 * genesis's are `seedTreeWrites` into the empty tree, so a refusal says **the
 * tree contradicts itself** — local state, never anything a peer sent. The
 * detail names the write, the key and the key's kind by its tag
 * (TYPES_INTERFACE → The tree keys), never a box for a key that is not one.
 *
 * Unreachable from peer input, which is what puts the condition outside the
 * funnel's totality promise. And a tree that refuses one block's write refuses
 * the *next* block's identically — so rejecting rather than stopping would reject
 * forever while staying up, the precise failure this file exists to prevent.
 */
export class DivergedStateTreeError extends CorruptChainStateError {
  constructor(
    site: string,
    height: number,
    readonly op: TreeWrite['tag'],
    readonly key: string,
  ) {
    super(
      site,
      height,
      `the AVL+ tree refused ${op} of the ${kindOfKey(key)} key ${key} at height ${height} — ` +
      refusalOf(op),
    );
  }
}

/** What a refused write says about the tree. */
function refusalOf(op: TreeWrite['tag']): string {
  switch (op) {
    case 'Remove':
      return 'the tree lacks the key the write removes';
    case 'Insert':
      return 'the tree already holds the key the write inserts';
    case 'Update':
      return 'the tree lacks the key the write updates';
    case 'InsertOrUpdate':
      return 'the library refused a write it performs whatever the key holds';
  }
}

/** A tree key's kind, named by its tag byte (TYPES_INTERFACE → The tree keys). */
function kindOfKey(keyHex: string): string {
  const tag = Number.parseInt(keyHex.slice(0, 2), 16);
  const named = Object.entries(TREE_TAG).find(([, value]) => value === tag);
  return named === undefined ? `untagged (0x${keyHex.slice(0, 2)})` : named[0];
}

/**
 * A read of this node's own AVL+ tree contradicts itself.
 *
 * `treeStateView`'s checked reads throw `consensus`'s `TreeInconsistencyError`
 * on an answer that cannot be honest — a `nextKey` not strictly above the key
 * looked up, an absent key's `prevKey` not strictly below it, a next key
 * naming a leaf the tree holds none for (CONSENSUS_INTERFACE → The tree
 * view). The session reads only this node's own prover, so the throw
 * examines nothing a peer sent — local corruption, or a bug in us, outside
 * the totality property's scope by construction
 * (NODE_INTERFACE → "What the funnel's totality catch is FOR"). `cause` is
 * the `TreeInconsistencyError` kept whole, for the reason
 * `UnreadableStoredBlockError` keeps its own: which neighbour disagreed is
 * the only thing that says what is corrupt, and re-deriving it from the
 * message is the prose-parsing this family refuses to do.
 */
export class InconsistentStateTreeError extends CorruptChainStateError {
  constructor(site: string, height: number, cause: TreeInconsistencyError) {
    super(
      site,
      height,
      `a read of this node's own tree contradicts itself at height ${height} — ${cause.message}`,
    );
    this.cause = cause;
  }
}

/**
 * A block journal inside retention is absent (NODE_INTERFACE → "Rollback").
 *
 * `purgeOldJournals` deletes strictly below `tip − maxReorgDepth`.
 * The fork walk's lowest non-genesis answer is `tip − maxReorgDepth + 1`,
 * and `reorg` reverts starting one above the fork point, so every height
 * `revertBlock` can be asked for is ≥ `tip − maxReorgDepth + 2` — inside
 * retention. When the fork walk reaches genesis (`tip ≤ maxReorgDepth`),
 * the purge argument is ≤ 0 and nothing is deleted.
 *
 * A missing journal is therefore a row the store lost, not a retention gap.
 */
export class MissingJournalError extends CorruptChainStateError {
  constructor(site: string, height: number) {
    super(
      site,
      height,
      `no block journal at height ${height} — inside retention ` +
      `(purgeOldJournals deletes strictly below tip − maxReorgDepth)`,
    );
  }
}

/**
 * No AVL version at or before a fork height the walk answers within
 * (NODE_INTERFACE → Configuration).
 *
 * `loadConfig` refuses `MAX_PROOF_HISTORY < maxReorgDepth`, so a missing
 * version is a row the store lost — reachable only through a `Config`
 * assembled without `loadConfig` (tests), or through store corruption.
 */
export class MissingStateVersionError extends CorruptChainStateError {
  constructor(site: string, height: number) {
    super(
      site,
      height,
      `no AVL version at or before fork height ${height} — ` +
      `loadConfig refuses MAX_PROOF_HISTORY < maxReorgDepth, ` +
      `so a missing version is a row the store lost`,
    );
  }
}

/**
 * A label the store resolves at a listed version has no row alive at that
 * version's height, or has two (NODE_INTERFACE → AVL+ State Root →
 * "A height of the proof window with no kept root is served from the store").
 *
 * The row predicate — `first_seen_height <= h AND (orphaned_at_height IS NULL
 * OR orphaned_at_height > h)` — resolves exactly one row per label at every
 * height a version is listed for (NODE_INTERFACE → AVL+ State Root →
 * "AVL storage shares nodes across versions; a row is a node's lifetime"), so
 * zero or two under that predicate means the lifetimes have been corrupted or
 * the store's writer and its reader disagree. Reachable only from a label
 * resolved against a listed version, so no input a peer sent arrives here —
 * local corruption, fail-stop, as a tree that contradicts itself under a
 * route's read is (→ InconsistentStateTreeError).
 */
export class InconsistentAvlNodeRowsError extends CorruptChainStateError {
  constructor(
    site: string,
    height: number,
    readonly labelHex: string,
    readonly rowCount: number,
  ) {
    super(
      site,
      height,
      rowCount === 0
        ? `Missing node for label ${labelHex} alive at height ${height} — ` +
          `the store lists a version at this height, so a label it resolves ` +
          `must have exactly one row alive here`
        : `Overlapping lifetimes for label ${labelHex} at height ${height} ` +
          `(${rowCount} rows) — a label's lifetimes never overlap under one height`,
    );
  }
}

/**
 * A version row already stands at the height being checkpointed — the store's
 * version history has run ahead of its chain (NODE_INTERFACE → AVL+ State Root).
 */
export class DuplicateStateVersionError extends CorruptChainStateError {
  constructor(site: string, height: number) {
    super(
      site,
      height,
      `a version row already stands at height ${height} — ` +
      `the store's version history has run ahead of its chain`,
    );
  }
}

/**
 * A block the apply funnel rejected during a reorg (NODE_INTERFACE → Fork
 * choice decides on verified headers, step 11). Distinct from
 * `CorruptChainStateError`: a rejected peer block is a peer's fault and does
 * not warrant fail-stop.
 */
export class ReorgBlockRejectedError extends Error {
  constructor(
    readonly height: number,
    readonly hash: string,
    reason?: string,
  ) {
    super(
      `reorg rejected block at height ${height} (${hash})` +
      (reason ? `: ${reason}` : ''),
    );
    this.name = 'ReorgBlockRejectedError';
  }
}

/**
 * The reorg abandoned its switch on a refusal that is not a consensus verdict
 * (NODE_INTERFACE → Fork choice decides on verified headers, step 10).
 *
 * Two classes reach here: `'acceptance'` (the future bound, re-run against
 * this node's clock at apply — MINING_INTERFACE → Header timestamp rules)
 * and `'local'` (the funnel's catch of an unexpected throw). Neither is
 * attributable to the peer, so the switch is abandoned with no mark, no
 * penalty and no memo.
 */
export class ReorgAbortedError extends Error {
  constructor(
    readonly height: number,
    readonly hash: string,
    readonly class_: 'acceptance' | 'local',
    readonly detail?: string,
  ) {
    super(
      `reorg aborted at height ${height} (${hash}): class=${class_}` +
      (detail ? `: ${detail}` : ''),
    );
    this.name = 'ReorgAbortedError';
  }
}

/**
 * The boundary. Diagnostic first, death second; everything else re-thrown
 * unchanged, so no other error changes shape by passing through here.
 *
 * Call it from the outermost frame of every path that can reach
 * `applyOrderingBlock`, fork resolution, or a stored-block read — and from a
 * frame the runtime cannot quietly reinterpret. The contained frames that would
 * otherwise swallow a family member are `net`'s sync-machine dispatch catches
 * (NET_INTERFACE → Sync State Machine) and Express's default 500
 * handler. Where nothing swallows it, an uncaught throw ends the process
 * anyway — but by the runtime's default rather than by our decision, which is
 * the same right answer for a reason that could change under us without a word.
 *
 * Never returns: it exits, or it re-throws.
 */
export function failStopIfCorruptChain(err: unknown): never {
  if (err instanceof CorruptChainStateError) {
    // The operator's conclusion, not the argument for it: an operator reading
    // this at 3am needs "do not go looking for a bad peer". The pointer to the
    // file that argument rests on rides `err.message`, because it belongs to
    // the subclass that has it — the members do not share one provenance, and a
    // pointer hardcoded here would name the ordering store for a fault in the
    // state tree. What this line adds is the half that IS true of every member
    // by construction, and the decision.
    console.error(
      `FATAL: ${err.message}. Nothing a peer sent can have caused this. ` +
      `Stopping rather than serving, mining or deciding fork choice from ` +
      `state this node cannot trust.`,
    );
    process.exit(1);
  }
  throw err;
}

/**
 * Wraps a store read so a `CorruptChainStateError` stops the node instead of
 * reaching a contained frame (NODE_INTERFACE → Sync handlers). A non-family
 * throw passes through unchanged — the caller's existing error handling is
 * preserved.
 */
export function guardStoreRead<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  return (...args: A): R => {
    try {
      return fn(...args);
    } catch (err) {
      failStopIfCorruptChain(err);
    }
  };
}
