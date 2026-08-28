import type { PostKey, BoxKey } from '../store/index.js';

// CONSTANTS → HTTP view bounds
export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 100;

const BOX_VALUE_BOUND = 1n << 63n;

// NODE_INTERFACE → HTTP API → "Every list a view returns is a page"
export function parseLimit(query: Record<string, unknown>): number | { error: string } {
  const raw = query['limit'] as string | undefined;
  if (raw === undefined) return PAGE_LIMIT_DEFAULT;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) {
    return { error: 'limit must be a positive safe integer' };
  }
  return Math.min(n, PAGE_LIMIT_MAX);
}

export function parseAfter(
  query: Record<string, unknown>,
  shape: 'post' | 'box' | 'id',
): PostKey | BoxKey | string | undefined | { error: string } {
  const raw = query['after'] as string | undefined;
  if (raw === undefined) return undefined;

  switch (shape) {
    case 'post': {
      const parts = raw.split(':');
      if (parts.length !== 2) return { error: 'after must be <blockHeight>:<blockIndex>' };
      const blockHeight = Number(parts[0]);
      const blockIndex = Number(parts[1]);
      if (!Number.isSafeInteger(blockHeight) || blockHeight < 0 ||
          !Number.isSafeInteger(blockIndex) || blockIndex < 0) {
        return { error: 'after must be <blockHeight>:<blockIndex> (non-negative safe integers)' };
      }
      return { blockHeight, blockIndex } satisfies PostKey;
    }
    case 'box': {
      const idx = raw.indexOf(':');
      if (idx < 1) return { error: 'after must be <value>:<boxId>' };
      const valStr = raw.slice(0, idx);
      const idStr = raw.slice(idx + 1);
      if (!/^[0-9a-fA-F]{64}$/.test(idStr)) {
        return { error: 'after must be <value>:<boxId> (boxId is 64 hex chars)' };
      }
      let value: bigint;
      try {
        value = BigInt(valStr);
      } catch {
        return { error: 'after must be <value>:<boxId> (value is a decimal integer)' };
      }
      if (value < 0n || value >= BOX_VALUE_BOUND) {
        return { error: 'after value out of domain [0, 2^63)' };
      }
      return { value, id: idStr.toLowerCase() } satisfies BoxKey;
    }
    case 'id': {
      if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
        return { error: 'after must be a 64-character hex string' };
      }
      return raw.toLowerCase();
    }
  }
}

export function formatKey(shape: 'post' | 'box' | 'id', key: PostKey | BoxKey | string): string {
  switch (shape) {
    case 'post': {
      const k = key as PostKey;
      return `${k.blockHeight}:${k.blockIndex}`;
    }
    case 'box': {
      const k = key as BoxKey;
      return `${k.value}:${k.id}`;
    }
    case 'id':
      return key as string;
  }
}

export function isLimitError(v: number | { error: string }): v is { error: string } {
  return typeof v === 'object' && 'error' in v;
}

export function isAfterError(
  v: PostKey | BoxKey | string | undefined | { error: string },
): v is { error: string } {
  return v !== null && typeof v === 'object' && 'error' in v && !('blockHeight' in v) && !('value' in v);
}


export function parseViewer(query: Record<string, unknown>): Uint8Array | null | { error: string } {
  const raw = query['viewer'] as string | undefined;
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || raw.length !== 64 || !/^[0-9a-f]{64}$/i.test(raw)) {
    return { error: 'viewer must be a 64-character hex string' };
  }
  return new Uint8Array(Buffer.from(raw, 'hex'));
}

export function isViewerError(v: Uint8Array | null | { error: string }): v is { error: string } {
  return v !== null && typeof v === 'object' && 'error' in v && !(v instanceof Uint8Array);
}
