import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

const ROOT = resolve(import.meta.dirname, '..');
const DIRS = ['src', 'test'];
const CAST_PATTERN = /\bas\s+never\b|\bas\s+unknown\s+as\b|\bas\s+any\b/;

function tsFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...tsFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      result.push(full);
    }
  }
  return result;
}

describe('no casts', () => {
  it('no forbidden type assertions in tools/e2e/{src,test}/**/*.ts', () => {
    const violations: string[] = [];
    for (const dir of DIRS) {
      for (const file of tsFiles(join(ROOT, dir))) {
        const lines = readFileSync(file, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (CAST_PATTERN.test(lines[i]!)) {
            const rel = file.slice(ROOT.length + 1);
            violations.push(`${rel}:${i + 1}: ${lines[i]!.trim()}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
