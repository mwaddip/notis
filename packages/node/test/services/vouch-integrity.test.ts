// ---------------------------------------------------------------------------
// P2-B phase 2 — vouch integrity + the born-committed bond (audit
// F-consensus-3, B6, and two holes found deriving the phase: the unpinned
// voucherId and the invite-create arm).
//
// Every attack below was first written in its ACCEPTANCE form and run against
// HEAD, where all of them passed — these are transactions the engine used to
// accept, not hypothetical shapes. Each keeps its own reachability note.
//
// Each attack is paired with a non-vacuity control: the same transaction
// differing only in the field the new rule pins, proving the rejection
// isolates that one rule rather than tripping over conservation, authorization, or
// a malformed fixture.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import {
  computeTxId,
  VOUCH_KARMA_AMOUNT,
  VOUCH_MIN_BALANCE,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
} from '@dagsocial/types';
import type {
  AnyBox,
  BondBox,
  CandidateOf,
  KarmaBox,
  UtxoTransaction,
  VouchBox,
  VouchEscrowBox,
} from '@dagsocial/types';
import Database from 'better-sqlite3';

import {
  rawPublicKey,
  seedProvenance,
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
  getBondFor,
} from '../../src/store/index.js';
import { applyTx, validateTx } from '../../src/services/utxo-engine.js';
import { castVouch } from '../../src/services/vouch.js';
import { createInvite } from '../../src/services/invites.js';
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

