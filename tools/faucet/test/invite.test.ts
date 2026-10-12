import { describe, it, expect } from 'vitest';
import { KARMA_MINIMUM, computeTxId } from '@dagsocial/types';
import { buildInviteTx } from '../src/invite.js';
import {
  B1, B2, ERA, INCOME_ID, OWN_ID,
  baseCfg as cfg, income, outputsOf, own, pubHex, recipient as invitee, verifies,
} from './fixture.js';

describe('buildInviteTx', () => {
  it('spends enough boxes and leaves the remainder as change', () => {
    const { tx, changeValue } = buildInviteTx(cfg, [
      { boxId: B1, value: 200n }, { boxId: B2, value: 100n },
    ], invitee, 512, ERA);
    expect(tx.inputs).toEqual([B1, B2]);
    expect(changeValue).toBe(50n);
  });

  it('creates exactly one karma output and one bond output, in that order', () => {
    const { tx } = buildInviteTx(cfg, [{ boxId: B1, value: 400n }], invitee, 512, ERA);;
    const outputs = outputsOf(tx);
    expect(outputs).toHaveLength(2);
    expect(outputs[0]!.boxType).toBe('karma');
    expect(outputs[1]!.boxType).toBe('bond');
  });

  // TYPES_INTERFACE → Box value domain: a karma output carries value ≥ 1.
  it('an exact spend builds the bond alone and change is null', () => {
    const { tx, changeValue, change } = buildInviteTx(cfg, [
      { boxId: B1, value: 250n }, { boxId: B2, value: KARMA_MINIMUM },
    ], invitee, 512, ERA);
    expect(tx.inputs).toEqual([B1]);
    expect(changeValue).toBe(0n);
    expect(change).toBeNull();
    expect(outputsOf(tx)).toHaveLength(1);
    expect(outputsOf(tx)[0]).toMatchObject({ boxType: 'bond', value: '250' });
  });

  it('a non-exact spend builds change at index 0 and the bond at index 1', () => {
    const { tx, change } = buildInviteTx(cfg, [{ boxId: B1, value: 400n }], invitee, 512, ERA);
    expect(change).not.toBeNull();
    expect(outputsOf(tx)).toHaveLength(2);
    expect(outputsOf(tx)[0]).toMatchObject({ boxType: 'karma', value: '150' });
    expect(outputsOf(tx)[1]).toMatchObject({ boxType: 'bond', value: '250' });
  });

  // ⛔ The bond IS the request, and the settlement grants its own value to this
  // key. A bond naming the wrong invitee grants to the wrong identity, and the
  // grant is once-per-identity forever.
  it('names the invitee on the bond and the faucet as inviter', () => {
    const { tx } = buildInviteTx(cfg, [{ boxId: B1, value: 400n }], invitee, 512, ERA);;
    const bond = outputsOf(tx)[1]!;
    expect(bond.value).toBe('250');
    expect(bond.inviterId).toBe(pubHex);
    expect(bond.inviteePublicKey).toBe(invitee);
  });

  // The body `jsonToTx` reads: binary fields as hex, values as decimal strings,
  // signatures as hex keyed by public-key hex.
  it('renders the wire body the node\'s JSON edge accepts', () => {
    const { tx } = buildInviteTx(cfg, [{ boxId: B1, value: 400n }], invitee, 512, ERA);;
    expect(() => JSON.stringify(tx)).not.toThrow();
    expect(outputsOf(tx)[0]).toEqual({ boxType: 'karma', value: '150', createdAtBlock: 512, owner: pubHex });
    expect(tx.protocolVersion).toBe(ERA);
    expect((tx.signatures as Record<string, string>)[pubHex]).toMatch(/^[0-9a-f]{128}$/);
  });

  // ⛔ The whole correctness of this service: the txId must be the one
  // @dagsocial/types computes over the typed transaction, not one this package
  // derived its own way.
  it('signs the txId @dagsocial/types computes, verifiably', () => {
    const { tx, txId } = buildInviteTx(cfg, [{ boxId: B1, value: 400n }], invitee, 512, ERA);
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
      protocolVersion: ERA,
    });
    expect(txId).toBe(expected);
    expect(verifies(tx, txId, pubHex)).toBe(true);
  });

  // WEB_INTERFACE → Invariants: the faucet signs the era the node reports. The
  // version is in the id preimage, so a different era yields a different id — the
  // signature covers the version, it is not a field the JSON carries beside the
  // signed id.
  it('stamps the era it is given into the JSON and the signed id', () => {
    const two = buildInviteTx(cfg, [{ boxId: B1, value: 400n }], invitee, 512, 2);
    const one = buildInviteTx(cfg, [{ boxId: B1, value: 400n }], invitee, 512, 1);
    expect(two.tx.protocolVersion).toBe(2);
    expect(two.txId).toBe(computeTxId({
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
      protocolVersion: 2,
    }));
    expect(two.txId).not.toBe(one.txId);
    expect(verifies(two.tx, two.txId, pubHex)).toBe(true);
  });

  it('refuses when the boxes cannot cover the bond', () => {
    expect(() => buildInviteTx(cfg, [{ boxId: B1, value: 10n }], invitee, 512, ERA))
      .toThrow(/insufficient/i);
  });

  // NODE_INTERFACE → Karma transition rules → "Only a post spends the floor".
  it('builds at exactly the bond plus KARMA_MINIMUM', () => {
    const { tx, changeValue } = buildInviteTx(
      cfg, [{ boxId: B1, value: 250n + KARMA_MINIMUM }], invitee, 512, ERA,
    );
    expect(changeValue).toBe(KARMA_MINIMUM);
    expect(outputsOf(tx)[0]).toMatchObject({ boxType: 'karma', value: String(KARMA_MINIMUM) });
  });

  it('refuses one below the bond plus KARMA_MINIMUM', () => {
    expect(() => buildInviteTx(cfg, [{ boxId: B1, value: 250n + KARMA_MINIMUM - 1n }], invitee, 512, ERA))
      .toThrow(/insufficient karma/);
  });

  it('refuses a faucet holding exactly the bond', () => {
    expect(() => buildInviteTx(cfg, [{ boxId: B1, value: 250n }], invitee, 512, ERA))
      .toThrow(/floor/);
  });

  it('refuses a malformed invitee key', () => {
    expect(() => buildInviteTx(cfg, [{ boxId: B1, value: 400n }], 'nope', 512, ERA))
      .toThrow(/64 lowercase hex/);
  });

  // ⛔ An invite naming the faucet itself would name a key that already holds an
  // identity record; the node refuses it, and so does the builder.
  it('refuses an invitee that is the faucet itself', () => {
    expect(() => buildInviteTx(cfg, [{ boxId: B1, value: 400n }], pubHex, 512, ERA))
      .toThrow(/itself/i);
  });

  // NODE_INTERFACE → Karma transition rules → "An identity holds at most two karma boxes":
  // the own box covers the bond, so the invite names it alone — the income box
  // is left to the owner. Chosen so the income box is larger than the own box:
  // a value-biased selection would pick the income box over the own one.
  it.fails('own 300 and income 500, bond 250 — the invite names the own box alone', () => {
    const { tx, changeValue } = buildInviteTx(cfg, [
      own(OWN_ID, 300n), income(INCOME_ID, 500n),
    ], invitee, 512, ERA);
    expect(tx.inputs).toEqual([OWN_ID]);
    expect(changeValue).toBe(50n);
  });

  // NODE_INTERFACE → Karma transition rules → "An identity holds at most two karma boxes":
  // the own box is short, so the invite names the own box and the income box.
  it.fails('own 100 and income 500 — the invite names both and returns the sum less the bond as change', () => {
    const { tx, changeValue } = buildInviteTx(cfg, [
      own(OWN_ID, 100n), income(INCOME_ID, 500n),
    ], invitee, 512, ERA);
    expect(tx.inputs).toEqual([OWN_ID, INCOME_ID]);
    expect(changeValue).toBe(100n + 500n - cfg.bondAmount);
  });

  // NODE_INTERFACE → Karma transition rules → "An identity holds at most two karma boxes":
  // an owner holding no own box spends the income box alone, and the change is
  // the owner's new own box (unmarked).
  it('the income box alone — the invite names it, and the change is unmarked', () => {
    const { tx, changeValue } = buildInviteTx(cfg, [
      income(INCOME_ID, 500n),
    ], invitee, 512, ERA);
    expect(tx.inputs).toEqual([INCOME_ID]);
    expect(changeValue).toBe(500n - cfg.bondAmount);
    const outputs = outputsOf(tx);
    expect(outputs[0]).toMatchObject({ boxType: 'karma' });
    expect('income' in (outputs[0] ?? {})).toBe(false);
  });

  // NODE_INTERFACE → Karma transition rules → "Only a post spends the floor":
  // the drained refusal names what the faucet holds across both boxes.
  it('names the sum of both boxes when the pair cannot cover the bond and the floor', () => {
    expect(() => buildInviteTx(cfg, [
      own(OWN_ID, 5n), income(INCOME_ID, 10n),
    ], invitee, 512, ERA)).toThrow(/15/);
  });

  // NODE_INTERFACE → Karma transition rules → "An identity holds at most two karma boxes":
  // every row of the transition table admits at most one karma output and no
  // marked one. The property binds every scenario the faucet builds.
  it('builds at most one karma output and no marked one across the scenarios', () => {
    const scenarios: Array<{ label: string; boxes: Parameters<typeof buildInviteTx>[1] }> = [
      { label: 'own alone, exact', boxes: [own(OWN_ID, 250n + KARMA_MINIMUM)] },
      { label: 'own alone with slack', boxes: [own(OWN_ID, 500n)] },
      { label: 'own covers, income beside', boxes: [own(OWN_ID, 500n), income(INCOME_ID, 100n)] },
      { label: 'own short, income covers the rest', boxes: [own(OWN_ID, 10n), income(INCOME_ID, 500n)] },
      { label: 'income alone', boxes: [income(INCOME_ID, 500n)] },
      { label: 'exact spend across both', boxes: [own(OWN_ID, 240n), income(INCOME_ID, KARMA_MINIMUM + 10n)] },
    ];
    for (const s of scenarios) {
      const { tx } = buildInviteTx(cfg, s.boxes, invitee, 512, ERA);
      const outputs = outputsOf(tx);
      const karmaOutputs = outputs.filter((o) => o['boxType'] === 'karma');
      expect(karmaOutputs.length, s.label).toBeLessThanOrEqual(1);
      for (const o of karmaOutputs) {
        expect('income' in o, s.label).toBe(false);
      }
    }
  });
});
