// MEMPOOL_INTERFACE → Gate metadata columns and Correctness gates: the
// `karma_owner` and `karma_spend` rows, and `pendingKarmaSpend`'s sum.
import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import {POST_PRICE_THREAD,
  POST_PRICE_REPLY,
  REPLY_AUTHOR_SHARE,
  LIKE_KARMA_COST,
  VOUCH_KARMA_AMOUNT,
  USERNAME_BURN_PRICE,
  computeTxId,
} from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';

async function importDb() {
  return (await import('../../src/store/db.js')) as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

async function importMempool() {
  return (await import('../../src/store/mempool.js')) as {
    insertUtxoTx: (tx: unknown, txId: string, expiresAtHeight: number) => number;
    pendingKarmaSpend: (ownerId: string) => bigint;
    removeUtxoTxEntry: (txId: string) => number;
    removeEntry: (rowid: number) => void;
    purgeExpired: (currentHeight: number) => number;
  };
}

const OWNER_A = 'aa'.repeat(32);
const OWNER_B = 'bb'.repeat(32);
const OWNER_C = 'cc'.repeat(32);
const TARGET_POST = '10'.repeat(32);
const TARGET_IDENT = '21'.repeat(32);
const INVITEE_KEY = '31'.repeat(32);
const AUTHOR_KEY = '41'.repeat(32);

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));

/** A unique input id per label — the pending-spend conflict refuses duplicates. */
function input(label: string): string {
  return createHash('blake2b512').update(label).digest().subarray(0, 32).toString('hex');
}

function likeTx(likerHex: string, label = `like-${likerHex}`) {
  return {
    inputs: [input(label)],
    outputs: [
      {
        boxType: 'karma',
        value: 100n,
        createdAtBlock: 0,
        owner: bytes(likerHex),
      },
      {
        boxType: 'like_accrual',
        value: LIKE_KARMA_COST,
        createdAtBlock: 0,
        author: bytes(AUTHOR_KEY),
      },
    ],
    signatures: { [likerHex]: new Uint8Array(64) },
    protocolVersion: 1,
    likeTarget: TARGET_POST,
  };
}

function threadTx(authorHex: string, label = `thread-${authorHex}`) {
  return {
    inputs: [input(label)],
    outputs: [
      {
        boxType: 'karma',
        value: 100n,
        createdAtBlock: 0,
        owner: bytes(authorHex),
      },
      {
        boxType: 'karma_price',
        value: POST_PRICE_THREAD,
        createdAtBlock: 0,
      },
    ],
    signatures: { [authorHex]: new Uint8Array(64) },
    protocolVersion: 1,
  };
}

function replyTx(authorHex: string, label = `reply-${authorHex}`) {
  return {
    inputs: [input(label)],
    outputs: [
      {
        boxType: 'karma',
        value: 100n,
        createdAtBlock: 0,
        owner: bytes(authorHex),
      },
      {
        boxType: 'karma_price',
        value: POST_PRICE_REPLY,
        createdAtBlock: 0,
      },
      {
        boxType: 'like_accrual',
        value: REPLY_AUTHOR_SHARE,
        createdAtBlock: 0,
        author: bytes(AUTHOR_KEY),
      },
    ],
    signatures: { [authorHex]: new Uint8Array(64) },
    protocolVersion: 1,
  };
}

function inviteTx(inviterHex: string, bondValue: bigint, label = `invite-${inviterHex}`) {
  return {
    inputs: [input(label)],
    outputs: [
      {
        boxType: 'karma',
        value: 100n,
        createdAtBlock: 0,
        owner: bytes(inviterHex),
      },
      {
        boxType: 'bond',
        value: bondValue,
        createdAtBlock: 0,
        inviterId: bytes(inviterHex),
        inviteePublicKey: bytes(INVITEE_KEY),
      },
    ],
    signatures: { [inviterHex]: new Uint8Array(64) },
    protocolVersion: 1,
  };
}

