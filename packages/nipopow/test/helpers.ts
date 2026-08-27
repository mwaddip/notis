import {
  PROTOCOL_VERSION,
  EMPTY_STATE_ROOT,
  GENESIS_PREV_BLOCK_HASH,
  interlinkRoot,
  updateInterlinks,
} from '@dagsocial/types';
import type { BlockHeader } from '@dagsocial/types';
import {
  verifyOrderingBlockPoW,
  blockHash,
  level as headerLevel,
  levelOfHit,
  powHit,
  orderingPowTarget,
} from '@dagsocial/validation';
import type { PoPowHeader, PopowHeaderReader } from '../src/index.js';

export const DEVNET_POW_TARGET_BITS = 3072;

export function solveHeaderPow(header: BlockHeader): number {
  for (let nonce = 0; ; nonce++) {
    if (verifyOrderingBlockPoW({ ...header, powNonce: nonce })) return nonce;
  }
}

export function solveForLevel(
  header: BlockHeader,
  minLevel: number,
): number {
  const target = orderingPowTarget(header.powTargetBits);
  if (target === null) throw new Error('invalid target');
  for (let nonce = 0; ; nonce++) {
    const candidate = { ...header, powNonce: nonce };
    if (!verifyOrderingBlockPoW(candidate)) continue;
    const hit = powHit(candidate);
    if (hit === null) continue;
    const lvl = levelOfHit(hit, target);
    if (lvl !== null && lvl >= minLevel) return nonce;
  }
}

export interface MinedChain {
  headers: BlockHeader[];
  interlinksPerHeader: string[][];
  popowHeaders: PoPowHeader[];
}

export function buildMinedChain(opts: {
  count: number;
  powTargetBits?: number;
  forceLevels?: Map<number, number>;
}): MinedChain {
  const { count, forceLevels } = opts;
  const powTargetBits = opts.powTargetBits ?? DEVNET_POW_TARGET_BITS;
  const headers: BlockHeader[] = [];
  const interlinksPerHeader: string[][] = [];
  const popowHeaders: PoPowHeader[] = [];
  let prevHash = GENESIS_PREV_BLOCK_HASH;
  let prevInterlinks: string[] = [];
  let prevLevel: number = Infinity;

  for (let i = 0; i < count; i++) {
    const height = i + 1;
    const expected = height === 1
      ? []
      : updateInterlinks(prevInterlinks, prevHash, prevLevel);
    const header: BlockHeader = {
      protocolVersion: PROTOCOL_VERSION,
      height,
      prevBlockHash: prevHash,
      utxoTxRoot: '00'.repeat(32),
      stateRoot: EMPTY_STATE_ROOT,
      validatorId: new Uint8Array(32),
      powNonce: 0,
      powTargetBits,
      createdAt: i,
      interlinkRoot: interlinkRoot(expected),
    };

    const wantLevel = forceLevels?.get(height);
    if (wantLevel !== undefined && wantLevel > 0) {
      header.powNonce = solveForLevel(header, wantLevel);
    } else {
      header.powNonce = solveHeaderPow(header);
    }

    const hash = blockHash(header);
    if (hash === null) throw new Error(`unhashable at height ${height}`);
    const lvl = headerLevel(header);
    if (lvl === null) throw new Error(`null level at height ${height}`);

    headers.push(header);
    interlinksPerHeader.push(expected);
    popowHeaders.push({ header, interlinks: expected });

    prevHash = hash;
    prevInterlinks = expected;
    prevLevel = lvl;
  }
  return { headers, interlinksPerHeader, popowHeaders };
}

export function makeReader(chain: MinedChain): PopowHeaderReader {
  const byHash = new Map<string, PoPowHeader>();
  const byHeight = new Map<number, PoPowHeader>();
  for (const ph of chain.popowHeaders) {
    const hash = blockHash(ph.header);
    if (hash !== null) byHash.set(hash, ph);
    byHeight.set(ph.header.height, ph);
  }
  return {
    chainHeight(): number {
      return chain.headers.length;
    },
    popowHeaderByHash(hash: string): PoPowHeader | null {
      return byHash.get(hash) ?? null;
    },
    popowHeaderAtHeight(height: number): PoPowHeader | null {
      return byHeight.get(height) ?? null;
    },
    lastHeaders(n: number): BlockHeader[] {
      const start = Math.max(0, chain.headers.length - n);
      return chain.headers.slice(start);
    },
    headersAfter(height: number, n: number): BlockHeader[] {
      const result: BlockHeader[] = [];
      for (let h = height + 1; h <= Math.min(height + n, chain.headers.length); h++) {
        const ph = byHeight.get(h);
        if (ph) result.push(ph.header);
      }
      return result;
    },
  };
}

export function devnetProfile() {
  return {
    expectedTarget: (_height: number) => DEVNET_POW_TARGET_BITS,
    genesisId: '',
    protocolVersion: PROTOCOL_VERSION,
  };
}

export function devnetProfileWithGenesisId(chain: MinedChain) {
  const gHash = blockHash(chain.headers[0]!);
  if (gHash === null) throw new Error('unhashable genesis');
  return {
    expectedTarget: (_height: number) => DEVNET_POW_TARGET_BITS,
    genesisId: gHash,
    protocolVersion: PROTOCOL_VERSION,
  };
}
