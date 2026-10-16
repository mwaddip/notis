import type { OrderingBlock } from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import {
  anyRefusedHeader,
  getCurrentHeight,
  getOrderingBlockHash,
  insertRefusedHeader,
} from '../store/index.js';
import { applyOrderingBlockVerdict } from './block-apply.js';
import { extendsOurTip } from './fork-resolution.js';
import type { ForkResolutionNet } from './fork-resolution.js';
import { handOverForkResolution } from './fork-resolution-runner.js';
import { failStopIfCorruptChain } from './corrupt-state.js';
import { onBlockApplied, registerPlaceholder } from './backfill.js';
import { getPlaceholdersAt } from '../store/index.js';

/**
 * Both entries — gossip and pull — converge here (NODE_INTERFACE → Relay
 * handlers / Sync handlers).
 *
 * Returns `true` for applied or already held, `false` for a marked header,
 * for a block the funnel refuses, or for a non-extending block that enters
 * fork resolution. The synchronous path can raise a `CorruptChainStateError`
 * (`getOrderingBlock`, `extendsOurTip`, `applyOrderingBlockVerdict`'s
 * re-thrown class); each registration wraps the call in
 * `failStopIfCorruptChain`.
 *
 * A `'consensus'` refusal on the extends arm marks the header in
 * `refused_headers` after the funnel's transaction has rolled back, in its
 * own write (NODE_INTERFACE → Refused headers); `'unbound'`, `'acceptance'`
 * and `'local'` mark nothing. A non-extending block is handed to the
 * single-flight runner (NODE_INTERFACE → Fork choice decides on verified
 * headers → "One resolution at a time"); the runner owns each resolution's
 * promise, so no rejection escapes this frame.
 */
export function handleOrderingBlock(
  block: OrderingBlock,
  fromPeerId: string,
  net: ForkResolutionNet,
): boolean {
  // NODE_INTERFACE → "Who reads the block_hash column, and who deliberately
  // does not". The null guard excludes a missing row (no block at this height)
  // from matching an unhashable arriving header — a bare `===` would return
  // "already held" for a null-null collision.
  const incomingHash = blockHash(block.header);
  const existingHash = getOrderingBlockHash(block.header.height);
  if (existingHash !== null && incomingHash !== null && existingHash === incomingHash) {
    return true;
  }

  // NODE_INTERFACE → Relay handlers → `onOrderingBlock`: a header this node
  // marked refused is refused with nothing applied.
  if (incomingHash !== null && anyRefusedHeader([incomingHash])) {
    return false;
  }

  const currentHeight = getCurrentHeight();
  if (currentHeight === 0 || extendsOurTip(block)) {
    const verdict = applyOrderingBlockVerdict(block);
    if (verdict.applied) {
      const placeholders = getPlaceholdersAt(block.header.height);
      for (const p of placeholders) {
        registerPlaceholder(p.id, p.contentHash, block.header.height, fromPeerId);
      }
      onBlockApplied(block.header.height).catch((err) =>
        console.warn(`Backfill error at height ${block.header.height}: ${String(err)}`),
      );
      return true;
    }
    // NODE_INTERFACE → Refused headers → "A mark names a header and is a
    // verdict on its body, because the two are one": a `'consensus'`
    // refusal of a block that extends the tip rests on bytes the header's
    // hash commits, so the mark is written here after the funnel's
    // transaction has returned — in its own write, outside that transaction
    // ("The mark is written outside the reorg transaction").
    if (verdict.class === 'consensus' && incomingHash !== null) {
      insertRefusedHeader(incomingHash, block.header.height, getCurrentHeight());
    }
    return false;
  }

  handOverForkResolution(block, net, fromPeerId);
  return false;
}

/**
 * The pull registration's wrapped handler, passed by `index.ts` to
 * `net.setBlocksHandler` (NODE_INTERFACE → Sync handlers).
 */
export function pullBlocksHandler(
  net: ForkResolutionNet,
): (block: OrderingBlock, fromPeerId: string) => boolean {
  return (block, fromPeerId) => {
    try {
      return handleOrderingBlock(block, fromPeerId, net);
    } catch (err) {
      failStopIfCorruptChain(err);
    }
  };
}
