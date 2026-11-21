// WEB_INTERFACE → The extension → "The debug file". A pure function from a
// snapshot, the log's events (oldest first) and whether the identifying
// values go in, to the file's text and its name. One value, one placeholder
// throughout the file — the collection reads the snapshot and the events;
// hex values match case-insensitively; a tick lets every value through
// unchanged. The function reaches no clock of its own: the caller hands
// `savedAt` (the number recorded in the document) and `nowMs` (the number
// the filename is formed from).

import { notisIdFromPeerId, MeshKeyError } from '@dagsocial/net/browser';
import { peerIdFromString } from '@libp2p/peer-id';
import type { DebugEvent } from './debug-log.js';
import type { DebugSnapshot, ReaderFacts, SettingsFacts } from './debug-snapshot.js';

/** The document the file serialises (WEB_INTERFACE → The extension → "The
 *  debug file"). `format` is a stable tag so a reader of a saved file can
 *  tell its shape from a future one; `identifying` is `true` only where the
 *  reader ticked the box beside *save as file*. */
export interface DebugFileDoc {
  format: 'notis-debug/1';
  savedAt: number;
  identifying: boolean;
  snapshot: DebugSnapshot;
  events: DebugEvent[];
}

/** The seams the module takes. `savedAt` is recorded inside the document;
 *  `nowMs` is the clock the filename is formed from (both handed in so the
 *  function reaches no `Date.now()` on its own). */
export interface DebugFileInput {
  snapshot: DebugSnapshot;
  events: readonly DebugEvent[];
  identifying: boolean;
  savedAt: number;
  nowMs: number;
}

/** The function's answer: the file's name and its text. */
export interface DebugFile {
  filename: string;
  text: string;
}

const HEX64 = /^[0-9a-f]{64}$/i;
// A 64-hex id with a 2-decimal-digit index — the box id shape outputs of a
// transaction carry (TYPES_INTERFACE → BoxId). `hex-dec` matches
// case-insensitively.
const BOX_ID = /^[0-9a-f]{64}-\d+$/i;

/** The identifying-value classes the collection sorts into. */
type ValueClass = 'key' | 'name' | 'tx' | 'post' | 'box' | 'hand-node' | 'local-node' | 'addr' | 'npub';

interface Collected {
  /** `[value, class]` pairs in collection order; duplicates allowed but
   *  deduplicated when the placeholders are assigned. A hex value is held in
   *  its lowercase form, so case-insensitive replacement can share one
   *  placeholder for every spelling. */
  values: Array<{ value: string; cls: ValueClass; hex: boolean }>;
}

function pushUnique(c: Collected, raw: string, cls: ValueClass): void {
  if (raw === '') return;
  const hex = HEX64.test(raw) || BOX_ID.test(raw);
  const value = hex ? raw.toLowerCase() : raw;
  for (const held of c.values) {
    if (held.value === value && held.cls === cls) return;
  }
  c.values.push({ value, cls, hex });
}

function collectFromReader(c: Collected, reader: ReaderFacts): void {
  if (reader.pubKeyHex !== null) pushUnique(c, reader.pubKeyHex, 'key');
  if (reader.name !== null) pushUnique(c, reader.name, 'name');
  for (const p of reader.pending) {
    pushUnique(c, p.txId, 'tx');
    // `postId` is a post id for a post, like or withdraw entry, a key for
    // a vouch, unvouch, invite or send, and a box id for a faucet credits
    // grant. The replacement is by the whole string; a bare key held here
    // is caught by the key class on its own occurrence, and the box-id
    // shape names its class apart from the 64-hex ones.
    classifyPostId(c, p.postId);
  }
  for (const w of reader.waiting) {
    pushUnique(c, w.txId, 'tx');
    classifyPostId(c, w.postId);
  }
  if (reader.observedAddress !== undefined && reader.observedAddress !== null) {
    pushUnique(c, reader.observedAddress, 'addr');
  }
}

function classifyPostId(c: Collected, id: string): void {
  if (id === '') return;
  if (BOX_ID.test(id)) {
    pushUnique(c, id, 'box');
    return;
  }
  if (HEX64.test(id)) {
    pushUnique(c, id, 'post');
    return;
  }
  // A send's postId is `recipient:<hex>` or an `@handle`; treat any 64-hex
  // substring as a key and name as a name. The outer string is left as the
  // event's data; the substrings reach the file through the replacement
  // pass.
}

function collectFromSettings(c: Collected, settings: SettingsFacts): void {
  if (settings.handNode.address !== '') pushUnique(c, settings.handNode.address, 'addr');
  if (settings.handNode.key !== null) pushUnique(c, settings.handNode.key, 'hand-node');
}

