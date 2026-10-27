import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sign as cryptoSign } from 'crypto';
import { MAX_TX_BYTES, PROTOCOL_VERSION, computeTxId, encodeTx, profileFor } from '@dagsocial/types';
import { bytesToHex } from '@dagsocial/types';
import type { AnyBox, AnyBoxCandidate, CreditBox, KarmaBox, UtxoTransaction } from '@dagsocial/types';
import { verifyEd25519 } from '@dagsocial/validation';
import { validateTx } from '@dagsocial/consensus';
import type { UtxoEngineDeps } from '@dagsocial/consensus';
import {
  applyContextFor,
  consolidateTx,
  hex,
  karmaBox,
  seedProvenance,
  seededIdentity,
  type TestIdentity,
} from './helpers.js';

// Every signature check the engine makes is `verifyEd25519`; the spy counts them.
vi.mock('@dagsocial/validation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dagsocial/validation')>();
  return { ...actual, verifyEd25519: vi.fn(actual.verifyEd25519) };
});
const checks = (): number => vi.mocked(verifyEd25519).mock.calls.length;

/**
 * The authorization step of `validateTx` checks each signer once
 * (CONSENSUS_INTERFACE → Cost → "A transaction checks each signer once"), and
 * every input still names its signer through its rule: an input whose signer
 * did not sign, or signed wrongly, refuses with its rule's text.
 */

const ctx = applyContextFor(profileFor('devnet'));
const H = 2;
const a = seededIdentity('authorization/a');
const b = seededIdentity('authorization/b');
const outsider = seededIdentity('authorization/outsider');

/** The engine's deps over a fixed set of live boxes; these cases read nothing else. */
function depsOver(boxes: AnyBox[]): UtxoEngineDeps {
  const live = new Map(boxes.map((box) => [box.id!, box]));
  const unread = (member: string) => (): never => {
    throw new Error(`an authorization case reads no ${member}`);
  };
  return {
    getBox: (id) => live.get(id) ?? null,
    insertBox: unread('insertBox'),
    consumeBox: unread('consumeBox'),
    getKarmaValue: unread('getKarmaValue'),
    getKarmaOwed: unread('getKarmaOwed'),
    // Rule 3 reads the owner's unmarked karma box ids; the stub answers from
    // the fixture boxes so a karma transaction naming every one of them is
    // admitted.
    getOwnKarmaBoxIds: (owner) =>
      boxes
        .filter((b): b is KarmaBox & { id: string } =>
          b.boxType === 'karma' &&
          bytesToHex((b as KarmaBox).owner) === bytesToHex(owner) &&
          (b as KarmaBox).income !== true &&
          b.id !== undefined)
        .map((b) => b.id),
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
    getBoxProvenance: unread('getBoxProvenance'),
    getVouchBox: unread('getVouchBox'),
    getNetworkRecord: unread('getNetworkRecord'),
    membershipBarMultiplier: ctx.membershipBarMultiplier,
    putIdentityRecord: unread('putIdentityRecord'),
    protocolVersionSchedule: ctx.protocolVersionSchedule,
    getUsername: unread('getUsername'),
    getUsernameByOwner: unread('getUsernameByOwner'),
  };
}

/** Each signer's signature over the transaction's id, into its map. */
function signedBy(tx: UtxoTransaction, ...signers: TestIdentity[]): UtxoTransaction {
  const id = Buffer.from(computeTxId(tx), 'hex');
  for (const s of signers) tx.signatures[hex(s.userId)] = new Uint8Array(cryptoSign(null, id, s.privateKey));
  return tx;
}

/** 308 karma boxes of `a` into one: the most inputs one transaction's bytes admit. */
function wideConsolidation() {
  const inputs = Array.from({ length: 308 }, (_, i) => karmaBox(a.userId, 1n, i));
  const { tx } = consolidateTx(a, inputs, H);
  return { inputs, tx };
}

