import { uid } from '../helpers.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { initDb, closeDb, getDb } from '../../src/store/db.js';
import {
  getOrderingBlock,
  getOrderingBlockHash,
  getCurrentHeight,
  createOrderingBlock,
} from '../../src/store/ordering.js';
import { createRouter, KARMA_SUPPLY_TYPES } from '../../src/routes/blocks.js';
import { PROTOCOL_VERSION } from '@dagsocial/types';
import type { OrderingBlock } from '@dagsocial/types';
import { unlinkSync } from 'fs';

const TEST_DB = '/tmp/dagsocial-test-routes-blocks.sqlite';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBlock(height: number, _hash: string): OrderingBlock {
  const baseHash = height === 1 ? '0'.repeat(64) : `block-${height - 1}`;
  return {
    header: {
      protocolVersion: PROTOCOL_VERSION,
      height,
      prevBlockHash: baseHash,
      // 32 bytes, so 64 hex characters — `'00'` repeated 32 times, not 64.
      // ⚠ Nothing in THIS file rejects a double-width field: the block goes
      // straight through `createOrderingBlock` into the store, bypassing the
      // apply gate that checks the header domain. The only signal is the route
      // answering `hash: null` for a header it cannot encode.
      utxoTxRoot: '00'.repeat(32),
      stateRoot: '00'.repeat(33),
      validatorId: uid('validator-1'),
      powNonce: 0,
      powTargetBits: 256 * 12,
      createdAt: Date.now(),
    },
    utxoTxTree: {
      // Every body carries a settlement as its last entry, and this one carries
      // nothing else (NODE_INTERFACE → It is the LAST entry in `utxoTxIds`).
      utxoTxIds: ['5e'.repeat(32)],
      utxoTxs: [new Uint8Array(96).fill(0x5e)],
      pruneEntries: [],
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
      getOrderingBlockHash,
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
      // `.safeIntegers()` and the bigint row type, matching what `createApp`
      // wires in `server.ts` exactly. Drop that one call and the mock sums
      // karma as a JS number while `BlocksDeps` declares bigint — and the route
      // renders it with `.toString()`, so a sum past 2^53 prints a different
      // number here than the node would. A mock that diverges arithmetically
      // from the interface it stands for is testing its own arithmetic.
      getTotalKarma: () => {
        const row = db
          .prepare(
            `SELECT COALESCE(SUM(value), 0) AS s FROM utxo_boxes
              WHERE box_type IN (${KARMA_SUPPLY_TYPES.map(() => '?').join(', ')})
                AND spent_at_block IS NULL`,
          )
          .safeIntegers()
          .get(...KARMA_SUPPLY_TYPES) as { s: bigint };
        return row.s;
      },
      getLiquidKarma: () => {
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
      inviteProbationBlocks: 43200,
      vouchCooldownBlocks: 60,
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

    // ⚠ **There is no poison half to build.** `postIds` is not a stored field:
    // the route derives it from the block's post-bearing transactions, so a
    // block has nowhere to hold a second opinion about which posts it created.
    // What this file owns is the route's JSON shape, and that its contents come
    // from the committed transaction list.
    //
    // Carried by the height-1 block rather than a second one on purpose — a
    // block at height 2 would move the tip `/blocks/current` asserts on.
    createOrderingBlock(makeBlock(1, 'a'.repeat(64)));
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

  it('GET /blocks/:height serves postIds derived from the committed transactions', async () => {
    const res = await request('/blocks/1');
    expect(res.status).toBe(200);
    const tree = (res.data as Record<string, unknown>).utxoTxTree as Record<
      string,
      unknown
    >;

    // ⛔ Derived, never stored. A block that creates no posts reports an empty
    // list rather than a missing field, and there is no second opinion it could
    // hold — the ids come from `postsOf`, which reads the committed
    // transactions and derives each id from the transaction that carries it.
    expect(tree.postIds).toEqual([]);
    expect(Array.isArray(tree.utxoTxIds)).toBe(true);
    // The retired body section is not served under any name.
    expect((res.data as Record<string, unknown>).subBlockTree).toBeUndefined();
  });

  it('GET /blocks/:height with invalid height returns 400', async () => {
    const res = await request('/blocks/not-a-number');
    expect(res.status).toBe(400);
  });

  it('GET /blocks/:height with a value above safe integer returns 400', async () => {
    const res = await request('/blocks/10000000000000000000');
    expect(res.status).toBe(400);
  });

  it('GET /blocks/:height with a negative height returns 400', async () => {
    const res = await request('/blocks/-1');
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
    expect(typeof body.liquidKarma).toBe('string');
    expect(typeof body.totalCredits).toBe('string');
    expect(body.networkType).toBe('testnet');
    // A number, not a decimal string — the two above are bigint server-side and
    // this one is not (NODE_INTERFACE → Status).
    expect(body.inviteProbationBlocks).toBe(43200);
    expect(typeof body.inviteProbationBlocks).toBe('number');
    // ⛔ Served for the same reason: the escrow floor a client must reproduce is
    // per-network (NODE_INTERFACE → Vouch transition rules). A plain number too.
    expect(body.vouchCooldownBlocks).toBe(60);
    expect(typeof body.vouchCooldownBlocks).toBe('number');
  });

  // -------------------------------------------------------------------------
  // `totalKarma` is karma in existence and `liquidKarma` is karma its owner can
  // spend now (NODE_INTERFACE → Status). One box per member of the
  // supply set, so a type added to `KARMA_SUPPLY_TYPES` without a fixture here
  // shows up as a sum that no longer matches rather than as silent
  // under-counting.
  //
  // ⛔ **The assertion below pins the supply set — "does this type's value count
  // as karma that exists?" — and neither the transition set nor the conservation
  // one** (NODE_INTERFACE → "Three karma sets, and none derives from another").
  // A type the karma arm admits as an output but the supply sum leaves out
  // belongs in one list only, and this test stays green when it is added.
  // -------------------------------------------------------------------------

  it('GET /status counts escrowed karma in totalKarma and only spendable karma in liquidKarma', async () => {
    const db = getDb();
    const insert = db.prepare(
      `INSERT INTO utxo_boxes
         (id, box_type, value, created_at_block, spent_at_block, owner, tx_id, output_index)
       VALUES (?, ?, ?, 1, ?, NULL, ?, 0)`,
    );
    // ⛔ **One row per member of the supply set, and the assertion below pins
    // that they ARE the set.** A karma-bearing type added to the set and not
    // here would make `totalKarma` short by that box and leave this green
    // without the pin.
    const seeded: Array<[string, bigint]> = [
      ['karma', 7n],
      ['bond', 13n],
      ['post_lock', 5n],
      ['vouch', 1n],
      // The two this unit made reachable: a marker or carry box holds karma
      // between a like and its payout, an escrow holds an unvouched stake
      // (TYPES_INTERFACE → LikeAccrualBox / VouchEscrowBox).
      ['like_accrual', 3n],
      ['vouch_escrow', 2n],
    ];
    for (const [boxType, value] of seeded) {
      insert.run(`box-${boxType}`, boxType, value, null, `tx-${boxType}`);
    }
    // The other ledger, and a spent box: neither sum may reach either.
    insert.run('box-credit', 'credit', 100n, null, 'tx-credit');
    insert.run('box-spent-karma', 'karma', 1000n, 2, 'tx-spent-karma');

    const res = await request('/status');
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;

    const expectedTotal = seeded.reduce((sum, [, value]) => sum + value, 0n);
    expect(seeded.map(([boxType]) => boxType)).toEqual([...KARMA_SUPPLY_TYPES]);
    expect(body.totalKarma).toBe(expectedTotal.toString());
    expect(body.liquidKarma).toBe('7');
    expect(body.totalCredits).toBe('100');
  });
});
