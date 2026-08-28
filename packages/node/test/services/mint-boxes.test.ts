import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { computeBoxId, computeMintTxId } from '@dagsocial/types';
import type { AnyBox, KarmaBox, PostLockBox } from '@dagsocial/types';
import type { BlockJournal, BoxMutation } from '../../src/store/journal.js';
import { labelNonce, seedProvenance } from '../helpers.js';

/**
 * Spec G phase C1 — the mint producers attach provenance.
 *
 * Two things are under test that the phase-B suite cannot reach, because no
 * producer set provenance then:
 *
 *  1. **No box id moves.** Phase C0 made `computeBoxId` hash
 *     `canonicalBoxBytes(box)`, which strips `id`/`txId`/`index`. Attaching
 *     provenance must therefore leave every existing id unchanged — the one
 *     thing no phase before G may break.
 *  2. **Provenance is appended last.** `serializeBox` spreads box keys in
 *     insertion order under `variableMapSize: false`, so a producer that
 *     interleaved `txId`/`index` among the candidate fields would serialize to
 *     different bytes than the same box read back through `rowToBox` — a
 *     restart-triggered stateRoot fork.
 *
 * The producer-built objects come from the **block journal**, not from a
 * test-local reconstruction: the journal records the object `insertBox`
 * actually received, so these assertions bite on the shipped producer rather
 * than on a mirror of it.
 */

