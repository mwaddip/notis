import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { BatchAVLVerifier } from '@ergots/avltree';
import {
  TREE_KEY_LENGTH,
  bytesToHex,
  creditOfKey,
  hexToBytes,
} from '@dagsocial/types';
import { holdingsPage, treeStateView, verifierSession } from '@dagsocial/consensus';
import type { CreditBox } from '@dagsocial/types';

/**
 * The range route and the single-key route share one implementation on the
 * ring (NODE_INTERFACE → "A proof at an older height restores a kept root"):
 * every lookup `atHeight` restores a kept root on the shared prover, performs
 * the lookups, generates the proof, and restores the live root. **No proof
 * path calls `rollback`** — and that is pinned by a spy counting zero across
 * every case this file holds and every case of the single-key route's
 * (`avl-endpoint.test.ts`).
 *
 * The holdings page's answer is replayed through
 * `treeStateView(verifierSession(BatchAVLVerifier(root, proof, cfg)))` and
 * must equal the node's answer: the one definition of a page's lookups is
 * `holdingsPage` (CONSENSUS_INTERFACE → The holdings page).
 */

async function freshStore() {
  const db = await import('../../src/store/db.js');
  db.initDb(':memory:');
  db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
  return db;
}

const TREE_CFG = { keyLength: TREE_KEY_LENGTH, valueLengthOpt: null };

type AnyAppHandle = Awaited<ReturnType<typeof setup>>;

async function setup() {
  const db = await freshStore();
  const { activateProverOverStore, makeTestIdentity, makeCreditBox, makeKarmaBox } = await import('../helpers.js');
  const { createApp } = await import('../../src/server.js');
  const { makeTestConfig } = await import('../helpers.js');

  const owner = makeTestIdentity();
  const empty = makeTestIdentity();
  // One credit box, one karma box: a non-empty set and a different range.
  const credit = makeCreditBox(1_000_000n, owner.userId, 0, 1);
  const karma = makeKarmaBox(100n, owner.userId, 0, 2);

  const { insertBox } = await import('../../src/store/utxo.js');
  insertBox(credit);
  insertBox(karma);

  const handle = await activateProverOverStore();
  const app = createApp(makeTestConfig({ nodeRole: 'server' }));
  return {
    app,
    db,
    handle,
    owner,
    empty,
    credit,
    karma,
    makeCreditBox,
  };
}

