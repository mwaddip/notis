import {
  describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, type KeyObject } from 'crypto';
import {
  computeBoxId,
  decodeTx,
  VOUCH_KARMA_AMOUNT,
  VOUCH_MIN_BALANCE,
  MEMPOOL_EXPIRY_BLOCKS,
  PROTOCOL_VERSION,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
} from '@dagsocial/types';
import type {
  AnyBox,
  CandidateOf,
  KarmaBox,
  UtxoTransaction,
  VouchBox,
  VouchEscrowBox,
} from '@dagsocial/types';
import Database from 'better-sqlite3';

import {
  initDb,
  closeDb,
  getDb,
  getKarmaBox,
  getKarmaBoxes,
  insertBox,
  getBox as storeGetBox,
  getIdentityRecord as storeGetIdentityRecord,
  hasActiveVouchEscrow as storeHasActiveVouchEscrow,
  getPendingEntries,
} from '../../src/store/index.js';
import { castVouch, initiateUnvouch } from '../../src/services/vouch.js';
import { config } from '../../src/config.js';
import type { UtxoEngineDeps } from '../../src/services/utxo-engine.js';
import {
  fixtureProvenance,
  rawPublicKey,
  seedProvenance,
  signTransaction,
  type Stored,
} from '../helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create and insert a karma box, returning it with its computed id. */
function createKarmaBox(
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
  insertBox(box);
  return box;
}

/** Create and insert a vouch box, returning it with its computed id. */
function createVouchBox(
  voucherId: Uint8Array,
  targetId: Uint8Array,
  seed: number,
): Stored<VouchBox> {
  const box = seedProvenance<VouchBox>(
    {
      boxType: 'vouch' as const,
      value: VOUCH_KARMA_AMOUNT,
      createdAtBlock: 0,
      voucherId,
      targetId,
    },
    seed,
  );
  insertBox(box);
  return box;
}

/**
 * An unreleased `VouchEscrowBox` for a voucher — the state a cooling voucher is
 * in (ARCHITECTURE → Vouch boxes).
 *
 * ⚠ **It names no target.** The gate it feeds is keyed on the voucher alone,
 * because that is the only question the box can answer.
 */
function seedVouchEscrow(owner: Uint8Array, releaseAtBlock: number): void {
  insertBox(
    seedProvenance<VouchEscrowBox>(
      {
        boxType: 'vouch_escrow' as const,
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: 0,
        owner,
        releaseAtBlock,
      },
      91,
    ),
  );
}

