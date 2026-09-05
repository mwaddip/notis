// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// happy-dom and jsdom compute no stylesheet, so this pins the rule's PRESENCE in
// app.css, never its effect; the rendered proof in Chromium pins the effect
// (WEB_INTERFACE → The identity display). Lexical, and honest about it.
const css = readFileSync(fileURLToPath(new URL('../src/style/app.css', import.meta.url)), 'utf8');

describe('app.css — the prefix control renders as the text prefix', () => {
  it('one .authorbtn rule neutralises the UA button', () => {
    // \s*\{ after .authorbtn skips the :hover / :focus-visible variants (their `:`
    // separates the name from the brace), so this counts the base block alone.
    const bases = css.match(/\.authorbtn\s*\{[^}]*\}/g) ?? [];
    expect(bases).toHaveLength(1);
    const block = bases[0];
    expect(block).toContain('background: transparent');
    expect(block).toContain('border: 0');
    expect(block).toContain('padding: 0');
  });

  it('.authorbtn:hover and .authorbtn:focus-visible blocks exist', () => {
    expect(css).toMatch(/\.authorbtn:hover\s*\{[^}]*\}/);
    expect(css).toMatch(/\.authorbtn:focus-visible\s*\{[^}]*\}/);
  });
});
