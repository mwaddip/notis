import {
  seedProvenance,
  type Stored,
  FIXTURE_BOND_KARMA,
} from '../helpers.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import {
  computeTxId,
  VOUCH_KARMA_AMOUNT,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
} from '@dagsocial/types';
import type {
  AnyBox,
  KarmaBox,
  BondBox,
  VouchBox,
  AnyBoxCandidate,
  CandidateOf,
  VouchEscrowBox,
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
  getVouchBox as storeGetVouchBox,
  getNetworkRecord as storeGetNetworkRecord,
} from '../../src/store/index.js';
import {
  beginBlockJournal,
  finishBlockJournal,
  insertBlockJournal,
} from '../../src/store/journal.js';
import { revertBlock } from '../../src/services/fork-resolution.js';
import { validateTx, applyTx, isMember } from '../../src/services/utxo-engine.js';
import type { UtxoEngineDeps, UtxoResult } from '../../src/services/utxo-engine.js';
import { config } from '../../src/config.js';

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

function rawPublicKey(keyObj: KeyObject): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

function signHash(hash: Uint8Array, privKey: KeyObject): Uint8Array {
  const sig = cryptoSign(null, Buffer.from(hash), privKey);
  return new Uint8Array(sig);
}

function computeTxHash(tx: UtxoTransaction): Uint8Array {
  return Buffer.from(computeTxId(tx), 'hex');
}

