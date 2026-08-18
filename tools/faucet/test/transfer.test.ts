import { describe, it, expect } from 'vitest';
import { computeTxId, PROTOCOL_VERSION } from '@dagsocial/types';
import { buildCreditTransferTx } from '../src/transfer.js';
import { C1, baseCfg as cfg, outputsOf, pubHex, recipient, verifies } from './fixture.js';

describe('buildCreditTransferTx', () => {
  it('pays the recipient and returns the change to the faucet', () => {
    const { tx } = buildCreditTransferTx(cfg, [{ boxId: C1, value: 500n }], recipient);
    const outputs = outputsOf(tx);
    expect(outputs).toHaveLength(2);
    expect(outputs.every((o) => o.boxType === 'credit')).toBe(true);
    const byOwner = Object.fromEntries(outputs.map((o) => [o.owner, o.value]));
    expect(byOwner[recipient]).toBe('1');            // cfg.creditAmount
    expect(byOwner[pubHex]).toBe('499');
  });

  // Credits are tradeable, so this is an ordinary transfer and the only rule is
  // conservation. A credit transition needs no output back to the input's
  // owner, so an exact spend emits one box rather than a zero-value second.
  it('omits the change output when the spend is exact', () => {
    const { tx, changeValue } = buildCreditTransferTx(cfg, [{ boxId: C1, value: 1n }], recipient);
    expect(changeValue).toBe(0n);
    expect(outputsOf(tx)).toHaveLength(1);
  });

  it('signs the txId @dagsocial/types computes, verifiably', () => {
    const { tx, txId } = buildCreditTransferTx(cfg, [{ boxId: C1, value: 500n }], recipient);
    const expected = computeTxId({
      inputs: [C1],
      outputs: [
        { boxType: 'credit', value: 1n, owner: Buffer.from(recipient, 'hex') },
        { boxType: 'credit', value: 499n, owner: Buffer.from(pubHex, 'hex') },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(txId).toBe(expected);
    expect(verifies(tx, txId, pubHex)).toBe(true);
  });

  it('renders the wire body the node\'s JSON edge accepts', () => {
    const { tx } = buildCreditTransferTx(cfg, [{ boxId: C1, value: 500n }], recipient);
    expect(() => JSON.stringify(tx)).not.toThrow();
    expect(outputsOf(tx)[0]).toEqual({ boxType: 'credit', value: '1', owner: recipient });
    expect((tx.signatures as Record<string, string>)[pubHex]).toMatch(/^[0-9a-f]{128}$/);
  });

  it('refuses when the boxes cannot cover the amount', () => {
    expect(() => buildCreditTransferTx(
      { ...cfg, creditAmount: 900n }, [{ boxId: C1, value: 5n }], recipient,
    )).toThrow(/insufficient/i);
  });

  it('refuses a malformed recipient key', () => {
    expect(() => buildCreditTransferTx(cfg, [{ boxId: C1, value: 500n }], 'nope'))
      .toThrow(/64 lowercase hex/);
  });

  it('refuses a recipient that is the faucet itself', () => {
    expect(() => buildCreditTransferTx(cfg, [{ boxId: C1, value: 500n }], pubHex))
      .toThrow(/itself/i);
  });
});
