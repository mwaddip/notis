// Persisted preferences: theme, identity tint, and which node and faucet the
// client reaches. Stored in localStorage and restored painted, not transitioned
// (HOUSE_STYLE → Motion). The theme's first-paint flip is handled inline in
// index.html's <head>; this module re-applies on load and owns every later
// change. Every read and write is guarded — storage is absent in private mode.

export type Theme = 'light' | 'dark';
export type IdTint = 'spine' | 'wash' | 'both' | 'off';

const KEY_THEME = 'notis.theme';
const KEY_IDTINT = 'notis.idtint';
const KEY_NODE = 'notis.node';
const KEY_FAUCET = 'notis.faucet';
export const KEY_LAYOUT = 'notis.layout';

// The client's default API base, baked at build time — empty for `pnpm dev`
// (the vite proxy makes the node same-origin), a path like /testnet/api for a
// deploy served under one. A stored node value overrides it; the source never
// hardcodes an origin.
export const BUILD_BASE = import.meta.env.VITE_API_BASE ?? '';

// The faucet's default base, baked at build time — empty means no faucet and no
// button (WEB_INTERFACE → The faucet step), a path like /testnet/faucet on a
// deploy. A stored faucet value overrides it; the source hardcodes no origin.
export const BUILD_FAUCET_BASE = import.meta.env.VITE_FAUCET_BASE ?? '';

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

export const prefs = {
  theme: (readStore(KEY_THEME) === 'dark' ? 'dark' : 'light') as Theme,
  idtint: ((): IdTint => {
    const v = readStore(KEY_IDTINT);
    return v === 'wash' || v === 'both' || v === 'off' ? v : 'spine';
  })(),
  node: readStore(KEY_NODE) ?? BUILD_BASE,
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
    // Cleared — reset to the build default rather than forcing same-origin.
    prefs.node = BUILD_BASE;
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
