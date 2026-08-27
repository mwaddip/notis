import { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { computePowHash } from '@dagsocial/validation';
import type { OrderingBlock } from '@dagsocial/types';
import { postIdsOf } from '../services/block-posts.js';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface MiningDeps {
  getCurrentTemplate(): OrderingBlock | null;
  submitMinedBlock(powNonce: number, height: number): string | null;
  setMinerPubkey(pubkey: Uint8Array | null): void;
  /**
   * Whether the node has met its peers, or has finished looking
   * (`services/peer-readiness.ts`). A decision rather than a side effect, so it
   * arrives as a dependency — the gate is part of this route's contract and is
   * testable without a net instance.
   */
  peerReady(): boolean;
  miningSecret: string;
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

/**
 * Bearer auth for every mining route. There is no unauthenticated mode: the
 * `?miner=` coinbase payout override is reachable only behind this check
 * (MINING_INTERFACE → Invariants, item 8; audit M-7).
 */
function authMiddleware(secret: string): import('express').RequestHandler {
  const expected = Buffer.from(`Bearer ${secret}`, 'utf8');
  return (req, res, next) => {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    // timingSafeEqual throws on unequal lengths, so the length check gates it.
    // A differing length is not a secret worth hiding — the secret's length is.
    const provided = Buffer.from(auth, 'utf8');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: MiningDeps): Router {
  const router = Router();
  const { miningSecret } = deps;

  // Enforced at startup, not per-request: a router with no secret must not exist.
  if (!miningSecret) {
    throw new Error('Mining routes require a non-empty mining secret');
  }

  // Auth middleware on all mining routes
  router.use(authMiddleware(miningSecret));

  // GET /mining/template — return current block template
  router.get('/template', (req, res) => {
    // Optional miner pubkey override for coinbase reward destination. Validated
    // here and applied below the gate: the 400 is a verdict on the request,
    // which readiness has no bearing on, while the assignment is a mutation this
    // node commits to and a refused request must not make one.
    const minerHex = typeof req.query.miner === 'string' ? req.query.miner : null;
    if (minerHex !== null && (minerHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(minerHex))) {
      res.status(400).json({ error: 'Invalid miner pubkey — must be 64 hex chars' });
      return;
    }

    // The peer-readiness gate (MINING_INTERFACE → "The peer-readiness gate").
    //
    // Withheld with the *same* 404 the absent-template case answers with, which
    // is what lets `scripts/miner.mjs` treat them identically — it retries on
    // that response and has no give-up count, so an unmet node polls until the
    // gate opens.
    //
    // Behind the `?miner=` validation on purpose: a malformed payout key is a
    // client bug and must earn its 400 whatever this node's readiness is.
    // Answering 404 there would tell a miner to retry a request that can never
    // succeed.
    //
    // **Above `setMinerPubkey`, and that ordering is the point.** The gate
    // guarantees a window in which every poll is refused, and `miner.mjs` polls
    // through it with no give-up count — so a refusal that still wrote the
    // payout key would let a request answering nothing mutate the coinbase
    // destination of every block this node later mines.
    //
    // Gate at serve, never at creation — `startBlockCreator` keeps building
    // templates, so "a miner node always holds a template" stays literally true.
    if (!deps.peerReady()) {
      res.status(404).json({ error: 'No block template available' });
      return;
    }

    if (minerHex !== null) {
      deps.setMinerPubkey(new Uint8Array(Buffer.from(minerHex, 'hex')));
    }

    const tpl = deps.getCurrentTemplate();
    if (!tpl) {
      res.status(404).json({ error: 'No block template available' });
      return;
    }

    // Compute PoW preimage from the header.
    //
    // The template is this node's own; the creator refuses to store one it
    // cannot encode, so `null` is our fault and not the miner's request. It is
    // therefore a 5xx and not the 404 above: "no template available" would be
    // false — there is one, and it is broken. Answering with a preimage-shaped
    // absence would be worse still, since a miner would burn hashes on it.
    const powPreimage = computePowHash(tpl.header);
    if (powPreimage === null) {
      res.status(500).json({ error: 'Block template header is not encodable' });
      return;
    }

    res.json({
      header: {
        protocolVersion: tpl.header.protocolVersion,
        height: tpl.header.height,
        prevBlockHash: tpl.header.prevBlockHash,
        utxoTxRoot: tpl.header.utxoTxRoot,
        stateRoot: tpl.header.stateRoot,
        validatorId: Buffer.from(tpl.header.validatorId).toString('hex'),
        powTargetBits: tpl.header.powTargetBits,
        createdAt: tpl.header.createdAt,
        interlinkRoot: tpl.header.interlinkRoot,
      },
      // The ids of the posts this template creates, derived from its
      // post-bearing transactions.
      postIds: postIdsOf(tpl),
      // ⛔ **The coinbase is an output of the settlement transaction**, the last
      // `utxoTxIds` entry, so the template reports no `coinbaseOutputs`
      // (TYPES_INTERFACE → Ordering block). A miner hashes `powPreimage` and
      // never reads the body.
      utxoTxIds: tpl.utxoTxTree.utxoTxIds,
      powPreimage: powPreimage.toString('hex'),
    });
  });

  // POST /mining/submit — submit a solved nonce
  router.post('/submit', (_req, res) => {
    const { powNonce, height } = _req.body as { powNonce?: number; height?: number };

    if (typeof powNonce !== 'number' || powNonce < 0) {
      res.status(400).json({ error: 'powNonce required (non-negative integer)' });
      return;
    }

    if (typeof height !== 'number' || height < 1) {
      res.status(400).json({ error: 'height required (positive integer)' });
      return;
    }

    const blockHash = deps.submitMinedBlock(powNonce, height);
    if (!blockHash) {
      res.status(422).json({ error: 'PoW invalid or template stale' });
      return;
    }

    res.status(201).json({ blockHash, height });
  });

  return router;
}