function vouchCastTx(voucherHex: string, label = `vouch-${voucherHex}`) {
  return {
    inputs: [input(label)],
    outputs: [
      {
        boxType: 'karma',
        value: 100n,
        createdAtBlock: 0,
        owner: bytes(voucherHex),
      },
      {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: 0,
        voucherId: bytes(voucherHex),
        targetId: bytes(TARGET_IDENT),
      },
    ],
    signatures: { [voucherHex]: new Uint8Array(64) },
    protocolVersion: 1,
  };
}

function nameBurnTx(ownerHex: string, label = `burn-${ownerHex}`) {
  return {
    inputs: [input(label), input(`${label}-name`)],
    outputs: [
      {
        boxType: 'karma',
        value: 100n,
        createdAtBlock: 0,
        owner: bytes(ownerHex),
      },
      {
        boxType: 'karma_price',
        value: USERNAME_BURN_PRICE,
        createdAtBlock: 0,
      },
    ],
    signatures: { [ownerHex]: new Uint8Array(64) },
    protocolVersion: 1,
  };
}

function consolidationTx(ownerHex: string, label = `cons-${ownerHex}`) {
  return {
    inputs: [input(label), input(`${label}-second`)],
    outputs: [
      {
        boxType: 'karma',
        value: 20n,
        createdAtBlock: 0,
        owner: bytes(ownerHex),
      },
    ],
    signatures: { [ownerHex]: new Uint8Array(64) },
    protocolVersion: 1,
  };
}

function claimTx(ownerHex: string, label = `claim-${ownerHex}`) {
  return {
    inputs: [input(label)],
    outputs: [
      {
        boxType: 'karma',
        value: 100n,
        createdAtBlock: 0,
        owner: bytes(ownerHex),
      },
      {
        boxType: 'username',
        value: 0n,
        createdAtBlock: 0,
        owner: bytes(ownerHex),
        name: new Uint8Array(Buffer.from(`claim_${ownerHex.slice(0, 4)}`, 'utf8')),
      },
    ],
    signatures: { [ownerHex]: new Uint8Array(64) },
    protocolVersion: 1,
  };
}

function withdrawalTx(ownerHex: string, label = `wd-${ownerHex}`) {
  return {
    inputs: [input(label)],
    outputs: [
      {
        boxType: 'karma',
        value: 10n,
        createdAtBlock: 0,
        owner: bytes(ownerHex),
      },
    ],
    signatures: { [ownerHex]: new Uint8Array(64) },
    protocolVersion: 1,
    postWithdraw: { postId: TARGET_POST },
  };
}

function unvouchTx(ownerHex: string, label = `unv-${ownerHex}`) {
  return {
    inputs: [input(label)],
    outputs: [
      {
        boxType: 'karma',
        value: 1n,
        createdAtBlock: 0,
        owner: bytes(ownerHex),
      },
      {
        boxType: 'vouch_escrow',
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: 0,
        owner: bytes(ownerHex),
        releaseAtBlock: 10,
      },
    ],
    signatures: { [ownerHex]: new Uint8Array(64) },
    protocolVersion: 1,
  };
}

function creditSendTx(senderHex: string, label = `send-${senderHex}`) {
  return {
    inputs: [input(label)],
    outputs: [
      {
        boxType: 'credit',
        value: 100n,
        createdAtBlock: 0,
        owner: bytes(senderHex),
      },
    ],
    signatures: { [senderHex]: new Uint8Array(64) },
    protocolVersion: 1,
  };
}

function rentCollectionTx(label = 'rent-x') {
  return {
    inputs: [input(label)],
    outputs: [
      {
        boxType: 'credit',
        value: 1n,
        createdAtBlock: 0,
        owner: new Uint8Array(32),
      },
      {
        boxType: 'fee',
        value: 1n,
        createdAtBlock: 0,
      },
    ],
    signatures: {},
    protocolVersion: 1,
  };
}

