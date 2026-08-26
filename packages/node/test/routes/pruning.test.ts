import { describe, it, expect } from 'vitest';
import express from 'express';
import http from 'http';
import { deleteRoutes } from '../../src/routes/delete.js';
import type { UtxoTransaction } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePruneTx(): UtxoTransaction {
  return {
    inputs: ['a'.repeat(64)],
    outputs: [{ boxType: 'karma' as const, value: 10n, owner: new Uint8Array(32), createdAtBlock: 1 }],
    signatures: {},
    protocolVersion: 1,
    prune: {
      rootPostHash: 'd'.repeat(64),
      subtreePostIds: ['d'.repeat(64)],
      subtreeMerkleRoot: new Uint8Array(32),
    },
  };
}

async function request(
  postId: string,
  body: unknown,
  executePruneImpl?: (tx: UtxoTransaction) => { txId: string },
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const deps = {
      executePrune: executePruneImpl ?? (() => ({ txId: 'b'.repeat(64) })),
    };
    const app = express();
    app.use(express.json());
    app.use(deleteRoutes(deps));
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const r = http.request(
        {
          hostname: 'localhost',
          port: addr.port,
          path: `/posts/${postId}/prune`,
          method: 'POST',
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
      if (body !== undefined) {
        r.write(JSON.stringify(body, (_k, v) => {
          if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
          if (typeof v === 'bigint') return v.toString();
          return v;
        }));
      }
      r.end();
    });
  });
}

const TEST_POST_HASH = 'd'.repeat(64);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pruning routes', () => {
  it('POST /posts/:id/prune with a prune transaction returns 201', async () => {
    const res = await request(TEST_POST_HASH, makePruneTx());
    expect(res.status).toBe(201);
    const body = res.data as Record<string, unknown>;
    expect(body.status).toBe('submitted');
    expect(typeof body.txId).toBe('string');
    expect(body.postId).toBe(TEST_POST_HASH);
  });

  it('POST /posts/:id/prune without prune payload returns 400', async () => {
    const res = await request(TEST_POST_HASH, { inputs: [], outputs: [], signatures: {}, protocolVersion: 1 });
    expect(res.status).toBe(400);
    const body = res.data as Record<string, unknown>;
    expect(body.error).toContain('prune transaction');
  });

  it('POST /posts/:id/prune returns 404 when executePrune throws 404', async () => {
    const res = await request(TEST_POST_HASH, makePruneTx(), () => {
      throw Object.assign(new Error('Post not found'), { statusCode: 404 });
    });
    expect(res.status).toBe(404);
  });

  it('POST /posts/:id/prune returns 403 when executePrune throws 403', async () => {
    const res = await request(TEST_POST_HASH, makePruneTx(), () => {
      throw Object.assign(new Error('Author mismatch'), { statusCode: 403 });
    });
    expect(res.status).toBe(403);
  });

  it('POST /posts/:id/prune returns 400 when executePrune throws 400', async () => {
    const res = await request(TEST_POST_HASH, makePruneTx(), () => {
      throw Object.assign(
        new Error('subtreePostIds does not match committed topology'),
        { statusCode: 400 },
      );
    });
    expect(res.status).toBe(400);
    const body = res.data as Record<string, unknown>;
    expect(body.error).toBe('subtreePostIds does not match committed topology');
  });

  it('POST /posts/:id/prune returns 500 for unexpected errors', async () => {
    const res = await request(TEST_POST_HASH, makePruneTx(), () => {
      throw new Error('unexpected');
    });
    expect(res.status).toBe(500);
  });
});
