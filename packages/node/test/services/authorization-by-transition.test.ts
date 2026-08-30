// ---------------------------------------------------------------------------
// Authorization is a property of the transition (NODE_INTERFACE → "Legal box
// transitions").
//
// What is asserted here is what the transition table STATES — which key a
// transition requires, and which input types no transition admits — never the
// wording of any refusal. Nothing below asserts a message: a rule that only
// holds while a particular string survives is pinned to the string rather than
// to the rule.
//
// Every case spends a real stored box through `validateTx`, so each verdict is
// the consensus verdict rather than a unit call, and every fixture CONSERVES
// with schema-valid outputs — output shape and conservation run ahead of
// authorization, so a fixture failing either would be refused for a reason that
// says nothing about who may spend.
//
// The admitted types are asserted as a BICONDITIONAL: the key the transition
// names authorizes, and a stranger's key does not. Refusal alone would pass on a
// rule that refuses everyone.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PROTOCOL_VERSION,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  BOX_TYPE_TAGS,
} from '@dagsocial/types';
import type {
  AnyBox,
  AnyBoxCandidate,
  UtxoTransaction,
} from '@dagsocial/types';
import { makeTestIdentity, seedProvenance, signTransaction, toHex } from '../helpers.js';
import type { TestIdentity } from '../helpers.js';
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
import { validateTx } from '../../src/services/utxo-engine.js';
import type { UtxoEngineDeps } from '../../src/services/utxo-engine.js';
import { config } from '../../src/config.js';

/**
 * One case per box type. `signer` is the key the type's transitions require, or
 * `null` when no transition admits the type as an input at all — the two
 * variants the authorization table holds, and between them they cover every
 * box type (TYPES_INTERFACE → What a new box type costs).
 */
interface Case {
  /** The box, minus provenance. */
  box: (holder: TestIdentity, other: TestIdentity) => Record<string, unknown>;
  /** Outputs of a spend that conserves and matches the schema. */
  outputs: (holder: TestIdentity) => AnyBoxCandidate[];
  /** The identity whose signature the transition requires, or null if none can. */
  signer: 'holder' | null;
}

const karmaOut = (owner: Uint8Array, value: bigint): AnyBoxCandidate =>
  ({ boxType: 'karma', value, createdAtBlock: 0, owner }) as unknown as AnyBoxCandidate;

const creditOut = (owner: Uint8Array, value: bigint): AnyBoxCandidate =>
  ({ boxType: 'credit', value, createdAtBlock: 0, owner }) as unknown as AnyBoxCandidate;

