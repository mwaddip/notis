import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// WEB_INTERFACE → The extension → "The build carries its commit". The function
// reads a tracked one-line file at `<packageDir>/extension/commit.txt` and
// decides the commit the extension build carries beside its version:
//
//   — forty lowercase hex names the commit (the archive case, expanded under
//     `export-subst`); no `git` command runs.
//   — the literal `$Format:%H$` placeholder triggers `git rev-parse HEAD` in
//     `packageDir`, with `-dirty` appended where a tracked file's content
//     differs from `HEAD` (untracked files do not count — the repo root holds
//     the user's own untracked files — and a stat whose content is unchanged
//     does not either, which is what `git diff` compares after refreshing).
//   — anything else is refused with the file's content named.

const HEX_40 = /^[0-9a-f]{40}$/;
const PLACEHOLDER = '$Format:%H$';

export function readBuildCommit(packageDir) {
  const commitFile = join(packageDir, 'extension', 'commit.txt');
  const raw = readFileSync(commitFile, 'utf8');
  const content = raw.replace(/\s+$/, '');
  if (HEX_40.test(content)) return content;
  if (content === PLACEHOLDER) return readFromGit(packageDir);
  throw new Error(`extension/commit.txt holds neither forty lowercase hex nor the placeholder: ${JSON.stringify(content)}`);
}

function readFromGit(cwd) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd });
  if (head.status !== 0) throw new Error(`git rev-parse HEAD in ${cwd} exited ${head.status}: ${head.stderr}`);
  const hash = head.stdout.replace(/\s+$/, '');
  if (!HEX_40.test(hash)) throw new Error(`git rev-parse HEAD answered ${JSON.stringify(hash)}`);
  // `diff --quiet HEAD --` compares tracked files by content, refreshing
  // stat information before it compares, so a tracked file whose mtime moved
  // with its content unchanged reads as clean. It exits 0 clean, 1 dirty.
  // Untracked files do not reach it — the repo root holds the user's own
  // untracked files.
  const dirty = spawnSync('git', ['diff', '--quiet', 'HEAD', '--'], { encoding: 'utf8', cwd });
  if (dirty.status === 0) return hash;
  if (dirty.status === 1) return `${hash}-dirty`;
  throw new Error(`git diff in ${cwd} exited ${dirty.status}: ${dirty.stderr}`);
}
