import { expect, vi } from 'vitest';
import {
  MAX_BLOCK_BODY_BYTES,
} from '@dagsocial/types';
import type {
  BlockHeader,
  OrderingBlock,
} from '@dagsocial/types';
import { makeApplicableBlock, makeTestConfig } from '../helpers.js';
import type { ForkResolutionNet } from '../../src/services/fork-resolution.js';
import type { Config } from '../../src/config.js';
import type Database from 'better-sqlite3';

// The devnet-profile config both the default suite's fork-resolution file and
// the slow tree hand to `startBlockCreator`. `makeTestConfig` fills the fields
// a `Config` requires that this literal does not state; every other field is
// kept verbatim so a newly-required one would still have to be stated here.
export const testConfig = makeTestConfig({
  port: 3000,
  dbPath: ':memory:',
  networkType: 'testnet' as const,
  nodeRole: 'miner' as const,
  blockBodyBudgetBytes: MAX_BLOCK_BODY_BYTES,
  orderingBlockPowTargetBits: 3072,
  bootstrapPeers: [] as string[],
  listenAddrs: '/ip4/127.0.0.1/tcp/0',
  maxPeers: 50,
});

type DbModule = {
  initDb: (path: string) => void;
  getDb: () => Database.Database;
  closeDb: () => void;
};

type BlockCreatorModule = {
  startBlockCreator: (cfg: Config) => void;
  stopBlockCreator: () => void;
  createOrderingBlock: () => OrderingBlock | null;
  getCurrentTemplate: () => OrderingBlock | null;
  submitMinedBlock: (powNonce: number, submittedHeight: number) => string | null;
};

export async function importDb(): Promise<DbModule> {
  return (await import('../../src/store/db.js')) as unknown as DbModule;
}

export async function importBlockCreator(): Promise<BlockCreatorModule> {
  return (await import(
    '../../src/services/block-creator.js'
  )) as unknown as BlockCreatorModule;
}

export async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as {
    getCurrentHeight: () => number;
    getOrderingBlock: (height: number) => OrderingBlock | null;
    getOrderingBlockHash: (height: number) => string | null;
    deleteOrderingBlock: (height: number) => void;
    createOrderingBlock: (block: OrderingBlock, interlinks: string[]) => void;
    getInterlinks: (height: number) => string[] | null;
  };
}

export async function importForkResolution() {
  return (await import(
    '../../src/services/fork-resolution.js'
  )) as unknown as {
    extendsOurTip: (block: OrderingBlock) => boolean;
    revertBlock: (height: number) => void;
    reorg: (forkHeight: number, newBlocks: OrderingBlock[]) => void;
    resolveFork: (
      block: OrderingBlock,
      net: ForkResolutionNet,
      fromPeerId: string,
    ) => Promise<void>;
    resetForkResolutionMemo: () => void;
  };
}

/**
 * A peer that answers the header request honestly and the block request with
 * `answer`.
 *
 * `connected` is what `getConnectedPeers()` reports — the Active list a
 * counterparty is selected from — and `askedPeers` records the peer id each of
 * the two requests went to, in call order.
 */
export function stubNet(
  theirHeaders: BlockHeader[],
  answer: OrderingBlock[],
  connected: string[] = ['peer-withholding'],
): ForkResolutionNet & {
  blockRequests: Array<{ startHeight: number; endHeight: number }>;
  headerRequests: Array<{ startHeight: number; maxCount: number }>;
  askedPeers: string[];
  penalties: Array<{ peerId: string; kind: string; reason: string }>;
} {
  const blockRequests: Array<{ startHeight: number; endHeight: number }> = [];
  const headerRequests: Array<{ startHeight: number; maxCount: number }> = [];
  const askedPeers: string[] = [];
  const penalties: Array<{ peerId: string; kind: string; reason: string }> = [];
  const peerTip = theirHeaders.length > 0
    ? Math.max(...theirHeaders.map(h => h.height))
    : null;
  return {
    blockRequests,
    headerRequests,
    askedPeers,
    penalties,
    getConnectedPeers: () => connected,
    requestHeaders: async (startHeight: number, maxCount: number, peerId: string) => {
      askedPeers.push(peerId);
      headerRequests.push({ startHeight, maxCount });
      // NET_INTERFACE → GetHeaders / GetBlocks responses: descending from startHeight,
      // clamped to the peer's tip, at most maxCount.
      const clamped = peerTip !== null ? Math.min(startHeight, peerTip) : startHeight;
      return theirHeaders
        .filter(h => h.height <= clamped)
        .sort((a, b) => b.height - a.height)
        .slice(0, maxCount);
    },
    requestBlocks: async (startHeight: number, endHeight: number, peerId: string) => {
      askedPeers.push(peerId);
      blockRequests.push({ startHeight, endHeight });
      return answer.filter(b => b.header.height >= startHeight && b.header.height <= endHeight);
    },
    penalizePeer: (peerId: string, kind: string, reason: string) => {
      penalties.push({ peerId, kind, reason });
    },
    peerTipHeight: () => peerTip,
  };
}

export interface Trackers {
  caughtCorrupt: Array<unknown>;
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers →
 * "One resolution at a time". The runner's launched resolution promise is
 * owned by the runner itself and reached through `waitForForkResolutionIdle`;
 * the fail-stop boundary is swapped for one that records rather than exits,
 * so a case can read what crossed it.
 */
export function installTrackers(ctx: Trackers, configOverride?: Partial<ReturnType<typeof makeTestConfig>>): void {
  if (configOverride) {
    const cfg = makeTestConfig(configOverride);
    vi.doMock('../../src/config.js', () => ({ config: cfg, loadConfig: () => cfg }));
  }
  vi.doMock('../../src/services/corrupt-state.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/services/corrupt-state.js')>();
    const wrapped: typeof actual.failStopIfCorruptChain = ((err: unknown): never => {
      if (err instanceof actual.CorruptChainStateError) {
        ctx.caughtCorrupt.push(err);
        return undefined as never;
      }
      throw err;
    }) as typeof actual.failStopIfCorruptChain;
    return { ...actual, failStopIfCorruptChain: wrapped };
  });
}