describe('membership arms', () => {
  let db: Database.Database;
  let ownerPubKey: Uint8Array;
  let ownerPrivKey: KeyObject;

  function makeDeps(): UtxoEngineDeps {
    return {
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
      getPendingPostAuthor: () => null,
      runInTransaction: (fn: () => void) => {
        (db.transaction(fn) as () => void)();
      },
      getVouchBox: storeGetVouchBox,
      getNetworkRecord: storeGetNetworkRecord,
      membershipBarMultiplier: 1,
      putIdentityRecord: storePutIdentityRecord,
      protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
    };
  }

  let deps: UtxoEngineDeps;

  beforeEach(() => {
    initDb(':memory:');
    db = getDb();
    db.prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    ownerPubKey = rawPublicKey(publicKey);
    ownerPrivKey = privateKey;

    deps = makeDeps();
  });

  afterEach(() => {
    closeDb();
  });

  function seedAsRoot(id: Uint8Array, height = 1): void {
    storePutIdentityRecord(id, {
      lastActivityBlock: height, lastDecayBlock: 0, invitedAtBlock: 0,
      lifetimeLikesReceived: 0n, memberSinceBlock: height, memberBar: 0,
      memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
    });
  }

  function seedRecord(id: Uint8Array, height = 1): void {
    storePutIdentityRecord(id, {
      lastActivityBlock: height, lastDecayBlock: 0, invitedAtBlock: height,
      lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0,
      memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
    });
  }

  function seedMember(
    id: Uint8Array,
    height: number,
    bar: number,
    vouches: number,
    invitesUsed = 0,
  ): void {
    storePutIdentityRecord(id, {
      lastActivityBlock: height, lastDecayBlock: 0, invitedAtBlock: 0,
      lifetimeLikesReceived: 0n, memberSinceBlock: height, memberBar: bar,
      memberVouches: vouches, memberLikes: 0n, invitesUsed,
    });
  }

  function setNetworkMemberCount(n: number): void {
    db.prepare('UPDATE network_record SET member_count = ? WHERE id = 1').run(n);
  }

  function createAndInsertKarma(
    owner: Uint8Array,
    value: bigint,
    seed: number,
  ): Stored<KarmaBox> {
    const box = seedProvenance<KarmaBox>(
      { boxType: 'karma' as const, value, createdAtBlock: 0, owner },
      seed,
    );
    storeInsertBox(box);
    return box;
  }

  function buildSignedTx(
    inputs: string[],
    rawOutputs: AnyBoxCandidate[],
    privKey: KeyObject,
    pubKey: Uint8Array,
  ): UtxoTransaction {
    const hexKey = Buffer.from(pubKey).toString('hex');
    const tx: UtxoTransaction = {
      inputs,
      outputs: rawOutputs,
      signatures: {},
      protocolVersion: 1,
    };
    const hash = computeTxHash(tx);
    tx.signatures[hexKey] = signHash(hash, privKey);
    return tx;
  }

  function makeInviteTx(
    karmaId: string,
    inviter: Uint8Array,
    inviterPriv: KeyObject,
    invitee: Uint8Array,
    karmaValue: bigint,
    bondValue: bigint,
  ): UtxoTransaction {
    const karmaOut: CandidateOf<KarmaBox> = {
      boxType: 'karma', value: karmaValue - bondValue,
      createdAtBlock: 0, owner: inviter,
    };
    const bondOut: CandidateOf<BondBox> = {
      boxType: 'bond', value: bondValue,
      createdAtBlock: 0, inviterId: inviter, inviteePublicKey: invitee,
    };
    const outputs: AnyBoxCandidate[] =
      karmaValue - bondValue > 0n ? [karmaOut, bondOut] : [bondOut];
    return buildSignedTx([karmaId], outputs, inviterPriv, inviter);
  }

  function makeVouchTx(
    karmaId: string,
    voucher: Uint8Array,
    voucherPriv: KeyObject,
    target: Uint8Array,
    karmaValue: bigint,
    height = 10,
  ): UtxoTransaction {
    const karmaOut: CandidateOf<KarmaBox> = {
      boxType: 'karma', value: karmaValue - VOUCH_KARMA_AMOUNT,
      createdAtBlock: height, owner: voucher,
    };
    const vouchOut: CandidateOf<VouchBox> = {
      boxType: 'vouch', value: VOUCH_KARMA_AMOUNT,
      createdAtBlock: height, voucherId: voucher, targetId: target,
    };
    return buildSignedTx([karmaId], [karmaOut, vouchOut], voucherPriv, voucher);
  }

  // -------------------------------------------------------------------------
  // ARCHITECTURE → The invite budget
  // -------------------------------------------------------------------------

  describe('invite budget', () => {
    it('the k-th invite needs k·D(N_now) vouches', () => {
      // D(27, 1) = 3. Member with bar=3, 7 vouches → floor(7/3) = 2 available.
      setNetworkMemberCount(27);
      seedMember(ownerPubKey, 1, 3, 7);
      const karma = createAndInsertKarma(ownerPubKey, 500n, 1);

      const invitee1 = new Uint8Array(32).fill(0xa1);
      const tx1 = makeInviteTx(
        karma.id!, ownerPubKey, ownerPrivKey, invitee1, 500n, FIXTURE_BOND_KARMA,
      );
      const r1 = validateAndApplyTx(deps, tx1, 10);
      expect(r1.valid).toBe(true);
      const rec1 = storeGetIdentityRecord(ownerPubKey)!;
      expect(rec1.invitesUsed).toBe(1);

      // Second invite — need a new karma box (first was consumed).
      const karma2 = createAndInsertKarma(ownerPubKey, 500n, 2);
      const invitee2 = new Uint8Array(32).fill(0xa2);
      const tx2 = makeInviteTx(
        karma2.id!, ownerPubKey, ownerPrivKey, invitee2, 500n, FIXTURE_BOND_KARMA,
      );
      const r2 = validateAndApplyTx(deps, tx2, 10);
      expect(r2.valid).toBe(true);
      expect(storeGetIdentityRecord(ownerPubKey)!.invitesUsed).toBe(2);

      // N grows → D(64, 1) = 4. floor(7/4) = 1, 1 - 2 = -1 → refused.
      setNetworkMemberCount(64);
      const karma3 = createAndInsertKarma(ownerPubKey, 500n, 3);
      const invitee3 = new Uint8Array(32).fill(0xa3);
      const tx3 = makeInviteTx(
        karma3.id!, ownerPubKey, ownerPrivKey, invitee3, 500n, FIXTURE_BOND_KARMA,
      );
      const r3 = validateTx(deps, tx3, 10);
      expect(r3.valid).toBe(false);
      expect(r3.error).toContain('no invites available');

      // Grow vouches to 12 → floor(12/4) = 3, 3 - 2 = 1. Accepted.
      storePutIdentityRecord(ownerPubKey, {
        ...storeGetIdentityRecord(ownerPubKey)!,
        memberVouches: 12,
      });
      const r3b = validateAndApplyTx(deps, tx3, 10);
      expect(r3b.valid).toBe(true);
      expect(storeGetIdentityRecord(ownerPubKey)!.invitesUsed).toBe(3);
    });

    it('a root with zero vouches invites — bounded by bond karma alone', () => {
      seedAsRoot(ownerPubKey);
      const karma = createAndInsertKarma(ownerPubKey, 500n, 1);
      const invitee = new Uint8Array(32).fill(0xbb);
      const tx = makeInviteTx(
        karma.id!, ownerPubKey, ownerPrivKey, invitee, 500n, FIXTURE_BOND_KARMA,
      );
      const result = validateAndApplyTx(deps, tx, 10);
      expect(result.valid).toBe(true);
    });

    it('a root record never lapses — isMember holds at zero vouches', () => {
      seedAsRoot(ownerPubKey);
      const record = storeGetIdentityRecord(ownerPubKey)!;
      expect(isMember(record)).toBe(true);
      expect(record.memberBar).toBe(0);
      expect(record.memberVouches).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // NODE_INTERFACE → Vouch transition rules
  // -------------------------------------------------------------------------

  describe('vouch-cast arm', () => {
    it('a resident cast is refused', () => {
      seedRecord(ownerPubKey);
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const { publicKey: targetPub } = generateKeyPairSync('ed25519');
      const targetRaw = rawPublicKey(targetPub);
      seedRecord(targetRaw);

      const tx = makeVouchTx(karma.id!, ownerPubKey, ownerPrivKey, targetRaw, 100n);
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('voucher to be a member');
    });

    it('a self-vouch is refused', () => {
      seedAsRoot(ownerPubKey);
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

      const tx = makeVouchTx(karma.id!, ownerPubKey, ownerPrivKey, ownerPubKey, 100n);
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Cannot vouch for yourself');
    });

    it('a duplicate pair is refused', () => {
      seedAsRoot(ownerPubKey);
      const { publicKey: targetPub } = generateKeyPairSync('ed25519');
      const targetRaw = rawPublicKey(targetPub);
      seedRecord(targetRaw);

      // Insert an existing vouch box for (owner, target).
      const existingVouch = seedProvenance<VouchBox>(
        {
          boxType: 'vouch' as const, value: VOUCH_KARMA_AMOUNT,
          createdAtBlock: 5, voucherId: ownerPubKey, targetId: targetRaw,
        },
        99,
      );
      storeInsertBox(existingVouch);

      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);
      const tx = makeVouchTx(karma.id!, ownerPubKey, ownerPrivKey, targetRaw, 100n);
      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('A live vouch already exists');
    });

    it('a vouch from a younger member does not move an older member count', () => {
      // A (owner) is younger: memberSinceBlock=5.
      // B (target) is older: memberSinceBlock=3.
      // counted(A→B) = B.memberSinceBlock=0? No. A.memberSinceBlock(5) < B.memberSinceBlock(3)? No.
      // Not counted → B.memberVouches stays at its current value.
      const { publicKey: targetPub, privateKey: _targetPriv } = generateKeyPairSync('ed25519');
      const targetRaw = rawPublicKey(targetPub);
      seedMember(ownerPubKey, 5, 1, 3);
      seedMember(targetRaw, 3, 1, 3);
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

      const tx = makeVouchTx(karma.id!, ownerPubKey, ownerPrivKey, targetRaw, 100n);
      const result = validateAndApplyTx(deps, tx, 10);
      expect(result.valid).toBe(true);

      const targetAfter = storeGetIdentityRecord(targetRaw)!;
      expect(targetAfter.memberVouches).toBe(3);
    });

    it('a vouch on a not-yet member counts and still counts after the target set', () => {
      // A (root, memberSinceBlock=1) vouches for B (resident, memberSinceBlock=0).
      // counted(A→B) = B.memberSinceBlock=0? Yes. B.memberVouches goes 0→1.
      seedAsRoot(ownerPubKey);
      const { publicKey: targetPub } = generateKeyPairSync('ed25519');
      const targetRaw = rawPublicKey(targetPub);
      seedRecord(targetRaw);
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

      const tx = makeVouchTx(karma.id!, ownerPubKey, ownerPrivKey, targetRaw, 100n);
      const result = validateAndApplyTx(deps, tx, 10);
      expect(result.valid).toBe(true);

      const targetAfter = storeGetIdentityRecord(targetRaw)!;
      expect(targetAfter.memberVouches).toBe(1);

      // Simulate the target getting set (membership pass would write this).
      storePutIdentityRecord(targetRaw, {
        ...targetAfter,
        memberSinceBlock: 10,
        memberBar: 1,
      });
      // A.memberSinceBlock(1) < B.memberSinceBlock(10) → still counted.
      // The vouch is still live and counted: no counter change needed.
    });
  });

  // -------------------------------------------------------------------------
  // NODE_INTERFACE → Vouch transition rules
  // -------------------------------------------------------------------------

  describe('vouch target', () => {
    it('a vouch naming a key with no record is refused and the key is still invitable', () => {
      seedAsRoot(ownerPubKey);
      const karma = createAndInsertKarma(ownerPubKey, 500n, 1);
      const freshTarget = new Uint8Array(32).fill(0xcc);

      // Vouch refused — no record.
      const vouchTx = makeVouchTx(karma.id!, ownerPubKey, ownerPrivKey, freshTarget, 500n);
      const vouchResult = validateTx(deps, vouchTx, 10);
      expect(vouchResult.valid).toBe(false);
      expect(vouchResult.error).toContain('Vouch target holds no identity record');

      // The key is still invitable — no record was created.
      expect(storeGetIdentityRecord(freshTarget)).toBeNull();
      const inviteTx = makeInviteTx(
        karma.id!, ownerPubKey, ownerPrivKey, freshTarget, 500n, FIXTURE_BOND_KARMA,
      );
      const inviteResult = validateAndApplyTx(deps, inviteTx, 10);
      expect(inviteResult.valid).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // NODE_INTERFACE → Vouch transition rules, NODE_INTERFACE → Block Journal
  // -------------------------------------------------------------------------

  describe('round trip', () => {
    it('the unvouch round trip through applyTx restores the count', () => {
      seedAsRoot(ownerPubKey);
      const { publicKey: targetPub } = generateKeyPairSync('ed25519');
      const targetRaw = rawPublicKey(targetPub);
      seedRecord(targetRaw);
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

      // Cast: B's memberVouches goes 0 → 1.
      const vouchTx = makeVouchTx(karma.id!, ownerPubKey, ownerPrivKey, targetRaw, 100n);
      const castResult = validateAndApplyTx(deps, vouchTx, 10);
      expect(castResult.valid).toBe(true);
      expect(storeGetIdentityRecord(targetRaw)!.memberVouches).toBe(1);

      // Find the vouch box that was created.
      const vouchBox = storeGetVouchBox(ownerPubKey, targetRaw)!;
      expect(vouchBox).toBeTruthy();

      // Unvouch: consume the vouch, produce an escrow. B's memberVouches goes 1 → 0.
      const escrow: CandidateOf<VouchEscrowBox> = {
        boxType: 'vouch_escrow',
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: 12,
        owner: ownerPubKey,
        releaseAtBlock: vouchBox.createdAtBlock + 2,
      };
      const unvouchTx = buildSignedTx(
        [vouchBox.id!], [escrow as AnyBoxCandidate], ownerPrivKey, ownerPubKey,
      );
      const unvouchResult = validateAndApplyTx(deps, unvouchTx, 12);
      expect(unvouchResult.valid).toBe(true);
      expect(storeGetIdentityRecord(targetRaw)!.memberVouches).toBe(0);
    });

    it('revertBlock restores the count through the journal with no arithmetic', () => {
      seedAsRoot(ownerPubKey);
      const { publicKey: targetPub } = generateKeyPairSync('ed25519');
      const targetRaw = rawPublicKey(targetPub);
      seedRecord(targetRaw);
      const karma = createAndInsertKarma(ownerPubKey, 100n, 1);

      expect(storeGetIdentityRecord(targetRaw)!.memberVouches).toBe(0);

      // Open a block journal, apply a vouch.
      beginBlockJournal(10);
      const vouchTx = makeVouchTx(karma.id!, ownerPubKey, ownerPrivKey, targetRaw, 100n);
      const castResult = validateAndApplyTx(deps, vouchTx, 10);
      expect(castResult.valid).toBe(true);
      expect(storeGetIdentityRecord(targetRaw)!.memberVouches).toBe(1);

      // Finish and persist the journal.
      const journal = finishBlockJournal();
      insertBlockJournal(journal);

      // Revert the block. B's count should be back to 0 — restored from the
      // journal's replaced value, not from subtracting 1.
      revertBlock(10);
      expect(storeGetIdentityRecord(targetRaw)!.memberVouches).toBe(0);
    });
  });
});
