// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { isMessage, KNOWN_KINDS, REFUSED_UNKNOWN, type Message } from '../src/extension/protocol';

// The wire shapes are closed at the type level; runtime, they are refused when
// the guard doesn't recognise the kind (WEB_INTERFACE → "The messages"). A
// shape that lies about its kind reaches the dispatcher as unknown, and the
// answer is one `{ error }` shape.

describe('isMessage — every known kind passes, everything else is refused', () => {
  it('a plain object with a known kind is a message', () => {
    for (const kind of KNOWN_KINDS) {
      expect(isMessage({ kind })).toBe(true);
    }
  });

  it('an unknown kind is not a message', () => {
    expect(isMessage({ kind: 'not-a-real-kind' })).toBe(false);
    expect(isMessage({ kind: '' })).toBe(false);
    expect(isMessage({ kind: 42 })).toBe(false);
  });

  it('null, primitives and arrays are not messages', () => {
    expect(isMessage(null)).toBe(false);
    expect(isMessage(undefined)).toBe(false);
    expect(isMessage('draft')).toBe(false);
    expect(isMessage(0)).toBe(false);
    expect(isMessage([])).toBe(false);
  });

  it('an object with no `kind` field is not a message', () => {
    expect(isMessage({})).toBe(false);
    expect(isMessage({ passphrase: 'x' })).toBe(false);
  });
});

describe('KNOWN_KINDS — the full set of what the dispatcher understands', () => {
  it('is exactly the 15 kinds the contract lists', () => {
    const expected: Array<Message['kind']> = [
      'state', 'draft', 'discardDraft', 'create', 'inspectFile',
      'importFile', 'exportFile', 'unlock', 'lock', 'forget',
      'policy', 'sign', 'ack', 'approve', 'decline',
    ];
    expect(KNOWN_KINDS.size).toBe(expected.length);
    for (const k of expected) expect(KNOWN_KINDS.has(k)).toBe(true);
  });
});

describe('REFUSED_UNKNOWN — one shape for every refused message', () => {
  it('carries exactly `error` as a string', () => {
    expect(REFUSED_UNKNOWN).toEqual({ error: 'unknown message kind' });
  });
});
