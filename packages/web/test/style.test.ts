// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// This pins the rule's PRESENCE in app.css, never its effect. happy-dom computes
// a cascade — specificity, order, tokens — where a view test renders, but never a
// hover or a layout; the rendered proof in Chromium pins those
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
      '.btn', '.theme-btn', '.hdr-word',
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
  it('the one-column header centres every child on one axis', () => {
    // Every child is a box at one column — the arrows, the lockup, the glyphs —
    // and the bar centres them on one axis (WEB_INTERFACE → The workspace →
    // "The header's children share one axis"). The base rule at tiling is
    // align-items: baseline, so this override is the switch to axis-centred.
    const one = mediaBlock('@media (max-width: 955px) {');
    expect(one).toMatch(/header \{[^}]*align-items: center/);
  });
  it('the base header .ctl.none reserves its space at tiling', () => {
    expect(css).toMatch(/header \.ctl\.none \{[^}]*visibility: hidden/);
  });
  it('.hdr-word wears the outlined ghost look — transparent, ink, borderStrong', () => {
    // The tiling profile and settings words share one class: outlined, transparent,
    // beside the filled theme word (HOUSE_STYLE → Colour, → Interaction).
    const blocks = css.match(/\.hdr-word\s*\{[^}]*\}/g) ?? [];
    const base = blocks.find((b) => b.includes('background: transparent'));
    expect(base).toBeDefined();
    expect(base!).toContain('color: var(--ink)');
    expect(base!).toContain('border: 1px solid var(--borderStrong)');
  });
});

describe('app.css — the mark and wordmark lockup', () => {
  // The lockup shares its baseline with the header's other words: .brand is an
  // inline formatting context whose baseline is the h1's text baseline, and the
  // mark hangs on that line as an inline-block with a fixed vertical-align so
  // its centre lands on the words' box centre (WEB_INTERFACE → The workspace →
  // "The header's children share one axis"). The lockup keeps one baseline
  // whether or not the h1 is displayed — under 372px the h1 hides, the mark
  // stays and the same inline-block rule still centres it.
  it('.brand is display: inline-block, so its baseline is the wordmark line box', () => {
    expect(css).toMatch(/\.brand \{[^}]*display: inline-block/);
    // No flex or align-items on .brand — the interior is inline formatting.
    const blocks = css.match(/\.brand \{[^}]*\}/g) ?? [];
    const base = blocks[0]!;
    expect(base).not.toContain('display: flex');
    expect(base).not.toContain('align-items:');
  });
  it('.mark is display: inline-block with a fixed vertical-align lift', () => {
    // The lift is a fixed pixel value (a fraction of the mark's height, not an
    // em); the self-hosted face makes it exact.
    expect(css).toMatch(/\.mark \{[^}]*display: inline-block[^}]*vertical-align: -\d+(\.\d+)?px/);
    expect(css).toMatch(/\.mark \{[^}]*margin-right: 8px/); // the lockup gap
  });
  it('the wordmark is display: inline so it shares its line with the mark', () => {
    expect(css).toMatch(/header h1 \{[^}]*display: inline/);
  });
});

describe('app.css — the arrows carry an optical lift, expressed in em', () => {
  // A typographic arrow is centred by its ink, not by its em box: the glyph is
  // lifted by a fixed fraction of its size, which the self-hosted face makes
  // exact (WEB_INTERFACE → The workspace → "The header's children share one
  // axis"). Padding-bottom on the button shrinks the content-area from the
  // bottom and, with flex align-items: center, lifts the character in place
  // without growing the 44 × 36 hit box on a phone or the 24 × 24 one at tiling.
  it('header .ctl carries padding-bottom in em', () => {
    expect(css).toMatch(/header \.ctl \{[^}]*padding-bottom: \.\d+em/);
  });
});

