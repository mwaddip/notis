/**
 * Output shape — the closed per-boxType schema (field-type pin,
 * NODE_INTERFACE → "Output shape").
 *
 * Two layers:
 *  - direct `checkOutputShape` calls for the schema mechanics (stray key,
 *    missing key, present-with-undefined, unknown boxType, the provenance-trio
 *    skip) — the unknown-boxType arm is reachable ONLY directly, because every
 *    transition arm already rejects unknown output types on its own;
 *  - full `validateTx` runs against a real store for the consensus surface:
 *    every boxType's honest shape still validates through a legal transition
 *    (including the two declared optionals present and absent), and every
 *    output boxType rejects a `guard` key, which no box carries.
 *
 * `BOX_TYPES` below is the types a transaction may CREATE, which is what this
 * file is about — not every box type. `genesis_proof`, `emission` and
 * `treasury` have no `OUTPUT_SHAPE` row because no transaction may create
 * them; `genesis_proof`'s refusal is covered in
 * `genesis-proof-not-in-tx.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'crypto';
import {
  computeBoxId,
  computeTxId,
  POST_LOCK_THREAD_COST,
  VOUCH_KARMA_AMOUNT,
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
} from '@dagsocial/types';
import type {
  AnyBox,
  AnyBoxCandidate,
  KarmaBox,
  CreditBox,
  Post,
  UtxoTransaction,
} from '@dagsocial/types';
import Database from 'better-sqlite3';
import {
  fixtureProvenance,
  makePost,
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
import { validateTx, checkOutputShape } from '../../src/services/utxo-engine.js';
import type { UtxoEngineDeps } from '../../src/services/utxo-engine.js';

function rawPublicKey(keyObj: KeyObject): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

/** Honest candidate per boxType, parameterized on an owner key. */
function honestCandidate(
  boxType: string,
  owner: Uint8Array,
): Record<string, unknown> {
  switch (boxType) {
    case 'karma':
      return {
        boxType: 'karma',
        value: 10n,
        owner,
      };
    case 'credit':
      return {
        boxType: 'credit',
        value: 10n,
        owner,
      };
    case 'invite':
      return {
        boxType: 'invite',
        value: 0n,
        inviterId: owner,
        inviteePublicKey: new Uint8Array(32).fill(0xaa),
      };
    case 'bond':
      return {
        boxType: 'bond',
        value: 10n,
        inviterId: owner,
        inviteePublicKey: new Uint8Array(32).fill(0xaa),
      };
    case 'post_lock':
      return {
        boxType: 'post_lock',
        value: 10n,
        originalValue: 10n,
        owner,
      };
    case 'vouch':
      return {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        voucherId: owner,
        targetId: new Uint8Array(32).fill(0xcc),
      };
    case 'fee':
      // The shared prefix and nothing else — no owner, no tail
      // (TYPES_INTERFACE → FeeBox).
      return {
        boxType: 'fee',
        value: 10n,
      };
    default:
      throw new Error(`no honest candidate for ${boxType}`);
  }
}

/**
 * The types a transaction may CREATE — `OUTPUT_SHAPE`'s key set, restated as a
 * type so the tables below are **compile-checked rather than hand-kept**.
 *
 * ⛔ **An array of the union is satisfied by any subset of it**, so `BOX_TYPES`
 * alone tracks the set by hand and a new output type would silently go
 * uncovered by every loop in this file. `CREATABLE` is keyed on the union
 * instead, which makes the omission a compile error, and `BOX_TYPES` is
 * derived from its keys. Same shape as `MirroredBoxType` in
 * `ui-crypto-mirror.test.ts`.
 */
type OutputBoxType = Exclude<
  AnyBox['boxType'],
  'genesis_proof' | 'emission' | 'treasury'
>;

/** Every type a transaction may create — the union's key set, not a list. */
const CREATABLE: Record<OutputBoxType, true> = {
  karma: true,
  credit: true,
  invite: true,
  bond: true,
  post_lock: true,
  vouch: true,
  fee: true,
};

const BOX_TYPES = Object.keys(CREATABLE) as readonly OutputBoxType[];

function shapeOf(outputs: unknown[]) {
  return checkOutputShape(outputs as AnyBoxCandidate[]);
}

// ---------------------------------------------------------------------------
// Direct checkOutputShape tests (no store)
// ---------------------------------------------------------------------------

