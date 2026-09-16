// Persisted preferences: theme, identity tint, and which node and faucet the
// client reaches. Stored in localStorage and restored painted, not transitioned
// (HOUSE_STYLE → Motion). The theme's first-paint flip is handled inline in
// index.html's <head>; this module re-applies on load and owns every later
// change. Every read and write is guarded — storage is absent in private mode.

export type Theme = 'light' | 'dark';
export type IdTint = 'spine' | 'wash' | 'both' | 'off';

const KEY_THEME = 'notis.theme';
const KEY_IDTINT = 'notis.idtint';
export const KEY_NODE = 'notis.node';
const KEY_FAUCET = 'notis.faucet';
export const KEY_LAYOUT = 'notis.layout';

// The deployment reads — five tags in the shell's head, read once at load
// (WEB_INTERFACE → "The client is served from the node's own origin").

export function readBase(): string {
  const el = document.querySelector('base');
  if (!el) return '/';
  const href = el.getAttribute('href');
  if (!href) return '/';
  const path = new URL(href, location.href).pathname;
  return path.endsWith('/') ? path : path + '/';
}

export function readMeta(name: string): string {
  const el = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!el) return '';
  const v = el.content.trim();
  return v.endsWith('/') ? v.slice(0, -1) : v;
}

/** Parse the `notis-nodes` meta as a JSON array of strings — anything else
 *  answers `[]` (WEB_INTERFACE → "The client is served from the node's own
 *  origin"). The build injects the per-network seed list. */
export function readNodesMeta(): string[] {
  const el = document.querySelector<HTMLMetaElement>('meta[name="notis-nodes"]');
  if (!el) return [];
  const raw = el.content.trim();
  if (raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const v of parsed) if (typeof v === 'string' && v !== '') out.push(v);
    return out;
  } catch {
    return [];
  }
}

/** Read `notis-public` — the origin + base a link to a post should carry, or
 *  empty when the deployment has none (WEB_INTERFACE → "The client is served
 *  from the node's own origin"). Always ends with `/` when non-empty. */
export function readPublicMeta(): string {
  const el = document.querySelector<HTMLMetaElement>('meta[name="notis-public"]');
  if (!el) return '';
  const v = el.content.trim();
  if (v === '') return '';
  return v.endsWith('/') ? v : v + '/';
}

export const WEB_BASE = readBase();
export const BUILD_BASE = readMeta('notis-api');
export const BUILD_FAUCET_BASE = readMeta('notis-faucet');
export const BUILD_NODES = readNodesMeta();
export const BUILD_PUBLIC = readPublicMeta();

// The wash percentages are large because the wash colour sits at the ground's
// own lightness — the mix controls how much hue comes through and nothing else,
// so it cannot move the text ratio.
const ID_MODES: Record<IdTint, { w: string; attr: 'on' | 'nospine' | 'off' }> = {
  spine: { w: '0%', attr: 'on' },
  both: { w: '55%', attr: 'on' },
  wash: { w: '80%', attr: 'nospine' },
  off: { w: '0%', attr: 'off' },
};

export function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode, blocked storage — the preference lives for this session only */
  }
}

export function removeStore(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* private mode, blocked storage */
  }
}

/** Resolve the node the client talks to at boot:
 *  the stored preference ?? the first entry of the build's seed list ?? the
 *  same-origin `notis-api` (WEB_INTERFACE → "The client is served from the
 *  node's own origin"). When none can serve, the App reports it and asks the
 *  reader to set one in `@profile`. */
function initialNode(): string {
  const stored = readStore(KEY_NODE);
  if (stored) return stored;
  if (BUILD_NODES.length > 0) return BUILD_NODES[0]!;
  return BUILD_BASE;
}

export const prefs = {
  theme: (readStore(KEY_THEME) === 'dark' ? 'dark' : 'light') as Theme,
  idtint: ((): IdTint => {
    const v = readStore(KEY_IDTINT);
    return v === 'wash' || v === 'both' || v === 'off' ? v : 'spine';
  })(),
  node: initialNode(),
  faucet: readStore(KEY_FAUCET) ?? BUILD_FAUCET_BASE,
};

const root = document.documentElement;

export function applyTheme(): void {
  if (prefs.theme === 'dark') root.setAttribute('data-t', 'dark');
  else root.removeAttribute('data-t');
}

export function applyIdTint(): void {
  const m = ID_MODES[prefs.idtint];
  root.setAttribute('data-idtint', m.attr);
  root.style.setProperty('--idw', m.w);
  root.style.setProperty('--idwf', m.w);
}

/** Apply both before the first render, while transitions are still suppressed. */
export function applyPrefs(): void {
  applyTheme();
  applyIdTint();
}

export function setTheme(t: Theme): void {
  prefs.theme = t;
  writeStore(KEY_THEME, t);
  applyTheme();
}

export function setIdTint(m: IdTint): void {
  prefs.idtint = m;
  writeStore(KEY_IDTINT, m);
  applyIdTint();
}

export function setNode(origin: string): void {
  const trimmed = origin.trim();
  if (trimmed) {
    prefs.node = trimmed;
    writeStore(KEY_NODE, trimmed);
  } else {
    // Cleared — reset to the first of the seed list or the same-origin default.
    prefs.node = BUILD_NODES[0] ?? BUILD_BASE;
    removeStore(KEY_NODE);
  }
}

export function setFaucet(origin: string): void {
  const trimmed = origin.trim();
  if (trimmed) {
    prefs.faucet = trimmed;
    writeStore(KEY_FAUCET, trimmed);
  } else {
    // Cleared — reset to the build default (empty means no faucet).
    prefs.faucet = BUILD_FAUCET_BASE;
    removeStore(KEY_FAUCET);
  }
}
