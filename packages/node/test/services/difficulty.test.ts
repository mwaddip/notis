import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RETARGET_HALFLIFE_BLOCKS,
  PROTOCOL_VERSION,
  EMPTY_STATE_ROOT,
  interlinkRoot,
} from '@dagsocial/types';
import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import { asertTargetBits, blockHash, blockWork } from '@dagsocial/validation';
import type { RetargetParams } from '@dagsocial/validation';
import { makeTestIdentity, solveHeaderPow, ZERO_HASH } from '../helpers.js';
import { defaultParams, makeChain } from '../helpers/make-header.js';
import type { PipelineCallbacks, PipelineContext } from '../../src/services/header-pipeline.js';

async function importDb() {
  return (await import('../../src/store/db.js')) as unknown as {
    initDb: (path: string) => void;
    closeDb: () => void;
  };
}

async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as unknown as {
    createOrderingBlock: (block: OrderingBlock, interlinks: string[]) => void;
    getCurrentHeight: () => number;
    getOrderingBlockHash: (height: number) => string | null;
  };
}

async function importDifficulty() {
  return (await import('../../src/services/difficulty.js')) as unknown as {
    retargetParams: () => RetargetParams;
    anchorCreatedAt: () => number;
    scheduledTargetBits: (parent: BlockHeader) => number;
    scheduledPowTargetBits: (header: BlockHeader) => number | null;
    nowMs: () => number;
    setClock: (fn: (() => number) | null) => void;
  };
}

async function seedBlock(
  ordering: Awaited<ReturnType<typeof importOrdering>>,
  height: number,
  createdAt: number,
  powTargetBits: number,
): Promise<BlockHeader> {
  const miner = makeTestIdentity();
  const header: BlockHeader = {
    protocolVersion: PROTOCOL_VERSION,
    height,
    prevBlockHash: ZERO_HASH,
    utxoTxRoot: ZERO_HASH,
    stateRoot: EMPTY_STATE_ROOT,
    validatorId: miner.userId,
    powNonce: 0,
    powTargetBits,
    createdAt,
    interlinkRoot: interlinkRoot([ZERO_HASH]),
    adProofsRoot: '00'.repeat(32),
  };
  header.powNonce = solveHeaderPow(header);
  ordering.createOrderingBlock(
    { header, utxoTxTree: { utxoTxIds: [], utxoTxs: [] }, validatorSignature: new Uint8Array(64) },
    [ZERO_HASH],
  );
  // The applied chain's headers ride the tree too (NODE_INTERFACE → Store
  // Interface → Header tree). `insertHeader` fills the row the pipeline fills
  // in production. Interlinks are the vector THIS header commits to — []
  // at height 1 — and `pathTa` is block 1's `createdAt` on this path.
  const { insertHeader } = await import('../../src/store/header-tree.js');
  const { getBlockCreatedAt } = await import('../../src/store/index.js');
  const w = blockWork(powTargetBits);
  if (w === null) throw new Error('seedBlock: powTargetBits outside domain');
  const hash = blockHash(header);
  if (hash === null) throw new Error('seedBlock: header outside domain');
  const pathTa = height === 1 ? createdAt : (getBlockCreatedAt(1) ?? createdAt);
  insertHeader({
    hash,
    height,
    prevHash: header.prevBlockHash,
    header,
    interlinks: [],
    chainWork: w,
    pathTa,
  });
  return header;
}

