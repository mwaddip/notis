import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import {
  MAX_BLOCK_BODY_BYTES,
  PROTOCOL_VERSION,
  VOUCH_KARMA_AMOUNT,
  POST_PRICE_THREAD,
  POST_PRICE_REPLY,
  REPLY_AUTHOR_SHARE,
  LIKE_KARMA_COST,
  computeTxId,
  computePostId,
} from '@dagsocial/types';
import { materializeOutput } from '@dagsocial/consensus';
import type {
  OrderingBlock,
  UtxoTransaction,
  CreditBox,
  KarmaBox,
  VouchBox,
  AnyBox,
  UsernameBox,
  PostCommit,
} from '@dagsocial/types';
import type { Config } from '../../src/config.js';
import type { TestIdentity } from '../helpers.js';
import {
  makeTestConfig,
  makeTestIdentity,
  makeCreditBox,
  makeKarmaBox,
  signTransaction,
  activateProverOverStore,
  wireIntakeForTests,
  solveHeaderPow,
  txToJson,
  makePostCommit,
} from '../helpers.js';

// ---------------------------------------------------------------------------
// The producer screens a rejected body and evicts only what its screen
// refuses; the fill skips an entry whose input, like target, reply parent or
// withdrawn post the body under build does not hold (MINING_INTERFACE →
// Template and submit; MEMPOOL_INTERFACE → Block Creator Integration).
// ---------------------------------------------------------------------------

const testConfig = makeTestConfig({
  port: 3100,
  dbPath: ':memory:',
  networkType: 'testnet' as const,
  nodeRole: 'miner' as const,
  blockBodyBudgetBytes: MAX_BLOCK_BODY_BYTES,
  orderingBlockPowTargetBits: 3072,
  bootstrapPeers: [] as string[],
  listenAddrs: '/ip4/127.0.0.1/tcp/0',
  maxPeers: 50,
});

const serverConfig = makeTestConfig({
  port: 0,
  dbPath: ':memory:',
  networkType: 'testnet' as const,
  nodeRole: 'server' as const,
  blockBodyBudgetBytes: MAX_BLOCK_BODY_BYTES,
  orderingBlockPowTargetBits: 3072,
  bootstrapPeers: [] as string[],
  listenAddrs: '/ip4/127.0.0.1/tcp/0',
  maxPeers: 50,
});

async function importBlockCreator() {
  return (await import('../../src/services/block-creator.js')) as unknown as {
    startBlockCreator: (cfg: Config) => void;
    stopBlockCreator: () => void;
    createOrderingBlock: () => OrderingBlock | null;
    getCurrentTemplate: () => OrderingBlock | null;
    submitMinedBlock: (powNonce: number, submittedHeight: number) => string | null;
  };
}

async function importMempool() {
  return (await import('../../src/store/mempool.js')) as {
    insertUtxoTx: (tx: UtxoTransaction, expiresAtHeight: number) => number;
    getPendingEntries: (limit: number) => Array<{ rowid: number; entryType: string; utxoTxBytes: Uint8Array | null }>;
    removeEntry: (rowid: number) => void;
    getPendingUtxoTxBytesByTxId: (txId: string) => Uint8Array | null;
  };
}

async function importDb() {
  return (await import('../../src/store/db.js')) as unknown as {
    initDb: (path: string) => void;
    getDb: () => import('better-sqlite3').Database;
    closeDb: () => void;
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown) => void;
    consumeBox: (boxId: string, consumedAtBlock: number) => void;
    getBox: (boxId: string) => unknown;
  };
}

async function importRecords() {
  return (await import('../../src/store/identity-records.js'));
}

async function importServer() {
  return (await import('../../src/server.js'));
}

async function startApp(): Promise<{ server: http.Server; base: string }> {
  const { createApp } = await importServer();
  const app = createApp(serverConfig);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base };
}

async function postJson(
  base: string,
  path: string,
  payload: unknown,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let body: Record<string, unknown> | null;
  try { body = text ? (JSON.parse(text) as Record<string, unknown>) : null; } catch { body = null; }
  return { status: r.status, body };
}

