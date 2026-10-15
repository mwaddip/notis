import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import type { PopowHeaderReader } from '@dagsocial/nipopow';
import { decodeNipopowProof } from '@dagsocial/nipopow';
import type { BlockHeader } from '@dagsocial/types';
import { GENESIS_PREV_BLOCK_HASH } from '@dagsocial/types';
import { initDb, closeDb } from '../../src/store/db.js';
import {
  createOrderingBlock,
  getCurrentHeight,
  getPopowHeaderByHash,
  getPopowHeaderAtHeight,
  getLastHeaders,
} from '../../src/store/ordering.js';
import { createRouter } from '../../src/routes/nipopow.js';
import { retargetParams } from '../../src/services/difficulty.js';
import { buildMinedHeaderChain } from '../helpers.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// NODE_INTERFACE → Nipopow prover → "The route caches its answer."
//
// The counter rides `reader.chainHeight` — the one call `proveWithReader`
// makes once per build (NIPOPOW_INTERFACE → proveWithReader) — and a cache
// hit short-circuits before `proveWithReader`, so a hit leaves it unchanged.

const CHAIN_LEN = 20;
let testDir: string;
let extraHeader: BlockHeader;
let extraInterlinks: string[];

const realReader: PopowHeaderReader = {
  chainHeight: getCurrentHeight,
  popowHeaderByHash: getPopowHeaderByHash,
  popowHeaderAtHeight: getPopowHeaderAtHeight,
  lastHeaders: getLastHeaders,
};

interface Counted {
  reader: PopowHeaderReader;
  builds(): number;
}

function wrapCounting(real: PopowHeaderReader): Counted {
  let count = 0;
  return {
    reader: {
      chainHeight: () => {
        count++;
        return real.chainHeight();
      },
      popowHeaderByHash: (hash) => real.popowHeaderByHash(hash),
      popowHeaderAtHeight: (height) => real.popowHeaderAtHeight(height),
      lastHeaders: (n) => real.lastHeaders(n),
    },
    builds: () => count,
  };
}

function makeApp(reader: PopowHeaderReader): express.Express {
  const app = express();
  app.use(express.json());
  app.use(createRouter({ reader, getCurrentHeight }));
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      console.error('500 error:', err instanceof Error ? err.stack : err);
      res.status(500).json({ error: 'internal' });
    },
  );
  return app;
}

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

function appendOneBlock(): void {
  createOrderingBlock(
    {
      header: extraHeader,
      utxoTxTree: { utxoTxIds: ['77'.repeat(32)], utxoTxs: [new Uint8Array(96)] },
      validatorSignature: new Uint8Array(64),
    },
    extraInterlinks,
  );
}

function decodeProof(proofHex: string): ReturnType<typeof decodeNipopowProof> {
  return decodeNipopowProof(new Uint8Array(Buffer.from(proofHex, 'hex')));
}