export async function teardownTrackers(): Promise<void> {
  const bc = await importBlockCreator();
  bc.stopBlockCreator();
  const { setClock } = await import('../../src/services/difficulty.js');
  setClock(null);
  const { resetForkResolutionRunner } = await import(
    '../../src/services/fork-resolution-runner.js'
  );
  resetForkResolutionRunner();
  const { resetForkResolutionMemo } = await import(
    '../../src/services/fork-resolution.js'
  );
  resetForkResolutionMemo();
  vi.doUnmock('../../src/services/corrupt-state.js');
  vi.doUnmock('../../src/config.js');
  vi.restoreAllMocks();
  vi.resetModules();
}

/**
 * NODE_INTERFACE → "One resolution at a time": wait until the runner is at
 * rest — nothing in flight and nothing pending — including resolutions a
 * hand-back starts. The runner owns the promise, so a case reaches it through
 * the exported waiter rather than wrapping `resolveFork`.
 */
export async function settleResolveForks(_ctx: Trackers): Promise<void> {
  const { waitForForkResolutionIdle } = await import(
    '../../src/services/fork-resolution-runner.js'
  );
  await waitForForkResolutionIdle();
  // Flush any synchronous post-settlement work from the handleOrderingBlock
  // catch chain and the apply path triggered by a block handed back.
  await Promise.resolve();
  await Promise.resolve();
}

/** The devnet far-future stamp the whole file runs under, well inside drift. */
export const T1 = 1_700_000_000_000;
export const HL = 288 * 60_000;
export const FAR_FUTURE = T1 + 40 * 86_400_000;

export async function initChainStore(): Promise<void> {
  const db = await importDb();
  db.initDb(':memory:');
  db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
  const { setClock } = await import('../../src/services/difficulty.js');
  setClock(() => FAR_FUTURE);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

export async function startCreator(cfg: ReturnType<typeof makeTestConfig>): Promise<void> {
  const bc = await importBlockCreator();
  bc.startBlockCreator(cfg);
}

export async function buildAndApply(specs: Array<[number, number]>): Promise<OrderingBlock[]> {
  const { applyOrderingBlock } = (await import('../../src/services/block-apply.js')) as {
    applyOrderingBlock: (block: OrderingBlock) => boolean;
  };
  const out: OrderingBlock[] = [];
  for (const [h, c] of specs) {
    const b = await makeApplicableBlock({ height: h, createdAt: c });
    expect(applyOrderingBlock(b)).toBe(true);
    out.push(b);
  }
  return out;
}

export interface StubNetOptions {
  readonly headerGate?: Promise<void>;
  readonly blockGate?: Promise<void>;
  readonly onHeaderCall?: () => void;
  readonly onBlockCall?: () => void;
  /** NODE_INTERFACE → "Re-scoring is memoised": the memo is keyed on
   *  `{atOurTip, theirTip}`. A case driving several resolutions off the same
   *  peer under one tip reads this through distinct `peerTip` values so one
   *  resolution's memo write does not short-circuit the next. */
  readonly peerTipOverride?: number | null;
}

export interface StubNet extends ForkResolutionNet {
  readonly penalties: Array<{ peerId: string; kind: string; reason: string }>;
  readonly headerCalls: { count: number };
  readonly blockCalls: { count: number };
}

/**
 * A peer serving one branch through the pull calls of NET_INTERFACE → Pull
 * Requests. Headers paged down from the request's start, blocks drawn by the
 * asked range, both optionally gated by a promise the case releases — a
 * scheduled order of events, not a sleep.
 */
export function singleBranchNet(
  peerId: string,
  blocks: readonly OrderingBlock[],
  opts: StubNetOptions = {},
): StubNet {
  const headers = blocks.map((b) => b.header);
  const tip = headers.length > 0 ? Math.max(...headers.map((h) => h.height)) : 0;
  const reportedTip = opts.peerTipOverride !== undefined ? opts.peerTipOverride : (tip === 0 ? null : tip);
  const penalties: Array<{ peerId: string; kind: string; reason: string }> = [];
  const headerCalls = { count: 0 };
  const blockCalls = { count: 0 };
  return {
    penalties,
    headerCalls,
    blockCalls,
    getConnectedPeers: () => [peerId],
    requestHeaders: async (startHeight, maxCount) => {
      headerCalls.count++;
      opts.onHeaderCall?.();
      if (opts.headerGate) await opts.headerGate;
      const clamped = tip === 0 ? startHeight : Math.min(startHeight, tip);
      return headers
        .filter((h) => h.height <= clamped)
        .sort((a, b) => b.height - a.height)
        .slice(0, maxCount);
    },
    requestBlocks: async (startHeight, endHeight) => {
      blockCalls.count++;
      opts.onBlockCall?.();
      if (opts.blockGate) await opts.blockGate;
      return blocks.filter(
        (b) => b.header.height >= startHeight && b.header.height <= endHeight,
      );
    },
    penalizePeer: (p, k, r) => { penalties.push({ peerId: p, kind: k, reason: r }); },
    peerTipHeight: () => reportedTip,
  };
}
