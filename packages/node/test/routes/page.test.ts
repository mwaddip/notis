import { describe, it, expect } from 'vitest';
import { parsePage, parseViewer, isPageError, isViewerError, PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from '../../src/routes/page.js';

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
