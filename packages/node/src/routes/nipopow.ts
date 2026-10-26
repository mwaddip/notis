import { Router } from 'express';
import { MAX_NIPOPOW_PARAM, encodeNipopowProof } from '@dagsocial/nipopow';
import { proveWithReader, ProofBuildError } from '@dagsocial/nipopow';
import type { PopowHeaderReader } from '@dagsocial/nipopow';
import { blockHash } from '@dagsocial/validation';
import {
  MissingStoredBlockError,
  failStopIfCorruptChain,
} from '../services/corrupt-state.js';
import { DECIMAL_INT } from './page.js';

// NODE_INTERFACE → Nipopow prover → "The route caches its answer."
const NIPOPOW_PROOF_CACHE_ENTRIES = 4;

// NODE_INTERFACE → Nipopow
export interface NipopowDeps {
  reader: PopowHeaderReader;
  getCurrentHeight(): number;
}

interface CacheEntry {
  m: number;
  k: number;
  proofHex: string;
}

export function createRouter(deps: NipopowDeps): Router {
  const router = Router();

  // NODE_INTERFACE → Nipopow prover → "The route caches its answer."
  // Keyed on the tip's block hash with `m` and `k`; a request at a new tip
  // empties the entries. `entries` is ordered MRU front, LRU back; a hit
  // and a miss both move their pair to the front, and the oldest ask falls
  // off when the length passes `NIPOPOW_PROOF_CACHE_ENTRIES`.
  let currentTip: string | null = null;
  const entries: CacheEntry[] = [];

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

    // The tip's hash names the chain the proof is a function of
    // (NODE_INTERFACE → Nipopow prover → "The route caches its answer.").
    const topHeaders = deps.reader.lastHeaders(1);
    const tipHeader = topHeaders[0] ?? null;
    const tipHash = tipHeader === null ? null : blockHash(tipHeader);

    if (tipHash !== null) {
      if (tipHash !== currentTip) {
        currentTip = tipHash;
        entries.length = 0;
      }
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        if (entry.m === m && entry.k === k) {
          entries.splice(i, 1);
          entries.unshift(entry);
          res.json({ proof: entry.proofHex });
          return;
        }
      }
    }

    try {
      const proof = proveWithReader(deps.reader, { m, k });
      const proofHex = Buffer.from(encodeNipopowProof(proof)).toString('hex');
      if (tipHash !== null) {
        entries.unshift({ m, k, proofHex });
        if (entries.length > NIPOPOW_PROOF_CACHE_ENTRIES) {
          entries.length = NIPOPOW_PROOF_CACHE_ENTRIES;
        }
      }
      res.json({ proof: proofHex });
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
