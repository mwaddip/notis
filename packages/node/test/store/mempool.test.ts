import { createHash } from 'crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';

// Dynamic import pattern — fresh modules per test
async function importDbFresh() {
  const mod = await import('../../src/store/db.js');
  return mod as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

async function importMempoolFresh() {
  const mod = await import('../../src/store/mempool.js');
  return mod as {
    insertUtxoTx: (tx: any, expiresAtHeight: number) => number;
    getPendingEntries: (limit: number) => any[];
    purgeExpired: (currentHeight: number) => number;
    removeEntry: (rowid: number) => void;
    hasPendingLike: (targetPostId: string, likerId: string) => boolean;
    countPendingInvites: (inviterId: string) => number;
    hasPendingVouch: (voucherId: string) => boolean;
    hasPendingSpend: (boxIds: string[]) => string | null;
    findPendingOutput: (boxId: string) => { id?: string } | null;
    getBoxWithPending: (boxId: string) => { id?: string } | null;
    PendingSpendConflictError: new (boxId: string) => Error;
    insertMempoolPrune: (entry: any, expiresAtHeight: number) => number;
    drainMempoolPrunes: (limit: number) => any[];
    removeMempoolPrunes: (entryIds: string[]) => void;
  };
}

/** Mempool store plus raw row access, for asserting the gate columns directly. */
async function importMempoolWithRow() {
  const mem = await importMempoolFresh();
  const { getDb } = await importDbFresh();
  return {
    ...mem,
    getDbRow: () =>
      (getDb() as any)
        .prepare('SELECT like_target, like_liker, invite_inviter, vouch_voucher FROM mempool')
        .get() as Record<string, string | null>,
  };
}

// ---------------------------------------------------------------------------
// Gate-metadata fixtures — hex ids as they are stored, and the minimal txs
// whose outputs the insert chokepoint lifts them from.
// ---------------------------------------------------------------------------

// Post ids, so they must be real 64-hex: `likeTarget` is `opt(b32)` in the txId
// preimage, and `'post_target_1'` has no encoding there.
const TARGET = '10'.repeat(32);
const OTHER_TARGET = '20'.repeat(32);
const LIKER_A = 'aa'.repeat(32);
const LIKER_B = 'bb'.repeat(32);
const INVITER_A = 'cc'.repeat(32);
const INVITER_B = 'dd'.repeat(32);
const VOUCHER_A = 'ee'.repeat(32);
const VOUCHER_B = 'ff'.repeat(32);
const TARGET_ID = '11'.repeat(32);

// Input box ids. `computeTxId` writes each input as `b32`, so a short label has
// no encoding — the same rule the post ids above carry, applied to inputs now
// that the pool derives its output ids at insert.
const BOX_1 = '61'.repeat(32);
const BOX_2 = '62'.repeat(32);
const BOX_3 = '63'.repeat(32);
const BOX_5 = '65'.repeat(32);
const BOX_99 = '69'.repeat(32);

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));

/**
 * A like tx: the gate columns derive from the tx-level `likeTarget` and the
 * single signing key — never from an output (NODE_INTERFACE → Per-block like
 * settlement). The karma output is shape-realism only; the store does not
 * inspect it for the like gate.
 */
function likeTx(targetPostId: string, likerHex: string) {
  return {
    inputs: [],
    outputs: [
      {
        boxType: 'karma',
        // `bigint`, as the type declares: the positional writer has no `number`
        // branch for a u64, so a plain `99` here has no encoding at all.
        value: 99n,
        owner: bytes(likerHex),
        guard: 'owner_signature',
      },
    ],
    signatures: { [likerHex]: new Uint8Array(64) },
    protocolVersion: 1,
    likeTarget: targetPostId,
  };
}

function inviteTx(inviterHex: string) {
  return {
    inputs: [],
    outputs: [
      {
        boxType: 'invite',
        value: 0n,
        inviterId: bytes(inviterHex),
        inviteePublicKey: new Uint8Array(32).fill(0x11),
        guard: 'invite_dual',
      },
    ],
    signatures: {},
    protocolVersion: 1,
  };
}