describe('difficulty schedule', () => {
  let db: Awaited<ReturnType<typeof importDb>>;
  let ordering: Awaited<ReturnType<typeof importOrdering>>;
  let difficulty: Awaited<ReturnType<typeof importDifficulty>>;

  beforeEach(async () => {
    vi.resetModules();
    db = await importDb();
    db.initDb(':memory:');
    ordering = await importOrdering();
    difficulty = await importDifficulty();
  });

  afterEach(() => {
    difficulty.setClock(null);
    db.closeDb();
  });

  describe('retargetParams', () => {
    it('derives params from the process config', async () => {
      const { config } = await import('../../src/config.js');
      const p = difficulty.retargetParams();
      expect(p.anchorBits).toBe(config.orderingBlockPowTargetBits);
      expect(p.idealMs).toBe(config.orderingBlockIdealMs);
      expect(p.halflifeMs).toBe(RETARGET_HALFLIFE_BLOCKS * config.orderingBlockIdealMs);
      expect(p.floorBits).toBe(config.orderingBlockPowTargetFloorBits);
      expect(p.ceilingBits).toBe(config.orderingBlockPowTargetCeilingBits);
    });
  });

  describe('scheduledTargetBits', () => {
    it('equals asertTargetBits over the stored block 1 stamp', async () => {
      const { config } = await import('../../src/config.js');
      const anchorBits = config.orderingBlockPowTargetBits;
      const t1 = 1_000_000;
      await seedBlock(ordering, 1, t1, anchorBits);

      const t2 = t1 + 120_000;
      const parent: BlockHeader = {
        protocolVersion: PROTOCOL_VERSION,
        height: 2,
        prevBlockHash: ZERO_HASH,
        utxoTxRoot: ZERO_HASH,
        stateRoot: EMPTY_STATE_ROOT,
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: anchorBits,
        createdAt: t2,
        interlinkRoot: interlinkRoot([ZERO_HASH]),
        adProofsRoot: '00'.repeat(32),
      };

      const scheduled = difficulty.scheduledTargetBits(parent);
      const expected = asertTargetBits(difficulty.retargetParams(), t1, parent);
      expect(scheduled).toBe(expected);
    });
  });

  describe('anchorCreatedAt', () => {
    it('returns block 1 stamp on a seeded chain', async () => {
      const { config } = await import('../../src/config.js');
      const t1 = 42_000;
      await seedBlock(ordering, 1, t1, config.orderingBlockPowTargetBits);
      expect(difficulty.anchorCreatedAt()).toBe(t1);
    });

    it('throws MissingStoredBlockError on a tipped chain with no row at 1', async () => {
      const { config } = await import('../../src/config.js');
      await seedBlock(ordering, 5, 100_000, config.orderingBlockPowTargetBits);
      expect(() => difficulty.anchorCreatedAt()).toThrow(/no block at height 1/);
    });

    it('throws a plain Error on an empty chain — a caller bug, not corruption', () => {
      expect(() => difficulty.anchorCreatedAt()).toThrow(/empty chain/);
    });
  });

  describe('scheduledPowTargetBits', () => {
    it('returns scheduledTargetBits(parent.header) when node holds the parent with matching hash', async () => {
      const { config } = await import('../../src/config.js');
      const anchorBits = config.orderingBlockPowTargetBits;
      const t1 = 1_000_000;
      await seedBlock(ordering, 1, t1, anchorBits);

      const t2 = t1 + 120_000;
      const block2Header = await seedBlock(ordering, 2, t2, anchorBits);
      const block2Hash = blockHash(block2Header);

      const headerAt3: BlockHeader = {
        protocolVersion: PROTOCOL_VERSION,
        height: 3,
        prevBlockHash: block2Hash!,
        utxoTxRoot: ZERO_HASH,
        stateRoot: EMPTY_STATE_ROOT,
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: anchorBits,
        createdAt: t2 + 120_000,
        interlinkRoot: interlinkRoot([ZERO_HASH]),
        adProofsRoot: '00'.repeat(32),
      };

      const result = difficulty.scheduledPowTargetBits(headerAt3);
      const expected = difficulty.scheduledTargetBits(block2Header);
      expect(result).toBe(expected);
    });

    it('returns config.orderingBlockPowTargetBits at height 1', async () => {
      const { config } = await import('../../src/config.js');
      const headerAt1: BlockHeader = {
        protocolVersion: PROTOCOL_VERSION,
        height: 1,
        prevBlockHash: ZERO_HASH,
        utxoTxRoot: ZERO_HASH,
        stateRoot: EMPTY_STATE_ROOT,
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: config.orderingBlockPowTargetBits,
        createdAt: 1_000_000,
        interlinkRoot: interlinkRoot([ZERO_HASH]),
        adProofsRoot: '00'.repeat(32),
      };
      expect(difficulty.scheduledPowTargetBits(headerAt1)).toBe(config.orderingBlockPowTargetBits);
    });

    it('returns null when no row exists at height − 1', () => {
      const headerAt5: BlockHeader = {
        protocolVersion: PROTOCOL_VERSION,
        height: 5,
        prevBlockHash: ZERO_HASH,
        utxoTxRoot: ZERO_HASH,
        stateRoot: EMPTY_STATE_ROOT,
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: 20,
        createdAt: 1_000_000,
        interlinkRoot: interlinkRoot([ZERO_HASH]),
        adProofsRoot: '00'.repeat(32),
      };
      expect(difficulty.scheduledPowTargetBits(headerAt5)).toBeNull();
    });

    it('returns null when stored hash differs from prevBlockHash', async () => {
      const { config } = await import('../../src/config.js');
      await seedBlock(ordering, 1, 1_000_000, config.orderingBlockPowTargetBits);

      const headerAt2: BlockHeader = {
        protocolVersion: PROTOCOL_VERSION,
        height: 2,
        prevBlockHash: 'ff'.repeat(32),
        utxoTxRoot: ZERO_HASH,
        stateRoot: EMPTY_STATE_ROOT,
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: config.orderingBlockPowTargetBits,
        createdAt: 2_000_000,
        interlinkRoot: interlinkRoot([ZERO_HASH]),
        adProofsRoot: '00'.repeat(32),
      };
      expect(difficulty.scheduledPowTargetBits(headerAt2)).toBeNull();
    });
  });

  describe('guardStoreRead wrapping scheduledPowTargetBits', () => {
    it('promotes a corrupt stored block_headers row into a fail-stop', async () => {
      const { guardStoreRead } = await import('../../src/services/corrupt-state.js');
      const { getDb } = await import('../../src/store/db.js');

      // The provider reads the tree parent (NODE_INTERFACE → Sync handlers
      // (pull-path) → "setScheduledTargetProvider(scheduledPowTargetBits)"), so a stored row whose
      // header_bytes do not decode is the corruption to surface.
      const corruptHash = 'ab'.repeat(32);
      const chainWorkBlob = Buffer.alloc(40); // 40 bytes, big-endian
      chainWorkBlob[39] = 1;
      getDb().prepare(
        `INSERT INTO block_headers
           (hash, height, prev_hash, header_bytes, interlinks, chain_work, path_t_a)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(corruptHash, 1, ZERO_HASH, Buffer.from([0xff, 0xff, 0xff]), Buffer.alloc(0), chainWorkBlob, 0);

      const headerAt2: BlockHeader = {
        protocolVersion: PROTOCOL_VERSION,
        height: 2,
        prevBlockHash: corruptHash,
        utxoTxRoot: ZERO_HASH,
        stateRoot: EMPTY_STATE_ROOT,
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: 20,
        createdAt: 1_000_000,
        interlinkRoot: interlinkRoot([ZERO_HASH]),
        adProofsRoot: '00'.repeat(32),
      };

      vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit');
      }) as never);
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const guarded = guardStoreRead(difficulty.scheduledPowTargetBits);
      expect(() => guarded(headerAt2)).toThrow('process.exit');
    });
  });

  describe('scheduledPowTargetBits reads the tree parent', () => {
    it('answers the schedule when the parent is a stored row off the applied chain', async () => {
      // Build an honest branch of 2 headers through the pipeline — pass 1
      // scores it against the (empty) best chain and wins, pass 2 stores
      // every row and rewrites `best_chain` (NODE_INTERFACE → Fork choice
      // decides on verified headers → "A side branch is stored only once it
      // is heavier"). The applied chain stays empty: no block body is staged.
      // The branch runs under the suite's own `retargetParams` so the
      // pipeline and the test share one anchor.
      const configMod = await import('../../src/config.js');
      const SCHEDULE = configMod.config.protocolVersionSchedule;
      const PARAMS = defaultParams({
        anchorBits: configMod.config.orderingBlockPowTargetBits,
        floorBits: configMod.config.orderingBlockPowTargetFloorBits,
        ceilingBits: configMod.config.orderingBlockPowTargetCeilingBits,
        idealMs: configMod.config.orderingBlockIdealMs,
      });
      const pipeline = await import('../../src/services/header-pipeline.js');
      pipeline.resetPipelineForTests();
      const branch = makeChain({ parent: null, n: 2, params: PARAMS, schedule: SCHEDULE });
      const callbacks: PipelineCallbacks = { penalize: () => {}, chainMoved: () => {} };
      const context: PipelineContext = {
        params: PARAMS,
        schedule: SCHEDULE,
        nowMs: () => 1_700_000_000_000 + 300_000_000_000,
        maxReorgDepth: 1_000,
        genesisId: '',
        lowestJournalHeight: () => null,
        appliedTipHeight: () => 0,
      };
      const headers = branch.map((p) => p.header);
      const first = pipeline.admitPage('peerT', branch[1]!.hash, headers, context, callbacks);
      expect(first.accepted).toBe(true);
      expect(first.outcome).toBe('won');
      const second = pipeline.admitPage('peerT', branch[1]!.hash, headers, context, callbacks);
      expect(second.accepted).toBe(true);
      expect(second.outcome).toBe('stored-from-pass-2');

      // Ask the provider about a header above the first stored row — height 2,
      // parent = `branch[0].hash`. The row stands at height 1, so the schedule
      // over its header and its `pathTa` is the answer.
      const parent = branch[0]!;
      const headerAbove: BlockHeader = {
        protocolVersion: PROTOCOL_VERSION,
        height: 2,
        prevBlockHash: parent.hash,
        utxoTxRoot: ZERO_HASH,
        stateRoot: EMPTY_STATE_ROOT,
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: branch[1]!.header.powTargetBits,
        createdAt: parent.header.createdAt + PARAMS.idealMs,
        interlinkRoot: interlinkRoot(parent.interlinks),
        adProofsRoot: '00'.repeat(32),
      };
      const freshDifficulty = (await import('../../src/services/difficulty.js')) as typeof import('../../src/services/difficulty.js');
      // The scheduled bits over the branch's own path: `asertTargetBits`
      // with the branch's block-1 stamp (`parent.pathTa`) and the stored
      // parent header.
      const expected = asertTargetBits(PARAMS, parent.pathTa, parent.header);
      const got = freshDifficulty.scheduledPowTargetBits(headerAbove);
      expect(got).toBe(expected);
      // The last assertion names the rule: the provider answered a header
      // whose parent sits in the tree off `ordering_blocks` — nothing is
      // applied, so an applied-chain read would have answered null.
      const { getOrderingBlockHash } = await import('../../src/store/index.js');
      expect(getOrderingBlockHash(1)).toBeNull();
    });
  });

  describe('clock seam', () => {
    it('defaults to Date.now', () => {
      const before = Date.now();
      const t = difficulty.nowMs();
      const after = Date.now();
      expect(t).toBeGreaterThanOrEqual(before);
      expect(t).toBeLessThanOrEqual(after);
    });

    it('takes an override and restores on null', () => {
      difficulty.setClock(() => 99999);
      expect(difficulty.nowMs()).toBe(99999);
      difficulty.setClock(null);
      expect(Math.abs(difficulty.nowMs() - Date.now())).toBeLessThan(100);
    });
  });
});