function collectFromEvents(c: Collected, events: readonly DebugEvent[]): void {
  // WEB_INTERFACE → The extension → "The debug file" — "and from the events
  // (each `write` event's and each `wait` event's `txId` field)". The
  // recorders write `txId` on both `write` and `wait` kinds
  // (`src/extension/mesh-seams.ts` `makeWriteObserver` and `src/main.ts`'s
  // wait recorder). An answered `local-lookup` event names a node the
  // access point answered — its key and each of its addresses are
  // identifying values too, from the event (→ "The debug file" — "a node
  // found at an access point — its key and its addresses, from the
  // snapshot and from each read's report in the log"). An event from an
  // earlier page whose node the current snapshot no longer holds is
  // caught by this walk.
  for (const e of events) {
    if (e.kind === 'write' || e.kind === 'wait') {
      const tx = e['txId'];
      if (typeof tx === 'string') pushUnique(c, tx, 'tx');
      continue;
    }
    if (e.kind === 'local-lookup') {
      const outcome = e['outcome'];
      if (outcome !== null && typeof outcome === 'object'
          && (outcome as { result?: unknown }).result === 'answered') {
        const notisId = (outcome as { notisId?: unknown }).notisId;
        if (typeof notisId === 'string') pushUnique(c, notisId, 'local-node');
        const addrs = (outcome as { localAddrs?: unknown }).localAddrs;
        if (Array.isArray(addrs)) {
          for (const a of addrs) {
            if (typeof a === 'string') pushUnique(c, a, 'addr');
          }
        }
      }
    }
  }
}

function collectFromMesh(
  c: Collected,
  nodes: readonly { notisId: string; local: boolean; addrs: readonly string[] }[],
): void {
  // WEB_INTERFACE → The extension → "The debug file" — a node found at
  // the access point: its key (`local-node`) and each of its addresses
  // (`addr`) are identifying values; the `local` mark names the entry.
  for (const n of nodes) {
    if (n.local !== true) continue;
    pushUnique(c, n.notisId, 'local-node');
    for (const a of n.addrs) pushUnique(c, a, 'addr');
  }
}

function collect(snapshot: DebugSnapshot, events: readonly DebugEvent[]): Collected {
  const c: Collected = { values: [] };
  if (!('error' in snapshot.reader)) collectFromReader(c, snapshot.reader);
  if (!('error' in snapshot.settings)) collectFromSettings(c, snapshot.settings);
  if (!('error' in snapshot.mesh)) {
    collectFromMesh(c, snapshot.mesh.state.nodes);
  }
  collectFromEvents(c, events);
  // WEB_INTERFACE → The extension → "The identifying values" — "the npub of
  // its FIPS address wherever it stands, since an access point says where its
  // reader stands". A seed node's npub is not identifying and stays, so the
  // collection takes the npubs whose `/p2p/<peer id>` maps to a node already
  // being replaced (its notisId reached `collectFromMesh` or
  // `collectFromEvents` as a `local-node`).
  const replacedNotisIds = new Set<string>();
  for (const v of c.values) {
    if (v.cls === 'local-node') replacedNotisIds.add(v.value);
  }
  for (const npub of collectNpubs(snapshot, events, replacedNotisIds)) {
    pushUnique(c, npub, 'npub');
  }
  return c;
}

