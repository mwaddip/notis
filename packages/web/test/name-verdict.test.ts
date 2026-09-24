// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { NameResult, NameStatus } from '@dagsocial/nipopow-client';
import { namePair, nameIsClay, recipientVerdict } from '../src/model/name-verdict';

// The clay handle's verdict (WEB_INTERFACE → The extension → "The verified
// names"): ink while no check has decided a pair and under proven, young and
// unchecked; clay under absent, unproven, no-proof and none. The send's answer
// to a typed handle (→ The wallet window → "The `send` row"): the proven owner
// and the name as committed under proven and young, the row's refusal under
// every other status.

function result(status: NameStatus): NameResult {
  return { status, owner: null, name: null, boxId: null, heightAfter: null, verdict: status };
}

describe('nameIsClay', () => {
  it('no check decided — ink', () => {
    expect(nameIsClay(undefined)).toBe(false);
  });

  it.each<NameStatus>(['proven', 'young', 'unchecked'])('%s — ink', (status) => {
    expect(nameIsClay(result(status))).toBe(false);
  });

  it.each<NameStatus>(['absent', 'unproven', 'no-proof', 'none'])('%s — clay', (status) => {
    expect(nameIsClay(result(status))).toBe(true);
  });

  it('a status outside the table reads as no check — ink, never a throw', () => {
    expect(nameIsClay(result('toString' as NameStatus))).toBe(false);
    expect(nameIsClay(result('' as NameStatus))).toBe(false);
  });
});

describe('namePair', () => {
  const KEY = 'ab'.repeat(32);

  it("a key's case never splits a pair — the key is lowercased", () => {
    expect(namePair(KEY.toUpperCase(), 'Bob')).toBe(namePair(KEY, 'Bob'));
  });

  it("a name's case always does — Bob and bob are two pairs", () => {
    expect(namePair(KEY, 'Bob')).not.toBe(namePair(KEY, 'bob'));
    expect(namePair(KEY.toUpperCase(), 'BOB')).not.toBe(namePair(KEY, 'bob'));
  });

  it('two keys holding one name are two pairs', () => {
    expect(namePair(KEY, 'Bob')).not.toBe(namePair('cd'.repeat(32), 'Bob'));
  });

  it('the name is kept as the row shows it, after the key and a separator neither holds', () => {
    const pair = namePair(KEY.toUpperCase(), 'Bob_01');
    expect(pair.startsWith(KEY)).toBe(true);
    expect(pair.endsWith('Bob_01')).toBe(true);
    const sep = pair.slice(KEY.length, pair.length - 'Bob_01'.length);
    expect(sep.length).toBeGreaterThan(0);
    expect(sep).not.toMatch(/[0-9a-fA-F]/);
    expect(sep).not.toMatch(/[A-Za-z0-9_]/);
  });
});

describe('recipientVerdict', () => {
  const REC = 'cd'.repeat(32);
  const held = (status: NameStatus, owner: unknown, name: unknown): NameResult =>
    ({ status, owner, name, boxId: null, heightAfter: null, verdict: status } as NameResult);

  it.each<NameStatus>(['proven', 'young'])('%s — the proven owner and the name as committed, never the handle as typed', (status) => {
    expect(recipientVerdict(held(status, REC, 'Bob'), '@bob')).toEqual({ key: REC, name: 'Bob' });
  });

  it('none — *no one holds that name.*', () => {
    expect(recipientVerdict(result('none'), '@bob')).toEqual({ refusal: 'no one holds that name.' });
  });

  it('unchecked — the check after the press\'s one run — *@bob is too new to check yet.*', () => {
    expect(recipientVerdict(result('unchecked'), '@bob')).toEqual({ refusal: '@bob is too new to check yet.' });
  });

  it.each<NameStatus>(['absent', 'unproven'])('%s — *this node\'s answer for @bob did not verify.*', (status) => {
    expect(recipientVerdict(result(status), '@bob')).toEqual({ refusal: "this node's answer for @bob did not verify." });
  });

  it('no-proof — *the node served no proof for @bob.*', () => {
    expect(recipientVerdict(result('no-proof'), '@bob')).toEqual({ refusal: 'the node served no proof for @bob.' });
  });

  it('the refusal carries the handle it is given, as typed', () => {
    expect(recipientVerdict(result('no-proof'), '@BoB_1')).toEqual({ refusal: 'the node served no proof for @BoB_1.' });
  });

  it.each<[string, unknown, unknown]>([
    ['no owner', null, 'Bob'],
    ['no name', REC, null],
    ['an owner that is not 64 hex', 'cd'.repeat(31), 'Bob'],
    ['an owner in capitals', REC.toUpperCase(), 'Bob'],
    ['an owner that is not a string', 7, 'Bob'],
    ['a name that is not a string', REC, 7],
  ])('a proven result with %s sends nowhere — it did not verify', (_what, owner, name) => {
    for (const status of ['proven', 'young'] as NameStatus[]) {
      expect(recipientVerdict(held(status, owner, name), '@bob')).toEqual({ refusal: "this node's answer for @bob did not verify." });
    }
  });

  it('a status outside the table sends nowhere — it did not verify, never a throw', () => {
    for (const status of ['toString', '', 'PROVEN']) {
      expect(recipientVerdict(held(status as NameStatus, REC, 'Bob'), '@bob')).toEqual({ refusal: "this node's answer for @bob did not verify." });
    }
  });
});
