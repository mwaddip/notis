// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// happy-dom and jsdom compute no stylesheet, so this pins the rule's PRESENCE in
// app.css, never its effect; the rendered proof in Chromium pins the effect
// (WEB_INTERFACE → The identity display). Lexical, and honest about it.
const css = readFileSync(fileURLToPath(new URL('../src/style/app.css', import.meta.url)), 'utf8');
const fontsCss = readFileSync(fileURLToPath(new URL('../public/fonts/fonts.css', import.meta.url)), 'utf8');

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

describe('app.css — the content grammar and the composer type control', () => {
  it('the paragraph-spacing, title, link, image-control and type-select rules are present', () => {
    expect(css).toMatch(/\.card-content > \* \+ \*\s*\{[^}]*\}/); // 8px between blocks
    expect(css).toMatch(/\.card-title\s*\{[^}]*\}/); // the title one step up
    expect(css).toMatch(/\.card-content a\s*\{[^}]*\}/); // a link keeps its colour
    expect(css).toMatch(/\.card-content \.img-show\s*\{[^}]*\}/); // the collapsed image control
    expect(css).toMatch(/\.composer-foot select\s*\{[^}]*\}/); // the type control's ghost look
  });
});

describe('fonts.css — the self-hosted italic face', () => {
  it('a second Plus Jakarta Sans @font-face is italic, weight 400 700, its own src', () => {
    const faces = fontsCss.match(/@font-face\s*\{[^}]*\}/g) ?? [];
    const italic = faces.find((f) => f.includes("font-family: 'Plus Jakarta Sans'") && f.includes('font-style: italic'));
    expect(italic).toBeDefined();
    expect(italic!).toContain('font-weight: 400 700');
    expect(italic!).toContain("url('/fonts/Plus-Jakarta-Sans-Italic.woff2')");
  });
});