// WEB_INTERFACE → The extension → "The identifying values" — "the npub of
// its FIPS address wherever it stands". For each FIPS-shaped substring
// `/fips/<npub>[/p2p/<peer id>]` anywhere in the snapshot or the events, if
// the peer id maps (through the existing helpers) to a replaced notisId, or
// the address stands beside a connection whose peer is a replaced notisId,
// the npub is collected.
const FIPS_REF_RE = /\/fips\/([0-9a-z]+)(?:\/p2p\/([^/\s"]+))?/g;

function fipsRefs(s: string): Array<{ npub: string; peerId: string | null }> {
  if (!s.includes('/fips/')) return [];
  const out: Array<{ npub: string; peerId: string | null }> = [];
  for (const m of s.matchAll(FIPS_REF_RE)) {
    out.push({ npub: m[1]!, peerId: m[2] ?? null });
  }
  return out;
}

function notisIdOfPeerId(peerIdStr: string): string | null {
  try {
    return notisIdFromPeerId(peerIdFromString(peerIdStr));
  } catch (e) {
    if (e instanceof MeshKeyError) return null;
    return null;
  }
}

export function collectNpubs(
  snapshot: DebugSnapshot,
  events: readonly DebugEvent[],
  replacedNotisIds: Set<string>,
): string[] {
  const out = new Set<string>();

  const consider = (npub: string, peerId: string | null, fallback: string | null): void => {
    let notisId: string | null = null;
    if (peerId !== null) notisId = notisIdOfPeerId(peerId);
    if (notisId === null) notisId = fallback;
    if (notisId !== null && replacedNotisIds.has(notisId)) out.add(npub);
  };

  const walk = (s: string, fallback: string | null): void => {
    for (const r of fipsRefs(s)) consider(r.npub, r.peerId, fallback);
  };

  if (!('error' in snapshot.mesh)) {
    for (const node of snapshot.mesh.state.nodes) {
      for (const a of node.addrs ?? []) walk(a, node.notisId);
      for (const a of node.droppedAddrs ?? []) walk(a, node.notisId);
      for (const k of Object.keys(node.lastFailures ?? {})) walk(k, node.notisId);
    }
    for (const conn of snapshot.mesh.diagnostics.connections) {
      const peerAsNotis = conn.peerKind === 'notis' ? conn.peer : null;
      walk(conn.remoteAddr, peerAsNotis);
    }
  }

  // `dial` events carry each attributed address in `outcome.addresses[*].addr`
  // beside the event's `nodeId`; a `connection` event names its peer and
  // transport but no remote address, so no address walk arises there.
  for (const e of events) {
    if (e.kind !== 'dial') continue;
    const outcome = e['outcome'];
    if (outcome === null || typeof outcome !== 'object') continue;
    const addresses = (outcome as { addresses?: unknown }).addresses;
    if (!Array.isArray(addresses)) continue;
    const nodeIdRaw = e['nodeId'];
    const fallback = typeof nodeIdRaw === 'string' ? nodeIdRaw : null;
    for (const a of addresses) {
      if (a === null || typeof a !== 'object') continue;
      const addr = (a as { addr?: unknown }).addr;
      if (typeof addr === 'string') walk(addr, fallback);
    }
  }

  return [...out];
}

interface PlaceholderMap {
  /** `[value, placeholder, hex]` in longest-first order, so a value that is
   *  a substring of another is replaced after its container (otherwise the
   *  container would never be seen whole after the substring took it over). */
  entries: Array<{ value: string; placeholder: string; hex: boolean }>;
}

function assignPlaceholders(c: Collected): PlaceholderMap {
  const counters = new Map<ValueClass, number>();
  const rows: Array<{ value: string; placeholder: string; hex: boolean }> = [];
  for (const v of c.values) {
    let placeholder: string;
    if (v.cls === 'hand-node') {
      // One hand-added node at a time (the settings row keeps one record);
      // the placeholder carries no number.
      placeholder = 'hand-node';
    } else {
      const n = (counters.get(v.cls) ?? 0) + 1;
      counters.set(v.cls, n);
      placeholder = `${v.cls}-${n}`;
    }
    rows.push({ value: v.value, placeholder, hex: v.hex });
  }
  // Longest first — a shorter value that is a substring of a longer one
  // must be replaced after it.
  rows.sort((a, b) => b.value.length - a.value.length);
  return { entries: rows };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceInText(text: string, map: PlaceholderMap): string {
  let out = text;
  for (const row of map.entries) {
    const flags = row.hex ? 'gi' : 'g';
    const re = new RegExp(escapeRegex(row.value), flags);
    out = out.replace(re, row.placeholder);
  }
  return out;
}

function pad2(n: number): string { return n < 10 ? '0' + n : String(n); }

/** The file's name (WEB_INTERFACE → The extension → "The debug file"):
 *  `notis-debug-<YYYYMMDD-HHMMSS>.json`, the clock read from the caller's
 *  `nowMs` under UTC. Under UTC so a downloaded file names the same instant
 *  every reader sees, not the saver's zone; a saver who wants their zone
 *  reads the `savedAt` inside the document. */
export function debugFilename(nowMs: number): string {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = pad2(d.getUTCMonth() + 1);
  const day = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  const mm = pad2(d.getUTCMinutes());
  const ss = pad2(d.getUTCSeconds());
  return `notis-debug-${y}${m}${day}-${hh}${mm}${ss}.json`;
}

/** Build the file's text and name from a snapshot, the log's events and
 *  whether the identifying values go in (WEB_INTERFACE → The extension →
 *  "The debug file"). Pure — no clock, no I/O; the caller hands both the
 *  recorded `savedAt` and the `nowMs` the filename is formed from. */
export function buildDebugFile(input: DebugFileInput): DebugFile {
  const events: DebugEvent[] = input.events.slice();
  const doc: DebugFileDoc = {
    format: 'notis-debug/1',
    savedAt: input.savedAt,
    identifying: input.identifying,
    snapshot: input.snapshot,
    events,
  };
  const raw = JSON.stringify(doc, null, 2);
  const text = input.identifying
    ? raw
    : replaceInText(raw, assignPlaceholders(collect(input.snapshot, events)));
  return { filename: debugFilename(input.nowMs), text };
}
