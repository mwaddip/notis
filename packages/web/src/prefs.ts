// Persisted preferences: theme, identity tint, and which node the client reads.
// Stored in localStorage and restored painted, not transitioned (spec → §7;
// HOUSE_STYLE → Motion). The theme's first-paint flip is handled inline in
// index.html's <head>; this module re-applies on load and owns every later
// change. Every read and write is guarded — storage is absent in private mode.

export type Theme = 'light' | 'dark';
export type IdTint = 'spine' | 'wash' | 'both' | 'off';

const KEY_THEME = 'notis.theme';
const KEY_IDTINT = 'notis.idtint';
const KEY_NODE = 'notis.node';
export const KEY_LAYOUT = 'notis.layout';

// The wash percentages are large because the wash colour sits at the ground's
// own lightness — the mix controls how much hue comes through and nothing else,
// so it cannot move the text ratio (thread-panes → §3.2).
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

export const prefs = {
  theme: (readStore(KEY_THEME) === 'dark' ? 'dark' : 'light') as Theme,
  idtint: ((): IdTint => {
    const v = readStore(KEY_IDTINT);
    return v === 'wash' || v === 'both' || v === 'off' ? v : 'spine';
  })(),
  node: readStore(KEY_NODE) ?? '',
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
  prefs.node = origin.trim();
  writeStore(KEY_NODE, prefs.node);
}
