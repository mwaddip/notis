import { expect } from 'vitest';
import {
  MAX_BLOCK_BODY_BYTES,
} from '@dagsocial/types';
import type {
  OrderingBlock,
} from '@dagsocial/types';
import { makeApplicableBlock, makeTestConfig } from '../helpers.js';
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

/**
 * Stage each block the test will hand to `reorg`, returning the hashes in
 * input order — `reorg(forkHeight, hashes)` reads each body out of
 * `staged_blocks` one at a time.
 */
export async function stagePrefix(blocks: readonly OrderingBlock[]): Promise<string[]> {
  const { stageBlock } = await import('../../src/store/header-tree.js');
  const { blockHash } = await import('@dagsocial/validation');
  const { encodeOrderingBlock } = await import('@dagsocial/types');
  const out: string[] = [];
  for (const b of blocks) {
    const hash = blockHash(b.header);
    if (hash === null) throw new Error('stagePrefix: block header is unhashable');
    stageBlock(hash, b.header.height, encodeOrderingBlock(b), 'test');
    out.push(hash);
  }
  return out;
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
  const { default: vi } = await import('vitest') as unknown as { default: typeof import('vitest') };
  void vi;
  const vitest = await import('vitest');
  vitest.vi.spyOn(console, 'warn').mockImplementation(() => {});
  vitest.vi.spyOn(console, 'log').mockImplementation(() => {});
  vitest.vi.spyOn(console, 'error').mockImplementation(() => {});
}

export async function startCreator(cfg: ReturnType<typeof makeTestConfig>): Promise<void> {
  const bc = await importBlockCreator();
  bc.startBlockCreator(cfg);
}

export async function importForkResolution() {
  return (await import(
    '../../src/services/fork-resolution.js'
  )) as unknown as {
    revertBlock: (height: number) => void;
    reorg: (forkHeight: number, hashes: readonly string[]) => void;
  };
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
