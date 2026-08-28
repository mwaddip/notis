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

interface BuildState {
  headers: BlockHeader[];
  interlinksPerHeader: string[][];
  popowHeaders: PoPowHeader[];
  prevHash: string;
  prevInterlinks: string[];
  prevLevel: number;
}

function freshState(): BuildState {
  return {
    headers: [],
    interlinksPerHeader: [],
    popowHeaders: [],
    prevHash: GENESIS_PREV_BLOCK_HASH,
    prevInterlinks: [],
    prevLevel: Infinity,
  };
}

function mineHeaders(
  from: number,
  to: number,
  powTargetBits: number,
  forceLevels: Map<number, number> | undefined,
  state: BuildState,
): void {
  for (let i = from; i < to; i++) {
    const height = i + 1;
    const expected = height === 1
      ? []
      : updateInterlinks(state.prevInterlinks, state.prevHash, state.prevLevel);
    const header: BlockHeader = {
      protocolVersion: PROTOCOL_VERSION,
      height,
      prevBlockHash: state.prevHash,
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

    // validatorId bytes are not frozen — Object.freeze on a typed array with elements throws
    Object.freeze(header);
    Object.freeze(expected);
    const entry: PoPowHeader = Object.freeze({ header, interlinks: expected });

    state.headers.push(header);
    state.interlinksPerHeader.push(expected);
    state.popowHeaders.push(entry);

    state.prevHash = hash;
    state.prevInterlinks = expected;
    state.prevLevel = lvl;
  }
}

export function buildMinedChainFresh(opts: {
  count: number;
  powTargetBits?: number;
  forceLevels?: Map<number, number>;
}): MinedChain {
  const powTargetBits = opts.powTargetBits ?? DEVNET_POW_TARGET_BITS;
  const state = freshState();
  mineHeaders(0, opts.count, powTargetBits, opts.forceLevels, state);
  return {
    headers: state.headers,
    interlinksPerHeader: state.interlinksPerHeader,
    popowHeaders: state.popowHeaders,
  };
}

function memoKey(powTargetBits: number, forceLevels?: Map<number, number>): string {
  let key = String(powTargetBits);
  if (forceLevels && forceLevels.size > 0) {
    const sorted = [...forceLevels.entries()].sort((a, b) => a[0] - b[0]);
    key += '/' + sorted.map(([h, l]) => `${h}:${l}`).join(',');
  }
  return key;
}

function sliceChain(state: BuildState, count: number): MinedChain {
  return {
    headers: state.headers.slice(0, count),
    interlinksPerHeader: state.interlinksPerHeader.slice(0, count),
    popowHeaders: state.popowHeaders.slice(0, count),
  };
}

const chainMemo = new Map<string, BuildState>();

export function buildMinedChain(opts: {
  count: number;
  powTargetBits?: number;
  forceLevels?: Map<number, number>;
}): MinedChain {
  const { count, forceLevels } = opts;
  const powTargetBits = opts.powTargetBits ?? DEVNET_POW_TARGET_BITS;
  const key = memoKey(powTargetBits, forceLevels);
  const existing = chainMemo.get(key);

  if (existing && existing.headers.length >= count) {
    return sliceChain(existing, count);
  }

  const state: BuildState = existing
    ? {
        headers: [...existing.headers],
        interlinksPerHeader: [...existing.interlinksPerHeader],
        popowHeaders: [...existing.popowHeaders],
        prevHash: existing.prevHash,
        prevInterlinks: existing.prevInterlinks,
        prevLevel: existing.prevLevel,
      }
    : freshState();

  mineHeaders(state.headers.length, count, powTargetBits, forceLevels, state);
  chainMemo.set(key, state);

  return sliceChain(state, count);
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
