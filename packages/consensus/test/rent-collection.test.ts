import { describe, it, expect } from 'vitest';
import { sign as cryptoSign } from 'crypto';
import {
  PROTOCOL_VERSION,
  STORAGE_RENT_PER_BYTE,
  boxRecordBytes,
  computeTxId,
  profileFor,
} from '@dagsocial/types';
import type { AnyBox, AnyBoxCandidate, CreditBox, UtxoTransaction } from '@dagsocial/types';
import { applyBlock, validateTx } from '@dagsocial/consensus';
import type { ApplyContext, UtxoEngineDeps } from '@dagsocial/consensus';
import {
  MemoryStateView,
  applyContextFor,
  candidateBlock,
  hex,
  karmaBox,
  identityRecord,
  protocolBox,
  seedProvenance,
  seededIdentity,
  type TestIdentity,
} from './helpers.js';

/**
 * NODE_INTERFACE → "Storage rent is a transition requiring no signature". The
 * waiver and the shape hang on one predicate — the empty signature map:
 *
 * 1. An empty map is a rent transition: every credit input is past its period,
 *    the credit outputs are its inputs' successors as a multiset of
 *    `(owner, value)`, no `lockedUntilBlock` on a successor, and the one FeeBox
 *    carries the summed charge; a shape wider or narrower than that is refused.
 * 2. A non-empty map is an ordinary credit transfer: every input requires its
 *    owner's signature, past its period or not, and the ordinary credit row's
 *    shape rules hold.
 *
 * The square these cases span is listed in each describe block; the folded
 * cells are called out beside the case that answers them.
 */

const ctx: ApplyContext = {
  ...applyContextFor(profileFor('devnet')),
  storageRentPeriodBlocks: 4,
};
const H = 10;
const PAST = H - ctx.storageRentPeriodBlocks - 2; // past the period
const FRESH = H - 1; // not past

const victim = seededIdentity('rent/victim');
const attacker = seededIdentity('rent/attacker');
const stranger = seededIdentity('rent/stranger');
const miner = seededIdentity('rent/miner');

function creditBox(
  owner: Uint8Array,
  value: bigint,
  createdAtBlock: number,
  nonce: number,
): CreditBox & { id: string } {
  return seedProvenance<CreditBox>(
    { boxType: 'credit', value, createdAtBlock, owner },
    createdAtBlock,
    nonce,
  );
}

function chargeFor(box: CreditBox): bigint {
  return STORAGE_RENT_PER_BYTE * BigInt(boxRecordBytes(box, box.txId, box.index).length);
}

/** Each signer's signature over the transaction's id, into its map. */
function signedBy(tx: UtxoTransaction, ...signers: TestIdentity[]): UtxoTransaction {
  const id = Buffer.from(computeTxId(tx), 'hex');
  for (const s of signers) {
    tx.signatures[hex(s.userId)] = new Uint8Array(cryptoSign(null, id, s.privateKey));
  }
  return tx;
}

