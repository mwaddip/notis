import { describe, it, expect } from 'vitest';
import { serialise, parse, isWindowId, authorWindowId, postsWindowId, windowSubject } from '../src/model/arrangement';
import { newWorkspace, newColumn } from '../src/model/workspace';

// 64-hex post ids and the fixed @-window ids.
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);
const P = '@profile';
const S = '@settings';
const W = '@wallet';
const AUTHOR = '@author:' + 'e'.repeat(64);
const POSTS = '@posts:' + 'f'.repeat(64);

describe('arrangement codec', () => {
  it('serialise and parse are inverses over valid ids', () => {
    const specs = [
      A,
      `${A},${B}`, // a comma-stacked column
      `${A}|${B}`, // two columns
      `${A},${B}|${C}`, // mixed: a stack, then a second column
      `${A},${P},${B}|${C},${D}`, // a mixed stack, then a two-window column
      `${P}`, // a lone profile window
    ];
    for (const spec of specs) {
      expect(serialise(parse(spec))).toBe(spec);
    }
  });

  it('round-trips a workspace built by hand, mixed windows and stacked columns', () => {
    const ws = newWorkspace();
    ws.columns.push(newColumn([A, P, B])); // column 0: a three-window stack
    ws.columns.push(newColumn([C, D])); // column 1: a two-window stack
    const text = serialise(ws);
    expect(text).toBe(`${A},${P},${B}|${C},${D}`);
    // Parsing the text reproduces the same window layout.
    const back = parse(text);
    expect(back.columns.map((c) => c.wins)).toEqual([[A, P, B], [C, D]]);
  });

  it('a stored / reads as a comma, so the stacks it separated join in order', () => {
    // A / joins the stacks it separated, in order — the parser's courtesy.
    expect(parse(`${A}/${B}`).columns.map((c) => c.wins)).toEqual([[A, B]]);
    expect(serialise(parse(`${A}/${B}`))).toBe(`${A},${B}`);
    // A multi-column arrangement: the / within a column joins, the | still splits.
    expect(serialise(parse(`${A}/${B}|${C}/${D}`))).toBe(`${A},${B}|${C},${D}`);
  });

  it('@settings and @wallet round-trip as live ids', () => {
    expect(serialise(parse(S))).toBe(S);
    expect(serialise(parse(`${A},${S}|${B}`))).toBe(`${A},${S}|${B}`);
    // A / joins the two into one column — the settings window can stack with
    // the profile window like any other pair.
    expect(serialise(parse(`${S}/${P}`))).toBe(`${S},${P}`);
    // @wallet joins the three fixed @-windows.
    expect(serialise(parse(W))).toBe(W);
    expect(serialise(parse(`${P},${W},${S}`))).toBe(`${P},${W},${S}`);
    expect(serialise(parse(`${W}/${P}`))).toBe(`${W},${P}`);
  });

  it('drops tokens that are not well-formed window ids', () => {
    expect(serialise(parse(`${A},notanid|${B}`))).toBe(`${A}|${B}`);
    expect(serialise(parse(`${A},|/${B}`))).toBe(`${A}|${B}`);
    expect(serialise(parse('  '))).toBe('');
    expect(serialise(parse(`#${A}`))).toBe(A); // a leading # (URL-hash form) is stripped
  });

  // WEB_INTERFACE → The workspace: `parse` reads a token lower-cased and drops
  // one it has already read, the first standing.
  it('a 64-hex id and an @author: or @posts: key written in capitals read lower-cased, and so does a window\'s own word', () => {
    const UP = 'AB'.repeat(32);
    const low = 'ab'.repeat(32);
    expect(parse(UP).columns.map((c) => c.wins)).toEqual([[low]]);
    expect(parse(`@author:${UP}|@posts:${UP}`).columns.map((c) => c.wins)).toEqual([['@author:' + low], ['@posts:' + low]]);
    expect(parse(`${'aB'.repeat(32)},@AUTHOR:${'Ab'.repeat(32)}|@Posts:${UP}`).columns.map((c) => c.wins))
      .toEqual([[low, '@author:' + low], ['@posts:' + low]]);
    expect(parse('@PROFILE,@Wallet|@SETTINGS').columns.map((c) => c.wins)).toEqual([[P, W], [S]]);
    // Every id a column holds is one isWindowId takes and windowSubject reads back.
    expect(parse(`@AUTHOR:${UP}`).columns[0]!.wins.map(windowSubject)).toEqual([{ kind: 'author', key: low }]);
  });

  it('one window written in two cases stands once, where it was first read', () => {
    expect(parse(`@author:${'EE'.repeat(32)}|@author:${'ee'.repeat(32)}`).columns.map((c) => c.wins)).toEqual([[AUTHOR]]);
    expect(parse(`@author:${'ee'.repeat(32)},${S}|@AUTHOR:${'Ee'.repeat(32)}`).columns.map((c) => c.wins)).toEqual([[AUTHOR, S]]);
    expect(parse(`${A},${A.toUpperCase()}|${B.toUpperCase()},${B}`).columns.map((c) => c.wins)).toEqual([[A], [B]]);
    expect(parse(`@posts:${'Ff'.repeat(32)},@POSTS:${'fF'.repeat(32)}|${POSTS}`).columns.map((c) => c.wins)).toEqual([[POSTS]]);
    expect(parse(`${P}|@Profile`).columns.map((c) => c.wins)).toEqual([[P]]);
  });

  it('a lower-case spec reads back unchanged, and a spec in capitals serialises to its lower-case form', () => {
    for (const spec of [`${A},${AUTHOR}|${POSTS},${P}`, `${W}|${B},${S}`, `${C}`, `${AUTHOR}|${D},${W}`]) {
      expect(serialise(parse(spec))).toBe(spec);
    }
    const text = serialise(parse(`${A.toUpperCase()}|@AUTHOR:${'EE'.repeat(32)},@Wallet`));
    expect(text).toBe(`${A}|${AUTHOR},${W}`);
    expect(serialise(parse(text))).toBe(text);
  });

  it('a token read twice in one column stands once, where it was first read', () => {
    expect(parse(`${A},${B},${A}`).columns.map((c) => c.wins)).toEqual([[A, B]]);
    expect(parse(`${P},${P}`).columns.map((c) => c.wins)).toEqual([[P]]);
    expect(parse(`${A},${W},${W},${B},${A},${W}`).columns.map((c) => c.wins)).toEqual([[A, W, B]]);
    // A / joins before the tokens are read, so a repeat across it is one column's.
    expect(parse(`${A}/${B}/${A}`).columns.map((c) => c.wins)).toEqual([[A, B]]);
  });

  it('a token read in an earlier column is dropped from every later one', () => {
    expect(parse(`${A},${P}|${P},${B}`).columns.map((c) => c.wins)).toEqual([[A, P], [B]]);
    expect(parse(`${P},${A}|${B}|${C},${A},${P}`).columns.map((c) => c.wins)).toEqual([[P, A], [B], [C]]);
    expect(parse(`${AUTHOR}|${POSTS},${AUTHOR}|${POSTS},${S}`).columns.map((c) => c.wins)).toEqual([[AUTHOR], [POSTS], [S]]);
  });

  it('a column whose every token was read before is not made', () => {
    expect(parse(`${P}|${P}`).columns.map((c) => c.wins)).toEqual([[P]]);
    expect(parse(`${A}|${A},${A}|${B}`).columns.map((c) => c.wins)).toEqual([[A], [B]]);
    expect(parse(`${A},${B}|${B},${A}|${A}|${C}`).columns.map((c) => c.wins)).toEqual([[A, B], [C]]);
    expect(parse(`${W}|${W}|${W}`).columns).toHaveLength(1);
  });

  it('what parse answers for a spec with repeats serialises to a spec it reads back unchanged', () => {
    for (const spec of [`${P}|${P}`, `${A},${B},${A}|${B},${C}`, `${A}/${A}|${S},${A}`]) {
      const text = serialise(parse(spec));
      expect(serialise(parse(text))).toBe(text);
      const wins = parse(spec).columns.flatMap((c) => c.wins);
      expect(new Set(wins).size).toBe(wins.length);
    }
  });

  it('recognises exactly 64-hex ids, @profile, @settings and @wallet — the three fixed @-windows', () => {
    expect(isWindowId(A)).toBe(true);
    expect(isWindowId(P)).toBe(true);
    expect(isWindowId(S)).toBe(true); // @settings is a live window id (WEB_INTERFACE → The settings window)
    expect(isWindowId(W)).toBe(true); // @wallet is a live window id (WEB_INTERFACE → The wallet window)
    expect(isWindowId('a'.repeat(63))).toBe(false);
    expect(isWindowId('g'.repeat(64))).toBe(false); // g is not hex
  });

  it('the author and posts windows round-trip; a bad suffix is not a window id', () => {
    expect(isWindowId(AUTHOR)).toBe(true);
    expect(isWindowId(POSTS)).toBe(true);
    // Round-trip through a full arrangement, mixed with a thread and a profile.
    expect(serialise(parse(`${A},${AUTHOR}|${POSTS},${P}`))).toBe(`${A},${AUTHOR}|${POSTS},${P}`);
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
    expect(windowSubject(S)).toBeNull();
    expect(windowSubject(W)).toBeNull();
  });
});
