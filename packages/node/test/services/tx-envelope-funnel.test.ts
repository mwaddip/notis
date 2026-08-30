// ---------------------------------------------------------------------------
// The embedded-tx proof obligation at the block funnel (`block-apply.ts`, the
// decode loop over `utxoTxTree.utxoTxIds`).
//
// The rule this file pins (NODE_INTERFACE → "Embedded transactions: a mismatch
// rejects the block"): every declared `utxoTxId` must be proven to be the id of
// the bytes carried beside it, and an arm that cannot complete that proof
// rejects the BLOCK. A body that does not match its committed ids would
// otherwise apply different state under one block hash.
//
// It is a property, not a list of arms, so the cases below are organised by
// *where the proof breaks down* rather than by arm: unreadable bytes, an
// envelope the hasher cannot read, an output field outside the encoder's
// domain, and a declared id the bytes do not produce. The last case is the
// separate constraint that keeps the verdict attached to the bytes rather than
// to the header hash.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  computeTxId,
  encodeTx,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import type { KarmaBox, OrderingBlock, UtxoTransaction, AnyBox } from '@dagsocial/types';
import type { BlockJournal } from '../../src/store/journal.js';
import type { TestIdentity } from '../helpers.js';
import {
  makeTestIdentity,
  makeKarmaBox,
  signTransaction,
  makeApplicableBlock,
} from '../helpers.js';
// Pure and stateless, so one static instance is safe alongside this file's
// module resets.
import { checkTxEnvelope } from '../../src/services/utxo-engine.js';

// checkTxEnvelope takes the judged-for height and the era schedule
// (NODE_INTERFACE → validateTx). These envelope-shape tests use the single-era
// default; a version-1 transaction passes the era check at any height.
const checkEnvelope = (tx: unknown) => checkTxEnvelope(tx, 0, [{ version: 1, fromHeight: 0 }]);

async function importDb() {
  return (await import('../../src/store/db.js')) as {
    initDb: (path: string) => void;
    closeDb: () => void;
    getDb: () => import('better-sqlite3').Database;
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown) => void;
    getBox: (boxId: string) => AnyBox | null;
  };
}

async function importBlockApply() {
  return (await import('../../src/services/block-apply.js')) as unknown as {
    applyOrderingBlock: (block: OrderingBlock) => boolean;
  };
}

async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as {
    getCurrentHeight: () => number;
    getOrderingBlock: (height: number) => OrderingBlock | null;
  };
}

async function importJournalStore() {
  return (await import('../../src/store/journal.js')) as {
    getBlockJournal: (height: number) => BlockJournal | null;
    isBlockJournalOpen: () => boolean;
  };
}

/** A conserving, signed karma self-spend over `box`. */
function karmaSelfSpend(id: TestIdentity, box: KarmaBox): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [box.id!],
    outputs: [
      {
        boxType: 'karma',
        value: box.value,
        createdAtBlock: 0,
        owner: id.userId,
      } as unknown as KarmaBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, id.privateKey, Buffer.from(id.userId).toString('hex'));
  return tx;
}

