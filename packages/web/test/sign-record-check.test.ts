import { describe, it, expect } from 'vitest';
import { isSignRecord, type SignRecord } from '../src/extension/protocol';

// The one check — `isSignRecord`, beside `SignRecord` — holds each required
// field of the record to its type (WEB_INTERFACE → The extension → "`sign`,
// in the background, in order"). These cases pin the check's shape.

function wellFormed(): SignRecord {
  return {
    id: 'aa'.repeat(16),
    txIdHex: 'bb'.repeat(32),
    txBytesHex: 'cc'.repeat(16),
    pubKeyHex: 'dd'.repeat(32),
    summary: { kind: 'other', spendRep: '0' },
    hint: {},
    createdAt: 1_700_000_000,
  };
}

describe('isSignRecord takes a well-formed record', () => {
  it('a record with every required field at its type passes', () => {
    expect(isSignRecord(wellFormed())).toBe(true);
  });

  it('a record carrying `windowId` and a declined `result` passes', () => {
    const r: SignRecord = { ...wellFormed(), windowId: 42, result: { declined: true } };
    expect(isSignRecord(r)).toBe(true);
  });

  it('a record carrying a signature `result` passes', () => {
    const r: SignRecord = { ...wellFormed(), result: { signature: 'ee'.repeat(32) } };
    expect(isSignRecord(r)).toBe(true);
  });
});

describe('isSignRecord refuses what a loose check would take', () => {
  it('refuses a non-object', () => {
    expect(isSignRecord(null)).toBe(false);
    expect(isSignRecord(undefined)).toBe(false);
    expect(isSignRecord('string')).toBe(false);
    expect(isSignRecord(42)).toBe(false);
  });

  it('refuses a record whose `id` is not a string', () => {
    expect(isSignRecord({ ...wellFormed(), id: 42 })).toBe(false);
  });

  it('refuses a record whose `txIdHex` is not a string', () => {
    expect(isSignRecord({ ...wellFormed(), txIdHex: null })).toBe(false);
  });

  it('refuses a record whose `txBytesHex` is missing', () => {
    const r = { ...wellFormed() } as Record<string, unknown>;
    delete r['txBytesHex'];
    expect(isSignRecord(r)).toBe(false);
  });

  it('refuses a record whose `pubKeyHex` is missing', () => {
    const r = { ...wellFormed() } as Record<string, unknown>;
    delete r['pubKeyHex'];
    expect(isSignRecord(r)).toBe(false);
  });

  it('refuses a record whose `summary` is `null` — `typeof null === "object"` on its own', () => {
    expect(isSignRecord({ ...wellFormed(), summary: null })).toBe(false);
  });

  it('refuses a record whose `summary` is missing', () => {
    const r = { ...wellFormed() } as Record<string, unknown>;
    delete r['summary'];
    expect(isSignRecord(r)).toBe(false);
  });

  it('refuses a record whose `hint` is missing', () => {
    const r = { ...wellFormed() } as Record<string, unknown>;
    delete r['hint'];
    expect(isSignRecord(r)).toBe(false);
  });

  it('refuses a record whose `createdAt` is not a number', () => {
    expect(isSignRecord({ ...wellFormed(), createdAt: '1700000000' })).toBe(false);
  });
});

// The background writes a SignRecord in three places — the write before the
// prompt opens (`doSign`), the two updates that attach a result (`approve`,
// `decline`) and the two that attach `result: { declined: true }` when a
// prompt window dies (`canOpenNewPrompt`, `discardAbandonedPrompts`). Each is
// `{ ...record, result }` or a fresh record with the seven required fields.
describe('a record background writes is a record `isSignRecord` passes', () => {
  it('a fresh record — the shape `doSign` writes before the prompt opens — passes', () => {
    expect(isSignRecord(wellFormed())).toBe(true);
  });

  it('the same record with `result: { signature }` — approve — passes', () => {
    const r: SignRecord = { ...wellFormed(), result: { signature: 'f0'.repeat(32) } };
    expect(isSignRecord(r)).toBe(true);
  });

  it('the same record with `result: { declined: true }` — decline, abandoned prompt — passes', () => {
    const r: SignRecord = { ...wellFormed(), result: { declined: true } };
    expect(isSignRecord(r)).toBe(true);
  });

  it('the same record with `windowId` — the moment `windows.create` returned — passes', () => {
    const r: SignRecord = { ...wellFormed(), windowId: 7 };
    expect(isSignRecord(r)).toBe(true);
  });
});
