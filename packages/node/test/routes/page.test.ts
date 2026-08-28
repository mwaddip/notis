import { describe, it, expect } from 'vitest';
import {
  parsePage, parseViewer, isPageError, isViewerError,
  parseLimit, isLimitError,
  parseAfter, isAfterError,
  formatKey,
  PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX,
} from '../../src/routes/page.js';

// ---------------------------------------------------------------------------
// parsePage (kept until phase 3)
// ---------------------------------------------------------------------------

describe('parsePage', () => {
  it('returns defaults when no query params are given', () => {
    const result = parsePage({});
    expect(isPageError(result)).toBe(false);
    if (isPageError(result)) return;
    expect(result.limit).toBe(PAGE_LIMIT_DEFAULT);
    expect(result.offset).toBe(0);
  });

  it('clamps limit to PAGE_LIMIT_MAX', () => {
    const result = parsePage({ limit: '999' });
    expect(isPageError(result)).toBe(false);
    if (isPageError(result)) return;
    expect(result.limit).toBe(PAGE_LIMIT_MAX);
  });

  it('passes through a limit within range', () => {
    const result = parsePage({ limit: '10', offset: '5' });
    expect(isPageError(result)).toBe(false);
    if (isPageError(result)) return;
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(5);
  });

  it('returns an error for a non-numeric limit', () => {
    const result = parsePage({ limit: 'abc' });
    expect(isPageError(result)).toBe(true);
    if (!isPageError(result)) return;
    expect(result.error).toContain('limit must be a non-negative safe integer');
  });

  it('returns an error for a negative offset', () => {
    const result = parsePage({ offset: '-1' });
    expect(isPageError(result)).toBe(true);
    if (!isPageError(result)) return;
    expect(result.error).toContain('offset must be a non-negative safe integer');
  });
});

// ---------------------------------------------------------------------------
// parseViewer (unchanged)
// ---------------------------------------------------------------------------

describe('parseViewer', () => {
  it('returns null when viewer is absent', () => {
    expect(parseViewer({})).toBeNull();
  });

  it('returns a Uint8Array for a valid 64-char hex viewer', () => {
    const hex = 'ab'.repeat(32);
    const result = parseViewer({ viewer: hex });
    expect(isViewerError(result)).toBe(false);
    expect(result).toBeInstanceOf(Uint8Array);
    expect((result as Uint8Array).length).toBe(32);
  });

  it('returns an error for a short viewer', () => {
    const result = parseViewer({ viewer: 'ab'.repeat(16) });
    expect(isViewerError(result)).toBe(true);
    if (!isViewerError(result)) return;
    expect(result.error).toContain('viewer must be a 64-character hex string');
  });

  it('returns an error for a non-hex viewer of correct length', () => {
    const result = parseViewer({ viewer: 'zz'.repeat(32) });
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