// ---------------------------------------------------------------------------
// The `as unknown as KarmaBox` casts below are DELIBERATE — same reason as
// `tx-envelope.test.ts`: the funnel's job is refusing a malformed embedded
// transaction, so the fixture has to be malformed. Not a typing defect.
// ---------------------------------------------------------------------------
describe('block funnel — the embedded-tx proof obligation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('a malformed envelope rejects the block, and the valid tx beside it does not land', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();

    const alice = makeTestIdentity();
    const mallory = makeTestIdentity();
    const aliceBox = makeKarmaBox(100n, alice.userId, 0, 0);
    const malloryBox = makeKarmaBox(40n, mallory.userId, 0, 1);
    utxo.insertBox(aliceBox);
    utxo.insertBox(malloryBox);

    const valid = karmaSelfSpend(alice, aliceBox);

    // ⛔ **Envelope-invalid AND encodable, which is now a narrow class.** The
    // codec bounds every field it writes, so a domain violation has no encoding
    // at all and can never reach a block. What survives is the envelope's one
    // VALUE rule: `protocolVersion` is `vlqU`, so a wrong version encodes and
    // hashes perfectly and the gate's strict equality is what refuses it. The
    // block's Merkle commitment over it is therefore honest, which is what makes
    // this the arm under test rather than the decode arm.
    const malformed = karmaSelfSpend(mallory, malloryBox);
    malformed.protocolVersion = PROTOCOL_VERSION + 1;
    signTransaction(
      malformed, mallory.privateKey, Buffer.from(mallory.userId).toString('hex'),
    );
    expect(checkEnvelope(malformed).valid).toBe(false);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const block = await makeApplicableBlock({ utxoTxs: [valid, malformed] });
    const applied = (await importBlockApply()).applyOrderingBlock(block);

    const warnings = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();

    expect(applied).toBe(false);

    // A STATED rejection naming the height and the transaction, not a verdict
    // inferred from the boolean.
    expect(
      warnings.filter(
        (w) =>
          w.includes(
            `Rejected block height=1: embedded UTXO tx ${computeTxId(malformed)} ` +
            `has a malformed envelope`,
          ) &&
          w.includes('Invalid tx envelope: protocolVersion must be'),
      ),
      `envelope rejection missing; got ${JSON.stringify(warnings)}`,
    ).toHaveLength(1);

    // The block is not on the chain and NOTHING it carried survived — the
    // well-formed transaction beside the malformed one included. That is the
    // half a per-tx skip gave away: the state a node reaches must not depend on
    // which bodies its peers happened to send.
    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(0);
    expect(utxo.getBox(aliceBox.id!)).not.toBeNull();
    expect(utxo.getBox(malloryBox.id!)).not.toBeNull();

    // No half-built journal left behind.
    const journal = await importJournalStore();
    expect(journal.getBlockJournal(1)).toBeNull();
    expect(journal.isBlockJournalOpen()).toBe(false);
  });

  it('an unhashable transaction has no encoding either, so it never reaches the funnel', async () => {
    // ⛔ **THE GATE'S ORDER AGAINST THE HASHER IS UNOBSERVABLE ON THE BLOCK
    // PATH, AND THE REASON IS STRONGER THAN AN ORDER.** `encodeTx` and
    // `computeTxId` write through the same throwing writers, so anything a
    // producer can put into `utxoTxs` is hashable, and anything unhashable is
    // unencodable — it cannot be committed, spliced or relayed
    // (TYPES_INTERFACE → Totality).
    //
    // ⚠ **The gate is not thereby redundant**, and this is the half that keeps
    // it honest: it still answers on the HTTP edge, where `jsonToTx` builds the
    // object and no codec bounds it (VALIDATION_INTERFACE → What a decoder
    // subsumes depends on the ENTRY PATH; node has both a store and an HTTP edge).
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();

    const alice = makeTestIdentity();
    const aliceBox = makeKarmaBox(100n, alice.userId, 0, 0);
    utxo.insertBox(aliceBox);

    const poison = karmaSelfSpend(alice, aliceBox);
    poison.inputs = [aliceBox.id!.toUpperCase()];

    // The gate would refuse it …
    expect(checkEnvelope(poison).valid, 'the gate must reject poison').toBe(false);
    // … and it never gets the chance, because the bytes do not exist.
    expect(() => computeTxId(poison)).toThrow();
    expect(() => encodeTx(poison)).toThrow();
  });

  it('an out-of-domain output field is unencodable too, on the same argument', async () => {
    // The output half of the case above. `originalValue` is `vlqU64`, whose
    // writer throws rather than sentinelling, so a transaction carrying a string
    // there is inexpressible on the wire — no producer can commit it and no
    // relay can splice it.
    //
    // ⚠ **`checkOutputShape` still answers on the HTTP edge**, which is where
    // the substantive coverage for this rule lives
    // (`field-type-pin.test.ts` → per-field type rejects).
    const alice = makeTestIdentity();
    const aliceBox = makeKarmaBox(100n, alice.userId, 0, 0);

    const poison = karmaSelfSpend(alice, aliceBox);
    poison.outputs = [
      {
        boxType: 'vouch_escrow',
        value: 100n,
        createdAtBlock: 0,
        owner: new Uint8Array(5), // writeBytesNOrThrow expects 32
        releaseAtBlock: 100,
      },
    ] as unknown as UtxoTransaction['outputs'];

    // The envelope clears it — it types `inputs`, `signatures`,
    // `protocolVersion` and `likeTarget`, and stops at `Array.isArray` for
    // outputs — and the writers refuse it anyway.
    expect(checkEnvelope(poison)).toEqual({ valid: true });
    expect(() => computeTxId(poison)).toThrow();
    expect(() => encodeTx(poison)).toThrow();
  });

  it('a declared id the bytes do not produce rejects the block', async () => {
    // The arm the obligation is named for: the body decodes, the envelope is
    // clean, the outputs are in domain — and the id beside it still belongs to
    // different bytes.
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();

    const alice = makeTestIdentity();
    const bob = makeTestIdentity();
    const aliceBox = makeKarmaBox(100n, alice.userId, 0, 0);
    const bobBox = makeKarmaBox(70n, bob.userId, 0, 1);
    utxo.insertBox(aliceBox);
    utxo.insertBox(bobBox);

    const declared = karmaSelfSpend(alice, aliceBox);
    const block = await makeApplicableBlock({ utxoTxs: [declared] });

    // A wholly different, individually valid transaction under the declared
    // id. Every gate ahead of the id check passes, so this reaches the
    // comparison and nothing else refuses it.
    const substituted = karmaSelfSpend(bob, bobBox);
    expect(checkEnvelope(substituted)).toEqual({ valid: true });
    expect(computeTxId(substituted)).not.toBe(computeTxId(declared));
    block.utxoTxTree.utxoTxs[0] = encodeTx(substituted);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const applied = (await importBlockApply()).applyOrderingBlock(block);
    const warnings = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();

    expect(applied).toBe(false);
    expect(
      warnings.filter(
        (w) =>
          w.includes(
            `embedded UTXO tx ${computeTxId(declared)} declares an id its bytes ` +
            `do not produce`,
          ) && w.includes(computeTxId(substituted)),
      ),
      `id-mismatch rejection missing; got ${JSON.stringify(warnings)}`,
    ).toHaveLength(1);

    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    // Neither body's input moved.
    expect(utxo.getBox(aliceBox.id!)).not.toBeNull();
    expect(utxo.getBox(bobBox.id!)).not.toBeNull();
  });

  it('rejection is of the BYTES: a good body under the same header hash still applies', async () => {
    // NODE_INTERFACE → "Rejection is of BYTES, not of the block hash". Nothing
    // implements a hash-keyed negative cache today, which is precisely why this
    // test exists: the constraint binds code not yet written, and the day
    // someone caches "block H is invalid" this is what fails.
    //
    // The attack and the test are the same shape. `utxoTxRoot` commits
    // `utxoTxIds` but NOT `utxoTxs`, so a good block and a body-corrupted block
    // genuinely share one header hash — an attacker who races the honest
    // producer needs no re-mine and no re-sign.
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();

    const alice = makeTestIdentity();
    const aliceBox = makeKarmaBox(100n, alice.userId, 0, 0);
    utxo.insertBox(aliceBox);
    const tx = karmaSelfSpend(alice, aliceBox);

    const good = await makeApplicableBlock({ utxoTxs: [tx] });
    const goodHash = blockHash(good.header);
    expect(goodHash).not.toBeNull();

    // Same header object, corrupted body. Bytes that are not a transaction at
    // all, so the decode arm is the one that fires.
    // ⚠ Only the FIRST body is replaced: the settlement rides `utxoTxs` as the
    // last entry, and dropping it would fail the alignment check ahead of the
    // decode arm this case is about.
    const corrupt = {
      ...good,
      utxoTxTree: {
        ...good.utxoTxTree,
        utxoTxs: good.utxoTxTree.utxoTxs.map(
          (b, i) => (i === 0 ? new Uint8Array([0xff, 0xff, 0xff]) : b),
        ),
      },
    } as OrderingBlock;

    // Without this the test proves nothing: the two blocks must be
    // indistinguishable at the header the node would key a cache on.
    expect(blockHash(corrupt.header)).toBe(goodHash);

    const blockApply = await importBlockApply();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(blockApply.applyOrderingBlock(corrupt)).toBe(false);
    const warnings = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    expect(
      warnings.some((w) => w.includes('did not decode')),
      `decode rejection missing; got ${JSON.stringify(warnings)}`,
    ).toBe(true);

    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(0);

    // The half that matters: the rejection left no residue, so the honest body
    // for that same hash is still acceptable. The funnel rolls SQLite back and
    // restores the AVL prover, which is why the good block's committed
    // `stateRoot` still matches the state it now produces.
    expect(blockApply.applyOrderingBlock(good)).toBe(true);
    expect(ordering.getCurrentHeight()).toBe(1);
    expect(ordering.getOrderingBlock(1)).not.toBeNull();
    expect(utxo.getBox(aliceBox.id!)).toBeNull(); // the good body's tx applied

    const journal = await importJournalStore();
    expect(journal.getBlockJournal(1)!.appliedUtxoTxs.map((t) => t.txId)).toEqual([
      computeTxId(tx),
    ]);
    expect(journal.isBlockJournalOpen()).toBe(false);
  });

  it('non-vacuity: the obligation is about PROOF, not about strictness', async () => {
    // The funnel did not simply get harsher. A transaction whose envelope,
    // outputs and id all check out has discharged the obligation — it is then
    // `validateTx` that judges it, at a different point in the loop and for a
    // different reason. An unsigned spend of a live box rejects the block here
    // as it always has, so the cases above measure the obligation rather than a
    // blanket refusal.
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();

    const alice = makeTestIdentity();
    const victim = makeTestIdentity();
    const aliceBox = makeKarmaBox(100n, alice.userId, 0, 0);
    const victimBox = makeKarmaBox(50n, victim.userId, 0, 1);
    utxo.insertBox(aliceBox);
    utxo.insertBox(victimBox);

    const valid = karmaSelfSpend(alice, aliceBox);
    const forged = karmaSelfSpend(victim, victimBox);
    forged.signatures = {}; // well-formed envelope, no authorisation

    expect(checkEnvelope(forged)).toEqual({ valid: true });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const block = await makeApplicableBlock({ utxoTxs: [valid, forged] });
    const applied = (await importBlockApply()).applyOrderingBlock(block);
    const warnings = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();

    expect(applied).toBe(false);
    // Rejected for what it says, not for how it is shaped.
    expect(warnings.some((w) => w.includes('failed re-validation'))).toBe(true);
    expect(warnings.some((w) => w.includes('has a malformed envelope'))).toBe(false);

    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(ordering.getCurrentHeight()).toBe(0);
    expect(utxo.getBox(aliceBox.id!)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Envelope exclusivity — at most one payload field
// (NODE_INTERFACE → Transaction envelope shape)
// ---------------------------------------------------------------------------

describe('envelope exclusivity — at most one payload field', () => {
  const INPUT = 'a'.repeat(64);
  const base = {
    inputs: [INPUT],
    outputs: [],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  const LIKE_TARGET = 'b'.repeat(64);
  const POST_COMMIT = {
    contentHash: new Uint8Array(32),
    author: new Uint8Array(32),
    parentRefs: [],
    protocolVersion: PROTOCOL_VERSION,
    type: 'regular' as const,
  };
  const PRUNE = { rootPostHash: 'c'.repeat(64) };
  const WITHDRAW = { postId: 'd'.repeat(64) };

  it('like + post (with a price box) is refused', () => {
    const tx = { ...base, likeTarget: LIKE_TARGET, post: POST_COMMIT };
    const r = checkEnvelope(tx);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/likeTarget/);
    expect(r.error).toMatch(/post/);
  });

  it('like + post (without a price box) is refused', () => {
    const tx = { ...base, outputs: [], likeTarget: LIKE_TARGET, post: POST_COMMIT };
    const r = checkEnvelope(tx);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/likeTarget.*post|post.*likeTarget/);
  });

  it('like + post (foreign author on the commit) is refused at the envelope', () => {
    const foreignPost = { ...POST_COMMIT, author: new Uint8Array(32).fill(0xff) };
    const tx = { ...base, likeTarget: LIKE_TARGET, post: foreignPost };
    const r = checkEnvelope(tx);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/likeTarget/);
    expect(r.error).toMatch(/post/);
  });

  it('like + prune is refused', () => {
    const tx = { ...base, likeTarget: LIKE_TARGET, prune: PRUNE };
    const r = checkEnvelope(tx);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/likeTarget/);
    expect(r.error).toMatch(/prune/);
  });

  it('post + prune is refused', () => {
    const tx = { ...base, post: POST_COMMIT, prune: PRUNE };
    const r = checkEnvelope(tx);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/post/);
    expect(r.error).toMatch(/prune/);
  });

  it('post + withdraw is refused', () => {
    const tx = { ...base, post: POST_COMMIT, postWithdraw: WITHDRAW };
    const r = checkEnvelope(tx);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/post/);
    expect(r.error).toMatch(/postWithdraw/);
  });

  it('prune + withdraw is refused', () => {
    const tx = { ...base, prune: PRUNE, postWithdraw: WITHDRAW };
    const r = checkEnvelope(tx);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/prune/);
    expect(r.error).toMatch(/postWithdraw/);
  });
});