describe('GET /api/v1/range/:kind/:owner — the range route', () => {
  let ctx: AnyAppHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rollbackSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let proverRollbackSpy: any;

  beforeEach(async () => {
    vi.resetModules();
    ctx = await setup();
    rollbackSpy = vi.spyOn(ctx.handle.storage, 'rollback');
    proverRollbackSpy = vi.spyOn(ctx.handle.prover, 'rollback');
  });
  afterEach(() => {
    expect(rollbackSpy, 'storage.rollback must not be called by the proof routes').not.toHaveBeenCalled();
    expect(proverRollbackSpy, 'prover.rollback must not be called by the proof routes').not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  // -------------------------------------------------------------------------
  // Walk and replay
  // -------------------------------------------------------------------------

  it('a page\'s proof replayed through holdingsPage answers the owner\'s boxes', async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/range/credit/${bytesToHex(ctx.owner.userId)}`)
      .expect(200);

    expect(res.body.kind).toBe('credit');
    expect(res.body.owner).toBe(bytesToHex(ctx.owner.userId));
    expect(res.body.limit).toBe(256);
    expect(res.body.from).toBeNull();
    expect(res.body.stateRoot).toBeTruthy();

    const proof = Uint8Array.from(Buffer.from(res.body.proof as string, 'base64'));
    const rootBytes = hexToBytes(res.body.stateRoot as string);

    const verifier = new BatchAVLVerifier(rootBytes, proof, TREE_CFG);
    expect(verifier.digest(), 'the proof anchors at the answered root').not.toBeNull();

    const view = treeStateView(verifierSession(verifier));
    const replayed = holdingsPage(view, 'credit', ctx.owner.userId, null, 256);

    expect(replayed.boxes.length).toBe(1);
    expect((replayed.boxes[0] as CreditBox).value).toBe(ctx.credit.value);
    expect(replayed.boxes[0]!.boxType).toBe('credit');
    expect(replayed.next).toBeNull();
    expect(res.body.next).toBeNull();
  });

  it('serves two heights with different owner box sets and replays each', async () => {
    // Height 0 holds credit = 1_000_000. Apply a block that spends it and
    // outputs 999_990 — the ring then answers each height with each root.
    const { makeApplicableBlock, mineNextBlock } = await import('../helpers.js');
    const { applyOrderingBlock } = await import('../../src/services/block-apply.js');
    const bc = await import('../../src/services/block-creator.js');
    const { makeTestConfig } = await import('../helpers.js');
    bc.startBlockCreator(makeTestConfig({ nodeRole: 'miner' }));

    // Height 1: a credit send that spends the owner's box
    const sendTx = await (async () => {
      const { makeCreditTx } = await import('../helpers.js');
      return makeCreditTx(ctx.owner, [ctx.credit], 10n, ctx.empty.userId);
    })();
    const mempool = await import('../../src/store/mempool.js');
    mempool.insertUtxoTx(sendTx, 1_000);
    const block1 = await mineNextBlock(bc);
    expect(block1).not.toBeNull();
    expect(block1!.header.height).toBe(1);

    // At height 0: owner has 1_000_000 credit box.
    const atZero = await request(ctx.app)
      .get(`/api/v1/range/credit/${bytesToHex(ctx.owner.userId)}?atHeight=0`)
      .expect(200);
    const verifier0 = new BatchAVLVerifier(hexToBytes(atZero.body.stateRoot as string), Uint8Array.from(Buffer.from(atZero.body.proof, 'base64')), TREE_CFG);
    const view0 = treeStateView(verifierSession(verifier0));
    const page0 = holdingsPage(view0, 'credit', ctx.owner.userId, null, 256);
    expect(page0.boxes.length).toBe(1);
    expect((page0.boxes[0] as CreditBox).value).toBe(1_000_000n);

    // At height 1: owner holds nothing — the send spent its only credit box.
    const atOne = await request(ctx.app)
      .get(`/api/v1/range/credit/${bytesToHex(ctx.owner.userId)}?atHeight=1`)
      .expect(200);
    const verifier1 = new BatchAVLVerifier(hexToBytes(atOne.body.stateRoot as string), Uint8Array.from(Buffer.from(atOne.body.proof, 'base64')), TREE_CFG);
    const view1 = treeStateView(verifierSession(verifier1));
    const page1 = holdingsPage(view1, 'credit', ctx.owner.userId, null, 256);
    expect(page1.boxes.length).toBe(0);
    expect(page1.next).toBeNull();

    bc.stopBlockCreator();
    void makeApplicableBlock, applyOrderingBlock;
  });

  it('an owner holding nothing — 200, a proof under which the page is empty, next null', async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/range/credit/${bytesToHex(ctx.empty.userId)}`)
      .expect(200);

    const verifier = new BatchAVLVerifier(hexToBytes(res.body.stateRoot as string), Uint8Array.from(Buffer.from(res.body.proof, 'base64')), TREE_CFG);
    const view = treeStateView(verifierSession(verifier));
    const page = holdingsPage(view, 'credit', ctx.empty.userId, null, 256);
    expect(page.boxes).toEqual([]);
    expect(page.next).toBeNull();
    expect(res.body.next).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Paging — 600 credit boxes, three pages of 256
  // -------------------------------------------------------------------------

  it('a 600-box owner pages through three pages at `limit` defaulted', async () => {
    // A dedicated store with 600 boxes seeded pre-genesis: the bootstrap puts
    // them in the tree, so paging reads one tree.
    vi.resetModules();
    const dbMod = await import('../../src/store/db.js');
    dbMod.initDb(':memory:');
    dbMod.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const { activateProverOverStore, makeTestIdentity, makeCreditBox, makeTestConfig } = await import('../helpers.js');
    const { insertBox } = await import('../../src/store/utxo.js');

    const big = makeTestIdentity();
    for (let i = 0; i < 600; i++) {
      insertBox(makeCreditBox(1n + BigInt(i), big.userId, 0, 100 + i));
    }
    const freshHandle = await activateProverOverStore();
    const { createApp } = await import('../../src/server.js');
    const app = createApp(makeTestConfig({ nodeRole: 'server' }));

    const freshStorageSpy = vi.spyOn(freshHandle.storage, 'rollback');
    const freshProverSpy = vi.spyOn(freshHandle.prover, 'rollback');

    let from: string | null = null;
    const seen = new Set<string>();
    let pages = 0;
    while (pages < 10) {
      const q: string = from === null
        ? `/api/v1/range/credit/${bytesToHex(big.userId)}`
        : `/api/v1/range/credit/${bytesToHex(big.userId)}?from=${from}`;
      const res = await request(app).get(q).expect(200);
      expect(res.body.limit).toBe(256);

      const verifier = new BatchAVLVerifier(hexToBytes(res.body.stateRoot as string), Uint8Array.from(Buffer.from(res.body.proof, 'base64')), TREE_CFG);
      const view = treeStateView(verifierSession(verifier));
      const page = holdingsPage(view, 'credit', big.userId, from === null ? null : hexToBytes(from), 256);
      for (const b of page.boxes) seen.add(b.id!);
      pages++;
      from = res.body.next;
      if (from === null) break;
    }

    expect(pages).toBe(3);
    expect(seen.size).toBe(600);
    expect(freshStorageSpy).not.toHaveBeenCalled();
    expect(freshProverSpy).not.toHaveBeenCalled();
    freshStorageSpy.mockRestore();
    freshProverSpy.mockRestore();
  });

  it('limit=1000 is served at 256', async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/range/credit/${bytesToHex(ctx.owner.userId)}?limit=1000`)
      .expect(200);
    expect(res.body.limit).toBe(256);
  });

  // -------------------------------------------------------------------------
  // Validation — 400 for every bad shape
  // -------------------------------------------------------------------------

  describe('400s for malformed parameters', () => {
    it('a kind outside the five', async () => {
      await request(ctx.app)
        .get(`/api/v1/range/notakind/${bytesToHex(ctx.owner.userId)}`)
        .expect(400);
    });

    it('a `kind` that is a Object.prototype property — the own-property check', async () => {
      for (const kind of ['toString', '__proto__', 'constructor']) {
        await request(ctx.app)
          .get(`/api/v1/range/${encodeURIComponent(kind)}/${bytesToHex(ctx.owner.userId)}`)
          .expect(400);
      }
    });

    it('an owner of 63 hex', async () => {
      await request(ctx.app).get('/api/v1/range/credit/' + '00'.repeat(31) + 'ff').expect(200); // 64 hex ok
      await request(ctx.app).get('/api/v1/range/credit/' + '00'.repeat(31) + 'f').expect(400); // 63 hex
    });

    it('an owner with a non-hex character', async () => {
      await request(ctx.app).get('/api/v1/range/credit/' + 'g'.repeat(64)).expect(400);
    });

    it('`from` of 128 hex', async () => {
      await request(ctx.app)
        .get(`/api/v1/range/credit/${bytesToHex(ctx.owner.userId)}?from=${'00'.repeat(64)}`)
        .expect(400);
    });

    it('`from` of non-hex', async () => {
      await request(ctx.app)
        .get(`/api/v1/range/credit/${bytesToHex(ctx.owner.userId)}?from=${'g'.repeat(130)}`)
        .expect(400);
    });

    it('`from` of 130 hex outside the range (pageRange refuses)', async () => {
      // 130 hex that is not inside the credit range for the owner — a karma
      // key of the same owner, say.
      const karmaKey = bytesToHex(hexToBytes('00'.repeat(65))); // all zeros is below every real range
      // Build a key that is 130 hex but outside the credit range: use a
      // different tag byte.
      const outside = '00' + bytesToHex(ctx.owner.userId).padEnd(128, '0');
      void karmaKey;
      await request(ctx.app)
        .get(`/api/v1/range/credit/${bytesToHex(ctx.owner.userId)}?from=${outside}`)
        .expect(400);
    });

    it('`limit` of 0, -1, 1.5, abc, empty string', async () => {
      for (const bad of ['0', '-1', '1.5', 'abc', '']) {
        await request(ctx.app)
          .get(`/api/v1/range/credit/${bytesToHex(ctx.owner.userId)}?limit=${encodeURIComponent(bad)}`)
          .expect(400);
      }
    });

    it('`atHeight` that is not a non-negative integer', async () => {
      for (const bad of ['-1', '1.5', 'abc', '']) {
        await request(ctx.app)
          .get(`/api/v1/range/credit/${bytesToHex(ctx.owner.userId)}?atHeight=${encodeURIComponent(bad)}`)
          .expect(400);
      }
    });
  });

  it('404 for a height outside the ring', async () => {
    await request(ctx.app)
      .get(`/api/v1/range/credit/${bytesToHex(ctx.owner.userId)}?atHeight=999`)
      .expect(404);
  });

  it('a page served `from` an in-range key answers the slice from that key', async () => {
    // One page from the credit range's start → one entry → next null.
    const base = `/api/v1/range/credit/${bytesToHex(ctx.owner.userId)}`;
    const first = await request(ctx.app).get(base).expect(200);
    expect(first.body.next).toBeNull();
    // A `from` at the credit key itself — a leaf, yielded; next null.
    const key = bytesToHex(creditOfKey(ctx.owner.userId, hexToBytes(ctx.credit.id!)));
    const second = await request(ctx.app).get(`${base}?from=${key}`).expect(200);
    expect(second.body.from).toBe(key);
    expect(second.body.next).toBeNull();
  });
});