function vouchTx(voucherHex: string, targetHex: string) {
  return {
    inputs: [],
    outputs: [
      {
        boxType: 'vouch',
        value: 10n,
        voucherId: bytes(voucherHex),
        targetId: bytes(targetHex),
        guard: 'owner_signature',
      },
    ],
    signatures: {},
    protocolVersion: 1,
  };
}

// Root post hashes: `serializePruneEntry` writes `rootPostHash` as `b32`, so
// `'root_1'` has no encoding.
const ROOT_1 = '31'.repeat(32);
const ROOT_2 = '32'.repeat(32);

function pruneEntry(rootPostHash: string) {
  return {
    rootPostHash,
    trigger: 'author',
    authorId: new Uint8Array(32),
    subtreeMerkleRoot: new Uint8Array(32),
    subtreePostIds: [rootPostHash],
    // `authorSignature` is the name `PruneEntry` declares, and the `as any` on
    // this fixture is what would hide a misspelling of it. The positional writer
    // reads declared fields by name, so a typo reaches a fixed-width writer as
    // `undefined` rather than riding along as an extra map key.
    authorSignature: new Uint8Array(64),
    protocolVersion: 1,
  } as any;
}

/**
 * A distinct transaction per label — the mempool's entry-count and FIFO tests
 * need N distinct entries, and `insertUtxoTx` rejects a duplicate pending spend,
 * so each fixture must name its own input box.
 */
function txWithInput(label: string): unknown {
  const id = createHash('blake2b512').update(label).digest().subarray(0, 32).toString('hex');
  return { inputs: [id], outputs: [], signatures: {}, protocolVersion: 1 };
}

