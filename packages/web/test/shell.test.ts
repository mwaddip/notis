// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const svg = readFileSync(fileURLToPath(new URL('../public/favicon.svg', import.meta.url)), 'utf8');

describe('shell icon links', () => {
  it('links the SVG favicon with type', () => {
    expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
  });
  it('links the ICO favicon', () => {
    expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="32x32">');
  });
  it('links the apple-touch-icon', () => {
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
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
