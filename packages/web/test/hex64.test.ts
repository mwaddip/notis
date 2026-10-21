import { describe, it, expect } from 'vitest';
import { decideMode } from '../src/mode';
import { parse, serialise } from '../src/model/arrangement';

// WEB_INTERFACE → Reading a node's answer, → The standalone thread, → The
// workspace: an id from a node is 64 lowercase hex; the id in a page's path
// and a token in the stored layout are read either-case and lower-cased.
// These cases pin the either-case rule through the sites that apply it.

describe("decideMode reads a path's id either-case and lower-cases it", () => {
  it('a lowercase 64-hex id reads as standalone with the id', () => {
    const id = 'a'.repeat(64);
    const m = decideMode('/p/' + id, '/');
    expect(m).toEqual({ kind: 'standalone', id, base: '/' });
  });

  it('an upper-case 64-hex id reads as standalone with the id lower-cased', () => {
    const upper = 'A'.repeat(64);
    const lower = 'a'.repeat(64);
    const m = decideMode('/p/' + upper, '/');
    expect(m).toEqual({ kind: 'standalone', id: lower, base: '/' });
  });

  it('a mixed-case id reads lower-cased', () => {
    const mixed = 'AbCdEf'.repeat(10) + 'Ab00';
    const m = decideMode('/p/' + mixed, '/');
    expect(m).toEqual({ kind: 'standalone', id: mixed.toLowerCase(), base: '/' });
  });

  it('a 63-character tail reads as workspace', () => {
    const m = decideMode('/p/' + 'a'.repeat(63), '/');
    expect(m).toEqual({ kind: 'workspace', base: '/' });
  });

  it('a 65-character tail reads as workspace', () => {
    const m = decideMode('/p/' + 'a'.repeat(65), '/');
    expect(m).toEqual({ kind: 'workspace', base: '/' });
  });
});

describe('parse reads stored tokens either-case and lower-cases them', () => {
  it('an upper-case id token reads as a lower-cased window id', () => {
    const upper = 'A'.repeat(64);
    const lower = 'a'.repeat(64);
    const ws = parse(upper);
    expect(serialise(ws)).toBe(lower);
  });

  it('a 63-character token is dropped', () => {
    const ws = parse('a'.repeat(63));
    expect(serialise(ws)).toBe('');
  });

  it('a 65-character token is dropped', () => {
    const ws = parse('a'.repeat(65));
    expect(serialise(ws)).toBe('');
  });

  it("the `@author:` and `@posts:` subject keys read either-case too", () => {
    const upper = 'A'.repeat(64);
    const lower = 'a'.repeat(64);
    const ws = parse('@author:' + upper + ',@posts:' + upper);
    expect(serialise(ws)).toBe('@author:' + lower + ',@posts:' + lower);
  });
});
