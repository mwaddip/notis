// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
  copyGlyph, gearGlyph, moonGlyph, personGlyph, sunGlyph, walletGlyph,
} from '../src/view/glyphs';

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

describe('walletGlyph — one body (evenodd) plus the flap', () => {
  it('the svg holds one <path> with fill-rule="evenodd" and one <polygon>; no curve command', () => {
    const svg = walletGlyph();
    const paths = svg.querySelectorAll('path');
    const polys = svg.querySelectorAll('polygon');
    expect(paths.length).toBe(1);
    expect(polys.length).toBe(1);
    expect(paths[0]!.getAttribute('fill-rule')).toBe('evenodd');
    const d = paths[0]!.getAttribute('d') ?? '';
    expect(d).not.toBe('');
    expect(d).not.toMatch(/[CSQTAcsqta]/);
  });
});

// The ink bounding box of every glyph in the file is centred in the 20×20 box
// within 0.25, so the mark sits on the header axis — the hazard the axis rule
// demands (WEB_INTERFACE → The workspace → "The header's children share one
// axis"). Parsing polygon points and the path's M/L pairs is enough because the
// technique bans every curve command (asserted above); the ink extent is the
// bounding box of the vertices.
const AXIS_TOLERANCE = 0.25;
const GLYPHS: Record<string, () => SVGSVGElement> = {
  personGlyph, sunGlyph, moonGlyph, gearGlyph, walletGlyph, copyGlyph,
};

function inkBounds(svg: SVGSVGElement): { minX: number; maxX: number; minY: number; maxY: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const poly of svg.querySelectorAll('polygon')) {
    const raw = poly.getAttribute('points') ?? '';
    for (const pair of raw.trim().split(/\s+/)) {
      const [x, y] = pair.split(',').map(Number);
      if (Number.isFinite(x) && Number.isFinite(y)) { xs.push(x!); ys.push(y!); }
    }
  }
  for (const p of svg.querySelectorAll('path')) {
    const d = p.getAttribute('d') ?? '';
    // Numbers are the M/L operand pairs — the technique bans curves, so every
    // pair is an (x, y). Strip commands, split by whitespace, take pairs.
    const nums = d.replace(/[MLZmlz]/g, ' ').split(/\s+/).filter((s) => s !== '').map(Number);
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const x = nums[i]!;
      const y = nums[i + 1]!;
      if (Number.isFinite(x) && Number.isFinite(y)) { xs.push(x); ys.push(y); }
    }
  }
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

describe('every glyph — ink bounding box centred in the 20px box within 0.25', () => {
  for (const [name, make] of Object.entries(GLYPHS)) {
    it(`${name} — |cx − 10| ≤ 0.25 and |cy − 10| ≤ 0.25`, () => {
      const b = inkBounds(make());
      const cx = (b.minX + b.maxX) / 2;
      const cy = (b.minY + b.maxY) / 2;
      expect(Math.abs(cx - 10)).toBeLessThanOrEqual(AXIS_TOLERANCE);
      expect(Math.abs(cy - 10)).toBeLessThanOrEqual(AXIS_TOLERANCE);
    });
  }
});
