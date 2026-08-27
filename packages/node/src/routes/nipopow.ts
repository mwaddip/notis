import { Router } from 'express';
import { MAX_NIPOPOW_PARAM, encodeNipopowProof } from '@dagsocial/nipopow';
import { proveWithReader, ProofBuildError } from '@dagsocial/nipopow';
import type { PopowHeaderReader } from '@dagsocial/nipopow';
import {
  MissingStoredBlockError,
  failStopIfCorruptChain,
} from '../services/corrupt-state.js';

const DECIMAL_INT = /^\d+$/;

// NODE_INTERFACE → Nipopow
export interface NipopowDeps {
  reader: PopowHeaderReader;
  getCurrentHeight(): number;
}

export function createRouter(deps: NipopowDeps): Router {
  const router = Router();

  // GET /nipopow/proof/:m/:k — NODE_INTERFACE → Nipopow
  router.get('/nipopow/proof/:m/:k', (req, res) => {
    const mStr = req.params['m']!;
    const kStr = req.params['k']!;

    if (!DECIMAL_INT.test(mStr) || !DECIMAL_INT.test(kStr)) {
      res.status(400).json({
        error: `m and k must be integers in [1, ${MAX_NIPOPOW_PARAM}]`,
      });
      return;
    }

    const m = Number(mStr);
    const k = Number(kStr);

    if (m < 1 || m > MAX_NIPOPOW_PARAM || k < 1 || k > MAX_NIPOPOW_PARAM) {
      res.status(400).json({
        error: `m and k must be integers in [1, ${MAX_NIPOPOW_PARAM}]`,
      });
      return;
    }

    if (deps.getCurrentHeight() < m + k) {
      res.status(404).json({ error: 'chain too short' });
      return;
    }

    try {
      const proof = proveWithReader(deps.reader, { m, k });
      res.json({ proof: Buffer.from(encodeNipopowProof(proof)).toString('hex') });
    } catch (err) {
      if (err instanceof ProofBuildError) {
        if (err.code === 'chain-too-short') {
          // NODE_INTERFACE → Nipopow: height moved under the request
          res.status(404).json({ error: 'chain too short' });
          return;
        }
        // NODE_INTERFACE → Nipopow prover: missing-popow-header on a canonical
        // chain is a row the walk needs that the store lost — fail-stop, not 500.
        // guardStoreRead catches decode failures; this catches absent rows.
        const wrapped = new MissingStoredBlockError('nipopow/proof', 0);
        wrapped.cause = err;
        failStopIfCorruptChain(wrapped);
      }
      throw err;
    }
  });

  return router;
}
