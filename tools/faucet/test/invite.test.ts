import { describe, it, expect } from 'vitest';
import { computeTxId, PROTOCOL_VERSION } from '@dagsocial/types';
import { buildInviteTx } from '../src/invite.js';
import { B1, B2, baseCfg as cfg, outputsOf, pubHex, recipient as invitee, verifies } from './fixture.js';

describe('buildInviteTx', () => {
  it('spends enough boxes and leaves the remainder as change', () => {
    const { tx, changeValue } = buildInviteTx(cfg, [
      { boxId: B1, value: 200n }, { boxId: B2, value: 100n },
    ], invitee);
    expect(tx.inputs).toEqual([B1, B2]);
    expect(changeValue).toBe(50n);
  });

  it('creates exactly one karma output and one bond output, in that order', () => {
    const { tx } = buildInviteTx(cfg, [{ boxId: B1, value: 400n }], invitee);
    const outputs = outputsOf(tx);
    expect(outputs).toHaveLength(2);
    expect(outputs[0]!.boxType).toBe('karma');
    expect(outputs[1]!.boxType).toBe('bond');
  });

  // ⛔ The engine refuses a karma transition that produces no karma output, so
  // the change box is emitted whatever it holds — and it is index 0, which is
  // what the pending chain derives its next input from.
  it('emits the change output even when the spend is exact', () => {
    const { tx, changeValue } = buildInviteTx(cfg, [{ boxId: B1, value: 250n }], invitee);
    expect(changeValue).toBe(0n);
    expect(outputsOf(tx)).toHaveLength(2);
    expect(outputsOf(tx)[0]).toMatchObject({ boxType: 'karma', value: '0' });
  });

  // ⛔ The bond IS the request, and the settlement grants its own value to this
  // key. A bond naming the wrong invitee grants to the wrong identity, and the
  // grant is once-per-identity forever.
  it('names the invitee on the bond and the faucet as inviter', () => {
    const { tx } = buildInviteTx(cfg, [{ boxId: B1, value: 400n }], invitee);
    const bond = outputsOf(tx)[1]!;
    expect(bond.value).toBe('250');
    expect(bond.inviterId).toBe(pubHex);
    expect(bond.inviteePublicKey).toBe(invitee);
  });

  // The body `jsonToTx` reads: binary fields as hex, values as decimal strings,
  // signatures as hex keyed by public-key hex.
  it('renders the wire body the node\'s JSON edge accepts', () => {
    const { tx } = buildInviteTx(cfg, [{ boxId: B1, value: 400n }], invitee);
    expect(() => JSON.stringify(tx)).not.toThrow();
    expect(outputsOf(tx)[0]).toEqual({ boxType: 'karma', value: '150', owner: pubHex });
    expect(tx.protocolVersion).toBe(PROTOCOL_VERSION);
    expect((tx.signatures as Record<string, string>)[pubHex]).toMatch(/^[0-9a-f]{128}$/);
  });

  // ⛔ The whole correctness of this service: the txId must be the one
  // @dagsocial/types computes over the typed transaction, not one this package
  // derived its own way.
  it('signs the txId @dagsocial/types computes, verifiably', () => {
    const { tx, txId } = buildInviteTx(cfg, [{ boxId: B1, value: 400n }], invitee);
    const expected = computeTxId({
      inputs: [B1],
      outputs: [
        { boxType: 'karma', value: 150n, owner: Buffer.from(pubHex, 'hex') },
        {
          boxType: 'bond',
          value: 250n,
          inviterId: Buffer.from(pubHex, 'hex'),
          inviteePublicKey: Buffer.from(invitee, 'hex'),
        },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(txId).toBe(expected);
    expect(verifies(tx, txId, pubHex)).toBe(true);
  });

  it('refuses when the boxes cannot cover the bond', () => {
    expect(() => buildInviteTx(cfg, [{ boxId: B1, value: 10n }], invitee))
      .toThrow(/insufficient/i);
  });

  it('refuses a malformed invitee key', () => {
    expect(() => buildInviteTx(cfg, [{ boxId: B1, value: 400n }], 'nope'))
      .toThrow(/64 lowercase hex/);
  });

  // ⛔ An invite naming the faucet itself would name a key that already holds an
  // identity record; the node refuses it, and so does the builder.
  it('refuses an invitee that is the faucet itself', () => {
    expect(() => buildInviteTx(cfg, [{ boxId: B1, value: 400n }], pubHex))
      .toThrow(/itself/i);
  });
});
