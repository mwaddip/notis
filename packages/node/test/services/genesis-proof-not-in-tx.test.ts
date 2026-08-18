import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { PROTOCOL_VERSION } from '@dagsocial/types';
import type {
  AnyBox,
  AnyBoxCandidate,
  GenesisProofBox,
  UtxoTransaction,
} from '@dagsocial/types';
import { seedProvenance } from '../helpers.js';
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
import { config } from '../../src/config.js';

/**
 * **A `genesis_proof` box may never appear in a transaction.** The box is
 * written by genesis seeding alone and is readable forever; without this rule
 * anyone could spray unbounded blobs into the UTXO set through an ordinary
 * transaction, and the one box that defines a network could be spent away.
 *
 * The rule has two halves and they cannot share a home. The OUTPUT half types a
 * whole candidate box, so `@dagsocial/validation` owns it at the gossip gate —
 * the twin below is node's own, at `checkOutputShape`. The INPUT half cannot
 * live there at all: `tx.inputs` are box **id strings**, and typing one requires
 * the UTXO set.
 *
 * Both halves assert the REASON, not merely `valid === false`. Each of these
 * transactions violates the rule *and* would fail some later check on its own —
 * conservation, an unknown transition — so a bare falsity assertion would pass
 * on a gate that has nothing to do with genesis proof boxes.
 */

function proofCandidate(payload = new Uint8Array([1, 2, 3])): Record<string, unknown> {
  return { boxType: 'genesis_proof', value: 0n,  createdAtBlock: 0,payload };
}

describe('a genesis_proof box may never be a transaction OUTPUT', () => {
  it('checkOutputShape refuses it by name, not as an unknown boxType', () => {
    const r = checkOutputShape([proofCandidate()] as unknown as AnyBoxCandidate[]);
    expect(r.valid).toBe(false);
    // The diagnosis is the assertion. The type excludes `genesis_proof` from
    // `OUTPUT_SHAPE`, so the unknown-boxType arm would reject it too — with a
    // reason that is false, since the tag is assigned rather than unknown.
    expect(r.error).toMatch(/genesis_proof box may not be a transaction output/);
    expect(r.error).not.toMatch(/unknown boxType/);
  });

  it('refuses it whatever else the candidate carries', () => {
    // The scan never dereferences `payload`, so a malformed proof box cannot be
    // slipped past by omitting fields or oversizing them.
    for (const out of [
      { boxType: 'genesis_proof' },
      proofCandidate(new Uint8Array(0)),
      proofCandidate(new Uint8Array(4096)),
      { ...proofCandidate(), owner: new Uint8Array(32) },
    ]) {
      const r = checkOutputShape([out] as unknown as AnyBoxCandidate[]);
      expect(r.valid, JSON.stringify(Object.keys(out))).toBe(false);
      expect(r.error).toMatch(/genesis_proof box may not be a transaction output/);
    }
  });

  it('refuses it at any position, and leaves the other output types alone', () => {
    const karma = {
      boxType: 'karma', value: 10n,  createdAtBlock: 0,owner: new Uint8Array(32).fill(1),
    };
    expect(checkOutputShape([karma] as unknown as AnyBoxCandidate[]).valid).toBe(true);
    const r = checkOutputShape([karma, proofCandidate()] as unknown as AnyBoxCandidate[]);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/index 1/);
  });
});

describe('a genesis_proof box may never be a transaction INPUT', () => {
  let deps: UtxoEngineDeps;
  let proof: GenesisProofBox & { id: string };

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
      getTopologyAuthor: () => null,
      runInTransaction: (fn: () => void) => { (db.transaction(fn) as () => void)(); },
    };
    proof = seedProvenance<GenesisProofBox>({
      boxType: 'genesis_proof' as const,
      value: 0n,
      createdAtBlock: 0,
      payload: new Uint8Array([0xaa, 0xbb]),
    });
    storeInsertBox(proof);
  });

  afterEach(() => closeDb());

  function spend(outputs: AnyBoxCandidate[]): UtxoTransaction {
    return { inputs: [proof.id], outputs, signatures: {}, protocolVersion: PROTOCOL_VERSION };
  }

  it('the store hands it back under the discriminant authorization keys on', () => {
    // The input half is keyed on the box TYPE, and the refusals below read that
    // type off whatever the UTXO set returns — so this pins the one premise
    // they share: a box round-trips under the discriminant it was stored with.
    const back = deps.getBox(proof.id);
    expect(back?.boxType).toBe('genesis_proof');
  });

  it('validateTx refuses to spend it, naming the box type', () => {
    // Zero outputs, so face-value conservation (0 in, 0 out) HOLDS and cannot be
    // what rejects this. The verdict has to come from authorization.
    const result = validateTx(deps, spend([]), 10);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/a genesis_proof box can never be consumed/);
    expect(result.error).toContain(proof.id);
  });

  it('refuses it whatever the transaction tries to produce', () => {
    const karmaOut = {
      boxType: 'karma', value: 0n,  createdAtBlock: 0,owner: new Uint8Array(32).fill(2),
    } as unknown as AnyBoxCandidate;
    const result = validateTx(deps, spend([karmaOut]), 10);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/a genesis_proof box can never be consumed/);
  });

  it('a proof box mixed with a karma input is refused before authorization', () => {
    // Not a weakness: "mixed input types" is a true diagnosis of a real
    // violation, and both orderings reject. Pinned so the ordering is a decision
    // rather than an accident.
    const karma = seedProvenance({
      boxType: 'karma' as const, value: 5n,  createdAtBlock: 0,owner: rawKey(),
    });
    storeInsertBox(karma);
    const tx: UtxoTransaction = {
      inputs: [proof.id, karma.id],
      outputs: [],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Mixed input types/);
  });
});

function rawKey(): Uint8Array {
  const { publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}
