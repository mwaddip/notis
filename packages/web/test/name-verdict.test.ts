// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { NameResult, NameStatus } from '@dagsocial/nipopow-client';
import { namePair, nameIsClay } from '../src/model/name-verdict';

// The clay handle's verdict (WEB_INTERFACE → The extension → "The verified
// names"): ink while no check has decided a pair and under proven, young and
// unchecked; clay under absent, unproven, no-proof and none.

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