/** The user transactions a template carries — every entry except the settlement at the end. */
function userTxIds(block: OrderingBlock): string[] {
  const ids = block.utxoTxTree.utxoTxIds;
  return ids.slice(0, ids.length - 1);
}

/** A credit transfer that spends `inputs` and emits `change` to `spender`, with optional fee. */
function creditTransferFrom(
  spender: TestIdentity,
  inputs: Array<{ id: string; value: bigint }>,
  fee: bigint,
): UtxoTransaction {
  const total = inputs.reduce((sum, b) => sum + b.value, 0n);
  const outputs: AnyBox[] = [
    { boxType: 'credit', value: total - fee, createdAtBlock: 0, owner: spender.userId } as CreditBox,
    ...(fee > 0n ? [{ boxType: 'fee', value: fee, createdAtBlock: 0 } as AnyBox] : []),
  ];
  const tx: UtxoTransaction = {
    inputs: inputs.map((b) => b.id),
    outputs,
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, spender.privateKey, Buffer.from(spender.userId).toString('hex'));
  return tx;
}

/** A karma transaction claiming `name` for `owner`, consuming `input`. */
function claimName(
  owner: TestIdentity,
  input: KarmaBox,
  name: string,
): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [input.id!],
    outputs: [
      { boxType: 'karma', value: input.value, createdAtBlock: 0, owner: owner.userId } as KarmaBox,
      { boxType: 'username', value: 0n, createdAtBlock: 0, owner: owner.userId, name: new TextEncoder().encode(name) } as UsernameBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, owner.privateKey, Buffer.from(owner.userId).toString('hex'));
  return tx;
}

/** A vouch cast transaction (`block-creator-rejected-body.test.ts`'s `makeVouchCastTx` shape). */
function vouchCastTx(karmaIn: KarmaBox, voucher: TestIdentity, targetId: Uint8Array): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [karmaIn.id!],
    outputs: [
      { boxType: 'karma', value: karmaIn.value - VOUCH_KARMA_AMOUNT, createdAtBlock: 0, owner: voucher.userId } as KarmaBox,
      { boxType: 'vouch', value: VOUCH_KARMA_AMOUNT, createdAtBlock: 0, voucherId: voucher.userId, targetId } as VouchBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, voucher.privateKey, Buffer.from(voucher.userId).toString('hex'));
  return tx;
}

/** A thread-post transaction (one karma_price output, one karma change). */
function threadPostTx(author: TestIdentity, karmaIn: KarmaBox, content: string): { tx: UtxoTransaction; postId: string; commit: PostCommit } {
  const commit: PostCommit = makePostCommit(author.userId, content);
  const tx: UtxoTransaction = {
    inputs: [karmaIn.id!],
    outputs: [
      { boxType: 'karma', value: karmaIn.value - POST_PRICE_THREAD, createdAtBlock: 0, owner: author.userId } as KarmaBox,
      { boxType: 'karma_price', value: POST_PRICE_THREAD, createdAtBlock: 0 } as AnyBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    post: commit,
  };
  signTransaction(tx, author.privateKey, Buffer.from(author.userId).toString('hex'));
  const postId = computePostId(computeTxId(tx), 0);
  return { tx, postId, commit };
}

/** A reply-post transaction naming one parent post. */
function replyPostTx(
  author: TestIdentity,
  parentAuthor: Uint8Array,
  karmaIn: KarmaBox,
  parentPostId: string,
  content: string,
): { tx: UtxoTransaction; postId: string } {
  const commit: PostCommit = {
    ...makePostCommit(author.userId, content, { parentRefs: [parentPostId] }),
  };
  const tx: UtxoTransaction = {
    inputs: [karmaIn.id!],
    outputs: [
      { boxType: 'karma', value: karmaIn.value - (POST_PRICE_REPLY - REPLY_AUTHOR_SHARE) - REPLY_AUTHOR_SHARE, createdAtBlock: 0, owner: author.userId } as KarmaBox,
      { boxType: 'karma_price', value: POST_PRICE_REPLY - REPLY_AUTHOR_SHARE, createdAtBlock: 0 } as AnyBox,
      { boxType: 'like_accrual', value: REPLY_AUTHOR_SHARE, createdAtBlock: 0, author: parentAuthor } as AnyBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    post: commit,
  };
  signTransaction(tx, author.privateKey, Buffer.from(author.userId).toString('hex'));
  return { tx, postId: computePostId(computeTxId(tx), 0) };
}

/** A like of `targetPostId` by `liker`, consuming `karma`. */
function likeOf(liker: TestIdentity, karma: KarmaBox, targetPostId: string, author: Uint8Array): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [karma.id!],
    outputs: [
      { boxType: 'karma', value: karma.value - LIKE_KARMA_COST, createdAtBlock: 0, owner: liker.userId } as KarmaBox,
      { boxType: 'like_accrual', value: LIKE_KARMA_COST, createdAtBlock: 0, author } as AnyBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    likeTarget: targetPostId,
  };
  signTransaction(tx, liker.privateKey, Buffer.from(liker.userId).toString('hex'));
  return tx;
}

/** A karma transaction withdrawing one post, as a reorg would re-insert it. */
function withdrawOf(author: TestIdentity, karmaIn: KarmaBox, postId: string): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [karmaIn.id!],
    outputs: [
      { boxType: 'karma', value: karmaIn.value, createdAtBlock: 0, owner: author.userId } as KarmaBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    postWithdraw: { postId },
  };
  signTransaction(tx, author.privateKey, Buffer.from(author.userId).toString('hex'));
  return tx;
}

