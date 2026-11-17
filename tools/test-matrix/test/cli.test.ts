// TEST_MATRIX_INTERFACE → Place in the workspace, → What it reads, → The
// output: the command's cases. Each spawns the real entry under
// `process.execPath` (the command runs under Node's own type stripping;
// TEST_MATRIX_INTERFACE → Place in the workspace) with its working
// directory a fixture git repository the case builds under `os.tmpdir()`
// and removes at its end.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.ts');

function sh(cmd: string, args: readonly string[], cwd: string): string {
  return execFileSync(cmd, [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function write(dir: string, path: string, content: string): void {
  const full = resolve(dir, path);
  mkdirSync(resolve(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

// Each case builds its fixture under `os.tmpdir()`, with a `master` branch
// and `user.name`/`user.email` set in the repository's own config.
function initRepo(dir: string): void {
  sh('git', ['init', '-q', '--initial-branch=master', '.'], dir);
  sh('git', ['config', 'user.name', 'tm'], dir);
  sh('git', ['config', 'user.email', 'tm@x'], dir);
  sh('git', ['config', 'commit.gpgSign', 'false'], dir);
}

interface FixtureOpts {
  readonly withNode?: boolean;
  readonly withoutWorkspaceYaml?: boolean;
}

function writeWorkspace(dir: string, opts: FixtureOpts): void {
  if (!(opts.withoutWorkspaceYaml ?? false)) {
    write(dir, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
  }
  write(
    dir,
    'packages/a/package.json',
    JSON.stringify({ name: '@dagsocial/a', version: '0.0.1' }),
  );
  write(dir, 'packages/a/src/index.ts', '// a\n');
  write(
    dir,
    'packages/b/package.json',
    JSON.stringify({
      name: '@dagsocial/b',
      version: '0.0.1',
      dependencies: { '@dagsocial/a': 'workspace:*' },
    }),
  );
  write(dir, 'packages/b/src/index.ts', '// b\n');
  if (opts.withNode ?? false) {
    write(
      dir,
      'packages/node/package.json',
      JSON.stringify({ name: '@dagsocial/node', version: '0.0.1' }),
    );
    write(dir, 'packages/node/src/index.ts', '// node\n');
  }
}

interface Fixture {
  readonly dir: string;
  readonly cleanup: () => void;
}

function fixture(opts: FixtureOpts = {}): Fixture {
  const dir = mkdtempSync(resolve(tmpdir(), 'tm-cli-'));
  initRepo(dir);
  writeWorkspace(dir, opts);
  sh('git', ['add', '-A'], dir);
  sh('git', ['commit', '-q', '-m', 'init'], dir);
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function invoke(cwd: string, args: readonly string[]): Run {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

interface SelectedJson {
  readonly run: string;
  readonly path: string;
  readonly rule: string;
}

interface UnplacedJson {
  readonly path: string;
  readonly rule: string;
}

interface Answer {
  readonly runs: readonly SelectedJson[];
  readonly unplaced: readonly UnplacedJson[];
  readonly membersLeftOut: readonly string[];
  readonly notCounted: readonly string[];
}

function parse(stdout: string): Answer {
  return JSON.parse(stdout) as Answer;
}

function runNames(a: Answer): string[] {
  return a.runs.map((r) => r.run).sort();
}

describe('--rev reads what the commits carry', () => {
  it('a branch commit changing packages/a/src/x.ts selects a and b; an uncommitted change beside it is not read', () => {
    const { dir, cleanup } = fixture();
    try {
      sh('git', ['checkout', '-q', '-b', 'feature'], dir);
      write(dir, 'packages/a/src/x.ts', 'export const x = 1;\n');
      sh('git', ['add', 'packages/a/src/x.ts'], dir);
      sh('git', ['commit', '-q', '-m', 'add x'], dir);
      write(dir, 'packages/b/src/y.ts', 'export const y = 1;\n');
      const r = invoke(dir, ['--rev', 'feature', '--base', 'master', '--json']);
      expect(r.status).toEqual(0);
      const a = parse(r.stdout);
      expect(runNames(a)).toEqual(['a', 'b']);
    } finally {
      cleanup();
    }
  });
});

describe('the working tree is read with no --rev', () => {
  it('a committed, a staged, an unstaged change and an untracked file inside a member — each is counted', () => {
    const { dir, cleanup } = fixture({ withNode: true });
    try {
      sh('git', ['checkout', '-q', '-b', 'work'], dir);
      // Committed in packages/a reaches a and b.
      write(dir, 'packages/a/src/committed.ts', 'export const c = 1;\n');
      sh('git', ['add', 'packages/a/src/committed.ts'], dir);
      sh('git', ['commit', '-q', '-m', 'committed'], dir);
      // A contracts file under no run, committed so the unstaged
      // modification beside it carries only in the working tree.
      write(dir, 'contracts/U.md', '# U\n');
      sh('git', ['add', 'contracts/U.md'], dir);
      sh('git', ['commit', '-q', '-m', 'add U'], dir);
      // Staged (not committed) — a second contracts file under no run.
      write(dir, 'contracts/S.md', '# S\n');
      sh('git', ['add', 'contracts/S.md'], dir);
      // Unstaged — modifies U.md on disk, no add.
      write(dir, 'contracts/U.md', '# U changed\n');
      // Untracked inside a member — in packages/node reaches node.
      write(dir, 'packages/node/src/untracked.ts', 'export const u = 1;\n');
      const r = invoke(dir, ['--json']);
      expect(r.status).toEqual(0);
      const a = parse(r.stdout);
      // The rows read node at run time by check, e2e and test-state;
      // node reached selects node:slow as well (TEST_MATRIX_INTERFACE →
      // Reach).
      expect([...runNames(a)].sort()).toEqual([
        'a',
        'b',
        'check',
        'e2e',
        'node',
        'node:slow',
        'test-state',
      ]);
      const unplacedPaths = a.unplaced.map((u) => u.path);
      expect(unplacedPaths).toContain('contracts/S.md');
      expect(unplacedPaths).toContain('contracts/U.md');
    } finally {
      cleanup();
    }
  });
});

describe('an untracked file outside every member is named and not counted', () => {
  it('notes.txt at the root selects nothing and appears in the answer as not counted', () => {
    const { dir, cleanup } = fixture();
    try {
      sh('git', ['checkout', '-q', '-b', 'work'], dir);
      write(dir, 'notes.txt', 'free-form notes\n');
      const r = invoke(dir, ['--json']);
      expect(r.status).toEqual(0);
      const a = parse(r.stdout);
      expect(runNames(a)).toEqual([]);
      expect(a.notCounted).toContain('notes.txt');
    } finally {
      cleanup();
    }
  });
});

describe('a rename counts both its paths', () => {
  it('packages/a/src/x.ts renamed to docs/x.ts selects a and b', () => {
    const { dir, cleanup } = fixture();
    try {
      write(dir, 'packages/a/src/x.ts', 'export const x = 1;\n');
      sh('git', ['add', 'packages/a/src/x.ts'], dir);
      sh('git', ['commit', '-q', '-m', 'add x'], dir);
      sh('git', ['checkout', '-q', '-b', 'rename'], dir);
      mkdirSync(resolve(dir, 'docs'), { recursive: true });
      sh('git', ['mv', 'packages/a/src/x.ts', 'docs/x.ts'], dir);
      sh('git', ['commit', '-q', '-m', 'rename'], dir);
      const r = invoke(dir, ['--rev', 'rename', '--base', 'master', '--json']);
      expect(r.status).toEqual(0);
      const a = parse(r.stdout);
      expect(runNames(a)).toEqual(['a', 'b']);
    } finally {
      cleanup();
    }
  });
});

describe('a deletion counts its path', () => {
  it('a branch that removes packages/a/src/x.ts selects a and b', () => {
    const { dir, cleanup } = fixture();
    try {
      write(dir, 'packages/a/src/x.ts', 'export const x = 1;\n');
      sh('git', ['add', 'packages/a/src/x.ts'], dir);
      sh('git', ['commit', '-q', '-m', 'add x'], dir);
      sh('git', ['checkout', '-q', '-b', 'del'], dir);
      sh('git', ['rm', '-q', 'packages/a/src/x.ts'], dir);
      sh('git', ['commit', '-q', '-m', 'delete'], dir);
      const r = invoke(dir, ['--rev', 'del', '--base', 'master', '--json']);
      expect(r.status).toEqual(0);
      const a = parse(r.stdout);
      expect(runNames(a)).toEqual(['a', 'b']);
    } finally {
      cleanup();
    }
  });
});

describe('--base names the base', () => {
  it('a diff from a base other than master reads only what changed after it', () => {
    const { dir, cleanup } = fixture();
    try {
      write(dir, 'packages/a/src/x.ts', 'export const x = 1;\n');
      sh('git', ['add', 'packages/a/src/x.ts'], dir);
      sh('git', ['commit', '-q', '-m', 'add a/x'], dir);
      const mid = sh('git', ['rev-parse', 'HEAD'], dir).trim();
      write(dir, 'packages/b/src/y.ts', 'export const y = 1;\n');
      sh('git', ['add', 'packages/b/src/y.ts'], dir);
      sh('git', ['commit', '-q', '-m', 'add b/y'], dir);
      const r = invoke(dir, ['--rev', 'master', '--base', mid, '--json']);
      expect(r.status).toEqual(0);
      const a = parse(r.stdout);
      expect(runNames(a)).toEqual(['b']);
    } finally {
      cleanup();
    }
  });
});

describe("the workspace is the rev's", () => {
  it('a branch that adds @dagsocial/c declaring a and changes packages/a/src/x.ts selects a, b and c', () => {
    const { dir, cleanup } = fixture();
    try {
      sh('git', ['checkout', '-q', '-b', 'work'], dir);
      write(
        dir,
        'packages/c/package.json',
        JSON.stringify({
          name: '@dagsocial/c',
          version: '0.0.1',
          dependencies: { '@dagsocial/a': 'workspace:*' },
        }),
      );
      write(dir, 'packages/c/src/index.ts', '// c\n');
      write(dir, 'packages/a/src/x.ts', 'export const x = 1;\n');
      sh('git', ['add', '-A'], dir);
      sh('git', ['commit', '-q', '-m', 'add c, change a'], dir);
      sh('git', ['checkout', '-q', 'master'], dir);
      const rRev = invoke(dir, ['--rev', 'work', '--base', 'master', '--json']);
      expect(rRev.status).toEqual(0);
      const aRev = parse(rRev.stdout);
      expect(runNames(aRev)).toEqual(['a', 'b', 'c']);
      const rTree = invoke(dir, ['--json']);
      expect(rTree.status).toEqual(0);
      const aTree = parse(rTree.stdout);
      expect(runNames(aTree)).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe('--members prints member names in build order', () => {
  it('a change reaching node prints node, without node:slow or check', () => {
    const { dir, cleanup } = fixture({ withNode: true });
    try {
      sh('git', ['checkout', '-q', '-b', 'work'], dir);
      write(dir, 'packages/node/src/x.ts', 'export const x = 1;\n');
      sh('git', ['add', 'packages/node/src/x.ts'], dir);
      sh('git', ['commit', '-q', '-m', 'change node'], dir);
      const r = invoke(dir, ['--rev', 'work', '--base', 'master', '--members']);
      expect(r.status).toEqual(0);
      expect(r.stdout.trimEnd().split(/\s+/)).toEqual(['node']);
    } finally {
      cleanup();
    }
  });

  it('a change selecting no member prints an empty line', () => {
    const { dir, cleanup } = fixture();
    try {
      sh('git', ['checkout', '-q', '-b', 'work'], dir);
      write(dir, 'contracts/X.md', '# X\n');
      sh('git', ['add', 'contracts/X.md'], dir);
      sh('git', ['commit', '-q', '-m', 'add contracts/X'], dir);
      const r = invoke(dir, ['--rev', 'work', '--base', 'master', '--members']);
      expect(r.status).toEqual(0);
      expect(r.stdout).toEqual('\n');
      const rJson = invoke(dir, ['--rev', 'work', '--base', 'master', '--json']);
      const a = parse(rJson.stdout);
      expect(a.unplaced.map((u) => u.path)).toContain('contracts/X.md');
    } finally {
      cleanup();
    }
  });
});

describe('--json', () => {
  it('parses as one object and carries the same runs as the text answer', () => {
    const { dir, cleanup } = fixture();
    try {
      sh('git', ['checkout', '-q', '-b', 'work'], dir);
      write(dir, 'packages/a/src/x.ts', 'export const x = 1;\n');
      sh('git', ['add', 'packages/a/src/x.ts'], dir);
      sh('git', ['commit', '-q', '-m', 'change a'], dir);
      const rJson = invoke(dir, ['--rev', 'work', '--base', 'master', '--json']);
      expect(rJson.status).toEqual(0);
      const trimmed = rJson.stdout.trimEnd();
      expect(trimmed.includes('\n')).toBe(false);
      const a = parse(trimmed);
      expect(runNames(a)).toEqual(['a', 'b']);
      const rText = invoke(dir, ['--rev', 'work', '--base', 'master']);
      expect(rText.status).toEqual(0);
      const textRuns: string[] = [];
      for (const line of rText.stdout.split('\n')) {
        const m = line.match(/^run ([a-z0-9:_-]+):/);
        if (m !== null) textRuns.push(m[1] as string);
      }
      expect(textRuns.sort()).toEqual(['a', 'b']);
    } finally {
      cleanup();
    }
  });
});

describe('the refusals exit 2 with one stderr line', () => {
  it('an unknown option', () => {
    const { dir, cleanup } = fixture();
    try {
      const r = invoke(dir, ['--bogus']);
      expect(r.status).toEqual(2);
      expect(r.stderr.split('\n').filter((l) => l !== '').length).toEqual(1);
    } finally {
      cleanup();
    }
  });

  it('a --rev that does not resolve', () => {
    const { dir, cleanup } = fixture();
    try {
      const r = invoke(dir, ['--rev', 'nope-not-a-rev']);
      expect(r.status).toEqual(2);
      expect(r.stderr.split('\n').filter((l) => l !== '').length).toEqual(1);
    } finally {
      cleanup();
    }
  });

  it('a tree with no pnpm-workspace.yaml', () => {
    const { dir, cleanup } = fixture({ withoutWorkspaceYaml: true });
    try {
      const r = invoke(dir, []);
      expect(r.status).toEqual(2);
      expect(r.stderr.split('\n').filter((l) => l !== '').length).toEqual(1);
    } finally {
      cleanup();
    }
  });
});

describe('an empty diff', () => {
  it('--rev master --base master exits 0 and selects nothing', () => {
    const { dir, cleanup } = fixture();
    try {
      const r = invoke(dir, ['--rev', 'master', '--base', 'master', '--json']);
      expect(r.status).toEqual(0);
      const a = parse(r.stdout);
      expect(runNames(a)).toEqual([]);
      expect(a.unplaced).toEqual([]);
      expect(a.notCounted).toEqual([]);
      expect([...a.membersLeftOut].sort()).toEqual(['a', 'b']);
    } finally {
      cleanup();
    }
  });
});
