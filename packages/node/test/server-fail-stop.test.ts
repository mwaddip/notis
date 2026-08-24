import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'net';
import { makeTestConfig, makeBlock, insertPoisonedBlock } from './helpers.js';
import { MAX_BLOCK_BODY_BYTES, profileFor } from '@dagsocial/types';

function makeConfig() {
  return makeTestConfig({
    port: 0,
    dbPath: ':memory:',
    networkType: 'testnet',
    profile: profileFor('testnet'),
    nodeRole: 'server',
    blockBodyBudgetBytes: MAX_BLOCK_BODY_BYTES,
    orderingBlockPowTargetBits: 3072,
    bootstrapPeers: [],
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    maxPeers: 50,
  });
}

// ---------------------------------------------------------------------------
// server.ts wires getOrderingBlock through guardStoreRead, so a
// CorruptChainStateError on the /blocks routes reaches failStopIfCorruptChain
// (NODE_INTERFACE → Sync handlers (pull-path)).
// ---------------------------------------------------------------------------

describe('server /blocks guardStoreRead wiring', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function startApp(block?: ReturnType<typeof makeBlock>, poison = false) {
    const { initDb, closeDb, getDb } = await import('../src/store/db.js');
    initDb(':memory:');
    if (block) {
      if (poison) {
        insertPoisonedBlock(getDb(), block);
      } else {
        const ordering = await import('../src/store/ordering.js');
        ordering.createOrderingBlock(block);
      }
    }
    const { createApp } = await import('../src/server.js');
    const app = createApp(makeConfig());
    const server = app.listen(0);
    const addr = server.address() as AddressInfo;
    return {
      baseUrl: `http://localhost:${addr.port}`,
      close: () => { server.close(); closeDb(); },
    };
  }

  it('GET /blocks/:height on a poisoned tip fires process.exit(1)', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { baseUrl, close } = await startApp(makeBlock(1, -1), true);
    try {
      // The mocked process.exit throws inside the handler; whether the client
      // sees a 500 or a dropped socket is not the pin.
      await fetch(`${baseUrl}/blocks/1`).catch(() => undefined);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      close();
    }
  });

  it('GET /blocks/current reads the stored block_hash and answers over a rotted row', async () => {
    // NODE_INTERFACE → "Who reads the block_hash column, and who deliberately
    // does not". The route reads the column, not the body, so a body-poisoned
    // row at the tip answers instead of triggering the fail-stop.
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    const { baseUrl, close } = await startApp(makeBlock(1, -1), true);
    try {
      const res = await fetch(`${baseUrl}/blocks/current`);
      expect(res.status).toBe(200);
      const body = await res.json() as { height: number; hash: string };
      expect(body.height).toBe(1);
      // `insertPoisonedBlock` writes `poisoned-${height}` when blockHash
      // returns null for the unhashable header.
      expect(body.hash).toBe('poisoned-1');
      expect(exit).not.toHaveBeenCalled();
    } finally {
      close();
    }
  });

  it('GET /blocks/:height on a clean block returns 200', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    const { baseUrl, close } = await startApp(makeBlock(1, 100));
    try {
      const res = await fetch(`${baseUrl}/blocks/1`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('header');
      expect(body.header.height).toBe(1);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      close();
    }
  });

  it('GET /blocks/:height returns 404 for a missing height', async () => {
    const { baseUrl, close } = await startApp();
    try {
      const res = await fetch(`${baseUrl}/blocks/999`);
      expect(res.status).toBe(404);
    } finally {
      close();
    }
  });
});
