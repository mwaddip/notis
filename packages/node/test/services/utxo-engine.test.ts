import {
  makePost,
  seedAsOneTx,
  seedProvenance,
  type Stored,
  fixtureProvenance,
  uid } from '../helpers.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  generateKeyPairSync,
  createHash,
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
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
} from '@dagsocial/types';
import type {
  AnyBox,
  KarmaBox,
  InviteBox,
  BondBox,
  Post,
  PostLockBox,
  VouchBox,
  AnyBoxCandidate,
  CandidateOf,
  CreditBox,
  FeeBox,
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
  getKarmaBox,
  getKarmaBoxes,
  insertBox as storeInsertBox,
  consumeBox as storeConsumeBox,
  hasActiveVouchCooldown as storeHasActiveVouchCooldown,
} from '../../src/store/index.js';
import { validateTx, applyTx } from '../../src/services/utxo-engine.js';
import type { UtxoEngineDeps, UtxoResult } from '../../src/services/utxo-engine.js';

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

describe('validateAndApplyTx', () => {
  let db: Database.Database;
  let ownerPubKey: Uint8Array;
  let ownerPrivKey: KeyObject;
  // Raw bytes, not hex: it is assigned `ownerPubKey` and every use feeds a
  // `UserId` field. ARCHITECTURE's rule — typed `UserId` ⇒ raw bytes, typed
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
      hasActiveVouchCooldown: storeHasActiveVouchCooldown,
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
    post?: Post,
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
  // 2. Valid karma→karma+invite+bond (invite creation)
  // -------------------------------------------------------------------------
  it('valid karma to karma+invite+bond (invite creation)', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

    const invitee = new Uint8Array(32).fill(0xaa);
    const newKarma: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      // Only the bond is paid: INVITE_KARMA_AMOUNT is minted at the claim.
      value: 100n - INVITE_BOND_KARMA,
      owner: ownerPubKey,
    };

    const inviteBox: CandidateOf<InviteBox> = {
      boxType: 'invite',
      value: 0n,
      inviterId: ownerUserId,
      inviteePublicKey: invitee,
    };

    const bondBox: CandidateOf<BondBox> = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      inviterId: ownerUserId,
      inviteePublicKey: invitee,
    };

    const tx = buildSignedTx(
      [karma.id!],
      [newKarma, inviteBox, bondBox],
      ownerPrivKey,
      ownerPubKey,
    );
    const result = validateAndApplyTx(deps, tx, 10);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();

    // All outputs should exist
    expect(deps.getBox(computeCandidateBoxId(newKarma, result.txId!, 0))).not.toBeNull();
    expect(deps.getBox(computeCandidateBoxId(inviteBox, result.txId!, 1))).not.toBeNull();
    expect(deps.getBox(computeCandidateBoxId(bondBox, result.txId!, 2))).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // 3. Valid like burn (P2-D): karma → karma at −LIKE_KARMA_COST, likeTarget
  // -------------------------------------------------------------------------
  it('valid like burn: karma → karma at −LIKE_KARMA_COST with likeTarget', () => {
    const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

    const newKarma: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: 100n - LIKE_KARMA_COST,
      owner: ownerPubKey,
    };

    const tx = buildSignedTx(
      [karma.id!],
      [newKarma],
      ownerPrivKey,
      ownerPubKey,
      1,
      'aa'.repeat(32),
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
      owner: ownerPubKey,
    };
    const splitB: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: 40n,
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
  // 11. The invite's two transitions and the shapes that separate them
  //
  // Either key the InviteBox names may sign, and the shape decides which one:
  // invitee → claim, inviter → cancel (NODE_INTERFACE → Legal box
  // transitions). Accepting either signature over either shape is not
  // equivalent, and the pair of rejections below is what pins that.
  // ---------------------------------------------------------------------------
  describe('the invite transitions and their signers', () => {
    let inviterPubKey: Uint8Array;
    let inviterPrivKey: KeyObject;
    let inviteePubKey: Uint8Array;
    let inviteePrivKey: KeyObject;
    let strangerPubKey: Uint8Array;
    let strangerPrivKey: KeyObject;
    let inviteBoxId: string;
    let bondBoxId: string;

    beforeEach(() => {
      const inviterKeys = generateKeyPairSync('ed25519');
      inviterPubKey = rawPublicKey(inviterKeys.publicKey);
      inviterPrivKey = inviterKeys.privateKey;

      const inviteeKeys = generateKeyPairSync('ed25519');
      inviteePubKey = rawPublicKey(inviteeKeys.publicKey);
      inviteePrivKey = inviteeKeys.privateKey;

      const strangerKeys = generateKeyPairSync('ed25519');
      strangerPubKey = rawPublicKey(strangerKeys.publicKey);
      strangerPrivKey = strangerKeys.privateKey;

      // The pair as invite creation emits it: one transaction, both boxes
      // naming the same invitee.
      const inviteBox: CandidateOf<InviteBox> = {
        boxType: 'invite',
        value: 0n,
        inviterId: inviterPubKey,
        inviteePublicKey: inviteePubKey,
      };
      const bondBox: CandidateOf<BondBox> = {
        boxType: 'bond',
        value: INVITE_BOND_KARMA,
        inviterId: inviterPubKey,
        inviteePublicKey: inviteePubKey,
      };
      const [invite, bond] = seedAsOneTx([inviteBox, bondBox]);
      deps.insertBox(invite!);
      deps.insertBox(bond!);
      inviteBoxId = invite!.id!;
      bondBoxId = bond!.id!;
    });

    /** Invite → one KarmaBox for the invitee. */
    function claimTx(owner = inviteePubKey, value = INVITE_KARMA_AMOUNT): UtxoTransaction {
      return {
        inputs: [inviteBoxId],
        outputs: [{ boxType: 'karma', value, owner } as KarmaBox],
        signatures: {},
        protocolVersion: 1,
      };
    }

    /** Invite → nothing. */
    function cancelTx(): UtxoTransaction {
      return {
        inputs: [inviteBoxId],
        outputs: [],
        signatures: {},
        protocolVersion: 1,
      };
    }

    it('accepts an invitee-signed claim', () => {
      const tx = claimTx();
      tx.signatures[Buffer.from(inviteePubKey).toString('hex')] = signHash(computeTxHash(tx), inviteePrivKey);

      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('accepts an inviter-signed cancel', () => {
      const tx = cancelTx();
      tx.signatures[Buffer.from(inviterPubKey).toString('hex')] = signHash(computeTxHash(tx), inviterPrivKey);

      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('rejects an inviter-signed CLAIM', () => {
      // Guard-satisfied by a named key, and still refused: the mint belongs to
      // the invitee's own decision, and applying it bars their address from any
      // further invite forever.
      const tx = claimTx();
      tx.signatures[Buffer.from(inviterPubKey).toString('hex')] = signHash(computeTxHash(tx), inviterPrivKey);

      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('signed by the invitee');
    });

    it('rejects an invitee-signed CANCEL', () => {
      const tx = cancelTx();
      tx.signatures[Buffer.from(inviteePubKey).toString('hex')] = signHash(computeTxHash(tx), inviteePrivKey);

      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('signed by the inviter');
    });

    it('rejects a stranger on either shape', () => {
      for (const build of [claimTx, cancelTx]) {
        const tx = build();
        tx.signatures[Buffer.from(strangerPubKey).toString('hex')] = signHash(computeTxHash(tx), strangerPrivKey);
        expect(validateTx(deps, tx, 10).valid).toBe(false);
      }
    });

    it('rejects a claim paying anyone but the named invitee', () => {
      const tx = claimTx(strangerPubKey);
      tx.signatures[Buffer.from(inviteePubKey).toString('hex')] = signHash(computeTxHash(tx), inviteePrivKey);

      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("owned by the invite's inviteePublicKey");
    });

    it('rejects a claim minting anything but INVITE_KARMA_AMOUNT', () => {
      for (const value of [INVITE_KARMA_AMOUNT - 1n, INVITE_KARMA_AMOUNT + 1n]) {
        const tx = claimTx(inviteePubKey, value);
        tx.signatures[Buffer.from(inviteePubKey).toString('hex')] = signHash(computeTxHash(tx), inviteePrivKey);
        const result = validateTx(deps, tx, 10);
        expect(result.valid, `value=${value}`).toBe(false);
        // The conservation carve fires first: the surplus is wrong before the
        // transition arm reads the amount. Two layers over one rule.
        expect(result.error).toContain('non-conservation');
      }
    });

    it('rejects a claim that also names the bond', () => {
      // Mixed input types have no legal shape any more, and no user
      // transition consumes a bond besides.
      const tx: UtxoTransaction = {
        inputs: [inviteBoxId, bondBoxId],
        outputs: [{
          boxType: 'karma', value: INVITE_KARMA_AMOUNT + INVITE_BOND_KARMA,
          owner: inviteePubKey, 
        } as KarmaBox],
        signatures: {},
        protocolVersion: 1,
      };
      tx.signatures[Buffer.from(inviteePubKey).toString('hex')] = signHash(computeTxHash(tx), inviteePrivKey);

      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Mixed input types|block application/);
    });

    it('rejects two invites in one transaction', () => {
      // Shaped as a two-invite CANCEL, not a two-invite claim: both boxes hold
      // 0 and there are no outputs, so the transaction conserves and reaches
      // step 7. A two-invite claim would be caught one step earlier by the
      // conservation carve, which requires exactly one input — the bound would
      // then be untested rather than proven.
      const second: CandidateOf<InviteBox> = {
        boxType: 'invite',
        value: 0n,
        inviterId: inviterPubKey,
        inviteePublicKey: strangerPubKey,
      };
      const seeded = seedProvenance<InviteBox>(second, 2);
      deps.insertBox(seeded);

      const tx: UtxoTransaction = {
        inputs: [inviteBoxId, seeded.id!],
        outputs: [],
        signatures: {},
        protocolVersion: 1,
      };
      tx.signatures[Buffer.from(inviterPubKey).toString('hex')] = signHash(computeTxHash(tx), inviterPrivKey);

      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('exactly one InviteBox');
    });
  });

  // ---------------------------------------------------------------------------
  // 13. Value conservation (audit C-1, L-11)
  //
  // sum(inputs) == sum(outputs) for every box type, with the three exceptions
  // NODE_INTERFACE → `validateTx` step 5 enumerates: the like burn, the
  // invite-claim surplus, and the zero-output vouch spend. All three move
  // karma; a credit transaction conserves strictly and names its fee in a box
  // (section 16). Every other mint or burn happens in a block-application
  // path, never inside a user transaction.
  // ---------------------------------------------------------------------------
  describe('value conservation (audit C-1, L-11)', () => {
    it('rejects self-signed K(v) -> K(v) + K(2) (mints karma from nothing)', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

      // The C-1 exploit: the change box keeps the full balance while a second
      // box conjures 2 more karma.
      const newKarma: CandidateOf<KarmaBox> = {
        boxType: 'karma',
        value: 100n,
        owner: ownerPubKey,
      };
      const conjured: CandidateOf<KarmaBox> = {
        boxType: 'karma',
        value: 2n,
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

    it('accepts the correct like burn K(v) -> K(v-1) with likeTarget (P2-D)', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

      const newKarma: CandidateOf<KarmaBox> = {
        boxType: 'karma',
        value: 100n - LIKE_KARMA_COST,
        owner: ownerPubKey,
      };

      const tx = buildSignedTx(
        [karma.id!],
        [newKarma],
        ownerPrivKey,
        ownerPubKey,
        1,
        'dd'.repeat(32),
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
          owner: ownerPubKey,
        };

        const tx = buildSignedTx([karma.id!], [newKarma], ownerPrivKey, ownerPubKey);
        Object.assign(tx.outputs[0]!, { value: badValue });
        const result = validateAndApplyTx(deps, tx, 10);

        expect(result.valid).toBe(false);
        expect(result.error).toContain("field 'value' must be a non-negative bigint < 2^64");
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
        owner: ownerPubKey,
      };
      const negative: CandidateOf<KarmaBox> = {
        boxType: 'karma',
        value: 0n,
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
      expect(result.error).toContain("field 'value' must be a non-negative bigint < 2^64");
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
        owner: ownerPubKey,
      };
      const postLock: CandidateOf<PostLockBox> = {
        boxType: 'post_lock',
        value: POST_LOCK_THREAD_COST,
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
        makePost(ownerPubKey, 'conserving lock payload'),
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
        owner: ownerPubKey,
      };
      const vouchBox: CandidateOf<VouchBox> = {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
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

    it('accepts a conserving invite-create tx K(v) -> K(v-25) + Invite(0) + Bond(25)', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

      const newKarma: CandidateOf<KarmaBox> = {
        boxType: 'karma',
        // Only the bond leaves the change box: the invite holds nothing.
        value: 100n - INVITE_BOND_KARMA,
        owner: ownerPubKey,
      };
      const inviteBox: CandidateOf<InviteBox> = {
        boxType: 'invite',
        value: 0n,
        inviterId: ownerUserId,
        inviteePublicKey: new Uint8Array(32).fill(0xbb),
      };
      const bondBox: CandidateOf<BondBox> = {
        boxType: 'bond',
        value: INVITE_BOND_KARMA,
        inviterId: ownerUserId,
        inviteePublicKey: new Uint8Array(32).fill(0xbb),
      };

      const tx = buildSignedTx(
        [karma.id!],
        [newKarma, inviteBox, bondBox],
        ownerPrivKey,
        ownerPubKey,
      );
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('rejects invite-create that does not debit the change box (audit C-1)', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

      // The transition arm pins the bond's value but nothing there requires the
      // change box to be debited for it. Conservation is what catches this.
      const newKarma: CandidateOf<KarmaBox> = {
        boxType: 'karma',
        value: 100n,
        owner: ownerPubKey,
      };
      const inviteBox: CandidateOf<InviteBox> = {
        boxType: 'invite',
        value: 0n,
        inviterId: ownerUserId,
        inviteePublicKey: new Uint8Array(32).fill(0xcc),
      };
      const bondBox: CandidateOf<BondBox> = {
        boxType: 'bond',
        value: INVITE_BOND_KARMA,
        inviterId: ownerUserId,
        inviteePublicKey: new Uint8Array(32).fill(0xcc),
      };

      const tx = buildSignedTx(
        [karma.id!],
        [newKarma, inviteBox, bondBox],
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
        value: INVITE_BOND_KARMA,
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
        [{ boxType: 'karma', value: INVITE_BOND_KARMA, owner: ownerPubKey } as KarmaBox],
        ownerPrivKey,
        ownerPubKey,
      );
      const authorized = validateTx(deps, conserving, 10);
      expect(authorized.valid).toBe(false);
      expect(authorized.error).toContain('block application');
    });

    it('accepts a VouchBox burn (unvouch) — karma escrows into the cooldown', () => {
      const { publicKey: targetPub } = generateKeyPairSync('ed25519');
      const vouchBox: CandidateOf<VouchBox> = {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        voucherId: ownerPubKey,
        targetId: rawPublicKey(targetPub),
      };
      const seededVouchBox = seedProvenance<VouchBox>(vouchBox, 1);
      const vouchBoxId = seededVouchBox.id;
      storeInsertBox(seededVouchBox);

      const tx = buildSignedTx([vouchBoxId], [], ownerPrivKey, ownerPubKey);
      const result = validateAndApplyTx(deps, tx, 10);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
      expect(deps.getBox(vouchBoxId)).toBeNull();
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
        value: 100n,
        owner: ownerPubKey,
      };
      const seededCreditBox = seedProvenance<CreditBox>(creditBox, 1);
      const creditBoxId = seededCreditBox.id;
      storeInsertBox(seededCreditBox);

      const tx = buildSignedTx(
        [creditBoxId],
        [
          { ...creditBox, value: 30n, owner: recipientRaw },
          { ...creditBox, value: 70n },
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
  // 14. The Invite+Bond sweep (audit H-2), closed by construction
  //
  // The attack was a 3-input "cancel shape" — the attacker's own KarmaBox plus
  // the InviteBox plus the uncommitted BondBox — sweeping both into their own
  // karma with no inviter signature. It needed a mixed-type input combination,
  // which `validateTx` step 3 permitted for exactly two shapes.
  //
  // Both preconditions are gone: every legal shape is single-type now, and a
  // bond input is refused by authorization whatever else the transaction holds. The
  // sweep is enumerated here rather than assumed unreachable, because "step 3
  // admits no exceptions" is a claim a future arm could quietly reverse.
  // ---------------------------------------------------------------------------
  describe('the Invite+Bond sweep (audit H-2)', () => {
    it('rejects the 3-input sweep, attacker-signed', () => {
      const inviterKeys = generateKeyPairSync('ed25519');
      const inviterPubKey = rawPublicKey(inviterKeys.publicKey);
      const attackerKeys = generateKeyPairSync('ed25519');
      const attackerPubKey = rawPublicKey(attackerKeys.publicKey);

      const karma = createAndInsertKarma(attackerPubKey, 100n, 3);
      const [invite, bond] = seedAsOneTx([
        {
          boxType: 'invite' as const, value: 0n, inviterId: inviterPubKey,
          inviteePublicKey: attackerPubKey, 
        },
        {
          boxType: 'bond' as const, value: INVITE_BOND_KARMA, inviterId: inviterPubKey,
          inviteePublicKey: attackerPubKey, 
        },
      ]);
      deps.insertBox(invite!);
      deps.insertBox(bond!);

      const tx: UtxoTransaction = {
        inputs: [karma.id!, invite!.id!, bond!.id!],
        outputs: [{
          boxType: 'karma',
          value: 100n + INVITE_KARMA_AMOUNT + INVITE_BOND_KARMA,
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
      expect(deps.getBox(invite!.id!)).not.toBeNull();
      expect(deps.getBox(bond!.id!)).not.toBeNull();
    });

    it('every legal shape is single-type — step 3 admits no exceptions', () => {
      // The precondition itself, stated directly. The two exceptions step 3
      // used to carry (invite+bond claim, karma+invite+bond cancel) were the
      // whole of the sweep's admission.
      const karma = createAndInsertKarma(ownerPubKey, 100n, 4);
      const [invite] = seedAsOneTx([{
        boxType: 'invite' as const, value: 0n, inviterId: ownerUserId,
        inviteePublicKey: new Uint8Array(32).fill(0x5c), 
      }], 1, 77);
      deps.insertBox(invite!);

      const tx: UtxoTransaction = {
        inputs: [karma.id!, invite!.id!],
        outputs: [{
          boxType: 'karma', value: 100n + INVITE_KARMA_AMOUNT, owner: ownerPubKey,
        } as KarmaBox],
        signatures: {},
        protocolVersion: 1,
      };
      tx.signatures[Buffer.from(ownerPubKey).toString('hex')] = signHash(computeTxHash(tx), ownerPrivKey);

      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Mixed input types');
    });
  });

  // ---------------------------------------------------------------------------
  // 15. P2-D like biconditional: `likeTarget` present ⟺ deficit exactly
  // LIKE_KARMA_COST — the only legal karma deficit in any user transaction —
  // and the like shape is exactly one karma output, same owner as all inputs.
  // ---------------------------------------------------------------------------
  describe('P2-D like biconditional and shape', () => {
    const TARGET = 'ab'.repeat(32);

    function karmaOut(value: bigint, owner: Uint8Array): KarmaBox {
      return {
        boxType: 'karma',
        value,
        owner,
      } as KarmaBox;
    }

    // --- the four quadrants -------------------------------------------------

    it('quadrant 1 — deficit of LIKE_KARMA_COST with likeTarget: valid', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const tx = buildSignedTx(
        [karma.id!], [karmaOut(99n, ownerPubKey)], ownerPrivKey, ownerPubKey, 1, TARGET,
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

    it('quadrant 3 — likeTarget on a conserving tx (zero deficit): invalid', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const tx = buildSignedTx(
        [karma.id!], [karmaOut(100n, ownerPubKey)], ownerPrivKey, ownerPubKey, 1, TARGET,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Like non-conservation');
    });

    it('quadrant 4a — likeTarget with a deficit of 2: invalid', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const tx = buildSignedTx(
        [karma.id!], [karmaOut(98n, ownerPubKey)], ownerPrivKey, ownerPubKey, 1, TARGET,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Like non-conservation');
    });

    it('quadrant 4b — likeTarget with a surplus: invalid', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const tx = buildSignedTx(
        [karma.id!], [karmaOut(101n, ownerPubKey)], ownerPrivKey, ownerPubKey, 1, TARGET,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Like non-conservation');
    });

    // --- input rules --------------------------------------------------------

    it('multi-input like: two karma boxes, one owner, one −1 output: valid', () => {
      const karmaA = createAndInsertKarma(ownerPubKey, 60n, 1);
      const karmaB = createAndInsertKarma(ownerPubKey, 40n, 2);
      const tx = buildSignedTx(
        [karmaA.id!, karmaB.id!],
        [karmaOut(100n - LIKE_KARMA_COST, ownerPubKey)],
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
        [karmaOut(100n - LIKE_KARMA_COST, ownerPubKey)],
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
        value: 100n,
        owner: ownerPubKey,
      };
      Object.assign(creditBox, fixtureProvenance(creditBox, 1));
      const creditId = computeBoxId(creditBox as never);
      storeInsertBox({ ...creditBox, id: creditId } as AnyBox);

      const tx = buildSignedTx(
        [creditId],
        [{ ...creditBox, value: 99n } as AnyBox],
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
        [karmaOut(60n, ownerPubKey), karmaOut(39n, ownerPubKey)],
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
        originalValue: 5n,
        owner: ownerPubKey,
      } as PostLockBox;
      const tx = buildSignedTx(
        [karma.id!],
        [karmaOut(94n, ownerPubKey), postLock],
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
  // `FeeBox` output it names (NODE_INTERFACE → `validateTx` step 5; the three
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
        owner,
      };
    }

    function feeOut(value: bigint): CandidateOf<FeeBox> {
      return { boxType: 'fee', value };
    }

    // The gap is swept rather than sampled — a 1-unit fee, an ordinary one, and
    // very nearly the whole balance — because no size is special: a credit-side
    // deficit is a missing fee box whatever it measures. The refusal is the
    // FALL-THROUGH's, there being no credit-ledger arm for it to be
    // (NODE_INTERFACE → `validateTx` step 5), which is what the message
    // assertion pins.
    it('rejects a credit deficit of any size when no fee box names it', () => {
      const cases: [bigint, bigint][] = [
        [1000n, 999n],   // a 1-unit gap
        [1000n, 900n],   // an ordinary gap
        [1000n, 1n],     // very nearly the whole balance
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
        [1000n, 999n],
        [1000n, 900n],
        [1000n, 1n],
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
    // donation to the miner inexpressible (NODE_INTERFACE → the credit
    // transition row). `credit(X) → credit(0)` expresses no such thing: it is a
    // whole-input deficit, and the case above refuses it.
    it('accepts a transaction whose only output is a fee box for the entire input', () => {
      const box = creditIn(1000n, 118);
      const tx = buildSignedTx([box.id!], [feeOut(1000n)], ownerPrivKey, ownerPubKey);
      const result = validateTx(deps, tx, 10);
      expect(result.error).toBeUndefined();
      expect(result.valid).toBe(true);
    });

    // A fee is not required. No amount is checked at this gate — the price of
    // inclusion is relay policy (MEMPOOL_INTERFACE → Fee floor), and requiring
    // a positive fee box would put a price floor in consensus.
    it('accepts a credit transaction carrying no fee box at all', () => {
      const box = creditIn(1000n, 110);
      const tx = buildSignedTx(
        [box.id!],
        [creditOut(400n), creditOut(600n)],
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
      const box = creditIn(1000n, 111);
      const tx = buildSignedTx([box.id!], [creditOut(1001n)], ownerPrivKey, ownerPubKey);
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Value non-conservation');
      expect(result.error).toContain('inputs=1000');
      expect(result.error).toContain('outputs=1001');
    });

    // Multi-owner credit inputs are an ordinary multi-party payment — credits
    // are exempt from the karma same-owner rule by name — so the fee box must
    // work for them too rather than only for a self-spend.
    it('accepts a fee box on credit inputs from two different owners', () => {
      const { publicKey: secondPub, privateKey: secondPriv } = generateKeyPairSync('ed25519');
      const secondRaw = rawPublicKey(secondPub);
      const mine = creditIn(600n, 112);
      const theirs = creditIn(400n, 113, secondRaw);

      const tx: UtxoTransaction = {
        inputs: [mine.id!, theirs.id!],
        outputs: [creditOut(950n), feeOut(50n)],
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
    // (NODE_INTERFACE → the credit transition row).
    it('rejects a second fee output', () => {
      const box = creditIn(1000n, 140);
      const tx = buildSignedTx(
        [box.id!],
        [creditOut(900n), feeOut(60n), feeOut(40n)],
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
      const box = creditIn(1000n, 141);
      const tx = buildSignedTx(
        [box.id!],
        [creditOut(900n), feeOut(60n), feeOut(40n)],
        ownerPrivKey, ownerPubKey,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.error).not.toContain('non-conservation');
    });

    // Zero fee means no box (NODE_INTERFACE → the credit transition row) — the
    // same rule the emission successor carries (TYPES_INTERFACE → EmissionBox).
    // A zero-value fee box conserves, so the transition arm is the only gate
    // that can refuse it, which the negative assertion below pins.
    it('rejects a zero-value fee box', () => {
      const box = creditIn(1000n, 142);
      const tx = buildSignedTx(
        [box.id!],
        [creditOut(1000n), feeOut(0n)],
        ownerPrivKey, ownerPubKey,
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('zero-value FeeBox');
      expect(result.error).not.toContain('non-conservation');
    });

    // `fee` is excluded by construction rather than by a clause naming it:
    // `KARMA_BOX_TYPES` is an allowlist and the karma arm rejects any output
    // outside it (NODE_INTERFACE → a FeeBox is reachable only from the credit
    // row). A karma transaction holds no credits to pay with.
    it('rejects a fee box on a karma-side transaction', () => {
      const karma = createAndInsertKarma(ownerPubKey, 100n, 143);
      const tx = buildSignedTx(
        [karma.id!],
        [
          { boxType: 'karma', value: 90n, owner: ownerPubKey },
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
        [{ boxType: 'karma', value: 90n, owner: ownerPubKey }],
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
      const box = creditIn(1000n, 115);
      const tx = buildSignedTx(
        [box.id!],
        [creditOut(900n)],
        ownerPrivKey, ownerPubKey, 1, 'ab'.repeat(32),
      );
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('likeTarget is only legal on an all-karma burn transaction');
      expect(result.error).not.toContain('Value non-conservation');
    });

    // The exemption the conservation table has forgotten before. A rewrite of
    // the arms is exactly what drops it, so it is asserted beside them.
    it('leaves the zero-output vouch exemption intact', () => {
      const { publicKey: targetPub } = generateKeyPairSync('ed25519');
      const vouchBox: CandidateOf<VouchBox> = {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        voucherId: ownerPubKey,
        targetId: rawPublicKey(targetPub),
      };
      const seeded = seedProvenance<VouchBox>(vouchBox, 116);
      storeInsertBox(seeded);

      const tx = buildSignedTx([seeded.id!], [], ownerPrivKey, ownerPubKey);
      const result = validateTx(deps, tx, 10);
      expect(result.error).toBeUndefined();
      expect(result.valid).toBe(true);
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
});
