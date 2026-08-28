import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractDeclaration } from './extract-declaration.js';

const INDEX_HTML = fileURLToPath(new URL('../../public/index.html', import.meta.url));
const html = readFileSync(INDEX_HTML, 'utf8');

function lift(header: string): string {
  return extractDeclaration(html, header, 'index.html');
}

interface Fns {
  mergeRange: (
    map: Map<string, unknown>,
    keyOf: (r: unknown) => string,
    compare: (a: string, b: string) => number,
    afterKey: string | null,
    rows: unknown[],
    next: string | null,
  ) => void;
  compareFeedKeys: (a: string, b: string) => number;
  compareDescKeys: (a: string, b: string) => number;
}

const fns: Fns = new Function(
  [
    lift('function compareFeedKeys('),
    lift('function compareDescKeys('),
    lift('function mergeRange('),
    'return { mergeRange, compareFeedKeys, compareDescKeys };',
  ].join('\n\n'),
)() as Fns;

const { mergeRange, compareFeedKeys, compareDescKeys } = fns;

function row(h: number, i: number) { return { blockHeight: h, blockIndex: i }; }
function key(h: number, i: number) { return `${h}:${i}`; }
function keyOf(r: unknown) { return key((r as { blockHeight: number }).blockHeight, (r as { blockIndex: number }).blockIndex); }

describe('mergeRange — feed (newest first)', () => {
  it('load-more replaces exactly its range and keeps the head', () => {
    const map = new Map<string, unknown>();
    mergeRange(map, keyOf, compareFeedKeys, null, [row(5, 0), row(4, 0), row(3, 0)], key(3, 0));
    expect([...map.keys()]).toEqual([key(5, 0), key(4, 0), key(3, 0)]);

    mergeRange(map, keyOf, compareFeedKeys, key(3, 0), [row(2, 0), row(1, 0)], null);
    const keys = [...map.keys()];
    expect(keys).toContain(key(5, 0));
    expect(keys).toContain(key(4, 0));
    expect(keys).toContain(key(3, 0));
    expect(keys).toContain(key(2, 0));
    expect(keys).toContain(key(1, 0));
    expect(keys).toHaveLength(5);
  });

  it('head refresh keeps older pages and drops a pruned key', () => {
    const map = new Map<string, unknown>();
    mergeRange(map, keyOf, compareFeedKeys, null, [row(5, 0), row(4, 0), row(3, 0)], key(3, 0));
    mergeRange(map, keyOf, compareFeedKeys, key(3, 0), [row(2, 0), row(1, 0)], null);
    expect(map.size).toBe(5);

    mergeRange(map, keyOf, compareFeedKeys, null, [row(5, 0), row(3, 0)], key(3, 0));
    expect(map.has(key(4, 0))).toBe(false);
    expect(map.has(key(5, 0))).toBe(true);
    expect(map.has(key(2, 0))).toBe(true);
    expect(map.has(key(1, 0))).toBe(true);
  });

  it('next = null extends the range to the end', () => {
    const map = new Map<string, unknown>();
    mergeRange(map, keyOf, compareFeedKeys, null, [row(5, 0), row(4, 0)], key(4, 0));
    mergeRange(map, keyOf, compareFeedKeys, key(4, 0), [row(3, 0)], null);
    expect(map.size).toBe(3);

    mergeRange(map, keyOf, compareFeedKeys, null, [row(5, 0)], null);
    expect(map.size).toBe(1);
    expect(map.has(key(5, 0))).toBe(true);
  });
});

describe('mergeRange — thread (ascending)', () => {
  it('load-more replaces exactly its range and keeps earlier pages', () => {
    const map = new Map<string, unknown>();
    mergeRange(map, keyOf, compareDescKeys, null, [row(1, 0), row(2, 0)], key(2, 0));
    mergeRange(map, keyOf, compareDescKeys, key(2, 0), [row(3, 0), row(4, 0)], null);
    expect(map.size).toBe(4);
    expect([...map.keys()]).toEqual([key(1, 0), key(2, 0), key(3, 0), key(4, 0)]);
  });

  it('head refresh drops pruned key in range', () => {
    const map = new Map<string, unknown>();
    mergeRange(map, keyOf, compareDescKeys, null, [row(1, 0), row(2, 0), row(3, 0)], key(3, 0));
    mergeRange(map, keyOf, compareDescKeys, key(3, 0), [row(4, 0)], null);

    mergeRange(map, keyOf, compareDescKeys, null, [row(1, 0), row(3, 0)], key(3, 0));
    expect(map.has(key(2, 0))).toBe(false);
    expect(map.has(key(4, 0))).toBe(true);
  });

  it('next = null extends the range to the end', () => {
    const map = new Map<string, unknown>();
    mergeRange(map, keyOf, compareDescKeys, null, [row(1, 0), row(2, 0)], key(2, 0));
    mergeRange(map, keyOf, compareDescKeys, key(2, 0), [row(3, 0)], null);

    mergeRange(map, keyOf, compareDescKeys, null, [row(1, 0)], null);
    expect(map.size).toBe(1);
    expect(map.has(key(1, 0))).toBe(true);
  });
});
