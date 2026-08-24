import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AnyBox, AnyBoxCandidate, CandidateOf, CreditBox, KarmaBox, BondBox, PostLockBox, VouchBox, VouchEscrowBox, LikeAccrualBox, EmissionBox, TreasuryBox, FeeBox, KarmaPoolBox } from '@dagsocial/types';
import type Database from 'better-sqlite3';

/**
 * Spec G phase C3 — outputs of a user transaction take the real creating
 * transaction's id and their position in `tx.outputs`.
 *
 * The hazard specific to this path, and absent from the mint paths: outputs are
 * **attacker-controlled CBOR**. `computeTxId` hashes them through
 * `canonicalBoxBytes`, so a client can put `txId`/`index` keys anywhere in an
 * output without changing the transaction id that gets signed and checked. If
 * materialization overwrote those keys in place rather than stripping and
 * re-appending them, the stored box would serialize differently from the same
 * box read back through `rowToBox` — and a node that restarted would compute a
 * different `stateRoot` than one that stayed up.
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
    insertBox: (box: AnyBox, postLockTarget?: string) => void;
    getBox: (boxId: string) => AnyBox | null;
  };
}

const user = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const TX_ID = 'fe'.repeat(32);

// `CandidateOf<CreditBox>`, which is what the name has always said. The return
// type said `CreditBox` — a stored box — while the body returns a literal with
// no id and no provenance, which is precisely the distinction this suite exists
// to pin (Spec G phase C3: outputs get their provenance from the transaction).
function creditCandidate(
  value: bigint,
  owner: Uint8Array,
  createdAtBlock = 0,
): CandidateOf<CreditBox> {
  return {
    boxType: 'credit',
    value,
    createdAtBlock,
    owner,
  };
}

// The module's own type rather than a hand-written shape: under a hand-written
// shape, reaching for another export is a compile error and the test that
// needed it goes unwritten instead.
async function importJournalFresh() {
  return import('../../src/store/journal.js');
}

describe('transaction output provenance (Spec G phase C3)', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('takes the real txId and the output position as index', async () => {
    const { materializeOutput } = await import('../../src/services/utxo-engine.js');

    const outputs = [
      creditCandidate(100n, user(0xa1)),
      creditCandidate(25n, user(0xa2)),
    ].map((box, index) => materializeOutput(box, TX_ID, index));

    expect(outputs[0]!.txId).toBe(TX_ID);
    expect(outputs[1]!.txId).toBe(TX_ID);
    expect(outputs[0]!.index).toBe(0);
    expect(outputs[1]!.index).toBe(1);
  });

  it('binds the box id to the transaction and the position it was created at', async () => {
    const { materializeOutput } = await import('../../src/services/utxo-engine.js');
    const { computeCandidateBoxId } = await import('@dagsocial/types');

    // Inverted by phase G3b. This asserted that attaching provenance must NOT
    // move an id — the load-bearing invariant for every phase *before* G, since
    // ids had to stay put while producers moved over. From G3b on the opposite
    // is required: an id that ignored its own provenance would be the M-11 id.
    const candidate = creditCandidate(100n, user(0xb1));
    const materialized = materializeOutput(candidate, TX_ID, 3);

    expect(materialized.id).toBe(computeCandidateBoxId(candidate, TX_ID, 3));
    // Same candidate, different outpoint — different box. This is what makes
    // two byte-identical outputs in one transaction distinguishable, which the
    // content hash could not do (the `utxo_boxes.id` PK collision).
    expect(materializeOutput(candidate, TX_ID, 4).id).not.toBe(materialized.id);
    expect(materializeOutput(candidate, 'a'.repeat(64), 3).id).not.toBe(materialized.id);
  });

  it('the store reconstruction is byte-identical (key order is canonical now)', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    const { serializeBox } = await import('../../src/state/serialize-box.js');
    const { materializeOutput } = await import('../../src/services/utxo-engine.js');
    initDb(':memory:');

    const produced = materializeOutput(creditCandidate(100n, user(0xc1)), TX_ID, 1);
    const keys = Object.keys(produced).filter((k) => k !== 'id');
    expect(keys.slice(-2)).toEqual(['txId', 'index']);

    insertBox(produced);
    const restored = getBox(produced.id!)!;
    expect(Buffer.from(serializeBox(restored)).toString('hex')).toBe(
      Buffer.from(serializeBox(produced)).toString('hex'),
    );
  });

  it('strips client-supplied provenance rather than overwriting it in place', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    const { serializeBox } = await import('../../src/state/serialize-box.js');
    const { materializeOutput } = await import('../../src/services/utxo-engine.js');
    initDb(':memory:');

    // A hostile output: provenance keys planted *before* the candidate fields,
    // carrying values the client chose. Overwriting in place would keep them in
    // these positions and silently fork a restarted node's stateRoot.
    const hostile = {
      boxType: 'credit',
      txId: 'aa'.repeat(32),
      index: 99,
      value: 100n,
      createdAtBlock: 0,
      owner: user(0xd1),
    } as unknown as CreditBox;

    const produced = materializeOutput(hostile, TX_ID, 0);
    expect(produced.txId).toBe(TX_ID);
    expect(produced.index).toBe(0);

    const keys = Object.keys(produced).filter((k) => k !== 'id');
    expect(keys.slice(-2)).toEqual(['txId', 'index']);
    // And the canonical position is the only one they appear in.
    expect(keys.indexOf('txId')).toBe(keys.lastIndexOf('txId'));

    insertBox(produced);
    const restored = getBox(produced.id!)!;
    expect(Buffer.from(serializeBox(restored)).toString('hex')).toBe(
      Buffer.from(serializeBox(produced)).toString('hex'),
    );
  });

  it('is total over every box type, appending after each type\'s own fields', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    const { serializeBox } = await import('../../src/state/serialize-box.js');
    const { materializeOutput } = await import('../../src/services/utxo-engine.js');
    initDb(':memory:');

    // Keyed on the union so a new type is a compile error rather than a
    // silent omission (TYPES_INTERFACE → What a new box type costs).
    // `genesis_proof` is excluded: it appears in no transaction, user or
    // settlement (NODE_INTERFACE → Genesis proof boxes are never in a
    // transaction). Per-type lists so optional-field variants are covered.
    const candidates: Record<Exclude<AnyBoxCandidate['boxType'], 'genesis_proof'>, readonly AnyBoxCandidate[]> = {
      karma: [{
        boxType: 'karma', value: 5n, createdAtBlock: 0, owner: user(0xe1),
      } satisfies CandidateOf<KarmaBox>],
      credit: [
        creditCandidate(7n, user(0xe2)),
        {
          boxType: 'credit', value: 8n, createdAtBlock: 0, owner: user(0xe3),
          lockedUntilBlock: 900,
        } satisfies CandidateOf<CreditBox>,
      ],
      bond: [{
        boxType: 'bond', value: 3n, createdAtBlock: 0, inviterId: user(0xe7),
        inviteePublicKey: user(0xe8),
      } satisfies CandidateOf<BondBox>],
      post_lock: [{
        boxType: 'post_lock', value: 5n, createdAtBlock: 0,
        originalValue: 10n, owner: user(0xeb),
      } satisfies CandidateOf<PostLockBox>],
      vouch: [{
        boxType: 'vouch', value: 1n, createdAtBlock: 0, voucherId: user(0xe9),
        targetId: user(0xea),
      } satisfies CandidateOf<VouchBox>],
      vouch_escrow: [{
        boxType: 'vouch_escrow', value: 1n, createdAtBlock: 0,
        owner: user(0xec), releaseAtBlock: 100,
      } satisfies CandidateOf<VouchEscrowBox>],
      like_accrual: [{
        boxType: 'like_accrual', value: 1n, createdAtBlock: 0,
        author: user(0xed),
      } satisfies CandidateOf<LikeAccrualBox>],
      emission: [{
        boxType: 'emission', value: 100n, createdAtBlock: 0,
      } satisfies CandidateOf<EmissionBox>],
      treasury: [{
        boxType: 'treasury', value: 50n, createdAtBlock: 0,
      } satisfies CandidateOf<TreasuryBox>],
      fee: [{
        boxType: 'fee', value: 2n, createdAtBlock: 0,
      } satisfies CandidateOf<FeeBox>],
      karma_pool: [{
        boxType: 'karma_pool', value: 500n, createdAtBlock: 0,
      } satisfies CandidateOf<KarmaPoolBox>],
    };

    Object.values(candidates).flat().forEach((candidate, index) => {
      const produced = materializeOutput(candidate, TX_ID, index);
      const keys = Object.keys(produced).filter((k) => k !== 'id');
      expect(keys.slice(-2)).toEqual(['txId', 'index']);

      insertBox(produced);
      const restored = getBox(produced.id!)!;
      expect(Buffer.from(serializeBox(restored)).toString('hex')).toBe(
        Buffer.from(serializeBox(produced)).toString('hex'),
      );
    });
  });

  it('applyTx stores the materialized box unchanged, and the height goes to the column', async () => {
    // The stored box is byte-identical to what `materializeOutput` produced:
    // any key added or reordered changes the id, so the store path adds nothing.
    //
    // `insertBox` fills the `created_at_block` column from the box's own
    // `createdAtBlock`, never from the open journal
    // (NODE_INTERFACE → Populating the record). The box declares 300 while the
    // journal and the applied height are 777, so a writer reaching for the
    // journal reads a height this assertion refuses.
    const { initDb } = await importDbFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    const { beginBlockJournal, finishBlockJournal } = await importJournalFresh();
    const { serializeBox } = await import('../../src/state/serialize-box.js');
    const { materializeOutput, applyTx } = await import(
      '../../src/services/utxo-engine.js'
    );
    const { getDb } = await importDbFresh();
    initDb(':memory:');

    const produced = materializeOutput(creditCandidate(100n, user(0xf1), 300), TX_ID, 0);
    beginBlockJournal(777);
    applyTx(
      {
        getBox,
        insertBox,
        consumeBox: () => {},
        getKarmaBox: () => null,
        runInTransaction: (fn: () => void) => { getDb().transaction(fn)(); },
      } as never,
      { inputs: [], outputs: [], signatures: {}, protocolVersion: 1 },
      [produced],
      777,
    );
    finishBlockJournal();

    const columnHeight = (
      getDb()
        .prepare('SELECT created_at_block FROM utxo_boxes WHERE id = ?')
        .get(produced.id!) as { created_at_block: number }
    ).created_at_block;
    expect(columnHeight).toBe(300);

    const restored = getBox(produced.id!)!;
    expect(restored.txId).toBe(TX_ID);
    expect(restored.index).toBe(0);
    expect('createdAtBlock' in restored).toBe(true);
    expect('lastTouchBlock' in restored).toBe(false);
    expect(Buffer.from(serializeBox(restored)).toString('hex')).toBe(
      Buffer.from(serializeBox({ ...produced })).toString('hex'),
    );
  });
});
