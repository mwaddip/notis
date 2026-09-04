import { describe, it, expect } from 'vitest';
import { serialise, parse, isWindowId } from '../src/model/arrangement';
import { newWorkspace, newRegion } from '../src/model/workspace';

// 64-hex post ids and the one @-window kind.
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);
const P = '@profile'; // the one @-window kind
const S = '@settings'; // the retired id, mapped to @profile on parse

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
});
