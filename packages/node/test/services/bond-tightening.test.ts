// ---------------------------------------------------------------------------
// Bond transitions — audit F-consensus-1, closed by construction.
//
// A `BondBox` has no user-transaction shape at all: no user transition names
// one as an input, so `checkAuthorization` refuses a bond input at step 6
// whoever signed and whatever the outputs look like (NODE_INTERFACE → "Bond
// transition rules"). Every attack
// below is one of the shapes that had to be pinned individually while a bond was
// spendable — settlement theft, cancel-absorb, the burn, and the griefed
// probation window — and each is now refused by the same rule.
//
// Enumerating them rather than asserting the rule once is the point: a rule
// that subsumes four defects is only as good as the demonstration that it
// reaches all four, and a future transition arm that re-admitted any of these
// shapes would pass a single generic test.
//
// Each attack is paired with a non-vacuity control, so a rejection isolates
// authorization rather than tripping over conservation or a malformed fixture.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import {
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
  UtxoTransaction,
} from '@dagsocial/types';
import Database from 'better-sqlite3';

import { seedAsOneTx, rawPublicKey, seedProvenance,
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
import { validateTx } from '../../src/services/utxo-engine.js';
import { computeTxId } from '@dagsocial/types';
import { config } from '../../src/config.js';

interface TestKeys {
  pub: Uint8Array;
  priv: KeyObject;
}

function makeKeys(): TestKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: rawPublicKey(publicKey), priv: privateKey };
}

/** Sign the tx hash for `keys` and store under the hex pubkey. */
function addSignature(tx: UtxoTransaction, keys: TestKeys): void {
  const hash = Buffer.from(computeTxId(tx), 'hex');
  tx.signatures[Buffer.from(keys.pub).toString('hex')] = new Uint8Array(
    cryptoSign(null, hash, keys.priv),
  );
}

