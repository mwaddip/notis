import {
  EMPTY_STATE_ROOT,
  GENESIS_PREV_BLOCK_HASH,
  NETWORK_PROFILES,
  interlinkRoot,
  protocolVersionAt,
  updateInterlinks,
} from '@dagsocial/types';
import type { BlockHeader, ProtocolEra } from '@dagsocial/types';
import {
  asertTargetBits,
  verifyOrderingBlockPoW,
  blockHash,
  level as headerLevel,
  levelOfHit,
  powHit,
  orderingPowTarget,
} from '@dagsocial/validation';
import type { RetargetParams } from '@dagsocial/validation';
import type { PoPowHeader, PopowHeaderReader } from '../src/index.js';

export const DEVNET_POW_TARGET_BITS = 3072;

export const DEVNET_RETARGET: RetargetParams = {
  anchorBits: 3072,
  idealMs: 60_000,
  halflifeMs: 17_280_000,
  floorBits: 2304,
  ceilingBits: 4096,
};

export const DEVNET_MAX_FUTURE_DRIFT_MS = 600_000;

const ANCHOR_TIME = 1_000_000;

export function solveHeaderPow(header: BlockHeader): number {
  for (let nonce = 0; ; nonce++) {
    if (verifyOrderingBlockPoW({ ...header, powNonce: nonce })) return nonce;
  }
}

export function solveForLevel(
  header: BlockHeader,
  minLevel: number,
  anchorBits: number,
): number {
  const yardstick = orderingPowTarget(anchorBits);
  if (yardstick === null) throw new Error('invalid anchor bits');
  for (let nonce = 0; ; nonce++) {
    const candidate = { ...header, powNonce: nonce };
    if (!verifyOrderingBlockPoW(candidate)) continue;
    const hit = powHit(candidate);
    if (hit === null) continue;
    const lvl = levelOfHit(hit, yardstick);
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
  prevLevel: number | null;
  prevHeight: number;
  prevCreatedAt: number;
}

function freshState(): BuildState {
  return {
    headers: [],
    interlinksPerHeader: [],
    popowHeaders: [],
    prevHash: GENESIS_PREV_BLOCK_HASH,
    prevInterlinks: [],
    prevLevel: Infinity,
    prevHeight: 0,
    prevCreatedAt: 0,
  };
}

// On-schedule stamps: bits stay at anchorBits, createdAt = ANCHOR_TIME + idealMs * (height - 1)
function mineHeaders(
  from: number,
  to: number,
  retarget: RetargetParams,
  schedule: readonly ProtocolEra[],
  forceLevels: Map<number, number> | undefined,
  state: BuildState,
  stampIntervalMs?: number,
): void {
  const interval = stampIntervalMs ?? retarget.idealMs;
  for (let i = from; i < to; i++) {
    const height = i + 1;
    const expected = height === 1
      ? []
      : updateInterlinks(state.prevInterlinks, state.prevHash, state.prevLevel);

    const createdAt = ANCHOR_TIME + interval * (height - 1);
    const powTargetBits = height === 1
      ? retarget.anchorBits
      : asertTargetBits(retarget, ANCHOR_TIME,
          { height: state.prevHeight, createdAt: state.prevCreatedAt });

    // the era scheduled at this height (TYPES_INTERFACE → Version)
    const version = protocolVersionAt(schedule, height);
    if (version === null) throw new Error(`no protocol era covers height ${height}`);

    const header: BlockHeader = {
      protocolVersion: version,
      height,
      prevBlockHash: state.prevHash,
      utxoTxRoot: '00'.repeat(32),
      stateRoot: EMPTY_STATE_ROOT,
      validatorId: new Uint8Array(32),
      powNonce: 0,
      powTargetBits,
      createdAt,
      interlinkRoot: interlinkRoot(expected),
    };

    const wantLevel = forceLevels?.get(height);
    if (wantLevel !== undefined && wantLevel > 0) {
      header.powNonce = solveForLevel(header, wantLevel, retarget.anchorBits);
    } else {
      header.powNonce = solveHeaderPow(header);
    }

    const hash = blockHash(header);
    if (hash === null) throw new Error(`unhashable at height ${height}`);
    const lvl = headerLevel(header, retarget.anchorBits);

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
    state.prevHeight = height;
    state.prevCreatedAt = createdAt;
  }
}

export function buildMinedChainFresh(opts: {
  count: number;
  retarget?: RetargetParams;
  forceLevels?: Map<number, number>;
  stampIntervalMs?: number;
  schedule?: readonly ProtocolEra[];
}): MinedChain {
  const retarget = opts.retarget ?? DEVNET_RETARGET;
  const schedule = opts.schedule ?? NETWORK_PROFILES.devnet.protocolVersionSchedule;
  const state = freshState();
  mineHeaders(0, opts.count, retarget, schedule, opts.forceLevels, state, opts.stampIntervalMs);
  return {
    headers: state.headers,
    interlinksPerHeader: state.interlinksPerHeader,
    popowHeaders: state.popowHeaders,
  };
}

function memoKey(
  retarget: RetargetParams,
  schedule: readonly ProtocolEra[],
  forceLevels?: Map<number, number>,
  stampIntervalMs?: number,
): string {
  let key = `${retarget.anchorBits}:${retarget.idealMs}:${retarget.halflifeMs}:${retarget.floorBits}:${retarget.ceilingBits}`;
  key += '/v=' + schedule.map(e => `${e.version}@${e.fromHeight}`).join(',');
  if (stampIntervalMs !== undefined) key += `/s=${stampIntervalMs}`;
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
  retarget?: RetargetParams;
  forceLevels?: Map<number, number>;
  stampIntervalMs?: number;
  schedule?: readonly ProtocolEra[];
}): MinedChain {
  const { count, forceLevels, stampIntervalMs } = opts;
  const retarget = opts.retarget ?? DEVNET_RETARGET;
  const schedule = opts.schedule ?? NETWORK_PROFILES.devnet.protocolVersionSchedule;
  const key = memoKey(retarget, schedule, forceLevels, stampIntervalMs);
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
        prevHeight: existing.prevHeight,
        prevCreatedAt: existing.prevCreatedAt,
      }
    : freshState();

  mineHeaders(state.headers.length, count, retarget, schedule, forceLevels, state, stampIntervalMs);
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
    retarget: DEVNET_RETARGET,
    maxFutureDriftMs: DEVNET_MAX_FUTURE_DRIFT_MS,
    nowMs: 100_000_000,
    genesisId: '',
    protocolVersionSchedule: NETWORK_PROFILES.devnet.protocolVersionSchedule,
  };
}

export function devnetProfileWithGenesisId(chain: MinedChain) {
  const gHash = blockHash(chain.headers[0]!);
  if (gHash === null) throw new Error('unhashable genesis');
  return {
    retarget: DEVNET_RETARGET,
    maxFutureDriftMs: DEVNET_MAX_FUTURE_DRIFT_MS,
    nowMs: 100_000_000,
    genesisId: gHash,
    protocolVersionSchedule: NETWORK_PROFILES.devnet.protocolVersionSchedule,
  };
}
