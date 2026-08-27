import type { Page } from '../store/index.js';

// CONSTANTS → HTTP view bounds
export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 100;

export function parsePage(query: Record<string, unknown>): Page | { error: string } {
  const rawLimit = query['limit'] as string | undefined;
  const rawOffset = query['offset'] as string | undefined;

  const parsedLimit = rawLimit !== undefined ? parseInt(rawLimit as string, 10) : PAGE_LIMIT_DEFAULT;
  if (rawLimit !== undefined && (!Number.isSafeInteger(parsedLimit) || parsedLimit < 0)) {
    return { error: 'limit must be a non-negative safe integer' };
  }

  const parsedOffset = rawOffset !== undefined ? parseInt(rawOffset as string, 10) : 0;
  if (rawOffset !== undefined && (!Number.isSafeInteger(parsedOffset) || parsedOffset < 0)) {
    return { error: 'offset must be a non-negative safe integer' };
  }

  return {
    limit: Math.min(parsedLimit, PAGE_LIMIT_MAX),
    offset: parsedOffset,
  };
}

export function parseViewer(query: Record<string, unknown>): Uint8Array | null | { error: string } {
  const raw = query['viewer'] as string | undefined;
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || raw.length !== 64 || !/^[0-9a-f]{64}$/i.test(raw)) {
    return { error: 'viewer must be a 64-character hex string' };
  }
  return new Uint8Array(Buffer.from(raw, 'hex'));
}

export function isPageError(v: Page | { error: string }): v is { error: string } {
  return 'error' in v;
}

export function isViewerError(v: Uint8Array | null | { error: string }): v is { error: string } {
  return v !== null && typeof v === 'object' && 'error' in v && !(v instanceof Uint8Array);
}