async function importDbFresh() {
  return (await import('../../src/store/db.js')) as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

async function importUtxoFresh() {
  return (await import('../../src/store/utxo.js')) as {
    getBox: (boxId: string) => AnyBox | null;
    getUnspentBoxes: () => AnyBox[];
  };
}

async function importJournalFresh() {
  return (await import('../../src/store/journal.js')) as {
    beginBlockJournal: (height: number) => void;
    finishBlockJournal: () => BlockJournal;
  };
}

/** Run `fn` with a journal open, returning the boxes producers inserted. */
async function producedBoxes(height: number, fn: () => void): Promise<AnyBox[]> {
  const journal = await importJournalFresh();
  journal.beginBlockJournal(height);
  fn();
  return journal
    .finishBlockJournal()
    .mutations.filter((m): m is BoxMutation => m.kind === 'box' && m.op === 'insert')
    .map((m) => m.box as AnyBox);
}

/** In-memory DB carrying just the AVL storage schema, for an isolated prover. */
function makeAvlDb(): Database.Database {
  const database = new Database(':memory:');
  database.pragma('journal_mode = WAL');
  database.exec(`
    CREATE TABLE avl_tree_versions (
      version BLOB PRIMARY KEY,
      height INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE avl_tree_nodes (
      version BLOB NOT NULL REFERENCES avl_tree_versions(version),
      label BLOB NOT NULL,
      node_data BLOB NOT NULL,
      PRIMARY KEY (version, label)
    );
  `);
  return database;
}

// Deterministic fixtures — no randomness, no Date.now().
const user = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const POST_A = 'a1'.repeat(32);
const HEIGHT = 700;



/**
 * A `PostLockBox` holding exactly `amount`, inserted and returned — the source
 * a `transferKarma` call names.
 *
 * ⛔ **Every transfer needs one.** A test that wants to put karma somewhere
 * must say where it came from — `transferKarma` names source and destination
 * in one call.
 */
function sourceFor(owner: Uint8Array, amount: bigint, nonce: number): PostLockBox[] {
  const box = seedProvenance<PostLockBox>(
    { boxType: 'post_lock' as const, value: amount, originalValue: amount, owner },
    1,
    nonce,
  );
  insertBoxSync(box);
  return [box];
}

/** Bound in `beforeEach` so the fixtures above can stay synchronous. */
let insertBoxSync: (box: AnyBox) => void;

/**
 * The one surviving karma producer that consolidates and stamps provenance.
 *
 * ⛔ **IT TAKES A SOURCE, AND THAT IS ITS WHOLE OBLIGATION.** The value has to
 * come out of a box the call names (ARCHITECTURE → The conservation axiom); the
 * consolidation and the provenance discipline are the ledger's standing ones.
 * The seeded `PostLockBox` is that source, and it is the shape the live caller
 * uses.
 */
async function transferOut(
  owner: Uint8Array,
  amount: bigint,
  height: number,
  ctx: { reason: string; subject: Uint8Array },
  nonce = 1,
): Promise<string> {
  const { insertBox } = await import('../../src/store/utxo.js');
  const { transferKarma } = await import('../../src/services/karma-transfer.js');
  insertBoxSync = (await import('../../src/store/utxo.js')).insertBox;
  const source = seedProvenance<PostLockBox>(
    {
      boxType: 'post_lock' as const,
      value: amount,
      originalValue: amount,
      owner,
    },
    1,
    nonce,
  );
  insertBox(source);
  const [id] = transferKarma(
    [source],
    [{ owner, amount, ctx: ctx as never }],
    null,
    height,
  );
  return id!;
}

describe('the transfer primitive attaches provenance (Spec G phase C1)', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  // --- the invariant the whole phase rests on ------------------------------

  // `ctx` is required on every `transferKarma` call, so the "without" arm is
  // reconstructed from the produced box — strip `id`/`txId`/`index` and
  // re-derive — which asserts the same equality against the **shipped**
  // producer rather than against a second, differently-configured call.
  it('the produced id BINDS its provenance — stripping it changes the id', async () => {
    const { initDb } = await importDbFresh();
    const { getBox } = await importUtxoFresh();
    const { postlockUnlockContext } = await import('../../src/mint-provenance.js');
    initDb(':memory:');

    const minted = await transferOut(user(0x01), 40n, HEIGHT, postlockUnlockContext(POST_A));
    const stored = getBox(minted)!;

    // Inverted by phase G3b. This asserted the opposite — that stripping
    // provenance left the id unmoved — which is what the *legacy* derivation
    // guaranteed and is precisely what made ids dishonest (M-11). Under the
    // provenance derivation the id must depend on `txId`/`index`, so the same
    // fixture now proves the reverse.
    expect(stored.txId).toBeDefined();
    expect(stored.index).toBe(0);

    // The stored box re-derives its own id: honesty, structurally.
    expect(computeBoxId(stored)).toBe(minted);

    // And the same box under different provenance does not.
    expect(computeBoxId({ ...stored, index: 1 })).not.toBe(minted);
    expect(computeBoxId({ ...stored, txId: 'a'.repeat(64) })).not.toBe(minted);
    expect(minted).toMatch(/^[0-9a-f]{64}$/);
  });

  // --- the provenance itself ------------------------------------------------

  it('transferKarma stamps the txId its context derives, at index 0', async () => {
    const { initDb } = await importDbFresh();
    const { getBox } = await importUtxoFresh();
    const { postlockUnlockContext } = await import('../../src/mint-provenance.js');
    initDb(':memory:');

    const ctx = postlockUnlockContext(POST_A);
    const boxId = await transferOut(user(0x02), 10n, HEIGHT, ctx);

    const stored = getBox(boxId)!;
    expect(stored.txId).toBe(computeMintTxId(HEIGHT, 'postlock-unlock', ctx.subject));
    expect(stored.index).toBe(0);
  });

  it('⛔ it refuses to create karma, and refuses to lose it', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox } = await import('../../src/store/utxo.js');
    const { transferKarma, KarmaNotConservedError } = await import(
      '../../src/services/karma-transfer.js'
    );
    const { postlockUnlockContext } = await import('../../src/mint-provenance.js');
    initDb(':memory:');

    const owner = user(0x0f);
    const source = seedProvenance<PostLockBox>(
      { boxType: 'post_lock' as const, value: 10n, originalValue: 10n, owner },
      1,
      77,
    );
    insertBox(source);
    const ctx = postlockUnlockContext(POST_A);

    // ⛔ **Both directions, because a source is what makes either checkable.**
    // Crediting more than the source holds is creation; leaving a surplus with
    // nowhere named to hold it is destruction. A primitive taking an amount and
    // no source can refuse neither.
    expect(() =>
      transferKarma([source], [{ owner, amount: 11n, ctx }], null, HEIGHT),
    ).toThrow(KarmaNotConservedError);
    expect(() =>
      transferKarma([source], [{ owner, amount: 9n, ctx }], null, HEIGHT),
    ).toThrow(KarmaNotConservedError);

    // Non-vacuity: the exact amount is accepted, so the two above fail on the
    // arithmetic rather than on the fixture.
    expect(() =>
      transferKarma([source], [{ owner, amount: 10n, ctx }], null, HEIGHT),
    ).not.toThrow();
  });

  // ⛔ **NO CREDIT CASE, BECAUSE NO PRODUCER ATTACHES CREDIT PROVENANCE.**
  // Coinbase credits are outputs of the block's settlement transaction and carry
  // that transaction's real `(txId, index)`; `output-shape-id-integrity` pins the
  // derivation every settlement output goes through.

  // `transferKarma` requires a `MintContext` on every call, so provenance-less
  // boxes are unreachable through the producer. The store enforces the same
  // invariant: `utxo_boxes.tx_id`/`output_index` are NOT NULL.

  // --- key order: provenance appended last ---------------------------------

  it('serializeBox is byte-identical for a minted box and its store reconstruction', async () => {
    const { initDb } = await importDbFresh();
    const { getBox } = await importUtxoFresh();
    const { serializeBox } = await import('../../src/state/serialize-box.js');
    const { transferKarma } = await import('../../src/services/karma-transfer.js');
  insertBoxSync = (await import('../../src/store/utxo.js')).insertBox;
    const {
      postlockUnlockContext,
      postlockRemainderContext,
      genesisCommitteeContext,
    } = await import('../../src/mint-provenance.js');
    initDb(':memory:');

    // ⛔ **The sources are seeded OUTSIDE the journal**, because they are
    // pre-block state — every transfer names a box that already existed. Seeded
    // inside, each would be journalled as an insert and the count below would be
    // measuring the fixture rather than the producers.
    const s1 = sourceFor(user(0x11), 10n, 11);
    const s2 = sourceFor(user(0x12), 20n, 12);
    const s3 = sourceFor(user(0x13), 30n, 13);
    // Distinct owners, so no consolidation reaches another's box.
    const produced = await producedBoxes(HEIGHT, () => {
      transferKarma(s1, [{ owner: user(0x11), amount: 10n, ctx: postlockUnlockContext(POST_A) }], null, HEIGHT);
      transferKarma(s2, [{ owner: user(0x12), amount: 20n, ctx: postlockRemainderContext(POST_A) }], null, HEIGHT);
      transferKarma(s3, [{ owner: user(0x13), amount: 30n, ctx: genesisCommitteeContext(user(0x13)) }], null, HEIGHT);
    });
    expect(produced.length).toBe(3);

    for (const box of produced) {
      // Provenance must be the last two keys the producer set — anything else
      // and the two encodings below diverge.
      const keys = Object.keys(box).filter((k) => k !== 'id');
      expect(keys.slice(-2)).toEqual(['txId', 'index']);

      const restored = getBox(box.id!)!;
      expect(Buffer.from(serializeBox(restored)).toString('hex')).toBe(
        Buffer.from(serializeBox(box)).toString('hex'),
      );
    }
  });

  it('bootstrap-from-store and live-producer provers agree over real minted boxes', async () => {
    const { initDb } = await importDbFresh();
    const { getUnspentBoxes } = await importUtxoFresh();
    const { createAvlProver, bootstrapAvlProver } = await import(
      '../../src/state/avl-prover.js'
    );
    const { transferKarma } = await import('../../src/services/karma-transfer.js');
  insertBoxSync = (await import('../../src/store/utxo.js')).insertBox;
    const {
      postlockUnlockContext,
      postlockRemainderContext,
      genesisCommitteeContext,
    } = await import('../../src/mint-provenance.js');
    initDb(':memory:');

    // Sources outside the journal — pre-block state, as above.
    const t1 = sourceFor(user(0x21), 10n, 21);
    const t2 = sourceFor(user(0x22), 20n, 22);
    const t3 = sourceFor(user(0x23), 30n, 23);
    const produced = await producedBoxes(HEIGHT, () => {
      transferKarma(t1, [{ owner: user(0x21), amount: 10n, ctx: postlockUnlockContext(POST_A) }], null, HEIGHT);
      transferKarma(t2, [{ owner: user(0x22), amount: 20n, ctx: postlockRemainderContext(POST_A) }], null, HEIGHT);
      transferKarma(t3, [{ owner: user(0x23), amount: 30n, ctx: genesisCommitteeContext(user(0x23)) }], null, HEIGHT);
    });

    // "Stayed up": the prover holds the producer-built objects.
    const live = createAvlProver(makeAvlDb());
    bootstrapAvlProver(live, produced, 0, []);

    // "Restarted": the prover re-bootstraps from SQLite.
    const restarted = createAvlProver(makeAvlDb());
    bootstrapAvlProver(restarted, getUnspentBoxes(), 0, []);

    const dLive = live.prover.digest();
    const dRestarted = restarted.prover.digest();
    expect(dLive).not.toBeNull();
    expect(Buffer.from(dRestarted!).toString('hex')).toBe(
      Buffer.from(dLive!).toString('hex'),
    );
  });

  // --- the pair the reason tag exists for ----------------------------------

  it('postlock-unlock and postlock-remainder to one author, one post, one height differ', async () => {
    const { initDb } = await importDbFresh();
    const { transferKarma } = await import('../../src/services/karma-transfer.js');
  insertBoxSync = (await import('../../src/store/utxo.js')).insertBox;
    const { postlockUnlockContext, postlockRemainderContext } = await import(
      '../../src/mint-provenance.js'
    );
    initDb(':memory:');

    const author = user(0x31);
    // Both legs: same author, same post, same height. The second
    // merge-consumes the first, so both boxes are visible only through the
    // journal.
    // Sources outside the journal — pre-block state, as above.
    const a1 = sourceFor(author, 3n, 31);
    const a2 = sourceFor(author, 5n, 32);
    const produced = await producedBoxes(HEIGHT, () => {
      transferKarma(a1, [{ owner: author, amount: 3n, ctx: postlockUnlockContext(POST_A) }], null, HEIGHT);
      transferKarma(a2, [{ owner: author, amount: 5n, ctx: postlockRemainderContext(POST_A) }], null, HEIGHT);
    });

    expect(produced.length).toBe(2);
    const [unlock, remainder] = produced;
    expect(unlock!.txId).toBeDefined();
    expect(remainder!.txId).toBeDefined();
    // Same (height, subject); only the reason tag separates them. Equal txIds
    // here would mean a `UNIQUE(tx_id, output_index)` violation in one block —
    // and, from phase G, two boxes claiming one identity.
    expect(remainder!.txId).not.toBe(unlock!.txId);
    expect(unlock!.id).not.toBe(remainder!.id);
  });
});

