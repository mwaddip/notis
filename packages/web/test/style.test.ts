// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// happy-dom and jsdom compute no stylesheet, so this pins the rule's PRESENCE in
// app.css, never its effect; the rendered proof in Chromium pins the effect
// (WEB_INTERFACE → The identity display). Lexical, and honest about it.
const css = readFileSync(fileURLToPath(new URL('../src/style/app.css', import.meta.url)), 'utf8');
const fontsCss = readFileSync(fileURLToPath(new URL('../public/fonts/fonts.css', import.meta.url)), 'utf8');
// app.ts is read as text, not imported: this file runs in the node environment and
// app.ts's import chain touches document at module scope. The breakpoint is one
// number in two places (WEB_INTERFACE → The workspace) and the pin is lexical.
const appTs = readFileSync(fileURLToPath(new URL('../src/app.ts', import.meta.url)), 'utf8');

describe('app.css — the prefix control renders as the text prefix', () => {
  it('the base .authorbtn rule neutralises the UA button', () => {
    // \s*\{ after .authorbtn skips the :hover / :focus-visible variants (their `:`
    // separates the name from the brace). The base block and the coarse touch
    // override both match; the base is the one that neutralises the button.
    const blocks = css.match(/\.authorbtn\s*\{[^}]*\}/g) ?? [];
    const base = blocks.find((b) => b.includes('background: transparent'));
    expect(base).toBeDefined();
    expect(base!).toContain('border: 0');
    expect(base!).toContain('padding: 0');
  });

  it('.authorbtn:hover and .authorbtn:focus-visible blocks exist', () => {
    expect(css).toMatch(/\.authorbtn:hover\s*\{[^}]*\}/);
    expect(css).toMatch(/\.authorbtn:focus-visible\s*\{[^}]*\}/);
  });
});

describe('app.css — a word control wears no box', () => {
  it('.word has no border', () => {
    const blocks = css.match(/\.word\s*\{[^}]*\}/g) ?? [];
    const base = blocks.find((b) => b.includes('border: 0'));
    expect(base).toBeDefined();
    expect(base!).not.toContain('border: 1px');
  });
  it('.btn keeps its border', () => {
    expect(css).toMatch(/\.btn-ghost\s*\{[^}]*border: 1px solid/);
  });
  it('every :hover inside the hover block', () => {
    const hover = mediaBlock('@media (hover: hover) {');
    expect(hover).not.toBe('');
    expect(css.replace(hover, '')).not.toContain(':hover');
  });
  it('.meta .linkbtn svg is inline-block with vertical-align', () => {
    expect(css).toMatch(/\.meta \.linkbtn svg\s*\{[^}]*display: inline-block/);
    expect(css).toMatch(/\.meta \.linkbtn svg\s*\{[^}]*vertical-align: -4px/);
  });
  it('.seg .word is inkMute at rest, ink when pressed', () => {
    expect(css).toMatch(/\.seg \.word\s*\{[^}]*color: var\(--inkMute\)/);
    expect(css).toMatch(/\.seg \.word\[aria-pressed="true"\]\s*\{[^}]*color: var\(--ink\)/);
  });
});

describe('app.css — the content grammar and the composer type control', () => {
  it('the paragraph-spacing, title, link, image-control and type-select rules are present', () => {
    expect(css).toMatch(/\.card-content > \* \+ \*\s*\{[^}]*\}/); // 8px between blocks
    expect(css).toMatch(/\.card-title\s*\{[^}]*\}/); // the title one step up
    expect(css).toMatch(/\.card-content a\s*\{[^}]*\}/); // a link keeps its colour
    expect(css).toMatch(/\.composer-foot select\s*\{[^}]*\}/); // the type control's ghost look
  });
});

