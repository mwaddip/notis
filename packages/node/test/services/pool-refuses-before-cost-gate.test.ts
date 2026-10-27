// MEMPOOL_INTERFACE → assertPoolAdmits: the pool's own refusals answer
// before the cost gate. Observed through a spy on consensus's `applyBlock`,
// which cost-estimate's candidate costs run — see MEMPOOL_INTERFACE → "The
// cost gate".
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { applyBlock } from '@dagsocial/consensus';
import {LIKE_KARMA_COST,
  MAX_BLOCK_BODY_BYTES,
  PROTOCOL_VERSION,
  computeContentHash,
  profileFor,
  computeTxId,
} from '@dagsocial/types';
import type {
  AnyBox,
  KarmaBox,
  UtxoTransaction,
} from '@dagsocial/types';
import { initDb, getDb, closeDb } from '../../src/store/db.js';
import { insertBox } from '../../src/store/utxo.js';
import { insertPost } from '../../src/store/posts.js';
import {
  getPendingEntries,
  setMempoolCap,
  DEFAULT_MAX_MEMPOOL_ENTRIES,
  MempoolFullError,
} from '../../src/store/mempool.js';
import { admitTx } from '../../src/services/admit-tx.js';
import { emptyBlockCost } from '../../src/services/cost-estimate.js';
import { handleRelayedTx } from '../../src/services/handle-tx.js';
import { createApp } from '../../src/server.js';
import {
  fixturePostId,
  fixtureTxId,
  liveProver,
  makeCreditBox,
  makeCreditTx,
  makeTestConfig,
  makeTestIdentity,
  seedProvenance,
  signTransaction,
  txToJson,
} from '../helpers.js';

// Wrap `applyBlock` in a spy so cost-estimate's candidate cost calls are
// counted at the module boundary. The rest of consensus is unchanged.
vi.mock('@dagsocial/consensus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dagsocial/consensus')>();
  return {
    ...actual,
    applyBlock: vi.fn(actual.applyBlock),
  };
});

const AUTHOR = new Uint8Array(32).fill(0x7a);

function post(server: http.Server, path: string, body: unknown): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body));
    const addr = server.address() as AddressInfo;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(d) });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: d });
          }
        });
      },
    );
    req.write(payload);
    req.end();
  });
}

