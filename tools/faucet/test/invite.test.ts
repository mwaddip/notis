import { describe, it, expect } from 'vitest';
import { computeTxId, PROTOCOL_VERSION } from '@dagsocial/types';
import { buildInviteTx } from '../src/invite.js';
import { B1, B2, baseCfg as cfg, outputsOf, pubHex, recipient as invitee, verifies } from './fixture.js';

describe('buildInviteTx', () => {
  it('spends enough boxes and leaves the remainder as change', () => {
    const { tx, changeValue } = buildInviteTx(cfg, [
      { boxId: B1, value: 200n }, { boxId: B2, value: 100n },
    ], invitee, 512);
    expect(tx.inputs).toEqual([B1, B2]);
    expect(changeValue).toBe(50n);
  });

  it('creates exactly one karma output and one bond output, in that order', () => {
    const { tx } = buildInviteTx(cfg, [{ boxId: B1, value: 400n }], invitee, 512);;
    const outputs = outputsOf(tx);
    expect(outputs).toHaveLength(2);
    expect(outputs[0]!.boxType).toBe('karma');
    expect(outputs[1]!.boxType).toBe('bond');
  });

  // TYPES_INTERFACE → Box value domain: a karma output carries value ≥ 1.
  it('an exact spend builds the bond alone and change is null', () => {
    const { tx, changeValue, change } = buildInviteTx(cfg, [{ boxId: B1, value: 250n }], invitee, 512);
    expect(changeValue).toBe(0n);
    expect(change).toBeNull();
    expect(outputsOf(tx)).toHaveLength(1);
    expect(outputsOf(tx)[0]).toMatchObject({ boxType: 'bond', value: '250' });
  });

  it('a non-exact spend builds change at index 0 and the bond at index 1', () => {
    const { tx, change } = buildInviteTx(cfg, [{ boxId: B1, value: 400n }], invitee, 512);
    expect(change).not.toBeNull();
    expect(outputsOf(tx)).toHaveLength(2);
    expect(outputsOf(tx)[0]).toMatchObject({ boxType: 'karma', value: '150' });
    expect(outputsOf(tx)[1]).toMatchObject({ boxType: 'bond', value: '250' });
  });

  // ⛔ The bond IS the request, and the settlement grants its own value to this
  // key. A bond naming the wrong invitee grants to the wrong identity, and the
  // grant is once-per-identity forever.
  it('names the invitee on the bond and the faucet as inviter', () => {
    const { tx } = buildInviteTx(cfg, [{ boxId: B1, value: 400n }], invitee, 512);;
    const bond = outputsOf(tx)[1]!;
    expect(bond.value).toBe('250');
    expect(bond.inviterId).toBe(pubHex);
    expect(bond.inviteePublicKey).toBe(invitee);
  });

  // The body `jsonToTx` reads: binary fields as hex, values as decimal strings,
  // signatures as hex keyed by public-key hex.
  it('renders the wire body the node\'s JSON edge accepts', () => {
    const { tx } = buildInviteTx(cfg, [{ boxId: B1, value: 400n }], invitee, 512);;
    expect(() => JSON.stringify(tx)).not.toThrow();
    expect(outputsOf(tx)[0]).toEqual({ boxType: 'karma', value: '150', createdAtBlock: 512, owner: pubHex });
    expect(tx.protocolVersion).toBe(PROTOCOL_VERSION);
    expect((tx.signatures as Record<string, string>)[pubHex]).toMatch(/^[0-9a-f]{128}$/);
  });

  // ⛔ The whole correctness of this service: the txId must be the one
  // @dagsocial/types computes over the typed transaction, not one this package
  // derived its own way.
  it('signs the txId @dagsocial/types computes, verifiably', () => {
    const { tx, txId } = buildInviteTx(cfg, [{ boxId: B1, value: 400n }], invitee, 512);
    const expected = computeTxId({
      inputs: [B1],
      outputs: [
        { boxType: 'karma', value: 150n, createdAtBlock: 512, owner: Buffer.from(pubHex, 'hex') },
        {
          boxType: 'bond',
          value: 250n,
          createdAtBlock: 512,
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
    expect(() => buildInviteTx(cfg, [{ boxId: B1, value: 10n }], invitee, 512))
      .toThrow(/insufficient/i);
  });

  it('refuses a malformed invitee key', () => {
    expect(() => buildInviteTx(cfg, [{ boxId: B1, value: 400n }], 'nope', 512))
      .toThrow(/64 lowercase hex/);
  });

  // ⛔ An invite naming the faucet itself would name a key that already holds an
  // identity record; the node refuses it, and so does the builder.
  it('refuses an invitee that is the faucet itself', () => {
    expect(() => buildInviteTx(cfg, [{ boxId: B1, value: 400n }], pubHex, 512))
      .toThrow(/itself/i);
  });
});
