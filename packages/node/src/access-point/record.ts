// NODE_INTERFACE → The access-point tool → "The record" — each change
// `setup` makes is written after it is made; `remove` walks the record
// in reverse and restores exactly what it names.

export interface RecordNodeEnvEdited {
  kind: 'nodeEnvEdited';
  priorText: string;
}
export interface RecordUplinkBandSet {
  kind: 'uplinkBandSet';
  profile: string;
  // The band as it was before `setup` set `bg` (`a` for 5 GHz, `bg` for
  // 2.4 GHz, or the empty string for a profile that declared none).
  priorBand: string;
}
export interface RecordFileWritten {
  kind: 'fileWritten';
  path: string;
  // The file's text as it was before `setup` wrote it, or `null` for a
  // file that did not exist.
  priorText: string | null;
}
export interface RecordUnitEnabled {
  kind: 'unitEnabled';
  unit: string;
}
export interface RecordUnitStarted {
  kind: 'unitStarted';
  unit: string;
}
export interface RecordNmConnectionAdded {
  kind: 'nmConnectionAdded';
  name: string;
}

export type RecordEntry =
  | RecordNodeEnvEdited
  | RecordUplinkBandSet
  | RecordFileWritten
  | RecordUnitEnabled
  | RecordUnitStarted
  | RecordNmConnectionAdded;

export interface AccessPointRecord {
  // The entries in the order `setup` made them; `remove` undoes them in
  // reverse.
  entries: RecordEntry[];
  // `true` once the last step of `setup` landed; a stop-early record is
  // incomplete and `setup` refuses to run against it.
  complete: boolean;
}

export const RECORD_DIR = '/etc/dagsocial/access-point';
export const RECORD_PATH = '/etc/dagsocial/access-point/record.json';

export function emptyRecord(): AccessPointRecord {
  return { entries: [], complete: false };
}

export function serializeRecord(r: AccessPointRecord): string {
  return JSON.stringify(r, null, 2) + '\n';
}

export function parseRecord(text: string): AccessPointRecord {
  const obj = JSON.parse(text) as unknown;
  if (typeof obj !== 'object' || obj === null) {
    throw new Error('record is not an object');
  }
  const o = obj as { entries?: unknown; complete?: unknown };
  if (!Array.isArray(o.entries)) throw new Error('record has no entries array');
  if (typeof o.complete !== 'boolean') throw new Error('record has no complete flag');
  return { entries: o.entries as RecordEntry[], complete: o.complete };
}
