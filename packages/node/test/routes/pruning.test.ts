import { describe, it, expect } from 'vitest';
import express from 'express';
import http from 'http';
import { deleteRoutes } from '../../src/routes/delete.js';
import type { UtxoTransaction } from '@dagsocial/types';
import type { UtxoEngineDeps } from '../../src/services/utxo-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJsonPruneTxBody(): Record<string, unknown> {
  return {
    inputs: ['a'.repeat(64)],
    outputs: [{ boxType: 'karma', value: '10', owner: '0'.repeat(64), createdAtBlock: 1 }],
    signatures: {},
    protocolVersion: 1,
    prune: {
      rootPostHash: 'd'.repeat(64),
      subtreePostIds: ['d'.repeat(64)],
      subtreeMerkleRoot: '0'.repeat(64),
    },
  };
}

const STUB_DEPS: UtxoEngineDeps = {
  getBox: () => null,
  insertBox: () => {},
  consumeBox: () => {},
  getKarmaBox: () => null,
  getKarmaValue: () => 0n,
  getIdentityRecord: () => null,
  hasActiveVouchEscrow: () => false,
  vouchCooldownBlocks: 0,
  inviteBondMin: 0n,
  inviteBondMax: 0n,
  decayCfg: { staleThresholdBlocks: 0, decayIntervalBlocks: 0, decayAmount: 0n, karmaMinimum: 0n },
  storageRentPeriodBlocks: 0,
  getBoxProvenance: () => null,
  getTopologyAuthor: () => null,
  runInTransaction: (fn: () => void) => fn(),
};

async function request(
  postId: string,
  body: unknown,
  executePruneImpl?: (deps: UtxoEngineDeps, tx: UtxoTransaction, height: number) => { txId: string },
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const deps = {
      ...STUB_DEPS,
      executePrune: executePruneImpl ?? ((_d: UtxoEngineDeps, _t: UtxoTransaction, _h: number) => ({ txId: 'b'.repeat(64) })),
      getCurrentHeight: () => 10,
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
        r.write(JSON.stringify(body));
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
    const res = await request(TEST_POST_HASH, { tx: makeJsonPruneTxBody() });
    expect(res.status).toBe(201);
    const body = res.data as Record<string, unknown>;
    expect(body.status).toBe('submitted');
    expect(typeof body.txId).toBe('string');
    expect(body.postId).toBe(TEST_POST_HASH);
  });

  it('POST /posts/:id/prune without tx field returns 400', async () => {
    const res = await request(TEST_POST_HASH, {});
    expect(res.status).toBe(400);
    const body = res.data as Record<string, unknown>;
    expect(body.error).toContain('prune transaction');
  });

  it('POST /posts/:id/prune without prune payload returns 400', async () => {
    const txBody = makeJsonPruneTxBody();
    delete txBody.prune;
    const res = await request(TEST_POST_HASH, { tx: txBody });
    expect(res.status).toBe(400);
    const body = res.data as Record<string, unknown>;
    expect(body.error).toContain('prune transaction');
  });

  it('POST /posts/:id/prune returns 400 when executePrune throws ClientError', async () => {
    const { ClientError } = await import('../../src/services/client-error.js');
    const res = await request(TEST_POST_HASH, { tx: makeJsonPruneTxBody() }, () => {
      throw new ClientError('subtreePostIds does not match committed topology');
    });
    expect(res.status).toBe(400);
    const body = res.data as Record<string, unknown>;
    expect(body.error).toBe('subtreePostIds does not match committed topology');
  });

  it('POST /posts/:id/prune returns 500 for unexpected errors', async () => {
    const res = await request(TEST_POST_HASH, { tx: makeJsonPruneTxBody() }, () => {
      throw new Error('unexpected');
    });
    expect(res.status).toBe(500);
  });

  it('hex subtreeMerkleRoot in JSON reaches executePrune as Uint8Array', async () => {
    const merkleHex = 'ab'.repeat(32);
    const txBody = makeJsonPruneTxBody();
    (txBody.prune as Record<string, unknown>).subtreeMerkleRoot = merkleHex;

    let captured: UtxoTransaction | undefined;
    await request(TEST_POST_HASH, { tx: txBody }, (_deps, tx) => {
      captured = tx;
      return { txId: 'b'.repeat(64) };
    });

    expect(captured).toBeDefined();
    expect(captured!.prune).toBeDefined();
    expect(captured!.prune!.subtreeMerkleRoot).toBeInstanceOf(Uint8Array);
    expect(captured!.prune!.subtreeMerkleRoot.length).toBe(32);
    expect(Buffer.from(captured!.prune!.subtreeMerkleRoot).toString('hex')).toBe(merkleHex);
  });
});
