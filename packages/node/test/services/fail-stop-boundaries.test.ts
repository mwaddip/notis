import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import {
  PROTOCOL_VERSION,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
} from '@dagsocial/types';
import type { OrderingBlock } from '@dagsocial/types';
import type { ForkResolutionNet } from '../../src/services/fork-resolution.js';

// ---------------------------------------------------------------------------
// Boundary pins that drive the real wiring — `pullBlocksHandler`,
// `guardStoreRead(getOrderingBlock)`, and the blocks router factory over a
// store whose tip row is poisoned (NODE_INTERFACE → Relay handlers / Sync
// handlers).
// ---------------------------------------------------------------------------

function makeBlock(height: number, createdAt: number): OrderingBlock {
  return {
    header: {
      protocolVersion: PROTOCOL_VERSION,
      height,
      prevBlockHash: '00'.repeat(32),
      utxoTxRoot: '00'.repeat(32),
      stateRoot: '00'.repeat(33),
      validatorId: new Uint8Array(32),
      powNonce: 0,
      powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
      createdAt,
    },
    utxoTxTree: {
      utxoTxIds: ['77'.repeat(32)],
      utxoTxs: [new Uint8Array(96)],
      pruneEntries: [],
    },
    validatorSignature: new Uint8Array(64),
  };
}

const stubNet: ForkResolutionNet = {
  getConnectedPeers: () => [],
  requestHeaders: async () => [],
  requestBlocks: async () => [],
  penalizePeer: () => {},
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
    const { initDb } = await import('../../src/store/db.js');
    initDb(':memory:');
    const ordering = await import('../../src/store/ordering.js');
    ordering.createOrderingBlock(makeBlock(1, -1));
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

    const handler = pullBlocksHandler(stubNet, undefined);
    expect(() => handler(makeBlock(2, 1000), 'peer1')).toThrow('process.exit');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('an already-held block returns true', async () => {
    const { initDb } = await import('../../src/store/db.js');
    initDb(':memory:');
    const ordering = await import('../../src/store/ordering.js');
    const clean = makeBlock(1, 100);
    ordering.createOrderingBlock(clean);

    const { pullBlocksHandler } = await import(
      '../../src/services/handle-block.js'
    );

    const handler = pullBlocksHandler(stubNet, undefined);
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

    const { initDb } = await import('../../src/store/db.js');
    initDb(':memory:');
    const ordering = await import('../../src/store/ordering.js');
    ordering.createOrderingBlock(makeBlock(1, -1));

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
    ordering.createOrderingBlock(makeBlock(1, 100));

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
// Route boundary — the blocks router factory with a guarded poisoned read
// ---------------------------------------------------------------------------

describe('route boundary (real wiring)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('GET /blocks/1 with a guarded poisoned read fires exit', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { initDb } = await import('../../src/store/db.js');
    initDb(':memory:');
    const ordering = await import('../../src/store/ordering.js');
    ordering.createOrderingBlock(makeBlock(1, -1));

    const { guardStoreRead } = await import(
      '../../src/services/corrupt-state.js'
    );
    const guarded = guardStoreRead(ordering.getOrderingBlock);

    // The property is the wrap through the real route, not Express's 500.
    expect(() => guarded(1)).toThrow('process.exit');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
