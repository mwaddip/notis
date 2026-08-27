import type { BlockHeader } from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import { MAX_NIPOPOW_PARAM } from './codec.js';
import type { PoPowHeader, NipopowProof } from './codec.js';

// NIPOPOW_INTERFACE → proveWithReader
export interface PopowHeaderReader {
  chainHeight(): number;
  popowHeaderByHash(hash: string): PoPowHeader | null;
  popowHeaderAtHeight(height: number): PoPowHeader | null;
  lastHeaders(n: number): BlockHeader[];
  headersAfter(height: number, n: number): BlockHeader[];
}

export class ProofBuildError extends Error {
  code: 'invalid-m' | 'invalid-k' | 'chain-too-short' | 'missing-popow-header';
  constructor(message: string, code: ProofBuildError['code']) {
    super(message);
    this.name = 'ProofBuildError';
    this.code = code;
  }
}

function requirePopowByHash(reader: PopowHeaderReader, hash: string): PoPowHeader {
  const ph = reader.popowHeaderByHash(hash);
  if (ph === null) {
    throw new ProofBuildError(
      `reader returned null for required popow header (hash: ${hash})`,
      'missing-popow-header',
    );
  }
  return ph;
}

// NIPOPOW_INTERFACE → proveWithReader: Ergo's production walk on the ascending vector
export function proveWithReader(
  reader: PopowHeaderReader,
  params: { m: number; k: number },
): NipopowProof {
  const { m, k } = params;
  if (!Number.isInteger(m) || m < 1 || m > MAX_NIPOPOW_PARAM) {
    throw new ProofBuildError(`m must be in [1, ${MAX_NIPOPOW_PARAM}], got ${m}`, 'invalid-m');
  }
  if (!Number.isInteger(k) || k < 1 || k > MAX_NIPOPOW_PARAM) {
    throw new ProofBuildError(`k must be in [1, ${MAX_NIPOPOW_PARAM}], got ${k}`, 'invalid-k');
  }
  const height = reader.chainHeight();
  if (height < m + k) {
    throw new ProofBuildError(
      `chain height ${height} < m+k=${m + k}`,
      'chain-too-short',
    );
  }

  // 1. Suffix: lastHeaders(k) — suffixHead + tail
  const suffixHeaders = reader.lastHeaders(k);
  if (suffixHeaders.length < k) {
    throw new ProofBuildError(
      `reader returned ${suffixHeaders.length} < k=${k} last headers`,
      'missing-popow-header',
    );
  }
  const firstHash = blockHash(suffixHeaders[0]!);
  if (firstHash === null) {
    throw new ProofBuildError(
      'blockHash returned null for the suffix head',
      'missing-popow-header',
    );
  }
  const suffixHead = requirePopowByHash(reader, firstHash);
  const suffixTail = suffixHeaders.slice(1);

  // 2. Prefix: walk from the top level down
  // TYPES_INTERFACE → Interlink vector, NIPOPOW_INTERFACE → proveWithReader —
  // interlinks[i] is the level-i pointer; interlinks[0] = genesis;
  // level 0 has no pointer and is never walked
  const M = suffixHead.interlinks.length - 1;
  const collected = new Map<number, PoPowHeader>();
  let anchoringHeight = 1;

  for (let i = M; i >= 1; i--) {
    const levelChain: PoPowHeader[] = [];
    let nextHash: string | null = suffixHead.interlinks[i] ?? null;
    while (nextHash !== null) {
      const ph = requirePopowByHash(reader, nextHash);
      if (ph.header.height < anchoringHeight) break;
      levelChain.unshift(ph);
      nextHash = ph.interlinks[i] ?? null;
    }
    for (const ph of levelChain) {
      collected.set(ph.header.height, ph);
    }
    if (m < levelChain.length) {
      anchoringHeight = levelChain[levelChain.length - m]!.header.height;
    }
  }

  // 3. Seed genesis
  const genesis = reader.popowHeaderAtHeight(1);
  if (genesis === null) {
    throw new ProofBuildError(
      'reader returned null for genesis (height 1)',
      'missing-popow-header',
    );
  }
  collected.set(1, genesis);

  // Dedupe by height (already keyed), sort ascending
  const prefix = [...collected.values()].sort((a, b) => a.header.height - b.header.height);

  return { m, k, prefix, suffixHead, suffixTail };
}