/** The identity record a member needs at the fill's membership checks. */
function memberRecord() {
  return {
    lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 0,
    lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0,
    memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
  };
}

describe('block creator vs a screened body', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch {
      // nothing to stop
    }
    vi.doUnmock('../../src/services/block-apply.js');
    vi.resetModules();
  });

  it('a credit child ahead of its parent stays pooled; the template carries the five honest and the parent, and the next template carries the child', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();

    const honestIds: TestIdentity[] = [];
    const honestTxs: UtxoTransaction[] = [];
    for (let i = 0; i < 5; i++) {
      const u = makeTestIdentity();
      const box = makeCreditBox(100_000n, u.userId, 0, 100 + i);
      utxo.insertBox(box);
      honestIds.push(u);
      honestTxs.push(creditTransferFrom(u, [{ id: box.id!, value: 100_000n }], 2_000n));
    }

    const spender = makeTestIdentity();
    const spenderBox = makeCreditBox(100_000n, spender.userId, 0, 7);
    utxo.insertBox(spenderBox);

    const parent = creditTransferFrom(spender, [{ id: spenderBox.id!, value: 100_000n }], 0n);
    const parentTxId = computeTxId(parent);
    const parentChange = materializeOutput(parent.outputs[0] as AnyBox, parentTxId, 0);
    const child = creditTransferFrom(spender, [{ id: parentChange.id!, value: 100_000n }], 50_000n);
    const childTxId = computeTxId(child);

    await activateProverOverStore();

    const { server, base } = await startApp();

    for (const t of honestTxs) {
      const r = await postJson(base, '/credits/transfer', { tx: txToJson(t) });
      expect(r.status, `honest submit (${r.status}): ${JSON.stringify(r.body)}`).toBe(200);
    }
    const pr = await postJson(base, '/credits/transfer', { tx: txToJson(parent) });
    expect(pr.status, `parent submit: ${JSON.stringify(pr.body)}`).toBe(200);
    const cr = await postJson(base, '/credits/transfer', { tx: txToJson(child) });
    expect(cr.status, `child submit: ${JSON.stringify(cr.body)}`).toBe(200);
    server.close();

    const mempool = await importMempool();
    expect(mempool.getPendingEntries(100)).toHaveLength(7);

    const warns: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')); });
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    warnSpy.mockRestore();

    const tpl = bc.getCurrentTemplate();
    expect(tpl).not.toBeNull();
    const ids = userTxIds(tpl!);
    expect(ids).toContain(parentTxId);
    expect(ids).not.toContain(childTxId);
    expect(ids).toHaveLength(6);
    expect(warns.filter((w) => w.includes('body-rejected'))).toHaveLength(0);

    await wireIntakeForTests();
    const nonce = solveHeaderPow(tpl!.header);
    expect(bc.submitMinedBlock(nonce, tpl!.header.height)).not.toBeNull();

    const next = bc.getCurrentTemplate();
    expect(next).not.toBeNull();
    expect(userTxIds(next!)).toContain(childTxId);
  });

  it('a pair of claims whose second spends the first\'s karma change leaves the honest transfer and the first claim in the template, and evicts the second claim\'s row alone', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();
    const records = await importRecords();

    const spender = makeTestIdentity();
    records.putIdentityRecord(spender.userId, memberRecord());
    const karma = makeKarmaBox(10n, spender.userId, 0, 1);
    utxo.insertBox(karma);

    const claim1 = claimName(spender, karma, 'alice');
    const claim1TxId = computeTxId(claim1);
    const karmaAfter = materializeOutput(claim1.outputs[0] as AnyBox, claim1TxId, 0) as KarmaBox;
    const claim2 = claimName(spender, karmaAfter, 'bobby');
    const claim2TxId = computeTxId(claim2);

    const honestId = makeTestIdentity();
    const honestBox = makeCreditBox(100_000_000n, honestId.userId, 0, 3);
    utxo.insertBox(honestBox);
    const honest = creditTransferFrom(honestId, [{ id: honestBox.id!, value: 100_000_000n }], 1_000_000n);
    const honestTxId = computeTxId(honest);

    await activateProverOverStore();

    const mempool = await importMempool();
    const claim1Row = mempool.insertUtxoTx(claim1, 1000);
    const claim2Row = mempool.insertUtxoTx(claim2, 1000);
    const honestRow = mempool.insertUtxoTx(honest, 1000);
    expect(mempool.getPendingEntries(10)).toHaveLength(3);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    const tpl = bc.getCurrentTemplate();
    expect(tpl).not.toBeNull();
    const ids = userTxIds(tpl!);
    expect(ids).toContain(honestTxId);
    expect(ids).toContain(claim1TxId);
    expect(ids).not.toContain(claim2TxId);

    const rowids = mempool.getPendingEntries(10).map((e) => e.rowid);
    expect(rowids).not.toContain(claim2Row);
    expect(rowids).toContain(claim1Row);
    expect(rowids).toContain(honestRow);
  });

  it('a stale vouch cast beside two honest transfers leaves the two in the template and evicts the cast\'s row alone', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();
    const records = await importRecords();

    const voucher = makeTestIdentity();
    const target = makeTestIdentity();
    records.putIdentityRecord(voucher.userId, { ...memberRecord(), memberSinceBlock: 1, invitedAtBlock: 0 });
    records.putIdentityRecord(target.userId, { ...memberRecord(), memberSinceBlock: 0, invitedAtBlock: 1 });
    const spent = makeKarmaBox(6n, voucher.userId, 0, 0);
    const other = makeKarmaBox(6n, voucher.userId, 0, 1, true);
    utxo.insertBox(spent);
    utxo.insertBox(other);

    const cast = vouchCastTx(spent, voucher, target.userId);
    const castTxId = computeTxId(cast);

    const h1 = makeTestIdentity();
    const h2 = makeTestIdentity();
    const b1 = makeCreditBox(10n ** 7n, h1.userId, 0, 20);
    const b2 = makeCreditBox(10n ** 7n, h2.userId, 0, 21);
    utxo.insertBox(b1);
    utxo.insertBox(b2);
    const t1 = creditTransferFrom(h1, [{ id: b1.id!, value: 10n ** 7n }], 1_000n);
    const t2 = creditTransferFrom(h2, [{ id: b2.id!, value: 10n ** 7n }], 1_000n);
    const t1Id = computeTxId(t1);
    const t2Id = computeTxId(t2);

    const mempool = await importMempool();
    const castRow = mempool.insertUtxoTx(cast, 1000);
    const r1 = mempool.insertUtxoTx(t1, 1000);
    const r2 = mempool.insertUtxoTx(t2, 1000);

    // The voucher's other box leaves the confirmed set before the tree is
    // built, so the cast turns invalid against the tree the fill reads
    // (`seedStaleVouchCast`, block-creator-rejected-body.test.ts).
    utxo.consumeBox(other.id!, 0);

    await activateProverOverStore();

    expect(mempool.getPendingEntries(10)).toHaveLength(3);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    const tpl = bc.getCurrentTemplate();
    expect(tpl).not.toBeNull();
    const ids = userTxIds(tpl!);
    expect(ids).toContain(t1Id);
    expect(ids).toContain(t2Id);
    expect(ids).not.toContain(castTxId);

    const rowids = mempool.getPendingEntries(10).map((e) => e.rowid);
    expect(rowids).toContain(r1);
    expect(rowids).toContain(r2);
    expect(rowids).not.toContain(castRow);
  });

  it('a refusal no pooled transaction accounts for evicts every row the body carried, logs INTERNAL on console.error, and the rebuild holds a template', async () => {
    let callCount = 0;
    vi.doMock('../../src/services/block-apply.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/services/block-apply.js')>();
      return {
        ...actual,
        computePostBlockStateRoot: (
          ...args: Parameters<typeof actual.computePostBlockStateRoot>
        ) => {
          callCount++;
          if (callCount === 1) return { kind: 'body-rejected' as const };
          return actual.computePostBlockStateRoot(...args);
        },
      };
    });

    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();

    const h1 = makeTestIdentity();
    const h2 = makeTestIdentity();
    const b1 = makeCreditBox(10n ** 7n, h1.userId, 0, 30);
    const b2 = makeCreditBox(10n ** 7n, h2.userId, 0, 31);
    utxo.insertBox(b1);
    utxo.insertBox(b2);
    const t1 = creditTransferFrom(h1, [{ id: b1.id!, value: 10n ** 7n }], 1_000n);
    const t2 = creditTransferFrom(h2, [{ id: b2.id!, value: 10n ** 7n }], 1_000n);

    await activateProverOverStore();

    const mempool = await importMempool();
    mempool.insertUtxoTx(t1, 1000);
    mempool.insertUtxoTx(t2, 1000);
    expect(mempool.getPendingEntries(10)).toHaveLength(2);

    const errors: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    errSpy.mockRestore();

    expect(bc.getCurrentTemplate()).not.toBeNull();
    expect(mempool.getPendingEntries(10)).toHaveLength(0);
    const internals = errors.filter((e) => e.includes('INTERNAL'));
    expect(internals).toHaveLength(1);
    expect(internals[0]).toContain('body-rejected');
  });

  it('a refusal no pooled transaction accounts for takes the carried rows\' pooled dependents with them', async () => {
    let callCount = 0;
    let firstBodyIds: string[] = [];
    vi.doMock('../../src/services/block-apply.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/services/block-apply.js')>();
      return {
        ...actual,
        computePostBlockStateRoot: (
          ...args: Parameters<typeof actual.computePostBlockStateRoot>
        ) => {
          callCount++;
          if (callCount === 1) {
            firstBodyIds = userTxIds(args[0] as OrderingBlock);
            return { kind: 'body-rejected' as const };
          }
          return actual.computePostBlockStateRoot(...args);
        },
      };
    });

    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();

    const h1 = makeTestIdentity();
    const b1 = makeCreditBox(10n ** 7n, h1.userId, 0, 30);
    utxo.insertBox(b1);
    const t1 = creditTransferFrom(h1, [{ id: b1.id!, value: 10n ** 7n }], 1_000n);
    const t1Id = computeTxId(t1);
    const t1Change = materializeOutput(t1.outputs[0] as AnyBox, t1Id, 0);
    const d = creditTransferFrom(h1, [{ id: t1Change.id!, value: 10n ** 7n - 1_000n }], 50_000n);
    const dId = computeTxId(d);

    await activateProverOverStore();

    const { server, base } = await startApp();
    const r1 = await postJson(base, '/credits/transfer', { tx: txToJson(t1) });
    expect(r1.status, `t1 submit: ${JSON.stringify(r1.body)}`).toBe(200);
    const rd = await postJson(base, '/credits/transfer', { tx: txToJson(d) });
    expect(rd.status, `dependent submit: ${JSON.stringify(rd.body)}`).toBe(200);
    server.close();

    const mempool = await importMempool();
    expect(mempool.getPendingEntries(10)).toHaveLength(2);
    expect(mempool.getPendingUtxoTxBytesByTxId(dId)).not.toBeNull();

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    errSpy.mockRestore();

    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(firstBodyIds).toContain(t1Id);
    expect(firstBodyIds).not.toContain(dId);
    expect(bc.getCurrentTemplate()).not.toBeNull();
    expect(mempool.getPendingUtxoTxBytesByTxId(dId)).toBeNull();
  });

  it('a reply ahead of its parent stays pooled; the template carries the parent and not the reply', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();
    const records = await importRecords();

    const author = makeTestIdentity();
    records.putIdentityRecord(author.userId, memberRecord());
    const authorKarma = makeKarmaBox(POST_PRICE_THREAD + 100n, author.userId, 0, 40);
    utxo.insertBox(authorKarma);

    const { tx: parentTx, postId: parentPostId } = threadPostTx(author, authorKarma, 'parent content');
    const parentTxId = computeTxId(parentTx);
    const parentChange = materializeOutput(parentTx.outputs[0] as AnyBox, parentTxId, 0) as KarmaBox;

    const replier = makeTestIdentity();
    records.putIdentityRecord(replier.userId, memberRecord());
    const replierKarma = makeKarmaBox(POST_PRICE_REPLY + 100n, replier.userId, 0, 41);
    utxo.insertBox(replierKarma);
    const { tx: replyTx } = replyPostTx(replier, author.userId, replierKarma, parentPostId, 'reply content');
    const replyTxId = computeTxId(replyTx);

    await activateProverOverStore();

    const mempool = await importMempool();
    const replyRow = mempool.insertUtxoTx(replyTx, 1000);
    const parentRow = mempool.insertUtxoTx(parentTx, 1000);
    expect(mempool.getPendingEntries(10)).toHaveLength(2);

    const warns: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')); });
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    warnSpy.mockRestore();

    const tpl = bc.getCurrentTemplate();
    expect(tpl).not.toBeNull();
    const ids = userTxIds(tpl!);
    expect(ids).toContain(parentTxId);
    expect(ids).not.toContain(replyTxId);

    const rowids = mempool.getPendingEntries(10).map((e) => e.rowid);
    expect(rowids).toContain(replyRow);
    void parentRow;
    void parentChange;
    expect(warns.filter((w) => w.includes('body-rejected'))).toHaveLength(0);
  });

  it('a like and a withdrawal whose posts are unconfirmed stay pooled; the template holds neither and no body-rejected warning fires', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();
    const records = await importRecords();

    const author = makeTestIdentity();
    records.putIdentityRecord(author.userId, memberRecord());
    const authorKarma = makeKarmaBox(100n, author.userId, 0, 50);
    utxo.insertBox(authorKarma);

    // One unconfirmed post id to point the like at; another to point the
    // withdrawal at. Neither has a block_topology row (unconfirmed).
    const likedPostId = computePostId('aa'.repeat(32), 0);
    const withdrawnPostId = computePostId('bb'.repeat(32), 0);

    const liker = makeTestIdentity();
    records.putIdentityRecord(liker.userId, memberRecord());
    const likerKarma = makeKarmaBox(LIKE_KARMA_COST + 10n, liker.userId, 0, 51);
    utxo.insertBox(likerKarma);
    const like = likeOf(liker, likerKarma, likedPostId, author.userId);
    const likeTxId = computeTxId(like);

    const withdrawer = makeTestIdentity();
    records.putIdentityRecord(withdrawer.userId, memberRecord());
    const withdrawerKarma = makeKarmaBox(10n, withdrawer.userId, 0, 52);
    utxo.insertBox(withdrawerKarma);
    const wd = withdrawOf(withdrawer, withdrawerKarma, withdrawnPostId);
    const wdTxId = computeTxId(wd);

    await activateProverOverStore();

    const mempool = await importMempool();
    const likeRow = mempool.insertUtxoTx(like, 1000);
    const wdRow = mempool.insertUtxoTx(wd, 1000);
    expect(mempool.getPendingEntries(10)).toHaveLength(2);

    const warns: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')); });
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    warnSpy.mockRestore();

    const tpl = bc.getCurrentTemplate();
    expect(tpl).not.toBeNull();
    const ids = userTxIds(tpl!);
    expect(ids).not.toContain(likeTxId);
    expect(ids).not.toContain(wdTxId);

    const rowids = mempool.getPendingEntries(10).map((e) => e.rowid);
    expect(rowids).toContain(likeRow);
    expect(rowids).toContain(wdRow);
    expect(warns.filter((w) => w.includes('body-rejected'))).toHaveLength(0);
  });

  it('a reply to a post selected earlier in the fill lands beside its parent in the template, through the selected set', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();
    const records = await importRecords();

    const author = makeTestIdentity();
    records.putIdentityRecord(author.userId, memberRecord());
    const authorKarma = makeKarmaBox(POST_PRICE_THREAD + 100n, author.userId, 0, 60);
    utxo.insertBox(authorKarma);
    const { tx: parentTx, postId: parentPostId } = threadPostTx(author, authorKarma, 'parent in-fill');
    const parentTxId = computeTxId(parentTx);

    const replier = makeTestIdentity();
    records.putIdentityRecord(replier.userId, memberRecord());
    const replierKarma = makeKarmaBox(POST_PRICE_REPLY + 100n, replier.userId, 0, 61);
    utxo.insertBox(replierKarma);
    const { tx: replyTx } = replyPostTx(replier, author.userId, replierKarma, parentPostId, 'reply in-fill');
    const replyTxId = computeTxId(replyTx);

    await activateProverOverStore();

    const mempool = await importMempool();
    // Post FIRST (rowid order), reply after — the karma class draws in FIFO,
    // so the fill meets the parent before the reply (MEMPOOL_INTERFACE →
    // Ordering).
    mempool.insertUtxoTx(parentTx, 1000);
    mempool.insertUtxoTx(replyTx, 1000);
    expect(mempool.getPendingEntries(10)).toHaveLength(2);

    const warns: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')); });
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    warnSpy.mockRestore();

    const tpl = bc.getCurrentTemplate();
    expect(tpl).not.toBeNull();
    const ids = userTxIds(tpl!);
    expect(ids).toContain(parentTxId);
    expect(ids).toContain(replyTxId);
    expect(warns.filter((w) => w.includes('body-rejected'))).toHaveLength(0);
  });

  it('a refill meeting a credit child ahead of its parent still skips the child, which stays pooled', async () => {
    // The first speculation comes in under the selection's estimates
    // (MINING_INTERFACE → Template and submit → "An estimate misses both
    // ways"), so the creator refills; the fill clears the dependency sets
    // beside the selection, so a child whose parent is only pooled is
    // skipped on the refill as it was on the first fill.
    let callCount = 0;
    vi.doMock('../../src/services/block-apply.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/services/block-apply.js')>();
      return {
        ...actual,
        computePostBlockStateRoot: (
          ...args: Parameters<typeof actual.computePostBlockStateRoot>
        ) => {
          callCount++;
          const real = actual.computePostBlockStateRoot(...args);
          if (callCount === 1 && real.kind === 'computed') return { ...real, cost: 1 };
          return real;
        },
      };
    });

    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();

    const spender = makeTestIdentity();
    const spenderBox = makeCreditBox(100_000n, spender.userId, 0, 90);
    utxo.insertBox(spenderBox);

    const parent = creditTransferFrom(spender, [{ id: spenderBox.id!, value: 100_000n }], 0n);
    const parentTxId = computeTxId(parent);
    const parentChange = materializeOutput(parent.outputs[0] as AnyBox, parentTxId, 0);
    const child = creditTransferFrom(spender, [{ id: parentChange.id!, value: 100_000n }], 50_000n);
    const childTxId = computeTxId(child);

    await activateProverOverStore();

    const mempool = await importMempool();
    const parentRow = mempool.insertUtxoTx(parent, 1000);
    const childRow = mempool.insertUtxoTx(child, 1000);
    expect(mempool.getPendingEntries(100)).toHaveLength(2);

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);

    const tpl = bc.getCurrentTemplate();
    expect(tpl).not.toBeNull();
    const ids = userTxIds(tpl!);
    expect(ids).toContain(parentTxId);
    expect(ids).not.toContain(childTxId);

    const rowids = mempool.getPendingEntries(100).map((e) => e.rowid);
    expect(rowids).toContain(childRow);
    void parentRow;
  });
});
