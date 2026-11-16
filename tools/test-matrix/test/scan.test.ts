// TEST_MATRIX_INTERFACE → Tests: the rows to the tree. Every cross-member
// reference is covered, every row's reader and what it reads exist in the
// tree, and no file under packages/web/src/ or packages/web/test/ names
// scripts/extension-check/.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ROWS } from '../src/rows.ts';
import type { Member, Row } from '../src/types.ts';
import { diskReader, readWorkspace } from '../src/workspace.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const workspace = readWorkspace(diskReader(ROOT));
const members = workspace.members;
const memberNames = new Set(members.map((m) => m.name));
const memberByDir = new Map<string, Member>(
  members.map((m) => [m.dir, m]),
);
const declaresByMember = new Map<string, Set<string>>(
  members.map((m) => [m.name, new Set(m.reads)]),
);

const CHECK_HARNESS_PREFIX = 'packages/web/scripts/extension-check/';

function gitLsFiles(dir: string): string[] {
  const out = execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--', dir], {
    encoding: 'utf8',
  });
  return out.split('\0').filter((s) => s !== '');
}

function readerOf(file: string): string | null {
  if (file.startsWith(CHECK_HARNESS_PREFIX)) return 'check';
  let best: Member | null = null;
  for (const m of members) {
    const prefix = `${m.dir}/`;
    if (file.startsWith(prefix)) {
      if (best === null || m.dir.length > best.dir.length) best = m;
    }
  }
  return best === null ? null : best.name;
}

interface Reference {
  file: string;
  lineno: number;
  path: string | null;   // the exact matched path, when the shape has one
  member: string | null; // the member the reference names, or null for a contracts path
}

function scanFile(file: string, content: string): Reference[] {
  const owner = readerOf(file);
  if (owner === null) return [];
  const noBlock = content.replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = noBlock.split(/\r?\n/);
  const refs: Reference[] = [];
  const seen = new Set<string>();

  const push = (lineno: number, path: string | null, member: string | null): void => {
    if (member !== null && member === owner) return;
    const key = `${lineno}\x00${path ?? ''}\x00${member ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ file, lineno, path, member });
  };

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? '';
    const cidx = line.indexOf('//');
    if (cidx !== -1) line = line.slice(0, cidx);
    const lineno = i + 1;

    // Shape 1 — a literal packages/<name>/<rest> or tools/<name>/<rest>.
    const rx1 = /(?<![A-Za-z0-9_@\.\/-])(packages|tools)\/([a-z][a-z0-9-]*)(\/[A-Za-z0-9_@\.\/-]*)?/g;
    let m: RegExpExecArray | null;
    while ((m = rx1.exec(line)) !== null) {
      const dir = m[1] as string;
      const name = m[2] as string;
      const rest = m[3] ?? '';
      if (!memberByDir.has(`${dir}/${name}`)) continue;
      if (rest === '' || rest === '/') continue;
      push(lineno, `${dir}/${name}${rest}`, name);
    }

    // Shape 1 — a literal contracts/<FILE>.md.
    const rx1c = /(?<![A-Za-z0-9_@\.\/-])(contracts\/[A-Z_]+(?:\.md)?)/g;
    while ((m = rx1c.exec(line)) !== null) {
      const matched = m[1] as string;
      const path = matched.endsWith('.md') ? matched : `${matched}.md`;
      push(lineno, path, null);
    }

    // Shape 2 — a relative path climbing to a member, by name alone.
    const rx2 = /(?<![A-Za-z0-9_@\.\/-])(?:\.\.\/)+([a-z][a-z0-9-]+)(?=\/)/g;
    while ((m = rx2.exec(line)) !== null) {
      const name = m[1] as string;
      if (memberNames.has(name)) push(lineno, null, name);
    }

    // Shape 3 — a path joined from segments, 'packages'/'tools' + name.
    const rx3 = /['"](packages|tools)['"]\s*,\s*['"]([a-z][a-z0-9-]+)['"]/g;
    while ((m = rx3.exec(line)) !== null) {
      const dir = m[1] as string;
      const name = m[2] as string;
      if (memberByDir.has(`${dir}/${name}`)) push(lineno, null, name);
    }

    // Shape 3 — joined relatives ending in a member name.
    const rx3b = /(?:['"]\.\.['"]\s*,\s*)+['"]([a-z][a-z0-9-]+)['"]/g;
    while ((m = rx3b.exec(line)) !== null) {
      const name = m[1] as string;
      if (memberNames.has(name)) push(lineno, null, name);
    }
  }
  return refs;
}

function isCovered(ref: Reference, owner: string, rows: readonly Row[]): boolean {
  if (ref.member !== null) {
    const declares = declaresByMember.get(owner);
    if (declares !== undefined && declares.has(ref.member)) return true;
  }
  for (const row of rows) {
    if (row.reader !== owner) continue;
    if (ref.member !== null && row.reads === ref.member) return true;
    if (ref.path !== null) {
      if (row.reads === ref.path) return true;
      if (row.reads.endsWith('/') && ref.path.startsWith(row.reads)) return true;
    }
  }
  return false;
}

interface UncoveredHit {
  file: string;
  lineno: number;
  names: string;  // the path or the member, whichever the reference carries
}

function collectUncovered(): UncoveredHit[] {
  const uncovered: UncoveredHit[] = [];
  for (const m of members) {
    for (const file of gitLsFiles(m.dir)) {
      if (file.endsWith('.md')) continue;
      let content: string;
      try {
        content = readFileSync(resolve(ROOT, file), 'utf8');
      } catch {
        continue;
      }
      const owner = readerOf(file);
      if (owner === null) continue;
      for (const ref of scanFile(file, content)) {
        if (isCovered(ref, owner, ROWS)) continue;
        uncovered.push({
          file: ref.file,
          lineno: ref.lineno,
          names: ref.path ?? (ref.member as string),
        });
      }
    }
  }
  return uncovered;
}

describe('the tree', () => {
  it('every cross-member reference is covered', () => {
    expect(collectUncovered()).toEqual([]);
  });

  it("every row's reader and what it reads exist in the tree", () => {
    const bad: Array<{ row: Row; why: string }> = [];
    for (const row of ROWS) {
      if (!memberNames.has(row.reader) && row.reader !== 'check') {
        bad.push({ row, why: `unknown reader: ${row.reader}` });
      }
      if (memberNames.has(row.reads)) continue;
      const normalized = row.reads.endsWith('/')
        ? row.reads.slice(0, -1)
        : row.reads;
      let ok = false;
      try {
        statSync(resolve(ROOT, normalized));
        ok = true;
      } catch {
        ok = false;
      }
      if (!ok) bad.push({ row, why: `path missing: ${row.reads}` });
    }
    expect(bad).toEqual([]);
  });

  it("no file under packages/web/src/ or packages/web/test/ names scripts/extension-check/", () => {
    const offenders: Array<{ file: string; lineno: number }> = [];
    for (const prefix of ['packages/web/src', 'packages/web/test']) {
      for (const file of gitLsFiles(prefix)) {
        if (file.endsWith('.md')) continue;
        let content: string;
        try {
          content = readFileSync(resolve(ROOT, file), 'utf8');
        } catch {
          continue;
        }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if ((lines[i] ?? '').includes('scripts/extension-check/')) {
            offenders.push({ file, lineno: i + 1 });
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
