import { newWorkspace, newColumn, type Workspace } from './workspace';

// The workspace as text: `#r1,r2|r5` — comma stacks windows in a column, `|`
// starts the next column. Readable, diffable, and the persistence format —
// `serialise` and `parse` are inverses (WEB_INTERFACE → The workspace).

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
  return ws.columns.map((c) => c.wins.join(',')).join('|');
}

/** Rebuild a workspace from its text form. Unknown tokens are dropped — a
 *  restored arrangement may name a post that has since been withdrawn, and its
 *  window renders the withdrawn marker (WEB_INTERFACE → The withdrawn state); a
 *  token that is not even a well-formed id is discarded here. Focus is not
 *  encoded, so every column opens focused on its first window. */
export function parse(spec: string): Workspace {
  const ws = newWorkspace();
  const s = spec.replace(/^#/, '').trim();
  if (!s) return ws;
  for (const colSpec of s.split('|')) {
    // A stored `/` reads as a `,`, so the stacks it separated join in order —
    // the courtesy the parser extends to the retired @settings
    // (WEB_INTERFACE → The workspace).
    const wins = colSpec.replace(/\//g, ',').split(',').map((x) => x.trim()).map(mapRetired).filter(isWindowId);
    if (wins.length) ws.columns.push(newColumn(wins));
  }
  return ws;
}