// ---------------------------------------------------------------------------
// C2 — the producers that build boxes directly rather than through transferKarma
// ---------------------------------------------------------------------------

describe('direct mint producers attach provenance (Spec G phase C2)', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  // ⛔ **DECAY HAS NO PROVENANCE CASES, BECAUSE IT PRODUCES NO BOX.** It derives
  // a plan, and the block's settlement transaction emits the replacement karma
  // as one of its outputs (NODE_INTERFACE → The settlement transaction) — so the
  // box carries that transaction's real `(txId, index)` and there is no
  // synthetic `decay` mint id to stamp. ✅ **A decay box cannot inherit the
  // identity of the box it charges**: it is a fresh output of a different
  // transaction, which is structural rather than asserted.
  //
  it('the two genesis boxes get distinct provenance under one selector each', async () => {
    const { initDb } = await importDbFresh();
    const { getBox } = await importUtxoFresh();
    const { serializeBox } = await import('../../src/state/serialize-box.js');
    const system = await import('../../src/store/system.js');
    const {
      genesisContext,
      GENESIS_SYSTEM_KARMA,
      GENESIS_FAUCET_CREDITS,
    } = await import('../../src/mint-provenance.js');
    initDb(':memory:');

    const sysKey = user(0x51);
    const produced = await producedBoxes(1, () => {
      system.ensureSystemKarmaBox(sysKey, 0);
      system.ensureFaucetCreditBox(sysKey, 0);
    });
    expect(produced.length).toBe(2);

    // `currentHeight = 0` clamps to 1 for both the recorded block and the txId
    // height — one derivation, so they cannot disagree.
    const [karmaBox, creditBox] = produced;
    expect(karmaBox!.txId).toBe(
      computeMintTxId(1, 'genesis', genesisContext(GENESIS_SYSTEM_KARMA).subject),
    );
    expect(creditBox!.txId).toBe(
      computeMintTxId(1, 'genesis', genesisContext(GENESIS_FAUCET_CREDITS).subject),
    );
    expect(karmaBox!.txId).not.toBe(creditBox!.txId);
    expect(karmaBox!.index).toBe(0);
    expect(creditBox!.index).toBe(0);

    for (const box of produced) {
      expect(Buffer.from(serializeBox(getBox(box.id!)!)).toString('hex')).toBe(
        Buffer.from(serializeBox(box)).toString('hex'),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Consolidation order does not reach the minted identity
// ---------------------------------------------------------------------------

describe("⛔ getKarmaBoxes returns a TOTAL order, ties included", () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  const OWNER = user(0x61);

  /**
   * Equal values, which is the whole shape under test.
   *
   * ⛔ **`ORDER BY value DESC` ALONE IS A PARTIAL ORDER, and a partial order
   * reads as handled.** Which of an equal-valued pair lands first would be
   * physical row order — and the decay pass lists these ids as the settlement's
   * INPUTS, which the transaction id hashes in order (NODE_INTERFACE → A derived
   * quantity has TWO kinds of input). Two nodes holding the same box set would
   * derive two different transactions.
   *
   * ⚠ **Equal values are ordinary, not exotic**: two faucet grants, or a payout
   * that happens to match a balance already held.
   */
  const EQUAL_VALUE = 500n;

  /**
   * Seed the pair in `tags` order and report the ids `getKarmaBoxes` hands back.
   *
   * The two boxes are identical but for their tag, so their provenance nonces
   * are what separate them — `canonicalBoxBytes` no longer distinguishes them
   * and they would otherwise derive one txId and trip
   * `UNIQUE(tx_id, output_index)`.
   */
  async function seededOrder(tags: [string, string]): Promise<string[]> {
    vi.resetModules();
    const { initDb } = await importDbFresh();
    const { insertBox, getKarmaBoxes } = await import('../../src/store/utxo.js');
    initDb(':memory:');

    for (const tag of tags) {
      insertBox(
        seedProvenance<KarmaBox>(
          { boxType: 'karma' as const, value: EQUAL_VALUE, owner: OWNER },
          1,
          labelNonce(tag),
        ),
      );
    }
    return getKarmaBoxes(OWNER).map((b) => b.id!);
  }

  it('an equal-valued pair comes back in ONE order whichever way it was inserted', async () => {
    const first = await seededOrder(['faucet', 'mint-1']);
    const second = await seededOrder(['mint-1', 'faucet']);

    expect(first).toHaveLength(2);
    // ⛔ The assertion the tie-break buys: one order, whatever the rows do.
    expect(second).toEqual(first);
    // Non-vacuity: the two runs really do hold different boxes in a different
    // physical order, so equality is the store's doing and not the fixture's.
    expect(new Set(first).size).toBe(2);
  });

  it('the tie-break is ascending id, and value DESC still leads', async () => {
    vi.resetModules();
    const { initDb } = await importDbFresh();
    const { insertBox, getKarmaBoxes } = await import('../../src/store/utxo.js');
    initDb(':memory:');

    // ⚠ **`value DESC` leads and `id` only breaks ties**, so coin selection
    // still takes the largest box first — the ordering is total without the
    // preference being a tie-break's side effect.
    for (const [tag, value] of [['small', 1n], ['big', 900n], ['mid', 500n]] as const) {
      insertBox(
        seedProvenance<KarmaBox>(
          { boxType: 'karma' as const, value, owner: OWNER },
          1,
          labelNonce(tag),
        ),
      );
    }
    expect(getKarmaBoxes(OWNER).map((b) => b.value)).toEqual([900n, 500n, 1n]);
  });
});
