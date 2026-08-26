import { Router } from 'express';
import type { OrderingBlock } from '@dagsocial/types';
import { postIdsOf } from '../services/block-posts.js';

// ---------------------------------------------------------------------------
// The karma supply set
// ---------------------------------------------------------------------------

/**
 * The box types whose value counts as karma that exists — what `getTotalKarma`
 * sums. Defined in `karma-supply.ts`, which states the rule; re-exported here
 * because `GET /status` is the reader this route serves.
 */
export { KARMA_SUPPLY_TYPES } from '../karma-supply.js';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface BlocksDeps {
  getOrderingBlock(height: number): OrderingBlock | null;
  getOrderingBlockHash(height: number): string | null;
  getCurrentHeight(): number;
  getPostCount(): number;
  getPendingPostCount(): number;
  /** Karma in existence — every box of the karma family, escrow included. */
  getTotalKarma(): bigint;
  /** Karma its owner can spend now — `karma` boxes alone. */
  getLiquidKarma(): bigint;
  getTotalCredits(): bigint;
  networkType: string;
  /**
   * Served because a per-network consensus value a client reproduces is served
   * by the node, never held as a client constant (NODE_INTERFACE → Status). No
   * client reads it today; the node's own reader is `block-creator`'s
   * `getBondsSettlingAt`. No engine check compares it.
   */
  inviteProbationBlocks: number;
  /** `NetworkProfile.vouchCooldownBlocks` — the escrow floor a client reproduces. */
  vouchCooldownBlocks: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an OrderingBlock to a JSON-safe shape.
 */
function blockToJson(block: OrderingBlock): Record<string, unknown> {
  return {
    header: {
      protocolVersion: block.header.protocolVersion,
      height: block.header.height,
      prevBlockHash: block.header.prevBlockHash,
      utxoTxRoot: block.header.utxoTxRoot,
      stateRoot: block.header.stateRoot,
      validatorId: Buffer.from(block.header.validatorId).toString('hex'),
      powNonce: block.header.powNonce,
      powTargetBits: block.header.powTargetBits,
      createdAt: block.header.createdAt,
    },
    utxoTxTree: {
      utxoTxIds: block.utxoTxTree.utxoTxIds,
      // The ids of the posts this block creates, derived from its post-bearing
      // transactions. There is no separate sub-block section to report.
      postIds: postIdsOf(block),
      // Binary fields omitted from JSON — UTXO tx bytes have no meaningful
      // textual representation.
      //
      // ⛔ **There is no `coinbaseOutputs` field.** The coinbase is an output of
      // the block's settlement transaction, which is the last `utxoTxIds` entry
      // (TYPES_INTERFACE → Ordering block).
      utxoTxs: [],
    },
    validatorSignature: Buffer.from(block.validatorSignature).toString('hex'),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: BlocksDeps): Router {
  const router = Router();

  // GET /blocks/current — must be defined BEFORE /blocks/:height
  router.get('/blocks/current', (_req, res) => {
    const height = deps.getCurrentHeight();
    if (height === 0) {
      res.json({ height: 0, hash: null });
      return;
    }

    // NODE_INTERFACE → "Who reads the block_hash column, and who deliberately
    // does not". `null` means height 0 (above) or a missing row.
    res.json({
      height,
      hash: deps.getOrderingBlockHash(height),
    });
  });

  // GET /blocks/:height — NODE_INTERFACE → Blocks
  router.get('/blocks/:height', (req, res) => {
    const height = parseInt(req.params['height']!, 10);
    if (!Number.isSafeInteger(height) || height < 0) {
      res.status(400).json({ error: 'Invalid height' });
      return;
    }

    const block = deps.getOrderingBlock(height);
    if (!block) {
      res.status(404).json({ error: 'Block not found' });
      return;
    }

    res.json(blockToJson(block));
  });

  // GET /status — aggregated node status
  router.get('/status', (_req, res) => {
    res.json({
      networkType: deps.networkType,
      blockHeight: deps.getCurrentHeight(),
      postCount: deps.getPostCount(),
      pendingPosts: deps.getPendingPostCount(),
      totalKarma: deps.getTotalKarma().toString(),
      liquidKarma: deps.getLiquidKarma().toString(),
      totalCredits: deps.getTotalCredits().toString(),
      // A plain number, unlike the two decimal strings above — it is not a
      // bigint server-side (`Config.inviteProbationBlocks`).
      inviteProbationBlocks: deps.inviteProbationBlocks,
      // ⛔ **Served because a client must REPRODUCE it.** An unvouch outputs a
      // `VouchEscrowBox` whose `releaseAtBlock` the engine pins as
      // `vouch.createdAtBlock + vouchCooldownBlocks`, so a client holding it as
      // a constant agrees on mainnet and is refused on devnet. Per-network
      // values are served, never known.
      vouchCooldownBlocks: deps.vouchCooldownBlocks,
    });
  });

  return router;
}
