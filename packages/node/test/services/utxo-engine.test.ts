import {
  makePostCommit,
  seedAsOneTx,
  seedProvenance,
  type Stored,
  fixtureProvenance,
  FIXTURE_BOND_KARMA,
} from '../helpers.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import {
  computeCandidateBoxId,
  computeBoxId,
  computeTxId,
  LIKE_KARMA_COST,
  POST_LOCK_THREAD_COST,
  VOUCH_KARMA_AMOUNT,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
} from '@dagsocial/types';
import type {
  AnyBox,
  KarmaBox,
  LikeAccrualBox,
  BondBox,
  PostCommit,
  PostLockBox,
  VouchBox,
  AnyBoxCandidate,
  CandidateOf,
  CreditBox,
  FeeBox,
  VouchEscrowBox,
  UserId,
  UtxoTransaction,
} from '@dagsocial/types';
import Database from 'better-sqlite3';

import {
  initDb,
  closeDb,
  getDb,
  getBox as storeGetBox,
  getIdentityRecord as storeGetIdentityRecord,
  putIdentityRecord as storePutIdentityRecord,
  getKarmaBox,
  getKarmaBoxes,
  insertBox as storeInsertBox,
  consumeBox as storeConsumeBox,
} from '../../src/store/index.js';
import { validateTx, applyTx } from '../../src/services/utxo-engine.js';
import type { UtxoEngineDeps, UtxoResult } from '../../src/services/utxo-engine.js';
import { config } from '../../src/config.js';

/**
 * Local convenience wrapper that replaces the removed validateAndApplyTx.
 */
function validateAndApplyTx(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): UtxoResult {
  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) return result;
  applyTx(deps, tx, result.computedOutputs!, currentBlockHeight);
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract raw 32-byte Ed25519 public key from SPKI DER KeyObject. */
function rawPublicKey(keyObj: KeyObject): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

/** Sign a 32-byte hash with Ed25519 private key. */
function signHash(hash: Uint8Array, privKey: KeyObject): Uint8Array {
  const sig = cryptoSign(null, Buffer.from(hash), privKey);
  return new Uint8Array(sig);
}

