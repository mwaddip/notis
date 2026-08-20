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
 * The positional format made this the shape local corruption actually arrives
 * in. Under cbor a header outside the encodable domain round-tripped intact and
 * failed later, at `blockHash` — the sibling above. Under positional encoding it
 * never comes back out at all: `writeVlqU` sentinels an out-of-domain value so
 * the row is still *written*, and `readVlqU` refuses the ten bytes past
 * `MAX_SAFE_INTEGER` that sentinel decodes to. The store read throws first, and
 * `blockHash` is never reached.
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
 * The live reason, as opposed to that latent one, is reach. `getOrderingBlock`
 * is read by `extendsOurTip`, `findForkPoint`, `revertBlock`, the block creator
 * and two routes as well as by apply, and only apply's read passes through a
 * catch that could promote anything. `extendsOurTip` in particular runs on the
 * gossip path *before* apply and outside `handleOrderingBlock`'s inner try, so
 * a bare `ReaderError` there reaches `failStopIfCorruptChain`, fails its
 * `instanceof`, and is re-thrown out of an `async` handler to end the process
 * as an unhandled rejection — no FATAL line, no site, no height, and the death
 * decided by the runtime rather than by us, which is exactly what the header of
 * this file says it must not be. Naming the fault where the row is read covers
 * every one of those callers at once.
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
 * The AVL+ tree refuses an operation the UTXO store implies must succeed.
 *
 * `performOneOperation` answers `{ success: false }` for exactly two engine-level
 * preconditions: `Insert` on a key already present, `Remove` on a key that is
 * absent. The tree mirrors `utxo_boxes`, so either answer says **the mirror has
 * drifted** — and the two arms are one fault seen from opposite sides, which is
 * why they share a class. The detail sentence says which side; the boundary must
 * not act differently on them.
 *
 * **Why this is corruption and not a rejection, stated per arm as provenance.**
 *
 * The **`Insert`** arm: `utxo_boxes.id` is `TEXT PRIMARY KEY` and the writer is a
 * plain `INSERT`, deliberately not `INSERT OR REPLACE` — stated on
 * `store/utxo.ts`'s `insertBox`. A duplicate box id therefore dies on the
 * constraint inside the applying transaction, **before the prover feed is built
 * from the journal**. An `Insert` reaching the tree with its key already present
 * means the tree holds a box the store does not.
 *
 * The **`Remove`** arm: consumed ids reach the feed only as `kind: 'box'`,
 * `op: 'remove'` journal entries, and the sole writer of those is `consumeBox`
 * — stated on `store/utxo.ts`'s `consumeBox`. Its `UPDATE` carries `AND
 * spent_at_block IS NULL` and refuses a zero row count, so the property that
 * every journalled remove spent a live row is kept by the **primitive**, not by
 * its callers. A consume naming an absent or already-spent id throws
 * `BoxNotLiveError` inside the applying transaction, which the funnel's
 * totality catch converts to a block rejection — the shape this arm's `Insert`
 * sibling already takes, and the reason a second remove of one id cannot be
 * journalled at all. A key that does reach the feed and the tree does not hold
 * means the tree lacks a box the store had.
 *
 * Neither arm is reachable from peer input, which is what puts the condition
 * outside the funnel's totality promise. And a drifted tree refuses the *next*
 * block identically — so rejecting rather than stopping would reject forever
 * while staying up, the precise failure this file exists to prevent.
 */
export class DivergedStateTreeError extends CorruptChainStateError {
  constructor(
    site: string,
    height: number,
    readonly op: 'Insert' | 'Remove',
    readonly key: string,
  ) {
    super(
      site,
      height,
      `the AVL+ tree refused ${op} of key ${key} at height ${height} — ` +
      (op === 'Remove'
        ? `the tree lacks a box the UTXO store held ` +
          `(store/utxo.ts → consumeBox, via the journal feed)`
        : `the tree holds a box the UTXO store does not ` +
          `(store/utxo.ts → insertBox)`),
    );
  }
}

/**
 * A block journal inside retention is absent (NODE_INTERFACE → Rollback).
 *
 * `purgeOldJournals` deletes strictly below `tip − MAX_REORG_DEPTH`.
 * `findForkPoint`'s lowest non-genesis answer is `tip − MAX_REORG_DEPTH + 1`,
 * and `reorg` reverts starting one above the fork point, so every height
 * `revertBlock` can be asked for is ≥ `tip − MAX_REORG_DEPTH + 2` — inside
 * retention. When `findForkPoint` reaches genesis (`tip ≤ MAX_REORG_DEPTH`),
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
      `(purgeOldJournals deletes strictly below tip − MAX_REORG_DEPTH)`,
    );
  }
}

/**
 * No AVL version at or before a fork height the walk answers within
 * (NODE_INTERFACE → Configuration).
 *
 * `loadConfig` refuses `MAX_PROOF_HISTORY < MAX_REORG_DEPTH`, so a missing
 * version is a row the store lost — reachable only through a `Config`
 * assembled without `loadConfig` (tests), or through store corruption.
 */
export class MissingStateVersionError extends CorruptChainStateError {
  constructor(site: string, height: number) {
    super(
      site,
      height,
      `no AVL version at or before fork height ${height} — ` +
      `loadConfig refuses MAX_PROOF_HISTORY < MAX_REORG_DEPTH, ` +
      `so a missing version is a row the store lost`,
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