describe('checkOutputShape (direct)', () => {
  const owner = new Uint8Array(32).fill(1);

  it('accepts every boxType honest shape', () => {
    for (const t of BOX_TYPES) {
      const r = shapeOf([honestCandidate(t, owner)]);
      expect(r.valid, `${t}: ${r.error}`).toBe(true);
    }
  });

  it('accepts the declared optionals present (karma.decayBurn, credit.lockedUntilBlock)', () => {
    expect(shapeOf([{ ...honestCandidate('karma', owner), decayBurn: true }]).valid).toBe(true);
    expect(
      shapeOf([{ ...honestCandidate('credit', owner), lockedUntilBlock: 500 }]).valid,
    ).toBe(true);
  });

  it('tolerates client-supplied id/txId/index (candidate form — structurally stripped from all committed bytes)', () => {
    const r = shapeOf([
      { ...honestCandidate('karma', owner), id: 'ff'.repeat(32), txId: 'aa'.repeat(32), index: 3 },
    ]);
    expect(r.valid, r.error).toBe(true);
  });

  it('rejects an unknown boxType with a clean UtxoResult error', () => {
    const r = shapeOf([{ boxType: 'wat', value: 10n }]);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/unknown boxType/);
  });

  it('rejects a stray key on every boxType', () => {
    for (const t of BOX_TYPES) {
      const r = shapeOf([{ ...honestCandidate(t, owner), note: 'x' }]);
      expect(r.valid, t).toBe(false);
      expect(r.error, t).toMatch(/unexpected key 'note'/);
    }
  });

  it("rejects 'proofSource' on karma and credit — neither shape declares it", () => {
    for (const t of ['karma', 'credit'] as const) {
      const r = shapeOf([{ ...honestCandidate(t, owner), proofSource: t === 'karma' ? 'faucet' : -1 }]);
      expect(r.valid, t).toBe(false);
      expect(r.error, t).toMatch(/unexpected key 'proofSource'/);
    }
  });

  it('rejects a missing required key on every boxType (last key dropped)', () => {
    // `fee` has no field but `value` — the shared prefix is its whole shape —
    // so dropping the last key is dropping `value` itself.
    const dropped: Record<OutputBoxType, string> = {
      karma: 'owner',
      credit: 'owner',
      invite: 'inviteePublicKey',
      bond: 'inviteePublicKey',
      post_lock: 'originalValue',
      vouch: 'targetId',
      fee: 'value',
    };
    for (const t of BOX_TYPES) {
      const c = honestCandidate(t, owner);
      delete c[dropped[t]!];
      const r = shapeOf([c]);
      expect(r.valid, t).toBe(false);
      expect(r.error, t).toMatch(new RegExp(`missing required key '${dropped[t]}'`));
    }
  });

  it('rejects an optional key present with value undefined (it enters the id preimage but not the store round-trip)', () => {
    const r = shapeOf([{ ...honestCandidate('karma', owner), decayBurn: undefined }]);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/present with value undefined/);
  });

  it('rejects a required key present with value undefined', () => {
    const r = shapeOf([{ ...honestCandidate('post_lock', owner), originalValue: undefined }]);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/present with value undefined/);
  });

  it('rejects a guard key on every boxType — no box carries one', () => {
    // No box interface declares `guard` (NODE_INTERFACE → Legal box
    // transitions: authorization belongs to the transition, not the box), so
    // the key is outside every closed set and the value is irrelevant. A
    // candidate carrying one cannot be stored under a rule that reads it.
    for (const t of BOX_TYPES) {
      const r = shapeOf([{ ...honestCandidate(t, owner), guard: 'owner_signature' }]);
      expect(r.valid, t).toBe(false);
      expect(r.error, t).toMatch(/unexpected key 'guard'/);
    }
  });

  it('names the offending output index in the error', () => {
    const r = shapeOf([
      honestCandidate('karma', owner),
      { ...honestCandidate('post_lock', owner), notAField: true },
    ]);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/index 1 \(post_lock\)/);
  });
});

// ---------------------------------------------------------------------------
// validateTx integration — real store, signed txs, legal transitions
// ---------------------------------------------------------------------------

