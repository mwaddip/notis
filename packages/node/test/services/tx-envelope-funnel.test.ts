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

async function importDb() {
  return (await import('../../src/store/db.js')) as {
    initDb: (path: string) => void;
    closeDb: () => void;
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown, postLockTarget?: string) => void;
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
    const utxo = await importUtxo();

    const alice = makeTestIdentity();
    const mallory = makeTestIdentity();
    const aliceBox = makeKarmaBox(100n, alice.userId, 0, 0);
    const malloryBox = makeKarmaBox(40n, mallory.userId, 0, 1);
    utxo.insertBox(aliceBox);
    utxo.insertBox(malloryBox);

    const valid = karmaSelfSpend(alice, aliceBox);

    // Envelope-invalid but still hashable and encodable, so the block's Merkle
    // commitment over it is honest: an UPPERCASE key in `signatures` names no
    // public key any signer emits. `signatures` is the natural home for the
    // defect — the envelope gate types it, and it sits outside the txId
    // preimage entirely (signatures are Ed25519 *over* the id), so the
    // transaction stays hashable while staying envelope-invalid.
    const malformed = karmaSelfSpend(mallory, malloryBox);
    malformed.signatures = {
      [Buffer.from(mallory.userId).toString('hex').toUpperCase()]: new Uint8Array(64),
    };

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
          w.includes('Invalid tx envelope: signatures key must be 64 lowercase hex characters'),
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

  it('the envelope gate fires ahead of the hasher, so an unhashable tx is a stated rejection', async () => {
    // The gate's placement is the property here, not the verdict. `computeTxId`
    // sits outside the decode loop's local try, so an envelope it cannot hash
    // would reach the funnel's totality catch and be logged as an "unexpected
    // failure" — a rejection the node cannot explain. The gate running first is
    // what keeps the same refusal stated.
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();

    const alice = makeTestIdentity();
    const aliceBox = makeKarmaBox(100n, alice.userId, 0, 0);
    utxo.insertBox(aliceBox);
    const valid = karmaSelfSpend(alice, aliceBox);

    const block = await makeApplicableBlock({ utxoTxs: [valid] });

    // Swap the committed body for an envelope `computeTxId` cannot hash at all.
    // `utxoTxRoot` commits the tx IDS only and the validator signature covers
    // the header, so the block stays internally consistent — the id simply no
    // longer matches its body, which is the malicious-producer shape.
    //
    // The defect must be one the envelope gate DOES catch and the hasher also
    // chokes on: that pairing is what makes the ordering observable. An
    // uppercase input id is both — `inputs` is `arr(ids, b32)`, so it has no
    // encoding, and the envelope pins the same 64-lowercase-hex domain.
    const poison = karmaSelfSpend(alice, aliceBox);
    poison.inputs = [aliceBox.id!.toUpperCase()];
    expect(checkTxEnvelope(poison).valid, 'the gate must reject poison').toBe(false);
    expect(() => computeTxId(poison)).toThrow();
    block.utxoTxTree.utxoTxs[0] = encodeTx(poison);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const applied = (await importBlockApply()).applyOrderingBlock(block);
    const warnings = warn.mock.calls.map((c) => String(c[0]));
    const errors = errSpy.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    errSpy.mockRestore();

    expect(applied).toBe(false);
    expect(
      warnings.some((w) => w.includes('has a malformed envelope')),
      `envelope rejection missing; got ${JSON.stringify(warnings)}`,
    ).toBe(true);
    // The discriminator: the hasher was never reached.
    expect(errors.filter((e) => e.includes('unexpected failure during apply'))).toEqual([]);

    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(utxo.getBox(aliceBox.id!)).not.toBeNull();
  });

  it('an out-of-domain output field is a stated rejection, not the totality catch', async () => {
    // D6. `checkTxEnvelope` deliberately does not type output entries, so an
    // output field outside the encoder's domain reaches a THROWING writer
    // inside `computeTxId` — `vlqU64` for `post_lock.originalValue` here, which
    // refuses a non-bigint. `checkOutputShape` between the two is what converts
    // that throw into a refusal the node can name (NODE_INTERFACE → "The output
    // domain check").
    //
    // The poison rides in as spliced bytes for a structural reason, not for
    // convenience: a throwing writer means the transaction cannot be hashed, so
    // no honest producer could have committed it in the first place.
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();

    const alice = makeTestIdentity();
    const aliceBox = makeKarmaBox(100n, alice.userId, 0, 0);
    utxo.insertBox(aliceBox);
    const valid = karmaSelfSpend(alice, aliceBox);

    const block = await makeApplicableBlock({ utxoTxs: [valid] });

    const poison = karmaSelfSpend(alice, aliceBox);
    poison.outputs = [
      {
        boxType: 'post_lock',
        value: 100n,
        originalValue: '100', // vlqU64 THROWS on a string
        owner: alice.userId,
      },
    ] as unknown as UtxoTransaction['outputs'];
    // Clears the envelope — which types `inputs`, `signatures`,
    // `protocolVersion` and `likeTarget`, and stops at `Array.isArray` for
    // outputs — and then throws in the hasher. That pair is what makes this the
    // arm under test rather than the one above.
    expect(checkTxEnvelope(poison)).toEqual({ valid: true });
    expect(() => computeTxId(poison)).toThrow();
    block.utxoTxTree.utxoTxs[0] = encodeTx(poison);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const applied = (await importBlockApply()).applyOrderingBlock(block);
    const warnings = warn.mock.calls.map((c) => String(c[0]));
    const errors = errSpy.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    errSpy.mockRestore();

    expect(applied).toBe(false);
    expect(
      warnings.filter(
        (w) => w.includes('has an out-of-domain output') && w.includes('originalValue'),
      ),
      `output-domain rejection missing; got ${JSON.stringify(warnings)}`,
    ).toHaveLength(1);
    expect(errors.filter((e) => e.includes('unexpected failure during apply'))).toEqual([]);

    const ordering = await importOrdering();
    expect(ordering.getOrderingBlock(1)).toBeNull();
    expect(utxo.getBox(aliceBox.id!)).not.toBeNull();
  });

  it('a declared id the bytes do not produce rejects the block', async () => {
    // The arm the obligation is named for: the body decodes, the envelope is
    // clean, the outputs are in domain — and the id beside it still belongs to
    // different bytes.
    const db = await importDb();
    db.initDb(':memory:');
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
    expect(checkTxEnvelope(substituted)).toEqual({ valid: true });
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
    const corrupt = {
      ...good,
      utxoTxTree: {
        ...good.utxoTxTree,
        utxoTxs: [new Uint8Array([0xff, 0xff, 0xff])],
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

    expect(checkTxEnvelope(forged)).toEqual({ valid: true });

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
