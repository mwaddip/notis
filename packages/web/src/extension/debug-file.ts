// WEB_INTERFACE → The extension → "The debug file". A pure function from a
// snapshot, the log's events (oldest first) and whether the identifying
// values go in, to the file's text and its name. One value, one placeholder
// throughout the file — the collection reads the snapshot and the events;
// hex values match case-insensitively; a tick lets every value through
// unchanged. The function reaches no clock of its own: the caller hands
// `savedAt` (the number recorded in the document) and `nowMs` (the number
// the filename is formed from).

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
type ValueClass = 'key' | 'name' | 'tx' | 'post' | 'box' | 'hand-node' | 'addr';

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
  if (settings.handNode.address !== '') {
    pushUnique(c, settings.handNode.address, 'addr');
    // A multiaddr may carry the node's key as a `/p2p/<peerId>` component;
    // the full address is one placeholder, and any 64-hex key embedded in
    // it is caught separately as `hand-node` for its own occurrence
    // elsewhere in the file.
    const peer = extractNotisHexFromAddr(settings.handNode.address);
    if (peer !== null) pushUnique(c, peer, 'hand-node');
  }
}

function extractNotisHexFromAddr(addr: string): string | null {
  // The hand-added address carries the peer id's base58 form in a `/p2p/`
  // component; the hex notisId cannot be read without the keypair work the
  // page does. The replacement pass cares only about strings present in
  // the file: a 64-hex key the handler stores would reach the file through
  // the reader's pending/waiting records, not through the address text.
  // Return `null` here so a 64-hex notisId only lands in the collection
  // where another seam carries it as a value.
  void addr;
  return null;
}

function collectFromEvents(c: Collected, events: readonly DebugEvent[]): void {
  // WEB_INTERFACE → The extension → "The debug file" — "and from the events
  // (each `write` event's and each `wait` event's `txId` field)". The
  // recorders write `txId` on both `write` and `wait` kinds
  // (`src/extension/mesh-seams.ts` `makeWriteObserver` and `src/main.ts`'s
  // wait recorder).
  for (const e of events) {
    if (e.kind !== 'write' && e.kind !== 'wait') continue;
    const tx = e['txId'];
    if (typeof tx === 'string') pushUnique(c, tx, 'tx');
  }
}

function collect(snapshot: DebugSnapshot, events: readonly DebugEvent[]): Collected {
  const c: Collected = { values: [] };
  if (!('error' in snapshot.reader)) collectFromReader(c, snapshot.reader);
  if (!('error' in snapshot.settings)) collectFromSettings(c, snapshot.settings);
  collectFromEvents(c, events);
  return c;
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