describe('the pool\'s own refusals answer before the cost gate', () => {
  let server: http.Server;

  beforeAll(async () => {
    initDb(':memory:');
    getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    await liveProver();
    // Prime `emptyBlockCost`'s per-tip cache (MEMPOOL_INTERFACE → The cost
    // gate), so each case's first admit spends one applyBlock call on its
    // own candidate rather than two — the empty's and the arrival's.
    emptyBlockCost('warmup');
    const app = createApp(makeTestConfig({
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
    }));
    server = app.listen(0);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    setMempoolCap(DEFAULT_MAX_MEMPOOL_ENTRIES);
    server.close();
    closeDb();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    // Each case starts with an empty pool and the default cap, so the one that
    // sets a smaller cap is not pre-loaded by its predecessors.
    getDb().prepare('DELETE FROM mempool').run();
    getDb().prepare('DELETE FROM mempool_inputs').run();
    getDb().prepare('DELETE FROM mempool_outputs').run();
    setMempoolCap(DEFAULT_MAX_MEMPOOL_ENTRIES);
    vi.mocked(applyBlock).mockClear();
  });

  it('POST /credits/transfer: a full credit class refuses an arrival bidding nothing, before any applyBlock call for its cost', async () => {
    setMempoolCap(2); // credit class cap = 1
    const residentSender = makeTestIdentity();
    const arrivalSender = makeTestIdentity();
    const residentBox = makeCreditBox(100_000n, residentSender.userId, 0, 1001);
    const arrivalBox = makeCreditBox(100_000n, arrivalSender.userId, 0, 1002);
    insertBox(residentBox);
    insertBox(arrivalBox);

    // Resident paying a non-zero fee pools fine. The admission that pools it
    // runs the cost gate once (MEMPOOL_INTERFACE → The cost gate), which the
    // spy counts: the control that the arrival's zero-count below is a path
    // read, not a spy that stopped intercepting.
    const resident = makeCreditTx(residentSender, [residentBox], 5_000n);
    const r1 = await post(server, '/credits/transfer', { tx: txToJson(resident) });
    expect(r1.status, JSON.stringify(r1.data)).toBe(200);
    expect(getPendingEntries(10)).toHaveLength(1);
    expect(vi.mocked(applyBlock).mock.calls.length).toBe(1);

    vi.mocked(applyBlock).mockClear();

    // The arrival bids nothing: no FeeBox output (makeCreditTx with fee=0
    // emits none), so `bidOf` is 0 and the full credit class — one slot,
    // held by the resident paying 5_000 — refuses it.
    const noFeeArrival = makeCreditTx(arrivalSender, [arrivalBox], 0n);
    const r2 = await post(server, '/credits/transfer', { tx: txToJson(noFeeArrival) });
    expect(r2.status).toBe(503);
    expect(r2.data).toEqual({ error: 'mempool full' });

    expect(vi.mocked(applyBlock).mock.calls.length).toBe(0);
  });

  it('handleRelayedTx: a relayed arrival whose input a pooled entry spends answers false before any applyBlock call for its cost', async () => {
    const sender = makeTestIdentity();
    const box = makeCreditBox(100_000n, sender.userId, 0, 2001);
    insertBox(box);

    // Pool one transaction spending `box` directly. The admission that
    // pools it runs the cost gate once (MEMPOOL_INTERFACE → The cost gate),
    // which the spy counts: the control that the arrival's zero-count below
    // is a path read, not a spy that stopped intercepting.
    const first = makeCreditTx(sender, [box], 5_000n);
    admitTx(first, computeTxId(first), 1000);
    expect(getPendingEntries(10)).toHaveLength(1);
    expect(vi.mocked(applyBlock).mock.calls.length).toBe(1);

    // The relay validates against the confirmed set (`getBox`), which still
    // holds `box`, so the pool's own conflict gate is what answers.
    const colliding = makeCreditTx(sender, [box], 4_000n);
    expect(colliding.inputs[0]).toBe(first.inputs[0]);

    vi.mocked(applyBlock).mockClear();

    const returned = handleRelayedTx(colliding, undefined, 'peer-x');
    expect(returned).toBe(false);
    expect(getPendingEntries(10)).toHaveLength(1);

    expect(vi.mocked(applyBlock).mock.calls.length).toBe(0);
  });

  it('admitTx: a full karma class refuses the arriving like before any applyBlock call for its cost', async () => {
    // Two likers, each with a karma box, targeting two distinct posts: the
    // same `(liker, target)` pair would be refused by the correctness gate
    // ahead of the pool's class check.
    const likerA = makeTestIdentity();
    const likerB = makeTestIdentity();
    const karmaA = seedProvenance<KarmaBox>({
      boxType: 'karma', value: 10_000n, createdAtBlock: 0, owner: likerA.userId,
    }, 0, 3001);
    const karmaB = seedProvenance<KarmaBox>({
      boxType: 'karma', value: 10_000n, createdAtBlock: 0, owner: likerB.userId,
    }, 0, 3002);
    insertBox(karmaA);
    insertBox(karmaB);

    const commitA = {
      contentHash: computeContentHash('karma class a'),
      author: AUTHOR,
      parentRefs: [] as string[],
      protocolVersion: PROTOCOL_VERSION,
      type: 'regular' as const,
    };
    const commitB = {
      contentHash: computeContentHash('karma class b'),
      author: AUTHOR,
      parentRefs: [] as string[],
      protocolVersion: PROTOCOL_VERSION,
      type: 'regular' as const,
    };
    const postIdA = fixturePostId(commitA);
    const postIdB = fixturePostId(commitB);
    insertPost(postIdA, fixtureTxId(commitA), commitA, 'karma class a');
    insertPost(postIdB, fixtureTxId(commitB), commitB, 'karma class b');

    setMempoolCap(2); // karma class cap = 1

    const buildLike = (liker: typeof likerA, karma: KarmaBox, postId: string): UtxoTransaction => {
      const outs: AnyBox[] = [];
      const change = karma.value - LIKE_KARMA_COST;
      if (change > 0n) {
        outs.push({ boxType: 'karma', value: change, createdAtBlock: 0, owner: liker.userId } as unknown as AnyBox);
      }
      outs.push({ boxType: 'like_accrual', value: LIKE_KARMA_COST, createdAtBlock: 0, author: AUTHOR } as unknown as AnyBox);
      const tx: UtxoTransaction = {
        inputs: [karma.id!],
        outputs: outs,
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
        likeTarget: postId,
      };
      signTransaction(tx, liker.privateKey, Buffer.from(liker.userId).toString('hex'));
      return tx;
    };

    // The admission that pools the resident like runs the cost gate once
    // (MEMPOOL_INTERFACE → The cost gate), which the spy counts: the control
    // that the arrival's zero-count below is a path read, not a spy that
    // stopped intercepting.
    const residentLike = buildLike(likerA, karmaA, postIdA);
    admitTx(residentLike, computeTxId(residentLike), 1000);
    expect(getPendingEntries(10)).toHaveLength(1);
    expect(vi.mocked(applyBlock).mock.calls.length).toBe(1);

    const arrivalLike = buildLike(likerB, karmaB, postIdB);

    vi.mocked(applyBlock).mockClear();

    let refusal: unknown;
    try {
      admitTx(arrivalLike, computeTxId(arrivalLike), 1000);
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(MempoolFullError);
    expect((refusal as { poolClass: string }).poolClass).toBe('karma');

    expect(vi.mocked(applyBlock).mock.calls.length).toBe(0);
  });
});
