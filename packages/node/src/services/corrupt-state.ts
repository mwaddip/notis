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
      `the ordering store disagrees with the apply gate`,
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
      `our stored block at height ${height} does not decode — ` +
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
      `store is not contiguous`,
    );
  }
}

/**
 * The boundary. Diagnostic first, death second; everything else re-thrown
 * unchanged, so no other error changes shape by passing through here.
 *
 * Call it from the outermost frame of every path that can reach
 * `applyOrderingBlock` or fork resolution — and from a frame the runtime cannot
 * quietly reinterpret. Each of those paths otherwise ends somewhere that
 * swallows: `@dagsocial/net`'s `appendBlocks` catch logs a throw from the sync
 * handler as *"failed to decode block"* and applies the next block anyway
 * (`net/src/node.ts:255-260`), its gossip dispatch catch is empty
 * (`net/src/gossip.ts:184`), and Express turns a throw in a route handler into a
 * 500 while the node carries on. Where nothing swallows it, an uncaught throw
 * ends the process anyway — but by the runtime's default rather than by our
 * decision, which is the same right answer for a reason that could change under
 * us without a word.
 *
 * Never returns: it exits, or it re-throws.
 */
export function failStopIfCorruptChain(err: unknown): never {
  if (err instanceof CorruptChainStateError) {
    // The operator's conclusion, not the argument for it: an operator reading
    // this at 3am needs "do not go looking for a bad peer", and the provenance
    // it rests on is one hop away for whoever wants to check it. Restating that
    // provenance here would be a copy that decays on its own schedule, in the
    // one artifact nobody greps when the store gains a second writer.
    console.error(
      `FATAL: ${err.message}. Nothing a peer sent can have caused this ` +
      `(store/ordering.ts → createOrderingBlock). Stopping rather than ` +
      `serving, mining or deciding fork choice from a chain this node ` +
      `cannot read.`,
    );
    process.exit(1);
  }
  throw err;
}