/** An unsigned vouch tx — for rejections that fire before validateTx. */
function vouchTxFor(
  voucherId: Uint8Array,
  targetId: Uint8Array,
): UtxoTransaction {
  return {
    inputs: [],
    outputs: [
      {
        boxType: 'vouch' as const,
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: 0,
        voucherId,
        targetId,
      },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('vouch service', () => {
  let db: Database.Database;
  let voucherPubKey: Uint8Array;
  let voucherPrivKey: KeyObject;
  let voucherPubKeyHex: string;
  let targetPubKey: Uint8Array;
  let targetPubKeyHex: string;
  let deps: UtxoEngineDeps;

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
      insertBox: (box: AnyBox) => {
        insertBox(box);
      },
      consumeBox: (id: string, atBlock: number) => {
        db.prepare('UPDATE utxo_boxes SET spent_at_block = ? WHERE id = ?').run(atBlock, id);
      },
      getKarmaBox: (owner: Uint8Array) => getKarmaBox(owner),
      getKarmaValue: (owner: Uint8Array) =>
        getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n),
      // ⛔ The real predicate, so a seeded `VouchEscrowBox` actually bars a
      // recast. A stub would leave the rule this suite fronts untested.
      hasActiveVouchEscrow: storeHasActiveVouchEscrow,
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
    };
  }

  /** A fully-formed, signed vouch tx that passes validateTx. */
  function signedVouchTx(
    karmaBoxId: string,
    owner: Uint8Array,
    targetId: Uint8Array,
    atBlock: number,
    privKey?: KeyObject,
  ): UtxoTransaction {
    const ownerHex = Buffer.from(owner).toString('hex');
    const newKarma: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: 99n,
      createdAtBlock: atBlock,
      owner,
    };
    const vouchBox: CandidateOf<VouchBox> = {
      boxType: 'vouch',
      value: VOUCH_KARMA_AMOUNT,
      createdAtBlock: atBlock,
      voucherId: owner,
      targetId,
    };
    const tx: UtxoTransaction = {
      inputs: [karmaBoxId],
      outputs: [
        newKarma,
        vouchBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, privKey ?? voucherPrivKey, ownerHex);
    return tx;
  }

  beforeEach(() => {
    initDb(':memory:');
    db = getDb();

    // Voucher identity
    const voucherKeys = generateKeyPairSync('ed25519');
    voucherPubKey = rawPublicKey(voucherKeys.publicKey);
    voucherPrivKey = voucherKeys.privateKey;
    voucherPubKeyHex = Buffer.from(voucherPubKey).toString('hex');

    // Target identity (different from voucher)
    const targetKeys = generateKeyPairSync('ed25519');
    targetPubKey = rawPublicKey(targetKeys.publicKey);
    targetPubKeyHex = Buffer.from(targetPubKey).toString('hex');

    deps = makeDeps();
  });

  afterEach(() => {
    closeDb();
  });

  // -----------------------------------------------------------------------
  // castVouch — error cases
  // -----------------------------------------------------------------------

  describe('castVouch', () => {
    // -------------------------------------------------------------------------
  // Phase 4 deliverable — id integrity across a REAL store round-trip.
  //
  // Every fixture in this file used to be built by `createKarmaBox(owner, 10, 1)`
  // — a NUMBER in a bigint `value`. The id was computed over that number; the
  // store reads back through `.safeIntegers()` and hands out a bigint; so the
  // box that came out did not derive the id it went in with. This suite seeds
  // ten such boxes, which is why the check lives here and not in a fixture:
  // the in-memory object is exactly what did NOT disagree.
  //
  // `computeBoxId` in `@dagsocial/types` says this holds "by construction for
  // every box in the UTXO set, checkable by any light client, indexer or AVL
  // prover".
  // Measured false for a number-valued box, true for a bigint-valued one.
  // -------------------------------------------------------------------------
  it('every seeded karma and vouch box still derives its own id after storage', () => {
    const karma = createKarmaBox(voucherPubKey, 10n, 1);
    const vouch = createVouchBox(voucherPubKey, targetPubKey, 2);

    for (const seeded of [karma, vouch]) {
      const stored = storeGetBox(seeded.id);
      expect(stored).not.toBeNull();
      expect(typeof stored!.value).toBe('bigint');
      expect(computeBoxId(stored!)).toBe(stored!.id);
    }
  });

  it('rejects if no VouchBox in outputs', () => {
      const tx: UtxoTransaction = {
        inputs: [],
        outputs: [],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };

      expect(() => castVouch(deps, tx, 5)).toThrow(
        'Transaction must contain a VouchBox output',
      );
    });

    it('rejects invalid target (all zeros)', () => {
      const tx: UtxoTransaction = {
        inputs: [],
        outputs: [
          {
            boxType: 'vouch' as const,
            value: VOUCH_KARMA_AMOUNT,
            createdAtBlock: 0,
            voucherId: voucherPubKey,
            targetId: new Uint8Array(32), // all zeros
          },
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };

      expect(() => castVouch(deps, tx, 5)).toThrow(
        'Invalid vouch target: must be a 32-byte public key',
      );
    });

    it('rejects self-vouch', () => {
      const tx: UtxoTransaction = {
        inputs: [],
        outputs: [
          {
            boxType: 'vouch' as const,
            value: VOUCH_KARMA_AMOUNT,
            createdAtBlock: 0,
            voucherId: voucherPubKey,
            targetId: voucherPubKey, // same as voucher
          },
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };

      expect(() => castVouch(deps, tx, 5)).toThrow('Cannot vouch for yourself');
    });

    it('rejects insufficient karma (< 11)', () => {
      // Create a karma box with only 10 karma (below VOUCH_MIN_BALANCE of 11)
      createKarmaBox(voucherPubKey, 10n, 1);

      const tx: UtxoTransaction = {
        inputs: [],
        outputs: [
          {
            boxType: 'vouch' as const,
            value: VOUCH_KARMA_AMOUNT,
            createdAtBlock: 0,
            voucherId: voucherPubKey,
            targetId: targetPubKey,
          },
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };

      expect(() => castVouch(deps, tx, 5)).toThrow(
        `Insufficient karma: need at least ${VOUCH_MIN_BALANCE} to vouch`,
      );
    });

    it('accepts a voucher whose balance clears the threshold across two boxes', () => {
      // The threshold is a balance summed across the voucher's karma boxes
      // (ARCHITECTURE → "Vouch boxes"): two 10-karma boxes cover 11 twice
      // over, and which of them the cast spends does not enter the predicate.
      const first = createKarmaBox(voucherPubKey, 10n, 1);
      createKarmaBox(voucherPubKey, 10n, 2);

      const newKarma: CandidateOf<KarmaBox> = {
        boxType: 'karma',
        value: first.value - VOUCH_KARMA_AMOUNT,
        createdAtBlock: 0,
        owner: voucherPubKey,
      };
      const vouchBox: CandidateOf<VouchBox> = {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: 0,
        voucherId: voucherPubKey,
        targetId: targetPubKey,
      };
      const tx: UtxoTransaction = {
        inputs: [first.id!],
        outputs: [newKarma, vouchBox],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };
      signTransaction(tx, voucherPrivKey, voucherPubKeyHex);

      expect(castVouch(deps, tx, 5).status).toBe('pending');
    });

    it('rejects duplicate vouch (pair already exists)', () => {
      // Give voucher enough karma to pass the balance check
      createKarmaBox(voucherPubKey, 100n, 1);

      // Create an existing vouch box for the same pair
      createVouchBox(voucherPubKey, targetPubKey, 5);

      const tx: UtxoTransaction = {
        inputs: [],
        outputs: [
          {
            boxType: 'vouch' as const,
            value: VOUCH_KARMA_AMOUNT,
            createdAtBlock: 0,
            voucherId: voucherPubKey,
            targetId: targetPubKey,
          },
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };

      expect(() => castVouch(deps, tx, 10)).toThrow(
        'Already vouching for an identity',
      );
    });

    // -------------------------------------------------------------------
    // Single active vouch, across all targets (audit L-4). The check used
    // to be pair-scoped, so one identity could hold many concurrent
    // VouchBoxes just by picking a different target each time.
    // -------------------------------------------------------------------

    it('rejects a second vouch aimed at a different target', () => {
      createKarmaBox(voucherPubKey, 100n, 1);
      createVouchBox(voucherPubKey, targetPubKey, 5);

      const otherTarget = rawPublicKey(generateKeyPairSync('ed25519').publicKey);
      const tx = vouchTxFor(voucherPubKey, otherTarget);

      expect(() => castVouch(deps, tx, 10)).toThrow(
        'Already vouching for an identity',
      );
    });

    it('rejects a second vouch while the first is still pending in the mempool', () => {
      const karma = createKarmaBox(voucherPubKey, 100n, 1);

      // First vouch — validated and queued, no VouchBox in the UTXO set yet.
      const firstTx = signedVouchTx(karma.id!, voucherPubKey, targetPubKey, 5);
      expect(castVouch(deps, firstTx, 5).status).toBe('pending');

      const otherTarget = rawPublicKey(generateKeyPairSync('ed25519').publicKey);
      const secondTx = vouchTxFor(voucherPubKey, otherTarget);

      expect(() => castVouch(deps, secondTx, 6)).toThrow('Vouch already pending');
    });

    it('control — a voucher with no active or pending vouch is accepted', () => {
      const karma = createKarmaBox(voucherPubKey, 100n, 1);
      const tx = signedVouchTx(karma.id!, voucherPubKey, targetPubKey, 5);
      expect(castVouch(deps, tx, 5).status).toBe('pending');
    });

    it('control — a different voucher is unaffected by another identity vouching', () => {
      createKarmaBox(voucherPubKey, 100n, 1);
      createVouchBox(voucherPubKey, targetPubKey, 5);

      const otherKeys = generateKeyPairSync('ed25519');
      const otherPub = rawPublicKey(otherKeys.publicKey);
      const otherKarma = createKarmaBox(otherPub, 100n, 1);
      const tx = signedVouchTx(otherKarma.id!, otherPub, targetPubKey, 10, otherKeys.privateKey);

      expect(castVouch(deps, tx, 10).status).toBe('pending');
    });

    it('rejects if cooldown active', () => {
      // Give voucher enough karma
      createKarmaBox(voucherPubKey, 100n, 1);

      // Set up a different target that has an active cooldown
      const cooldownTarget = (() => {
        const keys = generateKeyPairSync('ed25519');
        return rawPublicKey(keys.publicKey);
      })();

      // ⛔ An unreleased escrow BOX for this voucher — the gate is keyed on the
      // voucher, because the box carries no target (TYPES_INTERFACE →
      // VouchEscrowBox).
      seedVouchEscrow(voucherPubKey, 999);

      const tx: UtxoTransaction = {
        inputs: [],
        outputs: [
          {
            boxType: 'vouch' as const,
            value: VOUCH_KARMA_AMOUNT,
            createdAtBlock: 0,
            voucherId: voucherPubKey,
            targetId: cooldownTarget,
          },
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };

      expect(() => castVouch(deps, tx, 10)).toThrow(
        'Vouch cooldown active — cannot re-vouch yet',
      );
    });

    // -------------------------------------------------------------------
    // castVouch — success
    // -------------------------------------------------------------------

    it('accepts valid vouch and inserts into mempool', () => {
      const karma = createKarmaBox(voucherPubKey, 100n, 1);

      const newKarma: CandidateOf<KarmaBox> = {
        boxType: 'karma',
        value: 99n,
        createdAtBlock: 0,
        owner: voucherPubKey,
      };
      Object.assign(newKarma, fixtureProvenance(newKarma, 1));

      const vouchBox: CandidateOf<VouchBox> = {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: 0,
        voucherId: voucherPubKey,
        targetId: targetPubKey,
      };
      Object.assign(vouchBox, fixtureProvenance(vouchBox, 1));

      const tx: UtxoTransaction = {
        inputs: [karma.id!],
        outputs: [
          newKarma,
          vouchBox,
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };

      signTransaction(tx, voucherPrivKey, voucherPubKeyHex);

      const result = castVouch(deps, tx, 5);

      expect(result.status).toBe('pending');
      expect(result.txId).toBeDefined();
      expect(typeof result.txId).toBe('string');
      expect(result.expiresAtHeight).toBe(5 + MEMPOOL_EXPIRY_BLOCKS);

      // Verify mempool has the entry
      const entries = getPendingEntries(100);
      const matching = entries.filter((e) => {
        if (e.entryType !== 'utxo_tx' || !e.utxoTxBytes) return false;
        const storedTx = decodeTx(e.utxoTxBytes);
        return storedTx.outputs.some(
          (o) => o.boxType === 'vouch',
        );
      });
      expect(matching.length).toBe(1);
    });

    it('karma is unchanged after castVouch (pending only)', () => {
      const karma = createKarmaBox(voucherPubKey, 100n, 1);

      const newKarma: CandidateOf<KarmaBox> = {
        boxType: 'karma',
        value: 99n,
        createdAtBlock: 0,
        owner: voucherPubKey,
      };
      Object.assign(newKarma, fixtureProvenance(newKarma, 1));

      const vouchBox: CandidateOf<VouchBox> = {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: 0,
        voucherId: voucherPubKey,
        targetId: targetPubKey,
      };
      Object.assign(vouchBox, fixtureProvenance(vouchBox, 1));

      const tx: UtxoTransaction = {
        inputs: [karma.id!],
        outputs: [
          newKarma,
          vouchBox,
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };

      signTransaction(tx, voucherPrivKey, voucherPubKeyHex);
      castVouch(deps, tx, 5);

      // Karma should be unchanged (pending in mempool, not applied)
      const karmaBox = getKarmaBox(voucherPubKey);
      expect(karmaBox).not.toBeNull();
      expect(karmaBox!.value).toBe(100n);
    });
  });

  // -----------------------------------------------------------------------
  // initiateUnvouch
  // -----------------------------------------------------------------------

  describe('initiateUnvouch', () => {
    it('rejects if no VouchBox in inputs', () => {
      // Create a tx with a random input that does not exist in the DB
      const fakeInputId = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
      const tx: UtxoTransaction = {
        inputs: [fakeInputId],
        outputs: [],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };

      expect(() => initiateUnvouch(deps, tx, 5)).toThrow(
        'Transaction does not consume a VouchBox',
      );
    });

    it('rejects if signer is not the voucher', () => {
      // Create a vouch box owned by voucher
      const vouchBox = createVouchBox(voucherPubKey, targetPubKey, 1);

      // Build tx that consumes the vouch box
      const tx: UtxoTransaction = {
        inputs: [vouchBox.id!],
        // ⛔ The escrow output, because the unvouch conserves now — the stake
        // moves into a box rather than being destroyed with a row remembering
        // to re-mint it (ARCHITECTURE → Vouch boxes).
        outputs: [
          {
            boxType: 'vouch_escrow' as const,
            value: vouchBox.value,
            createdAtBlock: 0,
            owner: voucherPubKey,
            releaseAtBlock: 0 + 2,
          },
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };

      // Sign with target's key (not the voucher's key)
      const targetKeys = generateKeyPairSync('ed25519');
      const targetPrivKey = targetKeys.privateKey;
      const wrongPubKeyHex = targetPubKeyHex;

      signTransaction(tx, targetPrivKey, wrongPubKeyHex);

      expect(() => initiateUnvouch(deps, tx, 5)).toThrow(
        'VouchBox does not belong to signer',
      );
    });

    it('accepts valid unvouch and inserts into mempool', () => {
      const vouchBox = createVouchBox(voucherPubKey, targetPubKey, 1);

      const tx: UtxoTransaction = {
        inputs: [vouchBox.id!],
        // ⛔ The escrow output, because the unvouch conserves now — the stake
        // moves into a box rather than being destroyed with a row remembering
        // to re-mint it (ARCHITECTURE → Vouch boxes).
        outputs: [
          {
            boxType: 'vouch_escrow' as const,
            value: vouchBox.value,
            createdAtBlock: 0,
            owner: voucherPubKey,
            releaseAtBlock: 0 + 2,
          },
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };

      signTransaction(tx, voucherPrivKey, voucherPubKeyHex);

      const result = initiateUnvouch(deps, tx, 5);

      expect(result.status).toBe('pending');
      expect(result.txId).toBeDefined();
      expect(typeof result.txId).toBe('string');
      expect(result.expiresAtHeight).toBe(5 + MEMPOOL_EXPIRY_BLOCKS);
      // The escrow's `releaseAtBlock` is the exact pin:
      // `vouch.createdAtBlock + cooldown = 0 + 2`.
      expect(result.karmaReturnsAtBlock).toBe(2);

      // Verify mempool has the entry
      const entries = getPendingEntries(100);
      const matching = entries.filter((e) => {
        if (e.entryType !== 'utxo_tx' || !e.utxoTxBytes) return false;
        const storedTx = decodeTx(e.utxoTxBytes);
        return storedTx.inputs.includes(vouchBox.id!);
      });
      expect(matching.length).toBe(1);
    });
  });
});
