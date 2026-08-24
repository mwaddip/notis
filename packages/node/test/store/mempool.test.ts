import { createHash } from 'crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeBoxId, MEMPOOL_CREDIT_SHARE_PCT } from '@dagsocial/types';
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
    selectMempoolPrunes: (limit: number) => Array<{ rowid: number; entry: any }>;
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
        createdAtBlock: 0,
        owner: bytes(likerHex),
      },
    ],
    signatures: { [likerHex]: new Uint8Array(64) },
    protocolVersion: 1,
    likeTarget: targetPostId,
  };
}

/**
 * An invite, as the pool sees it: one `BondBox` output naming its inviter.
 *
 * ⛔ **The bond IS the invite** (ARCHITECTURE → Invite System), so the
 * `invite_inviter` gate column derives from it. The column's subject — an
 * inviter with a pending invite — is unchanged; only the box carrying it moved.
 */
function inviteTx(inviterHex: string) {
  return {
    inputs: [],
    outputs: [
      {
        boxType: 'bond',
        value: 25n,
        createdAtBlock: 0,
        inviterId: bytes(inviterHex),
        inviteePublicKey: new Uint8Array(32).fill(0x11),
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
        createdAtBlock: 0,
        voucherId: bytes(voucherHex),
        targetId: bytes(targetHex),
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

/**
 * A credit-side entry — all-credit outputs, which is what the pool classifies
 * on. Its input names no box the store holds, so the pool cannot price it and
 * it bids `0`: the cheapest possible credit entry, and the first evicted.
 */
function creditTxWithInput(label: string): unknown {
  const id = createHash('blake2b512').update(label).digest().subarray(0, 32).toString('hex');
  return {
    inputs: [id],
    outputs: [
      { boxType: 'credit', value: 1n,  createdAtBlock: 0,owner: new Uint8Array(32) },
    ],
    signatures: {},
    protocolVersion: 1,
  };
}

/**
 * A credit entry that really bids: it names `inputValue − outputValue` in a
 * `FeeBox` output, which is the whole of what the pool reads.
 *
 * ⛔ **The seeded box is not what makes the bid readable.** `bidOf` resolves
 * nothing (MEMPOOL_INTERFACE → Fee floor), so the fee is legible from the
 * transaction's own bytes; the box is here because these fixtures are otherwise
 * real transactions and the conflict gate reads their inputs.
 *
 * `padding` widens the transaction, which is how a test separates a fee from a
 * fee RATE — the same fee over more bytes is a worse bid.
 */
function seededCreditTx(
  label: string,
  inputValue: bigint,
  outputValue: bigint,
  padding = 1,
): { tx: unknown; box: Record<string, unknown> } {
  const owner = createHash('blake2b512').update(`${label}_owner`).digest().subarray(0, 32);
  const box = {
    boxType: 'credit' as const,
    value: inputValue,
    createdAtBlock: 0,
    owner: new Uint8Array(owner),
    txId: createHash('blake2b512').update(`${label}_tx`).digest().subarray(0, 32).toString('hex'),
    index: 0,
  };
  const id = computeBoxId(box as never);
  const share = outputValue / BigInt(padding);
  const outputs: unknown[] = Array.from({ length: padding }, (_, i) => ({
    boxType: 'credit' as const,
    value: i === 0 ? outputValue - share * BigInt(padding - 1) : share,
    createdAtBlock: 0,
    owner: new Uint8Array(owner),
  }));
  const fee = inputValue - outputValue;
  // Zero fee means no box, so a zero-bidding entry carries none — which is
  // exactly the shape the flood cases above rely on.
  if (fee > 0n) {
    outputs.push({ boxType: 'fee' as const, value: fee,  createdAtBlock: 0,});
  }
  return {
    tx: { inputs: [id], outputs, signatures: {}, protocolVersion: 1 },
    box: { ...box, id },
  };
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
    expect(entries[0].utxoTxBytes).toBeInstanceOf(Uint8Array);
    expect(entries[0].expiresAtHeight).toBe(200);
  });

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
    // A prune row's blob is read by selectMempoolPrunes, not the DTO
    // (MEMPOOL_INTERFACE → PoolEntry).
    expect(entries[0].utxoTxBytes).toBeNull();
    expect(entries[1].utxoTxBytes).toBeInstanceOf(Uint8Array);
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

  it('utxo_tx entry carries utxoTxBytes as a Uint8Array', async () => {
    const { insertUtxoTx, getPendingEntries } = await importMempoolFresh();
    const tx = { inputs: [BOX_99], outputs: [], signatures: {}, protocolVersion: 1 };
    insertUtxoTx(tx as any, 300);
    const entries = getPendingEntries(10);
    expect(entries).toHaveLength(1);
    expect(entries[0].entryType).toBe('utxo_tx');
    expect(entries[0].utxoTxBytes).toBeInstanceOf(Uint8Array);
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

    it('derives the like columns from `likeTarget` alone, never from an output', async () => {
      // ⛔ **The retired output-scan derivation stays dead**, and the box it
      // scanned for stays unrepresentable: `like` is a reserved boxType with no
      // interface and no encoder tag (TYPES_INTERFACE → ~~LikeBox~~). So the
      // fixture carries a real karma output instead, and the property is that a
      // transaction with outputs and no `likeTarget` derives no liker.
      const { insertUtxoTx, getDbRow } = await importMempoolWithRow();
      insertUtxoTx({
        inputs: [],
        outputs: [{ boxType: 'karma', value: 2n,  createdAtBlock: 0,owner: bytes(LIKER_A) }],
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
      createdAtBlock: 0,
      owner: bytes(OWNER),
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
        createdAtBlock: 0,
        owner: bytes(OWNER),
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

  // The pool row is the only copy of a queued prune between `POST
  // /posts/:id/prune` and the block that carries it, and `selectMempoolPrunes`
  // is the miner's first read of it — inside `createOrderingBlock`, which no
  // frame wraps in a try/catch. A prune test that stops at the insert leaves
  // the writer and the reader free to speak different codecs, so what this
  // needs to assert is the PAIR.
  describe('prune entry round-trip', () => {
    it('reads back exactly what was inserted, without removing the row', async () => {
      const mem = await importMempoolFresh();
      const entry = pruneEntry(ROOT_1);

      mem.insertMempoolPrune(entry, 100);
      const selected = mem.selectMempoolPrunes(32);

      expect(selected).toHaveLength(1);
      const got = selected[0]!.entry;
      expect(got.rootPostHash).toBe(entry.rootPostHash);
      expect(got.subtreePostIds).toEqual(entry.subtreePostIds);
      // `applyMutationPhase` tests `authorId instanceof Uint8Array` before it
      // hexes the claimed author, and hands all three byte fields to
      // `Buffer.from` / `createHash().update()`.
      expect(got.authorId).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(got.authorId)).toEqual(Buffer.from(entry.authorId));
      expect(Buffer.from(got.subtreeMerkleRoot)).toEqual(
        Buffer.from(entry.subtreeMerkleRoot),
      );
      expect(Buffer.from(got.authorSignature)).toEqual(
        Buffer.from(entry.authorSignature),
      );
      // The rows stay — `selectMempoolPrunes` is a read, not a drain.
      expect(mem.getPendingEntries(10)).toHaveLength(1);
    });

    it('reads in insertion order and the rows remain in the pool', async () => {
      const mem = await importMempoolFresh();
      mem.insertMempoolPrune(pruneEntry(ROOT_1), 100);
      mem.insertMempoolPrune(pruneEntry(ROOT_2), 100);

      const selected = mem.selectMempoolPrunes(32);

      expect(selected.map((s) => s.entry.rootPostHash)).toEqual([ROOT_1, ROOT_2]);
      expect(mem.getPendingEntries(10)).toHaveLength(2);
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

      const selected = mem.selectMempoolPrunes(32);

      // The readable sibling survives. A read that failed the whole batch on
      // one bad blob would stop the miner producing for as long as any row it
      // cannot read sat in front of it.
      expect(selected.map((s) => s.entry.rootPostHash)).toEqual([ROOT_2]);
      // The poisoned row is gone; the readable sibling remains.
      expect(mem.getPendingEntries(10)).toHaveLength(1);
      expect(errors).toHaveBeenCalledOnce();
      errors.mockRestore();
    });

    it('insertMempoolPrune writes prune_entry_id equal to computePruneEntryId(entry)', async () => {
      const mem = await importMempoolFresh();
      const { getDb } = await importDbFresh();
      const { computePruneEntryId } = await import('@dagsocial/types');
      const entry = pruneEntry(ROOT_1);

      mem.insertMempoolPrune(entry, 100);

      const row = getDb()
        .prepare('SELECT prune_entry_id FROM mempool WHERE entry_type = ?')
        .get('prune') as { prune_entry_id: string };
      expect(row.prune_entry_id).toBe(computePruneEntryId(entry));
    });

    it('removeMempoolPrunes deletes by prune_entry_id and leaves the others', async () => {
      const mem = await importMempoolFresh();
      const { computePruneEntryId } = await import('@dagsocial/types');
      const entry = pruneEntry(ROOT_1);
      mem.insertMempoolPrune(entry, 100);
      mem.insertMempoolPrune(pruneEntry(ROOT_2), 100);

      mem.removeMempoolPrunes([computePruneEntryId(entry)]);

      const left = mem.selectMempoolPrunes(32);
      expect(left.map((s) => s.entry.rootPostHash)).toEqual([ROOT_2]);
    });

    it('removeMempoolPrunes is indexed — idx_mempool_prune_entry_id', async () => {
      const mem = await importMempoolFresh();
      const { getDb } = await importDbFresh();
      const { computePruneEntryId } = await import('@dagsocial/types');
      const entry = pruneEntry(ROOT_1);
      mem.insertMempoolPrune(entry, 100);
      const entryId = computePruneEntryId(entry);

      // MEMPOOL_INTERFACE → "Confirmed-entry cleanup reaches every row, and
      // it is a lookup rather than a scan"
      const plan = getDb()
        .prepare('EXPLAIN QUERY PLAN DELETE FROM mempool WHERE prune_entry_id IN (?)')
        .all(entryId) as Array<{ detail: string }>;
      const usesIndex = plan.some((row) =>
        row.detail.includes('idx_mempool_prune_entry_id'),
      );
      expect(usesIndex).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Size cap — per class. The karma-side class rejects and never evicts; the
  // credit class displaces its cheapest resident for a higher bidder
  // (MEMPOOL_INTERFACE → Eviction, inside the credit class only).
  // -------------------------------------------------------------------------

  describe('size cap', () => {
    async function importCapped(cap: number) {
      vi.resetModules();
      const dbMod = await import('../../src/store/db.js');
      dbMod.initDb(':memory:');
      const mem = await import('../../src/store/mempool.js');
      mem.setMempoolCap(cap);
      return mem as any;
    }

    it('rejects every karma-side insert path at that class’s cap', async () => {
      // 6 entries, 50/50: three karma-side slots, three credit slots. Every
      // fixture below is karma-side — `txWithInput` has no outputs, a like has
      // a karma output, a prune entry is not a transaction at all — so the
      // three of them fill that class exactly, and the credit class stays
      // untouched throughout.
      const mem = await importCapped(6);

      expect(() => mem.insertUtxoTx(txWithInput('sb_1') as any, 100)).not.toThrow();
      expect(() => mem.insertUtxoTx(likeTx(TARGET, LIKER_A) as any, 100)).not.toThrow();
      expect(() => mem.insertMempoolPrune(pruneEntry(ROOT_1), 100)).not.toThrow();

      // At the class cap, each insert path rejects — including the prune path,
      // which is bounded by nothing if the class counts filter on `entry_type`.
      expect(() => mem.insertUtxoTx(txWithInput('sb_2') as any, 100)).toThrow(mem.MempoolFullError);
      expect(() => mem.insertUtxoTx(likeTx(TARGET, LIKER_B) as any, 100)).toThrow(
        mem.MempoolFullError,
      );
      expect(() => mem.insertMempoolPrune(pruneEntry(ROOT_2), 100)).toThrow(
        mem.MempoolFullError,
      );

      // Rejection, not eviction: nothing karma-side ever loses its slot, which
      // is the whole reason the classes are capped apart.
      expect(mem.getPendingEntries(100)).toHaveLength(3);

      // And the pool is not full — a credit transaction still gets in, so the
      // rejection above was the class's bound and not the pool's.
      expect(() => mem.insertUtxoTx(creditTxWithInput('c_1') as any, 100)).not.toThrow();
      expect(mem.getPendingEntries(100)).toHaveLength(4);
    });

    it('names the class that was full, not just the cap', async () => {
      const mem = await importCapped(2);   // one slot each
      mem.insertUtxoTx(txWithInput('k_1') as any, 100);
      try {
        mem.insertUtxoTx(txWithInput('k_2') as any, 100);
        expect.unreachable('the karma class was full');
      } catch (err) {
        expect(err).toBeInstanceOf(mem.MempoolFullError);
        expect((err as { poolClass: string }).poolClass).toBe('karma');
      }
    });

    it('accepts again once entries expire — a full class drains itself', async () => {
      const mem = await importCapped(4);   // two karma slots
      mem.insertUtxoTx(txWithInput('sb_expiring') as any, 10);
      mem.insertUtxoTx(txWithInput('sb_live') as any, 900);
      expect(() => mem.insertUtxoTx(txWithInput('sb_blocked') as any, 900)).toThrow(mem.MempoolFullError);

      mem.purgeExpired(50);
      expect(() => mem.insertUtxoTx(txWithInput('sb_after_purge') as any, 900)).not.toThrow();
    });

    it('bounds a credit flood to its share, leaving the karma class free', async () => {
      const mem = await importCapped(10);   // five credit slots, five karma
      for (let i = 0; i < 20; i++) {
        try {
          mem.insertUtxoTx(creditTxWithInput(`flood_${i}`) as any, 100);
        } catch {
          // Every arrival bids 0, so none can displace another — the class
          // fills and then refuses, which is what bounds the flood.
        }
      }
      expect(mem.getPendingEntries(100)).toHaveLength(5);

      // The karma class never saw the flood.
      expect(() => mem.insertUtxoTx(likeTx(TARGET, LIKER_A) as any, 100)).not.toThrow();
      expect(() => mem.insertUtxoTx(txWithInput('after_flood') as any, 100)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Credit-class eviction
  // -------------------------------------------------------------------------

  describe('credit-class eviction', () => {
    /** A capped pool with the seeded input boxes already in the UTXO store. */
    async function importCappedWithBoxes(cap: number, boxes: Record<string, unknown>[]) {
      vi.resetModules();
      const dbMod = await import('../../src/store/db.js');
      dbMod.initDb(':memory:');
      const utxo = await import('../../src/store/utxo.js');
      for (const box of boxes) utxo.insertBox(box as never);
      const mem = await import('../../src/store/mempool.js');
      mem.setMempoolCap(cap);
      return mem as any;
    }

    it('displaces the cheapest resident for a higher bidder', async () => {
      const rich = seededCreditTx('rich', 1000n, 100n);      // fee 900
      const poor = seededCreditTx('poor', 1000n, 990n);      // fee 10
      const mid = seededCreditTx('mid', 1000n, 500n);        // fee 500
      const mem = await importCappedWithBoxes(4, [rich.box, poor.box, mid.box]);

      mem.insertUtxoTx(rich.tx as any, 100);
      mem.insertUtxoTx(poor.tx as any, 100);
      expect(mem.getPendingEntries(100)).toHaveLength(2);

      // Two credit slots are full; `mid` outbids `poor` and takes its place.
      mem.insertUtxoTx(mid.tx as any, 100);
      const fees = mem.getPendingEntries(100).map((e: { rowid: number }) => e.rowid);
      expect(fees).toHaveLength(2);

      const db = (await import('../../src/store/db.js')).getDb();
      const held = (db.prepare('SELECT tx_fee FROM mempool ORDER BY tx_fee DESC')
        .all() as Array<{ tx_fee: number }>).map((r) => Number(r.tx_fee));
      expect(held).toEqual([900, 500]);
    });

    it('refuses a bid at or below the cheapest resident', async () => {
      const a = seededCreditTx('a', 1000n, 900n);     // fee 100
      const b = seededCreditTx('b', 1000n, 910n);     // fee 90
      const low = seededCreditTx('low', 1000n, 999n); // fee 1
      const mem = await importCappedWithBoxes(4, [a.box, b.box, low.box]);

      mem.insertUtxoTx(a.tx as any, 100);
      mem.insertUtxoTx(b.tx as any, 100);
      expect(() => mem.insertUtxoTx(low.tx as any, 100)).toThrow(mem.MempoolFullError);

      // Rejected, not admitted-then-evicted: both residents survive.
      expect(mem.getPendingEntries(100)).toHaveLength(2);
    });

    // ⛔ The whole point of two classes. Fee-ordered eviction over one pool
    // wipes every zero-bidding operation — posts, likes, invites, vouches —
    // and the coinbase's inclusion bonus then pays for work that can no longer
    // reach the pool at all.
    it('never evicts a karma-side entry, however high the bid', async () => {
      const rich = seededCreditTx('rich', 10_000n, 1n);   // fee 9999
      const cheap = seededCreditTx('cheap', 1000n, 999n); // fee 1
      const mem = await importCappedWithBoxes(4, [rich.box, cheap.box]);

      mem.insertUtxoTx(likeTx(TARGET, LIKER_A) as any, 100);
      mem.insertUtxoTx(txWithInput('post_like') as any, 100);
      mem.insertUtxoTx(cheap.tx as any, 100);
      mem.insertUtxoTx(creditTxWithInput('zero_bid') as any, 100);

      // Credit class full at two; the rich arrival displaces a credit entry.
      mem.insertUtxoTx(rich.tx as any, 100);

      const db = (await import('../../src/store/db.js')).getDb();
      const karma = db.prepare('SELECT COUNT(*) AS n FROM mempool WHERE tx_fee IS NULL')
        .get() as { n: number };
      const credit = db.prepare('SELECT COUNT(*) AS n FROM mempool WHERE tx_fee IS NOT NULL')
        .get() as { n: number };
      expect(karma.n).toBe(2);    // both survived
      expect(credit.n).toBe(2);
    });

    // The rate is per in-block byte, not per transaction: a fat transaction
    // paying the same total is a worse bid, because bytes are what the block
    // budget rations.
    it('ranks by rate, so the same fee over more bytes is the cheaper entry', async () => {
      const lean = seededCreditTx('lean', 1000n, 400n, 1);    // fee 600, 1 output
      const fat = seededCreditTx('fat', 1000n, 400n, 12);     // fee 600, 12 outputs
      const mem = await importCappedWithBoxes(2, [lean.box, fat.box]);

      mem.insertUtxoTx(fat.tx as any, 100);
      const db = (await import('../../src/store/db.js')).getDb();
      const fatBytes = (db.prepare('SELECT tx_bytes FROM mempool').get() as { tx_bytes: number }).tx_bytes;

      mem.insertUtxoTx(lean.tx as any, 100);
      const rows = db.prepare('SELECT tx_fee, tx_bytes FROM mempool').all() as
        Array<{ tx_fee: number; tx_bytes: number }>;

      // One credit slot, and the leaner of two equal fees is what holds it.
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.tx_fee)).toBe(600);
      expect(rows[0]!.tx_bytes).toBeLessThan(fatBytes);
    });

    it('reads back a fee near 2^60 exactly, so the displacement verdict is correct', async () => {
      const RESIDENT_FEE = (1n << 60n) - 1n;
      const resident = seededCreditTx('resident_big', RESIDENT_FEE + 1n, 1n);
      const mem = await importCappedWithBoxes(2, [resident.box]);

      mem.insertUtxoTx(resident.tx as any, 100);

      const db = (await import('../../src/store/db.js')).getDb();
      const stored = db.prepare('SELECT tx_fee FROM mempool WHERE tx_fee IS NOT NULL')
        .safeIntegers().get() as { tx_fee: bigint };
      expect(stored.tx_fee).toBe(RESIDENT_FEE);

      const arrivalFee = RESIDENT_FEE - 1n;
      const arrival = seededCreditTx('arrival_big', arrivalFee + 1n, 1n);
      (await import('../../src/store/utxo.js')).insertBox(arrival.box as never);

      expect(() => mem.insertUtxoTx(arrival.tx as any, 100)).toThrow(mem.MempoolFullError);

      const arrivalWins = seededCreditTx('arrival_wins', RESIDENT_FEE + 2n, 1n);
      (await import('../../src/store/utxo.js')).insertBox(arrivalWins.box as never);
      mem.insertUtxoTx(arrivalWins.tx as any, 100);
      expect(mem.getPendingEntries(100)).toHaveLength(1);
      const remaining = db.prepare('SELECT tx_fee FROM mempool WHERE tx_fee IS NOT NULL')
        .safeIntegers().get() as { tx_fee: bigint };
      expect(remaining.tx_fee).toBe(RESIDENT_FEE + 1n);
    });

    it('defaults to 10000 entries when MAX_MEMPOOL_ENTRIES is unset', async () => {
      delete process.env['MAX_MEMPOOL_ENTRIES'];
      vi.resetModules();
      const { config } = await import('../../src/config.js');
      expect(config.maxMempoolEntries).toBe(10000);
      const { DEFAULT_MAX_MEMPOOL_ENTRIES } = await import('../../src/store/mempool.js');
      expect(config.maxMempoolEntries).toBe(DEFAULT_MAX_MEMPOOL_ENTRIES);
    });
  });

  // -------------------------------------------------------------------------
  // setMempoolCap pins (MEMPOOL_INTERFACE → Size cap — reject, never evict)
  // -------------------------------------------------------------------------

  describe('setMempoolCap', () => {
    const CAP = 3;
    // Karma-side entries hold the remainder of the bound after the credit
    // share (MEMPOOL_INTERFACE → Eviction, inside the credit class only);
    // the setter is what the bound is.
    const KARMA_SLOTS = CAP - Math.floor((CAP * MEMPOOL_CREDIT_SHARE_PCT) / 100);

    it('the setter bounds the pool', async () => {
      vi.resetModules();
      const dbMod = await import('../../src/store/db.js');
      dbMod.initDb(':memory:');
      const mem = await import('../../src/store/mempool.js');
      mem.setMempoolCap(CAP);

      for (let i = 0; i < KARMA_SLOTS; i++) {
        expect(() => mem.insertUtxoTx(txWithInput(`cap_${i}`) as any, 100)).not.toThrow();
      }
      expect(() => mem.insertUtxoTx(txWithInput('cap_over') as any, 100)).toThrow(
        mem.MempoolFullError,
      );
    });

    it('rejects 0, negative, fractional, and NaN without changing the cap', async () => {
      vi.resetModules();
      const dbMod = await import('../../src/store/db.js');
      dbMod.initDb(':memory:');
      const mem = await import('../../src/store/mempool.js');
      mem.setMempoolCap(CAP);

      expect(() => mem.setMempoolCap(0)).toThrow('invalid capacity');
      expect(() => mem.setMempoolCap(-1)).toThrow('invalid capacity');
      expect(() => mem.setMempoolCap(1.5)).toThrow('invalid capacity');
      expect(() => mem.setMempoolCap(NaN)).toThrow('invalid capacity');

      for (let i = 0; i < KARMA_SLOTS; i++) {
        expect(() => mem.insertUtxoTx(txWithInput(`surv_${i}`) as any, 100)).not.toThrow();
      }
      expect(() => mem.insertUtxoTx(txWithInput('surv_over') as any, 100)).toThrow(
        mem.MempoolFullError,
      );
    });
  });

  describe('transaction size bound', () => {
    /**
     * A transaction whose `encodeTx` is exactly `bytes` long.
     *
     * The padding rides a signature value, the one field with no length rule of
     * its own — inputs are fixed-width hex, so a transaction built out of them
     * moves in 66-byte steps and can straddle the bound without landing on it.
     * `insertUtxoTx` verifies no signature, so this measures size and nothing
     * else.
     */
    /**
     * A transaction whose encoded length is exactly `bytes`.
     *
     * ⛔ **Every field the codec writes is fixed-width or bounded**, so the
     * padding has to come from a length-prefixed one: `inputs` gives 32-byte
     * steps and a post's `content` gives single-byte steps
     * (TYPES_INTERFACE → Layout — UtxoTransaction). ⚠ **A signature cannot pad**
     * — `b64` is fixed-width, so a padded one has no encoding.
     */
    async function txOverMaxSize() {
      const { encodeTx, computeContentHash, PROTOCOL_VERSION, MAX_TX_BYTES } = await import('@dagsocial/types');
      let inputs = 0;
      const build = (n: number) => ({
        inputs: Array.from({ length: n }, (_, i) =>
          i.toString(16).padStart(64, '0'),
        ),
        outputs: [],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
        post: {
          contentHash: computeContentHash('size-test'),
          author: new Uint8Array(32).fill(0x33),
          parentRefs: [],
          protocolVersion: PROTOCOL_VERSION,
          type: 'regular',
        },
      });
      while (encodeTx(build(inputs + 1) as any).length <= MAX_TX_BYTES) inputs++;
      return { over: build(inputs + 1), at: build(inputs) };
    }

    it('refuses a transaction over MAX_TX_BYTES at admission', async () => {
      const mem = await importMempoolFresh();

      const { over, at } = await txOverMaxSize();
      expect(() => mem.insertUtxoTx(over as any, 1000)).toThrow(
        (mem as any).TxTooLargeError,
      );
      expect(() => mem.insertUtxoTx(over as any, 1000)).toThrow(/above the .* limit/i);

      expect(mem.getPendingEntries(10)).toHaveLength(0);

      expect(() => mem.insertUtxoTx(at as any, 1000)).not.toThrow();
      expect(mem.getPendingEntries(10)).toHaveLength(1);
    });
  });
});
