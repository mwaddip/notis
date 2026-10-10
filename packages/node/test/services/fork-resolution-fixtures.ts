import {
  MAX_BLOCK_BODY_BYTES,
} from '@dagsocial/types';
import type {
  BlockHeader,
  OrderingBlock,
} from '@dagsocial/types';
import { makeTestConfig } from '../helpers.js';
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