describe('bond transitions (audit F-consensus-1)', () => {
  let db: Database.Database;
  let inviter: TestKeys;
  let invitee: TestKeys;

  function makeDeps() {
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
      getKarmaValue: (owner: Uint8Array): bigint =>
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
  }

  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    initDb(':memory:');
    db = getDb();
    inviter = makeKeys();
    invitee = makeKeys();
    deps = makeDeps();
  });

  afterEach(() => {
    closeDb();
  });

  /** Seed a karma box for `owner` with independent fixture provenance. */
  function seedKarma(owner: Uint8Array, value: bigint, nonce = 0): KarmaBox {
    const candidate = {
      boxType: 'karma' as const,
      value,
      createdAtBlock: 0,
      owner,
    };
    const box = seedProvenance<KarmaBox>(candidate, 1, nonce);
    storeInsertBox(box);
    return box;
  }

  /**
   * Seed the bond an invite emits — the whole of what an invite leaves behind
   * (ARCHITECTURE → Invite System). There is no second box.
   */
  function seedPair(): { bond: BondBox } {
    const bondCandidate = {
      boxType: 'bond' as const,
      value: FIXTURE_BOND_KARMA,
      createdAtBlock: 0,
      inviterId: inviter.pub,
      inviteePublicKey: invitee.pub,
    };
    const [bond] = seedAsOneTx([bondCandidate]);
    storeInsertBox(bond!);
    return { bond: bond as BondBox };
  }

  /** A karma output owned by `owner`. */
  function karmaOut(owner: Uint8Array, value: bigint): KarmaBox {
    return { boxType: 'karma', value, createdAtBlock: 0, owner } as KarmaBox;
  }

  /** Every rejection here names the same rule; assert the reason, not just the verdict. */
  function expectRefusedAsBlockApplyOnly(tx: UtxoTransaction, height: number): void {
    const result = validateTx(deps, tx, height);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('block application');
  }

  // -------------------------------------------------------------------------
  // 1. settlement-theft — the invitee signs bond → own KarmaBox and takes the
  //    deposit. Under the old rules this needed an explicit owner pin on the
  //    settlement shape; there is no settlement shape now.
  // -------------------------------------------------------------------------

  it('settlement-theft: the invitee cannot spend a bond to their own karma box', () => {
    const { bond } = seedPair();
    const tx: UtxoTransaction = {
      inputs: [bond.id!],
      outputs: [karmaOut(invitee.pub, FIXTURE_BOND_KARMA)],
      signatures: {},
      protocolVersion: 1,
    };
    addSignature(tx, invitee);
    expectRefusedAsBlockApplyOnly(tx, 2000);
  });

  it('settlement-theft: nor can the INVITER, which is the sharper half', () => {
    // The old rules made this shape legal once probation expired — the whole
    // point of the settlement transition. It is refused now because settlement
    // is block application's, and the deadline is a height the transaction
    // cannot assert (NODE_INTERFACE → "Bond transition rules").
    const { bond } = seedPair();
    const tx: UtxoTransaction = {
      inputs: [bond.id!],
      outputs: [karmaOut(inviter.pub, FIXTURE_BOND_KARMA)],
      signatures: {},
      protocolVersion: 1,
    };
    addSignature(tx, inviter);
    expectRefusedAsBlockApplyOnly(tx, 2000);
  });

  // -------------------------------------------------------------------------
  // 2. bond-absorb — a karma spend that also consumes the bond, sweeping the
  //    inviter's own stake back into their balance ahead of the deadline.
  // -------------------------------------------------------------------------

  it('bond-absorb: a karma spend may not name the bond alongside its karma', () => {
    const { bond } = seedPair();
    const karma = seedKarma(inviter.pub, 50n);
    const tx: UtxoTransaction = {
      inputs: [karma.id!, bond.id!],
      outputs: [karmaOut(inviter.pub, 50n + FIXTURE_BOND_KARMA)],
      signatures: {},
      protocolVersion: 1,
    };
    addSignature(tx, inviter);
    // Mixed input types are refused at step 3, ahead of authorization, which is
    // a second layer over the same shape rather than a different verdict.
    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Mixed input types|block application/);
  });

  it('non-vacuity: the invite that CREATES a bond is accepted', () => {
    // The live shape, and the control this file needs: without it every
    // rejection above could be the gate refusing anything a bond is named in.
    // ⛔ The transaction conserves — the invitee's karma comes from the pool at
    // settlement, not from the inviter (NODE_INTERFACE → validateTx step 5).
    const karma = seedKarma(inviter.pub, 50n + FIXTURE_BOND_KARMA);
    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        karmaOut(inviter.pub, 50n),
        {
          boxType: 'bond',
          value: FIXTURE_BOND_KARMA,
          createdAtBlock: 0,
          inviterId: inviter.pub,
          inviteePublicKey: invitee.pub,
        } as BondBox,
      ],
      signatures: {},
      protocolVersion: 1,
    };
    addSignature(tx, inviter);
    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 3. bond-burn — outputs: [] on a bond input, torching the inviter's stake.
  //    Forfeiture is real now, but it is the settlement's remainder at the
  //    probation deadline, never a transaction anyone can send.
  // -------------------------------------------------------------------------

  // ⚠ Two layers, and the ORDER decides which one answers. Conservation is
  // `validateTx` step 5 and authorization is step 6, so a zero-output bond spend
  // never reaches it: the value is gone and the sums say so first. Asserting
  // 'block application' here would be asserting a message the gate cannot
  // produce for this shape — the burn is refused, by the earlier rule.
  it('bond-burn: a zero-output bond spend is refused, invitee-signed', () => {
    const { bond } = seedPair();
    const tx: UtxoTransaction = {
      inputs: [bond.id!],
      outputs: [],
      signatures: {},
      protocolVersion: 1,
    };
    addSignature(tx, invitee);
    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('non-conservation');
  });

  it('bond-burn: the inviter cannot burn their own bond either', () => {
    const { bond } = seedPair();
    const tx: UtxoTransaction = {
      inputs: [bond.id!],
      outputs: [],
      signatures: {},
      protocolVersion: 1,
    };
    addSignature(tx, inviter);
    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('non-conservation');
  });

  it('bond-burn: a VALUE-CONSERVING bond spend is the one authorization answers', () => {
    // The layer below. Sending the bond's value straight back out keeps the
    // sums balanced, so conservation passes and authorization is what refuses —
    // which is the rule that actually makes a bond unspendable.
    const { bond } = seedPair();
    const tx: UtxoTransaction = {
      inputs: [bond.id!],
      outputs: [karmaOut(inviter.pub, bond.value)],
      signatures: {},
      protocolVersion: 1,
    };
    addSignature(tx, inviter);
    expectRefusedAsBlockApplyOnly(tx, 10);
  });

  it('bond-burn non-vacuity: the unvouch is the spend that DOES apply, escrowing its stake', () => {
    // The conservation exemption for a zero-output spend is vouch-only, and it
    // is still live: without this control the burn rejections above could be
    // conservation refusing every zero-output shape.
    const voucher = inviter;
    const vouch = seedProvenance<VouchBox>(
      {
        boxType: 'vouch' as const,
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: 0,
        voucherId: voucher.pub,
        targetId: invitee.pub,
      },
      1,
    );
    storeInsertBox(vouch);
    const tx: UtxoTransaction = {
      inputs: [vouch.id!],
      // ⛔ **The escrow output, because the exemption is retired.** The unvouch
      // is still the one karma-side spend that produces no karma box — it
      // produces an ESCROW box — and that is what separates it from the bond
      // burn above, which produces nothing at all and is refused.
      outputs: [{
        boxType: 'vouch_escrow' as const,
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: 0,
        owner: voucher.pub,
        releaseAtBlock: 0 + 2,
      } as never],
      signatures: {},
      protocolVersion: 1,
    };
    addSignature(tx, voucher);
    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 4. grief-commit — the committing invitee chose the probation window and
  //    could lock the inviter's bond effectively forever. There is no commit
  //    transition, and no window on the box: the deadline is
  //    `IdentityRecord.invitedAtBlock + INVITE_PROBATION_BLOCKS`, written by
  //    block application when the claim applies.
  // -------------------------------------------------------------------------

  it('grief-commit: a bond cannot be spent into a replacement bond', () => {
    const { bond } = seedPair();
    const tx: UtxoTransaction = {
      inputs: [bond.id!],
      outputs: [
        {
          boxType: 'bond',
          value: FIXTURE_BOND_KARMA,
          createdAtBlock: 0,
          inviterId: inviter.pub,
          inviteePublicKey: invitee.pub,
        } as BondBox,
      ],
      signatures: {},
      protocolVersion: 1,
    };
    addSignature(tx, invitee);
    expectRefusedAsBlockApplyOnly(tx, 10);
  });

  it('grief-commit: an unsigned bond spend is refused at the same rule', () => {
    // No transition admits a bond at all, so an empty signature map fails on
    // the same clause rather than on a missing-signature one — which is what
    // makes "no user transaction spends a bond" a property of the box rather
    // than of who happens to be asked.
    const { bond } = seedPair();
    const tx: UtxoTransaction = {
      inputs: [bond.id!],
      outputs: [karmaOut(inviter.pub, FIXTURE_BOND_KARMA)],
      signatures: {},
      protocolVersion: 1,
    };
    expectRefusedAsBlockApplyOnly(tx, 10);
  });
});
