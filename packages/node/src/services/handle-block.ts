import type { OrderingBlock } from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import { getCurrentHeight, getOrderingBlock } from '../store/index.js';
import { applyOrderingBlock } from './block-apply.js';
import { extendsOurTip, resolveFork } from './fork-resolution.js';
import type { ForkResolutionNet } from './fork-resolution.js';
import { failStopIfCorruptChain } from './corrupt-state.js';
import { onBlockApplied, registerPlaceholder } from './backfill.js';
import { getPlaceholdersAt } from '../store/index.js';

/**
 * Both entries — gossip and pull — converge here (NODE_INTERFACE → Relay
 * handlers / Sync handlers).
 *
 * Returns `true` for applied or already held, `false` for rejected or for a
 * non-extending block that enters fork resolution. The synchronous path can
 * raise a `CorruptChainStateError` (`getOrderingBlock`, `extendsOurTip`,
 * `applyOrderingBlock`'s re-thrown class); each registration wraps the call
 * in `failStopIfCorruptChain`. The launched `resolveFork` promise carries
 * its own `.catch(failStopIfCorruptChain)`.
 */
export function handleOrderingBlock(
  block: OrderingBlock,
  fromPeerId: string,
  net: ForkResolutionNet,
): boolean {
  const existing = getOrderingBlock(block.header.height);
  if (existing && blockHash(existing.header) === blockHash(block.header)) {
    return true;
  }

  const currentHeight = getCurrentHeight();
  if (currentHeight === 0 || extendsOurTip(block)) {
    const applied = applyOrderingBlock(block);
    if (applied) {
      const placeholders = getPlaceholdersAt(block.header.height);
      for (const p of placeholders) {
        registerPlaceholder(p.id, p.contentHash, block.header.height, fromPeerId);
      }
      onBlockApplied(block.header.height).catch((err) =>
        console.warn(`Backfill error at height ${block.header.height}: ${String(err)}`),
      );
    }
    return applied;
  }

  resolveFork(block, net, fromPeerId).catch(failStopIfCorruptChain);
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
