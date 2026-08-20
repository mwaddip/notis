import type { OrderingBlock } from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import { getCurrentHeight, getOrderingBlock } from '../store/index.js';
import { applyOrderingBlock } from './block-apply.js';
import { extendsOurTip, resolveFork } from './fork-resolution.js';
import type { ForkResolutionNet } from './fork-resolution.js';
import type { DagService } from './dag-service.js';
import { failStopIfCorruptChain } from './corrupt-state.js';

/**
 * Both entries — gossip and pull — converge here (NODE_INTERFACE → Relay
 * handlers / Sync handlers).
 *
 * Returns `true` for applied or already held, `false` for rejected or for a
 * non-extending block that enters fork resolution. Nothing awaits the
 * resolution; the `.catch(failStopIfCorruptChain)` on the launched promise is
 * the fail-stop boundary, so no other path carries a corrupt-state error out.
 */
export function handleOrderingBlock(
  block: OrderingBlock,
  fromPeerId: string,
  net: ForkResolutionNet,
  dagService?: DagService,
): boolean {
  const existing = getOrderingBlock(block.header.height);
  if (existing && blockHash(existing.header) === blockHash(block.header)) {
    return true;
  }

  const currentHeight = getCurrentHeight();
  if (currentHeight === 0 || extendsOurTip(block)) {
    return applyOrderingBlock(block, dagService);
  }

  resolveFork(block, net, fromPeerId, dagService).catch(failStopIfCorruptChain);
  return false;
}