describe('validateTx output shape (integration)', () => {
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
  // Post transactions) — a second deviation in any fixture whose subject is the
  // output schema.
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

  function karmaChange(value: bigint): Record<string, unknown> {
    return {
      boxType: 'karma',
      value,
      owner: ownerPubKey,
    };
  }

  // ---- accept controls: one legal transition per output boxType ----

  it('accepts karma → karma (honest, decayBurn absent)', () => {
    const karma = seedKarma(100n);
    const r = validateTx(deps, signedTx([karma.id!], [karmaChange(100n)]), 10);
    expect(r.valid, r.error).toBe(true);
  });

  it('accepts karma → karma with decayBurn present', () => {
    const karma = seedKarma(100n);
    const r = validateTx(
      deps,
      signedTx([karma.id!], [{ ...karmaChange(100n), decayBurn: true }]),
      10,
    );
    expect(r.valid, r.error).toBe(true);
  });

  it('accepts credit → credit (honest, lockedUntilBlock absent and present)', () => {
    const c1 = seedCredit(40n);
    const r1 = validateTx(
      deps,
      signedTx(
        [c1.id!],
        [{ boxType: 'credit', value: 40n, owner: ownerPubKey }],
      ),
      10,
    );
    expect(r1.valid, r1.error).toBe(true);

    const r2 = validateTx(
      deps,
      signedTx(
        [c1.id!],
        [
          {
            boxType: 'credit',
            value: 40n,
            owner: ownerPubKey,
            lockedUntilBlock: 500,
          },
        ],
      ),
      10,
    );
    expect(r2.valid, r2.error).toBe(true);
  });

  it('accepts karma → karma + post_lock (honest)', () => {
    const karma = seedKarma(100n);
    const lock = {
      boxType: 'post_lock',
      value: POST_LOCK_THREAD_COST,
      originalValue: POST_LOCK_THREAD_COST,
      owner: ownerPubKey,
    };
    const r = validateTx(
      deps,
      signedTx(
        [karma.id!],
        [karmaChange(100n - POST_LOCK_THREAD_COST), lock],
        makePost(ownerPubKey, 'honest lock payload'),
      ),
      10,
    );
    expect(r.valid, r.error).toBe(true);
  });

  it('accepts karma → karma + vouch (honest)', () => {
    const karma = seedKarma(100n);
    const vouch = {
      boxType: 'vouch',
      value: VOUCH_KARMA_AMOUNT,
      voucherId: ownerPubKey,
      targetId: new Uint8Array(32).fill(0xcc),
    };
    const r = validateTx(
      deps,
      signedTx([karma.id!], [karmaChange(100n - VOUCH_KARMA_AMOUNT), vouch]),
      10,
    );
    expect(r.valid, r.error).toBe(true);
  });

  it('accepts karma → karma + invite + bond (honest)', () => {
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
    const change = karmaChange(100n - INVITE_BOND_KARMA);
    const r = validateTx(deps, signedTx([karma.id!], [change, invite, bond]), 10);
    expect(r.valid, r.error).toBe(true);
  });

  // ---- stray-key rejects: same legal transitions, one key added ----

  it('rejects a karma output carrying a guard key', () => {
    const karma = seedKarma(100n);
    const r = validateTx(
      deps,
      signedTx([karma.id!], [{ ...karmaChange(100n), guard: 'owner_signature' }]),
      10,
    );
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/\(karma\): unexpected key 'guard'/);
  });

  // ---- key-set rejects through the full pipeline ----

  it('rejects a stray key through validateTx', () => {
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
  });

  it('rejects a missing required key through validateTx (post_lock without originalValue)', () => {
    const karma = seedKarma(100n);
    const lock: Record<string, unknown> = {
      boxType: 'post_lock',
      value: POST_LOCK_THREAD_COST,
      originalValue: POST_LOCK_THREAD_COST,
      owner: ownerPubKey,
    };
    const tx = signedTx(
      [karma.id!],
      [karmaChange(100n - POST_LOCK_THREAD_COST), lock],
      makePost(ownerPubKey, 'lock payload'),
    );
    // The key is removed AFTER signing: `originalValue` is `vlqU64` in the
    // box-id preimage, so a box without it has no encoding and `signedTx` would
    // die at `computeTxId` before `checkOutputShape` — the gate under test —
    // ever ran. `checkOutputShape` is `validateTx` step 4 and signatures are
    // read at step 6, so the rejection asserted below still happens first.
    delete lock['originalValue'];
    const r = validateTx(deps, tx, 10);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/missing required key 'originalValue'/);
  });

  it('rejects an optional key present with undefined through validateTx (CBOR can encode it, the store cannot round-trip it)', () => {
    const karma = seedKarma(100n);
    const r = validateTx(
      deps,
      signedTx([karma.id!], [{ ...karmaChange(100n), decayBurn: undefined }]),
      10,
    );
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/present with value undefined/);
  });

  // ---- unknown boxType: the step-4 schema rejects it first ----
  // Inverted by the field-type pin: the shape check now runs at step 4, ahead
  // of the transition arms, so ITS unknown-boxType arm is the primary gate
  // and the karma arm's totality count is the defense-in-depth layer behind
  // it. The tightened assertion doubles as the placement pin — moving the
  // check back behind the arms resurfaces the arm's wording and fails here.
  it('rejects an unknown output boxType at the shape gate (the transition arm backstops it)', () => {
    const karma = seedKarma(100n);
    const alien = { boxType: 'wat', value: 10n };
    const r = validateTx(deps, signedTx([karma.id!], [{ ...karmaChange(90n) }, alien]), 10);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/unknown boxType wat/);
  });
});
