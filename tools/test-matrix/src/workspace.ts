// TEST_MATRIX_INTERFACE → The workspace: readWorkspace takes a TreeReader —
// a required argument, never defaulted — and reads pnpm-workspace.yaml's
// packages: list in the <dir>/* form this repo uses, then each matched
// directory holding a package.json. The disk reader is a TreeReader over a
// root directory.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Member, TreeReader, Workspace } from './types.ts';

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const SCOPE = '@dagsocial/';

function parsePackages(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/);
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^packages:\s*$/.test(lines[i] ?? '')) {
      idx = i;
      break;
    }
  }
  if (idx === -1) {
    throw new Error(
      "test-matrix: refusing — pnpm-workspace.yaml has no 'packages:' list",
    );
  }
  const dirs: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s+-\s/.test(line)) break;
    const m = line.match(/^\s+-\s*['"]?(.+?)['"]?\s*$/);
    if (m === null) {
      throw new Error(
        `test-matrix: refusing — pnpm-workspace.yaml entry is unreadable: ${line}`,
      );
    }
    const glob = m[1] ?? '';
    if (!glob.endsWith('/*')) {
      throw new Error(
        `test-matrix: refusing — pnpm-workspace.yaml entry ${glob} is not the <dir>/* form`,
      );
    }
    dirs.push(glob.slice(0, -2));
  }
  return dirs;
}

export function readWorkspace(tree: TreeReader): Workspace {
  const yaml = tree.file('pnpm-workspace.yaml');
  if (yaml === null) {
    throw new Error(
      'test-matrix: refusing — pnpm-workspace.yaml is missing',
    );
  }
  const dirs = parsePackages(yaml);
  const members: Member[] = [];
  for (const base of dirs) {
    for (const sub of tree.dirs(base)) {
      const pkgPath = `${base}/${sub}/package.json`;
      const raw = tree.file(pkgPath);
      if (raw === null) continue;
      const pkg = JSON.parse(raw) as PackageJson;
      const fullName = typeof pkg.name === 'string' ? pkg.name : '';
      if (!fullName.startsWith(SCOPE)) continue;
      const name = fullName.slice(SCOPE.length);
      const reads = new Set<string>();
      for (const section of [
        'dependencies',
        'devDependencies',
        'peerDependencies',
      ] as const) {
        const deps = pkg[section];
        if (deps === undefined) continue;
        for (const dep of Object.keys(deps)) {
          if (dep.startsWith(SCOPE)) reads.add(dep.slice(SCOPE.length));
        }
      }
      members.push({
        name,
        dir: `${base}/${sub}`,
        reads: [...reads].sort(),
      });
    }
  }
  return { members };
}

export function diskReader(root: string): TreeReader {
  return {
    file(path) {
      try {
        return readFileSync(resolve(root, path), 'utf8');
      } catch {
        return null;
      }
    },
    dirs(path) {
      try {
        return readdirSync(resolve(root, path), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        return [];
      }
    },
  };
}

export type { Member, TreeReader, Workspace };