describe('app.css — under 372px the workspace header wordmark yields', () => {
  it('the max-width: 371px block hides header.hdr-workspace h1, so the standalone bar keeps its wordmark', () => {
    const under = mediaBlock('@media (max-width: 371px) {');
    expect(under).not.toBe('');
    expect(under).toMatch(/header\.hdr-workspace h1\s*\{[^}]*display: none/);
  });
  it('the hdr-workspace class name appears in no selector but the 371px rule, so no other rule catches the workspace header', () => {
    // The strip scroller already owns `.workspace`; a header class that shares
    // that name would grow the bar and take the scroller's padding and snap.
    // The hazard is that any second selector targeting .hdr-workspace would
    // re-open the same collision under a different name. Comments naming the
    // class are fine — the check is on selectors.
    const under = mediaBlock('@media (max-width: 371px) {');
    expect(under).toContain('hdr-workspace');
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(withoutComments.replace(under, '')).not.toContain('hdr-workspace');
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

describe('app.css — the status corner', () => {
  it('the base .corner rule is fixed at the viewport\'s bottom-right, 16px in', () => {
    const blocks = css.match(/\.corner\s*\{[^}]*\}/g) ?? [];
    const base = blocks.find((b) => b.includes('position: fixed'));
    expect(base).toBeDefined();
    expect(base!).toContain('right: 16px');
    expect(base!).toContain('bottom: 16px');
    expect(base!).toContain('background: transparent');
    expect(base!).toContain('border: 0');
  });
  it('the led is 8px round; fresh greenText, stale clay, down/none inkMute', () => {
    expect(css).toMatch(/\.corner \.led\s*\{[^}]*width: 8px/);
    expect(css).toMatch(/\.corner \.led\s*\{[^}]*height: 8px/);
    expect(css).toMatch(/\.corner \.led\s*\{[^}]*border-radius: 50%/);
    expect(css).toMatch(/\.corner \.led\.fresh\s*\{[^}]*background: var\(--greenText\)/);
    expect(css).toMatch(/\.corner \.led\.stale\s*\{[^}]*background: var\(--clay\)/);
    expect(css).toMatch(/\.corner \.led\.down, \.corner \.led\.none\s*\{[^}]*background: var\(--inkMute\)/);
  });
  it('the verified-tip states colour the dot: thin and refused clay, checking muted; a refused tip goes clay too', () => {
    // WEB_INTERFACE → The status corner — one hue at two weights: the dot is
    // clay for a heads-up and for the full rule alike; at the full rule the
    // height beside it is clay too. HOUSE_STYLE → Gold and clay are not
    // interchangeable.
    expect(css).toMatch(/\.corner \.led\.thin, \.corner \.led\.refused\s*\{[^}]*background: var\(--clay\)/);
    expect(css).toMatch(/\.corner \.led\.checking\s*\{[^}]*background: var\(--inkMute\)/);
    expect(css).toMatch(/\.corner \.tip\.clay\s*\{[^}]*color: var\(--clay\)/);
  });
  it('the corner\'s hover rule sits inside the hover block (HOUSE_STYLE → Interaction)', () => {
    const hover = mediaBlock('@media (hover: hover) {');
    expect(hover).toContain('.corner:hover');
  });
  it('the coarse-pointer block grows the hit box by padding', () => {
    const coarse = mediaBlock('@media (pointer: coarse) {');
    expect(coarse).toContain('.corner');
    expect(coarse).toMatch(/\.corner \{[^}]*padding: 10px/);
  });
  it('never a transition rule on .corner or its parts', () => {
    // "Numbers never animate" (HOUSE_STYLE → Motion). The general
    // prefers-reduced-motion clamp is not a per-selector rule.
    for (const block of (css.match(/\.corner[^\{]*\{[^}]*\}/g) ?? [])) {
      expect(block).not.toContain('transition');
    }
  });
});

describe('app.css — the key as a copy control', () => {
  it('.key-copy pins font-size 12.5px and text-align left (WEB_INTERFACE → The profile window → "The key is a control, and a press copies it")', () => {
    const block = css.match(/\.key-copy\s*\{[^}]*\}/)?.[0];
    expect(block).toBeDefined();
    expect(block!).toContain('font-size: 12.5px');
    expect(block!).toContain('text-align: left');
  });
  it('.key-copy-note is inkmute in the sans face and never breaks between its letters', () => {
    const block = css.match(/\.key-copy-note\s*\{[^}]*\}/)?.[0];
    expect(block).toBeDefined();
    expect(block!).toContain('color: var(--inkMute)');
    expect(block!).toContain('font-family: var(--sans)');
    expect(block!).toContain('word-break: normal');
  });
});

describe('app.css — the username claim form', () => {
  it('.username-form .name-row is a flex row with the input taking the width (WEB_INTERFACE → The username row → "Holding none, nothing pending, a rep box to spend")', () => {
    expect(css).toMatch(/\.username-form \.name-row\s*\{[^}]*display: flex/);
    expect(css).toMatch(/\.username-form \.name-row input\s*\{[^}]*flex: 1 1 auto/);
  });
});

describe('fonts.css — the self-hosted italic face', () => {
  it('a second Plus Jakarta Sans @font-face is italic, weight 400 700, its own src', () => {
    const faces = fontsCss.match(/@font-face\s*\{[^}]*\}/g) ?? [];
    const italic = faces.find((f) => f.includes("font-family: 'Plus Jakarta Sans'") && f.includes('font-style: italic'));
    expect(italic).toBeDefined();
    expect(italic!).toContain('font-weight: 400 700');
    expect(italic!).toContain("url('Plus-Jakarta-Sans-Italic.woff2')");
  });
});

