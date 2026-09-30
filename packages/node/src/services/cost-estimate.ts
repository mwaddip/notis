import {
  applyBlock,
  blockCost,
  buildBlockSettlement,
  treeStateView,
  treeWritesOf,
  TreeInconsistencyError,
} from '@dagsocial/consensus';
import type { BlockCost } from '@dagsocial/consensus';
import { EMPTY_STATE_ROOT, bytesToHex, computeTxId, encodeTx } from '@dagsocial/types';
import type { BlockHeader, OrderingBlock, UtxoTransaction } from '@dagsocial/types';
import { nextBlockHeight } from '../store/index.js';
import { tryGetAvlProver } from '../state/avl-prover.js';
import type { AvlProverHandle } from '../state/avl-prover.js';
import { proverSession } from '../state/prover-session.js';
import { config } from '../config.js';
import { applyContextFrom, costOf } from './block-apply.js';
import { InconsistentStateTreeError, failStopIfCorruptChain } from './corrupt-state.js';

/**
 * The producer of every block costed here: none. Its coinbase pays an all-zero
 * key, which signs nothing, so the settlement counts every actor the body
 * carries — the cost does not depend on who would mine it.
 */
const NO_PRODUCER = new Uint8Array(32);

/**
 * The cost of the candidate block at `height` carrying `txs` as its user
 * transactions, its settlement built as the creator builds one, the rules and the
 * writes run over this node's tree read unrecorded (MEMPOOL_INTERFACE → The cost
 * gate; NODE_INTERFACE → The block proof).
 *
 * `null` where there is no such block to cost: a chain that cannot back the
 * settlement produces no block at all, and a body the rules refuse — one spending
 * the output of a transaction still pooled, a like of a post still pooled — rides
 * a block with what it depends on.
 *
 * The header carries the height and `validatorId`, the only fields the mutation
 * phase reads (CONSENSUS_INTERFACE → Applying a block); every other field is a
 * zero.
 */
function candidateCost(
  handle: AvlProverHandle,
  txs: readonly UtxoTransaction[],
  height: number,
  site: string,
): BlockCost | null {
  const ctx = applyContextFrom(config);
  const bodies = txs.map((tx) => encodeTx(tx));
  try {
    const built = buildBlockSettlement(
      treeStateView(proverSession(handle.prover)), bodies, height, NO_PRODUCER, NO_PRODUCER, ctx,
    );
    if ('error' in built) return null;
    const header: BlockHeader = {
      protocolVersion: 0,
      height,
      prevBlockHash: '00'.repeat(32),
      utxoTxRoot: '00'.repeat(32),
      stateRoot: EMPTY_STATE_ROOT,
      validatorId: NO_PRODUCER,
      powNonce: 0,
      powTargetBits: 0,
      createdAt: 0,
      interlinkRoot: '00'.repeat(32),
      adProofsRoot: '00'.repeat(32),
    };
    const block: OrderingBlock = {
      header,
      utxoTxTree: {
        utxoTxIds: [...txs.map((tx) => computeTxId(tx)), computeTxId(built.tx)],
        utxoTxs: [...bodies, encodeTx(built.tx)],
      },
      validatorSignature: new Uint8Array(64),
    };
    const view = treeStateView(proverSession(handle.prover));
    const result = applyBlock(view, block, ctx);
    if (!result.ok) return null;
    return costOf(result.effects, view, treeWritesOf(result.effects, height, view));
  } catch (err) {
    // A read of this node's own tree that contradicts itself is local
    // corruption, never a verdict on the body — the boundary directly, because
    // the routes that call admission answer a throw as a 500 and stay up
    // (NODE_INTERFACE → "What the funnel's totality catch is FOR").
    if (err instanceof TreeInconsistencyError) {
      failStopIfCorruptChain(new InconsistentStateTreeError(site, height, err));
    }
    throw err;
  }
}

/**
 * The cost of the block carrying `tx` as its only user transaction at the height
 * of the block that would carry it — tip + 1 — or `null` where there is no such
 * block to cost, which a node with no prover never has (MEMPOOL_INTERFACE → The
 * cost gate). `site` names the caller in a fail-stop's diagnostic.
 */
export function costAlone(tx: UtxoTransaction, site: string): BlockCost | null {
  const handle = tryGetAvlProver();
  if (handle === null) return null;
  return candidateCost(handle, [tx], nextBlockHeight(), site);
}

/** The tip the empty block was last costed at — its height and the tree's digest — and that cost. */
let emptyAtTip: { height: number; digest: string; cost: number | null } | null = null;

/**
 * The cost of the block carrying no user transaction at tip + 1, computed once a
 * tip — the baseline every marginal cost at that tip is taken against
 * (MEMPOOL_INTERFACE → The cost gate). The tip is the next height and the tree's
 * digest, which a block applied or reverted moves. `null` for a node with no
 * prover, or a chain that cannot back even the empty body.
 */
export function emptyBlockCost(site: string): number | null {
  const handle = tryGetAvlProver();
  if (handle === null) return null;
  const height = nextBlockHeight();
  const digest = bytesToHex(handle.prover.digest());
  if (emptyAtTip === null || emptyAtTip.height !== height || emptyAtTip.digest !== digest) {
    const cost = candidateCost(handle, [], height, site);
    emptyAtTip = { height, digest, cost: cost === null ? null : blockCost(cost) };
  }
  return emptyAtTip.cost;
}

/**
 * The marginal cost of a transaction whose block alone costs `alone` at tip + 1:
 * that block's cost less the empty block's at the same tip (MEMPOOL_INTERFACE →
 * The cost gate). `null` where the empty block has no cost to take.
 */
export function marginalCost(alone: BlockCost, site: string): number | null {
  const empty = emptyBlockCost(site);
  return empty === null ? null : blockCost(alone) - empty;
}
