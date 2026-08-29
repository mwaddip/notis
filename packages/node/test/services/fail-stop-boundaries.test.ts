import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import type { ForkResolutionNet } from '../../src/services/fork-resolution.js';
import { makeBlock, insertPoisonedBlock } from '../helpers.js';

// ---------------------------------------------------------------------------
// Boundary pins that drive the real wiring — `pullBlocksHandler`,
// `guardStoreRead(getOrderingBlock)`, and the blocks router factory over a
// store whose tip row is poisoned (NODE_INTERFACE → Relay handlers / Sync
// handlers).
// ---------------------------------------------------------------------------

const stubNet: ForkResolutionNet = {
  getConnectedPeers: () => [],
  requestHeaders: async () => [],
  requestBlocks: async () => [],
  penalizePeer: () => {},
  peerTipHeight: () => null,
};

// ---------------------------------------------------------------------------
// Pull-path boundary — pullBlocksHandler over a poisoned store
// ---------------------------------------------------------------------------

describe('pull-path boundary (real wiring)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function poisonTip() {
    const { initDb, getDb } = await import('../../src/store/db.js');
    initDb(':memory:');
    const ordering = await import('../../src/store/ordering.js');
    insertPoisonedBlock(getDb(), makeBlock(1, -1));
    expect(ordering.getCurrentHeight()).toBe(1);
    return ordering;
  }

  it('a poisoned tip fires exit through the real pull handler', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await poisonTip();
    const { pullBlocksHandler } = await import(
      '../../src/services/handle-block.js'
    );

    const handler = pullBlocksHandler(stubNet);
    expect(() => handler(makeBlock(2, 1000), 'peer1')).toThrow('process.exit');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('an already-held block returns true', async () => {
    const { initDb } = await import('../../src/store/db.js');
    initDb(':memory:');
    const ordering = await import('../../src/store/ordering.js');
    const clean = makeBlock(1, 100);
    ordering.createOrderingBlock(clean, []);

    const { pullBlocksHandler } = await import(
      '../../src/services/handle-block.js'
    );

    const handler = pullBlocksHandler(stubNet);
    expect(handler(clean, 'peer1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Provider boundary — guardStoreRead(getOrderingBlock) over a poisoned store
// ---------------------------------------------------------------------------

describe('provider boundary (real wiring)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('a poisoned row fires exit through the guarded provider', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { initDb, getDb } = await import('../../src/store/db.js');
    initDb(':memory:');
    const ordering = await import('../../src/store/ordering.js');
    insertPoisonedBlock(getDb(), makeBlock(1, -1));

    const { guardStoreRead } = await import(
      '../../src/services/corrupt-state.js'
    );
    const guarded = guardStoreRead(ordering.getOrderingBlock);
    expect(() => guarded(1)).toThrow('process.exit');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('a clean height returns the block', async () => {
    const { initDb } = await import('../../src/store/db.js');
    initDb(':memory:');
    const ordering = await import('../../src/store/ordering.js');
    ordering.createOrderingBlock(makeBlock(1, 100), []);

    const { guardStoreRead } = await import(
      '../../src/services/corrupt-state.js'
    );
    const guarded = guardStoreRead(ordering.getOrderingBlock);
    const block = guarded(1);
    expect(block).not.toBeNull();
    expect(block!.header.height).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Route boundary — the real router with a guarded poisoned read
// ---------------------------------------------------------------------------

describe('route boundary (real wiring)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('GET /blocks/1 through the real router fires exit', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { initDb, getDb } = await import('../../src/store/db.js');
    initDb(':memory:');
    const ordering = await import('../../src/store/ordering.js');
    insertPoisonedBlock(getDb(), makeBlock(1, -1));

    const { guardStoreRead } = await import(
      '../../src/services/corrupt-state.js'
    );
    const { createRouter } = await import('../../src/routes/blocks.js');
    const { default: express } = await import('express');
    const http = await import('http');

    const app = express();
    app.use(createRouter({
      getOrderingBlock: guardStoreRead(ordering.getOrderingBlock),
      getOrderingBlockHash: ordering.getOrderingBlockHash,
      getCurrentHeight: ordering.getCurrentHeight,
      getPostCount: () => 0,
      getPendingPostCount: () => 0,
      getTotalKarma: () => 0n,
      getLiquidKarma: () => 0n,
      getTotalCredits: () => 0n,
      networkType: 'testnet',
      inviteProbationBlocks: 43200,
      vouchCooldownBlocks: 60,
      inviteBondMin: 100n,
      inviteBondMax: 10000n,
      getNetworkRecord: () => ({ memberCount: 1 }),
      membershipBarMultiplier: 1,
    }));

    await new Promise<void>((resolve) => {
      const server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        const req = http.request(
          { hostname: 'localhost', port: addr.port, path: '/blocks/1', method: 'GET' },
          (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => {
              server.close();
              resolve();
            });
          },
        );
        req.end();
      });
    });

    expect(exit).toHaveBeenCalledWith(1);
  });
});
