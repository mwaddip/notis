// TEST_MATRIX_INTERFACE → Tests: the rows to the tree. Every cross-member
// reference is covered, every row's reader and what it reads exist in the
// tree, and no file under packages/web/src/ or packages/web/test/ names
// scripts/extension-check/. The scan reads each file with its whitespace
// flattened after comments are stripped, and the matrix's own files are
// not scanned (TEST_MATRIX_INTERFACE → Tests → "The matrix's own files
// are not scanned").
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

const MATRIX_DIR = 'tools/test-matrix/';

function gitLsFiles(dir: string): string[] {
  const out = execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--', dir], {
    encoding: 'utf8',
  });
  return out.split('\0').filter((s) => s !== '');
}

function ownerOf(file: string): string | null {
  let best: Member | null = null;
  for (const m of members) {
    const prefix = `${m.dir}/`;
    if (file.startsWith(prefix)) {
      if (best === null || m.dir.length > best.dir.length) best = m;
    }
  }
  return best === null ? null : best.name;
}

// Strip /* ... */ block comments, preserving newlines so line numbers hold.
function stripBlockComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, ' '),
  );
}

// Strip a // line comment, but only where it opens a comment — not inside a
// string. Tracks single-/double-/back-quoted strings with a one-character
// escape.
function stripLineComment(line: string): string {
  let i = 0;
  let inStr: '"' | "'" | '`' | null = null;
  while (i < line.length) {
    const c = line[i];
    if (inStr !== null) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === inStr) inStr = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c;
      i += 1;
      continue;
    }
    if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
    i += 1;
  }
  return line;
}

// Flatten whitespace after stripping comments. Returns the flat string and a
// position → source-line map, so a regex match's index resolves to a line in
// the original file (TEST_MATRIX_INTERFACE → Tests → "Each file is read with
// its whitespace flattened").
function buildFlat(content: string): {
  flat: string;
  lineAt: (pos: number) => number;
} {
  const noBlock = stripBlockComments(content);
  const rawLines = noBlock.split(/\r?\n/);
  let flat = '';
  const posLine: number[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const srcLineno = i + 1;
    const line = stripLineComment(rawLines[i] ?? '');
    let inWs = false;
    for (let j = 0; j < line.length; j++) {
      const c = line[j] as string;
      if (/\s/.test(c)) {
        if (!inWs) {
          flat += ' ';
          posLine.push(srcLineno);
          inWs = true;
        }
      } else {
        flat += c;
        posLine.push(srcLineno);
        inWs = false;
      }
    }
    if (flat.length > 0 && flat[flat.length - 1] !== ' ') {
      flat += ' ';
      posLine.push(srcLineno);
    }
  }
  return {
    flat,
    lineAt: (pos) => posLine[pos] ?? 1,
  };
}

interface Reference {
  file: string;
  lineno: number;
  path: string | null;
  member: string | null;
}

