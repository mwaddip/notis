// The client's mode: workspace (the default) or standalone on one thread.
// Pure — no window, no DOM. Tested directly (WEB_INTERFACE → The standalone thread).

export type Mode =
  | { kind: 'workspace'; base: string }
  | { kind: 'standalone'; id: string; base: string };

const HEX64 = /^[0-9a-f]{64}$/i;

export function decideMode(pathname: string, base: string): Mode {
  const prefix = base + 'p/';
  if (!pathname.startsWith(prefix)) return { kind: 'workspace', base };
  const tail = pathname.slice(prefix.length);
  if (!HEX64.test(tail)) return { kind: 'workspace', base };
  return { kind: 'standalone', id: tail.toLowerCase(), base };
}
