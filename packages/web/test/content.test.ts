// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseContent } from '../src/view/content';

// The content grammar's block model — WEB_INTERFACE → Content. Pure and DOM-free,
// so it is pinned under node; the rendering is pinned in card.test.ts under
// happy-dom. This commit recognises no inline: every run is text.

const t = (text: string) => ({ kind: 'text' as const, text });

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

  it('drops blank lines at either end; a title ends the paragraph before it and starts none after', () => {
    expect(parseContent('\n\nhi\n\n')).toEqual([{ kind: 'paragraph', lines: [[t('hi')]] }]);
    expect(parseContent('para\n# Title\nnext')).toEqual([
      { kind: 'paragraph', lines: [[t('para')]] },
      { kind: 'title', inlines: [t('Title')] },
      { kind: 'paragraph', lines: [[t('next')]] },
    ]);
  });

  it('a whitespace-only line counts as blank', () => {
    expect(parseContent('a\n   \nb')).toEqual([
      { kind: 'paragraph', lines: [[t('a')]] },
      { kind: 'paragraph', lines: [[t('b')]] },
    ]);
  });

  it('empty content is no blocks', () => {
    expect(parseContent('')).toEqual([]);
    expect(parseContent('   \n  ')).toEqual([]);
  });
});
