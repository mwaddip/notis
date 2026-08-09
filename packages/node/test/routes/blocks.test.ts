import { uid } from '../helpers.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { initDb, closeDb, getDb } from '../../src/store/db.js';
import {
  getOrderingBlock,
  getCurrentHeight,
  createOrderingBlock,
} from '../../src/store/ordering.js';
import { createRouter } from '../../src/routes/blocks.js';
import { generateKeyPair, PROTOCOL_VERSION } from '@dagsocial/types';
import type { OrderingBlock } from '@dagsocial/types';
import { unlinkSync } from 'fs';

const TEST_DB = '/tmp/dagsocial-test-routes-blocks.sqlite';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBlock(height: number, hash: string): OrderingBlock {
  const baseHash = height === 1 ? '0'.repeat(64) : `block-${height - 1}`;
  return {
    header: {
      protocolVersion: PROTOCOL_VERSION,
      height,
      prevBlockHash: baseHash,
      // 32 bytes, so 64 hex characters — `'00'` repeated 32 times, not 64.
      // These were double-width, and nothing noticed: this block is written
      // straight through `createOrderingBlock` (the store), bypassing the apply
      // gate that checks the header domain, and `blockHash` used to hash
      // whatever it was handed. Since Phase 1f the route answers `hash: null`
      // for a header it cannot encode, which is what surfaced them.
      subBlockRoot: '00'.repeat(32),
      utxoTxRoot: '00'.repeat(32),
      stateRoot: '00'.repeat(33),
      validatorId: uid('validator-1'),
      powNonce: 0,
      powTargetBits: 12,
      createdAt: Date.now(),
    },
    subBlockTree: {
      subBlockRefs: [],
      subBlockEntries: [],
      pruneEntries: [],
    },
    utxoTxTree: {
      utxoTxIds: [],
      utxoTxs: [],
      coinbaseOutputs: [],
    },
    validatorSignature: new Uint8Array(64),
  };
}

async function request(
  path: string,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const db = getDb();

    // Build deps with real DB queries
    const deps = {
      getOrderingBlock,
      getCurrentHeight,
      getPostCount: () =>
        (
          db
            .prepare(
              "SELECT COUNT(*) AS c FROM dag_posts WHERE status = 'confirmed'",
            )
            .get() as { c: number }
        ).c,
      getPendingPostCount: () =>
        (
          db
            .prepare(
              "SELECT COUNT(*) AS c FROM dag_posts WHERE status = 'pending'",
            )
            .get() as { c: number }
        ).c,
      // `.safeIntegers()` and the bigint row type, matching `server.ts:372-389`
      // exactly. This mock was production's code with that one call removed, so
      // it summed karma as a JS number and returned it where `BlocksDeps` says
      // bigint — and the route renders it with `.toString()`, which is where a
      // sum past 2^53 would start printing a different number than the node
      // would. A mock that diverges from the interface it stands for is the
      // hazard the Config fixtures had; this one was arithmetic, not shape.
      getTotalKarma: () => {
        const row = db
          .prepare(
            "SELECT COALESCE(SUM(value), 0) AS s FROM utxo_boxes WHERE box_type = 'karma' AND spent_at_block IS NULL",
          )
          .safeIntegers()
          .get() as { s: bigint };
        return row.s;
      },
      getTotalCredits: () => {
        const row = db
          .prepare(
            "SELECT COALESCE(SUM(value), 0) AS s FROM utxo_boxes WHERE box_type = 'credit' AND spent_at_block IS NULL",
          )
          .safeIntegers()
          .get() as { s: bigint };
        return row.s;
      },
      networkType: 'testnet',
    };

    const app = express();
    app.use(express.json());
    app.use(createRouter(deps));
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const r = http.request(
        {
          hostname: 'localhost',
          port: addr.port,
          path,
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => {
            server.close();
            try {
              resolve({ status: res.statusCode ?? 0, data: JSON.parse(d) });
            } catch {
              resolve({ status: res.statusCode ?? 0, data: d });
            }
          });
        },
      );
      r.end();
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('blocks routes', () => {
  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
    initDb(TEST_DB);

    // Create an ordering block
    const block = makeBlock(1, 'a'.repeat(64));
    createOrderingBlock(block);

    // Create an identity
    const kp = generateKeyPair();
    const userId = kp.publicKey;
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
  });

  it('GET /blocks/:height returns block data', async () => {
    const res = await request('/blocks/1');
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    const header = body.header as Record<string, unknown>;
    expect(header.height).toBe(1);
    expect(typeof body.validatorSignature).toBe('string');
    expect(body.validatorSignature).toBeDefined();
  });

  it('GET /blocks/:height with invalid height returns 400', async () => {
    const res = await request('/blocks/not-a-number');
    expect(res.status).toBe(400);
  });

  it('GET /blocks/:height with unknown height returns 404', async () => {
    const res = await request('/blocks/99999');
    expect(res.status).toBe(404);
  });

  it('GET /blocks/current returns current height and hash', async () => {
    const res = await request('/blocks/current');
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.height).toBe(1);
    expect(typeof body.hash).toBe('string');
  });

  it('GET /status returns aggregated counts', async () => {
    const res = await request('/status');
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(typeof body.blockHeight).toBe('number');
    expect(typeof body.postCount).toBe('number');
    expect(typeof body.pendingPosts).toBe('number');
    expect(typeof body.totalKarma).toBe('string');
    expect(typeof body.totalCredits).toBe('string');
    expect(body.networkType).toBe('testnet');
  });
});
