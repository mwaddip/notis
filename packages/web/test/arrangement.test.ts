import { describe, it, expect } from 'vitest';
import { serialise, parse, isWindowId, authorWindowId, postsWindowId, windowSubject } from '../src/model/arrangement';
import { newWorkspace, newRegion } from '../src/model/workspace';

// 64-hex post ids and the one @-window kind.
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);
const P = '@profile'; // the one @-window kind
const S = '@settings'; // the retired id, mapped to @profile on parse
const AUTHOR = '@author:' + 'e'.repeat(64);
const POSTS = '@posts:' + 'f'.repeat(64);

describe('arrangement codec', () => {
  it('serialise and parse are inverses over valid ids', () => {
    const specs = [
      A,
      `${A},${B}`, // a comma-stacked region
      `${A}|${B}`, // two columns
      `${A}/${B}`, // two regions in one column
      `${A},${B}|${C}`, // mixed: a stack, then a second column
      `${A},${P}|${C}/${D},${B}`, // thread+window stack, multi-region column
      `${P}`, // a lone profile window
    ];
    for (const spec of specs) {
      expect(serialise(parse(spec))).toBe(spec);
    }
  });

  it('round-trips a workspace built by hand, mixed windows and multi-row columns', () => {
    const ws = newWorkspace();
    ws.columns.push({ regions: [newRegion([A, P]), newRegion([B])] }); // column 0: two regions
    ws.columns.push({ regions: [newRegion([C, D])] }); // column 1: one comma-stacked region
    const text = serialise(ws);
    expect(text).toBe(`${A},${P}/${B}|${C},${D}`);
    // Parsing the text reproduces the same window layout.
    const back = parse(text);
    expect(back.columns.map((c) => c.regions.map((r) => r.wins))).toEqual([[[A, P], [B]], [[C, D]]]);
  });

  it('a stored @settings maps to @profile, so a saved workspace survives the rename', () => {
    expect(serialise(parse(S))).toBe(P);
    expect(serialise(parse(`${A},${S}|${B}`))).toBe(`${A},${P}|${B}`);
    // A workspace holding both maps @settings and keeps @profile, de-duped by the layout.
    expect(serialise(parse(`${S}/${P}`))).toBe(`${P}/${P}`);
  });

  it('drops tokens that are not well-formed window ids', () => {
    expect(serialise(parse(`${A},notanid|${B}`))).toBe(`${A}|${B}`);
    expect(serialise(parse(`${A},|/${B}`))).toBe(`${A}|${B}`);
    expect(serialise(parse('  '))).toBe('');
    expect(serialise(parse(`#${A}`))).toBe(A); // a leading # (URL-hash form) is stripped
  });

  it('recognises exactly 64-hex ids and @profile; @settings is mapped, not a live id', () => {
    expect(isWindowId(A)).toBe(true);
    expect(isWindowId(P)).toBe(true);
    expect(isWindowId(S)).toBe(false); // @settings is rewritten on parse, never a live window id
    expect(isWindowId('a'.repeat(63))).toBe(false);
    expect(isWindowId('g'.repeat(64))).toBe(false); // g is not hex
  });

  it('the author and posts windows round-trip; a bad suffix is not a window id', () => {
    expect(isWindowId(AUTHOR)).toBe(true);
    expect(isWindowId(POSTS)).toBe(true);
    // Round-trip through a full arrangement, mixed with a thread and a profile.
    expect(serialise(parse(`${A},${AUTHOR}|${POSTS}/${P}`))).toBe(`${A},${AUTHOR}|${POSTS}/${P}`);
    // A bad suffix (not 64 hex, or the wrong kind) is dropped like any non-id token.
    expect(isWindowId('@author:' + 'e'.repeat(63))).toBe(false);
    expect(isWindowId('@author:' + 'g'.repeat(64))).toBe(false);
    expect(isWindowId('@author:')).toBe(false);
    expect(isWindowId('@follows:' + 'e'.repeat(64))).toBe(false);
    expect(serialise(parse(`${A},@author:xyz|${B}`))).toBe(`${A}|${B}`);
  });

  it('the id helpers build and read back the subject key', () => {
    expect(authorWindowId('e'.repeat(64))).toBe(AUTHOR);
    expect(postsWindowId('f'.repeat(64))).toBe(POSTS);
    expect(windowSubject(AUTHOR)).toEqual({ kind: 'author', key: 'e'.repeat(64) });
    expect(windowSubject(POSTS)).toEqual({ kind: 'posts', key: 'f'.repeat(64) });
    // Not an @author/@posts window → null.
    expect(windowSubject(A)).toBeNull();
    expect(windowSubject(P)).toBeNull();
  });
});