describe('app.css — the one-column breakpoint agrees with the source constant', () => {
  it('the @media (max-width) equals the exported ONE_COLUMN_MAX_PX', () => {
    const m = appTs.match(/ONE_COLUMN_MAX_PX\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(css).toContain(`@media (max-width: ${m![1]}px)`);
  });
});

// The content of a top-level @media block: from just after its `{` to the line
// that is a bare `}` (the block's rules are single-line, so their braces never
// start a line). Lexical, like the rest here.
function mediaBlock(header: string): string {
  const start = css.indexOf(header);
  if (start === -1) return '';
  const from = start + header.length;
  const end = css.indexOf('\n}', from);
  return end === -1 ? '' : css.slice(from, end);
}

describe('app.css — touch by the pointer', () => {
  it('every :hover rule sits inside one @media (hover: hover) block', () => {
    const hover = mediaBlock('@media (hover: hover) {');
    expect(hover).not.toBe('');
    // With that block's rules removed, no :hover may remain anywhere else.
    expect(css.replace(hover, '')).not.toContain(':hover');
  });

  it('the @media (pointer: coarse) block names each control of the touch table', () => {
    const coarse = mediaBlock('@media (pointer: coarse) {');
    expect(coarse).not.toBe('');
    for (const sel of [
      '.ctl', '.feed-head .ctl', '.bar', '.meta', '.stage', '.karma-field',
      '.btn', '.theme-btn',
      '.composer-foot select', '.word', '.authorbtn', '.composer textarea', '.composer input', '.winbody input',
    ]) {
      expect(coarse).toContain(sel);
    }
  });
});

describe('app.css — the one-column header', () => {
  it('the max-width block carries the header gap, the arrows-as-glyph rule, none:absent, and .hdr-glyph', () => {
    const one = mediaBlock('@media (max-width: 955px) {');
    expect(one).not.toBe('');
    expect(one).toContain('header { gap: 8px');
    expect(one).toMatch(/header \.ctl \{[^}]*flex: 0 0 44px/); // the strip's glyph, never shrinks
    expect(one).toMatch(/header \.ctl \{[^}]*font-size: 20px/);
    expect(one).toMatch(/header \.ctl \{[^}]*font-weight: 600/);
    expect(one).toContain('header .ctl.none { display: none'); // absent, not space-reserved
    expect(one).toMatch(/\.hdr-glyph \{[^}]*flex: 0 0 44px/); // the glyph button, 44 wide
    expect(one).toMatch(/\.hdr-glyph svg \{[^}]*width: 20px/); // the svg at 20px
  });
  it('the base header .ctl.none reserves its space at tiling', () => {
    expect(css).toMatch(/header \.ctl\.none \{[^}]*visibility: hidden/);
  });
});

describe('app.css — scroll-snap-stop inside the one-column block', () => {
  it('scroll-snap-stop: always is inside @media (max-width: 955px) and nowhere outside', () => {
    const one = mediaBlock('@media (max-width: 955px) {');
    expect(one).not.toBe('');
    expect(one).toContain('scroll-snap-stop: always');
    expect(css.replace(one, '')).not.toContain('scroll-snap-stop');
  });
});

describe('app.css — the standalone rules', () => {
  it('.workspace.standalone hides the feed, applies contents to panes, and caps the member', () => {
    expect(css).toMatch(/\.workspace\.standalone\s*\{[^}]*gap: 0/);
    expect(css).toMatch(/\.workspace\.standalone \.feed\s*\{[^}]*display: none/);
    expect(css).toMatch(/\.workspace\.standalone \.panes\s*\{[^}]*display: contents/);
    expect(css).toMatch(/\.workspace\.standalone \.col\s*\{[^}]*660px/);
  });
});

describe('app.css — the link fallback', () => {
  it('.card-link rule exists', () => {
    expect(css).toMatch(/\.card-link\s*\{/);
  });
});

describe('app.css — the handle', () => {
  it('.handle has font-weight 600 and ink, never names the mono family', () => {
    const blocks = css.match(/\.handle\s*\{[^}]*\}/g) ?? [];
    const base = blocks.find((b) => !b.includes('.who') && !b.includes('.bar') && !b.includes('.card'));
    expect(base).toBeDefined();
    expect(base!).toContain('font-weight: 600');
    expect(base!).toContain('color: var(--ink)');
    for (const b of blocks) {
      expect(b).not.toContain('var(--mono)');
    }
  });

  it('.who .handle at 0,2,0 carries font-weight 600 and ink to win over .authorbtn 0,1,0', () => {
    const block = css.match(/\.who \.handle\s*\{[^}]*\}/)?.[0];
    expect(block).toBeDefined();
    expect(block!).toContain('font-size: 13px');
    expect(block!).toContain('font-weight: 600');
    expect(block!).toContain('color: var(--ink)');
  });

  it('.bar .handle at 13px flex: 0 0 auto', () => {
    expect(css).toMatch(/\.bar \.handle\s*\{[^}]*font-size: 13px/);
    expect(css).toMatch(/\.bar \.handle\s*\{[^}]*flex: 0 0 auto/);
  });

  it('.card.open .who .handle fades as the prefix does', () => {
    expect(css).toMatch(/\.card\.open \.who \.handle\s*\{[^}]*opacity: \.75/);
  });

  it('the unused .who .name rule is gone', () => {
    expect(css).not.toMatch(/\.who \.name\s*\{/);
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