const CASES: Record<AnyBox['boxType'], Case> = {
  karma: {
    box: (h) => ({ boxType: 'karma', value: 10n, createdAtBlock: 0, owner: h.userId }),
    outputs: (h) => [karmaOut(h.userId, 10n)],
    signer: 'holder',
  },
  credit: {
    box: (h) => ({ boxType: 'credit', value: 100_000n, createdAtBlock: 0, owner: h.userId }),
    outputs: (h) => [creditOut(h.userId, 100_000n)],
    signer: 'holder',
  },
  // *voucher-signed* — and a VouchBox carries no `owner` at all, so the key the
  // row means is the only key field it has.
  vouch: {
    box: (h, o) => ({
      boxType: 'vouch', value: 1n, voucherId: h.userId, targetId: o.userId,
      createdAtBlock: 0,
    }),
    // The stake moves into a box the voucher's own transaction creates
    // (ARCHITECTURE → Vouch boxes); a zero-output spend is a whole-input
    // deficit and is refused before authorization is reached.
    outputs: (h) => [{
      boxType: 'vouch_escrow' as const,
      value: 1n,
      createdAtBlock: 0,
      owner: h.userId,
      releaseAtBlock: 0 + 2,
    } as never],
    signer: 'holder',
  },
  // `BLOCK_APPLICATION_ONLY` — the settlement returns the stake
  // (NODE_INTERFACE → Legal box transitions).
  vouch_escrow: {
    box: (h) => ({
      boxType: 'vouch_escrow', value: 1n, createdAtBlock: 0,
      owner: h.userId, releaseAtBlock: 5,
    }),
    outputs: (h) => [karmaOut(h.userId, 1n)],
    signer: null,
  },
  bond: {
    box: (h, o) => ({
      boxType: 'bond', value: 25n, inviterId: h.userId, inviteePublicKey: o.userId,
      createdAtBlock: 0,
    }),
    outputs: (h) => [karmaOut(h.userId, 25n)],
    signer: null,
  },
  karma_price: {
    box: () => ({
      boxType: 'karma_price', value: 10n,
      createdAtBlock: 0,
    }),
    outputs: (h) => [karmaOut(h.userId, 10n)],
    signer: null,
  },
  fee: {
    box: () => ({ boxType: 'fee', value: 10n, createdAtBlock: 0 }),
    outputs: (h) => [creditOut(h.userId, 10n)],
    signer: null,
  },
  emission: {
    box: () => ({ boxType: 'emission', value: 10n, createdAtBlock: 0 }),
    outputs: (h) => [creditOut(h.userId, 10n)],
    signer: null,
  },
  treasury: {
    box: () => ({ boxType: 'treasury', value: 10n, createdAtBlock: 0 }),
    outputs: (h) => [creditOut(h.userId, 10n)],
    signer: null,
  },
  karma_pool: {
    box: () => ({ boxType: 'karma_pool', value: 10n, createdAtBlock: 0 }),
    outputs: (h) => [karmaOut(h.userId, 10n)],
    signer: null,
  },
  genesis_proof: {
    box: () => ({
      boxType: 'genesis_proof', value: 0n, payload: new Uint8Array([0xaa]),
      createdAtBlock: 0,
    }),
    outputs: () => [],
    signer: null,
  },
  // `BLOCK_APPLICATION_ONLY` — only the settlement transaction consumes
  // markers (TYPES_INTERFACE → LikeAccrualBox). `author` is attribution, not
  // authorization.
  like_accrual: {
    box: (h) => ({
      boxType: 'like_accrual', value: 1n, createdAtBlock: 0, author: h.userId,
    }),
    outputs: (h) => [karmaOut(h.userId, 1n)],
    signer: null,
  },
};

