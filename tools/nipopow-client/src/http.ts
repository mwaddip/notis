// The light client's shaped-value helper and the proof blob's base64 decode.
// `capped` — the one rule a node's text passes through on its way into a
// verdict — comes from @dagsocial/node-reads, where readCappedJson applies
// the same rule to an unparseable body.

import { capped } from '@dagsocial/node-reads';

/**
 * A node's value as a verdict names it: a string quoted and capped, anything
 * else by its kind. Never converted — a parsed object can carry a `toString`
 * that is not a function, and converting it throws.
 */
export function shown(v: unknown): string {
  if (typeof v === 'string') return `'${capped(v)}'`;
  if (v === undefined) return 'missing';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v === 'object' ? 'an object' : `a ${typeof v}`;
}

/**
 * NODE_INTERFACE → AVL+ State Root — the proof blob is standard base64,
 * decoded with `atob`, a global in both browsers and Node 22. It throws on a
 * character outside the alphabet or on a wrong length — caught here so a
 * malformed blob from a lying node is a refused proof, `null`, never an
 * exception out of the library.
 */
export function base64ToBytes(b64: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