describe('P2-B phase 2 — vouch integrity + born-committed bond', () => {
  let db: Database.Database;
  let voucher: TestKeys;
  let target: TestKeys;

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
      // Present from the before-leg on so both halves run the same fixture
      // code: HEAD ignores it, the tightened engine requires it. Backed by the
      // store's real predicate — the one implementation every path shares.
      // ⛔ The real predicate over escrow BOXES. This suite's whole subject is
      // the consensus gates, and a stubbed one would leave V3 asserting the
      // stub (NODE_INTERFACE → Vouch transition rules).
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
    voucher = makeKeys();
    target = makeKeys();
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
   * An unreleased `VouchEscrowBox` for `owner` — the state a cooling voucher is
   * in (ARCHITECTURE → Vouch boxes).
   *
   * ⚠ **It names no target**, so a pair-scoped cooldown is inexpressible: the
   * rule the box can carry is voucher-scoped.
   */
  function seedEscrow(owner: Uint8Array, releaseAtBlock: number, nonce = 90): void {
    storeInsertBox(
      seedProvenance<VouchEscrowBox>(
        {
          boxType: 'vouch_escrow' as const,
          value: VOUCH_KARMA_AMOUNT,
          createdAtBlock: 0,
          owner,
          releaseAtBlock,
        },
        1,
        nonce,
      ),
    );
  }

  /**
   * A vouch cast K(v) → K(v − stake) + Vouch(stake), signed by `signer`.
   * `voucherIdInBox` defaults to the signer but is a free field — the runtime
   * shape is attacker-supplied CBOR, not bound by the VouchBox type.
   */
  function buildVouchCast(
    karmaBox: KarmaBox,
    signer: TestKeys,
    opts: {
      stake?: bigint;
      voucherIdInBox?: Uint8Array;
      targetId?: Uint8Array;
      height?: number;
    } = {},
  ): UtxoTransaction {
    const stake = opts.stake ?? VOUCH_KARMA_AMOUNT;
    const h = opts.height ?? 0;
    const vouchOut = {
      boxType: 'vouch' as const,
      value: stake,
      createdAtBlock: h,
      voucherId: opts.voucherIdInBox ?? signer.pub,
      targetId: opts.targetId ?? target.pub,
    } as unknown as VouchBox;
    const karmaOut: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: karmaBox.value - stake,
      createdAtBlock: h,
      owner: karmaBox.owner,
    };
    const tx: UtxoTransaction = {
      inputs: [karmaBox.id!],
      outputs: [karmaOut, vouchOut],
      signatures: {},
      protocolVersion: 1,
    };
    addSignature(tx, signer);
    return tx;
  }

  // -------------------------------------------------------------------------
  // V1 — the stake is unpinned in both directions (audit F-consensus-3).
  // `checkOutputValues` permits 0n and conservation is the only other bound,
  // while the unvouch escrow writes the CONSTANT: a 0-value vouch matures
  // into 1 karma minted from nothing, a 100-value vouch destroys 99.
  // -------------------------------------------------------------------------

  it('V1: rejects a 0-value vouch cast', () => {
    // Accepted on HEAD — this exact tx returned { valid: true }, and its
    // unvouch matured into 1 karma minted from nothing (the escrow wrote the
    // constant). Measured end-to-end in vouch-value-flow.test.ts.
    const karma = seedKarma(voucher.pub, 100n);
    const tx = buildVouchCast(karma, voucher, { stake: 0n, height: 10 });

    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('must stake exactly');
  });

  it('V1: rejects a 100-value vouch cast', () => {
    // Accepted on HEAD. The unvouch escrow wrote the constant 1, so the other
    // 99 karma were destroyed — the pin closes both directions at once.
    const karma = seedKarma(voucher.pub, 200n);
    const tx = buildVouchCast(karma, voucher, { stake: 100n, height: 10 });

    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('must stake exactly');
  });

  it('V1 non-vacuity: the same cast staking exactly VOUCH_KARMA_AMOUNT is accepted', () => {
    const karma = seedKarma(voucher.pub, 100n);
    const tx = buildVouchCast(karma, voucher, { stake: VOUCH_KARMA_AMOUNT, height: 10 });

    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // V2 — voucherId is unpinned at cast. `checkAuthorization` reads a
  // VouchBox's signer as its `voucherId`, so a VouchBox carrying a foreign
  // voucherId is spendable by the foreign key: A stakes their karma, B
  // unvouches it, and the escrow matures to B — a karma transfer with no
  // invite.
  // -------------------------------------------------------------------------

  it('V2: rejects a cast whose voucherId is not the karma input owner', () => {
    // Accepted on HEAD — and the consequence ran to completion there: the
    // foreign key's unvouch was authorized (`checkAuthorization` reads a
    // VouchBox's signer as its `voucherId`), so the escrow re-minted A's
    // stake to B. The block-level half lives in vouch-value-flow.test.ts.
    const foreign = makeKeys();
    const karma = seedKarma(voucher.pub, 100n);
    const tx = buildVouchCast(karma, voucher, { voucherIdInBox: foreign.pub, height: 10 });

    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("voucherId must be the karma input's owner");
  });

  it('V2 front door: castVouch rejects a signer that is not the voucherId', () => {
    // Accepted on HEAD: castVouch never compared the signer to voucherId, so
    // the theft was reachable through the service layer, not only through a
    // block. The consensus pin closes both doors at once.
    const foreign = makeKeys();
    seedKarma(foreign.pub, 20n, 1); // castVouch reads the voucherId's balance
    const karma = seedKarma(voucher.pub, 100n);
    const tx = buildVouchCast(karma, voucher, { voucherIdInBox: foreign.pub, height: 10 });

    expect(() => castVouch(deps, tx, 10)).toThrow(
      /voucherId must be the karma input's owner/,
    );
  });

  it('V2 non-vacuity: the same cast with voucherId == karma input owner is accepted', () => {
    const karma = seedKarma(voucher.pub, 100n);
    const tx = buildVouchCast(karma, voucher, { voucherIdInBox: voucher.pub, height: 10 });

    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // V3 — an unreleased escrow blocks re-vouching. `hasActiveVouchEscrow`
  // queries for unspent `vouch_escrow` boxes owned by the voucher; the
  // settlement consumes it at the first block at or past `releaseAtBlock`,
  // so the vouch cycle is capped at one per cooldown window.
  // -------------------------------------------------------------------------

  it('V3: rejects a cast while the voucher holds an unreleased escrow', () => {
    const karma = seedKarma(voucher.pub, 100n);
    seedEscrow(voucher.pub, 999);

    const tx = buildVouchCast(karma, voucher, { height: 10 });
    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('unreleased escrow');
  });

  // ⛔ **THE GATE IS VOUCHER-SCOPED, SO THE NON-VACUITY ACTOR IS A SECOND
  // VOUCHER.** `VouchEscrowBox` carries `owner` and `releaseAtBlock` and no
  // target (TYPES_INTERFACE → VouchEscrowBox), so a pair-scoped question is one
  // this state cannot answer — the rule is *this voucher may not recast*, and
  // what has to stay legal is somebody else's cast while their own escrow
  // cools.
  it('V3 non-vacuity: another voucher\'s escrow does not block this cast', () => {
    const otherVoucher = makeKeys();
    const karma = seedKarma(voucher.pub, 100n);
    seedEscrow(otherVoucher.pub, 999);

    const tx = buildVouchCast(karma, voucher, { height: 10 });
    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // V5 — the balance threshold is a consensus rule (ARCHITECTURE → "Vouch
  // boxes"). It is the one vouch rule that cannot be read off the transaction:
  // it is a predicate on the voucher's summed karma, so a cast arriving inside
  // a block — which passes no service gate on the receiving node — is decided
  // by the same number every other path reads.
  // -------------------------------------------------------------------------

  it('V5: rejects a cast whose voucher holds less than VOUCH_MIN_BALANCE', () => {
    const karma = seedKarma(voucher.pub, VOUCH_MIN_BALANCE - 1n);
    const tx = buildVouchCast(karma, voucher, { height: 10 });

    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('requires a karma balance of at least');
  });

  it('V5: a balance spread over two boxes clears a threshold neither box alone covers', () => {
    const first = seedKarma(voucher.pub, VOUCH_MIN_BALANCE - 1n, 0);
    seedKarma(voucher.pub, VOUCH_MIN_BALANCE - 1n, 1);

    const tx = buildVouchCast(first, voucher, { height: 10 });
    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('V5 non-vacuity: the same cast from a voucher at exactly VOUCH_MIN_BALANCE is accepted', () => {
    const karma = seedKarma(voucher.pub, VOUCH_MIN_BALANCE);
    const tx = buildVouchCast(karma, voucher, { height: 10 });

    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // V4 — the bond is the network's only sybil cost, and nothing may make it
  // free. Two rules carry that: the create arm pins the bond's value, and no
  // transaction shape can spend a bond back out (NODE_INTERFACE → "Bond
  // transition rules").
  // -------------------------------------------------------------------------

  /** K(100) → K(75) + Invite(0) + Bond(25), with the bond's value free. */
  function buildInviteCreate(
    inviter: TestKeys,
    karmaBox: KarmaBox,
    invitee: Uint8Array,
    bondValue: bigint,
  ): UtxoTransaction {
    const karmaOut: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: karmaBox.value - bondValue,
      createdAtBlock: 0,
      owner: inviter.pub,
    };
    const bondOut = {
      boxType: 'bond' as const,
      value: bondValue,
      createdAtBlock: 0,
      inviterId: inviter.pub,
      inviteePublicKey: invitee,
    } as BondBox;
    const tx: UtxoTransaction = {
      inputs: [karmaBox.id!],
      outputs: [karmaOut, bondOut],
      signatures: {},
      protocolVersion: 1,
    };
    addSignature(tx, inviter);
    return tx;
  }

  it('V4: rejects an invite whose bond holds nothing', () => {
    // Conservation alone permits a 0-value bond: the karma output simply keeps
    // the difference. Without the floor the settlement grants the invitee a
    // karma box out of the pool for no stake at all — and the grant EQUALS the
    // bond, which is what makes it arbitrage-free (ARCHITECTURE → Invite
    // System). At 0 the grant is 0 too, so the arbitrage is gone but the free
    // identity is not: the floor is what prices it.
    const inviter = makeKeys();
    const karma = seedKarma(inviter.pub, 100n);
    const createTx = buildInviteCreate(inviter, karma, makeKeys().pub, 0n);

    const result = validateTx(deps, createTx, 1);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('An invite bond must hold between');
  });

  it('V4: rejects an invite create whose bond is under the floor', () => {
    const inviter = makeKeys();
    const karma = seedKarma(inviter.pub, 100n);
    const createTx = buildInviteCreate(
      inviter, karma, makeKeys().pub, config.inviteBondMin - 1n,
    );

    const result = validateTx(deps, createTx, 1);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('An invite bond must hold between');
  });

  it('V4: rejects an invite create whose bond is over the ceiling', () => {
    // The boundary the old equality had no analogue for. The grant is a pool
    // draw sized by the inviter, so without a ceiling one invite could name
    // more of the supply than the pool holds.
    const inviter = makeKeys();
    const karma = seedKarma(inviter.pub, config.inviteBondMax + 100n);
    const createTx = buildInviteCreate(
      inviter, karma, makeKeys().pub, config.inviteBondMax + 1n,
    );

    const result = validateTx(deps, createTx, 1);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('An invite bond must hold between');
  });

  it('V4 service path: createInvite rejects a bond under the floor', () => {
    const inviter = makeKeys();
    const karma = seedKarma(inviter.pub, 100n);
    const createTx = buildInviteCreate(inviter, karma, makeKeys().pub, 1n);

    expect(() => createInvite(deps, createTx, 1)).toThrow(
      /An invite bond must hold between/,
    );
  });

  it('V4: no transaction can spend a bond back out, whoever signs', () => {
    // The other half. A funded bond is worth nothing as a cost if either party
    // can reclaim it: no user transition consumes one, so neither the inviter's
    // signature nor the invitee's satisfies it, and the settlement that does
    // release it is block application's alone.
    const inviter = makeKeys();
    const invitee = makeKeys();
    const karma = seedKarma(inviter.pub, 100n);
    const createTx = buildInviteCreate(inviter, karma, invitee.pub, FIXTURE_BOND_KARMA);
    const created = validateTx(deps, createTx, 1);
    expect(created.valid).toBe(true);
    applyTx(deps, createTx, created.computedOutputs!, 1);

    const bond = getBondFor(invitee.pub)!;
    expect(bond).not.toBeNull();

    for (const signer of [inviter, invitee]) {
      const reclaim: UtxoTransaction = {
        inputs: [bond.id!],
        outputs: [{
          boxType: 'karma', value: bond.value, createdAtBlock: 0, owner: signer.pub,
        }],
        signatures: {},
        protocolVersion: 1,
      };
      addSignature(reclaim, signer);
      const result = validateTx(deps, reclaim, 2);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('block application');
    }
  });

  it('V4 non-vacuity: the same create with a fully-funded bond is accepted', () => {
    const inviter = makeKeys();
    const karma = seedKarma(inviter.pub, 100n);
    const createTx = buildInviteCreate(
      inviter, karma, makeKeys().pub, FIXTURE_BOND_KARMA,
    );

    const result = validateTx(deps, createTx, 1);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });
});
