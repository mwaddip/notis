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
import { generateKeyPairSync, sign as cryptoSign, createHash, type KeyObject } from 'crypto';
import {
  computeBoxId,
  computeTxId,
  POST_LOCK_THREAD_COST,
  VOUCH_KARMA_AMOUNT,
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
} from '@dagsocial/types';
import type { AnyBox, KarmaBox, CreditBox, Post, UtxoTransaction } from '@dagsocial/types';
import Database from 'better-sqlite3';
import {
  fixtureProvenance,
  makePost,
  makeTestIdentity,
  seedAsOneTx,
  seedProvenance,
  type Stored,
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
  hasActiveVouchCooldown as storeHasActiveVouchCooldown,
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
      hasActiveVouchCooldown: storeHasActiveVouchCooldown,
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
        owner: ownerPubKey,
      },
      1,
    );
    storeInsertBox(box);
    return box;
  }

  // `post` rides here rather than at the call sites because a `PostLockBox`
  // output without it fails the engine's post biconditional (NODE_INTERFACE →
  // Post transactions).
  function signedTx(inputs: string[], outputs: unknown[], post?: Post): UtxoTransaction {
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
      owner: ownerPubKey,
    };
  }

  it('a post_lock carrying a guard key is rejected, nothing applied', () => {
    // No box declares `guard` (NODE_INTERFACE → Legal box transitions), so the
    // retired field is a stray key like any other and cannot be smuggled back
    // into the id preimage.
    const karma = seedKarma(100n);
    const lyingLock = {
      boxType: 'post_lock',
      value: POST_LOCK_THREAD_COST,
      originalValue: POST_LOCK_THREAD_COST,
      owner: ownerPubKey,
      guard: 'block_apply',
    };
    const r = validateTx(
      deps,
      signedTx([karma.id!], [karmaChange(100n - POST_LOCK_THREAD_COST), lyingLock]),
      10,
    );
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/unexpected key 'guard'/);
    // The input is untouched and no post_lock row exists.
    expect(deps.getBox(karma.id!)).not.toBeNull();
    const locks = db
      .prepare("SELECT COUNT(*) AS n FROM utxo_boxes WHERE box_type = 'post_lock'")
      .get() as { n: number | bigint };
    expect(Number(locks.n)).toBe(0);
  });

  it('before-leg probe 2, now closed: stray key is rejected, nothing applied', () => {
    const karma = seedKarma(100n);
    const strayLock = {
      boxType: 'post_lock',
      value: POST_LOCK_THREAD_COST,
      originalValue: POST_LOCK_THREAD_COST,
      owner: ownerPubKey,
      note: 'x',
    };
    const r = validateTx(
      deps,
      signedTx([karma.id!], [karmaChange(100n - POST_LOCK_THREAD_COST), strayLock]),
      10,
    );
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/unexpected key 'note'/);
    expect(deps.getBox(karma.id!)).not.toBeNull();
  });

  it('honest karma → karma + post_lock applies and round-trips id-clean', () => {
    const karma = seedKarma(100n);
    const lock = {
      boxType: 'post_lock',
      value: POST_LOCK_THREAD_COST,
      originalValue: POST_LOCK_THREAD_COST,
      owner: ownerPubKey,
    };
    const tx = signedTx(
      [karma.id!],
      [karmaChange(100n - POST_LOCK_THREAD_COST), lock],
      makePost(ownerPubKey, 'honest lock payload'),
    );
    const r = validateTx(deps, tx, 10);
    expect(r.valid, r.error).toBe(true);
    applyTx(deps, tx, r.computedOutputs!, 10);
    for (const out of r.computedOutputs!) expectIdClean(out.id!);
  });

  it('honest karma → karma + invite + bond applies and round-trips id-clean', () => {
    const karma = seedKarma(100n);
    const invitee = new Uint8Array(32).fill(0xaa);
    const invite = {
      boxType: 'invite',
      value: 0n,
      inviterId: ownerPubKey,
      inviteePublicKey: invitee,
    };
    const bond = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      inviterId: ownerPubKey,
      inviteePublicKey: invitee,
    };
    const tx = signedTx(
      [karma.id!],
      [karmaChange(100n - INVITE_BOND_KARMA), invite, bond],
    );
    const r = validateTx(deps, tx, 10);
    expect(r.valid, r.error).toBe(true);
    applyTx(deps, tx, r.computedOutputs!, 10);
    for (const out of r.computedOutputs!) expectIdClean(out.id!);
  });

  it('honest credit → credit (lockedUntilBlock present) applies and round-trips id-clean', () => {
    const credit = seedCredit(40n);
    const out = {
      boxType: 'credit',
      value: 40n,
      owner: ownerPubKey,
      lockedUntilBlock: 500,
    };
    const tx = signedTx([credit.id!], [out]);
    const r = validateTx(deps, tx, 10);
    expect(r.valid, r.error).toBe(true);
    applyTx(deps, tx, r.computedOutputs!, 10);
    for (const o of r.computedOutputs!) expectIdClean(o.id!);
  });

  it('honest karma → karma + vouch (and karma with decayBurn) applies and round-trips id-clean', () => {
    const karma = seedKarma(100n);
    const vouch = {
      boxType: 'vouch',
      value: VOUCH_KARMA_AMOUNT,
      voucherId: ownerPubKey,
      targetId: new Uint8Array(32).fill(0xcc),
    };
    const change = { ...karmaChange(100n - VOUCH_KARMA_AMOUNT), decayBurn: true };
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

  it('class-4a mutant, now closed: hex-string post_lock owner is rejected, nothing applied', () => {
    const karma = seedKarma(100n);
    const lyingLock: Record<string, unknown> = {
      boxType: 'post_lock',
      value: POST_LOCK_THREAD_COST,
      originalValue: POST_LOCK_THREAD_COST,
      owner: ownerPubKey,
    };
    const tx = signedTx([karma.id!], [karmaChange(100n - POST_LOCK_THREAD_COST), lyingLock]);
    // The lie is stamped AFTER signing. `owner` is `b32` from a `Uint8Array` in
    // the box-id preimage, so a hex *string* has no encoding at all now and
    // `signedTx` would throw before `checkOutputShape` saw it. That is itself
    // the class-4a defect closing a second time, one layer lower: what used to
    // be "stored, then reconstructed to different bytes" is now "cannot be
    // hashed". The gate is still what this test measures, so the fixture has to
    // reach it — `checkOutputShape` is step 4, signature reads are step 6.
    lyingLock['owner'] = Buffer.from(ownerPubKey).toString('hex'); // 64-char string, not bytes
    const r = validateTx(deps, tx, 10);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/\(post_lock\): field 'owner' must be a 32-byte Uint8Array/);
    // On the pre-pin tree this box was stored and its row reconstructed to
    // DIFFERENT bytes (Array.from over the string, chars coerced to numbers) —
    // computeBoxId(rowToBox(row)) !== row.id, permanently. Now: no row at all.
    expect(deps.getBox(karma.id!)).not.toBeNull();
    const locks = db
      .prepare("SELECT COUNT(*) AS n FROM utxo_boxes WHERE box_type = 'post_lock'")
      .get() as { n: number | bigint };
    expect(Number(locks.n)).toBe(0);
  });

  it('class-4b mutant, now closed: -0 in a number field is rejected (cbor float at insert, JSON 0 on read)', () => {
    const credit = seedCredit(40n);
    const out = {
      boxType: 'credit',
      value: 40n,
      owner: ownerPubKey,
      lockedUntilBlock: -0,
    };
    const r = validateTx(deps, signedTx([credit.id!], [out]), 10);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/field 'lockedUntilBlock'.*got -0/);
  });

  it('class-4c mutant, now closed: an invite pair with HEX-STRING keys is rejected; the honest pair round-trips id-clean', () => {
    // The class in the form it now takes. Both boxes carry `inviteePublicKey`,
    // and the create arm pairs them by comparing
    // `Buffer.from(x).toString('hex')` — which two identical hex STRINGS satisfy
    // just as well as two identical byte arrays. So the arm cannot catch this:
    // the pairing check passes, and the wrong-typed field reaches
    // `writeBytesNOrThrow` inside `computeTxId` at the last line of
    // `validateTx` — a throw on adversary-supplied input, which the no-panic
    // rule forbids. The schema's `bytes32` is what has to reject it.
    const karma = seedKarma(100n);
    const inviteeHex = 'bb'.repeat(32);
    const lyingPair = (key: unknown) => [
      karmaChange(100n - INVITE_BOND_KARMA),
      {
        boxType: 'invite', value: 0n, inviterId: ownerPubKey,
        inviteePublicKey: key,
      },
      {
        boxType: 'bond', value: INVITE_BOND_KARMA, inviterId: ownerPubKey,
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
