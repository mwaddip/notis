import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import { computeTxId } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import { pruneWithdrawRoutes } from '../../src/routes/prune-withdraw.js';
import { setNet } from '../../src/services/net-instance.js';
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
  getPendingPostAuthor: () => null,
  runInTransaction: (fn: () => void) => fn(),
      getVouchBox: () => null,
      getNetworkRecord: () => ({ memberCount: 1 }),
      membershipBarMultiplier: 1,
      putIdentityRecord: () => {},
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
      executePostWithdraw: (_d: UtxoEngineDeps, _t: UtxoTransaction, _h: number) => ({ txId: 'c'.repeat(64) }),
      getCurrentHeight: () => 10,
    };
    const app = express();
    app.use(express.json());
    app.use(pruneWithdrawRoutes(deps));
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
  afterEach(() => {
    setNet(null as unknown as Parameters<typeof setNet>[0]);
  });

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
      throw new ClientError('Post is not confirmed in an earlier block');
    });
    expect(res.status).toBe(400);
    const body = res.data as Record<string, unknown>;
    expect(body.error).toBe('Post is not confirmed in an earlier block');
  });

  it('POST /posts/:id/prune returns 500 for unexpected errors', async () => {
    const res = await request(TEST_POST_HASH, { tx: makeJsonPruneTxBody() }, () => {
      throw new Error('unexpected');
    });
    expect(res.status).toBe(500);
  });

  it('broadcasts the pooled prune transaction to peers', async () => {
    const broadcastTx = vi.fn((_tx: UtxoTransaction) => Promise.resolve());
    setNet({ broadcastTx } as unknown as Parameters<typeof setNet>[0]);

    let captured: UtxoTransaction | undefined;
    const res = await request(TEST_POST_HASH, { tx: makeJsonPruneTxBody() }, (_deps, tx) => {
      captured = tx;
      return { txId: 'b'.repeat(64) };
    });

    expect(res.status).toBe(201);
    expect(broadcastTx).toHaveBeenCalledTimes(1);
    const sent = broadcastTx.mock.calls[0]![0] as UtxoTransaction;
    expect(computeTxId(sent)).toBe(computeTxId(captured!));
  });
});
