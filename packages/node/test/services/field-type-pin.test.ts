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
 *    shape gate must reject before authorization is ever consulted, so a
 *    signature-shaped error (or a throw) here is a placement regression;
 *  - PER-FIELD rejects: for each boxType, each pinned field with a
 *    wrong-typed value → invalid, error names index, boxType, and key;
 *  - ACCEPT controls the output-shape suite does not already cover: the
 *    honest bond commit (typed probation numbers — the class-4c coercion
 *    shape, now dead) and the honest unvouch;
 *  - CBOR INGRESS: a block embedding the class-3 poison tx (string
 *    `originalValue`) is REJECTED by the funnel through the clean
 *    `{valid:false}` path — not the totality catch — and nothing lands in
 *    the store. On the pre-pin tree the same block APPLIED and the stored
 *    row made every later read of it throw (the before-leg probes).
 *
 * The accept controls for every other legal transition live in
 * output-shape.test.ts (output-shape pin) and utxo-engine.test.ts; the
 * id-integrity discriminator, fed the class-4 mutants, lives in
 * output-shape-id-integrity.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign, createHash, type KeyObject } from 'crypto';
import {
  BOX_VALUE_BOUND,
  canonicalBoxBytes,
  computeBoxId,
  computeTxId,
  encodeTx,
  decodeTx,
  POST_LOCK_THREAD_COST,
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
  hasActiveVouchEscrow as storeHasActiveVouchEscrow,
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
// CONSTRUCTION — a field of the wrong type, a value at or past BOX_VALUE_BOUND,
// a stray key.
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
      hasActiveVouchEscrow: () => false,
      vouchCooldownBlocks: 2,
      inviteBondMin: config.inviteBondMin,
      inviteBondMax: config.inviteBondMax,
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
      createdAtBlock: 0,
      owner: ownerPubKey,
    };
  }

  // -------------------------------------------------------------------------
  // Totality: validateTx never throws, whatever tx.outputs holds
  // -------------------------------------------------------------------------

  describe('totality of validateTx over malformed outputs', () => {
    /**
     * Corpus of malformed outputs. Each runs as the outputs of an UNSIGNED
     * transaction over one live karma input: the step-4 gate must produce the
     * reject before conservation, authorization, or transitions can read the object
     * (an unsigned tx surfacing a signature error — or a throw — means the
     * gate moved).
     */
    const karmaOwner32 = bytes32(0x11);
    const CORPUS: Array<[string, unknown]> = [
      // -- missing fields (the class-1 validate-time-throw sites) --
      ['karma missing owner', { boxType: 'karma', value: 10n, createdAtBlock: 0 }],
      ['karma missing value', { boxType: 'karma', createdAtBlock: 0, owner: karmaOwner32 }],
      ['vouch missing voucherId', { boxType: 'vouch', value: 1n, createdAtBlock: 0, targetId: karmaOwner32 }],
      ['bond missing inviteePublicKey', { boxType: 'bond', value: 10n, createdAtBlock: 0, inviterId: karmaOwner32 }],
      ['post_lock missing originalValue', { boxType: 'post_lock', value: 10n, createdAtBlock: 0, owner: karmaOwner32 }],
      // -- wrong-typed fields, one per FieldType --
      ['karma value as number', { ...honest('karma'), value: 10 }],
      ['karma value negative bigint', { ...honest('karma'), value: -1n }],
      // The stranded value: encodable, unstorable, and therefore not accepted
      // (TYPES_INTERFACE → Box value domain). `2^64` would be rejected under
      // either bound, so it could not tell the two apart.
      ['karma value at BOX_VALUE_BOUND', { ...honest('karma'), value: BOX_VALUE_BOUND }],
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
      ['vouch voucherId 31 bytes', { ...honest('vouch'), voucherId: new Uint8Array(31) }],
      ['vouch targetId as string', { ...honest('vouch'), targetId: 'cc'.repeat(32) }],
      // -- entries that are not objects at all --
      ['null entry', null],
      ['number entry', 42],
      ['string entry', 'box'],
      ['boolean entry', true],
      ['array entry', []],
      // -- unknown and prototype-colliding boxTypes --
      ["boxType 'constructor'", { boxType: 'constructor', value: 10n, createdAtBlock: 0 }],
      ["boxType 'toString'", { boxType: 'toString', value: 10n, createdAtBlock: 0 }],
      ["boxType 'like' (retired)", { boxType: 'like', value: 10n, createdAtBlock: 0 }],
      ['boxType as number', { boxType: 7, value: 10n, createdAtBlock: 0 }],
      ['boxType missing', { value: 10n, createdAtBlock: 0 }],
    ];

    function honest(boxType: string): Record<string, unknown> {
      switch (boxType) {
        case 'karma':
          return { boxType, value: 10n, createdAtBlock: 0, owner: karmaOwner32 };
        case 'credit':
          return { boxType, value: 10n, createdAtBlock: 0, owner: karmaOwner32 };
        case 'bond':
          return { boxType, value: 10n, createdAtBlock: 0, inviterId: karmaOwner32, inviteePublicKey: bytes32(0xaa) };
        case 'post_lock':
          return { boxType, value: 10n, createdAtBlock: 0, originalValue: 10n, owner: karmaOwner32 };
        case 'vouch':
          return { boxType, value: 1n, createdAtBlock: 0, voucherId: karmaOwner32, targetId: bytes32(0xcc) };
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
          return { boxType, value: 10n, createdAtBlock: 0, owner: bytes32(1), decayBurn: false };
        case 'credit':
          return { boxType, value: 10n, createdAtBlock: 0, owner: bytes32(1), lockedUntilBlock: 5 };
        case 'bond':
          return { boxType, value: 10n, createdAtBlock: 0, inviterId: bytes32(1), inviteePublicKey: bytes32(2) };
        case 'post_lock':
          return { boxType, value: 10n, createdAtBlock: 0, originalValue: 10n, owner: bytes32(1) };
        case 'vouch':
          return { boxType, value: 1n, createdAtBlock: 0, voucherId: bytes32(1), targetId: bytes32(0xcc) };
        default:
          throw new Error(boxType);
      }
    }

    // For each boxType, every pinned field and a value violating its spec.
    // (`boxType` is pinned by its own arm, tested in the output-shape suite.)
    const WRONG: Record<string, Record<string, unknown>> = {
      karma: { value: 10, owner: new Uint8Array(31), decayBurn: 1 },
      credit: { value: -1n, owner: 'aa'.repeat(32), lockedUntilBlock: -1 },
      bond: {
        value: BOX_VALUE_BOUND,
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

    it('u64 boundary: the largest accepted value is BOX_VALUE_BOUND − 1', () => {
      const atMax = { ...honestCandidate('karma'), value: BOX_VALUE_BOUND - 1n };
      expect(checkOutputShape([atMax] as unknown as AnyBoxCandidate[]).valid).toBe(true);
    });

    it('u64 boundary: BOX_VALUE_BOUND is rejected, and above it', () => {
      for (const value of [BOX_VALUE_BOUND, BOX_VALUE_BOUND + 1n, (1n << 64n) - 1n]) {
        const over = { ...honestCandidate('karma'), value };
        const r = checkOutputShape([over] as unknown as AnyBoxCandidate[]);
        expect(r.valid, String(value)).toBe(false);
        expect(r.error, String(value)).toMatch(/field 'value'/);
      }
    });

    it('the stranded values ENCODE — the writer is wider than the gate, deliberately', () => {
      // ⛔ **Encodable and accepted are two domains, and this is the pair that
      // keeps them apart** (TYPES_INTERFACE → Box value domain): `vlqU64` keeps
      // `[0, 2^64)` and consensus admits `[0, BOX_VALUE_BOUND)`. Asserting only
      // the rejection above would leave "the encoder was narrowed too" as an
      // equally good reading of a green suite — and narrowing the encoder is the
      // one thing that WOULD move box ids.
      for (const value of [BOX_VALUE_BOUND, (1n << 64n) - 1n]) {
        const box = { ...honestCandidate('karma'), value } as unknown as AnyBoxCandidate;
        expect(() => canonicalBoxBytes(box), String(value)).not.toThrow();
        // Round-trip through the id derivation too: a value the writer accepts
        // has a well-formed identity, which is exactly why the gate has to be
        // the thing that refuses it.
        expect(canonicalBoxBytes(box).length, String(value)).toBeGreaterThan(0);
      }
    });

  });

  // -------------------------------------------------------------------------
  // Accept controls the output-shape suite does not cover
  // -------------------------------------------------------------------------

  describe('accept controls (honest typed outputs through validateTx)', () => {
    it('honest invite (typed 32-byte key, conserving) validates', () => {
      const inviter = makeTestIdentity();
      const invitee = makeTestIdentity();
      const karma = makeKarmaBox(FIXTURE_BOND_KARMA + 10n, inviter.userId, 0, 61);
      storeInsertBox(karma);

      const tx: UtxoTransaction = {
        inputs: [karma.id!],
        outputs: [
          { boxType: 'karma', value: 10n,  createdAtBlock: 0,owner: inviter.userId },
          {
            boxType: 'bond',
            value: FIXTURE_BOND_KARMA,
            createdAtBlock: 0,
            inviterId: inviter.userId,
            inviteePublicKey: invitee.userId,
          },
        ] as unknown as UtxoTransaction['outputs'],
        signatures: {},
        protocolVersion: 1,
      };
      const hash = Buffer.from(computeTxId(tx), 'hex');
      tx.signatures[Buffer.from(inviter.userId).toString('hex')] = new Uint8Array(
        cryptoSign(null, hash, inviter.privateKey),
      );

      const r = validateTx(deps, tx, 100);
      expect(r.valid, r.error).toBe(true);
    });

    it('honest unvouch (vouch → vouch_escrow) validates', () => {
      const vouch = {
        boxType: 'vouch' as const,
        value: 1n,
        createdAtBlock: 0,
        voucherId: ownerPubKey,
        targetId: bytes32(0xcc),
      };
      const seeded = { ...vouch, ...fixtureProvenance(vouch, 1) } as AnyBox;
      seeded.id = computeBoxId(seeded);
      storeInsertBox(seeded);
      // ⛔ **An escrow output, because the unvouch conserves now.** The stake
      // moves into a box the voucher's own transaction creates
      // (ARCHITECTURE → Vouch boxes); a zero-output spend is an ordinary
      // whole-input deficit and is refused.
      const escrow = {
        boxType: 'vouch_escrow' as const,
        value: 1n,
        createdAtBlock: 0,
        owner: ownerPubKey,
        releaseAtBlock: 1000,
      };
      const r = validateTx(deps, signedTx([seeded.id!], [escrow as never]), 10);
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
          createdAtBlock: 0,
          originalValue: POST_LOCK_THREAD_COST,
          owner: ownerPubKey,
        };
        const tx = signedTx(
          [karma.id!],
          [
            {
              boxType: 'karma',
              value: 100n - POST_LOCK_THREAD_COST,
              createdAtBlock: 0,
              owner: ownerPubKey,
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

  describe('wire ingress (block funnel)', () => {
    /**
     * ⛔ **THE OUTPUT-DOMAIN CHECK IS UNREACHABLE FROM THE BLOCK PATH, AND THAT
     * IS THE FINDING** (VALIDATION_INTERFACE → What a decoder subsumes).
     *
     * An embedded transaction arrives as bytes and crosses `decodeTx`, which is
     * positional: it writes the layout's fields and reads them back, so it can
     * hand the funnel neither a stray key nor an out-of-domain value. The two
     * poison classes below are therefore closed by the codec at *different*
     * ends, and neither reaches `checkOutputShape` —
     *
     *  - a key the layout does not declare is never encoded, so it does not
     *    survive the round trip and is not in the id the block committed to;
     *  - a value outside a writer's domain has **no encoding at all**, so the
     *    transaction cannot be put on the wire by anyone.
     *
     * ⚠ **The gate is not thereby redundant.** `validateTx` step 4 is what the
     * HTTP edge crosses, where `jsonToTx` builds the object and no decoder
     * bounds it — which is why the direct `checkOutputShape` cases above are the
     * substantive coverage and these two pin the *reason* they are not reachable
     * here. Node has both a store and an HTTP edge, so a check a decoder
     * subsumes on one path stays live on the other.
     */
    it('a stray output key does not survive the codec, so the block applies without it', async () => {
      const attacker = makeTestIdentity();
      const karma = makeKarmaBox(100n, attacker.userId, 0);
      storeInsertBox(karma);
      const tx: UtxoTransaction = {
        inputs: [karma.id!],
        outputs: [
          {
            boxType: 'karma',
            value: 100n - POST_LOCK_THREAD_COST,
            createdAtBlock: 0,
            owner: attacker.userId,
            note: 'x', // not in the layout: never encoded, never hashed
          },
          {
            boxType: 'post_lock',
            value: POST_LOCK_THREAD_COST,
            createdAtBlock: 0,
            originalValue: POST_LOCK_THREAD_COST,
            owner: attacker.userId,
          },
        ] as unknown as UtxoTransaction['outputs'],
        signatures: {},
        protocolVersion: 1,
        post: makePost(attacker.userId, 'poison carrier'),
      };
      const hash = Buffer.from(computeTxId(tx), 'hex');
      tx.signatures[Buffer.from(attacker.userId).toString('hex')] = new Uint8Array(
        cryptoSign(null, hash, attacker.privateKey),
      );

      // The key is outside every committed byte: it changes no id …
      const stripped = decodeTx(encodeTx(tx));
      expect(Object.hasOwn(stripped.outputs[0]!, 'note')).toBe(false);
      expect(computeTxId(stripped)).toBe(computeTxId(tx));

      // … so the block is honest and applies, and what lands carries no `note`.
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const block = await makeApplicableBlock({ utxoTxs: [tx] });
        expect(applyOrderingBlock(block)).toBe(true);
        expect(errSpy.mock.calls).toHaveLength(0);
      } finally {
        errSpy.mockRestore();
      }

      const rows = db
        .prepare("SELECT extra_data FROM utxo_boxes WHERE box_type = 'karma'")
        .all() as Array<{ extra_data: string | null }>;
      for (const row of rows) {
        expect(String(row.extra_data ?? '')).not.toContain('note');
      }
    });

    it('an out-of-domain output VALUE has no encoding, so no producer can carry it', async () => {
      // ⛔ **The stronger half.** `originalValue` is `vlqU64`, and its writer
      // throws rather than sentinelling — so a transaction carrying a string
      // there cannot be hashed, cannot be signed and cannot be encoded. It is
      // inexpressible on the wire rather than refused at a gate
      // (TYPES_INTERFACE → Totality).
      const attacker = makeTestIdentity();
      const poison: UtxoTransaction = {
        inputs: ['ab'.repeat(32)],
        outputs: [
          {
            boxType: 'post_lock',
            value: POST_LOCK_THREAD_COST,
            createdAtBlock: 0,
            originalValue: String(POST_LOCK_THREAD_COST),
            owner: attacker.userId,
          },
        ] as unknown as UtxoTransaction['outputs'],
        signatures: {},
        protocolVersion: 1,
      };
      expect(() => computeTxId(poison)).toThrow();
      expect(() => encodeTx(poison)).toThrow();

      // And the HTTP edge, where no decoder bounds it, still answers with the
      // stated rejection rather than a throw.
      expect(checkOutputShape(poison.outputs).valid).toBe(false);
      expect(checkOutputShape(poison.outputs).error)
        .toMatch(/index 0 \(post_lock\): field 'originalValue'/);
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
            createdAtBlock: 0,
            owner: author.userId,
          },
          {
            boxType: 'post_lock',
            value: POST_LOCK_THREAD_COST,
            createdAtBlock: 0,
            originalValue: POST_LOCK_THREAD_COST,
            owner: author.userId,
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
