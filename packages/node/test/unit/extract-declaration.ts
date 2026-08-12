/**
 * Lifting a declaration out of a file by name — the machinery both mirror tests
 * run on.
 *
 * Two PoW consumers cannot import `@dagsocial/validation` and are held by mirrors
 * instead: `public/index.html`, served statically with no bundler, and
 * `scripts/miner.mjs`, standalone by decision. They mirror different halves —
 * the page does post PoW and copies `powTarget`, the script does header PoW and
 * copies `orderingPowTarget` (VALIDATION_INTERFACE → orderingPowTarget →
 * Mirrors). Each extracts declarations by name and cross-checks them.
 *
 * Shared rather than copied into each mirror: a brace matcher maintained twice is
 * the shape those mirrors exist to catch.
 */

/**
 * The source text of the declaration `header` opens, from the header through the
 * end of that declaration.
 *
 * Three shapes end three ways, and which one applies is decided by whichever of
 * `{`, `[` and `;` appears first after the header: a function or object body
 * ends at its balanced `}`, an array literal at its balanced `]`, and a simple
 * `const NAME = value;` at that semicolon. The scaled PoW target is spread
 * across all three — a function, its factor table, and its scale — and a mirror
 * that lifted only the function would reference constants the harness does not
 * hold.
 *
 * Delimiters inside string literals and comments are skipped, so a comment or
 * string containing one cannot truncate the slice.
 *
 * Throws when the declaration is absent. A mirror whose subject has been renamed
 * or deleted must fail loudly — a silently absent declaration is an omission
 * nothing else signals, and a mirror that skipped it would report coverage it
 * does not have.
 */
export function extractDeclaration(src: string, header: string, sourceLabel: string): string {
  const start = src.indexOf(header);
  if (start === -1) throw new Error(`${sourceLabel} no longer declares: ${header}`);

  const candidates = (['{', '[', ';'] as const)
    .map((ch) => ({ ch, at: src.indexOf(ch, start + header.length) }))
    .filter((c) => c.at !== -1)
    .sort((a, b) => a.at - b.at);
  const first = candidates[0];
  if (!first) throw new Error(`${sourceLabel}: no body found for: ${header}`);
  if (first.ch === ';') return src.slice(start, first.at + 1);

  const open = first.at;
  const opener = first.ch;
  const closer = opener === '{' ? '}' : ']';

  let depth = 0;
  let quote: string | null = null;
  let comment: 'line' | 'block' | null = null;

  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];

    if (comment === 'line') {
      if (ch === '\n') comment = null;
      continue;
    }
    if (comment === 'block') {
      if (ch === '*' && next === '/') { comment = null; i++; }
      continue;
    }
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { comment = 'line'; i++; continue; }
    if (ch === '/' && next === '*') { comment = 'block'; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }

    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${sourceLabel}: unterminated body for: ${header}`);
}