describe('authorization is a property of the transition', () => {
  let deps: UtxoEngineDeps;
  let holder: TestIdentity;
  let other: TestIdentity;
  let stranger: TestIdentity;

  beforeEach(() => {
    initDb(':memory:');
    const db = getDb();
    deps = {
      getBox: storeGetBox,
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
      runInTransaction: (fn: () => void) => { (db.transaction(fn) as () => void)(); },
      getVouchBox: () => null,
      getNetworkRecord: () => ({ memberCount: 1 }),
      membershipBarMultiplier: 1,
      putIdentityRecord: () => {},
      protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
    };
    holder = makeTestIdentity();
    other = makeTestIdentity();
    stranger = makeTestIdentity();
  });

  afterEach(() => closeDb());

  /**
   * Seed the case's box and build the conserving spend of it.
   *
   * The nonce advances per call: provenance is deterministic, so two boxes
   * seeded from one fixture in one test would collide on
   * `(tx_id, output_index)`.
   */
  let nonce = 0;

  const ENTRIES = Object.entries(CASES) as [AnyBox['boxType'], Case][];

  function spendOf(c: Case): UtxoTransaction {
    const box = seedProvenance<AnyBox>(c.box(holder, other), 1, nonce++);
    storeInsertBox(box);
    return {
      inputs: [box.id],
      outputs: c.outputs(holder),
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
  }

  // -------------------------------------------------------------------------
  // The dichotomy, over every box type a transaction can reach. A type is either
  // signature-requiring or admitted by no transition, and `AUTHORIZATION`'s
  // `Record` over `AnyBox['boxType']` makes omitting one a compile error; this is
  // the runtime half: every type reaches a verdict, none reaches an "unknown"
  // arm, and none throws. `CASES` is keyed on the union so the compiler catches
  // a missing type (TYPES_INTERFACE → What a new box type costs).
  // -------------------------------------------------------------------------
  describe('every box type is either signature-requiring or admitted by no transition', () => {
    it('covers every box type in `AnyBox`', () => {
      const covered = Object.keys(CASES);
      expect([...covered].sort()).toEqual(
        (Object.keys(BOX_TYPE_TAGS) as string[]).sort(),
      );
    });

    for (const [boxType, c] of ENTRIES) {
      it(`${boxType}: unsigned is refused, with a verdict rather than a throw`, () => {
        const result = validateTx(deps, spendOf(c), 10);
        expect(result.valid).toBe(false);
        expect(result.error).toBeTypeOf('string');
      });
    }
  });

  // -------------------------------------------------------------------------
  // The signature-requiring half, as a biconditional: the key the transition
  // names authorizes, and no other key does.
  // -------------------------------------------------------------------------
  describe('a transition that requires a signature is satisfied by exactly the key it names', () => {
    const signing = ENTRIES.filter(([, c]) => c.signer !== null);

    for (const [boxType, c] of signing) {
      it(`${boxType}: the named key authorizes the spend`, () => {
        const tx = spendOf(c);
        signTransaction(tx, holder.privateKey, toHex(holder.userId));

        const result = validateTx(deps, tx, 10);
        expect(result.valid, result.error).toBe(true);
      });

      it(`${boxType}: a stranger's signature does not`, () => {
        const tx = spendOf(c);
        signTransaction(tx, stranger.privateKey, toHex(stranger.userId));

        expect(validateTx(deps, tx, 10).valid).toBe(false);
      });

      it(`${boxType}: the other key the transaction mentions does not either`, () => {
        // `other` is the vouch target and the invite's invitee — a key the box
        // itself names, which is the near miss a stranger does not test. For
        // karma and credit it is simply a second real key.
        const tx = spendOf(c);
        signTransaction(tx, other.privateKey, toHex(other.userId));

        expect(validateTx(deps, tx, 10).valid).toBe(false);
      });
    }
  });

  // -------------------------------------------------------------------------
  // The no-transition half: a signature is not a way in, so it does not matter
  // whose it is.
  //
  // Two negative assertions, and each excludes a different wrong gate. Not a
  // signature complaint, because producing a signature is free and a rule
  // wanting a different one would be satisfiable. And not the transition
  // table's wording either — its arms would refuse every barred type on their
  // own, as the deliberate second layer, so without this the case would pass
  // with authorization deleted.
  // -------------------------------------------------------------------------
  describe('a type no transition admits is refused whoever signed', () => {
    const barred = ENTRIES.filter(([, c]) => c.signer === null);

    for (const [boxType, c] of barred) {
      it(`${boxType}: refused unsigned, and refused signed by every key involved`, () => {
        for (const id of [null, holder, other, stranger]) {
          const tx = spendOf(c);
          if (id !== null) signTransaction(tx, id.privateKey, toHex(id.userId));

          const result = validateTx(deps, tx, 10);
          expect(result.valid, `${boxType} signed by ${id === null ? 'nobody' : toHex(id.userId).slice(0, 8)}`)
            .toBe(false);
          expect(result.error).not.toMatch(/signature|signed by/i);
          expect(result.error).not.toMatch(/Unknown box type|not user transactions/);
        }
      });
    }
  });

  // -------------------------------------------------------------------------
  // The ordering the whole gate rests on. Authorization runs ahead of the
  // transition-shape conditions, so a transaction that is BOTH unsigned and
  // malformed is refused for being unsigned.
  //
  // Pinned here for a signature-requiring type. The barred-type half of the
  // same ordering is pinned in `utxo-engine.test.ts`.
  // -------------------------------------------------------------------------
  describe('authorization precedes the transition shape conditions', () => {
    /** karma → credit: conserves and matches the schema, and no transition allows it. */
    function karmaToCredit(): UtxoTransaction {
      const karma = seedProvenance<AnyBox>({
        boxType: 'karma', value: 100_000n,  createdAtBlock: 0,owner: holder.userId,
      });
      storeInsertBox(karma);
      return {
        inputs: [karma.id],
        outputs: [creditOut(holder.userId, 100_000n)],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };
    }

    it('an unsigned, illegally-shaped karma spend is refused for the signature', () => {
      const result = validateTx(deps, karmaToCredit(), 10);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/signature/i);
    });

    it('and the same shape, signed, is refused for the shape — so both gates are live', () => {
      const tx = karmaToCredit();
      signTransaction(tx, holder.privateKey, toHex(holder.userId));

      const result = validateTx(deps, tx, 10);
      expect(result.valid).toBe(false);
      expect(result.error).not.toMatch(/signature/i);
    });
  });
});