function makeTx(
  inputs: AnyBox[],
  outputs: AnyBoxCandidate[],
): UtxoTransaction {
  return {
    inputs: inputs.map((b) => b.id!),
    outputs,
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
}

/** The engine's deps over a fixed set of live boxes; these cases read nothing else. */
function depsOver(boxes: AnyBox[]): UtxoEngineDeps {
  const live = new Map(boxes.map((box) => [box.id!, box]));
  const unread = (member: string) => (): never => {
    throw new Error(`a rent case reads no ${member}`);
  };
  return {
    getBox: (id) => live.get(id) ?? null,
    insertBox: unread('insertBox'),
    consumeBox: unread('consumeBox'),
    getKarmaValue: unread('getKarmaValue'),
    getIdentityRecord: unread('getIdentityRecord'),
    hasActiveVouchEscrow: unread('hasActiveVouchEscrow'),
    vouchCooldownBlocks: ctx.vouchCooldownBlocks,
    getTopologyAuthor: unread('getTopologyAuthor'),
    getPendingPostAuthor: unread('getPendingPostAuthor'),
    runInTransaction: unread('runInTransaction'),
    inviteBondMin: ctx.inviteBondMin,
    inviteBondMax: ctx.inviteBondMax,
    decayCfg: ctx.decayCfg,
    storageRentPeriodBlocks: ctx.storageRentPeriodBlocks,
    getBoxProvenance: (id) => {
      const b = live.get(id);
      return b ? { txId: b.txId, index: b.index } : null;
    },
    getVouchBox: unread('getVouchBox'),
    getNetworkRecord: unread('getNetworkRecord'),
    membershipBarMultiplier: ctx.membershipBarMultiplier,
    putIdentityRecord: unread('putIdentityRecord'),
    protocolVersionSchedule: ctx.protocolVersionSchedule,
    getUsername: unread('getUsername'),
    getUsernameByOwner: unread('getUsernameByOwner'),
  };
}

/**
 * The exact rent shape for one past-period input: one successor of
 * `value - charge` to the same owner at the current height, the FeeBox at the
 * summed charge.
 */
function exactRentOutputs(inputs: CreditBox[]): AnyBoxCandidate[] {
  let totalCharge = 0n;
  const outputs: AnyBoxCandidate[] = [];
  for (const inp of inputs) {
    const charge = chargeFor(inp);
    totalCharge += charge;
    outputs.push({
      boxType: 'credit',
      value: inp.value - charge,
      createdAtBlock: H,
      owner: inp.owner,
    } as AnyBoxCandidate);
  }
  outputs.push({ boxType: 'fee', value: totalCharge, createdAtBlock: H } as AnyBoxCandidate);
  return outputs;
}

// ---------------------------------------------------------------------------
// validateTx: the three findings, written against the contract's verdict and
// red against today's rule — flipped to `it` as the rule lands.
// ---------------------------------------------------------------------------

describe('validateTx — the three findings the rule retires', () => {
  it('C-5: a past-period victim box co-spent with the attacker\'s fresh box, attacker-signed → REFUSE', () => {
    const victimBox = creditBox(victim.userId, 50_000_000n, PAST, 1);
    const attackerBox = creditBox(attacker.userId, 1_000_000n, FRESH, 2);
    const tx = makeTx(
      [victimBox, attackerBox],
      [{ boxType: 'credit', value: 51_000_000n, createdAtBlock: H, owner: attacker.userId } as AnyBoxCandidate],
    );
    signedBy(tx, attacker);
    expect(validateTx(depsOver([victimBox, attackerBox]), tx, H).valid).toBe(false);
  });

  it('C-5b: two past-period boxes of one owner and one value, unsigned, one successor to another owner → REFUSE', () => {
    const v1 = creditBox(victim.userId, 50_000_000n, PAST, 3);
    const v2 = creditBox(victim.userId, 50_000_000n, PAST, 4);
    const c1 = chargeFor(v1);
    const c2 = chargeFor(v2);
    const tx = makeTx(
      [v1, v2],
      [
        { boxType: 'credit', value: v1.value - c1, createdAtBlock: H, owner: victim.userId } as AnyBoxCandidate,
        { boxType: 'credit', value: v2.value - c2, createdAtBlock: H, owner: attacker.userId } as AnyBoxCandidate,
        { boxType: 'fee', value: c1 + c2, createdAtBlock: H } as AnyBoxCandidate,
      ],
    );
    expect(validateTx(depsOver([v1, v2]), tx, H).valid).toBe(false);
  });

  it('C-5c: an unsigned rent collection with a successor carrying lockedUntilBlock → REFUSE', () => {
    const v = creditBox(victim.userId, 50_000_000n, PAST, 5);
    const c = chargeFor(v);
    const tx = makeTx(
      [v],
      [
        {
          boxType: 'credit',
          value: v.value - c,
          createdAtBlock: H,
          owner: victim.userId,
          lockedUntilBlock: Number.MAX_SAFE_INTEGER,
        } as AnyBoxCandidate,
        { boxType: 'fee', value: c, createdAtBlock: H } as AnyBoxCandidate,
      ],
    );
    expect(validateTx(depsOver([v]), tx, H).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateTx: the square the rule spans, through the four statements.
//
// Dimensions — inputs × signature-map × outputs — folded where cells agree:
// - inputs: one past · one fresh · two past of one owner · two past of two
//   owners · two past of one owner and one value · one past + one fresh · one
//   past that cannot cover its charge
// - signature map: empty · every owner · the fresh box's owner only (C-5) · a
//   stranger alone · every owner + a stranger
// - outputs: exact rent · successor to another owner (whole value with and
//   without a fee, and the exact-rent-shape value) · locked successor ·
//   successor at a wrong height · one short · one over · fee off by one ·
//   below-charge box with a credit output beside the fee · ordinary transfer ·
//   signed with rent-shape outputs
//
// Folded cells:
// - "fresh input signed by its owner" (whatever the outputs) is folded into
//   the ordinary-transfer accept cases: a non-empty map puts every input on
//   OWNER_SIGNATURE, past or fresh, so the arm is the same.
// - "two past-period inputs, successor to another owner on only one of them"
//   is folded into C-5b: the refusal is the same multiset argument the
//   single-input "successor to another owner" case asserts.
// ---------------------------------------------------------------------------

describe('validateTx — the empty-map rent transition', () => {
  it('one past-period input, empty map, exact rent shape → ACCEPT', () => {
    const v = creditBox(victim.userId, 50_000_000n, PAST, 6);
    const tx = makeTx([v], exactRentOutputs([v]));
    expect(validateTx(depsOver([v]), tx, H)).toMatchObject({ valid: true });
  });

  it('two past-period inputs of one owner, empty map, exact rent shape → ACCEPT', () => {
    const v1 = creditBox(victim.userId, 50_000_000n, PAST, 7);
    const v2 = creditBox(victim.userId, 60_000_000n, PAST, 8);
    const tx = makeTx([v1, v2], exactRentOutputs([v1, v2]));
    expect(validateTx(depsOver([v1, v2]), tx, H)).toMatchObject({ valid: true });
  });

  it('two past-period inputs of two owners, empty map, exact rent shape (each successor to its own owner) → ACCEPT', () => {
    const v1 = creditBox(victim.userId, 50_000_000n, PAST, 9);
    const v2 = creditBox(stranger.userId, 70_000_000n, PAST, 10);
    const tx = makeTx([v1, v2], exactRentOutputs([v1, v2]));
    expect(validateTx(depsOver([v1, v2]), tx, H)).toMatchObject({ valid: true });
  });

  it('two past-period inputs of one owner and one value, empty map, two successors to that owner → ACCEPT', () => {
    const v1 = creditBox(victim.userId, 50_000_000n, PAST, 11);
    const v2 = creditBox(victim.userId, 50_000_000n, PAST, 12);
    const tx = makeTx([v1, v2], exactRentOutputs([v1, v2]));
    expect(validateTx(depsOver([v1, v2]), tx, H)).toMatchObject({ valid: true });
  });

  it('one past-period input whose value is below its charge is consumed whole; empty map, FeeBox only → ACCEPT', () => {
    // A credit box at the floor (MIN_BOX_VALUE_PER_BYTE × bytes) cannot cover
    // one period's charge: STORAGE_RENT_PER_BYTE / MIN_BOX_VALUE_PER_BYTE ≈ 3,889
    // (TYPES_INTERFACE → Box value domain). The whole value goes to the FeeBox,
    // no successor exists.
    const underfunded = creditBox(victim.userId, 100n, PAST, 13);
    expect(underfunded.value).toBeLessThan(chargeFor(underfunded));
    const tx = makeTx(
      [underfunded],
      [{ boxType: 'fee', value: underfunded.value, createdAtBlock: H } as AnyBoxCandidate],
    );
    expect(validateTx(depsOver([underfunded]), tx, H)).toMatchObject({ valid: true });
  });

  it('empty map, two past-period inputs, one successor short → REFUSE', () => {
    const v1 = creditBox(victim.userId, 50_000_000n, PAST, 14);
    const v2 = creditBox(victim.userId, 60_000_000n, PAST, 15);
    const c1 = chargeFor(v1);
    const c2 = chargeFor(v2);
    // Only one of the two successors emitted. The missing value lands in the
    // FeeBox, so conservation holds but the shape does not.
    const tx = makeTx(
      [v1, v2],
      [
        { boxType: 'credit', value: v1.value - c1, createdAtBlock: H, owner: victim.userId } as AnyBoxCandidate,
        { boxType: 'fee', value: (v2.value - c2) + c1 + c2, createdAtBlock: H } as AnyBoxCandidate,
      ],
    );
    expect(validateTx(depsOver([v1, v2]), tx, H).valid).toBe(false);
  });

  it('empty map, two past-period inputs, one successor over → REFUSE', () => {
    const v1 = creditBox(victim.userId, 50_000_000n, PAST, 16);
    const v2 = creditBox(victim.userId, 60_000_000n, PAST, 17);
    const c1 = chargeFor(v1);
    const c2 = chargeFor(v2);
    // Three credit outputs for two inputs — one surplus successor.
    const tx = makeTx(
      [v1, v2],
      [
        { boxType: 'credit', value: v1.value - c1, createdAtBlock: H, owner: victim.userId } as AnyBoxCandidate,
        { boxType: 'credit', value: v2.value - c2, createdAtBlock: H, owner: victim.userId } as AnyBoxCandidate,
        { boxType: 'credit', value: 1n, createdAtBlock: H, owner: victim.userId } as AnyBoxCandidate,
        { boxType: 'fee', value: c1 + c2 - 1n, createdAtBlock: H } as AnyBoxCandidate,
      ],
    );
    expect(validateTx(depsOver([v1, v2]), tx, H).valid).toBe(false);
  });

  it('empty map, past-period input, FeeBox off by one → REFUSE', () => {
    const v = creditBox(victim.userId, 50_000_000n, PAST, 18);
    const c = chargeFor(v);
    const tx = makeTx(
      [v],
      [
        { boxType: 'credit', value: v.value - c + 1n, createdAtBlock: H, owner: victim.userId } as AnyBoxCandidate,
        { boxType: 'fee', value: c - 1n, createdAtBlock: H } as AnyBoxCandidate,
      ],
    );
    expect(validateTx(depsOver([v]), tx, H).valid).toBe(false);
  });

  it('empty map + one past + one fresh → REFUSE at auth with the fresh input\'s owner-signature refusal', () => {
    // The past-period input's signer answers null; the fresh input's answers
    // the owner, so `checkAuthorization` fires `missingOwnerSignature` on the
    // fresh box before the credit arm's period predicate is reached.
    const past = creditBox(victim.userId, 50_000_000n, PAST, 19);
    const fresh = creditBox(victim.userId, 50_000_000n, FRESH, 20);
    const cp = chargeFor(past);
    const cf = chargeFor(fresh);
    const tx = makeTx(
      [past, fresh],
      [
        { boxType: 'credit', value: past.value - cp, createdAtBlock: H, owner: victim.userId } as AnyBoxCandidate,
        { boxType: 'credit', value: fresh.value - cf, createdAtBlock: H, owner: victim.userId } as AnyBoxCandidate,
        { boxType: 'fee', value: cp + cf, createdAtBlock: H } as AnyBoxCandidate,
      ],
    );
    const r = validateTx(depsOver([past, fresh]), tx, H);
    expect(r.valid).toBe(false);
    expect(r.error).toContain(`Missing or invalid owner signature for box ${fresh.id}`);
  });

  it('empty map, one past-period input, whole value to another owner, NO fee → REFUSE', () => {
    const v = creditBox(victim.userId, 50_000_000n, PAST, 35);
    const tx = makeTx(
      [v],
      [{ boxType: 'credit', value: v.value, createdAtBlock: H, owner: stranger.userId } as AnyBoxCandidate],
    );
    const r = validateTx(depsOver([v]), tx, H);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('Rent: credit outputs do not match');
  });

  it('empty map, one past-period input, whole value to another owner, with a fee → REFUSE', () => {
    // Value conservation holds: credit[stranger, v - f] + fee[f] = v. The fee
    // is not the rent charge, so the shape is wrong on both value and owner.
    const v = creditBox(victim.userId, 50_000_000n, PAST, 36);
    const fee = 1n;
    const tx = makeTx(
      [v],
      [
        { boxType: 'credit', value: v.value - fee, createdAtBlock: H, owner: stranger.userId } as AnyBoxCandidate,
        { boxType: 'fee', value: fee, createdAtBlock: H } as AnyBoxCandidate,
      ],
    );
    const r = validateTx(depsOver([v]), tx, H);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('Rent: credit outputs do not match');
  });

  it('empty map, one past-period input, exact rent shape but successor to another owner → REFUSE', () => {
    const v = creditBox(victim.userId, 50_000_000n, PAST, 37);
    const c = chargeFor(v);
    const tx = makeTx(
      [v],
      [
        { boxType: 'credit', value: v.value - c, createdAtBlock: H, owner: stranger.userId } as AnyBoxCandidate,
        { boxType: 'fee', value: c, createdAtBlock: H } as AnyBoxCandidate,
      ],
    );
    const r = validateTx(depsOver([v]), tx, H);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('Rent: credit outputs do not match');
  });

  it('empty map, one past-period input, exact rent shape but successor at a height other than the current → REFUSE', () => {
    // A height in the past still passes step 6 (createdAtBlock <=
    // currentBlockHeight) and reaches the rent arm's successor-height check.
    const v = creditBox(victim.userId, 50_000_000n, PAST, 38);
    const c = chargeFor(v);
    const tx = makeTx(
      [v],
      [
        { boxType: 'credit', value: v.value - c, createdAtBlock: H - 1, owner: victim.userId } as AnyBoxCandidate,
        { boxType: 'fee', value: c, createdAtBlock: H } as AnyBoxCandidate,
      ],
    );
    const r = validateTx(depsOver([v]), tx, H);
    expect(r.valid).toBe(false);
    expect(r.error).toContain(`must equal height ${H}`);
  });

  it('empty map, one past-period input below its charge, a credit output beside the fee → REFUSE', () => {
    // The ACCEPT shape for a below-charge box is FeeBox only, no successor.
    // Emitting a credit output alongside the fee makes expectedSuccessors=0
    // and actualSuccessors=1. The input value sits between the per-byte floor
    // and the charge, so the credit output can satisfy step 6's floor.
    const belowCharge = creditBox(victim.userId, 20_000_000n, PAST, 39);
    expect(belowCharge.value).toBeLessThan(chargeFor(belowCharge));
    const tx = makeTx(
      [belowCharge],
      [
        { boxType: 'credit', value: 10_000_000n, createdAtBlock: H, owner: victim.userId } as AnyBoxCandidate,
        { boxType: 'fee', value: 10_000_000n, createdAtBlock: H } as AnyBoxCandidate,
      ],
    );
    const r = validateTx(depsOver([belowCharge]), tx, H);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('Rent: credit outputs do not match');
  });

  it('empty map, one FRESH box, an ordinary transfer → REFUSE at auth with the owner-signature refusal', () => {
    // The input is not past its period, so its signer answers the owner; the
    // map holds no signature, so `checkAuthorization` fires first, before the
    // credit arm's period predicate.
    const fresh = creditBox(victim.userId, 50_000_000n, FRESH, 40);
    const tx = makeTx(
      [fresh],
      [{ boxType: 'credit', value: 50_000_000n, createdAtBlock: H, owner: stranger.userId } as AnyBoxCandidate],
    );
    const r = validateTx(depsOver([fresh]), tx, H);
    expect(r.valid).toBe(false);
    expect(r.error).toContain(`Missing or invalid owner signature for box ${fresh.id}`);
  });

  it('empty map, one FRESH box, the exact rent shape → REFUSE at auth with the owner-signature refusal', () => {
    // Even when the outputs are the rent shape, a fresh input under an empty
    // map still refuses at auth: the signer answers the owner.
    const fresh = creditBox(victim.userId, 50_000_000n, FRESH, 41);
    const tx = makeTx([fresh], exactRentOutputs([fresh]));
    const r = validateTx(depsOver([fresh]), tx, H);
    expect(r.valid).toBe(false);
    expect(r.error).toContain(`Missing or invalid owner signature for box ${fresh.id}`);
  });
});

describe('validateTx — a non-empty map is an ordinary credit transfer', () => {
  it('owner-signed past-period input, ordinary transfer to another owner → ACCEPT', () => {
    const v = creditBox(victim.userId, 50_000_000n, PAST, 21);
    const tx = makeTx(
      [v],
      [
        { boxType: 'credit', value: 40_000_000n, createdAtBlock: H, owner: stranger.userId } as AnyBoxCandidate,
        { boxType: 'credit', value: 9_900_000n, createdAtBlock: H, owner: victim.userId } as AnyBoxCandidate,
        { boxType: 'fee', value: 100_000n, createdAtBlock: H } as AnyBoxCandidate,
      ],
    );
    signedBy(tx, victim);
    expect(validateTx(depsOver([v]), tx, H)).toMatchObject({ valid: true });
  });

  it('owner-signed past-period input, outputs happen to be the rent shape → ACCEPT (ordinary transfer)', () => {
    // Signed → non-empty map → ordinary transfer arm. The rent-shape outputs
    // satisfy the ordinary credit row's shape rules (credit/fee only, at most
    // one fee, no zero fee).
    const v = creditBox(victim.userId, 50_000_000n, PAST, 22);
    const tx = makeTx([v], exactRentOutputs([v]));
    signedBy(tx, victim);
    expect(validateTx(depsOver([v]), tx, H)).toMatchObject({ valid: true });
  });

  it('owner-signed FRESH input, ordinary transfer → ACCEPT', () => {
    const fresh = creditBox(victim.userId, 50_000_000n, FRESH, 23);
    const tx = makeTx(
      [fresh],
      [{ boxType: 'credit', value: 50_000_000n, createdAtBlock: H, owner: stranger.userId } as AnyBoxCandidate],
    );
    signedBy(tx, victim);
    expect(validateTx(depsOver([fresh]), tx, H)).toMatchObject({ valid: true });
  });

  it('non-empty map, mixed past+fresh of two owners, both signed → ACCEPT', () => {
    const past = creditBox(victim.userId, 50_000_000n, PAST, 24);
    const fresh = creditBox(attacker.userId, 10_000_000n, FRESH, 25);
    const tx = makeTx(
      [past, fresh],
      [{ boxType: 'credit', value: 60_000_000n, createdAtBlock: H, owner: stranger.userId } as AnyBoxCandidate],
    );
    signedBy(tx, victim, attacker);
    expect(validateTx(depsOver([past, fresh]), tx, H)).toMatchObject({ valid: true });
  });

  it('non-empty map but a required owner\'s signature is missing → REFUSE at auth', () => {
    // C-5's shape: attacker signs their fresh box, victim's past-period box
    // carries no signature. The non-empty map puts every input on the ordinary
    // transfer rule and the victim's owner key is unaccounted for.
    const victimBox = creditBox(victim.userId, 50_000_000n, PAST, 26);
    const attackerBox = creditBox(attacker.userId, 1_000_000n, FRESH, 27);
    const tx = makeTx(
      [victimBox, attackerBox],
      [{ boxType: 'credit', value: 51_000_000n, createdAtBlock: H, owner: attacker.userId } as AnyBoxCandidate],
    );
    signedBy(tx, attacker);
    const r = validateTx(depsOver([victimBox, attackerBox]), tx, H);
    expect(r.valid).toBe(false);
    expect(r.error).toContain(`Missing or invalid owner signature for box ${victimBox.id}`);
  });

  it('a stranger alone (no input owns their key), past-period input → REFUSE at auth with "Missing or invalid owner signature"', () => {
    const v = creditBox(victim.userId, 50_000_000n, PAST, 28);
    const tx = makeTx(
      [v],
      [{ boxType: 'credit', value: v.value, createdAtBlock: H, owner: victim.userId } as AnyBoxCandidate],
    );
    signedBy(tx, stranger);
    const r = validateTx(depsOver([v]), tx, H);
    // Non-empty map puts each input on OWNER_SIGNATURE. Victim's signature is
    // absent, so the input refuses with its rule's text before the unrequired
    // key is reached.
    expect(r.valid).toBe(false);
    expect(r.error).toContain(`Missing or invalid owner signature for box ${v.id}`);
  });

  it('every owner plus a stranger → REFUSE at auth with the unrequired-key rule', () => {
    const v = creditBox(victim.userId, 50_000_000n, PAST, 29);
    const tx = makeTx(
      [v],
      [
        { boxType: 'credit', value: v.value - 1_000n, createdAtBlock: H, owner: victim.userId } as AnyBoxCandidate,
        { boxType: 'fee', value: 1_000n, createdAtBlock: H } as AnyBoxCandidate,
      ],
    );
    signedBy(tx, victim, stranger);
    const r = validateTx(depsOver([v]), tx, H);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('Signature map carries unrequired key');
  });
});

// ---------------------------------------------------------------------------
// applyBlock: each finding carried in a block body, applied over a view that
// seeds the past-period boxes and the four protocol boxes the settlement
// reads.
// ---------------------------------------------------------------------------

function genesisView(credits: CreditBox[]): MemoryStateView {
  const view = new MemoryStateView({ memberCount: 0 });
  let nonce = 100;
  for (const c of credits) view.insertBox(c);
  view.insertBox(protocolBox('emission', profileFor('devnet').creditEmissionTotal, nonce++));
  view.insertBox(protocolBox('karma_pool', 1_000_000n, nonce++));
  view.insertBox(protocolBox('treasury', 0n, nonce++));
  view.insertBox(protocolBox('backer_pool', 0n, nonce++));
  // Seed a karma box for the miner so the activity bump in membershipPass
  // has a key: nothing in a credit-only rent block needs any karma, but the
  // activity scan still reads records.
  view.insertBox(karmaBox(miner.userId, 1n, nonce++, 0));
  view.putIdentityRecord(miner.userId, identityRecord({ memberSinceBlock: 1 }));
  return view;
}

function applyRejected(txs: UtxoTransaction[], inputs: CreditBox[]): string | undefined {
  const view = genesisView(inputs);
  // `candidateBlock` reads `tx` and `txId` only; `out` is unused by
  // `buildBlockSettlement`, which decodes each body tx from its bytes.
  const built = txs.map((tx) => ({ tx, txId: computeTxId(tx), out: [] as AnyBox[] }));
  const block = candidateBlock(view, H, built, miner.userId, ctx);
  const result = applyBlock(view, block, ctx);
  return result.ok ? undefined : result.reason;
}

describe('applyBlock — the three findings refused in a block', () => {
  it('C-5: a block carrying the mixed co-spend attack → REFUSED', () => {
    const victimBox = creditBox(victim.userId, 50_000_000n, PAST, 30);
    const attackerBox = creditBox(attacker.userId, 1_000_000n, FRESH, 31);
    const tx = makeTx(
      [victimBox, attackerBox],
      [{ boxType: 'credit', value: 51_000_000n, createdAtBlock: H, owner: attacker.userId } as AnyBoxCandidate],
    );
    signedBy(tx, attacker);
    const reason = applyRejected([tx], [victimBox, attackerBox]);
    expect(reason).toContain(`Missing or invalid owner signature for box ${victimBox.id}`);
  });

  it('C-5b: a block carrying the duplicate-successor attack → REFUSED', () => {
    const v1 = creditBox(victim.userId, 50_000_000n, PAST, 32);
    const v2 = creditBox(victim.userId, 50_000_000n, PAST, 33);
    const c1 = chargeFor(v1);
    const c2 = chargeFor(v2);
    const tx = makeTx(
      [v1, v2],
      [
        { boxType: 'credit', value: v1.value - c1, createdAtBlock: H, owner: victim.userId } as AnyBoxCandidate,
        { boxType: 'credit', value: v2.value - c2, createdAtBlock: H, owner: attacker.userId } as AnyBoxCandidate,
        { boxType: 'fee', value: c1 + c2, createdAtBlock: H } as AnyBoxCandidate,
      ],
    );
    const reason = applyRejected([tx], [v1, v2]);
    expect(reason).toContain('failed re-validation');
  });

  it('C-5c: a block carrying a rent successor with lockedUntilBlock → REFUSED', () => {
    const v = creditBox(victim.userId, 50_000_000n, PAST, 34);
    const c = chargeFor(v);
    const tx = makeTx(
      [v],
      [
        {
          boxType: 'credit',
          value: v.value - c,
          createdAtBlock: H,
          owner: victim.userId,
          lockedUntilBlock: Number.MAX_SAFE_INTEGER,
        } as AnyBoxCandidate,
        { boxType: 'fee', value: c, createdAtBlock: H } as AnyBoxCandidate,
      ],
    );
    const reason = applyRejected([tx], [v]);
    expect(reason).toContain('failed re-validation');
  });
});
