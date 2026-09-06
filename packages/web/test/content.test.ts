// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseContent, linkCard, gateUrl, type Inline } from '../src/view/content';

// The content grammar — WEB_INTERFACE → Content. Pure and DOM-free, so it is
// pinned under node; the rendering is pinned in card.test.ts under happy-dom.

const t = (text: string): Inline => ({ kind: 'text', text });
const link = (url: string, text: string): Inline => ({ kind: 'link', url, text });
const bare = (url: string): Inline => ({ kind: 'bareUrl', url });
const strong = (...children: Inline[]): Inline => ({ kind: 'strong', children });
const em = (...children: Inline[]): Inline => ({ kind: 'em', children });

/** The inlines of a single-line content. */
function il(s: string): Inline[] {
  const b = parseContent(s);
  expect(b).toHaveLength(1);
  expect(b[0]!.kind).toBe('paragraph');
  const p = b[0] as { kind: 'paragraph'; lines: Inline[][] };
  expect(p.lines).toHaveLength(1);
  return p.lines[0]!;
}

describe('parseContent — blocks', () => {
  it('splits paragraphs on a blank line; a newline inside is a line break', () => {
    expect(parseContent('a\nb\n\nc')).toEqual([
      { kind: 'paragraph', lines: [[t('a')], [t('b')]] },
      { kind: 'paragraph', lines: [[t('c')]] },
    ]);
  });

  it('a title line at each level; #word without a space is text', () => {
    for (const h of ['#', '##', '###', '####', '#####', '######']) {
      expect(parseContent(h + ' Heading')).toEqual([{ kind: 'title', inlines: [t('Heading')] }]);
    }
    expect(parseContent('#hashtag')).toEqual([{ kind: 'paragraph', lines: [[t('#hashtag')]] }]);
    expect(parseContent('####### too many')).toEqual([{ kind: 'paragraph', lines: [[t('####### too many')]] }]);
  });

  it('a line of #s and spaces alone is text, not a title with a space', () => {
    expect(parseContent('#   ')).toEqual([{ kind: 'paragraph', lines: [[t('#   ')]] }]);
    expect(parseContent('###  ')).toEqual([{ kind: 'paragraph', lines: [[t('###  ')]] }]);
  });

  it('drops blank lines at either end; a title ends the paragraph before it and starts none after', () => {
    expect(parseContent('\n\nhi\n\n')).toEqual([{ kind: 'paragraph', lines: [[t('hi')]] }]);
    expect(parseContent('para\n# Title\nnext')).toEqual([
      { kind: 'paragraph', lines: [[t('para')]] },
      { kind: 'title', inlines: [t('Title')] },
      { kind: 'paragraph', lines: [[t('next')]] },
    ]);
  });

  it('empty content is no blocks', () => {
    expect(parseContent('')).toEqual([]);
    expect(parseContent('   \n  ')).toEqual([]);
  });
});

