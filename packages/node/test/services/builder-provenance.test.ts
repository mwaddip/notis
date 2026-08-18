import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPrivateKey } from 'crypto';
import {
  computeBoxId,
  computeTxId,
  generateKeyPair,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type {
  BondBox,
  CandidateOf,
  KarmaBox,
  UtxoTransaction,
} from '@dagsocial/types';
import { initDb, closeDb } from '../../src/store/db.js';
import { insertBox, getBox, getKarmaBoxes } from '../../src/store/utxo.js';
import { createInvite } from '../../src/services/invites.js';
import { validateTx, materializeOutput } from '../../src/services/utxo-engine.js';
import {
  fixtureProvenance,
  seedProvenance,
  signTransaction,
  FIXTURE_BOND_KARMA,
} from '../helpers.js';

/**
 * The invite's *predicted* box id.
 *
 * `POST /invites` hands the client a `bondBoxId` before the box exists. If the
 * service predicts a different id than block application materializes, the
 * client is holding a name for nothing — and it fails as a missing box at some
 * later read, not as a visible error at prediction time.
 *
 * The bond output sits at index **1** of `tx.outputs` (karma, bond), so this
 * also pins that positions come from the output's real position rather than
 * from a per-box counter or a hardcoded 0.
 */

describe('invite id prediction carries transaction provenance', () => {
  let inviter: ReturnType<typeof generateKeyPair>;
  let inviterId: Uint8Array;
  let invitee: Uint8Array;
  let inviterPrivKeyObj: ReturnType<typeof createPrivateKey>;
  const HEIGHT = 50;

  beforeEach(() => {
    initDb(':memory:');
    inviter = generateKeyPair();
    inviterId = inviter.publicKey;
    invitee = generateKeyPair().publicKey;
    inviterPrivKeyObj = createPrivateKey({
      key: Buffer.from(inviter.secretKey),
      format: 'der',
      type: 'pkcs8',
    });
  });

  afterEach(() => {
    closeDb();
  });

  /** A valid invite tx: consumes one KarmaBox, produces karma + bond. */
  function buildInviteTx(): UtxoTransaction {
    const karma = seedProvenance<KarmaBox>({
      boxType: 'karma',
      value: 100n,
      owner: inviterId,
    }, 1);
    insertBox(karma);

    const newKarma: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: 100n - FIXTURE_BOND_KARMA,
      owner: inviterId,
    };
    // ⛔ **The bond IS the request** — that key is the whole pairing, and the
    // settlement grants it out of the pool (ARCHITECTURE → Invite System).
    const bondBox: CandidateOf<BondBox> = {
      boxType: 'bond',
      value: FIXTURE_BOND_KARMA,
      inviterId,
      inviteePublicKey: invitee,
    };

    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        newKarma,
        bondBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviterPrivKeyObj, Buffer.from(inviterId).toString('hex'));
    return tx;
  }

  const deps = () => ({
    getBox,
    insertBox,
    consumeBox: () => {},
    getKarmaBox: () => null,
    getKarmaValue: (owner: Uint8Array) =>
      getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n),
    getIdentityRecord: () => null,
    runInTransaction: (fn: () => void) => fn(),
  });

  it('predicts ids at the outputs real positions, not from a counter', () => {
    const tx = buildInviteTx();
    const result = createInvite(deps() as never, tx, HEIGHT);

    expect(result.bondBox.txId).toBe(result.txId);
    // karma=0, bond=1 — a hardcoded 0 or a per-box counter would disagree with
    // the position block application uses.
    expect(result.bondBox.index).toBe(1);
  });

  it('predicts exactly what the apply path materializes for the same tx', () => {
    const tx = buildInviteTx();
    const result = createInvite(deps() as never, tx, HEIGHT);

    // The engine's own materialization of the same transaction — the path block
    // application takes. One shared rule, so these cannot drift.
    const applied = validateTx(deps() as never, tx, HEIGHT);
    expect(applied.valid).toBe(true);

    expect(applied.txId).toBe(result.txId);

    // Compare the whole provenance, not just the id. During the migration
    // window `computeBoxId` still strips `txId`/`index`, so an id-only
    // comparison passes for ANY index and would be vacuous here — it only
    // starts biting at phase G, which is too late to learn that the prediction
    // and the apply path disagree.
    for (const [predicted, materialized] of [
      [result.bondBox, applied.computedOutputs![1]!],
    ] as const) {
      expect(predicted.txId).toBe(materialized.txId);
      expect(predicted.index).toBe(materialized.index);
      expect(predicted.id).toBe(materialized.id);
    }
  });

  it('the txId is derived from candidates, so provenance cannot feed into it', () => {
    const tx = buildInviteTx();
    const result = createInvite(deps() as never, tx, HEIGHT);

    // `computeTxId` over the bare transaction equals the id stamped onto the
    // outputs. If a builder attached provenance before computing the txId, the
    // two would still agree — `canonicalBoxBytes` strips it — which is exactly
    // why the ordering has to be pinned rather than trusted to fail loudly.
    expect(computeTxId(tx)).toBe(result.txId);
    const rematerialized = materializeOutput(tx.outputs[1]!, result.txId, 1);
    expect(rematerialized.id).toBe(result.bondBox.id);
  });
});
