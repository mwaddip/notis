// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { gearGlyph } from '../src/view/glyphs';

// The house technique's rule for a shape carrying a hole: one <path> of
// M/L/Z only, fill-rule="evenodd" so the inner subpath carves the hole. No
// smooth curve of any kind — no C/S/Q/T/A command in d (HOUSE_STYLE →
// Illustration). Renders that keep to this rule are unmistakably by one hand.

describe('gearGlyph — one body, evenodd, no curve command', () => {
  it('the svg holds one <path>, fill-rule="evenodd", d built from M/L/Z only', () => {
    const svg = gearGlyph();
    const paths = svg.querySelectorAll('path');
    expect(paths.length).toBe(1);
    expect(svg.querySelectorAll('polygon').length).toBe(0);
    expect(paths[0]!.getAttribute('fill-rule')).toBe('evenodd');
    const d = paths[0]!.getAttribute('d') ?? '';
    expect(d).not.toBe('');
    // Every curve command in the SVG grammar — cubic (C/S), quadratic (Q/T),
    // arc (A), case-insensitive.
    expect(d).not.toMatch(/[CSQTAcsqta]/);
  });
});