/** Compute txHash exactly as the engine does (via computeTxId). */
function computeTxHash(tx: UtxoTransaction): Uint8Array {
  return Buffer.from(computeTxId(tx), 'hex');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

/** The one post `getTopologyAuthor` resolves in this suite, and its author. */
const LIKE_TARGET_POST = 'ab'.repeat(32);
const LIKE_TARGET_AUTHOR = new Uint8Array(32).fill(0xab);

describe('validateAndApplyTx', () => {
  let db: Database.Database;
  let ownerPubKey: Uint8Array;
  let ownerPrivKey: KeyObject;
  // Raw bytes, not hex: it is assigned `ownerPubKey` and every use feeds a
  // `UserId` field. ARCHITECTURE → Public-key representation — typed `UserId` ⇒ raw bytes, typed
  // `string` ⇒ lowercase hex — makes the declaration the thing that was wrong.
  let ownerUserId: UserId;

  /**
   * Create deps that wrap the real store functions.
   * `getBox` is overridden to return null for spent boxes.
   */
  function makeDeps(): UtxoEngineDeps {
    return {
      getBox: (id: string): AnyBox | null => {
        const box = storeGetBox(id);
        if (!box) return null;
        // Must also be unspent
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
      // ⛔ **The like marker's author pin** (NODE_INTERFACE → Karma transition
      // rules). One confirmed post, so a marker naming anyone else is refused
      // and a like on any other target has no author at all.
      inviteBondMin: config.inviteBondMin,
      inviteBondMax: config.inviteBondMax,
      decayCfg: {
        staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
        decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
        decayAmount: KARMA_DECAY_AMOUNT,
        karmaMinimum: KARMA_MINIMUM,
      },
      getTopologyAuthor: (postId: string) =>
        postId === LIKE_TARGET_POST ? LIKE_TARGET_AUTHOR : null,
      runInTransaction: (fn: () => void) => {
        (db.transaction(fn) as () => void)();
      },
    };
  }

  let deps: UtxoEngineDeps;

  beforeEach(() => {
    // Create a fresh in-memory database and initialise schema
    initDb(':memory:');
    db = getDb();

    // Generate owner keypair (reused across tests)
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    ownerPubKey = rawPublicKey(publicKey);
    ownerPrivKey = privateKey;
    ownerUserId = ownerPubKey;


    deps = makeDeps();
  });

  afterEach(() => {
    closeDb();
  });

  /** Create a KarmaBox, give it fixture provenance and its derived id, insert it. */
  function createAndInsertKarma(
    owner: Uint8Array,
    value: bigint,
    seed: number,
  ): Stored<KarmaBox> {
    const box = seedProvenance<KarmaBox>(
      {
        boxType: 'karma' as const,
        value,
        createdAtBlock: 0,
        owner,
      },
      seed,
    );
    storeInsertBox(box);
    return box;
  }

  /**
   * Build a transaction with a valid signature for the given private key.
   *
   * `rawOutputs` is `AnyBoxCandidate[]`, matching `UtxoTransaction.outputs`. It
   * said `AnyBox[]` — stored boxes — which is what forced every output literal
   * in this file to be annotated as a stored box too, and is the same confusion
   * the type distinction exists to prevent: an output's `txId` is the id of the
   * transaction being built, so a signed output carrying one is circular.
   */
  function buildSignedTx(
    inputs: string[],
    rawOutputs: AnyBoxCandidate[],
    privKey: KeyObject,
    pubKey: Uint8Array,
    protocolVersion = 1,
    likeTarget?: string,
    post?: PostCommit,
  ): UtxoTransaction {
    const hexKey = Buffer.from(pubKey).toString('hex');
    const tx: UtxoTransaction = {
      inputs,
      outputs: rawOutputs,
      signatures: {},
      protocolVersion,
      ...(likeTarget !== undefined ? { likeTarget } : {}),
      ...(post !== undefined ? { post } : {}),
    };
    const hash = computeTxHash(tx);
    tx.signatures[hexKey] = signHash(hash, privKey);
    return tx;
  }

  // -------------------------------------------------------------------------
  // 1. Valid karma→karma (balance change, same owner)
  // -------------------------------------------------------------------------
  it('valid karma to karma (re-anchor, same owner, value conserved)', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

    const newKarma: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: 100n,
      createdAtBlock: 0,
      owner: ownerPubKey,
    };

    const tx = buildSignedTx([karma.id!], [newKarma], ownerPrivKey, ownerPubKey);
    const result = validateAndApplyTx(deps, tx, 10);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();

    // Input box should now be spent
    expect(deps.getBox(karma.id!)).toBeNull();

    // Output box should exist and have an id assigned.
    //
    // Derived from the transaction's own id and the output's position, not from
    // the bare candidate: `computeBoxId` binds provenance as of phase G3b, so
    // re-deriving from a candidate with none yields a stable but meaningless id
    // — the test would look green while asserting nothing (report §F3).
    const outputBox = deps.getBox(computeCandidateBoxId(newKarma, result.txId!, 0));
    expect(outputBox).not.toBeNull();
    expect(outputBox!.boxType).toBe('karma');
    expect((outputBox as KarmaBox).value).toBe(100n);
  });

  // -------------------------------------------------------------------------
  // 2. Valid karma→karma+bond (the invite)
  // -------------------------------------------------------------------------
  it('valid karma to karma+bond (the invite)', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

    const invitee = new Uint8Array(32).fill(0xaa);
    const newKarma: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      // Only the bond is paid: FIXTURE_BOND_KARMA is minted at the claim.
      value: 100n - FIXTURE_BOND_KARMA,
      createdAtBlock: 0,
      owner: ownerPubKey,
    };

    const bondBox: CandidateOf<BondBox> = {
      boxType: 'bond',
      value: FIXTURE_BOND_KARMA,
      createdAtBlock: 0,
      inviterId: ownerUserId,
      inviteePublicKey: invitee,
    };

    const tx = buildSignedTx(
      [karma.id!],
      [newKarma, bondBox],
      ownerPrivKey,
      ownerPubKey,
    );
    const result = validateAndApplyTx(deps, tx, 10);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();

    // Both outputs should exist
    expect(deps.getBox(computeCandidateBoxId(newKarma, result.txId!, 0))).not.toBeNull();
    expect(deps.getBox(computeCandidateBoxId(bondBox, result.txId!, 1))).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // 3. Valid like burn (P2-D): karma → karma at −LIKE_KARMA_COST, likeTarget
  // -------------------------------------------------------------------------
  it('valid like: karma → karma + a LIKE_KARMA_COST marker, conserving', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

    const newKarma: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: 100n - LIKE_KARMA_COST,
      createdAtBlock: 0,
      owner: ownerPubKey,
    };
    // ⛔ The cost lands in a marker rather than leaving the ledger, so the
    // transaction conserves (ARCHITECTURE → The conservation axiom).
    const accrual: CandidateOf<LikeAccrualBox> = {
      boxType: 'like_accrual',
      value: LIKE_KARMA_COST,
      createdAtBlock: 0,
      author: LIKE_TARGET_AUTHOR,
    };

    const tx = buildSignedTx(
      [karma.id!],
      [newKarma, accrual],
      ownerPrivKey,
      ownerPubKey,
      1,
      LIKE_TARGET_POST,
    );
    const result = validateAndApplyTx(deps, tx, 10);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
    // The input is spent, the change box exists, and no other box was minted —
    // the burned karma is simply gone from the UTXO set.
    expect(deps.getBox(karma.id!)).toBeNull();
    const changeBox = deps.getBox(computeCandidateBoxId(newKarma, result.txId!, 0));
    expect(changeBox).not.toBeNull();
    expect((changeBox as KarmaBox).value).toBe(100n - LIKE_KARMA_COST);
  });

  // -------------------------------------------------------------------------
  // 4. Rejects spent input
  // -------------------------------------------------------------------------
  it('rejects spent input', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

    // Consume the box first (mark as spent)
    storeConsumeBox(karma.id!, 5);

    const newKarma: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: 100n,
      createdAtBlock: 0,
      owner: ownerPubKey,
    };

    const tx = buildSignedTx([karma.id!], [newKarma], ownerPrivKey, ownerPubKey);
    const result = validateAndApplyTx(deps, tx, 10);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('not found or already spent');
  });

  // -------------------------------------------------------------------------
  // 5. Karma value non-conservation rejected (audit C-1)
  // -------------------------------------------------------------------------
  it('rejects karma value non-conservation (audit C-1)', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

    // Output claims 120 from a 100 input — 20 karma minted from nothing.
    const newKarma: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: 120n,
      createdAtBlock: 0,
      owner: ownerPubKey,
    };

    const tx = buildSignedTx([karma.id!], [newKarma], ownerPrivKey, ownerPubKey);
    const result = validateAndApplyTx(deps, tx, 10);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Value non-conservation');

    // Nothing applied — the input box is still unspent.
    expect(deps.getBox(karma.id!)).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // 6. Rejects illegal transition (owner change on karma)
  // -------------------------------------------------------------------------
  it('rejects illegal transition (owner change on karma)', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

    // Different owner
    const { publicKey: otherPub } = generateKeyPairSync('ed25519');
    const otherPubRaw = rawPublicKey(otherPub);

    const newKarma: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: 100n,
      createdAtBlock: 0,
      owner: otherPubRaw,
    };

    const tx = buildSignedTx([karma.id!], [newKarma], ownerPrivKey, ownerPubKey);
    const result = validateAndApplyTx(deps, tx, 10);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('cannot be transferred');
  });

  // -------------------------------------------------------------------------
  // 7. Rejects a missing owner signature
  // -------------------------------------------------------------------------
  it('rejects a missing owner signature', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

    const newKarma: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: 100n,
      createdAtBlock: 0,
      owner: ownerPubKey,
    };

    // Build tx WITHOUT the owner's signature
    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [newKarma],
      signatures: {}, // empty — no signature
      protocolVersion: 1,
    };
    const result = validateAndApplyTx(deps, tx, 10);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Missing or invalid owner signature');
  });

  // -------------------------------------------------------------------------
  // 8. Transaction atomic: partial failure rolls back all changes
  // -------------------------------------------------------------------------
  it('transaction atomic: partial failure rolls back all changes', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

    const newKarma: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: 100n,
      createdAtBlock: 0,
      owner: ownerPubKey,
    };

    const tx = buildSignedTx([karma.id!], [newKarma], ownerPrivKey, ownerPubKey);

    // Create failing deps: insertBox always throws
    const failingDeps: UtxoEngineDeps = {
      ...deps,
      insertBox: (_box: AnyBox) => {
        throw new Error('Simulated insert failure');
      },
    };

    let threw = false;
    try {
      validateAndApplyTx(failingDeps, tx, 10);
    } catch {
      threw = true;
    }

    // Should have thrown (insertBox failure inside transaction propagates)
    expect(threw).toBe(true);

    // The consumed box should still be unspent (transaction rolled back)
    expect(deps.getBox(karma.id!)).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // 9. computeBoxId called for each output, IDs assigned
  // -------------------------------------------------------------------------
  it('computeBoxId called for each output, IDs assigned', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

    // A karma split — two same-owner outputs, so the per-output id derivation
    // is exercised at more than one index.
    const splitA: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: 60n,
      createdAtBlock: 0,
      owner: ownerPubKey,
    };
    const splitB: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: 40n,
      createdAtBlock: 0,
      owner: ownerPubKey,
    };

    const tx = buildSignedTx(
      [karma.id!],
      [splitA, splitB],
      ownerPrivKey,
      ownerPubKey,
    );
    const result = validateAndApplyTx(deps, tx, 10);

    expect(result.valid).toBe(true);

    // All output boxes should exist with their computed IDs, derived from the
    // transaction's own id and each output's position.
    const expectedIds = [splitA, splitB].map((c, i) =>
      computeCandidateBoxId(c, result.txId!, i),
    );
    for (const expectedId of expectedIds) {
      const box = storeGetBox(expectedId);
      expect(box).not.toBeNull();
      expect(box!.id).toBe(expectedId);
    }
  });

  // -------------------------------------------------------------------------
  // 10. validateTx checks authorization and transitions but does not mutate state
  // -------------------------------------------------------------------------
  it('validateTx checks authorization and transitions but does not mutate state', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

    const newKarma: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: 100n,
      createdAtBlock: 0,
      owner: ownerPubKey,
    };

    const tx = buildSignedTx([karma.id!], [newKarma], ownerPrivKey, ownerPubKey);
    const result = validateTx(deps, tx, 10);

    expect(result.valid).toBe(true);
    expect(result.computedOutputs).toBeDefined();
    expect(result.computedOutputs!.length).toBe(1);
    expect(result.computedOutputs![0]!.id).toBe(
      computeCandidateBoxId(newKarma, result.txId!, 0),
    );
    expect(result.txId).toBeDefined();

    // Box should still exist and be unspent (getBox returns null for spent boxes)
    const box = deps.getBox(karma.id!);
    expect(box).not.toBeNull();

    // No new boxes created — only the original karma box exists
    const bobBox = deps.getKarmaBox(ownerPubKey);
    expect(bobBox).not.toBeNull(); // the original box is still there, unchanged
  });

  // ---------------------------------------------------------------------------
  // 11. The invite is ONE transaction, and the bond is the request
  //
  // The invite is `karma → karma + bond`, authorized like any other karma
  // spend, and the block's settlement grants the invitee out of the karma pool
  // (ARCHITECTURE → Invite System). These pin the shape rules the arm carries
  // on top of that.
  // ---------------------------------------------------------------------------
  describe('the invite transition', () => {
    let inviterPubKey: Uint8Array;
    let inviterPrivKey: KeyObject;
    let inviteePubKey: Uint8Array;
    let strangerPubKey: Uint8Array;
    let strangerPrivKey: KeyObject;
    let karmaBoxId: string;

    // Sized on the CEILING, so a bond at either endpoint conserves and the
    // range check is what answers — a fixture funded for a typical bond would
    // have the sums refuse the ceiling case before the rule saw it.
    const FUNDED = config.inviteBondMax * 2n + 10n;

    beforeEach(() => {
      const inviterKeys = generateKeyPairSync('ed25519');
      inviterPubKey = rawPublicKey(inviterKeys.publicKey);
      inviterPrivKey = inviterKeys.privateKey;

      inviteePubKey = rawPublicKey(generateKeyPairSync('ed25519').publicKey);

      const strangerKeys = generateKeyPairSync('ed25519');
      strangerPubKey = rawPublicKey(strangerKeys.publicKey);
      strangerPrivKey = strangerKeys.privateKey;

      karmaBoxId = createAndInsertKarma(inviterPubKey, FUNDED, 41).id!;
    });

    /** karma(FUNDED) → karma(FUNDED − bond) + bond. */
    function inviteTx(opts: {
      bondValue?: bigint;
      bondInviterId?: Uint8Array;
      invitee?: Uint8Array;
    } = {}): UtxoTransaction {
      const bondValue = opts.bondValue ?? FIXTURE_BOND_KARMA;
      return {
        inputs: [karmaBoxId],
        outputs: [
          { boxType: 'karma', value: FUNDED - bondValue,  createdAtBlock: 0,owner: inviterPubKey } as KarmaBox,
          {
            boxType: 'bond',
            value: bondValue,
            createdAtBlock: 0,
            inviterId: opts.bondInviterId ?? inviterPubKey,
            inviteePublicKey: opts.invitee ?? inviteePubKey,
          } as BondBox,
        ],
        signatures: {},
        protocolVersion: 1,
      };
    }

    const signBy = (tx: UtxoTransaction, pub: Uint8Array, priv: KeyObject): UtxoTransaction => {
      tx.signatures[Buffer.from(pub).toString('hex')] = signHash(computeTxHash(tx), priv);
      return tx;
    };

    it('accepts an inviter-signed invite, and it CONSERVES', () => {
      const tx = signBy(inviteTx(), inviterPubKey, inviterPrivKey);
      const inSum = FUNDED;
      const outSum = tx.outputs.reduce((sum, o) => sum + o.value, 0n);
      // ⛔ No surplus anywhere: `FIXTURE_BOND_KARMA` comes from the pool at
      // settlement, so the invitee's karma is not in this transaction at all
      // (NODE_INTERFACE → validateTx step 5).
      expect(outSum).toBe(inSum);

      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('rejects a stranger-signed invite — it is the karma owner who signs', () => {
      const tx = signBy(inviteTx(), strangerPubKey, strangerPrivKey);
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('owner signature');
    });

    it('rejects a bond outside the network range, on either side', () => {
      // Conservation alone permits any value — the change output keeps the
      // difference — so this pin is the whole of the sybil price. `0n` is listed
      // separately from the floor: it is what conservation would admit, and it
      // is the value that makes the price free.
      for (const v of [0n, config.inviteBondMin - 1n, config.inviteBondMax + 1n]) {
        const tx = signBy(inviteTx({ bondValue: v }), inviterPubKey, inviterPrivKey);
        const result = validateTx(deps, tx, 10);
        expect(result.valid, `value=${v}`).toBe(false);
        expect(result.error).toContain('An invite bond must hold between');
      }
    });

    it('accepts a bond at each endpoint — the range is inclusive', () => {
      // Without these the rejections above hold equally over a rule that
      // refuses every bond.
      for (const v of [config.inviteBondMin, config.inviteBondMax]) {
        const tx = signBy(inviteTx({ bondValue: v }), inviterPubKey, inviterPrivKey);
        const result = validateTx(deps, tx, 10);
        expect(result.valid, `value=${v}`).toBe(true);
      }
    });

    it('grants exactly the bond, so a stranded grant costs what it strands', () => {
      // The bound that used to be a relationship between two constants is now an
      // identity. An inviter may name 32 bytes nobody holds; equality is what
      // makes that cost exactly what it strands.
      const bondValue = config.inviteBondMin + 3n;
      const tx = signBy(inviteTx({ bondValue }), inviterPubKey, inviterPrivKey);
      expect(validateTx(deps, tx, 10).valid).toBe(true);
      const bond = tx.outputs.find((o) => o.boxType === 'bond') as CandidateOf<BondBox>;
      expect(bond.value).toBe(bondValue);
    });

    it('rejects a bond naming someone else as inviter', () => {
      const tx = signBy(
        inviteTx({ bondInviterId: strangerPubKey }), inviterPubKey, inviterPrivKey,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("inviterId must be the karma input's owner");
    });

    it('rejects an invite naming a key that already holds an identity record', () => {
      // ⛔ Record existence is the test, never karma-box existence: the weaker
      // reading prints karma (ARCHITECTURE → The invite is ONE transaction).
      storePutIdentityRecord(inviteePubKey, {
        lastActivityBlock: 3,
        lastDecayBlock: 0,
        invitedAtBlock: 0,
        lifetimeLikesReceived: 900n,
      });
      const tx = signBy(inviteTx(), inviterPubKey, inviterPrivKey);
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('may not name an existing account');
    });

    it('rejects two bonds in one transaction', () => {
      // One bond, one grant: the pairing is structural, so a transaction
      // carrying two would owe two grants off one karma spend.
      const tx = inviteTx();
      tx.outputs.push({
        boxType: 'bond',
        value: FIXTURE_BOND_KARMA,
        createdAtBlock: 0,
        inviterId: inviterPubKey,
        inviteePublicKey: strangerPubKey,
      } as BondBox);
      // Still conserving, so the shape pin is what refuses it and not the sums.
      (tx.outputs[0] as KarmaBox).value = FUNDED - FIXTURE_BOND_KARMA * 2n;
      signBy(tx, inviterPubKey, inviterPrivKey);

      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('exactly 1 bond output');
    });
  });

  // ---------------------------------------------------------------------------
  // 13. Value conservation (audit C-1, L-11)
  //
  // sum(inputs) == sum(outputs) across the transaction as a whole — one total
  // per side, not per box type (NODE_INTERFACE → `validateTx` step 7). A user
  // transaction conserves unconditionally: each cost lands in a box the
  // transaction itself outputs. Every mint or burn happens in a
  // block-application path, never inside a user transaction.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // ⛔ NO BOX AND NO SIGNER IS EXEMPT FROM NON-TRANSFERABILITY.
  //
  // The shape below — one karma input, a same-owner change box and a
  // different-owner beneficiary — is the exact shape the faucet's same-owner
  // exemption admitted. It is asserted here, at the engine, rather than in a
  // fixture that has to configure a privileged box: a test that reached the rule
  // only through such a fixture would be testing the fixture's absence, and the
  // rule would lose its coverage the moment the fixture went.
  // ---------------------------------------------------------------------------
  describe('karma is transferable nowhere (NODE_INTERFACE → Karma transition rules)', () => {
    it('refuses a two-output karma split to a different owner, whoever owns the input', () => {
      const recipient = rawPublicKey(generateKeyPairSync('ed25519').publicKey);
      const karma = createAndInsertKarma(ownerPubKey, 1000n, 51);

      const tx = buildSignedTx(
        [karma.id!],
        [
          { boxType: 'karma', value: 900n,  createdAtBlock: 0,owner: ownerPubKey } as CandidateOf<KarmaBox>,
          { boxType: 'karma', value: 100n, createdAtBlock: 0, owner: recipient } as CandidateOf<KarmaBox>,
        ],
        ownerPrivKey,
        ownerPubKey,
      );

      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Karma cannot be transferred');
    });

    // ⛔ **The control the case above needs.** It conserves, it is owner-signed
    // and it has the same two-output shape — so without this, the rejection
    // could be the engine refusing any two karma outputs at all rather than
    // refusing the owner change.
    it('control: the same two-output split to the SAME owner is accepted', () => {
      const karma = createAndInsertKarma(ownerPubKey, 1000n, 52);

      const tx = buildSignedTx(
        [karma.id!],
        [
          { boxType: 'karma', value: 900n,  createdAtBlock: 0,owner: ownerPubKey } as CandidateOf<KarmaBox>,
          { boxType: 'karma', value: 100n, createdAtBlock: 0, owner: ownerPubKey } as CandidateOf<KarmaBox>,
        ],
        ownerPrivKey,
        ownerPubKey,
      );

      const result = validateTx(deps, tx, 10);
      expect(result.valid, result.error).toBe(true);
    });
  });

  describe('value conservation (audit C-1, L-11)', () => {
    it('rejects self-signed K(v) -> K(v) + K(2) (mints karma from nothing)', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

      // The C-1 exploit: the change box keeps the full balance while a second
      // box conjures 2 more karma.
      const newKarma: CandidateOf<KarmaBox> = {
        boxType: 'karma',
        value: 100n,
        createdAtBlock: 0,
        owner: ownerPubKey,
      };
      const conjured: CandidateOf<KarmaBox> = {
        boxType: 'karma',
        value: 2n,
        createdAtBlock: 0,
        owner: ownerPubKey,
      };

      const tx = buildSignedTx(
        [karma.id!],
        [newKarma, conjured],
        ownerPrivKey,
        ownerPubKey,
      );
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Value non-conservation');
      expect(result.error).toContain('inputs=100');
      expect(result.error).toContain('outputs=102');

      // Nothing applied.
      expect(deps.getBox(karma.id!)).not.toBeNull();
      expect(deps.getKarmaBox(ownerPubKey)!.value).toBe(100n);
    });

    it('accepts the correct like K(v) -> K(v-1) + marker(LIKE_KARMA_COST)', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

      const newKarma: CandidateOf<KarmaBox> = {
        boxType: 'karma',
        value: 100n - LIKE_KARMA_COST,
        createdAtBlock: 0,
        owner: ownerPubKey,
      };
      const accrual: CandidateOf<LikeAccrualBox> = {
        boxType: 'like_accrual',
        value: LIKE_KARMA_COST,
        createdAtBlock: 0,
        author: LIKE_TARGET_AUTHOR,
      };

      const tx = buildSignedTx(
        [karma.id!],
        [newKarma, accrual],
        ownerPrivKey,
        ownerPubKey,
        1,
        LIKE_TARGET_POST,
      );
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
      expect(deps.getKarmaBox(ownerPubKey)!.value).toBe(100n - LIKE_KARMA_COST);
    });

    // -----------------------------------------------------------------------
    // L-11 — box `value` must be a non-negative integer. The rule moved from
    // `checkOutputValues` into the step-4 schema (field-type pin), so the
    // rejection is shape-worded now; the bound is the same.
    //
    // ⚠ **The malformed value is stamped AFTER signing**, here and in the
    // balancing case below. `computeTxId` has no encoding for a `value` outside
    // the u64 (`vlqU64` throws — a bigint spans the whole wire domain, so no
    // sentinel is unreachable), so a fixture that signed over it would die in
    // the helper without ever reaching the check under test. The signature not
    // covering the mutation is immaterial to what is asserted: `checkOutputShape`
    // is `validateTx` step 4 and `checkAuthorization` — the only thing that reads a
    // signature — is step 6, so the rejection under test happens first either
    // way. Under CBOR the malformed value encoded silently and the distinction
    // never arose.
    // -----------------------------------------------------------------------
    for (const [label, badValue] of [
      ['negative', -1],
      ['NaN', Number.NaN],
      ['fractional', 1.5],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['beyond MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 2],
    ] as const) {
      it(`rejects a ${label} box value (${String(badValue)})`, () => {
        const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

        const newKarma: CandidateOf<KarmaBox> = {
          boxType: 'karma',
          value: 100n,
          createdAtBlock: 0,
          owner: ownerPubKey,
        };

        const tx = buildSignedTx([karma.id!], [newKarma], ownerPrivKey, ownerPubKey);
        Object.assign(tx.outputs[0]!, { value: badValue });
        const result = validateAndApplyTx(deps, tx, 10);

        expect(result.valid).toBe(false);
        expect(result.error).toContain("field 'value' must be a non-negative bigint < 2^63");
        expect(deps.getBox(karma.id!)).not.toBeNull();
      });
    }

    it('rejects a negative value that balances the sum (K(10) -> K(15) + K(-5))', () => {
      const karma = createAndInsertKarma(ownerPubKey, 10n, 1);

      // 15 + (-5) == 10, so a sum-only check would pass this — yet it hands
      // the owner a 15-karma box out of a 10-karma input.
      const newKarma: CandidateOf<KarmaBox> = {
        boxType: 'karma',
        value: 15n,
        createdAtBlock: 0,
        owner: ownerPubKey,
      };
      const negative: CandidateOf<KarmaBox> = {
        boxType: 'karma',
        value: 0n,
        createdAtBlock: 0,
        owner: ownerPubKey,
      };

      const tx = buildSignedTx(
        [karma.id!],
        [newKarma, negative],
        ownerPrivKey,
        ownerPubKey,
      );
      // −5 stamped after signing — see the note above the L-11 loop.
      Object.assign(tx.outputs[1]!, { value: -5 });
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("field 'value' must be a non-negative bigint < 2^63");
      expect(deps.getKarmaBox(ownerPubKey)!.value).toBe(10n);
    });

    // -----------------------------------------------------------------------
    // Legitimate tx shapes must keep passing
    // -----------------------------------------------------------------------
    it('accepts a conserving post-lock tx K(v) -> K(v-5) + PostLock(5)', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

      const newKarma: CandidateOf<KarmaBox> = {
        boxType: 'karma',
        value: 100n - POST_LOCK_THREAD_COST,
        createdAtBlock: 0,
        owner: ownerPubKey,
      };
      const postLock: CandidateOf<PostLockBox> = {
        boxType: 'post_lock',
        value: POST_LOCK_THREAD_COST,
        createdAtBlock: 0,
        originalValue: POST_LOCK_THREAD_COST,
        owner: ownerPubKey,
      };

      // The lock's payload: `post` present ⟺ exactly one `PostLockBox` at the
      // cost for that post's shape, and the author owns the karma being spent
      // (NODE_INTERFACE → Post transactions).
      const tx = buildSignedTx(
        [karma.id!],
        [newKarma, postLock],
        ownerPrivKey,
        ownerPubKey,
        1,
        undefined,
        makePostCommit(ownerPubKey, 'conserving lock payload'),
      );
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('accepts a conserving vouch tx K(v) -> K(v-1) + Vouch(1)', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const { publicKey: targetPub } = generateKeyPairSync('ed25519');
      const targetPubRaw = rawPublicKey(targetPub);

      const newKarma: CandidateOf<KarmaBox> = {
        boxType: 'karma',
        value: 100n - VOUCH_KARMA_AMOUNT,
        createdAtBlock: 10,
        owner: ownerPubKey,
      };
      const vouchBox: CandidateOf<VouchBox> = {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: 10,
        voucherId: ownerPubKey,
        targetId: targetPubRaw,
      };

      const tx = buildSignedTx(
        [karma.id!],
        [newKarma, vouchBox],
        ownerPrivKey,
        ownerPubKey,
      );
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('accepts a conserving invite K(v) -> K(v-25) + Bond(25)', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

      const newKarma: CandidateOf<KarmaBox> = {
        boxType: 'karma',
        // The bond is the whole of what leaves the change box.
        value: 100n - FIXTURE_BOND_KARMA,
        createdAtBlock: 0,
        owner: ownerPubKey,
      };
      const bondBox: CandidateOf<BondBox> = {
        boxType: 'bond',
        value: FIXTURE_BOND_KARMA,
        createdAtBlock: 0,
        inviterId: ownerUserId,
        inviteePublicKey: new Uint8Array(32).fill(0xbb),
      };

      const tx = buildSignedTx(
        [karma.id!],
        [newKarma, bondBox],
        ownerPrivKey,
        ownerPubKey,
      );
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('rejects an invite that does not debit the change box (audit C-1)', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

      // The transition arm pins the bond's value but nothing there requires the
      // change box to be debited for it. Conservation is what catches this.
      const newKarma: CandidateOf<KarmaBox> = {
        boxType: 'karma',
        value: 100n,
        createdAtBlock: 0,
        owner: ownerPubKey,
      };
      const bondBox: CandidateOf<BondBox> = {
        boxType: 'bond',
        value: FIXTURE_BOND_KARMA,
        createdAtBlock: 0,
        inviterId: ownerUserId,
        inviteePublicKey: new Uint8Array(32).fill(0xcc),
      };

      const tx = buildSignedTx(
        [karma.id!],
        [newKarma, bondBox],
        ownerPrivKey,
        ownerPubKey,
      );
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Value non-conservation');
    });

    it('rejects a BondBox burn (zero outputs) — no zero-output exemption is bond-shaped', () => {
      // The zero-output exemption is vouch-only, so conservation answers first
      // (step 5, ahead of authorization at step 6): the value is gone and the
      // sums say so. Authorization is the layer under it, and refuses a bond
      // input even when the sums balance. See test/services/bond-tightening.test.ts for
      // both layers with their non-vacuity controls.
      const bondBox: CandidateOf<BondBox> = {
        boxType: 'bond',
        value: FIXTURE_BOND_KARMA,
        createdAtBlock: 0,
        inviterId: ownerPubKey,
        inviteePublicKey: new Uint8Array(32).fill(0xdd),
      };
      const seededBondBox = seedProvenance<BondBox>(bondBox, 1);
      const bondBoxId = seededBondBox.id;
      storeInsertBox(seededBondBox);

      const tx = buildSignedTx([bondBoxId], [], ownerPrivKey, ownerPubKey);
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Value non-conservation');
      // Nothing applied — the bond is still unspent.
      expect(deps.getBox(bondBoxId)).not.toBeNull();

      // And the layer below, on a shape conservation cannot answer: sending the
      // bond's value straight back out balances the sums, so authorization is
      // what refuses.
      const conserving = buildSignedTx(
        [bondBoxId],
        [{ boxType: 'karma', value: FIXTURE_BOND_KARMA,  createdAtBlock: 0,owner: ownerPubKey } as KarmaBox],
        ownerPrivKey,
        ownerPubKey,
      );
      const authorized = validateTx(deps, conserving, 10);
      expect(authorized.valid).toBe(false);
      expect(authorized.error).toContain('block application');
    });

    it('accepts an unvouch — the stake escrows into a VouchEscrowBox', () => {
      const { publicKey: targetPub } = generateKeyPairSync('ed25519');
      const vouchBox: CandidateOf<VouchBox> = {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: 8,
        voucherId: ownerPubKey,
        targetId: rawPublicKey(targetPub),
      };
      const seededVouchBox = seedProvenance<VouchBox>(vouchBox, 1);
      const vouchBoxId = seededVouchBox.id;
      storeInsertBox(seededVouchBox);

      // ⛔ **An escrow output, not zero outputs.** The stake moves into a box
      // the voucher's own transaction creates, so both ends are named in one
      // operation and the pool is uninvolved (ARCHITECTURE → How a source and a
      // sink get named, first shape).
      const escrow = {
        boxType: 'vouch_escrow' as const,
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: 10,
        owner: ownerPubKey,
        releaseAtBlock: 8 + 2,
      };
      const tx = buildSignedTx([vouchBoxId], [escrow as AnyBox], ownerPrivKey, ownerPubKey);
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
      expect(deps.getBox(vouchBoxId)).toBeNull();
    });

    it('unvouch escrow dates from the vouch cast, not the unvouch height', () => {
      const { publicKey: targetPub } = generateKeyPairSync('ed25519');
      const CAST_HEIGHT = 5;
      const UNVOUCH_HEIGHT = 20;
      const vouchBox: CandidateOf<VouchBox> = {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: CAST_HEIGHT,
        voucherId: ownerPubKey,
        targetId: rawPublicKey(targetPub),
      };
      const seeded = seedProvenance<VouchBox>(vouchBox, 1);
      storeInsertBox(seeded);

      const escrow = {
        boxType: 'vouch_escrow' as const,
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: UNVOUCH_HEIGHT,
        owner: ownerPubKey,
        releaseAtBlock: CAST_HEIGHT + 2,
      };
      const tx = buildSignedTx([seeded.id!], [escrow as AnyBox], ownerPrivKey, ownerPubKey);
      const result = validateAndApplyTx(deps, tx, UNVOUCH_HEIGHT);
      expect(result.valid).toBe(true);
    });

    it('refuses an escrow whose releaseAtBlock derives from the unvouch height', () => {
      const { publicKey: targetPub } = generateKeyPairSync('ed25519');
      const CAST_HEIGHT = 5;
      const UNVOUCH_HEIGHT = 20;
      const vouchBox: CandidateOf<VouchBox> = {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: CAST_HEIGHT,
        voucherId: ownerPubKey,
        targetId: rawPublicKey(targetPub),
      };
      const seeded = seedProvenance<VouchBox>(vouchBox, 1);
      storeInsertBox(seeded);

      const escrow = {
        boxType: 'vouch_escrow' as const,
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: UNVOUCH_HEIGHT,
        owner: ownerPubKey,
        releaseAtBlock: UNVOUCH_HEIGHT + 2,
      };
      const tx = buildSignedTx([seeded.id!], [escrow as AnyBox], ownerPrivKey, ownerPubKey);
      const result = validateAndApplyTx(deps, tx, UNVOUCH_HEIGHT);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('releaseAtBlock must be');
    });

    it('VouchBox is spendable at any height — withdrawal is never timing-gated', () => {
      const { publicKey: targetPub } = generateKeyPairSync('ed25519');
      const CAST_HEIGHT = 100;
      const SPEND_HEIGHT = 101;
      const vouchBox: CandidateOf<VouchBox> = {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: CAST_HEIGHT,
        voucherId: ownerPubKey,
        targetId: rawPublicKey(targetPub),
      };
      const seeded = seedProvenance<VouchBox>(vouchBox, 1);
      storeInsertBox(seeded);

      const escrow = {
        boxType: 'vouch_escrow' as const,
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: SPEND_HEIGHT,
        owner: ownerPubKey,
        releaseAtBlock: CAST_HEIGHT + 2,
      };
      const tx = buildSignedTx([seeded.id!], [escrow as AnyBox], ownerPrivKey, ownerPubKey);
      const result = validateAndApplyTx(deps, tx, SPEND_HEIGHT);
      expect(result.valid).toBe(true);
    });

    it('refuses a vouch cast backdated by more than VOUCH_CAST_HEIGHT_WINDOW', () => {
      const { publicKey: targetPub } = generateKeyPairSync('ed25519');
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const HEIGHT = 20;
      const vouchOut: CandidateOf<VouchBox> = {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: HEIGHT - 6,
        voucherId: ownerPubKey,
        targetId: rawPublicKey(targetPub),
      };
      const karmaChange: CandidateOf<KarmaBox> = {
        boxType: 'karma',
        value: 100n - VOUCH_KARMA_AMOUNT,
        createdAtBlock: HEIGHT,
        owner: ownerPubKey,
      };
      const tx = buildSignedTx(
        [karma.id!],
        [karmaChange as AnyBox, vouchOut as AnyBox],
        ownerPrivKey, ownerPubKey,
      );
      const result = validateAndApplyTx(deps, tx, HEIGHT);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('blocks behind height');
    });

    it('accepts a vouch cast backdated by exactly VOUCH_CAST_HEIGHT_WINDOW', () => {
      const { publicKey: targetPub } = generateKeyPairSync('ed25519');
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const HEIGHT = 20;
      const vouchOut: CandidateOf<VouchBox> = {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: HEIGHT - 5,
        voucherId: ownerPubKey,
        targetId: rawPublicKey(targetPub),
      };
      const karmaChange: CandidateOf<KarmaBox> = {
        boxType: 'karma',
        value: 100n - VOUCH_KARMA_AMOUNT,
        createdAtBlock: HEIGHT,
        owner: ownerPubKey,
      };
      const tx = buildSignedTx(
        [karma.id!],
        [karmaChange as AnyBox, vouchOut as AnyBox],
        ownerPrivKey, ownerPubKey,
      );
      const result = validateAndApplyTx(deps, tx, HEIGHT);
      expect(result.valid).toBe(true);
    });

    // §4.7 (g): a user transaction spending an escrow is refused by
    // BLOCK_APPLICATION_ONLY — the settlement returns it.
    it('refuses a user transaction spending an escrow (block application only)', () => {
      const escrow = seedProvenance<VouchEscrowBox>(
        {
          boxType: 'vouch_escrow' as const,
          value: VOUCH_KARMA_AMOUNT,
          createdAtBlock: 0,
          owner: ownerPubKey,
          releaseAtBlock: 10,
        },
        1,
      );
      storeInsertBox(escrow);
      const karmaOut: CandidateOf<KarmaBox> = {
        boxType: 'karma',
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: 10,
        owner: ownerPubKey,
      };
      const tx = buildSignedTx([escrow.id!], [karmaOut as AnyBox], ownerPrivKey, ownerPubKey);
      const result = validateAndApplyTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('consumed only by block application');
    });

    it('does not extend the zero-output exception to karma or like inputs', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

      // A karma spend with no outputs is not a legal burn — only bond and
      // vouch may destroy value this way.
      const tx = buildSignedTx([karma.id!], [], ownerPrivKey, ownerPubKey);
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Value non-conservation');
      expect(deps.getBox(karma.id!)).not.toBeNull();
    });

    it('accepts a conserving credit transfer C(v) -> C(a) + C(v-a)', () => {
      const { publicKey: recipientPub } = generateKeyPairSync('ed25519');
      const recipientRaw = rawPublicKey(recipientPub);

      const creditBox = {
        boxType: 'credit' as const,
        value: 100_000n,
        createdAtBlock: 0,
        owner: ownerPubKey,
      };
      const seededCreditBox = seedProvenance<CreditBox>(creditBox, 1);
      const creditBoxId = seededCreditBox.id;
      storeInsertBox(seededCreditBox);

      const tx = buildSignedTx(
        [creditBoxId],
        [
          { ...creditBox, value: 30_000n, owner: recipientRaw },
          { ...creditBox, value: 70_000n },
        ] as AnyBox[],
        ownerPrivKey,
        ownerPubKey,
      );
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 14. The bond sweep (audit H-2), closed by construction
  //
  // The attack was a mixed-input "cancel shape" — the attacker's own KarmaBox
  // alongside the uncommitted BondBox — sweeping both into their own karma with
  // no inviter signature. It needed a mixed-type input combination, which
  // `validateTx` step 3 permitted for exactly two shapes.
  //
  // ⛔ **Both preconditions fail twice over**: every legal shape is single-type
  // and step 3 admits no exception, and a bond input is refused by authorization
  // whatever else the transaction holds (ARCHITECTURE → Invite System). The
  // sweep is enumerated here rather than assumed unreachable, because "step 3
  // admits no exceptions" is a claim a future arm could quietly reverse.
  // ---------------------------------------------------------------------------
  describe('the bond sweep (audit H-2)', () => {
    it('rejects the 2-input sweep, attacker-signed', () => {
      const inviterKeys = generateKeyPairSync('ed25519');
      const inviterPubKey = rawPublicKey(inviterKeys.publicKey);
      const attackerKeys = generateKeyPairSync('ed25519');
      const attackerPubKey = rawPublicKey(attackerKeys.publicKey);

      const karma = createAndInsertKarma(attackerPubKey, 100n, 3);
      const [bond] = seedAsOneTx([
        {
          boxType: 'bond' as const, value: FIXTURE_BOND_KARMA,  createdAtBlock: 0,inviterId: inviterPubKey,
          inviteePublicKey: attackerPubKey,
        },
      ]);
      deps.insertBox(bond!);

      const tx: UtxoTransaction = {
        inputs: [karma.id!, bond!.id!],
        outputs: [{
          boxType: 'karma',
          value: 100n + FIXTURE_BOND_KARMA,
          createdAtBlock: 0,
          owner: attackerPubKey,
        } as KarmaBox],
        signatures: {},
        protocolVersion: 1,
      };
      tx.signatures[Buffer.from(attackerPubKey).toString('hex')] = signHash(computeTxHash(tx), attackerKeys.privateKey);

      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Mixed input types');

      // The store is untouched: a rejected transaction applies nothing.
      expect(deps.getBox(bond!.id!)).not.toBeNull();
    });

    it('and the bond ALONE is refused by authorization, not by step 3', () => {
      // The layer below the mixed-type refusal, which is what makes the bond
      // unspendable rather than merely awkward to combine: single-type, value
      // conserving, and still refused because no transition admits a bond input.
      const attackerKeys = generateKeyPairSync('ed25519');
      const attackerPubKey = rawPublicKey(attackerKeys.publicKey);
      const [bond] = seedAsOneTx([
        {
          boxType: 'bond' as const, value: FIXTURE_BOND_KARMA, createdAtBlock: 0,
          inviterId: rawPublicKey(generateKeyPairSync('ed25519').publicKey),
          inviteePublicKey: attackerPubKey,
        },
      ], 1, 91);
      deps.insertBox(bond!);

      const tx: UtxoTransaction = {
        inputs: [bond!.id!],
        outputs: [{
          boxType: 'karma', value: FIXTURE_BOND_KARMA,  createdAtBlock: 0,owner: attackerPubKey,
        } as KarmaBox],
        signatures: {},
        protocolVersion: 1,
      };
      tx.signatures[Buffer.from(attackerPubKey).toString('hex')] = signHash(computeTxHash(tx), attackerKeys.privateKey);

      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('block application');
      expect(deps.getBox(bond!.id!)).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 15. P2-D like biconditional: `likeTarget` present ⟺ deficit exactly
  // LIKE_KARMA_COST — the only legal karma deficit in any user transaction —
  // and the like shape is exactly one karma output, same owner as all inputs.
  // ---------------------------------------------------------------------------
  describe('P2-D like biconditional and shape', () => {
    const TARGET = LIKE_TARGET_POST;
    const TARGET_AUTHOR = LIKE_TARGET_AUTHOR;

    function karmaOut(value: bigint, owner: Uint8Array): KarmaBox {
      return {
        boxType: 'karma',
        value,
        createdAtBlock: 0,
        owner,
      } as KarmaBox;
    }

    /**
     * The `LikeAccrualBox` a like emits — the marker that carries the cost.
     *
     * ⛔ **Its `author` is a free field at the wire**, which is exactly why the
     * pin exists: nothing in the type stops a builder naming someone else.
     */
    function marker(
      value: bigint = LIKE_KARMA_COST,
      author: Uint8Array = TARGET_AUTHOR,
    ): LikeAccrualBox {
      return { boxType: 'like_accrual', value, createdAtBlock: 0, author } as LikeAccrualBox;
    }

    // --- the four quadrants -------------------------------------------------

    it('quadrant 1 — likeTarget with a marker of LIKE_KARMA_COST: valid', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const tx = buildSignedTx(
        [karma.id!], [karmaOut(99n, ownerPubKey), marker()], ownerPrivKey, ownerPubKey, 1, TARGET,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.error).toBeUndefined();
      expect(result.valid).toBe(true);
    });

    it('quadrant 2 — deficit without likeTarget: invalid (the before-leg invariant)', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const tx = buildSignedTx(
        [karma.id!], [karmaOut(100n - LIKE_KARMA_COST, ownerPubKey)], ownerPrivKey, ownerPubKey,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Value non-conservation');
    });

    it('quadrant 3 — likeTarget with NO marker (a plain conserving tx): invalid', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const tx = buildSignedTx(
        [karma.id!], [karmaOut(100n, ownerPubKey)], ownerPrivKey, ownerPubKey, 1, TARGET,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('like_accrual marker expected');
    });

    it('quadrant 4a — a marker carrying more than LIKE_KARMA_COST: invalid', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const tx = buildSignedTx(
        [karma.id!], [karmaOut(98n, ownerPubKey), marker(2n)], ownerPrivKey, ownerPubKey, 1, TARGET,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      // ⛔ It CONSERVES — 100 in, 100 out. The old shape announced itself as an
      // imbalance; this one is refused only because a rule reads the marker.
      expect(result.error).toContain('must carry exactly');
    });

    it('quadrant 4b — a like that does not conserve: invalid', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const tx = buildSignedTx(
        [karma.id!], [karmaOut(100n, ownerPubKey), marker()], ownerPrivKey, ownerPubKey, 1, TARGET,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      // The deficit carve is gone: step 5 is `sum(in) == sum(out)` for every
      // transaction, likes included.
      expect(result.error).toContain('Value non-conservation');
    });

    // --- ⛔ THE CONVERSE, WHICH HAS NO PREDECESSOR ---------------------------

    it('⛔ a marker with NO likeTarget is refused, though it CONSERVES', () => {
      // `myKarma(100) → myKarma(99) + LikeAccrualBox(1, author=Bob)`. It
      // balances, it carries no `likeTarget`, and at settlement it would pay Bob
      // — a karma transfer with no invite, which is the exact shape
      // *"Karma cannot be transferred"* exists to refuse (NODE_INTERFACE →
      // Karma transition rules).
      //
      // ⛔ **Nothing else in the funnel fires on it.** Conservation holds, the
      // output shape is legal, the signature is the owner's, and every karma
      // output belongs to the input's owner — the marker is not a karma box.
      // Without the converse this is an accepted transaction.
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const tx = buildSignedTx(
        [karma.id!], [karmaOut(99n, ownerPubKey), marker()], ownerPrivKey, ownerPubKey,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('only legal on a like transaction');
    });

    it('⛔ a marker naming an author other than the target\'s is refused', () => {
      // The forward half's second obligation. A marker that named a key the
      // target's author is not would earmark the liker's karma to a stranger and
      // pay them at settlement — and it conserves, so only this rule catches it.
      const { publicKey: strangerPub } = generateKeyPairSync('ed25519');
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const tx = buildSignedTx(
        [karma.id!],
        [karmaOut(99n, ownerPubKey), marker(LIKE_KARMA_COST, rawPublicKey(strangerPub))],
        ownerPrivKey, ownerPubKey, 1, TARGET,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("author is");
    });

    it('a like on an unconfirmed target is refused: the author is unknowable', () => {
      // ⚠ **A consequence rather than a decision.** The marker has to name the
      // author and the author comes from `block_topology`, so a post no block has
      // confirmed names none — the confirmation the apply rule already demanded
      // at apply height is demanded at build time too.
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const tx = buildSignedTx(
        [karma.id!], [karmaOut(99n, ownerPubKey), marker()], ownerPrivKey, ownerPubKey, 1,
        'cd'.repeat(32),
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not confirmed');
    });

    // --- input rules --------------------------------------------------------

    it('multi-input like: two karma boxes, one owner, one −1 output: valid', () => {
      const karmaA = createAndInsertKarma(ownerPubKey, 60n, 1);
      const karmaB = createAndInsertKarma(ownerPubKey, 40n, 2);
      const tx = buildSignedTx(
        [karmaA.id!, karmaB.id!],
        [karmaOut(100n - LIKE_KARMA_COST, ownerPubKey), marker()],
        ownerPrivKey, ownerPubKey, 1, TARGET,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.error).toBeUndefined();
      expect(result.valid).toBe(true);
    });

    it('foreign-owner karma input mixed into a like: invalid (same-owner rule)', () => {
      const { publicKey: otherPub, privateKey: otherPriv } = generateKeyPairSync('ed25519');
      const otherRaw = rawPublicKey(otherPub);
      const karmaA = createAndInsertKarma(ownerPubKey, 60n, 1);
      const karmaB = createAndInsertKarma(otherRaw, 40n, 2);

      const tx = buildSignedTx(
        [karmaA.id!, karmaB.id!],
        [karmaOut(100n - LIKE_KARMA_COST, ownerPubKey), marker()],
        ownerPrivKey, ownerPubKey, 1, TARGET,
      );
      // Both owners co-sign — consensual, and still illegal.
      tx.signatures[Buffer.from(otherRaw).toString('hex')] =
        signHash(computeTxHash(tx), otherPriv);

      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Karma cannot be transferred');
    });

    it('likeTarget on a non-karma (credit) spend: invalid', () => {
      const creditBox = {
        boxType: 'credit' as const,
        value: 100_000n,
        createdAtBlock: 0,
        owner: ownerPubKey,
      };
      Object.assign(creditBox, fixtureProvenance(creditBox, 1));
      const creditId = computeBoxId(creditBox as never);
      storeInsertBox({ ...creditBox, id: creditId } as AnyBox);

      const tx = buildSignedTx(
        [creditId],
        [{ ...creditBox, value: 99_000n } as AnyBox],
        ownerPrivKey, ownerPubKey, 1, TARGET,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('likeTarget is only legal on an all-karma burn transaction');
    });

    it('likeTarget on a zero-output unvouch: invalid (no shelter under the vouch exemption)', () => {
      const { publicKey: targetPub } = generateKeyPairSync('ed25519');
      const vouchBox: CandidateOf<VouchBox> = {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: 0,
        voucherId: ownerPubKey,
        targetId: rawPublicKey(targetPub),
      };
      const seededVouchBox = seedProvenance<VouchBox>(vouchBox, 1);
      const vouchBoxId = seededVouchBox.id;
      storeInsertBox(seededVouchBox);

      const tx = buildSignedTx([vouchBoxId], [], ownerPrivKey, ownerPubKey, 1, TARGET);
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('likeTarget is only legal on an all-karma burn transaction');
    });

    // --- output-shape violations -------------------------------------------

    it('like with two karma outputs: invalid', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const tx = buildSignedTx(
        [karma.id!],
        [karmaOut(60n, ownerPubKey), karmaOut(39n, ownerPubKey), marker()],
        ownerPrivKey, ownerPubKey, 1, TARGET,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('exactly one karma output');
    });

    it('like with karma + another box type: invalid', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const postLock: CandidateOf<PostLockBox> = {
        boxType: 'post_lock',
        value: 5n,
        createdAtBlock: 0,
        originalValue: 5n,
        owner: ownerPubKey,
      } as PostLockBox;
      const tx = buildSignedTx(
        [karma.id!],
        [karmaOut(94n, ownerPubKey), postLock, marker()],
        ownerPrivKey, ownerPubKey, 1, TARGET,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('exactly one karma output');
    });

    // --- the retired arms stay dead ----------------------------------------

    it("a retired 'like'-typed output is rejected (the old cast shape stays dead)", () => {
      // T2b deleted the box type; JS clients are untyped, so the old cast
      // shape can still arrive as JSON. The step-4 schema rejects the unknown
      // boxType first (field-type pin); the karma arm's totality count is the
      // defense-in-depth layer behind it.
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const relic = {
        boxType: 'like',
        value: 2n,
        createdAtBlock: 0,
        likerId: ownerUserId,
      } as never;
      const tx = buildSignedTx(
        [karma.id!],
        [karmaOut(98n, ownerPubKey), relic],
        ownerPrivKey, ownerPubKey,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('unknown boxType like');
    });

    it('spending a PostLockBox with the owner signature is refused: no user transition consumes one (T2a)', () => {
      const postLock: CandidateOf<PostLockBox> = {
        boxType: 'post_lock',
        value: POST_LOCK_THREAD_COST,
        createdAtBlock: 0,
        originalValue: POST_LOCK_THREAD_COST,
        owner: ownerPubKey,
      };
      const seededPostLock = seedProvenance<PostLockBox>(postLock, 1);
      const postLockId = seededPostLock.id;
      storeInsertBox(seededPostLock);

      // The owner's own signature does not open a post_lock box. Conservation
      // holds (5 in, 5 out), and the transition table would also reject a
      // post_lock input — so what this pins is the authorization arm
      // specifically: the refusal must name the box TYPE, which is the key the
      // per-transition lookup reads.
      const tx = buildSignedTx(
        [postLockId],
        [karmaOut(POST_LOCK_THREAD_COST, ownerPubKey)],
        ownerPrivKey, ownerPubKey,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('No user transition consumes');
      expect(result.error).toContain('a post_lock box is consumed only by block application');
    });
  });

  // ---------------------------------------------------------------------------
  // 16. The fee box — a credit transaction conserves strictly, and a fee is a
  // `FeeBox` output it names (NODE_INTERFACE → `validateTx` step 7; the three
  // stated exceptions all move karma).
  //
  // Every rejection below is the fall-through's, because there is no
  // credit-ledger arm for it to be. The two "arms do not collide" cases assert
  // the message they did NOT get, since "rejected" alone would pass for either
  // gate and a collision is precisely what a shared check would hide.
  // ---------------------------------------------------------------------------
  describe('the fee box, and strict conservation on the credit ledger', () => {
    function creditIn(value: bigint, seed: number, owner = ownerPubKey): Stored<CreditBox> {
      const box = seedProvenance<CreditBox>(
        {
          boxType: 'credit' as const,
          value,
          createdAtBlock: 0,
          owner,
        },
        seed,
      );
      storeInsertBox(box);
      return box;
    }

    function creditOut(value: bigint, owner = ownerPubKey): CandidateOf<CreditBox> {
      return {
        boxType: 'credit',
        value,
        createdAtBlock: 0,
        owner,
      };
    }

    function feeOut(value: bigint): CandidateOf<FeeBox> {
      return { boxType: 'fee', value, createdAtBlock: 0 };
    }

    // The gap is swept rather than sampled — a 1-unit fee, an ordinary one, and
    // very nearly the whole balance — because no size is special: a credit-side
    // deficit is a missing fee box whatever it measures. The refusal is the
    // FALL-THROUGH's, there being no credit-ledger arm for it to be
    // (NODE_INTERFACE → `validateTx` step 5), which is what the message
    // assertion pins.
    it('rejects a credit deficit of any size when no fee box names it', () => {
      const cases: [bigint, bigint][] = [
        [100_000n, 99_999n],   // a 1-unit gap
        [100_000n, 90_000n],   // an ordinary gap
        [100_000n, 12_000n],   // very nearly the whole balance
      ];
      cases.forEach(([inValue, outValue], i) => {
        const box = creditIn(inValue, 100 + i);
        const tx = buildSignedTx([box.id!], [creditOut(outValue)], ownerPrivKey, ownerPubKey);
        const result = validateTx(deps, tx, 10);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Value non-conservation');
        expect(result.error).toContain(`inputs=${inValue}`);
        expect(result.error).toContain(`outputs=${outValue}`);
      });
    });

    // The same three amounts, expressed. This is the pair that shows the rule
    // changed rather than tightened: the transaction the case above refuses is
    // legal the moment the gap is written down as a box.
    it('accepts each of those once the gap is a fee box, and the sums close', () => {
      const cases: [bigint, bigint][] = [
        [100_000n, 99_999n],
        [100_000n, 90_000n],
        [100_000n, 12_000n],
      ];
      cases.forEach(([inValue, outValue], i) => {
        const box = creditIn(inValue, 130 + i);
        const tx = buildSignedTx(
          [box.id!],
          [creditOut(outValue), feeOut(inValue - outValue)],
          ownerPrivKey, ownerPubKey,
        );
        const result = validateTx(deps, tx, 10);
        expect(result.error).toBeUndefined();
        expect(result.valid).toBe(true);
      });
    });

    // A transaction whose only output is a fee box is accepted and conserves.
    // The whole input becomes the fee, and there is no reason to make a
    // donation to the miner inexpressible (NODE_INTERFACE → Legal box
    // transitions). `credit(X) → credit(0)` expresses no such thing: it is a
    // whole-input deficit, and the case above refuses it.
    it('accepts a transaction whose only output is a fee box for the entire input', () => {
      const box = creditIn(100_000n, 118);
      const tx = buildSignedTx([box.id!], [feeOut(100_000n)], ownerPrivKey, ownerPubKey);
      const result = validateTx(deps, tx, 10);
      expect(result.error).toBeUndefined();
      expect(result.valid).toBe(true);
    });

    // A fee is not required. No amount is checked at this gate — the price of
    // inclusion is relay policy (MEMPOOL_INTERFACE → Fee floor), and requiring
    // a positive fee box would put a price floor in consensus.
    it('accepts a credit transaction carrying no fee box at all', () => {
      const box = creditIn(100_000n, 110);
      const tx = buildSignedTx(
        [box.id!],
        [creditOut(40_000n), creditOut(60_000n)],
        ownerPrivKey, ownerPubKey,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.error).toBeUndefined();
      expect(result.valid).toBe(true);
    });

    // A surplus needs no clause of its own: the fall-through refuses it, in the
    // same message and by the same rule as the deficit above. One rule covers
    // both directions, which is what strict equality buys.
    it('rejects a credit transaction whose outputs exceed its inputs', () => {
      const box = creditIn(100_000n, 111);
      const tx = buildSignedTx([box.id!], [creditOut(100_001n)], ownerPrivKey, ownerPubKey);
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Value non-conservation');
      expect(result.error).toContain('inputs=100000');
      expect(result.error).toContain('outputs=100001');
    });

    // Multi-owner credit inputs are an ordinary multi-party payment — credits
    // are exempt from the karma same-owner rule by name — so the fee box must
    // work for them too rather than only for a self-spend.
    it('accepts a fee box on credit inputs from two different owners', () => {
      const { publicKey: secondPub, privateKey: secondPriv } = generateKeyPairSync('ed25519');
      const secondRaw = rawPublicKey(secondPub);
      const mine = creditIn(60_000n, 112);
      const theirs = creditIn(40_000n, 113, secondRaw);

      const tx: UtxoTransaction = {
        inputs: [mine.id!, theirs.id!],
        outputs: [creditOut(95_000n), feeOut(5_000n)],
        signatures: {},
        protocolVersion: 1,
      };
      const hash = computeTxHash(tx);
      tx.signatures[Buffer.from(ownerPubKey).toString('hex')] = signHash(hash, ownerPrivKey);
      tx.signatures[Buffer.from(secondRaw).toString('hex')] = signHash(hash, secondPriv);

      const result = validateTx(deps, tx, 10);
      expect(result.error).toBeUndefined();
      expect(result.valid).toBe(true);
    });

    // --- how many fee boxes, and holding what ------------------------------

    // A second fee output carries no information and gives one economic fact
    // two encodings with different `utxoTxRoot` — the same "one block, one
    // encoding" the zero-value coinbase output is refused for
    // (NODE_INTERFACE → Legal box transitions).
    it('rejects a second fee output', () => {
      const box = creditIn(100_000n, 140);
      const tx = buildSignedTx(
        [box.id!],
        [creditOut(90_000n), feeOut(6_000n), feeOut(4_000n)],
        ownerPrivKey, ownerPubKey,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('at most one FeeBox');
    });

    // ...and the refusal is the transition's, not conservation's. The sums
    // above close exactly, so without this the rejection could be arithmetic
    // and would move with the wrong rule.
    it('refuses the second fee output at the transition, with the sums closing', () => {
      const box = creditIn(100_000n, 141);
      const tx = buildSignedTx(
        [box.id!],
        [creditOut(90_000n), feeOut(6_000n), feeOut(4_000n)],
        ownerPrivKey, ownerPubKey,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.error).not.toContain('non-conservation');
    });

    // Zero fee means no box (NODE_INTERFACE → Legal box transitions) — the
    // same rule the emission successor carries (TYPES_INTERFACE → EmissionBox).
    // A zero-value fee box conserves, so the transition arm is the only gate
    // that can refuse it, which the negative assertion below pins.
    it('rejects a zero-value fee box', () => {
      const box = creditIn(100_000n, 142);
      const tx = buildSignedTx(
        [box.id!],
        [creditOut(100_000n), feeOut(0n)],
        ownerPrivKey, ownerPubKey,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('zero-value FeeBox');
      expect(result.error).not.toContain('non-conservation');
    });

    // `fee` is excluded by construction rather than by a clause naming it:
    // `KARMA_TRANSITION_TYPES` is an allowlist and the karma arm rejects any
    // output outside it (NODE_INTERFACE → "A FeeBox is reachable only from the
    // credit row"). A karma transaction holds no credits to pay with.
    it('rejects a fee box on a karma-side transaction', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 143);
      const tx = buildSignedTx(
        [karma.id!],
        [
          { boxType: 'karma', value: 90n, createdAtBlock: 0, owner: ownerPubKey },
          feeOut(10n),
        ],
        ownerPrivKey, ownerPubKey,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      // The allowlist's own message, not a fee-specific one: the point of the
      // rule being structural is that no clause names `fee`, so asserting a
      // fee-shaped message here would assert the opposite of the rule.
      expect(result.error).toContain('Illegal karma transition');
      expect(result.error).not.toContain('non-conservation');
    });

    // --- the arms do not collide -------------------------------------------

    // A karma deficit reaches the same fall-through the credit deficit now
    // does, so there is one rule and one message for both. The negative pins
    // that it is not the like gate: `likeTarget` ⟺ a deficit stays exact
    // because the like burn is the only deficit left in the system.
    it('leaves a karma deficit with no likeTarget to strict equality', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 114);
      const tx = buildSignedTx(
        [karma.id!],
        [{ boxType: 'karma', value: 90n, createdAtBlock: 0, owner: ownerPubKey }],
        ownerPrivKey, ownerPubKey,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Value non-conservation');
      expect(result.error).not.toContain('Like non-conservation');
    });

    // A like on credit inputs must reach the like gate rather than the
    // fall-through, so the ordering inside the gate is load-bearing: the like
    // carve runs first and refuses non-karma inputs there.
    it('leaves a like on credit inputs to the like gate, deficit and all', () => {
      const box = creditIn(100_000n, 115);
      const tx = buildSignedTx(
        [box.id!],
        [creditOut(90_000n)],
        ownerPrivKey, ownerPubKey, 1, 'ab'.repeat(32),
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('likeTarget is only legal on an all-karma burn transaction');
      expect(result.error).not.toContain('Value non-conservation');
    });

    // The exemption the conservation table has forgotten before. A rewrite of
    // the arms is exactly what drops it, so it is asserted beside them.
    // ⛔ **THE ZERO-OUTPUT VOUCH EXEMPTION IS RETIRED, AND THIS ASSERTS ITS
    // ABSENCE.** Conservation is unconditional now: an unvouch conserves because
    // its stake lands in a `VouchEscrowBox`, so a zero-output vouch spend is an
    // ordinary whole-input deficit and is refused like any other
    // (ARCHITECTURE → The conservation axiom).
    it('the zero-output vouch spend is no longer exempt from conservation', () => {
      const { publicKey: targetPub } = generateKeyPairSync('ed25519');
      const vouchBox: CandidateOf<VouchBox> = {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: 0,
        voucherId: ownerPubKey,
        targetId: rawPublicKey(targetPub),
      };
      const seeded = seedProvenance<VouchBox>(vouchBox, 116);
      storeInsertBox(seeded);

      const tx = buildSignedTx([seeded.id!], [], ownerPrivKey, ownerPubKey);
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Value non-conservation');
    });

    // A zero-output spend of a *funded* credit box is a whole-input deficit, so
    // conservation (step 5) refuses it before the transition table (step 7) is
    // reached at all. The whole input as a fee has an encoding — `credit(X) →
    // fee(X)`, above — and this is not it.
    it('refuses a funded zero-output credit spend at conservation', () => {
      const box = creditIn(1000n, 117);
      const tx = buildSignedTx([box.id!], [], ownerPrivKey, ownerPubKey);
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Value non-conservation');
    });

    // ...which leaves exactly one shape that reaches the transition's
    // zero-length rule: a credit box holding `0`, where conservation has
    // nothing to say. ⛔ **This is the only input that keeps that rule a live
    // gate rather than defense-in-depth**, and it is what the length test in
    // `isCreditSideTx` parallels — a zero-output transaction must not read as
    // credit-side.
    it('refuses a zero-value zero-output credit spend at the transition', () => {
      const box = creditIn(0n, 119);
      const tx = buildSignedTx([box.id!], [], ownerPrivKey, ownerPubKey);
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('CreditBox can only be spent to create CreditBox or FeeBox outputs');
      expect(result.error).not.toContain('non-conservation');
    });
  });

  // ---------------------------------------------------------------------------
  // 17. Spend timing — the coinbase maturity lock (E-1).
  //
  // `lockedUntilBlock` was derived, validated on creation, encoded, stored and
  // rendered — and no validation path read it on an input.
  // ---------------------------------------------------------------------------
  describe('spend timing — credit', () => {
    function lockedCreditIn(
      value: bigint,
      seed: number,
      lockedUntilBlock: number,
      owner = ownerPubKey,
    ): Stored<CreditBox> {
      const box = seedProvenance<CreditBox>(
        {
          boxType: 'credit' as const,
          value,
          createdAtBlock: 0,
          owner,
          lockedUntilBlock,
        },
        seed,
      );
      storeInsertBox(box);
      return box;
    }

    function unlockedCreditIn(value: bigint, seed: number, owner = ownerPubKey): Stored<CreditBox> {
      const box = seedProvenance<CreditBox>(
        {
          boxType: 'credit' as const,
          value,
          createdAtBlock: 0,
          owner,
        },
        seed,
      );
      storeInsertBox(box);
      return box;
    }

    function creditOut(value: bigint, owner = ownerPubKey): CandidateOf<CreditBox> {
      return { boxType: 'credit', value, createdAtBlock: 0, owner };
    }

    it('refuses a credit input before its lockedUntilBlock', () => {
      const box = lockedCreditIn(50_000n, 200, 200);
      const tx = buildSignedTx([box.id!], [creditOut(50_000n)], ownerPrivKey, ownerPubKey);
      const r = validateTx(deps, tx, 199);
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/locked until 200/);
    });

    it('accepts the same input at exactly lockedUntilBlock', () => {
      const box = lockedCreditIn(50_000n, 201, 200);
      const tx = buildSignedTx([box.id!], [creditOut(50_000n)], ownerPrivKey, ownerPubKey);
      expect(validateTx(deps, tx, 200).valid).toBe(true);
    });

    it('accepts a credit input carrying no lock', () => {
      const box = unlockedCreditIn(50_000n, 202);
      const tx = buildSignedTx([box.id!], [creditOut(50_000n)], ownerPrivKey, ownerPubKey);
      expect(validateTx(deps, tx, 1).valid).toBe(true);
    });

    it('refuses on timing before authorization, on an unsigned locked spend', () => {
      const box = lockedCreditIn(50_000n, 203, 200);
      const tx: UtxoTransaction = {
        inputs: [box.id!],
        outputs: [creditOut(50_000n)],
        signatures: {},
        protocolVersion: 1,
      };
      const r = validateTx(deps, tx, 199);
      expect(r.error).toMatch(/locked until/);
      expect(r.error).not.toMatch(/signature/i);
    });
  });
});