/** Three credit boxes each of `a` and `b`, interleaved, paid to one output: two signers. */
function twoSignerPayment() {
  const inputs = [a, b, a, b, a, b].map((owner, i) =>
    seedProvenance<CreditBox>({ boxType: 'credit', value: 100_000n, createdAtBlock: 1, owner: owner.userId }, 1, i),
  );
  const tx: UtxoTransaction = {
    inputs: inputs.map((box) => box.id!),
    outputs: [{ boxType: 'credit', value: 600_000n, createdAtBlock: H, owner: outsider.userId } as AnyBoxCandidate],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  return { inputs, tx };
}

describe('authorization checks each signer once', () => {
  beforeEach(() => {
    vi.mocked(verifyEd25519).mockClear();
  });

  it('a transaction whose 308 inputs one signer holds verifies that signature once', () => {
    const { inputs, tx } = wideConsolidation();
    expect(encodeTx(tx).length).toBeLessThanOrEqual(MAX_TX_BYTES);

    expect(validateTx(depsOver(inputs), tx, computeTxId(tx), H).valid).toBe(true);
    expect(checks()).toBe(1);
  });

  it("two signers whose inputs interleave are each verified once", () => {
    const { inputs, tx } = twoSignerPayment();
    signedBy(tx, a, b);

    expect(validateTx(depsOver(inputs), tx, computeTxId(tx), H).valid).toBe(true);
    expect(checks()).toBe(2);
  });

  it("a signer whose signature is missing refuses at the first input it signs for, with its rule's text", () => {
    const wide = wideConsolidation();
    wide.tx.signatures = {};
    expect(validateTx(depsOver(wide.inputs), wide.tx, computeTxId(wide.tx), H)).toEqual({
      valid: false,
      error: `Missing or invalid owner signature for box ${wide.inputs[0]!.id}`,
    });
    expect(checks()).toBe(0);

    const pay = twoSignerPayment();
    signedBy(pay.tx, a);
    expect(validateTx(depsOver(pay.inputs), pay.tx, computeTxId(pay.tx), H)).toEqual({
      valid: false,
      error: `Missing or invalid owner signature for box ${pay.inputs[1]!.id}`,
    });
    expect(checks()).toBe(1);
  });

  it("a signature that does not verify refuses at the first input its key signs for, checked once", () => {
    const wide = wideConsolidation();
    signedBy(wide.tx, outsider);
    wide.tx.signatures = { [hex(a.userId)]: wide.tx.signatures[hex(outsider.userId)]! };
    expect(validateTx(depsOver(wide.inputs), wide.tx, computeTxId(wide.tx), H)).toEqual({
      valid: false,
      error: `Missing or invalid owner signature for box ${wide.inputs[0]!.id}`,
    });
    expect(checks()).toBe(1);

    vi.mocked(verifyEd25519).mockClear();
    const pay = twoSignerPayment();
    signedBy(pay.tx, a, b);
    pay.tx.signatures[hex(b.userId)] = pay.tx.signatures[hex(a.userId)]!;
    expect(validateTx(depsOver(pay.inputs), pay.tx, computeTxId(pay.tx), H)).toEqual({
      valid: false,
      error: `Missing or invalid owner signature for box ${pay.inputs[1]!.id}`,
    });
    expect(checks()).toBe(2);
  });

  it('a key no input requires is refused once every input has verified', () => {
    const { inputs, tx } = wideConsolidation();
    signedBy(tx, outsider);
    expect(validateTx(depsOver(inputs), tx, computeTxId(tx), H)).toEqual({
      valid: false,
      error: `Signature map carries unrequired key ${hex(outsider.userId).slice(0, 16)}…`,
    });
    expect(checks()).toBe(1);
  });
});

/**
 * A deps' `verifySignature` is the check each required signer answers to, and
 * `verifyEd25519` is called only when the deps carry none
 * (CONSENSUS_INTERFACE → The overlay). Every case above runs with none. Who must
 * sign, and the refusal of a key no input requires, are the same either way.
 */
describe("authorization answers each signer from the deps' verifySignature when they carry one", () => {
  beforeEach(() => {
    vi.mocked(verifyEd25519).mockClear();
  });

  const withCheck = (boxes: AnyBox[], check: (s: Uint8Array, m: Uint8Array, k: Uint8Array) => boolean) =>
    ({ ...depsOver(boxes), verifySignature: vi.fn(check) });

  it('each required signer is asked once, with its entry, the id and its key, and verifyEd25519 never', () => {
    const { inputs, tx } = twoSignerPayment();
    signedBy(tx, a, b);
    const deps = withCheck(inputs, () => true);

    expect(validateTx(deps, tx, computeTxId(tx), H).valid).toBe(true);
    const id = computeTxId(tx);
    expect(deps.verifySignature.mock.calls.map(([s, m, k]) => [hex(s), hex(m), hex(k)])).toEqual([
      [hex(tx.signatures[hex(a.userId)]!), id, hex(a.userId)],
      [hex(tx.signatures[hex(b.userId)]!), id, hex(b.userId)],
    ]);
    expect(checks()).toBe(0);
  });

  it('a check answering false fails a correctly signed transaction with its rule\'s text', () => {
    const { inputs, tx } = twoSignerPayment();
    signedBy(tx, a, b);
    expect(validateTx(withCheck(inputs, () => false), tx, computeTxId(tx), H)).toEqual({
      valid: false,
      error: `Missing or invalid owner signature for box ${inputs[0]!.id}`,
    });
    expect(checks()).toBe(0);
  });

  it('a check answering true still refuses a missing signature and a key no input requires', () => {
    const pay = twoSignerPayment();
    signedBy(pay.tx, a);
    const payDeps = withCheck(pay.inputs, () => true);
    expect(validateTx(payDeps, pay.tx, computeTxId(pay.tx), H)).toEqual({
      valid: false,
      error: `Missing or invalid owner signature for box ${pay.inputs[1]!.id}`,
    });
    expect(payDeps.verifySignature).toHaveBeenCalledTimes(1);

    const wide = wideConsolidation();
    signedBy(wide.tx, outsider);
    expect(validateTx(withCheck(wide.inputs, () => true), wide.tx, computeTxId(wide.tx), H)).toEqual({
      valid: false,
      error: `Signature map carries unrequired key ${hex(outsider.userId).slice(0, 16)}…`,
    });
    expect(checks()).toBe(0);
  });
});

/**
 * `validateTx` reads its id from the caller (NODE_INTERFACE → validateTx): a
 * well-formed id its signatures do not cover refuses at the owner-signature
 * rule, with that rule's reason, and a transaction handed its own id answers
 * valid.
 */
describe('validateTx reads its id from the caller', () => {
  beforeEach(() => {
    vi.mocked(verifyEd25519).mockClear();
  });

  it("handed the transaction's own id, a signed consolidation answers valid", () => {
    const { inputs, tx } = wideConsolidation();
    expect(validateTx(depsOver(inputs), tx, computeTxId(tx), H).valid).toBe(true);
    expect(checks()).toBe(1);
  });

  it("handed another transaction's id, refuses with the owner-signature reason at the first input", () => {
    const { inputs, tx } = wideConsolidation();
    const other = consolidateTx(a, inputs, H + 1).tx;
    const otherId = computeTxId(other);
    expect(otherId).not.toBe(computeTxId(tx));
    expect(validateTx(depsOver(inputs), tx, otherId, H)).toEqual({
      valid: false,
      error: `Missing or invalid owner signature for box ${inputs[0]!.id}`,
    });
    expect(checks()).toBe(1);
  });
});