describe('parseContent — inlines', () => {
  it('a link, and its text does not nest', () => {
    expect(il('see [the docs](https://ok.com/x) here')).toEqual([t('see '), link('https://ok.com/x', 'the docs'), t(' here')]);
    // nothing nests inside link text — the * stays literal
    expect(il('[a *b* c](https://ok.com)')).toEqual([link('https://ok.com', 'a *b* c')]);
    // empty text is not a link; the `[` is a text char and scanning continues, so
    // the URL after the `(` is a bare URL, as `(https://…)` is anywhere
    expect(il('[](https://ok.com)')).toEqual([t('[]('), bare('https://ok.com'), t(')')]);
  });

  it('a bare URL only at the start or after whitespace or (', () => {
    expect(il('go to https://ok.com now')).toEqual([t('go to '), bare('https://ok.com'), t(' now')]);
    expect(il('(https://ok.com)')).toEqual([t('('), bare('https://ok.com'), t(')')]);
    // not after a non-space, non-(
    expect(il('xhttps://ok.com')).toEqual([t('xhttps://ok.com')]);
  });

  it('bare-URL trailing punctuation is trimmed, and a ) when the URL holds no (', () => {
    expect(il('https://ok.com.')).toEqual([bare('https://ok.com'), t('.')]);
    expect(il('https://ok.com),')).toEqual([bare('https://ok.com'), t('),')]);
    // a ) is kept when the URL opened one
    expect(il('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual([bare('https://en.wikipedia.org/wiki/Foo_(bar)')]);
  });

  it('bold before italic; emphasis holds links but no nested emphasis', () => {
    expect(il('**bold**')).toEqual([strong(t('bold'))]);
    expect(il('*italic*')).toEqual([em(t('italic'))]);
    expect(il('**a [x](https://ok.com) b**')).toEqual([strong(t('a '), link('https://ok.com', 'x'), t(' b'))]);
    // ** is tried first: **x** is bold, not two italics
    expect(il('**x**')[0]!.kind).toBe('strong');
  });

  it('the emphasis whitespace rule — 2 * 3 * 4 is text; an unclosed opener is text', () => {
    expect(il('2 * 3 * 4')).toEqual([t('2 * 3 * 4')]);
    expect(il('* a *')).toEqual([t('* a *')]);
    expect(il('**unclosed')).toEqual([t('**unclosed')]);
    expect(il('_x_')).toEqual([t('_x_')]); // _ is never a marker
  });

  it('every escape yields its character as text; \\ before anything else is a \\', () => {
    expect(il('\\*not bold\\*')).toEqual([t('*not bold*')]);
    expect(il('\\[x\\](y)')).toEqual([t('[x](y)')]);
    expect(il('a\\!b \\# \\\\')).toEqual([t('a!b # \\')]);
    expect(il('\\q')).toEqual([t('\\q')]);
  });

  it('the parenthesis span nests; whitespace in it fails the link', () => {
    expect(il('[x](https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual([link('https://en.wikipedia.org/wiki/Foo_(bar)', 'x')]);
    // the space fails the link; the `[` is text and scanning continues, so the
    // http run up to the space is a bare URL after the `(`
    expect(il('[x](https://a b.com)')).toEqual([t('[x]('), bare('https://a'), t(' b.com)')]);
  });

  it('raw HTML is its literal text', () => {
    expect(il('<b>x</b>')).toEqual([t('<b>x</b>')]);
  });
});

describe('the URL gate', () => {
  it('http and https pass; other schemes and whitespace fail', () => {
    expect(gateUrl('http://ok.com')?.host).toBe('ok.com');
    expect(gateUrl('https://ok.com')?.host).toBe('ok.com');
    expect(gateUrl('javascript:alert(1)')).toBeNull();
    expect(gateUrl('data:text/html,x')).toBeNull();
    expect(gateUrl('ftp://ok.com')).toBeNull();
    expect(gateUrl('mailto:a@b.com')).toBeNull();
    expect(gateUrl('https://a b.com')).toBeNull();
    expect(gateUrl('not a url')).toBeNull();
  });

  it('a construct whose URL fails the gate is text', () => {
    expect(il('[x](javascript:alert(1))')).toEqual([t('[x](javascript:alert(1))')]);
    expect(il('[x](ftp://y.com)')).toEqual([t('[x](ftp://y.com)')]);
  });
});

describe('the link card', () => {
  it('one link, or one bare URL, with surrounding whitespace, is the link card', () => {
    expect(linkCard(parseContent('[words](https://ok.com/p)'))).toEqual(link('https://ok.com/p', 'words'));
    expect(linkCard(parseContent('   https://ok.com   '))).toEqual(bare('https://ok.com'));
  });

  it('extra words, a title line, or two links are not a link card', () => {
    expect(linkCard(parseContent('see [x](https://ok.com)'))).toBeNull();
    expect(linkCard(parseContent('# t\n[x](https://ok.com)'))).toBeNull();
    expect(linkCard(parseContent('[x](https://ok.com) [y](https://ok.com)'))).toBeNull();
  });
});