function scanFile(file: string, content: string): Reference[] {
  const owner = ownerOf(file);
  if (owner === null) return [];
  const { flat, lineAt } = buildFlat(content);
  const refs: Reference[] = [];
  const seen = new Set<string>();
  const push = (pos: number, path: string | null, member: string | null): void => {
    if (member !== null && member === owner) return;
    const lineno = lineAt(pos);
    const key = `${lineno}\x00${path ?? ''}\x00${member ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ file, lineno, path, member });
  };

  // Shape 1 — a literal packages/<name> or tools/<name>, wherever it stands:
  // after a relative climb, inside an absolute path, or bare. The rest (the
  // path after the member's directory) is optional.
  const rx1 = /(packages|tools)\/([a-z][a-z0-9-]*)((?:\/[A-Za-z0-9_@\.\/-]*)?)/g;
  for (const m of flat.matchAll(rx1)) {
    const dir = m[1] as string;
    const name = m[2] as string;
    const rest = m[3] ?? '';
    const key = `${dir}/${name}`;
    if (!memberByDir.has(key)) continue;
    const path = rest === '' ? key : `${key}${rest}`;
    push(m.index as number, path, name);
  }

  // Shape 1 — a literal contracts/ reference, bare or with a path after it.
  const rx1c = /contracts\/([A-Z_]+(?:\.md)?)?/g;
  for (const m of flat.matchAll(rx1c)) {
    const tail = m[1] ?? '';
    const path =
      tail === ''
        ? 'contracts/'
        : tail.endsWith('.md')
          ? `contracts/${tail}`
          : `contracts/${tail}.md`;
    push(m.index as number, path, null);
  }

  // Shape 2 — a relative path climbing out of its member to a member by name
  // (../../net/…). A climb that goes through packages/ or tools/ is caught by
  // shape 1 on the same text.
  const rx2 = /(?:\.\.\/)+([a-z][a-z0-9-]+)/g;
  for (const m of flat.matchAll(rx2)) {
    const name = m[1] as string;
    if (name === 'packages' || name === 'tools') continue;
    if (memberNames.has(name)) push(m.index as number, null, name);
  }

  // Shape 3 — a path joined from segments, 'packages'/'tools' + name.
  const rx3 = /['"](packages|tools)['"]\s*,\s*['"]([a-z][a-z0-9-]+)['"]/g;
  for (const m of flat.matchAll(rx3)) {
    const dir = m[1] as string;
    const name = m[2] as string;
    if (memberByDir.has(`${dir}/${name}`)) push(m.index as number, null, name);
  }

  // Shape 3 — joined relatives ending in a member name.
  const rx3b = /(?:['"]\.\.['"]\s*,\s*)+['"]([a-z][a-z0-9-]+)['"]/g;
  for (const m of flat.matchAll(rx3b)) {
    const name = m[1] as string;
    if (memberNames.has(name)) push(m.index as number, null, name);
  }

  return refs;
}

function rowReads(row: Row, member: string | null, path: string | null): boolean {
  if (member !== null && row.reads === member) return true;
  if (path !== null) {
    if (row.reads === path) return true;
    if (row.reads.endsWith('/') && path.startsWith(row.reads)) return true;
  }
  return false;
}

// TEST_MATRIX_INTERFACE → Tests: a file a run-time row names (its path
// exact, or under a dir row) is read by the row's reader as well, so a
// reference in it is covered by its own member's declarations and rows
// or by the reader's. A by-no-run row covers a reference only when the
// reference's file is the row's reader.
function readersOfFile(file: string, rows: readonly Row[]): Set<string> {
  const readers = new Set<string>();
  const owner = ownerOf(file);
  if (owner !== null) readers.add(owner);
  for (const row of rows) {
    if (row.kind !== 'run time') continue;
    if (memberNames.has(row.reads)) continue;
    const covers = row.reads.endsWith('/')
      ? file.startsWith(row.reads)
      : row.reads === file;
    if (covers) readers.add(row.reader);
  }
  return readers;
}

function coveredByReader(ref: Reference, reader: string, rows: readonly Row[]): boolean {
  if (ref.member !== null) {
    const declares = declaresByMember.get(reader);
    if (declares !== undefined && declares.has(ref.member)) return true;
  }
  for (const row of rows) {
    if (row.kind === 'by no run') continue;
    if (row.reader !== reader) continue;
    if (rowReads(row, ref.member, ref.path)) return true;
  }
  return false;
}

function isCovered(ref: Reference, rows: readonly Row[]): boolean {
  for (const reader of readersOfFile(ref.file, rows)) {
    if (coveredByReader(ref, reader, rows)) return true;
  }
  for (const row of rows) {
    if (row.kind !== 'by no run') continue;
    if (row.reader !== ref.file) continue;
    if (rowReads(row, ref.member, ref.path)) return true;
  }
  return false;
}

interface UncoveredHit {
  file: string;
  lineno: number;
  names: string;
}

function collectUncovered(): UncoveredHit[] {
  const uncovered: UncoveredHit[] = [];
  for (const m of members) {
    if (m.dir === 'tools/test-matrix') continue;
    for (const file of gitLsFiles(m.dir)) {
      if (file.endsWith('.md')) continue;
      if (file.startsWith(MATRIX_DIR)) continue;
      let content: string;
      try {
        content = readFileSync(resolve(ROOT, file), 'utf8');
      } catch {
        continue;
      }
      const owner = ownerOf(file);
      if (owner === null) continue;
      for (const ref of scanFile(file, content)) {
        if (isCovered(ref, ROWS)) continue;
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
      if (row.kind === 'by no run') {
        let ok = false;
        try {
          const s = statSync(resolve(ROOT, row.reader));
          if (s.isFile()) ok = true;
        } catch {
          ok = false;
        }
        if (!ok) {
          bad.push({
            row,
            why: `by-no-run reader is not a tracked file: ${row.reader}`,
          });
        }
      } else {
        if (!memberNames.has(row.reader) && row.reader !== 'check') {
          bad.push({ row, why: `unknown reader: ${row.reader}` });
        }
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
