/**
 * Render-path id assertion: the demo UI's render functions must key on the
 * server-provided `p.id`, never recompute via `computePostId`.
 *
 * `computePostId(txId, index)` takes a hex txId string and a numeric index.
 * A render function that passes it a post object encodes `"[object Object]"`
 * and every post in the feed shares the same constant id — silently, with no
 * error. This test pins the hazard by asserting the render functions' source
 * contains no `computePostId(` call at all; the correct call lives in the
 * post-creation flow (`submitPost`), which is not a render function.
 *
 * ⚠ What this catches: any reintroduction of `computePostId` in renderThread,
 * loadFeed, or loadThread — the exact six-site defect. What it does NOT catch:
 * a new render function that someone writes without naming it one of these
 * three, or an aliased call (`const cpid = computePostId; cpid(p)`). The
 * alias gap is inherent to source-level assertions; covering it would require
 * runtime instrumentation with DOM mocking, which is not worth the coupling.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractDeclaration } from './extract-declaration.js';

const INDEX_HTML = fileURLToPath(new URL('../../public/index.html', import.meta.url));

function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (ch === quote) quote = null;
      i++; continue;
    }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2; continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; }
    out += ch;
    i++;
  }
  return out;
}

describe('render-path ids use server-provided p.id', () => {
  const html = readFileSync(INDEX_HTML, 'utf8');

  const RENDER_FUNCTIONS = [
    'function renderThread(',
    'async function loadFeed(',
    'async function loadThread(',
  ] as const;

  for (const header of RENDER_FUNCTIONS) {
    it(`${header.replace(/^(async )?function /, '').replace('(', '')} does not call computePostId`, () => {
      const src = extractDeclaration(html, header, 'index.html');
      const code = stripComments(src);
      expect(code).not.toContain('computePostId(');
    });
  }
});
