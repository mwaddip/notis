// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBuildCommit } from '../scripts/build-commit.mjs';

// WEB_INTERFACE → The extension → "The build carries its commit".
// The function takes a package directory (the directory holding `extension/`
// and `.git`), reads `<dir>/extension/commit.txt`, and answers one of:
//   — forty lowercase hex, the commit, where the file holds hex (the archive
//     case, under `export-subst`);
//   — `<hash>` or `<hash>-dirty` from `git rev-parse HEAD`, where the file
//     holds the literal placeholder `$Format:%H$` (a checkout);
//   — a refusal, naming the file's content, where it holds anything else.
// Untracked files never make a checkout dirty.

function runGit(cwd: string, args: readonly string[]): string {
  const r = spawnSync('git', args, {
    encoding: 'utf8',
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'tester',
      GIT_AUTHOR_EMAIL: 'tester@example.com',
      GIT_COMMITTER_NAME: 'tester',
      GIT_COMMITTER_EMAIL: 'tester@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

function makeRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'notis-build-commit-'));
  mkdirSync(join(dir, 'extension'), { recursive: true });
  writeFileSync(join(dir, '.gitattributes'), 'extension/commit.txt export-subst\n');
  writeFileSync(join(dir, 'extension', 'commit.txt'), '$Format:%H$\n');
  writeFileSync(join(dir, 'other.txt'), 'tracked payload\n');
  runGit(dir, ['init', '-q', '-b', 'main']);
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-q', '-m', 'init']);
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('build-commit — the function', () => {
  it('a checkout with the placeholder answers `git rev-parse HEAD`', () => {
    const r = makeRepo();
    try {
      const head = runGit(r.dir, ['rev-parse', 'HEAD']).trim();
      expect(readBuildCommit(r.dir)).toBe(head);
    } finally {
      r.cleanup();
    }
  });

  it('a tracked file that differs from HEAD appends -dirty', () => {
    const r = makeRepo();
    try {
      const head = runGit(r.dir, ['rev-parse', 'HEAD']).trim();
      writeFileSync(join(r.dir, 'other.txt'), 'tracked payload changed\n');
      expect(readBuildCommit(r.dir)).toBe(`${head}-dirty`);
    } finally {
      r.cleanup();
    }
  });

  it('an untracked file leaves the build clean — no -dirty', () => {
    const r = makeRepo();
    try {
      const head = runGit(r.dir, ['rev-parse', 'HEAD']).trim();
      writeFileSync(join(r.dir, 'untracked.txt'), 'the user\'s own file\n');
      expect(readBuildCommit(r.dir)).toBe(head);
    } finally {
      r.cleanup();
    }
  });

  it('an archive answers the same commit with no `.git` present', () => {
    const r = makeRepo();
    const unpack = mkdtempSync(join(tmpdir(), 'notis-build-commit-archive-'));
    try {
      const head = runGit(r.dir, ['rev-parse', 'HEAD']).trim();
      const tarPath = join(r.dir, 'out.tar');
      runGit(r.dir, ['archive', '--format=tar', `--output=${tarPath}`, 'HEAD']);
      const untar = spawnSync('tar', ['-xf', tarPath, '-C', unpack], { encoding: 'utf8' });
      if (untar.status !== 0) throw new Error(`tar exited ${untar.status}: ${untar.stderr}`);
      // The archive expands $Format:%H$ under export-subst, and carries no .git.
      expect(existsSync(join(unpack, '.git'))).toBe(false);
      expect(readFileSync(join(unpack, 'extension', 'commit.txt'), 'utf8').trim()).toBe(head);
      expect(readBuildCommit(unpack)).toBe(head);
    } finally {
      r.cleanup();
      rmSync(unpack, { recursive: true, force: true });
    }
  });

  it('a commit.txt holding anything else refuses, naming the content', () => {
    const r = makeRepo();
    try {
      writeFileSync(join(r.dir, 'extension', 'commit.txt'), 'not a commit\n');
      expect(() => readBuildCommit(r.dir)).toThrow(/not a commit/);
    } finally {
      r.cleanup();
    }
  });
});
