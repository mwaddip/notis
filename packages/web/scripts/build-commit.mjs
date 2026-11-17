// WEB_INTERFACE → The extension → "The build carries its commit". The function
// reads a tracked one-line file at `<packageDir>/extension/commit.txt` and
// decides the commit: forty lowercase hex names the commit (the archive case,
// expanded under `export-subst`); the literal `$Format:%H$` placeholder triggers
// `git rev-parse HEAD` in `packageDir`, with `-dirty` appended where a tracked
// file differs from `HEAD` (untracked files do not count); anything else is
// refused with the file's content named.
export function readBuildCommit(_packageDir) {
  return '';
}
