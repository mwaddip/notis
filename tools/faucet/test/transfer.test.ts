import { describe, it, expect } from 'vitest';
import { computeTxId } from '@dagsocial/types';
import { buildCreditTransferTx } from '../src/transfer.js';
import { C1, ERA, baseCfg as cfg, outputsOf, pubHex, recipient, verifies } from './fixture.js';

describe('buildCreditTransferTx', () => {
  it('pays the recipient and returns the change to the faucet', () => {
    const { tx } = buildCreditTransferTx(cfg, [{ boxId: C1, value: 500n }], recipient, 512, ERA);
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
    const { tx, changeValue } = buildCreditTransferTx(cfg, [{ boxId: C1, value: 1n }], recipient, 512, ERA);
    expect(changeValue).toBe(0n);
    expect(outputsOf(tx)).toHaveLength(1);
  });

  it('signs the txId @dagsocial/types computes, verifiably', () => {
    const { tx, txId } = buildCreditTransferTx(cfg, [{ boxId: C1, value: 500n }], recipient, 512, ERA);
    const expected = computeTxId({
      inputs: [C1],
      outputs: [
        { boxType: 'credit', value: 1n, createdAtBlock: 512, owner: Buffer.from(recipient, 'hex') },
        { boxType: 'credit', value: 499n, createdAtBlock: 512, owner: Buffer.from(pubHex, 'hex') },
      ],
      signatures: {},
      protocolVersion: ERA,
    });
    expect(txId).toBe(expected);
    expect(verifies(tx, txId, pubHex)).toBe(true);
  });

  // WEB_INTERFACE → Invariants: the faucet signs the era the node reports. The
  // version is in the id preimage, so a different era yields a different id — the
  // signature covers the version, it is not a field carried beside the signed id.
  it('stamps the era it is given into the JSON and the signed id', () => {
    const two = buildCreditTransferTx(cfg, [{ boxId: C1, value: 500n }], recipient, 512, 2);
    const one = buildCreditTransferTx(cfg, [{ boxId: C1, value: 500n }], recipient, 512, 1);
    expect(two.tx.protocolVersion).toBe(2);
    expect(two.txId).toBe(computeTxId({
      inputs: [C1],
      outputs: [
        { boxType: 'credit', value: 1n, createdAtBlock: 512, owner: Buffer.from(recipient, 'hex') },
        { boxType: 'credit', value: 499n, createdAtBlock: 512, owner: Buffer.from(pubHex, 'hex') },
      ],
      signatures: {},
      protocolVersion: 2,
    }));
    expect(two.txId).not.toBe(one.txId);
    expect(verifies(two.tx, two.txId, pubHex)).toBe(true);
  });

  it('renders the wire body the node\'s JSON edge accepts', () => {
    const { tx } = buildCreditTransferTx(cfg, [{ boxId: C1, value: 500n }], recipient, 512, ERA);
    expect(() => JSON.stringify(tx)).not.toThrow();
    expect(outputsOf(tx)[0]).toEqual({ boxType: 'credit', value: '1', createdAtBlock: 512, owner: recipient });
    expect((tx.signatures as Record<string, string>)[pubHex]).toMatch(/^[0-9a-f]{128}$/);
  });

  it('refuses when the boxes cannot cover the amount', () => {
    expect(() => buildCreditTransferTx(
      { ...cfg, creditAmount: 900n }, [{ boxId: C1, value: 5n }], recipient, 512, ERA,
    )).toThrow(/insufficient/i);
  });

  it('refuses a malformed recipient key', () => {
    expect(() => buildCreditTransferTx(cfg, [{ boxId: C1, value: 500n }], 'nope', 512, ERA))
      .toThrow(/64 lowercase hex/);
  });

  it('refuses a recipient that is the faucet itself', () => {
    expect(() => buildCreditTransferTx(cfg, [{ boxId: C1, value: 500n }], pubHex, 512, ERA))
      .toThrow(/itself/i);
  });
});
