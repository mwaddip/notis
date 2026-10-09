import { describe, it, expect } from 'vitest';
import {
  parseViewer, isViewerError,
  parseLimit, isLimitError,
  parseAfter, isAfterError,
  parseRoots, isRootsError,
  parseLight, isLightError,
  parseBatchIds, isBatchIdsError,
  formatKey,
  PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX,
  BATCH_READ_MAX,
} from '../../src/routes/page.js';

// ---------------------------------------------------------------------------
// parseViewer
// ---------------------------------------------------------------------------

describe('parseViewer', () => {
  it('returns null when viewer is absent', () => {
    expect(parseViewer({}, () => null)).toBeNull();
  });

  it('returns a Uint8Array for a valid 64-char hex viewer', () => {
    const hex = 'ab'.repeat(32);
    const result = parseViewer({ viewer: hex }, () => null);
    expect(isViewerError(result)).toBe(false);
    expect(result).toBeInstanceOf(Uint8Array);
    expect((result as Uint8Array).length).toBe(32);
  });

  it('returns an error for a short viewer', () => {
    const result = parseViewer({ viewer: 'ab'.repeat(16) }, () => null);
    expect(isViewerError(result)).toBe(true);
    if (!isViewerError(result)) return;
    expect(result.error).toContain('malformed identity parameter');
  });

  it('returns an error for a non-hex viewer of correct length', () => {
    const result = parseViewer({ viewer: 'zz'.repeat(32) }, () => null);
    expect(isViewerError(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseLimit
// ---------------------------------------------------------------------------

describe('parseLimit', () => {
  it('defaults to PAGE_LIMIT_DEFAULT', () => {
    expect(parseLimit({})).toBe(PAGE_LIMIT_DEFAULT);
  });

  it('clamps to PAGE_LIMIT_MAX', () => {
    expect(parseLimit({ limit: '999' })).toBe(PAGE_LIMIT_MAX);
  });

  it('passes through a valid limit', () => {
    expect(parseLimit({ limit: '10' })).toBe(10);
  });

  it('rejects limit = 0', () => {
    const r = parseLimit({ limit: '0' });
    expect(isLimitError(r)).toBe(true);
  });

  it('rejects negative limit', () => {
    const r = parseLimit({ limit: '-5' });
    expect(isLimitError(r)).toBe(true);
  });

  it('rejects non-numeric', () => {
    const r = parseLimit({ limit: 'abc' });
    expect(isLimitError(r)).toBe(true);
  });

  it('rejects a number past safe integer', () => {
    const r = parseLimit({ limit: '10000000000000000000' });
    expect(isLimitError(r)).toBe(true);
  });

  it('rejects hex notation', () => {
    expect(isLimitError(parseLimit({ limit: '0x10' }))).toBe(true);
  });

  it('rejects scientific notation', () => {
    expect(isLimitError(parseLimit({ limit: '1e2' }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseRoots
// ---------------------------------------------------------------------------

describe('parseRoots', () => {
  it('returns false when roots is absent', () => {
    expect(parseRoots({})).toBe(false);
  });

  it('returns true for roots=1', () => {
    expect(parseRoots({ roots: '1' })).toBe(true);
  });

  it('returns an error for any other value', () => {
    const r = parseRoots({ roots: '0' });
    expect(isRootsError(r)).toBe(true);
    if (!isRootsError(r)) return;
    expect(r.error).toBe('roots must be 1');
  });
});

// ---------------------------------------------------------------------------
// parseAfter — shape: 'post'
// ---------------------------------------------------------------------------

describe('parseAfter (post)', () => {
  it('returns undefined when absent', () => {
    expect(parseAfter({}, 'post')).toBeUndefined();
  });

  it('parses a valid post key', () => {
    const r = parseAfter({ after: '42:7' }, 'post');
    expect(isAfterError(r)).toBe(false);
    expect(r).toEqual({ blockHeight: 42, blockIndex: 7 });
  });

  it('accepts zero values', () => {
    const r = parseAfter({ after: '0:0' }, 'post');
    expect(isAfterError(r)).toBe(false);
    expect(r).toEqual({ blockHeight: 0, blockIndex: 0 });
  });

  it('rejects empty first part', () => {
    expect(isAfterError(parseAfter({ after: ':5' }, 'post'))).toBe(true);
  });

  it('rejects missing colon', () => {
    expect(isAfterError(parseAfter({ after: '42' }, 'post'))).toBe(true);
  });

  it('rejects negative height', () => {
    expect(isAfterError(parseAfter({ after: '-1:0' }, 'post'))).toBe(true);
  });

  it('rejects non-integer index', () => {
    expect(isAfterError(parseAfter({ after: '42:abc' }, 'post'))).toBe(true);
  });

  it('rejects unsafe integer', () => {
    expect(isAfterError(parseAfter({ after: '10000000000000000000:0' }, 'post'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseAfter — shape: 'box'
// ---------------------------------------------------------------------------

describe('parseAfter (box)', () => {
  const validId = 'ab'.repeat(32);

  it('returns undefined when absent', () => {
    expect(parseAfter({}, 'box')).toBeUndefined();
  });

  it('parses a valid box key', () => {
    const r = parseAfter({ after: `100:${validId}` }, 'box');
    expect(isAfterError(r)).toBe(false);
    const k = r as { value: bigint; id: string };
    expect(k.value).toBe(100n);
    expect(k.id).toBe(validId);
  });

  it('accepts value 0', () => {
    const r = parseAfter({ after: `0:${validId}` }, 'box');
    expect(isAfterError(r)).toBe(false);
    expect((r as { value: bigint }).value).toBe(0n);
  });

  it('lower-cases upper-case hex', () => {
    const upper = 'AB'.repeat(32);
    const r = parseAfter({ after: `50:${upper}` }, 'box');
    expect(isAfterError(r)).toBe(false);
    expect((r as { id: string }).id).toBe(upper.toLowerCase());
  });

  it('rejects value past domain', () => {
    const tooBig = (1n << 63n).toString();
    expect(isAfterError(parseAfter({ after: `${tooBig}:${validId}` }, 'box'))).toBe(true);
  });

  it('rejects negative value', () => {
    expect(isAfterError(parseAfter({ after: `-1:${validId}` }, 'box'))).toBe(true);
  });

  it('rejects short boxId', () => {
    expect(isAfterError(parseAfter({ after: `100:${'ab'.repeat(16)}` }, 'box'))).toBe(true);
  });

  it('rejects missing colon', () => {
    expect(isAfterError(parseAfter({ after: validId }, 'box'))).toBe(true);
  });

  it('rejects non-numeric value', () => {
    expect(isAfterError(parseAfter({ after: `xyz:${validId}` }, 'box'))).toBe(true);
  });

  it('rejects empty value part', () => {
    expect(isAfterError(parseAfter({ after: `:${validId}` }, 'box'))).toBe(true);
  });

  it('rejects hex value', () => {
    expect(isAfterError(parseAfter({ after: `0x10:${validId}` }, 'box'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseAfter — shape: 'id'
// ---------------------------------------------------------------------------

describe('parseAfter (id)', () => {
  it('returns undefined when absent', () => {
    expect(parseAfter({}, 'id')).toBeUndefined();
  });

  it('parses a valid id', () => {
    const hex = 'cd'.repeat(32);
    const r = parseAfter({ after: hex }, 'id');
    expect(isAfterError(r)).toBe(false);
    expect(r).toBe(hex);
  });

  it('lower-cases upper-case hex', () => {
    const upper = 'CD'.repeat(32);
    const r = parseAfter({ after: upper }, 'id');
    expect(isAfterError(r)).toBe(false);
    expect(r).toBe(upper.toLowerCase());
  });

  it('rejects short hex', () => {
    expect(isAfterError(parseAfter({ after: 'ab'.repeat(16) }, 'id'))).toBe(true);
  });

  it('rejects non-hex', () => {
    expect(isAfterError(parseAfter({ after: 'zz'.repeat(32) }, 'id'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatKey round-trips
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// parseLight — NODE_INTERFACE → Posts → "A light row is a post's id and the
// node's word"
// ---------------------------------------------------------------------------

describe('parseLight', () => {
  it('returns false when absent', () => {
    expect(parseLight({})).toBe(false);
  });

  it('returns true for light=1', () => {
    expect(parseLight({ light: '1' })).toBe(true);
  });

  it('rejects light=0', () => {
    const r = parseLight({ light: '0' });
    expect(isLightError(r)).toBe(true);
    if (!isLightError(r)) return;
    expect(r.error).toBe('light must be 1');
  });

  it('rejects empty', () => {
    const r = parseLight({ light: '' });
    expect(isLightError(r)).toBe(true);
  });

  it('rejects light=2', () => {
    const r = parseLight({ light: '2' });
    expect(isLightError(r)).toBe(true);
  });
});

describe('formatKey', () => {
  it('post: formatKey ∘ parseAfter is identity', () => {
    const key = '42:7';
    const parsed = parseAfter({ after: key }, 'post');
    expect(isAfterError(parsed)).toBe(false);
    expect(formatKey('post', parsed as { blockHeight: number; blockIndex: number })).toBe(key);
  });

  it('box: formatKey ∘ parseAfter is identity on a lower-case key', () => {
    const id = 'ab'.repeat(32);
    const key = `100:${id}`;
    const parsed = parseAfter({ after: key }, 'box');
    expect(isAfterError(parsed)).toBe(false);
    expect(formatKey('box', parsed as { value: bigint; id: string })).toBe(key);
  });

  it('id: formatKey ∘ parseAfter is identity on a lower-case key', () => {
    const key = 'ef'.repeat(32);
    const parsed = parseAfter({ after: key }, 'id');
    expect(isAfterError(parsed)).toBe(false);
    expect(formatKey('id', parsed as string)).toBe(key);
  });
});
// ---------------------------------------------------------------------------
// parseBatchIds — NODE_INTERFACE → Posts → "The batch read answers posts by id"
// ---------------------------------------------------------------------------

describe('parseBatchIds', () => {
  const makeId = (prefix: number) => prefix.toString(16).padStart(2, '0').repeat(32);

  it('BATCH_READ_MAX is 100', () => {
    expect(BATCH_READ_MAX).toBe(100);
  });

  // NODE_INTERFACE → Posts → "The batch read answers posts by id": the
  // overflow message reads BATCH_READ_MAX, so this pins the current
  // contract's string byte for byte against the current constant.
  it('the overflow message pins BATCH_READ_MAX=100 to "ids must hold 1 to 100 post ids"', () => {
    expect(BATCH_READ_MAX).toBe(100);
    const ids101 = Array.from({ length: 101 }, (_, i) => (i + 1).toString(16).padStart(64, '0'));
    const bad = parseBatchIds({ ids: ids101 });
    expect(isBatchIdsError(bad)).toBe(true);
    if (!isBatchIdsError(bad)) return;
    expect(bad.error).toBe('ids must hold 1 to 100 post ids');
  });

  it('answers lower-cased ids in the order given', () => {
    const upper = 'AB'.repeat(32);
    const lower = 'cd'.repeat(32);
    const r = parseBatchIds({ ids: [upper, lower] });
    expect(isBatchIdsError(r)).toBe(false);
    expect(r).toEqual([upper.toLowerCase(), lower]);
  });

  it('a body of undefined is 400 ids required (array)', () => {
    const r = parseBatchIds(undefined);
    expect(isBatchIdsError(r)).toBe(true);
    if (!isBatchIdsError(r)) return;
    expect(r.error).toBe('ids required (array)');
  });

  it('a body of null is 400 ids required (array)', () => {
    const r = parseBatchIds(null);
    expect(isBatchIdsError(r)).toBe(true);
    if (!isBatchIdsError(r)) return;
    expect(r.error).toBe('ids required (array)');
  });

  it('a body that is an array is 400 ids required (array)', () => {
    const r = parseBatchIds([makeId(1)]);
    expect(isBatchIdsError(r)).toBe(true);
    if (!isBatchIdsError(r)) return;
    expect(r.error).toBe('ids required (array)');
  });

  it('a body that is a string is 400 ids required (array)', () => {
    const r = parseBatchIds('x');
    expect(isBatchIdsError(r)).toBe(true);
    if (!isBatchIdsError(r)) return;
    expect(r.error).toBe('ids required (array)');
  });

  it('a body that is a number is 400 ids required (array)', () => {
    const r = parseBatchIds(42);
    expect(isBatchIdsError(r)).toBe(true);
    if (!isBatchIdsError(r)) return;
    expect(r.error).toBe('ids required (array)');
  });

  it('ids: "x" is 400 ids required (array)', () => {
    const r = parseBatchIds({ ids: 'x' });
    expect(isBatchIdsError(r)).toBe(true);
    if (!isBatchIdsError(r)) return;
    expect(r.error).toBe('ids required (array)');
  });

  it('ids: [] is 400 ids must hold 1 to 100 post ids', () => {
    const r = parseBatchIds({ ids: [] });
    expect(isBatchIdsError(r)).toBe(true);
    if (!isBatchIdsError(r)) return;
    expect(r.error).toBe('ids must hold 1 to 100 post ids');
  });

  it('100 ids pass; 101 ids are 400 ids must hold 1 to 100', () => {
    const ids100 = Array.from({ length: 100 }, (_, i) => makeId((i % 254) + 1));
    const ok = parseBatchIds({ ids: ids100 });
    expect(isBatchIdsError(ok)).toBe(false);
    const ids101 = Array.from({ length: 101 }, (_, i) => (i + 1).toString(16).padStart(64, '0'));
    const bad = parseBatchIds({ ids: ids101 });
    expect(isBatchIdsError(bad)).toBe(true);
    if (!isBatchIdsError(bad)) return;
    expect(bad.error).toBe('ids must hold 1 to 100 post ids');
  });

  it('a non-string entry is 400 ids must be 64-character hex strings', () => {
    const r = parseBatchIds({ ids: [42] });
    expect(isBatchIdsError(r)).toBe(true);
    if (!isBatchIdsError(r)) return;
    expect(r.error).toBe('ids must be 64-character hex strings');
  });

  it('a 63-char entry is 400 ids must be 64-character hex strings', () => {
    const r = parseBatchIds({ ids: ['0'.repeat(63)] });
    expect(isBatchIdsError(r)).toBe(true);
    if (!isBatchIdsError(r)) return;
    expect(r.error).toBe('ids must be 64-character hex strings');
  });

  it('a 64-char non-hex entry is 400 ids must be 64-character hex strings', () => {
    const r = parseBatchIds({ ids: ['z'.repeat(64)] });
    expect(isBatchIdsError(r)).toBe(true);
    if (!isBatchIdsError(r)) return;
    expect(r.error).toBe('ids must be 64-character hex strings');
  });

  it('a repeated id is 400 ids must not repeat', () => {
    const id = makeId(1);
    const r = parseBatchIds({ ids: [id, id] });
    expect(isBatchIdsError(r)).toBe(true);
    if (!isBatchIdsError(r)) return;
    expect(r.error).toBe('ids must not repeat');
  });

  it('an id repeated in another case is 400 ids must not repeat', () => {
    const lower = 'ab'.repeat(32);
    const r = parseBatchIds({ ids: [lower, lower.toUpperCase()] });
    expect(isBatchIdsError(r)).toBe(true);
    if (!isBatchIdsError(r)) return;
    expect(r.error).toBe('ids must not repeat');
  });
});

