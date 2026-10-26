import type { PostKey, BoxKey } from '../store/index.js';
import {
  BOX_VALUE_BOUND,
  canonicalUsername,
  isHex64,
  isValidUsernameBytes,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  BATCH_READ_MAX,
} from '@dagsocial/types';

export type UsernameLookup = (nameLower: string) => { owner: string } | null;

// NODE_INTERFACE → Blocks ("`:height` as a non-negative safe integer written in
// decimal digits alone"); every route's decimal test reads this one regex.
export const DECIMAL_INT = /^\d+$/;

// NODE_INTERFACE → "Every list a view returns is a page"; the bounds are
// `@dagsocial/types`' (TYPES_INTERFACE → HTTP view bounds).
export function parseLimit(query: Record<string, unknown>): number | { error: string } {
  const raw = query['limit'] as string | undefined;
  if (raw === undefined) return PAGE_LIMIT_DEFAULT;
  if (!DECIMAL_INT.test(raw)) return { error: 'limit must be a positive safe integer' };
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
      if (!DECIMAL_INT.test(parts[0]!) || !DECIMAL_INT.test(parts[1]!)) {
        return { error: 'after must be <blockHeight>:<blockIndex> (non-negative safe integers)' };
      }
      const blockHeight = Number(parts[0]);
      const blockIndex = Number(parts[1]);
      if (!Number.isSafeInteger(blockHeight) || !Number.isSafeInteger(blockIndex)) {
        return { error: 'after must be <blockHeight>:<blockIndex> (non-negative safe integers)' };
      }
      return { blockHeight, blockIndex } satisfies PostKey;
    }
    case 'box': {
      const idx = raw.indexOf(':');
      if (idx < 1) return { error: 'after must be <value>:<boxId>' };
      const valStr = raw.slice(0, idx);
      const idStr = raw.slice(idx + 1);
      if (!DECIMAL_INT.test(valStr)) {
        return { error: 'after must be <value>:<boxId> (value is a decimal integer)' };
      }
      // NODE_INTERFACE → HTTP API → "Hex is lowercase"
      if (!isHex64(idStr)) {
        return { error: 'after must be <value>:<boxId> (boxId is 64 lowercase hex characters)' };
      }
      const value = BigInt(valStr);
      if (value >= BOX_VALUE_BOUND) {
        return { error: 'after value out of domain [0, 2^63)' };
      }
      return { value, id: idStr } satisfies BoxKey;
    }
    case 'id': {
      // NODE_INTERFACE → HTTP API → "Hex is lowercase"
      if (!isHex64(raw)) {
        return { error: 'after must be 64 lowercase hex characters' };
      }
      return raw;
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

// NODE_INTERFACE → Identity parameters;
// NODE_INTERFACE → HTTP API → "Hex is lowercase"
export function resolveIdentityParam(
  value: string,
  getUsername: UsernameLookup,
): { hex: string } | { error: string; status: number } {
  const v: unknown = value;
  if (isHex64(v)) {
    return { hex: v };
  }
  if (value.startsWith('@')) {
    const rest = value.slice(1);
    const bytes = Buffer.from(rest, 'utf8');
    if (!isValidUsernameBytes(bytes)) {
      return { error: 'malformed identity parameter', status: 400 };
    }
    const canonical = canonicalUsername(bytes);
    const row = getUsername(canonical);
    if (!row) return { error: 'unknown handle', status: 404 };
    return { hex: row.owner };
  }
  return { error: 'malformed identity parameter', status: 400 };
}

export function isResolveError(v: { hex: string } | { error: string; status: number }): v is { error: string; status: number } {
  return 'error' in v;
}

export function parseViewer(
  query: Record<string, unknown>,
  getUsername: UsernameLookup,
): Uint8Array | null | { error: string; status?: number } {
  const raw = query['viewer'] as string | undefined;
  if (raw === undefined) return null;
  if (typeof raw !== 'string') return { error: 'viewer must be a string' };
  const resolved = resolveIdentityParam(raw, getUsername);
  if (isResolveError(resolved)) return resolved;
  return new Uint8Array(Buffer.from(resolved.hex, 'hex'));
}

export function isViewerError(v: Uint8Array | null | { error: string; status?: number }): v is { error: string; status?: number } {
  return v !== null && typeof v === 'object' && 'error' in v && !(v instanceof Uint8Array);
}

// One rule for every flag parameter that takes `1`: absent → `false`,
// `'1'` → `true`, anything else → `{ error: '<name> must be 1' }`
// (NODE_INTERFACE → Posts, NODE_INTERFACE → UTXO queries → "`pending=1`
// answers the pending view, as admission spends from it").
export function parseFlag(
  query: Record<string, unknown>,
  name: string,
): boolean | { error: string } {
  const raw = query[name] as string | undefined;
  if (raw === undefined) return false;
  if (raw === '1') return true;
  return { error: `${name} must be 1` };
}

export function isFlagError(v: boolean | { error: string }): v is { error: string } {
  return typeof v === 'object' && 'error' in v;
}

// NODE_INTERFACE → Posts → "The batch read answers posts by id": the body is
// an object whose `ids` is an array of 1 to BATCH_READ_MAX strings, each 64
// lowercase hex characters, none twice (NODE_INTERFACE → HTTP API → "Hex is
// lowercase"). The ids are answered in the order given.
export function parseBatchIds(body: unknown): string[] | { error: string } {
  if (body === null || body === undefined || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'ids required (array)' };
  }
  const ids = (body as { ids?: unknown }).ids;
  if (!Array.isArray(ids)) return { error: 'ids required (array)' };
  if (ids.length < 1 || ids.length > BATCH_READ_MAX) {
    return { error: `ids must hold 1 to ${BATCH_READ_MAX} post ids` };
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    if (!isHex64(raw)) {
      return { error: 'ids must be 64 lowercase hex characters' };
    }
    if (seen.has(raw)) return { error: 'ids must not repeat' };
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

export function isBatchIdsError(v: string[] | { error: string }): v is { error: string } {
  return !Array.isArray(v) && typeof v === 'object' && 'error' in v;
}
