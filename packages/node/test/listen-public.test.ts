import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const SRC_DIR = join(__dirname, '../src');

/**
 * NODE_INTERFACE → The public server → "One function builds the public server,
 * and every bound below is set there": the node's start listens through
 * `listenPublic`, and the admin listener is the one other `.listen(` call in
 * the package's source — on loopback, with none of the public server's bounds.
 *
 * The scan is the literal substring `.listen(` under `src/`; its enclosing
 * function is read off the nearest `function`/`export function` header above
 * each hit. A `.listen(` written on a line without the ascii dot — a dynamic
 * dispatch, a reflective call — is not seen by this scan.
 */
describe('under src/, `.listen(` is listenPublic\'s and createAdminApp\'s alone, and index.ts calls listenPublic', () => {
  function enclosingFunctionName(lines: string[], lineIndex: number): string | null {
    for (let i = lineIndex; i >= 0; i--) {
      const line = lines[i];
      if (line === undefined) continue;
      const match = line.match(/^\s*(?:export\s+)?function\s+([A-Za-z0-9_]+)\s*\(/);
      if (match && match[1] !== undefined) return match[1];
    }
    return null;
  }

  it('every `.listen(` under src/ sits in listenPublic or createAdminApp, and src/index.ts has one `listenPublic(` call', () => {
    const hits: { file: string; line: number; enclosing: string | null }[] = [];

    function walk(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.ts')) {
          const content = readFileSync(full, 'utf8');
          const lines = content.split('\n');
          const relative = full.replace(SRC_DIR + '/', '');
          lines.forEach((line, i) => {
            if (/\.listen\(/.test(line)) {
              hits.push({ file: relative, line: i + 1, enclosing: enclosingFunctionName(lines, i) });
            }
          });
        }
      }
    }

    walk(SRC_DIR);

    const enclosingByFile = hits.map(h => `${h.file}:${h.enclosing}`).sort();
    expect(enclosingByFile).toEqual([
      'server.ts:createAdminApp',
      'server.ts:listenPublic',
    ]);

    const indexTs = readFileSync(join(SRC_DIR, 'index.ts'), 'utf8');
    const listenPublicCalls = indexTs.match(/\blistenPublic\(/g) ?? [];
    expect(listenPublicCalls).toHaveLength(1);
  });
});