describe('mempool store', () => {
  beforeEach(async () => {
    vi.resetModules();
    const db = await importDbFresh();
    db.initDb(':memory:');
  });

  afterEach(async () => {
    const db = await importDbFresh();
    db.closeDb();
  });

  it('inserts a UTXO transaction and retrieves it', async () => {
    const { insertUtxoTx, getPendingEntries } = await importMempoolFresh();
    const tx = {
      inputs: [BOX_1],
      outputs: [],
      signatures: {},
      protocolVersion: 1,
    };

    insertUtxoTx(tx as any, 200);
    const entries = getPendingEntries(10);

    expect(entries).toHaveLength(1);
    expect(entries[0].entryType).toBe('utxo_tx');
    expect(entries[0].utxoTxCbor).toBeInstanceOf(Uint8Array);
    expect(entries[0].expiresAtHeight).toBe(200);
  });

  // ⛔ Reserved, never to be reused: the `batchId` case. A post and its karma
  // lock were two objects that had to be evicted and re-injected together, which
  // is what `batchId` grouped; a post is the payload of that one transaction now
  // (MEMPOOL_INTERFACE → PoolEntry), so there is nothing left to group.

  it('getPendingEntries respects limit', async () => {
    const { insertUtxoTx, getPendingEntries } = await importMempoolFresh();

    for (let i = 0; i < 5; i++) {
      insertUtxoTx(txWithInput(`sb_${i}`) as any, 100);
    }

    const entries = getPendingEntries(3);
    expect(entries).toHaveLength(3);
  });

  it('getPendingEntries returns entries in FIFO order by rowid', async () => {
    const { insertUtxoTx, getPendingEntries } = await importMempoolFresh();

    insertUtxoTx(txWithInput('first') as any, 100);
    insertUtxoTx(txWithInput('second') as any, 100);
    insertUtxoTx(txWithInput('third') as any, 100);

    const entries = getPendingEntries(10);
    expect(entries).toHaveLength(3);
    // rowid should be ascending
    expect(entries[0].rowid).toBeLessThan(entries[1].rowid);
    expect(entries[1].rowid).toBeLessThan(entries[2].rowid);
  });

  it('purgeExpired removes entries with expires_at_height < currentHeight', async () => {
    const { insertUtxoTx, insertMempoolPrune, getPendingEntries, purgeExpired } =
      await importMempoolFresh();

    insertUtxoTx(txWithInput('expired') as any, 10);
    insertMempoolPrune(pruneEntry(ROOT_1), 50);
    const tx = { inputs: [BOX_3], outputs: [], signatures: {}, protocolVersion: 1 };
    insertUtxoTx(tx as any, 30);

    const removed = purgeExpired(25); // removes entries with expires_at_height < 25
    expect(removed).toBe(1); // only expired at 10; the prune at 50 and tx at 30 are kept

    // Both surviving entry types, so the purge is shown to be keyed on the
    // height and not on the kind of row.
    const entries = getPendingEntries(10);
    expect(entries).toHaveLength(2);
    const entryTypes = entries.map((e) => e.entryType);
    expect(entryTypes).toContain('prune');
    expect(entryTypes).toContain('utxo_tx');
  });

  it('purgeExpired returns count of removed entries', async () => {
    const { insertUtxoTx, purgeExpired } = await importMempoolFresh();

    insertUtxoTx(txWithInput('a') as any, 10);
    insertUtxoTx(txWithInput('b') as any, 20);
    insertUtxoTx(txWithInput('c') as any, 30);

    const removed = purgeExpired(25);
    expect(removed).toBe(2); // a (10) and b (20) — both < 25
  });

  it('removeEntry removes a specific row by rowid', async () => {
    const { insertUtxoTx, getPendingEntries, removeEntry } = await importMempoolFresh();

    const rowid1 = insertUtxoTx(txWithInput('keep') as any, 100);
    const rowid2 = insertUtxoTx(txWithInput('remove') as any, 100);

    removeEntry(rowid2);

    const entries = getPendingEntries(10);
    expect(entries).toHaveLength(1);
    expect(entries[0].rowid).toBe(rowid1);
  });

  it('handles multiple entries of mixed types', async () => {
    const { insertUtxoTx, insertMempoolPrune, getPendingEntries } =
      await importMempoolFresh();
    const tx = { inputs: [BOX_5], outputs: [], signatures: {}, protocolVersion: 1 };

    insertMempoolPrune(pruneEntry(ROOT_1), 100);
    insertUtxoTx(tx as any, 100);
    insertMempoolPrune(pruneEntry(ROOT_2), 100);

    const entries = getPendingEntries(10);
    expect(entries).toHaveLength(3);

    // Insertion order, across both entry types — `getPendingEntries` is FIFO by
    // rowid and does not group by kind.
    const types = entries.map((e) => e.entryType);
    expect(types).toEqual(['prune', 'utxo_tx', 'prune']);
  });

  it('getPendingEntries returns empty array when mempool is empty', async () => {
    const { getPendingEntries } = await importMempoolFresh();
    const entries = getPendingEntries(10);
    expect(entries).toEqual([]);
  });

  it('getPendingEntries with limit 0 returns empty array', async () => {
    const { insertUtxoTx, getPendingEntries } = await importMempoolFresh();
    insertUtxoTx(txWithInput('sb_limit0') as any, 100);
    const entries = getPendingEntries(0);
    expect(entries).toEqual([]);
  });

  it('purgeExpired returns 0 when nothing to purge', async () => {
    const { insertUtxoTx, purgeExpired } = await importMempoolFresh();
    insertUtxoTx(txWithInput('sb_nopurge') as any, 100);
    const removed = purgeExpired(50); // nothing < 50
    expect(removed).toBe(0);
  });

  it('removeEntry is a no-op for a non-existent rowid', async () => {
    const { insertUtxoTx, getPendingEntries, removeEntry } = await importMempoolFresh();
    insertUtxoTx(txWithInput('sb_remove_noop') as any, 100);
    removeEntry(9999); // should not throw
    const entries = getPendingEntries(10);
    expect(entries).toHaveLength(1);
  });

  it('createdAt is set on insert', async () => {
    const { insertUtxoTx, getPendingEntries } = await importMempoolFresh();
    insertUtxoTx(txWithInput('sb_createdat') as any, 100);
    const entries = getPendingEntries(10);
    expect(entries[0].createdAt).toBeTruthy();
    expect(typeof entries[0].createdAt).toBe('string');
  });

  it('utxo_tx entry has pruneEntryCbor null and utxoTxCbor set', async () => {
    const { insertUtxoTx, getPendingEntries } = await importMempoolFresh();
    const tx = { inputs: [BOX_99], outputs: [], signatures: {}, protocolVersion: 1 };
    insertUtxoTx(tx as any, 300);
    const entries = getPendingEntries(10);
    expect(entries).toHaveLength(1);
    expect(entries[0].entryType).toBe('utxo_tx');
    // The payload columns are exclusive: a row carries the CBOR its entry type
    // names and null in the other (MEMPOOL_INTERFACE → PoolEntry).
    expect(entries[0].pruneEntryCbor).toBeNull();
    expect(entries[0].utxoTxCbor).toBeInstanceOf(Uint8Array);
  });

  // -------------------------------------------------------------------------
  // Correctness gates (MEMPOOL_INTERFACE → Correctness gates)
  // -------------------------------------------------------------------------

  describe('gate metadata and correctness gates', () => {
    it('hasPendingLike sees a like inserted past any bounded scan', async () => {
      const { insertUtxoTx, hasPendingLike, getPendingEntries } =
        await importMempoolFresh();

      // Bury the like behind the 1000-row bound the old decode-scan used.
      for (let i = 0; i < 1000; i++) insertUtxoTx(txWithInput(`filler_${i}`) as any, 100);
      const likeRowid = insertUtxoTx(likeTx(TARGET, LIKER_A) as any, 100);

      // Vacuity: the entry really is past the old scan's reach, so this test
      // fails against the fetch-1000-and-decode implementation. Keyed on the
      // like's own rowid — every row in the pool is a `utxo_tx` now, so the
      // entry type no longer separates the like from what buries it.
      const scanned = getPendingEntries(1000);
      expect(scanned).toHaveLength(1000);
      expect(scanned.some((e: any) => e.rowid === likeRowid)).toBe(false);

      expect(hasPendingLike(TARGET, LIKER_A)).toBe(true);
      // Controls — a single-field delta in each direction.
      expect(hasPendingLike(TARGET, LIKER_B)).toBe(false);
      expect(hasPendingLike(OTHER_TARGET, LIKER_A)).toBe(false);
    });

    it('countPendingInvites counts invites past any bounded scan', async () => {
      const { insertUtxoTx, countPendingInvites } =
        await importMempoolFresh();

      for (let i = 0; i < 1000; i++) insertUtxoTx(txWithInput(`filler_${i}`) as any, 100);
      insertUtxoTx(inviteTx(INVITER_A) as any, 100);
      insertUtxoTx(inviteTx(INVITER_A) as any, 100);
      insertUtxoTx(inviteTx(INVITER_B) as any, 100);

      expect(countPendingInvites(INVITER_A)).toBe(2);
      expect(countPendingInvites(INVITER_B)).toBe(1);
      expect(countPendingInvites(LIKER_A)).toBe(0);
    });

    it('hasPendingVouch is keyed on the voucher alone', async () => {
      const { insertUtxoTx, hasPendingVouch } = await importMempoolFresh();

      insertUtxoTx(vouchTx(VOUCHER_A, TARGET_ID) as any, 100);

      expect(hasPendingVouch(VOUCHER_A)).toBe(true);
      expect(hasPendingVouch(VOUCHER_B)).toBe(false);
    });

    it('leaves gate columns null for a tx with no gated outputs', async () => {
      const { insertUtxoTx, getDbRow } = await importMempoolWithRow();
      insertUtxoTx({ inputs: [], outputs: [], signatures: {}, protocolVersion: 1 } as any, 100);
      const row = getDbRow();
      expect(row.like_target).toBeNull();
      expect(row.like_liker).toBeNull();
      expect(row.invite_inviter).toBeNull();
      expect(row.vouch_voucher).toBeNull();
    });

    it('populates like_target/like_liker from the tx field and the signer (P2-D)', async () => {
      const { insertUtxoTx, getDbRow } = await importMempoolWithRow();
      insertUtxoTx(likeTx(TARGET, LIKER_A) as any, 100);
      const row = getDbRow();
      expect(row.like_target).toBe(TARGET);
      expect(row.like_liker).toBe(LIKER_A);
    });

    it('derives no liker from a multi-key signature map (no gate poisoning)', async () => {
      // A spare signature must not let an attacker pin someone else's
      // (liker, target) pair: with more than one key the row stays unpaired
      // and matches no hasPendingLike query.
      const { insertUtxoTx, getDbRow, hasPendingLike } = await importMempoolWithRow();
      const tx = likeTx(TARGET, LIKER_A);
      (tx.signatures as Record<string, Uint8Array>)[LIKER_B] = new Uint8Array(64);
      insertUtxoTx(tx as any, 100);
      const row = getDbRow();
      expect(row.like_target).toBe(TARGET);
      expect(row.like_liker).toBeNull();
      expect(hasPendingLike(TARGET, LIKER_A)).toBe(false);
      expect(hasPendingLike(TARGET, LIKER_B)).toBe(false);
    });

    it('ignores like-box outputs — the retired output-scan derivation stays dead', async () => {
      const { insertUtxoTx, getDbRow } = await importMempoolWithRow();
      insertUtxoTx({
        inputs: [],
        outputs: [{
          boxType: 'like', value: 2n, likerId: bytes(LIKER_A),
        }],
        signatures: {},
        protocolVersion: 1,
      } as any, 100);
      const row = getDbRow();
      expect(row.like_target).toBeNull();
      expect(row.like_liker).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Conflicting-spend gate
  //
  // Two pooled transactions naming one input is the state that puts a
  // transaction into a block it cannot apply in: the first spends the box, the
  // second's input is then dead. The gate is at the insert chokepoint because
  // that is the only place every admission path passes through.
  // -------------------------------------------------------------------------

  describe('conflicting spends', () => {
    const BOX_A = '41'.repeat(32);
    const BOX_B = '42'.repeat(32);

    /** A transaction whose only interesting property is which boxes it spends. */
    const spendTx = (inputs: string[]) => ({
      inputs,
      outputs: [],
      signatures: {},
      protocolVersion: 1,
    });

    it('refuses a second pending spend of the same box', async () => {
      const mem = await importMempoolFresh();

      mem.insertUtxoTx(spendTx([BOX_A]) as any, 1000);

      expect(() => mem.insertUtxoTx(spendTx([BOX_A]) as any, 1000)).toThrow(
        mem.PendingSpendConflictError,
      );
      expect(() => mem.insertUtxoTx(spendTx([BOX_A]) as any, 1000)).toThrow(
        /already spent by a pending/i,
      );
    });

    it('admits two transactions spending different boxes', async () => {
      const mem = await importMempoolFresh();

      mem.insertUtxoTx(spendTx([BOX_A]) as any, 1000);

      expect(() => mem.insertUtxoTx(spendTx([BOX_B]) as any, 1000)).not.toThrow();
      expect(mem.getPendingEntries(10)).toHaveLength(2);
    });

    it('refuses on any shared input, not only the first', async () => {
      const mem = await importMempoolFresh();

      mem.insertUtxoTx(spendTx([BOX_B]) as any, 1000);

      // BOX_A is free; the conflict is on the second input, and the error names
      // the box that actually collided rather than the first one checked.
      expect(() => mem.insertUtxoTx(spendTx([BOX_A, BOX_B]) as any, 1000)).toThrow(
        new RegExp(BOX_B),
      );
    });

    it('hasPendingSpend names the conflicting box and is null when there is none', async () => {
      const mem = await importMempoolFresh();

      mem.insertUtxoTx(spendTx([BOX_A]) as any, 1000);

      expect(mem.hasPendingSpend([BOX_A])).toBe(BOX_A);
      expect(mem.hasPendingSpend([BOX_B])).toBeNull();
      expect(mem.hasPendingSpend([])).toBeNull();
    });

    it('an entry written before the column existed blocks nothing', async () => {
      // Rows predating `migrateMempoolTxInputs` hold NULL, and `json_each` reads
      // NULL as zero rows rather than raising — so a pre-migration entry matches
      // no conflict query. Asserted rather than assumed.
      const mem = await importMempoolFresh();
      const { getDb } = await importDbFresh();

      mem.insertUtxoTx(spendTx([BOX_A]) as any, 1000);
      getDb().prepare('UPDATE mempool SET tx_inputs = NULL').run();

      expect(mem.hasPendingSpend([BOX_A])).toBeNull();
      expect(() => mem.insertUtxoTx(spendTx([BOX_A]) as any, 1000)).not.toThrow();
    });

  });

  // -------------------------------------------------------------------------
  // The pending view: confirmed ∪ pending outputs − pending inputs
  //
  // A transaction spending the change box of one still in the pool is the
  // ordinary shape — the client chains rather than re-spending the box its own
  // pending transaction consumed — and the confirmed set does not hold that
  // output yet.
  // -------------------------------------------------------------------------

  describe('pending view', () => {
    const CONFIRMED = '51'.repeat(32);
    const OWNER = '52'.repeat(32);

    /** A karma output shaped as the positional writer needs it (value is u64). */
    const karmaOut = (value: bigint) => ({
      boxType: 'karma',
      value,
      owner: bytes(OWNER),
      guard: 'owner_signature',
    });

    const chainTx = (inputs: string[], outputs: unknown[]) => ({
      inputs,
      outputs,
      signatures: {},
      protocolVersion: 1,
    });

    /** The id the pool predicts for output `index` of `tx`. */
    async function predictedId(tx: unknown, index: number): Promise<string> {
      const { computeTxId } = await import('@dagsocial/types');
      const { materializeOutput } = await import('../../src/services/utxo-engine.js');
      const t = tx as { outputs: unknown[] };
      return materializeOutput(
        t.outputs[index] as never,
        computeTxId(tx as never),
        index,
      ).id!;
    }

    it('serves a box a pending transaction would create', async () => {
      const mem = await importMempoolFresh();

      const parent = chainTx([CONFIRMED], [karmaOut(95n), karmaOut(5n)]);
      mem.insertUtxoTx(parent as never, 1000);
      const changeId = await predictedId(parent, 0);

      expect(mem.findPendingOutput(changeId)).not.toBeNull();
      expect(mem.findPendingOutput(changeId)!.id).toBe(changeId);
      expect(mem.getBoxWithPending(changeId)!.id).toBe(changeId);
    });

    it('does not serve a pending output that a later pending input consumed', async () => {
      const mem = await importMempoolFresh();

      const parent = chainTx([CONFIRMED], [karmaOut(95n)]);
      mem.insertUtxoTx(parent as never, 1000);
      const changeId = await predictedId(parent, 0);

      mem.insertUtxoTx(chainTx([changeId], [karmaOut(90n)]) as never, 1000);

      // The row is still findable — subtracting the spend is the view's job,
      // not the index's.
      expect(mem.findPendingOutput(changeId)).not.toBeNull();
      expect(mem.getBoxWithPending(changeId)).toBeNull();
    });

    it('subtracts a pending spend from the confirmed set too', async () => {
      const mem = await importMempoolFresh();
      const utxo = await import('../../src/store/utxo.js');
      const { computeBoxId } = await import('@dagsocial/types');

      const box = {
        boxType: 'karma' as const,
        value: 100n,
        owner: bytes(OWNER),
        guard: 'owner_signature' as const,
        txId: '53'.repeat(32),
        index: 0,
      };
      const confirmed = { ...box, id: computeBoxId(box) };
      utxo.insertBox(confirmed as never);

      expect(mem.getBoxWithPending(confirmed.id)!.id).toBe(confirmed.id);

      mem.insertUtxoTx(chainTx([confirmed.id], [karmaOut(99n)]) as never, 1000);

      expect(mem.getBoxWithPending(confirmed.id)).toBeNull();
    });

    it('answers null for a box no one holds', async () => {
      const mem = await importMempoolFresh();

      expect(mem.findPendingOutput(CONFIRMED)).toBeNull();
      expect(mem.getBoxWithPending(CONFIRMED)).toBeNull();
    });

    it('predicts the id block application will materialize', async () => {
      // The pool stores ids from `materializeOutput`, which strips
      // client-supplied provenance. An output arriving with a forged `id`/`txId`
      // must therefore be found under the real one, not the forged one.
      const mem = await importMempoolFresh();

      const forged = {
        ...karmaOut(95n),
        id: 'ff'.repeat(32),
        txId: 'ee'.repeat(32),
        index: 7,
      };
      const parent = chainTx([CONFIRMED], [forged]);
      mem.insertUtxoTx(parent as never, 1000);

      expect(mem.findPendingOutput('ff'.repeat(32))).toBeNull();
      const realId = await predictedId(parent, 0);
      expect(mem.findPendingOutput(realId)!.id).toBe(realId);
    });
  });

  // -------------------------------------------------------------------------
  // removeSubBlockEntries
  // -------------------------------------------------------------------------

  // The pool row is the only copy of a queued prune between `POST
  // /posts/:id/prune` and the block that carries it, and `drainMempoolPrunes`
  // is the miner's first read of it — inside `createOrderingBlock`, which no
  // frame wraps in a try/catch. A prune test that stops at the insert leaves
  // the writer and the reader free to speak different codecs, so what this
  // needs to assert is the PAIR.
  describe('prune entry round-trip', () => {
    it('drains back exactly what was inserted', async () => {
      const mem = await importMempoolFresh();
      const entry = pruneEntry(ROOT_1);

      mem.insertMempoolPrune(entry, 100);
      const drained = mem.drainMempoolPrunes(32);

      expect(drained).toHaveLength(1);
      expect(drained[0].rootPostHash).toBe(entry.rootPostHash);
      expect(drained[0].subtreePostIds).toEqual(entry.subtreePostIds);
      expect(drained[0].trigger).toBe(entry.trigger);
      // `applyMutationPhase` tests `authorId instanceof Uint8Array` before it
      // hexes the claimed author, and hands all three byte fields to
      // `Buffer.from` / `createHash().update()`.
      expect(drained[0].authorId).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(drained[0].authorId)).toEqual(Buffer.from(entry.authorId));
      expect(Buffer.from(drained[0].subtreeMerkleRoot)).toEqual(
        Buffer.from(entry.subtreeMerkleRoot),
      );
      expect(Buffer.from(drained[0].authorSignature)).toEqual(
        Buffer.from(entry.authorSignature),
      );
    });

    it('drains in insertion order and empties the pool', async () => {
      const mem = await importMempoolFresh();
      mem.insertMempoolPrune(pruneEntry(ROOT_1), 100);
      mem.insertMempoolPrune(pruneEntry(ROOT_2), 100);

      const drained = mem.drainMempoolPrunes(32);

      expect(drained.map((e) => e.rootPostHash)).toEqual([ROOT_1, ROOT_2]);
      expect(mem.getPendingEntries(10)).toHaveLength(0);
    });

    it('an unreadable row is dropped without taking its readable siblings with it', async () => {
      const mem = await importMempoolFresh();
      const { getDb } = await importDbFresh();
      const poisoned = mem.insertMempoolPrune(pruneEntry(ROOT_1), 100);
      mem.insertMempoolPrune(pruneEntry(ROOT_2), 100);
      getDb()
        .prepare(`UPDATE mempool SET prune_entry_cbor = ? WHERE rowid = ?`)
        .run(Buffer.from([0xff, 0xff, 0xff]), poisoned);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

      const drained = mem.drainMempoolPrunes(32);

      // The readable sibling survives. A drain that failed the whole batch on
      // one bad blob would stop the miner producing for as long as any row it
      // cannot read stays in front of it.
      expect(drained.map((e) => e.rootPostHash)).toEqual([ROOT_2]);
      expect(mem.getPendingEntries(10)).toHaveLength(0);
      expect(errors).toHaveBeenCalledOnce();
      errors.mockRestore();
    });

    it('removeMempoolPrunes matches the id computed from a stored row', async () => {
      const mem = await importMempoolFresh();
      const { computePruneEntryId } = await import('@dagsocial/types');
      const entry = pruneEntry(ROOT_1);
      mem.insertMempoolPrune(entry, 100);
      mem.insertMempoolPrune(pruneEntry(ROOT_2), 100);

      mem.removeMempoolPrunes([computePruneEntryId(entry)]);

      const left = mem.drainMempoolPrunes(32);
      expect(left.map((e) => e.rootPostHash)).toEqual([ROOT_2]);
    });
  });

  // ⛔ Reserved, never to be reused: the `removeSubBlockEntries` suite. There
  // are no sub-block entries to evict — a post enters the pool as the
  // transaction that creates it, and `finalizeBlock` clears those by rowid.

  // -------------------------------------------------------------------------
  // Size cap — reject, never evict
  // -------------------------------------------------------------------------

  describe('size cap', () => {
    const originalCap = process.env['MAX_MEMPOOL_ENTRIES'];

    afterEach(() => {
      if (originalCap === undefined) delete process.env['MAX_MEMPOOL_ENTRIES'];
      else process.env['MAX_MEMPOOL_ENTRIES'] = originalCap;
    });

    async function importCapped(cap: number) {
      process.env['MAX_MEMPOOL_ENTRIES'] = String(cap);
      vi.resetModules();
      const dbMod = await import('../../src/store/db.js');
      dbMod.initDb(':memory:');
      const mem = await import('../../src/store/mempool.js');
      return mem as any;
    }

    it('rejects every entry type at the cap and accepts below it', async () => {
      const mem = await importCapped(3);

      // Control: inserts below the cap succeed.
      expect(() => mem.insertUtxoTx(txWithInput('sb_1') as any, 100)).not.toThrow();
      expect(() => mem.insertUtxoTx(likeTx(TARGET, LIKER_A) as any, 100)).not.toThrow();
      expect(() => mem.insertMempoolPrune(pruneEntry(ROOT_1), 100)).not.toThrow();

      // At the cap (3 entries), each insert path rejects.
      expect(() => mem.insertUtxoTx(txWithInput('sb_2') as any, 100)).toThrow(mem.MempoolFullError);
      expect(() => mem.insertUtxoTx(likeTx(TARGET, LIKER_B) as any, 100)).toThrow(
        mem.MempoolFullError,
      );
      expect(() => mem.insertMempoolPrune(pruneEntry(ROOT_2), 100), ).toThrow(
        mem.MempoolFullError,
      );

      // Rejection, not eviction: the pool still holds exactly the cap.
      expect(mem.getPendingEntries(100)).toHaveLength(3);
    });

    it('accepts again once entries expire — a full pool drains itself', async () => {
      const mem = await importCapped(2);
      mem.insertUtxoTx(txWithInput('sb_expiring') as any, 10);
      mem.insertUtxoTx(txWithInput('sb_live') as any, 900);
      expect(() => mem.insertUtxoTx(txWithInput('sb_blocked') as any, 900)).toThrow(mem.MempoolFullError);

      mem.purgeExpired(50);
      expect(() => mem.insertUtxoTx(txWithInput('sb_after_purge') as any, 900)).not.toThrow();
    });

    it('defaults to 10000 entries when MAX_MEMPOOL_ENTRIES is unset', async () => {
      delete process.env['MAX_MEMPOOL_ENTRIES'];
      vi.resetModules();
      const { config } = await import('../../src/config.js');
      expect(config.maxMempoolEntries).toBe(10000);
    });
  });
});
