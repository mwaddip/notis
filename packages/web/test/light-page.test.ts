// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readLightRow, readLightRows } from '../src/api/light-page';
import { PageError } from '../src/api/client';
import type { LightJson, WithdrawnJson } from '../src/api/dto';

// Light-page rules: every row of every list is a `LightJson` or a
// `WithdrawnJson` with each field of its type, or the read fails as a
// `PageError` (WEB_INTERFACE → The extension → "The light read" → "A light
// page is held to its shape"). Each row answered is a fresh object of its
// type's fields alone — a key the type does not name is not carried.

const ID_1 = 'ab'.repeat(32);
const ID_2 = 'cd'.repeat(32);
const ID_3 = 'ef'.repeat(32);
const AUTHOR = 'bc'.repeat(32);
const TXID = 'de'.repeat(32);

function light(over: Partial<LightJson> = {}): LightJson {
  return {
    kind: 'light',
    id: ID_1,
    parentRefs: [],
    status: 'confirmed',
    blockHeight: 100,
    blockIndex: 0,
    blockCreatedAt: 1_700_000_000_000,
    likeCount: 2,
    descendantCount: 3,
    authorName: 'alice',
    likedByViewer: null,
    ...over,
  };
}

function withdrawn(over: Partial<WithdrawnJson> = {}): WithdrawnJson {
  return {
    kind: 'withdrawn',
    id: ID_1,
    author: AUTHOR,
    withdrawnAtHeight: 500,
    parentRefs: [],
    descendantCount: 0,
    authorName: null,
    txId: TXID,
    ...over,
  };
}

describe("readLightRows — a well-formed page passes and answers fresh objects of each type's fields alone", () => {
  it('a well-formed list of a light and a withdrawn row passes', () => {
    const rows = readLightRows([light(), withdrawn({ id: ID_2 })]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.kind).toBe('light');
    expect(rows[1]!.kind).toBe('withdrawn');
  });

  it('a key the type does not name is dropped from the answered row', () => {
    const [row] = readLightRows([{ ...light(), surprise: 'ignored' }]);
    expect(row).toBeDefined();
    expect((row as unknown as Record<string, unknown>)['surprise']).toBeUndefined();
    // The row is a fresh object — not the same identity the caller passed in.
    const same = { ...light() };
    const [out] = readLightRows([same]);
    expect(out).not.toBe(same);
  });
});

describe('readLightRows — a malformed field of either arm throws PageError', () => {
  const bad: Array<[string, unknown]> = [
    ['an upper-case id (light)', light({ id: ID_1.toUpperCase() })],
    ['a 63-char id (light)', light({ id: ID_1.slice(0, 63) })],
    ['two parents (light)', light({ parentRefs: [ID_2, ID_3] })],
    ['a parent that is a number (light)', light({ parentRefs: [42] as unknown as string[] })],
    ['a status outside the two (light)', light({ status: 'rejected' as unknown as 'confirmed' })],
    ['a negative count (light)', light({ likeCount: -1 })],
    ['a fractional count (light)', light({ descendantCount: 1.5 })],
    ['a count beyond the safe range (light)', light({ likeCount: Number.MAX_SAFE_INTEGER + 2 })],
    ['a name of 25 bytes (light)', light({ authorName: 'a'.repeat(25) })],
    ['a name with a space (light)', light({ authorName: 'al ice' })],
    ['likedByViewer a string (light)', light({ likedByViewer: 'true' as unknown as boolean })],
    ['an unknown kind', { ...light(), kind: 'weird' }],
    ['a full PostJson', {
      id: ID_1, content: 'hi', contentHash: ID_2, author: AUTHOR, parentRefs: [], protocolVersion: 1,
      type: 'regular', status: 'confirmed', blockHeight: 1, blockIndex: 0, blockCreatedAt: 0,
      likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null, txId: TXID,
    }],
    ['null', null],
    ['a string', 'nope'],
    ['an array', []],
    ['an upper-case id (withdrawn)', withdrawn({ id: ID_1.toUpperCase() })],
    ['two parents (withdrawn)', withdrawn({ parentRefs: [ID_2, ID_3] })],
    ['a negative count (withdrawn)', withdrawn({ descendantCount: -1 })],
    ['a name with a space (withdrawn)', withdrawn({ authorName: 'bo b' })],
  ];
  for (const [name, row] of bad) {
    it(`${name} throws PageError`, () => {
      expect(() => readLightRows([row])).toThrow(PageError);
    });
  }
});

describe('readLightRows — a value that is not an array throws PageError', () => {
  it('undefined throws PageError', () => {
    expect(() => readLightRows(undefined)).toThrow(PageError);
  });
  it('null throws PageError', () => {
    expect(() => readLightRows(null)).toThrow(PageError);
  });
  it('a string throws PageError', () => {
    expect(() => readLightRows('oops')).toThrow(PageError);
  });
  it('an object throws PageError', () => {
    expect(() => readLightRows({ 0: light(), length: 1 })).toThrow(PageError);
  });
});

describe("readLightRow — one row is read field by field and non-objects throw", () => {
  it('a well-formed light row answers a fresh object of its fields', () => {
    const r = readLightRow(light());
    expect(r.kind).toBe('light');
  });
  it('a well-formed withdrawn row answers a fresh object of its fields', () => {
    const r = readLightRow(withdrawn());
    expect(r.kind).toBe('withdrawn');
  });
  it('null throws PageError', () => {
    expect(() => readLightRow(null)).toThrow(PageError);
  });
  it('an array throws PageError', () => {
    expect(() => readLightRow([light()])).toThrow(PageError);
  });
});
