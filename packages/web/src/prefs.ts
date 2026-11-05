// Persisted preferences: theme, identity tint, and which node the client
// reaches. Stored in localStorage and restored painted, not transitioned
// (HOUSE_STYLE → Motion). The theme's first-paint flip is handled inline in
// index.html's <head>; this module re-applies on load and owns every later
// change. Every read and write is guarded — storage is absent in private mode.
// The faucet's base is the shell's `notis-faucet` value, never a preference
// (WEB_INTERFACE → "A faucet is a fact of the deployment, not of the network").

import { NETWORK_PROFILES, type NetworkType } from '@dagsocial/types';
import type { MeshAnchor } from './mesh';
import { trimBase } from './base';

export type Theme = 'light' | 'dark';
export type IdTint = 'spine' | 'wash' | 'both' | 'off';

const KEY_THEME = 'notis.theme';
const KEY_IDTINT = 'notis.idtint';
export const KEY_NODE = 'notis.node';
export const KEY_LAYOUT = 'notis.layout';

// The deployment reads — six tags in the shell's head, read once at load
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
  return trimBase(el.content.trim());
}

/** The per-network seed list the shell carries, parsed from the `notis-nodes`
 *  meta. An entry is an API base string or a node
 *  `{ notisId, addrs, api }` — a key, the addresses the mesh dials it at (none
 *  is allowed), each ending in its `/p2p/` id and none with a `/dns4/`, `/dns6/` or
 *  `/dnsaddr/` component, and the base its API answers at
 *  (WEB_INTERFACE → The client is served from the node's own origin → "The
 *  three later tags"). Anything that is not a JSON array of such entries
 *  reads as `[]`, and any malformed entry refuses the whole list.
 *  The bases list and the anchors list are read from one parse. */
interface ParsedNodes { bases: string[]; anchors: MeshAnchor[] }

function parseNodesMetaImpl(): ParsedNodes | null {
  const el = document.querySelector<HTMLMetaElement>('meta[name="notis-nodes"]');
  if (!el) return { bases: [], anchors: [] };
  const raw = el.content.trim();
  if (raw === '') return { bases: [], anchors: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const bases: string[] = [];
  const anchors: MeshAnchor[] = [];
  for (const v of parsed) {
    if (typeof v === 'string') {
      if (v === '') return null;
      bases.push(v);
      continue;
    }
    const a = parseAnchorEntry(v);
    if (a === null) return null;
    bases.push(a.api!);
    anchors.push(a);
  }
  return { bases, anchors };
}

/** One node entry. `addrs` is an array and may be empty — such a node is
 *  reached at its `api` base alone (WEB_INTERFACE → The client is served from
 *  the node's own origin → "The three later tags"; MESH_INTERFACE → The
 *  client's node list → "An entry may carry an API base"). */
function parseAnchorEntry(v: unknown): MeshAnchor | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const id = o['notisId'];
  if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) return null;
  const addrsRaw = o['addrs'];
  if (!Array.isArray(addrsRaw)) return null;
  const addrs: string[] = [];
  for (const a of addrsRaw) {
    if (typeof a !== 'string') return null;
    if (a.includes('/dns4/') || a.includes('/dns6/') || a.includes('/dnsaddr/')) return null;
    if (!/\/p2p\/[^/]+$/.test(a)) return null;
    addrs.push(a);
  }
  const apiRaw = o['api'];
  if (typeof apiRaw !== 'string') return null;
  if (!apiRaw.startsWith('http://') && !apiRaw.startsWith('https://')) return null;
  const api = apiRaw.endsWith('/') ? apiRaw.slice(0, -1) : apiRaw;
  return { notisId: id, addrs, api };
}

function parseNodesMeta(): ParsedNodes {
  return parseNodesMetaImpl() ?? { bases: [], anchors: [] };
}

/** The effective bases of the seed list — a string entry's own, a node
 *  entry's `api` — anything else, `[]` (WEB_INTERFACE → The client is served
 *  from the node's own origin → "The three later tags"). */
export function readNodesMeta(): string[] {
  return parseNodesMeta().bases;
}

/** The node entries of the seed list — the anchors the extension's mesh
 *  client starts from (WEB_INTERFACE → The extension → "The seed list, the
 *  faucet's base and the network's name"; MESH_INTERFACE → Discovery →
 *  "Anchors"). Same validation rules as `readNodesMeta`. */
export function readAnchorsMeta(): MeshAnchor[] {
  return parseNodesMeta().anchors;
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

/** Read `notis-network` — the network the build is for
 *  (WEB_INTERFACE → "The three later tags"). Empty, or a name no profile
 *  answers to, is a build with no verifier and reads as `null`; the accepted
 *  set is `Object.keys(NETWORK_PROFILES)`, never a list typed here. */
export function readNetworkMeta(): NetworkType | null {
  const el = document.querySelector<HTMLMetaElement>('meta[name="notis-network"]');
  if (!el) return null;
  const v = el.content.trim();
  if (v === '') return null;
  return Object.hasOwn(NETWORK_PROFILES, v) ? (v as NetworkType) : null;
}

export const WEB_BASE = readBase();
export const BUILD_BASE = readMeta('notis-api');
export const BUILD_FAUCET_BASE = readMeta('notis-faucet');
export const BUILD_PUBLIC = readPublicMeta();
export const BUILD_NETWORK = readNetworkMeta();

// WEB_INTERFACE → The client is served from the node's own origin → "The three
// later tags" — the effective base of each seed-list entry (a string's own, a
// node's `api`) and the node entries as `MeshAnchor`, read from one parse of
// the `notis-nodes` meta.
const _parsedNodes = parseNodesMeta();
export const BUILD_NODE_BASES: string[] = _parsedNodes.bases;
export const BUILD_ANCHORS: MeshAnchor[] = _parsedNodes.anchors;

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
 *  reader to set one in the settings window. */
function initialNode(): string {
  const stored = readStore(KEY_NODE);
  if (stored) return stored;
  if (BUILD_NODE_BASES.length > 0) return BUILD_NODE_BASES[0]!;
  return BUILD_BASE;
}

export const prefs = {
  theme: (readStore(KEY_THEME) === 'dark' ? 'dark' : 'light') as Theme,
  idtint: ((): IdTint => {
    const v = readStore(KEY_IDTINT);
    return v === 'wash' || v === 'both' || v === 'off' ? v : 'spine';
  })(),
  node: initialNode(),
  faucet: BUILD_FAUCET_BASE,
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
    prefs.node = BUILD_NODE_BASES[0] ?? BUILD_BASE;
    removeStore(KEY_NODE);
  }
}