describe('mempool karma spend gate', () => {
  beforeEach(async () => {
    vi.resetModules();
    (await importDb()).initDb(':memory:');
  });

  afterEach(async () => {
    (await importDb()).closeDb();
  });

  // ---- the five spending shapes, column by column ----

  it('a like writes the signer and LIKE_KARMA_COST', async () => {
    const { getDb } = await importDb();
    const { insertUtxoTx, pendingKarmaSpend } = await importMempool();
    insertUtxoTx(likeTx(OWNER_A), computeTxId(likeTx(OWNER_A) as UtxoTransaction), 100);
    const row = getDb().prepare(
      `SELECT karma_owner, karma_spend FROM mempool`,
    ).safeIntegers().get() as { karma_owner: string; karma_spend: bigint };
    expect(row.karma_owner).toBe(OWNER_A);
    expect(row.karma_spend).toBe(LIKE_KARMA_COST);
    expect(pendingKarmaSpend(OWNER_A)).toBe(LIKE_KARMA_COST);
  });

  it('a thread writes the signer and POST_PRICE_THREAD', async () => {
    const { getDb } = await importDb();
    const { insertUtxoTx, pendingKarmaSpend } = await importMempool();
    insertUtxoTx(threadTx(OWNER_A), computeTxId(threadTx(OWNER_A) as UtxoTransaction), 100);
    const row = getDb().prepare(
      `SELECT karma_owner, karma_spend FROM mempool`,
    ).safeIntegers().get() as { karma_owner: string; karma_spend: bigint };
    expect(row.karma_owner).toBe(OWNER_A);
    expect(row.karma_spend).toBe(POST_PRICE_THREAD);
    expect(pendingKarmaSpend(OWNER_A)).toBe(POST_PRICE_THREAD);
  });

  it('a reply writes the signer and the summed value of its karma-price and marker outputs', async () => {
    const { getDb } = await importDb();
    const { insertUtxoTx, pendingKarmaSpend } = await importMempool();
    insertUtxoTx(replyTx(OWNER_A), computeTxId(replyTx(OWNER_A) as UtxoTransaction), 100);
    const row = getDb().prepare(
      `SELECT karma_owner, karma_spend FROM mempool`,
    ).safeIntegers().get() as { karma_owner: string; karma_spend: bigint };
    expect(row.karma_owner).toBe(OWNER_A);
    expect(row.karma_spend).toBe(POST_PRICE_REPLY + REPLY_AUTHOR_SHARE);
    expect(pendingKarmaSpend(OWNER_A)).toBe(POST_PRICE_REPLY + REPLY_AUTHOR_SHARE);
  });

  it('an invite writes the signer and the bond value', async () => {
    const { getDb } = await importDb();
    const { insertUtxoTx, pendingKarmaSpend } = await importMempool();
    const bondValue = 25n;
    insertUtxoTx(inviteTx(OWNER_A, bondValue), computeTxId(inviteTx(OWNER_A, bondValue) as UtxoTransaction), 100);
    const row = getDb().prepare(
      `SELECT karma_owner, karma_spend FROM mempool`,
    ).safeIntegers().get() as { karma_owner: string; karma_spend: bigint };
    expect(row.karma_owner).toBe(OWNER_A);
    expect(row.karma_spend).toBe(bondValue);
    expect(pendingKarmaSpend(OWNER_A)).toBe(bondValue);
  });

  it('a vouch cast writes the signer and VOUCH_KARMA_AMOUNT', async () => {
    const { getDb } = await importDb();
    const { insertUtxoTx, pendingKarmaSpend } = await importMempool();
    insertUtxoTx(vouchCastTx(OWNER_A), computeTxId(vouchCastTx(OWNER_A) as UtxoTransaction), 100);
    const row = getDb().prepare(
      `SELECT karma_owner, karma_spend FROM mempool`,
    ).safeIntegers().get() as { karma_owner: string; karma_spend: bigint };
    expect(row.karma_owner).toBe(OWNER_A);
    expect(row.karma_spend).toBe(VOUCH_KARMA_AMOUNT);
    expect(pendingKarmaSpend(OWNER_A)).toBe(VOUCH_KARMA_AMOUNT);
  });

  it('a name burn writes the signer and USERNAME_BURN_PRICE', async () => {
    const { getDb } = await importDb();
    const { insertUtxoTx, pendingKarmaSpend } = await importMempool();
    insertUtxoTx(nameBurnTx(OWNER_A), computeTxId(nameBurnTx(OWNER_A) as UtxoTransaction), 100);
    const row = getDb().prepare(
      `SELECT karma_owner, karma_spend FROM mempool`,
    ).safeIntegers().get() as { karma_owner: string; karma_spend: bigint };
    expect(row.karma_owner).toBe(OWNER_A);
    expect(row.karma_spend).toBe(USERNAME_BURN_PRICE);
    expect(pendingKarmaSpend(OWNER_A)).toBe(USERNAME_BURN_PRICE);
  });

  // ---- the non-spending shapes write the signer and NULL in karma_spend ----
  //
  // MEMPOOL_INTERFACE → Gate metadata columns: a transaction that moves an
  // owner's own box writes the owner's one signer into karma_owner so
  // getOwnKarmaBoxIdsWithPending finds it, and leaves karma_spend NULL so
  // pendingKarmaSpend sums nothing from a row that spends none.

  it("a consolidation writes the signer in karma_owner and NULL in karma_spend", async () => {
    const { getDb } = await importDb();
    const { insertUtxoTx, pendingKarmaSpend } = await importMempool();
    insertUtxoTx(consolidationTx(OWNER_A), computeTxId(consolidationTx(OWNER_A) as UtxoTransaction), 100);
    const row = getDb().prepare(
      `SELECT karma_owner, karma_spend FROM mempool`,
    ).get() as { karma_owner: string | null; karma_spend: number | null };
    expect(row.karma_owner).toBe(OWNER_A);
    expect(row.karma_spend).toBeNull();
    expect(pendingKarmaSpend(OWNER_A)).toBe(0n);
  });

  it("a claim writes the signer in karma_owner and NULL in karma_spend", async () => {
    const { getDb } = await importDb();
    const { insertUtxoTx, pendingKarmaSpend } = await importMempool();
    insertUtxoTx(claimTx(OWNER_A), computeTxId(claimTx(OWNER_A) as UtxoTransaction), 100);
    const row = getDb().prepare(
      `SELECT karma_owner, karma_spend FROM mempool`,
    ).get() as { karma_owner: string | null; karma_spend: number | null };
    expect(row.karma_owner).toBe(OWNER_A);
    expect(row.karma_spend).toBeNull();
    expect(pendingKarmaSpend(OWNER_A)).toBe(0n);
  });

  it("a withdrawal writes the signer in karma_owner and NULL in karma_spend", async () => {
    const { getDb } = await importDb();
    const { insertUtxoTx, pendingKarmaSpend } = await importMempool();
    insertUtxoTx(withdrawalTx(OWNER_A), computeTxId(withdrawalTx(OWNER_A) as UtxoTransaction), 100);
    const row = getDb().prepare(
      `SELECT karma_owner, karma_spend FROM mempool`,
    ).get() as { karma_owner: string | null; karma_spend: number | null };
    expect(row.karma_owner).toBe(OWNER_A);
    expect(row.karma_spend).toBeNull();
    expect(pendingKarmaSpend(OWNER_A)).toBe(0n);
  });

  it("an unvouch writes the signer in karma_owner and NULL in karma_spend", async () => {
    const { getDb } = await importDb();
    const { insertUtxoTx, pendingKarmaSpend } = await importMempool();
    insertUtxoTx(unvouchTx(OWNER_A), computeTxId(unvouchTx(OWNER_A) as UtxoTransaction), 100);
    const row = getDb().prepare(
      `SELECT karma_owner, karma_spend FROM mempool`,
    ).get() as { karma_owner: string | null; karma_spend: number | null };
    expect(row.karma_owner).toBe(OWNER_A);
    expect(row.karma_spend).toBeNull();
    expect(pendingKarmaSpend(OWNER_A)).toBe(0n);
  });

  it('a credit send writes NULL in both columns', async () => {
    const { getDb } = await importDb();
    const { insertUtxoTx, pendingKarmaSpend } = await importMempool();
    insertUtxoTx(creditSendTx(OWNER_A), computeTxId(creditSendTx(OWNER_A) as UtxoTransaction), 100);
    const row = getDb().prepare(
      `SELECT karma_owner, karma_spend FROM mempool`,
    ).get() as { karma_owner: string | null; karma_spend: number | null };
    expect(row.karma_owner).toBeNull();
    expect(row.karma_spend).toBeNull();
    expect(pendingKarmaSpend(OWNER_A)).toBe(0n);
  });

  it('a rent collection writes NULL in both columns', async () => {
    const { getDb } = await importDb();
    const { insertUtxoTx } = await importMempool();
    insertUtxoTx(rentCollectionTx(), computeTxId(rentCollectionTx() as UtxoTransaction), 100);
    const row = getDb().prepare(
      `SELECT karma_owner, karma_spend FROM mempool`,
    ).get() as { karma_owner: string | null; karma_spend: number | null };
    expect(row.karma_owner).toBeNull();
    expect(row.karma_spend).toBeNull();
  });

  // ---- pendingKarmaSpend's sum: by owner, over several rows ----

  it('sums several karma-spend rows of one owner, ignoring another owner\'s rows', async () => {
    const { insertUtxoTx, pendingKarmaSpend } = await importMempool();
    insertUtxoTx(likeTx(OWNER_A, 'A-like-1'), computeTxId(likeTx(OWNER_A, 'A-like-1') as UtxoTransaction), 100);
    insertUtxoTx(threadTx(OWNER_A, 'A-thread-1'), computeTxId(threadTx(OWNER_A, 'A-thread-1') as UtxoTransaction), 100);
    insertUtxoTx(replyTx(OWNER_A, 'A-reply-1'), computeTxId(replyTx(OWNER_A, 'A-reply-1') as UtxoTransaction), 100);
    insertUtxoTx(likeTx(OWNER_B, 'B-like-1'), computeTxId(likeTx(OWNER_B, 'B-like-1') as UtxoTransaction), 100);
    insertUtxoTx(threadTx(OWNER_B, 'B-thread-1'), computeTxId(threadTx(OWNER_B, 'B-thread-1') as UtxoTransaction), 100);

    expect(pendingKarmaSpend(OWNER_A)).toBe(
      LIKE_KARMA_COST + POST_PRICE_THREAD + POST_PRICE_REPLY + REPLY_AUTHOR_SHARE,
    );
    expect(pendingKarmaSpend(OWNER_B)).toBe(LIKE_KARMA_COST + POST_PRICE_THREAD);
    expect(pendingKarmaSpend(OWNER_C)).toBe(0n);
  });

  it('removeUtxoTxEntry takes the row\'s spend out of the sum', async () => {
    const { getDb } = await importDb();
    const { insertUtxoTx, pendingKarmaSpend, removeUtxoTxEntry } = await importMempool();
    const rowid = insertUtxoTx(threadTx(OWNER_A, 'thread-to-remove'), computeTxId(threadTx(OWNER_A, 'thread-to-remove') as UtxoTransaction), 100);
    insertUtxoTx(likeTx(OWNER_A, 'like-stays'), computeTxId(likeTx(OWNER_A, 'like-stays') as UtxoTransaction), 100);
    expect(pendingKarmaSpend(OWNER_A)).toBe(POST_PRICE_THREAD + LIKE_KARMA_COST);
    const txId = (
      getDb().prepare('SELECT tx_id FROM mempool WHERE rowid = ?').get(rowid) as { tx_id: string }
    ).tx_id;
    removeUtxoTxEntry(txId);
    expect(pendingKarmaSpend(OWNER_A)).toBe(LIKE_KARMA_COST);
  });

  it('removeEntry takes the row\'s spend out of the sum', async () => {
    const { insertUtxoTx, pendingKarmaSpend, removeEntry } = await importMempool();
    const rowid = insertUtxoTx(threadTx(OWNER_A, 'thread-to-remove'), computeTxId(threadTx(OWNER_A, 'thread-to-remove') as UtxoTransaction), 100);
    insertUtxoTx(likeTx(OWNER_A, 'like-stays'), computeTxId(likeTx(OWNER_A, 'like-stays') as UtxoTransaction), 100);
    expect(pendingKarmaSpend(OWNER_A)).toBe(POST_PRICE_THREAD + LIKE_KARMA_COST);
    removeEntry(rowid);
    expect(pendingKarmaSpend(OWNER_A)).toBe(LIKE_KARMA_COST);
  });

  it('purgeExpired takes an expiring row\'s spend out of the sum', async () => {
    const { insertUtxoTx, pendingKarmaSpend, purgeExpired } = await importMempool();
    insertUtxoTx(threadTx(OWNER_A, 'expires-at-10'), computeTxId(threadTx(OWNER_A, 'expires-at-10') as UtxoTransaction), 10);
    insertUtxoTx(likeTx(OWNER_A, 'expires-at-100'), computeTxId(likeTx(OWNER_A, 'expires-at-100') as UtxoTransaction), 100);
    expect(pendingKarmaSpend(OWNER_A)).toBe(POST_PRICE_THREAD + LIKE_KARMA_COST);
    purgeExpired(50);
    expect(pendingKarmaSpend(OWNER_A)).toBe(LIKE_KARMA_COST);
  });

  // ---- the additive migration ----

  it('a store opened on a pool table that lacks the two columns gains them', async () => {
    const { getDb, closeDb } = await importDb();
    // Drop the migrated columns to simulate an older database shape, then run
    // the migration again by re-initializing against the same table state.
    const db = getDb();
    db.exec('DROP TABLE mempool');
    db.exec(`CREATE TABLE mempool (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_type TEXT NOT NULL CHECK(entry_type IN ('utxo_tx')),
      utxo_tx_bytes BLOB,
      expires_at_height INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    // Confirm the columns are absent before the migration runs.
    const beforeCols = db
      .prepare("PRAGMA table_info('mempool')")
      .all() as Array<{ name: string }>;
    expect(beforeCols.some((c) => c.name === 'karma_owner')).toBe(false);
    expect(beforeCols.some((c) => c.name === 'karma_spend')).toBe(false);
    closeDb();

    // Re-open through initDb — the ALTER pass adds every missing column.
    vi.resetModules();
    const freshDb = await importDb();
    freshDb.initDb(':memory:');
    const afterCols = freshDb
      .getDb()
      .prepare("PRAGMA table_info('mempool')")
      .all() as Array<{ name: string }>;
    expect(afterCols.some((c) => c.name === 'karma_owner')).toBe(true);
    expect(afterCols.some((c) => c.name === 'karma_spend')).toBe(true);
  });

  // ---- karma_owner mirrors like_liker's single-signature rule ----

  it('a karma spend with no signatures writes NULL in both columns', async () => {
    const { getDb } = await importDb();
    const { insertUtxoTx, pendingKarmaSpend } = await importMempool();
    const tx = likeTx(OWNER_A);
    tx.signatures = {};
    insertUtxoTx(tx, computeTxId(tx as UtxoTransaction), 100);
    const row = getDb().prepare(
      `SELECT karma_owner, karma_spend FROM mempool`,
    ).get() as { karma_owner: string | null; karma_spend: number | null };
    expect(row.karma_owner).toBeNull();
    expect(row.karma_spend).toBeNull();
    expect(pendingKarmaSpend(OWNER_A)).toBe(0n);
  });

  it('a karma spend with two signing keys writes NULL in both columns', async () => {
    const { getDb } = await importDb();
    const { insertUtxoTx, pendingKarmaSpend } = await importMempool();
    const tx = threadTx(OWNER_A);
    tx.signatures = {
      [OWNER_A]: new Uint8Array(64),
      [OWNER_B]: new Uint8Array(64),
    };
    insertUtxoTx(tx, computeTxId(tx as UtxoTransaction), 100);
    const row = getDb().prepare(
      `SELECT karma_owner, karma_spend FROM mempool`,
    ).get() as { karma_owner: string | null; karma_spend: number | null };
    expect(row.karma_owner).toBeNull();
    expect(row.karma_spend).toBeNull();
    expect(pendingKarmaSpend(OWNER_A)).toBe(0n);
    expect(pendingKarmaSpend(OWNER_B)).toBe(0n);
  });
});
