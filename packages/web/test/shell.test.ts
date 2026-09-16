// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const svg = readFileSync(fileURLToPath(new URL('../public/favicon.svg', import.meta.url)), 'utf8');
const fontsCss = readFileSync(fileURLToPath(new URL('../public/fonts/fonts.css', import.meta.url)), 'utf8');

describe('shell deploy tags', () => {
  it('carries <base> with the VITE_WEB_BASE placeholder', () => {
    expect(html).toContain('<base href="%VITE_WEB_BASE%">');
  });
  it('carries the notis-api meta with the VITE_API_BASE placeholder', () => {
    expect(html).toContain('<meta name="notis-api" content="%VITE_API_BASE%">');
  });
  it('carries the notis-faucet meta with the VITE_FAUCET_BASE placeholder', () => {
    expect(html).toContain('<meta name="notis-faucet" content="%VITE_FAUCET_BASE%">');
  });
  it('carries the notis-nodes meta with the VITE_NODES placeholder — a JSON array of API bases', () => {
    expect(html).toContain(`<meta name="notis-nodes" content='%VITE_NODES%'>`);
  });
  it('carries the notis-public meta with the VITE_PUBLIC placeholder — the origin+base a shareable link carries', () => {
    expect(html).toContain('<meta name="notis-public" content="%VITE_PUBLIC%">');
  });
  it('<base> precedes every URL-bearing element', () => {
    const basePos = html.indexOf('<base ');
    expect(basePos).toBeGreaterThan(-1);
    for (const tag of ['<link ', '<script', '<meta name="viewport"']) {
      const pos = html.indexOf(tag);
      if (pos === -1) continue;
      expect(basePos).toBeLessThan(pos);
    }
  });
});

describe('shell theme script — one file, no inline scripts (extension pages\' default CSP)', () => {
  it('references theme.js relative — one shell serves both builds', () => {
    expect(html).toContain('<script src="theme.js"></script>');
  });
  it('carries no inline <script> — the module entry is the only other script', () => {
    // The module entry `<script type="module" src="src/main.ts">` is a script
    // with a src, not inline. An inline script has no src attribute.
    const inline = html.match(/<script(?![^>]*\bsrc\b)[^>]*>[\s\S]*?<\/script>/g) ?? [];
    expect(inline).toHaveLength(0);
  });
});

describe('shell preview tags', () => {
  const PREVIEW_TAGS = [
    '<meta name="description"',
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Notis">',
    '<meta property="og:title" content="Notis">',
    '<meta property="og:description"',
    '<meta property="og:image" content="%VITE_PUBLIC_ORIGIN%%VITE_WEB_BASE%og.png">',
    '<meta property="og:image:type" content="image/png">',
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta property="og:image:alt" content="The Notis mark">',
    '<meta name="twitter:card" content="summary_large_image">',
  ];
  for (const tag of PREVIEW_TAGS) {
    it(`carries ${tag.slice(0, 40)}…`, () => {
      expect(html).toContain(tag);
    });
  }
  it('the og:image content composes from origin and base placeholders', () => {
    expect(html).toContain('content="%VITE_PUBLIC_ORIGIN%%VITE_WEB_BASE%og.png"');
  });
  it('each preview tag appears exactly once', () => {
    for (const tag of PREVIEW_TAGS) {
      const first = html.indexOf(tag);
      expect(first).toBeGreaterThan(-1);
      expect(html.indexOf(tag, first + 1)).toBe(-1);
    }
  });
});

describe('shell sprite removed', () => {
  it('notis-sprite is absent from the shell', () => {
    expect(html).not.toContain('notis-sprite');
  });
});

describe('shell icon links', () => {
  it('links the SVG favicon with type — relative, so <base> decides where it lives', () => {
    expect(html).toContain('<link rel="icon" href="favicon.svg" type="image/svg+xml">');
  });
  it('links the ICO favicon relative', () => {
    expect(html).toContain('<link rel="icon" href="favicon.ico" sizes="32x32">');
  });
  it('links the apple-touch-icon relative', () => {
    expect(html).toContain('<link rel="apple-touch-icon" href="apple-touch-icon.png">');
  });
});

describe('fonts.css references', () => {
  it('no url( opens with /', () => {
    const urls = [...fontsCss.matchAll(/url\(\s*'([^']*)'/g)];
    expect(urls.length).toBeGreaterThan(0);
    for (const m of urls) {
      expect(m[1]).not.toMatch(/^\//);
    }
  });
});

describe('favicon SVG well-formedness', () => {
  // happy-dom's DOMParser does not report a parsererror for `--` inside an XML
  // comment, so this is a string check, not a parse — and says so.
  it('holds no double-hyphen inside an XML comment (string check)', () => {
    const commentPattern = /<!--([\s\S]*?)-->/g;
    let m: RegExpExecArray | null;
    while ((m = commentPattern.exec(svg)) !== null) {
      const body = m[1];
      expect(body).not.toContain('--');
    }
  });
});