describe('nipopow route proof cache per tip', () => {
  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), 'dagsocial-test-nipopow-cache-'));
    initDb(join(testDir, 'store.sqlite'));

    const { headers, interlinksPerHeader } = buildMinedHeaderChain({
      anchorPrevBlockHash: GENESIS_PREV_BLOCK_HASH,
      anchorInterlinks: [],
      startHeight: 1,
      count: CHAIN_LEN + 1,
      params: retargetParams(),
      anchorCreatedAt: null,
      anchorStamp: 0,
      startStamp: 1_000_000,
    });

    for (let i = 0; i < CHAIN_LEN; i++) {
      createOrderingBlock(
        {
          header: headers[i]!,
          utxoTxTree: { utxoTxIds: ['77'.repeat(32)], utxoTxs: [new Uint8Array(96)] },
          validatorSignature: new Uint8Array(64),
        },
        interlinksPerHeader[i]!,
      );
    }

    extraHeader = headers[CHAIN_LEN]!;
    extraInterlinks = interlinksPerHeader[CHAIN_LEN]!;
  });

  afterAll(() => {
    closeDb();
    rmSync(testDir, { recursive: true, force: true });
  });

  it.fails('one tip, one (m, k): built once, bytes identical', async () => {
    const counted = wrapCounting(realReader);
    const app = makeApp(counted.reader);
    const r1 = await request(app, '/nipopow/proof/3/3');
    const r2 = await request(app, '/nipopow/proof/3/3');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect((r1.data as { proof: string }).proof).toBe((r2.data as { proof: string }).proof);
    expect(counted.builds()).toBe(1);
  });

  it.fails('one tip, four pairs then the first-asked again: four builds', async () => {
    const counted = wrapCounting(realReader);
    const app = makeApp(counted.reader);
    for (const path of [
      '/nipopow/proof/1/1',
      '/nipopow/proof/2/2',
      '/nipopow/proof/3/3',
      '/nipopow/proof/4/4',
      '/nipopow/proof/1/1',
    ]) {
      const res = await request(app, path);
      expect(res.status).toBe(200);
    }
    expect(counted.builds()).toBe(4);
  });

  it.fails(
    'one tip, five pairs then the first-asked rebuilds; the fourth-asked still answers from cache',
    async () => {
      const counted = wrapCounting(realReader);
      const app = makeApp(counted.reader);
      for (const path of [
        '/nipopow/proof/1/1',
        '/nipopow/proof/2/2',
        '/nipopow/proof/3/3',
        '/nipopow/proof/4/4',
        '/nipopow/proof/5/5',
      ]) {
        const res = await request(app, path);
        expect(res.status).toBe(200);
      }
      expect(counted.builds()).toBe(5);
      const re1 = await request(app, '/nipopow/proof/1/1');
      expect(re1.status).toBe(200);
      expect(counted.builds()).toBe(6);
      const re4 = await request(app, '/nipopow/proof/4/4');
      expect(re4.status).toBe(200);
      expect(counted.builds()).toBe(6);
    },
  );

  it('one tip, a block appended, same request: the suffix ends at the new tip and builds twice', async () => {
    const counted = wrapCounting(realReader);
    const app = makeApp(counted.reader);
    const r1 = await request(app, '/nipopow/proof/3/3');
    expect(r1.status).toBe(200);
    const p1 = decodeProof((r1.data as { proof: string }).proof);
    const tipBefore = p1.suffixTail[p1.suffixTail.length - 1]!.height;
    expect(tipBefore).toBe(CHAIN_LEN);

    appendOneBlock();

    const r2 = await request(app, '/nipopow/proof/3/3');
    expect(r2.status).toBe(200);
    const p2 = decodeProof((r2.data as { proof: string }).proof);
    const tipAfter = p2.suffixTail[p2.suffixTail.length - 1]!.height;
    expect(tipAfter).toBe(tipBefore + 1);
    expect(counted.builds()).toBe(2);
  });

  it('after a successful request, a 404 chain-too-short answers again, uncached', async () => {
    const counted = wrapCounting(realReader);
    const app = makeApp(counted.reader);
    const ok = await request(app, '/nipopow/proof/3/3');
    expect(ok.status).toBe(200);
    const buildsAfterOk = counted.builds();
    const bad1 = await request(app, '/nipopow/proof/128/128');
    expect(bad1.status).toBe(404);
    const bad2 = await request(app, '/nipopow/proof/128/128');
    expect(bad2.status).toBe(404);
    expect(counted.builds()).toBe(buildsAfterOk);
  });

  it('after a successful request, a 400 answers again, uncached', async () => {
    const counted = wrapCounting(realReader);
    const app = makeApp(counted.reader);
    const ok = await request(app, '/nipopow/proof/3/3');
    expect(ok.status).toBe(200);
    const buildsAfterOk = counted.builds();
    const bad1 = await request(app, '/nipopow/proof/0/3');
    expect(bad1.status).toBe(400);
    const bad2 = await request(app, '/nipopow/proof/0/3');
    expect(bad2.status).toBe(400);
    expect(counted.builds()).toBe(buildsAfterOk);
  });
});
