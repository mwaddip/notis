import { newWorkspace, newRegion, type Workspace, type Column } from './workspace';

// The workspace as text: `#r1,r2|r5/r10` — comma stacks windows in a region,
// `|` starts a new column, `/` a new region (row) in the current column.
// Readable, diffable, and the persistence format —
// `serialise` and `parse` are inverses.

const HEX64 = /^[0-9a-f]{64}$/i;
const WINDOW_IDS = new Set<string>(['@profile']);
// `@author:<64hex>` and `@posts:<64hex>` — the two membership windows
// (WEB_INTERFACE → The author window). The `:` and `@` cannot collide with a
// 64-hex post id.
const AT_SUBJECT = /^@(author|posts):([0-9a-f]{64})$/i;

/** A token is a real window id — a 64-hex post id, a known @-window, or an
 *  `@author:`/`@posts:` window naming a 64-hex key. */
export function isWindowId(k: string): boolean {
  return WINDOW_IDS.has(k) || HEX64.test(k) || AT_SUBJECT.test(k);
}

/** The window id for an author's window and its posts window. */
export function authorWindowId(key: string): string {
  return '@author:' + key;
}
export function postsWindowId(key: string): string {
  return '@posts:' + key;
}

/** The kind and 64-hex key an `@author:`/`@posts:` window names, or null for any
 *  other token (a thread id, `@profile`). */
export function windowSubject(k: string): { kind: 'author' | 'posts'; key: string } | null {
  const m = AT_SUBJECT.exec(k);
  return m ? { kind: m[1]!.toLowerCase() as 'author' | 'posts', key: m[2]!.toLowerCase() } : null;
}

/** A stored arrangement naming the retired `@settings` maps to `@profile`, so a
 *  saved workspace survives the rename (WEB_INTERFACE → The profile window). */
function mapRetired(k: string): string {
  return k === '@settings' ? '@profile' : k;
}

export function serialise(ws: Workspace): string {
  return ws.columns
    .map((c) => c.regions.map((r) => r.wins.join(',')).join('/'))
    .join('|');
}

/** Rebuild a workspace from its text form. Unknown tokens are dropped — a
 *  restored arrangement may name a post that has since been pruned, and its
 *  window renders the tombstone (WEB_INTERFACE → The three absence states); a
 *  token that is not even a well-formed id is discarded here. Focus is not
 *  encoded, so every region opens focused on its first window. */
export function parse(spec: string): Workspace {
  const ws = newWorkspace();
  const s = spec.replace(/^#/, '').trim();
  if (!s) return ws;
  for (const colSpec of s.split('|')) {
    const col: Column = { regions: [] };
    for (const regionSpec of colSpec.split('/')) {
      const wins = regionSpec.split(',').map((x) => x.trim()).map(mapRetired).filter(isWindowId);
      if (wins.length) col.regions.push(newRegion(wins));
    }
    if (col.regions.length) ws.columns.push(col);
  }
  return ws;
}
