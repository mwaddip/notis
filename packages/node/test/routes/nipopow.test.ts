import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { initDb, closeDb } from '../../src/store/db.js';
import {
  createOrderingBlock,
  getCurrentHeight,
  getPopowHeaderByHash,
  getPopowHeaderAtHeight,
  getLastHeaders,
  getHeadersAfter,
} from '../../src/store/ordering.js';
import { createRouter } from '../../src/routes/nipopow.js';
import { createPopowHeaderReader } from '../../src/services/nipopow.js';
import { buildMinedHeaderChain } from '../helpers.js';
import { GENESIS_PREV_BLOCK_HASH, MAX_FUTURE_DRIFT_MS } from '@dagsocial/types';
import { retargetParams } from '../../src/services/difficulty.js';
import { decodeNipopowProof, verifyProof } from '@dagsocial/nipopow';
import { unlinkSync } from 'fs';

const TEST_DB = '/tmp/dagsocial-test-routes-nipopow.sqlite';
const CHAIN_LEN = 20;

function request(
  app: express.Express,
  path: string,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
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

describe('nipopow route', () => {
  let app: express.Express;

  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
    initDb(TEST_DB);

    const { headers, interlinksPerHeader } = buildMinedHeaderChain({
      anchorPrevBlockHash: GENESIS_PREV_BLOCK_HASH,
      anchorInterlinks: [],
      startHeight: 1,
      count: CHAIN_LEN,
      params: retargetParams(),
      anchorCreatedAt: null,
      anchorStamp: 0,
      startStamp: 1_000_000,
    });

    for (let i = 0; i < headers.length; i++) {
      createOrderingBlock(
        {
          header: headers[i]!,
          utxoTxTree: { utxoTxIds: ['77'.repeat(32)], utxoTxs: [new Uint8Array(96)] },
          validatorSignature: new Uint8Array(64),
        },
        interlinksPerHeader[i]!,
      );
    }

    const reader = createPopowHeaderReader({
      getPopowHeaderByHash,
      getPopowHeaderAtHeight,
      getLastHeaders,
      getHeadersAfter,
      getCurrentHeight,
    });

    app = express();
    app.use(express.json());
    app.use(createRouter({ reader, getCurrentHeight }));
    app.use(
      (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        console.error('500 error:', err instanceof Error ? err.stack : err);
        res.status(500).json({ error: 'internal' });
      },
    );
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
  });

  // ---- 400 rejections ----

  it('rejects m=0', async () => {
    const res = await request(app, '/nipopow/proof/0/6');
    expect(res.status).toBe(400);
  });

  it('rejects k=0', async () => {
    const res = await request(app, '/nipopow/proof/6/0');
    expect(res.status).toBe(400);
  });

  it('rejects m=129', async () => {
    const res = await request(app, '/nipopow/proof/129/6');
    expect(res.status).toBe(400);
  });

  it('rejects k=129', async () => {
    const res = await request(app, '/nipopow/proof/6/129');
    expect(res.status).toBe(400);
  });

  it('rejects m=1.5', async () => {
    const res = await request(app, '/nipopow/proof/1.5/6');
    expect(res.status).toBe(400);
  });

  it('rejects m=abc', async () => {
    const res = await request(app, '/nipopow/proof/abc/6');
    expect(res.status).toBe(400);
  });

  it('rejects m=0x10', async () => {
    const res = await request(app, '/nipopow/proof/0x10/6');
    expect(res.status).toBe(400);
  });

  it('rejects k=1e2', async () => {
    const res = await request(app, '/nipopow/proof/6/1e2');
    expect(res.status).toBe(400);
  });

  // ---- 404 chain too short ----

  it('returns 404 when chain is too short', async () => {
    const res = await request(app, `/nipopow/proof/6/${CHAIN_LEN}`);
    expect(res.status).toBe(404);
    expect((res.data as Record<string, unknown>).error).toBe('chain too short');
  });

  // ---- 200 success ----

  it('returns a valid proof that decodes and verifies', async () => {
    const res = await request(app, '/nipopow/proof/3/3');
    expect(res.status).toBe(200);
    const body = res.data as { proof: string };
    expect(typeof body.proof).toBe('string');

    const proofBytes = Buffer.from(body.proof, 'hex');
    const proof = decodeNipopowProof(new Uint8Array(proofBytes));
    expect(proof.m).toBe(3);
    expect(proof.k).toBe(3);

    const result = verifyProof(proof, {
      retarget: retargetParams(),
      maxFutureDriftMs: MAX_FUTURE_DRIFT_MS,
      nowMs: Date.now() + 86_400_000,
      genesisId: '',
      protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
    });
    expect(result.ok).toBe(true);
  });

  it('same request twice returns identical bytes', async () => {
    const res1 = await request(app, '/nipopow/proof/3/3');
    const res2 = await request(app, '/nipopow/proof/3/3');
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect((res1.data as { proof: string }).proof).toBe(
      (res2.data as { proof: string }).proof,
    );
  });

  it('route is reachable without MINING_SECRET', async () => {
    const res = await request(app, '/nipopow/proof/3/3');
    expect(res.status).toBe(200);
  });
});
