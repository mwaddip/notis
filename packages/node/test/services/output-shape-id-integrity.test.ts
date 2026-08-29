/**
 * The id-integrity discriminator for the output-shape pin: an output accepted
 * by `validateTx` always satisfies `computeBoxId(rowToBox(row)) === row.id`
 * after apply.
 *
 * This is the invariant the check exists for (ARCHITECTURE → "Canonical bytes
 * are the record"). Without the pin a stray key is accepted, hashed verbatim
 * into the box id and the AVL leaf, and then silently dropped by the store
 * round-trip, since `insertBox` types the columns — so the committed bytes and
 * every later reconstruction of the box permanently disagree. These tests hold
 * the door shut.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'crypto';
import {
  computeBoxId,
  computeTxId,
  POST_PRICE_THREAD,
  VOUCH_KARMA_AMOUNT,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
} from '@dagsocial/types';
import type { AnyBox, KarmaBox, CreditBox, PostCommit, UtxoTransaction } from '@dagsocial/types';
import Database from 'better-sqlite3';
import {
  makePostCommit,
  seedProvenance,
  type Stored,
  FIXTURE_BOND_KARMA,
} from '../helpers.js';
import {
  initDb,
  closeDb,
  getDb,
  getBox as storeGetBox,
  getIdentityRecord as storeGetIdentityRecord,
  getKarmaBox,
  getKarmaBoxes,
  insertBox as storeInsertBox,
  consumeBox as storeConsumeBox,
} from '../../src/store/index.js';
import { validateTx, applyTx } from '../../src/services/utxo-engine.js';
import type { UtxoEngineDeps } from '../../src/services/utxo-engine.js';
import { config } from '../../src/config.js';

function rawPublicKey(keyObj: KeyObject): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

describe('output-shape pin: id integrity of accepted outputs', () => {
  let db: Database.Database;
  let ownerPubKey: Uint8Array;
  let ownerPrivKey: KeyObject;
  let deps: UtxoEngineDeps;

  beforeEach(() => {
    initDb(':memory:');
    db = getDb();
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    ownerPubKey = rawPublicKey(publicKey);
    ownerPrivKey = privateKey;
    deps = {
      getBox: (id: string): AnyBox | null => {
        const box = storeGetBox(id);
        if (!box) return null;
        const r = db
          .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
          .get(id) as { spent_at_block: number | null } | undefined;
        return r && r.spent_at_block === null ? box : null;
      },
      getIdentityRecord: storeGetIdentityRecord,
      insertBox: (box: AnyBox) => storeInsertBox(box),
      consumeBox: (id: string, atBlock: number) => storeConsumeBox(id, atBlock),
      getKarmaBox: (owner: Uint8Array) => getKarmaBox(owner),
      getKarmaValue: (owner: Uint8Array) =>
        getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n),
      hasActiveVouchEscrow: () => false,
      vouchCooldownBlocks: 2,
      inviteBondMin: config.inviteBondMin,
      inviteBondMax: config.inviteBondMax,
      decayCfg: {
        staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
        decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
        decayAmount: KARMA_DECAY_AMOUNT,
        karmaMinimum: KARMA_MINIMUM,
      },
      storageRentPeriodBlocks: 40,
      getBoxProvenance: () => null,
      getTopologyAuthor: () => null,
      runInTransaction: (fn: () => void) => {
        (db.transaction(fn) as () => void)();
      },
    };
  });

  afterEach(() => closeDb());

  function seedKarma(value: bigint): Stored<KarmaBox> {
    const box = seedProvenance<KarmaBox>(
      {
        boxType: 'karma',
        value,
        createdAtBlock: 0,
        owner: ownerPubKey,
      },
      1,
    );
    storeInsertBox(box);
    return box;
  }

  function seedCredit(value: bigint): Stored<CreditBox> {
    const box = seedProvenance<CreditBox>(
      {
        boxType: 'credit',
        value,
        createdAtBlock: 0,
        owner: ownerPubKey,
      },
      1,
    );
    storeInsertBox(box);
    return box;
  }

  // `post` rides here rather than at the call sites because a `KarmaPriceBox`
  // output without it fails the engine's post biconditional (NODE_INTERFACE →
  // Post transactions).
  function signedTx(inputs: string[], outputs: unknown[], post?: PostCommit): UtxoTransaction {
    const tx: UtxoTransaction = {
      inputs,
      outputs: outputs as UtxoTransaction['outputs'],
      signatures: {},
      protocolVersion: 1,
      ...(post ? { post } : {}),
    };
    const hash = Buffer.from(computeTxId(tx), 'hex');
    tx.signatures[Buffer.from(ownerPubKey).toString('hex')] = new Uint8Array(
      cryptoSign(null, hash, ownerPrivKey),
    );
    return tx;
  }

  /**
   * The discriminator: what the store hands back (rowToBox) re-derives the
   * row's own id. Reads through the raw row so a spent box would count too.
   */
  function expectIdClean(boxId: string): void {
    const fromStore = storeGetBox(boxId);
    expect(fromStore, `box ${boxId} not found in store`).not.toBeNull();
    const { id: _id, ...rest } = fromStore!;
    expect(computeBoxId(rest)).toBe(boxId);
  }

  function karmaChange(value: bigint): Record<string, unknown> {
    return {
      boxType: 'karma',
      value,
      createdAtBlock: 0,
      owner: ownerPubKey,
    };
  }

  it('a karma_price carrying a guard key is rejected, nothing applied', () => {
    const karma = seedKarma(100n);
    const lyingPrice = {
      boxType: 'karma_price',
      value: POST_PRICE_THREAD,
      createdAtBlock: 0,
      guard: 'block_apply',
    };
    const r = validateTx(
      deps,
      signedTx([karma.id!], [karmaChange(100n - POST_PRICE_THREAD), lyingPrice],
        makePostCommit(ownerPubKey, 'guard key payload')),
      10,
    );
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/unexpected key 'guard'/);
    expect(deps.getBox(karma.id!)).not.toBeNull();
    const prices = db
      .prepare("SELECT COUNT(*) AS n FROM utxo_boxes WHERE box_type = 'karma_price'")
      .get() as { n: number | bigint };
    expect(Number(prices.n)).toBe(0);
  });

  it('before-leg probe 2, now closed: stray key is rejected, nothing applied', () => {
    const karma = seedKarma(100n);
    const strayPrice = {
      boxType: 'karma_price',
      value: POST_PRICE_THREAD,
      createdAtBlock: 0,
      note: 'x',
    };
    const r = validateTx(
      deps,
      signedTx([karma.id!], [karmaChange(100n - POST_PRICE_THREAD), strayPrice],
        makePostCommit(ownerPubKey, 'stray key payload')),
      10,
    );
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/unexpected key 'note'/);
    expect(deps.getBox(karma.id!)).not.toBeNull();
  });

  it('honest karma → karma + karma_price applies and round-trips id-clean', () => {
    const karma = seedKarma(100n);
    const price = {
      boxType: 'karma_price',
      value: POST_PRICE_THREAD,
      createdAtBlock: 0,
    };
    const tx = signedTx(
      [karma.id!],
      [karmaChange(100n - POST_PRICE_THREAD), price],
      makePostCommit(ownerPubKey, 'honest price payload'),
    );
    const r = validateTx(deps, tx, 10);
    expect(r.valid, r.error).toBe(true);
    applyTx(deps, tx, r.computedOutputs!, 10);
    for (const out of r.computedOutputs!) expectIdClean(out.id!);
  });

  it('honest karma → karma + bond applies and round-trips id-clean', () => {
    const karma = seedKarma(100n);
    const invitee = new Uint8Array(32).fill(0xaa);
    const bond = {
      boxType: 'bond',
      value: FIXTURE_BOND_KARMA,
      createdAtBlock: 0,
      inviterId: ownerPubKey,
      inviteePublicKey: invitee,
    };
    const tx = signedTx(
      [karma.id!],
      [karmaChange(100n - FIXTURE_BOND_KARMA), bond],
    );
    const r = validateTx(deps, tx, 10);
    expect(r.valid, r.error).toBe(true);
    applyTx(deps, tx, r.computedOutputs!, 10);
    for (const out of r.computedOutputs!) expectIdClean(out.id!);
  });

  it('honest credit → credit (lockedUntilBlock present) applies and round-trips id-clean', () => {
    const credit = seedCredit(40_000n);
    const out = {
      boxType: 'credit',
      value: 40_000n,
      createdAtBlock: 0,
      owner: ownerPubKey,
      lockedUntilBlock: 500,
    };
    const tx = signedTx([credit.id!], [out]);
    const r = validateTx(deps, tx, 10);
    expect(r.valid, r.error).toBe(true);
    applyTx(deps, tx, r.computedOutputs!, 10);
    for (const o of r.computedOutputs!) expectIdClean(o.id!);
  });

  it('honest karma → karma + vouch applies and round-trips id-clean', () => {
    const karma = seedKarma(100n);
    const vouch = {
      boxType: 'vouch',
      value: VOUCH_KARMA_AMOUNT,
      createdAtBlock: 10,
      voucherId: ownerPubKey,
      targetId: new Uint8Array(32).fill(0xcc),
    };
    const change = karmaChange(100n - VOUCH_KARMA_AMOUNT);
    const tx = signedTx([karma.id!], [change, vouch]);
    const r = validateTx(deps, tx, 10);
    expect(r.valid, r.error).toBe(true);
    applyTx(deps, tx, r.computedOutputs!, 10);
    for (const o of r.computedOutputs!) expectIdClean(o.id!);
  });

  // -------------------------------------------------------------------------
  // Field-type pin: the class-4 committed-byte-lie mutants, fed to the same
  // discriminator. Each was ACCEPTED on the pre-pin tree (the before-leg
  // probes): the store then either round-tripped different bytes than the id
  // committed to (4a), silently changed the value's encoding (4b), or kept a
  // wrong-typed field forever behind a clean id (4c).
  // -------------------------------------------------------------------------

  it('class-4a mutant, now closed: stray owner on karma_price is rejected, nothing applied', () => {
    const karma = seedKarma(100n);
    const lyingPrice: Record<string, unknown> = {
      boxType: 'karma_price',
      value: POST_PRICE_THREAD,
      createdAtBlock: 0,
      owner: ownerPubKey,
    };
    const r = validateTx(
      deps,
      signedTx([karma.id!], [karmaChange(100n - POST_PRICE_THREAD), lyingPrice],
        makePostCommit(ownerPubKey, 'class-4a payload')),
      10,
    );
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/unexpected key 'owner'/);
    expect(deps.getBox(karma.id!)).not.toBeNull();
    const prices = db
      .prepare("SELECT COUNT(*) AS n FROM utxo_boxes WHERE box_type = 'karma_price'")
      .get() as { n: number | bigint };
    expect(Number(prices.n)).toBe(0);
  });

  it('class-4b mutant, now closed: -0 in a number field is rejected (cbor float at insert, JSON 0 on read)', () => {
    const credit = seedCredit(40_000n);
    const out = {
      boxType: 'credit',
      value: 40_000n,
      createdAtBlock: 0,
      owner: ownerPubKey,
      lockedUntilBlock: -0,
    };
    const r = validateTx(deps, signedTx([credit.id!], [out]), 10);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/field 'lockedUntilBlock'.*got -0/);
  });

  it('class-4c mutant, now closed: a bond with a HEX-STRING key is rejected; the honest one round-trips id-clean', () => {
    // The class in the form it now takes. The invite arm compares
    // `Buffer.from(bond.inviterId).toString('hex')` against the karma input's
    // owner — which a hex STRING satisfies just as well as a byte array. So the
    // arm cannot catch this: its check passes, and the wrong-typed field reaches
    // `writeBytesNOrThrow` inside `computeTxId` at the last line of
    // `validateTx` — a throw on adversary-supplied input, which the no-panic
    // rule forbids. The schema's `bytes32` is what has to reject it.
    const karma = seedKarma(100n);
    const inviteeHex = 'bb'.repeat(32);
    const lyingPair = (key: unknown) => [
      karmaChange(100n - FIXTURE_BOND_KARMA),
      {
        boxType: 'bond', value: FIXTURE_BOND_KARMA,  createdAtBlock: 0,inviterId: ownerPubKey,
        inviteePublicKey: key,
      },
    ];

    // Unsigned deliberately, and it changes nothing about what is being shown:
    // `checkOutputShape` is step 4 and `checkAuthorization` — which is where a txId is
    // first computed — is step 6, so the schema answers before any signature is
    // consulted. It also has to be unsigned to build at all: signing means
    // hashing the transaction, so a builder that signs this shape throws on the
    // client instead of reaching the node.
    const lying = validateTx(deps, {
      inputs: [karma.id!],
      outputs: lyingPair(inviteeHex) as unknown as UtxoTransaction['outputs'],
      signatures: {},
      protocolVersion: 1,
    }, 10);
    expect(lying.valid).toBe(false);
    expect(lying.error).toMatch(/field 'inviteePublicKey' must be a 32-byte Uint8Array/);
    // Nothing applied: the karma input is still unspent.
    expect(deps.getBox(karma.id!)).not.toBeNull();

    // The honest pair — same shape, raw bytes — validates, applies, and every
    // output satisfies the discriminator.
    const honestOutputs = lyingPair(new Uint8Array(Buffer.from(inviteeHex, 'hex')));
    const honestTx = signedTx([karma.id!], honestOutputs);
    const honest = validateTx(deps, honestTx, 10);
    expect(honest.valid, honest.error).toBe(true);
    applyTx(deps, honestTx, honest.computedOutputs!, 10);
    for (const o of honest.computedOutputs!) expectIdClean(o.id!);
  });
});