describe('app.css — a handle the chain does not back is clay', () => {
  // WEB_INTERFACE → The identity display — the text alone, in the tokens' clay:
  // each rule outranks every rule that inks its handle. happy-dom computes the
  // rest but never matches a hover, so the rule that outranks the prefix
  // control's hover darkening is pinned here by its selectors.
  const decls = (block: string): string => block.slice(block.indexOf('{') + 1, block.lastIndexOf('}')).trim();
  const classCount = (selector: string): number => (selector.match(/[.:][A-Za-z][\w-]*/g) ?? []).length;

  it('.handle.clay is clay and sets colour alone — the face, weight and size stay the handle\'s', () => {
    const block = css.match(/\.handle\.clay\s*\{[^}]*\}/)?.[0];
    expect(block).toBeDefined();
    expect(decls(block!)).toBe('color: var(--clay);');
  });

  it('the who, endorser and bond handles take clay at three classes, above the (0,2,0) rules that ink them and the hover', () => {
    const m = css.match(/([^{}]*\.who \.handle\.clay[^{}]*)\{([^}]*)\}/);
    expect(m).not.toBeNull();
    const selectors = m![1]!.split(',').map((s) => s.trim());
    expect(selectors).toEqual(['.who .handle.clay', '.endorser .handle.clay', '.bond .handle.clay']);
    for (const s of selectors) expect(classCount(s)).toBe(3);
    expect(m![2]!.trim()).toBe('color: var(--clay);');
    // What they outrank, each at two.
    expect(css).toMatch(/\.who \.handle \{[^}]*color: var\(--ink\)/);
    expect(css).toMatch(/\.endorser \.handle, \.bond \.handle \{[^}]*color: var\(--ink\)/);
    const hover = mediaBlock('@media (hover: hover) {');
    expect(hover).toContain('.authorbtn:hover { color: var(--ink); }');
    expect(classCount('.authorbtn:hover')).toBe(2);
  });

  it('the header\'s profile word takes clay over .hdr-word\'s ink', () => {
    const block = css.match(/\.hdr-word\.clay\s*\{[^}]*\}/)?.[0];
    expect(block).toBeDefined();
    expect(decls(block!)).toBe('color: var(--clay);');
  });

  it('the clay token stands in both themes', () => {
    expect(css).toMatch(/:root \{[^}]*--clay: #9A4A2F/);
    expect(css).toMatch(/:root\[data-t="dark"\] \{[^}]*--clay: #CC7658/);
  });
});
