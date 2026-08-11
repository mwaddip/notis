/**
 * Lifting a declaration out of a file by name — the machinery both mirror tests
 * run on.
 *
 * Two PoW consumers cannot import `@dagsocial/validation` and are held by mirrors
 * instead (VALIDATION_INTERFACE → powTarget / meetsPowTarget): `public/index.html`,
 * served statically with no bundler, and `scripts/miner.mjs`, standalone by
 * decision. Each mirror extracts declarations by name and cross-checks them.
 *
 * Shared rather than copied into each mirror: a brace matcher maintained twice is
 * the shape those mirrors exist to catch.
 */

/**
 * The source text of the declaration `header` opens, from the header through its
 * balanced closing brace.
 *
 * Braces inside string literals and comments are skipped, so a comment or string
 * containing `{`/`}` cannot truncate the slice.
 *
 * Throws when the declaration is absent. A mirror whose subject has been renamed
 * or deleted must fail loudly — a silently absent declaration is an omission
 * nothing else signals, and a mirror that skipped it would report coverage it
 * does not have.
 */
export function extractDeclaration(src: string, header: string, sourceLabel: string): string {
  const start = src.indexOf(header);
  if (start === -1) throw new Error(`${sourceLabel} no longer declares: ${header}`);

  const open = src.indexOf('{', start);
  if (open === -1) throw new Error(`${sourceLabel}: no body found for: ${header}`);

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

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${sourceLabel}: unterminated body for: ${header}`);
}
