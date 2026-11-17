// TEST_MATRIX_INTERFACE → What it reads → The diff: the paths a run reads.
// Under --rev, what changed between the merge base of the base and <rev>,
// and <rev>; without --rev, what changed between the merge base of the
// base and HEAD, and the working tree — committed, staged and unstaged —
// plus every untracked, unignored file. A rename is read as its two paths
// by --no-renames, and a deletion as its path.
import { execFileSync } from 'node:child_process';

export interface DiffOptions {
  readonly cwd: string;
  readonly rev: string | null;
  readonly base: string;
}

export interface Diff {
  // Repository root, as `git rev-parse --show-toplevel` answers for `cwd`
  // (TEST_MATRIX_INTERFACE → "The repository is the one the command runs
  // in").
  readonly root: string;
  // Tracked paths the diff names. Under --rev every path is here; without
  // --rev, committed, staged and unstaged paths are here.
  readonly changed: readonly string[];
  // Untracked, unignored paths. Empty under --rev.
  readonly untracked: readonly string[];
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitLines(args: readonly string[], cwd: string): string[] {
  return git(args, cwd).split('\0').filter((s) => s !== '');
}

function rootOf(cwd: string): string {
  try {
    return git(['rev-parse', '--show-toplevel'], cwd).trim();
  } catch {
    throw new Error(
      'test-matrix: refusing — not inside a git repository',
    );
  }
}

function resolveCommit(rev: string, cwd: string, label: string): string {
  try {
    return git(['rev-parse', '--verify', '-q', `${rev}^{commit}`], cwd).trim();
  } catch {
    throw new Error(
      `test-matrix: refusing — ${label} does not resolve: ${rev}`,
    );
  }
}

function mergeBaseOf(a: string, b: string, cwd: string): string {
  try {
    return git(['merge-base', a, b], cwd).trim();
  } catch {
    throw new Error(
      `test-matrix: refusing — no merge base between ${a} and ${b}`,
    );
  }
}

export function readDiff(opts: DiffOptions): Diff {
  const root = rootOf(opts.cwd);
  const baseSha = resolveCommit(opts.base, root, '--base');
  if (opts.rev === null) {
    const base = mergeBaseOf(baseSha, 'HEAD', root);
    // base..HEAD committed + base..working-tree unstaged (git diff <commit>)
    // and HEAD..index staged (--cached): their union covers every tracked
    // change since the merge base.
    const treeDiff = gitLines(
      ['diff', '--no-renames', '--name-only', '-z', base],
      root,
    );
    const stagedDiff = gitLines(
      ['diff', '--no-renames', '--name-only', '--cached', '-z'],
      root,
    );
    const changed = new Set<string>([...treeDiff, ...stagedDiff]);
    const untracked = gitLines(
      ['ls-files', '--others', '--exclude-standard', '-z'],
      root,
    );
    return { root, changed: [...changed], untracked };
  }
  const revSha = resolveCommit(opts.rev, root, '--rev');
  const base = mergeBaseOf(baseSha, revSha, root);
  const changed = gitLines(
    ['diff', '--no-renames', '--name-only', '-z', base, revSha],
    root,
  );
  return { root, changed, untracked: [] };
}
