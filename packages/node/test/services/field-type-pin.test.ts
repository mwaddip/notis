/**
 * Field-type pin (NODE_INTERFACE → "Output shape"): output fields carry
 * runtime types, and the shape check runs at validateTx step 4 — the first
 * consumer of `tx.outputs`.
 *
 * Four layers:
 *  - the TOTALITY property: for any contents of `tx.outputs` — missing
 *    fields, wrong-typed fields, `null`/non-object entries, unknown or
 *    prototype-colliding boxTypes — `validateTx` returns `{valid: false}`
 *    and never throws. Corpus transactions are deliberately UNSIGNED: the
 *    shape gate must reject before guards are ever consulted, so a
 *    signature-shaped error (or a throw) here is a placement regression;
 *  - PER-FIELD rejects: for each boxType, each pinned field with a
 *    wrong-typed value → invalid, error names index, boxType, and key;
 *  - ACCEPT controls the guard-shape suite does not already cover: the
 *    honest bond commit (typed probation numbers — the class-4c coercion
 *    shape, now dead) and the honest unvouch;
 *  - CBOR INGRESS: a block embedding the class-3 poison tx (string
 *    `originalValue`) is REJECTED by the funnel through the clean
 *    `{valid:false}` path — not the totality catch — and nothing lands in
 *    the store. On the pre-pin tree the same block APPLIED and the stored
 *    row made every later read of it throw (the before-leg probes).
 *
 * The accept controls for every other legal transition live in
 * output-shape.test.ts (guard-shape pin) and utxo-engine.test.ts; the
 * id-integrity discriminator, fed the class-4 mutants, lives in
 * output-shape-id-integrity.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign, createHash, type KeyObject } from 'crypto';
import {
  computeBoxId,
  computeTxId,
  encodeTx,
  decodeTx,
  POST_LOCK_THREAD_COST,
  INVITE_BOND_KARMA,
  INVITE_KARMA_AMOUNT,
} from '@dagsocial/types';
import type { AnyBox, AnyBoxCandidate, KarmaBox, UtxoTransaction } from '@dagsocial/types';
import Database from 'better-sqlite3';
import {
  fixtureProvenance,
  makeApplicableBlock,
  makeKarmaBox,
  makePost,
  makeTestIdentity,
  seedAsOneTx,
  seedProvenance,
  type Stored,
  type TestIdentity,
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
import { validateTx, checkOutputShape } from '../../src/services/utxo-engine.js';
import type { UtxoEngineDeps } from '../../src/services/utxo-engine.js';
import { applyOrderingBlock } from '../../src/services/block-apply.js';
import { config } from '../../src/config.js';

function rawPublicKey(keyObj: KeyObject): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

const bytes32 = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

// ---------------------------------------------------------------------------
// The `as unknown as AnyBoxCandidate[]` casts below are DELIBERATE and must not
// be "fixed" by a future type audit.
//
// This suite's subject is `checkOutputShape`, whose job is to reject decoded
// CBOR that does not match a box type. Its inputs are therefore malformed BY
// CONSTRUCTION — a field of the wrong type, a value past 2^64, a lying guard.
// The cast is how the test says "this is the bad input"; making these literals
// well-typed would delete the only cases the function exists to handle.
//
// The distinction that matters: a cast asserting a shape the code BELIEVES
// (a candidate typed as a stored box) is the harness defect this unit removed.
// A cast constructing a shape the code must REJECT is the test doing its job.
// ---------------------------------------------------------------------------
describe('field-type pin', () => {
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
        guard: 'owner_signature',
      },
      1,
    );
    storeInsertBox(box);
    return box;
  }

  function signedTx(inputs: string[], outputs: unknown[]): UtxoTransaction {
    const tx: UtxoTransaction = {
      inputs,
      outputs: outputs as UtxoTransaction['outputs'],
      signatures: {},
      protocolVersion: 1,
    };
    const hash = Buffer.from(computeTxId(tx), 'hex');
    tx.signatures[Buffer.from(ownerPubKey).toString('hex')] = new Uint8Array(
      cryptoSign(null, hash, ownerPrivKey),
    );
    return tx;
  }

  function karmaChange(value: bigint): Record<string, unknown> {
    return {
      boxType: 'karma',
      value,
      owner: ownerPubKey,
      guard: 'owner_signature',
    };
  }

  // -------------------------------------------------------------------------
  // Totality: validateTx never throws, whatever tx.outputs holds
  // -------------------------------------------------------------------------

  describe('totality of validateTx over malformed outputs', () => {
    /**
     * Corpus of malformed outputs. Each runs as the outputs of an UNSIGNED
     * transaction over one live karma input: the step-4 gate must produce the
     * reject before conservation, guards, or transitions can read the object
     * (an unsigned tx surfacing a signature error — or a throw — means the
     * gate moved).
     */
    const karmaOwner32 = bytes32(0x11);
    const CORPUS: Array<[string, unknown]> = [
      // -- missing fields (the class-1 validate-time-throw sites) --
      ['karma missing owner', { boxType: 'karma', value: 10n, guard: 'owner_signature' }],
      ['karma missing value', { boxType: 'karma', owner: karmaOwner32, guard: 'owner_signature' }],
      ['vouch missing voucherId', { boxType: 'vouch', value: 1n, targetId: karmaOwner32, guard: 'owner_signature' }],
      ['bond missing inviteePublicKey', { boxType: 'bond', value: 10n, inviterId: karmaOwner32, guard: 'block_apply' }],
      ['invite missing inviteePublicKey', { boxType: 'invite', value: 0n, inviterId: karmaOwner32, guard: 'invite_dual' }],
      ['post_lock missing originalValue', { boxType: 'post_lock', value: 10n, owner: karmaOwner32, guard: 'block_apply' }],
      // -- wrong-typed fields, one per FieldType --
      ['karma value as number', { ...honest('karma'), value: 10 }],
      ['karma value negative bigint', { ...honest('karma'), value: -1n }],
      ['karma value at 2^64', { ...honest('karma'), value: 1n << 64n }],
      ['karma owner as hex string', { ...honest('karma'), owner: 'aa'.repeat(32) }],
      ['karma owner 31 bytes', { ...honest('karma'), owner: new Uint8Array(31) }],
      ['karma owner 33 bytes', { ...honest('karma'), owner: new Uint8Array(33) }],
      ['karma owner as number', { ...honest('karma'), owner: 5 }],
      ['karma decayBurn as string', { ...honest('karma'), decayBurn: 'yes' }],
      ['credit lockedUntilBlock negative', { ...honest('credit'), lockedUntilBlock: -1 }],
      ['credit lockedUntilBlock as -0', { ...honest('credit'), lockedUntilBlock: -0 }],
      ['post_lock originalValue as string (the class-3 poison)', { ...honest('post_lock'), originalValue: 'x' }],
      // A `PostLockBox` declares no `targetPostId`, so an output carrying one is
      // rejected as an unexpected key rather than on its type — the schema is
      // closed, which is what makes the absence enforceable.
      ['post_lock with a targetPostId key at all', { ...honest('post_lock'), targetPostId: 'a'.repeat(64) }],
      // `bytes32`, not `bytes0or32`: the empty case went with the commit
      // transition, so a zero-length key is out of domain on both types now.
      ['bond inviteePublicKey empty', { ...honest('bond'), inviteePublicKey: new Uint8Array(0) }],
      ['bond inviteePublicKey 1 byte', { ...honest('bond'), inviteePublicKey: new Uint8Array(1) }],
      ['bond inviteePublicKey 31 bytes', { ...honest('bond'), inviteePublicKey: new Uint8Array(31) }],
      ['bond inviteePublicKey 33 bytes', { ...honest('bond'), inviteePublicKey: new Uint8Array(33) }],
      ['bond inviteePublicKey as hex string', { ...honest('bond'), inviteePublicKey: 'aa'.repeat(32) }],
      ['invite inviteePublicKey empty', { ...honest('invite'), inviteePublicKey: new Uint8Array(0) }],
      ['invite inviteePublicKey 31 bytes', { ...honest('invite'), inviteePublicKey: new Uint8Array(31) }],
      ['invite inviterId as string', { ...honest('invite'), inviterId: 'aa'.repeat(32) }],
      ['vouch voucherId 31 bytes', { ...honest('vouch'), voucherId: new Uint8Array(31) }],
      ['vouch targetId as string', { ...honest('vouch'), targetId: 'cc'.repeat(32) }],
      // -- entries that are not objects at all --
      ['null entry', null],
      ['number entry', 42],
      ['string entry', 'box'],
      ['boolean entry', true],
      ['array entry', []],
      // -- unknown and prototype-colliding boxTypes --
      ["boxType 'constructor'", { boxType: 'constructor', value: 10n, guard: 'owner_signature' }],
      ["boxType 'toString'", { boxType: 'toString', value: 10n, guard: 'owner_signature' }],
      ["boxType 'like' (retired)", { boxType: 'like', value: 10n, guard: 'owner_signature' }],
      ['boxType as number', { boxType: 7, value: 10n, guard: 'owner_signature' }],
      ['boxType missing', { value: 10n, guard: 'owner_signature' }],
    ];

    function honest(boxType: string): Record<string, unknown> {
      switch (boxType) {
        case 'karma':
          return { boxType, value: 10n, owner: karmaOwner32, guard: 'owner_signature' };
        case 'credit':
          return { boxType, value: 10n, owner: karmaOwner32, guard: 'owner_signature' };
        case 'invite':
          return { boxType, value: 0n, inviterId: karmaOwner32, inviteePublicKey: bytes32(0xaa), guard: 'invite_dual' };
        case 'bond':
          return { boxType, value: 10n, inviterId: karmaOwner32, inviteePublicKey: bytes32(0xaa), guard: 'block_apply' };
        case 'post_lock':
          return { boxType, value: 10n, originalValue: 10n, owner: karmaOwner32, guard: 'block_apply' };
        case 'vouch':
          return { boxType, value: 1n, voucherId: karmaOwner32, targetId: bytes32(0xcc), guard: 'owner_signature' };
        default:
          throw new Error(boxType);
      }
    }

    for (const [label, output] of CORPUS) {
      it(`rejects without throwing: ${label}`, () => {
        const karma = seedKarma(100n);
        const tx: UtxoTransaction = {
          inputs: [karma.id!],
          outputs: [output] as UtxoTransaction['outputs'],
          signatures: {}, // unsigned on purpose — see the corpus doc comment
          protocolVersion: 1,
        };
        let result: ReturnType<typeof validateTx> | undefined;
        expect(() => {
          result = validateTx(deps, tx, 10);
        }).not.toThrow();
        expect(result!.valid).toBe(false);
        expect(result!.error).toMatch(/Invalid output shape/);
      });
    }

    it('rejects a malformed output at index 1 without evaluating arms on it (mixed with an honest change)', () => {
      const karma = seedKarma(100n);
      const tx: UtxoTransaction = {
        inputs: [karma.id!],
        outputs: [karmaChange(90n), { ...honest('karma'), owner: 5 }] as UtxoTransaction['outputs'],
        signatures: {},
        protocolVersion: 1,
      };
      const r = validateTx(deps, tx, 10);
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/index 1 \(karma\): field 'owner'/);
    });
  });

  // -------------------------------------------------------------------------
  // Per-field rejects: error names index, boxType, and key
  // -------------------------------------------------------------------------

  describe('per-field type rejects (direct checkOutputShape)', () => {
    /** Honest candidate per boxType (all fields typed per TYPES_INTERFACE). */
    function honestCandidate(boxType: string): Record<string, unknown> {
      switch (boxType) {
        case 'karma':
          return { boxType, value: 10n, owner: bytes32(1), guard: 'owner_signature', decayBurn: false };
        case 'credit':
          return { boxType, value: 10n, owner: bytes32(1), guard: 'owner_signature', lockedUntilBlock: 5 };
        case 'invite':
          return { boxType, value: 0n, inviterId: bytes32(1), inviteePublicKey: bytes32(2), guard: 'invite_dual' };
        case 'bond':
          return { boxType, value: 10n, inviterId: bytes32(1), inviteePublicKey: bytes32(2), guard: 'block_apply' };
        case 'post_lock':
          return { boxType, value: 10n, originalValue: 10n, owner: bytes32(1), guard: 'block_apply' };
        case 'vouch':
          return { boxType, value: 1n, voucherId: bytes32(1), targetId: bytes32(0xcc), guard: 'owner_signature' };
        default:
          throw new Error(boxType);
      }
    }

    // For each boxType, every pinned field and a value violating its spec.
    // (guard/boxType are pinned by their own arms, tested in the guard-shape
    // suite.)
    const WRONG: Record<string, Record<string, unknown>> = {
      karma: { value: 10, owner: new Uint8Array(31), decayBurn: 1 },
      credit: { value: -1n, owner: 'aa'.repeat(32), lockedUntilBlock: -1 },
      invite: { value: 1n << 64n, inviterId: 7, inviteePublicKey: new Uint8Array(33) },
      bond: {
        value: Number.NaN,
        inviterId: new Uint8Array(0),
        inviteePublicKey: new Uint8Array(16),
      },
      post_lock: { value: 'x', originalValue: 5, owner: null },
      vouch: { value: [], voucherId: true, targetId: new Uint8Array(64) },
    };

    for (const [boxType, fields] of Object.entries(WRONG)) {
      for (const [key, badValue] of Object.entries(fields)) {
        it(`${boxType}.${key} wrong-typed → invalid, error names index/boxType/key`, () => {
          const candidate = { ...honestCandidate(boxType), [key]: badValue };
          const r = checkOutputShape([candidate] as unknown as AnyBoxCandidate[]);
          expect(r.valid).toBe(false);
          expect(r.error).toMatch(new RegExp(`index 0 \\(${boxType}\\): field '${key}'`));
        });
      }
    }

    it('accepts every honest candidate above (the wrong-value table mutates from a green baseline)', () => {
      for (const boxType of Object.keys(WRONG)) {
        const r = checkOutputShape([honestCandidate(boxType)] as unknown as AnyBoxCandidate[]);
        expect(r.valid, `${boxType}: ${r.error}`).toBe(true);
      }
    });

    it('-0 is rejected where 0 is accepted (credit lockedUntilBlock)', () => {
      // `uint` is the one numeric FieldType left on any box arm, and `-0` is
      // JSON- and CBOR-reachable: cbor-x encodes it as a float where the store's
      // JSON round-trip returns integer 0, so the two would not round-trip.
      const zero = { ...honestCandidate('credit'), lockedUntilBlock: 0 };
      expect(checkOutputShape([zero] as unknown as AnyBoxCandidate[]).valid).toBe(true);
      const negZero = { ...zero, lockedUntilBlock: -0 };
      const r = checkOutputShape([negZero] as unknown as AnyBoxCandidate[]);
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/field 'lockedUntilBlock'.*got -0/);
    });

    it('u64 boundary: value 2^64−1 accepted, 2^64 rejected', () => {
      const atMax = { ...honestCandidate('karma'), value: (1n << 64n) - 1n };
      expect(checkOutputShape([atMax] as unknown as AnyBoxCandidate[]).valid).toBe(true);
      const over = { ...honestCandidate('karma'), value: 1n << 64n };
      expect(checkOutputShape([over] as unknown as AnyBoxCandidate[]).valid).toBe(false);
    });

  });

  // -------------------------------------------------------------------------
  // Accept controls the guard-shape suite does not cover
  // -------------------------------------------------------------------------

  describe('accept controls (honest typed outputs through validateTx)', () => {
    /** The pair as invite creation emits it: one tx, one invitee key on both. */
    function seedInviteBondPair(inviter: TestIdentity, invitee: TestIdentity) {
      const invite = {
        boxType: 'invite' as const,
        value: 0n,
        inviterId: inviter.userId,
        inviteePublicKey: invitee.userId,
        guard: 'invite_dual' as const,
      };
      const bond = {
        boxType: 'bond' as const,
        value: INVITE_BOND_KARMA,
        inviterId: inviter.userId,
        inviteePublicKey: invitee.userId,
        guard: 'block_apply' as const,
      };
      const [seededInvite, seededBond] = seedAsOneTx([invite, bond]);
      storeInsertBox(seededInvite!);
      storeInsertBox(seededBond!);
      return { seededInvite: seededInvite!, seededBond: seededBond! };
    }

    it('honest invite claim (typed 32-byte key, minted karma) validates', () => {
      const inviter = makeTestIdentity();
      const invitee = makeTestIdentity();
      const { seededInvite } = seedInviteBondPair(inviter, invitee);

      const karmaOut = {
        boxType: 'karma',
        value: INVITE_KARMA_AMOUNT,
        owner: invitee.userId,
        guard: 'owner_signature',
      };
      const tx: UtxoTransaction = {
        inputs: [seededInvite.id!],
        outputs: [karmaOut] as unknown as UtxoTransaction['outputs'],
        signatures: {},
        protocolVersion: 1,
      };
      const hash = Buffer.from(computeTxId(tx), 'hex');
      tx.signatures[Buffer.from(invitee.userId).toString('hex')] = new Uint8Array(
        cryptoSign(null, hash, invitee.privateKey),
      );

      const r = validateTx(deps, tx, 100);
      expect(r.valid, r.error).toBe(true);
    });

    it('honest unvouch (vouch → zero outputs) validates', () => {
      const vouch = {
        boxType: 'vouch' as const,
        value: 1n,
        voucherId: ownerPubKey,
        targetId: bytes32(0xcc),
        guard: 'owner_signature' as const,
      };
      const seeded = { ...vouch, ...fixtureProvenance(vouch, 1) } as AnyBox;
      seeded.id = computeBoxId(seeded);
      storeInsertBox(seeded);
      const r = validateTx(deps, signedTx([seeded.id!], []), 10);
      expect(r.valid, r.error).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // No-panic: a rejected value must produce a VERDICT, never an exception
  // -------------------------------------------------------------------------

  describe('validateTx returns a verdict for an adversarial targetPostId (no-panic)', () => {
    /**
     * `PostLockBox` declares no `targetPostId` (TYPES_INTERFACE → Layout —
     * PostLockBox: a transaction cannot name its own outputs' ids without
     * circularity), so the field is out of domain at any value. The property
     * under test is unchanged and is not about the field: an
     * attacker-supplied output must produce a VERDICT from `validateTx`, never
     * an exception, and `computeTxId` runs at that function's LAST line. Step 4
     * rejecting first is what keeps the throw unreachable.
     *
     * The loop still spans values the encoder would treat differently, because
     * what has to hold is that NO value of any shape reaches the writer — a
     * closed schema is a stronger reason than a typed field, not a substitute
     * for the test.
     *
     * Note the fixture signs a well-formed lock and stamps the stray key after:
     * the signature could not be computed over an unencodable transaction, and
     * it does not need to be — step 4 precedes step 6.
     */
    for (const bad of ['hello', 'A'.repeat(64), 'a'.repeat(63), '', 'zz'.repeat(32), 'a'.repeat(64)]) {
      it(`targetPostId=${JSON.stringify(bad)} → {valid:false}, not a throw`, () => {
        const karma = makeKarmaBox(100n, ownerPubKey, 0);
        storeInsertBox(karma);
        const lock: Record<string, unknown> = {
          boxType: 'post_lock',
          value: POST_LOCK_THREAD_COST,
          originalValue: POST_LOCK_THREAD_COST,
          owner: ownerPubKey,
          guard: 'block_apply',
        };
        const tx = signedTx(
          [karma.id!],
          [
            {
              boxType: 'karma',
              value: 100n - POST_LOCK_THREAD_COST,
              owner: ownerPubKey,
              guard: 'owner_signature',
            },
            lock,
          ] as unknown as UtxoTransaction['outputs'],
        );
        lock['targetPostId'] = bad;

        let r: ReturnType<typeof validateTx> | undefined;
        expect(() => { r = validateTx(deps, tx, 10); }).not.toThrow();
        expect(r!.valid).toBe(false);
        // Attributed: rejected for the key, not for the missing post payload the
        // biconditional also wants — step 4 precedes the transition arms.
        expect(r!.error).toMatch(/unexpected key 'targetPostId'/);
      });
    }
  });

  // -------------------------------------------------------------------------
  // CBOR ingress: the block funnel inherits the gate from validateTx
  // -------------------------------------------------------------------------

  describe('CBOR ingress (block funnel)', () => {
    /**
     * ⚠ **Why the poison is a stray key and not `originalValue`.**
     *
     * A string `originalValue` on the post_lock cannot serve: `originalValue`
     * is `vlqU64`, which **throws** on a non-bigint, so the block is
     * unbuildable at the producer and, if the bytes were spliced in afterwards,
     * `computeTxId` would throw into the funnel's *totality catch* — the exact
     * path this test exists to prove is not taken.
     *
     * So the poison has to be one the encoder can carry, or the funnel never
     * reaches the gate under test. A key the layout does not declare is total by
     * construction: `canonicalBoxBytes` writes the layout's fields positionally
     * and never reads this one, so the transaction hashes and signs normally and
     * `checkOutputShape` (validateTx step 4) rejects it as an unexpected key.
     *
     * Class-3 — a poison whose writer THROWS — is the case below this one. It
     * needs its own fixture rather than a variant of this one: an unhashable
     * transaction cannot be committed by any producer, so it can only reach the
     * funnel as spliced bytes.
     */
    it('a block embedding a poison tx is REJECTED cleanly — nothing lands, no totality catch', async () => {
      const attacker = makeTestIdentity();
      const karma = makeKarmaBox(100n, attacker.userId, 0);
      storeInsertBox(karma);
      const tx: UtxoTransaction = {
        inputs: [karma.id!],
        outputs: [
          {
            boxType: 'karma',
            value: 100n - POST_LOCK_THREAD_COST,
            owner: attacker.userId,
            guard: 'owner_signature',
            note: 'x', // not in the layout: never encoded, so the tx still hashes
          },
          {
            boxType: 'post_lock',
            value: POST_LOCK_THREAD_COST,
            originalValue: POST_LOCK_THREAD_COST,
            owner: attacker.userId,
            guard: 'block_apply',
          },
        ] as unknown as UtxoTransaction['outputs'],
        signatures: {},
        protocolVersion: 1,
        // The lock's payload, so the stray key is the transaction's ONLY defect
        // — without it the engine's post biconditional rejects first and this
        // measures that instead.
        post: makePost(attacker.userId, 'poison carrier'),
      };
      const hash = Buffer.from(computeTxId(tx), 'hex');
      tx.signatures[Buffer.from(attacker.userId).toString('hex')] = new Uint8Array(
        cryptoSign(null, hash, attacker.privateKey),
      );

      // The embedded tx rides the block as encodeTx() CBOR; apply decodes it
      // and re-validates with validateTx — the single gate the funnel
      // inherits. On the pre-pin tree this block APPLIED (before-leg P2b).
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const block = await makeApplicableBlock({ utxoTxs: [tx] });
        expect(applyOrderingBlock(block)).toBe(false);
        // The clean rejection path, not the totality catch converting a throw.
        const unexpected = errSpy.mock.calls.filter((c) =>
          String(c[0]).includes('unexpected failure during apply'),
        );
        expect(unexpected).toHaveLength(0);
        // Attributed to the poison. The block carries a post-bearing tx now, so
        // "rejected" alone no longer says which gate answered.
        expect(
          warnSpy.mock.calls
            .map((c) => String(c[0]))
            .filter((w) => w.includes('out-of-domain output') && w.includes("unexpected key 'note'")),
        ).toHaveLength(1);
      } finally {
        warnSpy.mockRestore();
        errSpy.mockRestore();
      }

      // Nothing landed: the input is unspent, no post_lock row exists.
      expect(storeGetBox(karma.id!)).not.toBeNull();
      const locks = db
        .prepare("SELECT COUNT(*) AS n FROM utxo_boxes WHERE box_type = 'post_lock'")
        .get() as { n: number | bigint };
      expect(Number(locks.n)).toBe(0);
    });

    /**
     * Class-3: a poison whose writer THROWS. `originalValue` is `vlqU64`, so a
     * string there refuses to encode — which is exactly why it cannot arrive
     * the way the class-2 poison above does. No producer can commit an
     * unhashable transaction, so the only route in is bytes spliced beside an
     * honest id, and `utxoTxRoot` commits `utxoTxIds` rather than `utxoTxs`, so
     * the splice needs no re-mine and no re-sign.
     *
     * What the funnel's output-domain check buys is the *class* of the answer,
     * not the answer: without it `computeTxId` throws into the totality catch
     * and the block dies as an "unexpected failure", a rejection the node
     * cannot name (NODE_INTERFACE → "The output domain check").
     */
    it('class-3: a throwing-writer poison is rejected by name, not by the totality catch', async () => {
      const attacker = makeTestIdentity();
      const karma = makeKarmaBox(100n, attacker.userId, 0);
      storeInsertBox(karma);

      // The honest transaction whose id the block will commit to.
      const honest: UtxoTransaction = {
        inputs: [karma.id!],
        outputs: [
          {
            boxType: 'karma',
            value: 100n,
            owner: attacker.userId,
            guard: 'owner_signature',
          },
        ] as unknown as UtxoTransaction['outputs'],
        signatures: {},
        protocolVersion: 1,
      };
      honest.signatures[Buffer.from(attacker.userId).toString('hex')] = new Uint8Array(
        cryptoSign(null, Buffer.from(computeTxId(honest), 'hex'), attacker.privateKey),
      );

      const poison: UtxoTransaction = {
        inputs: [karma.id!],
        outputs: [
          {
            boxType: 'post_lock',
            value: POST_LOCK_THREAD_COST,
            originalValue: String(POST_LOCK_THREAD_COST), // vlqU64 THROWS on a string
            owner: attacker.userId,
            guard: 'block_apply',
          },
        ] as unknown as UtxoTransaction['outputs'],
        signatures: {},
        protocolVersion: 1,
      };
      // Unhashable — the property that forces the splice, asserted rather than
      // assumed, since the whole case rests on it.
      expect(() => computeTxId(poison)).toThrow();

      const block = await makeApplicableBlock({ utxoTxs: [honest] });
      block.utxoTxTree.utxoTxs[0] = encodeTx(poison);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(applyOrderingBlock(block)).toBe(false);
        expect(
          errSpy.mock.calls.filter((c) =>
            String(c[0]).includes('unexpected failure during apply'),
          ),
        ).toHaveLength(0);
        expect(
          warnSpy.mock.calls
            .map((c) => String(c[0]))
            .filter(
              (w) => w.includes('has an out-of-domain output') && w.includes('originalValue'),
            ),
        ).toHaveLength(1);
      } finally {
        warnSpy.mockRestore();
        errSpy.mockRestore();
      }

      expect(storeGetBox(karma.id!)).not.toBeNull();
      const class3Locks = db
        .prepare("SELECT COUNT(*) AS n FROM utxo_boxes WHERE box_type = 'post_lock'")
        .get() as { n: number | bigint };
      expect(Number(class3Locks.n)).toBe(0);
    });

    it('control: the same block shape with an honest typed lock APPLIES (and pins what decodeTx yields)', async () => {
      const author = makeTestIdentity();
      const karma = makeKarmaBox(100n, author.userId, 0);
      storeInsertBox(karma);
      const tx: UtxoTransaction = {
        inputs: [karma.id!],
        outputs: [
          {
            boxType: 'karma',
            value: 100n - POST_LOCK_THREAD_COST,
            owner: author.userId,
            guard: 'owner_signature',
          },
          {
            boxType: 'post_lock',
            value: POST_LOCK_THREAD_COST,
            originalValue: POST_LOCK_THREAD_COST,
            owner: author.userId,
            guard: 'block_apply',
          },
        ] as unknown as UtxoTransaction['outputs'],
        signatures: {},
        protocolVersion: 1,
        // An honest lock carries its post: `post` present ⟺ exactly one
        // `PostLockBox` at the cost for that post's shape (NODE_INTERFACE →
        // Post transactions).
        post: makePost(author.userId, 'honest control'),
      };
      const hash = Buffer.from(computeTxId(tx), 'hex');
      tx.signatures[Buffer.from(author.userId).toString('hex')] = new Uint8Array(
        cryptoSign(null, hash, author.privateKey),
      );

      // What the funnel's decoder actually hands the gate: byte fields as
      // Uint8Array (NOT Buffer — pinned here because the fix's `instanceof
      // Uint8Array` covers both, and a cbor-x behavior change should be loud),
      // amounts as bigint.
      const decoded = decodeTx(encodeTx(tx));
      const decodedKarma = decoded.outputs[0] as { owner: unknown; value: unknown };
      expect(decodedKarma.owner).toBeInstanceOf(Uint8Array);
      expect(Buffer.isBuffer(decodedKarma.owner)).toBe(false);
      expect(typeof decodedKarma.value).toBe('bigint');

      const block = await makeApplicableBlock({ utxoTxs: [tx] });
      expect(applyOrderingBlock(block)).toBe(true);
      const locks = db
        .prepare("SELECT COUNT(*) AS n FROM utxo_boxes WHERE box_type = 'post_lock'")
        .get() as { n: number | bigint };
      expect(Number(locks.n)).toBe(1);
    });
  });
});
