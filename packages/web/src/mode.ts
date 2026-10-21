import { readHex64 } from './hex64';

// The client's mode: workspace (the default) or standalone on one thread.
// Pure — no window, no DOM. Tested directly (WEB_INTERFACE → The standalone thread).

export type Mode =
  | { kind: 'workspace'; base: string }
  | { kind: 'standalone'; id: string; base: string };

export function decideMode(pathname: string, base: string): Mode {
  const prefix = base + 'p/';
  if (!pathname.startsWith(prefix)) return { kind: 'workspace', base };
  const id = readHex64(pathname.slice(prefix.length));
  if (id === null) return { kind: 'workspace', base };
  return { kind: 'standalone', id, base };
}
