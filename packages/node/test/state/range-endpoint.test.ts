import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import type { AvlNode } from '@ergots/avltree';
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
  return { app, db, handle, owner, empty, credit, karma };
}

describe('GET /api/v1/range/:kind/:owner — the range route', () => {
  let ctx: AnyAppHandle;
  // `storage.rollback` returns [AvlNode, number]; `prover.rollback` returns void.
  let rollbackSpy: MockInstance<[version: Uint8Array], [AvlNode, number]>;
  let proverRollbackSpy: MockInstance<[version: Uint8Array], void>;

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

  it('the answer carries the contract\'s seven fields exactly', async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/range/credit/${bytesToHex(ctx.owner.userId)}`)
      .expect(200);

    // NODE_INTERFACE → AVL+ State Root, the range bullet: `{ kind, owner,
    // atHeight, stateRoot, from, limit, proof }` — no decoded value, no
    // `next` (the page's next is read from the proof).
    expect(Object.keys(res.body).sort()).toEqual(
      ['atHeight', 'from', 'kind', 'limit', 'owner', 'proof', 'stateRoot'],
    );
    expect(res.body.kind).toBe('credit');
    expect(res.body.owner).toBe(bytesToHex(ctx.owner.userId));
    expect(res.body.limit).toBe(256);
    expect(res.body.from).toBeNull();
    expect(res.body.stateRoot).toBeTruthy();
    expect(res.body.proof).toBeTruthy();
  });

  it('a page\'s proof replayed through holdingsPage answers the owner\'s boxes', async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/range/credit/${bytesToHex(ctx.owner.userId)}`)
      .expect(200);

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
  });

  it('three heights with the owner\'s box set different at each — the proof replays to each set', async () => {
    // Build a second credit box pre-genesis so the owner has two, then spend
    // each in one block. The three heights hold three different sets.
    const dbMod = await import('../../src/store/db.js');
    dbMod.initDb(':memory:');
    dbMod.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const { makeTestIdentity, makeCreditBox, makeCreditTx, activateProverOverStore, makeTestConfig, mineNextBlock } = await import('../helpers.js');
    const { insertBox } = await import('../../src/store/utxo.js');
    const owner = makeTestIdentity();
    const other = makeTestIdentity();
    const box1 = makeCreditBox(1_000_000n, owner.userId, 0, 1);
    const box2 = makeCreditBox(500_000n, owner.userId, 0, 2);
    insertBox(box1);
    insertBox(box2);
    const handle = await activateProverOverStore();

    // Spies: no proof route should call rollback across the whole test.
    const storageSpy = vi.spyOn(handle.storage, 'rollback');
    const proverSpy = vi.spyOn(handle.prover, 'rollback');

    const bc = await import('../../src/services/block-creator.js');
    bc.startBlockCreator(makeTestConfig({ nodeRole: 'miner' }));

    const mempool = await import('../../src/store/mempool.js');
    mempool.insertUtxoTx(makeCreditTx(owner, [box1], 10n, other.userId), 1_000);
    const block1 = await mineNextBlock(bc);
    expect(block1!.header.height).toBe(1);

    mempool.insertUtxoTx(makeCreditTx(owner, [box2], 10n, other.userId), 1_000);
    const block2 = await mineNextBlock(bc);
    expect(block2!.header.height).toBe(2);

    const { createApp } = await import('../../src/server.js');
    const app = createApp(makeTestConfig({ nodeRole: 'server' }));
    const ownerHex = bytesToHex(owner.userId);

    async function pageAt(h: number) {
      const res = await request(app).get(`/api/v1/range/credit/${ownerHex}?atHeight=${h}`).expect(200);
      // The answer carries no `next`; the page's next is read from the proof.
      expect(res.body).not.toHaveProperty('next');
      const verifier = new BatchAVLVerifier(hexToBytes(res.body.stateRoot as string), Uint8Array.from(Buffer.from(res.body.proof, 'base64')), TREE_CFG);
      const view = treeStateView(verifierSession(verifier));
      return holdingsPage(view, 'credit', owner.userId, null, 256);
    }

    // Height 0: {box1, box2}
    const page0 = await pageAt(0);
    expect(page0.boxes.length).toBe(2);
    expect(new Set(page0.boxes.map((b) => (b as CreditBox).value))).toEqual(new Set([1_000_000n, 500_000n]));

    // Height 1: {box2}
    const page1 = await pageAt(1);
    expect(page1.boxes.length).toBe(1);
    expect((page1.boxes[0] as CreditBox).value).toBe(500_000n);

    // Height 2: {}
    const page2 = await pageAt(2);
    expect(page2.boxes.length).toBe(0);
    expect(page2.next).toBeNull();

    bc.stopBlockCreator();
    expect(storageSpy).not.toHaveBeenCalled();
    expect(proverSpy).not.toHaveBeenCalled();
    storageSpy.mockRestore();
    proverSpy.mockRestore();
  });

  it('an owner holding nothing — 200, a proof under which the page is empty, the proof says `next` is null', async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/range/credit/${bytesToHex(ctx.empty.userId)}`)
      .expect(200);

    const verifier = new BatchAVLVerifier(hexToBytes(res.body.stateRoot as string), Uint8Array.from(Buffer.from(res.body.proof, 'base64')), TREE_CFG);
    const view = treeStateView(verifierSession(verifier));
    const page = holdingsPage(view, 'credit', ctx.empty.userId, null, 256);
    expect(page.boxes).toEqual([]);
    expect(page.next).toBeNull();
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

    // The answer carries no `next`; the client follows `holdingsPage(…).next`
    // read from the proof.
    let fromBytes: Uint8Array | null = null;
    const seen = new Set<string>();
    let pages = 0;
    while (pages < 10) {
      const q: string = fromBytes === null
        ? `/api/v1/range/credit/${bytesToHex(big.userId)}`
        : `/api/v1/range/credit/${bytesToHex(big.userId)}?from=${bytesToHex(fromBytes)}`;
      const res = await request(app).get(q).expect(200);
      expect(res.body.limit).toBe(256);
      expect(res.body).not.toHaveProperty('next');

      const verifier = new BatchAVLVerifier(hexToBytes(res.body.stateRoot as string), Uint8Array.from(Buffer.from(res.body.proof, 'base64')), TREE_CFG);
      const view = treeStateView(verifierSession(verifier));
      const page = holdingsPage(view, 'credit', big.userId, fromBytes, 256);
      for (const b of page.boxes) seen.add(b.id!);
      pages++;
      if (page.next === null) break;
      fromBytes = page.next;
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

  it('a limit of digits past 2^53 is served at 256', async () => {
    // NODE_INTERFACE → avl-endpoint, the range route — "`limit` is an integer
    // from 1, served at `RANGE_PAGE_MAX` where it is above it or absent".
    const res = await request(ctx.app)
      .get(`/api/v1/range/credit/${bytesToHex(ctx.owner.userId)}?limit=99999999999999999999`)
      .expect(200);
    expect(res.body.limit).toBe(256);
  });

  it('an atHeight of digits past 2^53 is a 404 — no kept height carries that number', async () => {
    // NODE_INTERFACE → avl-endpoint, the range route — "a height the node
    // keeps no root of" is 404; the length of the digits is not the refusal.
    const res = await request(ctx.app)
      .get(`/api/v1/range/credit/${bytesToHex(ctx.owner.userId)}?atHeight=99999999999999999999`)
      .expect(404);
    expect(res.body).toEqual({ error: 'height not available' });
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
      // 130 hex that is not inside the credit range for the owner — a leading
      // tag byte for another kind, with the owner's id trailing.
      const outside = '00' + bytesToHex(ctx.owner.userId).padEnd(128, '0');
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
    const base = `/api/v1/range/credit/${bytesToHex(ctx.owner.userId)}`;
    const first = await request(ctx.app).get(base).expect(200);
    expect(first.body).not.toHaveProperty('next');
    // A `from` at the credit key itself — a leaf, yielded; the proof's next
    // is null because the range ends there.
    const key = bytesToHex(creditOfKey(ctx.owner.userId, hexToBytes(ctx.credit.id!)));
    const second = await request(ctx.app).get(`${base}?from=${key}`).expect(200);
    expect(second.body.from).toBe(key);
    const verifier = new BatchAVLVerifier(hexToBytes(second.body.stateRoot as string), Uint8Array.from(Buffer.from(second.body.proof, 'base64')), TREE_CFG);
    const page = holdingsPage(treeStateView(verifierSession(verifier)), 'credit', ctx.owner.userId, hexToBytes(key), 256);
    expect(page.boxes.length).toBe(1);
    expect(page.boxes[0]!.id).toBe(ctx.credit.id);
    expect((page.boxes[0] as CreditBox).value).toBe(ctx.credit.value);
    expect(page.boxes[0]!.boxType).toBe('credit');
    expect(page.next).toBeNull();
  });
});
