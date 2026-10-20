import { describe, it, expect } from 'vitest';
import { capped } from '../src/http.js';

const LONG = 'Z'.repeat(500);
const NAMED = `${'Z'.repeat(120)}…`;

describe('capped — the node text a verdict names', () => {
  it('a string of 120 characters is named whole', () => {
    expect(capped('Z'.repeat(120))).toBe('Z'.repeat(120));
  });

  it('a longer string is named by its first 120 characters and …', () => {
    expect(capped(LONG)).toBe(NAMED);
  });

  it('a surrogate pair across the cut is left out whole, never split', () => {
    expect(capped(`${'Z'.repeat(119)}\u{1F600}${'Z'.repeat(10)}`)).toBe(`${'Z'.repeat(119)}…`);
  });

  it('a surrogate pair ending at the cut is kept whole', () => {
    expect(capped(`${'Z'.repeat(118)}\u{1F600}${'Z'.repeat(10)}`)).toBe(`${'Z'.repeat(118)}\u{1F600}…`);
  });
});

// A verdict shows every C0 control, DEL and C1 control a node string carries
// as its \u escape, never raw, and the cap counts the text as shown.

describe("capped — a node's control characters as their escapes, never raw", () => {
  it.each([
    ['NUL', '\u0000', '\\u0000'],
    ['TAB', '\t', '\\u0009'],
    ['LF', '\n', '\\u000a'],
    ['CR', '\r', '\\u000d'],
    ['ESC', '\u001b', '\\u001b'],
    ['US, the last C0', '\u001f', '\\u001f'],
    ['DEL', '\u007f', '\\u007f'],
    ['PAD, the first C1', '\u0080', '\\u0080'],
    ['CSI', '\u009b', '\\u009b'],
    ['APC, the last C1', '\u009f', '\\u009f'],
  ])('%s is shown as its escape', (_name, raw, escape) => {
    expect(capped(`a${raw}b`)).toBe(`a${escape}b`);
  });

  it('the characters beside the three ranges are shown as they are', () => {
    expect(capped(' ~ ')).toBe(' ~ ');
  });

  it('a 120-character body of escapes — the text as shown is capped', () => {
    expect(capped('\u001b'.repeat(120))).toBe(`${'\\u001b'.repeat(20)}…`);
  });

  it('an escape across the cut is left out whole, never split', () => {
    expect(capped(`${'Z'.repeat(117)}\u001bZ`)).toBe(`${'Z'.repeat(117)}…`);
  });

  it('an escape ending at the cut is kept whole', () => {
    expect(capped(`${'Z'.repeat(114)}\u001bZ`)).toBe(`${'Z'.repeat(114)}\\u001b…`);
  });
});
