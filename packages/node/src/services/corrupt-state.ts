/**
 * The one condition this node stops for, and the one place that decides it.
 *
 * Everything else in the apply path is a *rejection*: a peer sent something
 * invalid, the node says no and stays up. That is the funnel's totality
 * property, and it is a property about **untrusted input** — no block a peer can
 * construct may take the node down.
 *
 * "Our own stored header cannot be hashed" is not in that class and cannot be
 * put in it. In `src` the ordering store has exactly one writer,
 * `block-apply.ts`'s `storeCreateOrderingBlock`, downstream of the
 * `verifyOrderingBlockStructure` gate whose header checks *are*
 * `verifyHeaderFieldDomains`. So no peer can cause this: it means local
 * corruption or a bug in us, and the honest response is to stop.
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
 * A height that should hold a block and does not.
 *
 * `ordering_blocks` holds exactly heights 1..MAX with no holes, and the store
 * itself is what guarantees it: one insert, gated on
 * `height === currentHeight + 1` (or genesis at 1), and one delete, reached only
 * from `revertBlock` inside `reorg`'s strictly top-down loop and inside its
 * transaction. Nothing prunes blocks. `getCurrentHeight()` is `MAX(height)`, so
 * a hole does not lower the tip and nothing else would notice it either.
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
    console.error(
      `FATAL: ${err.message}. The ordering store's only writer is this node's ` +
      `own apply path, so nothing a peer sent can have caused this. Stopping ` +
      `rather than serving, mining or deciding fork choice from a chain this ` +
      `node cannot read.`,
    );
    process.exit(1);
  }
  throw err;
}
